"""
Shared audit log writer — single source of truth for the audit_log INSERT.
"""
from __future__ import annotations

import logging
from typing import Any

import asyncpg

log = logging.getLogger(__name__)


async def write_audit_log(
    conn: asyncpg.Connection,
    *,
    event_type: str,
    severity: str = "info",
    task_id: str | None = None,
    agent_session_id: str | None = None,
    message: str | None = None,
    data: dict[str, Any] | None = None,
) -> None:
    """Insert a row into audit_log. Fire-and-forget safe — logs on error, never raises."""
    try:
        await conn.execute(
            """
            INSERT INTO audit_log
                (event_type, severity, task_id, agent_session_id, message, data)
            VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6::jsonb)
            """,
            event_type,
            severity,
            task_id,
            agent_session_id,
            message or event_type,
            # Dict, not json.dumps — the pool's jsonb codec (db.py) encodes.
            # Pre-dumping double-encodes: the column ends up a jsonb string,
            # unqueryable with ->> (the cortex reflection bug class).
            data or {},
        )
    except Exception:
        log.warning("Failed to write audit log: %s", event_type, exc_info=True)


# ── RBAC audit helper ──────────────────────────────────────────────────────

from uuid import UUID


async def audit_rbac(
    pool,
    actor_id: str | UUID | None,
    action: str,
    target_id: str | UUID | None = None,
    details: dict[str, Any] | None = None,
    ip: str | None = None,
    tenant_id: str | UUID | None = None,
) -> None:
    """Insert a row into rbac_audit_log.

    All parameters are optional-friendly: None values are stored as SQL NULL.
    UUIDs can be passed as strings or UUID objects.
    Fire-and-forget safe — logs on error, never raises.
    """
    try:
        _actor = UUID(str(actor_id)) if actor_id else None
        _target = UUID(str(target_id)) if target_id else None
        _tenant = UUID(str(tenant_id)) if tenant_id else UUID("00000000-0000-0000-0000-000000000001")
        _details = details if details else None  # dict — jsonb codec encodes (see above)

        await pool.execute(
            "INSERT INTO rbac_audit_log (actor_id, action, target_id, details, ip_address, tenant_id) "
            "VALUES ($1, $2, $3, $4, $5, $6)",
            _actor, action, _target, _details, ip, _tenant,
        )
    except Exception:
        log.warning("Failed to write RBAC audit log: action=%s actor=%s", action, actor_id, exc_info=True)
