"""Rewind read paths + route (chat-rewind epic, T5).

T4's rewinds.rewind withdraws later rows (messages.withdrawn_by) and writes a
marker row (messages.rewind_id). This file pins what READS that state:

  * her next turn's history (chat._open_turn) never carries a withdrawn row
    and does carry the marker, after the target;
  * a room off a withdrawn message gets no seed (chat.thread_seed);
  * GET /messages omits withdrawn rows and every row carries `rewind`: null,
    or for the marker the stored rewinds row (never re-derived from its text);
  * thread_reply_counts offers no stub off a withdrawn row and counts no
    withdrawn child;
  * POST /api/v1/conversations/{id}/rewind is the owner's door to rewind():
    its result with string ids, 409 when busy, 400 for any other refusal,
    404 for a conversation that is not his, 422 for a malformed body.
"""

from __future__ import annotations

import datetime as dt
import json
import uuid

import pytest

from app import chat, conversations, rewinds, traces
from app.identity import Person
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory
from tests.test_chat import _say, _set_model

pytestmark = requires_db

# Earlier than any real clock this suite runs under, so every seeded row sorts
# before the marker (stamped now()) and the message a test then sends.
T0 = dt.datetime(2026, 10, 1, 9, 0, 0, tzinfo=dt.UTC)


def _at(seconds: float) -> dt.datetime:
    return T0 + dt.timedelta(seconds=seconds)


def _json(value):
    return json.loads(value) if isinstance(value, str) else value


async def _owner(pool) -> Person:
    row = await pool.fetchrow("SELECT id, name, role FROM people WHERE role = 'owner'")
    return Person(id=row["id"], name=row["name"], role=row["role"])


async def _active(owner_client) -> uuid.UUID:
    resp = await owner_client.get("/api/v1/conversations/active")
    assert resp.status_code == 200
    return uuid.UUID(resp.json()["id"])


async def _msg(pool, cid, role: str, content: str, at: float) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO messages (conversation_id, role, content, created_at) "
        "VALUES ($1, $2, $3, $4) RETURNING id",
        cid,
        role,
        content,
        _at(at),
    )


async def _withdraw(pool, cid, person: Person, *message_ids: uuid.UUID) -> uuid.UUID:
    """Flag rows withdrawn by a bare rewinds row — the state T4 leaves — so a
    read-path test does not depend on rewind()'s own choices."""
    rid = await pool.fetchval(
        "INSERT INTO rewinds (conversation_id, person_id, mode) VALUES ($1, $2, 'chat') "
        "RETURNING id",
        cid,
        person.id,
    )
    await pool.execute(
        "UPDATE messages SET withdrawn_by = $1 WHERE id = ANY($2::uuid[])", rid, list(message_ids)
    )
    return rid


async def _seed_exchange(pool, cid) -> dict:
    """early ask/answer, the target, then two later rows that a rewind to the
    target withdraws. Contents are unique so a leak is unambiguous."""
    tag = uuid.uuid4().hex[:8]
    w = {
        "early_q": f"early question {tag}",
        "early_a": f"early answer {tag}",
        "target": f"rewrite the plan file {tag}",
        "late_a": f"WITHDRAWN reply {tag}",
        "late_q": f"WITHDRAWN follow-up {tag}",
    }
    w["m_early_q"] = await _msg(pool, cid, "user", w["early_q"], 0)
    w["m_early_a"] = await _msg(pool, cid, "assistant", w["early_a"], 1)
    w["m_target"] = await _msg(pool, cid, "user", w["target"], 10)
    w["m_late_a"] = await _msg(pool, cid, "assistant", w["late_a"], 11)
    w["m_late_q"] = await _msg(pool, cid, "user", w["late_q"], 20)
    return w


async def _history_after(owner_client, gateway, message: str) -> list[dict]:
    """Send one real message and return the user/assistant rows the gateway
    was handed BEFORE that message (her history window)."""
    status, _ = await _say(owner_client, message)
    assert status == 200
    (body,) = [b for _, b in gateway.seen if isinstance(b, dict) and "messages" in b][:1]
    rows = [m for m in body["messages"] if m["role"] in ("user", "assistant")]
    assert rows and rows[-1]["content"].endswith(message)
    return rows[:-1]


# -- criterion 1: her next turn's history -------------------------------------------


async def test_her_next_turn_never_sees_a_withdrawn_row(owner_client, pool, mount_peers):
    gateway = FakeGateway()
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)
    cid = await _active(owner_client)
    w = await _seed_exchange(pool, cid)
    await rewinds.rewind(pool, app, await _owner(pool), cid, w["m_target"], "chat")

    history = await _history_after(owner_client, gateway, "so where were we?")
    sent = "\n".join(m["content"] for m in history)
    assert w["late_a"] not in sent, "a withdrawn assistant row reached her history"
    assert w["late_q"] not in sent, "a withdrawn user row reached her history"
    assert w["target"] in sent and w["early_q"] in sent and w["early_a"] in sent


