"""The turn ledger writes once, completely, or not at all."""
from __future__ import annotations

import pytest

from app import traces
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
