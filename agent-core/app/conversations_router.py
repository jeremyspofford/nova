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
