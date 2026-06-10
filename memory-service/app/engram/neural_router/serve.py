"""Neural Router serving — model loading, caching, and re-ranking.

Loaded by memory-service to re-rank spreading activation candidates
in the /context code path. Background task refreshes model cache
every neural_router_model_check_interval seconds.
"""

from __future__ import annotations

import io
import logging
from datetime import datetime

import torch
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings

from .features import extract_embedding_features, extract_scalar_features
from .model import EmbeddingReranker, ScalarReranker

log = logging.getLogger(__name__)

# Module-level model cache
_cached_model: ScalarReranker | EmbeddingReranker | None = None
_cached_arch: str | None = None
_cached_trained_at: datetime | None = None
_cached_tenant_id: str | None = None


async def load_latest_model(
    session: AsyncSession,
    tenant_id: str = "00000000-0000-0000-0000-000000000001",
) -> bool:
    """Load the latest active model from PostgreSQL if newer than cached.

    Returns True if a new model was loaded, False otherwise.
    """
    global _cached_model, _cached_arch, _cached_trained_at, _cached_tenant_id

    try:
        row = await session.execute(
            text("""
                SELECT architecture, weights, trained_at
                FROM neural_router_models
                WHERE tenant_id = CAST(:tid AS uuid) AND is_active
                LIMIT 1
            """),
            {"tid": tenant_id},
        )
        result = row.fetchone()

        if result is None:
            return False

        # Skip if we already have this exact model
        if (
            _cached_trained_at is not None
            and _cached_tenant_id == tenant_id
            and result.trained_at <= _cached_trained_at
        ):
            return False

        # Deserialize with safe loading (weights_only=True — security requirement)
        buf = io.BytesIO(result.weights)
        state_dict = torch.load(buf, map_location="cpu", weights_only=True)

        if result.architecture == "embedding":
            model = EmbeddingReranker()
        else:
            model = ScalarReranker()

        model.load_state_dict(state_dict)
        model.eval()

        _cached_model = model
        _cached_arch = result.architecture
        _cached_trained_at = result.trained_at
        _cached_tenant_id = tenant_id

        log.info(
            "Loaded %s model (trained_at=%s) for tenant %s",
            result.architecture,
            result.trained_at,
            tenant_id,
        )
        return True

    except Exception:
        log.warning("Failed to load neural router model", exc_info=True)
        return False


def get_cached_model() -> tuple[ScalarReranker | EmbeddingReranker | None, str | None]:
    """Return the cached model and architecture name, or (None, None)."""
    return _cached_model, _cached_arch


def neural_rerank(
    candidates: list[dict],
    query_embedding: list[float] | None = None,
    temporal_context: dict | None = None,
    max_results: int = 20,
) -> list[dict]:
    """Re-rank candidates using the cached neural router model.

    If no model is loaded, or re-ranking fails, returns candidates unchanged.

    Args:
        candidates: List of candidate dicts from spreading activation.
        query_embedding: 768-dim query embedding (needed for embedding model).
        temporal_context: Dict with time_of_day, day_of_week, active_goal.
        max_results: Maximum number of results to return.

    Returns:
        Re-ranked list of candidate dicts, truncated to max_results.
    """
    if not settings.neural_router_enabled:
        return candidates[:max_results]

    model, arch = get_cached_model()
    if model is None:
        return candidates[:max_results]

    if not candidates:
        return []

    try:
        if temporal_context is None:
            temporal_context = {}

        # Extract scalar features
        scalar_features = extract_scalar_features(candidates, temporal_context)

        with torch.no_grad():
            if arch == "embedding" and query_embedding is not None:
                # Extract embedding features
                candidate_embeddings = [
                    c.get("embedding") or [0.0] * 768 for c in candidates
                ]
                q_emb, e_emb = extract_embedding_features(
                    query_embedding, candidate_embeddings
                )
                scores = model(scalar_features, q_emb, e_emb)
            else:
                # Scalar-only forward pass (works for both architectures
                # but EmbeddingReranker needs embeddings, so fall back to scalar)
                if arch == "embedding":
                    log.debug(
                        "Embedding model but no query embedding — skipping rerank"
                    )
                    return candidates[:max_results]
                scores = model(scalar_features)

        # Sort by score descending
        score_list = scores.squeeze(-1).tolist()
        if isinstance(score_list, float):
            score_list = [score_list]

        paired = list(zip(score_list, candidates))
        paired.sort(key=lambda x: x[0], reverse=True)

        reranked = [c for _, c in paired[:max_results]]
        return reranked

    except Exception:
        log.warning(
            "Neural rerank failed — returning un-reranked candidates", exc_info=True
        )
        return candidates[:max_results]
