"""SEC-006a — platform_secrets store integration tests.

Encrypted-at-rest secrets accessible only via authenticated admin endpoints
on the orchestrator. Real services, no mocks (per project rule).
"""
from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_patch_then_resolve_roundtrips_plaintext(orchestrator, admin_headers):
    """A value PATCHed via /api/v1/admin/secrets must be decryptable via /resolve."""
    key = "nova-test-llm.anthropic_api_key"
    value = "sk-ant-fake-roundtrip-12345"

    patch = await orchestrator.patch(
        "/api/v1/admin/secrets",
        headers=admin_headers,
        json={"updates": {key: value}},
    )
    assert patch.status_code == 200, patch.text

    try:
        resolve = await orchestrator.post(
            "/api/v1/admin/secrets/resolve",
            headers=admin_headers,
            json={"keys": [key]},
        )
        assert resolve.status_code == 200, resolve.text
        body = resolve.json()
        assert body["values"][key] == value
    finally:
        await orchestrator.delete(
            f"/api/v1/admin/secrets/{key}",
            headers=admin_headers,
        )


@pytest.mark.asyncio
async def test_resolve_missing_key_omits_from_response(orchestrator, admin_headers):
    """Resolving an unset key returns success with the key absent — not 404.

    Lets callers batch-fetch and distinguish "not configured" from "not requested"
    by inspecting the response keys.
    """
    resolve = await orchestrator.post(
        "/api/v1/admin/secrets/resolve",
        headers=admin_headers,
        json={"keys": ["nova-test-definitely-not-set-anywhere"]},
    )
    assert resolve.status_code == 200, resolve.text
    body = resolve.json()
    assert body["values"] == {}


@pytest.mark.asyncio
async def test_list_returns_configured_keys_without_values(orchestrator, admin_headers):
    """GET /api/v1/admin/secrets returns key+timestamp only — never the value.

    The dashboard uses this to show "Configured" vs "Not configured" badges and
    must never have plaintext in its bundle.
    """
    key = "nova-test-list-coverage.openai_api_key"

    patch = await orchestrator.patch(
        "/api/v1/admin/secrets",
        headers=admin_headers,
        json={"updates": {key: "sk-fake-list-test"}},
    )
    assert patch.status_code == 200, patch.text

    try:
        listing = await orchestrator.get(
            "/api/v1/admin/secrets",
            headers=admin_headers,
        )
        assert listing.status_code == 200, listing.text
        body = listing.json()
        keys = {entry["key"] for entry in body["keys"]}
        assert key in keys
        # Value must never appear in any field of the list response.
        assert "sk-fake-list-test" not in listing.text
    finally:
        await orchestrator.delete(
            f"/api/v1/admin/secrets/{key}",
            headers=admin_headers,
        )
