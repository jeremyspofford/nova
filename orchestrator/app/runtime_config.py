"""Read runtime-configurable values that the Settings UI owns.

Two stores, one rule — the value saved in the UI must win:

  - platform_config (Postgres) is the source of truth. Orchestrator-internal
    consumers read it directly via get_db_config().
  - nova:config:* (Redis db1) is the push-synced copy that other services
    read. The orchestrator only reads it via get_redis_config() for values
    that must match what those services see (e.g. memory.provider_url).

Both helpers cache briefly, fall back to the caller's default, and never
raise — a config read must not take a request down.
"""

from __future__ import annotations

import json
import logging
import time

import redis.asyncio as aioredis
from app.config import settings

log = logging.getLogger(__name__)

_redis_client: aioredis.Redis | None = None
_redis_cache: dict[str, tuple[float, str | None]] = {}
_db_cache: dict[str, tuple[float, str | None]] = {}


def _unwrap(val: str | None) -> str | None:
    """Strip one layer of JSON string quoting (platform_config stores JSONB)."""
    if val and len(val) >= 2 and val[0] == '"' and val[-1] == '"':
        try:
            return json.loads(val)
        except Exception:
            pass
    return val


def _get_redis() -> aioredis.Redis:
    global _redis_client
    if _redis_client is None:
        db1_url = settings.redis_url.rsplit("/", 1)[0] + "/1"
        _redis_client = aioredis.from_url(db1_url, decode_responses=True)
    return _redis_client


async def close_runtime_config_redis() -> None:
    """Close the module-level Redis connection. Call at shutdown."""
    global _redis_client
    if _redis_client is not None:
        await _redis_client.aclose()
        _redis_client = None


async def get_redis_config(key: str, default: str | None = None,
                           ttl: float = 10.0) -> str | None:
    """nova:config:<key> from Redis db1, unwrapped, cached for ttl seconds."""
    now = time.monotonic()
    hit = _redis_cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1] if hit[1] is not None else default
    try:
        val = _unwrap(await _get_redis().get(f"nova:config:{key}"))
    except Exception as exc:
        log.debug("Runtime config read failed for %s: %s", key, exc)
        return default
    _redis_cache[key] = (now, val)
    return val if val is not None else default


async def get_db_config(key: str, default: str | None = None,
                        ttl: float = 30.0) -> str | None:
    """platform_config value for <key> as text, unwrapped, cached for ttl
    seconds. NULL rows and missing rows both yield the default."""
    from app.db import get_pool

    now = time.monotonic()
    hit = _db_cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1] if hit[1] is not None else default
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            raw = await conn.fetchval(
                "SELECT value #>> '{}' FROM platform_config WHERE key = $1", key
            )
        val = _unwrap(raw)
        if val == "null":
            val = None
    except Exception as exc:
        log.debug("Platform config read failed for %s: %s", key, exc)
        return default
    _db_cache[key] = (now, val)
    return val if val is not None else default
