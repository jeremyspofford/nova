"""Intel feed CRUD and content ingestion endpoints."""
from __future__ import annotations

import json
import logging
from datetime import datetime
from urllib.parse import urlparse
from uuid import UUID

from app.auth import AdminDep, UserDep
from app.db import get_pool
from app.stimulus import (
    RECOMMENDATION_APPROVED,
    RECOMMENDATION_COMMENTED,
    emit_stimulus,
)
from fastapi import APIRouter, HTTPException, Query
from nova_worker_common.url_validator import validate_url
from pydantic import BaseModel

log = logging.getLogger(__name__)

intel_router = APIRouter(tags=["intel"])


# ── Feed auto-detection ──────────────────────────────────────────────────────

def _detect_feed_type(url: str) -> str:
    """Infer feed_type from URL patterns."""
    lower = url.lower()
    parsed = urlparse(lower)
    host = parsed.hostname or ""
    path = parsed.path

    if "reddit.com" in host:
        return "reddit_json"
    if "github.com" in host:
        if "/trending" in path:
            return "github_trending"
        if "/releases" in path or path.endswith(".atom"):
            return "github_releases"
    if path.endswith((".xml", ".atom", ".rss")) or "/rss" in path or "/feed" in path:
        return "rss"
    return "page"


def _detect_category(url: str) -> str:
    """Infer category from URL patterns."""
    lower = url.lower()
    host = (urlparse(lower).hostname or "")
    if "reddit.com" in host:
        return "reddit"
    if "github.com" in host:
        return "github"
    blog_hosts = {"blog.", "news.", "openai.com", "anthropic.com"}
    if any(h in host for h in blog_hosts):
        return "blog"
    blog_paths = {"/blog", "/news", "/feed", "/rss"}
    if any(p in lower for p in blog_paths):
        return "blog"
    tooling_keywords = {"ollama", "vllm", "sglang", "litellm", "langchain"}
    if any(kw in lower for kw in tooling_keywords):
        return "tooling"
    if "/docs" in lower or "/documentation" in lower:
        return "docs"
    return "other"


def _auto_name(url: str, feed_type: str) -> str:
    """Generate a human-readable name from URL."""
    parsed = urlparse(url)
    host = parsed.hostname or ""
    path = parsed.path.rstrip("/")

    if feed_type == "reddit_json":
        # Extract subreddit: /r/ClaudeAI/new/.json → r/ClaudeAI
        parts = path.split("/")
        for i, p in enumerate(parts):
            if p == "r" and i + 1 < len(parts):
                return f"r/{parts[i + 1]}"
        return host

    if feed_type == "github_trending":
        return "GitHub Trending"

    if feed_type == "github_releases":
        # /owner/repo/releases.atom → owner/repo Releases
        parts = [p for p in path.split("/") if p and p not in ("releases", "releases.atom")]
        if len(parts) >= 2:
            return f"{parts[0]}/{parts[1]} Releases"

    # Default: clean hostname
    return host.replace("www.", "").replace("old.", "")


# ── Request / Response models ────────────────────────────────────────────────

class CreateFeedRequest(BaseModel):
    url: str
    name: str | None = None                 # Auto-generated if omitted
    feed_type: str | None = None            # Auto-detected if omitted
    category: str | None = None             # Auto-detected if omitted
    check_interval_seconds: int = 3600


class UpdateFeedRequest(BaseModel):
    url: str | None = None
    name: str | None = None
    category: str | None = None
    check_interval_seconds: int | None = None
    enabled: bool | None = None


class FeedStatusUpdate(BaseModel):
    last_checked_at: str
    error_count: int
    last_hash: str | None = None


class ContentItem(BaseModel):
    feed_id: UUID
    content_hash: str
    title: str | None = None
    url: str | None = None
    body: str | None = None
    author: str | None = None
    score: int | None = None
    published_at: str | None = None
    metadata: dict = {}


class IngestContentRequest(BaseModel):
    items: list[ContentItem]


