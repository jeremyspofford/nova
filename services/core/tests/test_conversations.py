"""Conversations belong to a person, and only to that person."""
from __future__ import annotations

import logging
import uuid

from app import traces
from app.main import app, lifespan
from tests.conftest import OWNER, requires_db

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


async def _pending(owner_client) -> bool:
    return (await owner_client.get("/api/v1/conversations/active")).json()["pending_turn"]


async def test_active_reports_a_turn_this_process_is_running(owner_client, pool):
    """pending_turn is derived from TWO live facts: an unclosed turns row
    (status NULL) AND this process holding it in traces.INFLIGHT — the flag a
    reloaded client reads to know it should poll for the finishing reply.
    The row alone is not a turn: the moment the process lets go of the id
    the flag clears, whether or not the row has closed yet."""
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]

    # An open, not-yet-closed turn (status NULL), exactly as chat.py leaves it
    # while the model is still answering...
    turn_id = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id) VALUES ('chat', $1) RETURNING id",
        uuid.UUID(conversation),
    )
    # ...and registered as running HERE, exactly as chat_stream does.
    traces.INFLIGHT.add(turn_id)
    try:
        assert await _pending(owner_client) is True
    finally:
        traces.INFLIGHT.discard(turn_id)
    # Let go of it — the process is no longer running this turn.
    assert await _pending(owner_client) is False

    # Closed, the row is terminal and stays clear.
    await pool.execute("UPDATE turns SET status = 'ok', ended_at = now() WHERE id = $1", turn_id)
    assert await _pending(owner_client) is False


async def test_a_turn_no_process_is_running_is_never_pending(owner_client, pool, caplog):
    """The 2026-09-01 defect: core was SIGKILLed mid-turn by a redeploy, so
    close_turn never ran, and the NULL row it left read as "Nova is still
    responding" for a day. A NULL row THIS process is not running is not
    pending — and because the startup sweep should have closed it, finding one
    is said at WARNING rather than tidied silently."""
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    turn_id = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id) VALUES ('chat', $1) RETURNING id",
        uuid.UUID(conversation),
    )
    assert turn_id not in traces.INFLIGHT

    with caplog.at_level(logging.WARNING, logger="core"):
        assert await _pending(owner_client) is False

    (line,) = [
        r.getMessage()
        for r in caplog.records
        if r.levelno == logging.WARNING and str(turn_id) in r.getMessage()
    ]
    assert "no process is running" in line
    assert conversation in line
    # The row itself is untouched: reporting is not repairing — the sweep at
    # startup is the one writer of 'interrupted'.
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn_id) is None


async def test_startup_closes_an_orphan_before_anyone_can_read_it_as_pending(
    owner_client, pool
):
    """The whole path, through the app's real lifespan: a NULL-status turn in
    the owner's active conversation left by a dead process is 'interrupted'
    once the app has started, and /conversations/active reports no pending
    turn. (Plain ASGITransport never runs the lifespan — conftest — so it is
    entered here directly; that is the startup the container runs.)"""
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    orphan = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id) VALUES ('chat', $1) RETURNING id",
        uuid.UUID(conversation),
    )
    assert orphan not in traces.INFLIGHT

    async with lifespan(app):
        row = await pool.fetchrow("SELECT status, ended_at FROM turns WHERE id = $1", orphan)
        assert row["status"] == "interrupted"
        assert row["ended_at"] is not None
        assert await _pending(owner_client) is False


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


# -- clear chat: delete the transcript, leave the audit + memory alone ------


async def test_clear_deletes_this_conversations_messages(owner_client, pool):
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    for role, content in [("user", "hi"), ("assistant", "hello"), ("user", "again")]:
        await pool.execute(
            "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
            conversation,
            role,
            content,
        )

    resp = await owner_client.post(f"/api/v1/conversations/{conversation}/clear")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"id": conversation, "cleared": 3}  # a real count, not a bare "ok"

    # The transcript is gone; the empty state is real.
    remaining = await pool.fetchval(
        "SELECT count(*) FROM messages WHERE conversation_id = $1", conversation
    )
    assert remaining == 0
    listed = (await owner_client.get(f"/api/v1/conversations/{conversation}/messages")).json()
    assert listed["messages"] == []


async def test_clear_needs_an_identity(client, pool):
    # A real, owned conversation exists — the refusal is about the caller, not
    # the target. Register the owner, take their conversation, then call as an
    # anonymous client (no cookie, no bearer).
    resp = await client.post("/api/v1/auth/register", json=OWNER)
    assert resp.status_code == 200
    conversation = (await client.get("/api/v1/conversations/active")).json()["id"]
    # Drop the session cookie so the next call carries no identity at all.
    client.cookies.clear()
    resp = await client.post(f"/api/v1/conversations/{conversation}/clear")
    assert resp.status_code == 401
    # Nothing was cleared — but there was nothing to clear; the point is the 401.


async def test_clear_on_someone_elses_conversation_is_a_404_and_touches_nothing(
    owner_client, pool
):
    stranger = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('stranger', 'adult') RETURNING id"
    )
    theirs = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", stranger
    )
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'theirs')",
        theirs,
    )

    resp = await owner_client.post(f"/api/v1/conversations/{theirs}/clear")
    assert resp.status_code == 404  # not found, not forbidden — someone else's

    # Their message is untouched: a 404 clears nothing.
    assert (
        await pool.fetchval("SELECT count(*) FROM messages WHERE conversation_id = $1", theirs)
    ) == 1


async def test_clear_on_an_unknown_conversation_is_a_404(owner_client):
    resp = await owner_client.post(f"/api/v1/conversations/{uuid.uuid4()}/clear")
    assert resp.status_code == 404


async def test_clear_leaves_the_audit_trail_and_conversation_intact(owner_client, pool):
    """Clear removes the transcript, NOT the audit history. turns/turn_spans and
    the governance ledger are what Activity and the operator's audit read; they
    must survive a clear — and the conversation row itself survives, so a turn's
    conversation_id is not even nulled."""
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'ask')",
        conversation,
    )
    turn_id = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, status, ended_at) "
        "VALUES ('chat', $1, 'ok', now()) RETURNING id",
        conversation,
    )
    await pool.execute(
        "INSERT INTO turn_spans (turn_id, kind, name) VALUES ($1, 'tool', 'fetch_url')",
        turn_id,
    )
    await pool.execute("INSERT INTO governance_events (kind) VALUES ('device.enrolled')")

    resp = await owner_client.post(f"/api/v1/conversations/{conversation}/clear")
    assert resp.status_code == 200

    # Transcript gone...
    msg_count = await pool.fetchval(
        "SELECT count(*) FROM messages WHERE conversation_id = $1", conversation
    )
    assert msg_count == 0
    # ...but every audit row remains, and the conversation still exists.
    assert await pool.fetchval("SELECT count(*) FROM turns") == 1
    conversation_id = await pool.fetchval(
        "SELECT conversation_id FROM turns WHERE id = $1", turn_id
    )
    assert conversation_id is not None
    span_count = await pool.fetchval(
        "SELECT count(*) FROM turn_spans WHERE turn_id = $1", turn_id
    )
    assert span_count == 1
    assert await pool.fetchval("SELECT count(*) FROM governance_events") == 1
    assert (
        await pool.fetchval("SELECT count(*) FROM conversations WHERE id = $1", conversation)
    ) == 1
