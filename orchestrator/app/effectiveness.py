"""Effectiveness matrix — hourly aggregation of model outcome scores.

Computes avg outcome_score per (model, task_type) from usage_events
and pushes the result to Redis for the llm-gateway tier resolver.

The gateway reads this at `nova:cache:model_effectiveness` to filter
tier preference lists — models that consistently underperform for a
task type get deprioritised automatically.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone

from .db import get_pool
from .store import get_redis

log = logging.getLogger(__name__)

REDIS_KEY = "nova:cache:model_effectiveness"
REDIS_TTL = 3600  # 1 hour — matches the computation interval


async def compute_and_publish() -> int:
    """Aggregate outcome scores and publish to Redis.

    Returns the number of (model, task_type) entries in the matrix.
    """
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT model,
                   COALESCE(metadata->>'task_type', 'unknown') AS task_type,
                   SUM(outcome_score * outcome_confidence) / NULLIF(SUM(outcome_confidence), 0) AS avg_score,
                   COUNT(*) AS sample_count
            FROM usage_events
            WHERE outcome_score IS NOT NULL
              AND outcome_confidence IS NOT NULL
              AND created_at > NOW() - INTERVAL '30 days'
            GROUP BY 1, 2
        """)

    matrix = {}
    for row in rows:
        key = f"{row['model']}:{row['task_type']}"
        matrix[key] = {
            "avg_score": round(float(row["avg_score"]), 3),
            "sample_count": int(row["sample_count"]),
        }

    try:
        redis = get_redis()
        await redis.set(REDIS_KEY, json.dumps(matrix), ex=REDIS_TTL)
        log.info("Published effectiveness matrix: %d entries", len(matrix))
    except Exception:
        log.warning("Redis unavailable — effectiveness matrix not published", exc_info=True)

    await _detect_capability_gaps(matrix)

    feedback_count = await _send_memory_feedback()
    if feedback_count:
        log.info("Sent %d memory outcome feedback entries", feedback_count)

    return len(matrix)


CAPABILITY_GAP_KEY = "nova:signals:capability_gaps"


async def _detect_capability_gaps(matrix: dict) -> None:
    """Find task_types where all models underperform and signal to cortex."""
    # Group by task_type
    task_types: dict[str, list[dict]] = {}
    for key, entry in matrix.items():
        _, task_type = key.rsplit(":", 1)
        task_types.setdefault(task_type, []).append(entry)

    gaps = []
    for task_type, entries in task_types.items():
        total_samples = sum(e["sample_count"] for e in entries)
        if total_samples < 20:
            continue  # Not enough data
        best_score = max(e["avg_score"] for e in entries)
        if best_score < 0.5:
            gaps.append({
                "task_type": task_type,
                "best_score": best_score,
                "sample_count": total_samples,
            })

    try:
        redis = get_redis()
        if gaps:
            await redis.set(CAPABILITY_GAP_KEY, json.dumps(gaps), ex=REDIS_TTL)
            log.info("Capability gaps detected: %s", [g["task_type"] for g in gaps])
        else:
            await redis.delete(CAPABILITY_GAP_KEY)
    except Exception:
        log.warning("Failed to publish capability gaps", exc_info=True)


FEEDBACK_CURSOR_KEY = "nova:state:outcome_feedback_cursor"


async def _send_memory_feedback() -> int:
    """Send outcome scores for memory-backed interactions to memory-service."""
    redis = get_redis()
    pool = get_pool()

    cursor_raw = await redis.get(FEEDBACK_CURSOR_KEY)
    if cursor_raw:
        cursor = datetime.fromisoformat(cursor_raw)
    else:
        cursor = datetime.now(timezone.utc) - timedelta(days=30)

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT metadata->'memory_ids' AS memory_ids,
                   outcome_score,
                   created_at
            FROM usage_events
            WHERE outcome_score IS NOT NULL
              AND metadata->'memory_ids' IS NOT NULL
              AND jsonb_array_length(metadata->'memory_ids') > 0
              AND created_at > $1
            ORDER BY created_at ASC
            LIMIT 500
            """,
            cursor,
        )

    if not rows:
        return 0

    # Build feedback batch: neutral API is per-item {memory_id, outcome_score}.
    feedback = []
    for row in rows:
        memory_ids = row["memory_ids"]  # already parsed as list by asyncpg JSONB codec
        if not isinstance(memory_ids, list):
            continue
        # Scores land in [−1, 1] per the FeedbackRequest contract.
        score = max(-1.0, min(1.0, float(row["outcome_score"])))
        for mid in memory_ids:
            feedback.append({"memory_id": str(mid), "outcome_score": score})

    if not feedback:
        return 0

    sent = 0
    try:
        from .clients import get_memory_client_async
        client = await get_memory_client_async()
        for item in feedback:
            resp = await client.post("/api/v1/memory/feedback", json=item)
            if resp.status_code in (200, 201):
                sent += 1
        if sent < len(feedback):
            log.warning(
                "Memory outcome feedback: %d/%d entries accepted", sent, len(feedback)
            )
    except Exception:
        log.warning("Failed to send memory outcome feedback", exc_info=True)

    # Update cursor to last processed row (not now() — avoids skipping rows when >500 pending)
    last_created = rows[-1]["created_at"]
    await redis.set(FEEDBACK_CURSOR_KEY, last_created.isoformat())

    return sent


async def effectiveness_loop() -> None:
    """Background loop — recompute every hour and send outcome feedback to memory."""
    while True:
        try:
            await compute_and_publish()
            sent = await _send_memory_feedback()
            if sent:
                log.info("Sent %d outcome feedback entries to memory-service", sent)
        except Exception:
            log.exception("Effectiveness matrix computation failed")
        await asyncio.sleep(3600)
