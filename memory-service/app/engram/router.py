"""
Engram Network API router — Phases 1-7.

Phase 1: POST /ingest, GET /stats
Phase 2: POST /activate, POST /reconstruct
Phase 3: POST /context, GET /self-model, POST /self-model/bootstrap
Phase 4: POST /consolidate, GET /consolidation-log
Phase 5: GET /router-status, POST /mark-used
Phase 6: GET /graph
Phase 7: POST /outcome-feedback
"""

from __future__ import annotations

import logging
from collections import defaultdict, deque
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Response
from nova_contracts.engram import (
    ActivateRequest,
    ContextRequest,
    IngestRequest,
    IngestResponse,
    MarkUsedRequest,
)
from pydantic import BaseModel, Field
from sqlalchemy import text

from app.db.database import get_db

from .activation import spreading_activation
from .consolidation import bootstrap_self_model, run_consolidation
from .ingestion import ingest_direct
from .neural_router.serve import get_cached_model
from .outcome_feedback import process_feedback
from .reconstruction import get_self_model_summary, reconstruct
from .retrieval_logger import (
    get_labeled_observation_count,
    get_observation_count,
    mark_engrams_used,
)
from .working_memory import assemble_context, format_context_prompt

log = logging.getLogger(__name__)

engram_router = APIRouter(prefix="/api/v1/engrams", tags=["engrams"])


# ── Tenant resolution (FC-001 grace period) ───────────────────────────────────
#
# Phase 1-3 of the multi-tenancy rollout: callers SHOULD pass tenant_id on every
# request. Missing values default to the seeded tenant with a WARNING log so we
# can find stragglers in production. Phase 4 flips this to raise 400.

DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001"


def _resolve_tenant(tenant_id: UUID | None, endpoint: str) -> str:
    """Return a tenant_id string, falling back to DEFAULT_TENANT with a WARNING
    when the caller didn't provide one. Centralizes the Phase 1 grace-period
    behavior so Phase 4 can flip it in one place."""
    if tenant_id is None:
        log.warning(
            "memory-service %s called without tenant_id — defaulting to %s. "
            "This will become a 400 once FC-001 rollout completes (Phase 4).",
            endpoint,
            DEFAULT_TENANT,
        )
        return DEFAULT_TENANT
    return str(tenant_id)


# ── Phase 1: Ingestion ────────────────────────────────────────────────


@engram_router.post("/ingest", response_model=IngestResponse, status_code=201)
async def ingest_engram(req: IngestRequest):
    """Ingest raw text directly into the engram graph (bypasses queue)."""
    tenant_id = _resolve_tenant(req.tenant_id, "/ingest")
    result = await ingest_direct(
        raw_text=req.raw_text,
        source_type=req.source_type.value
        if hasattr(req.source_type, "value")
        else req.source_type,
        source_id=str(req.source_id) if req.source_id else None,
        session_id=str(req.session_id) if req.session_id else None,
        occurred_at=req.occurred_at.isoformat() if req.occurred_at else None,
        metadata=req.metadata,
        tenant_id=tenant_id,
    )
    return IngestResponse(
        engrams_created=result["engrams_created"],
        engrams_updated=result["engrams_updated"],
        edges_created=result["edges_created"],
        engram_ids=result["engram_ids"],
    )


@engram_router.get("/stats")
async def engram_stats():
    """Return statistics about the engram graph."""
    async with get_db() as session:
        type_rows = await session.execute(
            text("""
                SELECT type, count(*) AS cnt,
                       count(*) FILTER (WHERE superseded) AS superseded_cnt
                FROM engrams
                GROUP BY type ORDER BY cnt DESC
            """)
        )
        by_type = {
            row.type: {"total": row.cnt, "superseded": row.superseded_cnt}
            for row in type_rows
        }

        edge_rows = await session.execute(
            text("""
                SELECT relation, count(*) AS cnt,
                       round(avg(weight)::numeric, 3) AS avg_weight
                FROM engram_edges
                GROUP BY relation ORDER BY cnt DESC
            """)
        )
        by_relation = {
            row.relation: {"count": row.cnt, "avg_weight": float(row.avg_weight)}
            for row in edge_rows
        }

        source_rows = await session.execute(
            text("""
                SELECT source_type, count(*) AS cnt
                FROM engrams
                GROUP BY source_type ORDER BY cnt DESC
            """)
        )
        by_source_type = {row.source_type: row.cnt for row in source_rows}

        total_engrams = (
            await session.execute(text("SELECT count(*) FROM engrams"))
        ).scalar()
        total_edges = (
            await session.execute(text("SELECT count(*) FROM engram_edges"))
        ).scalar()
        total_archived = (
            await session.execute(text("SELECT count(*) FROM engram_archive"))
        ).scalar()

        profile_rows = await session.execute(
            text("""
                SELECT source_type, type, count(*) AS cnt
                FROM engrams
                WHERE NOT superseded AND type IN ('entity', 'fact', 'preference')
                GROUP BY source_type, type
            """)
        )
        user_profile = {"entity_count": 0, "fact_count": 0, "preference_count": 0}
        for row in profile_rows:
            if row.source_type in ("chat", "consolidation"):
                if row.type == "entity":
                    user_profile["entity_count"] += row.cnt
                elif row.type == "fact":
                    user_profile["fact_count"] += row.cnt
                elif row.type == "preference":
                    user_profile["preference_count"] += row.cnt

    return {
        "total_engrams": total_engrams,
        "total_edges": total_edges,
        "total_archived": total_archived,
        "by_type": by_type,
        "by_relation": by_relation,
        "by_source_type": by_source_type,
        "user_profile": user_profile,
    }


