"""Scheduled-goal firing via a transactional outbox (cron durability).

Two phases, called from Cortex's PERCEIVE:

  enqueue_due_fires()  — for each goal whose schedule_next_at is due, record a
                         durable fire in goal_fire_outbox AND advance the clock
                         (schedule_next_at, completion_count) in the SAME
                         transaction. The clock never advances without a durable
                         fire, so a crash can't silently drop a scheduled run.

  drain_outbox()       — return stimuli for pending fires WITHOUT marking them
                         done. The caller acks (ack_fires) only after the cycle
                         has processed them, so a crash mid-cycle redelivers.
                         At-least-once: a missed briefing is worse than a rare
                         duplicate, and duplicate side effects are bounded by
                         the tool-idempotency ledger (migration 103).

Replaces the old check_schedules(), which advanced the clock before the work
was durable — at-most-once with a data-loss window.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from croniter import croniter

from .db import get_pool
from .stimulus import GOAL_SCHEDULE_DUE

log = logging.getLogger(__name__)

# A fire that keeps coming back without being acked (cycle crashes each time it
# is processed) is parked as 'failed' after this many attempts so it stops
# redelivering forever and becomes visible for inspection.
MAX_FIRE_ATTEMPTS = 5


async def _initialize_uninitialized_schedules(conn, now: datetime) -> None:
    """Self-heal: migration-seeded (or hand-inserted) cron goals arrive with
    NULL schedule_next_at, which the due-query skips forever. Give them a first
    fire time so seeding a goal is enough to schedule it.
    """
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


async def enqueue_due_fires() -> int:
    """Record a durable fire + advance the clock for each due scheduled goal.

    Returns the number of fires newly enqueued. Each goal is handled in its own
    transaction: the outbox INSERT and the goals UPDATE commit together or not
    at all, so the clock never advances past a fire that wasn't persisted.
    """
    pool = get_pool()
    now = datetime.now(timezone.utc)
    enqueued = 0

    async with pool.acquire() as conn:
        await _initialize_uninitialized_schedules(conn, now)

        # Candidate ids without a lock; each is re-checked under FOR UPDATE below.
        candidates = await conn.fetch(
            """
            SELECT id
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

        for cand in candidates:
            async with conn.transaction():
                # Lock the row and re-check the due condition. SKIP LOCKED means
                # a second cortex replica can't double-fire the same goal.
                goal = await conn.fetchrow(
                    """
                    SELECT id, title, priority, schedule_cron, schedule_next_at,
                           max_completions, completion_count
                    FROM goals
                    WHERE id = $1
                      AND status = 'active'
                      AND schedule_cron IS NOT NULL
                      AND schedule_next_at IS NOT NULL
                      AND schedule_next_at <= $2
                      AND (max_completions IS NULL OR completion_count < max_completions)
                    FOR UPDATE SKIP LOCKED
                    """,
                    cand["id"], now,
                )
                if goal is None:
                    continue  # taken by another worker, or no longer due

                goal_id = str(goal["id"])
                fire_at = goal["schedule_next_at"]  # the instant that came due
                cron_expr = goal["schedule_cron"]

                # Compute the NEXT fire time from now (not from fire_at) so a
                # cortex that was down for a while fires once and catches up,
                # rather than replaying every missed interval.
                try:
                    next_at = croniter(cron_expr, now).get_next(datetime)
                except (ValueError, KeyError):
                    log.warning("Invalid cron for goal %s: %s — skipping", goal_id, cron_expr)
                    continue

                # Durable fire. Idempotent on (goal_id, fire_at): if this exact
                # scheduled instant was already enqueued, don't duplicate it.
                ins = await conn.execute(
                    """
                    INSERT INTO goal_fire_outbox (goal_id, title, priority, fire_at)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (goal_id, fire_at) DO NOTHING
                    """,
                    goal["id"], goal["title"], goal["priority"], fire_at,
                )

                new_count = goal["completion_count"] + 1
                await conn.execute(
                    """
                    UPDATE goals
                    SET schedule_next_at = $1,
                        schedule_last_ran_at = $2,
                        completion_count = $3,
                        updated_at = NOW()
                    WHERE id = $4
                    """,
                    next_at, now, new_count, goal["id"],
                )

                # Auto-complete one-shot goals once they hit their cap.
                if goal["max_completions"] is not None and new_count >= goal["max_completions"]:
                    await conn.execute(
                        "UPDATE goals SET status = 'completed', updated_at = NOW() WHERE id = $1",
                        goal["id"],
                    )
                    log.info("Goal %s completed (max_completions=%d reached)",
                             goal_id, goal["max_completions"])

                if ins.endswith(" 1"):  # a row was actually inserted (not ON CONFLICT skip)
                    enqueued += 1
                    log.info("Enqueued fire for goal %s (%s), fire_at=%s, next_at=%s",
                             goal_id, goal["title"], fire_at, next_at)

    return enqueued


async def drain_outbox(limit: int = 10) -> tuple[list[dict], list[str]]:
    """Return (stimuli, outbox_ids) for up to `limit` pending fires.

    Does NOT mark fires done — the caller acks via ack_fires() only after the
    cycle has processed them. Increments attempts; fires that exceed
    MAX_FIRE_ATTEMPTS are parked as 'failed' rather than redelivered forever.
    """
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Park poison fires (processed-but-never-acked past the cap).
            await conn.execute(
                "UPDATE goal_fire_outbox SET status = 'failed' "
                "WHERE status = 'pending' AND attempts >= $1",
                MAX_FIRE_ATTEMPTS,
            )
            rows = await conn.fetch(
                """
                SELECT id, goal_id, title, priority
                FROM goal_fire_outbox
                WHERE status = 'pending'
                ORDER BY fire_at
                LIMIT $1
                FOR UPDATE SKIP LOCKED
                """,
                limit,
            )
            ids = [str(r["id"]) for r in rows]
            if ids:
                await conn.execute(
                    "UPDATE goal_fire_outbox SET attempts = attempts + 1 "
                    "WHERE id = ANY($1::uuid[])",
                    ids,
                )

    stimuli = [
        {
            "type": GOAL_SCHEDULE_DUE,
            "source": "cortex",
            "payload": {
                "goal_id": str(r["goal_id"]),
                "title": r["title"],
                "outbox_id": str(r["id"]),
            },
            "priority": r["priority"],
        }
        for r in rows
    ]
    return stimuli, ids


async def ack_fires(ids: list[str]) -> None:
    """Mark fires 'done' after the cycle successfully processed them."""
    if not ids:
        return
    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE goal_fire_outbox SET status = 'done', dispatched_at = NOW() "
            "WHERE id = ANY($1::uuid[])",
            ids,
        )
