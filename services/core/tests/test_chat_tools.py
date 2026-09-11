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


def activity_frames(sent: list, status: str) -> list[dict]:
    """Every activity payload with the given status, in order — used to
    inspect fields `activities()` above collapses away, like `reason`."""
    return [f["activity"] for f in sent if "activity" in f and f["activity"]["status"] == status]


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
    gateway = ScriptedGateway(rounds=((whole_call("c1", "get_time", {}),), (text("it is late"),)))
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
    # The error activity frame states WHY, ERROR_PREFIX stripped — never
    # invented, and never present on the "start" frame beside it.
    assert activity_frames(sent, "error")[0]["reason"] == result.removeprefix("Error: ")
    assert "reason" not in activity_frames(sent, "start")[0]
    # A tool that failed does not fail the turn: she gets to say so.
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_a_stated_tool_failure_carries_its_reason_on_the_error_activity(
    monkeypatch, owner_client, pool, mount_peers, workspace
):
    """The owner's walk, 2026-09-02 23:52: device_run tree raised a stated
    ToolFailure ("executable file not found in $PATH") — the call FINISHED,
    it just refused — and the model adapted, ran `find` instead, and
    succeeded. The chat UI still said "device_run did not finish": the
    activity frame's status alone cannot distinguish a stated failure from a
    turn cut off mid-call. This pins the fix at its source — the frame
    itself — with a fake tool standing in for device_run so the test does
    not also depend on a paired device."""

    async def raise_tree_not_found(args: dict, ctx: tools.ToolContext) -> str:
        raise tools.ToolFailure("could not run tree: executable file not found in $PATH")

    monkeypatch.setitem(
        tools.REGISTRY,
        "fake_device_run",
        tools.Tool(
            name="fake_device_run",
            description="d",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            executor=raise_tree_not_found,
        ),
    )
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "fake_device_run", {}),),
            (text("that didn't work, let me try something else"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert activities(sent) == [
        ("fake_device_run", "start"),
        ("fake_device_run", "error"),
    ]
    assert activity_frames(sent, "error")[0] == {
        "tool": "fake_device_run",
        "status": "error",
        "reason": "could not run tree: executable file not found in $PATH",
    }
    result = gateway.payloads[1]["messages"][-1]["content"]
    assert result == "Error: could not run tree: executable file not found in $PATH"


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
    """PIN MOVED (out-of-rounds narration, 2026-09-03): the cap now spends ONE
    extra GATEWAY call on a tool-less narration round, so a turn whose work
    already succeeded still reports it instead of persisting only the note.
    Hence 3 gateway calls, not 2 — and the narration round here asks for a tool
    anyway, which is REFUSED rather than dispatched, so the second (start,
    error) pair joins the activity list while the cap on TOOL rounds holds."""
    forever = (whole_call("c", "get_time", {}),)
    gateway = ScriptedGateway(rounds=(forever, forever, forever, forever))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "agents.max_tool_rounds", 2)

    sent = await _say(owner_client)

    assert gateway.calls == 3  # 2 tool rounds + the one narration round
    assert gateway.payloads[2].get("tools") in (None, [])
    note = texts(sent)[-1]
    assert "stopped after 2 tool rounds without finishing" in note
    # Only the FIRST round's call ran. The capped round's calls are not
    # executed, and the narration round's call is refused, never dispatched.
    assert activities(sent) == [
        ("get_time", "start"),
        ("get_time", "ok"),
        ("get_time", "start"),
        ("get_time", "error"),
    ]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert "stopped after 2 tool rounds without finishing" in stored


# -- the cap must not SWALLOW an answer ------------------------------------
#
# The owner's walk, 2026-09-02 23:52: the model ran device_run tree (honest
# "executable not found"), adapted to device_run find (exit 0 — the listing he
# asked for came back), then which tree, and hit max_tool_rounds=6. The persisted
# reply was ONLY "[stopped after 6 tool rounds without finishing]": a successful
# result existed and the user never saw it. A capped turn now gets ONE final
# tool-less narration round with every accumulated tool result in context, so the
# model answers with what it has — and the note still lands after it.


async def test_the_cap_gets_one_toolless_narration_round_that_answers(
    owner_client, pool, mount_peers, workspace
):
    """The headline fix. Round 1 runs a tool successfully, round 2 hits the cap
    with another call. The turn then makes EXACTLY one more gateway call, with
    NO tools advertised, whose answer persists — followed by the note, which
    stays because the operator must still know the turn stopped early."""
    forever = (whole_call("c", "get_time", {}),)
    answer = "It's just past midnight — that's what the clock call came back with."
    gateway = ScriptedGateway(rounds=(forever, forever, (text(answer),)))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "agents.max_tool_rounds", 2)

    sent = await _say(owner_client)

    # Exactly one extra GATEWAY call, and it advertised no tools.
    assert gateway.calls == 3
    assert gateway.payloads[2].get("tools") in (None, [])
    # It saw the accumulated tool results — that is the whole point.
    roles = [m["role"] for m in gateway.payloads[2]["messages"]]
    assert "tool" in roles

    # Only round 1's call ever ran: the narration round dispatched nothing.
    assert activities(sent) == [("get_time", "start"), ("get_time", "ok")]

    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert answer in stored
    assert stored.endswith("[stopped after 2 tool rounds without finishing]")
    assert texts(sent)[-2:] == [
        answer,
        "\n\n[stopped after 2 tool rounds without finishing]",
    ]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_a_silent_narration_round_leaves_the_note_alone(
    owner_client, pool, mount_peers, workspace
):
    """FAIL-OPEN: the narration round says nothing. The note alone persists,
    exactly as before the round existed — never an error, never an empty turn."""
    forever = (whole_call("c", "get_time", {}),)
    gateway = ScriptedGateway(rounds=(forever, forever, ()))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "agents.max_tool_rounds", 2)

    await _say(owner_client)

    assert gateway.calls == 3
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == "[stopped after 2 tool rounds without finishing]"
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_a_failed_narration_round_leaves_the_note_alone(
    owner_client, pool, mount_peers, workspace
):
    """FAIL-OPEN, the other way: the narration round's gateway call dies (the
    script has no round 3, so it answers 500). The turn still ENDS ok with the
    note — a dead extra round costs the answer, never the turn."""
    forever = (whole_call("c", "get_time", {}),)
    gateway = ScriptedGateway(rounds=(forever, forever))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "agents.max_tool_rounds", 2)

    sent = await _say(owner_client)

    assert gateway.calls == 3
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == "[stopped after 2 tool rounds without finishing]"
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_a_tool_call_in_the_narration_round_is_refused_not_dispatched(
    owner_client, pool, mount_peers, workspace
):
    """The cap on TOOL rounds is held MECHANICALLY, not by the nudge asking
    nicely: a call the narration round emits anyway is answered with a stated
    result and recorded as a refused span. The tool never runs, and the note
    still persists."""
    write = (whole_call("w1", "workspace_write_file", {"path": "a.md", "content": "one"}),)
    second = (whole_call("w2", "workspace_write_file", {"path": "b.md", "content": "two"}),)
    third = (whole_call("w3", "workspace_write_file", {"path": "c.md", "content": "three"}),)
    gateway = ScriptedGateway(rounds=(write, second, third))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "agents.max_tool_rounds", 2)

    sent = await _say(owner_client)

    assert gateway.calls == 3
    # a.md was written in round 1; b.md's call was capped; c.md's was REFUSED.
    assert (workspace / "a.md").exists()
    assert not (workspace / "b.md").exists()
    assert not (workspace / "c.md").exists()
    assert activities(sent) == [
        ("workspace_write_file", "start"),
        ("workspace_write_file", "ok"),
        ("workspace_write_file", "start"),
        ("workspace_write_file", "error"),
    ]

    refused = [
        row
        for row in await _spans(pool, "tool")
        if row["meta"].get("refused_out_of_rounds") is True
    ]
    assert len(refused) == 1
    assert refused[0]["meta"]["ok"] is False
    assert refused[0]["meta"]["error"] == chat.OUT_OF_ROUNDS_REFUSAL

    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == "[stopped after 2 tool rounds without finishing]"
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_a_replace_class_correction_cannot_swallow_the_cap_note(
    owner_client, pool, mount_peers, workspace
):
    """Review I1: FIX A must not undo FIX B. The narration round answers with an
    unchecked device-state claim, so the state guard fires and its correction
    REPLACES the model's prose — which is right, but the cap note is the
    BACKEND's record that the turn stopped early, not the model's prose, and it
    must survive. Without this the operator cannot tell a capped turn from an
    ordinary one."""
    await pool.execute(
        "INSERT INTO devices (name, platform, hostname, pubkey) "
        "VALUES ('DELL-XPS-8950', 'linux', 'dell', $1)",
        "a" * 64,
    )
    # A tool that does not exist: refused, so NOTHING ran successfully — the
    # redirect is then blocked by the round cap itself, which is the precondition
    # under test (a successful call would block it earlier, for another reason).
    forever = (whole_call("c", "no_such_tool", {}),)
    claim = "The device is still offline."
    gateway = ScriptedGateway(rounds=(forever, forever, (text(claim),)))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "agents.max_tool_rounds", 2)

    sent = await _say(owner_client)

    # No redirect: an out-of-rounds turn gets no extra dispatch.
    assert gateway.calls == 3
    guard_spans = [row for row in await _spans(pool, "guard")]
    assert [row["name"] for row in guard_spans] == ["state_claim"]
    assert guard_spans[0]["meta"]["not_redirected_because"] == "out_of_rounds"

    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == (
        "Correction: I did not actually check the device this turn — I have no "
        "record of doing so.\n\n[stopped after 2 tool rounds without finishing]"
    )
    assert claim not in stored
    assert texts(sent)[-1].endswith("[stopped after 2 tool rounds without finishing]")


