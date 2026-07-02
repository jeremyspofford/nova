"""
Engram management endpoints — reindex, status, maintenance.

These endpoints manage the memory system's ingestion pipeline from the
orchestrator side (which has access to messages, tasks, intel content).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from uuid import UUID

import httpx
import redis.asyncio as aioredis
from app.auth import AdminDep
from app.config import settings
from app.db import get_pool
from fastapi import APIRouter
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/engrams", tags=["engrams"])

QUEUE_NAME = "memory:ingestion:queue"


# ── Redis helper ─────────────────────────────────────────────────────────────

def _engram_redis_url() -> str:
    """Redis URL targeting db0 (memory-service's database)."""
    return settings.redis_url.rsplit("/", 1)[0] + "/0"


async def _push_to_queue(
    redis: aioredis.Redis,
    raw_text: str,
    source_type: str,
    source_id: str | None = None,
    occurred_at: str | None = None,
    metadata: dict | None = None,
) -> None:
    """Push a single item to the engram ingestion queue."""
    payload = json.dumps({
        "raw_text": raw_text,
        "source_type": source_type,
        "source_id": source_id,
        "occurred_at": occurred_at or datetime.now(timezone.utc).isoformat(),
        "metadata": metadata or {},
    })
    await redis.lpush(QUEUE_NAME, payload)


# ── Request/response models ──────────────────────────────────────────────────

class ReindexRequest(BaseModel):
    sources: list[str] = ["all"]  # "chat", "intel", "tasks", "knowledge", or "all"
    since: datetime | None = None  # Optional: only reindex content after this date
    dry_run: bool = False  # If true, return counts without actually queuing


class ReindexResponse(BaseModel):
    status: str
    queued: dict[str, int]  # source → count of items queued
    total: int
    dry_run: bool
    message: str


class ReindexStatusResponse(BaseModel):
    queue_depth: int
    total_queued: int  # total items queued when reindex started (0 if no active job)
    processed: int  # total_queued - queue_depth
    progress_pct: float  # 0.0 to 100.0
    engram_count: int | None = None
    active: bool  # True if a reindex is in progress
    sources: list[str]  # which sources were selected
    started_at: str | None = None
    message: str


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/reindex", response_model=ReindexResponse)
async def reindex_memory(req: ReindexRequest, _admin: AdminDep):
    """Re-process historical content through the engram ingestion pipeline.

    This pushes past conversations, task outputs, intel content, and/or
    knowledge crawl data to the engram ingestion queue for decomposition
    with the current model and prompts. Useful after changing the
    decomposition model or fixing ingestion bugs.

    Entity resolution prevents duplicate engrams — existing matches are
    updated rather than duplicated.
    """
    pool = get_pool()
    sources = set(req.sources)
    if "all" in sources:
        sources = {"chat", "intel", "tasks", "knowledge"}

    valid_sources = {"chat", "intel", "tasks", "knowledge"}
    invalid = sources - valid_sources
    if invalid:
        return ReindexResponse(
            status="error",
            queued={},
            total=0,
            dry_run=req.dry_run,
            message=f"Invalid sources: {invalid}. Valid: {valid_sources}",
        )

    queued: dict[str, int] = {}

    r = aioredis.from_url(_engram_redis_url(), decode_responses=True)
    try:
        if "chat" in sources:
            queued["chat"] = await _reindex_chat(pool, r, req.since, req.dry_run)

        if "tasks" in sources:
            queued["tasks"] = await _reindex_tasks(pool, r, req.since, req.dry_run)

        if "intel" in sources:
            queued["intel"] = await _reindex_intel(pool, r, req.since, req.dry_run)

        if "knowledge" in sources:
            queued["knowledge"] = await _reindex_knowledge(pool, r, req.since, req.dry_run)
    finally:
        await r.aclose()

    total = sum(queued.values())
    action = "Would queue" if req.dry_run else "Queued"

    # Store job state in Redis so progress survives page refresh
    if not req.dry_run and total > 0:
        job = json.dumps({
            "total_queued": total,
            "sources": list(sources),
            "queued_per_source": queued,
            "started_at": datetime.now(timezone.utc).isoformat(),
        })
        r2 = aioredis.from_url(_engram_redis_url(), decode_responses=True)
        try:
            await r2.set("engram:reindex:job", job)
        finally:
            await r2.aclose()

    return ReindexResponse(
        status="queued" if not req.dry_run else "dry_run",
        queued=queued,
        total=total,
        dry_run=req.dry_run,
        message=f"{action} {total} items for reindex ({', '.join(f'{k}={v}' for k, v in queued.items())})",
    )


@router.get("/reindex/status", response_model=ReindexStatusResponse)
async def reindex_status(_admin: AdminDep):
    """Check the current state of the engram ingestion queue and any active reindex job."""
    r = aioredis.from_url(_engram_redis_url(), decode_responses=True)
    try:
        depth = await r.llen(QUEUE_NAME)
        raw_job = await r.get("engram:reindex:job")
    finally:
        await r.aclose()

    # Parse stored job state (survives page refresh / container restart)
    total_queued = 0
    sources: list[str] = []
    started_at: str | None = None

    if raw_job:
        try:
            job = json.loads(raw_job)
            total_queued = job.get("total_queued", 0)
            sources = job.get("sources", [])
            started_at = job.get("started_at")
        except (json.JSONDecodeError, TypeError):
            pass

    # Active if queue has items — don't rely solely on job key existing
    active = depth > 0

    # If queue has items but no job key (e.g. triggered before tracking code),
    # estimate total from current depth as a lower bound
    if active and total_queued == 0:
        total_queued = depth

    # Clean up completed job
    if depth == 0 and raw_job:
        r2 = aioredis.from_url(_engram_redis_url(), decode_responses=True)
        try:
            await r2.delete("engram:reindex:job")
        finally:
            await r2.aclose()

    processed = max(0, total_queued - depth) if total_queued > 0 else 0
    progress_pct = (processed / total_queued * 100) if total_queued > 0 else 0.0

    # Also check total engram count via memory-service if reachable
    engram_count = None
    try:
        import httpx
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get("http://memory-service:8002/api/v1/engrams/stats")
            if resp.status_code == 200:
                engram_count = resp.json().get("total_engrams")
    except Exception:
        pass

    if active:
        msg = f"Reindexing: {processed}/{total_queued} processed ({depth} remaining)"
    elif depth > 0:
        msg = f"{depth} items pending in ingestion queue."
    else:
        msg = "Queue empty — all items processed."

    return ReindexStatusResponse(
        queue_depth=depth,
        total_queued=total_queued,
        processed=processed,
        progress_pct=round(progress_pct, 1),
        engram_count=engram_count,
        active=active,
        sources=sources,
        started_at=started_at,
        message=msg,
    )


# ── Reindex implementations ─────────────────────────────────────────────────

async def _reindex_chat(pool, redis, since: datetime | None, dry_run: bool) -> int:
    """Re-decompose existing chat-sourced engrams with the current model.

    Chat conversation history is not persisted to PostgreSQL (it lives
    in-memory in the WebSocket handler), so we can't reconstruct raw
    user/assistant pairs. Instead, we re-ingest existing chat engrams
    through the decomposition pipeline so the current (better) model can
    re-classify types (e.g. fact → entity) and extract relationships
    that the original model missed.

    Entity resolution deduplicates — matching engrams get an importance
    boost rather than creating duplicates.
    """
    # Query existing chat engrams from memory-service's DB via its HTTP API
    try:
        import httpx
        params = "?source_type=chat&limit=2000"
        if since:
            params += f"&since={since.isoformat()}"
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"http://memory-service:8002/api/v1/engrams/search{params}")
            if resp.status_code != 200:
                # Fallback: query orchestrator's own DB for the engram count
                # (memory-service may not have a search-by-source endpoint)
                raise httpx.HTTPError("search endpoint not available")
            engrams = resp.json()
    except Exception:
        # Direct DB query against the shared postgres as fallback
        query = """
            SELECT id, content, type, created_at
            FROM engrams
            WHERE source_type = 'chat'
        """
        params_list: list = []
        if since:
            query += " AND created_at >= $1"
            params_list.append(since)
        query += " ORDER BY created_at"
        engrams = [dict(r) for r in await pool.fetch(query, *params_list)]

    if dry_run:
        return len(engrams)

    for eng in engrams:
        content = eng.get("content", "")
        if not content.strip():
            continue
        created = eng.get("created_at")
        occurred = created.isoformat() if hasattr(created, 'isoformat') else str(created) if created else None

        await _push_to_queue(
            redis,
            raw_text=content,
            source_type="chat",
            source_id=str(eng.get("id", "")),
            occurred_at=occurred,
            metadata={"reindex": True, "re_decompose": True},
        )

    log.info("Reindex: queued %d chat engrams for re-decomposition", len(engrams))
    return len(engrams)


