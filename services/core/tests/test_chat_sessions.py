"""Chat sessions: several top-level conversations, listed, archived, deleted.

What is pinned here is the part the sidebar cannot check for itself: which
conversations are his to list (never a beat, agent or eval log, never a
room), that a new session does NOT move the hallway, that "main" is derived
from the same query delivery uses, and that a reminder set in a session
lands back in that session.
"""

from __future__ import annotations

import asyncio
import uuid

from app import chat, tools, traces
from app.identity import Person
from app.main import app
from app.tools.base import ToolContext
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory

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


# -- running at once (owner, 2026-10-07: "let sessions run in parallel when
# using cloud models") -------------------------------------------------------


def _serving(local: bool | None) -> dict:
    """What the gateway's explain walk answers: which link would serve, and
    whether its provider is local. None leaves the flag out (an older
    gateway), which must be read as "not known"."""
    serve = {"role": "chat", "link": 1, "reason": None, "served_by": "p:m", "standby": False}
    if local is not None:
        serve["local"] = local
    return {"role": "chat", "chain": [], "would_serve": serve, "reason": None}


def _completions(gateway: FakeGateway) -> int:
    return sum(1 for path, _ in gateway.seen if path.endswith("/chat/completions"))


async def _second_session_send(owner_client, pool, mount_peers, explain: dict | None):
    """Hold a turn in the hallway, then send in a second session. Returns the
    second send's response, or None if it opened a stream (it is then still
    held, so it cannot have returned) — and how many turns were running."""
    hold = asyncio.Event()
    gateway = FakeGateway(deltas=("working",), hold=hold, explain_body=explain)
    mount_peers(gateway=gateway, memory=FakeMemory())
    assert (
        await owner_client.put("/api/v1/settings", json={"key": "chat.model", "value": "m"})
    ).status_code == 200
    side = (await owner_client.post(BASE, json={})).json()["id"]

    first = asyncio.create_task(
        owner_client.post("/api/v1/chat/stream", json={"message": "in the hallway"})
    )
    while _completions(gateway) < 1:
        await asyncio.sleep(0.01)
    second = asyncio.create_task(
        owner_client.post(
            "/api/v1/chat/stream", json={"message": "in the side session", "conversation_id": side}
        )
    )
    try:
        for _ in range(300):
            if second.done() or _completions(gateway) >= 2:
                break
            await asyncio.sleep(0.01)
        running = _completions(gateway)
        answered = second.result() if second.done() else None
    finally:
        hold.set()
    await asyncio.wait_for(first, timeout=10)
    await asyncio.wait_for(second, timeout=10)
    await asyncio.wait_for(chat.drain_background(), timeout=15)
    return answered, running, side


async def test_on_a_cloud_model_a_second_session_runs_at_once(owner_client, pool, mount_peers):
    answered, running, _ = await _second_session_send(
        owner_client, pool, mount_peers, _serving(local=False)
    )
    # Not queued: the second turn reached the model while the first was held.
    assert answered is None
    assert running == 2


async def test_on_a_local_model_a_second_session_still_queues(owner_client, pool, mount_peers):
    answered, running, side = await _second_session_send(
        owner_client, pool, mount_peers, _serving(local=True)
    )
    assert answered is not None and answered.status_code == 202, answered
    assert running == 1
    # And it ran once the first turn let go (S15's promise, unchanged).
    rows = await pool.fetch(
        "SELECT role FROM messages WHERE conversation_id = $1 ORDER BY created_at",
        uuid.UUID(side),
    )
    assert [r["role"] for r in rows] == ["user", "assistant"]


async def test_when_the_gateway_cannot_say_where_it_runs_it_queues(owner_client, pool, mount_peers):
    # No `local` flag at all: not known, and not known is the old behaviour.
    answered, running, _ = await _second_session_send(
        owner_client, pool, mount_peers, _serving(local=None)
    )
    assert answered is not None and answered.status_code == 202
    assert running == 1


async def test_on_a_cloud_model_one_session_still_answers_one_at_a_time(
    owner_client, pool, mount_peers
):
    """Parallel is ACROSS sessions. Two sends into the same transcript would
    interleave two replies — S15's gate holds there whatever the model."""
    hold = asyncio.Event()
    gateway = FakeGateway(deltas=("working",), hold=hold, explain_body=_serving(local=False))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await owner_client.put("/api/v1/settings", json={"key": "chat.model", "value": "m"})
    first = asyncio.create_task(owner_client.post("/api/v1/chat/stream", json={"message": "one"}))
    while _completions(gateway) < 1:
        await asyncio.sleep(0.01)
    try:
        again = await owner_client.post("/api/v1/chat/stream", json={"message": "two"})
        assert again.status_code == 202, again.text
    finally:
        hold.set()
    await asyncio.wait_for(first, timeout=10)
    await asyncio.wait_for(chat.drain_background(), timeout=15)
