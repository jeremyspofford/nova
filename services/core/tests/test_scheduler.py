"""The tick: a due row is claimed exactly once, every firing is a traced turn,
delivery is a fact from the device's own frame, and the process's death is
visible on the row it left running."""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from app import chat, db, devices, devices_ws, scheduler, timers, traces
from app.identity import Person
from app.main import app, lifespan
from tests.conftest import TEST_DSN, requires_db
from tests.device_fakes import FakeDevice, FakeWSConn
from tests.fakes import FakeMemory, Refusal, ScriptedGateway

pytestmark = requires_db

NY = "America/New_York"
MODEL = "qwen3:8b"
# Every timer here is created for 2031 (create refuses a past once against the
# DB clock) and the tick is handed a `now` past it — the claim reads `now`, not
# the wall clock, so nothing in these tests waits.
FUTURE_ONCE = {"kind": "once", "at": "2031-06-01T09:00"}
LATER = datetime(2031, 6, 1, 14, 0, tzinfo=UTC)  # 10:00 EDT, an hour after
TURN_STATUS = "SELECT status FROM turns WHERE id = $1"


@pytest.fixture(autouse=True)
def _clean_hub():
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    scheduler.RUNNING.clear()
    yield
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    scheduler.RUNNING.clear()


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


async def _owner(pool) -> tuple[Person, uuid.UUID]:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id"
    )
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", pid
    )
    return Person(id=pid, name="jeremy", role="owner"), conversation


async def _reminder(pool, person, conversation, *, message="stretch", device=None, spec=None):
    return await timers.create(
        pool,
        person=person,
        kind="reminder",
        title=message,
        payload={"message": message, "device": device},
        spec=spec or FUTURE_ONCE,
        tz=NY,
        conversation_id=conversation,
        created_via="chat",
    )


async def _scheduled(pool, person, conversation, *, instruction="what's on my calendar file?"):
    return await timers.create(
        pool,
        person=person,
        kind="scheduled",
        title="calendar",
        payload={"instruction": instruction},
        spec={"kind": "day", "at": "07:00"},
        tz=NY,
        conversation_id=conversation,
        created_via="chat",
    )


async def _job_row(pool, handler: str, *, next_fire_at: datetime, spec=None) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO timers (kind, title, payload, schedule, timezone, next_fire_at, created_via) "
        "VALUES ('job', $1, $2::jsonb, $3::jsonb, 'UTC', $4, 'system') RETURNING id",
        handler,
        {"handler": handler},
        spec or {"kind": "minutes", "every": 5},
        next_fire_at,
    )


async def _firings(pool, timer_id):
    return await pool.fetch(
        "SELECT * FROM timer_firings WHERE timer_id = $1 ORDER BY started_at", timer_id
    )


async def _spans(pool, turn_id):
    return await pool.fetch(
        "SELECT kind, name, meta FROM turn_spans WHERE turn_id = $1 ORDER BY started_at", turn_id
    )


async def _connect(pool, *, name: str) -> tuple[uuid.UUID, FakeDevice, FakeWSConn, asyncio.Task]:
    """Enroll and drive serve() to a registered socket (test_devices_ws's shape)."""
    device = FakeDevice()
    creator = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('adult', 'adult') RETURNING id"
    )
    code = await devices.mint_pairing_code(pool, created_by=creator)
    enrolled = await devices.enroll(
        pool, code=code["code"], pubkey=device.pubkey_hex, name=name, platform="linux",
        hostname="host",
    )
    device.device_id = enrolled["device_id"]
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    ready = await asyncio.wait_for(device.handshake(conn), 2)
    assert ready["type"] == "ready"
    return uuid.UUID(enrolled["device_id"]), device, conn, task


async def _close(conn: FakeWSConn, task: asyncio.Task) -> None:
    conn.feed_close()
    await asyncio.wait_for(task, 2)


# -- reminder -----------------------------------------------------------------------


