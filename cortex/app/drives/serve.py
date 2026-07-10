"""Serve drive — pursue user-set goals.

Urgency is based on:
- Number of active goals
- Whether any goals have pending tasks or need new work
- Time since last check
- Stimulus events (message received, goal created, schedule due)
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from ..db import get_pool
from . import DriveContext, DriveResult

log = logging.getLogger(__name__)


async def _record_fire_skips(goal_ids: list[str]) -> None:
    """Make consumed-but-filtered schedule fires visible (audit bug 3).

    The scheduler consumes a goal.schedule_due fire when it emits the
    stimulus; if the dispatch filters below drop the goal, that scheduled run
    is gone. The drop is often correct (review gate, caps) — but silently
    losing a cron fire looks identical to the scheduler being broken, so the
    reason is logged, written to the goal's journal, and stamped onto
    current_plan.last_fire_skip for the goal card.
    """
    from ..journal import emit_journal

    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, title, status, maturation_status, iteration,
                      max_iterations, cost_so_far_usd, max_cost_usd
               FROM goals WHERE id = ANY($1::uuid[])""",
            goal_ids,
        )
        by_id = {str(r["id"]): r for r in rows}
        for gid in goal_ids:
            r = by_id.get(gid)
            if r is None:
                reason = "goal no longer exists"
            elif r["status"] != "active":
                reason = f"goal status is '{r['status']}'"
            elif r["maturation_status"] == "review":
                reason = "maturation 'review' — waiting for human input"
            elif r["max_iterations"] is not None and (r["iteration"] or 0) >= r["max_iterations"]:
                reason = f"iteration cap reached ({r['iteration']}/{r['max_iterations']})"
            elif r["max_cost_usd"] is not None and float(r["cost_so_far_usd"] or 0) >= float(r["max_cost_usd"]):
                reason = (
                    f"cost cap reached (${float(r['cost_so_far_usd'] or 0):.2f}"
                    f"/${float(r['max_cost_usd']):.2f})"
                )
            else:
                reason = "dropped by dispatch filters (unmet dependencies)"
            log.warning(
                "Scheduled fire skipped for goal %s ('%s'): %s",
                gid, r["title"] if r else "?", reason,
            )
            if r is not None:
                await conn.execute(
                    """UPDATE goals
                       SET current_plan = jsonb_set(
                             CASE WHEN jsonb_typeof(current_plan) = 'object'
                                  THEN current_plan ELSE '{}'::jsonb END,
                             '{last_fire_skip}', $1::jsonb),
                           updated_at = NOW()
                       WHERE id = $2::uuid""",
                    {"reason": reason,
                     "at": datetime.now(timezone.utc).isoformat()},
                    gid,
                )
            await emit_journal(gid, "fire.skipped", {"reason": reason})


async def _filter_dep_blocked(goals: list[dict]) -> list[dict]:
    """Remove children whose depends_on siblings haven't completed."""
    pool = get_pool()
    out: list[dict] = []
    for g in goals:
        plan = g.get("current_plan") or {}
        if isinstance(plan, str):
            try:
                plan = json.loads(plan)
            except json.JSONDecodeError:
                plan = {}
        deps = plan.get("depends_on") if isinstance(plan, dict) else None
        if not deps or not g.get("parent_goal_id"):
            out.append(g)
            continue
        # Find sibling spawn_indices among completed/cancelled siblings
        async with pool.acquire() as conn:
            done = await conn.fetch(
                """SELECT (current_plan->>'spawn_index')::int AS idx
                   FROM goals
                   WHERE parent_goal_id = $1::uuid
                     AND status IN ('completed','cancelled')
                     AND current_plan ? 'spawn_index'""",
                g["parent_goal_id"],
            )
        done_idx = {r["idx"] for r in done if r["idx"] is not None}
        if all(d in done_idx for d in deps):
            out.append(g)
    return out


