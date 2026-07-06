"""Goal schedule checker — queries due goals and emits stimuli.

Called during Cortex's PERCEIVE phase each cycle. Finds goals where
schedule_next_at <= now(), emits goal.schedule_due stimuli, and
advances schedule_next_at to the next fire time.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from croniter import croniter

from .db import get_pool
from .stimulus import GOAL_SCHEDULE_DUE

log = logging.getLogger(__name__)


async def check_schedules() -> list[dict]:
    """Find due scheduled goals and return stimuli dicts.

    Also advances schedule_next_at and increments completion_count.
    Returns stimulus dicts (not pushed to Redis — caller merges into cycle).
    """
    pool = get_pool()
    now = datetime.now(timezone.utc)

    async with pool.acquire() as conn:
        # Self-heal: migration-seeded (or hand-inserted) cron goals arrive with
        # NULL schedule_next_at, which the due-query below skips forever. Give
        # them a first fire time so seeding a goal is enough to schedule it.
        uninitialized = await conn.fetch(
            """
            SELECT id, title, schedule_cron
            FROM goals
            WHERE status = 'active'
              AND schedule_cron IS NOT NULL
              AND schedule_next_at IS NULL
            """
        )
        for row in uninitialized:
            try:
                first_at = croniter(row["schedule_cron"], now).get_next(datetime)
            except (ValueError, KeyError):
                log.warning(
                    "Invalid cron for goal %s (%s): %s — cannot initialize",
                    row["id"], row["title"], row["schedule_cron"],
                )
                continue
            await conn.execute(
                "UPDATE goals SET schedule_next_at = $1, updated_at = NOW() WHERE id = $2",
                first_at, row["id"],
            )
            log.info(
                "Initialized schedule for goal %s (%s): first fire %s",
                row["id"], row["title"], first_at,
            )

        rows = await conn.fetch(
            """
            SELECT id, title, priority, schedule_cron, max_completions, completion_count
            FROM goals
            WHERE status = 'active'
              AND schedule_cron IS NOT NULL
              AND schedule_next_at IS NOT NULL
              AND schedule_next_at <= $1
              AND (max_completions IS NULL OR completion_count < max_completions)
            ORDER BY priority DESC
            LIMIT 10
            """,
            now,
        )

        stimuli = []
        for row in rows:
            goal_id = str(row["id"])
            cron_expr = row["schedule_cron"]

            # Compute next fire time
            try:
                next_at = croniter(cron_expr, now).get_next(datetime)
            except (ValueError, KeyError):
                log.warning("Invalid cron for goal %s: %s — skipping", goal_id, cron_expr)
                continue

            # Advance schedule and increment count
            new_count = row["completion_count"] + 1
            await conn.execute(
                """
                UPDATE goals
                SET schedule_next_at = $1,
                    schedule_last_ran_at = $2,
                    completion_count = $3,
                    updated_at = NOW()
                WHERE id = $4
                """,
                next_at, now, new_count, row["id"],
            )

            # Auto-complete one-shot goals
            if row["max_completions"] is not None and new_count >= row["max_completions"]:
                await conn.execute(
                    "UPDATE goals SET status = 'completed', updated_at = NOW() WHERE id = $1",
                    row["id"],
                )
                log.info("Goal %s completed (max_completions=%d reached)", goal_id, row["max_completions"])

            stimuli.append({
                "type": GOAL_SCHEDULE_DUE,
                "source": "cortex",
                "payload": {"goal_id": goal_id, "title": row["title"]},
                "priority": row["priority"],
            })
            log.info("Schedule due: goal %s (%s), next at %s", goal_id, row["title"], next_at)

        return stimuli