async def test_a_due_reminder_lands_in_chat_as_a_reminder_turn_and_the_once_is_finished(pool):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)

    # Not due yet: nothing is claimed, nothing is written.
    early = row["next_fire_at"] - timedelta(seconds=1)
    assert await scheduler.tick_once(app, pool, now=early) == []
    assert await pool.fetchval("SELECT count(*) FROM timer_firings") == 0

    fired = await scheduler.tick_once(app, pool, now=LATER)
    assert len(fired) == 1

    message = await pool.fetchrow(
        "SELECT role, content, turn_id FROM messages WHERE conversation_id = $1", conversation
    )
    assert (message["role"], message["content"]) == ("assistant", "Reminder: stretch")
    turn = await pool.fetchrow("SELECT * FROM turns WHERE id = $1", message["turn_id"])
    assert turn["kind"] == "reminder" and turn["status"] == "ok"
    assert turn["conversation_id"] == conversation and turn["model"] is None
    assert turn["id"] not in traces.INFLIGHT

    (firing,) = await _firings(pool, row["id"])
    assert firing["id"] == fired[0]
    assert firing["status"] == "ok" and firing["reason"] is None
    assert firing["ended_at"] is not None
    assert firing["turn_id"] == turn["id"]
    assert firing["scheduled_for"] == row["next_fire_at"]
    assert firing["delivery"] == {
        "chat": {"ok": True},
        "devices": [],
        "note": "no paired device was connected",
    }
    after = await timers.get(pool, row["id"])
    assert after["next_fire_at"] is None  # a once that fired is FINISHED, not flagged
    assert after["consecutive_failures"] == 0
    # A second tick finds nothing: NULL is never due.
    assert await scheduler.tick_once(app, pool, now=LATER + timedelta(hours=1)) == []
    assert len(await _firings(pool, row["id"])) == 1


async def test_a_reminder_notifies_every_connected_device_through_the_chats_own_tool_span(pool):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation, message="drink water")
    _did, device, conn, task = await _connect(pool, name="laptop")
    # A paired device that is NOT connected is not a target — and is not a failure.
    await devices.enroll(
        pool,
        code=(await devices.mint_pairing_code(pool, created_by=person.id))["code"],
        pubkey=FakeDevice().pubkey_hex, name="desktop", platform="linux", hostname="h",
    )
    try:
        fired, frame = await asyncio.gather(
            scheduler.tick_once(app, pool, now=LATER),
            asyncio.wait_for(device.answer_command(conn), 5),
        )
    finally:
        await _close(conn, task)

    assert frame["envelope"]["capability"] == "system.notify"
    assert frame["envelope"]["args"] == {"message": "Reminder: drink water"}
    (firing,) = await _firings(pool, row["id"])
    assert firing["status"] == "ok"
    assert firing["delivery"]["chat"] == {"ok": True}
    assert firing["delivery"]["devices"] == [{"name": "laptop", "ok": True}]
    assert "note" not in firing["delivery"]
    spans = await _spans(pool, firing["turn_id"])
    (span,) = [s for s in spans if s["kind"] == "tool"]
    assert span["name"] == "device_notify"
    assert span["meta"]["ok"] is True
    assert span["meta"]["facts"] == [{"device": "laptop", "connected": True}]
    assert span["meta"]["args_redacted"]["device"] == "laptop"


async def test_a_named_device_that_is_offline_is_a_stated_delivery_failure_not_a_firing_failure(
    pool,
):
    person, conversation = await _owner(pool)
    await devices.enroll(
        pool,
        code=(await devices.mint_pairing_code(pool, created_by=person.id))["code"],
        pubkey=FakeDevice().pubkey_hex, name="desktop", platform="linux", hostname="h",
    )
    row = await _reminder(pool, person, conversation, device="desktop")
    await scheduler.tick_once(app, pool, now=LATER)

    (firing,) = await _firings(pool, row["id"])
    assert firing["status"] == "ok"  # the chat row landed; that is what ok means
    (entry,) = firing["delivery"]["devices"]
    assert entry["name"] == "desktop" and entry["ok"] is False
    assert "not connected" in entry["reason"]
    spans = await _spans(pool, firing["turn_id"])
    (span,) = [s for s in spans if s["kind"] == "tool"]
    assert span["meta"]["ok"] is False
    assert span["meta"]["facts"] == [{"device": "desktop", "connected": False}]


