"""GET /api/v1/governance — the operator-visible audit surface (Fix 3): every
governance event, newest-first, authed, paginated with the same cursor shape
activity.py's turn ledger uses.
"""
from __future__ import annotations

import uuid

from app import governance
from tests.conftest import requires_db

pytestmark = requires_db


async def _write(pool, kind: str, tag: str) -> None:
    async with pool.acquire() as conn, conn.transaction():
        await governance.record_event(conn, kind=kind, meta={"tag": tag})


async def test_the_route_needs_an_identity(client):
    resp = await client.get("/api/v1/governance")
    assert resp.status_code == 401


async def test_lists_events_newest_first(owner_client, pool):
    await _write(pool, governance.DEVICE_REVOKED, "a")
    await _write(pool, governance.DEVICE_REVOKED, "b")
    await _write(pool, governance.DEVICE_REVOKED, "c")

    resp = await owner_client.get("/api/v1/governance")
    assert resp.status_code == 200
    events = resp.json()["events"]
    assert [e["meta"]["tag"] for e in events] == ["c", "b", "a"]
    assert all(e["kind"] == governance.DEVICE_REVOKED for e in events)
    assert all(e["created_at"] for e in events)
    # The row is a record, not a decision: no action-class column rides it.
    assert set(events[0]) == {"id", "kind", "actor", "subject_ref", "meta", "created_at"}


async def test_an_empty_ledger_lists_as_empty(owner_client):
    resp = await owner_client.get("/api/v1/governance")
    assert resp.status_code == 200
    assert resp.json() == {"events": []}


async def test_pagination_pages_strictly_older_than_the_cursor(owner_client, pool):
    for i in range(5):
        await _write(pool, governance.DEVICE_REVOKED, f"event-{i}")

    first = await owner_client.get("/api/v1/governance?limit=2")
    assert first.status_code == 200
    first_events = first.json()["events"]
    assert len(first_events) == 2

    cursor = first_events[-1]["id"]
    second = await owner_client.get(f"/api/v1/governance?limit=2&before={cursor}")
    assert second.status_code == 200
    second_events = second.json()["events"]
    assert len(second_events) == 2

    first_ids = {e["id"] for e in first_events}
    second_ids = {e["id"] for e in second_events}
    assert first_ids.isdisjoint(second_ids)  # no page overlap

    remaining = await owner_client.get(
        f"/api/v1/governance?limit=2&before={second_events[-1]['id']}"
    )
    assert len(remaining.json()["events"]) == 1
    all_seen = first_ids | second_ids | {remaining.json()["events"][0]["id"]}
    assert len(all_seen) == 5  # every event surfaced exactly once across pages


async def test_paging_before_an_unknown_id_is_a_404_not_a_silent_full_list(owner_client):
    resp = await owner_client.get(f"/api/v1/governance?before={uuid.uuid4()}")
    assert resp.status_code == 404
