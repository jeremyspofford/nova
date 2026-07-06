"""
Task queue backed by Redis lists.

Architecture:
  - Producer (router.py): LPUSH task_id onto nova:queue:tasks
  - Consumer (queue_worker): BRPOP task_id, run pipeline in background
  - Heartbeat: running tasks call write_heartbeat() every 30s
  - Dead letter: tasks that exhaust retries are moved to nova:queue:dead_letter
    for inspection — never silently dropped

The queue worker spawns each pipeline execution as an asyncio.create_task so
multiple tasks can run concurrently without blocking the BRPOP loop.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from redis import exceptions as _redis_exceptions

from .config import settings
from .store import get_redis

logger = logging.getLogger(__name__)

# ── Concurrency control ───────────────────────────────────────────────────────
_pipeline_semaphore: asyncio.Semaphore = asyncio.Semaphore(settings.pipeline_max_concurrent)

# ── Redis key constants ────────────────────────────────────────────────────────
TASK_QUEUE_KEY       = "nova:queue:tasks"
TASK_QUEUE_SET_KEY   = "nova:queue:tasks:set"
DEAD_LETTER_KEY      = "nova:queue:dead_letter"
HEARTBEAT_KEY_FMT    = "nova:heartbeat:task:{task_id}"


# ── Producer ───────────────────────────────────────────────────────────────────

# Lua script for atomic SADD+LPUSH — prevents race where SADD succeeds
# but LPUSH never fires (crash/disconnect between the two calls).
_ENQUEUE_LUA = """
local added = redis.call('SADD', KEYS[1], ARGV[1])
if added == 1 then
    redis.call('LPUSH', KEYS[2], ARGV[1])
    return 1
end
return 0
"""


async def enqueue_task(task_id: str) -> None:
    """
    Push a task onto the work queue with dedup (atomic via Lua script).
    SADD to the dedup set first — if the task is already queued, skip LPUSH.
    LPUSH so newest tasks go to the front; BRPOP pops from the right (FIFO).
    """
    redis = get_redis()
    # redis.eval runs a Lua script atomically on the Redis server
    added = await redis.eval(  # noqa: S307 — Redis Lua, not Python eval
        _ENQUEUE_LUA, 2, TASK_QUEUE_SET_KEY, TASK_QUEUE_KEY, task_id,
    )
    if not added:
        logger.info("Task %s already in queue — skipping duplicate enqueue", task_id)
        return
    logger.debug("Enqueued task %s", task_id)


async def queue_depth() -> int:
    """Return the number of tasks waiting to be picked up."""
    redis = get_redis()
    return await redis.llen(TASK_QUEUE_KEY)


# ── Heartbeat ──────────────────────────────────────────────────────────────────

async def write_heartbeat(task_id: str) -> None:
    """
    Called by the pipeline executor every ~30s while a task is running.
    Sets a key that expires after HEARTBEAT_TTL seconds.
    The Reaper checks for missing keys to detect stale tasks.
    """
    redis = get_redis()
    key = HEARTBEAT_KEY_FMT.format(task_id=task_id)
    await redis.set(key, "alive", ex=settings.task_heartbeat_ttl_seconds)


async def is_heartbeat_alive(task_id: str) -> bool:
    """Return True if the task's heartbeat key still exists in Redis."""
    redis = get_redis()
    key = HEARTBEAT_KEY_FMT.format(task_id=task_id)
    return bool(await redis.exists(key))


async def clear_heartbeat(task_id: str) -> None:
    """Remove heartbeat key when a task completes normally."""
    redis = get_redis()
    key = HEARTBEAT_KEY_FMT.format(task_id=task_id)
    await redis.delete(key)


# ── Dead letter ────────────────────────────────────────────────────────────────

DEAD_LETTER_MAX = 10_000  # Cap to prevent unbounded Redis memory growth


async def move_to_dead_letter(task_id: str, reason: str) -> None:
    """
    Push a failed task to the dead letter queue for inspection.
    Capped at DEAD_LETTER_MAX entries — oldest items are trimmed.
    """
    redis = get_redis()
    entry = json.dumps({
        "task_id":   task_id,
        "reason":    reason,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    pipe = redis.pipeline()
    pipe.lpush(DEAD_LETTER_KEY, entry)
    pipe.ltrim(DEAD_LETTER_KEY, 0, DEAD_LETTER_MAX - 1)
    await pipe.execute()
    logger.warning("Task %s moved to dead letter: %s", task_id, reason)


async def dead_letter_depth() -> int:
    """Return the number of items in the dead letter queue."""
    redis = get_redis()
    return await redis.llen(DEAD_LETTER_KEY)


# ── Consumer (queue worker) ────────────────────────────────────────────────────

async def queue_worker() -> None:
    """
    Background worker: block-pop task IDs from the queue and execute each pipeline.

    Each pipeline run is spawned as asyncio.create_task so the BRPOP loop never
    blocks — multiple tasks can run concurrently.

    Lifecycle: started as asyncio.create_task in main.py lifespan; cancelled on
    graceful shutdown (CancelledError breaks the loop cleanly).
    """
    # Import here to avoid circular imports — pipeline imports queue for heartbeats
    from .pipeline.executor import execute_pipeline

    logger.info("Task queue worker started")
    redis = get_redis()

    while True:
        try:
            # Block for up to 5 seconds waiting for a task.
            # Short timeout lets us check CancelledError regularly.
            result = await redis.brpop(TASK_QUEUE_KEY, timeout=5)
            if result is None:
                continue  # timeout — loop back and check again

            _key, task_id_bytes = result
            task_id = task_id_bytes.decode() if isinstance(task_id_bytes, bytes) else task_id_bytes

            # Remove from dedup set so the task can be re-enqueued if needed later
            await redis.srem(TASK_QUEUE_SET_KEY, task_id)
            logger.info("Dequeued task %s", task_id)
            # Fire-and-forget: pipeline runs in background, worker picks up next task immediately
            asyncio.create_task(
                _run_with_error_guard(task_id, execute_pipeline),
                name=f"pipeline:{task_id}",
            )

        except asyncio.CancelledError:
            logger.info("Task queue worker shutting down")
            break
        except _redis_exceptions.TimeoutError:
            # redis-py 8.x: an idle BRPOP can lose the race between its own
            # socket read timeout and the server's nil reply at exactly the
            # block timeout. It's an empty poll, not a failure — loop again.
            continue
        except Exception:
            logger.exception("Unexpected error in queue worker — will retry in 1s")
            await asyncio.sleep(1)


async def _run_with_error_guard(task_id: str, execute_fn) -> None:
    """
    Wraps pipeline execution with concurrency control so an unhandled exception
    marks the task failed rather than silently dying as a background task.

    Acquires ``_pipeline_semaphore`` before running the pipeline, so at most
    ``settings.pipeline_max_concurrent`` pipelines execute simultaneously.
    """
    # Check if we'll have to wait (semaphore already fully acquired)
    if _pipeline_semaphore._value == 0:  # noqa: SLF001
        logger.info(
            "Task %s waiting for pipeline concurrency slot (max_concurrent=%d)",
            task_id, settings.pipeline_max_concurrent,
        )
    try:
        async with _pipeline_semaphore:
            await execute_fn(task_id)
    except Exception:
        logger.exception("Unhandled exception executing pipeline for task %s", task_id)
        # Best-effort: mark task failed in DB so it doesn't stay stuck in queued
        try:
            from .pipeline.executor import mark_task_failed
            await mark_task_failed(task_id, error="Unhandled pipeline exception — see logs")
        except Exception:
            logger.exception("Could not mark task %s as failed after pipeline crash", task_id)
