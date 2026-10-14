"""S38b T4: read_result(ref, part | query) — a kept result, read back.

A summary marker (context_summary.marker) tells her the full text is kept and
`read_result("rN", part=… or query=…)`. This is that tool: it reads THIS
turn's kept results (traces.results_of(ctx.turn_id), T1's live map) and
serves one in parts or by search, the same way browser_read serves a page —
reader.read_text builds the Page from plain lines through the reader's own
_paginate, and search() is the reader's, not a copy.

Criteria:
  C1 part i of a result is the reader's part i of its text: part 2 of a
     60,000-char result is the region from ~24,000 to ~48,000, headed with
     the ref, tool, size and "part 2 of 3".
  C2 query returns the lines holding every word, each with its part number;
     no match says so (with the part count), not an error.
  C3 an unknown ref, or a part past the end, is a stated failure (Error:,
     ok=False) naming the refs that exist / the part count.
  C4 outside a chat turn (no turn id, or a turn this process is not
     running) is a stated cannot, never a guess from elsewhere.
  C5 registered, reads_only, schema {ref (required), part, query}, and the
     parameter names are exactly the ones the summary marker tells her to
     use; dispatch never reads turn_id (test_no_approvals stays green).
  C6 in a real chat turn she reads back a result an earlier round kept:
     the round after her read_result call SENDS her the asked part.
"""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

import pytest

from app import context_summary, tools, traces
from app.browser import reader
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway

# -- helpers -----------------------------------------------------------------


def _numbered(chars: int) -> str:
    """A log of fixed-width numbered lines, `chars` long (whole lines)."""
    line = "line {:05d} of the long log, with words enough to fill it out\n"
    width = len(line.format(0))
    count = chars // width
    return "".join(line.format(i) for i in range(count)).rstrip("\n")


def _turn() -> traces.Turn:
    turn = traces.Turn(id=uuid.uuid4(), started_at=traces.datetime.now(traces.UTC))
    traces.track_results(turn)
    return turn


def _ctx(turn_id, tmp_path: Path) -> tools.ToolContext:
    return tools.context_for(None, object(), workspace_root=tmp_path, turn_id=turn_id)


@pytest.fixture
def turn():
    made = _turn()
    yield made
    traces.clear_results(made.id)


# -- reader.read_text: the reader's own paging and search, on plain text ----


def test_read_text_pages_plain_lines_with_the_readers_own_paginate():
    text = _numbered(60_000)
    page = reader.read_text(text, reader.DEFAULT_PART_CHARS)
    lines = tuple(reader.Line(t) for t in text.split("\n"))
    assert page.lines == lines
    parts, starts = reader._paginate(lines, reader.DEFAULT_PART_CHARS)
    assert page.parts == tuple(parts) and page.starts == tuple(starts)
    assert len(page.parts) == 3
    assert "\n".join(page.parts) == text  # nothing lost, nothing added


def test_read_text_clamps_its_part_size_like_read():
    text = _numbered(10_000)
    assert reader.read_text(text, 0).parts == reader.read_text(text, reader.MIN_PART_CHARS).parts


def test_read_text_is_searchable_by_the_readers_search():
    text = _numbered(60_000)
    page = reader.read_text(text, reader.DEFAULT_PART_CHARS)
    matches, total = reader.search(page, "line 00900")
    assert total == 1
    assert matches[0].part == 3 and "line 00900" in matches[0].text


# -- C1: a part -------------------------------------------------------------


async def test_part_two_of_a_60k_result_is_the_24k_to_48k_region(turn, tmp_path):
    text = _numbered(60_000)
    traces.keep_result(turn, "c1", "workspace_read_file", "short first result")
    traces.keep_result(turn, "c2", "device_run", text)

    result, ok = await tools.dispatch(
        "read_result", {"ref": "r2", "part": 2}, _ctx(turn.id, tmp_path)
    )

    assert ok, result
    head, _, body = result.partition("\n\n")
    assert "r2" in head and "device_run" in head and f"{len(text):,} chars" in head
    assert "part 2 of 3" in head
    assert body == reader.read_text(text, reader.DEFAULT_PART_CHARS).parts[1]
    start = text.index(body)
    assert 24_000 - 80 < start <= 24_000
    assert 48_000 - 80 < start + len(body) <= 48_000


async def test_no_part_reads_part_one(turn, tmp_path):
    text = _numbered(30_000)
    traces.keep_result(turn, "c1", "browser_read", text)
    result, ok = await tools.dispatch("read_result", {"ref": "r1"}, _ctx(turn.id, tmp_path))
    assert ok, result
    assert "part 1 of 2" in result
    assert result.endswith(reader.read_text(text, reader.DEFAULT_PART_CHARS).parts[0])


# -- C2: a query ------------------------------------------------------------


async def test_a_query_returns_the_matching_lines_with_their_parts(turn, tmp_path):
    text = _numbered(60_000).replace("line 00900 of", "line 00900 ERROR disk full of")
    traces.keep_result(turn, "c1", "device_run", text)

    result, ok = await tools.dispatch(
        "read_result", {"ref": "r1", "query": "error disk"}, _ctx(turn.id, tmp_path)
    )

    assert ok, result
    assert result.splitlines()[0].startswith("Result r1 (device_run, ")
    assert "1 line holds every word of 'error disk'" in result
    assert re.search(r"^- part 3: .*line 00900 ERROR disk full", result, re.M)
    assert "line 00899" not in result  # only the matching line, not the part


async def test_a_query_with_no_match_says_so(turn, tmp_path):
    traces.keep_result(turn, "c1", "device_run", _numbered(30_000))
    result, ok = await tools.dispatch(
        "read_result", {"ref": "r1", "query": "zebra"}, _ctx(turn.id, tmp_path)
    )
    assert ok, result
    assert "No line holds every word of 'zebra' (2 parts)." in result


