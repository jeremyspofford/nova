"""Watched repos for cortex CI triage — CRUD over `cortex_watched_repos`.

This table is consumed by:
  - cortex.app.drives.ci_triage (per-stimulus lookup of trigger_mode/budget)
  - orchestrator.app.polling_worker (per-cycle scan of polling_only/fallback rows)

Per-credential settings (encrypted secret, OAuth scopes) live in
`capability_credentials`. Per-repo behavior (trigger mode, polling interval,
workflow glob, active hours, daily budget) lives here so a single credential
can watch multiple repos with different rules.
"""
from __future__ import annotations

import logging
from uuid import UUID

import asyncpg
from app.capabilities.models import (
    TriggerMode,
    WatchedRepo,
    WatchedRepoCreate,
    WatchedRepoUpdate,
)

logger = logging.getLogger(__name__)


async def list_watched_repos(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    credential_id: UUID | None = None,
) -> list[WatchedRepo]:
    async with pool.acquire() as conn:
        if credential_id is not None:
            rows = await conn.fetch(
                "SELECT * FROM cortex_watched_repos "
                "WHERE tenant_id=$1 AND credential_id=$2 "
                "ORDER BY created_at DESC",
                tenant_id, credential_id,
            )
        else:
            rows = await conn.fetch(
                "SELECT * FROM cortex_watched_repos "
                "WHERE tenant_id=$1 ORDER BY created_at DESC",
                tenant_id,
            )
    return [_row_to_model(r) for r in rows]


async def get_watched_repo(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    repo_id: UUID,
) -> WatchedRepo | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM cortex_watched_repos WHERE id=$1 AND tenant_id=$2",
            repo_id, tenant_id,
        )
    return _row_to_model(row) if row else None


async def create_watched_repo(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    user_id: UUID | None,
    credential_id: UUID,
    payload: WatchedRepoCreate,
) -> WatchedRepo:
    """Raises asyncpg.UniqueViolationError on duplicate (tenant, repo)."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO cortex_watched_repos (
                tenant_id, user_id, credential_id, repo,
                trigger_mode, polling_interval_min, workflow_pattern,
                active_hours_start, active_hours_end, daily_budget, enabled
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            RETURNING *
            """,
            tenant_id, user_id, credential_id, payload.repo,
            payload.trigger_mode.value, payload.polling_interval_min,
            payload.workflow_pattern,
            payload.active_hours_start, payload.active_hours_end,
            payload.daily_budget, payload.enabled,
        )
    return _row_to_model(row)


async def update_watched_repo(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    repo_id: UUID,
    payload: WatchedRepoUpdate,
) -> WatchedRepo | None:
    """Patch only fields present in the payload (exclude_unset semantics)."""
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        return await get_watched_repo(pool, tenant_id=tenant_id, repo_id=repo_id)

    if isinstance(updates.get("trigger_mode"), TriggerMode):
        updates["trigger_mode"] = updates["trigger_mode"].value

    cols = list(updates.keys())
    values = list(updates.values())
    set_clause = ", ".join(f"{col}=${i+1}" for i, col in enumerate(cols))
    sql = (
        f"UPDATE cortex_watched_repos SET {set_clause} "
        f"WHERE id=${len(cols)+1} AND tenant_id=${len(cols)+2} RETURNING *"
    )

    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, *values, repo_id, tenant_id)
    return _row_to_model(row) if row else None


async def delete_watched_repo(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    repo_id: UUID,
) -> bool:
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM cortex_watched_repos WHERE id=$1 AND tenant_id=$2",
            repo_id, tenant_id,
        )
    return result.endswith(" 1")


def _row_to_model(row: asyncpg.Record) -> WatchedRepo:
    return WatchedRepo(
        id=row["id"],
        tenant_id=row["tenant_id"],
        user_id=row["user_id"],
        credential_id=row["credential_id"],
        repo=row["repo"],
        trigger_mode=TriggerMode(row["trigger_mode"]),
        polling_interval_min=row["polling_interval_min"],
        workflow_pattern=row["workflow_pattern"],
        active_hours_start=row["active_hours_start"],
        active_hours_end=row["active_hours_end"],
        daily_budget=row["daily_budget"],
        enabled=row["enabled"],
        created_at=row["created_at"],
    )
