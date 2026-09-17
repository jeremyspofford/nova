"""The turn ledger writes once, completely, or not at all — and every turn
reaches a terminal status, even when the process that ran it did not."""

from __future__ import annotations

import json
import logging
import re
import uuid
from pathlib import Path

import asyncpg
import pytest
import yaml

from app import chat, traces
from tests.conftest import requires_db

pytestmark = requires_db


async def _turn(pool):
    person = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('owner', 'owner') RETURNING id"
    )
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
    )
    return await traces.open_turn(pool, conversation_id=conversation, model="qwen3:8b")


async def test_an_open_turn_has_no_status_yet(pool):
    turn = await _turn(pool)
    row = await pool.fetchrow(
        "SELECT status, ended_at, model, kind FROM turns WHERE id = $1", turn.id
    )
    assert row["status"] is None  # unfinished reads as unfinished, never as ok
    assert row["ended_at"] is None
    assert row["model"] == "qwen3:8b"
    assert row["kind"] == "chat"


async def test_spans_and_status_land_together(pool):
    turn = await _turn(pool)
    with turn.span("memory_recall") as span:
        span.meta.update(k=5, hits=2)
    with turn.span("llm_call", "qwen3:8b") as span:
        span.meta["model"] = "qwen3:8b"

    await traces.close_turn(pool, turn, "ok")

    rows = await pool.fetch(
        "SELECT kind, name, duration_ms, meta FROM turn_spans WHERE turn_id = $1 "
        "ORDER BY started_at",
        turn.id,
    )
    assert [r["kind"] for r in rows] == ["memory_recall", "llm_call"]
    assert rows[0]["meta"] == {"k": 5, "hits": 2}
    assert rows[1]["name"] == "qwen3:8b"
    assert all(r["duration_ms"] >= 0 for r in rows)
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) == "ok"


async def test_a_failed_close_writes_nothing_at_all(pool):
    turn = await _turn(pool)
    with turn.span("memory_recall") as span:
        span.meta["hits"] = 1
    # A span the database will refuse — kind is NOT NULL.
    turn.spans.append(traces.Span(kind=None, name=None, started_at=turn.started_at, duration_ms=1))

    with pytest.raises(Exception):
        await traces.close_turn(pool, turn, "ok")

    assert await pool.fetchval("SELECT count(*) FROM turn_spans WHERE turn_id = $1", turn.id) == 0
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) is None


async def test_an_invented_status_is_refused(pool):
    turn = await _turn(pool)
    with pytest.raises(ValueError):
        await traces.close_turn(pool, turn, "finished")


# -- process death: the sweep, and the redeploy that should rarely need it --


async def test_startup_sweeps_every_orphan_as_interrupted_and_nothing_else(pool, caplog):
    """A NULL status is 'no close ran', not 'still running'. At startup the
    process runs nothing, so every NULL row is an orphan of a dead process —
    closed as 'interrupted' with an ended_at, each one said out loud. A turn
    THIS process is running (INFLIGHT) and a turn already closed are left
    exactly as they were; a second sweep finds nothing."""
    person = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('owner', 'owner') RETURNING id"
    )
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
    )
    running = await traces.open_turn(pool, conversation_id=conversation)
    traces.INFLIGHT.add(running.id)
    try:
        orphan = await traces.open_turn(pool, conversation_id=conversation)
        # An orphan with no conversation at all (an eval turn, or one whose
        # conversation was deleted) is swept too — the WHERE is on status, not
        # on ownership.
        stray = await traces.open_turn(pool, kind="eval", conversation_id=None)
        finished = await traces.open_turn(pool, conversation_id=conversation)
        await traces.close_turn(pool, finished, "ok")

        with caplog.at_level(logging.WARNING, logger="core"):
            swept = await traces.sweep_orphaned_turns(pool)

        assert set(swept) == {orphan.id, stray.id}
        for turn_id in (orphan.id, stray.id):
            row = await pool.fetchrow("SELECT status, ended_at FROM turns WHERE id = $1", turn_id)
            assert row["status"] == "interrupted"
            assert row["ended_at"] is not None
        # Untouched: the live turn stays open, the finished one stays 'ok'.
        assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", running.id) is None
        assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", finished.id) == "ok"

        # Never silent: one WARNING per swept turn, carrying what was known.
        warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
        for turn in (orphan, stray):
            (line,) = [w for w in warnings if str(turn.id) in w]
            assert "interrupted" in line
            assert turn.started_at.isoformat() in line
            assert str(turn.conversation_id) in line  # "None" for the stray
        assert not any(str(running.id) in w for w in warnings)

        # Idempotent.
        assert await traces.sweep_orphaned_turns(pool) == []
    finally:
        traces.INFLIGHT.discard(running.id)


