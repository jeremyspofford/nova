"""Integration tests for the neutral memory API + agent memory tools."""
import os

import httpx
import pytest

ORCH = os.getenv("NOVA_ORCHESTRATOR_URL", "http://localhost:8000")
MEM = os.getenv("NOVA_MEMORY_URL", "http://localhost:8002")
ADMIN_SECRET = os.getenv("NOVA_ADMIN_SECRET", "nova-admin-secret-change-me")
_HDRS = {"X-Admin-Secret": ADMIN_SECRET}


@pytest.mark.asyncio
async def test_active_backend_reported():
    """The neutral API reports which backend is live."""
    async with httpx.AsyncClient(timeout=10) as c:
        resp = await c.get(f"{MEM}/api/v1/memory/backend", headers=_HDRS)
        assert resp.status_code == 200
        assert resp.json().get("backend") in ("okf", "engram")


@pytest.mark.asyncio
async def test_context_endpoint():
    """context retrieval works on the neutral path for any backend."""
    async with httpx.AsyncClient(timeout=15) as c:
        resp = await c.post(
            f"{MEM}/api/v1/memory/context",
            headers=_HDRS,
            json={"query": "nova-test-memory-search"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert "context" in data
        assert "memory_ids" in data


@pytest.mark.asyncio
async def test_stats_endpoint():
    """stats reports the provider name and item count."""
    async with httpx.AsyncClient(timeout=10) as c:
        resp = await c.get(f"{MEM}/api/v1/memory/stats", headers=_HDRS)
        assert resp.status_code == 200
        data = resp.json()
        assert "provider_name" in data
        assert "total_items" in data


@pytest.mark.asyncio
async def test_memory_tools_registered():
    """Memory tools appear in the orchestrator tool catalog."""
    async with httpx.AsyncClient(timeout=10) as c:
        resp = await c.get(f"{ORCH}/api/v1/tools", headers=_HDRS)
        if resp.status_code != 200:
            pytest.skip(f"tool catalog returned {resp.status_code}")
        blob = resp.text
        for name in ("search_memory", "what_do_i_know", "recall_topic",
                     "read_memory", "remember"):
            assert f'"{name}"' in blob, f"{name} missing from tool catalog"
