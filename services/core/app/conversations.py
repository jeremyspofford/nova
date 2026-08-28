"""Conversations and their messages — scoped to the person who owns them."""
from __future__ import annotations

import uuid

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

from app import db, identity
from app.identity import Person

router = APIRouter(prefix="/api/v1/conversations", tags=["conversations"])


def as_json(row: asyncpg.Record) -> dict:
    return {
        "id": str(row["id"]),
        "title": row["title"],
        "created_at": row["created_at"].isoformat(),
    }


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
    return as_json(await active_conversation(await db.get_pool(), person))


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
