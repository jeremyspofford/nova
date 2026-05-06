"""Building materializes spec_children as subgoal rows for complex goals.

This test fails today (no building.py executor) and starts passing after Task 6.
"""
import asyncio
import os

import httpx
import pytest

ORCH = os.getenv("NOVA_ORCH_URL", "http://localhost:8000")
ADMIN = os.getenv("NOVA_ADMIN_SECRET", "")
HEADERS = {"X-Admin-Secret": ADMIN}


@pytest.mark.slow
@pytest.mark.asyncio
async def test_building_spawns_subgoals_for_complex_goal():
    """A complex goal with spec_children advances review→building→waiting, spawning child rows."""
    async with httpx.AsyncClient(timeout=30.0) as c:
        r = await c.post(f"{ORCH}/api/v1/goals", headers=HEADERS, json={
            "title": "nova-test-decomp building spawns",
            "description": "test parent for building.py",
            "max_cost_usd": 10.00,
        })
        r.raise_for_status()
        goal_id = r.json()["id"]

        try:
            # Seed the goal directly into 'building' phase with structured spec_children
            children = [
                {"title": "child A", "description": "do A", "hint": "fast",
                 "depends_on": [], "estimated_cost_usd": 2.0, "estimated_complexity": "complex"},
                {"title": "child B", "description": "do B", "hint": "after A",
                 "depends_on": [0], "estimated_cost_usd": 3.0, "estimated_complexity": "complex"},
            ]
            await c.patch(f"{ORCH}/api/v1/goals/{goal_id}", headers=HEADERS, json={
                "complexity": "complex",
                "spec": "irrelevant for this test",
                "spec_children": children,
                "maturation_status": "building",
                "spec_approved_at": "2026-04-28T00:00:00Z",
                "spec_approved_by": "test",
            })

            # Wait for cortex to run building (up to 2 minutes)
            g = None
            for _ in range(60):
                await asyncio.sleep(2)
                resp = await c.get(f"{ORCH}/api/v1/goals/{goal_id}", headers=HEADERS)
                resp.raise_for_status()
                g = resp.json()
                if g.get("maturation_status") == "waiting":
                    break

            assert g is not None
            assert g["maturation_status"] == "waiting", (
                f"parent should advance to waiting, got: {g.get('maturation_status')}"
            )

            # Verify two child rows exist with parent_goal_id pointing to us
            r = await c.get(
                f"{ORCH}/api/v1/goals?parent_goal_id={goal_id}", headers=HEADERS,
            )
            r.raise_for_status()
            kids = r.json()
            assert len(kids) == 2, f"expected 2 children, got {len(kids)}: {[k['title'] for k in kids]}"
            titles = sorted(k["title"] for k in kids)
            assert titles == ["child A", "child B"]
            for k in kids:
                assert k["depth"] == 1, f"child depth should be 1, got {k['depth']}"
                # Children skip triage — speccing already classified each via
                # estimated_complexity, so they spawn directly into scoping with
                # complexity prefilled. See cortex/app/maturation/building.py.
                assert k["maturation_status"] == "scoping", (
                    f"child should start in scoping, got {k['maturation_status']}"
                )
                assert k["complexity"] == "complex", (
                    f"child complexity should be prefilled from estimated_complexity, "
                    f"got {k.get('complexity')}"
                )
        finally:
            await c.delete(f"{ORCH}/api/v1/goals/{goal_id}?cascade=true", headers=HEADERS)
