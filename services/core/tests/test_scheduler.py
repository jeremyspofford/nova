"""The tick: a due row is claimed exactly once, every firing is a traced turn,
delivery is a fact from the device's own frame, and the process's death is
visible on the row it left running. S12: a scheduled row bound to an agent
runs the agent's own funnel — its persona, its rounds, its role on the turn —
and lands in the owner's conversation; a plain row's call is unchanged."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import asyncpg
import pytest

from app import (
    agents,
    beats,
    chat,
    db,
    devices,
    devices_ws,
    scheduler,
    settings_store,
    timers,
    tools,
    traces,
)
from app.identity import Person
from app.main import app, lifespan
from tests.conftest import TEST_DSN, requires_db
from tests.device_fakes import FakeDevice, FakeWSConn
from tests.fakes import FakeGateway, FakeMemory, Refusal, ScriptedGateway
from tests.test_chat_agents import SUBSET
from tests.test_chat_agents import _create as _create_agent

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


async def _rounds_ceiling(pool, rounds: int) -> None:
    """The live round ceiling, written the way the settings route writes it."""
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('agents.max_tool_rounds', $1::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        rounds,
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
        pool,
        code=code["code"],
        pubkey=device.pubkey_hex,
        name=name,
        platform="linux",
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
        pubkey=FakeDevice().pubkey_hex,
        name="desktop",
        platform="linux",
        hostname="h",
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
        pubkey=FakeDevice().pubkey_hex,
        name="desktop",
        platform="linux",
        hostname="h",
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
    await pool.execute("INSERT INTO settings (key, value) VALUES ('chat.model', $1::jsonb)", model)


async def test_a_due_scheduled_runs_a_real_turn_with_no_user_row_and_no_ingest(pool, mount_peers):
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
    # The plain pin (S12 kept it): no persona kwarg at all for a row nobody
    # bound — a plain firing's call is byte-for-byte what it was.
    assert call["kwargs"] == {"ingest": False}
    _app, _pool, turn, who, conv, _message, history, model, _rounds, _emit = call["args"]
    assert who == person  # the timer's person, which for his timers is the owner
    assert conv == conversation and history == [] and model == MODEL
    assert turn.conversation_id == conversation


# -- scheduled, bound to an agent (S12) ---------------------------------------------------


@pytest.fixture
def root(monkeypatch, tmp_path) -> Path:
    """The WORKSPACE_ROOT agents.create makes agents/<name>/ under."""
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


async def _bound(pool, person, conversation, agent, *, instruction="append the date to log.md"):
    return await timers.create(
        pool,
        person=person,
        kind="scheduled",
        title="log the date",
        payload={"instruction": instruction},
        spec={"kind": "day", "at": "07:00"},
        tz=NY,
        conversation_id=conversation,
        created_via="chat",
        agent_id=agent.id,
    )


async def test_an_agent_bound_firing_runs_as_the_agent_and_lands_in_the_owners_chat(
    pool, mount_peers, root
):
    """No chat.model is set, and the firing still runs: the agent's turn
    names no model and the gateway walks agent_coder's own chain. The turn
    row says who did the work (agent_id, role) and whose money it is
    (person_id: the owner); the request carries the agent's subset, its
    block and its role; recall asks the agent's partition; nothing is
    ingested; and the reply is one assistant row in the OWNER's conversation."""
    person, conversation = await _owner(pool)
    agent = await _create_agent(pool, mount_peers)
    gateway = FakeGateway(deltas=("logged the date",))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)
    row = await _bound(pool, person, conversation, agent)

    fired = await scheduler.tick_once(app, pool, now=row["next_fire_at"] + timedelta(minutes=1))
    assert len(fired) == 1

    rows = await pool.fetch(
        "SELECT role, content, turn_id FROM messages WHERE conversation_id = $1", conversation
    )
    assert [(r["role"], r["content"]) for r in rows] == [("assistant", "logged the date")]
    turn = await pool.fetchrow("SELECT * FROM turns WHERE id = $1", rows[0]["turn_id"])
    assert turn["kind"] == "scheduled" and turn["status"] == "ok"
    assert turn["agent_id"] == agent.id and turn["role"] == "agent_coder"
    assert turn["person_id"] == person.id and turn["conversation_id"] == conversation
    assert turn["model"] == ""  # no model named: the role's chain decides
    assert turn["id"] not in traces.INFLIGHT

    # The one completion request: the agent's subset and block, its role, the
    # owner's id as the payer, the framed instruction, and NO model.
    (path, payload), headers = next(
        (seen, h)
        for seen, h in zip(gateway.seen, gateway.seen_headers, strict=True)
        if seen[0] == "/v1/chat/completions"
    )
    assert "model" not in payload
    assert payload["tools"] == tools.advertised_tools(SUBSET)
    assert "You are coder, an agent working for the household" in payload["messages"][0]["content"]
    user_messages = [m for m in payload["messages"] if m["role"] == "user"]
    assert len(user_messages) == 1
    assert user_messages[0]["content"].startswith(
        "[Scheduled turn — you set this up earlier as 'log the date'"
    )
    assert user_messages[0]["content"].endswith("\n\nappend the date to log.md")
    assert headers["x-nova-role"] == "agent_coder"
    assert headers["x-nova-person"] == str(person.id)
    assert headers["x-nova-turn-id"] == str(turn["id"])

    # Memory: the AGENT's partition is recalled (read_shared_memory is off),
    # and nothing is ingested — a timer's instruction is not something he said.
    await chat.drain_background()
    assert [r["person_id"] for r in memory.recalls] == [str(agent.id)]
    assert memory.ingests == []
    spans = await _spans(pool, turn["id"])
    assert {s["kind"] for s in spans} >= {"agent_cap", "memory_recall", "llm_call"}
    assert "memory_ingest" not in {s["kind"] for s in spans}

    (firing,) = await _firings(pool, row["id"])
    assert firing["status"] == "ok" and firing["turn_id"] == turn["id"]
    assert firing["delivery"] == {"chat": {"ok": True}}
    after = await timers.get(pool, row["id"])
    assert after["consecutive_failures"] == 0 and after["agent_id"] == agent.id


