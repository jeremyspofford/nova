"""The action ledger (chat-rewind epic, T1).

Every call of a tool that CHANGES something (not reads_only) whose executor was
reached lands one turn_actions row, written by the backend — no tool opts in.
The rows are what a rewind later reads to say what it undid and what it could
not; a call the ledger missed is a revert nobody can ever claim, and a call it
invented is one somebody might. So the rows are filed by traces.close_turn in
the same transaction as the turn's spans: a turn that never closed has neither.
"""

from __future__ import annotations

import json
import uuid

import pytest

from app import chat, tools, traces
from app.identity import Person
from app.tools.base import Tool, ToolContext, ToolFailure
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway

SCHEMA = {
    "type": "object",
    "properties": {"x": {"type": "string"}},
    "additionalProperties": False,
}


def _person() -> Person:
    return Person(id=uuid.uuid4(), name="jeremy", role="owner")


def _ctx(tmp_path, sink: list | None) -> ToolContext:
    return ToolContext(
        app=None,
        person=_person(),
        workspace_root=tmp_path,
        facts_sink=[],
        undo_sink=sink,
    )


def _register(monkeypatch, name: str, executor, *, reads_only: bool = False) -> None:
    monkeypatch.setitem(
        tools.REGISTRY,
        name,
        Tool(
            name=name,
            description="d",
            parameters=SCHEMA,
            executor=executor,
            reads_only=reads_only,
        ),
    )


async def _changer(args: dict, ctx: ToolContext) -> str:
    ctx.undo_sink.append({"was": args.get("x", "absent")})
    return "changed"


async def _changer_no_undo(args: dict, ctx: ToolContext) -> str:
    return "changed, nothing to undo"


async def _failing(args: dict, ctx: ToolContext) -> str:
    raise ToolFailure("could not change it")


async def _reader(args: dict, ctx: ToolContext) -> str:
    return "read"


async def _actions(pool, turn_id) -> list:
    assert await pool.fetchval("SELECT to_regclass('turn_actions')") is not None, (
        "no turn_actions table — migration 040 has not run"
    )
    return await pool.fetch(
        "SELECT turn_id, conversation_id, seq, tool, ok, undo "
        "FROM turn_actions WHERE turn_id = $1 ORDER BY seq",
        turn_id,
    )


def _undo(row):
    value = row["undo"]
    return json.loads(value) if isinstance(value, str) else value


# -- the fields: facts about the call, never a gate ---------------------------


def test_tool_revert_defaults_to_none():
    async def ex(args, ctx):
        return "x"

    tool = Tool(name="t", description="d", parameters=SCHEMA, executor=ex)
    assert "revert" in Tool.__dataclass_fields__
    assert tool.revert is None


def test_tool_context_undo_sink_defaults_to_none(tmp_path):
    assert "undo_sink" in ToolContext.__dataclass_fields__
    ctx = ToolContext(app=None, person=_person(), workspace_root=tmp_path)
    assert ctx.undo_sink is None


def test_turn_carries_an_actions_list():
    turn = traces.Turn(id=uuid.uuid4(), started_at=None)
    assert turn.actions == []


# -- migration 040 -------------------------------------------------------------


async def _columns(pool, table: str) -> dict[str, tuple[str, str]]:
    rows = await pool.fetch(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
        "WHERE table_name = $1",
        table,
    )
    return {r["column_name"]: (r["data_type"], r["is_nullable"]) for r in rows}


async def _fks(pool, table: str) -> dict[str, str]:
    rows = await pool.fetch(
        """
        SELECT kcu.column_name, ccu.table_name AS ref
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_name = kcu.table_name
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1
        """,
        table,
    )
    return {r["column_name"]: r["ref"] for r in rows}


@requires_db
async def test_migration_040_creates_rewinds(pool):
    cols = await _columns(pool, "rewinds")
    assert {
        "id",
        "conversation_id",
        "person_id",
        "target_message_id",
        "mode",
        "created_at",
        "undone",
        "not_undone",
    } <= set(cols)
    assert cols["undone"][0] == "jsonb"
    assert cols["not_undone"][0] == "jsonb"


