"""HTTP endpoints backing the dashboard Capture page."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

import redis.asyncio as aioredis
from app.config import settings
from app.db import get_pool
from fastapi import APIRouter, Query

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/capture", tags=["capture"])

# ── Redis db0 client (memory-service's queue DB, also used by bridge) ────────

_capture_redis: aioredis.Redis | None = None


def _get_capture_redis() -> aioredis.Redis:
    """Get a Redis client for db0 (bridge-maintained dropped counters)."""
    global _capture_redis
    if _capture_redis is None:
        base_url = settings.redis_url.rsplit("/", 1)[0]  # strip /2
        _capture_redis = aioredis.from_url(f"{base_url}/0", decode_responses=True)
    return _capture_redis


async def close_capture_redis() -> None:
    """Close the capture Redis client. Call from orchestrator lifespan shutdown."""
    global _capture_redis
    if _capture_redis is not None:
        await _capture_redis.aclose()
        _capture_redis = None


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.get("/sessions")
async def list_sessions(limit: int = Query(50, ge=1, le=500)):
    """List screenpipe capture sessions, most recent first."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, source_kind, uri, title, metadata, trust_score, ingested_at
              FROM sources
             WHERE source_kind = 'screenpipe'
             ORDER BY ingested_at DESC
             LIMIT $1
            """,
            limit,
        )
    return {
        "sessions": [
            {
                "id": str(r["id"]),
                "source_kind": r["source_kind"],
                "uri": r["uri"],
                "title": r["title"],
                "metadata": (
                    r["metadata"]
                    if isinstance(r["metadata"], dict)
                    else (json.loads(r["metadata"]) if r["metadata"] else {})
                ),
                "trust_score": r["trust_score"],
                "ingested_at": r["ingested_at"].isoformat(),
            }
            for r in rows
        ]
    }


@router.get("/today-stats")
async def today_stats():
    """Aggregate capture stats for today (UTC): session count, seconds, dropped, top apps."""
    today_start = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT metadata, ingested_at
              FROM sources
             WHERE source_kind = 'screenpipe' AND ingested_at >= $1
            """,
            today_start,
        )

    sessions_count = len(rows)
    by_app: dict[str, float] = {}
    captured_seconds = 0.0

    for r in rows:
        meta_raw = r["metadata"]
        meta = (
            meta_raw
            if isinstance(meta_raw, dict)
            else (json.loads(meta_raw) if meta_raw else {})
        )
        try:
            start = datetime.fromisoformat(
                meta["captured_at_start"].replace("Z", "+00:00")
            )
            end = datetime.fromisoformat(
                meta["captured_at_end"].replace("Z", "+00:00")
            )
            secs = (end - start).total_seconds()
            captured_seconds += secs
            app = meta.get("app", "unknown")
            by_app[app] = by_app.get(app, 0.0) + secs
        except (KeyError, ValueError, TypeError):
            continue

    top_apps = sorted(by_app.items(), key=lambda x: x[1], reverse=True)[:5]

    # Read today's dropped count from bridge-maintained Redis hash (db0)
    today_key = f"nova:capture:dropped:{today_start.strftime('%Y-%m-%d')}"
    dropped_total = 0
    try:
        redis = _get_capture_redis()
        raw = await redis.hgetall(today_key)
        for v in raw.values():
            try:
                dropped_total += int(v)
            except (TypeError, ValueError):
                continue
    except Exception as exc:
        logger.warning("failed to read dropped counter from redis: %s", exc)

    return {
        "sessions_count": sessions_count,
        "captured_seconds": int(captured_seconds),
        "dropped_count": dropped_total,
        "top_apps": [{"app": a, "captured_seconds": int(s)} for a, s in top_apps],
    }
