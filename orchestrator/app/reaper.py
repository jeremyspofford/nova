"""
Reaper: periodic background task that detects and recovers from failures.

Runs every settings.reaper_interval_seconds as asyncio.create_task in main.py lifespan.
Replaces the startup-only recover_stale_agents() with continuous monitoring.

What it catches:
  1. Tasks stuck in running states with no heartbeat → retry or fail + dead letter
  2. Agent sessions running past their timeout → mark failed, propagate to task
  3. Tasks queued but never started (queue worker died) → re-enqueue

The Reaper does NOT cancel actively-running tasks — it only acts on tasks
that have gone silent (heartbeat expired or no started_at after grace period).
A task that keeps heartbeating while a stage grinds forever is killed by the
in-process wall-clock timeout instead (pipeline.stage_timeout_seconds,
executor.StageWallClockTimeout — safety rail step 3); the Reaper is the
backstop for a dead or partitioned process, not the primary timeout.
"""

from __future__ import annotations

import asyncio
import logging

from .config import settings

logger = logging.getLogger(__name__)

# Pipeline running states monitored by the reaper.
# These are the states where a live heartbeat is expected.
# Post-pipeline stages (documentation_running, diagramming_running, etc.)
# are intentionally excluded — they have different heartbeat expectations.
_ACTIVE_RUNNING_STATES = (
    "context_running", "task_running",
    "critique_direction_running", "guardrail_running",
    "code_review_running", "critique_acceptance_running",
    "decision_running", "completing",
)


# ── Main loop ──────────────────────────────────────────────────────────────────

async def reaper_loop() -> None:
    """
    Entry point. Started as asyncio.create_task in main.py lifespan.
    Wakes every settings.reaper_interval_seconds, runs all reap checks, sleeps again.
    """
    logger.info("Reaper started")
    _cycle = 0
    while True:
        try:
            await asyncio.sleep(settings.reaper_interval_seconds)
            await _reap_stale_running_tasks()
            await _reap_stuck_queued_tasks()
            await _reap_timed_out_sessions()
            await _reap_stale_clarifications()
            await _reap_stale_checkpoints()
            await _reap_expired_approvals()
            # Run task history cleanup once per ~60 cycles (~hourly at 60s interval)
            _cycle += 1
            if _cycle % 60 == 0:
                await _cleanup_expired_tasks()
        except asyncio.CancelledError:
            logger.info("Reaper shutting down")
            break
        except Exception:
            logger.exception("Reaper cycle error — will retry next interval")


# ── Reap stale running tasks ───────────────────────────────────────────────────

async def _reap_stale_running_tasks() -> None:
    """
    Find tasks in active states whose heartbeat has expired.
    These are tasks that started execution but the pipeline process died.

    The DB query only nominates CANDIDATES: the live heartbeat is the Redis
    key the executor's heartbeat loop refreshes every 30s
    (queue.write_heartbeat), while tasks.last_heartbeat_at is only touched
    once at pipeline start. Before this liveness check existed, every task
    whose stage legitimately ran past task_stale_seconds (~150s — routine
    for local models on CPU) was force-failed while its process was healthy
    and heartbeating. A candidate with a live Redis heartbeat gets its DB
    timestamp refreshed and is skipped; a Redis outage falls through to the
    reap (the heartbeat writer can't write either, so the DB column is the
    only signal left).

    Recovery: always force-fail via force_fail_task, which bypasses the CAS
    state machine. The reaper is a terminal recovery mechanism — if a task
    wants to retry, it must be re-submitted through the normal path. The old
    retry-requeue branch attempted task_running → queued, which the state
    machine rejects, causing a 60-second error spam loop (REL-001).
    """
    from .db import get_pool
    from .pipeline.state_machine import force_fail_task
    from .queue import is_heartbeat_alive, move_to_dead_letter

    pool = get_pool()
    async with pool.acquire() as conn:
        stale_tasks = await conn.fetch(
            """
            SELECT id, status, retry_count, max_retries
            FROM tasks
            WHERE status = ANY($1::text[])
              AND (
                last_heartbeat_at IS NULL
                OR last_heartbeat_at < now() - ($2 || ' seconds')::interval
              )
            """,
            list(_ACTIVE_RUNNING_STATES),
            str(settings.task_stale_seconds),
        )

    for task in stale_tasks:
        task_id = str(task["id"])

        try:
            alive = await is_heartbeat_alive(task_id)
        except Exception as e:
            logger.warning(
                "Reaper could not check Redis heartbeat for %s (%s) — "
                "falling back to the DB timestamp", task_id, e,
            )
            alive = False
        if alive:
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE tasks SET last_heartbeat_at = now() WHERE id = $1",
                    task["id"],
                )
            continue

        reason = (
            f"reaped: heartbeat expired in state '{task['status']}' "
            f"(retry_count={task['retry_count']}/{task['max_retries']})"
        )
        ok = await force_fail_task(task_id, reason)
        if not ok:
            # Already terminal (complete/failed/cancelled) — nothing to do
            continue
        await move_to_dead_letter(task_id, reason="heartbeat_timeout")
        async with pool.acquire() as conn:
            await _audit(conn, "task_failed", "error", task_id=task_id,
                         data={"reason": "heartbeat_timeout", "was_running_as": task["status"]})


