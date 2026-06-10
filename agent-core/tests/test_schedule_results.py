import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from app.scheduler.results import post_schedule_result, record_fire


def make_pool_conn():
    pool = MagicMock()
    conn = MagicMock()
    conn.fetch = AsyncMock(return_value=[])
    conn.fetchval = AsyncMock(return_value=None)
    conn.fetchrow = AsyncMock(return_value=None)
    conn.execute = AsyncMock(return_value="UPDATE 1")
    acq = MagicMock()
    acq.__aenter__ = AsyncMock(return_value=conn)
    acq.__aexit__ = AsyncMock(return_value=False)
    pool.acquire = MagicMock(return_value=acq)
    pool.execute = AsyncMock(return_value="UPDATE 1")
    return pool, conn


def executed_sql(conn) -> list[str]:
    return [call.args[0] for call in conn.execute.await_args_list]


@pytest.mark.asyncio
async def test_creates_thread_and_posts_result_on_first_run():
    pool, conn = make_pool_conn()
    conn.fetchrow = AsyncMock(return_value={"name": "morning digest", "conversation_task_id": None})

    await post_schedule_result(pool, "task-1", "sched-1", "completed", "Here is your digest.")

    sql = executed_sql(conn)
    assert any("INSERT INTO tasks" in s for s in sql), "should create the thread task"
    assert any("UPDATE schedules SET conversation_task_id" in s for s in sql)
    assert any("INSERT INTO task_messages" in s for s in sql)
    msg_call = next(c for c in conn.execute.await_args_list if "task_messages" in c.args[0])
    assert msg_call.args[2] == "Here is your digest."


@pytest.mark.asyncio
async def test_reuses_existing_thread():
    pool, conn = make_pool_conn()
    thread_id = uuid.uuid4()
    conn.fetchrow = AsyncMock(return_value={"name": "digest", "conversation_task_id": thread_id})
    conn.fetchval = AsyncMock(return_value=1)  # thread task still exists

    await post_schedule_result(pool, "task-2", "sched-1", "completed", "Second run.")

    sql = executed_sql(conn)
    assert not any("INSERT INTO tasks" in s for s in sql), "must not create a second thread"
    msg_call = next(c for c in conn.execute.await_args_list if "task_messages" in c.args[0])
    assert msg_call.args[1] == thread_id


@pytest.mark.asyncio
async def test_recreates_thread_when_conversation_was_deleted():
    pool, conn = make_pool_conn()
    conn.fetchrow = AsyncMock(return_value={"name": "digest", "conversation_task_id": uuid.uuid4()})
    conn.fetchval = AsyncMock(return_value=None)  # dangling — conversation deleted

    await post_schedule_result(pool, "task-3", "sched-1", "completed", "After delete.")

    sql = executed_sql(conn)
    assert any("INSERT INTO tasks" in s for s in sql), "should lazily recreate the thread"
    assert any("INSERT INTO task_messages" in s for s in sql)


@pytest.mark.asyncio
async def test_failed_run_posts_failure_note():
    pool, conn = make_pool_conn()
    conn.fetchrow = AsyncMock(return_value={"name": "digest", "conversation_task_id": None})

    await post_schedule_result(pool, "task-4", "sched-1", "failed", "boom")

    msg_call = next(c for c in conn.execute.await_args_list if "task_messages" in c.args[0])
    assert msg_call.args[2] == "Scheduled run failed: boom"


@pytest.mark.asyncio
async def test_empty_result_gets_placeholder():
    pool, conn = make_pool_conn()
    conn.fetchrow = AsyncMock(return_value={"name": "digest", "conversation_task_id": None})

    await post_schedule_result(pool, "task-5", "sched-1", "completed", "")

    msg_call = next(c for c in conn.execute.await_args_list if "task_messages" in c.args[0])
    assert msg_call.args[2] == "(run completed with no output)"


@pytest.mark.asyncio
async def test_unknown_schedule_is_noop():
    pool, conn = make_pool_conn()
    conn.fetchrow = AsyncMock(return_value=None)

    await post_schedule_result(pool, "task-6", "sched-gone", "completed", "result")

    assert conn.execute.await_args_list == []


@pytest.mark.asyncio
async def test_db_error_never_raises():
    pool, conn = make_pool_conn()
    conn.fetchrow = AsyncMock(side_effect=RuntimeError("db down"))

    await post_schedule_result(pool, "task-7", "sched-1", "completed", "result")


@pytest.mark.asyncio
async def test_record_fire_bumps_counters():
    pool, _ = make_pool_conn()

    await record_fire(pool, "sched-1")

    sql = pool.execute.await_args_list[0].args[0]
    assert "fire_count = fire_count + 1" in sql
    assert "last_fired = now()" in sql


@pytest.mark.asyncio
async def test_record_fire_never_raises():
    pool, _ = make_pool_conn()
    pool.execute = AsyncMock(side_effect=RuntimeError("db down"))

    await record_fire(pool, "sched-1")