async def test_a_reminder_whose_conversation_is_gone_still_reaches_the_devices_and_is_an_error(
    pool,
):
    """The reminder was for him, not for the thread: the chat leg is a stated
    failure and the firing is an error (ok means the chat row landed), but the
    connected device is still told."""
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation, message="stretch")
    _did, device, conn, task = await _connect(pool, name="laptop")
    try:
        await pool.execute("DELETE FROM conversations WHERE id = $1", conversation)
        _fired, frame = await asyncio.gather(
            scheduler.tick_once(app, pool, now=LATER),
            asyncio.wait_for(device.answer_command(conn), 5),
        )
    finally:
        await _close(conn, task)
    assert frame["envelope"]["args"] == {"message": "Reminder: stretch"}
    (firing,) = await _firings(pool, row["id"])
    assert firing["status"] == "error"
    assert "no longer exists" in firing["reason"]
    assert firing["delivery"]["chat"]["ok"] is False
    assert firing["delivery"]["devices"] == [{"name": "laptop", "ok": True}]
    assert await pool.fetchval(TURN_STATUS, firing["turn_id"]) == "error"
    assert (await timers.get(pool, row["id"]))["consecutive_failures"] == 1
    no_row = "SELECT count(*) FROM messages WHERE turn_id = $1"
    assert await pool.fetchval(no_row, firing["turn_id"]) == 0


# -- scheduled ----------------------------------------------------------------------------


async def _set_model(pool, model: str = MODEL) -> None:
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('chat.model', $1::jsonb)", model
    )


