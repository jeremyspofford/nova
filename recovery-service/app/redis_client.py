import json
import logging
from typing import Optional

import redis.asyncio as aioredis

from app.config import settings

logger = logging.getLogger(__name__)

_redis: Optional[aioredis.Redis] = None
_config_redis: Optional[aioredis.Redis] = None
_per_db_redis: dict[int, aioredis.Redis] = {}


async def get_redis() -> aioredis.Redis:
    """Recovery service's own Redis connection (db7) — for nova:system:* data."""
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


async def get_config_redis() -> aioredis.Redis:
    """Cross-db connection to db1 — reads nova:config:inference.* written by orchestrator."""
    global _config_redis
    if _config_redis is None:
        base = settings.redis_url.rsplit("/", 1)[0]
        _config_redis = aioredis.from_url(f"{base}/1", decode_responses=True)
    return _config_redis


async def get_redis_for_db(db: int) -> aioredis.Redis:
    """Return (and cache) a Redis client for an arbitrary DB number.

    Used by factory reset to wipe per-service state across all Nova Redis DBs:
    db0=memory-service, db1=llm-gateway, db2=orchestrator, db3=chat-api,
    db4=unused (was chat-bridge), db5=cortex, db6=intel-worker, db7=recovery
    (reuses get_redis), db8=knowledge-worker, db9=voice-service.
    """
    if db in _per_db_redis:
        return _per_db_redis[db]
    base = settings.redis_url.rsplit("/", 1)[0]
    client = aioredis.from_url(f"{base}/{db}", decode_responses=True)
    _per_db_redis[db] = client
    return client


async def read_config(key: str, default: str = "") -> str:
    """Read a nova:config:* key from the gateway's Redis db (db1).
    Values may be JSON-encoded strings (e.g. '"vllm"') — unwrap them."""
    r = await get_config_redis()
    val = await r.get(f"nova:config:{key}")
    if val is None:
        return default
    # Dashboard writes config values as JSON strings — unwrap one level
    try:
        parsed = json.loads(val)
        if isinstance(parsed, str):
            return parsed
    except (json.JSONDecodeError, TypeError):
        pass
    return val


async def write_system(key: str, data: dict) -> None:
    """Write a nova:system:* key to recovery's own Redis db (db7)."""
    r = await get_redis()
    await r.set(f"nova:system:{key}", json.dumps(data))


async def read_system(key: str) -> Optional[dict]:
    """Read a nova:system:* key from recovery's own Redis db (db7)."""
    r = await get_redis()
    val = await r.get(f"nova:system:{key}")
    return json.loads(val) if val else None


async def write_config_state(key: str, value: str) -> None:
    """Write inference state to db1 (gateway reads this for routing decisions)."""
    r = await get_config_redis()
    await r.set(f"nova:config:{key}", value)


async def close_redis() -> None:
    global _redis, _config_redis, _per_db_redis
    if _redis:
        await _redis.aclose()
        _redis = None
    if _config_redis:
        await _config_redis.aclose()
        _config_redis = None
    for client in _per_db_redis.values():
        try:
            await client.aclose()
        except Exception:
            pass
    _per_db_redis = {}