# ── Startup cleanup ───────────────────────────────────────────────────────────

async def cleanup_stale_running_on_startup() -> int:
    """
    One-time at startup: force-fail any task whose heartbeat has expired
    AND is still in a *_running state. Idempotent — subsequent calls find
    nothing to do because earlier runs already cleaned them up.

    Returns the count of tasks cleaned up (for logging).
    """
    from .db import get_pool
    from .pipeline.state_machine import force_fail_task

    pool = get_pool()
    async with pool.acquire() as conn:
        stale = await conn.fetch(
            """
            SELECT id, status, last_heartbeat_at
              FROM tasks
             WHERE status = ANY($1::text[])
               AND (
                 last_heartbeat_at IS NULL
                 OR last_heartbeat_at < now() - ($2 || ' seconds')::interval
               )
            """,
            list(_ACTIVE_RUNNING_STATES),
            str(settings.task_stale_seconds),
        )

    count = 0
    for task in stale:
        reason = (
            f"reaped at startup: previously stuck in '{task['status']}' "
            f"since {task['last_heartbeat_at']}"
        )
        if await force_fail_task(str(task["id"]), reason):
            count += 1

    if count > 0:
        logger.warning("Startup cleanup: force-failed %d stale running tasks", count)
    return count


# ── Reap stuck queued tasks ────────────────────────────────────────────────────

async def _reap_stuck_queued_tasks() -> None:
    """
    Find tasks that have been in 'queued' state too long without being picked up.
    This catches the case where the queue worker died after the task was dequeued
    from Redis but before it updated the DB status to a running state.

    Fix: re-push the task_id back onto the Redis queue. The DB status stays
    'queued' — the worker will pick it up and transition to a running state.
    """
    from .db import get_pool
    from .queue import enqueue_task

    pool = get_pool()
    async with pool.acquire() as conn:
        # CAS UPDATE: atomically claim stuck tasks by bumping queued_at.
        # Only one reaper wins the row — prevents double-enqueue races.
        stuck = await conn.fetch(
            """
            UPDATE tasks
            SET queued_at = now()
            WHERE status = 'queued'
              AND queued_at < now() - ($1 || ' seconds')::interval
            RETURNING id
            """,
            str(settings.stale_queued_seconds),
        )

        for task in stuck:
            task_id = str(task["id"])
            logger.warning("Reaper: task %s stuck in queued state — re-pushing to queue", task_id)
            await enqueue_task(task_id)
            await _audit(conn, "task_requeued", "warning", task_id=task_id,
                         data={"reason": "stuck_in_queued"})


# ── Reap timed-out agent sessions ─────────────────────────────────────────────

async def _reap_timed_out_sessions() -> None:
    """
    Find agent sessions running past their timeout_seconds (from pod_agents config).
    Mark them failed. The pipeline executor's heartbeat loop will detect the failed
    session and handle it per the agent's on_failure config (abort/skip/escalate).
    """
    from .db import get_pool

    pool = get_pool()
    async with pool.acquire() as conn:
        timed_out = await conn.fetch(
            """
            SELECT s.id, s.task_id, s.role, pa.timeout_seconds
            FROM agent_sessions s
            LEFT JOIN pod_agents pa ON pa.id = s.pod_agent_id
            WHERE s.status = 'running'
              AND s.started_at IS NOT NULL
              AND s.started_at < now() - (
                  COALESCE(pa.timeout_seconds, 60) + $1
              ) * interval '1 second'
            """,
            settings.session_timeout_buffer_seconds,
        )

        for session in timed_out:
            session_id = str(session["id"])
            task_id    = str(session["task_id"])
            logger.warning(
                "Reaper: agent session %s (role=%s) timed out on task %s",
                session_id, session["role"], task_id,
            )
            await conn.execute(
                """
                UPDATE agent_sessions
                SET status = 'failed',
                    error = 'Agent session exceeded timeout',
                    completed_at = now()
                WHERE id = $1
                """,
                session["id"],
            )
            await _audit(conn, "session_timeout", "warning",
                         task_id=task_id,
                         data={"session_id": session_id, "role": session["role"]})


# ── Reap stale clarification tasks ────────────────────────────────────────────

async def _reap_stale_clarifications() -> None:
    """Cancel tasks stuck in clarification_needed past the timeout."""
    from .db import get_pool

    timeout_hours = settings.clarification_timeout_hours
    pool = get_pool()
    async with pool.acquire() as conn:
        stale = await conn.fetch(
            """
            SELECT id FROM tasks
            WHERE status = 'clarification_needed'
              AND (metadata->>'clarification_requested_at')::timestamptz
                  < now() - ($1 || ' hours')::interval
            """,
            str(timeout_hours),
        )
    from .pipeline.state_machine import transition_task_status

    for task in stale:
        task_id = str(task["id"])
        logger.warning(
            "Reaper: task %s clarification timed out after %dh — cancelling",
            task_id, timeout_hours,
        )
        ok = await transition_task_status(
            task_id, "cancelled",
            extra_sets=", error = $4, completed_at = now()",
            extra_args=["Timed out waiting for clarification"],
        )
        if not ok:
            logger.info("Reaper: task %s cancellation rejected by state machine — skipping", task_id)
            continue
        async with pool.acquire() as audit_conn:
            await _audit(audit_conn, "task_cancelled", "warning", task_id=task_id,
                         data={"reason": "clarification_timeout"})


