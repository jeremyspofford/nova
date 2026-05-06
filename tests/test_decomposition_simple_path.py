"""Simple goal: building creates flat tasks (not subgoals); maturation_status advances to verifying."""
import asyncio
import os

import httpx
import pytest

ORCH = os.getenv("NOVA_ORCH_URL", "http://localhost:8000")
ADMIN = os.getenv("NOVA_ADMIN_SECRET", "")
HEADERS = {"X-Admin-Secret": ADMIN}


@pytest.mark.slow
@pytest.mark.asyncio
async def test_simple_goal_materializes_flat_tasks():
    """Simple goal: building creates tasks (not subgoals); maturation advances to verifying."""
    async with httpx.AsyncClient(timeout=30.0) as c:
        r = await c.post(f"{ORCH}/api/v1/goals", headers=HEADERS, json={
            "title": "nova-test-simple-flat",
            "description": "single-file change",
            "max_cost_usd": 5.0,
        })
        r.raise_for_status()
        gid = r.json()["id"]
        try:
            await c.patch(f"{ORCH}/api/v1/goals/{gid}", headers=HEADERS, json={
                "complexity": "simple",
                "spec": "test spec",
                "spec_children": [
                    {"title": "single task", "description": "do the thing", "hint": "h",
                     "depends_on": [], "estimated_cost_usd": 1.0, "estimated_complexity": "simple"},
                ],
                "maturation_status": "building",
                "spec_approved_at": "2026-04-28T00:00:00Z",
                "spec_approved_by": "test",
            })
            g = None
            for _ in range(60):
                await asyncio.sleep(2)
                resp = await c.get(f"{ORCH}/api/v1/goals/{gid}", headers=HEADERS)
                resp.raise_for_status()
                g = resp.json()
                if g.get("maturation_status") in ("verifying", None):
                    break
            assert g is not None
            assert g["maturation_status"] == "verifying", (
                f"simple goal should advance building → verifying, got {g.get('maturation_status')}"
            )
            children_resp = await c.get(f"{ORCH}/api/v1/goals?parent_goal_id={gid}", headers=HEADERS)
            assert len(children_resp.json()) == 0, "simple goal must not spawn subgoals"
        finally:
            await c.delete(f"{ORCH}/api/v1/goals/{gid}?cascade=true", headers=HEADERS)
