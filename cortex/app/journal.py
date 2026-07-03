"""Cortex journal — narrates thinking to a reserved conversation."""
from __future__ import annotations

import json
import logging
from datetime import datetime
from uuid import UUID

import redis.asyncio as aioredis

from .config import settings
from .db import get_pool

log = logging.getLogger(__name__)

JOURNAL_ID = UUID(settings.journal_conversation_id)
CORTEX_USER_ID = UUID(settings.cortex_user_id)

_notify_redis: aioredis.Redis | None = None


async def _get_notify_redis() -> aioredis.Redis:
    """Get or create the Redis connection used for notification publishes."""
    global _notify_redis
    if _notify_redis is None:
        _notify_redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _notify_redis


async def close_notify_redis() -> None:
    """Close the notification Redis connection. Call at shutdown."""
    global _notify_redis
    if _notify_redis is not None:
        await _notify_redis.aclose()
        _notify_redis = None


_journal_ensured = False


async def _ensure_journal_conversation(conn) -> None:
    """Idempotently create the Cortex journal conversation.

    Migration 021 seeds it once, but a data wipe clears conversations
    (and cascades from its owner user) without re-running migrations —
    leaving every journal write to fail the conversation FK. Owned by the
    synthetic-admin user (seeded by the orchestrator on boot), tenant
    Default.
    """
    global _journal_ensured
    if _journal_ensured:
        return
    await conn.execute(
        """
        INSERT INTO conversations (id, title, user_id, tenant_id)
        VALUES ($1, 'Cortex Journal',
                '00000000-0000-0000-0000-000000000000',
                '00000000-0000-0000-0000-000000000001')
        ON CONFLICT (id) DO NOTHING
        """,
        JOURNAL_ID,
    )
    _journal_ensured = True


async def write_entry(
    content: str,
    entry_type: str = "narration",
    metadata: dict | None = None,
) -> UUID:
    """Write a journal entry to the Cortex conversation.

    entry_type: narration | progress | completion | question | escalation | reflection
    """
    meta = {
        "type": entry_type,
        "source": "cortex",
        **(metadata or {}),
    }
    pool = get_pool()
    async with pool.acquire() as conn:
        await _ensure_journal_conversation(conn)
        row = await conn.fetchrow(
            """
            INSERT INTO messages (conversation_id, role, content, metadata)
            VALUES ($1, 'assistant', $2, $3::jsonb)
            RETURNING id
            """,
            JOURNAL_ID,
            content,
            meta,
        )
        await conn.execute(
            "UPDATE conversations SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1",
            JOURNAL_ID,
        )
    msg_id = row["id"]
    log.debug("Journal entry [%s]: %s", entry_type, content[:80])
    return msg_id


async def read_recent(limit: int = 20) -> list[dict]:
    """Read recent journal entries, newest first."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, role, content, metadata, created_at
            FROM messages
            WHERE conversation_id = $1
            ORDER BY created_at DESC
            LIMIT $2
            """,
            JOURNAL_ID,
            limit,
        )
    return [
        {
            "id": str(r["id"]),
            "role": r["role"],
            "content": r["content"],
            "metadata": r["metadata"],
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]


async def read_user_replies_since(since: datetime) -> list[dict]:
    """Read user replies to the journal since a given time.

    These are messages from the human directing Cortex behavior.
    """
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, content, metadata, created_at
            FROM messages
            WHERE conversation_id = $1 AND role = 'user' AND created_at > $2
            ORDER BY created_at
            """,
            JOURNAL_ID,
            since,
        )
    return [
        {
            "id": str(r["id"]),
            "content": r["content"],
            "metadata": r["metadata"],
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]


async def emit_journal(
    goal_id: str | None,
    event: str,
    payload: dict | None = None,
) -> None:
    """Structured journal entry for goal-lifecycle events.

    Wraps write_entry so journal queries can filter by event/goal_id.
    Body shape: 'event=<event> goal=<id> payload=<json>'
    Metadata: {event, goal_id, payload}
    """
    content = f"event={event} goal={goal_id or '-'}"
    if payload:
        content += f" payload={json.dumps(payload, default=str)}"
    metadata: dict = {"event": event, "goal_id": str(goal_id) if goal_id else None}
    if payload:
        metadata["payload"] = payload
    try:
        await write_entry(content=content, entry_type="goal_event", metadata=metadata)
    except Exception as e:
        # Journal failures must never break the maturation pipeline.
        log.warning("emit_journal failed (event=%s goal=%s): %s", event, goal_id, e)


async def emit_notification(
    goal_id: str | UUID,
    kind: str,
    title: str,
    link: str | None = None,
) -> None:
    """Publish a goal notification to the existing nova:notifications Redis pub/sub channel.

    Existing consumers:
      - orchestrator/app/pipeline_router.py:1232 — SSE stream subscribes to nova:notifications
      - orchestrator/app/auto_friction.py:28 — friction logger subscribes to the same channel

    Dashboard reads the SSE stream at GET /api/v1/pipeline/notifications/stream.
    No new HTTP endpoint or websocket plumbing required.
    """
    payload = {
        "kind": kind,
        "goal_id": str(goal_id),
        "title": title,
        "link": link or f"/goals/{goal_id}",
    }
    try:
        redis = await _get_notify_redis()
        await redis.publish("nova:notifications", json.dumps(payload))
    except Exception as e:
        log.warning("emit_notification failed (kind=%s goal=%s): %s", kind, goal_id, e)
