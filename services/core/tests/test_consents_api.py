"""GET/POST /api/v1/consents — the operator's window onto pending approval
cards and the only place one is decided.

Deciding is authenticated exactly like every other route in this service
(a session cookie or the service bearer — see identity.require_person); there
is no separate "operator" role gate yet because none exists anywhere in core
today (a future role-scoping slice can narrow this, per the S3 plan's named
out-of-scope items). What IS pinned here is that an unauthenticated caller
cannot decide anything, that deciding only ever flips status via
consents.decide (never runs the action — that is T1's ruling S3-R4, re-proven
at the HTTP layer), and that a missing or already-decided card is a stated
404, never a silent no-op that looks like success.
"""
from __future__ import annotations

import uuid

from app import consents
from app.identity import Person
from tests.conftest import requires_db

pytestmark = requires_db

ARGS = {"url": "https://example.com/pricing"}


async def _person(pool, role: str = "owner") -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, $2) RETURNING id", role, role
    )
    return Person(id=pid, name=role, role=role)


async def _conversation(pool, person: Person) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person.id
    )


async def _raise(pool, person, *, conversation_id=None, args=ARGS) -> dict:
    return await consents.raise_consent(
        pool,
        action_class="fetch_url",
        args=args,
        summary="Run fetch_url with url=" + args["url"],
        person_id=person.id,
        agent="chat",
        conversation_id=conversation_id,
    )


# -- auth --------------------------------------------------------------


async def test_every_route_needs_an_identity(client, pool):
    person = await _person(pool)
    card = await _raise(pool, person)
    resp = await client.get("/api/v1/consents")
    assert resp.status_code == 401

    resp = await client.post(
        f"/api/v1/consents/{card['consent_id']}/decide", json={"decision": "approve"}
    )
    assert resp.status_code == 401


# -- GET /consents -----------------------------------------------------


async def test_list_returns_only_pending_cards(owner_client, pool):
    resp = await owner_client.get("/api/v1/auth/me")
    person_id = uuid.UUID(resp.json()["person"]["id"])
    person = Person(id=person_id, name="jeremy", role="owner")

    pending = await _raise(pool, person, args={"url": "https://example.com/a"})
    decided = await _raise(pool, person, args={"url": "https://example.com/b"})
    await consents.decide(
        pool, consent_id=uuid.UUID(decided["consent_id"]), approve=True, decided_by=person.id
    )

    resp = await owner_client.get("/api/v1/consents")
    assert resp.status_code == 200
    ids = {c["consent_id"] for c in resp.json()["consents"]}
    assert ids == {pending["consent_id"]}


async def test_list_filters_by_conversation_when_asked(owner_client, pool):
    resp = await owner_client.get("/api/v1/auth/me")
    person = Person(id=uuid.UUID(resp.json()["person"]["id"]), name="jeremy", role="owner")
    conv_a = await _conversation(pool, person)
    conv_b = await _conversation(pool, person)
    card_a = await _raise(pool, person, conversation_id=conv_a, args={"url": "https://example.com/a"})
    await _raise(pool, person, conversation_id=conv_b, args={"url": "https://example.com/b"})

    resp = await owner_client.get(f"/api/v1/consents?conversation_id={conv_a}")
    assert resp.status_code == 200
    cards = resp.json()["consents"]
    assert [c["consent_id"] for c in cards] == [card_a["consent_id"]]


async def test_an_empty_pending_set_lists_as_empty(owner_client):
    resp = await owner_client.get("/api/v1/consents")
    assert resp.status_code == 200
    assert resp.json() == {"consents": []}


# -- POST /consents/{id}/decide -----------------------------------------


async def test_approve_flips_status_and_returns_the_updated_card(owner_client, pool):
    resp = await owner_client.get("/api/v1/auth/me")
    person = Person(id=uuid.UUID(resp.json()["person"]["id"]), name="jeremy", role="owner")
    card = await _raise(pool, person)

    resp = await owner_client.post(
        f"/api/v1/consents/{card['consent_id']}/decide", json={"decision": "approve"}
    )
    assert resp.status_code == 200
    body = resp.json()["consent"]
    assert body["status"] == "approved"
    assert body["consent_id"] == card["consent_id"]

    # Approving ran NOTHING at the kernel — used_at stays NULL (ruling S3-R4).
    row = await consents.get(pool, uuid.UUID(card["consent_id"]))
    assert row["used_at"] is None
    assert row["decided_by"] == person.id


