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
            "SELECT id, title, created_at, summary, summary_upto, cleared_at "
            "FROM conversations ORDER BY created_at DESC LIMIT 1")
        if row:
            return {"id": str(row["id"]), "title": row["title"],
                    "created_at": str(row["created_at"]),
                    # the summary is dropped by clear_context, so a stale one
                    # can never outlive the window it was built from
                    "summary": row["summary"],
                    "summary_upto": str(row["summary_upto"]) if row["summary_upto"] else None,
                    "cleared_at": str(row["cleared_at"]) if row["cleared_at"] else None}
        conversation_id = uuid.uuid4()
        await conn.execute(
            "INSERT INTO conversations (id, title) VALUES ($1, $2)",
            conversation_id, "Nova")
        return {"id": str(conversation_id), "title": "Nova", "created_at": None,
                "summary": None, "summary_upto": None}


async def set_summary(conversation_id: str, summary: str, upto):
    """Persist the rolling summary and its watermark (upto: datetime)."""
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE conversations SET summary = $2, summary_upto = $3, "
            "updated_at = now() WHERE id = $1",
            uuid.UUID(conversation_id), summary, upto)


async def append_message(conversation_id: str, role: str, content: Optional[str] = None,
                         model_used: Optional[str] = None,
                         tool_calls: Optional[list | dict] = None,
                         metadata: Optional[dict] = None) -> str:
    message_id = uuid.uuid4()
    async with db.acquire() as conn:
        # One unit: a stored message whose conversation still claims an older
        # last_message_at sorts and prunes wrong everywhere downstream.
        async with conn.transaction():
            await conn.execute(
                """INSERT INTO messages (id, conversation_id, role, content, model_used, tool_calls, metadata)
                   VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::jsonb, '{}'::jsonb))""",
                message_id, uuid.UUID(conversation_id), role, content, model_used,
                json.dumps(tool_calls) if tool_calls is not None else None,
                json.dumps(metadata) if metadata is not None else None)
            await conn.execute(
                "UPDATE conversations SET updated_at = now(), last_message_at = now() "
                "WHERE id = $1", uuid.UUID(conversation_id))
    return str(message_id)


async def load_history(conversation_id: str, limit: int = 200,
                       roles: Optional[tuple[str, ...]] = None) -> list[dict]:
    """The most recent `limit` messages, in chronological order.

    `roles` filters INSIDE the limit, which is the whole point: every tool
    call journals a row here (router_chat stamps one per activity event), and
    those rows outnumber real turns ~2:1 in practice. Taking 200 rows and
    filtering after meant the LLM replayed whatever fraction happened to be
    conversation — measured 2026-07-24 on the live DB: 128 tool rows in the
    200 fetched, so 72 real turns against a budget sized for far more. Nova
    forgot roughly three times sooner than configured, and decoded 128 rows
    of jsonb tool_calls to throw them away.
    """
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, role, content, model_used, tool_calls, metadata, created_at FROM (
                   SELECT m.* FROM messages m
                   JOIN conversations c ON c.id = m.conversation_id
                   WHERE m.conversation_id = $1
                     AND ($3::text[] IS NULL OR m.role = ANY($3::text[]))
                     AND (c.cleared_at IS NULL OR m.created_at > c.cleared_at)
                   ORDER BY m.created_at DESC
                   LIMIT $2
               ) recent ORDER BY created_at ASC""",
            uuid.UUID(conversation_id), limit, list(roles) if roles else None)
    return [{
        "id": str(r["id"]),
        "role": r["role"],
        "content": r["content"],
        "model_used": r["model_used"],
        "tool_calls": r["tool_calls"],
        "metadata": r["metadata"],
        "created_at": str(r["created_at"]) if r["created_at"] else None,
    } for r in rows]


def to_llm_history(history: list[dict]) -> list[dict]:
    """Text-only user/assistant turns for the LLM (tool rows are audit records)."""
    return [{"role": m["role"], "content": m["content"]}
            for m in history
            if m["role"] in ("user", "assistant") and m["content"]]


def estimate_tokens(text: str) -> int:
    """Chars/4 heuristic — good enough for budgeting, no tokenizer dependency."""
    return len(text) // 4 + 1


def window_history(history: list[dict], budget_tokens: int,
                   min_messages: int = 4) -> tuple[list[dict], list[dict]]:
    """Split text turns into (window, aged_out), both chronological.

    Newest turns win; the window always keeps at least min_messages so the
    conversation never goes blind, even when a single huge message would
    exceed the budget on its own.
    """
    text_turns = [m for m in history
                  if m["role"] in ("user", "assistant") and m["content"]]
    window: list[dict] = []
    used = 0
    for m in reversed(text_turns):
        cost = estimate_tokens(m["content"])
        if window and len(window) >= min_messages and used + cost > budget_tokens:
            break
        window.append(m)
        used += cost
    window.reverse()
    aged = text_turns[:len(text_turns) - len(window)]
    return window, aged


async def clear_context(conversation_id: str) -> dict:
    """/clear — reset the working context without destroying anything.

    Sets the watermark to now and drops the rolling summary. Messages stay:
    the turn ledger references them, the journal already holds every
    exchange, and a delete would make a mis-typed /clear unrecoverable.

    The summary MUST go with the window. It is merged from turns that aged
    out, so leaving it would keep the cleared conversation alive as a
    300-word paraphrase — which is precisely what the operator cleared.
    """
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE conversations
                  SET cleared_at = now(), summary = NULL,
                      -- not NULL: compaction treats a null watermark as
                      -- 'epoch' and would re-summarise everything
                      summary_upto = now()
                WHERE id = $1
            RETURNING cleared_at""", uuid.UUID(conversation_id))
        if not row:
            return {"cleared": False}
        kept = await conn.fetchval(
            "SELECT count(*) FROM messages WHERE conversation_id = $1",
            uuid.UUID(conversation_id))
    return {"cleared": True, "cleared_at": str(row["cleared_at"]),
            "messages_kept": int(kept or 0)}
