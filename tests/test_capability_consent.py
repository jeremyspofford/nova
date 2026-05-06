"""Consent gate: blast-radius classification, approval lifecycle, rule auto-approve."""
from __future__ import annotations

import sys

sys.path.insert(0, '/home/jeremy/workspace/nova/orchestrator')
sys.path.insert(0, '/home/jeremy/workspace/nova/nova-contracts')

from uuid import UUID, uuid4

import pytest
from app.capabilities.consent import (
    ApprovalDecision,
    decide_approval,
    gate,
    get_approval,
)
from app.capabilities.executor import execute_tool
from nova_contracts import BlastRadius

TENANT = UUID("00000000-0000-0000-0000-000000000001")
USER = UUID("00000000-0000-0000-0000-000000000001")


@pytest.mark.asyncio
async def test_read_tier_auto_allows(pool):
    decision = await gate(
        pool, tenant_id=TENANT, user_id=USER, task_id=None,
        tool_name="list_workflow_runs", tool_kind="native",
        blast_radius=BlastRadius.READ, args={"repo": "x/y"},
        provider_kind="github", target="repos/x/y", reversible=True,
        actor_kind="agent", actor_id="ci_triage_agent",
    )
    assert decision.action == "allow"
    assert decision.approval_id is None


@pytest.mark.asyncio
async def test_propose_tier_auto_allows(pool):
    decision = await gate(
        pool, tenant_id=TENANT, user_id=USER, task_id=None,
        tool_name="diagnose_failure", tool_kind="native",
        blast_radius=BlastRadius.PROPOSE, args={},
        provider_kind="github", target=None, reversible=True,
        actor_kind="agent", actor_id="ci_triage_agent",
    )
    assert decision.action == "allow"


@pytest.mark.asyncio
async def test_mutate_tier_creates_pending(pool):
    decision = await gate(
        pool, tenant_id=TENANT, user_id=USER, task_id=None,
        tool_name=f"test_open_pr_{uuid4().hex[:8]}", tool_kind="native",
        blast_radius=BlastRadius.MUTATE,
        args={"repo": "x/y", "branch": "fix"},
        provider_kind="github", target="repos/x/y", reversible=True,
        actor_kind="agent", actor_id="ci_triage_agent",
    )
    assert decision.action == "pending"
    assert decision.approval_id is not None
    # Cleanup the approval so we don't pollute state
    row = await get_approval(pool, tenant_id=TENANT, approval_id=decision.approval_id)
    assert row is not None
    assert row["status"] == "pending"


@pytest.mark.asyncio
async def test_approve_flips_status(pool):
    d = await gate(
        pool, tenant_id=TENANT, user_id=USER, task_id=None,
        tool_name=f"test_open_pr_{uuid4().hex[:8]}", tool_kind="native",
        blast_radius=BlastRadius.MUTATE, args={"repo": "x/y"},
        provider_kind="github", target="repos/x/y", reversible=True,
        actor_kind="agent", actor_id="t",
    )
    ok = await decide_approval(
        pool, tenant_id=TENANT, approval_id=d.approval_id,
        decision=ApprovalDecision(decision="approve", decided_by="admin"),
    )
    assert ok
    row = await get_approval(pool, tenant_id=TENANT, approval_id=d.approval_id)
    assert row["status"] == "approved"


@pytest.mark.asyncio
async def test_reject_flips_status(pool):
    d = await gate(
        pool, tenant_id=TENANT, user_id=USER, task_id=None,
        tool_name=f"test_open_pr_{uuid4().hex[:8]}", tool_kind="native",
        blast_radius=BlastRadius.MUTATE, args={"repo": "x/y"},
        provider_kind="github", target="repos/x/y", reversible=True,
        actor_kind="agent", actor_id="t",
    )
    ok = await decide_approval(
        pool, tenant_id=TENANT, approval_id=d.approval_id,
        decision=ApprovalDecision(decision="reject", decided_by="admin"),
    )
    assert ok
    row = await get_approval(pool, tenant_id=TENANT, approval_id=d.approval_id)
    assert row["status"] == "rejected"


@pytest.mark.asyncio
async def test_decide_already_decided_returns_false(pool):
    d = await gate(
        pool, tenant_id=TENANT, user_id=USER, task_id=None,
        tool_name=f"test_open_pr_{uuid4().hex[:8]}", tool_kind="native",
        blast_radius=BlastRadius.MUTATE, args={"repo": "x/y"},
        provider_kind="github", target="repos/x/y", reversible=True,
        actor_kind="agent", actor_id="t",
    )
    ok1 = await decide_approval(
        pool, tenant_id=TENANT, approval_id=d.approval_id,
        decision=ApprovalDecision(decision="approve", decided_by="admin"),
    )
    ok2 = await decide_approval(
        pool, tenant_id=TENANT, approval_id=d.approval_id,
        decision=ApprovalDecision(decision="reject", decided_by="admin"),
    )
    assert ok1 is True
    assert ok2 is False  # already decided


