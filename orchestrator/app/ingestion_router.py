"""Generalized HTTP ingestion — one authenticated door into Nova's memory.

Any external application (capture tool, meeting exporter, CLI, webhook)
POSTs a payload to /api/v1/ingest; the endpoint validates, authenticates,
rate-limits, applies the source's denylist, and LPUSHes onto
memory:ingestion:queue (Redis db0) — the exact queue chat/intel/knowledge/
cortex already produce into. The memory-service consumer is untouched; the
payload matches its real contract (raw_text, source_type, source_id,
session_id, occurred_at, metadata, tenant_id — see memory-service
app/ingestion.py:_dispatch_event). Provenance that the consumer does not
consume directly (source_name/title/uri, per-source trust) travels inside
metadata; the OKF backend derives trust from source_type today.

Replaces the per-source bridge pattern (screenpipe-bridge, removed
2026-07-06). Deliberately NOT an MCP surface: MCP is request/response tool
invocation — push ingestion wants plain HTTP and backpressure.

Auth, two ways:
  - per-source token: Authorization: Bearer sk-nova-ingest-<...> minted at
    registration (SHA-256 stored, shown exactly once)
  - operator credentials: admin secret or admin JWT (require_admin)
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import secrets
import time
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

import redis.asyncio as aioredis
from app.auth import AdminDep, require_admin
from app.config import settings
from app.db import get_pool
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/ingest", tags=["ingestion"])

_QUEUE_KEY = "memory:ingestion:queue"
_TOKEN_PREFIX = "sk-nova-ingest-"
_DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001"

# ── db0 queue client (memory-service's queue db) ────────────────────────────

_ingestion_redis: aioredis.Redis | None = None


def _get_queue_redis() -> aioredis.Redis:
    global _ingestion_redis
    if _ingestion_redis is None:
        base = settings.redis_url.rsplit("/", 1)[0]
        _ingestion_redis = aioredis.from_url(f"{base}/0", decode_responses=True)
    return _ingestion_redis


async def close_ingestion_redis() -> None:
    """Called from the lifespan shutdown path (CLAUDE.md: every get_redis
    needs a matching close, or connections leak across restarts)."""
    global _ingestion_redis
    if _ingestion_redis is not None:
        await _ingestion_redis.aclose()
        _ingestion_redis = None


# ── Backpressure threshold (runtime-configurable, cached) ───────────────────

_DEPTH_CACHE_TTL = 3.0
_depth_cache: tuple[int, float] = (10_000, 0.0)


async def _max_queue_depth() -> int:
    """ingestion.max_queue_depth from platform_config; default 10_000."""
    global _depth_cache
    value, at = _depth_cache
    now = time.monotonic()
    if now - at < _DEPTH_CACHE_TTL:
        return value
    depth = 10_000
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            raw = await conn.fetchval(
                "SELECT value #>> '{}' FROM platform_config WHERE key = 'ingestion.max_queue_depth'"
            )
        if raw:
            depth = max(0, int(str(raw).strip('"')))
    except Exception:
        pass  # DB hiccup — keep the default rather than failing ingestion
    _depth_cache = (depth, now)
    return depth


# ── Source resolution + auth ────────────────────────────────────────────────

async def _source_by_token_hash(token_hash: str) -> dict | None:
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM ingestion_sources WHERE api_key_hash = $1 AND active",
            token_hash,
        )
    return dict(row) if row else None


async def _source_by_name(name: str) -> dict | None:
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM ingestion_sources WHERE name = $1 AND active", name
        )
    return dict(row) if row else None


async def ingest_auth(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_admin_secret: Annotated[str | None, Header(alias="X-Admin-Secret")] = None,
) -> dict | None:
    """Authenticate a push. Returns the registered source row for token
    callers, None for operator-credential callers (admin secret / admin JWT).
    """
    if authorization and authorization.startswith(f"Bearer {_TOKEN_PREFIX}"):
        token = authorization[7:]
        source = await _source_by_token_hash(hashlib.sha256(token.encode()).hexdigest())
        if source is None:
            raise HTTPException(status_code=401, detail="Invalid or revoked ingestion token")
        return source
    # Fall through to operator credentials — require_admin raises 401/403/429.
    await require_admin(request, authorization=authorization, x_admin_secret=x_admin_secret)
    return None


# ── Denylist (bridge semantics, source-agnostic) ────────────────────────────

def _matches_denylist(metadata: dict, source: dict) -> str | None:
    """Return the matched rule (for the response) or None."""
    def _list(key: str) -> list[str]:
        raw = source.get(key)
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except ValueError:
                raw = []
        return [str(x).lower() for x in (raw or [])]

    app_name = str(metadata.get("app", "")).lower()
    url = str(metadata.get("url", "")).lower()
    title = str(metadata.get("window_title", "")).lower()

    if app_name and app_name in _list("denylist_apps"):
        return f"app:{app_name}"
    for pat in _list("denylist_url_patterns"):
        if pat and pat in url:
            return f"url:{pat}"
    for pat in _list("denylist_window_titles"):
        if pat and pat in title:
            return f"window_title:{pat}"
    return None


# ── Rate limit (sliding window per source, orchestrator redis) ──────────────

async def _rate_limited(source_name: str, limit_per_minute: int) -> bool:
    from app.store import get_redis

    window = int(time.time() / 60)
    key = f"nova:ingest:ratelimit:{source_name}:{window}"
    try:
        redis = get_redis()
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, 120)
        return count > limit_per_minute
    except Exception:
        return False  # never block ingestion on rate-limiter infra failure


# ── The endpoint ────────────────────────────────────────────────────────────

class IngestPayload(BaseModel):
    raw_text: str
    source_type: str = "external"
    source_name: str = "external"
    source_title: str | None = None
    source_uri: str | None = None
    source_id: str | None = None
    session_id: str | None = None
    occurred_at: str | None = None
    metadata: dict = Field(default_factory=dict)
    tenant_id: str | None = None


@router.post("")
async def ingest(
    payload: IngestPayload,
    source: Annotated[dict | None, Depends(ingest_auth)],
):
    raw_text = payload.raw_text.strip()
    if not raw_text:
        raise HTTPException(status_code=400, detail="raw_text is required")

    # Token callers ARE their registered source; operator pushes may name one.
    if source is None and payload.source_name:
        source = await _source_by_name(payload.source_name)

    source_name = (source or {}).get("name") or payload.source_name
    source_type = (source or {}).get("source_type") or payload.source_type
    trust = (source or {}).get("trust")
    rate_limit = int((source or {}).get("rate_limit_per_minute") or 120)

    if await _rate_limited(source_name, rate_limit):
        raise HTTPException(
            status_code=429,
            detail=f"Ingestion rate limit for '{source_name}' exceeded ({rate_limit}/min)",
        )

    if source is not None:
        matched = _matches_denylist(payload.metadata, source)
        if matched:
            return {"queued": False, "reason": f"denylist ({matched})"}

    # Backpressure: refuse to grow the queue unbounded.
    depth_limit = await _max_queue_depth()
    queue = _get_queue_redis()
    depth = await queue.llen(_QUEUE_KEY)
    if depth >= depth_limit:
        raise HTTPException(
            status_code=503,
            detail=f"Ingestion queue saturated ({depth} >= {depth_limit}) — retry later",
            headers={"Retry-After": "30"},
        )

    metadata = dict(payload.metadata)
    metadata.setdefault("source_name", source_name)
    if payload.source_title:
        metadata.setdefault("source_title", payload.source_title)
    if payload.source_uri:
        metadata.setdefault("source_uri", payload.source_uri)
    if trust is not None:
        metadata.setdefault("source_trust", float(trust))

    # EXACT consumer contract — memory-service app/ingestion.py:_dispatch_event.
    message = {
        "raw_text": raw_text,
        "source_type": source_type,
        "source_id": payload.source_id,
        "session_id": payload.session_id or f"ingest-{source_name}",
        "occurred_at": payload.occurred_at or datetime.now(timezone.utc).isoformat(),
        "metadata": metadata,
        "tenant_id": payload.tenant_id or _DEFAULT_TENANT,
    }
    await queue.lpush(_QUEUE_KEY, json.dumps(message))

    if source is not None:
        asyncio.create_task(_touch_source(source["id"]))

    return {"queued": True, "source": source_name, "queue_depth": depth + 1}


async def _touch_source(source_id) -> None:
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE ingestion_sources SET last_ingested_at = NOW() WHERE id = $1",
                source_id,
            )
    except Exception:
        logger.debug("last_ingested_at touch failed", exc_info=True)


# ── Source registration (admin-only) ────────────────────────────────────────

class SourceCreate(BaseModel):
    name: str
    source_type: str = "external"
    trust: float = 0.70
    rate_limit_per_minute: int = 120
    denylist_apps: list[str] = Field(default_factory=list)
    denylist_url_patterns: list[str] = Field(default_factory=list)
    denylist_window_titles: list[str] = Field(default_factory=list)


@router.post("/sources", status_code=201)
async def register_source(req: SourceCreate, _admin: AdminDep):
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")

    token = _TOKEN_PREFIX + secrets.token_urlsafe(24)
    token_hash = hashlib.sha256(token.encode()).hexdigest()

    pool = get_pool()
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """INSERT INTO ingestion_sources
                       (name, source_type, trust, api_key_hash, rate_limit_per_minute,
                        denylist_apps, denylist_url_patterns, denylist_window_titles)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                   RETURNING id, name, source_type, trust, rate_limit_per_minute,
                             active, created_at""",
                name, req.source_type, req.trust, token_hash, req.rate_limit_per_minute,
                req.denylist_apps, req.denylist_url_patterns, req.denylist_window_titles,
            )
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(status_code=409, detail=f"Source '{name}' already exists")
        raise

    out = dict(row)
    out["created_at"] = out["created_at"].isoformat()
    out["id"] = str(out["id"])
    # Shown exactly once — only the hash is stored.
    out["token"] = token
    return out


@router.get("/sources")
async def list_sources(_admin: AdminDep):
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, name, source_type, trust, rate_limit_per_minute,
                      api_key_hash IS NOT NULL AS has_token, active,
                      created_at, last_ingested_at
               FROM ingestion_sources ORDER BY created_at"""
        )
    return [
        {
            **dict(r),
            "id": str(r["id"]),
            "created_at": r["created_at"].isoformat(),
            "last_ingested_at": r["last_ingested_at"].isoformat() if r["last_ingested_at"] else None,
        }
        for r in rows
    ]


@router.delete("/sources/{source_id}", status_code=204)
async def revoke_source(source_id: UUID, _admin: AdminDep):
    pool = get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "UPDATE ingestion_sources SET active = FALSE, api_key_hash = NULL WHERE id = $1",
            source_id,
        )
    if result.endswith("0"):
        raise HTTPException(status_code=404, detail="Source not found")
