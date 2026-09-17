"""/api/v1/notices — the Inbox's surface.

Three routes and one rule underneath them: the badge is the SERVER's count,
and a notice he has read is no longer owed to him. Every write here is read
back from the row postgres wrote, so what the page renders after a click is
what the store holds, never a locally patched copy.

Neither button is a permission (owner ruling 2026-09-03): `seen` is a read
receipt, `mute` is a noise preference, and the tests below pin what each one
does to the ROW — a mute that survives a delivery, a read that does not launder
a failed delivery into a delivered one.
"""

from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app import checks, identity, notices
from app.main import app
from tests.conftest import BASE_URL, requires_db

pytestmark = requires_db

# A stand-in family, so this suite tests the ROUTER and not whichever checks
# app/checks happens to register today. notices.record derives the check name
# from the live registry at write time, so a notice cannot exist without one.
PROBE = "probe_api"

# Every key a notice json carries. Pinned as a SET: a field added to the row
# without the page being told is invisible, and a field silently dropped is a
# fact the Inbox stops showing. `finding_key`, `turn_id` and `firing_id` are
# deliberately absent — the Inbox opens the trace of the turn that ACTED.
NOTICE_KEYS = {
    "id",
    "check_name",
    "title",
    "facts",
    "urgent",
    "acted",
    "acted_note",
    "acted_turn_id",
    "repeats",
    "state",
    "delivery",
    "failed_reason",
    "first_seen_at",
    "last_seen_at",
    "delivered_at",
    "seen_at",
    "muted_at",
    "cleared_at",
    # S25.2.4: WHICH chat row carried it, which is what decides whether
    # "talk about this" has anywhere to go. A push-only delivery has a
    # `delivered_at` and no message, so the two are not interchangeable.
    "delivered_message_id",
    # S25.1.2 / Q2: whether it is quiet RIGHT NOW (the live mute, not the
    # `muted_at` stamp a cleared row keeps), and who asked for the quiet —
    # null meaning she did.
    "silenced",
    "muted_by",
}


async def _never_runs(app_, pool_):
    raise AssertionError("the notices API must never run a check")


@pytest.fixture(autouse=True)
def registered(monkeypatch):
    monkeypatch.setitem(
        checks.REGISTRY,
        PROBE,
        checks.Check(
            name=PROBE,
            describe=f"a stand-in check for the notices API suite ({PROBE})",
            urgent=False,
            run=_never_runs,
        ),
    )


def _finding(key: str = "timer_failing:one", **overrides) -> checks.Finding:
    kwargs = dict(
        key=key,
        title="the nightly backup timer has failed 4 times running",
        facts={"failures": 4, "timer": "backup"},
        urgent=False,
    )
    kwargs.update(overrides)
    return checks.Finding(**kwargs)


async def _record(pool, **overrides):
    notice, _ = await notices.record(
        pool, _finding(**overrides), check_name=PROBE, turn_id=None, firing_id=None
    )
    return notice


async def _listing(client, *, muted: bool = False) -> dict:
    resp = await client.get("/api/v1/notices", params={"muted": str(muted).lower()})
    assert resp.status_code == 200, resp.text
    return resp.json()


# -- auth and shape -------------------------------------------------------------


async def test_every_route_needs_an_identity(client):
    nid = uuid.uuid4()
    assert (await client.get("/api/v1/notices")).status_code == 401
    assert (await client.put(f"/api/v1/notices/{nid}/seen")).status_code == 401
    mute = await client.put(f"/api/v1/notices/{nid}/mute", json={"muted": True})
    assert mute.status_code == 401