async def test_a_due_scheduled_runs_a_real_turn_with_no_user_row_and_no_ingest(
    pool, mount_peers
):
    person, conversation = await _owner(pool)
    gateway = ScriptedGateway(rounds=((text("Your calendar is empty today."),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)
    await _set_model(pool)
    row = await _scheduled(pool, person, conversation)

    fired = await scheduler.tick_once(app, pool, now=row["next_fire_at"] + timedelta(minutes=1))
    assert len(fired) == 1

    rows = await pool.fetch(
        "SELECT role, content, turn_id FROM messages WHERE conversation_id = $1", conversation
    )
    # ONE row, the assistant's — the instruction is never persisted as his words.
    assert [(r["role"], r["content"]) for r in rows] == [
        ("assistant", "Your calendar is empty today.")
    ]
    turn = await pool.fetchrow("SELECT * FROM turns WHERE id = $1", rows[0]["turn_id"])
    assert turn["kind"] == "scheduled" and turn["status"] == "ok" and turn["model"] == MODEL
    assert turn["conversation_id"] == conversation
    assert turn["id"] not in traces.INFLIGHT

    # What the model was told: the framed instruction, as the user message,
    # with an empty history before it.
    payload = gateway.payloads[0]
    user_messages = [m for m in payload["messages"] if m["role"] == "user"]
    assert len(user_messages) == 1
    framed = user_messages[0]["content"]
    assert framed.startswith("[Scheduled turn — you set this up earlier as 'calendar'")
    assert "the owner may not be watching" in framed
    assert "Local time now:" in framed
    assert framed.endswith("\n\nwhat's on my calendar file?")

    # Memory: recalled (a turn is a turn) but NOT ingested.
    await chat.drain_background()
    assert memory.ingests == []
    spans = await _spans(pool, turn["id"])
    assert {s["kind"] for s in spans} >= {"memory_recall", "llm_call"}
    assert "memory_ingest" not in {s["kind"] for s in spans}

    (firing,) = await _firings(pool, row["id"])
    assert firing["status"] == "ok" and firing["turn_id"] == turn["id"]
    assert firing["delivery"] == {"chat": {"ok": True}}
    # A daily repeat: the next fire is the next 07:00 New York after the claim.
    after = await timers.get(pool, row["id"])
    assert after["next_fire_at"] == row["next_fire_at"] + timedelta(days=1)


async def test_the_scheduled_turn_is_run_turn_called_with_ingest_false(
    pool, mount_peers, monkeypatch
):
    person, conversation = await _owner(pool)
    mount_peers(gateway=ScriptedGateway(rounds=((text("ok"),),)), memory=FakeMemory())
    await _set_model(pool)
    row = await _scheduled(pool, person, conversation)
    seen: list[dict] = []
    original = chat._run_turn

    async def spy(*args, **kwargs):
        seen.append({"args": args, "kwargs": kwargs})
        return await original(*args, **kwargs)

    monkeypatch.setattr(chat, "_run_turn", spy)
    await scheduler.tick_once(app, pool, now=row["next_fire_at"] + timedelta(minutes=1))

    (call,) = seen
    assert call["kwargs"] == {"ingest": False}
    _app, _pool, turn, who, conv, _message, history, model, _rounds, _emit = call["args"]
    assert who == person  # the timer's person, which for his timers is the owner
    assert conv == conversation and history == [] and model == MODEL
    assert turn.conversation_id == conversation


async def test_run_turn_ingests_by_default(pool, mount_peers, monkeypatch):
    """The keyword's default is True: the eval runner and chat_stream pass
    nothing to _run_turn and their turns ingest exactly as before."""
    person, conversation = await _owner(pool)
    memory = FakeMemory()
    mount_peers(gateway=ScriptedGateway(rounds=((text("hi"),),)), memory=memory)
    turn = await traces.open_turn(pool, conversation_id=conversation, model=MODEL)
    await chat._run_turn(
        app, pool, turn, person, conversation, "hello", [], MODEL, 3, lambda f: None
    )
    await chat.drain_background()
    assert [i["exchange"] for i in memory.ingests] == [{"user": "hello", "assistant": "hi"}]


async def test_a_scheduled_turn_that_errors_is_an_error_firing_with_the_turns_reason(
    pool, mount_peers
):
    person, conversation = await _owner(pool)
    mount_peers(
        gateway=ScriptedGateway(rounds=(Refusal(503, {"error": {"message": "no backend"}}),)),
        memory=FakeMemory(),
    )
    await _set_model(pool)
    row = await _scheduled(pool, person, conversation)
    await scheduler.tick_once(app, pool, now=row["next_fire_at"] + timedelta(minutes=1))
    (firing,) = await _firings(pool, row["id"])
    assert firing["status"] == "error"
    assert firing["reason"] and "no backend" in firing["reason"]
    assert await pool.fetchval(TURN_STATUS, firing["turn_id"]) == "error"
    assert firing["delivery"]["chat"]["ok"] is False
    assert (await timers.get(pool, row["id"]))["consecutive_failures"] == 1


async def test_a_scheduled_turn_with_no_model_set_is_refused_not_run(pool, mount_peers):
    person, conversation = await _owner(pool)
    gateway = ScriptedGateway(rounds=())
    mount_peers(gateway=gateway, memory=FakeMemory())
    row = await _scheduled(pool, person, conversation)
    await scheduler.tick_once(app, pool, now=row["next_fire_at"] + timedelta(minutes=1))
    (firing,) = await _firings(pool, row["id"])
    assert firing["status"] == "refused"
    assert "no chat model is set" in firing["reason"]
    assert gateway.calls == 0
    assert await pool.fetchval("SELECT count(*) FROM messages") == 0
    # Refused before _run_turn ever ran, so _run_turn never closed the turn —
    # the scheduler must, or Activity shows a scheduled turn running forever.
    assert await pool.fetchval(TURN_STATUS, firing["turn_id"]) == "error"


# -- job -------------------------------------------------------------------------------------


async def test_a_due_job_runs_its_handler_under_a_job_span(pool):
    await timers.ensure_jobs(pool)
    job = await pool.fetchrow("SELECT * FROM timers WHERE payload->>'handler' = 'retention'")
    # Something for retention to prune, so the result is a real count.
    await pool.execute(
        "INSERT INTO timer_firings (timer_id, scheduled_for, started_at, status, ended_at) "
        "VALUES ($1, now(), now() - interval '40 days', 'ok', now())",
        job["id"],
    )
    fired = await scheduler.tick_once(app, pool, now=job["next_fire_at"] + timedelta(minutes=1))
    assert len(fired) == 1
    firing = await pool.fetchrow("SELECT * FROM timer_firings WHERE id = $1", fired[0])
    assert firing["status"] == "ok"
    assert firing["delivery"] == {
        "job": {"ok": True, "result": "deleted 1 firing older than 30 days"}
    }
    turn = await pool.fetchrow("SELECT * FROM turns WHERE id = $1", firing["turn_id"])
    assert turn["kind"] == "job" and turn["status"] == "ok" and turn["conversation_id"] is None
    (span,) = await _spans(pool, turn["id"])
    assert (span["kind"], span["name"]) == ("job", "retention")
    assert span["meta"] == {"result": "deleted 1 firing older than 30 days"}
    after = await timers.get(pool, job["id"])
    assert after["next_fire_at"] == job["next_fire_at"] + timedelta(days=1)


async def test_an_unknown_job_handler_is_refused_and_pauses_the_row_with_the_reason(pool):
    timer_id = await _job_row(pool, "nope", next_fire_at=datetime(2031, 1, 1, tzinfo=UTC))
    fired = await scheduler.tick_once(app, pool, now=LATER)
    assert len(fired) == 1
    (firing,) = await _firings(pool, timer_id)
    assert firing["status"] == "refused"
    assert firing["reason"] == "no job handler named 'nope'"
    row = await timers.get(pool, timer_id)
    assert row["paused_at"] is not None
    assert row["paused_reason"] == "no job handler named 'nope'"
    assert row["consecutive_failures"] == 1
    assert await pool.fetchval(TURN_STATUS, firing["turn_id"]) == "error"
    # Paused: the next tick leaves it alone.
    assert await scheduler.tick_once(app, pool, now=LATER + timedelta(days=1)) == []


# -- the claim ------------------------------------------------------------------------------------


async def test_two_concurrent_ticks_on_one_due_row_produce_one_firing(pool):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)
    other = await asyncpg.create_pool(TEST_DSN, min_size=1, max_size=2, init=db._configure)
    try:
        a, b = await asyncio.gather(
            scheduler.tick_once(app, pool, now=LATER), scheduler.tick_once(app, other, now=LATER)
        )
    finally:
        await other.close()
    assert len(a) + len(b) == 1
    assert len(await _firings(pool, row["id"])) == 1
    assert await pool.fetchval("SELECT count(*) FROM messages") == 1


async def test_a_row_locked_by_another_transaction_is_skipped_not_waited_on(pool):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)
    other = await asyncpg.create_pool(TEST_DSN, min_size=1, max_size=2, init=db._configure)
    try:
        async with other.acquire() as conn:
            tr = conn.transaction()
            await tr.start()
            await conn.execute("SELECT id FROM timers WHERE id = $1 FOR UPDATE", row["id"])
            # SKIP LOCKED: the tick returns at once with nothing, rather than
            # blocking on the other claim.
            assert await asyncio.wait_for(scheduler.tick_once(app, pool, now=LATER), 5) == []
            await tr.rollback()
        assert len(await scheduler.tick_once(app, pool, now=LATER)) == 1
    finally:
        await other.close()
    assert len(await _firings(pool, row["id"])) == 1


