"""Knowledge source and credential CRUD endpoints."""
from __future__ import annotations

import base64
import json
import logging
import os
from datetime import datetime, timezone
from uuid import UUID

import redis.asyncio as aioredis
from app.auth import AdminDep, UserDep
from app.config import settings
from app.db import get_pool
from fastapi import APIRouter, HTTPException, Query
from nova_worker_common.credentials.builtin import BuiltinCredentialProvider
from nova_worker_common.url_validator import validate_url
from pydantic import BaseModel

log = logging.getLogger(__name__)

knowledge_router = APIRouter(tags=["knowledge"])

DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001"

VALID_SOURCE_TYPES = {
    "web_crawl", "github_profile", "gitlab_profile",
    "twitter", "mastodon", "bluesky", "reddit_profile",
    "manual_import",
}

VALID_STATUSES = {"active", "paused", "error", "restricted"}
VALID_SCOPES = {"personal", "shared"}

# ── Engram Redis client (db 0 — memory-service's queue) ─────────────────────

_ingestion_redis: aioredis.Redis | None = None


def _get_ingestion_redis() -> aioredis.Redis:
    """Get a Redis client for the memory ingestion queue (memory-service's DB 0)."""
    global _ingestion_redis
    if _ingestion_redis is None:
        base_url = settings.redis_url.rsplit("/", 1)[0]  # strip /2
        _ingestion_redis = aioredis.from_url(f"{base_url}/0", decode_responses=True)
    return _ingestion_redis


async def close_ingestion_redis() -> None:
    """Close the ingestion-queue Redis client. Call from orchestrator lifespan shutdown."""
    global _ingestion_redis
    if _ingestion_redis is not None:
        await _ingestion_redis.aclose()
        _ingestion_redis = None


# ── Request / Response models ────────────────────────────────────────────────


class CreateSourceRequest(BaseModel):
    name: str
    url: str
    source_type: str
    scope: str = "personal"
    crawl_config: dict | None = None
    credential_id: str | None = None


class UpdateSourceRequest(BaseModel):
    name: str | None = None
    url: str | None = None
    status: str | None = None
    scope: str | None = None
    crawl_config: dict | None = None
    credential_id: str | None = None


class SourceStatusUpdate(BaseModel):
    status: str
    last_crawl_at: str | None = None
    last_crawl_summary: dict | None = None
    error_count: int | None = None


class CreateCredentialRequest(BaseModel):
    label: str
    credential_data: str
    scopes: dict | None = None


class PasteContentRequest(BaseModel):
    content: str


class CrawlLogRequest(BaseModel):
    tenant_id: str | None = None
    source_id: str
    started_at: str | None = None
    finished_at: str | None = None
    pages_visited: int = 0
    pages_skipped: int = 0
    engrams_created: int = 0
    engrams_updated: int = 0
    llm_calls_made: int = 0
    status: str = "running"
    error_detail: str | None = None
    crawl_tree: dict | None = None


# ── Source endpoints ─────────────────────────────────────────────────────────


@knowledge_router.get("/api/v1/knowledge/sources")
async def list_sources(
    _user: UserDep,
    scope: str | None = Query(default=None),
    status: str | None = Query(default=None),
):
    """List knowledge sources for the caller's tenant. FC-001: filters by
    _user.tenant_id so users never see other tenants' sources."""
    pool = get_pool()
    conditions: list[str] = ["tenant_id = $1"]
    values: list = [UUID(_user.tenant_id)]
    idx = 2

    if scope is not None:
        conditions.append(f"scope = ${idx}")
        values.append(scope)
        idx += 1
    if status is not None:
        conditions.append(f"status = ${idx}")
        values.append(status)
        idx += 1

    where = " WHERE " + " AND ".join(conditions)
    query = f"SELECT * FROM knowledge_sources{where} ORDER BY created_at DESC"

    async with pool.acquire() as conn:
        rows = await conn.fetch(query, *values)
    return [dict(r) for r in rows]