# ── Reap stale human checkpoints ──────────────────────────────────────────────

async def _reap_stale_checkpoints() -> None:
    """Cancel waiting_human tasks whose human checkpoint went unanswered.

    Mirrors _reap_stale_clarifications. Also flips the still-pending
    checkpoint approval row to 'timeout' so it leaves Pending Approvals.
    """
    from .db import get_pool

    timeout_hours = settings.checkpoint_timeout_hours
    pool = get_pool()
    async with pool.acquire() as conn:
        stale = await conn.fetch(
            """
            SELECT id, metadata->>'checkpoint_approval_id' AS approval_id
            FROM tasks
            WHERE status = 'waiting_human'
              AND (metadata->>'checkpoint_requested_at')::timestamptz
                  < now() - ($1 || ' hours')::interval
            """,
            str(timeout_hours),
        )
    from .pipeline.state_machine import transition_task_status

    for task in stale:
        task_id = str(task["id"])
        logger.warning(
            "Reaper: task %s human checkpoint unanswered after %dh — cancelling",
            task_id, timeout_hours,
        )
        ok = await transition_task_status(
            task_id, "cancelled",
            extra_sets=", error = $4, completed_at = now()",
            extra_args=["Timed out waiting for human checkpoint response"],
        )
        if not ok:
            logger.info("Reaper: task %s cancellation rejected by state machine — skipping", task_id)
            continue
        if task["approval_id"]:
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE approval_requests SET status='timeout' "
                    "WHERE id=$1::uuid AND status='pending'",
                    task["approval_id"],
                )
        async with pool.acquire() as audit_conn:
            await _audit(audit_conn, "task_cancelled", "warning", task_id=task_id,
                         data={"reason": "checkpoint_timeout"})


# ── Reap expired pending approvals ────────────────────────────────────────────

async def _reap_expired_approvals() -> None:
    """Expired pending approvals → 'timeout', so they leave the DB's idea of
    'pending' instead of zombie-ing forever.

    The consent worker flips a row only when it comes back to execute the
    call; if the task died first, nothing ever touches the row again — it's
    hidden from /approvals (which filters expires_at > now()) while every
    inbox message about it still says 'waiting for your decision'. Checkpoint
    approvals whose task is still parked (waiting_human) are left for
    _reap_stale_checkpoints, which also resolves the task.
    """
    from .db import get_pool

    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            UPDATE approval_requests ar
            SET status = 'timeout'
            WHERE ar.status = 'pending'
              AND ar.expires_at < now()
              AND NOT EXISTS (
                  SELECT 1 FROM tasks t
                  WHERE t.id = ar.task_id AND t.status = 'waiting_human'
              )
            RETURNING ar.id, ar.kind, ar.tool_name
            """,
        )
    for r in rows:
        logger.info(
            "Reaper: approval %s (%s %s) expired unanswered — marked timeout",
            r["id"], r["kind"], r["tool_name"],
        )


# ── Auto-cleanup expired task history ─────────────────────────────────────────

async def _cleanup_expired_tasks() -> None:
    """
    Delete terminal tasks older than the configured retention period.
    Reads `task_history_retention_days` from platform config.
    0 or missing = disabled (keep forever).
    """
    from .db import get_pool

    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT value FROM platform_config WHERE key = 'task_history_retention_days'"
        )
        if not row:
            return
        try:
            days = int(row["value"].strip('"'))
        except (ValueError, TypeError, AttributeError):
            return
        if days <= 0:
            return

        result = await conn.execute(
            """
            DELETE FROM tasks
            WHERE status IN ('complete', 'failed', 'cancelled')
              AND completed_at < now() - ($1 || ' days')::interval
            """,
            str(days),
        )
        deleted = int(result.split()[-1])
        if deleted > 0:
            logger.info("Auto-cleanup: deleted %d tasks older than %d days", deleted, days)
            await _audit(conn, "task_history_cleanup", "info",
                         data={"deleted": deleted, "retention_days": days})


# ── Audit helper ──────────────────────────────────────────────────────────────

async def _audit(
    conn,
    event_type: str,
    severity: str,
    *,
    task_id: str | None = None,
    data: dict | None = None,
) -> None:
    """Write a reaper event to the immutable audit log."""
    from .audit import write_audit_log
    await write_audit_log(
        conn,
        event_type=event_type,
        severity=severity,
        task_id=task_id,
        message=f"Reaper: {event_type}",
        data=data,
    )