async def test_the_deferral_redirect_is_gated_on_the_round_cap(
    owner_client, pool, mount_peers, workspace
):
    """Review M2: the deferral redirect was not gated on out_of_rounds, so a
    capped narration that says "let me search" earned a fourth gateway call
    whose nudge told the model to call a tool the capped round was not even
    offered — and whose success path replaced (and so discarded) the cap note.
    It is gated now: three gateway calls, no deferral span, note intact."""
    forever = (whole_call("c", "get_time", {}),)
    defer = "Let me search the web for the rest of that."
    gateway = ScriptedGateway(rounds=(forever, forever, (text(defer),)))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "agents.max_tool_rounds", 2)

    await _say(owner_client)

    assert gateway.calls == 3  # a fourth would be the deferral redirect
    assert [row["name"] for row in await _spans(pool, "guard")] == []
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == f"{defer}\n\n[stopped after 2 tool rounds without finishing]"


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
    gateway = ScriptedGateway(rounds=((whole_call("c1", "get_time", {}),), (text("It is late."),)))
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


async def test_the_next_turn_replays_no_tool_transcript(owner_client, pool, mount_peers, workspace):
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


async def test_a_tool_cut_off_mid_call_leaves_a_span_that_says_so(monkeypatch, tmp_path, pool):
    """A client that hangs up while a tool is running still files the span,
    and it must not read as a success nobody checked. The gate must let the
    executor be reached first, so the spy is seeded auto (pool builds the DB)."""
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