@pytest.mark.asyncio
async def test_remember_creates_consent_rule(pool):
    # Use same unique tool name for both gate calls so the rule applies
    unique_tool = f"test_open_pr_{uuid4().hex[:8]}"
    d = await gate(
        pool, tenant_id=TENANT, user_id=USER, task_id=None,
        tool_name=unique_tool, tool_kind="native",
        blast_radius=BlastRadius.MUTATE, args={"repo": "x/y"},
        provider_kind="github", target="repos/x/y", reversible=True,
        actor_kind="agent", actor_id="t",
    )
    await decide_approval(
        pool, tenant_id=TENANT, approval_id=d.approval_id,
        decision=ApprovalDecision(
            decision="approve", decided_by="admin",
            remember=True,
            rule_scope={"target_glob": "repos/x/*"},
        ),
    )
    # Now a second matching call should auto-approve via rule
    d2 = await gate(
        pool, tenant_id=TENANT, user_id=USER, task_id=None,
        tool_name=unique_tool, tool_kind="native",
        blast_radius=BlastRadius.MUTATE, args={"repo": "x/z"},
        provider_kind="github", target="repos/x/z", reversible=True,
        actor_kind="agent", actor_id="t",
    )
    assert d2.action == "allow"
    assert d2.rule_id is not None


@pytest.mark.asyncio
async def test_rule_scope_mismatch_still_requires_approval(pool):
    """Even with a rule for 'repos/x/*', a call to 'repos/y/*' must still create approval."""
    # Assume the previous test left a rule for repos/x/* — but that's brittle.
    # Use a unique tool name to isolate.
    unique_tool = f"test_open_pr_{uuid4().hex[:8]}"
    # First, pending → approve+remember to create a rule
    d = await gate(
        pool, tenant_id=TENANT, user_id=USER, task_id=None,
        tool_name=unique_tool, tool_kind="native",
        blast_radius=BlastRadius.MUTATE, args={},
        provider_kind="github", target="repos/safe/*", reversible=True,
        actor_kind="agent", actor_id="t",
    )
    await decide_approval(
        pool, tenant_id=TENANT, approval_id=d.approval_id,
        decision=ApprovalDecision(
            decision="approve", decided_by="admin",
            remember=True,
            rule_scope={"target_glob": "repos/safe/*"},
        ),
    )
    # Now a call to a DIFFERENT target should still create pending
    d2 = await gate(
        pool, tenant_id=TENANT, user_id=USER, task_id=None,
        tool_name=unique_tool, tool_kind="native",
        blast_radius=BlastRadius.MUTATE, args={},
        provider_kind="github", target="repos/dangerous/repo", reversible=True,
        actor_kind="agent", actor_id="t",
    )
    assert d2.action == "pending"


# ---------------------------------------------------------------------------
# Executor end-to-end tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_executor_read_tier_runs_and_audits(pool):
    """READ tier flows through executor; underlying gets called; audit row emitted."""
    async def fake_tool(args, secret):
        return {"runs": [{"id": 42}], "echoed_arg": args.get("repo")}

    result = await execute_tool(
        pool,
        tenant_id=TENANT, user_id=None, task_id=None,
        actor_kind="agent", actor_id="executor-test",
        tool_name="exec_test_list_runs", tool_kind="native",
        blast_radius=BlastRadius.READ, reversible=True,
        provider_kind="github", target="repos/x/y", credential_id=None,
        args={"repo": "x/y"},
        underlying=fake_tool,
    )
    assert result == {"runs": [{"id": 42}], "echoed_arg": "x/y"}
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM capability_audit "
            "WHERE tool_name='exec_test_list_runs' "
            "ORDER BY timestamp DESC LIMIT 1"
        )
    assert row is not None
    assert row["response_status"] == "success"
    assert row["blast_radius"] == "read"


@pytest.mark.asyncio
async def test_executor_mutate_returns_pending_without_calling(pool):
    """MUTATE without a matching rule short-circuits at the gate; underlying NOT called."""
    called = []
    async def fake_tool(args, secret):
        called.append(args)
        return {"ok": True}

    result = await execute_tool(
        pool,
        tenant_id=TENANT, user_id=USER, task_id=None,
        actor_kind="agent", actor_id="executor-test-mutate",
        tool_name="exec_test_open_pr", tool_kind="native",
        blast_radius=BlastRadius.MUTATE, reversible=True,
        provider_kind="github", target="repos/x/y", credential_id=None,
        args={"repo": "x/y", "title": "test"},
        underlying=fake_tool,
    )
    assert result["status"] == "consent_pending"
    assert "approval_id" in result
    assert called == []  # underlying must NOT have been called


@pytest.mark.asyncio
async def test_executor_records_error_on_underlying_exception(pool):
    """When underlying raises, audit gets an error row and the exception re-raises."""
    async def boom(args, secret):
        raise RuntimeError("upstream service down")

    with pytest.raises(RuntimeError, match="upstream service down"):
        await execute_tool(
            pool,
            tenant_id=TENANT, user_id=None, task_id=None,
            actor_kind="agent", actor_id="executor-test-err",
            tool_name="exec_test_boom", tool_kind="native",
            blast_radius=BlastRadius.READ, reversible=True,
            provider_kind="github", target=None, credential_id=None,
            args={},
            underlying=boom,
        )
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM capability_audit "
            "WHERE tool_name='exec_test_boom' ORDER BY timestamp DESC LIMIT 1"
        )
    assert row["response_status"] == "error"
    assert row["error_class"] == "RuntimeError"
