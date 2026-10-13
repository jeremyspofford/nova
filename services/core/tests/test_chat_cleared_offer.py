"""The cleared-offer guard wired into the live turn (guard follow-ups T1).

Turn f816e1c2: after real tool work she asked "Do you want me to disable Fast
Startup now? That one I can actually do." guards.cleared_offer_check detects
that from her reply alone; this file drives the REAL chat round loop through a
scripted gateway to pin what the turn then does — the own-tool handback's
pattern (#145):

  * a guard span "cleared_offer" and ONE redirect round that advertises tools,
    even though tools already ran ok this turn (the after-tools mode);
  * her next call is dispatched — nothing is blocked or refused;
  * a redirect that asks leave again ends with the honest note APPENDED;
  * a reply offering EXTRA work ("also …") draws no span and no extra round;
  * the nudge lists this turn's calls and leaves scope to her: do it if it is
    part of what he asked, answer without asking leave if it is not.
"""

from __future__ import annotations

import json

from app import chat, tools
from app.tools.base import Tool, ToolContext
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


def call_delta(index: int, *, call_id, name, arguments) -> dict:
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": index,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                    ]
                }
            }
        ]
    }


class Spy:
    def __init__(self, result: str) -> None:
        self.calls: list = []
        self.result = result

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        return self.result


def _arm_run(monkeypatch) -> Spy:
    spy = Spy("exit 0\nok")
    schema = {
        "type": "object",
        "properties": {"device": {"type": "string"}, "argv": {"type": "array"}},
    }
    monkeypatch.setitem(tools.REGISTRY, "device_run", Tool("device_run", "d", schema, spy))
    return spy


READ = {"device": "dell", "argv": ["powercfg", "/a"]}
CHANGE = {"device": "dell", "argv": ["powercfg", "/h", "off"]}
MESSAGE = "now set up the dell so it can be woken over the network"
OFFER = (
    "The adapters are armed and S3 is available. Fast Startup is the remaining blocker. "
    "Do you want me to disable Fast Startup now? That one I can actually do."
)
OFFER_AGAIN = "Should I go ahead and disable Fast Startup? I can do that."
ANSWER = (
    "Done: Fast Startup is off (powercfg /h off, exit 0), "
    "so the Dell can be woken over the network."
)
EXTRA = (
    "Done: Fast Startup is off and the adapters are armed. "
    "Want me to also run a wake test from the hub? I can do that too."
)


async def _say(client) -> list:
    resp = await client.post("/api/v1/chat/stream", json={"message": MESSAGE})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


async def _spans(pool) -> list:
    rows = await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'guard' ORDER BY started_at"
    )
    return [
        json.loads(r["meta"]) if isinstance(r["meta"], str) else r["meta"]
        for r in rows
        if r["name"] == "cleared_offer"
    ]


async def test_f816e1c2_after_tools_ran_the_offer_redirects_with_tools_and_her_call_runs(
    owner_client, pool, mount_peers, monkeypatch
):
    run = _arm_run(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (call_delta(0, call_id="a1", name="device_run", arguments=READ),),
            (text(OFFER),),
            (call_delta(0, call_id="a2", name="device_run", arguments=CHANGE),),
            (text(ANSWER),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    spans = await _spans(pool)
    assert len(spans) == 1, "her permission question beside her own can-do must draw a span"
    assert spans[0]["detected"] is True
    assert "disable Fast Startup" in spans[0]["action"]
    assert spans[0]["redirected"] is True
    assert gateway.calls == 4
    assert gateway.payloads[2].get("tools"), "the redirect round must advertise tools"
    assert run.calls == [READ, CHANGE]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == ANSWER
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    assert sent[-1] == DONE


async def test_a_redirect_that_asks_leave_again_ends_with_the_honest_note(
    owner_client, pool, mount_peers, monkeypatch
):
    _arm_run(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (call_delta(0, call_id="a1", name="device_run", arguments=READ),),
            (text(OFFER),),
            (text(OFFER_AGAIN),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    spans = await _spans(pool)
    assert len(spans) == 1
    assert spans[0]["redirected"] is False
    assert gateway.calls == 3, "one redirect only, never a second"
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored.startswith(OFFER)
    assert chat.cleared_offer_note("disable Fast Startup now") in stored


async def test_an_offer_of_extra_work_draws_no_span_and_no_round(
    owner_client, pool, mount_peers, monkeypatch
):
    _arm_run(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (call_delta(0, call_id="a1", name="device_run", arguments=CHANGE),),
            (text(EXTRA),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client)

    assert await _spans(pool) == []
    assert gateway.calls == 2
    assert await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'") == EXTRA


def test_the_nudge_lists_the_turns_calls_and_leaves_scope_to_her():
    class S:
        kind, name, meta = "tool", "device_run", {"ok": True}

    nudge = chat.cleared_offer_nudge("disable Fast Startup now", [S()])
    assert "disable Fast Startup now" in nudge
    assert "- device_run: ok" in nudge
    assert "no approval step" in nudge
    assert "part of what he asked" in nudge
    assert "without asking" in nudge
    note = chat.cleared_offer_note("disable Fast Startup now")
    assert "disable Fast Startup now" in note and "no approval step" in note
