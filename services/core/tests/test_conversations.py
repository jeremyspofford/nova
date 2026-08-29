"""Conversations belong to a person, and only to that person."""
from __future__ import annotations

import uuid

from tests.conftest import requires_db

pytestmark = requires_db


async def test_active_creates_one_then_reuses_it(owner_client, pool):
    first = await owner_client.get("/api/v1/conversations/active")
    assert first.status_code == 200
    body = first.json()
    # pending_turn joined the shape in S2c so a reloaded client can tell a
    # turn is still finishing server-side and poll for it (see chat.py).
    assert set(body) == {"id", "title", "created_at", "pending_turn"}
    assert body["created_at"]
    # A brand-new conversation has no turn in flight.
    assert body["pending_turn"] is False

    second = await owner_client.get("/api/v1/conversations/active")
    assert second.json()["id"] == body["id"]
    assert await pool.fetchval("SELECT count(*) FROM conversations") == 1


async def test_active_reports_a_turn_still_in_flight(owner_client, pool):
    """A turns row with status NULL is a turn still running — the flag a
    reloaded client reads to know it should poll for the finishing reply."""
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]

    # An open, not-yet-closed turn (status NULL), exactly as chat.py leaves it
    # while the model is still answering.
    turn_id = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id) VALUES ('chat', $1) RETURNING id",
        uuid.UUID(conversation),
    )
    assert (await owner_client.get("/api/v1/conversations/active")).json()["pending_turn"] is True

    # Once it closes, the flag clears — the reply has landed.
    await pool.execute("UPDATE turns SET status = 'ok', ended_at = now() WHERE id = $1", turn_id)
    assert (await owner_client.get("/api/v1/conversations/active")).json()["pending_turn"] is False


async def test_messages_come_back_oldest_first(owner_client, pool):
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    for index, (role, content) in enumerate(
        [("user", "first"), ("assistant", "second"), ("user", "third")]
    ):
        await pool.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at) "
            "VALUES ($1, $2, $3, now() + make_interval(secs => $4))",
            conversation,
            role,
            content,
            index,
        )

    resp = await owner_client.get(f"/api/v1/conversations/{conversation}/messages")
    assert resp.status_code == 200
    messages = resp.json()["messages"]
    assert [m["content"] for m in messages] == ["first", "second", "third"]
    assert [m["role"] for m in messages] == ["user", "assistant", "user"]
    assert all(m["created_at"] for m in messages)


async def test_someone_elses_conversation_is_a_404(owner_client, pool):
    stranger = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('stranger', 'adult') RETURNING id"
    )
    theirs = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", stranger
    )
    resp = await owner_client.get(f"/api/v1/conversations/{theirs}/messages")
    assert resp.status_code == 404


async def test_an_unknown_conversation_is_a_404(owner_client):
    resp = await owner_client.get(f"/api/v1/conversations/{uuid.uuid4()}/messages")
    assert resp.status_code == 404


async def test_conversations_need_an_identity(client):
    assert (await client.get("/api/v1/conversations/active")).status_code == 401
