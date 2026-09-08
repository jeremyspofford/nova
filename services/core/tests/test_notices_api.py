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


async def _listing(client) -> dict:
    resp = await client.get("/api/v1/notices")
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


async def test_the_listing_is_newest_sighting_first_and_includes_cleared_rows(owner_client, pool):
    """`last_seen_at`, not `first_seen_at`: something a check still finds today
    sits above something that stopped recurring last week. A cleared row stays
    in the record — "this was true and is not any more" is part of it."""
    first = await _record(pool)
    second = await _record(pool, key="k2", facts={"a": 1})
    await notices.clear(pool, second.id)
    # The older row is seen again by a later beat, so it is the fresher news.
    await _record(pool)

    listed = (await _listing(owner_client))["notices"]

    assert [row["id"] for row in listed] == [str(first.id), str(second.id)]
    assert listed[0]["repeats"] == 2
    assert listed[1]["cleared_at"] is not None


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

    assert len(listing["notices"]) == 3
    assert listing["unseen_count"] == 1
    assert {row["id"] for row in listing["notices"]} == {
        str(unread.id),
        str(read.id),
        str(hushed.id),
    }


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
    assert body["notice"]["state"] == notices.SEEN
    assert body["notice"]["seen_at"] is not None
    # Counted AFTER the write, so the badge the click produced comes back with
    # it rather than being decremented by the page.
    assert body["unseen_count"] == 0
    # Read back from the table, not from what the route returned.
    row = await pool.fetchrow("SELECT state, seen_at FROM notices WHERE id = $1", notice.id)
    assert (row["state"], row["seen_at"] is not None) == (notices.SEEN, True)


async def test_marking_seen_twice_keeps_the_first_read(owner_client, pool):
    notice = await _record(pool)

    first = await owner_client.put(f"/api/v1/notices/{notice.id}/seen")
    second = await owner_client.put(f"/api/v1/notices/{notice.id}/seen")

    assert second.status_code == 200
    assert second.json()["notice"]["seen_at"] == first.json()["notice"]["seen_at"]


async def test_reading_a_failed_notice_stops_the_digest_owing_it(owner_client, pool):
    """The rule this router is the owner's half of: a notice he has SEEN is no
    longer deliverable, whatever its delivery state. The record that nobody was
    TOLD stands — state and reason are untouched — but he has read it with his
    own eyes, so tomorrow's digest does not repeat it at him."""
    notice = await _record(pool)
    await notices.mark_failed(pool, notice.id, "no paired device was connected")
    assert [n.id for n in await notices.deliverable(pool)] == [notice.id]

    resp = await owner_client.put(f"/api/v1/notices/{notice.id}/seen")

    assert resp.status_code == 200, resp.text
    assert resp.json()["notice"]["state"] == notices.FAILED, "a read is not a delivery"
    assert resp.json()["notice"]["failed_reason"] == "no paired device was connected"
    assert resp.json()["notice"]["seen_at"] is not None
    assert await notices.deliverable(pool) == []


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
