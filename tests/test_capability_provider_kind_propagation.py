"""T2-02: provider_kind propagation through approval_requests → consent_rules.

Closes G4 from the readiness audit. The consent gate must persist the
provider_kind on each approval row and use it (not a hardcoded "github")
when materialising a consent_rule on remember=True. Otherwise a Cloudflare
approval would create a github-scoped rule, causing accidental
auto-approvals when M12's second provider lands.
"""
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
)
from nova_contracts import BlastRadius

TENANT = UUID("00000000-0000-0000-0000-000000000001")
USER = UUID("00000000-0000-0000-0000-000000000001")


@pytest.mark.asyncio
async def test_provider_kind_stored_and_used_in_consent_rule(pool):
    """provider_kind must round-trip approval_requests → consent_rules per provider.

    Two providers, same tool_name. Each approval row stores its own
    provider_kind. Each remember=True creates a rule scoped to that provider.
    A cloudflare call must NOT auto-approve via the github rule.
    """
    unique_tool = f"test_open_fix_pr_{uuid4().hex[:8]}"

    # --- Assertion 1 + 2: github approval row stores provider_kind="github"
    d_github = await gate(
        pool,
        tenant_id=TENANT,
        user_id=USER,
        task_id=None,
        tool_name=unique_tool,
        tool_kind="native",
        blast_radius=BlastRadius.MUTATE,
        args={"repo": "x/y"},
        provider_kind="github",
        target="repos/x/y",
        reversible=True,
        actor_kind="agent",
        actor_id="ci_triage_agent",
    )
    assert d_github.action == "pending"
    assert d_github.approval_id is not None

    async with pool.acquire() as conn:
        row_pk = await conn.fetchval(
            "SELECT provider_kind FROM approval_requests WHERE id = $1",
            d_github.approval_id,
        )
    assert row_pk == "github", (
        f"approval_requests.provider_kind for github call should be 'github', got {row_pk!r}"
    )

    # --- Assertion 3 + 4: decide_approval(remember=True) creates a github-scoped rule
    ok = await decide_approval(
        pool,
        tenant_id=TENANT,
        approval_id=d_github.approval_id,
        decision=ApprovalDecision(
            decision="approve",
            decided_by="admin",
            remember=True,
            rule_scope={"target_glob": "repos/x/*"},
        ),
    )
    assert ok is True

    async with pool.acquire() as conn:
        github_rule = await conn.fetchrow(
            """
            SELECT id, provider_kind, tool_name
            FROM consent_rules
            WHERE tenant_id=$1 AND user_id=$2 AND tool_name=$3
              AND provider_kind='github' AND enabled=true
            ORDER BY accepted_at DESC LIMIT 1
            """,
            TENANT, USER, unique_tool,
        )
    assert github_rule is not None, "consent_rules row for github must exist"
    assert github_rule["provider_kind"] == "github", (
        f"consent_rules.provider_kind should mirror approval row, got {github_rule['provider_kind']!r}"
    )

    # --- Assertion 5: cloudflare approval row stores provider_kind="cloudflare"
    d_cf = await gate(
        pool,
        tenant_id=TENANT,
        user_id=USER,
        task_id=None,
        tool_name=unique_tool,
        tool_kind="native",
        blast_radius=BlastRadius.MUTATE,
        args={"zone": "example.com"},
        provider_kind="cloudflare",
        target="zones/example.com",
        reversible=True,
        actor_kind="agent",
        actor_id="ci_triage_agent",
    )
    assert d_cf.action == "pending", (
        "cloudflare call must NOT be auto-approved by the github rule "
        f"(got action={d_cf.action!r})"
    )
    assert d_cf.approval_id is not None

    async with pool.acquire() as conn:
        cf_pk = await conn.fetchval(
            "SELECT provider_kind FROM approval_requests WHERE id = $1",
            d_cf.approval_id,
        )
    assert cf_pk == "cloudflare", (
        f"approval_requests.provider_kind for cloudflare call should be 'cloudflare', got {cf_pk!r}"
    )

    # --- Assertion 6: cloudflare remember=True creates a cloudflare-scoped rule
    ok = await decide_approval(
        pool,
        tenant_id=TENANT,
        approval_id=d_cf.approval_id,
        decision=ApprovalDecision(
            decision="approve",
            decided_by="admin",
            remember=True,
            rule_scope={"target_glob": "zones/example.com"},
        ),
    )
    assert ok is True

    async with pool.acquire() as conn:
        cf_rule = await conn.fetchrow(
            """
            SELECT id, provider_kind, tool_name
            FROM consent_rules
            WHERE tenant_id=$1 AND user_id=$2 AND tool_name=$3
              AND provider_kind='cloudflare' AND enabled=true
            ORDER BY accepted_at DESC LIMIT 1
            """,
            TENANT, USER, unique_tool,
        )
    assert cf_rule is not None, (
        "consent_rules row scoped to cloudflare must exist — proves provider_kind was "
        "derived from the approval row, not hardcoded"
    )
    assert cf_rule["provider_kind"] == "cloudflare"

    # --- Assertion 7: a fresh cloudflare MUTATE call now auto-approves via the cf rule
    # (sanity: the cf rule we just created actually works)
    d_cf2 = await gate(
        pool,
        tenant_id=TENANT,
        user_id=USER,
        task_id=None,
        tool_name=unique_tool,
        tool_kind="native",
        blast_radius=BlastRadius.MUTATE,
        args={"zone": "example.com"},
        provider_kind="cloudflare",
        target="zones/example.com",
        reversible=True,
        actor_kind="agent",
        actor_id="ci_triage_agent",
    )
    assert d_cf2.action == "allow"
    assert d_cf2.rule_id == cf_rule["id"], (
        "second cloudflare call must auto-approve via the cloudflare-scoped rule"
    )
