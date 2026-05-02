"""Audit query — paginated, filterable list over `capability_audit`.

Read surface only. The writer + chain verifier live in `audit.py`. The
append-only RULE in migration 069 prevents UPDATE/DELETE at the DB layer,
so this module deliberately does not implement either.

Filtering is by exact match on string columns (actor, tool, event_type,
provider, target, blast_radius, response_status), exact UUID match on
credential_id / task_id, and time-range bounds on `timestamp`.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any
from uuid import UUID

import asyncpg

logger = logging.getLogger(__name__)

MAX_LIMIT = 500


async def query_audit(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    from_ts: datetime | None = None,
    to_ts: datetime | None = None,
    actor_id: str | None = None,
    actor_kind: str | None = None,
    event_type: str | None = None,
    tool_name: str | None = None,
    tool_kind: str | None = None,
    target: str | None = None,
    blast_radius: str | None = None,
    provider_kind: str | None = None,
    credential_id: UUID | None = None,
    task_id: UUID | None = None,
    response_status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[dict[str, Any]]:
    where = ["tenant_id=$1"]
    args: list[Any] = [tenant_id]

    def add(col: str, val: Any) -> None:
        if val is None:
            return
        args.append(val)
        where.append(f"{col}=${len(args)}")

    add("actor_id", actor_id)
    add("actor_kind", actor_kind)
    add("event_type", event_type)
    add("tool_name", tool_name)
    add("tool_kind", tool_kind)
    add("target", target)
    add("blast_radius", blast_radius)
    add("provider_kind", provider_kind)
    add("credential_id", credential_id)
    add("task_id", task_id)
    add("response_status", response_status)

    if from_ts is not None:
        args.append(from_ts)
        where.append(f"timestamp >= ${len(args)}")
    if to_ts is not None:
        args.append(to_ts)
        where.append(f"timestamp <= ${len(args)}")

    capped_limit = max(1, min(int(limit), MAX_LIMIT))
    args.append(capped_limit)
    limit_idx = len(args)
    args.append(max(0, int(offset)))
    offset_idx = len(args)

    sql = f"""
        SELECT id, tenant_id, user_id, timestamp,
               actor_kind, actor_id, task_id,
               event_type, tool_name, tool_kind, blast_radius,
               provider_kind, target, credential_id,
               args_redacted, response_status, response_summary,
               error_class, duration_ms
        FROM capability_audit
        WHERE {' AND '.join(where)}
        ORDER BY timestamp DESC, id DESC
        LIMIT ${limit_idx} OFFSET ${offset_idx}
    """

    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *args)
    return [dict(r) for r in rows]


async def count_audit(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    from_ts: datetime | None = None,
    to_ts: datetime | None = None,
) -> int:
    """Cheap count for paginator UI. No filter parity with query_audit on purpose —
    matches the dashboard's "showing N of M (within time window)" pattern."""
    where = ["tenant_id=$1"]
    args: list[Any] = [tenant_id]
    if from_ts is not None:
        args.append(from_ts)
        where.append(f"timestamp >= ${len(args)}")
    if to_ts is not None:
        args.append(to_ts)
        where.append(f"timestamp <= ${len(args)}")
    sql = f"SELECT count(*) FROM capability_audit WHERE {' AND '.join(where)}"
    async with pool.acquire() as conn:
        return await conn.fetchval(sql, *args)
