"""T3 (own-tool-handback epic, 2026-10-10): the current-change warning — never a refusal.

The incident (turn c9ba8d70, dell:qwen3:8b): start_change returned the new
worktree .../.worktrees/nova-3ff482, then she aimed device_edit_file at
.../.worktrees/nova-3e8ab0/README.md — an OLDER change's worktree from a
previous turn. Under the 09-03 no-approvals ruling the call STILL RUNS; its
result ends with a stated warning naming the change she started this turn, and
the trace marks it (the same facts_sink seam as S29's outside_worktree and
walk-fixes T4's not_the_worktree).

Criteria:
  C1 after start_change this turn (its fact carries "started": True),
     device_edit_file / device_write_file (path) and device_run (cwd or argv)
     aimed inside a DIFFERENT <repo>/.worktrees/nova-<id> run (the frame is
     sent) and the result's LAST line is the warning; the fact
     {"other_change_worktree": <other>, "tool": <name>} lands on facts_sink
     with no "device" key; a failed call states it in its failure too.
  C2 chat._run_tool sets span.meta["other_change_worktree"] = True when THIS
     call's facts slice holds that fact; ok as the agent answered, no error.
  C3 silent: same worktree; no start_change this turn; a change only listed
     (list_changes' fact has no "started"); reads; a path off .worktrees.
  C4 start_change's fact gains "started": True (pinned in test_start_change).

Assumptions: list_changes sets no marker (A1); the last start_change of the
turn is current; "other" is derived from the current path's
<repo>/.worktrees/nova- prefix alone (A2); warn after the frame answered (A3).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime

import pytest

from app import chat, tools, traces
from tests.conftest import requires_db
from tests.test_devices_ws import _close, _connect, _ctx, _person

pytestmark = requires_db

REPO = "/home/jeremy/workspace/nova"
CURRENT = f"{REPO}/.worktrees/nova-3ff482"
OLD = f"{REPO}/.worktrees/nova-3e8ab0"
STARTED = {
    "change": "3ff482",
    "worktree_path": CURRENT,
    "branch": "nova/3ff482-edit-test-2",
    "started": True,
}
LISTED = {"change": "3e8ab0", "worktree_path": OLD, "branch": "nova/3e8ab0-edit-test"}
EDIT_META = {"matches": 1, "bytes_before": 120, "bytes_after": 131}


def _warning(other: str) -> str:
    return f"Warning: the change you started this turn is {CURRENT}; this touched {other}."


@pytest.fixture(autouse=True)
def _no_checkout(monkeypatch):
    """The outside-worktree flag is not under test here; keep it off."""
    monkeypatch.delenv("NOVA_CHECKOUT", raising=False)
    monkeypatch.delenv("NOVA_REPO_HOST", raising=False)


async def _call(pool, conn, device, tool, args, facts, *, ok=True, error=None, meta=None):
    """Dispatch `tool` with `facts` as the turn's sink (what earlier calls left
    there), answer its one frame; returns (result, ok, frames sent)."""
    person = await _person(pool)
    sent: list[dict] = []

    async def answer():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        assert frame["type"] == "command"
        sent.append(frame)
        reply = device.result(frame["envelope"], ok=ok, output="done", error=error)
        if meta is not None:
            reply["meta"] = meta
        conn.feed(reply)

    ans = asyncio.create_task(answer())
    result, dispatched_ok = await tools.dispatch(tool, args, _ctx(person, facts=facts))
    await asyncio.wait_for(ans, 2)
    return result, dispatched_ok, sent


def _flags(facts: list[dict]) -> list[dict]:
    return [f for f in facts if "other_change_worktree" in f]


def _edit(path: str) -> dict:
    return {"device": "mini-pc", "path": path, "old": "# Nova", "new": "# Nova edited"}


# -- C1: the c9ba8d70 shape and its siblings ------------------------------------


async def test_c1_the_incident_edit_on_the_old_worktree_runs_and_is_warned(pool):
    _id, device, conn, task = await _connect(pool, name="mini-pc")
    facts = [dict(STARTED)]
    result, ok, sent = await _call(
        pool, conn, device, "device_edit_file", _edit(f"{OLD}/README.md"), facts, meta=EDIT_META
    )
    assert ok is True, result  # it ran: never a refusal
    assert sent and sent[0]["envelope"]["args"]["path"] == f"{OLD}/README.md"
    assert result.splitlines()[-1] == _warning(OLD)
    assert _flags(facts) == [{"other_change_worktree": OLD, "tool": "device_edit_file"}]
    assert all("device" not in f for f in _flags(facts))
    await _close(conn, task)


async def test_c1_the_incident_failed_edit_still_states_the_warning(pool):
    """c9ba8d70's edit was refused by the agent ("found 2 matches")."""
    _id, device, conn, task = await _connect(pool, name="mini-pc")
    facts = [dict(STARTED)]
    result, ok, _sent = await _call(
        pool,
        conn,
        device,
        "device_edit_file",
        _edit(f"{OLD}/README.md"),
        facts,
        ok=False,
        error="found 2 matches",
    )
    assert ok is False
    assert "found 2 matches" in result
    assert result.splitlines()[-1] == _warning(OLD)
    assert _flags(facts) == [{"other_change_worktree": OLD, "tool": "device_edit_file"}]
    await _close(conn, task)


