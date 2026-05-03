"""Polls nova:config:* from Redis db1 every 30s and caches values in-process.

Active-poll variant of the runtime config pattern (compare orchestrator/app/auth.py
which uses lazy-on-read with TTL): a background task refreshes every
poll_interval_seconds so accessor reads are always cache hits — no inline Redis
round-trip on the session-ingestion hot path.
"""

import asyncio
import json
import logging
from typing import Any

import redis.asyncio as redis_async

logger = logging.getLogger(__name__)

_PREFIX = "nova:config:"
_WATCHED_PREFIXES = ("screenpipe.", "capture.")


class RuntimeConfig:
    def __init__(self, redis: redis_async.Redis, poll_interval_seconds: int = 30):
        self._redis = redis
        self._poll_interval = poll_interval_seconds
        self._cache: dict[str, str] = {}
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        await self._refresh()
        self._task = asyncio.create_task(self._poll_loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _poll_loop(self) -> None:
        while True:
            await asyncio.sleep(self._poll_interval)
            try:
                await self._refresh()
            except Exception as exc:
                logger.warning("runtime_config refresh failed: %s", exc)

    async def _refresh(self) -> None:
        new_cache: dict[str, str] = {}
        for prefix in _WATCHED_PREFIXES:
            async for key in self._redis.scan_iter(match=f"{_PREFIX}{prefix}*"):
                key_str = key.decode() if isinstance(key, bytes) else key
                value = await self._redis.get(key_str)
                if value is not None:
                    new_cache[key_str.removeprefix(_PREFIX)] = (
                        value.decode() if isinstance(value, bytes) else value
                    )
        self._cache = new_cache

    async def get_str(self, key: str, default: str = "") -> str:
        return self._cache.get(key, default)

    async def get_int(self, key: str, default: int) -> int:
        raw = self._cache.get(key)
        if raw is None:
            return default
        try:
            return int(raw)
        except (TypeError, ValueError):
            logger.warning("runtime_config: failed to parse int for %s=%r", key, raw)
            return default

    async def get_bool(self, key: str, default: bool = False) -> bool:
        raw = self._cache.get(key)
        if raw is None:
            return default
        return raw.lower() in ("1", "true", "yes")

    async def get_list(self, key: str, default: list | None = None) -> list:
        raw = self._cache.get(key)
        if raw is None:
            return default or []
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, list) else (default or [])
        except json.JSONDecodeError:
            logger.warning("runtime_config: failed to parse list for %s", key)
            return default or []
