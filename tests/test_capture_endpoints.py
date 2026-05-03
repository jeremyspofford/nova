import uuid

import httpx
import pytest


@pytest.mark.asyncio
async def test_list_capture_sessions_returns_screenpipe_sources_only():
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get("http://localhost:8000/api/v1/capture/sessions?limit=10")
        r.raise_for_status()
        body = r.json()
        assert "sessions" in body
        for s in body["sessions"]:
            assert s["source_kind"] == "screenpipe"


@pytest.mark.asyncio
async def test_today_stats_shape():
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get("http://localhost:8000/api/v1/capture/today-stats")
        r.raise_for_status()
        body = r.json()
        assert "sessions_count" in body
        assert "captured_seconds" in body
        assert "dropped_count" in body
        assert "top_apps" in body
        assert isinstance(body["top_apps"], list)


@pytest.mark.asyncio
async def test_exclude_endpoint_appends_to_denylist():
    """POST /exclude appends to the correct Redis JSON list with dedup."""
    unique_value = f"nova-test-app-{uuid.uuid4()}"
    async with httpx.AsyncClient(timeout=10.0) as c:
        # First call: should add the value
        r = await c.post(
            "http://localhost:8000/api/v1/capture/exclude",
            json={"scope": "app", "value": unique_value},
        )
        r.raise_for_status()
        body = r.json()
        assert body["ok"] is True
        assert body["added"] is True
        assert unique_value in body["items"]

        # Second call with the same value: should be a no-op
        r = await c.post(
            "http://localhost:8000/api/v1/capture/exclude",
            json={"scope": "app", "value": unique_value},
        )
        r.raise_for_status()
        body = r.json()
        assert body["ok"] is True
        assert body["added"] is False
        assert unique_value in body["items"]


@pytest.mark.asyncio
async def test_exclude_endpoint_rejects_invalid_scope():
    """POST /exclude with an unknown scope returns 400."""
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.post(
            "http://localhost:8000/api/v1/capture/exclude",
            json={"scope": "invalid_scope", "value": "anything"},
        )
        assert r.status_code == 400


@pytest.mark.asyncio
async def test_exclude_endpoint_rejects_empty_value():
    """POST /exclude with an empty value returns 400."""
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.post(
            "http://localhost:8000/api/v1/capture/exclude",
            json={"scope": "app", "value": "  "},
        )
        assert r.status_code == 400
