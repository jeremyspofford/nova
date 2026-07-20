"""Conversation compaction — a rolling summary of turns aged out of the
verbatim history window.

Fire-and-forget after a completed turn. No-ops unless enough un-summarized
messages have aged out (compaction_min_aged), so most turns cost nothing.
Raw exchanges remain journaled in memory regardless — the summary preserves
conversational continuity, the journal preserves recall.
"""

import asyncio
import logging
import uuid
from datetime import datetime

from app import conversations, db, settings_store, trace
from app.llm import router as llm_router

log = logging.getLogger(__name__)

_lock = asyncio.Lock()

_MAX_TRANSCRIPT_CHARS = 24_000
_MAX_MSG_CHARS = 800

_SYSTEM = """You maintain the running summary of one long, continuous conversation between a user and Nova (an AI assistant).
Merge the previous summary with the newly aged-out messages into ONE updated summary, at most 300 words, plain text.
Preserve, in priority order: stable facts about the user and their preferences; decisions that were made; open threads, requests, or commitments not yet resolved; notable outcomes.
Drop pleasantries and transient detail. Never invent content. Output only the summary text."""


async def maybe_compact(conversation_id: str, model: str,
                        window_oldest_at: str | None):
    """Summarize messages that fell out of the verbatim window, if enough did."""
    if not window_oldest_at:
        return
    boundary = (window_oldest_at if isinstance(window_oldest_at, datetime)
                else datetime.fromisoformat(window_oldest_at))

    async with _lock:
        try:
            async with db.acquire() as conn:
                rows = await conn.fetch(
                    """SELECT role, content, created_at FROM messages
                       WHERE conversation_id = $1
                         AND role IN ('user','assistant')
                         AND content IS NOT NULL AND content <> ''
                         AND created_at < $2
                         AND created_at > COALESCE(
                             (SELECT summary_upto FROM conversations WHERE id = $1),
                             'epoch'::timestamptz)
                       ORDER BY created_at ASC""",
                    uuid.UUID(conversation_id), boundary)
                prev = await conn.fetchval(
                    "SELECT summary FROM conversations WHERE id = $1",
                    uuid.UUID(conversation_id))

            if len(rows) < settings_store.get("compaction.min_aged"):
                return

            parts = []
            for r in rows:
                speaker = "User" if r["role"] == "user" else "Nova"
                parts.append(f"{speaker}: {r['content'][:_MAX_MSG_CHARS]}")
            transcript = "\n\n".join(parts)[:_MAX_TRANSCRIPT_CHARS]

            user_prompt = ""
            if prev:
                user_prompt += f"Previous summary:\n{prev}\n\n"
            user_prompt += f"Newly aged-out messages:\n{transcript}\n\nUpdated summary:"

            compaction_model = llm_router.effective_model(
                settings_store.get("compaction.model") or model)
            summary = ""
            async with trace.turn("compaction", conversation_id=conversation_id,
                                  model=compaction_model) as t:
                async with trace.span("llm_call", compaction_model) as lsp:
                    lsp["prompt_chars"] = len(_SYSTEM) + len(user_prompt)
                    async for event in llm_router.stream_chat(
                            [{"role": "system", "content": _SYSTEM},
                             {"role": "user", "content": user_prompt}],
                            compaction_model):
                        if event.get("type") == "text":
                            summary += event["text"]
                        elif event.get("type") == "usage":
                            u = event.get("usage") or {}
                            lsp["prompt_tokens"] = u.get("prompt_tokens")
                            lsp["completion_tokens"] = u.get("completion_tokens")
                        elif event.get("type") == "error":
                            lsp["error"] = event["error"]
                            t.set_error(event["error"])
                            log.warning("compaction LLM error (will retry on a "
                                        "later turn): %s", event["error"])
                            return
                    lsp["completion_chars"] = len(summary)

            summary = summary.strip()
            if not summary:
                log.warning("compaction produced empty summary; skipping update")
                return

            upto = rows[-1]["created_at"]
            await conversations.set_summary(conversation_id, summary, upto)
            log.info("Compacted %d aged messages into summary (%d chars, upto %s)",
                     len(rows), len(summary), upto)
        except Exception:
            log.exception("compaction pass failed; watermark unchanged")
