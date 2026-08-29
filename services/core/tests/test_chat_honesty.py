"""The honesty guard wired into the live turn.

test_guards.py pins the matcher in isolation; these prove the wiring: a
fabricated claim is corrected in the PERSISTED text and streamed as its own
frame with a kind='guard' span in the atomic close, and an honest turn is
byte-identical to what shipped before the guard existed.
"""
from __future__ import annotations

import json

import pytest

from app import chat, guards
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway

pytestmark = requires_db

DONE = "[DONE]"


def frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        assert block.startswith("data: "), block
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def _call_delta(index: int, *, call_id=None, name=None, arguments=None) -> dict:
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


def streamed_call(index: int, call_id: str, name: str, arguments: dict) -> tuple[dict, ...]:
    blob = json.dumps(arguments)
    head, tail = blob[: len(blob) // 2], blob[len(blob) // 2 :]
    return (
        _call_delta(index, call_id=call_id, name=name, arguments=""),
        _call_delta(index, arguments=head),
        _call_delta(index, arguments=tail),
    )


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


async def _say(client, message: str = "summarize kv offloading to a file") -> list:
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


async def _spans(pool, kind: str | None = None) -> list:
    rows = await pool.fetch(
        "SELECT kind, name, meta FROM turn_spans ORDER BY started_at, kind"
    )
    return [row for row in rows if kind is None or row["kind"] == kind]


async def test_a_fabricated_write_is_corrected_in_the_record_and_leaves_a_guard_span(
    owner_client, pool, mount_peers, workspace
):
    """The captured live lie, reproduced: the model claims a file write with
    no tool call at all. The reply the operator keeps must carry the
    contradiction, and the guard firing must be visible in the ledger."""
    gateway = ScriptedGateway(
        rounds=((text("I've created a summary file called kv_offloading_summary.md."),),)
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client)

    # The turn still succeeds and still says what it said — plus the truth.
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored.startswith("I've created a summary file called kv_offloading_summary.md.")
    assert stored.endswith(guards.CORRECTION_TEXT)

    # The correction reached the stream on its own frame, before [DONE].
    corrections = [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]
    assert corrections == [guards.CORRECTION_TEXT]
    assert sent[-1] == DONE

    # The guard firing is in the ledger, in the same atomic close, naming the
    # claim it caught and that nothing backed it.
    guard = await _spans(pool, "guard")
    assert len(guard) == 1
    assert guard[0]["name"] == "narration"
    meta = guard[0]["meta"]
    assert meta["backing_span"] is False
    assert meta["claims"] == [{"kind": "wrote_file", "target": "kv_offloading_summary.md"}]

    # No write ever ran — the whole point.
    assert await _spans(pool, "tool") == []

    # What memory remembers is the corrected reply, not the lie.
    await chat.drain_background()
    assert memory.ingests[0]["exchange"]["assistant"].endswith(guards.CORRECTION_TEXT)


async def test_an_honest_write_turn_is_untouched_and_leaves_no_guard_span(
    owner_client, pool, mount_peers, workspace
):
    """A turn that really wrote the file it names ships its success claim
    unchanged: no correction frame, no guard span, the reply byte-identical
    to what it would have been without the guard."""
    reply = "I've created groceries.md with your five items."
    gateway = ScriptedGateway(
        rounds=(
            (
                *streamed_call(
                    0,
                    "call_1",
                    "workspace_write_file",
                    {"path": "groceries.md", "content": "- milk\n- eggs\n- bread\n- tea\n- rice\n"},
                ),
            ),
            (text(reply),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "make me a five-item grocery list")

    assert not [f for f in sent if isinstance(f, dict) and "correction" in f]
    assert await _spans(pool, "guard") == []
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == reply

    # The write really happened, and its span is what backed the claim.
    tool_spans = await _spans(pool, "tool")
    assert [s["name"] for s in tool_spans] == ["workspace_write_file"]
    assert tool_spans[0]["meta"]["ok"] is True
    assert (workspace / "groceries.md").read_text(encoding="utf-8").count("\n") == 5
