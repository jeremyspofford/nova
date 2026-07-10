"""Transactional outbox for scheduled-goal fires (migration 104).

Exercises the REAL cortex.app.scheduler (enqueue_due_fires / drain_outbox /
ack_fires) against the REAL running Postgres — no mocks. The outbox closes the
cron fire-and-lose window: the old check_schedules() advanced schedule_next_at
BEFORE the work was durable, so a crash between "advance the clock" and
"dispatch the work" silently dropped a scheduled run. Now the clock advances
and a durable fire is recorded in ONE transaction, and a fire is only acked
after a non-error cycle — at-least-once delivery.

Cortex's `app.*` is imported in isolation (tests/_service_app.py) so this
coexists with orchestrator-app tests in the same pytest session.

Run:
    cd tests && uv run --with-requirements requirements.txt pytest test_goal_fire_outbox.py -v

Requires Postgres up. No LLM needed.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import asyncpg
import pytest
import pytest_asyncio
from _service_app import service_app

PG_DSN = os.getenv(
    "NOVA_PG_DSN",
    f"postgresql://nova:{os.getenv('POSTGRES_PASSWORD', 'nova_dev_password')}@localhost:5432/nova",
)

TEST_PREFIX = "nova-test-outbox"


@pytest_asyncio.fixture
async def cortex():
    """Cortex app.scheduler loaded in isolation, app.db pointed at localhost."""
    with service_app("cortex") as import_module:
        app_db = import_module("app.db")
        scheduler = import_module("app.scheduler")

        pool = await asyncpg.create_pool(PG_DSN, min_size=1, max_size=2)
        saved_pool = app_db._pool
        app_db._pool = pool
        await _cleanup(pool)

        ns = SimpleNamespace(
            db=app_db,
            enqueue_due_fires=scheduler.enqueue_due_fires,
            drain_outbox=scheduler.drain_outbox,
            ack_fires=scheduler.ack_fires,
            MAX_FIRE_ATTEMPTS=scheduler.MAX_FIRE_ATTEMPTS,
            pool=pool,
        )
        try:
            yield ns
        finally:
            await _cleanup(pool)
            app_db._pool = saved_pool
            await pool.close()


async def _cleanup(pool) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM goal_fire_outbox WHERE goal_id IN "
            "(SELECT id FROM goals WHERE title LIKE $1)",
            f"{TEST_PREFIX}%",
        )
        await conn.execute("DELETE FROM goals WHERE title LIKE $1", f"{TEST_PREFIX}%")


async def _make_due_goal(
    pool, *, cron: str = "*/5 * * * *", max_completions=None, due_seconds_ago: int = 30,
) -> str:
    """Insert an active scheduled goal already due (schedule_next_at in the past)."""
    goal_id = uuid.uuid4()
    due_at = datetime.now(timezone.utc) - timedelta(seconds=due_seconds_ago)
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO goals (id, title, description, status, priority,
                               schedule_cron, schedule_next_at, max_completions, completion_count)
            VALUES ($1, $2, 'outbox test goal', 'active', 5, $3, $4, $5, 0)
            """,
            goal_id, f"{TEST_PREFIX}-{goal_id}", cron, due_at, max_completions,
        )
    return str(goal_id)


async def _outbox_rows(pool, goal_id: str) -> list[dict]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT status, attempts, fire_at FROM goal_fire_outbox WHERE goal_id = $1::uuid ORDER BY created_at",
            goal_id,
        )
    return [dict(r) for r in rows]


async def _goal(pool, goal_id: str) -> dict:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status, schedule_next_at, completion_count FROM goals WHERE id = $1::uuid",
            goal_id,
        )
    return dict(row)


# ── Enqueue records a durable fire AND advances the clock ────────────────────

@pytest.mark.asyncio
async def test_enqueue_records_fire_and_advances_clock(cortex):
    goal_id = await _make_due_goal(cortex.pool)
    before = await _goal(cortex.pool, goal_id)

    count = await cortex.enqueue_due_fires()

    assert count >= 1
    rows = await _outbox_rows(cortex.pool, goal_id)
    assert len(rows) == 1, "one durable fire recorded"
    assert rows[0]["status"] == "pending"

    after = await _goal(cortex.pool, goal_id)
    assert after["schedule_next_at"] > before["schedule_next_at"], "clock advanced past the due instant"
    assert after["completion_count"] == 1


# ── The scheduled instant is durable BEFORE any dispatch happens ─────────────
# This is the crash-safety property: enqueue commits the fire, so a crash right
# after (before drain/dispatch) still leaves the fire recoverable.

