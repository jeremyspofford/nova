"""Rewind core (chat-rewind epic, T4).

rewinds.rewind(pool, app, person, conversation_id, message_id, mode) takes a
conversation back to one of the owner's own messages. Every later message is
WITHDRAWN (flagged withdrawn_by, never deleted: threads, attachments and
notices hang off message rows); in mode='executions' every recorded action
her turns took after it is reverted newest-first through its tool's verified
Tool.revert, and the result names each one that was NOT undone with the
reason. A revert that raised is never listed as undone. A marker message (a
role='user' row carrying rewind_id, composed in code) tells her next turn what
happened. A running turn makes it refuse, distinguishably, so the route can
answer 409.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import uuid

import asyncpg
import pytest

from app import chat, conversations, queued, rewinds, tools, traces
from app.identity import Person
from app.main import app
from app.tools.base import Tool, ToolContext, ToolFailure
from tests.conftest import TEST_DSN, requires_db
from tests.fakes import FakeGateway, FakeMemory
from tests.test_chat import _set_model

SCHEMA = {"type": "object", "properties": {}, "additionalProperties": False}
T0 = dt.datetime(2026, 10, 6, 12, 0, 0, tzinfo=dt.UTC)


def _at(seconds: float) -> dt.datetime:
    return T0 + dt.timedelta(seconds=seconds)


def _json(value):
    return json.loads(value) if isinstance(value, str) else value


async def _noop(args: dict, ctx: ToolContext) -> str:
    return "ok"


@pytest.fixture
def reverts(monkeypatch):
    """Registers fake changing tools whose reverts record each call in order.

    rw_a / rw_b revert cleanly, rw_raises' revert raises ToolFailure, and
    rw_norevert declares no revert at all."""
    calls: list[tuple[str, dict, ToolContext]] = []

    def _make(name: str):
        async def _revert(payload, ctx):
            calls.append((name, payload, ctx))
            return f"put back {name} {payload.get('n')}"

        return _revert

    async def _raising(payload, ctx):
        calls.append(("rw_raises", payload, ctx))
        raise ToolFailure("the thing is already gone")

    for name, revert in (
        ("rw_a", _make("rw_a")),
        ("rw_b", _make("rw_b")),
        ("rw_raises", _raising),
        ("rw_norevert", None),
    ):
        monkeypatch.setitem(
            tools.REGISTRY,
            name,
            Tool(name=name, description="d", parameters=SCHEMA, executor=_noop, revert=revert),
        )
    return calls


async def _owner(pool) -> Person:
    row = await pool.fetchrow(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id, name, role"
    )
    return Person(id=row["id"], name=row["name"], role=row["role"])


async def _conversation(pool, person: Person) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person.id
    )


async def _msg(pool, cid, role: str, content: str, at: float, turn_id=None) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO messages (conversation_id, role, content, created_at, turn_id) "
        "VALUES ($1, $2, $3, $4, $5) RETURNING id",
        cid,
        role,
        content,
        _at(at),
        turn_id,
    )


async def _turn(pool, cid, at: float, status: str | None = "ok") -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model, status, started_at) "
        "VALUES ('chat', $1, 'm', $2, $3) RETURNING id",
        cid,
        status,
        _at(at),
    )


async def _action(pool, turn_id, cid, seq: int, tool: str, *, ok=True, undo=None) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO turn_actions (turn_id, conversation_id, seq, tool, ok, undo) "
        "VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id",
        turn_id,
        cid,
        seq,
        tool,
        ok,
        None if undo is None else json.dumps(undo),
    )


@pytest.fixture
async def world(pool):
    """One conversation: an early exchange (with one action), the target
    message, then two later turns with actions — plus a second conversation
    whose later action must never be touched."""
    person = await _owner(pool)
    cid = await _conversation(pool, person)
    w = {"person": person, "cid": cid}

    w["t1"] = await _turn(pool, cid, 0.5)
    w["m1"] = await _msg(pool, cid, "user", "first thing", 0)
    w["a1"] = await _action(pool, w["t1"], cid, 0, "rw_a", undo={"n": 1})
    w["m2"] = await _msg(pool, cid, "assistant", "did the first thing", 1, w["t1"])

    w["m3"] = await _msg(pool, cid, "user", "rewrite the plan file", 10)
    w["t3"] = await _turn(pool, cid, 10.5)
    w["a3"] = await _action(pool, w["t3"], cid, 0, "rw_a", undo={"n": 3})
    w["a4"] = await _action(pool, w["t3"], cid, 1, "rw_b", undo={"n": 4})
    w["m4"] = await _msg(pool, cid, "assistant", "rewrote it", 11, w["t3"])

    w["m5"] = await _msg(pool, cid, "user", "and the other one", 20)
    w["t5"] = await _turn(pool, cid, 20.5)
    w["a5"] = await _action(pool, w["t5"], cid, 0, "rw_a", undo={"n": 5})
    w["m6"] = await _msg(pool, cid, "assistant", "done that too", 21, w["t5"])

    other = await _conversation(pool, person)
    w["other"] = other
    ot = await _turn(pool, other, 30)
    w["other_action"] = await _action(pool, ot, other, 0, "rw_a", undo={"n": 99})
    await _msg(pool, other, "user", "elsewhere", 29)
    return w


async def _state(pool) -> dict:
    return {
        "rewinds": await pool.fetchval("SELECT count(*) FROM rewinds"),
        "withdrawn": await pool.fetchval(
            "SELECT count(*) FROM messages WHERE withdrawn_by IS NOT NULL"
        ),
        "markers": await pool.fetchval("SELECT count(*) FROM messages WHERE rewind_id IS NOT NULL"),
        "messages": await pool.fetchval("SELECT count(*) FROM messages"),
        "reverted": await pool.fetchval(
            "SELECT count(*) FROM turn_actions WHERE reverted_by IS NOT NULL "
            "OR revert_ok IS NOT NULL OR revert_result IS NOT NULL"
        ),
    }


async def _rewind(pool, w, message_id, mode="chat"):
    return await rewinds.rewind(pool, app, w["person"], w["cid"], message_id, mode)


async def _refused(pool, w, reverts, message_id, mode="chat", *, conversation_id=None):
    before = await _state(pool)
    with pytest.raises(rewinds.RewindRefused) as info:
        await rewinds.rewind(pool, app, w["person"], conversation_id or w["cid"], message_id, mode)
    assert info.value.reason, "a refusal must state its reason"
    assert await _state(pool) == before, "a refused rewind changed something"
    assert reverts == [], "a refused rewind called a revert"
    return info.value


# -- refusals: stated, and nothing changes ----------------------------------------


@requires_db
async def test_an_unknown_mode_is_refused_and_changes_nothing(pool, world, reverts):
    err = await _refused(pool, world, reverts, world["m3"], mode="everything")
    assert "mode" in err.reason


@requires_db
async def test_a_target_from_another_conversation_is_refused(pool, world, reverts):
    other_msg = await pool.fetchval(
        "SELECT id FROM messages WHERE conversation_id = $1", world["other"]
    )
    await _refused(pool, world, reverts, other_msg, mode="executions")


@requires_db
async def test_a_target_that_does_not_exist_is_refused(pool, world, reverts):
    await _refused(pool, world, reverts, uuid.uuid4())


@requires_db
async def test_an_assistant_target_is_refused(pool, world, reverts):
    await _refused(pool, world, reverts, world["m4"], mode="executions")


@requires_db
async def test_an_already_withdrawn_target_is_refused(pool, world, reverts):
    rid = await pool.fetchval(
        "INSERT INTO rewinds (conversation_id, person_id, target_message_id, mode) "
        "VALUES ($1, $2, $3, 'chat') RETURNING id",
        world["cid"],
        world["person"].id,
        world["m3"],
    )
    await pool.execute("UPDATE messages SET withdrawn_by = $1 WHERE id = $2", rid, world["m5"])
    await _refused(pool, world, reverts, world["m5"])


@requires_db
async def test_a_marker_target_is_refused(pool, world, reverts):
    rid = await pool.fetchval(
        "INSERT INTO rewinds (conversation_id, person_id, target_message_id, mode) "
        "VALUES ($1, $2, $3, 'chat') RETURNING id",
        world["cid"],
        world["person"].id,
        world["m1"],
    )
    marker = await pool.fetchval(
        "INSERT INTO messages (conversation_id, role, content, rewind_id, created_at) "
        "VALUES ($1, 'user', '[rewind] marker', $2, $3) RETURNING id",
        world["cid"],
        rid,
        _at(40),
    )
    await _refused(pool, world, reverts, marker)


@requires_db
async def test_a_busy_conversation_is_refused_distinguishably(pool, world, reverts):
    running = await _turn(pool, world["cid"], 50, status=None)
    traces.INFLIGHT.add(running)
    try:
        err = await _refused(pool, world, reverts, world["m3"], mode="executions")
    finally:
        traces.INFLIGHT.discard(running)
    assert isinstance(err, rewinds.RewindBusy)
    # The other refusals are NOT the busy kind (T5 maps only busy to 409).
    plain = await _refused(pool, world, reverts, world["m4"])
    assert not isinstance(plain, rewinds.RewindBusy)


@requires_db
async def test_the_rewind_waits_for_the_conversation_lock(pool, world, reverts):
    """The busy check and the withdrawal happen under hold_conversation, so a
    send holding the lock is waited for, not raced."""
    holder = await asyncpg.connect(TEST_DSN)
    try:
        tx = holder.transaction()
        await tx.start()
        await queued.hold_conversation(holder, world["cid"])
        task = asyncio.create_task(_rewind(pool, world, world["m3"]))
        await asyncio.sleep(0.5)
        assert not task.done(), "the rewind did not wait for the conversation lock"
        assert (await _state(pool))["withdrawn"] == 0
        await tx.rollback()
        result = await asyncio.wait_for(task, timeout=10)
    finally:
        await holder.close()
    assert result["withdrawn"] == 3


# -- withdrawal --------------------------------------------------------------------


@requires_db
async def test_a_rewind_withdraws_every_later_message_and_deletes_none(pool, world, reverts):
    # A real span on a later turn, so "the audit trail is untouched" compares rows.
    await pool.execute(
        "INSERT INTO turn_spans (turn_id, kind, name, started_at) VALUES ($1, 'tool', 'rw_a', $2)",
        world["t5"],
        _at(20.6),
    )
    turns_before = await pool.fetch("SELECT * FROM turns ORDER BY id")
    spans_before = await pool.fetch("SELECT * FROM turn_spans ORDER BY id")
    count_before = await pool.fetchval("SELECT count(*) FROM messages")

    result = await _rewind(pool, world, world["m3"], "chat")
    rid = result["rewind_id"]

    rows = {
        r["id"]: r["withdrawn_by"]
        for r in await pool.fetch(
            "SELECT id, withdrawn_by FROM messages WHERE conversation_id = $1", world["cid"]
        )
    }
    for later in ("m4", "m5", "m6"):
        assert rows[world[later]] == rid, later
    for kept in ("m1", "m2", "m3"):
        assert rows[world[kept]] is None, kept
    # Nothing deleted: every row is still there (plus the one marker).
    assert await pool.fetchval("SELECT count(*) FROM messages") == count_before + 1
    # The other conversation is untouched.
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM messages WHERE conversation_id = $1 AND withdrawn_by IS NOT NULL",
            world["other"],
        )
        == 0
    )
    # The audit trail is untouched.
    assert await pool.fetch("SELECT * FROM turns ORDER BY id") == turns_before
    assert await pool.fetch("SELECT * FROM turn_spans ORDER BY id") == spans_before


@requires_db
async def test_a_rewind_lands_one_rewinds_row(pool, world, reverts):
    result = await _rewind(pool, world, world["m3"], "chat")
    rows = await pool.fetch("SELECT * FROM rewinds")
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == result["rewind_id"]
    assert row["conversation_id"] == world["cid"]
    assert row["person_id"] == world["person"].id
    assert row["target_message_id"] == world["m3"]
    assert row["mode"] == "chat"


@requires_db
async def test_rows_already_withdrawn_keep_their_first_rewind(pool, world, reverts):
    first = await _rewind(pool, world, world["m5"], "chat")
    assert first["withdrawn"] == 1  # m6
    second = await _rewind(pool, world, world["m3"], "chat")
    m6 = await pool.fetchval("SELECT withdrawn_by FROM messages WHERE id = $1", world["m6"])
    assert m6 == first["rewind_id"], "an already-withdrawn row was re-flagged"
    # m4, m5 and the first marker are withdrawn by the second rewind.
    assert second["withdrawn"] == 3
    for later in ("m4", "m5"):
        assert (
            await pool.fetchval("SELECT withdrawn_by FROM messages WHERE id = $1", world[later])
            == second["rewind_id"]
        )


@requires_db
async def test_a_rewind_with_nothing_after_it_still_writes_a_row_and_a_marker(pool, world, reverts):
    await _rewind(pool, world, world["m5"], "chat")  # withdraws m6
    result = await _rewind(pool, world, world["m5"], "executions")
    assert result["withdrawn"] == 1  # only the first rewind's marker
    assert await pool.fetchval("SELECT count(*) FROM rewinds") == 2
    assert await pool.fetchval("SELECT count(*) FROM messages WHERE rewind_id IS NOT NULL") == 2


# -- mode=chat reverts nothing ------------------------------------------------------


@requires_db
async def test_chat_mode_reverts_nothing(pool, world, reverts):
    result = await _rewind(pool, world, world["m3"], "chat")
    assert reverts == []
    assert result["undone"] == [] and result["not_undone"] == []
    assert result["mode"] == "chat"
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM turn_actions WHERE reverted_by IS NOT NULL "
            "OR revert_ok IS NOT NULL OR revert_result IS NOT NULL"
        )
        == 0
    )
    row = await pool.fetchrow("SELECT undone, not_undone FROM rewinds")
    assert _json(row["undone"]) == [] and _json(row["not_undone"]) == []


# -- mode=executions ---------------------------------------------------------------


@requires_db
async def test_executions_mode_reverts_later_actions_newest_first(pool, world, reverts):
    result = await _rewind(pool, world, world["m3"], "executions")
    assert [(name, payload) for name, payload, _ in reverts] == [
        ("rw_a", {"n": 5}),
        ("rw_b", {"n": 4}),
        ("rw_a", {"n": 3}),
    ]
    assert [u["action_id"] for u in result["undone"]] == [
        str(world["a5"]),
        str(world["a4"]),
        str(world["a3"]),
    ]
    assert result["not_undone"] == []


@requires_db
async def test_executions_mode_records_the_revert_on_each_row(pool, world, reverts):
    result = await _rewind(pool, world, world["m3"], "executions")
    for key, n, tool in (("a3", 3, "rw_a"), ("a4", 4, "rw_b"), ("a5", 5, "rw_a")):
        row = await pool.fetchrow(
            "SELECT reverted_by, revert_ok, revert_result FROM turn_actions WHERE id = $1",
            world[key],
        )
        assert row["reverted_by"] == result["rewind_id"], key
        assert row["revert_ok"] is True, key
        assert row["revert_result"] == f"put back {tool} {n}", key


@requires_db
async def test_actions_before_the_target_or_elsewhere_are_never_reverted(pool, world, reverts):
    await _rewind(pool, world, world["m3"], "executions")
    for key in ("a1", "other_action"):
        row = await pool.fetchrow(
            "SELECT reverted_by, revert_ok, revert_result FROM turn_actions WHERE id = $1",
            world[key],
        )
        assert row["reverted_by"] is None and row["revert_ok"] is None, key
    assert {"n": 1} not in [p for _, p, _ in reverts]
    assert {"n": 99} not in [p for _, p, _ in reverts]


@requires_db
async def test_an_action_already_reverted_is_never_reverted_again(pool, world, reverts):
    first = await _rewind(pool, world, world["m5"], "executions")
    assert [p for _, p, _ in reverts] == [{"n": 5}]
    second = await _rewind(pool, world, world["m3"], "executions")
    assert [p for _, p, _ in reverts] == [{"n": 5}, {"n": 4}, {"n": 3}]
    assert str(world["a5"]) not in [u["action_id"] for u in second["undone"]]
    assert (
        await pool.fetchval("SELECT reverted_by FROM turn_actions WHERE id = $1", world["a5"])
        == first["rewind_id"]
    )


@requires_db
async def test_reverts_run_as_the_person_who_rewound(pool, world, reverts):
    await _rewind(pool, world, world["m3"], "executions")
    assert reverts
    for _, _, ctx in reverts:
        assert isinstance(ctx, ToolContext)
        assert ctx.person == world["person"]


@requires_db
async def test_only_a_revert_that_returned_is_undone_and_one_failure_does_not_stop_the_rest(
    pool, world, reverts
):
    cid, t = world["cid"], await _turn(pool, world["cid"], 25)
    failed = await _action(pool, t, cid, 0, "rw_a", ok=False, undo={"n": 6})
    no_undo = await _action(pool, t, cid, 1, "rw_a", undo=None)
    no_revert = await _action(pool, t, cid, 2, "rw_norevert", undo={"n": 8})
    raises = await _action(pool, t, cid, 3, "rw_raises", undo={"n": 9})
    unknown = await _action(pool, t, cid, 4, "tool_that_is_no_longer_registered", undo={"n": 10})

    result = await _rewind(pool, world, world["m3"], "executions")

    # Only rw_raises' revert was attempted among the new rows; the rest never ran.
    called = [p for _, p, _ in reverts]
    assert {"n": 9} in called
    assert {"n": 6} not in called and {"n": 8} not in called and {"n": 10} not in called
    # The raising revert did not stop the earlier-turn reverts after it.
    assert called[-3:] == [{"n": 5}, {"n": 4}, {"n": 3}]

    undone_ids = {u["action_id"] for u in result["undone"]}
    assert undone_ids == {str(world["a3"]), str(world["a4"]), str(world["a5"])}
    not_undone = {n["action_id"]: n for n in result["not_undone"] if n.get("action_id")}
    for aid, tool in (
        (failed, "rw_a"),
        (no_undo, "rw_a"),
        (no_revert, "rw_norevert"),
        (raises, "rw_raises"),
        (unknown, "tool_that_is_no_longer_registered"),
    ):
        entry = not_undone[str(aid)]
        assert entry["tool"] == tool
        assert entry["reason"], f"{tool} listed not undone without a reason"
    assert "already gone" in not_undone[str(raises)]["reason"]

    row = await pool.fetchrow(
        "SELECT reverted_by, revert_ok, revert_result FROM turn_actions WHERE id = $1", raises
    )
    assert row["reverted_by"] == result["rewind_id"]
    assert row["revert_ok"] is False
    assert "already gone" in row["revert_result"]
    for aid in (failed, no_undo, no_revert, unknown):
        r = await pool.fetchrow(
            "SELECT reverted_by, revert_ok, revert_result FROM turn_actions WHERE id = $1", aid
        )
        assert r["reverted_by"] == result["rewind_id"]
        assert r["revert_ok"] is not True
        # The row itself states why it was not undone, the same reason the result lists.
        assert r["revert_result"], f"{aid} skipped without a stored reason"
        assert r["revert_result"] == not_undone[str(aid)]["reason"]


@requires_db
async def test_an_unclosed_turn_in_range_is_named_as_actions_not_recorded(pool, world, reverts):
    crashed = await _turn(pool, world["cid"], 15, status=None)  # not running: not INFLIGHT/DOING
    result = await _rewind(pool, world, world["m3"], "executions")
    unrecorded = [n for n in result["not_undone"] if n.get("turn_id") == str(crashed)]
    assert len(unrecorded) == 1, result["not_undone"]
    assert "not recorded" in unrecorded[0]["reason"]
    assert unrecorded[0]["tool"] in (None, "unknown")
    # An unclosed turn BEFORE the target is not named.
    early = await _turn(pool, world["cid"], 5, status=None)
    again = await _rewind(pool, world, world["m1"], "executions")
    assert any(n.get("turn_id") == str(early) for n in again["not_undone"])
    assert not any(n.get("turn_id") == str(early) for n in result["not_undone"]), (
        "a turn before the target was named"
    )


# -- the marker and the result ------------------------------------------------------


@requires_db
async def test_the_marker_is_a_user_row_carrying_the_rewind(pool, world, reverts):
    result = await _rewind(pool, world, world["m3"], "chat")
    marker = await pool.fetchrow(
        "SELECT * FROM messages WHERE id = $1", result["marker_message_id"]
    )
    assert marker is not None
    assert marker["conversation_id"] == world["cid"]
    assert marker["role"] == "user"
    assert marker["rewind_id"] == result["rewind_id"]
    assert marker["withdrawn_by"] is None
    latest = await pool.fetchval(
        "SELECT max(created_at) FROM messages WHERE withdrawn_by = $1", result["rewind_id"]
    )
    assert marker["created_at"] > latest
    content = marker["content"]
    assert "rewind" in content.lower()
    assert "rewrite the plan file" in content  # names the target
    assert "3" in content  # the withdrawn count


@requires_db
async def test_the_executions_marker_names_what_was_and_was_not_undone(pool, world, reverts):
    t = await _turn(pool, world["cid"], 25)
    await _action(pool, t, world["cid"], 0, "rw_raises", undo={"n": 9})
    result = await _rewind(pool, world, world["m3"], "executions")
    content = await pool.fetchval(
        "SELECT content FROM messages WHERE id = $1", result["marker_message_id"]
    )
    assert "rw_a" in content and "rw_b" in content
    assert "rw_raises" in content and "already gone" in content


@requires_db
async def test_the_result_matches_the_stored_row(pool, world, reverts):
    t = await _turn(pool, world["cid"], 25)
    await _action(pool, t, world["cid"], 0, "rw_raises", undo={"n": 9})
    result = await _rewind(pool, world, world["m3"], "executions")
    assert set(result) >= {
        "rewind_id",
        "marker_message_id",
        "mode",
        "withdrawn",
        "undone",
        "not_undone",
    }
    assert result["mode"] == "executions"
    assert result["withdrawn"] == 3
    row = await pool.fetchrow("SELECT * FROM rewinds WHERE id = $1", result["rewind_id"])
    assert _json(row["undone"]) == json.loads(json.dumps(result["undone"]))
    assert _json(row["not_undone"]) == json.loads(json.dumps(result["not_undone"]))
    for entry in result["undone"]:
        assert entry["tool"] and entry["line"]
    assert result["not_undone"] and all(n["reason"] for n in result["not_undone"])


@requires_db
async def test_a_revert_that_crashes_is_stated_never_undone_and_the_rest_still_run(
    pool, world, reverts, monkeypatch
):
    """A revert that raises something other than ToolFailure (a bug) is still
    listed not undone with what it raised, and the older reverts still run."""

    async def _crash(payload, ctx):
        reverts.append(("rw_crash", payload, ctx))
        raise RuntimeError("socket closed mid-restore")

    monkeypatch.setitem(
        tools.REGISTRY,
        "rw_crash",
        Tool(name="rw_crash", description="d", parameters=SCHEMA, executor=_noop, revert=_crash),
    )
    t = await _turn(pool, world["cid"], 25)
    crash = await _action(pool, t, world["cid"], 0, "rw_crash", undo={"n": 7})

    result = await _rewind(pool, world, world["m3"], "executions")

    assert [p for _, p, _ in reverts] == [{"n": 7}, {"n": 5}, {"n": 4}, {"n": 3}]
    assert str(crash) not in {u["action_id"] for u in result["undone"]}
    entry = next(n for n in result["not_undone"] if n.get("action_id") == str(crash))
    assert entry["tool"] == "rw_crash"
    assert "socket closed mid-restore" in entry["reason"]
    row = await pool.fetchrow(
        "SELECT revert_ok, revert_result FROM turn_actions WHERE id = $1", crash
    )
    assert row["revert_ok"] is False
    assert "socket closed mid-restore" in row["revert_result"]


@requires_db
async def test_the_marker_sorts_after_a_withdrawn_row_stamped_ahead_of_the_clock(
    pool, world, reverts
):
    """A later row whose stored created_at is ahead of now() (clock skew, a
    fixture) is still before the marker, or the marker would sort among the
    rows it withdrew."""
    future = await _msg(pool, world["cid"], "assistant", "from the future", 365 * 86400)
    result = await _rewind(pool, world, world["m3"], "chat")
    stamped = await pool.fetchval("SELECT created_at FROM messages WHERE id = $1", future)
    assert stamped > await pool.fetchval("SELECT now()")
    marker_at = await pool.fetchval(
        "SELECT created_at FROM messages WHERE id = $1", result["marker_message_id"]
    )
    assert marker_at > stamped


@requires_db
async def test_the_executions_marker_names_an_unclosed_turn(pool, world, reverts):
    await _turn(pool, world["cid"], 15, status=None)
    result = await _rewind(pool, world, world["m3"], "executions")
    content = await pool.fetchval(
        "SELECT content FROM messages WHERE id = $1", result["marker_message_id"]
    )
    assert "not recorded" in content


# -- T10: no turn opens between the withdrawal and the marker ----------------------
#
# The window: rewind() has committed the withdrawal, is running its reverts
# (here a fake revert parked on an asyncio.Event), and has not yet written the
# marker. A turn opened in that window would read a history with the later
# rows gone and NO marker saying why, and would act while files are still
# being put back. Every test opens the window deterministically (it waits for
# the revert to be entered), acts, then releases it.

# Before any real clock this suite runs under, so every seeded row sorts before
# the marker (stamped now()) and the user row of any turn opened afterwards.
RACE_T0 = dt.datetime(2026, 10, 1, 9, 0, 0, tzinfo=dt.UTC)


def _race_at(seconds: float) -> dt.datetime:
    return RACE_T0 + dt.timedelta(seconds=seconds)


@pytest.fixture
async def race(owner_client, pool, mount_peers, monkeypatch):
    """The registered owner's hallway: an early exchange, the target message,
    and one later turn whose single action is rw_slow -- a revertible fake
    whose revert parks until `release` is set (and then raises `fail` if a
    test set one)."""
    gateway = FakeGateway(deltas=("on it",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)
    row = await pool.fetchrow("SELECT id, name, role FROM people WHERE role = 'owner'")
    person = Person(id=row["id"], name=row["name"], role=row["role"])
    resp = await owner_client.get("/api/v1/conversations/active")
    assert resp.status_code == 200
    cid = uuid.UUID(resp.json()["id"])
    tag = uuid.uuid4().hex[:8]
    w: dict = {
        "client": owner_client,
        "gateway": gateway,
        "person": person,
        "cid": cid,
        "tag": tag,
        "entered": asyncio.Event(),
        "release": asyncio.Event(),
        "fail": None,
        "late_reply": f"WITHDRAWN reply {tag}",
    }

    async def _m(role, content, at, turn_id=None):
        return await pool.fetchval(
            "INSERT INTO messages (conversation_id, role, content, created_at, turn_id) "
            "VALUES ($1, $2, $3, $4, $5) RETURNING id",
            cid,
            role,
            content,
            _race_at(at),
            turn_id,
        )

    w["m1"] = await _m("user", f"early question {tag}", 0)
    w["m2"] = await _m("assistant", f"early answer {tag}", 1)
    w["m3"] = await _m("user", f"rewrite the plan file {tag}", 10)
    w["t3"] = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model, status, started_at) "
        "VALUES ('chat', $1, 'm', 'ok', $2) RETURNING id",
        cid,
        _race_at(10.5),
    )
    w["a3"] = await _action(pool, w["t3"], cid, 0, "rw_slow", undo={"n": 3})
    w["m4"] = await _m("assistant", w["late_reply"], 11, w["t3"])

    async def _slow(payload, ctx):
        w["entered"].set()
        await w["release"].wait()
        if w["fail"] is not None:
            raise w["fail"]
        return "put back the plan file"

    monkeypatch.setitem(
        tools.REGISTRY,
        "rw_slow",
        Tool(name="rw_slow", description="d", parameters=SCHEMA, executor=_noop, revert=_slow),
    )
    return w


async def _open_window(pool, w, *, via_route: bool = False) -> asyncio.Task:
    """Start an executions rewind to m3 and return once its revert is parked:
    the withdrawal has committed and the marker has not been written."""
    if via_route:
        coro = w["client"].post(
            f"/api/v1/conversations/{w['cid']}/rewind",
            json={"message_id": str(w["m3"]), "mode": "executions"},
        )
    else:
        coro = rewinds.rewind(pool, app, w["person"], w["cid"], w["m3"], "executions")
    task = asyncio.ensure_future(coro)
    entered = asyncio.ensure_future(w["entered"].wait())
    await asyncio.wait({task, entered}, timeout=10, return_when=asyncio.FIRST_COMPLETED)
    if not entered.done():
        entered.cancel()
        if task.done():
            task.result()  # raises what the rewind raised
        task.cancel()
        pytest.fail("the rewind never reached its revert")
    assert not task.done(), "the rewind finished without waiting for its revert"
    assert await pool.fetchval(
        "SELECT count(*) FROM messages WHERE withdrawn_by IS NOT NULL AND conversation_id = $1",
        w["cid"],
    ), "the window opens only after the withdrawal commits"
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM messages WHERE rewind_id IS NOT NULL AND conversation_id = $1",
            w["cid"],
        )
        == 0
    ), "the marker landed before the revert finished"
    return task


async def _close_window(w, task: asyncio.Task):
    """Let the revert finish, wait for the rewind and everything it fired."""
    w["release"].set()
    try:
        return await asyncio.wait_for(task, timeout=15)
    finally:
        await asyncio.wait_for(chat.drain_background(), timeout=15)


async def _send(w, message: str):
    return await w["client"].post(
        "/api/v1/chat/stream", json={"message": message, "conversation_id": str(w["cid"])}
    )


async def _send_settled(w, message: str):
    """POST a message and wait for the detached work THAT post fired (the
    drain a 202 spawns, or a started turn) -- never for the rewind itself."""
    before = set(chat._BACKGROUND)
    resp = await _send(w, message)
    await asyncio.wait_for(chat.settle_detached(before), timeout=15)
    return resp


async def _waiting_bodies(pool, cid) -> list[str]:
    rows = await pool.fetch(
        "SELECT body FROM queued_messages WHERE conversation_id = $1 "
        "AND claimed_at IS NULL AND cancelled_at IS NULL ORDER BY seq",
        cid,
    )
    return [r["body"] for r in rows]


def _gateway_history_for(gateway, message: str) -> list[dict]:
    """The user/assistant rows the gateway was handed before `message`."""
    for _, body in gateway.seen:
        if not isinstance(body, dict) or "messages" not in body:
            continue
        rows = [m for m in body["messages"] if m["role"] in ("user", "assistant")]
        if rows and isinstance(rows[-1]["content"], str) and rows[-1]["content"].endswith(message):
            return rows[:-1]
    raise AssertionError(f"no model call carried {message!r}")


@requires_db
async def test_a_message_sent_mid_rewind_is_queued_and_opens_no_turn(pool, race):
    w = race
    message = f"so where were we? {w['tag']}"
    task = await _open_window(pool, w)
    try:
        resp = await _send_settled(w, message)
        assert resp.status_code == 202, (resp.status_code, resp.text[:200])
        assert resp.json()["queued"]["body"] == message
        assert await _waiting_bodies(pool, w["cid"]) == [message]
        assert (
            await pool.fetchval(
                "SELECT count(*) FROM turns WHERE conversation_id = $1 AND status IS NULL",
                w["cid"],
            )
            == 0
        ), "a turn opened while the rewind was still reverting"
        assert (
            await pool.fetchval("SELECT count(*) FROM messages WHERE content = $1", message) == 0
        ), "his message landed as a user row before the marker"
    finally:
        await _close_window(w, task)


@requires_db
async def test_the_queued_message_runs_after_the_marker_and_reads_its_final_text(pool, race):
    w = race
    message = f"so where were we? {w['tag']}"
    task = await _open_window(pool, w, via_route=True)
    try:
        await _send_settled(w, message)
    finally:
        resp = await _close_window(w, task)
    assert resp.status_code == 200, resp.text
    marker = await pool.fetchrow(
        "SELECT id, content, created_at FROM messages WHERE rewind_id IS NOT NULL "
        "AND conversation_id = $1",
        w["cid"],
    )
    assert "Undone: rw_slow (put back the plan file)" in marker["content"]
    sent = await pool.fetch(
        "SELECT created_at FROM messages WHERE role = 'user' AND content = $1", message
    )
    assert len(sent) == 1, "the queued message did not run exactly once"
    assert sent[0]["created_at"] > marker["created_at"], "her turn opened before the marker"
    history = _gateway_history_for(w["gateway"], message)
    seen = "\n".join(m["content"] for m in history)
    assert marker["content"] in seen, "her turn did not read the marker's final text"
    assert w["late_reply"] not in seen, "a withdrawn row reached her turn"


@requires_db
async def test_a_message_queued_during_the_window_is_drained_once_the_marker_lands(pool, race):
    """Nothing else will free it: no turn is running, so no turn's ending
    drains it. The rewind itself must, after the marker commits."""
    w = race
    message = f"queued in the gap {w['tag']}"
    task = await _open_window(pool, w, via_route=True)
    try:
        await queued.enqueue_for_test(pool, w["cid"], w["person"].id, message)
    finally:
        resp = await _close_window(w, task)
    assert resp.status_code == 200, resp.text
    assert await _waiting_bodies(pool, w["cid"]) == [], "the queued message was never run"
    claim = await pool.fetchrow(
        "SELECT claimed_at, turn_id, cancelled_at FROM queued_messages WHERE body = $1", message
    )
    assert claim["claimed_at"] is not None and claim["turn_id"] is not None
    assert claim["cancelled_at"] is None
    marker_at = await pool.fetchval(
        "SELECT created_at FROM messages WHERE rewind_id IS NOT NULL AND conversation_id = $1",
        w["cid"],
    )
    sent_at = await pool.fetchval(
        "SELECT created_at FROM messages WHERE role = 'user' AND content = $1", message
    )
    assert sent_at > marker_at


@requires_db
async def test_a_drain_during_the_window_starts_nothing(pool, race):
    w = race
    message = f"drained too early {w['tag']}"
    turns_before = await pool.fetchval("SELECT count(*) FROM turns")
    task = await _open_window(pool, w)
    try:
        await queued.enqueue_for_test(pool, w["cid"], w["person"].id, message)
        before = set(chat._BACKGROUND)
        await chat.drain_queue(app, pool, w["cid"])
        await asyncio.wait_for(chat.settle_detached(before), timeout=15)
        assert await pool.fetchval("SELECT count(*) FROM turns") == turns_before, (
            "the drain opened a turn while the rewind was still reverting"
        )
        assert await _waiting_bodies(pool, w["cid"]) == [message]
        assert await pool.fetchval("SELECT count(*) FROM messages WHERE content = $1", message) == 0
    finally:
        await _close_window(w, task)


@requires_db
async def test_a_second_rewind_in_the_window_is_refused_busy_and_changes_nothing(pool, race):
    w = race
    task = await _open_window(pool, w)
    try:
        before = await _state(pool)
        with pytest.raises(rewinds.RewindBusy) as info:
            await rewinds.rewind(pool, app, w["person"], w["cid"], w["m1"], "chat")
        assert info.value.reason
        assert await _state(pool) == before, "a refused second rewind changed something"
    finally:
        await _close_window(w, task)


@requires_db
async def test_a_second_rewind_posted_in_the_window_answers_409(pool, race):
    w = race
    task = await _open_window(pool, w)
    try:
        before = await _state(pool)
        resp = await w["client"].post(
            f"/api/v1/conversations/{w['cid']}/rewind",
            json={"message_id": str(w["m1"]), "mode": "chat"},
        )
        assert resp.status_code == 409, resp.text
        assert isinstance(resp.json()["error"], str) and resp.json()["error"]
        assert await _state(pool) == before
    finally:
        await _close_window(w, task)


@requires_db
async def test_the_conversation_lock_is_not_held_across_the_reverts(pool, race):
    w = race
    task = await _open_window(pool, w)
    try:
        other = await asyncpg.connect(TEST_DSN)
        try:
            async with other.transaction():
                got = await other.fetchval(
                    "SELECT pg_try_advisory_xact_lock($1)", queued._lock_key(w["cid"])
                )
        finally:
            await other.close()
        assert got is True, "the rewind held the conversation's lock across a revert"
    finally:
        await _close_window(w, task)


async def _reads_free(pool, w) -> None:
    """Not busy, a send starts a turn, and a later rewind is not refused busy."""
    assert not await conversations.conversation_busy(pool, w["cid"])
    assert not await conversations.person_busy(pool, w["person"].id)
    resp = await _send(w, f"anyone there? {w['tag']}")
    assert resp.status_code == 200, (resp.status_code, resp.text[:200])
    await asyncio.wait_for(chat.drain_background(), timeout=15)
    again = await rewinds.rewind(pool, app, w["person"], w["cid"], w["m1"], "chat")
    assert again["rewind_id"]


@requires_db
@pytest.mark.parametrize(
    "fail",
    [ToolFailure("the plan file changed since"), RuntimeError("socket closed mid-restore")],
    ids=["refused", "crashed"],
)
async def test_the_window_closes_when_a_revert_raises(pool, race, fail):
    w = race
    w["fail"] = fail
    task = await _open_window(pool, w)
    result = await _close_window(w, task)
    assert [n["tool"] for n in result["not_undone"]] == ["rw_slow"]
    await _reads_free(pool, w)


@requires_db
async def test_the_window_closes_when_the_marker_write_raises(pool, race, monkeypatch):
    w = race

    def _broken(*args, **kwargs):
        raise RuntimeError("could not compose the marker")

    monkeypatch.setattr(rewinds, "_marker_content", _broken)
    task = await _open_window(pool, w)
    with pytest.raises(RuntimeError, match="could not compose the marker"):
        await _close_window(w, task)
    monkeypatch.undo()
    await _reads_free(pool, w)


@requires_db
@pytest.mark.parametrize("why", ["bad_mode", "bad_target", "busy"])
async def test_a_refused_rewind_never_opens_the_window(pool, race, why):
    w = race
    running = None
    if why == "busy":
        running = await pool.fetchval(
            "INSERT INTO turns (kind, conversation_id, model, status, started_at) "
            "VALUES ('chat', $1, 'm', NULL, $2) RETURNING id",
            w["cid"],
            _race_at(30),
        )
        traces.INFLIGHT.add(running)
    try:
        mode = "everything" if why == "bad_mode" else "executions"
        target = w["m4"] if why == "bad_target" else w["m3"]
        with pytest.raises(rewinds.RewindRefused):
            await rewinds.rewind(pool, app, w["person"], w["cid"], target, mode)
    finally:
        if running is not None:
            traces.INFLIGHT.discard(running)
            await pool.execute("UPDATE turns SET status = 'error' WHERE id = $1", running)
    assert not w["entered"].is_set()
    await _reads_free(pool, w)


@requires_db
async def test_the_window_stays_shut_until_the_marker_commits(pool, race, monkeypatch):
    """The reverts are done and the marker text is composed, but the marker
    has not committed (another connection holds the rewinds row, so the
    outcome write waits on it). A send in that last gap still queues and opens
    no turn, and runs only once the marker is in. Pins the window's END: one
    closed after the reverts but before the marker commit lets a turn read a
    history with the rows gone and no marker."""
    w = race
    message = f"right after the reverts {w['tag']}"
    composed = asyncio.Event()
    compose = rewinds._marker_content

    def _composing(*args, **kwargs):
        text = compose(*args, **kwargs)
        composed.set()
        return text

    monkeypatch.setattr(rewinds, "_marker_content", _composing)
    task = await _open_window(pool, w)
    blocker = await asyncpg.connect(TEST_DSN)
    held = blocker.transaction()
    await held.start()
    try:
        assert await blocker.fetchval(
            "SELECT count(*) FROM (SELECT id FROM rewinds WHERE conversation_id = $1 FOR UPDATE) r",
            w["cid"],
        )
        w["release"].set()
        await asyncio.wait_for(composed.wait(), timeout=10)
        assert not task.done()
        assert (
            await pool.fetchval(
                "SELECT count(*) FROM messages WHERE rewind_id IS NOT NULL "
                "AND conversation_id = $1",
                w["cid"],
            )
            == 0
        ), "the marker committed past the held rewinds row"
        resp = await _send_settled(w, message)
        assert resp.status_code == 202, (resp.status_code, resp.text[:200])
        assert await _waiting_bodies(pool, w["cid"]) == [message]
        assert (
            await pool.fetchval(
                "SELECT count(*) FROM turns WHERE conversation_id = $1 AND status IS NULL",
                w["cid"],
            )
            == 0
        ), "a turn opened before the marker committed"
        assert await pool.fetchval("SELECT count(*) FROM messages WHERE content = $1", message) == 0
    finally:
        await held.rollback()
        await blocker.close()
        await _close_window(w, task)
    marker_at = await pool.fetchval(
        "SELECT created_at FROM messages WHERE rewind_id IS NOT NULL AND conversation_id = $1",
        w["cid"],
    )
    sent_at = await pool.fetchval(
        "SELECT created_at FROM messages WHERE role = 'user' AND content = $1", message
    )
    assert sent_at is not None and sent_at > marker_at
