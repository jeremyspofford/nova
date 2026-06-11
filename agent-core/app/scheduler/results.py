"""Surface scheduled-run output into chat — one conversation thread per schedule.

A conversation is any task that has task_messages rows (see conversations_router).
Each schedule lazily gets a dedicated thread task; every run appends its result as
an assistant message, so schedule output appears in the chat sidebar like any other
conversation — and the user can reply to it there to follow up on a result.
"""
from __future__ import annotations

import logging
import uuid

logger = logging.getLogger(__name__)


async def post_schedule_result(pool, task_id, schedule_id, final_status: str, result_text: str) -> None:
    """Append a scheduled run's result to the schedule's conversation thread.

    Never raises — surfacing output must not affect task completion.

    Convention: a completed run whose entire result is `NOTHING` is intentionally
    quiet — nothing posts. The proactivity pulse relies on this so "no, nothing
    worth doing" cycles don't spam the thread; any schedule may use it. Matched
    case-insensitively and ignoring trailing punctuation: small local models reply
    "Nothing." as often as the requested exact token (observed live, qwen2.5:0.5b).
    """
    if final_status == "completed" and (result_text or "").strip().rstrip(".!").strip().upper() == "NOTHING":
        logger.debug("schedule %s run was a quiet NOTHING — not posting", str(schedule_id)[:8])
        return
    try:
        async with pool.acquire() as conn:
            sched = await conn.fetchrow(
                "SELECT name, conversation_task_id FROM schedules WHERE id = $1::uuid",
                schedule_id,
            )
            if sched is None:
                return

            thread_id = sched["conversation_task_id"]
            # Guard against a dangling id (FK handles UI deletes, but a partial
            # restore can leave one behind).
            if thread_id is not None:
                exists = await conn.fetchval("SELECT 1 FROM tasks WHERE id = $1", thread_id)
                if exists is None:
                    thread_id = None

            if thread_id is None:
                thread_id = uuid.uuid4()
                await conn.execute(
                    "INSERT INTO tasks (id, prompt, goal, status, source) "
                    "VALUES ($1, $2, $2, 'completed', 'schedule-thread')",
                    thread_id, f"⏰ {sched['name']}",
                )
                await conn.execute(
                    "UPDATE schedules SET conversation_task_id = $1 WHERE id = $2::uuid",
                    thread_id, schedule_id,
                )

            if final_status == "completed":
                content = result_text or "(run completed with no output)"
            else:
                content = f"Scheduled run failed: {result_text or 'unknown error'}"
            await conn.execute(
                "INSERT INTO task_messages (task_id, role, content) VALUES ($1, 'assistant', $2)",
                thread_id, content,
            )
    except Exception as exc:
        logger.warning(
            "could not post schedule result (schedule=%s task=%s): %s",
            str(schedule_id)[:8], str(task_id)[:8], exc,
        )


async def record_fire(pool, schedule_id) -> None:
    """Bump last_fired/fire_count for an event-driven fire (webhook/fs_watch/task_complete).

    The poll path updates these inside its own transaction; event-driven paths must
    record fires too or the dashboard under-reports runs. Never raises.
    """
    try:
        await pool.execute(
            "UPDATE schedules SET last_fired = now(), fire_count = fire_count + 1 WHERE id = $1::uuid",
            schedule_id,
        )
    except Exception as exc:
        logger.warning("could not record fire for schedule %s: %s", str(schedule_id)[:8], exc)
