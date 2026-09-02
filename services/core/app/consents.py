"""Consents: a single-use, args-bound, requestor-bound grant, burned mechanically.

This module holds the three things the policy kernel and (in T2) the operator
API do with a consent, and nothing decides one by reading prose:

  * raise_consent  — the funnel raises (or reuses) a pending card for an exact
                     action; atomic with a governance consent.raised event.
  * validate_and_use — the BURN (ruling S3-R3): one SQL UPDATE whose WHERE
                     clause IS the check — status approved, never used, not
                     expired, args_hash matches, requestor matches — claimed
                     with FOR UPDATE SKIP LOCKED so two concurrent burns can
                     never double-spend one approval. Atomic with a governance
                     consent.burned event: a failed event write rolls the burn
                     back and the approval survives, retryable.
  * decide         — the operator approves or denies; it ONLY flips status
                     (ruling S3-R4: approving runs nothing — the funnel is the
                     only executor and re-checks next turn).

Binding is MANDATORY. v3's D-029 fallbacks (id-only, agent-optional) are not
carried: an approval for one URL cannot be spent on another, nor by another
requestor.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

import asyncpg

from app import autonomy, governance

# How long an approval stays burnable, from when the card was raised. Generous
# because the operator decides on their own time and the model re-attempts in a
# later turn — but bounded, and checked in the burn's WHERE clause, never in
# code the model can talk around.
CONSENT_TTL_SECONDS = 24 * 60 * 60


def args_hash(args: dict[str, Any]) -> str:
    """A stable hash of the exact arguments, so a consent binds to THEM. Keys
    are sorted and separators fixed, so {"a":1,"b":2} and {"b":2,"a":1} — the
    same call — hash identically, and any change to any value does not."""
    canonical = json.dumps(args, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# The burn. One statement: the inner SELECT claims exactly one matching,
# unspent, unexpired, args- and requestor-bound approval with FOR UPDATE SKIP
# LOCKED (so a concurrent burn takes a different row or none), and the UPDATE
# spends it. No row out means no valid consent — nothing is spent.
_BURN_SQL = """
UPDATE consents SET used_at = now()
WHERE id = (
    SELECT id FROM consents
    WHERE action_class = $1
      AND args_hash = $2
      AND requestor_person = $3
      AND requestor_agent = $4
      AND status = 'approved'
      AND used_at IS NULL
      AND expires_at > now()
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
RETURNING id
"""

_FIND_PENDING_SQL = """
SELECT * FROM consents
WHERE action_class = $1
  AND args_hash = $2
  AND requestor_person = $3
  AND requestor_agent = $4
  AND conversation_id IS NOT DISTINCT FROM $5
  AND status = 'pending'
  AND expires_at > now()
ORDER BY created_at DESC
LIMIT 1
"""

_INSERT_SQL = """
INSERT INTO consents
    (action_class, args_hash, requestor_person, requestor_agent,
     conversation_id, args, summary, expires_at)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now() + make_interval(secs => $8))
