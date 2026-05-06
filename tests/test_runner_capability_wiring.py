"""Integration test for the agent-runner ↔ capability-executor seam.

When an agent on a credentialed pod (e.g. ci_triage_agent) decides to call
a github_external MUTATE tool like open_fix_pr or register_webhook, the
dispatcher must:

  1. Look up the credential by credential_id (from task context)
  2. Run the consent gate — MUTATE without a matching rule creates a
     pending approval_request and returns 'consent_pending' WITHOUT
     touching the underlying tool.
  3. Audit every step so the chain is intact.

This test exists because before it was added, the agent runner blew up at
the moment of tool dispatch with `execute_tool() missing 1 required
keyword-only argument: 'secret'` — because github_external_tools'
execute_tool signature requires `secret`, but app.tools.execute_tool
(the dispatcher) only had `(name, arguments)`. The capability platform
existed and worked when called directly; the *seam* between the agent
runner and the capability platform was simply never wired.

The test asserts the seam at the dispatch layer (not via the LLM) so it
runs deterministically. The full end-to-end agent-decides-to-call-tool
path is covered by the M11 acceptance walkthrough.
"""
from __future__ import annotations

import sys

sys.path.insert(0, '/home/jeremy/workspace/nova/orchestrator')
sys.path.insert(0, '/home/jeremy/workspace/nova/nova-contracts')
sys.path.insert(0, '/home/jeremy/workspace/nova/nova-worker-common')

import json
from uuid import UUID, uuid4

import httpx
import pytest


@pytest.fixture
async def app_db_pool(pool):
    """Patch the orchestrator's global db pool so test-scope direct calls into
    `app.tools.execute_tool` work without spinning up the full FastAPI app."""
    from app import db as app_db
    saved = app_db._pool
    app_db._pool = pool
    try:
        yield
    finally:
        app_db._pool = saved


@pytest.mark.asyncio
async def test_dispatch_routes_credentialed_mutate_through_capability_executor(
    orchestrator: httpx.AsyncClient, admin_headers: dict, pool, app_db_pool
):
    """app.tools.execute_tool, given a github_external MUTATE tool + context with
    credential_id, must route through capabilities.executor and create a pending
    approval_request — without ever calling the underlying GitHub API."""
    cred_resp = await orchestrator.post(
        "/api/v1/capabilities/credentials",
        headers=admin_headers,
        json={
            "provider_kind": "github",
            "auth_method": "pat",
            "label": f"nova-test-runner-wire-{uuid4().hex[:6]}",
            "secret": "ghp_dummy_for_dispatch_test_only",
        },
    )
    assert cred_resp.status_code == 201, cred_resp.text
    cred_id = cred_resp.json()["id"]

    try:
        from app.tools import execute_tool

        result = await execute_tool(
            "open_fix_pr",
            {
                "repo": "nova-test/wire-check-do-not-create",
                "branch": "test-branch",
                "base": "main",
                "patch": {"files": [], "summary": "wire-check", "confidence": 0.5},
                "title": "wire-check (should not actually open)",
            },
            context={
                "tenant_id": "00000000-0000-0000-0000-000000000001",
                "user_id":   "00000000-0000-0000-0000-000000000001",
                "task_id":   str(uuid4()),
                "credential_id": cred_id,
                "actor_kind": "agent",
                "actor_id": "ci_triage_agent",
            },
        )

        # Dispatcher returns a string (because the runner consumes it as message content).
        assert isinstance(result, str), f"expected str, got {type(result).__name__}"
        parsed = json.loads(result)
        assert parsed.get("status") == "consent_pending", f"got {parsed}"
        approval_id = parsed["approval_id"]

        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT tool_name, status, blast_radius FROM approval_requests WHERE id=$1::uuid",
                UUID(approval_id),
            )
        assert row is not None, "approval_request row not found in DB"
        assert row["tool_name"] == "open_fix_pr"
        assert row["status"] == "pending"
        assert row["blast_radius"] == "mutate"

    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}",
            headers=admin_headers,
        )


@pytest.mark.asyncio
async def test_dispatch_without_credential_id_errors_clearly(
    orchestrator: httpx.AsyncClient, admin_headers: dict, app_db_pool
):
    """Calling a github_external tool without credential_id in context should
    return a clear error rather than crashing — so an agent that lacks the
    credential context fails loud at dispatch instead of getting a confusing
    'missing secret' kwarg error."""
    from app.tools import execute_tool

    result = await execute_tool(
        "register_webhook",
        {"repo": "nova-test/x", "target_url": "https://example.invalid", "credential_id": "", "events": ["workflow_run"]},
        context={
            "tenant_id": "00000000-0000-0000-0000-000000000001",
            "user_id":   "00000000-0000-0000-0000-000000000001",
            "task_id":   str(uuid4()),
            "actor_kind": "agent",
            "actor_id":   "ci_triage_agent",
            # NOTE: deliberately no credential_id
        },
    )

    assert isinstance(result, str)
    parsed = json.loads(result)
    # Error shape — clear text the agent can read back to the user / log.
    assert parsed.get("status") == "error"
    assert "credential_id" in parsed.get("message", "").lower()


@pytest.mark.asyncio
async def test_dispatch_without_context_falls_through_to_legacy_path(
    orchestrator: httpx.AsyncClient, admin_headers: dict, app_db_pool
):
    """When called without context (legacy callers — tests, manual invocations
    of non-credentialed tools), dispatch must keep working unchanged. Running
    a non-credentialed tool with no context should produce its normal output,
    not a credential-related error."""
    from app.tools import execute_tool
    # `list_skills` is a platform tool with no credential requirement
    result = await execute_tool("list_skills", {})
    assert isinstance(result, str)
    # Should be valid JSON or at least a plain string output, not an error
    # complaining about credentials.
    assert "credential_id" not in result.lower() or "no credential required" in result.lower()
