"""Consent rules CRUD endpoints — list / create / patch / delete.

These exist so the dashboard can manage auto-approve rules. The consent gate
itself (test_capability_consent.py) verifies that enabled rules auto-approve;
this file just exercises the management API.
"""
from __future__ import annotations

from uuid import UUID

import httpx
import pytest


@pytest.mark.asyncio
async def test_consent_rule_create_list_delete(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """Round-trip: POST creates, GET lists, DELETE removes."""
    # Create
    create = await orchestrator.post(
        "/api/v1/capabilities/consent-rules",
        headers=admin_headers,
        json={
            "tool_name": "open_fix_pr",
            "provider_kind": "github",
            "scope_match": {
                "target_glob": "repos/jeremyspofford/nova-test-cap/*",
                "max_diff_lines": 50,
            },
        },
    )
    assert create.status_code == 201, create.text
    rule = create.json()
    rule_id = rule["id"]
    assert rule["tool_name"] == "open_fix_pr"
    assert rule["provider_kind"] == "github"
    assert rule["enabled"] is True
    assert rule["source"] == "user_remember"
    assert rule["scope_match"]["target_glob"] == "repos/jeremyspofford/nova-test-cap/*"

    try:
        # List
        listed = await orchestrator.get(
            "/api/v1/capabilities/consent-rules", headers=admin_headers,
        )
        assert listed.status_code == 200
        ids = [r["id"] for r in listed.json()]
        assert rule_id in ids
    finally:
        # Delete
        d = await orchestrator.delete(
            f"/api/v1/capabilities/consent-rules/{rule_id}",
            headers=admin_headers,
        )
        assert d.status_code == 204

    # Confirm deleted
    listed_after = await orchestrator.get(
        "/api/v1/capabilities/consent-rules", headers=admin_headers,
    )
    ids_after = [r["id"] for r in listed_after.json()]
    assert rule_id not in ids_after


@pytest.mark.asyncio
async def test_consent_rule_patch_toggle_enabled(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """PATCH /consent-rules/{id} flips the enabled flag."""
    create = await orchestrator.post(
        "/api/v1/capabilities/consent-rules",
        headers=admin_headers,
        json={
            "tool_name": "comment_on_pr",
            "provider_kind": "github",
            "scope_match": {"target_glob": "*"},
        },
    )
    assert create.status_code == 201
    rule_id = create.json()["id"]

    try:
        patch = await orchestrator.patch(
            f"/api/v1/capabilities/consent-rules/{rule_id}",
            headers=admin_headers,
            json={"enabled": False},
        )
        assert patch.status_code == 200, patch.text
        assert patch.json()["enabled"] is False

        # Re-enable
        patch2 = await orchestrator.patch(
            f"/api/v1/capabilities/consent-rules/{rule_id}",
            headers=admin_headers,
            json={"enabled": True},
        )
        assert patch2.status_code == 200
        assert patch2.json()["enabled"] is True
    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/consent-rules/{rule_id}", headers=admin_headers,
        )


@pytest.mark.asyncio
async def test_consent_rules_filter_by_tool(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """GET /consent-rules?tool_name=X returns only matching rules."""
    a = await orchestrator.post(
        "/api/v1/capabilities/consent-rules",
        headers=admin_headers,
        json={
            "tool_name": "open_fix_pr",
            "provider_kind": "github",
            "scope_match": {"target_glob": "repos/owner/repo-a/*"},
        },
    )
    b = await orchestrator.post(
        "/api/v1/capabilities/consent-rules",
        headers=admin_headers,
        json={
            "tool_name": "comment_on_pr",
            "provider_kind": "github",
            "scope_match": {"target_glob": "repos/owner/repo-b/*"},
        },
    )
    assert a.status_code == 201 and b.status_code == 201
    a_id = a.json()["id"]
    b_id = b.json()["id"]

    try:
        listed = await orchestrator.get(
            "/api/v1/capabilities/consent-rules?tool_name=open_fix_pr",
            headers=admin_headers,
        )
        assert listed.status_code == 200
        ids = [r["id"] for r in listed.json()]
        assert a_id in ids
        assert b_id not in ids
    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/consent-rules/{a_id}", headers=admin_headers,
        )
        await orchestrator.delete(
            f"/api/v1/capabilities/consent-rules/{b_id}", headers=admin_headers,
        )


@pytest.mark.asyncio
async def test_consent_rule_delete_unknown_returns_404(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    from uuid import uuid4
    bogus = uuid4()
    resp = await orchestrator.delete(
        f"/api/v1/capabilities/consent-rules/{bogus}",
        headers=admin_headers,
    )
    assert resp.status_code == 404
