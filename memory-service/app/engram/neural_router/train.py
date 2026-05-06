"""Neural Router training pipeline.

Entrypoint for the neural-router-trainer container. Listens for train
signals on Redis db6, assembles labeled data from retrieval_log,
trains a PyTorch model, validates via precision@K, and stores weights
in PostgreSQL.

Usage: python -m app.engram.neural_router.train
"""

from __future__ import annotations

import asyncio
import io
import json
import logging

import redis.asyncio as aioredis
import torch
import torch.nn as nn
from app.config import settings
from app.db.database import get_db
from sqlalchemy import text

from .features import extract_scalar_features
from .model import EmbeddingReranker, ScalarReranker

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
log = logging.getLogger("neural_router.train")

_DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001"


# ── Data Assembly ────────────────────────────────────────────────────────


async def assemble_training_data(tenant_id: str) -> list[dict]:
    """Fetch labeled retrieval_log rows and build training examples.

    Each example is a dict with:
        scalar_features: list[float] (25 dims)
        query_embedding: list[float] (768 dims) or None
        engram_embedding: list[float] (768 dims) or None
        label: 1.0 (used) or 0.0 (surfaced but not used)
    """
    examples: list[dict] = []

    max_obs = settings.neural_router_max_training_obs

    async with get_db() as session:
        # Fetch most recent labeled observations for this tenant, capped to
        # bound memory usage (each obs expands to N surfaced-engram examples
        # with 768-dim embeddings).
        rows = await session.execute(
            text("""
                SELECT id, query_embedding::text, query_text,
                       temporal_context, engrams_surfaced, engrams_used
                FROM retrieval_log
                WHERE tenant_id = CAST(:tid AS uuid)
                  AND engrams_used IS NOT NULL
                ORDER BY created_at DESC
                LIMIT :cap
            """),
            {"tid": tenant_id, "cap": max_obs},
        )
        observations = rows.fetchall()
        # Reverse to restore chronological order (oldest-first) for temporal split
        observations = list(reversed(observations))

        if not observations:
            return examples

        # Collect all unique engram IDs we need metadata for
        all_engram_ids: set[str] = set()
        for obs in observations:
            if obs.engrams_surfaced:
                all_engram_ids.update(str(eid) for eid in obs.engrams_surfaced)

        if not all_engram_ids:
            return examples

        # Fetch engram metadata in batch
        engram_rows = await session.execute(
            text("""
                SELECT id::text, type, importance, activation,
                       last_accessed, embedding::text,
                       outcome_avg, outcome_count
                FROM engrams
                WHERE id = ANY(CAST(:ids AS uuid[]))
            """),
            {"ids": list(all_engram_ids)},
        )
        engram_meta = {row.id: row for row in engram_rows.fetchall()}

    # Build training examples
    for obs in observations:
        used_set = set(str(u) for u in (obs.engrams_used or []))
        surfaced = [str(s) for s in (obs.engrams_surfaced or [])]
        temporal = (
            obs.temporal_context if isinstance(obs.temporal_context, dict) else {}
        )

        # Parse query embedding from pgvector text format "[0.1,0.2,...]"
        query_emb = (
            _parse_pgvector(obs.query_embedding) if obs.query_embedding else None
        )

        for eid in surfaced:
            meta = engram_meta.get(eid)
            if meta is None:
                continue

            candidate = {
                "cosine_similarity": 0.0,  # Not stored in log; model learns without it
                "importance": float(meta.importance or 0.5),
                "activation": float(meta.activation or 0.0),
                "last_accessed": meta.last_accessed,
                "type": meta.type or "fact",
                "convergence_paths": 0,
                "outcome_avg": float(meta.outcome_avg or 0.0)
                if meta.outcome_avg is not None
                else 0.0,
                "outcome_count": int(meta.outcome_count or 0),
            }

            scalar_tensor = extract_scalar_features([candidate], temporal)
            scalar_list = scalar_tensor[0].tolist()

            engram_emb = _parse_pgvector(meta.embedding) if meta.embedding else None

            examples.append(
                {
                    "scalar_features": scalar_list,
                    "query_embedding": query_emb,
                    "engram_embedding": engram_emb,
                    "label": 1.0 if eid in used_set else 0.0,
                }
            )

    return examples


def _parse_pgvector(text_repr: str | None) -> list[float] | None:
    """Parse pgvector text representation '[0.1,0.2,...]' to list of floats."""
    if not text_repr:
        return None
    try:
        cleaned = text_repr.strip("[] ")
        return [float(x) for x in cleaned.split(",")]
    except (ValueError, AttributeError):
        return None


# ── Training Loop ────────────────────────────────────────────────────────


