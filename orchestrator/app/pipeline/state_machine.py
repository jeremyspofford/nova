"""
Task state machine with compare-and-swap (CAS) transitions.

Prevents invalid status transitions (e.g. complete → queued) and
race conditions where two processes try to update the same task.

Every status update in the codebase should go through transition_task_status()
instead of raw UPDATE queries. This is the single source of truth for
which transitions are legal.

Status lifecycle:
  submitted → queued → {role}_running → completing → complete
                ↕            ↕              ↕
           cancelled      failed         failed
"""

from __future__ import annotations

import logging

from ..db import get_pool

logger = logging.getLogger(__name__)

# ── Valid transitions ─────────────────────────────────────────────────────────
#
# Dynamic statuses: each pipeline agent role produces a "{role}_running" status.
# Rather than enumerating every combination, we define rules:
#   - Any *_running status can transition to another *_running, completing,
#     clarification_needed, pending_human_review, failed, or cancelled.
#   - "queued" can transition to any *_running status, failed, or cancelled.
#
# The static map below covers the well-known statuses. The _is_valid_transition()
# function also handles dynamic *_running statuses that aren't listed explicitly.

VALID_TRANSITIONS: dict[str, set[str]] = {
    "submitted": {"queued", "cancelled", "failed"},
    "queued": {
        "context_running", "task_running", "critique_direction_running",
        "guardrail_running", "code_review_running", "critique_acceptance_running",
        "decision_running", "documentation_running", "diagramming_running",
        "security_review_running", "memory_extraction_running",
        # A resumed task whose every remaining stage is already checkpointed
        # (e.g. crash after the final checkpoint, or a human-checkpoint resume
        # near the end) goes straight to assembly without any *_running hop.
        "completing",
        "cancelled", "failed",
    },
    "context_running": {
        "task_running", "critique_direction_running",
        "clarification_needed", "failed", "cancelled",
    },
    "task_running": {
        "critique_direction_running", "guardrail_running",
        "code_review_running", "critique_acceptance_running",
        "completing", "waiting_human", "failed", "cancelled",
    },
    "critique_direction_running": {
        "task_running", "guardrail_running", "code_review_running",
        "completing", "pending_human_review", "clarification_needed",
        "failed", "cancelled",
    },
    "guardrail_running": {
        "code_review_running", "critique_acceptance_running",
        "completing", "pending_human_review", "failed", "cancelled",
    },
    "code_review_running": {
        "task_running", "critique_acceptance_running",
        "completing", "pending_human_review", "failed", "cancelled",
    },
    "critique_acceptance_running": {
        "task_running", "completing", "pending_human_review",
        "failed", "cancelled",
    },
    "decision_running": {
        "completing", "failed", "cancelled",
    },
    # Post-pipeline agents
    "documentation_running": {"completing", "failed", "cancelled"},
    "diagramming_running": {"completing", "failed", "cancelled"},
    "security_review_running": {"completing", "failed", "cancelled"},
    "memory_extraction_running": {"completing", "failed", "cancelled"},
    # Non-running intermediate states
    "pending_human_review": {"task_running", "queued", "completing", "failed", "cancelled"},
    "clarification_needed": {"queued", "context_running", "task_running", "failed", "cancelled"},
    # Parked mid-stage on a human checkpoint (request_human_checkpoint tool).
    # Resume re-queues; the reaper cancels after checkpoint_timeout_hours.
    "waiting_human": {"queued", "failed", "cancelled"},
    "completing": {"complete", "failed"},
    # Terminal states — no transitions allowed
    "complete": set(),
    "failed": set(),
    "cancelled": set(),
}

TERMINAL_STATES = {"complete", "failed", "cancelled"}

# All known *_running suffixes — used for dynamic validation of unknown roles
_RUNNING_SUFFIX = "_running"


def _is_valid_transition(current: str, new: str) -> bool:
    """
    Check if transitioning from current → new is valid.

    Uses the static VALID_TRANSITIONS map first. For any *_running status
    not in the map (new agent roles added later), falls back to a dynamic
    rule: *_running can go to another *_running, completing, pending_human_review,
    clarification_needed, failed, or cancelled.
    """
    # Known status — use the explicit map
    if current in VALID_TRANSITIONS:
        return new in VALID_TRANSITIONS[current]

    # Unknown *_running status — apply dynamic rule
    if current.endswith(_RUNNING_SUFFIX):
        return (
            new.endswith(_RUNNING_SUFFIX)
            or new in {"completing", "pending_human_review", "clarification_needed", "waiting_human", "failed", "cancelled"}
        )

    # Unknown non-running status — reject (conservative)
    return False