@knowledge_router.post("/api/v1/knowledge/sources", status_code=201)
async def create_source(req: CreateSourceRequest, _user: UserDep):
    """Create a new knowledge source. Validates URL against SSRF blocklist."""
    # SSRF validation
    error = validate_url(req.url)
    if error:
        raise HTTPException(status_code=400, detail=f"Invalid URL: {error}")

    # Validate source_type against CHECK constraint values
    if req.source_type not in VALID_SOURCE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid source_type '{req.source_type}'. Must be one of: {', '.join(sorted(VALID_SOURCE_TYPES))}",
        )

    # Validate scope
    if req.scope not in VALID_SCOPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid scope '{req.scope}'. Must be one of: {', '.join(sorted(VALID_SCOPES))}",
        )

    tenant_id = UUID(_user.tenant_id)
    cred_id = UUID(req.credential_id) if req.credential_id else None

    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO knowledge_sources
                (tenant_id, name, url, source_type, scope, crawl_config, credential_id)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
            RETURNING *
            """,
            tenant_id, req.name, req.url, req.source_type, req.scope,
            json.dumps(req.crawl_config or {}), cred_id,
        )
    log.info("Knowledge source created: %s — %s (tenant %s)", row["id"], req.name, tenant_id)
    return dict(row)


@knowledge_router.get("/api/v1/knowledge/sources/{source_id}")
async def get_source(source_id: UUID, _user: UserDep):
    """Get source detail with recent crawl history. Tenant-scoped — returns
    404 (not 403) for cross-tenant lookups so we don't leak existence."""
    tenant_id = UUID(_user.tenant_id)
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM knowledge_sources WHERE id = $1 AND tenant_id = $2",
            source_id, tenant_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Source not found")

        crawl_history = await conn.fetch(
            """
            SELECT * FROM knowledge_crawl_log
            WHERE source_id = $1 AND tenant_id = $2
            ORDER BY started_at DESC
            LIMIT 10
            """,
            source_id, tenant_id,
        )

    source = dict(row)
    source["crawl_history"] = [dict(c) for c in crawl_history]
    return source


@knowledge_router.patch("/api/v1/knowledge/sources/{source_id}")
async def update_source(source_id: UUID, req: UpdateSourceRequest, _user: UserDep):
    """Update source config. If URL changes, re-validates SSRF."""
    updates = req.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    # If URL is changing, re-validate
    if "url" in updates:
        error = validate_url(updates["url"])
        if error:
            raise HTTPException(status_code=400, detail=f"Invalid URL: {error}")

    # Validate status if provided
    if "status" in updates and updates["status"] not in VALID_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status '{updates['status']}'. Must be one of: {', '.join(sorted(VALID_STATUSES))}",
        )

    # Validate scope if provided
    if "scope" in updates and updates["scope"] not in VALID_SCOPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid scope '{updates['scope']}'. Must be one of: {', '.join(sorted(VALID_SCOPES))}",
        )

    # Convert credential_id string to UUID if present
    if "credential_id" in updates and updates["credential_id"] is not None:
        updates["credential_id"] = UUID(updates["credential_id"])

    # Serialize crawl_config to JSON string for asyncpg JSONB
    if "crawl_config" in updates and updates["crawl_config"] is not None:
        updates["crawl_config"] = json.dumps(updates["crawl_config"])

    set_parts = []
    values = []
    for i, (key, val) in enumerate(updates.items(), start=1):
        if key == "crawl_config":
            set_parts.append(f"{key} = ${i}::jsonb")
        else:
            set_parts.append(f"{key} = ${i}")
        values.append(val)

    values.append(source_id)
    values.append(UUID(_user.tenant_id))
    set_clause = ", ".join(set_parts)
    id_idx = len(values) - 1
    tenant_idx = len(values)

    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE knowledge_sources SET {set_clause}, updated_at = NOW() "
            f"WHERE id = ${id_idx} AND tenant_id = ${tenant_idx} RETURNING *",
            *values,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Source not found")
    log.info("Knowledge source updated: %s", source_id)
    return dict(row)


@knowledge_router.delete("/api/v1/knowledge/sources/{source_id}", status_code=204)
async def delete_source(source_id: UUID, _user: UserDep):
    """Delete a knowledge source. Tenant-scoped so users can't delete other
    tenants' sources by guessing UUIDs. Cascades handle crawl_log/page_cache."""
    pool = get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM knowledge_sources WHERE id = $1 AND tenant_id = $2",
            source_id, UUID(_user.tenant_id),
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Source not found")
    log.info("Knowledge source deleted: %s", source_id)


@knowledge_router.post("/api/v1/knowledge/sources/{source_id}/crawl")
async def trigger_crawl(source_id: UUID, _user: UserDep):
    """Trigger an immediate crawl. Activates paused sources. Tenant-scoped."""
    tenant_id = UUID(_user.tenant_id)
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, status FROM knowledge_sources WHERE id = $1 AND tenant_id = $2",
            source_id, tenant_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Source not found")

        # If paused, activate it
        if row["status"] == "paused":
            await conn.execute(
                "UPDATE knowledge_sources SET status = 'active', updated_at = NOW() "
                "WHERE id = $1 AND tenant_id = $2",
                source_id, tenant_id,
            )

    log.info("Crawl triggered for knowledge source: %s", source_id)
    return {"message": "Crawl triggered"}