async def test_a_row_carries_every_field_the_inbox_reads(owner_client, pool):
    notice = await _record(pool)

    (listed,) = (await _listing(owner_client))["notices"]

    assert set(listed) == NOTICE_KEYS
    assert listed["id"] == str(notice.id)
    assert listed["check_name"] == PROBE
    assert listed["title"] == notice.title
    assert listed["facts"] == {"failures": 4, "timer": "backup"}
    assert (listed["urgent"], listed["acted"], listed["repeats"]) == (False, False, 1)
    assert listed["state"] == notices.RAISED
    assert (listed["delivery"], listed["failed_reason"]) == ({}, None)
    assert listed["first_seen_at"] == notice.first_seen_at.isoformat()
    assert listed["last_seen_at"] == notice.last_seen_at.isoformat()
    assert listed["delivered_at"] is None and listed["seen_at"] is None
    assert listed["muted_at"] is None and listed["cleared_at"] is None
    assert (listed["acted_note"], listed["acted_turn_id"]) == (None, None)
    assert listed["delivered_message_id"] is None
    assert (listed["silenced"], listed["muted_by"]) == (False, None)


async def test_the_listing_is_newest_TELLING_first_and_includes_cleared_rows(owner_client, pool):
    """REVERSED 2026-09-16 (was `last_seen_at`, "newest sighting first").

    A beat finding the same thing again is the check talking, not news for
    him — sorting by it put the noisiest condition on the box permanently at
    the top. The order is when he was TOLD. A cleared row stays in the
    record either way: "this was true and is not any more" is part of it.
    """
    first = await _record(pool)
    second = await _record(pool, key="k2", facts={"a": 1})
    await notices.clear(pool, second.id)
    # The older row recurs. It does not thereby become the newer news.
    await _record(pool)

    listed = (await _listing(owner_client))["notices"]

    assert [row["id"] for row in listed] == [str(second.id), str(first.id)]
    assert listed[1]["repeats"] == 2
    assert listed[0]["cleared_at"] is not None


async def test_the_badge_is_counted_by_the_server_over_every_row(owner_client, pool):
    """Not the page's guess from the rows it happens to hold: the count is
    `notices.unseen_count` over the whole table, which is why it can differ
    from the length of `notices` in the same answer."""
    assert (await _listing(owner_client))["unseen_count"] == 0

    unread = await _record(pool)
    read = await _record(pool, key="k2", facts={"a": 1})
    hushed = await _record(pool, key="k3", facts={"a": 2})
    await notices.mark_seen(pool, read.id)
    await notices.set_muted(pool, hushed.id, True)

    listing = await _listing(owner_client)

    # The muted row is NOT in the default view (S25.1.2) — but the answer
    # says so out loud rather than just omitting it, which is what keeps a
    # filter from reading as a disappearance.
    assert {row["id"] for row in listing["notices"]} == {str(unread.id), str(read.id)}
    assert listing["unseen_count"] == 1
    assert listing["muted_count"] == 1

    hidden = await _listing(owner_client, muted=True)
    assert [row["id"] for row in hidden["notices"]] == [str(hushed.id)]
    # Same badge on both views: it counts news he has not read, and a muted
    # row was never news. The two views cannot disagree about the number.
    assert hidden["unseen_count"] == 1


async def test_the_listing_honours_its_limit(owner_client, pool):
    await _record(pool)
    second = await _record(pool, key="k2", facts={"a": 1})

    resp = await owner_client.get("/api/v1/notices", params={"limit": 1})

    assert resp.status_code == 200, resp.text
    assert [row["id"] for row in resp.json()["notices"]] == [str(second.id)]
    # The badge still counts BOTH: a limit is a page size, not a filter on
    # what he has not read.
    assert resp.json()["unseen_count"] == 2


# -- the read receipt -----------------------------------------------------------


async def test_marking_seen_returns_the_row_as_written_and_the_new_count(owner_client, pool):
    notice = await _record(pool)

    resp = await owner_client.put(f"/api/v1/notices/{notice.id}/seen")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["notice"]["id"] == str(notice.id)
    # S25.1.3: the receipt is the timestamp. The state goes on saying what
    # happened to the notice — nobody has delivered this one yet.
    assert body["notice"]["state"] == notices.RAISED
    assert body["notice"]["seen_at"] is not None
    # Counted AFTER the write, so the badge the click produced comes back with
    # it rather than being decremented by the page.
    assert body["unseen_count"] == 0
    # Read back from the table, not from what the route returned.
    row = await pool.fetchrow("SELECT state, seen_at FROM notices WHERE id = $1", notice.id)
    assert (row["state"], row["seen_at"] is not None) == (notices.RAISED, True)