@requires_db
async def test_rewinds_mode_is_chat_or_executions(pool):
    import asyncpg

    assert await pool.fetchval("SELECT to_regclass('rewinds')") is not None
    defn = await pool.fetchval(
        "SELECT string_agg(pg_get_constraintdef(oid), ' ') FROM pg_constraint "
        "WHERE conrelid = 'rewinds'::regclass AND contype = 'c'"
    )
    assert defn and "chat" in defn and "executions" in defn
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute(
            "INSERT INTO rewinds (conversation_id, person_id, target_message_id, mode) "
            "VALUES (NULL, NULL, NULL, 'everything')"
        )


@requires_db
async def test_migration_040_creates_turn_actions(pool):
    cols = await _columns(pool, "turn_actions")
    assert {
        "id",
        "turn_id",
        "conversation_id",
        "seq",
        "tool",
        "ok",
        "undo",
        "created_at",
        "reverted_by",
        "revert_ok",
        "revert_result",
    } <= set(cols)
    assert cols["undo"] == ("jsonb", "YES")
    assert cols["ok"][0] == "boolean"
    assert cols["reverted_by"][1] == "YES"
    assert cols["revert_ok"] == ("boolean", "YES")
    assert cols["revert_result"][1] == "YES"
    fks = await _fks(pool, "turn_actions")
    assert fks.get("turn_id") == "turns"
    assert fks.get("reverted_by") == "rewinds"


@requires_db
async def test_migration_040_adds_messages_withdrawn_by_and_rewind_id(pool):
    cols = await _columns(pool, "messages")
    assert cols.get("withdrawn_by", (None, None))[1] == "YES"
    assert cols.get("rewind_id", (None, None))[1] == "YES"
    assert "kind" not in cols
    fks = await _fks(pool, "messages")
    assert fks.get("withdrawn_by") == "rewinds"
    assert fks.get("rewind_id") == "rewinds"


# -- the ledger, at the seam it is written ---------------------------------------


@requires_db
async def test_a_changing_call_lands_one_row_carrying_its_undo_payload(pool, monkeypatch, tmp_path):
    _register(monkeypatch, "fake_change", _changer)
    turn = await traces.open_turn(pool)
    ctx = _ctx(tmp_path, [])
    await chat._run_tool(
        turn, ctx, chat.ToolCall(id="c1", name="fake_change", arguments='{"x": "old"}')
    )
    await traces.close_turn(pool, turn, "ok")

    rows = await _actions(pool, turn.id)
    assert len(rows) == 1
    assert rows[0]["tool"] == "fake_change"
    assert rows[0]["ok"] is True
    assert rows[0]["turn_id"] == turn.id
    assert _undo(rows[0]) == {"was": "old"}


@requires_db
async def test_a_failing_changing_call_lands_a_row_with_ok_false_and_no_undo(
    pool, monkeypatch, tmp_path
):
    _register(monkeypatch, "fake_fail", _failing)
    turn = await traces.open_turn(pool)
    ctx = _ctx(tmp_path, [])
    _, ok = await chat._run_tool(
        turn, ctx, chat.ToolCall(id="c1", name="fake_fail", arguments="{}")
    )
    assert ok is False
    await traces.close_turn(pool, turn, "ok")

    rows = await _actions(pool, turn.id)
    assert [(r["tool"], r["ok"], r["undo"]) for r in rows] == [("fake_fail", False, None)]


@requires_db
async def test_a_changing_call_with_no_undo_payload_stores_null(pool, monkeypatch, tmp_path):
    _register(monkeypatch, "fake_plain", _changer_no_undo)
    turn = await traces.open_turn(pool)
    await chat._run_tool(
        turn, _ctx(tmp_path, []), chat.ToolCall(id="c1", name="fake_plain", arguments="{}")
    )
    await traces.close_turn(pool, turn, "ok")
    rows = await _actions(pool, turn.id)
    assert [(r["tool"], r["ok"], r["undo"]) for r in rows] == [("fake_plain", True, None)]


@requires_db
async def test_a_reads_only_call_lands_no_row(pool, monkeypatch, tmp_path):
    _register(monkeypatch, "fake_read", _reader, reads_only=True)
    _register(monkeypatch, "fake_change", _changer)
    turn = await traces.open_turn(pool)
    ctx = _ctx(tmp_path, [])
    await chat._run_tool(turn, ctx, chat.ToolCall(id="c1", name="fake_read", arguments="{}"))
    await chat._run_tool(turn, ctx, chat.ToolCall(id="c2", name="fake_change", arguments="{}"))
    await traces.close_turn(pool, turn, "ok")
    assert [r["tool"] for r in await _actions(pool, turn.id)] == ["fake_change"]


