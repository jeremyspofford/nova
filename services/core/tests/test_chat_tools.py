"""The ring-0 tool loop inside the chat turn.

Everything here drives the real route through a scripted gateway, so what
is under test is the loop itself: how a tool call is accumulated off the
wire, that it executes exactly once and in the model's order, what the
client sees while it runs, what the next round is told, and what the trace
says afterwards.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime

import pytest

from app import chat, tools, traces
from tests.conftest import requires_db
from tests.fakes import FakeMemory, Refusal, ScriptedGateway

pytestmark = requires_db

DONE = "[DONE]"


def frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        assert block.startswith("data: "), block
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


# -- wire shapes a backend might emit --------------------------------------


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def call_delta(index: int, *, call_id=None, name=None, arguments=None) -> dict:
    """One streaming tool-call delta, exactly as OpenAI emits them: the
    first fragment carries the id and the function name, later fragments
    carry only more argument text, all keyed by `index`."""
    function: dict = {}
    if name is not None:
        function["name"] = name
    if arguments is not None:
        function["arguments"] = arguments
    fragment: dict = {"index": index, "function": function}
    if call_id is not None:
        fragment["id"] = call_id
        fragment["type"] = "function"
    return {"choices": [{"delta": {"tool_calls": [fragment]}}]}


def whole_call(call_id: str, name: str, arguments: dict) -> dict:
    """The other shape in the wild: a backend that does not really stream
    tool calls sends the finished call in a single chunk, under `message`
    rather than `delta`, arguments already a JSON string."""
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


def streamed_call(index: int, call_id: str, name: str, arguments: dict) -> tuple[dict, ...]:
    """The same call, split across chunks the way a real stream splits it."""
    blob = json.dumps(arguments)
    head, tail = blob[: len(blob) // 2], blob[len(blob) // 2 :]
    return (
        call_delta(index, call_id=call_id, name=name, arguments=""),
        call_delta(index, arguments=head),
        call_delta(index, arguments=tail),
    )


# -- helpers ---------------------------------------------------------------


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


async def _set(client, key: str, value) -> None:
    resp = await client.put("/api/v1/settings", json={"key": key, "value": value})
    assert resp.status_code == 200, resp.text


async def _say(client, message: str = "do the thing") -> list:
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


def activities(sent: list) -> list[tuple[str, str]]:
    return [(f["activity"]["tool"], f["activity"]["status"]) for f in sent if "activity" in f]


def texts(sent: list) -> list[str]:
    return [f["t"] for f in sent if isinstance(f, dict) and "t" in f]


async def _spans(pool, kind: str | None = None) -> list:
    rows = await pool.fetch(
        "SELECT kind, name, duration_ms, meta FROM turn_spans ORDER BY started_at, kind"
    )
    return [row for row in rows if kind is None or row["kind"] == kind]


# -- one round of tools ----------------------------------------------------


async def test_a_streamed_tool_call_runs_and_the_next_round_answers(
    owner_client, pool, mount_peers, workspace
):
    gateway = ScriptedGateway(
        rounds=(
            (
                text("Writing that down. "),
                *streamed_call(
                    0,
                    "call_1",
                    "workspace_write_file",
                    {"path": "groceries.md", "content": "- milk\n"},
                ),
            ),
            (text("Done — the list has milk on it."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "chat.model", "qwen3:8b")

    sent = await _say(owner_client, "write a grocery list")

    assert texts(sent) == ["Writing that down. ", "Done — the list has milk on it."]
    assert activities(sent) == [
        ("workspace_write_file", "start"),
        ("workspace_write_file", "ok"),
    ]
    assert sent[-1] == DONE

    # The file genuinely exists, with the content the model asked for.
    assert (workspace / "groceries.md").read_text(encoding="utf-8") == "- milk\n"

    # The whole turn's text is what persists, in the order it streamed.
    assert await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'") == (
        "Writing that down. Done — the list has milk on it."
    )
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_the_start_frame_comes_before_the_result_frame_for_every_call(
    owner_client, pool, mount_peers, workspace
):
    gateway = ScriptedGateway(
        rounds=(
            (
                *streamed_call(0, "c1", "workspace_write_file", {"path": "a.md", "content": "a"}),
                *streamed_call(1, "c2", "get_time", {}),
            ),
            (text("both done"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)
    assert activities(sent) == [
        ("workspace_write_file", "start"),
        ("workspace_write_file", "ok"),
        ("get_time", "start"),
        ("get_time", "ok"),
    ]


async def test_the_second_round_is_told_what_the_tools_answered(
    owner_client, pool, mount_peers, workspace
):
    gateway = ScriptedGateway(
        rounds=(
            (
                text("one moment. "),
                *streamed_call(
                    0, "call_1", "workspace_write_file", {"path": "n.md", "content": "x"}
                ),
            ),
            (text("done"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    second = gateway.payloads[1]["messages"]
    assistant = second[-2]
    assert assistant["role"] == "assistant"
    assert assistant["content"] == "one moment. "
    assert assistant["tool_calls"][0]["id"] == "call_1"
    assert assistant["tool_calls"][0]["function"]["name"] == "workspace_write_file"

    tool_message = second[-1]
    assert tool_message["role"] == "tool"
    assert tool_message["tool_call_id"] == "call_1"
    assert tool_message["content"].startswith("Wrote n.md")


async def test_tools_are_advertised_on_every_round(owner_client, pool, mount_peers, workspace):
    gateway = ScriptedGateway(
        rounds=((whole_call("c1", "get_time", {}),), (text("it is late"),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    for payload in gateway.payloads:
        names = {entry["function"]["name"] for entry in payload["tools"]}
        assert "workspace_write_file" in names and "get_time" in names


async def test_the_non_streamed_single_chunk_shape_is_handled(
    owner_client, pool, mount_peers, workspace
):
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "workspace_write_file", {"path": "one.md", "content": "hi"}),),
            (text("wrote it"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)
    assert activities(sent) == [("workspace_write_file", "start"), ("workspace_write_file", "ok")]
    assert (workspace / "one.md").read_text(encoding="utf-8") == "hi"


async def test_a_call_with_no_index_and_no_id_still_runs_exactly_once(
    owner_client, pool, mount_peers, workspace
):
    """Some backends omit both. The call still has to execute, once, and
    the tool result still needs an id to be addressed by."""
    fragment = {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "function": {
                                "name": "workspace_write_file",
                                "arguments": json.dumps({"path": "x.md", "content": "y"}),
                            }
                        }
                    ]
                }
            }
        ]
    }
    gateway = ScriptedGateway(rounds=((fragment,), (text("ok"),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)
    assert activities(sent) == [("workspace_write_file", "start"), ("workspace_write_file", "ok")]
    assert (workspace / "x.md").read_text(encoding="utf-8") == "y"
    tool_message = gateway.payloads[1]["messages"][-1]
    assert tool_message["tool_call_id"]


# -- three rounds: write, read, answer -------------------------------------


async def test_write_then_read_then_answer(owner_client, pool, mount_peers, workspace):
    gateway = ScriptedGateway(
        rounds=(
            (
                *streamed_call(
                    0, "c1", "workspace_write_file", {"path": "groceries.md", "content": "- milk\n"}
                ),
            ),
            (*streamed_call(0, "c2", "workspace_read_file", {"path": "groceries.md"}),),
            (text("The list says: - milk"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "write a list then read it back")

    assert activities(sent) == [
        ("workspace_write_file", "start"),
        ("workspace_write_file", "ok"),
        ("workspace_read_file", "start"),
        ("workspace_read_file", "ok"),
    ]
    assert gateway.calls == 3
    assert gateway.payloads[2]["messages"][-1]["content"] == "- milk\n"
    assert texts(sent) == ["The list says: - milk"]


# -- errors round-trip -----------------------------------------------------


async def test_malformed_arguments_execute_nothing_and_the_model_may_retry(
    owner_client, pool, mount_peers, workspace
):
    gateway = ScriptedGateway(
        rounds=(
            (call_delta(0, call_id="c1", name="workspace_write_file", arguments='{"path": '),),
            (
                *streamed_call(
                    0, "c2", "workspace_write_file", {"path": "good.md", "content": "second try"}
                ),
            ),
            (text("that time it worked"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert activities(sent) == [
        ("workspace_write_file", "start"),
        ("workspace_write_file", "error"),
        ("workspace_write_file", "start"),
        ("workspace_write_file", "ok"),
    ]
    # The malformed call left nothing on disk at all: the only file in the
    # workspace is the one the RETRY wrote.
    assert [p.name for p in workspace.iterdir()] == ["good.md"]

    error_result = gateway.payloads[1]["messages"][-1]["content"]
    assert error_result.startswith("Error: ")
    assert error_result.endswith("re-issue the call")
    assert (workspace / "good.md").read_text(encoding="utf-8") == "second try"


async def test_a_failing_tool_is_an_error_activity_and_a_stated_result(
    owner_client, pool, mount_peers, workspace
):
    gateway = ScriptedGateway(
        rounds=(
            (*streamed_call(0, "c1", "workspace_read_file", {"path": "../escape.md"}),),
            (text("I could not read that — it is outside my workspace."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)
    assert activities(sent) == [
        ("workspace_read_file", "start"),
        ("workspace_read_file", "error"),
    ]
    result = gateway.payloads[1]["messages"][-1]["content"]
    assert result.startswith("Error: ")
    assert "outside the workspace" in result
    # A tool that failed does not fail the turn: she gets to say so.
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_a_tool_that_does_not_exist_is_refused_by_name(
    owner_client, pool, mount_peers, workspace
):
    gateway = ScriptedGateway(
        rounds=(
            (*streamed_call(0, "c1", "run_shell_command", {"cmd": "rm -rf /"}),),
            (text("I do not have that tool."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)
    assert activities(sent) == [("run_shell_command", "start"), ("run_shell_command", "error")]
    result = gateway.payloads[1]["messages"][-1]["content"]
    assert "no tool named 'run_shell_command'" in result


# -- the round cap ---------------------------------------------------------


async def test_the_round_cap_stops_and_says_so(owner_client, pool, mount_peers, workspace):
    forever = (whole_call("c", "get_time", {}),)
    gateway = ScriptedGateway(rounds=(forever, forever, forever, forever))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "agents.max_tool_rounds", 2)

    sent = await _say(owner_client)

    assert gateway.calls == 2
    note = texts(sent)[-1]
    assert "stopped after 2 tool rounds without finishing" in note
    # Only the first round's call ran: the capped round's calls are not executed.
    assert activities(sent) == [("get_time", "start"), ("get_time", "ok")]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert "stopped after 2 tool rounds without finishing" in stored


async def test_the_default_round_cap_is_six(owner_client):
    resp = await owner_client.get("/api/v1/settings")
    defs = {item["key"]: item for item in resp.json()["settings"]}
    assert defs["agents.max_tool_rounds"]["type"] == "int"
    assert defs["agents.max_tool_rounds"]["default"] == 6
    assert defs["agents.max_tool_rounds"]["value"] == 6


# -- the empty-reply floor -------------------------------------------------


async def test_a_tool_round_with_no_text_does_not_trip_the_empty_floor(
    owner_client, pool, mount_peers, workspace
):
    gateway = ScriptedGateway(
        rounds=((whole_call("c1", "get_time", {}),), (text("It is late."),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]
    assert await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'") == (
        "It is late."
    )


async def test_a_turn_that_never_says_anything_is_still_an_error(
    owner_client, pool, mount_peers, workspace
):
    gateway = ScriptedGateway(rounds=((whole_call("c1", "get_time", {}),), ()))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)
    assert [f for f in sent if isinstance(f, dict) and "error" in f]
    assert await pool.fetchval("SELECT status FROM turns") == "error"


# -- the trace -------------------------------------------------------------


async def test_every_tool_call_is_a_span_and_llm_calls_carry_their_round(
    owner_client, pool, mount_peers, workspace
):
    gateway = ScriptedGateway(
        rounds=(
            (
                *streamed_call(
                    0, "c1", "workspace_write_file", {"path": "spans.md", "content": "hello"}
                ),
            ),
            (*streamed_call(0, "c2", "workspace_read_file", {"path": "nope.md"}),),
            (text("all recorded"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    llm = await _spans(pool, "llm_call")
    assert [span["meta"]["round"] for span in llm] == [1, 2, 3]

    tool_spans = await _spans(pool, "tool")
    assert [span["name"] for span in tool_spans] == [
        "workspace_write_file",
        "workspace_read_file",
    ]

    wrote, failed = tool_spans
    assert wrote["meta"]["ok"] is True
    assert wrote["meta"]["args_redacted"]["path"] == "spans.md"
    assert wrote["meta"]["result_head"].startswith("Wrote spans.md")
    assert "error" not in wrote["meta"]
    assert wrote["duration_ms"] >= 0

    assert failed["meta"]["ok"] is False
    assert failed["meta"]["error"].startswith("Error: ")
    assert "nope.md" in failed["meta"]["result_head"]


async def test_span_arguments_are_recorded_as_heads_not_whole_payloads(
    owner_client, pool, mount_peers, workspace
):
    """A 200 KB file body must not be copied into the trace."""
    body = "x" * 5000
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "workspace_write_file", {"path": "big.md", "content": body}),),
            (text("written"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    span = (await _spans(pool, "tool"))[0]
    recorded = span["meta"]["args_redacted"]["content"]
    assert len(recorded) < 500
    assert recorded.startswith("xxx")
    assert "5000" in recorded  # it says how much it left out
    assert len(span["meta"]["result_head"]) <= chat.SPAN_RESULT_HEAD_CHARS


# -- a backend with no tool support ----------------------------------------


async def test_a_backend_that_rejects_tools_says_so_instead_of_degrading(
    owner_client, pool, mount_peers, workspace
):
    gateway = ScriptedGateway(
        rounds=(
            Refusal(
                status=400,
                # The backend's own words, which never contain the sentence
                # asserted below — that sentence has to be added by core.
                body={"error": {"message": "'tools' is not a supported parameter"}},
            ),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    stated = [f["error"] for f in sent if isinstance(f, dict) and "error" in f]
    assert stated, sent
    assert "does not support tools" in stated[0]
    assert "'tools' is not a supported parameter" in stated[0]  # never replaced
    # Never a second, quieter attempt without them.
    assert gateway.calls == 1
    assert await pool.fetchval("SELECT status FROM turns") == "error"


async def test_a_gateway_failure_mid_loop_is_stated_and_keeps_what_streamed(
    owner_client, pool, mount_peers, workspace
):
    gateway = ScriptedGateway(
        rounds=(
            (
                text("checking. "),
                *streamed_call(0, "c1", "get_time", {}),
            ),
            Refusal(status=502, body={"error": {"message": "the backend went away"}}),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)
    assert texts(sent) == ["checking. "]
    stated = [f["error"] for f in sent if isinstance(f, dict) and "error" in f]
    assert "the backend went away" in stated[0]
    assert await pool.fetchval("SELECT status FROM turns") == "error"


# -- history -------------------------------------------------------------


async def test_the_next_turn_replays_no_tool_transcript(
    owner_client, pool, mount_peers, workspace
):
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "get_time", {}),),
            (text("it is late"),),
            (text("still late"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "what time is it")
    await _say(owner_client, "and now")

    third = gateway.payloads[2]["messages"]
    assert all(m["role"] in ("system", "user", "assistant") for m in third)
    assert [m["role"] for m in third if m["role"] != "system"] == ["user", "assistant", "user"]


# -- the prompt ----------------------------------------------------------


async def test_the_stable_prompt_names_the_tools_it_advertises(
    owner_client, pool, mount_peers, workspace
):
    gateway = ScriptedGateway(rounds=((text("hi"),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "hello")

    stable = gateway.payloads[0]["messages"][0]["content"]
    advertised = {e["function"]["name"] for e in gateway.payloads[0]["tools"]}
    for name in advertised:
        assert name in stable


async def test_a_tool_cut_off_mid_call_leaves_a_span_that_says_so(monkeypatch, tmp_path):
    """A client that hangs up while a tool is running still files the span,
    and it must not read as a success nobody checked."""
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))

    async def never_returns(args, ctx):
        raise asyncio.CancelledError

    monkeypatch.setitem(
        tools.REGISTRY,
        "spy",
        tools.Tool(
            name="spy",
            description="d",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            executor=never_returns,
        ),
    )
    ctx = tools.ToolContext(app=None, person=None, workspace_root=tmp_path)

    with pytest.raises(asyncio.CancelledError):
        await chat._run_tool(turn, ctx, chat.ToolCall(id="c1", name="spy", arguments="{}"))

    span = turn.spans[0]
    assert (span.kind, span.name) == ("tool", "spy")
    assert span.meta["ok"] is False
    assert "before this call returned" in span.meta["result_head"]


async def test_a_call_with_a_flood_of_arguments_cannot_bloat_the_trace(
    owner_client, pool, mount_peers, workspace
):
    """The model chooses how many arguments it sends, and they are recorded
    before validation refuses them — so the whole record is capped, not
    just each value."""
    flood = {f"key{index}": "value" for index in range(5000)}
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "workspace_write_file", flood),),
            (text("that call was refused"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)
    assert activities(sent) == [
        ("workspace_write_file", "start"),
        ("workspace_write_file", "error"),
    ]

    span = (await _spans(pool, "tool"))[0]
    recorded = span["meta"]["args_redacted"]
    assert isinstance(recorded, str)  # degraded to a clipped record, on purpose
    assert len(recorded) < chat.SPAN_ARGS_TOTAL_CHARS + 200
    assert "more chars" in recorded
