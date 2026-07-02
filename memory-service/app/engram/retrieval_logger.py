"""
Retrieval logger — Phase 5 of the Engram Network.

Logs every retrieval event to the retrieval_log table:
  - What was queried (embedding + text)
  - What was surfaced (engram IDs from activation)
  - What was actually used (filled later via mark-used feedback)
  - Temporal context (time, day, active goal)
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from app.config import settings
from app.embedding import to_pg_vector
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)

_DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001"

async def log_retrieval(
    session: AsyncSession,
    query_embedding: list[float],
    query_text: str,
    engram_ids_surfaced: list[str],
    session_id: str = "",
    active_goal: str = "",
    tenant_id: str = _DEFAULT_TENANT,
) -> str | None:
    """Log a retrieval event (surfaced ids; mark-used fills usage later).

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
        return str(row.id) if row else None
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
