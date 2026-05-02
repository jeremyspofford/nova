"""Capability credential vault — CRUD roundtrip and audit."""
from __future__ import annotations

import json as _json
from uuid import UUID

import httpx
import pytest

from fixtures.fake_github import FakeGitHubServer


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


@pytest.mark.asyncio
async def test_credential_health_healthy_via_fake_github(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """Validation against fake-github with a good token returns HEALTHY.

    Networking: fake-github binds 0.0.0.0; orchestrator container reaches the
    host via host.docker.internal (mapped to host-gateway in docker-compose.yml).
    """
    fake = FakeGitHubServer()
    await fake.start()
    try:
        # Rewrite the loopback address to host.docker.internal so the orchestrator
        # container can route the request back to the test-runner host.
        host_visible_base = fake.base_url.replace("127.0.0.1", "host.docker.internal")

        create = await orchestrator.post(
            "/api/v1/capabilities/credentials",
            headers=admin_headers,
            json={
                "provider_kind": "github",
                "auth_method": "pat",
                "label": "nova-test-validate-1",
                "secret": "ghp_validtoken",
            },
        )
        assert create.status_code == 201, create.text
        cred_id = create.json()["id"]

        try:
            test = await orchestrator.post(
                f"/api/v1/capabilities/credentials/{cred_id}/test",
                headers=admin_headers,
                json={"api_base": host_visible_base},
            )
            assert test.status_code == 200, test.text
            assert test.json()["health"] == "healthy"
        finally:
            await orchestrator.delete(
                f"/api/v1/capabilities/credentials/{cred_id}",
                headers=admin_headers,
            )
    finally:
        await fake.stop()


@pytest.mark.asyncio
async def test_credential_create_writes_audit(orchestrator: httpx.AsyncClient, admin_headers: dict, pool):
    """Creating a credential produces a capability_audit row with credential_id set."""
    import asyncio

    resp = await orchestrator.post(
        "/api/v1/capabilities/credentials",
        headers=admin_headers,
        json={
            "provider_kind": "github",
            "auth_method": "pat",
            "label": "nova-test-audit-trail",
            "secret": "ghp_audittrail_test",
        },
    )
    assert resp.status_code == 201
    cred_id = resp.json()["id"]

    try:
        # Give the background write a moment to complete (in case it's async)
        await asyncio.sleep(0.5)

        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT event_type, args_redacted FROM capability_audit "
                "WHERE credential_id=$1 ORDER BY timestamp ASC",
                UUID(cred_id),
            )
        assert any(r["event_type"] == "credential_use" for r in rows), \
            f"Expected credential_use audit row; got: {[r['event_type'] for r in rows]}"
        # Optional: assert there's a 'store' action in the args_redacted of one of them
        actions = []
        for r in rows:
            args = r["args_redacted"]
            if isinstance(args, str):
                args = _json.loads(args)
            if args:
                actions.append(args.get("action"))
        assert "store" in actions, f"Expected action=store in audit args; got actions={actions}"
    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}",
            headers=admin_headers,
        )
