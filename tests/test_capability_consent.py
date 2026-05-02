"""Consent gate: blast-radius classification, approval lifecycle, rule auto-approve."""
from __future__ import annotations
import sys
sys.path.insert(0, '/home/jeremy/workspace/nova/orchestrator')
sys.path.insert(0, '/home/jeremy/workspace/nova/nova-contracts')

import asyncio
from uuid import UUID, uuid4
import pytest

from app.capabilities.consent import (
    gate, get_approval, list_pending, decide_approval,
    ConsentDecision, ApprovalDecision,
)
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
        tool_name="open_fix_pr", tool_kind="native",
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
        tool_name="open_fix_pr", tool_kind="native",
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
        tool_name="open_fix_pr", tool_kind="native",
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
        tool_name="open_fix_pr", tool_kind="native",
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
    d = await gate(
        pool, tenant_id=TENANT, user_id=USER, task_id=None,
        tool_name="open_fix_pr", tool_kind="native",
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
        tool_name="open_fix_pr", tool_kind="native",
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
