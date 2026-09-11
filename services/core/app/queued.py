"""Messages the owner sent while a turn was running (S15).

One conversation answers one question at a time. A message that arrives while a
turn is in flight is not refused and not run concurrently — it is ACCEPTED as a
row here and run by itself the moment the turn ends.

Everything in this module is about one property: a 202 is a promise, and a
promise nothing keeps is the worst kind of success to report. So:

- the decision to queue is taken under a per-conversation advisory lock, not
  from a read that seven round trips later is stale (`hold_conversation`);
- a row stops being `waiting` only by being claimed for a turn, or by being
  cancelled with a STATED REASON the owner can read (the table's own CHECK
  enforces the reason);
- a row a dead process left waiting is found at startup and cancelled out loud,
  because nothing will ever end in a fresh process to trigger its drain
  (`sweep_stranded`).

The drain itself lives in `chat.py`, because starting a turn is chat's one job
and there must not be a second path that does it.
"""

from __future__ import annotations

import logging
import uuid

import asyncpg

logger = logging.getLogger("core")

# The columns every caller reads a queued row back through, so the API shape and
# the drain cannot drift apart.
_FIELDS = "id, seq, conversation_id, person_id, body, created_at, claimed_at, turn_id"


def _lock_key(conversation_id: uuid.UUID) -> int:
    """A stable 64-bit advisory-lock key for one conversation.

    Derived from the id itself rather than stored anywhere: the lock must mean
    the same thing in every process and after every restart, and a table of
    lock numbers is a thing that can fall out of step with the conversations it
    is supposed to be about.
    """
    return int.from_bytes(conversation_id.bytes[:8], "big", signed=True)


async def hold_conversation(conn: asyncpg.Connection, conversation_id: uuid.UUID) -> None:
    """Take this conversation's lock for the caller's transaction.

    Held until the transaction ends, so whatever the caller decides about
    "is a turn already running?" is still true when it acts on it. Without this
    the check is advisory: the stream route does seven round trips between
    reading the answer and registering the turn, which is all the room two
    near-simultaneous sends (a double tap, a phone and a laptop) need to both
    read "not busy" and both start.

    It must never be held across a model turn — `019_timers.sql` states that
    rule for the same reason: the pool has ten connections and a turn can take
    twenty minutes. Take it, decide, commit.
    """
    await conn.execute("SELECT pg_advisory_xact_lock($1)", _lock_key(conversation_id))


async def enqueue(
    conn: asyncpg.Connection,
    conversation_id: uuid.UUID,
    person_id: uuid.UUID,
    body: str,
) -> asyncpg.Record:
    """Accept a message for later. The caller must already hold the lock."""
    return await conn.fetchrow(
        f"INSERT INTO queued_messages (conversation_id, person_id, body) "
        f"VALUES ($1, $2, $3) RETURNING {_FIELDS}",
        conversation_id,
        person_id,
        body,
    )


async def waiting(pool: asyncpg.Pool, conversation_id: uuid.UUID) -> list[asyncpg.Record]:
    """This conversation's accepted-but-unanswered messages, oldest first."""
    return await pool.fetch(
        f"SELECT {_FIELDS} FROM queued_messages WHERE conversation_id = $1 "
        f"AND claimed_at IS NULL AND cancelled_at IS NULL ORDER BY seq",
        conversation_id,
    )


async def any_waiting(pool: asyncpg.Pool, conversation_id: uuid.UUID) -> bool:
    """Is an answer still owed to this conversation from the queue?

    Read by `conversations.has_pending_turn`, which is what a reloaded tab polls
    on. If it went false between a turn closing and the drain opening the next
    one, that tab would stop polling and the queued reply would never appear.
    """
    return bool(
        await pool.fetchval(
            "SELECT 1 FROM queued_messages WHERE conversation_id = $1 "
            "AND claimed_at IS NULL AND cancelled_at IS NULL LIMIT 1",
            conversation_id,
        )
    )


async def claim_next(conn: asyncpg.Connection, conversation_id: uuid.UUID) -> asyncpg.Record | None:
    """The oldest waiting message for this conversation, claimed for a turn.

    `FOR UPDATE SKIP LOCKED` and the re-checked predicates together are what
    make two drains racing the same row harmless — `_run_turn`'s finally runs
    for every kind of turn, so a chat turn and a scheduled firing ending
    together both try. One claims, the other sees nothing.

    `turn_id` is filled by `mark_claimed` in the SAME transaction, which the
    table's CHECK requires: a claim that names no turn would read as sent.
    """
    return await conn.fetchrow(
        f"SELECT {_FIELDS} FROM queued_messages WHERE id = ("
        "  SELECT id FROM queued_messages"
        "  WHERE conversation_id = $1 AND claimed_at IS NULL AND cancelled_at IS NULL"
        "  ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED"
        ") AND claimed_at IS NULL AND cancelled_at IS NULL",
        conversation_id,
    )