@knowledge_router.patch("/api/v1/knowledge/sources/{source_id}/status")
async def update_source_status(
    source_id: UUID, req: SourceStatusUpdate, _admin: AdminDep,
):
    """Update source status (called by knowledge-worker)."""
    if req.status not in VALID_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status '{req.status}'. Must be one of: {', '.join(sorted(VALID_STATUSES))}",
        )

    set_parts = ["status = $1"]
    values: list = [req.status]
    idx = 2

    if req.last_crawl_at is not None:
        set_parts.append(f"last_crawl_at = ${idx}::timestamptz")
        values.append(datetime.fromisoformat(req.last_crawl_at.replace("Z", "+00:00")))
        idx += 1

    if req.last_crawl_summary is not None:
        set_parts.append(f"last_crawl_summary = ${idx}::jsonb")
        values.append(json.dumps(req.last_crawl_summary))
        idx += 1

    if req.error_count is not None:
        set_parts.append(f"error_count = ${idx}")
        values.append(req.error_count)
        idx += 1

    values.append(source_id)
    set_clause = ", ".join(set_parts)

    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE knowledge_sources SET {set_clause}, updated_at = NOW() WHERE id = ${idx} RETURNING *",
            *values,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Source not found")
    log.info("Knowledge source status updated: %s -> %s", source_id, req.status)
    return dict(row)


# ── Credential endpoints ────────────────────────────────────────────────────


@knowledge_router.get("/api/v1/knowledge/credentials")
async def list_credentials(_admin: AdminDep):
    """List credentials (metadata only — NEVER returns encrypted data)."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, label, provider, scopes, last_validated_at, created_at
            FROM knowledge_credentials
            ORDER BY created_at DESC
            """
        )
    return [dict(r) for r in rows]


@knowledge_router.post("/api/v1/knowledge/credentials", status_code=201)
async def create_credential(req: CreateCredentialRequest, _admin: AdminDep):
    """Store a new encrypted credential. NEVER returns encrypted data or plaintext."""
    master_key = os.getenv("CREDENTIAL_MASTER_KEY", "")
    if not master_key:
        raise HTTPException(
            status_code=500,
            detail="CREDENTIAL_MASTER_KEY not configured — cannot encrypt credentials",
        )

    try:
        provider = BuiltinCredentialProvider(master_key)
        encrypted = provider.encrypt(DEFAULT_TENANT_ID, req.credential_data)
    except Exception as e:
        log.error("Credential encryption failed: %s", e)
        raise HTTPException(status_code=500, detail="Credential encryption failed")

    tenant_id = UUID(DEFAULT_TENANT_ID)
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO knowledge_credentials (tenant_id, label, encrypted_data, scopes)
            VALUES ($1, $2, $3, $4::jsonb)
            RETURNING id, label, provider, scopes, created_at
            """,
            tenant_id, req.label, encrypted, json.dumps(req.scopes) if req.scopes else None,
        )

        # Audit trail
        await conn.execute(
            """
            INSERT INTO knowledge_credential_audit
                (credential_id, tenant_id, action, actor)
            VALUES ($1, $2, 'store', 'dashboard')
            """,
            row["id"], tenant_id,
        )

    log.info("Credential stored: %s — %s", row["id"], req.label)
    return dict(row)


@knowledge_router.delete("/api/v1/knowledge/credentials/{credential_id}", status_code=204)
async def delete_credential(credential_id: UUID, _admin: AdminDep):
    """Delete a credential. ON DELETE SET NULL handles source references."""
    tenant_id = UUID(DEFAULT_TENANT_ID)
    pool = get_pool()
    async with pool.acquire() as conn:
        # Audit before deletion (CASCADE will delete audit entries too,
        # so log the delete action first)
        await conn.execute(
            """
            INSERT INTO knowledge_credential_audit
                (credential_id, tenant_id, action, actor)
            VALUES ($1, $2, 'delete', 'dashboard')
            """,
            credential_id, tenant_id,
        )

        result = await conn.execute(
            "DELETE FROM knowledge_credentials WHERE id = $1", credential_id,
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Credential not found")
    log.info("Credential deleted: %s", credential_id)


@knowledge_router.post("/api/v1/knowledge/credentials/{credential_id}/validate")
async def validate_credential(credential_id: UUID, _admin: AdminDep):
    """Trigger credential validation (updates last_validated_at)."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE knowledge_credentials
            SET last_validated_at = NOW()
            WHERE id = $1
            RETURNING id, label, provider, scopes, last_validated_at, created_at
            """,
            credential_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Credential not found")

    # Audit the validation
    tenant_id = UUID(DEFAULT_TENANT_ID)
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO knowledge_credential_audit
                (credential_id, tenant_id, action, actor)
            VALUES ($1, $2, 'validate', 'dashboard')
            """,
            credential_id, tenant_id,
        )

    log.info("Credential validated: %s", credential_id)
    return dict(row)


