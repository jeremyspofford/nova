"""GitHub PAT granted-scopes are captured during validation.

The /user call already proves the token authenticates. GitHub returns the
token's actual scopes via the `X-OAuth-Scopes` response header. Capturing
those into `credential.scopes.granted` lets the dashboard warn when a PAT
is missing required scopes (e.g. `admin:repo_hook` for webhook registration)
*before* a tool call later 403s.
"""
from __future__ import annotations

import httpx
import pytest
from fixtures.fake_github import FakeGitHubServer


@pytest.mark.asyncio
async def test_validation_captures_granted_scopes(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """A successful /user validation populates credential.scopes.granted."""
    fake = FakeGitHubServer()
    await fake.start()
    try:
        host_visible = fake.base_url.replace("127.0.0.1", "host.docker.internal")

        # ghp_full_scopes is the fake's full-scoped token sentinel
        create = await orchestrator.post(
            "/api/v1/capabilities/credentials",
            headers=admin_headers,
            json={
                "provider_kind": "github",
                "auth_method": "pat",
                "label": "nova-test-scopes-full",
                "secret": "ghp_full_scopes",
            },
        )
        assert create.status_code == 201, create.text
        cred_id = create.json()["id"]

        try:
            test = await orchestrator.post(
                f"/api/v1/capabilities/credentials/{cred_id}/test",
                headers=admin_headers,
                json={"api_base": host_visible},
            )
            assert test.status_code == 200, test.text
            assert test.json()["health"] == "healthy"

            # The credential's scopes JSONB should now carry granted: [...]
            got = await orchestrator.get(
                f"/api/v1/capabilities/credentials/{cred_id}",
                headers=admin_headers,
            )
            assert got.status_code == 200
            scopes = got.json().get("scopes") or {}
            granted = scopes.get("granted") or []
            assert "repo" in granted
            assert "workflow" in granted
            assert "admin:repo_hook" in granted
        finally:
            await orchestrator.delete(
                f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers,
            )
    finally:
        await fake.stop()


@pytest.mark.asyncio
async def test_validation_captures_minimal_scopes(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """A token with insufficient scopes validates as healthy but reports the gap."""
    fake = FakeGitHubServer()
    await fake.start()
    try:
        host_visible = fake.base_url.replace("127.0.0.1", "host.docker.internal")

        # ghp_minimal_scopes returns only `repo`
        create = await orchestrator.post(
            "/api/v1/capabilities/credentials",
            headers=admin_headers,
            json={
                "provider_kind": "github",
                "auth_method": "pat",
                "label": "nova-test-scopes-minimal",
                "secret": "ghp_minimal_scopes",
            },
        )
        assert create.status_code == 201
        cred_id = create.json()["id"]

        try:
            test = await orchestrator.post(
                f"/api/v1/capabilities/credentials/{cred_id}/test",
                headers=admin_headers,
                json={"api_base": host_visible},
            )
            assert test.status_code == 200
            assert test.json()["health"] == "healthy"

            got = await orchestrator.get(
                f"/api/v1/capabilities/credentials/{cred_id}",
                headers=admin_headers,
            )
            scopes = got.json().get("scopes") or {}
            granted = scopes.get("granted") or []
            assert "repo" in granted
            assert "admin:repo_hook" not in granted
            assert "workflow" not in granted
        finally:
            await orchestrator.delete(
                f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers,
            )
    finally:
        await fake.stop()
