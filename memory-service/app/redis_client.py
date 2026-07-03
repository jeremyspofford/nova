"""Shared module-level Redis client (db0 — ingestion queue and service state)."""

from __future__ import annotations

import redis.asyncio as aioredis
from app.config import settings

_redis: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=False)
    return _redis


async def close_redis() -> None:
    """Close the module-level Redis connection. Call at shutdown."""
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None
