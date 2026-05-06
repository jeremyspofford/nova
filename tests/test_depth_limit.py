"""At depth=max_depth-1, complex children get flat-task-materialized regardless of complexity claim."""
import asyncio
import os

import httpx
import pytest

ORCH = os.getenv("NOVA_ORCH_URL", "http://localhost:8000")
ADMIN = os.getenv("NOVA_ADMIN_SECRET", "")
HEADERS = {"X-Admin-Secret": ADMIN}


@pytest.mark.slow
@pytest.mark.asyncio
async def test_depth_wall_forces_flat_tasks():
    async with httpx.AsyncClient(timeout=30.0) as c:
        r = await c.post(f"{ORCH}/api/v1/goals", headers=HEADERS, json={
            "title": "nova-test-depth-wall",
            "description": "depth wall test",
            "max_cost_usd": 10.0,
        })
        r.raise_for_status()
        gid = r.json()["id"]
        try:
            await c.patch(f"{ORCH}/api/v1/goals/{gid}", headers=HEADERS, json={
                "depth": 4, "max_depth": 5,
                "complexity": "complex",
                "spec": "test",
                "spec_children": [
                    {"title": "complex child", "description": "desc", "hint": "h",
                     "depends_on": [], "estimated_cost_usd": 1.0,
                     "estimated_complexity": "complex"},
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
                if g.get("maturation_status") == "verifying":
                    break
            assert g is not None
            assert g["maturation_status"] == "verifying", (
                f"at depth wall, building should advance to verifying (flat tasks), "
                f"got {g.get('maturation_status')}"
            )
            r = await c.get(f"{ORCH}/api/v1/goals?parent_goal_id={gid}", headers=HEADERS)
            assert len(r.json()) == 0, "depth wall hit but subgoals spawned anyway"
        finally:
            await c.delete(f"{ORCH}/api/v1/goals/{gid}?cascade=true", headers=HEADERS)