async def assess(ctx: DriveContext | None = None) -> DriveResult:
    """Assess serve drive urgency based on active goals and stimuli."""
    # Cron-due goals must enter the work set regardless of staleness: the
    # scheduler consumes the due event when it emits the stimulus, so if the
    # goal isn't picked up THIS cycle the scheduled run is silently dropped
    # until the goal goes stale (up to check_interval later).
    scheduled_goal_ids: list[str] = []
    if ctx:
        for s in ctx.stimuli_of_type("goal.schedule_due"):
            gid = (s.get("payload") or {}).get("goal_id")
            if gid:
                scheduled_goal_ids.append(gid)

    pool = get_pool()
    async with pool.acquire() as conn:
        active_count = await conn.fetchval(
            "SELECT COUNT(*) FROM goals WHERE status = 'active'"
        )

        stale_goals = await conn.fetch(
            """
            SELECT id, title, description, current_plan, priority, progress,
                   iteration, max_iterations, cost_so_far_usd, max_cost_usd,
                   check_interval_seconds, last_checked_at, maturation_status,
                   parent_goal_id
            FROM goals
            WHERE status = 'active'
              AND (
                -- Normal stale check — but cron-scheduled goals are dispatched
                -- by their schedule ALONE. Letting staleness also dispatch them
                -- double-fired every standing goal (once at ~24h staleness via
                -- the default pod, once at its cron time), burning tokens and
                -- parking review-noise from the wrong pipeline.
                ((last_checked_at IS NULL
                  OR last_checked_at < NOW() - (check_interval_seconds || ' seconds')::interval)
                 AND schedule_cron IS NULL)
                -- OR has active maturation phase (not review — that waits for human)
                OR maturation_status IN ('triaging', 'scoping', 'speccing', 'building', 'waiting', 'verifying')
                -- OR its cron schedule just fired
                OR id = ANY($1::uuid[])
              )
              AND (maturation_status IS NULL OR maturation_status != 'review')
              AND (max_iterations IS NULL OR iteration < max_iterations)
              AND (max_cost_usd IS NULL OR COALESCE(cost_so_far_usd, 0) < max_cost_usd)
            ORDER BY
                -- Schedule-due goals first — their trigger is consumed this cycle
                CASE WHEN id = ANY($1::uuid[]) THEN 0 ELSE 1 END,
                -- Then active maturation goals regardless of priority
                CASE WHEN maturation_status IN ('triaging','scoping','speccing','building','waiting','verifying')
                     THEN 0 ELSE 1 END,
                priority DESC,
                last_checked_at NULLS FIRST,
                created_at DESC
            LIMIT 10
            """,
            scheduled_goal_ids,
        )

        active_tasks = await conn.fetchval(
            """
            SELECT COUNT(*) FROM tasks t
            JOIN goals g ON t.goal_id = g.id
            WHERE g.status = 'active' AND t.status IN ('queued', 'running')
            """
        )

    # Filter dep-blocked children outside the connection scope
    stale_goals = await _filter_dep_blocked([dict(g) for g in stale_goals])

    # Fires the filters above (or the dep filter) dropped — record why.
    fire_skips: list[str] = []
    if scheduled_goal_ids:
        surviving = {str(g["id"]) for g in stale_goals}
        fire_skips = [gid for gid in scheduled_goal_ids if gid not in surviving]
        if fire_skips:
            try:
                await _record_fire_skips(fire_skips)
            except Exception as e:
                log.warning("fire-skip bookkeeping failed: %s", e)

    if active_count == 0 and (ctx is None or not ctx.stimuli_of_type(
        "message.received", "goal.created", "goal.schedule_due",
        "goal.spec_approved", "recommendation.approved"
    )):
        return DriveResult(
            name="serve", priority=1, urgency=0.0,
            description="No active goals",
        )

    # Base urgency from stale goals
    stale_ratio = len(stale_goals) / max(active_count, 1) if active_count > 0 else 0
    urgency = min(1.0, 0.2 + stale_ratio * 0.6)

    # If tasks are already in-flight, reduce urgency
    if active_tasks > 0:
        urgency *= 0.5

    # Stimulus boosts
    if ctx:
        schedule_due = ctx.stimuli_of_type("goal.schedule_due")
        if schedule_due:
            urgency = max(urgency, 0.9)

        if ctx.stimuli_of_type("message.received"):
            urgency = min(1.0, urgency + 0.3)

        if ctx.stimuli_of_type("goal.created"):
            urgency = min(1.0, urgency + 0.2)

        if ctx.stimuli_of_type("goal.spec_approved"):
            urgency = max(urgency, 0.9)

        if ctx.stimuli_of_type("recommendation.approved"):
            urgency = min(1.0, urgency + 0.3)

    goal_summaries = [
        {"id": str(g["id"]), "title": g["title"], "description": g["description"],
         "current_plan": g["current_plan"], "priority": g["priority"],
         "progress": g["progress"], "iteration": g["iteration"],
         "max_iterations": g["max_iterations"], "cost_so_far_usd": float(g["cost_so_far_usd"] or 0),
         "max_cost_usd": float(g["max_cost_usd"]) if g["max_cost_usd"] is not None else None,
         "maturation_status": g.get("maturation_status")}
        for g in stale_goals
    ]

    return DriveResult(
        name="serve",
        priority=1,
        urgency=round(urgency, 2),
        description=f"{active_count} active goals, {len(stale_goals)} need attention",
        proposed_action=f"Work on one of {len(stale_goals)} stale goals" if stale_goals else None,
        context={
            "stale_goals": goal_summaries,
            "active_tasks": active_tasks,
            "scheduled_goal_ids": scheduled_goal_ids,
            # Already recorded by _record_fire_skips — the cycle-level
            # bookkeeping excludes these to avoid double journal entries.
            "fire_skips": fire_skips,
        },
    )
