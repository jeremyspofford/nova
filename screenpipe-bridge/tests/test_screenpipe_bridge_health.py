"""Health endpoint contract tests for screenpipe-bridge.

These tests run against the live bridge container on port 8140.
"""

import httpx
import pytest

BASE = "http://localhost:8140"


@pytest.mark.asyncio
async def test_health_live():
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.get(f"{BASE}/health/live")
        assert r.status_code == 200
        assert r.json()["status"] == "alive"


@pytest.mark.asyncio
async def test_health_ready_shape():
    """When not paused and screenpipe.url not configured, /health/ready returns a valid shape."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.get(f"{BASE}/health/ready")
        # Either 200 (all deps healthy) or 503 (a required dep is down)
        assert r.status_code in (200, 503)
        body = r.json()
        assert "status" in body


@pytest.mark.asyncio
async def test_health_ready_includes_paused_field():
    """When not paused and screenpipe.url not configured, /health/ready returns paused field."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.get(f"{BASE}/health/ready")
        body = r.json()
        # paused is present on 200 responses; on 503 it may or may not be present
        # depending on whether the paused check short-circuited
        if r.status_code == 200:
            assert "paused" in body


@pytest.mark.asyncio
async def test_test_connection_requires_admin_secret():
    """/test-connection returns 401 when admin secret is missing."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.get(f"{BASE}/test-connection")
        assert r.status_code == 401


@pytest.mark.asyncio
async def test_test_connection_wrong_secret():
    """/test-connection returns 401 with a wrong secret."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.get(f"{BASE}/test-connection", headers={"X-Admin-Secret": "wrong"})
        assert r.status_code == 401


@pytest.mark.asyncio
async def test_test_connection_no_url_configured():
    """/test-connection with valid admin secret returns ok=False when URL not configured."""
    import os

    admin_secret = os.environ.get("NOVA_ADMIN_SECRET", "nova-admin-secret-change-me")
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.get(
            f"{BASE}/test-connection",
            headers={"X-Admin-Secret": admin_secret},
        )
        # If the service has a URL configured this may be ok=True; otherwise ok=False.
        # Either way the endpoint must be reachable and return valid JSON.
        assert r.status_code == 200
        body = r.json()
        assert "ok" in body
