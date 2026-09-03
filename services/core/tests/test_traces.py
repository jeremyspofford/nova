"""The turn ledger writes once, completely, or not at all — and every turn
reaches a terminal status, even when the process that ran it did not."""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

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
            row = await pool.fetchrow(
                "SELECT status, ended_at FROM turns WHERE id = $1", turn_id
            )
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
