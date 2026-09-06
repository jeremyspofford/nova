"""S10-pre: the reply badge is DERIVED from the trace.

The turn stream carries one `served_by` frame — the gateway's own
X-Nova-Served-By (`provider:model`) as read off the llm_call span — and a
reloaded transcript gets the same fact from the same span through the
assistant row's turn link. Neither is ever the model setting the turn ran
under, and neither is anything the reply says about itself."""
from __future__ import annotations

import json

from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory

pytestmark = requires_db

DONE = "[DONE]"


def frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


async def _turn(owner_client, mount_peers, *, served_by: str, model: str) -> list:
    gateway = FakeGateway(deltas=("Hi", "."), served_by=served_by)
    mount_peers(gateway=gateway, memory=FakeMemory())
    resp = await owner_client.put("/api/v1/settings", json={"key": "chat.model", "value": model})
    assert resp.status_code == 200
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "hello"})
    assert resp.status_code == 200
    return frames(resp.text)


async def test_the_stream_carries_the_gateways_served_by_once_after_the_deltas(
    owner_client, mount_peers
):
    sent = await _turn(
        owner_client,
        mount_peers,
        served_by="openrouter:anthropic/claude-sonnet-5",
        model="openrouter:anthropic/claude-sonnet-5",
    )

    badges = [f["served_by"] for f in sent if isinstance(f, dict) and "served_by" in f]
    assert badges == ["openrouter:anthropic/claude-sonnet-5"]
    # After the round's deltas, before DONE.
    kinds = [next(iter(f)) if isinstance(f, dict) else f for f in sent]
    assert kinds == ["meta", "t", "t", "served_by", DONE]


async def test_the_badge_is_what_the_gateway_said_not_the_setting(owner_client, mount_peers):
    """A bare model id routes to the default provider; the badge names the
    provider that actually served, which the setting alone does not say."""
    sent = await _turn(owner_client, mount_peers, served_by="ollama:qwen3:8b", model="qwen3:8b")
    assert sent[0]["meta"]["model"] == "qwen3:8b"
    assert [f["served_by"] for f in sent if isinstance(f, dict) and "served_by" in f] == [
        "ollama:qwen3:8b"
    ]


async def test_a_reloaded_transcript_badges_assistant_rows_from_their_turns_span(
    owner_client, mount_peers, pool
):
    sent = await _turn(
        owner_client,
        mount_peers,
        served_by="anthropic:claude-opus-5",
        model="anthropic:claude-opus-5",
    )
    conversation_id = sent[0]["meta"]["conversation_id"]

    resp = await owner_client.get(f"/api/v1/conversations/{conversation_id}/messages")

    assert resp.status_code == 200
    messages = resp.json()["messages"]
    assert [(m["role"], m["served_by"]) for m in messages] == [
        ("user", None),
        ("assistant", "anthropic:claude-opus-5"),
    ]
    # The link is the turn, and the fact is the span's — not a column on
    # the message row.
    row = await pool.fetchrow("SELECT turn_id FROM messages WHERE role = 'assistant'")
    assert str(row["turn_id"]) == sent[0]["meta"]["turn_id"]
    columns = {
        r["column_name"]
        for r in await pool.fetch(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'messages'"
        )
    }
    assert "served_by" not in columns


async def test_a_row_without_a_turn_has_no_badge_rather_than_an_invented_one(owner_client, pool):
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', 'old')",
        conversation,
    )
    resp = await owner_client.get(f"/api/v1/conversations/{conversation}/messages")
    assert resp.json()["messages"][-1]["served_by"] is None


async def test_no_served_by_frame_when_the_gateway_never_stated_one(owner_client, mount_peers):
    gateway = FakeGateway(deltas=("Hi",), served_by="")
    mount_peers(gateway=gateway, memory=FakeMemory())
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "hello"})
    sent = frames(resp.text)
    assert not any(isinstance(f, dict) and "served_by" in f for f in sent)
