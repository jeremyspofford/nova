"""S38b T1: every tool result she is sent is kept in full, for the life of
its turn's trace.

The span keeps only the first SPAN_RESULT_HEAD_CHARS of a result. S38b
summarizes old results out of what is SENT, so the full text has to live
somewhere she can read it back from: a `tool_results` row per call (turn id,
ref r1..rN in call order, tool call id, tool, content, chars), written by
close_turn in its one transaction beside the spans, and deleted with the turn.
While chat runs the turn the same results are in a process-local map
(traces.results_of), so a later call in the SAME turn can read them before
any row exists.

The chat-flow tests drive the real route through a scripted gateway and
assert on what the gateway RECEIVED and what the database holds.
"""

from __future__ import annotations

import json
import uuid

import asyncpg
import pytest

from app import traces
from app.traces import SPAN_RESULT_HEAD_CHARS
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway

pytestmark = requires_db

ASK = "compare the two logs in my workspace"


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def calls(*specs: tuple[str, str, dict]) -> dict:
    """One assistant message carrying several tool calls, in this order."""
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                        for call_id, name, arguments in specs
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ]
    }


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


def _write(workspace, name: str, marker: str, chars: int) -> str:
    line = f"{marker} line of a log that is long enough to matter\n"
    body = (line * (chars // len(line) + 1))[:chars]
    (workspace / name).write_text(body, encoding="utf-8")
    return body


async def _say(client, message: str) -> None:
    resp = await client.put("/api/v1/settings", json={"key": "chat.model", "value": "qwen3:8b"})
    assert resp.status_code == 200, resp.text
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text


def _two_reads() -> ScriptedGateway:
    return ScriptedGateway(
        rounds=(
            (
                calls(
                    ("c1", "workspace_read_file", {"path": "first.log"}),
                    ("c2", "workspace_read_file", {"path": "second.log"}),
                ),
            ),
            (text("the second log failed first."),),
        ),
        served_by=f"dell:qwen3:8b-{uuid.uuid4().hex[:8]}",
    )


async def _kept(pool, turn_id) -> list:
    return await pool.fetch(
        "SELECT ref, tool_call_id, tool, content, chars FROM tool_results "
        "WHERE turn_id = $1 ORDER BY ref",
        turn_id,
    )


async def _bare_turn(pool) -> traces.Turn:
    person = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('owner', 'owner') RETURNING id"
    )
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
    )
    return await traces.open_turn(pool, conversation_id=conversation, model="qwen3:8b")


# -- C1: two calls, two rows, in full, in call order ------------------------


async def test_a_turn_with_two_tool_calls_keeps_both_results_in_full(
    owner_client, pool, mount_peers, workspace
):
    first = _write(workspace, "first.log", "alpha", 3_000)
    second = _write(workspace, "second.log", "omega", 4_500)
    gateway = _two_reads()
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    turn_id = await pool.fetchval("SELECT id FROM turns WHERE kind = 'chat'")
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn_id) == "ok"
    rows = await _kept(pool, turn_id)
    assert [r["ref"] for r in rows] == ["r1", "r2"]
    assert [r["tool_call_id"] for r in rows] == ["c1", "c2"]
    assert [r["tool"] for r in rows] == ["workspace_read_file", "workspace_read_file"]
    # Exactly what the next round SENT her, whole — not the span's head.
    sent = {
        m["tool_call_id"]: m["content"]
        for m in gateway.payloads[1]["messages"]
        if m.get("role") == "tool"
    }
    assert rows[0]["content"] == sent["c1"] and first in rows[0]["content"]
    assert rows[1]["content"] == sent["c2"] and second in rows[1]["content"]
    for row in rows:
        assert len(row["content"]) > SPAN_RESULT_HEAD_CHARS
        assert row["chars"] == len(row["content"])
    # The span still carries only its head: the full text lives in the row.
    heads = await pool.fetch(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND kind = 'tool' ORDER BY started_at",
        turn_id,
    )
    assert all(len(h["meta"]["result_head"]) <= SPAN_RESULT_HEAD_CHARS for h in heads)


# -- C5: the live map holds them while the turn runs, cleared after ---------