async def test_a_bound_firings_run_turn_call_carries_the_persona_and_the_rows_rounds(
    pool, mount_peers, monkeypatch, root
):
    """The agent case beside the plain pin below: the call differs in exactly
    the persona kwarg, the agent's Person value, the row's round budget and
    the empty model — the conversation, the empty history and ingest=False
    are the same. The shared scope is derived from the row and the OWNER's id
    (the timer's person), never handed in."""
    person, conversation = await _owner(pool)
    agent = await _create_agent(pool, mount_peers, max_tool_rounds=3, read_shared_memory=True)
    mount_peers(gateway=FakeGateway(deltas=("ok",)), memory=FakeMemory())
    await _set_model(pool)  # set, and still not named for the agent's turn
    row = await _bound(pool, person, conversation, agent)
    seen: list[dict] = []
    original = chat._run_turn

    async def spy(*args, **kwargs):
        seen.append({"args": args, "kwargs": kwargs})
        return await original(*args, **kwargs)

    monkeypatch.setattr(chat, "_run_turn", spy)
    await scheduler.tick_once(app, pool, now=row["next_fire_at"] + timedelta(minutes=1))

    (call,) = seen
    assert set(call["kwargs"]) == {"ingest", "persona"}
    assert call["kwargs"]["ingest"] is False
    persona = call["kwargs"]["persona"]
    assert isinstance(persona, agents.Persona)
    assert persona.agent is not None and persona.agent.id == agent.id
    assert persona.tool_names == SUBSET
    assert persona.shared_person_id == person.id  # the timer's owner, from the row
    assert persona.workspace_root == agents.folder_for(agent)
    _app, _pool, turn, who, conv, _message, history, model, rounds, _emit = call["args"]
    assert who == agent.person() and who.role == agents.AGENT_PERSON_ROLE
    assert conv == conversation and history == [] and model == ""
    assert rounds == 3 == agent.max_tool_rounds
    assert turn.agent_id == agent.id and turn.role == agent.role
    assert turn.person_id == person.id and turn.conversation_id == conversation
    (firing,) = await _firings(pool, row["id"])
    assert firing["status"] == "ok"


