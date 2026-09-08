"""/api/v1/timers — the Schedules page's surface. Every row is the store's own
serialisation plus `last_firing` read off timer_firings; someone else's timer
is a 404, never a 403; every job is visible to every person; "Run now" runs
the tick inline and hands back the firing row it actually produced; and the
chat transcript labels a reminder row by its turn's kind, never a stored flag.
"""

from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app import devices_ws, identity, scheduler, timers
from app.identity import Person
from app.main import app
from app.timers_api import DEFAULT_PAUSE_REASON, MAX_LIMIT
from tests.conftest import BASE_URL, requires_db

pytestmark = requires_db

NY = "America/New_York"
# Created for 2031 — create refuses a past once against the DB clock, and the
# API's fire route makes the row due itself, so nothing here waits.
FUTURE_ONCE = {"kind": "once", "at": "2031-06-01T09:00"}
ROW_KEYS = {
    "id",
    "kind",
    "title",
    "payload",
    "schedule",
    "schedule_words",
    "timezone",
    "conversation_id",
    "next_fire_at",
    "paused_at",
    "paused_reason",
    "consecutive_failures",
    "created_via",
    "created_at",
    "last_firing",
}
FIRING_KEYS = {
    "id",
    "timer_id",
    "scheduled_for",
    "started_at",
    "ended_at",
    "status",
    "reason",
    "turn_id",
    "delivery",
}


@pytest.fixture(autouse=True)
def _clean_hub():
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    scheduler.RUNNING.clear()
    yield
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    scheduler.RUNNING.clear()


async def _owner(pool) -> tuple[Person, uuid.UUID]:
    """The person owner_client registered, and their active conversation."""
    row = await pool.fetchrow("SELECT id, name, role FROM people WHERE role = 'owner'")
    person = Person(id=row["id"], name=row["name"], role=row["role"])
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person.id
    )
    return person, conversation


async def _stranger(pool, name: str = "stranger") -> tuple[Person, uuid.UUID]:
    # 'adult', not 'owner' — people_one_owner allows the one owner_client made.
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, 'adult') RETURNING id", name
    )
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", pid
    )
    return Person(id=pid, name=name, role="adult"), conversation


async def _client_for(pool, person: Person) -> AsyncClient:
    """A browser session for `person` — the cookie path, so the request IS them."""
    token = await identity.create_session(pool, person.id)
    return AsyncClient(
        transport=ASGITransport(app=app),
        base_url=BASE_URL,
        cookies={identity.COOKIE_NAME: token},
    )


async def _reminder(pool, person, conversation, *, title="stretch", spec=None):
    return await timers.create(
        pool,
        person=person,
        kind="reminder",
        title=title,
        payload={"message": title, "device": None},
        spec=spec or FUTURE_ONCE,
        tz=NY,
        conversation_id=conversation,
        created_via="chat",
    )


async def _closed_firing(pool, timer_id, *, status="ok", reason=None, offset_secs=0) -> uuid.UUID:
    """A finished firing written straight to the table (the tick's shape),
    started `offset_secs` after now so ordering is explicit."""
    return await pool.fetchval(
        "INSERT INTO timer_firings (timer_id, scheduled_for, started_at, ended_at, status, "
        "reason) VALUES ($1, now(), now() + make_interval(secs => $2), "
        "now() + make_interval(secs => $2), $3, $4) RETURNING id",
        timer_id,
        offset_secs,
        status,
        reason,
    )


# -- auth and shape ------------------------------------------------------------------


async def test_every_route_needs_an_identity(client):
    tid = uuid.uuid4()
    assert (await client.get("/api/v1/timers")).status_code == 401
    assert (await client.get(f"/api/v1/timers/{tid}/firings")).status_code == 401
    assert (await client.post(f"/api/v1/timers/{tid}/pause", json={})).status_code == 401
    assert (await client.post(f"/api/v1/timers/{tid}/resume")).status_code == 401
    assert (await client.post(f"/api/v1/timers/{tid}/fire")).status_code == 401
    assert (await client.delete(f"/api/v1/timers/{tid}")).status_code == 401


