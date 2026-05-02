"""Consent rules CRUD — auto-approve policies stored in `consent_rules`.

Distinct from `consent.py` (the gate that evaluates rules at tool-call time).
This module is the management surface used by the dashboard to list, create,
toggle, and delete rules. Rules created here flow through `consent.gate()` →
`_find_matching_rule()` on subsequent MUTATE/DESTRUCT calls.
"""
from __future__ import annotations

import logging
from uuid import UUID

import asyncpg

from app.capabilities.models import (
    ConsentRule,
    ConsentRuleCreate,
    ConsentRuleSource,
    ConsentRuleUpdate,
)

logger = logging.getLogger(__name__)


async def list_consent_rules(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    tool_name: str | None = None,
    provider_kind: str | None = None,
) -> list[ConsentRule]:
    where = ["tenant_id=$1"]
    args: list = [tenant_id]
    if tool_name is not None:
        args.append(tool_name)
        where.append(f"tool_name=${len(args)}")
    if provider_kind is not None:
        args.append(provider_kind)
        where.append(f"provider_kind=${len(args)}")
    sql = (
        f"SELECT * FROM consent_rules WHERE {' AND '.join(where)} "
        f"ORDER BY accepted_at DESC"
    )
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *args)
    return [_row_to_model(r) for r in rows]


async def create_consent_rule(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    user_id: UUID,
    payload: ConsentRuleCreate,
) -> ConsentRule:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO consent_rules (
                tenant_id, user_id, tool_name, provider_kind,
                scope_match, source
            ) VALUES ($1,$2,$3,$4,$5,$6)
            RETURNING *
            """,
            tenant_id, user_id, payload.tool_name, payload.provider_kind,
            payload.scope_match, payload.source.value,
        )
    return _row_to_model(row)


async def update_consent_rule(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    rule_id: UUID,
    payload: ConsentRuleUpdate,
) -> ConsentRule | None:
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM consent_rules WHERE id=$1 AND tenant_id=$2",
                rule_id, tenant_id,
            )
        return _row_to_model(row) if row else None

    cols = list(updates.keys())
    values = list(updates.values())
    set_clause = ", ".join(f"{col}=${i+1}" for i, col in enumerate(cols))
    sql = (
        f"UPDATE consent_rules SET {set_clause} "
        f"WHERE id=${len(cols)+1} AND tenant_id=${len(cols)+2} RETURNING *"
    )
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, *values, rule_id, tenant_id)
    return _row_to_model(row) if row else None


async def delete_consent_rule(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    rule_id: UUID,
) -> bool:
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM consent_rules WHERE id=$1 AND tenant_id=$2",
            rule_id, tenant_id,
        )
    return result.endswith(" 1")


def _row_to_model(row: asyncpg.Record) -> ConsentRule:
    return ConsentRule(
        id=row["id"],
        tenant_id=row["tenant_id"],
        user_id=row["user_id"],
        tool_name=row["tool_name"],
        provider_kind=row["provider_kind"],
        scope_match=row["scope_match"],
        source=ConsentRuleSource(row["source"]),
        proposed_at=row["proposed_at"],
        accepted_at=row["accepted_at"],
        enabled=row["enabled"],
        last_applied_at=row["last_applied_at"],
        apply_count=row["apply_count"],
    )