def _seconds(value: str | int) -> int:
    """A compose duration ('330s', '5m30s', or a bare number of seconds)."""
    if isinstance(value, int):
        return value
    units = {"h": 3600, "m": 60, "s": 1, "ms": 0.001}
    total = 0.0
    for amount, unit in re.findall(r"(\d+(?:\.\d+)?)(ms|h|m|s)", value):
        total += float(amount) * units[unit]
    return int(total)


def test_a_redeploy_waits_long_enough_for_a_turn_to_close_its_trace():
    """The sweep exists for a SIGKILL mid-turn; the deploy is set so that is
    rare. Three numbers must stay ordered, and they live in three files:
    chat.GATEWAY_TIMEOUT.read (the longest one gateway call can hold a turn
    open) <= uvicorn's --timeout-graceful-shutdown (how long it waits for
    that connection before it will even run the lifespan drain) < compose's
    stop_grace_period (when docker SIGKILLs). Equal uvicorn/compose values
    would give the drain zero seconds in the timeout branch."""
    root = Path(__file__).resolve().parents[3]
    compose = yaml.safe_load((root / "deploy" / "docker-compose.yml").read_text())
    stop_grace = _seconds(compose["services"]["core"]["stop_grace_period"])

    dockerfile = (root / "services" / "core" / "Dockerfile").read_text()
    # The exec-form CMD, which may be continued across lines with a backslash.
    match = re.search(r"^CMD\s+(\[.*?\])\s*$", dockerfile.replace("\\\n", " "), re.M | re.S)
    assert match, "core's Dockerfile has no exec-form CMD"
    cmd = json.loads(match.group(1))
    assert "--timeout-graceful-shutdown" in cmd, cmd
    graceful = int(cmd[cmd.index("--timeout-graceful-shutdown") + 1])

    assert graceful >= chat.GATEWAY_TIMEOUT.read
    assert stop_grace > graceful
    # The liveness design (INFLIGHT + the startup sweep) is correct only with
    # exactly ONE core process: a second worker would report another's live
    # turn as not pending and its startup would sweep that turn as
    # interrupted. Refuse the shapes that would break it.
    assert "--workers" not in cmd, cmd
    core = compose["services"]["core"]
    assert "replicas" not in (core.get("deploy") or {}), core.get("deploy")
    assert "scale" not in core, core.get("scale")


async def test_the_person_is_on_the_turn_and_survives_their_deletion(pool):
    person = await pool.fetchrow(
        "INSERT INTO people (name, role) VALUES ('scratch', 'guest') RETURNING id"
    )
    turn = await traces.open_turn(pool, person_id=person["id"], timezone="America/Denver")
    assert turn.person_id == person["id"] and turn.timezone == "America/Denver"
    await traces.close_turn(pool, turn, "ok")
    assert (await pool.fetchval("SELECT person_id FROM turns WHERE id = $1", turn.id)) == person[
        "id"
    ]
    await pool.execute("DELETE FROM people WHERE id = $1", person["id"])
    # ON DELETE SET NULL: the turn (and its spend) outlives the scratch person.
    assert (await pool.fetchval("SELECT person_id FROM turns WHERE id = $1", turn.id)) is None


# -- S12: who did the work, and what it is doing right now --


async def _agent(pool) -> uuid.UUID:
    """A minimal agents row. Not in conftest's per-test TRUNCATE list, so the
    tests that use it delete it themselves."""
    return await pool.fetchval(
        "INSERT INTO agents (name, purpose, instructions, tools, max_tool_rounds, created_via) "
        "VALUES ('coder', 'writes code', 'be terse', ARRAY['get_time'], 5, 'page') RETURNING id"
    )


async def test_the_agent_and_role_are_on_the_turn_and_survive_the_agents_deletion(pool):
    """turns.agent_id says WHO did the work, turns.role which routing role its
    rounds walked; person_id stays the owner it was for. Both round-trip
    through open_turn and the row. ON DELETE SET NULL: deleting the agent
    keeps the trace and its role text in Activity and only loses the name."""
    owner = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('owner', 'owner') RETURNING id"
    )
    agent = await _agent(pool)
    try:
        turn = await traces.open_turn(
            pool, kind="agent", person_id=owner, agent_id=agent, role="agent_coder"
        )
        assert turn.agent_id == agent and turn.role == "agent_coder"
        assert turn.person_id == owner and turn.kind == "agent"
        await traces.close_turn(pool, turn, "ok")
        row = await pool.fetchrow(
            "SELECT person_id, agent_id, role, kind, status FROM turns WHERE id = $1", turn.id
        )
        assert row["person_id"] == owner
        assert row["agent_id"] == agent
        assert row["role"] == "agent_coder"
        assert row["kind"] == "agent" and row["status"] == "ok"

        await pool.execute("DELETE FROM agents WHERE id = $1", agent)
        row = await pool.fetchrow("SELECT agent_id, role FROM turns WHERE id = $1", turn.id)
        assert row["agent_id"] is None
        assert row["role"] == "agent_coder"
    finally:
        await pool.execute("DELETE FROM agents WHERE id = $1", agent)