@pytest.mark.asyncio
async def test_fire_survives_without_drain(cortex):
    goal_id = await _make_due_goal(cortex.pool)
    await cortex.enqueue_due_fires()

    # Simulate "crash before drain": we never drain/ack. The fire is still there.
    rows = await _outbox_rows(cortex.pool, goal_id)
    assert len(rows) == 1 and rows[0]["status"] == "pending", "fire persists for recovery"


# ── Enqueue is idempotent for the same due instant (no duplicate fires) ──────

@pytest.mark.asyncio
async def test_enqueue_idempotent_for_same_instant(cortex):
    goal_id = await _make_due_goal(cortex.pool)
    await cortex.enqueue_due_fires()

    # Force the goal due again at the SAME instant it originally fired.
    async with cortex.pool.acquire() as conn:
        orig_fire_at = (await _outbox_rows(cortex.pool, goal_id))[0]["fire_at"]
        await conn.execute(
            "UPDATE goals SET schedule_next_at = $1 WHERE id = $2::uuid",
            orig_fire_at, goal_id,
        )
    await cortex.enqueue_due_fires()

    rows = await _outbox_rows(cortex.pool, goal_id)
    assert len(rows) == 1, "UNIQUE (goal_id, fire_at) prevents a duplicate fire for the same instant"


# ── Drain surfaces stimuli but does NOT ack; ack marks done ──────────────────

@pytest.mark.asyncio
async def test_drain_then_ack_lifecycle(cortex):
    goal_id = await _make_due_goal(cortex.pool)
    await cortex.enqueue_due_fires()

    stimuli, ids = await cortex.drain_outbox(limit=10)

    mine = [s for s in stimuli if s["payload"]["goal_id"] == goal_id]
    assert len(mine) == 1, "drain surfaces the fire as a stimulus"
    assert mine[0]["type"] == "goal.schedule_due"
    assert mine[0]["payload"]["title"].startswith(TEST_PREFIX)

    # Not acked yet — still pending, attempts incremented.
    rows = await _outbox_rows(cortex.pool, goal_id)
    assert rows[0]["status"] == "pending"
    assert rows[0]["attempts"] == 1

    await cortex.ack_fires(ids)
    rows = await _outbox_rows(cortex.pool, goal_id)
    assert rows[0]["status"] == "done", "ack marks the fire delivered"


# ── At-least-once: an un-acked fire is redelivered on the next drain ─────────

@pytest.mark.asyncio
async def test_unacked_fire_is_redelivered(cortex):
    goal_id = await _make_due_goal(cortex.pool)
    await cortex.enqueue_due_fires()

    # First drain (simulate a cycle that crashed before ack).
    stimuli1, _ids1 = await cortex.drain_outbox(limit=10)
    assert any(s["payload"]["goal_id"] == goal_id for s in stimuli1)

    # Next drain redelivers the same still-pending fire.
    stimuli2, ids2 = await cortex.drain_outbox(limit=10)
    assert any(s["payload"]["goal_id"] == goal_id for s in stimuli2), "un-acked fire redelivers"

    rows = await _outbox_rows(cortex.pool, goal_id)
    assert rows[0]["attempts"] == 2, "each delivery attempt is counted"

    await cortex.ack_fires(ids2)
    stimuli3, _ids3 = await cortex.drain_outbox(limit=10)
    assert not any(s["payload"]["goal_id"] == goal_id for s in stimuli3), "acked fire is not redelivered"


# ── Poison fires (never acked past the cap) are parked, not redelivered forever

@pytest.mark.asyncio
async def test_poison_fire_parked_after_max_attempts(cortex):
    goal_id = await _make_due_goal(cortex.pool)
    await cortex.enqueue_due_fires()

    # Drain repeatedly without ever acking (a fire that crashes the cycle).
    for _ in range(cortex.MAX_FIRE_ATTEMPTS + 2):
        await cortex.drain_outbox(limit=10)

    rows = await _outbox_rows(cortex.pool, goal_id)
    assert rows[0]["status"] == "failed", "a fire past MAX_FIRE_ATTEMPTS is parked as failed"

    stimuli, _ids = await cortex.drain_outbox(limit=10)
    assert not any(s["payload"]["goal_id"] == goal_id for s in stimuli), "parked fire stops redelivering"


# ── One-shot goals (max_completions=1) auto-complete on fire ─────────────────

@pytest.mark.asyncio
async def test_one_shot_goal_auto_completes(cortex):
    goal_id = await _make_due_goal(cortex.pool, max_completions=1)
    await cortex.enqueue_due_fires()

    goal = await _goal(cortex.pool, goal_id)
    assert goal["status"] == "completed", "a one-shot goal completes once its single fire is enqueued"
    assert goal["completion_count"] == 1
    # The fire is still durably recorded and will be delivered.
    rows = await _outbox_rows(cortex.pool, goal_id)
    assert len(rows) == 1
