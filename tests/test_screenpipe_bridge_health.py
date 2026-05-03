import httpx
import pytest


@pytest.mark.asyncio
async def test_bridge_health_live_returns_200():
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.get("http://localhost:8140/health/live")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"