async def test_a_turn_nobody_delegated_stores_no_agent_and_no_role(pool):
    """Nova's own turns (every caller today) pass neither: both columns are
    NULL, so 'who' reads as Nova and the role stays derived from kind."""
    turn = await _turn(pool)
    assert turn.agent_id is None and turn.role is None
    row = await pool.fetchrow("SELECT agent_id, role FROM turns WHERE id = $1", turn.id)
    assert row["agent_id"] is None and row["role"] is None


async def test_a_turn_for_an_agent_that_does_not_exist_is_refused(pool):
    """An agent_id naming no row is refused by the foreign key before the turn
    exists — never stored as a dangling reference that would attribute work
    to nobody. Nothing is left behind."""
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await traces.open_turn(pool, kind="agent", agent_id=uuid.uuid4(), role="agent_ghost")
    assert await pool.fetchval("SELECT count(*) FROM turns") == 0


async def test_doing_is_set_read_and_cleared_and_close_turn_leaves_it_alone(pool):
    """DOING is what a running turn is doing right now, held only in this
    process. Clearing an id never recorded is a no-op (every exit path may
    call it), reading one is None (idle as far as this process knows), and
    close_turn does not touch it: the scheduler closes reminder/job turns that
    never entered DOING, and chat's close is a detached task that can fail —
    the pop belongs to chat._run_turn's finally, the one line every exit of a
    turn chat ran passes through."""
    unknown = uuid.uuid4()
    assert traces.doing(unknown) is None
    traces.clear_doing(unknown)  # no-op, no error
    assert unknown not in traces.DOING

    turn = await _turn(pool)
    try:
        traces.set_doing(turn.id, "starting")
        assert traces.doing(turn.id) == "starting"
        traces.set_doing(turn.id, "thinking")
        assert traces.doing(turn.id) == "thinking"
        traces.set_doing(turn.id, "get_time")
        assert traces.DOING[turn.id] == "get_time"

        await traces.close_turn(pool, turn, "ok")
        assert traces.doing(turn.id) == "get_time"  # chat owns the pop, not the close

        traces.clear_doing(turn.id)
        assert traces.doing(turn.id) is None
        traces.clear_doing(turn.id)  # idempotent
    finally:
        traces.clear_doing(turn.id)


# -- the owner's Stop (S15) --


async def test_a_stop_can_only_be_asked_of_a_turn_this_process_is_running(pool):
    """STOPPING is derived from INFLIGHT, not a wish anyone can record.

    A stop for a turn no process here is running could never take effect —
    nothing would read the flag — so asking is REFUSED rather than accepted
    and silently dropped. That is the whole difference between a Stop button
    that works and one that returns 200 over nothing.
    """
    turn = await _turn(pool)
    # Not in flight: nothing here is running it, so the ask is refused and
    # records nothing.
    assert traces.ask_to_stop(turn.id, "the owner pressed Stop") is False
    assert traces.stop_requested(turn.id) is None
    assert turn.id not in traces.STOPPING

    traces.INFLIGHT.add(turn.id)
    try:
        assert traces.ask_to_stop(turn.id, "the owner pressed Stop") is True
        assert traces.stop_requested(turn.id) == "the owner pressed Stop"
        # Asking twice keeps the FIRST reason: the turn is already stopping and
        # a second press did not cause it.
        assert traces.ask_to_stop(turn.id, "pressed again") is True
        assert traces.stop_requested(turn.id) == "the owner pressed Stop"
    finally:
        traces.INFLIGHT.discard(turn.id)
        traces.clear_stop(turn.id)

    # Cleared like DOING: by the turn's own finally, idempotently, and for an
    # id never recorded.
    assert traces.stop_requested(turn.id) is None
    traces.clear_stop(uuid.uuid4())  # no-op, no error


async def test_a_stopped_turn_closes_as_stopped_not_interrupted(pool):
    """'interrupted' means NO process was running it — the sweep's word, and
    the scheduler attaches behaviour to it. A deliberate Stop is a different
    fact and gets its own status, so Activity can tell a redeploy from someone
    pressing the button."""
    turn = await _turn(pool)
    await traces.close_turn(pool, turn, "stopped")
    row = await pool.fetchrow("SELECT status, ended_at FROM turns WHERE id = $1", turn.id)
    assert row["status"] == "stopped" and row["ended_at"] is not None
    assert "stopped" in traces.VALID_STATUSES
