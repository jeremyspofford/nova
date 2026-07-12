"""Chat outcome scorer — infers LLM response quality from user behavior.

Runs as a 30-second background loop. For each new user message, scores
the preceding assistant response using implicit heuristics:
  - Acknowledgment ("thanks") → 0.9
  - Topic change (low similarity) → 0.8
  - Follow-up (moderate similarity) → 0.75
  - Correction ("no, I meant...") → 0.4
  - Rephrased question (high similarity) → 0.3
  - Abandonment (30+ min silence) → 0.5 (low confidence)

Keyword heuristics run first (free). Embedding similarity only runs
if keywords don't produce a high-confidence result.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timedelta, timezone

from app.quality_scorer import (
    score_instruction_adherence_live,
    score_memory_recall,
    score_memory_relevance,
    score_memory_usage,
    score_response_coherence,
    score_safety_compliance,
    score_tool_accuracy,
)

from .clients import get_llm_client
from .db import get_pool
from .store import get_redis

log = logging.getLogger(__name__)

# Redis keys
CURSOR_KEY = "nova:state:chat_scorer_cursor"
SCORED_CONVOS_KEY = "nova:state:scored_conversations"

# Heuristic patterns
_ACKNOWLEDGMENT_PATTERNS = re.compile(
    r"^(thanks?|thank you|perfect|great|got it|awesome|nice|cool|ok thanks|"
    r"that works|that'?s? (great|perfect|exactly|right|helpful|what i needed))\s*[.!]?$",
    re.IGNORECASE,
)
_CORRECTION_PATTERNS = re.compile(
    r"^(no[,.]?\s|not what i|actually[,.]?\s|that'?s? (wrong|not|incorrect)|"
    r"i (said|meant|asked)|you misunderstood|that'?s? not right)",
    re.IGNORECASE,
)


def _score_by_keywords(user_msg: str) -> tuple[float, float] | None:
    """Try keyword-based scoring. Returns (score, confidence) or None if no match."""
    text = user_msg.strip()

    # Short acknowledgment (spec threshold: 30 chars)
    if len(text) < 30 and _ACKNOWLEDGMENT_PATTERNS.match(text):
        return 0.9, 0.85

    # Correction (length-bounded to avoid false positives on long messages)
    if len(text) < 200 and _CORRECTION_PATTERNS.match(text):
        return 0.4, 0.8

    return None


async def _get_embedding(text: str) -> list[float] | None:
    """Get embedding via llm-gateway /embed endpoint."""
    try:
        client = get_llm_client()
        resp = await client.post("/embed", json={"input": text})
        if resp.status_code == 200:
            data = resp.json()
            # llm-gateway returns {"data": [{"embedding": [...]}]}
            return data["data"][0]["embedding"]
    except Exception:
        pass
    return None


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


async def _score_by_similarity(
    user_msg: str, prev_user_msg: str | None, assistant_msg: str,
) -> tuple[float, float]:
    """Score using embedding similarity. Fallback when keywords don't match."""
    # If no previous user message, default to follow-up (building on response)
    if not prev_user_msg:
        return 0.75, 0.5

    # Compare current user message with previous user message
    emb_current = await _get_embedding(user_msg)
    emb_prev = await _get_embedding(prev_user_msg)

    if emb_current is None or emb_prev is None:
        return 0.7, 0.4  # Can't compute — neutral with low confidence

    sim = _cosine_similarity(emb_current, emb_prev)

    if sim > 0.8:
        # High similarity to previous question → rephrasing
        return 0.3, 0.85
    elif sim < 0.3:
        # Very different topic → moved on (satisfied)
        return 0.8, 0.6
    else:
        # Moderate similarity → follow-up question
        return 0.75, 0.7


async def _score_turn(
    user_msg: str, prev_user_msg: str | None, assistant_msg: str,
) -> tuple[float, float]:
    """Score a single assistant response based on the user's next message."""
    # Try keywords first (free, high confidence)
    kw_result = _score_by_keywords(user_msg)
    if kw_result:
        return kw_result

    # Fall back to embedding similarity
    return await _score_by_similarity(user_msg, prev_user_msg, assistant_msg)