# -- the mixed shape: streamed deltas AND a trailing restatement -----------
#
# An aggregating proxy in front of a backend can do both at once: relay the
# per-index deltas as they arrive AND append the finished call in a trailing
# `message` chunk. Each half on its own is covered above; the combination is
# the shape that made the same call look like two.


def trailing_echo(call_id: str, name: str, arguments: dict) -> dict:
    """The finished call restated after its deltas — no index, same id."""
    return whole_call(call_id, name, arguments)


async def test_a_streamed_call_repeated_in_a_trailing_chunk_runs_exactly_once(
    owner_client, pool, mount_peers, workspace
):
    args = {"title": "Coffee order", "content": "flat white"}
    memory = FakeMemory()
    gateway = ScriptedGateway(
        rounds=(
            (
                *streamed_call(0, "call_1", "memory_save", args),
                trailing_echo("call_1", "memory_save", args),
            ),
            (text("saved it"),),
        )
    )
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client)

    # The tool is not required to be idempotent, so "once" is the property,
    # not "the same answer twice".
    assert len(memory.saves) == 1
    assert memory.saves[0]["title"] == "Coffee order"
    assert memory.saves[0]["content"] == "flat white"
    assert activities(sent) == [("memory_save", "start"), ("memory_save", "ok")]

    second = gateway.payloads[1]["messages"]
    assistant = [m for m in second if m["role"] == "assistant"][-1]
    assert len(assistant["tool_calls"]) == 1
    tool_messages = [m for m in second if m["role"] == "tool"]
    assert len(tool_messages) == 1
    assert tool_messages[0]["tool_call_id"] == "call_1"

    spans = await _spans(pool, "tool")
    assert len(spans) == 1