async def test_a_row_is_the_stores_spec_plus_last_firing_null_before_any_firing(owner_client, pool):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)

    resp = await owner_client.get("/api/v1/timers")
    assert resp.status_code == 200
    (listed,) = resp.json()["timers"]
    assert set(listed) == ROW_KEYS
    assert listed["id"] == str(row["id"])
    assert listed["kind"] == "reminder" and listed["title"] == "stretch"
    assert listed["payload"] == {"message": "stretch", "device": None}
    assert listed["schedule"] == FUTURE_ONCE
    assert listed["schedule_words"].startswith("once, ")
    assert listed["timezone"] == NY
    assert listed["conversation_id"] == str(conversation)
    assert listed["next_fire_at"] == row["next_fire_at"].isoformat()
    assert listed["paused_at"] is None and listed["paused_reason"] is None
    assert listed["consecutive_failures"] == 0
    assert listed["created_via"] == "chat"
    assert listed["last_firing"] is None  # never fired: null, not an invented outcome


async def test_an_empty_list_is_empty(owner_client):
    resp = await owner_client.get("/api/v1/timers")
    assert resp.status_code == 200
    assert resp.json() == {"timers": []}


# -- last_firing -----------------------------------------------------------------------


async def test_last_firing_is_the_newest_firings_outcome_verbatim(owner_client, pool):
    person, conversation = await _owner(pool)
    first = await _reminder(pool, person, conversation, title="first")
    second = await _reminder(pool, person, conversation, title="second")
    await _closed_firing(pool, first["id"], status="ok", offset_secs=0)
    await _closed_firing(
        pool, first["id"], status="error", reason="the chat row did not persist", offset_secs=5
    )
    # `second` has one firing still running: shown running, never coerced.
    await pool.execute(
        "INSERT INTO timer_firings (timer_id, scheduled_for, status) VALUES ($1, now(), 'running')",
        second["id"],
    )

    by_id = {t["id"]: t for t in (await owner_client.get("/api/v1/timers")).json()["timers"]}
    assert set(by_id) == {str(first["id"]), str(second["id"])}
    newest = by_id[str(first["id"])]["last_firing"]
    assert set(newest) == {"status", "ended_at", "reason"}
    assert newest["status"] == "error"
    assert newest["reason"] == "the chat row did not persist"
    assert newest["ended_at"] is not None
    assert by_id[str(second["id"])]["last_firing"] == {
        "status": "running",
        "ended_at": None,
        "reason": None,
    }


# -- pagination ------------------------------------------------------------------------


async def test_list_pages_newest_first_and_exhausts_without_overlap(owner_client, pool):
    person, conversation = await _owner(pool)
    ids = []
    for i in range(5):
        row = await _reminder(pool, person, conversation, title=f"timer-{i}")
        # Explicit created_at so newest-first is deterministic across pages.
        await pool.execute(
            "UPDATE timers SET created_at = now() + make_interval(secs => $2) WHERE id = $1",
            row["id"],
            i,
        )
        ids.append(str(row["id"]))

    seen: list[str] = []
    cursor = None
    pages = 0
    while True:
        url = "/api/v1/timers?limit=2" + (f"&before={cursor}" if cursor else "")
        resp = await owner_client.get(url)
        assert resp.status_code == 200
        page = resp.json()["timers"]
        pages += 1
        if not page:
            break
        seen.extend(t["id"] for t in page)
        cursor = page[-1]["id"]
    assert pages == 4  # 2 + 2 + 1, then the empty page that ends it
    assert seen == list(reversed(ids))  # newest first, each exactly once
    assert len(set(seen)) == 5


async def test_paging_before_an_unknown_timer_is_a_404_not_a_silent_full_list(owner_client):
    resp = await owner_client.get(f"/api/v1/timers?before={uuid.uuid4()}")
    assert resp.status_code == 404
    assert "to page before" in resp.json()["error"]


async def test_paging_before_someone_elses_timer_is_a_404(owner_client, pool):
    stranger, theirs = await _stranger(pool)
    row = await _reminder(pool, stranger, theirs)
    resp = await owner_client.get(f"/api/v1/timers?before={row['id']}")
    assert resp.status_code == 404


