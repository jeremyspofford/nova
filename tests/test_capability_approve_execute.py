"""T1-01: Approve→Execute Worker — closes the loop from approval to PR.

Today, decide_approval flips approval_requests.status to 'approved' and returns.
Nothing executes the originally-pended tool call. This test file is the seam
that proves the worker actually re-executes the approved tool.

All three tests run against the live orchestrator over HTTP. The boundary fake
is at the GitHub API layer (fake-github), not at Nova's tool dispatch layer.
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import httpx
import pytest

from fixtures.fake_github import FakeGitHubServer


TENANT = UUID("00000000-0000-0000-0000-000000000001")
USER = UUID("00000000-0000-0000-0000-000000000001")


async def _wait_for_audit_row(
    pool,
    *,
    task_id: UUID,
    event_type: str,
    response_status: str | None = None,
    timeout_s: float = 5.0,
    poll_s: float = 0.1,
) -> dict | None:
    """Poll capability_audit until a row matching the criteria appears or timeout.

    Returns the matching row as a dict, or None if not found within timeout.
    """
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        async with pool.acquire() as conn:
            if response_status is None:
                row = await conn.fetchrow(
                    "SELECT * FROM capability_audit "
                    "WHERE task_id=$1 AND event_type=$2 "
                    "ORDER BY timestamp DESC LIMIT 1",
                    task_id, event_type,
                )
            else:
                row = await conn.fetchrow(
                    "SELECT * FROM capability_audit "
                    "WHERE task_id=$1 AND event_type=$2 AND response_status=$3 "
                    "ORDER BY timestamp DESC LIMIT 1",
                    task_id, event_type, response_status,
                )
        if row:
            return dict(row)
        await asyncio.sleep(poll_s)
    return None


@pytest.fixture
async def fake_github_server():
    """Boundary fake for the GitHub REST API."""
    server = FakeGitHubServer()
    await server.start()
    try:
        yield server
    finally:
        await server.stop()


async def _create_test_credential(
    orchestrator: httpx.AsyncClient, admin_headers: dict, *, label: str,
) -> str:
    """Create a github PAT credential via the API. Returns credential_id."""
    resp = await orchestrator.post(
        "/api/v1/capabilities/credentials",
        headers=admin_headers,
        json={
            "provider_kind": "github",
            "auth_method": "pat",
            "label": label,
            "secret": "ghp_validtoken",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _create_pending_approval_via_executor(
    pool,
    *,
    task_id: UUID,
    tool_name: str,
    credential_id: UUID,
    args: dict,
    api_base: str,
) -> UUID:
    """Trigger the capability executor with MUTATE blast radius so it pends.

    Returns the approval_id. This is the same code path the agent runner takes.
    The args carry _test_api_base so the underlying open_fix_pr call hits
    fake-github when the worker eventually executes it.
    """
    from app.capabilities.executor import execute_tool as cap_execute_tool

    async def _underlying(args, secret):
        # Call the fake-github PR creation endpoint directly
        async with httpx.AsyncClient(
            base_url=api_base,
            headers={
                "Authorization": f"Bearer {secret}",
                "Accept": "application/vnd.github+json",
            },
            timeout=10,
        ) as client:
            resp = await client.post(
                f"/repos/{args['repo']}/pulls",
                json={
                    "title": args.get("title", "test"),
                    "body": args.get("body", ""),
                    "head": args.get("branch", "feature-x"),
                    "base": args.get("base", "main"),
                    "_test_patch": args.get("patch", {}),
                },
            )
            resp.raise_for_status()
            return resp.json()

    from nova_contracts import BlastRadius

    result = await cap_execute_tool(
        pool,
        tenant_id=TENANT,
        user_id=USER,
        task_id=task_id,
        actor_kind="agent",
        actor_id="ci_triage_agent",
        tool_name=tool_name,
        tool_kind="native",
        blast_radius=BlastRadius.MUTATE,
        reversible=True,
        provider_kind="github",
        target=args.get("repo"),
        credential_id=credential_id,
        args=args,
        underlying=_underlying,
    )
    assert result.get("status") == "consent_pending", (
        f"expected pending, got {result}"
    )
    return UUID(result["approval_id"])


@pytest.mark.asyncio
async def test_approve_triggers_tool_execution(
    pool,
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    fake_github_server,
):
    """The headline test: approve a pending → worker executes the tool.

    Flow:
      1. Create credential (real, in the vault).
      2. Trigger executor with MUTATE → returns consent_pending + approval_id.
      3. capability_audit has one consent_request row with task_id.
      4. POST /api/v1/capabilities/approvals/<id>/decide approve.
      5. Within 5s, capability_audit gets a tool_call success row with same task_id.
    """
    task_id = uuid4()
    tool_name = "open_fix_pr"
    cred_id = await _create_test_credential(
        orchestrator, admin_headers, label=f"nova-test-approve-{uuid4().hex[:6]}",
    )

    api_base = fake_github_server.base_url.replace(
        "127.0.0.1", "host.docker.internal",
    )

    try:
        # 2: trigger MUTATE → pending
        approval_id = await _create_pending_approval_via_executor(
            pool,
            task_id=task_id,
            tool_name=tool_name,
            credential_id=UUID(cred_id),
            args={
                "repo": "nova-test-org/nova-test-repo",
                "branch": "nova-fix-ci/abc123",
                "base": "main",
                "patch": {"files": [], "summary": "test fix", "confidence": 0.9},
                "title": "nova test PR",
                "body": "approve-execute-worker test",
            },
            api_base=api_base,
        )

        # 3: audit row exists for consent_request, same task_id
        async with pool.acquire() as conn:
            cr_row = await conn.fetchrow(
                "SELECT * FROM capability_audit "
                "WHERE task_id=$1 AND event_type='consent_request'",
                task_id,
            )
        assert cr_row is not None, "expected consent_request audit row"

        # Stash the api_base in tool_context so the worker can reach fake-github.
        # The conftest pool registers a JSONB codec that does json.dumps for
        # us, so pass the dict directly — passing a pre-serialised string
        # would double-encode and yield an array on read.
        async with pool.acquire() as conn:
            row_ctx = await conn.fetchval(
                "SELECT tool_context FROM approval_requests WHERE id=$1",
                approval_id,
            )
            existing = dict(row_ctx) if isinstance(row_ctx, dict) else {}
            existing["_test_api_base"] = api_base
            await conn.execute(
                "UPDATE approval_requests SET tool_context = $2 WHERE id = $1",
                approval_id, existing,
            )

        # 4: hit the decide endpoint
        decide_resp = await orchestrator.post(
            f"/api/v1/capabilities/approvals/{approval_id}/decide",
            headers=admin_headers,
            json={"decision": "approve"},
        )
        assert decide_resp.status_code == 200, decide_resp.text
        assert decide_resp.json() == {"status": "ok"}

        # 5: poll for tool_call success row tied to the same task_id
        tc_row = await _wait_for_audit_row(
            pool,
            task_id=task_id,
            event_type="tool_call",
            response_status="success",
            timeout_s=10.0,
        )
        assert tc_row is not None, (
            f"approval-worker did not execute approved tool for task {task_id} within 10s"
        )
        assert tc_row["tool_name"] == tool_name
        assert tc_row["response_status"] == "success"
    finally:
        # Clean up credential
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers,
        )


@pytest.mark.asyncio
async def test_reject_does_not_execute(
    pool,
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    fake_github_server,
):
    """Rejecting a pending approval must NOT enqueue or execute."""
    task_id = uuid4()
    tool_name = "open_fix_pr"
    cred_id = await _create_test_credential(
        orchestrator, admin_headers, label=f"nova-test-reject-{uuid4().hex[:6]}",
    )

    api_base = fake_github_server.base_url.replace(
        "127.0.0.1", "host.docker.internal",
    )

    try:
        approval_id = await _create_pending_approval_via_executor(
            pool,
            task_id=task_id,
            tool_name=tool_name,
            credential_id=UUID(cred_id),
            args={
                "repo": "nova-test-org/nova-test-repo",
                "branch": "nova-fix-ci/reject",
                "base": "main",
                "patch": {"files": [], "summary": "should not run", "confidence": 0.5},
                "title": "should not be created",
            },
            api_base=api_base,
        )

        # Reject
        resp = await orchestrator.post(
            f"/api/v1/capabilities/approvals/{approval_id}/decide",
            headers=admin_headers,
            json={"decision": "reject"},
        )
        assert resp.status_code == 200, resp.text

        # Wait the same window — must NOT see a tool_call success row
        tc_row = await _wait_for_audit_row(
            pool,
            task_id=task_id,
            event_type="tool_call",
            response_status="success",
            timeout_s=5.0,
        )
        assert tc_row is None, (
            f"rejected approval still produced tool_call: {tc_row}"
        )
    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers,
        )


@pytest.mark.asyncio
async def test_expired_approval_is_not_executed(
    pool,
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    fake_github_server,
):
    """An approval row past expires_at must not execute, even if approved.

    The test forces expires_at into the past directly in the DB, then approves
    via the API. The worker must detect the expiry and set status='timeout'
    instead of executing.
    """
    task_id = uuid4()
    tool_name = "open_fix_pr"
    cred_id = await _create_test_credential(
        orchestrator, admin_headers, label=f"nova-test-expired-{uuid4().hex[:6]}",
    )

    api_base = fake_github_server.base_url.replace(
        "127.0.0.1", "host.docker.internal",
    )

    try:
        approval_id = await _create_pending_approval_via_executor(
            pool,
            task_id=task_id,
            tool_name=tool_name,
            credential_id=UUID(cred_id),
            args={
                "repo": "nova-test-org/nova-test-repo",
                "branch": "nova-fix-ci/expired",
                "base": "main",
                "patch": {"files": [], "summary": "expired", "confidence": 0.4},
                "title": "expired",
            },
            api_base=api_base,
        )

        # Force expires_at into the past
        expired_ts = datetime.now(timezone.utc) - timedelta(seconds=1)
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE approval_requests SET expires_at = $2 WHERE id = $1",
                approval_id, expired_ts,
            )

        # Approve via API — endpoint will still flip to approved (gate-level
        # filter is in list_pending; decide_approval doesn't currently filter
        # on expires_at). But the worker must detect the expiry.
        resp = await orchestrator.post(
            f"/api/v1/capabilities/approvals/{approval_id}/decide",
            headers=admin_headers,
            json={"decision": "approve"},
        )
        # The endpoint may return 200 or 409 depending on implementation —
        # the contract is the worker doesn't run.
        assert resp.status_code in (200, 409), resp.text

        # Wait — must NOT see a tool_call success row
        tc_row = await _wait_for_audit_row(
            pool,
            task_id=task_id,
            event_type="tool_call",
            response_status="success",
            timeout_s=5.0,
        )
        assert tc_row is None, (
            f"expired approval was executed: {tc_row}"
        )

        # Confirm row ends in status 'timeout' (worker's resolution for expired)
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT status FROM approval_requests WHERE id=$1",
                approval_id,
            )
        assert row is not None
        assert row["status"] == "timeout", (
            f"expected status='timeout' for expired approval, got {row['status']!r}"
        )
    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers,
        )
