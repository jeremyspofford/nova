"""Watched repos CRUD — list/create/update/delete via the capability router."""
from __future__ import annotations

from uuid import UUID, uuid4

import httpx
import pytest


async def _make_credential(orchestrator: httpx.AsyncClient, admin_headers: dict) -> str:
    resp = await orchestrator.post(
        "/api/v1/capabilities/credentials",
        headers=admin_headers,
        json={
            "provider_kind": "github",
            "auth_method": "pat",
            "label": "nova-test-watched-repos-cred",
            "secret": "ghp_test_watched_repos_xx",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_watched_repo_create_list_delete(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """Create, list, delete — happy path."""
    cred_id = await _make_credential(orchestrator, admin_headers)
    repo_slug = f"nova-test/wr-{uuid4().hex[:8]}"

    try:
        # Create
        create = await orchestrator.post(
            f"/api/v1/capabilities/credentials/{cred_id}/watched-repos",
            headers=admin_headers,
            json={"repo": repo_slug, "polling_interval_min": 30, "daily_budget": 10},
        )
        assert create.status_code == 201, create.text
        wr = create.json()
        wr_id = wr["id"]
        assert wr["repo"] == repo_slug
        assert wr["polling_interval_min"] == 30
        assert wr["daily_budget"] == 10
        assert wr["enabled"] is True
        assert wr["trigger_mode"] == "webhook_with_polling_fallback"

        try:
            # List under credential
            listed = await orchestrator.get(
                f"/api/v1/capabilities/credentials/{cred_id}/watched-repos",
                headers=admin_headers,
            )
            assert listed.status_code == 200
            assert any(r["id"] == wr_id for r in listed.json())
        finally:
            # Delete
            d = await orchestrator.delete(
                f"/api/v1/capabilities/watched-repos/{wr_id}", headers=admin_headers
            )
            assert d.status_code == 204
    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers
        )


@pytest.mark.asyncio
async def test_watched_repo_update_patch_semantics(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """PATCH only changes provided fields; omitted ones stay put."""
    cred_id = await _make_credential(orchestrator, admin_headers)
    repo_slug = f"nova-test/wr-patch-{uuid4().hex[:8]}"

    try:
        create = await orchestrator.post(
            f"/api/v1/capabilities/credentials/{cred_id}/watched-repos",
            headers=admin_headers,
            json={"repo": repo_slug, "polling_interval_min": 15, "daily_budget": 20},
        )
        assert create.status_code == 201
        wr_id = create.json()["id"]

        try:
            # Update only enabled flag
            patch = await orchestrator.patch(
                f"/api/v1/capabilities/watched-repos/{wr_id}",
                headers=admin_headers,
                json={"enabled": False},
            )
            assert patch.status_code == 200, patch.text
            updated = patch.json()
            assert updated["enabled"] is False
            assert updated["polling_interval_min"] == 15  # unchanged
            assert updated["daily_budget"] == 20          # unchanged

            # Update trigger_mode + interval together
            patch2 = await orchestrator.patch(
                f"/api/v1/capabilities/watched-repos/{wr_id}",
                headers=admin_headers,
                json={"trigger_mode": "polling_only", "polling_interval_min": 60},
            )
            assert patch2.status_code == 200, patch2.text
            after = patch2.json()
            assert after["trigger_mode"] == "polling_only"
            assert after["polling_interval_min"] == 60
            assert after["enabled"] is False  # still false from previous patch
        finally:
            await orchestrator.delete(
                f"/api/v1/capabilities/watched-repos/{wr_id}", headers=admin_headers
            )
    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers
        )


@pytest.mark.asyncio
async def test_watched_repo_duplicate_returns_409(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """Creating two watched_repo rows for the same (tenant, repo) returns 409."""
    cred_id = await _make_credential(orchestrator, admin_headers)
    repo_slug = f"nova-test/wr-dup-{uuid4().hex[:8]}"

    try:
        first = await orchestrator.post(
            f"/api/v1/capabilities/credentials/{cred_id}/watched-repos",
            headers=admin_headers,
            json={"repo": repo_slug},
        )
        assert first.status_code == 201
        wr_id = first.json()["id"]

        try:
            dup = await orchestrator.post(
                f"/api/v1/capabilities/credentials/{cred_id}/watched-repos",
                headers=admin_headers,
                json={"repo": repo_slug},
            )
            assert dup.status_code == 409, dup.text
        finally:
            await orchestrator.delete(
                f"/api/v1/capabilities/watched-repos/{wr_id}", headers=admin_headers
            )
    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers
        )


@pytest.mark.asyncio
async def test_watched_repo_for_unknown_credential_returns_404(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """POST under a nonexistent credential 404s — no orphan watched_repos."""
    bogus = uuid4()
    resp = await orchestrator.post(
        f"/api/v1/capabilities/credentials/{bogus}/watched-repos",
        headers=admin_headers,
        json={"repo": "nova-test/unreachable"},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.asyncio
async def test_credential_delete_cascades_watched_repos(
    orchestrator: httpx.AsyncClient, admin_headers: dict, pool
):
    """Deleting a credential removes its watched_repos via DB-level FK cascade."""
    cred_id = await _make_credential(orchestrator, admin_headers)
    repo_slug = f"nova-test/wr-cascade-{uuid4().hex[:8]}"

    create = await orchestrator.post(
        f"/api/v1/capabilities/credentials/{cred_id}/watched-repos",
        headers=admin_headers,
        json={"repo": repo_slug},
    )
    assert create.status_code == 201
    wr_id = create.json()["id"]

    # Sanity check: row exists in DB
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM cortex_watched_repos WHERE id=$1",
            UUID(wr_id),
        )
    assert row is not None

    # Delete the credential
    d = await orchestrator.delete(
        f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers,
    )
    assert d.status_code == 204

    # FK cascade should have removed the watched_repo row in the DB
    async with pool.acquire() as conn:
        row_after = await conn.fetchrow(
            "SELECT id FROM cortex_watched_repos WHERE id=$1",
            UUID(wr_id),
        )
    assert row_after is None, "watched_repo row should have been cascaded"
