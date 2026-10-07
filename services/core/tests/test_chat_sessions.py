"""Chat sessions: several top-level conversations, listed, archived, deleted.

What is pinned here is the part the sidebar cannot check for itself: which
conversations are his to list (never a beat, agent or eval log, never a
room), that a new session does NOT move the hallway, that "main" is derived
from the same query delivery uses, and that a reminder set in a session
lands back in that session.
"""

from __future__ import annotations

import uuid

from app import tools, traces
from app.identity import Person
from app.main import app
from app.tools.base import ToolContext
from tests.conftest import requires_db

pytestmark = requires_db

BASE = "/api/v1/conversations"


async def _owner(pool) -> Person:
    row = await pool.fetchrow("SELECT id, name, role FROM people WHERE role = 'owner'")
    return Person(id=row["id"], name=row["name"], role=row["role"])


async def _ids(owner_client, archived: bool = False) -> list[str]:
    response = await owner_client.get(BASE, params={"archived": str(archived).lower()})
    assert response.status_code == 200
    return [s["id"] for s in response.json()["sessions"]]


async def test_the_list_starts_with_the_hallway_and_marks_it_main(owner_client):
    response = await owner_client.get(BASE)
    assert response.status_code == 200
    sessions = response.json()["sessions"]
    assert len(sessions) == 1
    hallway = (await owner_client.get(f"{BASE}/active")).json()["id"]
    assert sessions[0]["id"] == hallway
    assert sessions[0]["main"] is True
    assert sessions[0]["label"] == "New session"
    assert sessions[0]["busy"] is False
    assert sessions[0]["archived_at"] is None


async def test_a_new_session_does_not_move_the_hallway(owner_client):
    hallway = (await owner_client.get(f"{BASE}/active")).json()["id"]
    created = await owner_client.post(BASE, json={})
    assert created.status_code == 200
    body = created.json()
    assert body["main"] is False
    # Delivery still resolves to the hallway — a new session is not where a
    # digest goes just because it is newest.
    assert (await owner_client.get(f"{BASE}/active")).json()["id"] == hallway
    assert set(await _ids(owner_client)) == {hallway, body["id"]}


async def test_only_his_sessions_are_listed_never_logs_or_rooms(owner_client, pool):
    owner = await _owner(pool)
    hallway = (await owner_client.get(f"{BASE}/active")).json()["id"]
    # A beat / agent / eval log: inactive, titled — the shape all three use.
    await pool.execute(
        "INSERT INTO conversations (person_id, active, title) VALUES ($1, false, 'beats')",
        owner.id,
    )
    message = await pool.fetchval(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', 'hi') "
        "RETURNING id",
        uuid.UUID(hallway),
    )
    room = await owner_client.post(f"{BASE}/{hallway}/messages/{message}/thread")
    assert room.status_code == 200
    assert await _ids(owner_client) == [hallway]
    # And they cannot be renamed or archived through the session routes.
    refused = await owner_client.patch(f"{BASE}/{room.json()['id']}", json={"archived": True})
    assert refused.status_code == 400
    assert "not a chat session" in refused.json()["error"]


async def test_the_label_is_his_title_else_his_first_line(owner_client, pool):
    session = (await owner_client.post(BASE, json={})).json()["id"]
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES "
        "($1, 'user', 'fix the wifi on the dell\nit drops every hour')",
        uuid.UUID(session),
    )
    listed = {s["id"]: s for s in (await owner_client.get(BASE)).json()["sessions"]}
    assert listed[session]["label"] == "fix the wifi on the dell"
    assert listed[session]["message_count"] == 1
    # The most recently active session comes first.
    assert next(iter(listed)) == session

    renamed = await owner_client.patch(f"{BASE}/{session}", json={"title": "  Dell   wifi "})
    assert renamed.json()["label"] == "Dell wifi"
    cleared = await owner_client.patch(f"{BASE}/{session}", json={"title": None})
    assert cleared.json()["title"] is None
    assert cleared.json()["label"] == "fix the wifi on the dell"


async def test_archive_and_unarchive_move_it_between_the_lists(owner_client):
    session = (await owner_client.post(BASE, json={})).json()["id"]
    archived = await owner_client.patch(f"{BASE}/{session}", json={"archived": True})
    assert archived.status_code == 200
    assert archived.json()["archived_at"] is not None
    assert session not in await _ids(owner_client)
    assert await _ids(owner_client, archived=True) == [session]

    back = await owner_client.patch(f"{BASE}/{session}", json={"archived": False})
    assert back.json()["archived_at"] is None
    assert session in await _ids(owner_client)
    assert await _ids(owner_client, archived=True) == []