def train_model(
    examples: list[dict],
    obs_count: int,
) -> tuple[nn.Module, str, float] | None:
    """Train a model on assembled examples.

    Returns (model, architecture_name, validation_precision) or None on failure.
    """
    if len(examples) < 10:
        log.warning("Too few examples (%d) to train", len(examples))
        return None

    # Architecture gate
    use_embedding = obs_count >= settings.neural_router_embedding_threshold
    has_embeddings = all(
        e["query_embedding"] is not None and e["engram_embedding"] is not None
        for e in examples
    )
    use_embedding = use_embedding and has_embeddings

    arch_name = "embedding" if use_embedding else "scalar"
    log.info("Training %s architecture with %d examples", arch_name, len(examples))

    # Temporal split: oldest 80% train, newest 20% validate
    split_idx = int(len(examples) * (1 - settings.neural_router_validation_split))
    train_examples = examples[:split_idx]
    val_examples = examples[split_idx:]

    if len(val_examples) < 5:
        log.warning("Too few validation examples (%d)", len(val_examples))
        return None

    # Build tensors
    train_scalars = torch.tensor(
        [e["scalar_features"] for e in train_examples], dtype=torch.float32
    )
    train_labels = torch.tensor(
        [[e["label"]] for e in train_examples], dtype=torch.float32
    )
    val_scalars = torch.tensor(
        [e["scalar_features"] for e in val_examples], dtype=torch.float32
    )
    val_labels = torch.tensor([[e["label"]] for e in val_examples], dtype=torch.float32)

    if use_embedding:
        train_q_emb = torch.tensor(
            [e["query_embedding"] for e in train_examples], dtype=torch.float32
        )
        train_e_emb = torch.tensor(
            [e["engram_embedding"] for e in train_examples], dtype=torch.float32
        )
        val_q_emb = torch.tensor(
            [e["query_embedding"] for e in val_examples], dtype=torch.float32
        )
        val_e_emb = torch.tensor(
            [e["engram_embedding"] for e in val_examples], dtype=torch.float32
        )
        model = EmbeddingReranker()
    else:
        train_q_emb = train_e_emb = val_q_emb = val_e_emb = None
        model = ScalarReranker()

    # Save val labels before freeing the Python-list copies
    val_label_list = [e["label"] for e in val_examples]
    del train_examples, val_examples

    optimizer = torch.optim.Adam(
        model.parameters(),
        lr=settings.neural_router_learning_rate,
        weight_decay=1e-4,
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=settings.neural_router_training_epochs
    )
    criterion = nn.BCELoss()

    best_val_loss = float("inf")
    patience_counter = 0
    best_state = None

    for epoch in range(settings.neural_router_training_epochs):
        # Train
        model.train()
        if use_embedding:
            preds = model(train_scalars, train_q_emb, train_e_emb)
        else:
            preds = model(train_scalars)
        loss = criterion(preds, train_labels)

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        scheduler.step()

        # Validate
        model.eval()
        with torch.no_grad():
            if use_embedding:
                val_preds = model(val_scalars, val_q_emb, val_e_emb)
            else:
                val_preds = model(val_scalars)
            val_loss = criterion(val_preds, val_labels).item()

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            patience_counter = 0
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
        else:
            patience_counter += 1

        if patience_counter >= 3:
            log.info("Early stopping at epoch %d (patience=3)", epoch + 1)
            break

    # Restore best weights
    if best_state:
        model.load_state_dict(best_state)

    # Compute validation precision@20
    model.eval()
    with torch.no_grad():
        if use_embedding:
            val_scores = model(val_scalars, val_q_emb, val_e_emb)
        else:
            val_scores = model(val_scalars)

    precision = _precision_at_k(
        val_scores.squeeze().tolist(),
        val_label_list,
        k=20,
    )
    log.info("Validation precision@20: %.4f", precision)

    return model, arch_name, precision


def _precision_at_k(
    scores: list[float] | float, labels: list[float], k: int = 20
) -> float:
    """Compute precision@K: of the top K scored items, how many are positive."""
    if isinstance(scores, float):
        scores = [scores]
    if not scores or not labels:
        return 0.0
    paired = list(zip(scores, labels))
    paired.sort(key=lambda x: x[0], reverse=True)
    top_k = paired[:k]
    positives = sum(1 for _, label in top_k if label > 0.5)
    return positives / len(top_k) if top_k else 0.0


# ── Model Storage ────────────────────────────────────────────────────────