@requires_db
async def test_a_call_refused_before_its_executor_lands_no_row(pool, monkeypatch, tmp_path):
    _register(monkeypatch, "fake_change", _changer)
    turn = await traces.open_turn(pool)
    ctx = _ctx(tmp_path, [])
    # No such tool, then arguments off the schema: neither reached an executor.
    await chat._run_tool(turn, ctx, chat.ToolCall(id="c1", name="no_such_tool", arguments="{}"))
    await chat._run_tool(
        turn, ctx, chat.ToolCall(id="c2", name="fake_change", arguments='{"nope": 1}')
    )
    await chat._run_tool(turn, ctx, chat.ToolCall(id="c3", name="fake_change", arguments="{}"))
    await traces.close_turn(pool, turn, "ok")
    rows = await _actions(pool, turn.id)
    assert [r["tool"] for r in rows] == ["fake_change"]


@requires_db
async def test_a_script_step_lands_its_own_row_and_seq_follows_call_order(
    pool, monkeypatch, tmp_path
):
    _register(monkeypatch, "fake_a", _changer)
    _register(monkeypatch, "fake_b", _changer_no_undo)
    _register(monkeypatch, "fake_read", _reader, reads_only=True)
    turn = await traces.open_turn(pool)
    ctx = _ctx(tmp_path, [])
    await chat._run_tool(turn, ctx, chat.ToolCall(id="c1", name="fake_a", arguments='{"x": "1"}'))
    await chat._run_script_step(turn, ctx, lambda _frame: None, "fake_b", {}, index=0, item=None)
    await chat._run_script_step(turn, ctx, lambda _frame: None, "fake_read", {}, index=1, item=None)
    await chat._run_script_step(
        turn, ctx, lambda _frame: None, "fake_a", {"x": "2"}, index=2, item=None
    )
    await traces.close_turn(pool, turn, "ok")

    rows = await _actions(pool, turn.id)
    assert [r["tool"] for r in rows] == ["fake_a", "fake_b", "fake_a"]
    seqs = [r["seq"] for r in rows]
    assert seqs == sorted(seqs) and len(set(seqs)) == 3
    assert [_undo(r) for r in rows] == [{"was": "1"}, None, {"was": "2"}]


@requires_db
async def test_a_script_step_refused_before_its_executor_lands_no_row(pool, monkeypatch, tmp_path):
    _register(monkeypatch, "fake_a", _changer)
    turn = await traces.open_turn(pool)
    ctx = _ctx(tmp_path, [])
    await chat._run_script_step(
        turn, ctx, lambda _frame: None, "fake_a", {"nope": 1}, index=0, item=None
    )
    await traces.close_turn(pool, turn, "ok")
    assert await _actions(pool, turn.id) == []


async def _changer_twice(args: dict, ctx: ToolContext) -> str:
    ctx.undo_sink.append({"step": 1})
    ctx.undo_sink.append({"step": 2})
    return "changed two things"


@requires_db
async def test_several_undo_entries_in_one_call_are_stored_as_a_list(pool, monkeypatch, tmp_path):
    # CONTRACT (T1 GREEN): one entry is stored as itself, several as a list
    # of them in the order appended — never just the first.
    _register(monkeypatch, "fake_twice", _changer_twice)
    _register(monkeypatch, "fake_change", _changer)
    turn = await traces.open_turn(pool)
    ctx = _ctx(tmp_path, [])
    await chat._run_tool(turn, ctx, chat.ToolCall(id="c1", name="fake_twice", arguments="{}"))
    await chat._run_tool(
        turn, ctx, chat.ToolCall(id="c2", name="fake_change", arguments='{"x": "y"}')
    )
    await traces.close_turn(pool, turn, "ok")
    rows = await _actions(pool, turn.id)
    assert [_undo(r) for r in rows] == [[{"step": 1}, {"step": 2}], {"was": "y"}]


# -- written with the spans, or not at all ------------------------------------


@requires_db
async def test_actions_are_recorded_on_the_turn_and_only_written_by_close_turn(
    pool, monkeypatch, tmp_path
):
    _register(monkeypatch, "fake_change", _changer)
    turn = await traces.open_turn(pool)
    await chat._run_tool(
        turn, _ctx(tmp_path, []), chat.ToolCall(id="c1", name="fake_change", arguments="{}")
    )
    # Recorded synchronously on the turn, written nowhere yet.
    assert [a["tool"] if isinstance(a, dict) else a.tool for a in turn.actions] == ["fake_change"]
    assert await _actions(pool, turn.id) == []
    assert await pool.fetchval("SELECT count(*) FROM turn_spans WHERE turn_id = $1", turn.id) == 0


