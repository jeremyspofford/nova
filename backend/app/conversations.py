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
                       roles: Optional[tuple[str, ...]] = None,
                       before: Optional[str] = None) -> list[dict]:
    """The most recent `limit` messages, in chronological order.

    `roles` filters INSIDE the limit, which is the whole point: every tool
    call journals a row here (router_chat stamps one per activity event), and
    those rows outnumber real turns ~2:1 in practice. Taking 200 rows and
    filtering after meant the LLM replayed whatever fraction happened to be
    conversation — measured 2026-07-24 on the live DB: 128 tool rows in the
    200 fetched, so 72 real turns against a budget sized for far more. Nova
    forgot roughly three times sooner than configured, and decoded 128 rows
    of jsonb tool_calls to throw them away.

    `before` is the pagination cursor — rows strictly older than that
    timestamp. It backs the chat UI's "load earlier": the endpoint's window
    is finite, and without a way to walk backwards the only honest thing it
    could say is that older turns exist and cannot be reached.

    ORDER BY carries `id` as a tiebreak. created_at ties are real — an
    assistant row and the narration warning about it share a microsecond —
    and once the window can be paged, a tie that sorts differently between
    calls drops a row from every page or returns it on two.
    """
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, role, content, model_used, tool_calls, metadata, created_at FROM (
                   SELECT m.* FROM messages m
                   JOIN conversations c ON c.id = m.conversation_id
                   WHERE m.conversation_id = $1
                     AND ($3::text[] IS NULL OR m.role = ANY($3::text[]))
                     AND (c.cleared_at IS NULL OR m.created_at > c.cleared_at)
                     -- ::text::timestamptz, like load_tool_activity's cursor:
                     -- the value arrives as a string and asyncpg will not
                     -- encode a str into a timestamptz parameter directly.
                     AND ($4::text IS NULL
                          OR m.created_at < $4::text::timestamptz)
                   ORDER BY m.created_at DESC, m.id DESC
                   LIMIT $2
               ) recent ORDER BY created_at ASC, id ASC""",
            uuid.UUID(conversation_id), limit, list(roles) if roles else None,
            before)
    return [{
        "id": str(r["id"]),
        "role": r["role"],
        "content": r["content"],
        "model_used": r["model_used"],
        "tool_calls": r["tool_calls"],
        "metadata": r["metadata"],
        "created_at": str(r["created_at"]) if r["created_at"] else None,
    } for r in rows]


async def load_tool_activity(conversation_id: str, since: Optional[str],
                             limit: int = 300) -> list[dict]:
    """The role='tool' rows since `since` — the mechanical record of what ran.

    Its own query on purpose: load_history's row cap is spent on the
    user/assistant transcript and has to stay that way.

    NEWEST-WINS at the cap, like load_history. This was a plain
    `ORDER BY created_at ASC LIMIT 300`, which drops the wrong end: past the
    cap it discards what just happened and keeps the oldest rows in the
    window, so the turn most likely to matter — the one she is about to
    answer a follow-up to — is the first to vanish. Not yet triggered live
    (65 rows on the busiest conversation), and the fix costs one subquery.
    """
    if not since:
        return []
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT content, tool_calls, created_at FROM (
                 SELECT id, content, tool_calls, created_at FROM messages
                 WHERE conversation_id = $1 AND role = 'tool'
                   -- only rows that record a CALL. 'narration_retry' and
                   -- friends are activity notes about the turn, and letting
                   -- one in produced "main -> ok", which names no tool.
                   --
                   -- 'capability' was left in and is the same defect: its row
                   -- is a GUARD VIOLATION ("claimed filesystem access, which
                   -- no tool in this turn's toolset provides") written under
                   -- name='main', and _outcome scores it 'ok'. So the finding
                   -- that she claimed something false replayed to her as a
                   -- successful tool call named `main` — evidence FOR the
                   -- claim it was raised to refute. Nothing is lost by
                   -- dropping it: the correction is appended to the reply
                   -- text itself, so it is already in the assistant row this
                   -- note hangs off.
                   AND tool_calls->>'kind' IN
                       ('tool_start', 'tool_result', 'dispatch')
                   AND created_at >= $2::text::timestamptz
                 ORDER BY created_at DESC, id DESC LIMIT $3
               ) recent ORDER BY created_at ASC, id ASC""",
            uuid.UUID(conversation_id), since, limit)
    out = []
    for r in rows:
        tc = r["tool_calls"]
        if isinstance(tc, str):
            try:
                tc = json.loads(tc or "{}")
            except ValueError:
                tc = {}
        out.append({"name": (tc or {}).get("name"), "kind": (tc or {}).get("kind"),
                    "content": r["content"] or "", "created_at": str(r["created_at"])})
    return out