RETURNING *
"""

_DECIDE_SQL = """
UPDATE consents SET status = $2, decided_at = now(), decided_by = $3
WHERE id = $1 AND status = 'pending'
RETURNING *
"""


def card_spec(row: asyncpg.Record | dict) -> dict:
    """The shape the funnel hands its caller and the T2 UI renders. Built from
    a consent row alone, so the inline card and the Approvals page (which
    re-queries) show the same thing."""
    conversation_id = row["conversation_id"]
    return {
        "consent_id": str(row["id"]),
        "action_class": row["action_class"],
        "args_hash": row["args_hash"],
        "args": row["args"],
        "summary": row["summary"],
        "status": row["status"],
        "conversation_id": str(conversation_id) if conversation_id else None,
        "requested_by": {
            "person_id": str(row["requestor_person"]),
            "agent": row["requestor_agent"],
        },
        "created_at": row["created_at"].isoformat(),
        "expires_at": row["expires_at"].isoformat(),
    }


async def raise_consent(
    pool: asyncpg.Pool,
    *,
    action_class: str,
    args: dict[str, Any],
    summary: str,
    person_id: uuid.UUID,
    agent: str,
    conversation_id: uuid.UUID | None,
) -> dict:
    """Raise a pending card for this exact action, or reuse the one already
    waiting — the model asking twice must not stack two cards. Atomic with a
    governance consent.raised event."""
    hashed = args_hash(args)
    async with pool.acquire() as conn, conn.transaction():
        existing = await conn.fetchrow(
            _FIND_PENDING_SQL, action_class, hashed, person_id, agent, conversation_id
        )
        if existing is not None:
            return card_spec(existing)
        row = await conn.fetchrow(
            _INSERT_SQL,
            action_class,
            hashed,
            person_id,
            agent,
            conversation_id,
            args,
            summary,
            CONSENT_TTL_SECONDS,
        )
        await governance.record_event(
            conn,
            kind=governance.CONSENT_RAISED,
            action_class=action_class,
            actor=str(person_id),
            subject_ref=row["id"],
            meta={"agent": agent, "args_hash": hashed, "summary": summary},
        )
        return card_spec(row)


async def validate_and_use(
    pool: asyncpg.Pool,
    *,
    action_class: str,
    args_hash: str,
    person_id: uuid.UUID,
    agent: str,
) -> bool:
    """Burn one matching approval and record it, in ONE transaction. True only
    when a row was actually spent. The governance write shares the transaction:
    if it fails, the burn rolls back and the approval is still there to retry.

    Never LLM-judged — the WHERE clause in _BURN_SQL is the entire decision."""
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(_BURN_SQL, action_class, args_hash, person_id, agent)
        if row is None:
            return False
        await governance.record_event(
            conn,
            kind=governance.CONSENT_BURNED,
            action_class=action_class,
            actor=str(person_id),
            subject_ref=row["id"],
            meta={"agent": agent, "args_hash": args_hash},
        )
        return True


async def decide(
    pool: asyncpg.Pool,
    *,
    consent_id: uuid.UUID,
    approve: bool,
    decided_by: uuid.UUID,
) -> dict | None:
    """Approve or deny a pending card. Flips status and records the decision —
    and NOTHING else (ruling S3-R4): the action is re-attempted by the model
    and burned at the funnel next turn, so there is no execute-at-approval path.
    Returns the updated card, or None if the card was missing or already
    decided (so a double-decide is a safe no-op, not a second event)."""
    status = "approved" if approve else "denied"
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(_DECIDE_SQL, consent_id, status, decided_by)
        if row is None:
            return None
        await governance.record_event(
            conn,
            kind=governance.CONSENT_DECIDED,
            action_class=row["action_class"],
            actor=str(decided_by),
            subject_ref=consent_id,
            meta={"decision": status},
        )
        if not approve:
            # A deny breaks this class's graduation streak, in THIS transaction
            # so the deny, its event and the reset commit or roll back together.
            # Only denied — an approve is a step toward graduation, not a
            # distrust signal, so it must not reset. This zeroes the counter
            # only; it never demotes (disposition/earned are the failure/revoke
            # path's business). A double-decide returned None above, so this is
            # never reached for a no-op decision — no second reset.
            await autonomy.reset_streak_on_deny(conn, row["action_class"])
        return card_spec(row)


async def get(pool: asyncpg.Pool, consent_id: uuid.UUID) -> asyncpg.Record | None:
    return await pool.fetchrow("SELECT * FROM consents WHERE id = $1", consent_id)


async def get_for_continuation(
    pool: asyncpg.Pool,
    consent_id: uuid.UUID,
    *,
    conversation_id: uuid.UUID,
    person_id: uuid.UUID,
) -> asyncpg.Record | None:
    """The ONE consent a continuation may legitimately claim to be resuming.

    chat.py marks a user message 'plumbing' when it cites the consent it
    resumes, and a plumbing row is dropped from every later history window — so
    citing an id is a request to REMOVE a message from what the model will ever
    read again. Existence is not remotely enough authority for that: every
    authenticated caller can list ids (GET /api/v1/consents), so a bare
    `get()` would let anyone cite a denied card, another conversation's card, or
    another person's card and quietly hide any message they liked.

    So the WHERE clause is the whole check, the way the burn's is
    (validate_and_use): the card must be THIS conversation's, THIS person's,
    and APPROVED — the only state a continuation can honestly resume. Anything
    else returns None and the message stays ordinary chat. Scoped mechanically,
    never by trusting the id the client sent.
    """
    return await pool.fetchrow(
        "SELECT * FROM consents WHERE id = $1 AND conversation_id = $2 "
        "AND requestor_person = $3 AND status = 'approved'",
        consent_id,
        conversation_id,
        person_id,
    )


async def pending_for_conversation(
    pool: asyncpg.Pool, conversation_id: uuid.UUID
) -> list[dict]:
    """The cards still awaiting a decision in one conversation — the inline
    card's re-query and the source for T2's per-conversation view."""
    rows = await pool.fetch(
        "SELECT * FROM consents WHERE conversation_id = $1 AND status = 'pending' "
        "AND expires_at > now() ORDER BY created_at DESC",
        conversation_id,
    )
    return [card_spec(row) for row in rows]


async def pending_all(pool: asyncpg.Pool) -> list[dict]:
    """Every card still awaiting a decision, across every conversation —
    T2's Approvals page (services/core/app/consents_api.py's GET route with
    no conversation_id filter). Same predicate as pending_for_conversation
    (status='pending', unexpired), just not scoped to one conversation."""
    rows = await pool.fetch(
        "SELECT * FROM consents WHERE status = 'pending' AND expires_at > now() "
        "ORDER BY created_at DESC"
    )
    return [card_spec(row) for row in rows]
