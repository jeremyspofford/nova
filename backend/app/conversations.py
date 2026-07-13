"""Conversation management."""

import logging
import uuid
from typing import Optional
from app import db

log = logging.getLogger(__name__)


async def get_or_create_active_conversation() -> dict:
    """Get or create the single active conversation."""
    async with await db.get_connection() as conn:
        # For Phase 1, we maintain one active conversation
        # This can be enhanced later to support multiple concurrent conversations
        result = await conn.fetchrow(
            "SELECT id, title, created_at FROM conversations ORDER BY created_at DESC LIMIT 1"
        )

        if result:
            return {
                "id": str(result["id"]),
                "title": result["title"],
                "created_at": result["created_at"],
            }

        # Create new conversation
        conversation_id = uuid.uuid4()
        await conn.execute(
            "INSERT INTO conversations (id, title) VALUES ($1, $2)",
            conversation_id,
            "Chat Session"
        )
        return {
            "id": str(conversation_id),
            "title": "Chat Session",
            "created_at": None,
        }


async def append_message(conversation_id: str, role: str, content: Optional[str] = None,
                         model_used: Optional[str] = None, tool_calls: Optional[list] = None) -> str:
    """Append a message to the conversation."""
    async with await db.get_connection() as conn:
        message_id = uuid.uuid4()
        await conn.execute(
            """INSERT INTO messages (id, conversation_id, role, content, model_used, tool_calls)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            message_id,
            uuid.UUID(conversation_id),
            role,
            content,
            model_used,
            tool_calls,
        )
        # Update conversation's last_message_at
        await conn.execute(
            "UPDATE conversations SET updated_at = now(), last_message_at = now() WHERE id = $1",
            uuid.UUID(conversation_id)
        )
        return str(message_id)


async def load_history(conversation_id: str, limit: int = 40) -> list:
    """Load recent message history for a conversation."""
    async with await db.get_connection() as conn:
        rows = await conn.fetch(
            """SELECT id, role, content, model_used, tool_calls, created_at
               FROM messages
               WHERE conversation_id = $1
               ORDER BY created_at ASC
               LIMIT $2""",
            uuid.UUID(conversation_id),
            limit,
        )
        return [{
            "id": str(row["id"]),
            "role": row["role"],
            "content": row["content"],
            "model_used": row["model_used"],
            "tool_calls": row["tool_calls"],
            "created_at": str(row["created_at"]) if row["created_at"] else None,
        } for row in rows]


async def get_conversation_summary(conversation_id: str) -> Optional[dict]:
    """Get conversation metadata."""
    async with await db.get_connection() as conn:
        result = await conn.fetchrow(
            "SELECT id, title, created_at, updated_at, last_message_at FROM conversations WHERE id = $1",
            uuid.UUID(conversation_id),
        )
        if result:
            return {
                "id": str(result["id"]),
                "title": result["title"],
                "created_at": str(result["created_at"]) if result["created_at"] else None,
                "updated_at": str(result["updated_at"]) if result["updated_at"] else None,
                "last_message_at": str(result["last_message_at"]) if result["last_message_at"] else None,
            }
        return None
