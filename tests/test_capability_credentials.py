"""Capability credential vault — CRUD roundtrip and audit."""
from __future__ import annotations

import httpx
import pytest


@pytest.mark.asyncio
async def test_create_and_retrieve_credential(orchestrator: httpx.AsyncClient, admin_headers: dict):
    """Test credential creation, retrieval, and deletion."""
    # Create
    resp = await orchestrator.post(
        "/api/v1/capabilities/credentials",
        headers=admin_headers,
        json={
            "provider_kind": "github",
            "auth_method": "pat",
            "label": "nova-test-pat-1",
            "secret": "ghp_abc12345_test_token",
            "scopes": {"repo": True, "workflow": True},
        },
    )
    assert resp.status_code == 201, resp.text
    cred = resp.json()
    cred_id = cred["id"]
    assert "secret" not in cred  # secret NEVER returned
    assert cred["health"] in ("unknown", "healthy", "invalid")
    assert cred["label"] == "nova-test-pat-1"

    # Retrieve
    resp = await orchestrator.get(
        f"/api/v1/capabilities/credentials/{cred_id}",
        headers=admin_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["id"] == cred_id
    assert "secret" not in resp.json()

    # Cleanup
    resp = await orchestrator.delete(
        f"/api/v1/capabilities/credentials/{cred_id}",
        headers=admin_headers,
    )
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_secret_never_returned(orchestrator: httpx.AsyncClient, admin_headers: dict):
    """Secret value must never appear in any API response."""
    secret_value = "ghp_uniquetestsecret_77777777"
    resp = await orchestrator.post(
        "/api/v1/capabilities/credentials",
        headers=admin_headers,
        json={
            "provider_kind": "github",
            "auth_method": "pat",
            "label": "nova-test-secret-leak-check",
            "secret": secret_value,
        },
    )
    assert resp.status_code == 201
    cred_id = resp.json()["id"]

    try:
        # Hit every endpoint that could possibly return the credential
        list_resp = await orchestrator.get(
            "/api/v1/capabilities/credentials", headers=admin_headers
        )
        get_resp = await orchestrator.get(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers
        )
        for r in (list_resp, get_resp):
            assert r.status_code == 200
            assert secret_value not in r.text, f"SECRET LEAKED in {r.url}"
    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers
        )
