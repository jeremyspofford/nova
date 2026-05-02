"""Consent gate: classifies blast-radius, checks rules, creates approvals.

The gate is the boundary between an agent's tool-call decision and execution.
Every external action — native tool, MCP HTTP, MCP stdio — flows through here.
"""
from __future__ import annotations
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import UUID, uuid4

import asyncpg

from nova_contracts import BlastRadius

# v1 single-tenant default; multi-tenant will derive from auth context
_DEFAULT_USER = UUID("00000000-0000-0000-0000-000000000001")

logger = logging.getLogger(__name__)


@dataclass
class ConsentDecision:
    action: Literal["allow", "deny", "pending"]
    approval_id: UUID | None = None
    rule_id: UUID | None = None  # set when allow was via auto-approve rule
    reason: str | None = None    # human-readable explanation


async def gate(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    user_id: UUID | None,
    task_id: UUID | None,
    tool_name: str,
    tool_kind: str,                 # 'native' | 'mcp_http' | 'mcp_stdio'
    blast_radius: BlastRadius,
    args: dict,
    provider_kind: str | None,
    target: str | None,
    reversible: bool,
    actor_kind: str,
    actor_id: str,
    diff_preview: str | None = None,
) -> ConsentDecision:
    """Decide whether a tool call may proceed.

    READ / PROPOSE → allow (auto)
    MUTATE / DESTRUCT → check rules; if no rule matches, create pending approval
    """
    if blast_radius in (BlastRadius.READ, BlastRadius.PROPOSE):
        return ConsentDecision(action="allow")

    # MUTATE or DESTRUCT — check for matching rule first
    rule = await _find_matching_rule(
        pool, tenant_id=tenant_id, user_id=user_id,
        tool_name=tool_name, provider_kind=provider_kind or "",
        args=args, target=target,
    )
    if rule is not None:
        # Auto-approve via rule
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE consent_rules SET last_applied_at=now(), apply_count=apply_count+1 WHERE id=$1",
                rule["id"],
            )
        return ConsentDecision(action="allow", rule_id=rule["id"],
                               reason=f"auto-approved by rule {rule['id']}")

    # No matching rule → create pending approval row
    approval_id = uuid4()
    expires_at = datetime.now(timezone.utc) + timedelta(hours=24)
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO approval_requests (
              id, tenant_id, task_id, requested_by,
              tool_name, tool_kind, blast_radius,
              args_redacted, diff_preview, status,
              created_at, expires_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',now(),$10
            )
            """,
            approval_id, tenant_id, task_id, actor_id,
            tool_name, tool_kind, blast_radius.value,
            args, diff_preview, expires_at,
        )
    return ConsentDecision(action="pending", approval_id=approval_id)


async def _find_matching_rule(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    user_id: UUID | None,
    tool_name: str,
    provider_kind: str,
    args: dict,
    target: str | None,
) -> asyncpg.Record | None:
    """Return the first enabled consent_rule whose scope_match accepts this call.

    v1 matchers in scope_match JSONB:
      - target_glob: shell-style glob over `target` (e.g. 'repos/jeremyspofford/*')
      - max_diff_lines: int — args['diff_lines'] must be <= this
      - failure_signature: substring match against args['failure_signature']
    """
    if user_id is None:
        return None
    async with pool.acquire() as conn:
        rules = await conn.fetch(
            """
            SELECT id, scope_match
            FROM consent_rules
            WHERE tenant_id=$1 AND user_id=$2 AND tool_name=$3
              AND provider_kind=$4 AND enabled=true
            """,
            tenant_id, user_id, tool_name, provider_kind,
        )
    for rule in rules:
        if _matches(rule["scope_match"], args, target):
            return rule
    return None


def _matches(scope: dict, args: dict, target: str | None) -> bool:
    """AND-of-keys matcher across the v1 matcher kinds."""
    import fnmatch
    if "target_glob" in scope:
        if target is None or not fnmatch.fnmatchcase(target, scope["target_glob"]):
            return False
    if "max_diff_lines" in scope:
        diff_lines = args.get("diff_lines")
        if diff_lines is None or diff_lines > scope["max_diff_lines"]:
            return False
    if "failure_signature" in scope:
        sig = args.get("failure_signature", "")
        if scope["failure_signature"] not in str(sig):
            return False
    return True


async def get_approval(pool: asyncpg.Pool, *, tenant_id: UUID, approval_id: UUID) -> asyncpg.Record | None:
    async with pool.acquire() as conn:
        return await conn.fetchrow(
            "SELECT * FROM approval_requests WHERE id=$1 AND tenant_id=$2",
            approval_id, tenant_id,
        )


async def list_pending(pool: asyncpg.Pool, *, tenant_id: UUID) -> list[asyncpg.Record]:
    async with pool.acquire() as conn:
        return await conn.fetch(
            "SELECT * FROM approval_requests "
            "WHERE tenant_id=$1 AND status='pending' AND expires_at > now() "
            "ORDER BY created_at DESC",
            tenant_id,
        )


@dataclass
class ApprovalDecision:
    decision: Literal["approve", "reject"]
    decided_by: str
    decided_via: str = "dashboard"
    remember: bool = False
    rule_scope: dict | None = None  # required if remember=True


async def decide_approval(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    approval_id: UUID,
    decision: ApprovalDecision,
) -> bool:
    """Record approve/reject. If remember=True, insert a consent_rule.
    Returns True if the row was decided; False if not found / already decided.
    """
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT * FROM approval_requests WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
                approval_id, tenant_id,
            )
            if not row or row["status"] != "pending":
                return False
            new_status = "approved" if decision.decision == "approve" else "rejected"
            rule_id = None
            if decision.decision == "approve" and decision.remember:
                if decision.rule_scope is None:
                    raise ValueError("remember=True requires rule_scope")
                # Get the user_id from… well, v1 single-tenant — derive from tenant
                # For now, hardcoded to _DEFAULT_USER. Caller should pass user_id explicitly later.
                rule_row = await conn.fetchrow(
                    """
                    INSERT INTO consent_rules (
                      tenant_id, user_id, tool_name, provider_kind,
                      scope_match, source
                    ) VALUES ($1, $2, $3, $4, $5, 'user_remember')
                    RETURNING id
                    """,
                    tenant_id, _DEFAULT_USER, row["tool_name"],
                    "github",  # FIXME: derive from approval row context
                    decision.rule_scope,
                )
                rule_id = rule_row["id"]
            await conn.execute(
                """
                UPDATE approval_requests
                SET status=$1, decided_by=$2, decided_via=$3,
                    decided_at=now(), rule_id=$4
                WHERE id=$5
                """,
                new_status, decision.decided_by, decision.decided_via,
                rule_id, approval_id,
            )
    return True