async def test_marking_seen_twice_keeps_the_first_read(owner_client, pool):
    notice = await _record(pool)

    first = await owner_client.put(f"/api/v1/notices/{notice.id}/seen")
    second = await owner_client.put(f"/api/v1/notices/{notice.id}/seen")

    assert second.status_code == 200
    assert second.json()["notice"]["seen_at"] == first.json()["notice"]["seen_at"]


async def test_reading_a_failed_notice_does_NOT_stop_the_digest_owing_it(owner_client, pool):
    """REVERSED 2026-09-16 (S25 Q1), and this router is the owner's half of
    the reversal: the click that used to silence a card forever now only
    records that he looked at it.

    Everything else about the row is untouched, as before — `failed` and its
    reason stand, because a read receipt does not make a push that never
    landed have landed. What changed is that the debt stands too. To end it
    he mutes it, which says so in a word and can be undone from the Inbox's
    muted view."""
    notice = await _record(pool)
    await notices.mark_failed(pool, notice.id, "no paired device was connected")
    assert [n.id for n in await notices.deliverable(pool)] == [notice.id]

    resp = await owner_client.put(f"/api/v1/notices/{notice.id}/seen")

    assert resp.status_code == 200, resp.text
    assert resp.json()["notice"]["state"] == notices.FAILED, "a read is not a delivery"
    assert resp.json()["notice"]["failed_reason"] == "no paired device was connected"
    assert resp.json()["notice"]["seen_at"] is not None
    assert [n.id for n in await notices.deliverable(pool)] == [notice.id], (
        "reading it in the Inbox silenced the digest — the defect S25.1.3 "
        "names: one click, two meanings, and no word saying so"
    )


async def test_marking_an_unknown_notice_seen_is_a_404_in_the_stores_words(owner_client):
    missing = uuid.uuid4()

    resp = await owner_client.put(f"/api/v1/notices/{missing}/seen")

    assert resp.status_code == 404
    assert str(missing) in resp.json()["error"]
    assert "nothing was written" in resp.json()["error"]


# -- the noise preference -------------------------------------------------------


async def test_mute_and_unmute_round_trip_and_move_the_badge(owner_client, pool):
    notice = await _record(pool)
    assert (await _listing(owner_client))["unseen_count"] == 1

    muted = await owner_client.put(f"/api/v1/notices/{notice.id}/mute", json={"muted": True})

    assert muted.status_code == 200, muted.text
    assert muted.json()["notice"]["state"] == notices.MUTED
    assert muted.json()["notice"]["muted_at"] is not None
    assert muted.json()["unseen_count"] == 0, "a mute is a preference; it leaves the badge"
    assert await notices.deliverable(pool) == []

    unmuted = await owner_client.put(f"/api/v1/notices/{notice.id}/mute", json={"muted": False})

    assert unmuted.status_code == 200, unmuted.text
    # Back to the state its own evidence supports: nobody was ever told, so it
    # is owed again — not a remembered previous state.
    assert unmuted.json()["notice"]["state"] == notices.RAISED
    assert unmuted.json()["notice"]["muted_at"] is None
    assert unmuted.json()["unseen_count"] == 1
    assert [n.id for n in await notices.deliverable(pool)] == [notice.id]


async def test_a_mute_body_without_the_key_is_refused(owner_client, pool):
    """Required and nullable-free: a client that forgot the field cannot mute
    (or unmute) by accident."""
    notice = await _record(pool)

    resp = await owner_client.put(f"/api/v1/notices/{notice.id}/mute", json={})

    assert resp.status_code == 422
    row = await pool.fetchrow("SELECT state, muted_at FROM notices WHERE id = $1", notice.id)
    assert (row["state"], row["muted_at"]) == (notices.RAISED, None)


