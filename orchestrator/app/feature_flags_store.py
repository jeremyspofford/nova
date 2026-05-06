"""Feature-flag store — async DB CRUD over feature_flags + feature_flag_audit
plus the pubsub publisher that notifies every flag-consuming service when a
value changes.

Per backend blocker B6: every PATCH / DELETE runs UPSERT + audit INSERT in a
single asyncpg transaction acquired from the SHARED orchestrator pool.
PUBLISH happens AFTER commit — a failed publish leaves the DB authoritative
but logs a WARNING. Subscribers will catch up at their next reconnect or
via the cache TTL.

Per security blocker S1: every audit row captures actor + ip + user_agent +
request_id. The router (Phase B6) is responsible for extracting these from
the FastAPI Request object and passing them in.
"""
from __future__ import annotations

import logging
from typing import Any

import asyncpg

from app.store import get_redis

logger = logging.getLogger(__name__)

INVALIDATE_CHANNEL = "nova:flags:invalidate"


async def list_overrides(pool: asyncpg.Pool) -> list[dict[str, Any]]:
    """Return every active override (one row per flag with a non-default
    value persisted in the DB)."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT key, value, set_by, set_at, notes "
            "FROM feature_flags ORDER BY key"
        )
        return [dict(r) for r in rows]


async def get_override(pool: asyncpg.Pool, key: str) -> dict[str, Any] | None:
    """Single-flag detail. Returns None if no override exists."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT key, value, set_by, set_at, notes "
            "FROM feature_flags WHERE key = $1",
            key,
        )
        return dict(row) if row else None


async def upsert_override(
    pool: asyncpg.Pool,
    *,
    key: str,
    value: Any,
    actor: str,
    ip: str | None,
    user_agent: str | None,
    request_id: str | None,
    notes: str | None,
) -> dict[str, Any]:
    """Set or update a flag override. Atomically writes the override and an
    audit row in one transaction. Publishes invalidation after commit (a
    failed publish does NOT roll back).

    Returns the new override row.

    The orchestrator's pool registers a JSONB codec (json.dumps / json.loads)
    in app.db._init_connection, so we pass `value` as a raw Python primitive
    here — the codec handles encoding. Hand-rolled `json.dumps(value)` would
    double-encode under that codec.
    """
    async with pool.acquire() as conn:
        async with conn.transaction():
            old_value = await conn.fetchval(
                "SELECT value FROM feature_flags WHERE key = $1", key
            )
            await conn.execute(
                """
                INSERT INTO feature_flags (key, value, set_by, set_at, notes)
                VALUES ($1, $2::jsonb, $3, NOW(), $4)
                ON CONFLICT (key) DO UPDATE
                  SET value = EXCLUDED.value,
                      set_by = EXCLUDED.set_by,
                      set_at = EXCLUDED.set_at,
                      notes = EXCLUDED.notes
                """,
                key, value, actor, notes,
            )
            await conn.execute(
                """
                INSERT INTO feature_flag_audit (
                    key, action, old_value, new_value, actor,
                    actor_ip, actor_user_agent, request_id, notes
                ) VALUES ($1, 'set', $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8)
                """,
                key, old_value, value, actor,
                ip, user_agent, request_id, notes,
            )

    await _publish_invalidation_safe(key)

    row = await get_override(pool, key)
    assert row is not None  # we just wrote it
    return row


async def delete_override(
    pool: asyncpg.Pool,
    *,
    key: str,
    actor: str,
    ip: str | None,
    user_agent: str | None,
    request_id: str | None,
) -> bool:
    """Reset a flag to its in-code default by removing its override row.

    Returns True if a row was deleted, False if there was no override to
    delete (idempotent on the no-op case)."""
    async with pool.acquire() as conn:
        async with conn.transaction():
            old_value = await conn.fetchval(
                "SELECT value FROM feature_flags WHERE key = $1", key
            )
            if old_value is None:
                return False
            await conn.execute("DELETE FROM feature_flags WHERE key = $1", key)
            await conn.execute(
                """
                INSERT INTO feature_flag_audit (
                    key, action, old_value, new_value, actor,
                    actor_ip, actor_user_agent, request_id
                ) VALUES ($1, 'reset', $2::jsonb, NULL, $3, $4, $5, $6)
                """,
                key, old_value, actor, ip, user_agent, request_id,
            )

    await _publish_invalidation_safe(key)
    return True


async def list_audit(
    pool: asyncpg.Pool,
    *,
    key: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Audit history. If `key` is provided, narrow to that flag; otherwise
    return the most recent entries across all flags. Newest first."""
    async with pool.acquire() as conn:
        if key is not None:
            rows = await conn.fetch(
                """
                SELECT id, key, action, old_value, new_value, actor,
                       actor_ip, actor_user_agent, request_id,
                       occurred_at, notes
                FROM feature_flag_audit
                WHERE key = $1
                ORDER BY occurred_at DESC
                LIMIT $2
                """,
                key, limit,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT id, key, action, old_value, new_value, actor,
                       actor_ip, actor_user_agent, request_id,
                       occurred_at, notes
                FROM feature_flag_audit
                ORDER BY occurred_at DESC
                LIMIT $1
                """,
                limit,
            )
        return [dict(r) for r in rows]


async def publish_invalidation(key: str) -> None:
    """Publish a key on the invalidate channel. Called by the router after
    every successful PATCH / DELETE; subscribers re-warm their caches.

    Failures log WARNING but do not raise — DB is the source of truth, a
    missed publish only means subscribers are stale until reconnect."""
    redis = get_redis()
    await redis.publish(INVALIDATE_CHANNEL, key)


async def warm_cache_from_store(pool: asyncpg.Pool) -> None:
    """Populate the SDK's in-process cache directly from the orchestrator's
    own database. Used by orchestrator's lifespan startup so it doesn't
    have to HTTP-fetch from itself.

    Other services use `nova_contracts.feature_flags_http.warm_cache_from_http`
    against `http://orchestrator:8000` instead. This helper is the
    orchestrator-only fast path.
    """
    from nova_contracts.feature_flags import populate_cache

    overrides = await list_overrides(pool)
    populate_cache({row["key"]: row["value"] for row in overrides})


async def _publish_invalidation_safe(key: str) -> None:
    """Wrapper used inside upsert/delete that swallows publish errors so a
    Redis hiccup never rolls back a committed flag change."""
    try:
        await publish_invalidation(key)
    except Exception:  # noqa: BLE001 — best-effort post-commit notification
        logger.warning(
            "flag_publish_invalidation_failed key=%s — DB is authoritative; "
            "subscribers stale until reconnect",
            key,
            exc_info=True,
        )
