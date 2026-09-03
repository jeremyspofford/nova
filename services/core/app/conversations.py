"""Conversations and their messages — scoped to the person who owns them."""
from __future__ import annotations

import logging
import uuid

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

from app import db, identity, traces
from app.identity import Person

router = APIRouter(prefix="/api/v1/conversations", tags=["conversations"])
logger = logging.getLogger("core")


def as_json(row: asyncpg.Record) -> dict:
    return {
        "id": str(row["id"]),
        "title": row["title"],
        "created_at": row["created_at"].isoformat(),
    }


async def has_pending_turn(pool: asyncpg.Pool, conversation_id: uuid.UUID) -> bool:
    """Is a turn for this conversation running in THIS process right now?

    Derived from two live facts, never a flag someone maintains: the ledger
    (a turn opens with status NULL and closes in traces.close_turn) AND the
    process's own traces.INFLIGHT set. A NULL row alone is not enough — a
    process killed mid-turn never runs close_turn, and the row it leaves
    behind would otherwise read as "still responding" forever (the 2026-09-01
    defect: one such row, one day of a spinner over nothing). Since S2c a
    client disconnect finishes the turn server-side rather than abandoning
    it, so a NULL row that IS in INFLIGHT means genuinely still-generating —
    exactly what a reloaded client polls on before rendering the reply.

    A NULL row NOT in INFLIGHT is never reported pending. It should not exist
    at all — the startup sweep (traces.sweep_orphaned_turns) closes every
    orphan before the first request — so one here is a tripwire: logged at
    WARNING, because it means the sweep was bypassed, not that a turn is
    running.
    """
    rows = await pool.fetch(
        "SELECT id, started_at FROM turns WHERE conversation_id = $1 AND status IS NULL",
        conversation_id,
    )
    pending = False
    for row in rows:
        if row["id"] in traces.INFLIGHT:
            pending = True
            continue
        logger.warning(
            "turn %s (conversation %s, started %s) has status NULL but no process is running "
            "it — not reported pending; either its close failed in this process "
            "(see 'could not close turn') or the startup sweep was bypassed",
            row["id"],
            conversation_id,
            row["started_at"].isoformat(),
        )
    return pending


async def active_conversation(pool: asyncpg.Pool, person: Person) -> asyncpg.Record:
    """The person's active conversation, created on first ask."""
    row = await pool.fetchrow(
        "SELECT id, title, created_at FROM conversations "
        "WHERE person_id = $1 AND active ORDER BY created_at DESC LIMIT 1",
        person.id,
    )
    if row is not None:
        return row
    return await pool.fetchrow(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id, title, created_at",
        person.id,
    )


async def owned_conversation(
    pool: asyncpg.Pool, person: Person, conversation_id: uuid.UUID
) -> asyncpg.Record:
    """That conversation, or a 404 — someone else's is not found, not forbidden."""
    row = await pool.fetchrow(
        "SELECT id, title, created_at FROM conversations WHERE id = $1 AND person_id = $2",
        conversation_id,
        person.id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail=f"no conversation {conversation_id} here")
    return row


async def resolve(
    pool: asyncpg.Pool, person: Person, conversation_id: uuid.UUID | None
) -> asyncpg.Record:
    """A named conversation must be the requester's; otherwise the active one."""
    if conversation_id is not None:
        return await owned_conversation(pool, person, conversation_id)
    return await active_conversation(pool, person)


@router.get("/active")
async def get_active(person: Person = Depends(identity.require_person)) -> dict:
    pool = await db.get_pool()
    conversation = await active_conversation(pool, person)
    return {
        **as_json(conversation),
        # So a client returning after a hard refresh knows a turn is still
        # finishing server-side and should poll for it, rather than showing a
        # truncated reply (S2c). A just-created conversation has none.
        "pending_turn": await has_pending_turn(pool, conversation["id"]),
    }


@router.get("/{conversation_id}/messages")
async def get_messages(
    conversation_id: uuid.UUID, person: Person = Depends(identity.require_person)
) -> dict:
    pool = await db.get_pool()
    await owned_conversation(pool, person, conversation_id)
    rows = await pool.fetch(
        "SELECT id, role, content, created_at FROM messages "
        "WHERE conversation_id = $1 ORDER BY created_at, id",
        conversation_id,
    )
    return {
        "messages": [
            {
                "id": str(row["id"]),
                "role": row["role"],
                "content": row["content"],
                "created_at": row["created_at"].isoformat(),
            }
            for row in rows
        ]
    }


async def clear_messages(pool: asyncpg.Pool, conversation_id: uuid.UUID) -> int:
    """Delete this conversation's transcript rows, and ONLY those.

    "Clear chat" clears the transcript the operator sees and the model's
    history_window source (chat.py reads `messages` for the next turn's
    context) — nothing else. turns/turn_spans and the governance ledger are the
    AUDIT trail and stay untouched (Activity keeps its history; the conversation
    row itself survives, so turns' conversation_id is not even nulled). Durable
    memory lives in a separate service and is not reached from here. Returns the
    number of rows removed, parsed from the command tag, so the caller reports a
    real count rather than an unchecked "ok"."""
    tag = await pool.execute("DELETE FROM messages WHERE conversation_id = $1", conversation_id)
    # asyncpg returns a command tag like "DELETE 3"; the trailing field is the
    # row count. A malformed tag is a real failure, not a silent zero.
    return int(tag.rsplit(" ", 1)[1])


@router.post("/{conversation_id}/clear")
async def clear_conversation(
    conversation_id: uuid.UUID, person: Person = Depends(identity.require_person)
) -> dict:
    """Clear the CURRENT conversation's messages. require_person + ownership:
    someone else's conversation is a 404 (owned_conversation), never touched.
    Deletes rows in `messages` only — see clear_messages on what is deliberately
    left intact (audit + memory)."""
    pool = await db.get_pool()
    await owned_conversation(pool, person, conversation_id)
    cleared = await clear_messages(pool, conversation_id)
    return {"id": str(conversation_id), "cleared": cleared}
