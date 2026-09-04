"""The append-only governance ledger: a record of what happened, never a gate.

Nothing in v4 decides whether Nova may act (owner ruling 2026-09-03), so this
table records no decisions — it records FACTS an operator must be able to read
back later: a device enrolled, a device revoked, a replayed device audit chain
that did not join up. Each event is written IN THE SAME TRANSACTION as the
state mutation it records, so the record and the fact it records commit
together or not at all (mirroring traces.close_turn): callers pass their own
transaction's connection to `record_event`, and a failed event write rolls the
mutation back with it. An event that records no mutation (an audit-chain break
changes no row) is written the same way inside a transaction its writer opens
for that one row (devices_ws._audit_break).

Nothing here is on any path a tool call takes: tools.dispatch never reads or
writes this table (tests/test_no_approvals.py pins it), and nothing reads it to
decide anything — it is the audit, not an authority. Tool calls themselves are
recorded in turn_spans, one per call, by the chat loop.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

import asyncpg

# The kinds this service writes. A kind added here is a kind something writes.
# Devices (slice 5): a paired machine's whole arc is readable here — which key
# was bound to which name and on whose pairing code, and the revoke that ended
# it. DEVICE_AUDIT_BREAK is written by devices_ws.ingest_audit when a replayed
# device audit chain does not join up — never a silent reindex, because a chain
# that quietly heals proves nothing afterwards.
DEVICE_ENROLLED = "device.enrolled"
DEVICE_REVOKED = "device.revoked"
DEVICE_AUDIT_BREAK = "device.audit_break"


async def record_event(
    conn: asyncpg.Connection,
    *,
    kind: str,
    actor: str | None = None,
    subject_ref: uuid.UUID | None = None,
    meta: dict[str, Any] | None = None,
) -> None:
    """Append one event on `conn` — the caller's transaction, so the event and
    the mutation it records share a fate. `conn` is a connection already inside
    a transaction; this never opens one of its own."""
    await conn.execute(
        "INSERT INTO governance_events (kind, actor, subject_ref, meta) "
        "VALUES ($1, $2, $3, $4::jsonb)",
        kind,
        actor,
        subject_ref,
        meta or {},
    )


async def recent_events(
    pool: asyncpg.Pool,
    *,
    limit: int = 100,
    before_created_at: datetime | None = None,
    before_id: uuid.UUID | None = None,
) -> list[asyncpg.Record]:
    """Newest-first, for the operator's audit surface and the tests.

    `before_created_at`/`before_id` page strictly older than one event's
    (created_at, id) — the same cursor shape as activity.py's turn ledger and
    for the same reason: created_at alone can collide, so id is the
    tiebreaker, never a substitute (governance_api.py resolves a `before` id
    into this pair, the same way activity.py resolves its own).
    """
    conditions: list[str] = []
    params: list[Any] = []
    if before_created_at is not None and before_id is not None:
        params.append(before_created_at)
        params.append(before_id)
        conditions.append(f"(created_at, id) < (${len(params) - 1}, ${len(params)})")
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    params.append(limit)
    return await pool.fetch(
        f"SELECT id, kind, actor, subject_ref, meta, created_at "
        f"FROM governance_events {where} ORDER BY created_at DESC, id DESC LIMIT ${len(params)}",
        *params,
    )
