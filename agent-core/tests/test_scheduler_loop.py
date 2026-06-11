from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from app.scheduler.loop import _poll_once, fire_task_complete_schedules


def make_pool_conn(fetch_rows=None):
    pool = MagicMock()
    conn = MagicMock()
    conn.fetch = AsyncMock(return_value=fetch_rows or [])
    conn.fetchval = AsyncMock(return_value=None)
    conn.fetchrow = AsyncMock(return_value=None)
    conn.execute = AsyncMock(return_value="UPDATE 1")
    tx = MagicMock()
    tx.__aenter__ = AsyncMock(return_value=tx)
    tx.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)
    acq = MagicMock()
    acq.__aenter__ = AsyncMock(return_value=conn)
    acq.__aexit__ = AsyncMock(return_value=False)
    pool.acquire = MagicMock(return_value=acq)
    pool.fetchrow = AsyncMock(return_value=None)
    pool.fetch = AsyncMock(return_value=[])
    return pool, conn


@pytest.mark.asyncio
async def test_poll_dispatches_due_interval_schedule():
    dispatched = []

    async def dispatch_fn(prompt, source, schedule_id):
        dispatched.append(schedule_id)
        return "task-001"

    schedule = {
        "id": "sched-001",
        "name": "test",
        "prompt": "check things",
        "trigger": {"type": "interval", "every_seconds": 3600},
        "enabled": True,
        "created_by": "user",
        "last_fired": None,
        "next_fire": datetime.now(timezone.utc) - timedelta(seconds=60),
    }
    pool, conn = make_pool_conn(fetch_rows=[schedule])
    conn.fetchrow = AsyncMock(return_value=schedule)
    conn.fetchval = AsyncMock(return_value=None)

    await _poll_once(pool, dispatch_fn)
    assert "sched-001" in dispatched


@pytest.mark.asyncio
async def test_poll_skips_when_previous_run_active():
    dispatched = []

    async def dispatch_fn(prompt, source, schedule_id):
        dispatched.append(schedule_id)
        return "task-002"

    schedule = {
        "id": "sched-002",
        "name": "slow job",
        "prompt": "heavy task",
        "trigger": {"type": "cron", "expr": "0 * * * *"},
        "enabled": True,
        "created_by": "user",
        "next_fire": datetime.now(timezone.utc) - timedelta(seconds=10),
    }
    pool, conn = make_pool_conn(fetch_rows=[schedule])
    conn.fetchrow = AsyncMock(return_value=schedule)
    conn.fetchval = AsyncMock(return_value="existing-running-task-id")

    await _poll_once(pool, dispatch_fn)
    assert dispatched == []


@pytest.mark.asyncio
async def test_once_schedule_sets_enabled_false():
    execute_calls = []

    async def dispatch_fn(prompt, source, schedule_id):
        return "task-003"

    schedule = {
        "id": "sched-003",
        "name": "one-shot",
        "prompt": "one time",
        "trigger": {"type": "once", "at": (datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat()},
        "enabled": True,
        "created_by": "user",
        "next_fire": datetime.now(timezone.utc) - timedelta(seconds=5),
    }
    pool, conn = make_pool_conn(fetch_rows=[schedule])
    conn.fetchrow = AsyncMock(return_value=schedule)
    conn.fetchval = AsyncMock(return_value=None)

    async def capture_execute(query, *args):
        execute_calls.append(args)
        return "UPDATE 1"
    conn.execute = capture_execute

    await _poll_once(pool, dispatch_fn)
    any_disabled = any(False in list(args) for args in execute_calls)
    assert any_disabled


@pytest.mark.asyncio
async def test_fire_task_complete_schedules_dispatches_dependent():
    dispatched = []

    async def dispatch_fn(prompt, source, schedule_id):
        dispatched.append({"schedule_id": schedule_id, "prompt": prompt})
        return "task-004"

    schedule = {
        "id": "chain-sched-001",
        "prompt": "follow up on {completed_task_id}",
        "trigger": {"type": "task_complete", "task_id": "upstream-001", "on_status": ["completed"]},
    }
    pool = MagicMock()
    pool.fetch = AsyncMock(return_value=[schedule])

    await fire_task_complete_schedules(pool, "upstream-001", "completed", dispatch_fn)

    assert len(dispatched) == 1
    assert "upstream-001" in dispatched[0]["prompt"]
