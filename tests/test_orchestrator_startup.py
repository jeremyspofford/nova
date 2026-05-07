"""Tests for orchestrator startup-task observability (Fix #1: defer MCP load)."""
from __future__ import annotations

import httpx
import pytest
from conftest import ADMIN_SECRET, ORCHESTRATOR_URL


@pytest.mark.asyncio
async def test_startup_tasks_endpoint_reports_mcp_status():
    """Orchestrator must expose startup-task status so callers can tell whether
    MCP is loaded, loading, or failed. This protects against silent regressions
    of the 'await load_mcp_servers()' blocking pattern in the lifespan."""
    headers = {"X-Admin-Secret": ADMIN_SECRET} if ADMIN_SECRET else {}
    async with httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=5) as client:
        resp = await client.get("/api/v1/admin/startup-tasks", headers=headers)
    assert resp.status_code == 200, f"endpoint missing: {resp.status_code} {resp.text}"
    data = resp.json()
    assert "mcp_load" in data, "mcp_load status missing"
    assert data["mcp_load"]["status"] in ("in_progress", "complete", "failed"), (
        f"unexpected status: {data['mcp_load']}"
    )


@pytest.mark.asyncio
async def test_health_ready_returns_independent_of_mcp_completion():
    """`/health/ready` must return 200 regardless of whether MCP load is
    complete. The orchestrator yields its lifespan before MCP finishes; readiness
    is about request-handling capacity, not MCP availability."""
    async with httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=3) as client:
        resp = await client.get("/health/ready")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] in ("ready", "degraded", "ok")
