"""S30c T7: `ToolContext.turn_id` — which turn a call ran in, for provenance.

A job outlives the turn that started it, so the device_jobs row has to say
which turn started it (T10 writes ctx.turn_id on the row). The context is the
one place a tool learns about its turn, so the turn's id rides there — set by
chat, the one place a turn runs, and None everywhere else (a reminder firing,
a distil beat, a rewind: none of them is a turn).

It is an identity channel for PROVENANCE, never a principal: nothing reads it
to decide whether a call may run (test_no_approvals pins that dispatch never
touches it).
"""

from __future__ import annotations

import json
import uuid

from app import tools
from app.identity import Person
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_agents import _agent_turn, _create, _owner

SCHEMA = {"type": "object", "properties": {}, "additionalProperties": False}


def _person() -> Person:
    return Person(id=uuid.uuid4(), name="jeremy", role="owner")


def _spy(monkeypatch, name: str = "fake_turn_spy") -> list:
    seen: list = []

    async def spy(args: dict, ctx: ToolContext) -> str:
        seen.append(ctx.turn_id)
        return "seen"

    monkeypatch.setitem(
        tools.REGISTRY,
        name,
        Tool(name=name, description="d", parameters=SCHEMA, executor=spy, reads_only=True),
    )
    return seen


def _call(call_id: str, name: str) -> dict:
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps({})},
                        }
                    ]
                }
            }
        ]
    }


def _text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


# -- C1: the field ---------------------------------------------------------------


def test_tool_context_turn_id_defaults_to_none(tmp_path):
    ctx = ToolContext(app=None, person=_person(), workspace_root=tmp_path)
    assert ctx.turn_id is None


# -- C2: context_for carries it, and leaves it None outside a turn ---------------


def test_context_for_carries_the_turn_id(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    turn_id = uuid.uuid4()
    ctx = tools.context_for(None, _person(), turn_id=turn_id)
    assert ctx.turn_id == turn_id


def test_context_for_without_a_turn_leaves_it_none(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    assert tools.context_for(None, _person()).turn_id is None


async def test_dispatch_hands_the_executor_the_contexts_turn_id(monkeypatch, tmp_path):
    seen = _spy(monkeypatch)
    turn_id = uuid.uuid4()
    ctx = ToolContext(app=None, person=_person(), workspace_root=tmp_path, turn_id=turn_id)
    assert await tools.dispatch("fake_turn_spy", "{}", ctx) == ("seen", True)
    assert seen == [turn_id]


# -- C3: a real chat turn hands its tools ITS id -----------------------------------


@requires_db
async def test_a_nova_chat_turn_hands_its_tools_the_turn_id(
    owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "ws"))
    seen = _spy(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (_call("c1", "fake_turn_spy"),),
            (_call("c2", "fake_turn_spy"),),
            (_text("done"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "look"})
    assert resp.status_code == 200, resp.text

    turn_ids = [r["id"] for r in await pool.fetch("SELECT id FROM turns WHERE kind = 'chat'")]
    assert len(turn_ids) == 1
    # Both calls of the turn carry the turn's own id — the one turn_spans is keyed by.
    assert seen == [turn_ids[0], turn_ids[0]]
    spans = await pool.fetchval(
        "SELECT count(*) FROM turn_spans WHERE turn_id = $1 AND name = 'fake_turn_spy'",
        turn_ids[0],
    )
    assert spans == 2


@requires_db
async def test_two_chat_turns_each_hand_their_own_id(
    owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "ws"))
    seen = _spy(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (_call("c1", "fake_turn_spy"),),
            (_text("one"),),
            (_call("c2", "fake_turn_spy"),),
            (_text("two"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    for message in ("first", "second"):
        resp = await owner_client.post("/api/v1/chat/stream", json={"message": message})
        assert resp.status_code == 200, resp.text

    ordered = [
        r["id"]
        for r in await pool.fetch("SELECT id FROM turns WHERE kind = 'chat' ORDER BY started_at")
    ]
    assert len(ordered) == 2 and ordered[0] != ordered[1]
    assert seen == ordered


# -- C4: an agent's turn hands its tools the agent turn's id ----------------------


@requires_db
async def test_an_agent_turn_hands_its_tools_its_turn_id(pool, mount_peers, monkeypatch, tmp_path):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "ws"))
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers)
    seen = _spy(monkeypatch)
    # A call outside the agent's subset still RUNS (scope, not a gate), so the
    # spy needs no place in the agent's toolset.
    mount_peers(
        gateway=ScriptedGateway(rounds=((_call("c1", "fake_turn_spy"),), (_text("done"),))),
        memory=FakeMemory(),
    )
    turn, _frames = await _agent_turn(pool, agent, owner)
    assert isinstance(turn.id, uuid.UUID)
    assert seen == [turn.id]