async def test_limit_is_capped_and_zero_is_refused(owner_client, pool, monkeypatch):
    # Postgres happily accepts LIMIT 100000, so "200 with one row" proves
    # nothing about the cap (the review's vacuity finding). The store is spied
    # on: the limit that actually reaches it must be MAX_LIMIT, on both routes.
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)
    assert (await owner_client.get("/api/v1/timers?limit=0")).status_code == 422
    seen: dict[str, int] = {}
    real_list, real_firings = timers.list_for, timers.firings_for

    async def spy_list(pool_, person_, *, limit, before=None):
        seen["timers"] = limit
        return await real_list(pool_, person_, limit=limit, before=before)

    async def spy_firings(pool_, timer_id, *, limit, before=None):
        seen["firings"] = limit
        return await real_firings(pool_, timer_id, limit=limit, before=before)

    monkeypatch.setattr(timers, "list_for", spy_list)
    monkeypatch.setattr(timers, "firings_for", spy_firings)
    resp = await owner_client.get("/api/v1/timers?limit=100000")
    assert resp.status_code == 200
    assert len(resp.json()["timers"]) == 1
    assert seen["timers"] == MAX_LIMIT
    resp = await owner_client.get(f"/api/v1/timers/{row['id']}/firings?limit=100000")
    assert resp.status_code == 200
    assert seen["firings"] == MAX_LIMIT


async def test_firings_page_newest_first_exhaust_and_refuse_a_foreign_cursor(owner_client, pool):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)
    other = await _reminder(pool, person, conversation, title="other")
    ids = [str(await _closed_firing(pool, row["id"], offset_secs=i)) for i in range(3)]
    foreign = await _closed_firing(pool, other["id"])

    first = await owner_client.get(f"/api/v1/timers/{row['id']}/firings?limit=2")
    assert first.status_code == 200
    page = first.json()["firings"]
    assert [f["id"] for f in page] == [ids[2], ids[1]]
    assert set(page[0]) == FIRING_KEYS
    assert all(f["timer_id"] == str(row["id"]) for f in page)

    second = await owner_client.get(
        f"/api/v1/timers/{row['id']}/firings?limit=2&before={page[-1]['id']}"
    )
    assert [f["id"] for f in second.json()["firings"]] == [ids[0]]
    third = await owner_client.get(f"/api/v1/timers/{row['id']}/firings?limit=2&before={ids[0]}")
    assert third.json() == {"firings": []}

    # A cursor that is a real firing of ANOTHER timer is not a cursor into this one.
    resp = await owner_client.get(f"/api/v1/timers/{row['id']}/firings?before={foreign}")
    assert resp.status_code == 404
    resp = await owner_client.get(f"/api/v1/timers/{row['id']}/firings?before={uuid.uuid4()}")
    assert resp.status_code == 404


# -- visibility: own + jobs, someone else's is not found --------------------------------


async def test_someone_elses_timer_is_404_on_every_route_and_absent_from_the_list(
    owner_client, pool
):
    stranger, theirs = await _stranger(pool)
    row = await _reminder(pool, stranger, theirs, title="theirs")
    tid = row["id"]

    assert (await owner_client.get("/api/v1/timers")).json() == {"timers": []}
    for resp in (
        await owner_client.get(f"/api/v1/timers/{tid}/firings"),
        await owner_client.post(f"/api/v1/timers/{tid}/pause", json={"reason": "mine"}),
        await owner_client.post(f"/api/v1/timers/{tid}/resume"),
        await owner_client.post(f"/api/v1/timers/{tid}/fire"),
        await owner_client.delete(f"/api/v1/timers/{tid}"),
    ):
        assert resp.status_code == 404, resp.text  # not found, never forbidden
        assert resp.json()["error"] == f"no timer {tid} here"
    # And nothing happened to it.
    after = await timers.get(pool, tid)
    assert after["paused_at"] is None
    assert await pool.fetchval("SELECT count(*) FROM timer_firings") == 0


