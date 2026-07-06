"""Learning from failures: cortex reflections actually accumulate.

The reflection loop (record on task outcome → inject into the next PLAN)
existed but was starved for months: the jsonb current_plan corruption
crashed _update_goal_progress, and reflection recording shared its try
block, so cortex_reflections stayed empty. Separately, manual "run now"
triggers never registered with the task monitor, so operator-triggered
runs taught Nova nothing.

These tests pin the resurrected loop:
  - a manually triggered goal run produces a cortex_reflections row for
    that exact task once the pipeline finishes (requires an LLM)
  - the reflections table is queryable per-goal (read side of PLAN)
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

CORTEX = "http://localhost:8100"
BRIEFING_GOAL_TITLE = "Morning briefing"


@pytest.mark.asyncio
@pytest.mark.requires_llm
@pytest.mark.timeout(170)
async def test_manual_trigger_records_reflection(pool, admin_headers):
    """Manual trigger → task terminal → reflection row for that task."""
    async with pool.acquire() as conn:
        goal_id = await conn.fetchval(
            "SELECT id FROM goals WHERE title = $1 AND status = 'active'",
            BRIEFING_GOAL_TITLE,
        )
    assert goal_id, "seeded briefing goal missing"

    async with httpx.AsyncClient(timeout=15) as c:
        resp = await c.post(
            f"{CORTEX}/api/v1/cortex/trigger/{goal_id}", headers=admin_headers,
        )
    assert resp.status_code == 200, resp.text
    task_id = resp.json()["task_id"]

    # Pipeline run + one cortex TRACK cycle (30s cadence) to collect it.
    for _ in range(28):
        await asyncio.sleep(5)
        async with pool.acquire() as conn:
            n = await conn.fetchval(
                "SELECT COUNT(*) FROM cortex_reflections WHERE task_id = $1::uuid",
                task_id,
            )
        if n:
            break
    else:
        pytest.fail(
            f"no reflection recorded for manually triggered task {task_id} "
            "— TRACK is not learning from this run"
        )

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT outcome, approach, goal_id FROM cortex_reflections "
            "WHERE task_id = $1::uuid",
            task_id,
        )
    assert str(row["goal_id"]) == str(goal_id)
    assert row["outcome"] in ("success", "partial", "failure", "timeout")
    assert row["approach"], "reflection must capture the attempted approach"


@pytest.mark.asyncio
async def test_reflections_queryable_per_goal(pool):
    """Read side of PLAN: per-goal reflection history is retrievable."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT r.outcome, r.approach FROM cortex_reflections r "
            "JOIN goals g ON g.id = r.goal_id WHERE g.title = $1 "
            "ORDER BY r.created_at DESC LIMIT 5",
            BRIEFING_GOAL_TITLE,
        )
    assert rows, (
        "no reflections exist for the briefing goal — the learning loop "
        "is starved again (check _update_goal_progress / task_monitor)"
    )