async def _write_quality_scores(
    conn,
    conversation_id: str,
    message_id: str | None,
    scores: list[dict],
) -> int:
    """Write per-dimension quality scores to quality_scores table."""
    written = 0
    for s in scores:
        if s is None:
            continue
        try:
            await conn.execute(
                """
                INSERT INTO quality_scores
                    (conversation_id, message_id, dimension, score, confidence, metadata)
                VALUES ($1, $2, $3, $4, $5, $6)
                """,
                conversation_id,
                message_id,
                s["dimension"],
                s["score"],
                s.get("confidence"),
                json.dumps(s.get("metadata", {})),
            )
            written += 1
        except Exception as e:
            log.debug("Failed to write quality score %s: %s", s.get("dimension"), e)
    return written


async def _process_new_messages() -> int:
    """Process new messages and score preceding assistant responses.

    Returns the number of scores written.
    """
    redis = get_redis()
    pool = get_pool()

    # Read cursor
    cursor_raw = await redis.get(CURSOR_KEY)
    if cursor_raw:
        cursor = datetime.fromisoformat(cursor_raw)
    else:
        cursor = datetime.now(timezone.utc) - timedelta(hours=1)

    scores_written = 0

    async with pool.acquire() as conn:
        # Find new user messages since cursor
        rows = await conn.fetch(
            """
            SELECT m.id, m.conversation_id, m.content, m.created_at,
                   m.role
            FROM messages m
            WHERE m.created_at > $1
              AND m.role = 'user'
            ORDER BY m.conversation_id, m.created_at
            LIMIT 100
            """,
            cursor,
        )

        if not rows:
            return 0

        new_cursor = cursor

        for row in rows:
            conv_id = str(row["conversation_id"])
            user_msg = row["content"] or ""
            msg_time = row["created_at"]

            if msg_time > new_cursor:
                new_cursor = msg_time

            # Get the preceding assistant message
            assistant_row = await conn.fetchrow(
                """
                SELECT id, content, created_at, metadata FROM messages
                WHERE conversation_id = $1
                  AND role = 'assistant'
                  AND created_at < $2
                ORDER BY created_at DESC
                LIMIT 1
                """,
                row["conversation_id"], msg_time,
            )
            if not assistant_row:
                continue

            # Get the previous user message (for similarity comparison)
            prev_user_row = await conn.fetchrow(
                """
                SELECT content FROM messages
                WHERE conversation_id = $1
                  AND role = 'user'
                  AND created_at < $2
                ORDER BY created_at DESC
                LIMIT 1
                """,
                row["conversation_id"], msg_time,
            )

            assistant_msg = assistant_row["content"] or ""
            prev_user_msg = prev_user_row["content"] if prev_user_row else None

            # Aliases used by quality scoring block below
            user_text = user_msg
            assistant_text = assistant_msg

            # Score
            score, confidence = await _score_turn(user_msg, prev_user_msg, assistant_msg)

            # Find matching usage_event (session_id = conversation_id, within 120s)
            # PostgreSQL doesn't allow ORDER BY/LIMIT in UPDATE — use subquery
            # Compute time range in Python to avoid asyncpg type-inference
            # ambiguity with BETWEEN ($2 - INTERVAL ...) AND $2
            ref_time = assistant_row["created_at"]
            ref_time_lower = ref_time - timedelta(seconds=120)
            result = await conn.execute(
                """
                UPDATE usage_events
                SET outcome_score = $4, outcome_confidence = $5
                WHERE id = (
                    SELECT id FROM usage_events
                    WHERE session_id = $1
                      AND created_at >= $2
                      AND created_at <= $3
                      AND outcome_score IS NULL
                    ORDER BY created_at DESC
                    LIMIT 1
                )
                """,
                conv_id,
                ref_time_lower,
                ref_time,
                score,
                confidence,
            )

            if result and result != "UPDATE 0":
                scores_written += 1

            # ── Quality dimension scoring (async, non-blocking) ──
            try:
                quality_scores = []

                # Memory relevance — check if memories were injected
                memory_ids = []
                if assistant_row.get("metadata"):
                    meta = assistant_row["metadata"]
                    if isinstance(meta, str):
                        meta = json.loads(meta)
                    memory_ids = meta.get("memory_ids", [])

                if memory_ids:
                    relevance = await score_memory_relevance(memory_ids, user_text)
                    quality_scores.append(relevance)

                    # Memory usage — did the response actually use retrieved memories?
                    usage = await score_memory_usage(memory_ids, assistant_text)
                    quality_scores.append(usage)

                # Memory recall — correction detection
                recall = score_memory_recall(user_text)
                quality_scores.append(recall)

                # Tool accuracy — parse agent session output
                # agent_sessions has no conversation_id; join through tasks table
                session_output = None
                session_row = await conn.fetchrow(
                    """SELECT s.output, t.id AS task_id FROM agent_sessions s
                       JOIN tasks t ON t.id = s.task_id
                       WHERE t.conversation_id = $1
                       ORDER BY s.completed_at DESC NULLS LAST LIMIT 1""",
                    conv_id,
                )
                if session_row and session_row["output"]:
                    output = session_row["output"]
                    session_output = json.loads(output) if isinstance(output, str) else output

                tool_score = score_tool_accuracy(session_output)
                quality_scores.append(tool_score)
                had_tools = tool_score is not None

                # Response coherence — skip if tools were used
                coherence = await score_response_coherence(
                    user_text, assistant_text, had_tool_calls=had_tools
                )
                quality_scores.append(coherence)

                # Safety compliance — derived from guardrail_findings on the matched task
                task_id_for_scoring = None
                if session_row and session_row.get("task_id"):
                    task_id_for_scoring = str(session_row["task_id"])
                elif assistant_row.get("metadata"):
                    meta = assistant_row["metadata"]
                    if isinstance(meta, str):
                        meta = json.loads(meta)
                    task_id_for_scoring = meta.get("task_id")

                if task_id_for_scoring:
                    safety = await score_safety_compliance(task_id_for_scoring, pool)
                    quality_scores.append(safety)

                # Instruction adherence — opt-in toggle. Lives in
                # platform_config (seeded by migration 065); the previous
                # implementation read a Redis key nothing ever wrote, so
                # flipping the stored value was silently dead.
                from app.runtime_config import get_db_config
                flag = await get_db_config("quality.instruction_adherence_live", "false")
                enabled = (flag or "").strip().lower() in ("true", "1", "yes")

                if enabled:
                    adherence = await score_instruction_adherence_live(
                        user_message=user_text,
                        response_text=assistant_text,
                        enabled=True,
                    )
                    quality_scores.append(adherence)

                written = await _write_quality_scores(
                    conn, str(conv_id), str(assistant_row["id"]), quality_scores
                )
                if written > 0:
                    log.debug("Wrote %d quality scores for conversation %s", written, conv_id)
            except Exception as e:
                log.debug("Quality scoring failed (non-fatal): %s", e)

    # Update cursor
    await redis.set(CURSOR_KEY, new_cursor.isoformat())

    return scores_written


