"""GET /api/v1/governance — the operator-visible audit surface (Fix 3): every
governance event, newest-first, authed, paginated with the same cursor shape
activity.py's turn ledger uses.
"""
from __future__ import annotations

import uuid

from app import governance
from tests.conftest import requires_db

pytestmark = requires_db


async def _write(pool, kind: str, action_class: str, meta: dict | None = None) -> None:
    await governance.append(pool, kind=kind, action_class=action_class, meta=meta or {})


async def test_the_route_needs_an_identity(client):
    resp = await client.get("/api/v1/governance")
    assert resp.status_code == 401


async def test_lists_events_newest_first(owner_client, pool):
    await _write(pool, governance.POLICY_DENIED, "a")
    await _write(pool, governance.POLICY_DENIED, "b")
    await _write(pool, governance.POLICY_DENIED, "c")

    resp = await owner_client.get("/api/v1/governance")
    assert resp.status_code == 200
    events = resp.json()["events"]
    assert [e["action_class"] for e in events] == ["c", "b", "a"]
    assert all(e["kind"] == governance.POLICY_DENIED for e in events)
    assert all(e["created_at"] for e in events)


async def test_an_empty_ledger_lists_as_empty(owner_client):
    resp = await owner_client.get("/api/v1/governance")
    assert resp.status_code == 200
    assert resp.json() == {"events": []}


async def test_filters_by_action_class(owner_client, pool):
    await _write(pool, governance.POLICY_DENIED, "fetch_url")
    await _write(pool, governance.POLICY_DENIED, "workspace_write_file")

    resp = await owner_client.get("/api/v1/governance?action_class=fetch_url")
    assert resp.status_code == 200
    events = resp.json()["events"]
    assert len(events) == 1
    assert events[0]["action_class"] == "fetch_url"


async def test_pagination_pages_strictly_older_than_the_cursor(owner_client, pool):
    for i in range(5):
        await _write(pool, governance.POLICY_DENIED, f"class-{i}")

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
