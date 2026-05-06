"""
Entity resolution — deduplicates engrams by matching against existing nodes.

Two strategies:
1. Exact name match (case-insensitive) for entity-type engrams
2. Embedding similarity > threshold for same-type engrams

When a match is found, the existing engram is updated rather than creating a
duplicate. This keeps the graph clean and edges meaningful.
"""

from __future__ import annotations

import logging
from uuid import UUID

from app.config import settings
from app.embedding import to_pg_vector
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)


async def find_existing_entity(
    session: AsyncSession,
    entity_name: str,
    tenant_id: str = "00000000-0000-0000-0000-000000000001",
) -> dict | None:
    """Find an existing entity engram by exact name match (case-insensitive).

    Returns the row as a dict if found, None otherwise.
    """
    result = await session.execute(
        text("""
            SELECT id, type, content, importance, activation, access_count, confidence
            FROM engrams
            WHERE type = 'entity'
              AND tenant_id = CAST(:tenant_id AS uuid)
              AND NOT superseded
              AND lower(content) = lower(:name)
            LIMIT 1
        """),
        {"name": entity_name, "tenant_id": tenant_id},
    )
    row = result.fetchone()
    if row:
        return {
            "id": row.id,
            "type": row.type,
            "content": row.content,
            "importance": row.importance,
            "activation": row.activation,
            "access_count": row.access_count,
            "confidence": row.confidence,
        }
    return None


async def find_similar_engram(
    session: AsyncSession,
    embedding: list[float],
    engram_type: str,
    threshold: float | None = None,
    tenant_id: str = "00000000-0000-0000-0000-000000000001",
) -> dict | None:
    """Find an existing engram of the same type by embedding similarity.

    Returns the row as a dict if similarity exceeds the threshold, None otherwise.
    The similarity check uses cosine distance: similarity = 1 - distance.
    """
    if threshold is None:
        threshold = settings.engram_entity_similarity_threshold

    result = await session.execute(
        text("""
            SELECT id, type, content, importance, activation, access_count, confidence,
                   1 - (embedding <=> CAST(:embedding AS halfvec)) AS similarity
            FROM engrams
            WHERE type = :type
              AND tenant_id = CAST(:tenant_id AS uuid)
              AND NOT superseded
              AND embedding IS NOT NULL
            ORDER BY embedding <=> CAST(:embedding AS halfvec)
            LIMIT 1
        """),
        {
            "embedding": to_pg_vector(embedding),
            "type": engram_type,
            "tenant_id": tenant_id,
        },
    )
    row = result.fetchone()
    if row and row.similarity >= threshold:
        return {
            "id": row.id,
            "type": row.type,
            "content": row.content,
            "importance": row.importance,
            "activation": row.activation,
            "access_count": row.access_count,
            "confidence": row.confidence,
            "similarity": row.similarity,
        }
    return None


async def find_similar_engram_any_type(
    session: AsyncSession,
    embedding: list[float],
    threshold: float = 0.92,
    tenant_id: str = "00000000-0000-0000-0000-000000000001",
) -> dict | None:
    """Find an existing engram by embedding similarity regardless of type.

    Used for cross-type dedup: prevents "The user's name is Jeremy" from
    existing as both a fact and an entity.
    """
    result = await session.execute(
        text("""
            SELECT id, type, content, importance, activation, access_count, confidence,
                   1 - (embedding <=> CAST(:embedding AS halfvec)) AS similarity
            FROM engrams
            WHERE tenant_id = CAST(:tenant_id AS uuid)
              AND NOT superseded
              AND embedding IS NOT NULL
            ORDER BY embedding <=> CAST(:embedding AS halfvec)
            LIMIT 1
        """),
        {
            "embedding": to_pg_vector(embedding),
            "tenant_id": tenant_id,
        },
    )
    row = result.fetchone()
    if row and row.similarity >= threshold:
        return {
            "id": row.id,
            "type": row.type,
            "content": row.content,
            "importance": row.importance,
            "activation": row.activation,
            "access_count": row.access_count,
            "confidence": row.confidence,
            "similarity": row.similarity,
        }
    return None


async def update_existing_engram(
    session: AsyncSession,
    engram_id: UUID,
    new_content: str | None = None,
    importance_boost: float = 0.0,
) -> None:
    """Update an existing engram: bump access_count, optionally update content and importance.

    Uses the ACT-R access boost formula: base += 0.1 * (1 - base), capped at 1.0.
    """
    set_parts = [
        "access_count = access_count + 1",
        "last_accessed = NOW()",
        "activation = LEAST(1.0, activation + 0.1 * (1.0 - activation))",
        "updated_at = NOW()",
    ]
    params: dict = {"id": str(engram_id)}

    if new_content:
        set_parts.append("content = :content")
        params["content"] = new_content

    if importance_boost > 0:
        set_parts.append("importance = LEAST(1.0, importance + :boost)")
        params["boost"] = importance_boost

    await session.execute(
        text(f"UPDATE engrams SET {', '.join(set_parts)} WHERE id = CAST(:id AS uuid)"),
        params,
    )


async def find_contradiction_candidates(
    session: AsyncSession,
    embedding: list[float],
    content_hint: str,
    tenant_id: str = "00000000-0000-0000-0000-000000000001",
) -> list[dict]:
    """Find existing engrams that might contradict new information.

    Uses embedding similarity > contradiction_threshold to find candidates.
    Only searches fact-type engrams (contradictions are most meaningful for facts).
    """
    threshold = settings.engram_contradiction_similarity_threshold

    result = await session.execute(
        text("""
            SELECT id, content,
                   1 - (embedding <=> CAST(:embedding AS halfvec)) AS similarity
            FROM engrams
            WHERE type = 'fact'
              AND tenant_id = CAST(:tenant_id AS uuid)
              AND NOT superseded
              AND embedding IS NOT NULL
              AND 1 - (embedding <=> CAST(:embedding AS halfvec)) > :threshold
            ORDER BY embedding <=> CAST(:embedding AS halfvec)
            LIMIT 5
        """),
        {
            "embedding": to_pg_vector(embedding),
            "tenant_id": tenant_id,
            "threshold": threshold,
        },
    )
    return [
        {"id": row.id, "content": row.content, "similarity": row.similarity}
        for row in result.fetchall()
    ]