async def test_c1_a_write_into_another_worktree_is_written_and_warned(pool):
    _id, device, conn, task = await _connect(pool, name="mini-pc")
    facts = [dict(STARTED)]
    result, ok, sent = await _call(
        pool,
        conn,
        device,
        "device_write_file",
        {"device": "mini-pc", "path": f"{OLD}/notes.md", "content": "x"},
        facts,
    )
    assert ok is True, result
    assert sent
    assert result.splitlines()[-1] == _warning(OLD)
    assert _flags(facts) == [{"other_change_worktree": OLD, "tool": "device_write_file"}]
    await _close(conn, task)


@pytest.mark.parametrize(
    "args",
    [
        {"argv": ["git", "status"], "cwd": OLD},
        {"argv": ["git", "status"], "cwd": f"{OLD}/services/core"},
        {"argv": ["git", "-C", OLD, "status"]},
        {"argv": ["sh", "-c", f"cd {OLD}/apps && ls"]},
    ],
)
async def test_c1_a_run_in_another_worktree_runs_and_is_warned(pool, args):
    _id, device, conn, task = await _connect(pool, name="mini-pc")
    facts = [dict(STARTED)]
    result, ok, sent = await _call(
        pool, conn, device, "device_run", {"device": "mini-pc", **args}, facts
    )
    assert ok is True, result
    assert sent
    assert result.splitlines()[-1] == _warning(OLD)
    assert _flags(facts) == [{"other_change_worktree": OLD, "tool": "device_run"}]
    await _close(conn, task)


async def test_c1_the_last_started_change_is_current(pool):
    """Two start_changes in one turn: the LATER one is current, so the first
    one's worktree is the other."""
    _id, device, conn, task = await _connect(pool, name="mini-pc")
    first = {**STARTED, "change": "3e8ab0", "worktree_path": OLD}
    facts = [first, dict(STARTED)]
    result, ok, _sent = await _call(
        pool, conn, device, "device_edit_file", _edit(f"{OLD}/README.md"), facts, meta=EDIT_META
    )
    assert ok is True, result
    assert result.splitlines()[-1] == _warning(OLD)
    await _close(conn, task)


# -- C3: silent ----------------------------------------------------------------


@pytest.mark.parametrize(
    "facts",
    [
        [dict(STARTED)],  # the current worktree itself
        [],  # no change this turn
        [dict(LISTED), {**LISTED, "change": "3ff482", "worktree_path": CURRENT}],  # listed only
    ],
    ids=["same-worktree", "no-change", "list-changes-only"],
)
async def test_c3_same_worktree_no_change_or_only_listed_no_warning(pool, facts):
    _id, device, conn, task = await _connect(pool, name="mini-pc")
    path = f"{CURRENT}/README.md" if facts == [STARTED] else f"{OLD}/README.md"
    result, ok, _sent = await _call(
        pool, conn, device, "device_edit_file", _edit(path), facts, meta=EDIT_META
    )
    assert ok is True, result
    assert "Warning:" not in result
    assert _flags(facts) == []
    await _close(conn, task)


