"""S47 — the card channel: a UI-only frame beside her reply.

A card carries what she must never hold (a pairing code), so the channel's
contract is mostly where the payload may NOT go: never into the model's next
round, never onto a span, never into the stored reply. And it exists only
where there is a chat to show it in — the stream route — never in a turn that
streams to nobody (a drained queue, a schedule, an agent's own turn)."""

from __future__ import annotations

import json

import pytest

from app import chat, tools
from app.tools.base import Tool
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway

pytestmark = requires_db

DONE = "[DONE]"
# A marker that must appear in the card frame and NOWHERE else.
SECRET = "CARD-SECRET-7Q4W"


def frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        assert block.startswith("data: "), block
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def whole_call(call_id: str, name: str, arguments: dict) -> dict:
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


async def _card_tool(args: dict, ctx) -> str:
    if ctx.card is None:
        return "there is no chat to show a card in"
    ctx.card({"kind": "test_card", "secret": SECRET})
    return "sent a card to the chat"


CARD_TOOL = Tool(
    name="test_card_tool",
    description="Sends a test card.",
    parameters={"type": "object", "properties": {}, "additionalProperties": False},
    executor=_card_tool,
)


@pytest.fixture
def card_tool(monkeypatch):
    monkeypatch.setitem(tools.REGISTRY, CARD_TOOL.name, CARD_TOOL)
    return CARD_TOOL


async def set_chat_model(client) -> None:
    resp = await client.put("/api/v1/settings", json={"key": "chat.model", "value": "qwen3:8b"})
    assert resp.status_code == 200, resp.text


async def test_a_card_reaches_the_stream_and_nowhere_else(
    owner_client, pool, mount_peers, card_tool
):
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("call_1", "test_card_tool", {}),),
            (text("The card is in the chat."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await set_chat_model(owner_client)
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "show me a card"})
    assert resp.status_code == 200, resp.text
    sent = frames(resp.text)

    cards = [f["card"] for f in sent if isinstance(f, dict) and "card" in f]
    assert cards == [{"kind": "test_card", "secret": SECRET}]
    # Every OTHER frame is free of it.
    others = [f for f in sent if not (isinstance(f, dict) and "card" in f)]
    assert SECRET not in json.dumps(others)
    # The model's next round was told only the tool's result.
    assert SECRET not in json.dumps(gateway.payloads)
    # Not on any span, not in any stored message.
    spans = await pool.fetch("SELECT meta::text AS meta FROM turn_spans")
    assert all(SECRET not in row["meta"] for row in spans)
    stored = await pool.fetch("SELECT content FROM messages")
    assert all(SECRET not in row["content"] for row in stored)


async def test_a_context_built_without_a_channel_has_none(card_tool):
    """Every caller but the stream route builds its context this way."""
    import uuid

    from app.identity import Person

    person = Person(id=uuid.uuid4(), name="jeremy", role="owner")
    ctx = tools.context_for(None, person, facts_sink=[])
    assert ctx.card is None
    said = await tools.REGISTRY["test_card_tool"].executor({}, ctx)
    assert said == "there is no chat to show a card in"


def test_the_card_channel_emits_one_card_frame():
    seen: list = []
    send = chat._card_channel(seen.append)
    send({"kind": "setup_qr", "setup": "install_pwa"})
    assert seen == ['data: {"card": {"kind": "setup_qr", "setup": "install_pwa"}}\n\n']


def test_only_the_stream_route_hands_a_turn_a_card_channel():
    """The scheduler, the queue drain and an agent's turn stream to nobody:
    a card sent there would mint a code for no one and call it sent."""
    import inspect

    source = inspect.getsource(chat)
    assert source.count("card=_card_channel(") == 1
    assert "card=_card_channel(queue.put_nowait)" in source