@engram_router.get("/health")
async def memory_health():
    """Comprehensive memory system diagnostics — is the system self-improving?"""
    async with get_db() as session:
        # 1. Outcome feedback
        outcome_row = await session.execute(
            text("""
            SELECT count(*) FILTER (WHERE outcome_count > 0) AS with_outcomes,
                   round((avg(outcome_avg) FILTER (WHERE outcome_count > 0))::numeric, 3) AS avg_score,
                   max(outcome_count) AS max_obs
            FROM engrams
        """)
        )
        o = outcome_row.fetchone()

        # 2. Recalibration
        recalib_row = await session.execute(
            text("""
            SELECT count(*) FILTER (WHERE outcome_count >= 5 AND outcome_avg > 0.65) AS boost,
                   count(*) FILTER (WHERE outcome_count >= 5 AND outcome_avg < 0.45) AS demote,
                   count(*) FILTER (WHERE last_recalibrated_at IS NOT NULL) AS recalibrated
            FROM engrams WHERE outcome_count > 0 AND NOT superseded
        """)
        )
        r = recalib_row.fetchone()

        # 3. Activation distribution
        act_row = await session.execute(
            text("""
            SELECT count(*) FILTER (WHERE activation >= 1.0) AS full,
                   count(*) FILTER (WHERE activation >= 0.5 AND activation < 1.0) AS mid,
                   count(*) FILTER (WHERE activation >= 0.05 AND activation < 0.5) AS low,
                   count(*) FILTER (WHERE activation < 0.05) AS floor_val
            FROM engrams WHERE NOT superseded
        """)
        )
        a = act_row.fetchone()

        # 4. Co-activations
        coact_row = await session.execute(
            text("""
            SELECT count(*) FILTER (WHERE co_activations > 1) AS strengthened,
                   max(co_activations) AS max_coact
            FROM engram_edges
        """)
        )
        c = coact_row.fetchone()

        # 5. Consolidation
        topic_row = await session.execute(
            text("""
            SELECT count(*) FILTER (WHERE NOT superseded) AS living,
                   count(*) FILTER (WHERE superseded) AS superseded
            FROM engrams WHERE type = 'topic'
        """)
        )
        t = topic_row.fetchone()

        last_consol = await session.execute(
            text("""
            SELECT created_at, engrams_reviewed,
                   COALESCE(topics_created, 0) AS topics_created,
                   engrams_merged, edges_pruned
            FROM consolidation_log
            ORDER BY created_at DESC LIMIT 1
        """)
        )
        lc = last_consol.fetchone()

        # 6. Neural router
        nr_row = await session.execute(
            text("""
            SELECT count(*) AS models,
                   max(trained_at) AS latest
            FROM neural_router_models
        """)
        )
        nr = nr_row.fetchone()

        obs_row = await session.execute(text("SELECT count(*) FROM retrieval_log"))
        obs_count = obs_row.scalar()

        # 7. Age check (for activation decay status)
        age_row = await session.execute(
            text("""
            SELECT min(created_at) AS oldest,
                   count(*) FILTER (WHERE created_at < NOW() - INTERVAL '30 days') AS older_30d
            FROM engrams WHERE NOT superseded
        """)
        )
        age = age_row.fetchone()

    # Build issues list
    issues = []
    if (o.with_outcomes or 0) == 0:
        issues.append(
            "Outcome feedback is not flowing — engrams have no outcome scores"
        )
    if (c.max_coact or 1) <= 1:
        issues.append("Co-activations never increment — Hebbian learning is inactive")
    if (a.mid or 0) == 0 and (a.low or 0) == 0:
        oldest_days = (
            (datetime.now(timezone.utc) - age.oldest).days if age.oldest else 0
        )
        if oldest_days >= 30:
            issues.append(
                "All engrams at full activation despite being 30+ days old — decay may not be running"
            )
        else:
            issues.append(
                f"Activation decay hasn't kicked in yet — oldest engram is {oldest_days} days old, decay starts at 30"
            )
    total_topics = (t.living or 0) + (t.superseded or 0)
    if total_topics > 0 and (t.superseded or 0) / total_topics > 0.80:
        issues.append(
            f"Topic supersession rate is {(t.superseded or 0) * 100 // total_topics}% — consolidation may be churning"
        )
    if (r.recalibrated or 0) == 0 and (o.with_outcomes or 0) > 50:
        issues.append("No engrams have been recalibrated despite having outcome data")

    self_improving = (o.with_outcomes or 0) > 0 and len(issues) <= 2

    return {
        "outcome_feedback": {
            "engrams_with_outcomes": o.with_outcomes or 0,
            "avg_outcome_score": float(o.avg_score) if o.avg_score else None,
            "max_observations": o.max_obs or 0,
            "recalibration": {
                "boost_eligible": r.boost or 0,
                "demote_eligible": r.demote or 0,
                "recalibrated_total": r.recalibrated or 0,
            },
        },
        "activation": {
            "full": a.full or 0,
            "mid": a.mid or 0,
            "low": a.low or 0,
            "floor": a.floor_val or 0,
        },
        "co_activations": {
            "edges_strengthened": c.strengthened or 0,
            "max_co_activations": c.max_coact or 0,
        },
        "consolidation": {
            "living_topics": t.living or 0,
            "superseded_topics": t.superseded or 0,
            "supersession_rate": round((t.superseded or 0) / max(total_topics, 1), 3),
            "last_run": lc.created_at.isoformat() if lc else None,
            "last_run_stats": {
                "topics_created": lc.topics_created if lc else 0,
                "engrams_merged": lc.engrams_merged if lc else 0,
                "edges_pruned": lc.edges_pruned if lc else 0,
            }
            if lc
            else None,
        },
        "neural_router": {
            "models_trained": nr.models or 0,
            "retrieval_observations": obs_count or 0,
            "latest_model_date": nr.latest.isoformat() if nr.latest else None,
        },
        "self_improving": self_improving,
        "issues": issues,
    }


@engram_router.get("/user-profile")
async def get_user_profile():
    """Return what Nova knows about the user — entities, facts, preferences from personal sources."""
    async with get_db() as session:
        entity_rows = await session.execute(
            text("""
                SELECT id::text, content, confidence, importance,
                       created_at, last_accessed, source_meta::text
                FROM engrams
                WHERE type = 'entity'
                  AND source_type IN ('chat', 'consolidation')
                  AND NOT superseded
                  AND content NOT LIKE 'nova-test-%'
                ORDER BY importance DESC, access_count DESC
                LIMIT 50
            """)
        )

        detail_rows = await session.execute(
            text("""
                SELECT id::text, type, content, confidence, importance,
                       created_at, source_meta::text
                FROM engrams
                WHERE type IN ('fact', 'preference')
                  AND source_type IN ('chat', 'consolidation')
                  AND NOT superseded
                  AND content NOT LIKE 'nova-test-%'
                ORDER BY importance DESC, access_count DESC
                LIMIT 100
            """)
        )

    import json as _json

    entities = []
    for r in entity_rows:
        meta = {}
        if r.source_meta:
            try:
                meta = _json.loads(r.source_meta)
            except Exception:
                pass
        entities.append(
            {
                "id": r.id,
                "name": r.content,
                "confidence": r.confidence,
                "importance": r.importance,
                "learned_at": r.created_at.isoformat() if r.created_at else None,
                "last_seen": r.last_accessed.isoformat() if r.last_accessed else None,
                "source": meta.get("session_id") or meta.get("title") or "conversation",
            }
        )

    facts = []
    preferences = []
    for r in detail_rows:
        meta = {}
        if r.source_meta:
            try:
                meta = _json.loads(r.source_meta)
            except Exception:
                pass
        item = {
            "id": r.id,
            "content": r.content,
            "confidence": r.confidence,
            "learned_at": r.created_at.isoformat() if r.created_at else None,
            "source": meta.get("session_id") or meta.get("title") or "conversation",
        }
        if r.type == "fact":
            facts.append(item)
        else:
            preferences.append(item)

    return {"entities": entities, "facts": facts, "preferences": preferences}


