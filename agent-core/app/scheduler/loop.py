"""Scheduler loop: polls the schedules table, dispatches due tasks."""
from __future__ import annotations
import asyncio
import logging
from datetime import datetime, timezone, timedelta
from typing import Any, Callable, Awaitable

from .utils import compute_next_fire, resolve_placeholders
from ..watchers.handler import _fire_queue

logger = logging.getLogger(__name__)

POLL_INTERVAL_S = 10
MISSED_THRESHOLD_S = 90  # append note to prompt if we're this late


async def scheduler_loop(pool, dispatch_fn: Callable) -> None:
    """Long-running loop: poll time-based schedules + drain the fs_watch queue."""
    logger.info("Scheduler loop started")
    while True:
        try:
            await _poll_once(pool, dispatch_fn)
            await _drain_file_queue(pool, dispatch_fn)
        except asyncio.CancelledError:
            logger.info("Scheduler loop cancelled")
            raise
        except Exception as exc:
            logger.error("Scheduler loop error (continuing): %s", exc)
        await asyncio.sleep(POLL_INTERVAL_S)


async def _poll_once(pool, dispatch_fn: Callable) -> None:
    """Find all enabled schedules whose next_fire <= now and dispatch them."""
    now = datetime.now(timezone.utc)
    async with pool.acquire() as conn:
        async with conn.transaction():
            due = await conn.fetch(
                """
                SELECT id, name, prompt, trigger, enabled, last_fired, next_fire
                FROM schedules
                WHERE enabled = true
                  AND next_fire IS NOT NULL
                  AND next_fire <= $1
                FOR UPDATE SKIP LOCKED
                """,
                now,
            )

            for row in due:
                schedule_id = str(row["id"])
                prompt = row["prompt"]
                trigger = row["trigger"]
                next_fire = row["next_fire"]

                # Concurrency guard: skip if a running task for this schedule exists.
                running_task = await conn.fetchval(
                    "SELECT id FROM tasks WHERE schedule_id = $1 AND status IN ('pending', 'running') LIMIT 1",
                    row["id"],
                )
                if running_task is not None:
                    logger.debug("Skipping schedule %s — previous run still active", schedule_id[:8])
                    continue

                # Missed-schedule note.
                lateness = (now - next_fire.replace(tzinfo=timezone.utc) if next_fire.tzinfo is None
                            else now - next_fire).total_seconds()
                if lateness > MISSED_THRESHOLD_S:
                    prompt = f"{prompt}\n\n[Note: this run was {int(lateness)}s late]"

                # Compute next fire time (before disabling once schedules).
                trigger_type = trigger.get("type")
                new_next_fire = compute_next_fire(trigger) if trigger_type not in ("once",) else None

                # Update schedule metadata.
                if trigger_type == "once":
                    await conn.execute(
                        """UPDATE schedules
                           SET last_fired = $2, next_fire = NULL, fire_count = fire_count + 1, enabled = $3
                           WHERE id = $1""",
                        row["id"], now, False,
                    )
                else:
                    await conn.execute(
                        """UPDATE schedules
                           SET last_fired = $2, next_fire = $3, fire_count = fire_count + 1
                           WHERE id = $1""",
                        row["id"], now, new_next_fire,
                    )

    # Dispatch OUTSIDE the transaction to avoid holding the lock during execution.
    for row in due:
        schedule_id = str(row["id"])
        prompt = row["prompt"]
        trigger = row["trigger"]
        next_fire = row["next_fire"]

        # Re-check concurrency guard (race window between transaction and dispatch).
        async with pool.acquire() as conn:
            running_task = await conn.fetchval(
                "SELECT id FROM tasks WHERE schedule_id = $1 AND status IN ('pending', 'running') LIMIT 1",
                row["id"],
            )
        if running_task is not None:
            continue

        lateness = (now - next_fire.replace(tzinfo=timezone.utc) if next_fire.tzinfo is None
                    else now - next_fire).total_seconds()
        if lateness > MISSED_THRESHOLD_S:
            prompt = f"{prompt}\n\n[Note: this run was {int(lateness)}s late]"

        try:
            task_id = await dispatch_fn(prompt, f"schedule:{schedule_id}", schedule_id)
            logger.info(
                "Dispatched task %s for schedule %s (%s)",
                str(task_id)[:8], schedule_id[:8], row["name"],
            )
        except Exception as exc:
            logger.error("Failed to dispatch schedule %s: %s", schedule_id[:8], exc)


async def _drain_file_queue(pool, dispatch_fn: Callable) -> None:
    """Drain the watchdog fire queue and dispatch tasks for each event."""
    while not _fire_queue.empty():
        try:
            item = _fire_queue.get_nowait()
        except Exception:
            break

        schedule_id = item["schedule_id"]
        file_path = item.get("file_path", "")
        file_event = item.get("file_event", "")

        # Fetch the schedule's prompt.
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT prompt FROM schedules WHERE id = $1 AND enabled = true",
                schedule_id,
            )
        if row is None:
            logger.debug("fs_watch fire for unknown/disabled schedule %s — skipping", schedule_id)
            continue

        prompt = resolve_placeholders(row["prompt"], {
            "file_path": file_path,
            "file_event": file_event,
        })
        try:
            task_id = await dispatch_fn(prompt, f"schedule:{schedule_id}", schedule_id)
            logger.info(
                "fs_watch dispatched task %s for schedule %s (file=%s event=%s)",
                str(task_id)[:8], schedule_id[:8], file_path, file_event,
            )
        except Exception as exc:
            logger.error("Failed to dispatch fs_watch schedule %s: %s", schedule_id[:8], exc)


async def fire_task_complete_schedules(
    pool,
    completed_task_id: str,
    final_status: str,
    dispatch_fn: Callable,
) -> None:
    """Called when a task completes; fires any task_complete schedules watching that task."""
    rows = await pool.fetch(
        """
        SELECT id, prompt, trigger
        FROM schedules
        WHERE enabled = true
          AND trigger->>'type' = 'task_complete'
          AND trigger->>'task_id' = $1
        """,
        completed_task_id,
    )
    for row in rows:
        trigger = row["trigger"]
        on_status = trigger.get("on_status", ["completed"])
        if final_status not in on_status:
            continue

        schedule_id = str(row["id"])
        prompt = resolve_placeholders(row["prompt"], {
            "completed_task_id": completed_task_id,
            "final_status": final_status,
        })
        try:
            task_id = await dispatch_fn(prompt, f"schedule:{schedule_id}", schedule_id)
            logger.info(
                "task_complete schedule %s dispatched task %s (upstream=%s status=%s)",
                schedule_id[:8], str(task_id)[:8], completed_task_id[:8], final_status,
            )
        except Exception as exc:
            logger.error("Failed to dispatch task_complete schedule %s: %s", schedule_id[:8], exc)


async def fire_webhook_schedule(
    pool,
    schedule_id: str,
    payload: dict[str, Any],
    dispatch_fn: Callable,
) -> None:
    """Called by the webhook endpoint after auth; dispatches the schedule's task."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT prompt FROM schedules WHERE id = $1 AND enabled = true",
            schedule_id,
        )
    if row is None:
        logger.warning("Webhook fire for unknown/disabled schedule %s", schedule_id[:8])
        return

    prompt = resolve_placeholders(row["prompt"], payload)
    try:
        task_id = await dispatch_fn(prompt, f"schedule:{schedule_id}", schedule_id)
        logger.info("Webhook schedule %s dispatched task %s", schedule_id[:8], str(task_id)[:8])
    except Exception as exc:
        logger.error("Failed to dispatch webhook schedule %s: %s", schedule_id[:8], exc)
