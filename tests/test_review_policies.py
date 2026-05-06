"""Review policy cascades from parent to children, with auto-upgrade for sensitive scopes."""
import asyncio
import os

import httpx
import pytest

ORCH = os.getenv("NOVA_ORCH_URL", "http://localhost:8000")
ADMIN = os.getenv("NOVA_ADMIN_SECRET", "")
HEADERS = {"X-Admin-Secret": ADMIN}


@pytest.mark.slow
@pytest.mark.parametrize("parent_policy,parent_scope,expected_child", [
    ("top-only", ["backend"], "top-only"),
    ("cost-above-2", ["backend"], "cost-above-2"),
    ("cost-above-2", ["security"], "scopes-sensitive"),  # auto-upgrade
    ("scopes-sensitive", ["backend"], "scopes-sensitive"),
    ("all", ["backend"], "all"),
])
@pytest.mark.asyncio
async def test_policy_cascades(parent_policy, parent_scope, expected_child):
    async with httpx.AsyncClient(timeout=30.0) as c:
        r = await c.post(f"{ORCH}/api/v1/goals", headers=HEADERS, json={
            "title": f"nova-test-policy-{parent_policy}-{parent_scope[0]}",
            "description": "policy cascade test",
            "max_cost_usd": 10.0,
        })
        r.raise_for_status()
        gid = r.json()["id"]
        try:
            await c.patch(f"{ORCH}/api/v1/goals/{gid}", headers=HEADERS, json={
                "complexity": "complex",
                "spec": "test",
                "spec_children": [
                    {"title": "ch1", "description": "d", "hint": "h",
                     "depends_on": [], "estimated_cost_usd": 1.0,
                     "estimated_complexity": "complex"},
                ],
                "review_policy": parent_policy,
                "scope_analysis": {"affected_scopes": parent_scope},
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
                if g.get("maturation_status") == "waiting":
                    break
            r = await c.get(f"{ORCH}/api/v1/goals?parent_goal_id={gid}", headers=HEADERS)
            children = r.json()
            assert len(children) == 1, f"expected 1 child, got {len(children)}"
            assert children[0]["review_policy"] == expected_child, (
                f"{parent_policy}+{parent_scope} expected {expected_child}, "
                f"got {children[0]['review_policy']}"
            )
        finally:
            await c.delete(f"{ORCH}/api/v1/goals/{gid}?cascade=true", headers=HEADERS)