async def test_her_next_turn_carries_the_marker_after_the_target(owner_client, pool, mount_peers):
    gateway = FakeGateway()
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)
    cid = await _active(owner_client)
    w = await _seed_exchange(pool, cid)
    result = await rewinds.rewind(pool, app, await _owner(pool), cid, w["m_target"], "chat")
    marker = await pool.fetchval(
        "SELECT content FROM messages WHERE id = $1", result["marker_message_id"]
    )

    history = await _history_after(owner_client, gateway, "so where were we?")
    # Exactly the surviving rows, in created_at order, the marker last — as the
    # owner's (role user) row, its code-composed text intact.
    assert len(history) == 4, [m["content"] for m in history]
    for row, (role, content) in zip(
        history,
        [
            ("user", w["early_q"]),
            ("assistant", w["early_a"]),
            ("user", w["target"]),
            ("user", marker),
        ],
        strict=True,
    ):
        assert row["role"] == role
        assert row["content"].endswith(content)


# -- criterion 2: thread_seed ---------------------------------------------------------


async def test_a_room_off_a_withdrawn_message_gets_no_seed(owner_client, pool):
    person = await _owner(pool)
    hallway = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person.id
    )
    live = await _msg(pool, hallway, "assistant", "the live digest", 0)
    gone = await _msg(pool, hallway, "assistant", "the withdrawn digest", 1)
    live_room, _ = await conversations.open_thread(pool, person, live)
    gone_room, _ = await conversations.open_thread(pool, person, gone)
    await _withdraw(pool, hallway, person, gone)

    seed = await chat.thread_seed(pool, live_room["id"])
    assert any(m["content"].endswith("the live digest") for m in seed), (
        "a live parent lost its seed"
    )
    assert await chat.thread_seed(pool, gone_room["id"]) == [], (
        "a room was seeded with a withdrawn message"
    )


# -- criterion 3: GET messages --------------------------------------------------------


async def test_get_messages_omits_withdrawn_rows(owner_client, pool):
    cid = await _active(owner_client)
    w = await _seed_exchange(pool, cid)
    await _withdraw(pool, cid, await _owner(pool), w["m_late_a"], w["m_late_q"])

    resp = await owner_client.get(f"/api/v1/conversations/{cid}/messages")
    assert resp.status_code == 200
    ids = [m["id"] for m in resp.json()["messages"]]
    assert ids == [str(w["m_early_q"]), str(w["m_early_a"]), str(w["m_target"])]


async def test_an_ordinary_row_carries_a_null_rewind_field(owner_client, pool):
    cid = await _active(owner_client)
    await _seed_exchange(pool, cid)

    rows = (await owner_client.get(f"/api/v1/conversations/{cid}/messages")).json()["messages"]
    assert rows
    for row in rows:
        assert "rewind" in row, "every row must say whether it is a marker"
        assert row["rewind"] is None


async def test_the_marker_states_its_rewind_from_the_stored_row(owner_client, pool):
    cid = await _active(owner_client)
    w = await _seed_exchange(pool, cid)
    result = await rewinds.rewind(pool, app, await _owner(pool), cid, w["m_target"], "executions")
    # Rewrite the stored lists: the field must be READ from the rewinds row,
    # never re-derived from the marker's text.
    undone = [{"tool": "workspace_write_file", "action_id": "a1", "line": "put back plan.md"}]
    not_undone = [{"tool": "device_run", "action_id": "a2", "reason": "a command already ran"}]
    await pool.execute(
        "UPDATE rewinds SET undone = $2::jsonb, not_undone = $3::jsonb WHERE id = $1",
        result["rewind_id"],
        json.dumps(undone),
        json.dumps(not_undone),
    )

    rows = (await owner_client.get(f"/api/v1/conversations/{cid}/messages")).json()["messages"]
    (marker,) = [r for r in rows if r["id"] == str(result["marker_message_id"])]
    assert marker["rewind"] == {
        "id": str(result["rewind_id"]),
        "mode": "executions",
        "target_message_id": str(w["m_target"]),
        "withdrawn": 2,
        "undone": undone,
        "not_undone": not_undone,
    }
    others = [r for r in rows if r["id"] != str(result["marker_message_id"])]
    assert all(r.get("rewind", "missing") is None for r in others)


