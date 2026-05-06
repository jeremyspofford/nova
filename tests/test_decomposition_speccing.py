"""Speccing produces a JSON envelope with spec_children + verification_commands + criteria.

This test fails today and starts passing after Task 4 (the speccing.py rewrite).
"""
import asyncio
import os

import httpx
import pytest

ORCH = os.getenv("NOVA_ORCH_URL", "http://localhost:8000")
ADMIN = os.getenv("NOVA_ADMIN_SECRET", "nova-admin-secret-change-me")
HEADERS = {"X-Admin-Secret": ADMIN}


@pytest.mark.slow
@pytest.mark.asyncio
async def test_speccing_produces_structured_output():
    """Goal advances past speccing → spec_children/verification_commands/criteria populated."""
    async with httpx.AsyncClient(timeout=30.0) as c:
        # Create a complex goal manually parked at 'speccing' phase
        r = await c.post(f"{ORCH}/api/v1/goals", headers=HEADERS, json={
            "title": "nova-test-decomp speccing structured output",
            "description": "Add a /healthz alias on orchestrator next to /health/ready",
            "max_cost_usd": 5.00,
        })
        r.raise_for_status()
        goal_id = r.json()["id"]

        try:
            # Force into speccing phase (test-only path; cortex picks up next cycle)
            await c.patch(f"{ORCH}/api/v1/goals/{goal_id}", headers=HEADERS,
                json={
                    "maturation_status": "speccing",
                    "scope_analysis": {
                        "affected_scopes": ["backend"],
                        "estimated_files_changed": 1,
                    },
                })

            # Wait up to 3 minutes for cortex to advance speccing → review (or fail)
            g = None
            for _ in range(90):
                await asyncio.sleep(2)
                resp = await c.get(f"{ORCH}/api/v1/goals/{goal_id}", headers=HEADERS)
                resp.raise_for_status()
                g = resp.json()
                phase = g.get("maturation_status")
                if phase in ("review", None) or g.get("status") == "failed":
                    break

            assert g is not None, "no goal response"
            # spec_children should be populated even on the hard-fallback path,
            # since speccing always writes the column (empty list on fallback).
            assert g.get("spec_children") is not None, (
                "speccing should populate spec_children with structured JSON; "
                f"goal state: {g}"
            )
            children = g["spec_children"]
            assert isinstance(children, list)
            for c_item in children:
                assert "title" in c_item and "description" in c_item, c_item
                assert "depends_on" in c_item and isinstance(c_item["depends_on"], list)
                assert "estimated_cost_usd" in c_item

            assert g.get("verification_commands") is not None, (
                "speccing should populate verification_commands"
            )
            assert isinstance(g["verification_commands"], list)
            assert g.get("success_criteria_structured") is not None
            assert isinstance(g["success_criteria_structured"], list)
        finally:
            # Cleanup
            await c.delete(f"{ORCH}/api/v1/goals/{goal_id}?cascade=true", headers=HEADERS)