async def test_a_capped_agents_firing_is_an_error_with_the_cap_statement(pool, mount_peers, root):
    """The cap is _run_turn's own exit (test_chat_cap): the statement is
    persisted as the assistant row in the owner's conversation, the turn
    closes error, no completion is requested — and the firing records
    FIRING_ERROR with that same statement, read back off the turn."""
    person, conversation = await _owner(pool)
    agent = await _create_agent(pool, mount_peers, monthly_cap_usd=20)
    gateway = FakeGateway(
        deltas=("must never stream",),
        spend_body={
            "window": "month",
            "timezone": "UTC",
            "totals": {"usd": 0},
            "by_role": [{"key": "agent_coder", "local": False, "usd": 21.4, "calls": 3}],
        },
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)
    row = await _bound(pool, person, conversation, agent)

    await scheduler.tick_once(app, pool, now=row["next_fire_at"] + timedelta(minutes=1))

    statement = (
        "agent coder is over its monthly cap ($21.40 of $20.00 this month) — raise it on the "
        "Agents page"
    )
    (firing,) = await _firings(pool, row["id"])
    assert firing["status"] == "error"
    assert firing["reason"] == statement
    assert firing["delivery"] == {"chat": {"ok": False, "reason": statement}}
    rows = await pool.fetch(
        "SELECT role, content FROM messages WHERE conversation_id = $1", conversation
    )
    assert [(r["role"], r["content"]) for r in rows] == [("assistant", statement)]
    assert await pool.fetchval(TURN_STATUS, firing["turn_id"]) == "error"
    turn = await pool.fetchrow("SELECT agent_id, role FROM turns WHERE id = $1", firing["turn_id"])
    assert turn["agent_id"] == agent.id and turn["role"] == "agent_coder"
    # Nothing was spent finding out, and nothing was recalled.
    assert [path for path, _ in gateway.seen] == ["/admin/spend"]
    assert memory.recalls == []
    spans = await _spans(pool, firing["turn_id"])
    assert [(s["kind"], s["name"]) for s in spans] == [("agent_cap", None)]
    assert (await timers.get(pool, row["id"]))["consecutive_failures"] == 1