# ── Memory Correction ─────────────────────────────────────────────────


class CorrectionRequest(BaseModel):
    correction: str  # e.g., "My name is Jeremy, not James"
    engram_id: str | None = None  # optional — target a specific engram


@engram_router.post("/correct")
async def correct_engram(req: CorrectionRequest):
    """Apply a user correction to an entity or fact engram."""
    from app.embedding import get_embedding, to_pg_vector

    async with get_db() as session:
        old_content = None
        target_id = None

        if req.engram_id:
            # Direct correction — find the specific engram
            row = await session.execute(
                text(
                    "SELECT id, content FROM engrams WHERE id = CAST(:id AS uuid) AND NOT superseded"
                ),
                {"id": req.engram_id},
            )
            found = row.fetchone()
            if not found:
                raise HTTPException(status_code=404, detail="Engram not found")
            target_id = found.id
            old_content = found.content
        else:
            # Semantic search — find the most relevant personal entity/fact
            emb = await get_embedding(req.correction, session)
            if emb is None:
                raise HTTPException(
                    status_code=503, detail="Embedding service unavailable"
                )
            row = await session.execute(
                text("""
                    SELECT id, content, 1 - (embedding <=> CAST(:emb AS halfvec)) AS sim
                    FROM engrams
                    WHERE type IN ('entity', 'fact', 'preference')
                      AND source_type IN ('chat', 'consolidation')
                      AND NOT superseded
                      AND embedding IS NOT NULL
                    ORDER BY embedding <=> CAST(:emb AS halfvec)
                    LIMIT 1
                """),
                {"emb": to_pg_vector(emb)},
            )
            found = row.fetchone()
            if not found or found.sim < 0.4:
                raise HTTPException(
                    status_code=404, detail="No matching engram found for correction"
                )
            target_id = found.id
            old_content = found.content

        # Supersede the old engram
        await session.execute(
            text(
                "UPDATE engrams SET superseded = TRUE, updated_at = NOW() WHERE id = CAST(:id AS uuid)"
            ),
            {"id": str(target_id)},
        )

        # Create the corrected engram
        import uuid as _uuid

        new_id = _uuid.uuid4()
        emb = await get_embedding(req.correction, session)

        await session.execute(
            text("""
                INSERT INTO engrams (id, type, content, embedding, source_type, confidence, importance, activation, created_at, updated_at)
                VALUES (CAST(:id AS uuid), 'fact', :content, CAST(:emb AS halfvec), 'chat', 0.95, 0.8, 1.0, NOW(), NOW())
            """),
            {
                "id": str(new_id),
                "content": req.correction,
                "emb": to_pg_vector(emb) if emb else None,
            },
        )

        await session.commit()

    return {
        "corrected": 1,
        "old_content": old_content,
        "new_content": req.correction,
        "engram_id": str(new_id),
    }


# ── Post-wipe Onboarding ────────────────────────────────────────────────


class BootstrapFact(BaseModel):
    attribute: str  # e.g., "name", "role", "interests"
    value: str


class BootstrapRequest(BaseModel):
    facts: list[BootstrapFact]


@engram_router.post("/user-profile/bootstrap")
async def bootstrap_user_profile(req: BootstrapRequest):
    """Seed initial user profile facts. Used after factory reset or first boot."""
    from app.embedding import get_embedding, to_pg_vector

    async with get_db() as session:
        created_ids = []
        for fact in req.facts:
            if not fact.value.strip():
                continue

            content = f"The user's {fact.attribute} is {fact.value}"
            emb = await get_embedding(content, session)

            import uuid

            new_id = uuid.uuid4()

            # Check for existing similar entity (dedup)
            if emb:
                existing = await session.execute(
                    text("""
                        SELECT id FROM engrams
                        WHERE type IN ('entity', 'fact')
                          AND source_type IN ('chat', 'consolidation')
                          AND NOT superseded
                          AND embedding IS NOT NULL
                          AND 1 - (embedding <=> CAST(:emb AS halfvec)) > 0.90
                        LIMIT 1
                    """),
                    {"emb": to_pg_vector(emb)},
                )
                if existing.fetchone():
                    continue  # Already know this, skip

            await session.execute(
                text("""
                    INSERT INTO engrams (id, type, content, embedding, source_type, confidence, importance, activation, created_at, updated_at)
                    VALUES (CAST(:id AS uuid), 'fact', :content, CAST(:emb AS halfvec), 'chat', 0.95, 0.8, 1.0, NOW(), NOW())
                """),
                {
                    "id": str(new_id),
                    "content": content,
                    "emb": to_pg_vector(emb) if emb else None,
                },
            )
            created_ids.append(str(new_id))

        await session.commit()

    return {"created": len(created_ids), "engram_ids": created_ids}


# ── Phase 2: Spreading Activation + Reconstruction ────────────────────


@engram_router.post("/activate")
async def activate_engrams(req: ActivateRequest):
    """Run spreading activation on a query and return activated engrams."""
    tenant_id = _resolve_tenant(req.tenant_id, "/activate")
    async with get_db() as session:
        activated = await spreading_activation(
            session,
            req.query,
            seed_count=req.seed_count,
            max_hops=req.max_hops,
            max_results=req.max_results,
            depth=req.depth,
            tenant_id=tenant_id,
        )
    return {
        "count": len(activated),
        "engrams": [
            {
                "id": a.id,
                "type": a.type,
                "content": a.content,
                "activation": round(a.activation, 4),
                "importance": round(a.importance, 4),
                "final_score": round(a.final_score, 4),
                "convergence_paths": a.convergence_paths,
                "source_type": a.source_type,
            }
            for a in activated
        ],
    }


@engram_router.post("/reconstruct")
async def reconstruct_memory(query: str):
    """Activate + reconstruct coherent memory text from the engram graph."""
    async with get_db() as session:
        activated = await spreading_activation(session, query)
        if not activated:
            return {"text": "", "engram_count": 0}

        self_model = await get_self_model_summary(session)
        text_result = await reconstruct(
            session,
            activated,
            context=query,
            self_model_summary=self_model,
        )
    return {
        "text": text_result,
        "engram_count": len(activated),
        "top_engrams": [
            {"id": a.id, "type": a.type, "score": round(a.final_score, 4)}
            for a in activated[:5]
        ],
    }


# ── Phase 3: Working Memory Gate ───────────────────────────────────────