@pytest.mark.parametrize(
    "path",
    [
        f"{REPO}/.worktrees/novaX/README.md",  # not a nova-<id> worktree
        "/home/jeremy/notes/README.md",  # off .worktrees entirely
        f"{CURRENT}/sub/README.md",  # under the current one
    ],
)
async def test_c3_paths_that_are_not_another_change_no_warning(pool, path):
    _id, device, conn, task = await _connect(pool, name="mini-pc")
    facts = [dict(STARTED)]
    result, ok, _sent = await _call(
        pool, conn, device, "device_edit_file", _edit(path), facts, meta=EDIT_META
    )
    assert ok is True, result
    assert "Warning:" not in result
    assert _flags(facts) == []
    await _close(conn, task)


async def test_c3_an_id_that_only_shares_a_prefix_is_another_change(pool):
    """nova-3ff482x is not nova-3ff482's tree: a different id warns (paired
    with the same-worktree silence above)."""
    _id, device, conn, task = await _connect(pool, name="mini-pc")
    facts = [dict(STARTED)]
    other = f"{CURRENT}x"
    result, ok, _sent = await _call(
        pool, conn, device, "device_edit_file", _edit(f"{other}/README.md"), facts, meta=EDIT_META
    )
    assert ok is True, result
    assert result.splitlines()[-1] == _warning(other)
    await _close(conn, task)


async def test_c3_reads_of_another_worktree_never_warn(pool):
    _id, device, conn, task = await _connect(pool, name="mini-pc")
    facts = [dict(STARTED)]
    result, ok, _sent = await _call(
        pool,
        conn,
        device,
        "device_read_file",
        {"device": "mini-pc", "path": f"{OLD}/README.md"},
        facts,
    )
    assert ok is True, result
    assert "Warning:" not in result
    assert _flags(facts) == []
    await _close(conn, task)


# -- C2: the span mark ---------------------------------------------------------


def _turn() -> traces.Turn:
    return traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))


async def test_c2_the_span_is_marked_and_not_an_error(pool):
    _id, device, conn, task = await _connect(pool, name="mini-pc")
    person = await _person(pool)

    async def answer():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        reply = device.result(frame["envelope"], output="done")
        reply["meta"] = EDIT_META
        conn.feed(reply)

    ans = asyncio.create_task(answer())
    turn = _turn()
    call = chat.ToolCall(
        id="c1", name="device_edit_file", arguments=json.dumps(_edit(f"{OLD}/README.md"))
    )
    result, ok = await chat._run_tool(turn, _ctx(person, facts=[dict(STARTED)]), call)
    await asyncio.wait_for(ans, 2)
    assert ok is True, result
    (span,) = turn.spans
    assert span.meta["ok"] is True and "error" not in span.meta
    assert span.meta["other_change_worktree"] is True
    assert {"other_change_worktree": OLD, "tool": "device_edit_file"} in span.meta["facts"]
    await _close(conn, task)


async def test_c2_an_earlier_fact_does_not_mark_a_later_span(pool):
    _id, device, conn, task = await _connect(pool, name="mini-pc")
    person = await _person(pool)

    async def answer():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        reply = device.result(frame["envelope"], output="done")
        reply["meta"] = EDIT_META
        conn.feed(reply)

    ans = asyncio.create_task(answer())
    turn = _turn()
    earlier = {"other_change_worktree": OLD, "tool": "device_edit_file"}
    call = chat.ToolCall(
        id="c1", name="device_edit_file", arguments=json.dumps(_edit(f"{CURRENT}/README.md"))
    )
    result, ok = await chat._run_tool(turn, _ctx(person, facts=[dict(STARTED), earlier]), call)
    await asyncio.wait_for(ans, 2)
    assert ok is True, result
    (span,) = turn.spans
    assert "other_change_worktree" not in span.meta
    await _close(conn, task)
