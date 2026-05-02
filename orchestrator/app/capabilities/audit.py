"""Capability audit log writer with per-tenant tamper-evident hash chain."""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import asyncpg

from app.capabilities.redactor import redact_dict


logger = logging.getLogger(__name__)
GENESIS_HASH = b'\x00' * 32


def _canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, default=str, separators=(",", ":"))


async def write_audit_event(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    actor_kind: str,
    actor_id: str,
    event_type: str,
    user_id: UUID | None = None,
    task_id: UUID | None = None,
    tool_name: str | None = None,
    tool_kind: str | None = None,
    blast_radius: str | None = None,
    provider_kind: str | None = None,
    target: str | None = None,
    credential_id: UUID | None = None,
    args_redacted: dict | None = None,
    response_status: str = "success",
    response_summary: str | None = None,
    error_class: str | None = None,
    duration_ms: int | None = None,
) -> UUID:
    """Insert an audit row, computing per-tenant SHA256 chain."""
    args = redact_dict(args_redacted) if args_redacted else None
    summary = response_summary[:512] if response_summary else None
    audit_id = uuid4()
    timestamp = datetime.now(timezone.utc)

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Per-tenant advisory lock to serialize chain extension
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                f"capability_audit:{tenant_id}",
            )
            prev_hash_row = await conn.fetchval(
                "SELECT content_hash FROM capability_audit "
                "WHERE tenant_id=$1 ORDER BY timestamp DESC, id DESC LIMIT 1",
                tenant_id,
            )
            prev_hash: bytes = bytes(prev_hash_row) if prev_hash_row else GENESIS_HASH

            content = _canonical_json({
                "id": str(audit_id),
                "tenant_id": str(tenant_id),
                "user_id": str(user_id) if user_id else None,
                "timestamp": timestamp.isoformat(),
                "actor_kind": actor_kind,
                "actor_id": actor_id,
                "task_id": str(task_id) if task_id else None,
                "event_type": event_type,
                "tool_name": tool_name,
                "tool_kind": tool_kind,
                "blast_radius": blast_radius,
                "provider_kind": provider_kind,
                "target": target,
                "credential_id": str(credential_id) if credential_id else None,
                "args_redacted": args,
                "response_status": response_status,
                "response_summary": summary,
                "error_class": error_class,
                "duration_ms": duration_ms,
                "prev_hash": prev_hash.hex(),
            })
            content_hash = hashlib.sha256(content.encode()).digest()

            await conn.execute(
                """
                INSERT INTO capability_audit (
                  id, tenant_id, user_id, timestamp,
                  actor_kind, actor_id, task_id,
                  event_type, tool_name, tool_kind, blast_radius,
                  provider_kind, target, credential_id,
                  args_redacted, response_status, response_summary,
                  error_class, duration_ms,
                  prev_hash, content_hash
                ) VALUES (
                  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                  $15,$16,$17,$18,$19,$20,$21
                )
                """,
                audit_id, tenant_id, user_id, timestamp,
                actor_kind, actor_id, task_id,
                event_type, tool_name, tool_kind, blast_radius,
                provider_kind, target, credential_id,
                args, response_status, summary,
                error_class, duration_ms,
                prev_hash, content_hash,
            )
    return audit_id


@dataclass
class ChainResult:
    is_valid: bool
    row_count: int
    broken_at: UUID | None = None


async def verify_chain(pool: asyncpg.Pool, *, tenant_id: UUID) -> ChainResult:
    """Walk the tenant's chain from genesis; return ChainResult."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM capability_audit WHERE tenant_id=$1 "
            "ORDER BY timestamp ASC, id ASC",
            tenant_id,
        )
    if not rows:
        return ChainResult(is_valid=True, row_count=0)

    expected_prev = GENESIS_HASH
    for row in rows:
        if bytes(row["prev_hash"]) != expected_prev:
            return ChainResult(is_valid=False, row_count=len(rows),
                               broken_at=row["id"])
        # Recompute content hash from stored fields
        args = row["args_redacted"]

        recomputed_content = _canonical_json({
            "id": str(row["id"]),
            "tenant_id": str(row["tenant_id"]),
            "user_id": str(row["user_id"]) if row["user_id"] else None,
            "timestamp": row["timestamp"].isoformat(),
            "actor_kind": row["actor_kind"],
            "actor_id": row["actor_id"],
            "task_id": str(row["task_id"]) if row["task_id"] else None,
            "event_type": row["event_type"],
            "tool_name": row["tool_name"],
            "tool_kind": row["tool_kind"],
            "blast_radius": row["blast_radius"],
            "provider_kind": row["provider_kind"],
            "target": row["target"],
            "credential_id": str(row["credential_id"]) if row["credential_id"] else None,
            "args_redacted": args,
            "response_status": row["response_status"],
            "response_summary": row["response_summary"],
            "error_class": row["error_class"],
            "duration_ms": row["duration_ms"],
            "prev_hash": expected_prev.hex(),
        })
        recomputed_hash = hashlib.sha256(recomputed_content.encode()).digest()
        if recomputed_hash != bytes(row["content_hash"]):
            return ChainResult(is_valid=False, row_count=len(rows),
                               broken_at=row["id"])
        expected_prev = bytes(row["content_hash"])

    return ChainResult(is_valid=True, row_count=len(rows))
