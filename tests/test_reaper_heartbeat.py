"""Reaper liveness check — the Redis heartbeat is authoritative.

tasks.last_heartbeat_at is only touched once at pipeline start; the live
30-second heartbeat is a Redis key (queue.write_heartbeat). The reaper's DB
query therefore only NOMINATES candidates — before force-failing it must
consult the Redis key, or every healthy stage running past
task_stale_seconds (~150s, routine on CPU-local models) gets killed
mid-flight. Verified live 2026-07-13: a context stage with a
refreshing Redis TTL was reaped at ~150s by the DB-only check.

Real Postgres rows (nova-test- prefixed, torn down); the Redis liveness
probe and the fail/dead-letter sinks are monkeypatched seams.

Orchestrator's `app.*` is imported in isolation (see tests/_service_app.py).
"""
from __future__ import annotations

import os
import uuid

import asyncpg
import pytest_asyncio
from _service_app import service_app

PG_DSN = os.getenv(
    "NOVA_PG_DSN",
    f"postgresql://nova:{os.getenv('POSTGRES_PASSWORD', 'nova_dev_password')}@localhost:5432/nova",
)


@pytest_asyncio.fixture
async def reaper_env(monkeypatch):
    """Orchestrator reaper with a real DB pool and instrumented seams."""
    with service_app("orchestrator") as import_module:
        app_db = import_module("app.db")
        queue = import_module("app.queue")
        state_machine = import_module("app.pipeline.state_machine")
        reaper = import_module("app.reaper")

        pool = await asyncpg.create_pool(PG_DSN, min_size=1, max_size=2)
        saved_pool = app_db._pool
        app_db._pool = pool

        calls = {"failed": [], "dead_letter": [], "alive": None, "raise": False}

        async def fake_is_alive(task_id: str) -> bool:
            if calls["raise"]:
                raise ConnectionError("redis down")
            return bool(calls["alive"])

        async def fake_force_fail(task_id: str, reason: str) -> bool:
            calls["failed"].append((task_id, reason))
            return True

        async def fake_dead_letter(task_id: str, reason: str = "") -> None:
            calls["dead_letter"].append(task_id)

        async def fake_audit(conn, *a, **kw):
            return None

        monkeypatch.setattr(queue, "is_heartbeat_alive", fake_is_alive)
        monkeypatch.setattr(queue, "move_to_dead_letter", fake_dead_letter)
        monkeypatch.setattr(state_machine, "force_fail_task", fake_force_fail)
        monkeypatch.setattr(reaper, "_audit", fake_audit)

        task_id = uuid.uuid4()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO tasks (id, user_input, status, retry_count, max_retries,
                                   last_heartbeat_at)
                VALUES ($1, 'nova-test-reaper-liveness', 'context_running', 0, 2,
                        now() - interval '10 minutes')
                """,
                task_id,
            )

        try:
            yield reaper, pool, str(task_id), calls
        finally:
            async with pool.acquire() as conn:
                await conn.execute(
                    "DELETE FROM tasks WHERE user_input LIKE 'nova-test-reaper-%'"
                )
            await pool.close()
            app_db._pool = saved_pool


async def test_live_redis_heartbeat_blocks_the_reap(reaper_env):
    reaper, pool, task_id, calls = reaper_env
    calls["alive"] = True

    await reaper._reap_stale_running_tasks()

    assert calls["failed"] == []
    assert calls["dead_letter"] == []
    # The DB timestamp self-heals so the row stops being a candidate.
    async with pool.acquire() as conn:
        age = await conn.fetchval(
            "SELECT extract(epoch FROM now() - last_heartbeat_at) FROM tasks WHERE id = $1::uuid",
            task_id,
        )
    assert age < 60


async def test_dead_heartbeat_is_reaped(reaper_env):
    reaper, pool, task_id, calls = reaper_env
    calls["alive"] = False

    await reaper._reap_stale_running_tasks()

    assert [t for t, _ in calls["failed"]] == [task_id]
    assert calls["dead_letter"] == [task_id]
    assert "heartbeat expired" in calls["failed"][0][1]


async def test_redis_outage_falls_back_to_db_signal(reaper_env):
    # When Redis is unreachable the heartbeat writer can't write either —
    # the stale DB column is the only signal left, so the reap proceeds.
    reaper, pool, task_id, calls = reaper_env
    calls["raise"] = True

    await reaper._reap_stale_running_tasks()

    assert [t for t, _ in calls["failed"]] == [task_id]
