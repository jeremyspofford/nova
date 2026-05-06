"""
Source provenance — the backing store for engram knowledge.

Every engram traces back to a source: a conversation, web page, intel feed,
manual paste, task output, etc. Sources store raw content (hybrid: DB for
small, filesystem for large, URI for re-fetchable) and metadata.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime
from pathlib import Path
from uuid import UUID

from app.config import settings
from app.http_client import get_http_client
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)

# Trust defaults by source kind
DEFAULT_TRUST: dict[str, float] = {
    "chat": 0.95,
    "manual_paste": 0.90,
    "task_output": 0.85,
    "knowledge_crawl": 0.70,
    "intel_feed": 0.70,
    "pipeline_extraction": 0.80,
    "consolidation": 0.85,
    "api_response": 0.50,
    "screenpipe": 0.80,
}

# Sources larger than this threshold are stored on filesystem
CONTENT_SIZE_THRESHOLD = 100_000  # 100 KB

# Filesystem root for large source content
SOURCES_DIR = Path("/data/sources")


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


_DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001"


async def find_or_create_source(
    session: AsyncSession,
    *,
    source_kind: str,
    title: str | None = None,
    uri: str | None = None,
    content: str | None = None,
    trust_score: float | None = None,
    author: str | None = None,
    published_at: datetime | None = None,
    completeness: str = "complete",
    coverage_notes: str | None = None,
    metadata: dict | None = None,
    tenant_id: str = _DEFAULT_TENANT,
) -> UUID:
    """Find existing source by (tenant_id, content_hash) or (tenant_id, URI, kind),
    or create a new one.

    Returns the source UUID. Does NOT call session.commit() — relies on
    the caller's get_db() context manager for auto-commit. tenant_id ensures
    the same URI can legitimately exist for two tenants without collision.
    """
    c_hash = _content_hash(content) if content else None
    trust = (
        trust_score if trust_score is not None else DEFAULT_TRUST.get(source_kind, 0.7)
    )

    # Dedup: check content hash first, then URI — scoped per tenant so two
    # tenants reading the same article each get their own source row.
    if c_hash:
        row = await session.execute(
            text(
                "SELECT id FROM sources"
                " WHERE content_hash = :h AND tenant_id = CAST(:tid AS uuid)"
                " LIMIT 1"
            ),
            {"h": c_hash, "tid": tenant_id},
        )
        existing = row.fetchone()
        if existing:
            log.debug("Source dedup hit (hash): %s", existing.id)
            return existing.id

    if uri:
        row = await session.execute(
            text(
                "SELECT id FROM sources"
                " WHERE uri = :u AND source_kind = :k"
                "   AND tenant_id = CAST(:tid AS uuid)"
                " LIMIT 1"
            ),
            {"u": uri, "k": source_kind, "tid": tenant_id},
        )
        existing = row.fetchone()
        if existing:
            log.debug("Source dedup hit (URI): %s", existing.id)
            return existing.id

    # Store content: inline (small) or filesystem (large)
    db_content = None
    content_path = None
    if content:
        if len(content.encode()) <= CONTENT_SIZE_THRESHOLD:
            db_content = content
        else:
            content_path = _store_to_filesystem(c_hash, content)

    row = await session.execute(
        text("""
            INSERT INTO sources (
                source_kind, title, uri, content, content_path, content_hash,
                trust_score, author, published_at, completeness, coverage_notes,
                metadata, tenant_id
            ) VALUES (
                :kind, :title, :uri, :content, :content_path, :hash,
                :trust, :author, :published_at, :completeness, :coverage_notes,
                CAST(:metadata AS jsonb), CAST(:tenant_id AS uuid)
            )
            RETURNING id
        """),
        {
            "kind": source_kind,
            "title": title,
            "uri": uri,
            "content": db_content,
            "content_path": content_path,
            "hash": c_hash,
            "trust": trust,
            "author": author,
            "published_at": published_at,
            "completeness": completeness,
            "coverage_notes": coverage_notes,
            "metadata": json.dumps(metadata or {}),
            "tenant_id": tenant_id,
        },
    )
    source_id = row.scalar_one()
    log.info(
        "Created source %s (%s): %s",
        source_id,
        source_kind,
        title or uri or "(untitled)",
    )
    return source_id


def _store_to_filesystem(content_hash: str, content: str) -> str:
    """Store large content to filesystem. Returns relative path."""
    SOURCES_DIR.mkdir(parents=True, exist_ok=True)
    shard = content_hash[:2]
    shard_dir = SOURCES_DIR / shard
    shard_dir.mkdir(exist_ok=True)
    path = shard_dir / f"{content_hash}.txt"
    path.write_text(content, encoding="utf-8")
    return f"{shard}/{content_hash}.txt"


async def get_source(session: AsyncSession, source_id: UUID) -> dict | None:
    """Fetch a source by ID with engram count."""
    row = await session.execute(
        text("""
            SELECT s.*, COUNT(e.id) AS engram_count
            FROM sources s
            LEFT JOIN engrams e ON e.source_ref_id = s.id AND NOT e.superseded
            WHERE s.id = :id
            GROUP BY s.id
        """),
        {"id": source_id},
    )
    r = row.fetchone()
    if not r:
        return None
    return _row_to_dict(r)


async def list_sources(
    session: AsyncSession,
    *,
    source_kind: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict]:
    """List sources with engram counts."""
    filters = ["1=1"]
    params: dict = {"limit": limit, "offset": offset}
    if source_kind:
        filters.append("s.source_kind = :kind")
        params["kind"] = source_kind

    where = " AND ".join(filters)
    rows = await session.execute(
        text(f"""
            SELECT s.*, COUNT(e.id) AS engram_count
            FROM sources s
            LEFT JOIN engrams e ON e.source_ref_id = s.id AND NOT e.superseded
            WHERE {where}
            GROUP BY s.id
            ORDER BY s.ingested_at DESC
            LIMIT :limit OFFSET :offset
        """),
        params,
    )
    return [_row_to_dict(r) for r in rows.fetchall()]


async def delete_source(session: AsyncSession, source_id: UUID) -> bool:
    """Delete a source. Engrams keep their source_meta but lose the FK."""
    result = await session.execute(
        text("DELETE FROM sources WHERE id = :id"),
        {"id": source_id},
    )
    return result.rowcount > 0


async def get_source_content(session: AsyncSession, source_id: UUID) -> str | None:
    """Retrieve full content from DB or filesystem."""
    row = await session.execute(
        text("SELECT content, content_path, uri FROM sources WHERE id = :id"),
        {"id": source_id},
    )
    r = row.fetchone()
    if not r:
        return None
    if r.content:
        return r.content
    if r.content_path:
        path = SOURCES_DIR / r.content_path
        if path.exists():
            return path.read_text(encoding="utf-8")
    return None


async def generate_source_summary(content: str) -> str:
    """Generate a 1-paragraph summary of source content via LLM."""
    from .decomposition import SOURCE_SUMMARY_PROMPT, resolve_model

    model = await resolve_model(settings.engram_decomposition_model)
    client = get_http_client()
    resp = await client.post(
        f"{settings.llm_gateway_url}/complete",
        json={
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": SOURCE_SUMMARY_PROMPT.format(content=content[:8000]),
                },
            ],
            "temperature": 0.3,
            "max_tokens": 300,
        },
        timeout=30.0,
    )
    if resp.status_code == 200:
        return resp.json().get("content", "")
    return ""


async def update_source_summary(
    session: AsyncSession,
    source_id: UUID,
    summary: str,
    section_summaries: list[dict] | None = None,
) -> None:
    """Update the hierarchical summaries for a source."""
    await session.execute(
        text("""
            UPDATE sources
            SET summary = :summary,
                section_summaries = CAST(:sections AS jsonb),
                updated_at = NOW()
            WHERE id = :id
        """),
        {
            "id": source_id,
            "summary": summary,
            "sections": json.dumps(section_summaries) if section_summaries else None,
        },
    )


async def get_domain_summary(session: AsyncSession) -> dict:
    """Lightweight knowledge domain overview for agent priming."""
    by_kind = await session.execute(
        text("""
            SELECT source_kind, COUNT(*) AS cnt,
                   SUM(CASE WHEN stale THEN 1 ELSE 0 END) AS stale_cnt
            FROM sources
            GROUP BY source_kind
            ORDER BY cnt DESC
        """)
    )
    kinds = {
        r.source_kind: {"count": r.cnt, "stale_count": r.stale_cnt}
        for r in by_kind.fetchall()
    }

    total = await session.execute(
        text("SELECT COUNT(*) FROM engrams WHERE NOT superseded")
    )
    engram_count = total.scalar_one()

    domains_q = await session.execute(
        text("""
            SELECT e.content, COUNT(edge.id) AS connections
            FROM engrams e
            JOIN engram_edges edge ON edge.source_id = e.id OR edge.target_id = e.id
            WHERE e.type = 'entity' AND NOT e.superseded
            GROUP BY e.id, e.content
            ORDER BY connections DESC
            LIMIT 15
        """)
    )
    domains = [r.content for r in domains_q.fetchall()]

    titles_q = await session.execute(
        text("""
            SELECT title, source_kind FROM sources
            WHERE title IS NOT NULL
            ORDER BY ingested_at DESC
            LIMIT 20
        """)
    )
    recent_sources = [
        {"title": r.title, "kind": r.source_kind} for r in titles_q.fetchall()
    ]

    # Incomplete sources
    gaps_q = await session.execute(
        text("""
            SELECT title, source_kind, completeness, coverage_notes
            FROM sources
            WHERE completeness != 'complete'
            ORDER BY ingested_at DESC
            LIMIT 10
        """)
    )
    gaps = [
        {"title": r.title, "kind": r.source_kind, "coverage": r.coverage_notes}
        for r in gaps_q.fetchall()
    ]

    # Stale sources
    stale_q = await session.execute(
        text("""
            SELECT title, source_kind, verified_at
            FROM sources
            WHERE stale = TRUE OR (verified_at IS NOT NULL AND verified_at < NOW() - INTERVAL '30 days')
            ORDER BY verified_at ASC NULLS FIRST
            LIMIT 10
        """)
    )
    stale_sources = [
        {"title": r.title, "kind": r.source_kind} for r in stale_q.fetchall()
    ]

    return {
        "source_count": sum(v["count"] for v in kinds.values()),
        "engram_count": engram_count,
        "by_kind": kinds,
        "domains": domains,
        "recent_sources": recent_sources,
        "gaps": gaps,
        "stale_sources": stale_sources,
    }


def _row_to_dict(r) -> dict:
    """Convert a source row to dict."""
    return {
        "id": str(r.id),
        "source_kind": r.source_kind,
        "title": r.title,
        "uri": r.uri,
        "has_content": bool(r.content or r.content_path),
        "content_hash": r.content_hash,
        "summary": r.summary,
        "section_summaries": r.section_summaries,
        "trust_score": r.trust_score,
        "verified_at": r.verified_at.isoformat() if r.verified_at else None,
        "stale": r.stale,
        "completeness": r.completeness,
        "coverage_notes": r.coverage_notes,
        "author": r.author,
        "published_at": r.published_at.isoformat() if r.published_at else None,
        "ingested_at": r.ingested_at.isoformat(),
        "metadata": r.metadata or {},
        "engram_count": getattr(r, "engram_count", 0),
    }