async def test_the_live_results_are_readable_during_the_turn_and_gone_after(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    _write(workspace, "first.log", "alpha", 3_000)
    _write(workspace, "second.log", "omega", 4_500)
    gateway = _two_reads()
    mount_peers(gateway=gateway, memory=FakeMemory())

    seen: dict = {}
    real_clear = traces.clear_results

    def spy(turn_id):
        # The state the map held at the moment _run_turn's finally clears it.
        live = traces.results_of(turn_id)
        seen[turn_id] = None if live is None else [(r.ref, r.tool_call_id) for r in live]
        real_clear(turn_id)

    monkeypatch.setattr(traces, "clear_results", spy)

    await _say(owner_client, ASK)

    turn_id = await pool.fetchval("SELECT id FROM turns WHERE kind = 'chat'")
    assert seen == {turn_id: [("r1", "c1"), ("r2", "c2")]}
    assert traces.results_of(turn_id) is None
    assert turn_id not in traces.RESULTS


async def test_a_turn_chat_never_ran_keeps_results_on_the_turn_but_never_enters_the_map(pool):
    turn = await _bare_turn(pool)
    traces.keep_result(turn, "c9", "web_search", "x" * 900)
    assert [r.ref for r in turn.tool_results] == ["r1"]
    assert traces.results_of(turn.id) is None


def test_keeping_a_result_is_synchronous_and_numbers_refs_in_call_order():
    turn = traces.Turn(id=uuid.uuid4(), started_at=traces.datetime.now(traces.UTC))
    traces.track_results(turn)
    try:
        a = traces.keep_result(turn, "c1", "browser_read", "a" * 1000)
        b = traces.keep_result(turn, "c2", "web_search", "b" * 10)
        assert (a.ref, b.ref) == ("r1", "r2")
        assert (a.chars, b.chars) == (1000, 10)
        # The map holds the turn's OWN list: a later append is visible at once.
        assert traces.results_of(turn.id) is turn.tool_results
        c = traces.keep_result(turn, "c3", "browser_read", "c")
        assert [r.ref for r in traces.results_of(turn.id)] == ["r1", "r2", "r3"]
        assert c.tool_call_id == "c3"
    finally:
        traces.clear_results(turn.id)
    assert traces.results_of(turn.id) is None
    traces.clear_results(turn.id)  # a second clear is a no-op


# -- C2/C3/C4/C6: close_turn writes them in its one transaction ---------------


async def test_close_turn_writes_the_kept_results(pool):
    turn = await _bare_turn(pool)
    big = "line of output\n" * 400
    traces.keep_result(turn, "c1", "browser_read", big)
    traces.keep_result(turn, "c2", "web_search", "short")

    await traces.close_turn(pool, turn, "ok")

    rows = await _kept(pool, turn.id)
    assert [(r["ref"], r["tool_call_id"], r["tool"]) for r in rows] == [
        ("r1", "c1", "browser_read"),
        ("r2", "c2", "web_search"),
    ]
    assert rows[0]["content"] == big and rows[0]["chars"] == len(big)
    assert rows[1]["content"] == "short" and rows[1]["chars"] == 5


async def test_a_failed_close_writes_no_kept_results(pool):
    turn = await _bare_turn(pool)
    traces.keep_result(turn, "c1", "browser_read", "z" * 2000)
    # An action the database will refuse (tool is NOT NULL) — written AFTER
    # the results in close_turn, so a result row that escaped the transaction
    # would still be there.
    turn.actions.append(traces.Action(tool=None, ok=True))

    with pytest.raises(Exception):
        await traces.close_turn(pool, turn, "ok")

    assert await _kept(pool, turn.id) == []
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) is None


async def test_deleting_the_turn_deletes_its_kept_results(pool):
    turn = await _bare_turn(pool)
    traces.keep_result(turn, "c1", "browser_read", "y" * 700)
    await traces.close_turn(pool, turn, "ok")
    assert len(await _kept(pool, turn.id)) == 1

    await pool.execute("DELETE FROM turns WHERE id = $1", turn.id)

    assert await pool.fetchval("SELECT count(*) FROM tool_results") == 0


async def test_a_result_with_a_nul_byte_never_fails_the_close(pool):
    turn = await _bare_turn(pool)
    raw = "before\x00after" + "." * 600
    traces.keep_result(turn, "c1", "workspace_read_file", raw)

    await traces.close_turn(pool, turn, "ok")

    rows = await _kept(pool, turn.id)
    assert rows[0]["content"] == raw.replace("\x00", "�")
    assert rows[0]["chars"] == len(raw)
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) == "ok"


async def test_the_table_refuses_a_ref_out_of_shape_and_a_wrong_count(pool):
    turn = await _bare_turn(pool)
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute(
            "INSERT INTO tool_results (turn_id, ref, tool, content, chars) "
            "VALUES ($1, 'x1', 't', 'abc', 3)",
            turn.id,
        )
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute(
            "INSERT INTO tool_results (turn_id, ref, tool, content, chars) "
            "VALUES ($1, 'r1', 't', 'abc', 4)",
            turn.id,
        )


# -- A1: the kept text is scrubbed like the span ----------------------------


async def test_a_credential_the_arguments_masked_never_reaches_the_kept_result(
    pool, mount_peers, monkeypatch
):
    """A token pasted as an argument KEY is masked out of the span's arguments,
    and a refusal echoing it is scrubbed from the span's head
    (test_span_masking). The kept full text gets the same scrub. The refusal
    is scripted so the echo is certain: a store that stops echoing must not
    turn this test into a pass that proves nothing."""
    from app import tools
    from tests.test_span_masking import _TOKEN, _nova_turn, _owner, _raw_call

    async def echoing_dispatch(name, arguments, ctx, *, reached=None):
        if reached is not None:
            reached.append(name)
        return f"{tools.ERROR_PREFIX}unknown argument {_TOKEN!r}", False

    monkeypatch.setattr(tools, "dispatch", echoing_dispatch)
    owner = await _owner(pool)
    raw = json.dumps({"name": "gh", "url": "http://gh.mcp.invalid/mcp", _TOKEN: "x"})
    gateway = ScriptedGateway(
        rounds=((_raw_call("mcp_connect", raw),), (text("That did not work."),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn, _ = await _nova_turn(pool, owner, "connect github")

    rows = await _kept(pool, turn.id)
    assert [r["tool"] for r in rows] == ["mcp_connect"]
    assert _TOKEN not in rows[0]["content"]
    assert "unknown argument" in rows[0]["content"]
