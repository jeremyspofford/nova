"""
Intel Tools -- intelligence analysis for Cortex and agents.

These tools let Cortex (and any agent) query the intel feed content,
create recommendations based on analysis, and check dismissed content
hashes to avoid re-recommending old ideas.

Tools provided:
  query_intel_content   -- search recent intel feed content items
  create_recommendation -- create an intel recommendation with grade/confidence
  get_dismissed_hashes  -- retrieve dismissed recommendation hash clusters
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from nova_contracts import BlastRadius, ToolDefinition

log = logging.getLogger(__name__)

# ─── Tool definitions (what the LLM sees) ────────────────────────────────────

INTEL_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="query_intel_content",
        description=(
            "Query recent intel feed content. Returns articles, posts, and updates "
            "from monitored feeds (RSS, Reddit, GitHub trending/releases, page changes). "
            "Use this to survey what's new in the AI/ML ecosystem before making "
            "recommendations. Filter by category, time range, or keyword search."
        ),
        parameters={
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "description": "Filter by feed category (e.g. 'ai_news', 'tooling', 'research')",
                },
                "since_hours": {
                    "type": "integer",
                    "description": "How many hours back to search (default: 168, max: 720)",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max items to return (default: 20, max: 100)",
                },
                "search": {
                    "type": "string",
                    "description": "Keyword search across title and body (case-insensitive)",
                },
            },
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="create_recommendation",
        description=(
            "Create an intel recommendation based on your analysis of feed content. "
            "Grade reflects strategic value: A = high-impact, should implement soon; "
            "B = valuable, worth planning; C = interesting, low priority. Include "
            "source_content_ids to link the recommendation to the intel items that "
            "informed it."
        ),
        parameters={
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Short title for the recommendation",
                },
                "summary": {
                    "type": "string",
                    "description": "What you recommend and why (1-3 sentences)",
                },
                "rationale": {
                    "type": "string",
                    "description": "Detailed reasoning for this recommendation",
                },
                "grade": {
                    "type": "string",
                    "enum": ["A", "B", "C"],
                    "description": "Strategic value grade: A=high, B=medium, C=low",
                },
                "confidence": {
                    "type": "number",
                    "description": "How confident you are (0.0 to 1.0)",
                },
                "category": {
                    "type": "string",
                    "description": "Category (e.g. 'tooling', 'research', 'infrastructure')",
                },
                "features": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of specific features or capabilities this would add",
                },
                "source_content_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "UUIDs of intel_content_items that informed this recommendation",
                },
            },
            "required": ["title", "summary", "grade", "confidence"],
        },
        blast_radius=BlastRadius.MUTATE,
    ),
    ToolDefinition(
        name="get_dismissed_hashes",
        description=(
            "Get hash clusters from dismissed recommendations. Use this before "
            "creating a new recommendation to check if similar content was already "
            "dismissed by the user. Returns dismissed recommendation titles and "
            "their hash clusters for dedup comparison."
        ),
        parameters={
            "type": "object",
            "properties": {},
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
]


# ─── Tool execution ───────────────────────────────────────────────────────────

async def _execute_query_intel_content(
    category: str | None = None,
    since_hours: int = 168,
    limit: int = 20,
    search: str | None = None,
) -> str:
    """Query intel_content_items joined with intel_feeds."""
    from app.db import get_pool

    since_hours = max(1, min(since_hours, 720))
    limit = max(1, min(limit, 100))
    pool = get_pool()

    cutoff = datetime.now(timezone.utc) - timedelta(hours=since_hours)

    conditions = ["ci.ingested_at >= $1"]
    params: list = [cutoff]
    idx = 2

    if category:
        conditions.append(f"f.category = ${idx}")
        params.append(category)
        idx += 1

    if search:
        conditions.append(f"(ci.title ILIKE ${idx} OR ci.body ILIKE ${idx})")
        params.append(f"%{search}%")
        idx += 1

    where = " AND ".join(conditions)
    params.append(limit)

    rows = await pool.fetch(
        f"""
        SELECT ci.id, ci.title, ci.url, ci.author, ci.score,
               ci.published_at, ci.ingested_at, f.name AS feed_name,
               f.category, LEFT(ci.body, 500) AS body_preview
        FROM intel_content_items ci
        JOIN intel_feeds f ON f.id = ci.feed_id
        WHERE {where}
        ORDER BY ci.ingested_at DESC
        LIMIT ${idx}
        """,
        *params,
    )

    items = []
    for r in rows:
        items.append({
            "id": str(r["id"]),
            "title": r["title"],
            "url": r["url"],
            "author": r["author"],
            "score": r["score"],
            "published_at": r["published_at"].isoformat() if r["published_at"] else None,
            "ingested_at": r["ingested_at"].isoformat() if r["ingested_at"] else None,
            "feed_name": r["feed_name"],
            "category": r["category"],
            "body_preview": r["body_preview"],
        })

    return json.dumps(items, default=str)


async def _execute_create_recommendation(
    title: str,
    summary: str,
    grade: str,
    confidence: float,
    rationale: str | None = None,
    category: str | None = None,
    features: list[str] | None = None,
    source_content_ids: list[str] | None = None,
) -> str:
    """Insert into intel_recommendations with validation."""
    from app.db import get_pool

    if grade not in ("A", "B", "C"):
        return json.dumps({"error": f"Invalid grade '{grade}'. Must be A, B, or C."})
    if not (0.0 <= confidence <= 1.0):
        return json.dumps({"error": f"Invalid confidence {confidence}. Must be 0.0-1.0."})

    pool = get_pool()
    rec_id = uuid4()

    await pool.execute(
        """
        INSERT INTO intel_recommendations (id, title, summary, rationale, grade,
                                           confidence, category, features, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
        """,
        rec_id, title, summary, rationale, grade, confidence, category, features,
    )

    # Link source content items if provided
    if source_content_ids:
        for cid in source_content_ids:
            try:
                await pool.execute(
                    """
                    INSERT INTO intel_recommendation_sources (recommendation_id, content_item_id)
                    VALUES ($1, $2::uuid)
                    ON CONFLICT DO NOTHING
                    """,
                    rec_id, cid,
                )
            except Exception as e:
                log.warning("Failed to link source %s to recommendation %s: %s", cid, rec_id, e)

    return json.dumps({"id": str(rec_id), "status": "pending", "title": title, "grade": grade})


async def _execute_get_dismissed_hashes() -> str:
    """Query dismissed recommendations with hash clusters."""
    from app.db import get_pool

    pool = get_pool()

    rows = await pool.fetch(
        """
        SELECT id, title, dismissed_hash_cluster
        FROM intel_recommendations
        WHERE status = 'dismissed' AND dismissed_hash_cluster IS NOT NULL
        ORDER BY decided_at DESC NULLS LAST
        LIMIT 200
        """
    )

    items = []
    for r in rows:
        items.append({
            "id": str(r["id"]),
            "title": r["title"],
            "hashes": r["dismissed_hash_cluster"],
        })

    return json.dumps(items, default=str)


async def execute_tool(name: str, arguments: dict) -> str:
    """Dispatch an intel tool call by name."""
    log.info("Executing intel tool: %s  args=%s", name, arguments)
    try:
        if name == "query_intel_content":
            return await _execute_query_intel_content(
                category=arguments.get("category"),
                since_hours=arguments.get("since_hours", 168),
                limit=arguments.get("limit", 20),
                search=arguments.get("search"),
            )
        elif name == "create_recommendation":
            return await _execute_create_recommendation(
                title=arguments["title"],
                summary=arguments["summary"],
                grade=arguments["grade"],
                confidence=arguments["confidence"],
                rationale=arguments.get("rationale"),
                category=arguments.get("category"),
                features=arguments.get("features"),
                source_content_ids=arguments.get("source_content_ids"),
            )
        elif name == "get_dismissed_hashes":
            return await _execute_get_dismissed_hashes()
        else:
            return f"Unknown intel tool '{name}'"
    except Exception as e:
        log.error("Intel tool '%s' failed: %s", name, e, exc_info=True)
        return json.dumps({"error": str(e)})