async def _reindex_tasks(pool, redis, since: datetime | None, dry_run: bool) -> int:
    """Re-ingest completed task inputs and outputs as episodic memory."""
    query = """
        SELECT id, user_input, output, created_at, completed_at
        FROM tasks
        WHERE status = 'complete'
          AND user_input IS NOT NULL
    """
    params: list = []
    if since:
        query += " AND created_at >= $1"
        params.append(since)
    query += " ORDER BY created_at"

    rows = await pool.fetch(query, *params)

    if dry_run:
        return len(rows)

    for row in rows:
        # Format as a task summary
        output_preview = ""
        if row["output"]:
            out = row["output"]
            if isinstance(out, dict):
                output_preview = json.dumps(out)[:500]
            else:
                output_preview = str(out)[:500]

        raw_text = f"Task request: {row['user_input']}"
        if output_preview:
            raw_text += f"\n\nTask result: {output_preview}"

        await _push_to_queue(
            redis,
            raw_text=raw_text,
            source_type="chat",  # tasks are Nova's own work, treat as chat context
            source_id=str(row["id"]),
            occurred_at=(row["completed_at"] or row["created_at"]).isoformat(),
            metadata={"reindex": True, "source": "task"},
        )

    log.info("Reindex: queued %d task outputs", len(rows))
    return len(rows)