async def test_a_paused_row_never_fires(pool):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)
    await timers.pause(pool, row["id"], reason="holiday")
    assert await scheduler.tick_once(app, pool, now=LATER) == []
    assert await _firings(pool, row["id"]) == []
    after = await timers.get(pool, row["id"])
    assert after["paused_at"] is not None and after["next_fire_at"] == row["next_fire_at"]
    assert await pool.fetchval("SELECT count(*) FROM messages") == 0


async def test_five_consecutive_failures_pause_the_timer_with_the_last_reason(pool, monkeypatch):
    async def flaky(pool) -> str:
        raise RuntimeError("boom")

    monkeypatch.setitem(timers.JOBS, "flaky", flaky)
    start = datetime(2031, 1, 1, tzinfo=UTC)
    timer_id = await _job_row(pool, "flaky", next_fire_at=start)

    for attempt in range(1, 5):
        fired = await scheduler.tick_once(app, pool, now=start + timedelta(minutes=5 * attempt))
        assert len(fired) == 1, attempt
        row = await timers.get(pool, timer_id)
        assert row["consecutive_failures"] == attempt
        assert row["paused_at"] is None, attempt

    fired = await scheduler.tick_once(app, pool, now=start + timedelta(minutes=25))
    assert len(fired) == 1
    row = await timers.get(pool, timer_id)
    assert row["consecutive_failures"] == 5
    assert row["paused_at"] is not None
    assert row["paused_reason"] == (
        "paused after 5 consecutive failures: job 'flaky' failed — RuntimeError: boom"
    )
    firings = await _firings(pool, timer_id)
    assert [f["status"] for f in firings] == ["error"] * 5
    assert all("boom" in f["reason"] for f in firings)
    # And it stays paused: the sixth tick claims nothing.
    assert await scheduler.tick_once(app, pool, now=start + timedelta(minutes=30)) == []


async def test_a_success_resets_the_failure_count(pool, monkeypatch):
    calls = {"n": 0}

    async def sometimes(pool) -> str:
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("not yet")
        return "fine"

    monkeypatch.setitem(timers.JOBS, "sometimes", sometimes)
    start = datetime(2031, 1, 1, tzinfo=UTC)
    timer_id = await _job_row(pool, "sometimes", next_fire_at=start)
    for attempt in range(1, 4):
        await scheduler.tick_once(app, pool, now=start + timedelta(minutes=5 * attempt))
    row = await timers.get(pool, timer_id)
    assert row["consecutive_failures"] == 0 and row["paused_at"] is None
    assert [f["status"] for f in await _firings(pool, timer_id)] == ["error", "error", "ok"]