async def transition_task_status(
    task_id: str,
    new_status: str,
    *,
    current_stage: str | None = None,
    extra_sets: str = "",
    extra_args: list | None = None,
) -> bool:
    """
    Atomically transition task status using CAS (compare-and-swap).

    Returns True if the transition succeeded, False if it was invalid or
    another process already changed the status (lost the race).

    Parameters:
        task_id       - UUID of the task
        new_status    - desired next status
        current_stage - optional pipeline stage name to set
        extra_sets    - additional SET clauses with sequential $N placeholders
                        starting from $4 (e.g. ", error = $4, completed_at = now()").
                        If current_stage is also provided, extra_sets placeholders
                        must start from $5 since $4 is used for current_stage.
        extra_args    - bind parameter values corresponding to $N in extra_sets

    The function:
      1. Reads the current status
      2. Validates the transition against the state machine
      3. Uses CAS: UPDATE ... WHERE id = $1 AND status = $current
      4. Returns False if 0 rows updated (race lost or already transitioned)

    Reserved bind positions: $1=task_id, $2=new_status, $3=current_status.
    $4+ are available for current_stage and extra_args in that order.
    """
    pool = get_pool()
    async with pool.acquire() as conn:
        # Step 1: Read current status
        row = await conn.fetchrow(
            "SELECT status FROM tasks WHERE id = $1",
            task_id,
        )
        if row is None:
            logger.error(
                "transition_task_status: task %s not found", task_id
            )
            return False

        current_status = row["status"]

        # Step 2: Validate transition
        if not _is_valid_transition(current_status, new_status):
            logger.error(
                "Invalid task status transition: task=%s %s -> %s (rejected by state machine)",
                task_id, current_status, new_status,
            )
            return False

        # Step 3: CAS update — only succeeds if status hasn't changed since our read
        heartbeat_clause = ", last_heartbeat_at = now()" if new_status.endswith(_RUNNING_SUFFIX) else ""

        # Build the query dynamically based on optional clauses.
        # Bind positions: $1=task_id, $2=new_status, $3=current_status
        bind_args: list = [task_id, new_status, current_status]
        next_idx = 4

        if current_stage is not None:
            stage_clause = f", current_stage = ${next_idx}"
            bind_args.append(current_stage)
            next_idx += 1
        else:
            stage_clause = ""

        if extra_args:
            bind_args.extend(extra_args)

        query = f"""
            UPDATE tasks
            SET status = $2{stage_clause}{heartbeat_clause}{extra_sets}
            WHERE id = $1 AND status = $3
        """

        result = await conn.execute(query, *bind_args)

    if result == "UPDATE 0":
        logger.error(
            "CAS failed for task %s: expected status '%s', task was already changed "
            "(target was '%s')",
            task_id, current_status, new_status,
        )
        return False

    logger.debug(
        "Task %s: %s -> %s", task_id, current_status, new_status
    )
    return True


async def force_fail_task(task_id: str, reason: str) -> bool:
    """
    Recovery-path helper: transition a stuck task to 'failed' without going
    through the CAS state machine. Used by the reaper and startup cleanup
    when a task has gone silent for longer than task_stale_seconds.

    Writes the given reason to tasks.error as an audit trail. Returns True
    if the row was updated, False if the task did not exist or was already
    in a terminal state (failed/complete/cancelled).
    """
    pool = get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE tasks
               SET status = 'failed',
                   error = $2,
                   completed_at = now(),
                   last_heartbeat_at = now()
             WHERE id = $1::uuid
               AND status NOT IN ('failed', 'complete', 'cancelled')
            """,
            task_id, reason,
        )
    # asyncpg returns "UPDATE <rowcount>" — "UPDATE 1" means a row was changed
    updated = result.endswith(" 1")
    if updated:
        logger.warning(
            "force_fail_task: %s -> failed (reason: %s)", task_id, reason,
        )
    return updated
