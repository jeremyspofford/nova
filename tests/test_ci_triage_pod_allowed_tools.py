"""T2-05: ci_triage_agent Task Agent allowed_tools must reference real tools.

Closes G3 from the readiness audit. Migration 073 seeded the Task Agent's
allowed_tools with two phantom names — `get_run_details` and `get_check_runs`
— that the dispatcher rejects with "Unknown tool". The fix migration replaces
them with the real names: `get_workflow_run` and `get_run_logs`.

Real DB, no mocks: the test fetches the live row via the orchestrator's
`/api/v1/pods/{id}` endpoint, then validates every name against the static
ALL_TOOLS registry.
"""
from __future__ import annotations

import sys

sys.path.insert(0, "/home/jeremy/workspace/nova/orchestrator")
sys.path.insert(0, "/home/jeremy/workspace/nova/nova-contracts")
sys.path.insert(0, "/home/jeremy/workspace/nova/nova-worker-common")

import httpx
import pytest

PHANTOM_NAMES = {"get_run_details", "get_check_runs"}
EXPECTED_REPLACEMENTS = {"get_workflow_run", "get_run_logs"}


def _registered_tool_names() -> set[str]:
    """Source of truth: the orchestrator's static tool registry."""
    from app.tools import ALL_TOOLS

    return {t.name for t in ALL_TOOLS}


@pytest.mark.asyncio
async def test_ci_triage_task_agent_allowed_tools_are_registered(
    orchestrator: httpx.AsyncClient, admin_headers: dict
) -> None:
    """Every name in the Task Agent's allowed_tools must exist in ALL_TOOLS."""
    # Find the ci_triage_agent pod.
    resp = await orchestrator.get("/api/v1/pods", headers=admin_headers)
    assert resp.status_code == 200, resp.text
    pods = resp.json()
    triage = next((p for p in pods if p.get("name") == "ci_triage_agent"), None)
    assert triage is not None, "ci_triage_agent pod missing — migration 073 not applied?"

    # Pull its agents (returned as part of GET /pods/{id}).
    resp = await orchestrator.get(
        f"/api/v1/pods/{triage['id']}", headers=admin_headers
    )
    assert resp.status_code == 200, resp.text
    pod_detail = resp.json()
    agents = pod_detail.get("agents") or []
    task_agent = next((a for a in agents if a.get("role") == "task"), None)
    assert task_agent is not None, "ci_triage_agent has no task-role agent"

    allowed = list(task_agent.get("allowed_tools") or [])
    assert allowed, "Task Agent allowed_tools is empty"

    # Phantom names must be gone.
    leftover_phantoms = PHANTOM_NAMES.intersection(allowed)
    assert not leftover_phantoms, (
        f"Phantom tool names still in allowed_tools: {leftover_phantoms!r}. "
        f"Migration 078 should have replaced them."
    )

    # Replacements must be present.
    missing_replacements = EXPECTED_REPLACEMENTS - set(allowed)
    assert not missing_replacements, (
        f"Expected replacement tool names missing from allowed_tools: "
        f"{missing_replacements!r}"
    )

    # Every name must resolve to a registered tool.
    registered = _registered_tool_names()
    unknown = [n for n in allowed if n not in registered]
    assert not unknown, (
        f"Task Agent allowed_tools references {len(unknown)} tool(s) that are "
        f"not in ALL_TOOLS: {unknown!r}. The dispatcher will return "
        f"'Unknown tool' for each one."
    )