async def test_jobs_are_visible_to_every_person_with_their_own_history(owner_client, pool):
    stranger, theirs = await _stranger(pool)
    await _reminder(pool, stranger, theirs, title="theirs")
    assert await timers.ensure_jobs(pool) == ["retention"]
    job_id = await pool.fetchval("SELECT id FROM timers WHERE kind = 'job'")
    firing = await _closed_firing(pool, job_id, status="ok")

    for client in (owner_client, await _client_for(pool, stranger)):
        listed = (await client.get("/api/v1/timers")).json()["timers"]
        jobs = [t for t in listed if t["kind"] == "job"]
        assert [j["id"] for j in jobs] == [str(job_id)]
        assert jobs[0]["payload"] == {"handler": "retention"}
        assert jobs[0]["created_via"] == "system"
        assert jobs[0]["last_firing"]["status"] == "ok"
        firings = (await client.get(f"/api/v1/timers/{job_id}/firings")).json()["firings"]
        assert [f["id"] for f in firings] == [str(firing)]
    # The stranger sees THEIR timer beside the job; the owner does not.
    stranger_rows = (await (await _client_for(pool, stranger)).get("/api/v1/timers")).json()
    assert sorted(t["kind"] for t in stranger_rows["timers"]) == ["job", "reminder"]
    assert [t["kind"] for t in (await owner_client.get("/api/v1/timers")).json()["timers"]] == [
        "job"
    ]


# -- pause / resume ------------------------------------------------------------------


async def test_pause_without_a_reason_takes_the_pages_default_and_returns_the_row(
    owner_client, pool
):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)

    resp = await owner_client.post(f"/api/v1/timers/{row['id']}/pause", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == ROW_KEYS
    assert body["paused_at"] is not None
    assert body["paused_reason"] == DEFAULT_PAUSE_REASON
    assert (
        await pool.fetchval("SELECT paused_reason FROM timers WHERE id = $1", row["id"])
        == DEFAULT_PAUSE_REASON
    )

    # No body at all is the same as an empty one.
    other = await _reminder(pool, person, conversation, title="other")
    resp = await owner_client.post(f"/api/v1/timers/{other['id']}/pause")
    assert resp.status_code == 200, resp.text
    assert resp.json()["paused_reason"] == DEFAULT_PAUSE_REASON


async def test_pause_with_a_reason_records_those_words(owner_client, pool):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)
    resp = await owner_client.post(
        f"/api/v1/timers/{row['id']}/pause", json={"reason": "on holiday"}
    )
    assert resp.status_code == 200
    assert resp.json()["paused_reason"] == "on holiday"


async def test_a_sent_but_empty_reason_is_the_stores_refusal(owner_client, pool):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)
    resp = await owner_client.post(f"/api/v1/timers/{row['id']}/pause", json={"reason": "  "})
    assert resp.status_code == 400
    assert "needs a reason" in resp.json()["error"]
    assert (await timers.get(pool, row["id"]))["paused_at"] is None


async def test_pausing_a_paused_row_is_409_with_the_original_reason(owner_client, pool):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)
    await timers.pause(pool, row["id"], reason="first reason")
    resp = await owner_client.post(f"/api/v1/timers/{row['id']}/pause", json={"reason": "again"})
    assert resp.status_code == 409
    assert "first reason" in resp.json()["error"]
    assert (await timers.get(pool, row["id"]))["paused_reason"] == "first reason"


async def test_resume_clears_the_pause_and_returns_the_row(owner_client, pool):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)
    await timers.pause(pool, row["id"], reason="holiday")

    resp = await owner_client.post(f"/api/v1/timers/{row['id']}/resume")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == ROW_KEYS
    assert body["paused_at"] is None and body["paused_reason"] is None
    # A future once keeps its instant — that is the time he asked for.
    assert body["next_fire_at"] == row["next_fire_at"].isoformat()


async def test_resuming_an_unpaused_row_is_409(owner_client, pool):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)
    resp = await owner_client.post(f"/api/v1/timers/{row['id']}/resume")
    assert resp.status_code == 409
    assert "not paused" in resp.json()["error"]


# -- fire -----------------------------------------------------------------------------


