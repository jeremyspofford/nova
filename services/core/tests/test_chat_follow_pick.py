"""A turn sending chat's pick asks for the pick as it stands now (2026-10-05).

The walk that found it: asked "switch chat to gemini on openrouter for now",
she called set_chat_model, the pick was stored and read back — and round 4 of
the same turn died with "no model in the 'chat' chain can serve right now".
The turn read chat.model once, when it opened, so it kept asking for the Dell
while the pick had rewritten chat's chain to [Dell] alone, and the Dell was
walled. Every turn that switched models broke its own remaining rounds, and a
pick made in the switcher while she was answering broke hers the same way.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

import pytest
from starlette.applications import Starlette

from app import chat, settings_store, tools, traces
from app.main import app
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db
from tests.fakes import FakeMemory, Refusal, ScriptedGateway
from tests.test_proxies import DELL, GEMINI, RoutesGateway

pytestmark = requires_db

ASK = [{"role": "user", "content": "hi"}]
PICTURE = [
    {
        "role": "user",
        "content": [
            {"type": "text", "text": "what is this?"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
        ],
    }
]
SEEING = "hub:qwen3-vl:8b"


def _turn(model: str = DELL, **fields) -> traces.Turn:
    return traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC), model=model, **fields)


async def _chat_model_is(pool, value: str) -> None:
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('chat.model', to_jsonb($1::text)) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        value,
    )


# -- the rule -------------------------------------------------------------------


@pytest.mark.parametrize("kind", ["chat", "scheduled", "beat"])
async def test_a_turn_sending_chat_s_pick_asks_for_the_pick_as_it_stands(pool, kind):
    turn = _turn(kind=kind)
    await _chat_model_is(pool, DELL)
    assert await chat._round_model(turn, DELL, ASK) == DELL
    await _chat_model_is(pool, GEMINI)
    assert await chat._round_model(turn, DELL, ASK) == GEMINI


async def test_a_turn_opened_with_no_pick_asks_for_the_one_made_since(pool):
    # The turn sent no model (chat.model was unset) and a pick was then made.
    await _chat_model_is(pool, GEMINI)
    assert await chat._round_model(_turn(model=""), "", ASK) == GEMINI


async def test_a_cleared_pick_keeps_what_the_turn_was_asking_for(pool):
    await _chat_model_is(pool, "")
    assert await chat._round_model(_turn(), DELL, ASK) == DELL


@pytest.mark.parametrize(
    ("turn", "model"),
    [
        (_turn(kind="eval"), DELL),  # an eval names its candidate
        (_turn(model="", role="agent_coder"), ""),  # an agent walks its own role
        (_turn(), SEEING),  # swapped to a model that can see the turn's pictures
    ],
    ids=["eval", "agent", "vision-swap"],
)
async def test_a_turn_not_sending_chat_s_pick_keeps_its_model(pool, turn, model):
    await _chat_model_is(pool, GEMINI)
    assert await chat._round_model(turn, model, ASK) == model


async def test_a_turn_carrying_pictures_keeps_the_model_they_were_checked_against(pool):
    # chat.model could see, so nothing was swapped; a pick must not hand the
    # pictures to a model nobody checked.
    await _chat_model_is(pool, GEMINI)
    assert await chat._round_model(_turn(), DELL, PICTURE) == DELL


async def test_a_pick_that_cannot_be_read_keeps_what_the_turn_was_asking_for(pool, monkeypatch):
    async def locked(_pool, _key):
        raise ConnectionError("the settings table is locked")

    monkeypatch.setattr(settings_store, "read_value", locked)
    assert await chat._round_model(_turn(), DELL, ASK) == DELL


# -- through the real route -----------------------------------------------------


def tool_call(call_id: str, name: str, args: dict) -> dict:
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(args)},
                        }
                    ]
                }
            }
        ]
    }


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


class PickingGateway:
    """Chat's rounds and the admin answers a pick reads and writes, on one
    gateway — as they are on the real one."""

    def __init__(self, rounds: tuple, chain: list[str]) -> None:
        self.scripted = ScriptedGateway(rounds=rounds)
        self.routes = RoutesGateway(chain)
        self.app = Starlette(routes=[*self.scripted.app.routes, *self.routes.app.routes])


async def _llm_models(pool) -> list[str]:
    rows = await pool.fetch(
        "SELECT meta FROM turn_spans WHERE kind = 'llm_call' ORDER BY started_at"
    )
    return [row["meta"]["model"] for row in rows]


async def _say(owner_client, message: str) -> None:
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text


async def test_the_rounds_after_her_pick_ask_for_the_new_pick(owner_client, pool, mount_peers):
    gateway = PickingGateway(
        rounds=(
            (tool_call("p1", "set_chat_model", {"model": GEMINI}),),
            (text("Gemini answers chat first now; the Dell is its fallback."),),
        ),
        chain=[],
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _chat_model_is(pool, DELL)

    await _say(owner_client, "switch chat to gemini on openrouter for now")

    assert [p.get("model") for p in gateway.scripted.payloads] == [DELL, GEMINI]
    assert await _llm_models(pool) == [DELL, GEMINI]
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    assert await settings_store.read_value(pool, "chat.model") == GEMINI
    assert gateway.routes.chain == [DELL]


async def test_a_pick_made_elsewhere_while_she_answers_lands_at_her_next_round(
    owner_client, pool, mount_peers, monkeypatch
):
    # The switcher in another tab, or an agent she delegated to: nothing in
    # this turn made the pick, and its next round asks for it all the same.
    async def switched_elsewhere(_args: dict, _ctx: ToolContext) -> str:
        await _chat_model_is(pool, GEMINI)
        return "looked"

    monkeypatch.setitem(
        tools.REGISTRY,
        "look_around",
        Tool(
            "look_around",
            "d",
            {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
            switched_elsewhere,
        ),
    )
    gateway = ScriptedGateway(
        rounds=((tool_call("l1", "look_around", {}),), (text("Nothing to report."),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _chat_model_is(pool, DELL)

    await _say(owner_client, "look around")

    assert [p.get("model") for p in gateway.payloads] == [DELL, GEMINI]


async def test_a_judge_or_redirect_call_asks_for_the_pick_as_it_stands(pool, mount_peers):
    # The text-only calls (the responsiveness judge, both redirects) send the
    # turn's model too, so they read the pick the same way.
    gateway = ScriptedGateway(rounds=((text("on_topic"),),))
    mount_peers(gateway=gateway)
    await _chat_model_is(pool, GEMINI)

    await chat._collect_completion(app, _turn(), DELL, ASK, purpose="judge")

    assert [p.get("model") for p in gateway.payloads] == [GEMINI]


async def test_a_round_that_fails_after_her_pick_names_the_pick_it_asked_for(
    owner_client, pool, mount_peers
):
    refused = "no model in the 'chat' chain can serve right now"
    gateway = PickingGateway(
        rounds=(
            (tool_call("p1", "set_chat_model", {"model": GEMINI}),),
            Refusal(status=503, body={"error": refused}),
        ),
        chain=[],
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _chat_model_is(pool, DELL)

    await _say(owner_client, "switch chat to gemini on openrouter for now")

    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored.startswith(
        f"I didn't get a response from {GEMINI} in round 2: "
        f"the gateway refused the request (503): {refused}"
    ), stored
