"""Audit query endpoint — list/filter/paginate over `capability_audit`.

This is the read API the dashboard's Audit Log viewer hits. Writes go through
`audit.write_audit_event` (covered by test_capability_audit.py) and append-only
rules in migration 069. This test file just exercises the read surface.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import httpx
import pytest


# Helper: write an audit row directly via the credential-create flow, which
# triggers a credential_use event, then return the cred id for cleanup.
async def _emit_audit_via_cred(
    orchestrator: httpx.AsyncClient, admin_headers: dict, label: str
) -> str:
    resp = await orchestrator.post(
        "/api/v1/capabilities/credentials",
        headers=admin_headers,
        json={
            "provider_kind": "github",
            "auth_method": "pat",
            "label": label,
            "secret": "ghp_audit_query_test",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_audit_list_returns_recent_rows(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """GET /audit returns recent audit rows, newest first."""
    cred_id = await _emit_audit_via_cred(
        orchestrator, admin_headers, "nova-test-audit-recent"
    )
    try:
        listed = await orchestrator.get(
            "/api/v1/capabilities/audit?limit=10",
            headers=admin_headers,
        )
        assert listed.status_code == 200, listed.text
        rows = listed.json()
        assert isinstance(rows, list)
        # Should include at least the credential_use event we just generated
        assert any(r.get("credential_id") == cred_id for r in rows)
        # Sorted newest first by timestamp
        timestamps = [r["timestamp"] for r in rows]
        assert timestamps == sorted(timestamps, reverse=True)
    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers
        )


@pytest.mark.asyncio
async def test_audit_filter_by_credential_id(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """?credential_id=X returns only rows for that credential."""
    cred_a = await _emit_audit_via_cred(
        orchestrator, admin_headers, "nova-test-audit-filter-a"
    )
    cred_b = await _emit_audit_via_cred(
        orchestrator, admin_headers, "nova-test-audit-filter-b"
    )
    try:
        resp = await orchestrator.get(
            f"/api/v1/capabilities/audit?credential_id={cred_a}",
            headers=admin_headers,
        )
        assert resp.status_code == 200
        rows = resp.json()
        assert len(rows) >= 1
        for r in rows:
            assert r["credential_id"] == cred_a
    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_a}", headers=admin_headers
        )
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_b}", headers=admin_headers
        )


@pytest.mark.asyncio
async def test_audit_filter_by_event_type(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """?event_type=credential_use only returns those rows."""
    cred_id = await _emit_audit_via_cred(
        orchestrator, admin_headers, "nova-test-audit-evtype"
    )
    try:
        resp = await orchestrator.get(
            "/api/v1/capabilities/audit?event_type=credential_use&limit=20",
            headers=admin_headers,
        )
        assert resp.status_code == 200
        rows = resp.json()
        for r in rows:
            assert r["event_type"] == "credential_use"
    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers
        )


@pytest.mark.asyncio
async def test_audit_filter_by_time_range(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """?from=&to= bounds the result to a window."""
    cred_id = await _emit_audit_via_cred(
        orchestrator, admin_headers, "nova-test-audit-time"
    )
    try:
        # Window ends in the past — should return zero rows
        far_past_from = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        far_past_to = (datetime.now(timezone.utc) - timedelta(days=29)).isoformat()
        empty = await orchestrator.get(
            "/api/v1/capabilities/audit",
            headers=admin_headers,
            params={"from_ts": far_past_from, "to_ts": far_past_to},
        )
        assert empty.status_code == 200, empty.text
        assert empty.json() == []

        # Window includes "now" — must include the cred we just made
        recent_from = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        recent_to = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        recent = await orchestrator.get(
            "/api/v1/capabilities/audit",
            headers=admin_headers,
            params={"from_ts": recent_from, "to_ts": recent_to, "limit": 50},
        )
        assert recent.status_code == 200, recent.text
        assert any(r["credential_id"] == cred_id for r in recent.json())
    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers
        )


@pytest.mark.asyncio
async def test_audit_pagination(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """?limit and ?offset paginate the result set deterministically."""
    cred_ids: list[str] = []
    for i in range(3):
        cred_ids.append(
            await _emit_audit_via_cred(
                orchestrator, admin_headers, f"nova-test-audit-paginate-{i}"
            )
        )
    try:
        page1 = await orchestrator.get(
            "/api/v1/capabilities/audit?limit=2&offset=0",
            headers=admin_headers,
        )
        page2 = await orchestrator.get(
            "/api/v1/capabilities/audit?limit=2&offset=2",
            headers=admin_headers,
        )
        assert page1.status_code == 200 and page2.status_code == 200
        assert len(page1.json()) <= 2
        assert len(page2.json()) <= 2
        ids1 = {r["id"] for r in page1.json()}
        ids2 = {r["id"] for r in page2.json()}
        # No overlap — pages should be disjoint
        assert not (ids1 & ids2)
    finally:
        for cred_id in cred_ids:
            await orchestrator.delete(
                f"/api/v1/capabilities/credentials/{cred_id}",
                headers=admin_headers,
            )