async def test_fire_runs_the_tick_inline_and_returns_the_firing_it_produced(owner_client, pool):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)

    resp = await owner_client.post(f"/api/v1/timers/{row['id']}/fire")
    assert resp.status_code == 200, resp.text
    firing = resp.json()["firing"]
    assert set(firing) == FIRING_KEYS
    assert firing["timer_id"] == str(row["id"])
    assert firing["status"] == "ok" and firing["reason"] is None
    assert firing["ended_at"] is not None
    assert firing["delivery"] == {
        "chat": {"ok": True},
        "devices": [],
        "note": "no paired device was connected",
    }

    # The answer is the row the tick wrote, not a description of one.
    stored = await pool.fetchrow("SELECT * FROM timer_firings WHERE id = $1", firing["id"])
    assert stored is not None and stored["status"] == "ok"
    assert str(stored["turn_id"]) == firing["turn_id"]
    turn = await pool.fetchrow(
        "SELECT kind, status, conversation_id FROM turns WHERE id = $1", stored["turn_id"]
    )
    assert turn["kind"] == "reminder" and turn["status"] == "ok"
    assert turn["conversation_id"] == conversation
    message = await pool.fetchrow(
        "SELECT role, content, turn_id FROM messages WHERE conversation_id = $1", conversation
    )
    assert (message["role"], message["content"]) == ("assistant", "Reminder: stretch")
    assert message["turn_id"] == stored["turn_id"]

    # And the list now says so on the row.
    (listed,) = (await owner_client.get("/api/v1/timers")).json()["timers"]
    assert listed["last_firing"] == {
        "status": "ok",
        "ended_at": firing["ended_at"],
        "reason": None,
    }
    # Run now PREVIEWS a future once: the asked-for instant still stands.
    assert listed["next_fire_at"] == row["next_fire_at"].isoformat()


async def test_fire_on_a_paused_row_is_409_and_fires_nothing(owner_client, pool):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)
    await timers.pause(pool, row["id"], reason="holiday")
    resp = await owner_client.post(f"/api/v1/timers/{row['id']}/fire")
    assert resp.status_code == 409
    assert "paused (holiday)" in resp.json()["error"]
    assert await pool.fetchval("SELECT count(*) FROM timer_firings") == 0
    assert await pool.fetchval("SELECT count(*) FROM messages") == 0


# -- delete ---------------------------------------------------------------------------


async def test_delete_is_204_removes_the_row_and_its_firings_and_a_second_delete_is_404(
    owner_client, pool
):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation)
    await _closed_firing(pool, row["id"])

    resp = await owner_client.delete(f"/api/v1/timers/{row['id']}")
    assert resp.status_code == 204
    assert resp.content == b""
    assert await timers.get(pool, row["id"]) is None
    assert await pool.fetchval("SELECT count(*) FROM timer_firings") == 0

    again = await owner_client.delete(f"/api/v1/timers/{row['id']}")
    assert again.status_code == 404


# -- the transcript's turn_kind ---------------------------------------------------------


async def test_messages_carry_turn_kind_from_the_turn_that_wrote_them_and_null_otherwise(
    owner_client, pool
):
    person, conversation = await _owner(pool)
    row = await _reminder(pool, person, conversation, title="stretch")
    # A user row with no turn, and an assistant row from a chat turn, both older
    # than the reminder so the order is fixed.
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content, created_at) "
        "VALUES ($1, 'user', 'remind me', now() - interval '2 minutes')",
        conversation,
    )
    chat_turn = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model, status, ended_at) "
        "VALUES ('chat', $1, 'qwen3:8b', 'ok', now()) RETURNING id",
        conversation,
    )
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content, turn_id, created_at) "
        "VALUES ($1, 'assistant', 'will do', $2, now() - interval '1 minute')",
        conversation,
        chat_turn,
    )
    fired = await owner_client.post(f"/api/v1/timers/{row['id']}/fire")
    assert fired.status_code == 200, fired.text

    resp = await owner_client.get(f"/api/v1/conversations/{conversation}/messages")
    assert resp.status_code == 200
    messages = resp.json()["messages"]
    assert [(m["role"], m["content"], m["turn_kind"]) for m in messages] == [
        ("user", "remind me", None),
        ("assistant", "will do", "chat"),
        ("assistant", "Reminder: stretch", "reminder"),
    ]
    # The label is the turn's kind, read through the link — never a column on
    # the message row that could drift from the trace.
    columns = {
        r["column_name"]
        for r in await pool.fetch(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'messages'"
        )
    }
    assert "turn_kind" not in columns
    # S10 added cost_usd (the turn's cost from its spans; null when unpriced).
    # S12 (2026-09-08) added agent (the agent that wrote the row, derived from
    # turns.agent_id; null for Nova and for a deleted agent) and delegations
    # (derived from the turn's delegate_to_agent spans) — trace-derived, like
    # turn_kind, never stored on the message.
    assert set(messages[0]) == {
        "id",
        "role",
        "content",
        "created_at",
        "served_by",
        "turn_kind",
        "cost_usd",
        "route_reason",
        "agent",
        "delegations",
    }