@engram_router.post("/context")
async def get_engram_context(req: ContextRequest):
    """Assemble the full working memory context for a query.

    This is the main endpoint the orchestrator calls to get engram-powered
    memory context for prompt assembly.
    """
    tenant_id = _resolve_tenant(req.tenant_id, "/context")
    async with get_db() as session:
        ctx = await assemble_context(
            session,
            query=req.query,
            session_id=req.session_id,
            current_turn=req.current_turn,
            depth=req.depth,
            tenant_id=tenant_id,
        )
    prompt = format_context_prompt(ctx)
    return {
        "context": prompt,
        "total_tokens": ctx.total_tokens,
        "sections": {
            "self_model": bool(ctx.self_model),
            "active_goal": bool(ctx.active_goal),
            "memories": bool(ctx.memories),
            "key_decisions": bool(ctx.key_decisions),
            "open_threads": bool(ctx.open_threads),
        },
        "engram_ids": ctx.engram_ids,
        "engram_summaries": ctx.engram_summaries,
        "retrieval_log_id": ctx.retrieval_log_id,
    }


@engram_router.get("/self-model")
async def get_self_model():
    """Return the current self-model summary."""
    async with get_db() as session:
        summary = await get_self_model_summary(session)
    return {"self_model": summary}


@engram_router.post("/self-model/bootstrap")
async def bootstrap_self_model_endpoint():
    """Seed default self-model engrams (idempotent — skips if already present)."""
    async with get_db() as session:
        created = await bootstrap_self_model(session)
        await session.commit()
    return {"created": created}


# ── Phase 4: Consolidation ─────────────────────────────────────────────


@engram_router.post("/consolidate")
async def trigger_consolidation():
    """Manually trigger a consolidation cycle."""
    stats = await run_consolidation(trigger="manual")
    return stats