async def test_archiving_the_main_session_hands_the_hallway_to_a_fresh_one(owner_client):
    hallway = (await owner_client.get(f"{BASE}/active")).json()["id"]
    side = (await owner_client.post(BASE, json={})).json()["id"]
    await owner_client.patch(f"{BASE}/{hallway}", json={"archived": True})
    now = (await owner_client.get(f"{BASE}/active")).json()["id"]
    # Never the side session he opened — a fresh hallway.
    assert now not in (hallway, side)
    listed = {s["id"]: s["main"] for s in (await owner_client.get(BASE)).json()["sessions"]}
    assert listed == {now: True, side: False}


async def test_make_main_moves_delivery_and_leaves_exactly_one(owner_client, pool):
    owner = await _owner(pool)
    hallway = (await owner_client.get(f"{BASE}/active")).json()["id"]
    side = (await owner_client.post(BASE, json={})).json()["id"]
    response = await owner_client.post(f"{BASE}/{side}/main")
    assert response.status_code == 200
    assert response.json()["main"] is True
    assert (await owner_client.get(f"{BASE}/active")).json()["id"] == side
    actives = await pool.fetchval(
        "SELECT count(*) FROM conversations WHERE person_id = $1 AND chat_session AND active",
        owner.id,
    )
    assert actives == 1
    listed = {s["id"]: s["main"] for s in (await owner_client.get(BASE)).json()["sessions"]}
    assert listed == {hallway: False, side: True}


async def test_delete_removes_it_and_states_what_went(owner_client, pool):
    session = (await owner_client.post(BASE, json={})).json()["id"]
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'hello')",
        uuid.UUID(session),
    )
    response = await owner_client.delete(f"{BASE}/{session}")
    assert response.status_code == 200
    assert response.json() == {
        "id": session,
        "deleted": True,
        "messages": 1,
        "timers_unlinked": 0,
    }
    assert (
        await pool.fetchval("SELECT count(*) FROM conversations WHERE id = $1", uuid.UUID(session))
        == 0
    )
    assert (await owner_client.delete(f"{BASE}/{session}")).status_code == 404


async def test_a_session_with_a_turn_running_is_not_deleted(owner_client, pool):
    session = (await owner_client.post(BASE, json={})).json()["id"]
    turn_id = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id) VALUES ('chat', $1) RETURNING id",
        uuid.UUID(session),
    )
    traces.INFLIGHT.add(turn_id)
    try:
        listed = {s["id"]: s for s in (await owner_client.get(BASE)).json()["sessions"]}
        assert listed[session]["busy"] is True
        response = await owner_client.delete(f"{BASE}/{session}")
        assert response.status_code == 409
        assert "still running" in response.json()["error"]
    finally:
        traces.INFLIGHT.discard(turn_id)
    assert (
        await pool.fetchval("SELECT count(*) FROM conversations WHERE id = $1", uuid.UUID(session))
        == 1
    )


async def test_someone_elses_session_is_not_found(owner_client, pool):
    other = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('guest', 'guest') RETURNING id"
    )
    theirs = await pool.fetchval(
        "INSERT INTO conversations (person_id, chat_session) VALUES ($1, true) RETURNING id",
        other,
    )
    assert (await owner_client.patch(f"{BASE}/{theirs}", json={"title": "x"})).status_code == 404
    assert (await owner_client.delete(f"{BASE}/{theirs}")).status_code == 404
    assert (await owner_client.post(f"{BASE}/{theirs}/main")).status_code == 404
    assert str(theirs) not in await _ids(owner_client)


async def test_a_reminder_set_in_a_session_lands_in_that_session(owner_client, pool, tmp_path):
    owner = await _owner(pool)
    hallway = (await owner_client.get(f"{BASE}/active")).json()["id"]
    side = (await owner_client.post(BASE, json={})).json()["id"]
    ctx = ToolContext(
        app=app, person=owner, workspace_root=tmp_path, conversation_id=uuid.UUID(side)
    )
    _, ok = await tools.dispatch(
        "create_timer", {"kind": "reminder", "text": "stretch", "in_minutes": 5}, ctx
    )
    assert ok
    landed = await pool.fetchval(
        "SELECT conversation_id FROM timers WHERE person_id = $1", owner.id
    )
    assert str(landed) == side
    assert side != hallway


async def test_a_reminder_from_outside_a_session_still_lands_in_the_hallway(
    owner_client, pool, tmp_path
):
    owner = await _owner(pool)
    hallway = (await owner_client.get(f"{BASE}/active")).json()["id"]
    log = await pool.fetchval(
        "INSERT INTO conversations (person_id, active, title) VALUES ($1, false, 'beats') "
        "RETURNING id",
        owner.id,
    )
    ctx = ToolContext(app=app, person=owner, workspace_root=tmp_path, conversation_id=log)
    _, ok = await tools.dispatch(
        "create_timer", {"kind": "reminder", "text": "stretch", "in_minutes": 5}, ctx
    )
    assert ok
    landed = await pool.fetchval(
        "SELECT conversation_id FROM timers WHERE person_id = $1", owner.id
    )
    assert str(landed) == hallway
