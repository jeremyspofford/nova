"""Followed-source registry — the subscriptions half of content ingestion
(docs/plans/content-ingestion.md phase 2). Mechanical CRUD, mirroring the
media_ingests ledger: the follow_source / poll tools read and write here, the
poll-followed-sources automation walks the enabled rows. Source-neutral key
"<extractor>:<id>", so a channel, a playlist, and a podcast feed are all just
rows. Migration 039.
"""

from typing import Optional

from app import db


async def get(source_key: str) -> Optional[dict]:
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM source_subscriptions WHERE source_key = $1", source_key)
    return dict(row) if row else None


async def list_all(enabled_only: bool = False) -> list[dict]:
    q = "SELECT * FROM source_subscriptions"
    if enabled_only:
        q += " WHERE enabled = true"
    q += " ORDER BY created_at"
    async with db.acquire() as conn:
        rows = await conn.fetch(q)
    return [dict(r) for r in rows]


async def upsert(*, source_key: str, url: str, extractor: str,
                 title: Optional[str], backfill: int) -> dict:
    """Follow a source (or refresh its metadata if already followed). Re-follow
    is idempotent on source_key — it never duplicates or resets counters."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO source_subscriptions
                 (source_key, url, extractor, title, backfill)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (source_key) DO UPDATE SET
                 url = EXCLUDED.url, extractor = EXCLUDED.extractor,
                 title = COALESCE(EXCLUDED.title, source_subscriptions.title),
                 backfill = EXCLUDED.backfill, enabled = true, updated_at = now()
               RETURNING *""",
            source_key, url, extractor, title, backfill)
    return dict(row)


async def delete(source_key: str) -> bool:
    """Unfollow. Ingested memories are kept — unfollowing stops future polls,
    it doesn't erase what was already learned."""
    async with db.acquire() as conn:
        res = await conn.execute(
            "DELETE FROM source_subscriptions WHERE source_key = $1", source_key)
    return res.endswith("1")


async def set_enabled(source_key: str, enabled: bool) -> bool:
    async with db.acquire() as conn:
        res = await conn.execute(
            "UPDATE source_subscriptions SET enabled = $2, updated_at = now() "
            "WHERE source_key = $1", source_key, enabled)
    return res.endswith("1")


async def increment_ingested(source_key: str, n: int = 1) -> None:
    """Bump a source's running ingested_count by one as the worker actually lands
    an item — the count now grows asynchronously, decoupled from the follow/poll
    that discovered it (which records status/timing separately via record_poll)."""
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE source_subscriptions SET ingested_count = ingested_count + $2, "
            "updated_at = now() WHERE source_key = $1", source_key, n)


async def record_poll(source_key: str, *, status: str, error: Optional[str],
                      new_ingested: int) -> None:
    """Stamp a poll outcome: last_polled_at, ok/error, and bump the running
    ingested_count by however many new items this poll pulled in."""
    async with db.acquire() as conn:
        await conn.execute(
            """UPDATE source_subscriptions
                 SET last_polled_at = now(), last_status = $2, last_error = $3,
                     ingested_count = ingested_count + $4, updated_at = now()
               WHERE source_key = $1""",
            source_key, status, error, new_ingested)