async def test_a_missed_repeat_fires_once_and_resumes_from_now_not_twelve_times(pool, monkeypatch):
    """A 5-minute job that missed an hour (core was down): ONE firing whose
    scheduled_for is the missed instant, and a next fire after now — never a
    burst of catch-up firings."""

    async def quiet(pool) -> str:
        return "ran"

    monkeypatch.setitem(timers.JOBS, "quiet", quiet)
    missed = datetime(2031, 1, 1, 8, 0, tzinfo=UTC)
    timer_id = await _job_row(pool, "quiet", next_fire_at=missed)
    now = missed + timedelta(hours=1)
    assert len(await scheduler.tick_once(app, pool, now=now)) == 1
    (firing,) = await _firings(pool, timer_id)
    assert firing["scheduled_for"] == missed
    assert (await timers.get(pool, timer_id))["next_fire_at"] == now + timedelta(minutes=5)
    assert await scheduler.tick_once(app, pool, now=now + timedelta(seconds=1)) == []


async def test_an_on_time_repeat_keeps_its_grid(pool, monkeypatch):
    async def quiet(pool) -> str:
        return "ran"

    monkeypatch.setitem(timers.JOBS, "quiet", quiet)
    due = datetime(2031, 1, 1, 8, 0, tzinfo=UTC)
    timer_id = await _job_row(pool, "quiet", next_fire_at=due)
    await scheduler.tick_once(app, pool, now=due + timedelta(seconds=40))  # a late tick
    assert (await timers.get(pool, timer_id))["next_fire_at"] == due + timedelta(minutes=5)


# -- sweep and lifespan ----------------------------------------------------------------------------


async def test_startup_sweep_marks_every_running_firing_interrupted_with_the_reason(pool, caplog):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)
    orphan = await pool.fetchval(
        "INSERT INTO timer_firings (timer_id, scheduled_for, status) VALUES ($1, now(), 'running') "
        "RETURNING id",
        row["id"],
    )
    live = await pool.fetchval(
        "INSERT INTO timer_firings (timer_id, scheduled_for, status) VALUES ($1, now(), 'running') "
        "RETURNING id",
        row["id"],
    )
    done = await pool.fetchval(
        "INSERT INTO timer_firings (timer_id, scheduled_for, status, ended_at) "
        "VALUES ($1, now(), 'ok', now()) RETURNING id",
        row["id"],
    )
    scheduler.RUNNING.add(live)  # this process is running it: excluded, derived from the set
    with caplog.at_level(logging.WARNING, logger="core"):
        assert await scheduler.sweep_orphaned_firings(pool) == [orphan]
    swept = await pool.fetchrow("SELECT * FROM timer_firings WHERE id = $1", orphan)
    assert swept["status"] == "interrupted"
    assert swept["reason"] == scheduler.INTERRUPTED_REASON
    assert swept["ended_at"] is not None
    status_of = "SELECT status FROM timer_firings WHERE id = $1"
    assert await pool.fetchval(status_of, live) == "running"
    assert await pool.fetchval(status_of, done) == "ok"
    (line,) = [r.getMessage() for r in caplog.records if str(orphan) in r.getMessage()]
    assert "interrupted" in line and str(row["id"]) in line
    scheduler.RUNNING.discard(live)
    # Idempotent for the swept row; the formerly-live one is now an orphan too.
    assert await scheduler.sweep_orphaned_firings(pool) == [live]
    assert await scheduler.sweep_orphaned_firings(pool) == []