@requires_db
async def test_close_turn_writes_spans_unchanged_beside_the_actions(pool, monkeypatch, tmp_path):
    _register(monkeypatch, "fake_change", _changer)
    _register(monkeypatch, "fake_read", _reader, reads_only=True)
    turn = await traces.open_turn(pool)
    ctx = _ctx(tmp_path, [])
    await chat._run_tool(turn, ctx, chat.ToolCall(id="c1", name="fake_change", arguments="{}"))
    await chat._run_tool(turn, ctx, chat.ToolCall(id="c2", name="fake_read", arguments="{}"))
    await traces.close_turn(pool, turn, "ok")

    spans = await pool.fetch(
        "SELECT kind, name, meta FROM turn_spans WHERE turn_id = $1 ORDER BY started_at", turn.id
    )
    assert [(s["kind"], s["name"]) for s in spans] == [
        ("tool", "fake_change"),
        ("tool", "fake_read"),
    ]
    for s in spans:
        meta = json.loads(s["meta"]) if isinstance(s["meta"], str) else s["meta"]
        assert meta["ok"] is True and meta["reached_executor"] is True
        # The undo payload is the ledger's, never the trace's.
        assert "undo" not in meta
    assert len(await _actions(pool, turn.id)) == 1


@requires_db
async def test_a_failed_close_writes_neither_spans_nor_actions(pool, monkeypatch, tmp_path):
    _register(monkeypatch, "fake_change", _changer)
    turn = await traces.open_turn(pool)
    await chat._run_tool(
        turn, _ctx(tmp_path, []), chat.ToolCall(id="c1", name="fake_change", arguments="{}")
    )
    # A span that cannot be written (meta is not JSON) aborts the transaction.
    turn.spans.append(
        traces.Span(
            kind="tool", name="bad", started_at=turn.started_at, duration_ms=0, meta=object()
        )
    )
    with pytest.raises(Exception):
        await traces.close_turn(pool, turn, "ok")
    assert await _actions(pool, turn.id) == []
    assert await pool.fetchval("SELECT count(*) FROM turn_spans WHERE turn_id = $1", turn.id) == 0


# -- a real chat turn, through the route ----------------------------------------


def _call(call_id: str, name: str, arguments: dict) -> dict:
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                    ]
                }
            }
        ]
    }


def _text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


@requires_db
async def test_a_chat_turn_lands_its_action_row_with_conversation_and_undo(
    owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "ws"))
    _register(monkeypatch, "fake_change", _changer)
    _register(monkeypatch, "fake_read", _reader, reads_only=True)
    gateway = ScriptedGateway(
        rounds=(
            (_call("c1", "fake_read", {}),),
            (_call("c2", "fake_change", {"x": "before"}),),
            (_text("done"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "change it"})
    assert resp.status_code == 200, resp.text

    turn = await pool.fetchrow("SELECT id, conversation_id, status FROM turns WHERE kind = 'chat'")
    assert turn["status"] == "ok"
    rows = await _actions(pool, turn["id"])
    assert len(rows) == 1
    row = rows[0]
    assert row["tool"] == "fake_change"
    assert row["ok"] is True
    assert row["conversation_id"] == turn["conversation_id"]
    assert row["seq"] is not None
    assert _undo(row) == {"was": "before"}


@requires_db
async def test_an_unwritable_action_rolls_back_the_spans_and_leaves_the_turn_open(
    pool, monkeypatch, tmp_path
):
    # The other half of "one transaction": spans are written FIRST, so only an
    # action that fails to write proves the spans roll back with it.
    _register(monkeypatch, "fake_change", _changer)
    turn = await traces.open_turn(pool)
    await chat._run_tool(
        turn, _ctx(tmp_path, []), chat.ToolCall(id="c1", name="fake_change", arguments="{}")
    )
    assert len(turn.spans) == 1
    turn.actions.append(traces.Action(tool="fake_change", ok=True, undo=object()))
    with pytest.raises(Exception):
        await traces.close_turn(pool, turn, "ok")
    assert await pool.fetchval("SELECT count(*) FROM turn_spans WHERE turn_id = $1", turn.id) == 0
    assert await _actions(pool, turn.id) == []
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) is None
