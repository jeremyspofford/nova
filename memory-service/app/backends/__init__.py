"""
Backend factory — resolves the active MemoryBackend from runtime config.

`memory.backend` lives in Redis db1 (key nova:config:memory.backend,
JSON-encoded, written by the orchestrator's runtime-config sync) and is
re-read with a short cache so the dashboard can switch backends without
a restart. Unknown or unset values fall back to the engram backend.
"""

from __future__ import annotations

import json
import logging
import time

import redis.asyncio as aioredis
from app.config import settings

from .base import ContextResult, MemoryBackend, WriteResult
from .engram_backend import EngramBackend

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
        if name == "okf":
            try:
                from .okf.backend import OkfBackend  # deferred import

                _instances[name] = OkfBackend()
            except ImportError:
                log.error(
                    "memory.backend=okf but the OKF backend is unavailable — "
                    "falling back to engram"
                )
                return _instantiate("engram")
        else:
            _instances[name] = EngramBackend()
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

    if name not in ("engram", "okf"):
        log.warning("Unknown memory.backend %r — falling back to engram", name)
        name = "engram"

    if name != _cached_name and _cached_name is not None:
        log.info("Memory backend switched: %s → %s", _cached_name, name)
    _cached_name, _cached_at = name, now
    return name


async def get_backend() -> MemoryBackend:
    """The active backend instance (cached per name)."""
    return _instantiate(await current_backend_name())