async def test_a_bound_agent_that_vanished_is_a_refused_firing_never_novas_turn(
    pool, mount_peers, monkeypatch, root
):
    """Unreachable while migration 021's RESTRICT holds (proved in
    test_timers_api); stated anyway: the row's agent_id names no agent, so
    the firing is REFUSED with the reason — never quietly run as Nova with
    her whole toolset — and its turn is closed rather than left running."""
    person, conversation = await _owner(pool)
    agent = await _create_agent(pool, mount_peers)
    gateway = FakeGateway(deltas=("must never stream",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(pool)
    row = await _bound(pool, person, conversation, agent)

    async def gone(pool_, agent_id):
        return None

    monkeypatch.setattr(agents, "by_id", gone)
    await scheduler.tick_once(app, pool, now=row["next_fire_at"] + timedelta(minutes=1))

    (firing,) = await _firings(pool, row["id"])
    assert firing["status"] == "refused"
    assert firing["reason"] == scheduler.AGENT_GONE_REASON
    assert firing["delivery"]["chat"] == {"ok": False, "reason": scheduler.AGENT_GONE_REASON}
    assert gateway.seen == []
    assert await pool.fetchval("SELECT count(*) FROM messages") == 0
    turn = await pool.fetchrow(
        "SELECT status, agent_id, role FROM turns WHERE id = $1", firing["turn_id"]
    )
    assert turn["status"] == "error" and turn["agent_id"] is None and turn["role"] is None
    assert (await timers.get(pool, row["id"]))["consecutive_failures"] == 1


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
    """The app's real startup: the orphan sweep, ensure_jobs AND ensure_beats
    run, the loop is a live task while the app is up, and at shutdown it is
    cancelled and awaited BEFORE chat.drain_background — a forever task drained
    with the set would hang shutdown.

    ensure_beats being CALLED here is the whole spine: without it no beat row
    exists in a deployed build and nothing she watches ever runs."""
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
        assert (
            await pool.fetchval("SELECT status FROM timer_firings WHERE id = $1", orphan)
            == "interrupted"
        )
        assert (
            await pool.fetchval(
                "SELECT count(*) FROM timers WHERE kind = 'job' "
                "AND payload->>'handler' = 'retention'"
            )
            == 1
        )
        seeded = {
            row["handler"]
            for row in await pool.fetch(
                "SELECT payload->>'handler' AS handler FROM timers WHERE kind = $1",
                beats.BEAT_KIND,
            )
        }
        assert seeded == set(beats.BEATS)
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

    async def already_seeded(pool_):
        return True

    monkeypatch.setattr(beats, "ensure_beats", already_seeded)
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


async def test_the_ticker_seeds_the_beats_after_registration_without_a_restart(pool, monkeypatch):
    """A FRESH INSTALL has no owner when core starts, so main.lifespan's
    ensure_beats honestly declines. Without a retry the beats would not exist
    until someone restarted core — on a new box, "not until the stack is next
    redeployed" — and she would watch nothing while looking perfectly healthy.
    The loop asks again on its own ticks, which are exactly the moments the
    answer could have changed."""
    assert await beats.ensure_beats(pool) is False  # nobody has registered yet

    ticks = asyncio.Event()
    original_tick = scheduler.tick_once

    async def counting_tick(app_, pool_, *, now=None):
        ticks.set()
        return await original_tick(app_, pool_, now=now)

    monkeypatch.setattr(scheduler, "tick_once", counting_tick)
    task = asyncio.create_task(scheduler.run_forever(app, pool, interval_s=0.01))
    try:
        await asyncio.wait_for(ticks.wait(), 5)
        assert (
            await pool.fetchval("SELECT count(*) FROM timers WHERE kind = $1", beats.BEAT_KIND) == 0
        )
        # He registers. No restart, no redeploy.
        await pool.execute("INSERT INTO people (name, role) VALUES ('jeremy', 'owner')")
        for _ in range(500):
            seeded = await pool.fetchval(
                "SELECT count(*) FROM timers WHERE kind = $1", beats.BEAT_KIND
            )
            if seeded == len(beats.BEATS):
                break
            await asyncio.sleep(0.01)
        assert seeded == len(beats.BEATS)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_the_ticker_stops_asking_once_the_beats_are_rows(pool, monkeypatch):
    """The read-back is what stops it: ensure_beats returns True only when
    every beat was found as a row, and the loop asks until it does."""
    await pool.execute("INSERT INTO people (name, role) VALUES ('jeremy', 'owner')")
    asked = {"n": 0}
    real = beats.ensure_beats

    async def counting(pool_):
        asked["n"] += 1
        return await real(pool_)

    monkeypatch.setattr(beats, "ensure_beats", counting)
    task = asyncio.create_task(scheduler.run_forever(app, pool, interval_s=0.01))
    try:
        for _ in range(500):
            if asked["n"] >= 1:
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.2)  # many more ticks go by
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert asked["n"] == 1, "the seed is asked for until it takes, then never again"


async def test_a_seeding_failure_is_loud_and_never_stops_the_ticks(pool, monkeypatch, caplog):
    """Seeding is not this loop's job. A database that will not answer it must
    not hold up every reminder behind it — the failure is logged with its
    reason and the tick runs anyway."""
    ticks = {"n": 0}

    async def explodes(pool_):
        raise RuntimeError("the beats table is on fire")

    async def counting_tick(app_, pool_, *, now=None):
        ticks["n"] += 1
        return []

    monkeypatch.setattr(beats, "ensure_beats", explodes)
    monkeypatch.setattr(scheduler, "tick_once", counting_tick)
    with caplog.at_level(logging.ERROR, logger="core"):
        task = asyncio.create_task(scheduler.run_forever(app, pool, interval_s=0.01))
        try:
            for _ in range(500):
                if ticks["n"] >= 2:
                    break
                await asyncio.sleep(0.01)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    assert ticks["n"] >= 2
    assert any("the beats could not be seeded" in r.getMessage() for r in caplog.records)


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


# -- the bound on one firing (the S9 carry) ---------------------------------------------------


async def test_a_firing_that_passes_the_bound_is_stopped_and_says_so(pool, monkeypatch, caplog):
    """Firings run one after another, so an unbounded run delays every timer
    behind it until the process restarts. asyncio.wait_for cuts it, the firing
    is an ERROR whose reason STATES the bound, and the turn is closed — reverting
    the bound leaves this hanging for the length of the test's timeout."""
    monkeypatch.setattr(scheduler, "FIRING_TIMEOUT_FLOOR_S", 0.05)
    entered = asyncio.Event()

    async def hangs(pool_) -> str:
        entered.set()
        await asyncio.sleep(30)
        return "never reached"

    monkeypatch.setitem(timers.JOBS, "hangs", hangs)
    timer_id = await _job_row(pool, "hangs", next_fire_at=datetime(2031, 1, 1, tzinfo=UTC))
    with caplog.at_level(logging.ERROR, logger="core"):
        fired = await asyncio.wait_for(scheduler.tick_once(app, pool, now=LATER), 10)
    assert len(fired) == 1
    assert entered.is_set()  # it really started; this is a cut, not a refusal

    (firing,) = await _firings(pool, timer_id)
    assert firing["status"] == scheduler.FIRING_ERROR
    assert firing["reason"] == scheduler.timeout_reason("job", 0.05)
    assert "0.05 seconds" in firing["reason"] and "delay every timer behind it" in firing["reason"]
    assert firing["ended_at"] is not None
    assert await pool.fetchval(TURN_STATUS, firing["turn_id"]) == "error"
    # An error, not an interruption: the timer did something wrong, so it counts
    # toward the pause ceiling. A beat that hangs every hour is broken.
    row = await timers.get(pool, timer_id)
    assert row["consecutive_failures"] == 1
    assert any(str(firing["id"]) in r.getMessage() for r in caplog.records)
    assert scheduler.RUNNING == set()


def test_the_bound_is_stated_in_words_from_the_bound_that_was_applied():
    """The sentence carries the number that was actually used — passed in, not
    read from a constant — so it can never describe a bound nobody applied. And
    it says out loud that a cut is not proof of a hang: this bound is derived
    from the live ceiling, so a run that reached it may have been legitimate."""
    said = scheduler.timeout_reason("beat", 42)
    assert "42 seconds" in said
    assert said.startswith("this beat firing")
    assert "legitimately long one that was cut" in said
    assert "the turn's spans say which" in said


async def test_the_bound_is_derived_from_the_live_ceiling_not_the_default(pool):
    """The defect this closes: one constant computed from the DEFAULT round
    ceiling bounded EVERY firing kind, so raising agents.max_tool_rounds — a
    deliberate act — left a legitimate long turn to be cut, recorded an error
    and charged one of the five failures that pause the row. Pinned against the
    live setting, never a literal."""
    await _rounds_ceiling(pool, 40)
    rounds = int(await settings_store.read_value(pool, "agents.max_tool_rounds"))
    assert await scheduler.firing_timeout_s(pool, "scheduled") == rounds * chat.GATEWAY_TIMEOUT.read
    # And it moves with the setting rather than with an edit here.
    await _rounds_ceiling(pool, 12)
    assert await scheduler.firing_timeout_s(pool, "scheduled") == 12 * chat.GATEWAY_TIMEOUT.read


async def test_a_bound_agents_firing_is_bounded_by_that_agents_own_budget(pool, mount_peers, root):
    """An agent-bound scheduled row runs the agent's rounds, so the bound is
    the agent's — reading the setting instead would cut the very row whose
    budget was widened on purpose."""
    await _owner(pool)
    await _rounds_ceiling(pool, 6)
    agent = await _create_agent(pool, mount_peers, name="researcher", max_tool_rounds=30)
    assert agent.max_tool_rounds == 30
    assert await scheduler.firing_timeout_s(pool, "scheduled", agent) == (
        30 * chat.GATEWAY_TIMEOUT.read
    )


async def test_a_firing_that_makes_no_model_call_gets_the_floor(pool):
    """A reminder writes a chat row and a device frame; a job is database work.
    Neither waits on a gateway round, so neither is bounded by one."""
    await _rounds_ceiling(pool, 40)
    assert await scheduler.firing_timeout_s(pool, "reminder") == scheduler.FIRING_TIMEOUT_FLOOR_S
    assert await scheduler.firing_timeout_s(pool, "job") == scheduler.FIRING_TIMEOUT_FLOOR_S
    # And the floor really is a floor: a tiny live ceiling cannot shrink a
    # firing's budget below what its own work needs.
    await _rounds_ceiling(pool, 1)
    assert await scheduler.firing_timeout_s(pool, "beat") == scheduler.FIRING_TIMEOUT_FLOOR_S


def test_the_kinds_bounded_by_the_round_ceiling_are_the_ones_that_run_a_model_turn():
    assert set(scheduler.MODEL_TURN_KINDS) == {"scheduled", beats.BEAT_KIND}


async def test_a_timeout_from_inside_the_run_is_not_reported_as_the_bound(pool, monkeypatch):
    """The bound's sentence names a number. A TimeoutError that escapes the
    work itself must not borrow those words — the firing would claim it ran
    for 1800 seconds when it ran for none."""

    async def times_out(pool_, row_, turn_):
        raise TimeoutError("the search backend went quiet")

    monkeypatch.setattr(scheduler, "_fire_job", times_out)
    timer_id = await _job_row(pool, "retention", next_fire_at=datetime(2031, 1, 1, tzinfo=UTC))
    await scheduler.tick_once(app, pool, now=LATER)
    (firing,) = await _firings(pool, timer_id)
    assert firing["status"] == scheduler.FIRING_ERROR
    assert "a timeout inside the firing" in firing["reason"]
    assert "the search backend went quiet" in firing["reason"]
    assert firing["reason"] != scheduler.timeout_reason("job", scheduler.FIRING_TIMEOUT_FLOOR_S)
    assert f"{scheduler.FIRING_TIMEOUT_FLOOR_S:g} seconds" not in firing["reason"]
