"""
Retrieval logger — Phase 5 of the Engram Network (Neural Router foundation).

Logs every retrieval event to the retrieval_log table:
  - What was queried (embedding + text)
  - What was surfaced (engram IDs from activation)
  - What was actually used (filled later by the orchestrator)
  - Temporal context (time, day, active goal)

This data is the training set for the Neural Router. The NN training
container listens for train signals on Redis db6 and trains when
enough labeled observations accumulate.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

import redis.asyncio as aioredis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.embedding import to_pg_vector

log = logging.getLogger(__name__)

_DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001"

# Redis client for neural router train signals (db6, separate from embedding cache on db0)
_train_redis: aioredis.Redis | None = None


async def _get_train_redis() -> aioredis.Redis:
    """Lazy-init Redis client for neural router signals on db6."""
    global _train_redis
    if _train_redis is None:
        # Parse base URL and force db6
        base = settings.redis_url.rsplit("/", 1)[0]
        _train_redis = aioredis.from_url(f"{base}/6", decode_responses=True)
    return _train_redis


async def log_retrieval(
    session: AsyncSession,
    query_embedding: list[float],
    query_text: str,
    engram_ids_surfaced: list[str],
    session_id: str = "",
    active_goal: str = "",
    tenant_id: str = _DEFAULT_TENANT,
) -> str | None:
    """Log a retrieval event for future Neural Router training.

    Returns the log entry ID (for later marking which engrams were used).
    """
    try:
        now = datetime.now(timezone.utc)
        temporal_context = {
            "time_of_day": now.hour / 24 + now.minute / 1440,
            "day_of_week": now.strftime("%A"),
            "active_goal": active_goal,
        }

        result = await session.execute(
            text("""
                INSERT INTO retrieval_log
                    (query_embedding, query_text, temporal_context,
                     engrams_surfaced, session_id, tenant_id)
                VALUES
                    (CAST(:embedding AS halfvec), :query_text,
                     CAST(:temporal AS jsonb),
                     CAST(:surfaced AS uuid[]), :session_id,
                     CAST(:tenant_id AS uuid))
                RETURNING id
            """),
            {
                "embedding": to_pg_vector(query_embedding),
                "query_text": query_text,
                "temporal": json.dumps(temporal_context),
                "surfaced": engram_ids_surfaced,
                "session_id": session_id,
                "tenant_id": tenant_id,
            },
        )
        row = result.fetchone()
        log_id = str(row.id) if row else None

        if log_id:
            await _maybe_emit_train_signal(session, tenant_id)

        return log_id
    except Exception:
        log.debug("Failed to log retrieval", exc_info=True)
        return None


async def mark_engrams_used(
    session: AsyncSession,
    retrieval_log_id: str,
    engram_ids_used: list[str],
) -> None:
    """Mark which surfaced engrams were actually referenced by the LLM."""
    try:
        await session.execute(
            text("""
                UPDATE retrieval_log
                SET engrams_used = CAST(:used AS uuid[])
                WHERE id = CAST(:id AS uuid)
            """),
            {"id": retrieval_log_id, "used": engram_ids_used},
        )
        # Labeled data just grew — check if training threshold crossed
        # Get tenant_id from the log entry
        tid_row = await session.execute(
            text("SELECT tenant_id FROM retrieval_log WHERE id = CAST(:id AS uuid)"),
            {"id": retrieval_log_id},
        )
        tid = tid_row.scalar()
        if tid:
            await _maybe_emit_train_signal(session, str(tid))
    except Exception:
        log.debug("Failed to mark engrams used", exc_info=True)


async def get_observation_count(
    session: AsyncSession,
    tenant_id: str = _DEFAULT_TENANT,
) -> int:
    """Count total retrieval observations for a tenant."""
    try:
        result = await session.execute(
            text(
                "SELECT count(*) FROM retrieval_log"
                " WHERE tenant_id = CAST(:tid AS uuid)"
            ),
            {"tid": tenant_id},
        )
        return result.scalar() or 0
    except Exception:
        return 0


async def get_labeled_observation_count(
    session: AsyncSession,
    tenant_id: str = _DEFAULT_TENANT,
) -> int:
    """Count observations with non-null engrams_used (training-ready)."""
    try:
        result = await session.execute(
            text(
                "SELECT count(*) FROM retrieval_log"
                " WHERE tenant_id = CAST(:tid AS uuid)"
                "   AND engrams_used IS NOT NULL"
            ),
            {"tid": tenant_id},
        )
        return result.scalar() or 0
    except Exception:
        return 0


async def _maybe_emit_train_signal(
    session: AsyncSession,
    tenant_id: str,
) -> None:
    """Emit a Redis train signal if labeled observations cross the retrain threshold."""
    try:
        if not settings.neural_router_enabled:
            return

        labeled = await get_labeled_observation_count(session, tenant_id)
        if labeled < settings.neural_router_min_observations:
            return

        # Check if new labeled observations since last model exceed retrain_every
        r = await _get_train_redis()
        last_key = f"neural_router:last_trained_count:{tenant_id}"
        last_count = await r.get(last_key)
        last_count = int(last_count) if last_count else 0

        if labeled - last_count >= settings.neural_router_retrain_every:
            await r.lpush(
                "neural_router:train_signal",
                json.dumps({"tenant_id": tenant_id, "observation_count": labeled}),
            )
            await r.set(last_key, labeled)
            log.info(
                "Emitted train signal for tenant %s (%d labeled observations)",
                tenant_id,
                labeled,
            )
    except Exception:
        log.debug("Failed to emit train signal", exc_info=True)