async def mark_claimed(conn: asyncpg.Connection, queued_id: uuid.UUID, turn_id: uuid.UUID) -> None:
    """Record which turn ran this message. Same transaction as the turn's row."""
    await conn.execute(
        "UPDATE queued_messages SET claimed_at = now(), turn_id = $2 WHERE id = $1",
        queued_id,
        turn_id,
    )


async def cancel(
    pool: asyncpg.Pool, queued_id: uuid.UUID, person_id: uuid.UUID, reason: str
) -> asyncpg.Record | None:
    """Take back a message that has not run yet.

    Returns the row it actually changed, or None — so the caller reports what
    happened rather than assuming. A message the drain claimed a moment ago
    changes nothing here, and answering 200 over that would tell the owner his
    message was withdrawn when it is already being answered.
    """
    return await pool.fetchrow(
        f"UPDATE queued_messages SET cancelled_at = now(), cancelled_reason = $3 "
        f"WHERE id = $1 AND person_id = $2 AND claimed_at IS NULL AND cancelled_at IS NULL "
        f"RETURNING {_FIELDS}, cancelled_reason",
        queued_id,
        person_id,
        reason,
    )


async def owned(
    pool: asyncpg.Pool, queued_id: uuid.UUID, person_id: uuid.UUID
) -> asyncpg.Record | None:
    """The row, if it is this person's — so someone else's is NOT FOUND rather
    than forbidden, the answer `conversations.owned_conversation` gives."""
    return await pool.fetchrow(
        f"SELECT {_FIELDS}, cancelled_at, cancelled_reason FROM queued_messages "
        f"WHERE id = $1 AND person_id = $2",
        queued_id,
        person_id,
    )


RESTART_REASON = (
    "core restarted before this was sent, so it was never run — send it again if you still want it"
)


async def sweep_stranded(pool: asyncpg.Pool) -> int:
    """Cancel, out loud, every message a dead process left waiting.

    A fresh process runs no turns, so nothing will ever END to trigger a drain:
    a row left waiting here would sit accepted and unanswered for ever, which is
    a 202 that lied. It is not silently SENT either — the box may have been down
    for days and the message may be long stale, and running it unasked would be
    the same defect from the other side. So it is cancelled with a reason the
    owner can read, and counted in the log.

    Returns how many it cancelled; logs only when that is not zero, so a normal
    start is silent and an abnormal one is not.
    """
    rows = await pool.fetch(
        "UPDATE queued_messages SET cancelled_at = now(), cancelled_reason = $1 "
        "WHERE claimed_at IS NULL AND cancelled_at IS NULL "
        "RETURNING id, conversation_id, body",
        RESTART_REASON,
    )
    for row in rows:
        logger.warning(
            "queued message %s for conversation %s was never sent (%r) — cancelled: %s",
            row["id"],
            row["conversation_id"],
            row["body"][:80],
            RESTART_REASON,
        )
    return len(rows)


def as_json(row: asyncpg.Record, *, ahead: int | None = None) -> dict:
    """One queued row as the API states it.

    `ahead` is how many accepted messages run BEFORE this one — 0 for the next
    one up. Named for what it counts rather than "position", which reads as both
    0-based and 1-based to different people and would make "position 1" mean two
    different things in the UI and the tests.
    """
    body = {
        "id": str(row["id"]),
        "conversation_id": str(row["conversation_id"]),
        "body": row["body"],
        "created_at": row["created_at"].isoformat(),
    }
    if ahead is not None:
        body["ahead"] = ahead
    return body


async def enqueue_for_test(
    pool: asyncpg.Pool, conversation_id: uuid.UUID, person_id: uuid.UUID, body: str
) -> uuid.UUID:
    """A waiting row, without a turn in flight to create one — for the tests
    that exercise the sweep and the shutdown guard directly."""
    async with pool.acquire() as conn, conn.transaction():
        row = await enqueue(conn, conversation_id, person_id, body)
    return row["id"]
