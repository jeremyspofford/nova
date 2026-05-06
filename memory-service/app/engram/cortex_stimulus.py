"""Emit stimuli to Cortex's Redis queue (db5) from the memory-service."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

import redis.asyncio as aioredis
from app.config import settings

log = logging.getLogger(__name__)

_cortex_redis: aioredis.Redis | None = None


async def emit_to_cortex(type: str, payload: dict | None = None) -> None:
    """Push a stimulus to Cortex's queue on Redis db5. Fire-and-forget."""
    global _cortex_redis
    if _cortex_redis is None:
        import re

        base_url = re.sub(r"/\d+$", "", str(settings.redis_url))
        _cortex_redis = aioredis.from_url(f"{base_url}/5", decode_responses=True)
    try:
        stimulus = {
            "type": type,
            "source": "memory-service",
            "payload": payload or {},
            "priority": 0,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        await _cortex_redis.lpush("cortex:stimuli", json.dumps(stimulus))
    except Exception as e:
        log.debug("Failed to emit stimulus %s: %s", type, e)