async def _reindex_intel(pool, redis, since: datetime | None, dry_run: bool) -> int:
    """Re-ingest intel content items with the corrected attribution prompt."""
    query = """
        SELECT ici.id, ici.title, ici.body, ici.url, ici.ingested_at,
               if2.name AS feed_name
        FROM intel_content_items ici
        LEFT JOIN intel_feeds if2 ON ici.feed_id = if2.id
        WHERE ici.body IS NOT NULL
          AND ici.body != ''
    """
    params: list = []
    if since:
        query += " AND ici.ingested_at >= $1"
        params.append(since)
    query += " ORDER BY ici.ingested_at"

    rows = await pool.fetch(query, *params)

    if dry_run:
        return len(rows)

    for row in rows:
        title = row["title"] or ""
        body = row["body"] or ""
        raw_text = f"{title}\n\n{body}" if title else body

        await _push_to_queue(
            redis,
            raw_text=raw_text,
            source_type="intel",
            source_id=str(row["id"]),
            occurred_at=row["ingested_at"].isoformat(),
            metadata={
                "reindex": True,
                "feed_name": row["feed_name"] or "",
                "url": row["url"] or "",
            },
        )

    log.info("Reindex: queued %d intel items", len(rows))
    return len(rows)


async def _reindex_knowledge(pool, redis, since: datetime | None, dry_run: bool) -> int:
    """Re-ingest knowledge-sourced engrams for re-decomposition.

    The knowledge-worker pushes crawled content directly to the engram
    queue — raw page content is not stored in the orchestrator DB. Like
    chat, we re-process existing knowledge-sourced engrams through the
    current model for better type classification.

    For a full re-crawl, use "Crawl Now" on individual sources in the
    Sources page.
    """
    query = """
        SELECT id, content, type, created_at
        FROM engrams
        WHERE source_type = 'knowledge'
    """
    params_list: list = []
    if since:
        query += " AND created_at >= $1"
        params_list.append(since)
    query += " ORDER BY created_at"

    try:
        rows = await pool.fetch(query, *params_list)
    except Exception:
        return 0

    if dry_run:
        return len(rows)

    for row in rows:
        content = row["content"]
        if not content.strip():
            continue
        await _push_to_queue(
            redis,
            raw_text=content,
            source_type="knowledge",
            source_id=str(row["id"]),
            occurred_at=row["created_at"].isoformat() if row["created_at"] else None,
            metadata={"reindex": True, "re_decompose": True},
        )

    log.info("Reindex: queued %d knowledge engrams for re-decomposition", len(rows))
    return len(rows)


@router.post("/sources/{source_id}/redecompose")
async def redecompose_source(source_id: UUID, _admin: AdminDep):
    """Re-decompose a source through the current ingestion pipeline.

    Fetches stored content from memory-service and re-queues for ingestion.
    Useful after decomposition prompt improvements.
    """
    async with httpx.AsyncClient(timeout=10) as client:
        content_resp = await client.get(
            f"{settings.memory_service_url}/api/v1/engrams/sources/{source_id}/content"
        )
        if content_resp.status_code != 200:
            return {"error": "Source content not available for re-decomposition"}
        content = content_resp.json().get("content")

        meta_resp = await client.get(
            f"{settings.memory_service_url}/api/v1/engrams/sources/{source_id}"
        )
        meta = meta_resp.json() if meta_resp.status_code == 200 else {}

    if not content:
        return {"error": "No stored content — URI-only sources cannot be re-decomposed"}

    r = aioredis.from_url(_engram_redis_url(), decode_responses=True)
    try:
        await _push_to_queue(
            r,
            raw_text=content,
            source_type=meta.get("source_kind", "manual_paste"),
            source_id=str(source_id),
            metadata={"redecompose": True, "source_ref_id": str(source_id)},
        )
    finally:
        await r.aclose()

    return {"status": "queued", "source_id": str(source_id)}
