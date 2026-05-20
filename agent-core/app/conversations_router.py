"""Conversation management endpoints — /api/v1/conversations."""
import logging
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, status

from .config import settings
from .db import get_pool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/conversations", tags=["conversations"])


def _require_admin(x_admin_secret: str | None = Header(default=None)) -> None:
    if not x_admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing admin secret")
    if x_admin_secret != settings.admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin secret")


@router.get("")
async def list_conversations(limit: int = 50, _: None = Depends(_require_admin)) -> list:
    """List tasks that have been used as chat conversations, most-recent first."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT t.id,
                   COALESCE(NULLIF(t.goal, ''), '(new conversation)') AS title,
                   t.created_at,
                   MAX(m.created_at) AS last_message_at
            FROM tasks t
            JOIN task_messages m ON m.task_id = t.id
            GROUP BY t.id, t.goal, t.created_at
            ORDER BY MAX(m.created_at) DESC
            LIMIT $1
            """,
            limit,
        )
    return [
        {
            "id": str(r["id"]),
            "title": r["title"],
            "created_at": r["created_at"].isoformat(),
            "last_message_at": r["last_message_at"].isoformat() if r["last_message_at"] else None,
        }
        for r in rows
    ]


@router.delete("/{conv_id}")
async def delete_conversation(conv_id: str, _: None = Depends(_require_admin)) -> dict:
    """Delete a chat conversation and its messages (CASCADE)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        # Only delete tasks that are actual chat conversations (have messages)
        has_messages = await conn.fetchval(
            "SELECT 1 FROM task_messages WHERE task_id = $1::uuid LIMIT 1",
            conv_id,
        )
        if not has_messages:
            raise HTTPException(status_code=404, detail="Conversation not found")
        await conn.execute("DELETE FROM tasks WHERE id = $1::uuid", conv_id)
    return {"deleted": conv_id}


@router.delete("")
async def delete_all_conversations(_: None = Depends(_require_admin)) -> dict:
    """Delete all chat conversations and their messages."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            rows = await conn.fetch("SELECT DISTINCT task_id FROM task_messages")
            if not rows:
                return {"deleted": 0}
            task_ids = [r["task_id"] for r in rows]
            # Clear self-referential parent links and task_events (both NO ACTION — no cascade)
            await conn.execute(
                "UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = ANY($1::uuid[])",
                task_ids,
            )
            await conn.execute(
                "DELETE FROM task_events WHERE task_id = ANY($1::uuid[])",
                task_ids,
            )
            result = await conn.execute(
                "DELETE FROM tasks WHERE id = ANY($1::uuid[])",
                task_ids,
            )
    deleted = int(result.split()[-1]) if result else 0
    return {"deleted": deleted}


@router.post("")
async def create_conversation(_: None = Depends(_require_admin)) -> dict:
    """Pre-create a conversation task so the client has a stable ID before the first message."""
    conv_id = str(uuid.uuid4())
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO tasks (id, prompt, goal, status, created_at) "
            "VALUES ($1, '', '', 'running', now())",
            conv_id,
        )
    return {"id": conv_id}