async def test_deny_flips_status_to_denied(owner_client, pool):
    resp = await owner_client.get("/api/v1/auth/me")
    person = Person(id=uuid.UUID(resp.json()["person"]["id"]), name="jeremy", role="owner")
    card = await _raise(pool, person)

    resp = await owner_client.post(
        f"/api/v1/consents/{card['consent_id']}/decide", json={"decision": "deny"}
    )
    assert resp.status_code == 200
    assert resp.json()["consent"]["status"] == "denied"


async def test_deciding_an_unknown_card_is_a_404_not_a_silent_no_op(owner_client):
    resp = await owner_client.post(
        f"/api/v1/consents/{uuid.uuid4()}/decide", json={"decision": "approve"}
    )
    assert resp.status_code == 404


async def test_deciding_an_already_decided_card_again_is_a_404(owner_client, pool):
    resp = await owner_client.get("/api/v1/auth/me")
    person = Person(id=uuid.UUID(resp.json()["person"]["id"]), name="jeremy", role="owner")
    card = await _raise(pool, person)
    first = await owner_client.post(
        f"/api/v1/consents/{card['consent_id']}/decide", json={"decision": "approve"}
    )
    assert first.status_code == 200

    second = await owner_client.post(
        f"/api/v1/consents/{card['consent_id']}/decide", json={"decision": "deny"}
    )
    assert second.status_code == 404
    # The first decision stands — a 404 on the second call never overwrites it.
    row = await consents.get(pool, uuid.UUID(card["consent_id"]))
    assert row["status"] == "approved"


async def test_an_invalid_decision_value_is_a_422(owner_client, pool):
    resp = await owner_client.get("/api/v1/auth/me")
    person = Person(id=uuid.UUID(resp.json()["person"]["id"]), name="jeremy", role="owner")
    card = await _raise(pool, person)
    resp = await owner_client.post(
        f"/api/v1/consents/{card['consent_id']}/decide", json={"decision": "maybe"}
    )
    assert resp.status_code == 422


# -- Fix C: a decided consent is made visible in its conversation -------


async def _messages(pool, conversation_id: uuid.UUID) -> list:
    return await pool.fetch(
        "SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at",
        conversation_id,
    )


async def test_a_deny_records_exactly_one_resolution_message_in_the_conversation(
    owner_client, pool
):
    """After a DENY, history still showed 'awaiting your approval…' and the
    model re-narrated it. The resolution message puts the deny in chat AND in
    the model's next-turn context so it stops re-narrating a stale pending
    state."""
    resp = await owner_client.get("/api/v1/auth/me")
    person = Person(id=uuid.UUID(resp.json()["person"]["id"]), name="jeremy", role="owner")
    conv = await _conversation(pool, person)
    card = await _raise(pool, person, conversation_id=conv)

    resp = await owner_client.post(
        f"/api/v1/consents/{card['consent_id']}/decide", json={"decision": "deny"}
    )
    assert resp.status_code == 200

    msgs = await _messages(pool, conv)
    assert len(msgs) == 1
    assert msgs[0]["role"] == "assistant"
    assert "denied" in msgs[0]["content"]
    assert card["summary"] in msgs[0]["content"]


async def test_an_approve_does_not_post_a_resolution_message(owner_client, pool):
    """APPROVE is covered by the client's continuation turn (ruling S3-R4), so
    the API must not double-post here."""
    resp = await owner_client.get("/api/v1/auth/me")
    person = Person(id=uuid.UUID(resp.json()["person"]["id"]), name="jeremy", role="owner")
    conv = await _conversation(pool, person)
    card = await _raise(pool, person, conversation_id=conv)

    resp = await owner_client.post(
        f"/api/v1/consents/{card['consent_id']}/decide", json={"decision": "approve"}
    )
    assert resp.status_code == 200
    assert await _messages(pool, conv) == []


async def test_a_deny_on_a_null_conversation_card_does_not_crash(owner_client, pool):
    """A card raised outside any conversation has nowhere to land the
    resolution — the deny still succeeds, it just posts nothing."""
    resp = await owner_client.get("/api/v1/auth/me")
    person = Person(id=uuid.UUID(resp.json()["person"]["id"]), name="jeremy", role="owner")
    card = await _raise(pool, person, conversation_id=None)

    resp = await owner_client.post(
        f"/api/v1/consents/{card['consent_id']}/decide", json={"decision": "deny"}
    )
    assert resp.status_code == 200
    assert resp.json()["consent"]["status"] == "denied"
    # Nothing was inserted anywhere — no crash, no orphan message.
    assert await pool.fetchval("SELECT count(*) FROM messages") == 0
