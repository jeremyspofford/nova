import time
from unittest.mock import AsyncMock, MagicMock

import pytest
from app.scheduler import guards
from app.scheduler.results import post_schedule_result


def make_pool(config: dict[str, str], nova_dispatches: int = 0):
    pool = MagicMock()

    async def fetchval(query, *args):
        if "app_config" in query:
            return config.get(args[0])
        if "count(*)" in query:
            return nova_dispatches
        return None

    pool.fetchval = AsyncMock(side_effect=fetchval)
    pool.execute = AsyncMock(return_value="INSERT 0 1")
    return pool


def set_tools_cache(value):
    """Pin the capability check result without HTTP."""
    guards._caps_cache = (time.monotonic(), value)


@pytest.fixture(autouse=True)
def reset_caps_cache():
    guards._caps_cache = None
    yield
    guards._caps_cache = None


@pytest.mark.asyncio
async def test_kill_switch_blocks():
    pool = make_pool({"proactivity.enabled": "false"})
    allowed, reason = await guards.check_nova_dispatch(pool)
    assert allowed is False
    assert "kill switch" in reason


@pytest.mark.asyncio
async def test_budget_exhausted_blocks():
    set_tools_cache(True)
    pool = make_pool({"proactivity.daily_task_budget": "3"}, nova_dispatches=3)
    allowed, reason = await guards.check_nova_dispatch(pool)
    assert allowed is False
    assert "budget" in reason


@pytest.mark.asyncio
async def test_no_tools_model_blocks():
    set_tools_cache(False)
    pool = make_pool({})
    allowed, reason = await guards.check_nova_dispatch(pool)
    assert allowed is False
    assert "tool calling" in reason


@pytest.mark.asyncio
async def test_unknown_tools_is_allowed():
    set_tools_cache(None)
    pool = make_pool({})
    allowed, reason = await guards.check_nova_dispatch(pool)
    assert allowed is True
    assert reason is None


@pytest.mark.asyncio
async def test_all_green_dispatches():
    set_tools_cache(True)
    pool = make_pool({"proactivity.enabled": "true"}, nova_dispatches=1)
    allowed, reason = await guards.check_nova_dispatch(pool)
    assert allowed is True
    assert reason is None


@pytest.mark.asyncio
async def test_invalid_budget_falls_back_to_default():
    set_tools_cache(True)
    pool = make_pool({"proactivity.daily_task_budget": "lots"}, nova_dispatches=11)
    allowed, _ = await guards.check_nova_dispatch(pool)
    assert allowed is True  # 11 < default 12


@pytest.mark.asyncio
async def test_block_note_posts_once_per_transition(monkeypatch):
    posts = []

    async def fake_post(pool, task_id, schedule_id, status, text):
        posts.append(text)

    monkeypatch.setattr("app.scheduler.results.post_schedule_result", fake_post)

    config: dict[str, str] = {}
    pool = make_pool(config)

    async def execute(query, *args):
        if "app_config" in query:
            config[args[0]] = args[1]
        return "INSERT 0 1"

    pool.execute = AsyncMock(side_effect=execute)

    await guards.note_block_state(pool, "sched-1", "daily task budget reached (12/12)")
    await guards.note_block_state(pool, "sched-1", "daily task budget reached (12/12)")
    assert len(posts) == 1
    assert "paused" in posts[0]

    # Clearing the block resets state silently; a new block posts again.
    await guards.note_block_state(pool, "sched-1", None)
    assert len(posts) == 1
    await guards.note_block_state(pool, "sched-1", "proactivity is disabled (kill switch)")
    assert len(posts) == 2


@pytest.mark.asyncio
async def test_nothing_result_is_not_posted():
    pool = MagicMock()
    conn = MagicMock()
    conn.fetchrow = AsyncMock(return_value={"name": "pulse", "conversation_task_id": None})
    conn.execute = AsyncMock()
    acq = MagicMock()
    acq.__aenter__ = AsyncMock(return_value=conn)
    acq.__aexit__ = AsyncMock(return_value=False)
    pool.acquire = MagicMock(return_value=acq)

    await post_schedule_result(pool, "task-1", "sched-1", "completed", "NOTHING")
    await post_schedule_result(pool, "task-2", "sched-1", "completed", "  NOTHING\n")
    # Small local models don't match the exact token reliably (observed live).
    await post_schedule_result(pool, "task-3", "sched-1", "completed", "Nothing.")
    await post_schedule_result(pool, "task-4", "sched-1", "completed", "nothing")

    conn.execute.assert_not_awaited()

    # A failed run that happens to say NOTHING still posts (failures are never quiet).
    await post_schedule_result(pool, "task-5", "sched-1", "failed", "NOTHING")
    assert conn.execute.await_count > 0
