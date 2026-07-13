"""Conversation persistence — one continuous session."""

import json
import logging
import uuid
from typing import Optional

from app import db

log = logging.getLogger(__name__)


async def get_or_create_active_conversation() -> dict:
    """The single continuous conversation (newest row wins; created on first use)."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, title, created_at FROM conversations "
            "ORDER BY created_at DESC LIMIT 1")
        if row:
            return {"id": str(row["id"]), "title": row["title"],
                    "created_at": str(row["created_at"])}
        conversation_id = uuid.uuid4()
        await conn.execute(
            "INSERT INTO conversations (id, title) VALUES ($1, $2)",
            conversation_id, "Nova")
        return {"id": str(conversation_id), "title": "Nova", "created_at": None}


async def append_message(conversation_id: str, role: str, content: Optional[str] = None,
                         model_used: Optional[str] = None,
                         tool_calls: Optional[list | dict] = None) -> str:
    message_id = uuid.uuid4()
    async with db.acquire() as conn:
        await conn.execute(
            """INSERT INTO messages (id, conversation_id, role, content, model_used, tool_calls)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            message_id, uuid.UUID(conversation_id), role, content, model_used,
            json.dumps(tool_calls) if tool_calls is not None else None)
        await conn.execute(
            "UPDATE conversations SET updated_at = now(), last_message_at = now() "
            "WHERE id = $1", uuid.UUID(conversation_id))
    return str(message_id)


async def load_history(conversation_id: str, limit: int = 50) -> list[dict]:
    """The most recent `limit` messages, in chronological order."""
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, role, content, model_used, tool_calls, created_at FROM (
                   SELECT * FROM messages
                   WHERE conversation_id = $1
                   ORDER BY created_at DESC
                   LIMIT $2
               ) recent ORDER BY created_at ASC""",
            uuid.UUID(conversation_id), limit)
    return [{
        "id": str(r["id"]),
        "role": r["role"],
        "content": r["content"],
        "model_used": r["model_used"],
        "tool_calls": r["tool_calls"],
        "created_at": str(r["created_at"]) if r["created_at"] else None,
    } for r in rows]


def to_llm_history(history: list[dict]) -> list[dict]:
    """Text-only user/assistant turns for the LLM (tool rows are audit records)."""
    return [{"role": m["role"], "content": m["content"]}
            for m in history
            if m["role"] in ("user", "assistant") and m["content"]]