async def test_the_marker_counts_only_its_own_rewinds_withdrawals(owner_client, pool):
    # An earlier rewind already withdrew a row in this conversation; the new
    # marker's `withdrawn` is the rows THIS rewind flagged, not every
    # withdrawn row the conversation holds.
    person = await _owner(pool)
    cid = await _active(owner_client)
    w = await _seed_exchange(pool, cid)
    stray = await _msg(pool, cid, "assistant", "withdrawn by an earlier rewind", 5)
    await _withdraw(pool, cid, person, stray)
    result = await rewinds.rewind(pool, app, person, cid, w["m_target"], "chat")

    rows = (await owner_client.get(f"/api/v1/conversations/{cid}/messages")).json()["messages"]
    (marker,) = [r for r in rows if r["id"] == str(result["marker_message_id"])]
    assert marker["rewind"]["withdrawn"] == 2


# -- criterion 4: thread_reply_counts -------------------------------------------------


async def test_a_withdrawn_row_offers_no_room_stub(owner_client, pool):
    person = await _owner(pool)
    cid = await _active(owner_client)
    roomed = await _msg(pool, cid, "assistant", "a digest with a room", 0)
    noticed = await _msg(pool, cid, "assistant", "a digest that delivered a notice", 1)
    kept = await _msg(pool, cid, "assistant", "a digest that stays", 2)
    await conversations.open_thread(pool, person, roomed)
    await conversations.open_thread(pool, person, kept)
    await pool.execute(
        "INSERT INTO notices (check_name, finding_key, fingerprint, title, facts, "
        "delivered_message_id) VALUES ('a_check', 'k1', 'fp-1', 'a finding', '{}'::jsonb, $1)",
        noticed,
    )
    await _withdraw(pool, cid, person, roomed, noticed)

    counts = await conversations.thread_reply_counts(pool, cid)
    assert roomed not in counts, "a withdrawn message's room still offers a stub"
    assert noticed not in counts, "a withdrawn notice-delivering message still offers a stub"
    assert counts == {kept: 0}


async def test_a_room_count_excludes_withdrawn_children(owner_client, pool):
    person = await _owner(pool)
    cid = await _active(owner_client)
    parent = await _msg(pool, cid, "assistant", "a digest", 0)
    room, _ = await conversations.open_thread(pool, person, parent)
    children = [await _msg(pool, room["id"], "user", f"reply {i}", 10 + i) for i in range(3)]
    await _withdraw(pool, room["id"], person, children[2])

    assert await conversations.thread_reply_counts(pool, cid) == {parent: 2}


async def test_a_room_whose_every_child_is_withdrawn_still_offers_its_stub(owner_client, pool):
    # The parent is live, so its room stays reachable — at zero replies, not gone.
    person = await _owner(pool)
    cid = await _active(owner_client)
    parent = await _msg(pool, cid, "assistant", "a digest", 0)
    room, _ = await conversations.open_thread(pool, person, parent)
    children = [await _msg(pool, room["id"], "user", f"reply {i}", 10 + i) for i in range(2)]
    await _withdraw(pool, room["id"], person, *children)

    assert await conversations.thread_reply_counts(pool, cid) == {parent: 0}


# -- criterion 5: the route -----------------------------------------------------------


def _url(cid) -> str:
    return f"/api/v1/conversations/{cid}/rewind"


async def test_the_route_returns_the_rewind_result_with_string_ids(owner_client, pool):
    cid = await _active(owner_client)
    w = await _seed_exchange(pool, cid)

    resp = await owner_client.post(
        _url(cid), json={"message_id": str(w["m_target"]), "mode": "chat"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    stored = await pool.fetchrow("SELECT * FROM rewinds WHERE conversation_id = $1", cid)
    marker = await pool.fetchval("SELECT id FROM messages WHERE rewind_id = $1", stored["id"])
    assert body == {
        "rewind_id": str(stored["id"]),
        "marker_message_id": str(marker),
        "mode": "chat",
        "withdrawn": 2,
        "undone": [],
        "not_undone": [],
    }


async def test_the_route_rewinds_as_the_owning_person(owner_client, pool, monkeypatch):
    cid = await _active(owner_client)
    seen = []

    async def _fake(pool_, app_, person, conversation_id, message_id, mode):
        seen.append((person, conversation_id, message_id, mode))
        return {
            "rewind_id": uuid.uuid4(),
            "marker_message_id": uuid.uuid4(),
            "mode": mode,
            "withdrawn": 0,
            "undone": [],
            "not_undone": [],
        }

    monkeypatch.setattr(rewinds, "rewind", _fake)
    target = uuid.uuid4()
    resp = await owner_client.post(
        _url(cid), json={"message_id": str(target), "mode": "executions"}
    )
    assert resp.status_code == 200, resp.text
    owner = await _owner(pool)
    ((person, conversation_id, message_id, mode),) = seen
    assert person.id == owner.id
    assert (conversation_id, message_id, mode) == (cid, target, "executions")
    assert isinstance(resp.json()["rewind_id"], str)


async def test_a_busy_conversation_is_409_with_the_stated_reason(owner_client, pool):
    cid = await _active(owner_client)
    w = await _seed_exchange(pool, cid)
    running = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model, status) "
        "VALUES ('chat', $1, 'm', NULL) RETURNING id",
        cid,
    )
    traces.INFLIGHT.add(running)
    try:
        resp = await owner_client.post(
            _url(cid), json={"message_id": str(w["m_target"]), "mode": "chat"}
        )
    finally:
        traces.INFLIGHT.discard(running)
    assert resp.status_code == 409, resp.text
    assert isinstance(resp.json()["error"], str) and resp.json()["error"]
    assert await pool.fetchval("SELECT count(*) FROM rewinds") == 0