async def save_model(
    model: nn.Module,
    arch_name: str,
    precision: float,
    obs_count: int,
    tenant_id: str,
) -> bool:
    """Serialize and store model in PostgreSQL. Promote if it beats current.

    Returns True if model was promoted to active.
    """
    # Serialize weights to bytes
    buf = io.BytesIO()
    torch.save(model.state_dict(), buf)
    weights_bytes = buf.getvalue()

    async with get_db() as session:
        # Check current active model's precision
        current = await session.execute(
            text("""
                SELECT validation_precision_at_k
                FROM neural_router_models
                WHERE tenant_id = CAST(:tid AS uuid) AND is_active
            """),
            {"tid": tenant_id},
        )
        current_row = current.fetchone()
        current_precision = (
            float(current_row.validation_precision_at_k)
            if current_row and current_row.validation_precision_at_k is not None
            else 0.0
        )

        should_promote = (
            precision >= current_precision + settings.neural_router_min_precision_gain
        )

        if should_promote:
            # Atomic swap: deactivate current, insert new as active
            await session.execute(
                text("""
                    UPDATE neural_router_models
                    SET is_active = FALSE
                    WHERE tenant_id = CAST(:tid AS uuid) AND is_active
                """),
                {"tid": tenant_id},
            )

        await session.execute(
            text("""
                INSERT INTO neural_router_models
                    (tenant_id, architecture, weights, observation_count,
                     validation_precision_at_k, is_active)
                VALUES
                    (CAST(:tid AS uuid), :arch, :weights, :obs,
                     :precision, :active)
            """),
            {
                "tid": tenant_id,
                "arch": arch_name,
                "weights": weights_bytes,
                "obs": obs_count,
                "precision": precision,
                "active": should_promote,
            },
        )

        # Retention policy: keep only last N inactive models per tenant
        max_inactive = settings.neural_router_max_inactive_models
        await session.execute(
            text("""
                DELETE FROM neural_router_models
                WHERE id IN (
                    SELECT id FROM neural_router_models
                    WHERE tenant_id = CAST(:tid AS uuid) AND NOT is_active
                    ORDER BY trained_at DESC
                    OFFSET :keep
                )
            """),
            {"tid": tenant_id, "keep": max_inactive},
        )

        await session.commit()

    if should_promote:
        log.info(
            "Promoted %s model (precision=%.4f) for tenant %s",
            arch_name,
            precision,
            tenant_id,
        )
    else:
        log.info(
            "Stored %s model (precision=%.4f < current %.4f) — not promoted",
            arch_name,
            precision,
            current_precision,
        )

    return should_promote


# ── Train for Tenant ─────────────────────────────────────────────────────


async def train_for_tenant(tenant_id: str) -> None:
    """Full training cycle for a single tenant."""
    log.info("Starting training for tenant %s", tenant_id)

    examples = await assemble_training_data(tenant_id)
    if not examples:
        log.info("No labeled data for tenant %s — skipping", tenant_id)
        return

    obs_count = len(examples)
    result = train_model(examples, obs_count)
    if result is None:
        log.warning("Training failed for tenant %s", tenant_id)
        return

    model, arch_name, precision = result
    await save_model(model, arch_name, precision, obs_count, tenant_id)


# ── Startup Probe ────────────────────────────────────────────────────────


async def startup_probe(r: aioredis.Redis) -> None:
    """Check for tenants that need training but have no active model."""
    log.info("Running startup probe...")

    # Drain stale signals left from previous crash-loop restarts so we
    # don't accumulate duplicate work in the queue.
    drained = await r.delete("neural_router:train_signal")
    if drained:
        log.info("Startup probe: drained stale train signal queue")

    async with get_db() as session:
        # Find tenants with enough labeled observations but no active model
        rows = await session.execute(
            text("""
                SELECT rl.tenant_id::text, count(*) AS cnt
                FROM retrieval_log rl
                WHERE rl.engrams_used IS NOT NULL
                GROUP BY rl.tenant_id
                HAVING count(*) >= :min_obs
            """),
            {"min_obs": settings.neural_router_min_observations},
        )
        tenants_ready = rows.fetchall()

        for row in tenants_ready:
            tid = row.tenant_id
            # Check if this tenant already has an active model
            active = await session.execute(
                text("""
                    SELECT 1 FROM neural_router_models
                    WHERE tenant_id = CAST(:tid AS uuid) AND is_active
                    LIMIT 1
                """),
                {"tid": tid},
            )
            if active.fetchone() is None:
                log.info(
                    "Startup probe: tenant %s has %d observations, no model — enqueuing",
                    tid,
                    row.cnt,
                )
                await r.lpush(
                    "neural_router:train_signal",
                    json.dumps({"tenant_id": tid, "observation_count": row.cnt}),
                )


# ── Main Loop ────────────────────────────────────────────────────────────


async def main_loop() -> None:
    """BRPOP listener on Redis db6 for neural_router:train_signal."""
    base = settings.redis_url.rsplit("/", 1)[0]
    r = aioredis.from_url(f"{base}/6", decode_responses=True)

    log.info("Neural Router trainer starting on Redis db6")

    # Run startup probe
    await startup_probe(r)

    log.info("Listening for train signals on neural_router:train_signal...")
    while True:
        try:
            result = await r.brpop("neural_router:train_signal", timeout=30)
            if result is None:
                continue

            _, payload = result
            try:
                data = json.loads(payload)
                tenant_id = data.get("tenant_id", _DEFAULT_TENANT)
            except (json.JSONDecodeError, AttributeError):
                tenant_id = _DEFAULT_TENANT

            await train_for_tenant(tenant_id)

        except aioredis.ConnectionError:
            log.warning("Redis connection lost, retrying in 5s...")
            await asyncio.sleep(5)
        except Exception:
            log.exception("Unexpected error in training loop")
            await asyncio.sleep(5)


def main() -> None:
    """Entrypoint for the training container."""
    log.info("Neural Router training container starting")
    try:
        asyncio.run(main_loop())
    except KeyboardInterrupt:
        log.info("Trainer shutting down")


if __name__ == "__main__":
    main()