class CreateRecommendationRequest(BaseModel):
    title: str
    summary: str
    rationale: str
    grade: str
    confidence: float
    category: str = "other"
    features: list[str] = []
    complexity: str = "medium"
    auto_implementable: bool = False
    implementation_plan: str | None = None
    source_content_ids: list[str] = []
    memory_ids: list[str] = []


class UpdateRecommendationRequest(BaseModel):
    status: str | None = None
    decided_by: str | None = None


class CreateCommentRequest(BaseModel):
    author_type: str = "human"
    author_name: str
    body: str


# ── Endpoints ────────────────────────────────────────────────────────────────

@intel_router.get("/api/v1/intel/feeds")
async def list_feeds(
    _user: UserDep,
    enabled: bool | None = Query(default=None),
    category: str | None = Query(default=None),
):
    """List all intel feeds, optionally filtered by enabled status or category."""
    pool = get_pool()
    conditions: list[str] = []
    values: list = []
    idx = 1

    if enabled is not None:
        conditions.append(f"enabled = ${idx}")
        values.append(enabled)
        idx += 1
    if category is not None:
        conditions.append(f"category = ${idx}")
        values.append(category)
        idx += 1

    where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
    query = f"SELECT * FROM intel_feeds{where} ORDER BY created_at DESC"

    async with pool.acquire() as conn:
        rows = await conn.fetch(query, *values)
    return [dict(r) for r in rows]


@intel_router.post("/api/v1/intel/feeds", status_code=201)
async def create_feed(req: CreateFeedRequest, _user: UserDep):
    """Create a new intel feed. Auto-detects type, category, and name from URL."""
    error = validate_url(req.url)
    if error:
        raise HTTPException(status_code=400, detail=f"Invalid feed URL: {error}")

    feed_type = req.feed_type or _detect_feed_type(req.url)
    category = req.category or _detect_category(req.url)
    name = req.name or _auto_name(req.url, feed_type)

    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO intel_feeds (name, url, feed_type, category, check_interval_seconds)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            name, req.url, feed_type, category, req.check_interval_seconds,
        )
    log.info("Intel feed created: %s — %s", row["id"], name)
    return dict(row)


@intel_router.patch("/api/v1/intel/feeds/{feed_id}")
async def update_feed(feed_id: UUID, req: UpdateFeedRequest, _user: UserDep):
    """Update feed config. If URL changes, re-validates SSRF and re-detects type/category."""
    updates = req.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    # If URL is changing, re-validate and re-detect type/category
    if "url" in updates:
        error = validate_url(updates["url"])
        if error:
            raise HTTPException(status_code=400, detail=f"Invalid feed URL: {error}")
        updates["feed_type"] = _detect_feed_type(updates["url"])
        updates["category"] = _detect_category(updates["url"])
        # Reset check state since source changed
        updates["last_checked_at"] = None
        updates["last_hash"] = None
        updates["error_count"] = 0

    set_parts = []
    values = []
    for i, (key, val) in enumerate(updates.items(), start=1):
        set_parts.append(f"{key} = ${i}")
        values.append(val)

    values.append(feed_id)
    set_clause = ", ".join(set_parts)
    idx = len(values)

    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE intel_feeds SET {set_clause}, updated_at = NOW() WHERE id = ${idx} RETURNING *",
            *values,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Feed not found")
    log.info("Intel feed updated: %s", feed_id)
    return dict(row)