def _outcome(content: str) -> str:
    head = (content or "").lstrip()[:80].lower()
    return "error" if head.startswith("error") or '"error"' in head else "ok"


def tool_activity_notes(history: list[dict], activity: list[dict]) -> dict[str, str]:
    """One derived line per past turn: what actually ran, and how it ended.

    Keyed by the user message that opened the turn, because tool rows are
    written fire-and-forget and can land after the assistant row — bucketing
    by "the previous assistant row" would misfile them.

    Mechanical, never the model's word for it: every entry is read from a row
    the runner wrote at execution time. This is the fix for a turn replaying
    as prose only — she said "let me dig deeper" four times because the
    history she was handed contained no evidence that list_egress had already
    run, and when she could not see her own tool history she invented one.
    """
    users = [m["created_at"] for m in history
             if m["role"] == "user" and m.get("created_at")]
    if not users or not activity:
        return {}
    # AN OUTCOME COMES FROM A RESULT, NEVER FROM A CALL. `tool_start` rows
    # carry the ARGUMENTS as their content, and `{"action": "list"}` does not
    # begin with "error", so _outcome scored every one of them `ok`. Each call
    # therefore produced two contradictory entries and the model was handed
    # both. MEASURED 2026-08-04, replayed verbatim into her next turn:
    #
    #   manage_tool_hosts -> ok; manage_tool_hosts -> error;
    #   manage_tools -> ok; manage_tools -> error
    #
    # Both of those calls were REFUSED. This note exists to be the mechanical
    # record she trusts over her own prose, and it was asserting that a denied
    # call had succeeded — in the same breath as saying it failed.
    results: dict[str, list[str]] = {}
    started: dict[str, list[str]] = {}
    for a in activity:
        name = a.get("name")
        if not name:
            continue
        bucket = None
        for u in users:
            if u <= a["created_at"]:
                bucket = u
            else:
                break
        if bucket is None:
            continue
        if a.get("kind") == "tool_start":
            started.setdefault(bucket, []).append(name)
            continue
        label = f"{name} -> {_outcome(a['content'])}"
        seen = results.setdefault(bucket, [])
        if label not in seen:
            seen.append(label)
    out: dict[str, str] = {}
    for bucket in set(results) | set(started):
        entries = list(results.get(bucket, []))
        # A call with no result is not a success and not a failure — it is a
        # call that did not finish, which is exactly what an interrupted turn
        # leaves behind. Saying so beats inventing either verdict.
        answered = {e.split(" -> ", 1)[0] for e in entries}
        for name in started.get(bucket, []):
            if name in answered:
                continue
            label = f"{name} -> started, no result recorded"
            if label not in entries:
                entries.append(label)
        if entries:
            out[bucket] = ("[tools that ran in this turn: "
                           + "; ".join(entries[:8]) + "]")
    return out


def to_llm_history(history: list[dict],
                   activity: Optional[list[dict]] = None) -> list[dict]:
    """Text-only user/assistant turns, each assistant turn followed by the
    mechanical record of what ran in it.

    NOT reconstructed assistant(tool_calls)+tool pairs: no assistant row has
    ever carried tool_calls (0 of 549 live rows) and tool_call_id is NULL on
    all 1651 tool rows, so a pair would have to be invented — and the stored
    content is a 200-char UI stub, so it would pair a fabricated call with a
    fabricated result. That is the failure being fixed, not a way to fix it.
    """
    notes = tool_activity_notes(history, activity or [])
    out: list[dict] = []
    pending: Optional[str] = None
    for m in history:
        if m["role"] not in ("user", "assistant") or not m["content"]:
            continue
        content = m["content"]
        if m["role"] == "user":
            pending = notes.get(m.get("created_at"))
            # ORPHAN GUARD. A user row with no assistant row after it means
            # that turn never landed one — it was cancelled, or a second turn
            # on the same conversation overtook it. Replayed raw, the model
            # receives two consecutive user messages and answers BOTH in one
            # reply: measured 66 times live, and the shape Jeremy reported on
            # 2026-08-04 ("she merges her responses into one longer message").
            #
            # Derived from the row sequence, so it goes quiet by itself the
            # moment orphans stop appearing — there is no list to maintain.
            # Stated as a fact about the transcript, not an instruction: this
            # text is replayed to the model, and "answer it now" is exactly
            # the merge being prevented.
            if out and out[-1]["role"] == "user":
                out.append({
                    "role": "assistant",
                    "content": ("[This turn was interrupted and never "
                                "answered. The operator has since sent the "
                                "message below — answer that one. Do not "
                                "re-answer the earlier message unless they "
                                "ask again.]"),
                })
        elif pending:
            content = f"{content}\n\n{pending}"
            pending = None
        out.append({"role": m["role"], "content": content})
    return out


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