@knowledge_router.get("/api/v1/knowledge/credentials/{credential_id}/retrieve")
async def retrieve_credential(credential_id: UUID, _admin: AdminDep):
    """Retrieve encrypted credential data for service-to-service decryption.

    AdminDep-only — intended for knowledge-worker to fetch and decrypt locally.
    Returns base64-encoded encrypted bytes (JSON can't transport raw BYTEA).
    """
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT encrypted_data, tenant_id FROM knowledge_credentials WHERE id = $1",
            credential_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Credential not found")

        # Audit trail — log every retrieval
        await conn.execute(
            """
            INSERT INTO knowledge_credential_audit
                (credential_id, tenant_id, action, actor)
            VALUES ($1, $2, 'retrieve', 'knowledge-worker')
            """,
            credential_id, row["tenant_id"],
        )

    log.info("Credential retrieved (encrypted): %s", credential_id)
    return {
        "encrypted_data": base64.b64encode(row["encrypted_data"]).decode("ascii"),
        "tenant_id": str(row["tenant_id"]),
    }


# ── Import endpoints ────────────────────────────────────────────────────────


@knowledge_router.post("/api/v1/knowledge/sources/{source_id}/paste")
async def paste_content(source_id: UUID, req: PasteContentRequest, _user: UserDep):
    """Manual content paste — pushes to the memory ingestion queue. Tenant-scoped."""
    tenant_id = _user.tenant_id
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM knowledge_sources WHERE id = $1 AND tenant_id = $2",
            source_id, UUID(tenant_id),
        )
        if not row:
            raise HTTPException(status_code=404, detail="Source not found")

    try:
        redis = _get_ingestion_redis()
        payload = json.dumps({
            "raw_text": req.content,
            "source_type": "knowledge",
            "source_id": str(source_id),
            "metadata": {"import_method": "paste"},
            "tenant_id": tenant_id,
        })
        await redis.lpush("memory:ingestion:queue", payload)
    except Exception as e:
        log.error("Failed to push to ingestion queue: %s", e)
        raise HTTPException(status_code=500, detail="Failed to submit content for ingestion")

    log.info("Paste content submitted for source: %s", source_id)
    return {"message": "Content submitted for ingestion"}


# ── Stats endpoint ──────────────────────────────────────────────────────────


@knowledge_router.get("/api/v1/knowledge/stats")
async def knowledge_stats(_user: UserDep):
    """Aggregate knowledge stats for the caller's tenant only."""
    tenant_id = UUID(_user.tenant_id)
    pool = get_pool()
    async with pool.acquire() as conn:
        status_rows = await conn.fetch(
            "SELECT status, COUNT(*) AS count FROM knowledge_sources"
            " WHERE tenant_id = $1 GROUP BY status",
            tenant_id,
        )
        total_credentials = await conn.fetchval(
            "SELECT COUNT(*) FROM knowledge_credentials WHERE tenant_id = $1",
            tenant_id,
        )
        latest_crawl = await conn.fetchval(
            "SELECT MAX(last_crawl_at) FROM knowledge_sources WHERE tenant_id = $1",
            tenant_id,
        )

    status_map = {r["status"]: r["count"] for r in status_rows}
    return {
        "sources_active": status_map.get("active", 0),
        "sources_paused": status_map.get("paused", 0),
        "sources_error": status_map.get("error", 0),
        "sources_restricted": status_map.get("restricted", 0),
        "sources_total": sum(status_map.values()) if status_map else 0,
        "total_credentials": total_credentials or 0,
        "latest_crawl_at": latest_crawl.isoformat() if latest_crawl else None,
    }


# ── Crawl log endpoint (called by knowledge-worker) ────────────────────────


@knowledge_router.post("/api/v1/knowledge/crawl-log", status_code=201)
async def create_crawl_log(req: CrawlLogRequest, _admin: AdminDep):
    """Store crawl results from knowledge-worker."""
    tenant_id = UUID(req.tenant_id or DEFAULT_TENANT_ID)
    source_id = UUID(req.source_id)

    started = None
    if req.started_at:
        try:
            started = datetime.fromisoformat(req.started_at.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            started = datetime.now(timezone.utc)

    finished = None
    if req.finished_at:
        try:
            finished = datetime.fromisoformat(req.finished_at.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            pass

    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO knowledge_crawl_log
                (tenant_id, source_id, started_at, finished_at,
                 pages_visited, pages_skipped, engrams_created, engrams_updated,
                 llm_calls_made, status, error_detail, crawl_tree)
            VALUES ($1, $2, COALESCE($3, NOW()), $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
            RETURNING *
            """,
            tenant_id, source_id, started, finished,
            req.pages_visited, req.pages_skipped, req.engrams_created, req.engrams_updated,
            req.llm_calls_made, req.status, req.error_detail,
            json.dumps(req.crawl_tree) if req.crawl_tree else None,
        )
    log.info("Crawl log stored for source %s: %s", source_id, req.status)
    return dict(row)
