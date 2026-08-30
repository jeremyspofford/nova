"""The append-only governance ledger: every authorization decision, recorded.

A decision that only reads (an auto-allow) leaves nothing here — the ledger is
for the decisions an operator must be able to audit: a consent raised, decided
or burned, and every policy denial. Each event is written IN THE SAME
TRANSACTION as the state mutation it records, so the record and the fact it
records commit together or not at all (mirroring traces.close_turn): callers
pass their own transaction's connection to `record_event`, and a failed event
write rolls the mutation back with it.

Nothing here is on a decision path. policy.authorize never reads this table —
it is the audit, not an authority.
"""
from __future__ import annotations

import uuid
from typing import Any

import asyncpg

# The kinds S3 writes. Autonomy promotions/demotions/revokes are T3 and are
# deliberately not listed yet — a kind added here is a kind something writes.
CONSENT_RAISED = "consent.raised"
CONSENT_DECIDED = "consent.decided"
CONSENT_BURNED = "consent.burned"
POLICY_DENIED = "policy.denied"


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


async def recent_events(pool: asyncpg.Pool, *, limit: int = 100) -> list[asyncpg.Record]:
    """Newest-first, for the operator's audit surface (T3) and the tests."""
    return await pool.fetch(
        "SELECT id, kind, action_class, actor, subject_ref, meta, created_at "
        "FROM governance_events ORDER BY created_at DESC, id DESC LIMIT $1",
        limit,
    )