@intel_router.delete("/api/v1/intel/feeds/{feed_id}", status_code=204)
async def delete_feed(feed_id: UUID, _user: UserDep):
    """Delete an intel feed."""
    pool = get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute("DELETE FROM intel_feeds WHERE id = $1", feed_id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Feed not found")
    log.info("Intel feed deleted: %s", feed_id)


@intel_router.patch("/api/v1/intel/feeds/{feed_id}/status")
async def update_feed_status(feed_id: UUID, req: FeedStatusUpdate, _admin: AdminDep):
    """Update feed check status (used by intel-worker)."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE intel_feeds
            SET last_checked_at = $1::timestamptz,
                error_count = $2,
                last_hash = $3,
                updated_at = NOW()
            WHERE id = $4
            RETURNING *
            """,
            datetime.fromisoformat(req.last_checked_at.replace("Z", "+00:00")),
            req.error_count, req.last_hash, feed_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Feed not found")
    log.info("Intel feed status updated: %s", feed_id)
    return dict(row)


@intel_router.post("/api/v1/intel/content")
async def ingest_content(req: IngestContentRequest, _admin: AdminDep):
    """Store new content items. Dedup by content_hash. Returns only newly stored items."""
    pool = get_pool()
    inserted = []
    async with pool.acquire() as conn:
        for item in req.items:
            published = None
            if item.published_at:
                try:
                    published = datetime.fromisoformat(item.published_at.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    pass
            row = await conn.fetchrow(
                """
                INSERT INTO intel_content_items
                    (feed_id, content_hash, title, url, body, author, score, published_at, metadata)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
                ON CONFLICT (content_hash) DO NOTHING
                RETURNING id, feed_id, content_hash, title, url
                """,
                item.feed_id, item.content_hash, item.title, item.url,
                item.body, item.author, item.score, published,
                json.dumps(item.metadata),
            )
            if row:
                inserted.append(dict(row))
    log.info("Intel content ingested: %d new / %d total", len(inserted), len(req.items))
    return inserted


@intel_router.get("/api/v1/intel/stats")
async def intel_stats(_user: UserDep):
    """Aggregate intel stats for the dashboard."""
    pool = get_pool()
    async with pool.acquire() as conn:
        items_this_week = await conn.fetchval(
            "SELECT COUNT(*) FROM intel_content_items WHERE ingested_at > now() - interval '7 days'"
        )
        active_feeds = await conn.fetchval(
            "SELECT COUNT(*) FROM intel_feeds WHERE enabled = true"
        )
        grade_rows = await conn.fetch(
            "SELECT grade, COUNT(*) AS count FROM intel_recommendations GROUP BY grade"
        )
        total_recommendations = await conn.fetchval(
            "SELECT COUNT(*) FROM intel_recommendations"
        )

    grade_map = {r["grade"]: r["count"] for r in grade_rows}
    return {
        "items_this_week": items_this_week or 0,
        "active_feeds": active_feeds or 0,
        "grade_a": grade_map.get("A", 0),
        "grade_b": grade_map.get("B", 0),
        "grade_c": grade_map.get("C", 0),
        "total_recommendations": total_recommendations or 0,
    }


# ── Recommendation endpoints ────────────────────────────────────────────────


@intel_router.post("/api/v1/intel/recommendations", status_code=201)
async def create_recommendation(req: CreateRecommendationRequest, _admin: AdminDep):
    """Create an intel recommendation (used by Cortex after content analysis)."""
    # Validate grade
    if req.grade not in ("A", "B", "C"):
        raise HTTPException(status_code=400, detail="grade must be A, B, or C")
    # Validate confidence
    if not (0 <= req.confidence <= 1):
        raise HTTPException(status_code=400, detail="confidence must be between 0 and 1")
    # Validate complexity
    if req.complexity not in ("low", "medium", "high"):
        raise HTTPException(status_code=400, detail="complexity must be low, medium, or high")

    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO intel_recommendations
                (title, summary, rationale, features, grade, confidence,
                 category, auto_implementable, implementation_plan, complexity)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
            """,
            req.title, req.summary, req.rationale, req.features,
            req.grade, req.confidence, req.category,
            req.auto_implementable, req.implementation_plan, req.complexity,
        )
        rec_id = row["id"]

        # Link source content items
        for cid in req.source_content_ids:
            await conn.execute(
                """
                INSERT INTO intel_recommendation_sources (recommendation_id, content_item_id)
                VALUES ($1, $2::uuid)
                ON CONFLICT DO NOTHING
                """,
                rec_id, cid,
            )

        # Link supporting memories
        for mid in req.memory_ids:
            await conn.execute(
                """
                INSERT INTO intel_recommendation_memories (recommendation_id, memory_id)
                VALUES ($1, $2)
                ON CONFLICT DO NOTHING
                """,
                rec_id, mid,
            )

    log.info("Intel recommendation created: %s — %s (grade=%s)", rec_id, req.title, req.grade)
    return {"id": str(rec_id), "title": req.title, "grade": req.grade, "status": "pending"}


@intel_router.get("/api/v1/intel/recommendations")
async def list_recommendations(
    _user: UserDep,
    status: str | None = Query(default=None),
    grade: str | None = Query(default=None),
    category: str | None = Query(default=None),
    limit: int = Query(default=20),
    offset: int = Query(default=0),
):
    """List recommendations with optional filters."""
    conditions: list[str] = []
    values: list = []
    idx = 1

    if status is not None:
        conditions.append(f"status = ${idx}")
        values.append(status)
        idx += 1
    if grade is not None:
        conditions.append(f"grade = ${idx}")
        values.append(grade)
        idx += 1
    if category is not None:
        conditions.append(f"category = ${idx}")
        values.append(category)
        idx += 1

    where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
    values.extend([limit, offset])
    query = (
        f"SELECT * FROM intel_recommendations{where}"
        f" ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    )

    # Single query with correlated subqueries to avoid N+1
    query_with_counts = (
        f"SELECT r.*,"
        f" (SELECT COUNT(*) FROM intel_recommendation_sources WHERE recommendation_id = r.id) AS source_count,"
        f" (SELECT COUNT(*) FROM intel_recommendation_memories WHERE recommendation_id = r.id) AS memory_count,"
        f" (SELECT COUNT(*) FROM comments WHERE entity_type = 'recommendation' AND entity_id = r.id) AS comment_count"
        f" FROM ({query}) r"
    )

    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(query_with_counts, *values)
    return [dict(r) for r in rows]


@intel_router.get("/api/v1/intel/recommendations/{rec_id}")
async def get_recommendation(rec_id: UUID, _user: UserDep):
    """Get a single recommendation with sources, linked memories, and comments."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM intel_recommendations WHERE id = $1", rec_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Recommendation not found")

        sources = await conn.fetch(
            """
            SELECT rs.*, ci.title, ci.url, ci.content_hash, ci.body, ci.author, ci.score
            FROM intel_recommendation_sources rs
            JOIN intel_content_items ci ON ci.id = rs.content_item_id
            WHERE rs.recommendation_id = $1
            """,
            rec_id,
        )
        memories = await conn.fetch(
            "SELECT * FROM intel_recommendation_memories WHERE recommendation_id = $1",
            rec_id,
        )
        comments = await conn.fetch(
            """
            SELECT * FROM comments
            WHERE entity_type = 'recommendation' AND entity_id = $1
            ORDER BY created_at ASC
            """,
            rec_id,
        )

    rec = dict(row)
    rec["sources"] = [dict(s) for s in sources]
    rec["memories"] = [dict(m) for m in memories]
    rec["comments"] = [dict(c) for c in comments]
    return rec


@intel_router.patch("/api/v1/intel/recommendations/{rec_id}")
async def update_recommendation(
    rec_id: UUID, req: UpdateRecommendationRequest, _user: UserDep,
):
    """Update recommendation status. Approved creates a linked goal."""
    if not req.status and not req.decided_by:
        raise HTTPException(status_code=400, detail="No fields to update")

    pool = get_pool()
    async with pool.acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT * FROM intel_recommendations WHERE id = $1", rec_id,
        )
        if not existing:
            raise HTTPException(status_code=404, detail="Recommendation not found")

        if req.status == "approved":
            title = f"[Intel] {existing['title']}"
            description = f"{existing['summary']}\n\nRationale: {existing['rationale']}"
            goal = await conn.fetchrow(
                """
                INSERT INTO goals (title, description, status, priority, source_recommendation_id, created_via)
                VALUES ($1, $2, 'active', 3, $3, 'cortex')
                RETURNING id
                """,
                title, description, rec_id,
            )
            row = await conn.fetchrow(
                """
                UPDATE intel_recommendations
                SET goal_id = $1, status = 'speccing', decided_by = $2,
                    decided_at = NOW(), updated_at = NOW()
                WHERE id = $3
                RETURNING *
                """,
                goal["id"], req.decided_by, rec_id,
            )
            await emit_stimulus(
                RECOMMENDATION_APPROVED,
                {"recommendation_id": str(rec_id), "goal_id": str(goal["id"])},
            )

        elif req.status == "dismissed":
            hash_rows = await conn.fetch(
                """
                SELECT ci.content_hash FROM intel_recommendation_sources rs
                JOIN intel_content_items ci ON ci.id = rs.content_item_id
                WHERE rs.recommendation_id = $1
                """,
                rec_id,
            )
            hashes = [r["content_hash"] for r in hash_rows]
            row = await conn.fetchrow(
                """
                UPDATE intel_recommendations
                SET status = 'dismissed', dismissed_hash_cluster = $1,
                    decided_by = $2, decided_at = NOW(), updated_at = NOW()
                WHERE id = $3
                RETURNING *
                """,
                hashes, req.decided_by, rec_id,
            )

        elif req.status == "deferred":
            row = await conn.fetchrow(
                """
                UPDATE intel_recommendations
                SET status = 'deferred', decided_by = $1,
                    decided_at = NOW(), updated_at = NOW()
                WHERE id = $2
                RETURNING *
                """,
                req.decided_by, rec_id,
            )

        else:
            # Generic update (no special status transition)
            updates = req.model_dump(exclude_unset=True)
            set_parts = []
            values = []
            for i, (key, val) in enumerate(updates.items(), start=1):
                set_parts.append(f"{key} = ${i}")
                values.append(val)
            values.append(rec_id)
            idx = len(values)
            row = await conn.fetchrow(
                f"UPDATE intel_recommendations SET {', '.join(set_parts)}, updated_at = NOW() WHERE id = ${idx} RETURNING *",
                *values,
            )

    return dict(row)


# ── Comment endpoints ────────────────────────────────────────────────────────


@intel_router.get("/api/v1/intel/recommendations/{rec_id}/comments")
async def list_recommendation_comments(
    rec_id: UUID,
    _user: UserDep,
    limit: int = Query(default=50),
    offset: int = Query(default=0),
):
    """List comments on a recommendation."""
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT * FROM comments
            WHERE entity_type = 'recommendation' AND entity_id = $1
            ORDER BY created_at ASC
            LIMIT $2 OFFSET $3
            """,
            rec_id, limit, offset,
        )
    return [dict(r) for r in rows]


@intel_router.post("/api/v1/intel/recommendations/{rec_id}/comments", status_code=201)
async def create_recommendation_comment(
    rec_id: UUID, req: CreateCommentRequest, _user: UserDep,
):
    """Add a comment to a recommendation."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO comments (entity_type, entity_id, author_type, author_name, body)
            VALUES ('recommendation', $1, $2, $3, $4)
            RETURNING *
            """,
            rec_id, req.author_type, req.author_name, req.body,
        )
    if req.author_type == "human":
        await emit_stimulus(
            RECOMMENDATION_COMMENTED,
            {"recommendation_id": str(rec_id), "comment_id": str(row["id"])},
        )
    return dict(row)


@intel_router.delete(
    "/api/v1/intel/recommendations/{rec_id}/comments/{comment_id}",
    status_code=204,
)
async def delete_recommendation_comment(
    rec_id: UUID, comment_id: UUID, _user: UserDep,
):
    """Delete a comment from a recommendation."""
    pool = get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM comments WHERE id = $1 AND entity_type = 'recommendation' AND entity_id = $2",
            comment_id, rec_id,
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Comment not found")
