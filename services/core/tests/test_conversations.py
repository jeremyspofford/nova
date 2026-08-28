"""Conversations belong to a person, and only to that person."""
from __future__ import annotations

import uuid

from tests.conftest import requires_db

pytestmark = requires_db


async def test_active_creates_one_then_reuses_it(owner_client, pool):
    first = await owner_client.get("/api/v1/conversations/active")
    assert first.status_code == 200
    body = first.json()
    assert set(body) == {"id", "title", "created_at"}
    assert body["created_at"]

    second = await owner_client.get("/api/v1/conversations/active")
    assert second.json()["id"] == body["id"]
    assert await pool.fetchval("SELECT count(*) FROM conversations") == 1


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