async def test_the_409_states_the_refusals_own_reason(owner_client, monkeypatch):
    cid = await _active(owner_client)

    async def _busy(*args, **kwargs):
        raise rewinds.RewindBusy("a turn is still running in this conversation (t-42)")

    monkeypatch.setattr(rewinds, "rewind", _busy)
    resp = await owner_client.post(
        _url(cid), json={"message_id": str(uuid.uuid4()), "mode": "chat"}
    )
    assert resp.status_code == 409
    assert resp.json()["error"] == "a turn is still running in this conversation (t-42)"


async def test_any_other_refusal_is_400_with_the_stated_reason(owner_client, pool, monkeypatch):
    cid = await _active(owner_client)
    w = await _seed_exchange(pool, cid)
    # The real refusal: an assistant row is not his message to rewind to.
    resp = await owner_client.post(
        _url(cid), json={"message_id": str(w["m_late_a"]), "mode": "chat"}
    )
    assert resp.status_code == 400, resp.text
    assert isinstance(resp.json()["error"], str) and resp.json()["error"]
    resp = await owner_client.post(
        _url(cid), json={"message_id": str(w["m_target"]), "mode": "everything"}
    )
    assert resp.status_code == 400, resp.text

    async def _refuse(*args, **kwargs):
        raise rewinds.RewindRefused("that message is already withdrawn (m-7)")

    monkeypatch.setattr(rewinds, "rewind", _refuse)
    resp = await owner_client.post(
        _url(cid), json={"message_id": str(w["m_target"]), "mode": "chat"}
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "that message is already withdrawn (m-7)"


async def test_someone_elses_or_an_unknown_conversation_is_404(owner_client, pool):
    other = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('guest', 'guest') RETURNING id"
    )
    theirs = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", other
    )
    their_msg = await _msg(pool, theirs, "user", "their message", 0)
    unknown = uuid.uuid4()
    for cid in (theirs, unknown):
        resp = await owner_client.post(
            _url(cid), json={"message_id": str(their_msg), "mode": "chat"}
        )
        assert resp.status_code == 404
        # owned_conversation's answer, not a missing route's.
        assert resp.json()["error"] == f"no conversation {cid} here"
    assert await pool.fetchval("SELECT count(*) FROM rewinds") == 0


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"mode": "chat"}, id="missing message_id"),
        pytest.param({"message_id": "not-a-uuid", "mode": "chat"}, id="non-uuid message_id"),
    ],
)
async def test_a_malformed_body_is_422(owner_client, pool, body):
    cid = await _active(owner_client)
    resp = await owner_client.post(_url(cid), json=body)
    assert resp.status_code == 422, resp.text
    assert await pool.fetchval("SELECT count(*) FROM rewinds") == 0


# -- criterion 6: end to end ----------------------------------------------------------


async def test_a_posted_rewind_reaches_the_transcript_and_her_next_turn(
    owner_client, pool, mount_peers
):
    gateway = FakeGateway()
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)
    cid = await _active(owner_client)
    w = await _seed_exchange(pool, cid)

    resp = await owner_client.post(
        _url(cid), json={"message_id": str(w["m_target"]), "mode": "chat"}
    )
    assert resp.status_code == 200, resp.text
    marker_id = resp.json()["marker_message_id"]

    rows = (await owner_client.get(f"/api/v1/conversations/{cid}/messages")).json()["messages"]
    assert [r["id"] for r in rows] == [
        str(w["m_early_q"]),
        str(w["m_early_a"]),
        str(w["m_target"]),
        marker_id,
    ]
    assert rows[-1]["rewind"]["target_message_id"] == str(w["m_target"])

    history = await _history_after(owner_client, gateway, "let's try that again")
    sent = "\n".join(m["content"] for m in history)
    assert w["late_a"] not in sent and w["late_q"] not in sent
    assert history[-1]["content"].endswith(rows[-1]["content"])
