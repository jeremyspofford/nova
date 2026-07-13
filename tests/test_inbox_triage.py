"""Inbox/approvals triage — messages link to live items, approvals never zombie.

Three fixes under test, all against real services:
  * notify_log rows carry approval_id/task_id and the inbox API joins the
    referenced item's LIVE status (no more dead-end "waiting" one-liners)
  * GET /api/v1/capabilities/approvals/recent shows resolved approvals so an
    empty pending list explains itself
  * the reaper flips expired pending approvals to 'timeout' (verified live at
    ship time; the endpoints here only ever see non-zombie state)
"""
import pytest

LINK_FIELDS = {"approval_id", "task_id", "approval_status", "task_status"}


@pytest.mark.asyncio
async def test_inbox_items_carry_link_fields(orchestrator, admin_headers):
    # Guarantee at least one row exists (the test push writes an inbox row
    # even when ntfy delivery is disabled).
    resp = await orchestrator.post("/api/v1/notify/test", headers=admin_headers)
    assert resp.status_code == 200, resp.text

    resp = await orchestrator.get(
        "/api/v1/notify/inbox", params={"limit": 5}, headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    items = resp.json()["items"]
    assert items, "inbox empty even after a test push"
    for item in items:
        assert LINK_FIELDS <= set(item.keys()), item.keys()


@pytest.mark.asyncio
async def test_unlinked_message_has_null_refs(orchestrator, admin_headers):
    """The test push isn't about any approval or task — its refs must be null,
    so the UI falls back to the plain event badge."""
    resp = await orchestrator.post("/api/v1/notify/test", headers=admin_headers)
    assert resp.status_code == 200, resp.text

    resp = await orchestrator.get(
        "/api/v1/notify/inbox", params={"limit": 1}, headers=admin_headers,
    )
    newest = resp.json()["items"][0]
    assert newest["event"] == "test"
    assert newest["approval_id"] is None
    assert newest["task_id"] is None
    assert newest["approval_status"] is None
    assert newest["task_status"] is None


@pytest.mark.asyncio
async def test_recent_approvals_endpoint(orchestrator, admin_headers):
    resp = await orchestrator.get(
        "/api/v1/capabilities/approvals/recent", headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert isinstance(rows, list)
    for r in rows:
        assert r["status"] != "pending", r
        assert r["tool_name"]
        assert r["kind"] in ("consent", "checkpoint")


@pytest.mark.asyncio
async def test_recent_approvals_limit(orchestrator, admin_headers):
    resp = await orchestrator.get(
        "/api/v1/capabilities/approvals/recent",
        params={"limit": 1},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    assert len(resp.json()) <= 1


@pytest.mark.asyncio
async def test_pending_list_never_contains_expired(orchestrator, admin_headers):
    """Belt over the reaper's suspenders: whatever /approvals returns must be
    genuinely decidable — pending and unexpired."""
    from datetime import datetime, timezone

    resp = await orchestrator.get(
        "/api/v1/capabilities/approvals", headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    now = datetime.now(timezone.utc)
    for a in resp.json():
        assert a["status"] == "pending"
        expires = datetime.fromisoformat(a["expires_at"].replace("Z", "+00:00"))
        assert expires > now, f"expired approval leaked into pending list: {a['id']}"