# -- C3: unknown ref, part past the end --------------------------------------


async def test_an_unknown_ref_is_refused_naming_the_refs_that_exist(turn, tmp_path):
    traces.keep_result(turn, "c1", "workspace_read_file", "a")
    traces.keep_result(turn, "c2", "device_run", "b")
    traces.keep_result(turn, "c3", "browser_read", "c")
    result, ok = await tools.dispatch("read_result", {"ref": "r9"}, _ctx(turn.id, tmp_path))
    assert not ok
    assert result.startswith(tools.ERROR_PREFIX)
    assert "r9" in result
    assert "r1 (workspace_read_file), r2 (device_run), r3 (browser_read)" in result


async def test_a_turn_with_no_results_yet_says_so(turn, tmp_path):
    result, ok = await tools.dispatch("read_result", {"ref": "r1"}, _ctx(turn.id, tmp_path))
    assert not ok
    assert "no tool results yet" in result


async def test_a_part_past_the_end_is_refused_naming_the_part_count(turn, tmp_path):
    traces.keep_result(turn, "c1", "device_run", _numbered(30_000))
    result, ok = await tools.dispatch(
        "read_result", {"ref": "r1", "part": 3}, _ctx(turn.id, tmp_path)
    )
    assert not ok
    assert result.startswith(tools.ERROR_PREFIX)
    assert "r1 has 2 parts; there is no part 3" in result


# -- C4: outside a chat turn -------------------------------------------------


async def test_outside_a_turn_it_states_it_cannot(tmp_path):
    result, ok = await tools.dispatch("read_result", {"ref": "r1"}, _ctx(None, tmp_path))
    assert not ok
    assert result.startswith(tools.ERROR_PREFIX)
    assert "only inside a chat turn" in result


async def test_a_turn_this_process_is_not_running_states_it_cannot(tmp_path):
    untracked = traces.Turn(id=uuid.uuid4(), started_at=traces.datetime.now(traces.UTC))
    traces.keep_result(untracked, "c1", "device_run", "kept on the turn only")
    result, ok = await tools.dispatch("read_result", {"ref": "r1"}, _ctx(untracked.id, tmp_path))
    assert not ok
    assert "only inside a chat turn" in result


async def test_it_reads_only_its_own_turns_results(tmp_path):
    other = _turn()  # tracked FIRST, so "whatever is in the map" would be this one
    mine = _turn()
    try:
        traces.keep_result(other, "c1", "device_run", "another turn's secret result")
        traces.keep_result(mine, "c1", "browser_read", "this turn's own result")
        result, ok = await tools.dispatch("read_result", {"ref": "r1"}, _ctx(mine.id, tmp_path))
        assert ok, result
        assert "this turn's own result" in result and "secret" not in result
    finally:
        traces.clear_results(other.id)
        traces.clear_results(mine.id)


# -- C5: registered, and named as the marker names it -----------------------


def test_read_result_is_registered_reads_only_with_the_markers_parameters():
    tool = tools.REGISTRY["read_result"]
    assert tool.reads_only
    props = tool.parameters["properties"]
    assert set(props) == {"ref", "part", "query"}
    assert tool.parameters["required"] == ["ref"]
    marker = context_summary.marker("r3", "browser_read", 48_120)
    call = re.search(r'(\w+)\("r3", (\w+)=… or (\w+)=…\)', marker)
    assert call is not None, marker
    assert call.group(1) == tool.name
    assert {call.group(2), call.group(3)} == {"part", "query"} <= set(props)


async def test_a_ref_that_is_not_a_string_never_reaches_the_executor(turn, tmp_path):
    result, ok = await tools.dispatch("read_result", {"ref": 3}, _ctx(turn.id, tmp_path))
    assert not ok and result.startswith(tools.ERROR_PREFIX)


# -- C6: in a real chat turn --------------------------------------------------


def _calls(call_id: str, name: str, arguments: dict) -> dict:
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
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ]
    }


@requires_db
async def test_in_a_chat_turn_she_reads_back_part_two_of_an_earlier_result(
    owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    root = tmp_path / "workspace"
    root.mkdir()
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    log = _numbered(30_000)
    (root / "core.log").write_text(log, encoding="utf-8")
    gateway = ScriptedGateway(
        rounds=(
            (_calls("c1", "workspace_read_file", {"path": "core.log"}),),
            (_calls("c2", "read_result", {"ref": "r1", "part": 2}),),
            ({"choices": [{"delta": {"content": "line 00450 is the last."}}]},),
        ),
        served_by=f"dell:qwen3:8b-{uuid.uuid4().hex[:8]}",
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "chat.model", "value": "qwen3:8b"}
    )
    assert resp.status_code == 200, resp.text

    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "what is last?"})
    assert resp.status_code == 200, resp.text

    turn_id = await pool.fetchval("SELECT id FROM turns WHERE kind = 'chat'")
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn_id) == "ok"
    sent = {
        m["tool_call_id"]: m["content"]
        for m in gateway.payloads[2]["messages"]
        if m.get("role") == "tool"
    }
    kept = await pool.fetchval(
        "SELECT content FROM tool_results WHERE turn_id = $1 AND ref = 'r1'", turn_id
    )
    assert "part 2 of 2" in sent["c2"]
    assert sent["c2"].endswith(reader.read_text(kept, reader.DEFAULT_PART_CHARS).parts[1])
    assert "line 00450" in sent["c2"] and "line 00000" not in sent["c2"]
    ok = await pool.fetchval(
        "SELECT meta->>'ok' FROM turn_spans WHERE turn_id = $1 AND name = 'read_result'",
        turn_id,
    )
    assert ok == "true"
