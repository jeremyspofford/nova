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