@engram_router.get("/consolidation-log")
async def get_consolidation_log(limit: int = Query(default=20, le=100)):
    """Return recent consolidation log entries."""
    async with get_db() as session:
        result = await session.execute(
            text("""
                SELECT id, trigger_type, engrams_reviewed, schemas_created,
                       edges_strengthened, edges_pruned, engrams_pruned,
                       engrams_merged, contradictions_resolved,
                       COALESCE(topics_created, 0) AS topics_created,
                       self_model_updates::text, model_used, duration_ms,
                       created_at
                FROM consolidation_log
                ORDER BY created_at DESC
                LIMIT :limit
            """),
            {"limit": limit},
        )
        rows = result.fetchall()

    import json

    return {
        "count": len(rows),
        "entries": [
            {
                "id": str(row.id),
                "trigger": row.trigger_type,
                "engrams_reviewed": row.engrams_reviewed,
                "schemas_created": row.schemas_created,
                "edges_strengthened": row.edges_strengthened,
                "edges_pruned": row.edges_pruned,
                "engrams_pruned": row.engrams_pruned,
                "engrams_merged": row.engrams_merged,
                "contradictions_resolved": row.contradictions_resolved,
                "topics_created": getattr(row, "topics_created", 0),
                "self_model_updates": json.loads(row.self_model_updates)
                if row.self_model_updates
                else {},
                "model_used": row.model_used,
                "duration_ms": row.duration_ms,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ],
    }


@engram_router.get("/topics")
async def list_topics():
    """List all active topic engrams with member counts."""
    async with get_db() as session:
        result = await session.execute(
            text("""
                SELECT e.id::text, e.content, e.importance, e.source_meta,
                       e.created_at,
                       (SELECT count(*) FROM engram_edges ee
                        WHERE ee.target_id = e.id AND ee.relation = 'part_of') AS member_count
                FROM engrams e
                WHERE e.type = 'topic' AND NOT e.superseded
                ORDER BY importance DESC
            """)
        )
        rows = result.fetchall()

    import json

    return {
        "count": len(rows),
        "topics": [
            {
                "id": row.id,
                "content": row.content,
                "importance": round(float(row.importance), 3),
                "member_count": row.member_count,
                "entity_anchors": (
                    row.source_meta
                    if isinstance(row.source_meta, dict)
                    else json.loads(row.source_meta or "{}")
                ).get("entity_anchors", [])
                if row.source_meta
                else [],
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ],
    }


@engram_router.get("/engrams/{engram_id}")
async def get_engram_detail(engram_id: str):
    """Get full detail for a single engram (no content truncation)."""
    async with get_db() as session:
        result = await session.execute(
            text("""
                SELECT id::text, type, content, activation, importance,
                       access_count, confidence, source_type, superseded,
                       created_at, source_ref_id::text, source_meta
                FROM engrams
                WHERE id = CAST(:id AS uuid)
            """),
            {"id": engram_id},
        )
        row = result.fetchone()
        if not row:
            from fastapi import HTTPException

            raise HTTPException(404, "Engram not found")

    return {
        "id": row.id,
        "type": row.type,
        "content": row.content,  # Full content, no truncation
        "activation": round(float(row.activation), 4),
        "importance": round(float(row.importance), 4),
        "access_count": row.access_count,
        "confidence": round(float(row.confidence), 4),
        "source_type": row.source_type,
        "superseded": row.superseded,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "source_ref_id": row.source_ref_id,
        "source_meta": row.source_meta if isinstance(row.source_meta, dict) else {},
    }


@engram_router.delete("/engrams/{engram_id}", status_code=204)
async def delete_engram(engram_id: str):
    """Permanently delete an engram ("forget this").

    Cascades:
    - engram_edges rows with this engram as source or target → deleted (FK CASCADE)
    - working_memory_slots referencing it → deleted (FK CASCADE)
    - retrieval_log.engrams_surfaced/engrams_used arrays → dangling UUIDs remain
      (client code filters missing engrams at read time; keeps retrieval analytics intact)
    - sources → preserved (other engrams may still reference them)
    """
    async with get_db() as session:
        result = await session.execute(
            text("DELETE FROM engrams WHERE id = CAST(:id AS uuid) RETURNING id"),
            {"id": engram_id},
        )
        if not result.fetchone():
            from fastapi import HTTPException

            raise HTTPException(404, "Engram not found")
        await session.commit()
    log.info("Deleted engram %s", engram_id)
    return Response(status_code=204)


# ── Phase 5: Neural Router Status & Mark-Used ─────────────────────────


@engram_router.get("/router-status")
async def router_status():
    """Neural Router status: mode, model info, observation counts."""
    async with get_db() as session:
        obs_count = await get_observation_count(session)
        labeled_count = await get_labeled_observation_count(session)

    model, arch = get_cached_model()

    if model is not None:
        mode = "embedding_reranker" if arch == "embedding" else "scalar_reranker"
    elif obs_count >= 200:
        mode = "ready_for_training"
    else:
        mode = "cosine_only"

    return {
        "observation_count": obs_count,
        "labeled_count": labeled_count,
        "mode": mode,
        "model_loaded": model is not None,
        "architecture": arch,
        "ready_for_training": labeled_count >= 200,
        "message": (
            f"Active: {mode} ({obs_count} observations, {labeled_count} labeled)"
            if model is not None
            else f"Collecting observations: {labeled_count}/200 labeled"
        ),
    }


@engram_router.post("/mark-used")
async def mark_used(req: MarkUsedRequest):
    """Mark which engrams were actually used from a retrieval context.

    Called by the orchestrator after the LLM response to provide ground
    truth for Neural Router training.
    """
    tenant_id = _resolve_tenant(req.tenant_id, "/mark-used")
    async with get_db() as session:
        # Tenant isolation: verify the retrieval log belongs to the caller's
        # tenant before updating. Silently returns ok for cross-tenant attempts
        # so we don't leak existence of other tenants' logs.
        owner = await session.execute(
            text("SELECT tenant_id FROM retrieval_log WHERE id = CAST(:id AS uuid)"),
            {"id": req.retrieval_log_id},
        )
        owner_tid = owner.scalar()
        if owner_tid is not None and str(owner_tid) != tenant_id:
            log.warning(
                "mark-used: retrieval_log %s belongs to tenant %s, caller is %s — ignored",
                req.retrieval_log_id,
                owner_tid,
                tenant_id,
            )
            return {"status": "ok"}
        await mark_engrams_used(session, req.retrieval_log_id, req.engram_ids_used)
        await session.commit()
    return {"status": "ok"}


# ── Batch Fetch ────────────────────────────────────────────────────────


class BatchRequest(BaseModel):
    ids: list[str]


class BatchItem(BaseModel):
    id: str
    content: str
    node_type: str


@engram_router.post("/batch", response_model=list[BatchItem])
async def batch_get_engrams(req: BatchRequest):
    """Return engram content for a list of IDs. Used by quality scorer."""
    if not req.ids:
        return []
    async with get_db() as session:
        placeholders = ", ".join(f":id_{i}" for i in range(len(req.ids)))
        params = {f"id_{i}": uid for i, uid in enumerate(req.ids)}
        result = await session.execute(
            text(
                f"SELECT id::text, content, type FROM engrams WHERE id::text IN ({placeholders})"
            ),
            params,
        )
        rows = result.fetchall()
    return [BatchItem(id=r[0], content=r[1], node_type=r[2]) for r in rows]


# ── Phase 6: Graph Visualization ───────────────────────────────────────


# ── Semantic domain classification ───────────────────────────────────────────
# Maps keyword patterns to high-level knowledge domains.
# Each connected component is classified by keyword matching on its content,
# then components sharing a domain are merged into one visual cluster.

DOMAIN_KEYWORDS: dict[str, list[str]] = {
    "AI Models & LLMs": [
        "llm",
        "language model",
        "gpt",
        "claude",
        "gemini",
        "qwen",
        "llama",
        "mistral",
        "ollama",
        "vllm",
        "sglang",
        "inference",
        "fine-tun",
        "quantiz",
        "gguf",
        "lora",
        "transformer",
        "token limit",
        "context window",
        "deepseek",
        "phi-",
        "mixtral",
        "moe",
        "mixture of expert",
    ],
    "AI Agents & Products": [
        "agent",
        "agentic",
        "autonomous",
        "copilot",
        "cursor",
        "aider",
        "claude code",
        "skills hub",
        "chatbot",
        "assistant",
        "multi-agent",
        "tool use",
        "function call",
        "mcp server",
        "mcp tool",
    ],
    "AI Research & Papers": [
        "paper",
        "arxiv",
        "research",
        "benchmark",
        "eval",
        "alignment",
        "interpretab",
        "theorem",
        "proof",
        "study",
        "experiment",
        "finding",
        "methodology",
        "dataset",
        "leaderboard",
        "arc-agi",
        "mmlu",
    ],
    "AI Safety & Ethics": [
        "anthropomorph",
        "consciousness",
        "sentien",
        "bias",
        "fairness",
        "harm",
        "responsible",
        "guardrail",
        "red team",
        "jailbreak",
        "deception",
        "oversight",
        "control problem",
    ],
    "Machine Learning": [
        "training",
        "embedding",
        "vector",
        "neural",
        "gradient",
        "loss",
        "epoch",
        "batch",
        "optimizer",
        "attention",
        "diffusion",
        "gan",
        "reinforcement learn",
        "reward model",
        "classification",
        "regression",
    ],
    "Software Tools": [
        "tool",
        "library",
        "framework",
        "sdk",
        "cli",
        "package",
        "npm",
        "pip",
        "toolkit",
        "utility",
        "plugin",
        "extension",
        "crate",
    ],
    "Open Source Projects": [
        "github",
        "repository",
        "open-source",
        "open source",
        "repo",
        "contributor",
        "release",
        "changelog",
        "license",
        "fork",
    ],
    "Cloud & Infrastructure": [
        "docker",
        "kubernetes",
        "aws",
        "cloud",
        "server",
        "deploy",
        "gpu",
        "hosting",
        "terraform",
        "ansible",
        "ci/cd",
        "pipeline",
        "container",
        "vpc",
        "ec2",
        "lambda",
        "s3",
    ],
    "Hardware & Compute": [
        "chip",
        "memristor",
        "semiconductor",
        "transistor",
        "quantum",
        "tpu",
        "gpu",
        "cuda",
        "rocm",
        "mac mini",
        "apple silicon",
        "compute",
        "fpga",
        "asic",
    ],
    "Programming": [
        "python",
        "javascript",
        "typescript",
        "rust",
        "golang",
        "java",
        "algorithm",
        "data structure",
        "design pattern",
        "refactor",
        "debugging",
        "compiler",
        "syntax",
    ],
    "Web & APIs": [
        "web app",
        "frontend",
        "backend",
        "api",
        "rest",
        "graphql",
        "react",
        "vue",
        "html",
        "css",
        "http",
        "websocket",
        "endpoint",
    ],
    "Data & Databases": [
        "database",
        "sql",
        "postgres",
        "redis",
        "mongodb",
        "data",
        "schema",
        "migration",
        "query",
        "index",
        "cache",
        "storage",
    ],
    "Security": [
        "security",
        "auth",
        "encrypt",
        "vulnerab",
        "attack",
        "credential",
        "secret",
        "permission",
        "oauth",
        "jwt",
        "tls",
        "ssl",
        "cve",
    ],
    "People & Organizations": [
        "founder",
        "ceo",
        "author",
        "researcher",
        "engineer",
        "company",
        "anthropic",
        "openai",
        "google",
        "meta",
        "microsoft",
        "startup",
        "team",
        "hired",
        "acquired",
    ],
    "Nova Self-Knowledge": [
        "nova",
        "self-model",
        "self model",
        "identity",
        "self-knowledge",
        "engram",
        "consolidat",
        "cortex",
        "working memory",
        "my purpose",
    ],
    "User & Preferences": [
        "user prefer",
        "user wants",
        "user like",
        "user needs",
        "communication style",
        "greeting",
        "the user",
    ],
    "Workflow & Automation": [
        "workflow",
        "automat",
        "cron",
        "schedule",
        "batch",
        "scraping",
        "crawler",
        "rss",
        "feed",
        "polling",
        "ingestion",
    ],
    "Documentation & Learning": [
        "document",
        "readme",
        "wiki",
        "guide",
        "tutorial",
        "reference",
        "learning",
        "course",
        "certification",
        "study note",
    ],
    "News & Commentary": [
        "news",
        "article",
        "blog",
        "podcast",
        "reddit",
        "hacker news",
        "opinion",
        "commentary",
        "trend",
        "announcement",
    ],
}


def _classify_domain(content_blob: str) -> str:
    """Classify a text blob into a high-level domain by keyword matching."""
    lower = content_blob.lower()
    scores: dict[str, int] = {}
    for domain, keywords in DOMAIN_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in lower)
        if score > 0:
            scores[domain] = score
    if not scores:
        return "Miscellaneous"
    return max(scores, key=scores.get)


def _merge_into_domains(
    components: list[list[dict]],
) -> tuple[list[dict], dict[str, int]]:
    """Merge connected components into semantic domains.

    Returns (clusters_list, engram_id_to_cluster_id_map).
    """
    domain_groups: dict[str, list[dict]] = defaultdict(list)
    for members in components:
        content_blob = " ".join(m["content"] or "" for m in members)
        domain = _classify_domain(content_blob)
        domain_groups[domain].extend(members)

    # Sort domains by size (largest first)
    sorted_domains = sorted(domain_groups.items(), key=lambda x: -len(x[1]))

    clusters: list[dict] = []
    engram_cluster: dict[str, int] = {}
    for idx, (domain, members) in enumerate(sorted_domains):
        clusters.append({"id": idx, "label": domain, "count": len(members)})
        for m in members:
            engram_cluster[m["id"]] = idx

    return clusters, engram_cluster


@engram_router.get("/graph")
async def get_graph(
    center_id: str | None = Query(default=None, description="Engram ID to center on"),
    query: str | None = Query(
        default=None, description="Query to find center via activation"
    ),
    depth: int = Query(default=2, ge=1, le=4, description="BFS depth"),
    max_nodes: int = Query(default=50, ge=10, le=5000),
    mode: str = Query(
        default="bfs", description="bfs = BFS from center, full = all clusters"
    ),
):
    """Return a subgraph for visualization (nodes + edges).

    mode=bfs: BFS from a center node (default, backward-compatible).
    mode=full: Return all non-superseded engrams with connected-component
    clustering and domain labels. Like an Obsidian graph view.
    """
    async with get_db() as session:
        # ── Full-graph mode: all clusters ────────────────────────────────
        if mode == "full":
            # Fetch all non-superseded engrams
            engrams_result = await session.execute(
                text("""
                    SELECT id::text, type, LEFT(content, 200) AS content,
                           activation, importance, access_count, confidence,
                           source_type, superseded, created_at
                    FROM engrams
                    WHERE NOT superseded
                    ORDER BY importance DESC
                    LIMIT :limit
                """),
                {"limit": max_nodes},
            )
            all_engrams = [
                {
                    "id": r.id,
                    "type": r.type,
                    "content": r.content,
                    "activation": float(r.activation),
                    "importance": float(r.importance),
                    "access_count": r.access_count,
                    "confidence": float(r.confidence),
                    "source_type": r.source_type,
                    "superseded": r.superseded,
                    "created_at": r.created_at,
                }
                for r in engrams_result
            ]

            if not all_engrams:
                return {"nodes": [], "edges": [], "clusters": []}

            engram_ids = [e["id"] for e in all_engrams]
            id_set = set(engram_ids)

            # Fetch all edges between selected engrams
            edges_result = await session.execute(
                text("""
                    SELECT source_id::text, target_id::text, relation,
                           weight, co_activations
                    FROM engram_edges
                    WHERE source_id = ANY(CAST(:ids AS uuid[]))
                      AND target_id = ANY(CAST(:ids AS uuid[]))
                """),
                {"ids": engram_ids},
            )
            raw_edges = [
                {
                    "source_id": r.source_id,
                    "target_id": r.target_id,
                    "relation": r.relation,
                    "weight": float(r.weight),
                    "co_activations": r.co_activations,
                }
                for r in edges_result
            ]

            # ── Topic-based clustering ────────────────────────────────────
            # Use topic engrams and part_of edges for natural clustering
            # instead of hardcoded keyword classification.
            topic_edges = await session.execute(
                text("""
                    SELECT ee.source_id::text AS member_id,
                           ee.target_id::text AS topic_id,
                           t.content AS topic_content
                    FROM engram_edges ee
                    JOIN engrams t ON t.id = ee.target_id
                      AND t.type = 'topic' AND NOT t.superseded
                    WHERE ee.relation = 'part_of'
                      AND ee.source_id = ANY(CAST(:ids AS uuid[]))
                """),
                {"ids": engram_ids},
            )
            topic_memberships = topic_edges.fetchall()

            # Build cluster map from topic memberships
            topic_ids_seen: dict[str, int] = {}  # topic_id -> cluster_id
            engram_cluster: dict[str, int] = {}
            clusters: list[dict] = []

            for row in topic_memberships:
                if row.topic_id not in topic_ids_seen:
                    cluster_id = len(clusters)
                    topic_ids_seen[row.topic_id] = cluster_id
                    # Extract topic name (first line of "TOPIC: <name>\n<summary>")
                    label = row.topic_content or "Unnamed Topic"
                    if label.startswith("TOPIC: "):
                        label = label[7:]
                    if "\n" in label:
                        label = label.split("\n")[0]
                    clusters.append(
                        {
                            "id": cluster_id,
                            "label": label.strip(),
                            "count": 0,
                            "topic_engram_id": row.topic_id,
                        }
                    )
                cluster_id = topic_ids_seen[row.topic_id]
                engram_cluster[row.member_id] = cluster_id
                clusters[cluster_id]["count"] += 1

            # Uncategorized cluster for engrams not in any topic
            uncategorized_count = sum(
                1
                for e in all_engrams
                if e["id"] not in engram_cluster and e["type"] != "topic"
            )
            if uncategorized_count > 0:
                uncat_id = len(clusters)
                clusters.append(
                    {
                        "id": uncat_id,
                        "label": "Uncategorized",
                        "count": uncategorized_count,
                    }
                )
                for e in all_engrams:
                    if e["id"] not in engram_cluster and e["type"] != "topic":
                        engram_cluster[e["id"]] = uncat_id

            # Assign topic nodes to their own cluster
            for e in all_engrams:
                if e["type"] == "topic" and e["id"] in topic_ids_seen:
                    engram_cluster[e["id"]] = topic_ids_seen[e["id"]]

            # Sort clusters by count descending
            clusters.sort(key=lambda c: -c["count"])
            # Remap cluster IDs after sorting
            old_to_new = {c["id"]: i for i, c in enumerate(clusters)}
            for c in clusters:
                c["id"] = old_to_new[c["id"]]
            engram_cluster = {
                eid: old_to_new[cid] for eid, cid in engram_cluster.items()
            }

            # Build response
            nodes = [
                {
                    "id": e["id"],
                    "type": e["type"],
                    "content": e["content"],
                    "activation": round(e["activation"], 3),
                    "importance": round(e["importance"], 3),
                    "access_count": e["access_count"],
                    "confidence": round(e["confidence"], 3),
                    "source_type": e["source_type"],
                    "superseded": e["superseded"],
                    "created_at": e["created_at"].isoformat()
                    if e["created_at"]
                    else None,
                    "cluster_id": engram_cluster.get(e["id"], 0),
                    "cluster_label": clusters[engram_cluster.get(e["id"], 0)]["label"]
                    if e["id"] in engram_cluster
                    else "Uncategorized",
                }
                for e in all_engrams
            ]

            edges = [
                {
                    "source": e["source_id"],
                    "target": e["target_id"],
                    "relation": e["relation"],
                    "weight": round(e["weight"], 3),
                    "co_activations": e["co_activations"],
                }
                for e in raw_edges
            ]

            return {
                "nodes": nodes,
                "edges": edges,
                "clusters": clusters,
                "node_count": len(nodes),
                "edge_count": len(edges),
            }

        # ── BFS mode (original behavior) ────────────────────────────────
        # Determine center node
        if query and not center_id:
            activated = await spreading_activation(session, query, max_results=1)
            if activated:
                center_id = activated[0].id

        if not center_id:
            # Fall back to most-accessed engram
            row = await session.execute(
                text("""
                    SELECT id::text FROM engrams
                    WHERE NOT superseded
                    ORDER BY access_count DESC, activation DESC
                    LIMIT 1
                """)
            )
            r = row.fetchone()
            if not r:
                return {"nodes": [], "edges": []}
            center_id = r.id

        # BFS from center
        visited: set[str] = set()
        bfs_queue: deque[tuple[str, int]] = deque([(center_id, 0)])
        node_ids: list[str] = []

        while bfs_queue and len(node_ids) < max_nodes:
            current_id, current_depth = bfs_queue.popleft()
            if current_id in visited:
                continue
            visited.add(current_id)
            node_ids.append(current_id)

            if current_depth < depth:
                neighbors = await session.execute(
                    text("""
                        SELECT target_id::text AS neighbor_id FROM engram_edges
                        WHERE source_id = CAST(:id AS uuid)
                        UNION
                        SELECT source_id::text AS neighbor_id FROM engram_edges
                        WHERE target_id = CAST(:id AS uuid)
                    """),
                    {"id": current_id},
                )
                for row in neighbors:
                    if row.neighbor_id not in visited:
                        bfs_queue.append((row.neighbor_id, current_depth + 1))

        if not node_ids:
            return {"nodes": [], "edges": []}

        # Fetch node details
        nodes_result = await session.execute(
            text("""
                SELECT id::text, type, content, activation, importance,
                       access_count, confidence, source_type,
                       superseded, created_at
                FROM engrams
                WHERE id = ANY(CAST(:ids AS uuid[]))
            """),
            {"ids": node_ids},
        )

        nodes = [
            {
                "id": row.id,
                "type": row.type,
                "content": row.content[:200],
                "activation": round(float(row.activation), 3),
                "importance": round(float(row.importance), 3),
                "access_count": row.access_count,
                "confidence": round(float(row.confidence), 3),
                "source_type": row.source_type,
                "superseded": row.superseded,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in nodes_result
        ]

        # Fetch edges between these nodes
        edges_result = await session.execute(
            text("""
                SELECT source_id::text, target_id::text, relation,
                       weight, co_activations
                FROM engram_edges
                WHERE source_id = ANY(CAST(:ids AS uuid[]))
                  AND target_id = ANY(CAST(:ids AS uuid[]))
            """),
            {"ids": node_ids},
        )

        edges = [
            {
                "source": row.source_id,
                "target": row.target_id,
                "relation": row.relation,
                "weight": round(float(row.weight), 3),
                "co_activations": row.co_activations,
            }
            for row in edges_result
        ]

    return {
        "center_id": center_id,
        "nodes": nodes,
        "edges": edges,
        "node_count": len(nodes),
        "edge_count": len(edges),
    }


@engram_router.get("/graph/lightweight")
async def get_graph_lightweight(
    max_nodes: int = Query(default=2000, ge=10, le=50000),
    include_superseded: bool = Query(default=False),
):
    """Return a minimal subgraph for Brain rendering.

    Returns only the fields needed for visualization (id, type, importance,
    cluster_id, cluster_label) — no content, activation, confidence, etc.
    Payload is ~10x smaller than /graph?mode=full.
    """
    async with get_db() as session:
        # Fetch engram fields — include truncated content + source_type for sidebar/tooltips
        where_clause = "" if include_superseded else "WHERE NOT superseded"
        engrams_result = await session.execute(
            text(f"""
                SELECT id::text, type, importance,
                       LEFT(content, 120) AS content_preview, source_type
                FROM engrams
                {where_clause}
                ORDER BY importance DESC
                LIMIT :limit
            """),
            {"limit": max_nodes},
        )
        all_engrams = [
            {
                "id": r.id,
                "type": r.type,
                "importance": float(r.importance),
                "content": r.content_preview,
                "source_type": r.source_type,
            }
            for r in engrams_result
        ]

        if not all_engrams:
            return {
                "nodes": [],
                "edges": [],
                "clusters": [],
                "node_count": 0,
                "edge_count": 0,
            }

        engram_ids = [e["id"] for e in all_engrams]

        # Fetch slim edges — source, target, weight, relation
        edges_result = await session.execute(
            text("""
                SELECT source_id::text, target_id::text, weight, relation
                FROM engram_edges
                WHERE source_id = ANY(CAST(:ids AS uuid[]))
                  AND target_id = ANY(CAST(:ids AS uuid[]))
            """),
            {"ids": engram_ids},
        )
        raw_edges = [
            {
                "source_id": r.source_id,
                "target_id": r.target_id,
                "weight": float(r.weight),
                "relation": r.relation,
            }
            for r in edges_result
        ]

        # ── Topic-based clustering (same logic as /graph?mode=full) ──────
        topic_edges = await session.execute(
            text("""
                SELECT ee.source_id::text AS member_id,
                       ee.target_id::text AS topic_id,
                       LEFT(t.content, 200) AS topic_content
                FROM engram_edges ee
                JOIN engrams t ON t.id = ee.target_id
                  AND t.type = 'topic' AND NOT t.superseded
                WHERE ee.relation = 'part_of'
                  AND ee.source_id = ANY(CAST(:ids AS uuid[]))
            """),
            {"ids": engram_ids},
        )
        topic_memberships = topic_edges.fetchall()

        topic_ids_seen: dict[str, int] = {}
        engram_cluster: dict[str, int] = {}
        clusters: list[dict] = []

        for row in topic_memberships:
            if row.topic_id not in topic_ids_seen:
                cluster_id = len(clusters)
                topic_ids_seen[row.topic_id] = cluster_id
                label = row.topic_content or "Unnamed Topic"
                if label.startswith("TOPIC: "):
                    label = label[7:]
                if "\n" in label:
                    label = label.split("\n")[0]
                clusters.append({"id": cluster_id, "label": label.strip(), "count": 0})
            cluster_id = topic_ids_seen[row.topic_id]
            engram_cluster[row.member_id] = cluster_id
            clusters[cluster_id]["count"] += 1

        uncategorized_count = sum(
            1
            for e in all_engrams
            if e["id"] not in engram_cluster and e["type"] != "topic"
        )
        if uncategorized_count > 0:
            uncat_id = len(clusters)
            clusters.append(
                {"id": uncat_id, "label": "Uncategorized", "count": uncategorized_count}
            )
            for e in all_engrams:
                if e["id"] not in engram_cluster and e["type"] != "topic":
                    engram_cluster[e["id"]] = uncat_id

        for e in all_engrams:
            if e["type"] == "topic" and e["id"] in topic_ids_seen:
                engram_cluster[e["id"]] = topic_ids_seen[e["id"]]

        clusters.sort(key=lambda c: -c["count"])
        old_to_new = {c["id"]: i for i, c in enumerate(clusters)}
        for c in clusters:
            c["id"] = old_to_new[c["id"]]
        engram_cluster = {eid: old_to_new[cid] for eid, cid in engram_cluster.items()}

        # Build minimal response
        nodes = []
        for e in all_engrams:
            cid = engram_cluster.get(e["id"], 0)
            nodes.append(
                {
                    "id": e["id"],
                    "type": e["type"],
                    "importance": round(e["importance"], 3),
                    "content": e.get("content"),
                    "source_type": e.get("source_type"),
                    "cluster_id": cid,
                    "cluster_label": clusters[cid]["label"]
                    if e["id"] in engram_cluster and cid < len(clusters)
                    else "Uncategorized",
                }
            )

        edges = [
            {
                "source": e["source_id"],
                "target": e["target_id"],
                "weight": round(e["weight"], 3),
                "relation": e.get("relation"),
            }
            for e in raw_edges
        ]

        return {
            "nodes": nodes,
            "edges": edges,
            "clusters": clusters,
            "node_count": len(nodes),
            "edge_count": len(edges),
        }


# ── Phase 7: Outcome Feedback ───────────────────────────────────────────


class OutcomeFeedbackEntry(BaseModel):
    engram_id: str
    outcome_score: float
    task_type: str = "unknown"


@engram_router.post("/outcome-feedback")
async def receive_outcome_feedback(feedback: list[OutcomeFeedbackEntry]):
    """Receive outcome scores and adjust engram activation/importance/edges."""
    async with get_db() as session:
        stats = await process_feedback(session, [e.model_dump() for e in feedback])
    return {"status": "ok", **stats}


# ── Source Provenance ─────────────────────────────────────────────────────────


class CreateSourceRequest(BaseModel):
    source_kind: str
    title: str | None = None
    uri: str | None = None
    content: str | None = None
    trust_score: float | None = None
    author: str | None = None
    completeness: str = "complete"
    coverage_notes: str | None = None
    metadata: dict = Field(default_factory=dict)


@engram_router.post("/sources")
async def create_source(req: CreateSourceRequest):
    """Create or find-by-dedup a source record."""
    from .sources import find_or_create_source, get_source

    async with get_db() as session:
        source_id = await find_or_create_source(
            session,
            source_kind=req.source_kind,
            title=req.title,
            uri=req.uri,
            content=req.content,
            trust_score=req.trust_score,
            author=req.author,
            completeness=req.completeness,
            coverage_notes=req.coverage_notes,
            metadata=req.metadata,
        )
        return await get_source(session, source_id)


@engram_router.get("/sources")
async def list_sources_endpoint(
    source_kind: str | None = None,
    limit: int = 100,
    offset: int = 0,
):
    """List all sources with engram counts."""
    from .sources import list_sources

    async with get_db() as session:
        return await list_sources(
            session, source_kind=source_kind, limit=limit, offset=offset
        )


@engram_router.get("/sources/domain-summary")
async def domain_summary():
    """Lightweight knowledge domain overview for agent priming."""
    from .sources import get_domain_summary

    async with get_db() as session:
        return await get_domain_summary(session)


@engram_router.get("/sources/{source_id}")
async def get_source_endpoint(source_id: UUID):
    """Get full source detail with engram count."""
    from .sources import get_source

    async with get_db() as session:
        result = await get_source(session, source_id)
        if not result:
            from fastapi import HTTPException

            raise HTTPException(404, "Source not found")
        return result


@engram_router.get("/sources/{source_id}/content")
async def get_source_content_endpoint(source_id: UUID):
    """Retrieve full source content (from DB or filesystem)."""
    from .sources import get_source_content

    async with get_db() as session:
        content = await get_source_content(session, source_id)
        if content is None:
            from fastapi import HTTPException

            raise HTTPException(404, "Source content not available")
        return {"content": content}


@engram_router.delete("/sources/{source_id}")
async def delete_source_endpoint(source_id: UUID):
    """Delete a source record."""
    from .sources import delete_source

    async with get_db() as session:
        deleted = await delete_source(session, source_id)
        return {"deleted": deleted}
