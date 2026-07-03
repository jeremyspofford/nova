"""Stimulus queue — BRPOP-based event system for Cortex.

Services push typed JSON stimuli to Redis list `cortex:stimuli` (db5).
Cortex drains the queue each cycle via BRPOP with adaptive timeout.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

import redis.asyncio as aioredis

from .config import settings

log = logging.getLogger(__name__)

# Redis key for the stimulus queue (on cortex's db5)
STIMULUS_KEY = "cortex:stimuli"

# Maximum stimuli to drain per cycle (prevents runaway)
MAX_DRAIN = 50

# Stimulus type constants
MESSAGE_RECEIVED = "message.received"
GOAL_CREATED = "goal.created"
GOAL_SCHEDULE_DUE = "goal.schedule_due"
GOAL_DEADLINE_APPROACHING = "goal.deadline_approaching"
HEALTH_DEGRADED = "health.degraded"
CONSOLIDATION_COMPLETE = "consolidation.complete"
BUDGET_TIER_CHANGE = "budget.tier_change"

# Intelligence & maturation stimuli
RECOMMENDATION_APPROVED = "recommendation.approved"
RECOMMENDATION_COMMENTED = "recommendation.commented"
GOAL_SPEC_APPROVED = "goal.spec_approved"
GOAL_SPEC_REJECTED = "goal.spec_rejected"
GOAL_COMMENTED = "goal.commented"

# Experience learning stimuli
GOAL_STUCK = "goal.stuck"
GOAL_COMPLETED = "goal.completed"
GOAL_BUDGET_PAUSED = "goal.budget_paused"
SUBGOAL_TERMINATED = "subgoal.terminated"  # any terminal: completed | failed | cancelled

# CI capability platform stimuli (M8 — cortex wiring for CI triage)
CI_WORKFLOW_RUN_FAILURE = "ci.workflow_run.failure"

_redis: aioredis.Redis | None = None


async def get_redis() -> aioredis.Redis:
    """Get or create the Redis connection for stimulus queue."""
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


async def close_redis() -> None:
    """Close Redis connection. Call at shutdown."""
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None


async def brpop_stimulus(timeout: int) -> list[dict]:
    """Block until a stimulus arrives or timeout expires, then drain the queue.

    Returns a list of stimulus dicts (may be empty on timeout).
    """
    r = await get_redis()
    stimuli: list[dict] = []

    try:
        result = await r.brpop(STIMULUS_KEY, timeout=timeout)
        if result:
            # result is (key, value) tuple
            stimuli.append(json.loads(result[1]))

            # Drain remaining without blocking (up to MAX_DRAIN)
            while len(stimuli) < MAX_DRAIN:
                extra = await r.rpop(STIMULUS_KEY)
                if extra is None:
                    break
                stimuli.append(json.loads(extra))
    except Exception as e:
        log.warning("BRPOP error (will retry next cycle): %s", e)

    return stimuli


async def emit(type: str, source: str, payload: dict | None = None, priority: int = 0) -> None:
    """Push a stimulus onto the queue. Used by Cortex for self-injection."""
    stimulus = {
        "type": type,
        "source": source,
        "payload": payload or {},
        "priority": priority,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    try:
        r = await get_redis()
        await r.lpush(STIMULUS_KEY, json.dumps(stimulus))
    except Exception as e:
        log.warning("Failed to emit stimulus %s: %s", type, e)