async def _check_abandonments() -> int:
    """Score abandoned conversations (no user message for 30+ min)."""
    pool = get_pool()
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=30)
    scores_written = 0

    async with pool.acquire() as conn:
        # Find assistant messages with no follow-up user message for 30+ min
        rows = await conn.fetch(
            """
            SELECT ue.id, ue.session_id, ue.created_at
            FROM usage_events ue
            WHERE ue.outcome_score IS NULL
              AND ue.session_id IS NOT NULL
              -- session_id is TEXT and API clients may send arbitrary ids;
              -- a single non-UUID row would make the ::uuid cast below throw
              -- and wedge every scorer iteration until the row is deleted.
              AND ue.session_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              AND ue.created_at < $1
              AND NOT EXISTS (
                  SELECT 1 FROM messages m
                  WHERE m.conversation_id = ue.session_id::uuid
                    AND m.role = 'user'
                    AND m.created_at > ue.created_at
              )
            LIMIT 50
            """,
            cutoff,
        )

        for row in rows:
            await conn.execute(
                "UPDATE usage_events SET outcome_score = 0.5, outcome_confidence = 0.2 WHERE id = $1",
                row["id"],
            )
            scores_written += 1

    return scores_written


async def _compute_conversation_scores() -> int:
    """Compute session-level scores for quiet conversations."""
    redis = get_redis()
    pool = get_pool()
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=30)
    scores_written = 0

    async with pool.acquire() as conn:
        # Find conversations with scored turns but no recent activity
        rows = await conn.fetch(
            """
            SELECT DISTINCT ue.session_id
            FROM usage_events ue
            WHERE ue.session_id IS NOT NULL
              AND ue.outcome_score IS NOT NULL
              AND ue.created_at < $1
              AND NOT EXISTS (
                  SELECT 1 FROM messages m
                  WHERE m.conversation_id::text = ue.session_id
                    AND m.created_at > $1
              )
            LIMIT 20
            """,
            cutoff,
        )

        for row in rows:
            sid = row["session_id"]

            # Check dedup — skip if already scored recently (per-key TTL)
            dedup_key = f"{SCORED_CONVOS_KEY}:{sid}"
            if await redis.exists(dedup_key):
                continue

            # Get all scored turns for this session, ordered by time
            turns = await conn.fetch(
                """
                SELECT outcome_score, outcome_confidence, created_at
                FROM usage_events
                WHERE session_id = $1 AND outcome_score IS NOT NULL
                ORDER BY created_at ASC
                """,
                sid,
            )

            if not turns:
                continue

            # Weighted average biased toward final turns.
            # Weights ramp linearly from 0.5 (first turn) to 1.0 (last turn).
            # For n=1, max(n-1,1) prevents division by zero → weight is 0.5,
            # so single-turn score passes through unchanged.
            n = len(turns)
            weights = [0.5 + 0.5 * (i / max(n - 1, 1)) for i in range(n)]
            total_w = sum(weights)
            session_score = sum(
                t["outcome_score"] * w for t, w in zip(turns, weights)
            ) / total_w

            # Resolve conversation_id from session_id (may be UUID string)
            conv_uuid = None
            try:
                from uuid import UUID as _UUID
                conv_uuid = _UUID(sid)
            except (ValueError, AttributeError):
                pass

            # Write to conversation_outcomes (skip if conversation doesn't exist)
            try:
                await conn.execute(
                    """
                    INSERT INTO conversation_outcomes
                        (conversation_id, session_id, session_score, turn_count)
                    VALUES ($1, $2, $3, $4)
                    """,
                    conv_uuid,
                    sid,
                    round(session_score, 3),
                    n,
                )
                scores_written += 1
            except Exception as e:
                log.debug("Skipping conversation outcome for %s: %s", sid, e)

            # Mark as scored regardless (2h per-key expiry — won't grow unboundedly)
            await redis.set(dedup_key, "1", ex=7200)

    return scores_written


async def chat_scorer_loop() -> None:
    """Background loop — score chat interactions every 30 seconds."""
    log.info("Chat scorer started")
    while True:
        try:
            msg_scores = await _process_new_messages()
            abandon_scores = await _check_abandonments()
            conv_scores = await _compute_conversation_scores()
            if msg_scores or abandon_scores:
                log.info(
                    "Chat scorer: %d message scores, %d abandonment scores",
                    msg_scores, abandon_scores,
                )
            if conv_scores:
                log.info("Chat scorer: %d conversation scores computed", conv_scores)
        except Exception:
            log.exception("Chat scorer iteration failed")
        await asyncio.sleep(30)