async def test_muting_an_unknown_notice_is_a_404_in_the_stores_words(owner_client):
    missing = uuid.uuid4()

    resp = await owner_client.put(f"/api/v1/notices/{missing}/mute", json={"muted": True})

    assert resp.status_code == 404
    assert str(missing) in resp.json()["error"]


async def test_any_person_in_the_household_sees_the_inbox(owner_client, pool):
    """Notices belong to the beats and the beats to the owner; the table
    carries no person of its own, so nothing here is ownership-scoped — the
    same stance the Agents page takes. require_person is only auth."""
    await _record(pool)
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('sam', 'adult') RETURNING id"
    )
    token = await identity.create_session(pool, pid)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url=BASE_URL,
        cookies={identity.COOKIE_NAME: token},
    ) as other:
        listing = await _listing(other)

    assert len(listing["notices"]) == 1 and listing["unseen_count"] == 1


# -- "talk about this" (S25.2.4) -------------------------------------------------


async def _owner_id(pool):
    """The person `owner_client` registered. Read from the table rather than
    taken as a fixture, so these tests cannot pass against a person the API
    never saw."""
    return await pool.fetchval("SELECT id FROM people WHERE role = 'owner'")


async def _delivered(pool, owner_person) -> tuple:
    """A notice that actually reached him: a chat row, and the notice
    recording WHICH row carried it — which is the whole of what makes a room
    possible (S24 put `delivered_message_id` on the notice for this)."""
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", owner_person
    )
    message = await pool.fetchval(
        "INSERT INTO messages (conversation_id, role, content) "
        "VALUES ($1, 'assistant', 'Two things came up today.') RETURNING id",
        conversation,
    )
    notice = await _record(pool)
    await notices.mark_delivered(
        pool, notice.id, delivery={"chat": {"ok": True}}, message_id=message
    )
    return notice, conversation, message


async def test_talking_about_a_delivered_notice_opens_the_room_off_its_message(owner_client, pool):
    """S24 built the mechanism; this is its first consumer. The room hangs
    off the message that TOLD him — so the conversation he lands in already
    has the digest above it, and the seed carries the check's own facts."""
    notice, _conversation, message = await _delivered(pool, await _owner_id(pool))

    resp = await owner_client.post(f"/api/v1/notices/{notice.id}/thread")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["parent_message_id"] == str(message)
    assert body["created"] is True
    # Read back from the table, not from what the route said.
    parent = await pool.fetchval(
        "SELECT parent_message_id FROM conversations WHERE id = $1", body["conversation_id"]
    )
    assert parent == message


async def test_asking_twice_lands_in_the_SAME_room(owner_client, pool):
    """Two taps race each other on a phone. `open_thread` leans on the
    partial unique index rather than checking first, so the second is a read
    — never a second room with half the conversation in it."""
    notice, _conversation, _message = await _delivered(pool, await _owner_id(pool))

    first = await owner_client.post(f"/api/v1/notices/{notice.id}/thread")
    second = await owner_client.post(f"/api/v1/notices/{notice.id}/thread")

    assert first.json()["conversation_id"] == second.json()["conversation_id"]
    assert (first.json()["created"], second.json()["created"]) == (True, False)


async def test_a_notice_nobody_was_told_about_has_nowhere_to_talk_and_says_so(owner_client, pool):
    """The case S24 named and did not solve. A notice with no delivery has no
    message, so it has no room — and the answer says that in those words.

    It is a fact about the WORLD (nobody was told), never a decision about
    him: he can still open the card, read it, mute it, and say anything he
    likes in the main chat. That is why it reads "there is no message to talk
    under" and not "you cannot".
    """
    notice = await _record(pool)

    resp = await owner_client.post(f"/api/v1/notices/{notice.id}/thread")

    assert resp.status_code == 409, resp.text
    reason = resp.json()["error"]
    assert "has not been delivered" in reason and "no message to talk under" in reason
    for word in ("not allowed", "permission", "cannot do", "denied"):
        assert word not in reason.lower()


