"""Stimulus emitter — pushes events to Cortex's stimulus queue.

Cortex runs on Redis db5. The orchestrator connects to db5 specifically
for stimulus emission (separate from its own db2 connection).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

import redis.asyncio as aioredis
from app.config import settings

log = logging.getLogger(__name__)

STIMULUS_KEY = "cortex:stimuli"
_CORTEX_REDIS_DB = 5

# Intelligence stimuli
RECOMMENDATION_CREATED = "recommendation.created"
RECOMMENDATION_APPROVED = "recommendation.approved"
RECOMMENDATION_COMMENTED = "recommendation.commented"
GOAL_CREATED = "goal.created"
GOAL_SPEC_APPROVED = "goal.spec_approved"
GOAL_SPEC_REJECTED = "goal.spec_rejected"
GOAL_COMMENTED = "goal.commented"

# CI capability platform stimuli (M8 — cortex wiring for CI triage)
CI_WORKFLOW_RUN_FAILURE = "ci.workflow_run.failure"

_redis: aioredis.Redis | None = None


async def _get_redis() -> aioredis.Redis:
    """Get Redis connection pointing at Cortex's db5."""
    global _redis
    if _redis is None:
        import re
        base_url = re.sub(r"/\d+$", "", settings.redis_url)
        _redis = aioredis.from_url(f"{base_url}/{_CORTEX_REDIS_DB}", decode_responses=True)
    return _redis


async def close_redis() -> None:
    """Close the module-level Redis connection. Call at shutdown."""
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None


async def emit_stimulus(type: str, payload: dict | None = None, priority: int = 0) -> None:
    """Push a stimulus to Cortex's queue. Fire-and-forget (never raises)."""
    stimulus = {
        "type": type,
        "source": "orchestrator",
        "payload": payload or {},
        "priority": priority,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    try:
        r = await _get_redis()
        await r.lpush(STIMULUS_KEY, json.dumps(stimulus))
        await r.ltrim(STIMULUS_KEY, 0, 999)  # Cap at 1000 — prevent unbounded growth if Cortex is down
    except Exception as e:
        log.debug("Failed to emit stimulus %s: %s", type, e)
