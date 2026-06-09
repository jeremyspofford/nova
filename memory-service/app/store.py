# memory-service/app/store.py
from typing import Any

import asyncpg


async def write_memory(
    pool: asyncpg.Pool,
    content: str,
    source_kind: str,
    source_uri: str | None = None,
    kind: str = "fact",
    importance: float = 0.5,
    tags: list[str] | None = None,
    embedding: list[float] | None = None,
) -> str:
    """Insert a memory row. embedding/tags are optional — when the caller
    already computed them (extraction dedup path) the row skips the embed queue."""
    row = await pool.fetchrow(
        """
        INSERT INTO memories (content, source_kind, source_uri, kind, importance, tags, embedding)
        VALUES ($1, $2, $3, $4, $5, COALESCE($6::text[], '{}'::text[]), $7)
        RETURNING id::text
        """,
        content,
        source_kind,
        source_uri,
        kind,
        importance,
        tags,
        embedding,
    )
    return row["id"]


async def get_memory(pool: asyncpg.Pool, memory_id: str) -> dict | None:
    row = await pool.fetchrow(
        """
        SELECT id::text, content, source_kind, source_uri, tags,
               created_at, used_count, last_used, kind, importance
        FROM memories
        WHERE id = $1::uuid
        """,
        memory_id,
    )
    return dict(row) if row else None


async def mark_used(pool: asyncpg.Pool, memory_id: str) -> None:
    await pool.execute(
        """
        UPDATE memories
        SET used_count = used_count + 1, last_used = now()
        WHERE id = $1::uuid
        """,
        memory_id,
    )


async def get_profile(pool: asyncpg.Pool, limit: int = 12) -> list[dict]:
    """Stable high-value facts/preferences — the 'what Nova knows about you'
    block injected into every conversation."""
    rows = await pool.fetch(
        """
        SELECT id::text, content, kind, importance, used_count, last_used, created_at
        FROM memories
        WHERE kind IN ('fact', 'preference')
        ORDER BY importance DESC, used_count DESC, last_used DESC NULLS LAST
        LIMIT $1
        """,
        limit,
    )
    return [dict(r) for r in rows]


async def get_stats(pool: asyncpg.Pool) -> dict:
    row = await pool.fetchrow(
        """
        SELECT
            COUNT(*)                                                          AS total_rows,
            COALESCE(pg_total_relation_size('memories'), 0)                   AS table_size_bytes,
            ROUND(
                100.0 * COUNT(*) FILTER (WHERE embedding IS NOT NULL)
                    / NULLIF(COUNT(*), 0),
                1
            )                                                                 AS embedding_coverage_pct
        FROM memories
        """
    )
    return {
        "total_rows": int(row["total_rows"]),
        "table_size_bytes": int(row["table_size_bytes"]),
        "embedding_coverage_pct": float(row["embedding_coverage_pct"] or 0.0),
    }


async def search_memories(
    pool: asyncpg.Pool,
    embedding: list[float] | None,
    query: str,
    limit: int = 10,
    source_kinds: list[str] | None = None,
    tags: list[str] | None = None,
    min_similarity: float | None = None,
) -> list[dict]:
    if embedding is not None:
        return await _semantic_search(pool, embedding, limit, source_kinds, tags, min_similarity)
    return await _keyword_search(pool, query, limit, source_kinds, tags)


# Salience blend: similarity dominates; recency, importance and reinforcement
# nudge. Additive on purpose — multiplicative decay buries old-but-relevant
# memories, and "devalued" must never mean "buried". Half-life 30 days
# (ln(2)/30 ≈ 0.0231); reinforcement saturates at ~100 recalls.
_SALIENCE_EXPR = """
    0.60 * similarity
  + 0.15 * exp(-0.0231 * GREATEST(extract(epoch FROM (now() - COALESCE(last_used, created_at))) / 86400.0, 0))
  + 0.15 * importance
  + 0.10 * LEAST(ln(1 + used_count) / ln(101), 1.0)
"""