async def test_a_trailing_restatement_replaces_the_streamed_arguments(
    owner_client, pool, mount_peers, workspace
):
    """The restatement is the backend's final word on that call, so it wins.

    Concatenating the two would produce arguments that parse as neither;
    keeping the deltas would ignore a correction the backend just made.
    """
    gateway = ScriptedGateway(
        rounds=(
            (
                *streamed_call(
                    0,
                    "call_1",
                    "workspace_write_file",
                    {"path": "streamed.md", "content": "from the deltas"},
                ),
                trailing_echo(
                    "call_1",
                    "workspace_write_file",
                    {"path": "echoed.md", "content": "from the echo"},
                ),
            ),
            (text("written"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)
    assert activities(sent) == [("workspace_write_file", "start"), ("workspace_write_file", "ok")]
    assert [p.name for p in workspace.iterdir()] == ["echoed.md"]
    assert (workspace / "echoed.md").read_text(encoding="utf-8") == "from the echo"


async def test_two_distinct_un_indexed_calls_still_both_run(
    owner_client, pool, mount_peers, workspace
):
    """Two whole-call chunks with different ids are two calls, not one
    restated — the property the id-keying must not break."""
    gateway = ScriptedGateway(
        rounds=(
            (
                whole_call("call_a", "workspace_write_file", {"path": "a.md", "content": "a"}),
                whole_call("call_b", "workspace_write_file", {"path": "b.md", "content": "b"}),
            ),
            (text("both written"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)
    assert activities(sent) == [
        ("workspace_write_file", "start"),
        ("workspace_write_file", "ok"),
        ("workspace_write_file", "start"),
        ("workspace_write_file", "ok"),
    ]
    assert sorted(p.name for p in workspace.iterdir()) == ["a.md", "b.md"]
    tool_messages = [m for m in gateway.payloads[1]["messages"] if m["role"] == "tool"]
    assert [m["tool_call_id"] for m in tool_messages] == ["call_a", "call_b"]


# -- the buffer on its own -------------------------------------------------


def _buffered(*fragments: dict) -> list[tuple[str, str, str]]:
    buffer = chat.ToolCallBuffer()
    for fragment in fragments:
        buffer.add(fragment)
    return [(call.id, call.name, call.arguments) for call in buffer.finished()]


def _fragment(*, index=None, call_id=None, name=None, arguments=None) -> dict:
    function: dict = {}
    if name is not None:
        function["name"] = name
    if arguments is not None:
        function["arguments"] = arguments
    fragment: dict = {"function": function}
    if index is not None:
        fragment["index"] = index
    if call_id is not None:
        fragment["id"] = call_id
    return fragment


def test_the_buffer_folds_a_trailing_echo_into_the_call_it_restates():
    assert _buffered(
        _fragment(index=0, call_id="a", name="get_time", arguments=""),
        _fragment(index=0, arguments='{"x":'),
        _fragment(index=0, arguments=" 1}"),
        _fragment(call_id="a", name="get_time", arguments='{"x": 1}'),
    ) == [("a", "get_time", '{"x": 1}')]


def test_the_buffer_keeps_two_un_indexed_calls_with_no_ids_apart():
    assert _buffered(
        _fragment(name="get_time", arguments="{}"),
        _fragment(name="workspace_list_files", arguments="{}"),
    ) == [("call_1", "get_time", "{}"), ("call_2", "workspace_list_files", "{}")]


def test_the_buffer_keeps_two_un_indexed_calls_with_distinct_ids_apart():
    assert _buffered(
        _fragment(call_id="a", name="get_time", arguments="{}"),
        _fragment(call_id="b", name="get_time", arguments="{}"),
    ) == [("a", "get_time", "{}"), ("b", "get_time", "{}")]


def test_indexed_argument_fragments_still_concatenate_when_the_id_repeats():
    """A backend that repeats the id on every indexed delta must not have
    its arguments replaced fragment by fragment."""
    assert _buffered(
        _fragment(index=0, call_id="a", name="memory_save", arguments='{"ti'),
        _fragment(index=0, call_id="a", arguments='tle": "x"}'),
    ) == [("a", "memory_save", '{"title": "x"}')]


def test_two_calls_a_backend_gave_the_same_id_do_not_share_a_tool_call_id():
    """Two indexed calls really are two calls; a strict backend rejects two
    tool results carrying one id, so the duplicate is re-minted."""
    ids = [
        call_id
        for call_id, _name, _args in _buffered(
            _fragment(index=0, call_id="dup", name="get_time", arguments="{}"),
            _fragment(index=1, call_id="dup", name="get_time", arguments="{}"),
        )
    ]
    assert len(set(ids)) == 2
    assert ids[0] == "dup"


def test_the_buffer_folds_a_whole_call_a_proxy_sent_twice():
    """The same non-streamed call relayed twice is one call, not two."""
    whole = _fragment(call_id="a", name="get_time", arguments="{}")
    assert _buffered(whole, dict(whole)) == [("a", "get_time", "{}")]


async def test_a_tools_progress_reports_stream_as_progress_frames_with_detail(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """ToolContext.progress (S10a-3) is bound per call to an activity frame
    with status 'progress' and the tool's own words in `detail` — a pull's
    percentage moving in the bubble. Frames: start, progress…, ok."""
    from app import tools
    from app.tools.base import Tool

    async def slow(args, ctx):
        ctx.progress("pulling qwen3:4b — 42% (1.0 GB of 2.3 GB)")
        ctx.progress("pulling qwen3:4b — 100% (2.3 GB of 2.3 GB)")
        return "Pulled ollama:qwen3:4b"

    monkeypatch.setitem(
        tools.REGISTRY,
        "slow_tool",
        Tool(name="slow_tool", description="x", parameters={"type": "object"}, executor=slow),
    )
    gateway = ScriptedGateway(
        rounds=(
            (*streamed_call(0, "c1", "slow_tool", {}),),
            (text("Done — qwen3:4b is installed."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)
    assert activities(sent) == [
        ("slow_tool", "start"),
        ("slow_tool", "progress"),
        ("slow_tool", "progress"),
        ("slow_tool", "ok"),
    ]
    assert [f["detail"] for f in activity_frames(sent, "progress")] == [
        "pulling qwen3:4b — 42% (1.0 GB of 2.3 GB)",
        "pulling qwen3:4b — 100% (2.3 GB of 2.3 GB)",
    ]
    assert "detail" not in activity_frames(sent, "start")[0]


async def test_a_stop_lands_inside_a_long_tool_call_not_only_between_them(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """The case that prompted the feature: a download that reports as it goes.

    The stop is checked in the PROGRESS callback the turn binds for every call,
    so ANY long tool that reports its own progress becomes interruptible
    without knowing Stop exists — derived from the reporting it already does,
    not from a list of interruptible tools someone maintains.

    The honest limit is in the assertions: core stopped WAITING on the call. It
    does not claim the work the call had already done was undone, and the
    reply must not say otherwise.
    """
    from app import tools
    from app.tools.base import Tool

    steps: list[int] = []

    async def slow(args, ctx):
        for i in range(200):
            steps.append(i)
            # The stop rides out through here — the same call that draws the bar.
            ctx.progress(f"step {i} of 200")
            await asyncio.sleep(0.005)
        return "finished all 200 steps"

    monkeypatch.setitem(
        tools.REGISTRY,
        "slow_tool",
        Tool(name="slow_tool", description="x", parameters={"type": "object"}, executor=slow),
    )
    gateway = ScriptedGateway(
        rounds=(
            (*streamed_call(0, "c1", "slow_tool", {}),),
            (text("all 200 steps are done."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn = asyncio.create_task(
        owner_client.post("/api/v1/chat/stream", json={"message": "do the slow thing"})
    )
    while len(steps) < 3:
        await asyncio.sleep(0.005)
    turn_id = await pool.fetchval("SELECT id FROM turns WHERE status IS NULL")
    stop = await owner_client.post(f"/api/v1/chat/turns/{turn_id}/stop")
    assert stop.status_code == 200, stop.text

    resp = await asyncio.wait_for(turn, timeout=10)
    assert resp.status_code == 200
    await asyncio.wait_for(chat.drain_background(), timeout=10)

    assert len(steps) < 200, "the call ran to the end — the stop never landed inside it"
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn_id) == "stopped"
    reply = await pool.fetchval(
        "SELECT content FROM messages WHERE turn_id = $1 AND role = 'assistant'", turn_id
    )
    assert reply is not None, "a stopped turn still owes the owner a visible reply"
    assert "slow_tool" in reply, "it says what it was doing when it stopped"
    assert "all 200 steps are done" not in reply, "the round after the stop never ran"
    assert "finished all 200 steps" not in reply, "it does not claim the call completed"
