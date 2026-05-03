"""Approval-execution worker.

Background asyncio task that BRPOPs approval IDs off
``nova:queue:approved_executions`` (Redis db 2 — the orchestrator's main db)
and dispatches each one through ``executor.execute_approved``. This is what
closes the loop from "user clicks Approve in the dashboard" to "the originally
pended tool call actually runs."

Concurrency: ``asyncio.Semaphore(3)`` — three approved executions in flight at
once. GitHub MUTATE tools (open_fix_pr, comment_on_pr) take seconds; this
caps the simultaneous outbound load while letting backlogs drain quickly.

Dead-lettering: per-approval consecutive-failure tracking (in-memory dict keyed
by approval_id). After three consecutive errors for the same approval_id the
worker LPUSHes it to ``nova:queue:approved_executions:dead`` and removes the
counter. A single transient retry isn't dead-lettered — only repeated ones.

Lifespan:
  - Started from ``app.main.lifespan`` via ``asyncio.create_task``
  - Cancelled and awaited at shutdown
  - The Redis client (lazy via consent._get_consent_redis) is closed via
    ``consent.close_consent_redis()`` from the same shutdown block
"""
from __future__ import annotations

import asyncio
import logging
from uuid import UUID

import redis.asyncio as aioredis

from app.capabilities import consent
from app.capabilities.executor import execute_approved
from app.config import settings
from app.db import get_pool

logger = logging.getLogger(__name__)

# BRPOP block timeout. Short enough that lifespan shutdown cancels promptly.
_BRPOP_TIMEOUT_S = 5.0
_MAX_CONSECUTIVE_FAILURES = 3
_CONCURRENCY = 3

# Lazily-initialized worker-side Redis. Distinct connection from the one
# decide_approval uses on the producer side (consent._get_consent_redis)
# so a slow BRPOP can't starve the LPUSH path.
_worker_redis: aioredis.Redis | None = None
# Consecutive failures keyed by approval_id (UUID string)
_failure_counts: dict[str, int] = {}


def _get_worker_redis() -> aioredis.Redis:
    global _worker_redis
    if _worker_redis is None:
        _worker_redis = aioredis.from_url(
            settings.redis_url, decode_responses=True,
        )
    return _worker_redis


async def close_approval_worker_redis() -> None:
    """Close the worker-side Redis connection. Call at lifespan shutdown."""
    global _worker_redis
    if _worker_redis is not None:
        try:
            await _worker_redis.aclose()
        finally:
            _worker_redis = None


async def _process_one(approval_id_str: str, semaphore: asyncio.Semaphore) -> None:
    """Run a single approval through the executor, gated by the semaphore."""
    async with semaphore:
        try:
            approval_id = UUID(approval_id_str)
        except ValueError:
            logger.warning(
                "approval-worker: dropping non-UUID payload %r",
                approval_id_str,
            )
            return

        pool = get_pool()
        try:
            outcome = await execute_approved(pool, approval_id)
            # Reset failure counter on success / non-error outcome.
            _failure_counts.pop(approval_id_str, None)
            logger.info(
                "approval-worker: approval=%s outcome=%s",
                approval_id, outcome.get("status"),
            )
        except Exception:
            _failure_counts[approval_id_str] = (
                _failure_counts.get(approval_id_str, 0) + 1
            )
            count = _failure_counts[approval_id_str]
            logger.exception(
                "approval-worker: error executing approval=%s (attempt %d/%d)",
                approval_id_str, count, _MAX_CONSECUTIVE_FAILURES,
            )
            if count >= _MAX_CONSECUTIVE_FAILURES:
                try:
                    redis = _get_worker_redis()
                    await redis.lpush(
                        consent.APPROVED_EXEC_DEAD_QUEUE, approval_id_str,
                    )
                    logger.error(
                        "approval-worker: dead-lettered approval=%s after %d failures",
                        approval_id_str, count,
                    )
                except Exception:
                    logger.exception(
                        "approval-worker: failed to dead-letter %s",
                        approval_id_str,
                    )
                _failure_counts.pop(approval_id_str, None)


async def approval_worker_loop() -> None:
    """Long-running BRPOP loop. Dispatches approved executions concurrently.

    Cancellation-safe: when the lifespan task is cancelled, the BRPOP raises
    CancelledError on the next iteration and we exit. Outstanding _process_one
    tasks are *not* awaited here — they're tracked so the lifespan can
    asyncio.gather(..., return_exceptions=True) on shutdown if it wants to.
    For now, dropping them on cancellation is acceptable: a partial PR creation
    is recoverable (re-run the approval; idempotent on the GitHub side because
    the branch+title combo is deterministic).
    """
    logger.info("approval-worker: starting (BRPOP %s)", consent.APPROVED_EXEC_QUEUE)
    semaphore = asyncio.Semaphore(_CONCURRENCY)
    in_flight: set[asyncio.Task] = set()

    try:
        while True:
            try:
                redis = _get_worker_redis()
                # BRPOP returns (key, value) tuple, or None on timeout
                popped = await redis.brpop(
                    consent.APPROVED_EXEC_QUEUE, timeout=_BRPOP_TIMEOUT_S,
                )
                if popped is None:
                    continue
                _, approval_id_str = popped
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("approval-worker: BRPOP error — backing off 2s")
                await asyncio.sleep(2)
                continue

            task = asyncio.create_task(
                _process_one(approval_id_str, semaphore),
                name=f"approval-exec-{approval_id_str[:8]}",
            )
            in_flight.add(task)
            task.add_done_callback(in_flight.discard)
    except asyncio.CancelledError:
        logger.info(
            "approval-worker: cancelled (in_flight=%d) — shutting down",
            len(in_flight),
        )
        raise
