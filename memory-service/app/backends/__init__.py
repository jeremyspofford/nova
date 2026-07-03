"""
Backend factory — resolves the active MemoryBackend from runtime config.

`memory.backend` lives in Redis db1 (key nova:config:memory.backend,
JSON-encoded, written by the orchestrator's runtime-config sync) and is
re-read with a short cache. "okf" is the only built-in backend; unknown
values fall back to it with a warning. An external provider is configured
via memory.provider_url on the orchestrator side, not here.
"""

from __future__ import annotations

import json
import logging
import time

import redis.asyncio as aioredis
from app.config import settings

from .base import ContextResult, MemoryBackend, WriteResult

__all__ = [
    "MemoryBackend",
    "WriteResult",
    "ContextResult",
    "get_backend",
    "current_backend_name",
    "close_config_redis",
]

log = logging.getLogger(__name__)

_CONFIG_KEY = "nova:config:memory.backend"
_CACHE_TTL = 15.0  # seconds

_instances: dict[str, MemoryBackend] = {}
_cached_name: str | None = None
_cached_at: float = 0.0
_config_redis: aioredis.Redis | None = None


def _get_config_redis() -> aioredis.Redis:
    """Client for Redis db1, where orchestrator syncs nova:config:* keys."""
    global _config_redis
    if _config_redis is None:
        url = settings.redis_url.rsplit("/", 1)[0] + "/1"
        _config_redis = aioredis.from_url(url, decode_responses=True)
    return _config_redis


async def close_config_redis() -> None:
    global _config_redis
    if _config_redis is not None:
        await _config_redis.aclose()
        _config_redis = None


def _instantiate(name: str) -> MemoryBackend:
    if name not in _instances:
        # Fail loudly: memory is load-bearing, a broken backend must surface
        # at the call site instead of silently degrading.
        from .okf.backend import OkfBackend

        _instances[name] = OkfBackend()
    return _instances[name]


async def current_backend_name() -> str:
    """Resolve the configured backend name (Redis override > setting default)."""
    global _cached_name, _cached_at
    now = time.monotonic()
    if _cached_name is not None and now - _cached_at < _CACHE_TTL:
        return _cached_name

    name = settings.memory_backend
    try:
        raw = await _get_config_redis().get(_CONFIG_KEY)
        if raw:
            # Dashboard/orchestrator write config values JSON-encoded ('"okf"')
            try:
                parsed = json.loads(raw)
                value = parsed if isinstance(parsed, str) else str(parsed)
            except (json.JSONDecodeError, TypeError):
                value = raw
            value = value.strip().lower()
            if value:
                name = value
    except Exception:
        log.debug("memory.backend Redis read failed — using default", exc_info=True)

    if name != "okf":
        log.warning("Unknown memory.backend %r — using okf", name)
        name = "okf"

    _cached_name, _cached_at = name, now
    return name


async def get_backend() -> MemoryBackend:
    """The active backend instance (cached per name)."""
    return _instantiate(await current_backend_name())