_ROW_COLS = """id::text, content, source_kind, source_uri, tags,
            created_at, used_count, last_used, kind, importance"""


async def _semantic_search(
    pool: asyncpg.Pool,
    embedding: list[float],
    limit: int,
    source_kinds: list[str] | None,
    tags: list[str] | None,
    min_similarity: float | None,
) -> list[dict]:
    filters: list[str] = ["embedding IS NOT NULL"]
    params: list[Any] = [embedding, limit]

    if source_kinds:
        params.append(source_kinds)
        filters.append(f"source_kind = ANY(${len(params)})")
    if tags:
        params.append(tags)
        filters.append(f"tags @> ${len(params)}")

    if min_similarity is not None:
        params.append(min_similarity)
        filters.append(f"1 - (embedding <=> $1) >= ${len(params)}")

    where = " AND ".join(filters)
    # Two stages: the inner query rides the vector index (ORDER BY distance),
    # the outer re-ranks the candidate pool by salience. Pool is at least 50
    # so re-ranking has real candidates even for small limits.
    sql = f"""
        WITH candidates AS (
            SELECT
                {_ROW_COLS},
                1 - (embedding <=> $1) AS similarity
            FROM memories
            WHERE {where}
            ORDER BY embedding <=> $1
            LIMIT GREATEST($2, 50)
        )
        SELECT *, ({_SALIENCE_EXPR}) AS salience
        FROM candidates
        ORDER BY salience DESC
        LIMIT $2
    """
    rows = await pool.fetch(sql, *params)
    return [dict(r) for r in rows]


async def _keyword_search(
    pool: asyncpg.Pool,
    query: str,
    limit: int,
    source_kinds: list[str] | None,
    tags: list[str] | None,
) -> list[dict]:
    if not query.strip():
        return []

    filters: list[str] = [
        "to_tsvector('english', content) @@ plainto_tsquery('english', $1)"
    ]
    params: list[Any] = [query, limit]

    if source_kinds:
        params.append(source_kinds)
        filters.append(f"source_kind = ANY(${len(params)})")
    if tags:
        params.append(tags)
        filters.append(f"tags @> ${len(params)}")

    where = " AND ".join(filters)
    # ts_rank is unbounded; ts_rank/(ts_rank+1) maps it into [0,1) so the
    # same salience blend applies to the keyword fallback path.
    sql = f"""
        WITH candidates AS (
            SELECT
                {_ROW_COLS},
                ts_rank(to_tsvector('english', content),
                        plainto_tsquery('english', $1)) AS raw_rank
            FROM memories
            WHERE {where}
            ORDER BY raw_rank DESC
            LIMIT GREATEST($2, 50)
        ), scored AS (
            SELECT *, (raw_rank / (raw_rank + 1.0)) AS similarity
            FROM candidates
        )
        SELECT *, ({_SALIENCE_EXPR}) AS salience
        FROM scored
        ORDER BY salience DESC
        LIMIT $2
    """
    rows = await pool.fetch(sql, *params)
    out = []
    for r in rows:
        d = dict(r)
        d.pop("raw_rank", None)
        out.append(d)
    return out


async def update_embedding_and_tags(
    pool: asyncpg.Pool,
    memory_id: str,
    embedding: list[float],
    tags: list[str],
) -> None:
    await pool.execute(
        "UPDATE memories SET embedding = $1, tags = $2 WHERE id = $3::uuid",
        embedding,
        tags,
        memory_id,
    )


async def get_unembedded_ids(pool: asyncpg.Pool, limit: int = 50) -> list[str]:
    """Recovery scan: rows that need embedding (queue may have missed them on crash)."""
    rows = await pool.fetch(
        """
        SELECT id::text FROM memories
        WHERE embedding IS NULL
        ORDER BY created_at
        LIMIT $1
        """,
        limit,
    )
    return [r["id"] for r in rows]