async def test_lifespan_sweeps_seeds_and_runs_the_scheduler_cancelled_before_the_drain(
    pool, monkeypatch
):
    """The app's real startup: the orphan sweep and ensure_jobs run, the loop
    is a live task while the app is up, and at shutdown it is cancelled and
    awaited BEFORE chat.drain_background — a forever task drained with the set
    would hang shutdown."""
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)
    orphan = await pool.fetchval(
        "INSERT INTO timer_firings (timer_id, scheduled_for, status) VALUES ($1, now(), 'running') "
        "RETURNING id",
        row["id"],
    )
    ticks: list[datetime] = []
    original_tick = scheduler.tick_once

    async def counting_tick(app_, pool_, *, now=None):
        ticks.append(datetime.now(UTC))
        return await original_tick(app_, pool_, now=now)

    monkeypatch.setattr(scheduler, "tick_once", counting_tick)
    seen_at_drain: dict = {}
    original_drain = chat.drain_background

    async def observing_drain():
        task = app.state.scheduler_task
        seen_at_drain["cancelled_before_drain"] = task.cancelled() or (
            task.done() and not task.exception()
        )
        seen_at_drain["done"] = task.done()
        await original_drain()

    monkeypatch.setattr(chat, "drain_background", observing_drain)

    async with lifespan(app):
        assert await pool.fetchval(
            "SELECT status FROM timer_firings WHERE id = $1", orphan
        ) == "interrupted"
        assert await pool.fetchval(
            "SELECT count(*) FROM timers WHERE kind = 'job' AND payload->>'handler' = 'retention'"
        ) == 1
        task = app.state.scheduler_task
        assert isinstance(task, asyncio.Task) and not task.done()
        assert task.get_name() == "scheduler"
        # Let the loop's first tick run (it fires immediately, then sleeps for
        # the interval, so within this test there is exactly one).
        for _ in range(500):
            if ticks:
                break
            await asyncio.sleep(0.01)
        assert len(ticks) == 1
    assert seen_at_drain == {"cancelled_before_drain": True, "done": True}
    assert task.cancelled()


async def test_run_forever_logs_a_failing_tick_and_keeps_going(monkeypatch, caplog):
    calls = {"n": 0}

    async def failing_then_fine(app_, pool_, *, now=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("db hiccup")
        return []

    monkeypatch.setattr(scheduler, "tick_once", failing_then_fine)
    with caplog.at_level(logging.ERROR, logger="core"):
        task = asyncio.create_task(scheduler.run_forever(app, None, interval_s=0.01))
        for _ in range(100):
            if calls["n"] >= 2:
                break
            await asyncio.sleep(0.005)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert calls["n"] >= 2
    assert any("scheduler tick failed" in r.getMessage() for r in caplog.records)


async def test_a_graceful_shutdown_mid_firing_closes_it_interrupted_and_counts_no_failure(
    pool, monkeypatch
):
    """lifespan cancels the ticker (SIGTERM, `compose up -d --build`) while a
    firing runs: the firing is closed `interrupted` with the reason, its turn
    is `interrupted`, and the timer's failure count is untouched — the same
    fact the startup sweep states for a SIGKILL. Reverting the CancelledError
    branch records `error` / "did not reach an outcome" and counts a failure,
    so five redeploys during long turns would pause the timer."""
    entered = asyncio.Event()

    async def slow(pool_) -> str:
        entered.set()
        await asyncio.sleep(30)
        return "never reached"

    monkeypatch.setitem(timers.JOBS, "slow", slow)
    timer_id = await _job_row(pool, "slow", next_fire_at=datetime(2020, 1, 1, tzinfo=UTC))
    task = asyncio.create_task(scheduler.run_forever(app, pool, interval_s=60))
    await asyncio.wait_for(entered.wait(), 5)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert task.cancelled()

    (firing,) = await _firings(pool, timer_id)
    assert firing["status"] == "interrupted"
    assert firing["reason"] == scheduler.SHUTDOWN_REASON
    assert firing["ended_at"] is not None
    assert await pool.fetchval(TURN_STATUS, firing["turn_id"]) == "interrupted"
    row = await timers.get(pool, timer_id)
    assert row["consecutive_failures"] == 0 and row["paused_at"] is None
    assert scheduler.RUNNING == set()
    # Already closed: the next startup's sweep has nothing to say about it.
    assert await scheduler.sweep_orphaned_firings(pool) == []


def test_framed_instruction_names_the_timer_and_the_local_time():
    framed = scheduler.framed_instruction(
        "calendar", "read it", now_words="Sun 6 Sep 2026 07:00 EDT"
    )
    assert framed == (
        "[Scheduled turn — you set this up earlier as 'calendar'; the owner may not be "
        "watching. Local time now: Sun 6 Sep 2026 07:00 EDT.]\n\nread it"
    )
    assert json.dumps(framed)  # plain text, nothing a transport would choke on
