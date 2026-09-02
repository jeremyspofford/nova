"""The append-only governance ledger: every authorization decision, recorded.

A decision that only reads (an auto-allow) leaves nothing here — the ledger is
for the decisions an operator must be able to audit: a consent raised, decided
or burned, every policy denial, and every earned-autonomy promotion, demotion
or revoke (T3's app/autonomy.py). Each event is written IN THE SAME
TRANSACTION as the state mutation it records, so the record and the fact it
records commit together or not at all (mirroring traces.close_turn): callers
pass their own transaction's connection to `record_event`, and a failed event
write rolls the mutation back with it.

Nothing here is on a decision path. policy.authorize never reads this table —
it is the audit, not an authority.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

import asyncpg

# The kinds this service writes. A kind added here is a kind something writes.
CONSENT_RAISED = "consent.raised"
CONSENT_DECIDED = "consent.decided"
CONSENT_BURNED = "consent.burned"
POLICY_DENIED = "policy.denied"
AUTONOMY_PROMOTED = "autonomy.promoted"
AUTONOMY_DEMOTED = "autonomy.demoted"
AUTONOMY_REVOKED = "autonomy.revoked"
# The owner set a class's disposition by hand (autonomy.set_disposition):
# meta {"before", "after", "action_class"}, actor = the person. Distinct from
# promoted/demoted/revoked so the ledger reads "the owner decided", never "the
# streak decided".
AUTONOMY_DISPOSITION_SET = "autonomy.disposition_set"
# Devices (slice 5). A paired machine's whole arc is readable here: which key
# was bound to which name and on whose pairing code, every time its grants
# moved and to what, and the revoke that ended it. DEVICE_AUDIT_BREAK is
# written by T2 when a replayed device audit chain does not join up — never a
# silent reindex, because a chain that quietly heals proves nothing afterwards.
DEVICE_ENROLLED = "device.enrolled"
DEVICE_GRANTS_CHANGED = "device.grants_changed"
DEVICE_REVOKED = "device.revoked"
DEVICE_AUDIT_BREAK = "device.audit_break"


async def record_event(
    conn: asyncpg.Connection,
    *,
    kind: str,
    action_class: str | None = None,
    actor: str | None = None,
    subject_ref: uuid.UUID | None = None,
    meta: dict[str, Any] | None = None,
) -> None:
    """Append one event on `conn` — the caller's transaction, so the event and
    the mutation it records share a fate. `conn` is a connection already inside
    a transaction; this never opens one of its own."""
    await conn.execute(
        "INSERT INTO governance_events (kind, action_class, actor, subject_ref, meta) "
        "VALUES ($1, $2, $3, $4, $5::jsonb)",
        kind,
        action_class,
        actor,
        subject_ref,
        meta or {},
    )


async def append(
    pool: asyncpg.Pool,
    *,
    kind: str,
    action_class: str | None = None,
    actor: str | None = None,
    subject_ref: uuid.UUID | None = None,
    meta: dict[str, Any] | None = None,
) -> None:
    """Append a standalone event that records no accompanying state mutation —
    a policy denial refuses without changing anything, so its only record is
    the event itself. Opens its own transaction so the append is durable."""
    async with pool.acquire() as conn, conn.transaction():
        await record_event(
            conn,
            kind=kind,
            action_class=action_class,
            actor=actor,
            subject_ref=subject_ref,
            meta=meta,
        )


async def recent_events(
    pool: asyncpg.Pool,
    *,
    limit: int = 100,
    before_created_at: datetime | None = None,
    before_id: uuid.UUID | None = None,
    action_class: str | None = None,
) -> list[asyncpg.Record]:
    """Newest-first, for the operator's audit surface (T3) and the tests.

    `before_created_at`/`before_id` page strictly older than one event's
    (created_at, id) — the same cursor shape as activity.py's turn ledger and
    for the same reason: created_at alone can collide, so id is the
    tiebreaker, never a substitute (governance_api.py resolves a `before` id
    into this pair, the same way activity.py resolves its own). `action_class`
    narrows to one class's history (Settings -> Autonomy's per-class recent
    decisions); omitted, every class is included.
    """
    conditions: list[str] = []
    params: list[Any] = []
    if action_class is not None:
        params.append(action_class)
        conditions.append(f"action_class = ${len(params)}")
    if before_created_at is not None and before_id is not None:
        params.append(before_created_at)
        params.append(before_id)
        conditions.append(f"(created_at, id) < (${len(params) - 1}, ${len(params)})")
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    params.append(limit)
    return await pool.fetch(
        f"SELECT id, kind, action_class, actor, subject_ref, meta, created_at "
        f"FROM governance_events {where} ORDER BY created_at DESC, id DESC LIMIT ${len(params)}",
        *params,
    )
