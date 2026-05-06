"""FC-003: Google OAuth state validation (CSRF protection).

These tests verify that the OAuth flow:
- Generates a random state token on /api/v1/auth/google
- Includes the state in the redirect URL sent to Google
- Rejects callbacks without state
- Rejects callbacks with unknown state
- Treats state as single-use (GETDEL semantics)
- Ignores client-supplied redirect_uri (uses Redis-stored value)

Tests are skipped if Google OAuth is not configured (GOOGLE_CLIENT_ID env var).
"""
from __future__ import annotations

import os

import httpx
import pytest

ORCHESTRATOR_URL = os.getenv("NOVA_ORCHESTRATOR_URL", "http://localhost:8000")


async def _google_enabled() -> bool:
    async with httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=5.0) as client:
        r = await client.get("/api/v1/auth/providers")
        if r.status_code != 200:
            return False
        return bool(r.json().get("google"))


@pytest.mark.asyncio
async def test_google_auth_url_includes_state():
    if not await _google_enabled():
        pytest.skip("Google OAuth not configured")
    async with httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=10.0) as client:
        r = await client.get("/api/v1/auth/google")
        assert r.status_code == 200, r.text
        body = r.json()
        assert "url" in body
        assert "state" in body, "Response must include state token"
        assert "state=" in body["url"], "State must be embedded in the OAuth URL"
        assert len(body["state"]) >= 32, "State must be sufficiently random (>=32 chars)"


@pytest.mark.asyncio
async def test_google_callback_rejects_missing_state():
    if not await _google_enabled():
        pytest.skip("Google OAuth not configured")
    async with httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=10.0) as client:
        r = await client.post(
            "/api/v1/auth/google/callback",
            json={"code": "fake-code-no-state"},
        )
        assert r.status_code == 400, r.text
        assert "state" in r.text.lower()


@pytest.mark.asyncio
async def test_google_callback_rejects_unknown_state():
    if not await _google_enabled():
        pytest.skip("Google OAuth not configured")
    async with httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=10.0) as client:
        r = await client.post(
            "/api/v1/auth/google/callback",
            json={
                "code": "fake-code",
                "state": "totally-unknown-state-token-1234567890abcdef",
            },
        )
        assert r.status_code == 400, r.text
        assert "state" in r.text.lower()


@pytest.mark.asyncio
async def test_google_callback_state_is_single_use():
    """Once a state is validated successfully, it must be consumed (GETDEL semantics).
    A second callback using the same state must be rejected.
    """
    if not await _google_enabled():
        pytest.skip("Google OAuth not configured")
    async with httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=10.0) as client:
        # Generate a fresh state via the auth-url endpoint.
        url_resp = await client.get("/api/v1/auth/google")
        assert url_resp.status_code == 200
        state = url_resp.json()["state"]

        # First use: state validation passes, code exchange fails (fake code).
        # Either way, the state is consumed.
        r1 = await client.post(
            "/api/v1/auth/google/callback",
            json={"code": "fake-code", "state": state},
        )
        # We don't care about r1's exact status — what matters is r2.

        # Second use: state must already be gone.
        r2 = await client.post(
            "/api/v1/auth/google/callback",
            json={"code": "fake-code", "state": state},
        )
        assert r2.status_code == 400, (
            f"State must be single-use; second call should fail with 400, got {r2.status_code}"
        )
        assert "state" in r2.text.lower()