async def test_talking_about_a_notice_that_does_not_exist_is_the_stores_404(owner_client):
    resp = await owner_client.post(f"/api/v1/notices/{uuid.uuid4()}/thread")

    assert resp.status_code == 404, resp.text
    assert "nothing was written" in resp.json()["error"]


async def test_a_mute_HE_made_is_recorded_as_his(owner_client, pool):
    """The other half of S25 Q2. Her tool passes None; this route passes his
    id, and the Inbox renders the difference — otherwise a silence he did not
    ask for is indistinguishable from one he did."""
    notice = await _record(pool)

    resp = await owner_client.put(f"/api/v1/notices/{notice.id}/mute", json={"muted": True})

    assert resp.status_code == 200, resp.text
    muted_by = await pool.fetchval(
        "SELECT muted_by FROM notice_mutes WHERE check_name = $1 AND finding_key = $2",
        notice.check_name,
        notice.finding_key,
    )
    assert muted_by == await _owner_id(pool)


async def test_the_listing_says_who_silenced_each_row(owner_client, pool):
    """S25 Q2, at the surface that renders it. "Nova muted this" and "you
    muted this" are different facts and the page cannot tell them apart from
    a boolean."""
    his = await _record(pool)
    hers = await _record(pool, key="k2", facts={"a": 1})
    await owner_client.put(f"/api/v1/notices/{his.id}/mute", json={"muted": True})
    await notices.set_muted(pool, hers.id, True, muted_by=None)

    listed = (await _listing(owner_client, muted=True))["notices"]

    by_key = {row["id"]: row for row in listed}
    assert by_key[str(his.id)]["muted_by"] == str(await _owner_id(pool))
    assert by_key[str(hers.id)]["muted_by"] is None
    assert all(row["silenced"] is True for row in listed)


async def test_silenced_is_the_live_mute_and_not_the_stamp_left_on_the_row(owner_client, pool):
    """Clearing a condition forgets its mute and leaves `muted_at` standing,
    because the stamp is the row's history. `silenced` is the answer to "is
    this quiet right now", which is the only one an Unmute button can act on.
    """
    notice = await _record(pool)
    await owner_client.put(f"/api/v1/notices/{notice.id}/mute", json={"muted": True})
    await notices.clear(pool, notice.id)

    row = (await _listing(owner_client))["notices"][0]

    assert row["muted_at"] is not None, "the history is still on the row"
    assert row["silenced"] is False and row["muted_by"] is None
    assert (await _listing(owner_client))["muted_count"] == 0


# -- the digest view (S25 Q4) ----------------------------------------------------


async def test_the_digest_view_groups_by_the_message_that_carried_them(owner_client, pool):
    """ "What you were told on Tuesday." The group is the telling, and every
    card in it is the row as the Inbox renders it elsewhere — one shape, so
    a card cannot say different things on two pages."""
    notice, _conversation, message = await _delivered(pool, await _owner_id(pool))
    waiting = await _record(pool, key="k2", facts={"a": 1})

    resp = await owner_client.get("/api/v1/notices/digests")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [g["message_id"] for g in body["digests"]] == [str(message)]
    assert [n["id"] for n in body["digests"][0]["notices"]] == [str(notice.id)]
    assert body["digests"][0]["delivered_at"] is not None
    # The other half of the same question, and the same rows 2.4 draws a
    # disabled "talk about this" on.
    assert [n["id"] for n in body["not_told_yet"]] == [str(waiting.id)]


async def test_digests_is_a_route_and_not_read_as_a_notice_id(owner_client):
    """FastAPI matches in declaration order, so `/digests` sitting after
    `/{notice_id}` would be parsed as a malformed UUID and answered 422.
    Pinned because the failure is a 422 on a route that plainly exists."""
    resp = await owner_client.get("/api/v1/notices/digests")

    assert resp.status_code == 200, resp.text
    assert "digests" in resp.json()
