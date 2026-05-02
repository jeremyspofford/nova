"""
Memory Tools — agent-callable knowledge retrieval.

These tools let agents search, recall, and read from Nova's memory system
on-demand instead of relying on pre-injected context. This gives agents
control over what they retrieve and when, keeping the context window lean.

Tools provided:
  what_do_i_know            -- lightweight domain awareness (what topics/sources exist)
  search_memory             -- semantic search across engrams (ranked results)
  recall_topic              -- retrieve all engrams connected to an entity
  read_source               -- fetch full content from a source record
  get_consolidation_status  -- recent consolidation cycle history
  get_memory_stats          -- engram counts, graph stats, system health
  trigger_consolidation     -- manually start a consolidation cycle
  get_router_status         -- neural router mode (cosine vs trained reranker)
"""
from __future__ import annotations

import logging

import httpx
from nova_contracts import BlastRadius, ToolDefinition

log = logging.getLogger(__name__)

MEMORY_BASE = "http://memory-service:8002/api/v1/engrams"
_TIMEOUT = httpx.Timeout(15.0)

# ─── Tool definitions (what the LLM sees) ────────────────────────────────────

MEMORY_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="what_do_i_know",
        description=(
            "Get a lightweight overview of what knowledge domains and sources you have "
            "in memory. Returns topic areas, source titles, and counts — NOT the actual "
            "knowledge. Use this FIRST to understand what you know before doing deeper "
            "retrieval. Costs almost zero context tokens."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Optional topic to focus the overview on",
                },
                "depth": {
                    "type": "string",
                    "enum": ["shallow", "standard", "deep"],
                    "description": "shallow=topics only, standard=topics+schemas, deep=full breakdown",
                },
            },
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="search_memory",
        description=(
            "Search your memory for knowledge relevant to a query. Returns ranked "
            "engrams (facts, episodes, procedures) with source attribution. Use this "
            "when you need to recall specific information. More expensive than "
            "what_do_i_know but returns actual knowledge content."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What to search for in memory",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Max results to return (default: 10, max: 30)",
                },
                "depth": {
                    "type": "string",
                    "enum": ["shallow", "standard", "deep"],
                    "description": "shallow=schemas/topics only, standard=default, deep=follow all structural edges",
                },
            },
            "required": ["query"],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="recall_topic",
        description=(
            "Retrieve all knowledge connected to a specific entity or topic. Uses "
            "graph traversal to find everything related — facts, episodes, procedures "
            "that reference the entity and their connections. Use this when you want "
            "comprehensive recall about a person, project, concept, or tool."
        ),
        parameters={
            "type": "object",
            "properties": {
                "entity": {
                    "type": "string",
                    "description": "The entity/topic to recall (e.g., 'Jeremy', 'Nova', 'Python')",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Max results (default: 15, max: 50)",
                },
                "depth": {
                    "type": "string",
                    "enum": ["shallow", "standard", "deep"],
                    "description": "shallow=schemas/topics only, standard=default, deep=everything connected",
                },
            },
            "required": ["entity"],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="read_source",
        description=(
            "Read the full content of a source document. Sources are the raw material "
            "behind engrams — articles, conversations, documents, crawled pages. Use "
            "this when engram summaries aren't detailed enough and you need the original "
            "content. Returns the full text, which may be large."
        ),
        parameters={
            "type": "object",
            "properties": {
                "source_id": {
                    "type": "string",
                    "description": "UUID of the source to read",
                },
            },
            "required": ["source_id"],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="get_consolidation_status",
        description=(
            "Check the status and history of memory consolidation cycles. Returns "
            "recent consolidation log entries showing when cycles ran, how long they "
            "took, and what they did (pattern extraction, pruning, contradiction "
            "resolution). Use this to verify consolidation is running and healthy."
        ),
        parameters={
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "Number of recent log entries to return (default: 5, max: 20)",
                },
            },
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="get_memory_stats",
        description=(
            "Get statistics about the memory system: total engram count, type breakdown, "
            "edge counts, source counts, and ingestion queue depth. Use this to monitor "
            "memory health and growth."
        ),
        parameters={
            "type": "object",
            "properties": {},
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="trigger_consolidation",
        description=(
            "Manually trigger a memory consolidation cycle. Consolidation replays "
            "recent engrams, extracts patterns, strengthens connections (Hebbian "
            "learning), resolves contradictions, prunes weak memories, and updates "
            "the self-model. Will be skipped if a cycle is already running. "
            "Use sparingly, typically when you notice fragmented knowledge."
        ),
        parameters={
            "type": "object",
            "properties": {},
            "required": [],
        },
        blast_radius=BlastRadius.MUTATE,
    ),
    ToolDefinition(
        name="get_router_status",
        description=(
            "Check the Neural Router status — whether memory retrieval uses basic "
            "cosine similarity or a trained ML reranker. The router trains automatically "
            "after 200+ labeled retrieval observations. Returns mode, observation counts, "
            "and whether training is ready. Use this to understand your own retrieval quality."
        ),
        parameters={
            "type": "object",
            "properties": {},
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
]


# ─── Executors ────────────────────────────────────────────────────────────────

async def execute_tool(name: str, arguments: dict) -> str:
    """Dispatch memory tool calls to memory-service."""
    try:
        if name == "what_do_i_know":
            return await _what_do_i_know(arguments)
        elif name == "search_memory":
            return await _search_memory(arguments)
        elif name == "recall_topic":
            return await _recall_topic(arguments)
        elif name == "read_source":
            return await _read_source(arguments)
        elif name == "get_consolidation_status":
            return await _get_consolidation_status(arguments)
        elif name == "get_memory_stats":
            return await _get_memory_stats(arguments)
        elif name == "trigger_consolidation":
            return await _trigger_consolidation(arguments)
        elif name == "get_router_status":
            return await _get_router_status(arguments)
        else:
            return f"Unknown memory tool: {name}"
    except httpx.TimeoutException:
        return "Memory service timed out. Try again or reduce max_results."
    except Exception as e:
        log.warning("Memory tool '%s' failed: %s", name, e)
        return f"Memory tool error: {e}"


async def _what_do_i_know(args: dict) -> str:
    depth = args.get("depth", "shallow")

    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        # Try topic-based overview first (direct query, not semantic search)
        topics_resp = await c.get(f"{MEMORY_BASE}/topics")
        if topics_resp.status_code == 200:
            topics_data = topics_resp.json()
            topic_list = topics_data.get("topics", [])

            if topic_list:
                lines = [f"Knowledge domains ({len(topic_list)} topics):"]
                for t in topic_list:
                    member_note = f" ({t.get('member_count', '?')} items)" if t.get("member_count") else ""
                    lines.append(f"\n- {t['content'][:200]}{member_note}")

                # Standard/deep: also fetch schema summaries for each topic
                if depth in ("standard", "deep") and topic_list:
                    lines.append("\n\nSchemas:")
                    schemas_resp = await c.post(
                        f"{MEMORY_BASE}/activate",
                        params={"query": "knowledge patterns", "max_results": 30, "depth": "shallow"},
                    )
                    if schemas_resp.status_code == 200:
                        schemas_data = schemas_resp.json()
                        for e in schemas_data.get("engrams", []):
                            if e.get("type") == "schema":
                                lines.append(f"\n- [schema] {e['content'][:200]}")

                return "\n".join(lines)

        # Fall back to source-based domain summary
        resp = await c.get(f"{MEMORY_BASE}/sources/domain-summary")
        resp.raise_for_status()
        data = resp.json()

    lines = [f"Knowledge overview ({data['engram_count']} memories from {data['source_count']} sources):"]

    if data.get("by_kind"):
        lines.append("\nSources by type:")
        for kind, info in data["by_kind"].items():
            stale_note = f" ({info['stale_count']} stale)" if info.get("stale_count") else ""
            lines.append(f"  - {kind}: {info['count']}{stale_note}")

    if data.get("domains"):
        lines.append(f"\nKey topics: {', '.join(data['domains'][:10])}")

    if data.get("recent_sources"):
        lines.append("\nRecent sources:")
        for s in data["recent_sources"][:10]:
            lines.append(f"  - [{s['kind']}] {s['title']}")

    return "\n".join(lines)


async def _search_memory(args: dict) -> str:
    query = args.get("query", "")
    max_results = min(args.get("max_results", 10), 30)
    depth = args.get("depth", "standard")

    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        resp = await c.post(
            f"{MEMORY_BASE}/activate",
            params={"query": query, "max_results": max_results, "depth": depth},
        )
        resp.raise_for_status()
        data = resp.json()

    if not data.get("engrams"):
        return "No relevant memories found."

    lines = [f"Found {data['count']} relevant memories:"]
    for e in data["engrams"]:
        source_note = f" [from: {e.get('source_type', '?')}]" if e.get("source_type") else ""
        score = f" (relevance: {e.get('final_score', 0):.2f})"
        lines.append(f"\n- [{e['type']}]{source_note}{score}\n  {e['content']}")

    return "\n".join(lines)


async def _recall_topic(args: dict) -> str:
    entity = args.get("entity", "")
    max_results = min(args.get("max_results", 15), 50)
    depth = args.get("depth", "standard")

    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        resp = await c.post(
            f"{MEMORY_BASE}/activate",
            params={"query": entity, "max_results": max_results, "depth": depth},
        )
        resp.raise_for_status()
        data = resp.json()

    if not data.get("engrams"):
        return f"No knowledge found about '{entity}'."

    by_type: dict[str, list] = {}
    for e in data["engrams"]:
        by_type.setdefault(e["type"], []).append(e)

    lines = [f"Knowledge about '{entity}' ({data['count']} items):"]
    for etype, engrams in by_type.items():
        lines.append(f"\n## {etype.title()}s")
        for e in engrams:
            lines.append(f"- {e['content']}")

    return "\n".join(lines)


async def _read_source(args: dict) -> str:
    source_id = args.get("source_id", "")
    if not source_id:
        return "source_id is required."

    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        meta_resp = await c.get(f"{MEMORY_BASE}/sources/{source_id}")
        if meta_resp.status_code == 404:
            return f"Source '{source_id}' not found."
        meta_resp.raise_for_status()
        meta = meta_resp.json()

        content_resp = await c.get(f"{MEMORY_BASE}/sources/{source_id}/content")
        if content_resp.status_code == 404:
            if meta.get("uri"):
                return (
                    f"Source '{meta.get('title', source_id)}' is a reference — "
                    f"content not stored locally. Original URI: {meta['uri']}\n"
                    f"Summary: {meta.get('summary', 'No summary available.')}"
                )
            return "Source content not available."
        content_resp.raise_for_status()
        content = content_resp.json().get("content", "")

    header = f"Source: {meta.get('title', 'Untitled')} [{meta['source_kind']}]"
    if meta.get("author"):
        header += f" by {meta['author']}"
    if meta.get("trust_score"):
        header += f" (trust: {meta['trust_score']:.1f})"

    if len(content) > 15000:
        content = content[:15000] + f"\n\n[... truncated, {len(content)} chars total]"

    return f"{header}\n\n{content}"


async def _get_consolidation_status(args: dict) -> str:
    limit = min(args.get("limit", 5), 20)

    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        resp = await c.get(
            f"{MEMORY_BASE}/consolidation-log",
            params={"limit": limit},
        )
        resp.raise_for_status()
        data = resp.json()

    entries = data.get("entries", []) if isinstance(data, dict) else data
    if not entries:
        return "No consolidation cycles have run yet."

    lines = [f"Recent consolidation cycles ({len(entries)} entries):"]
    for entry in entries:
        trigger = entry.get("trigger", "?")
        ts = entry.get("created_at", "?")
        duration_ms = entry.get("duration_ms")
        dur_str = f" ({duration_ms / 1000:.1f}s)" if duration_ms is not None else ""

        parts = []
        if entry.get("engrams_reviewed"):
            parts.append(f"{entry['engrams_reviewed']} reviewed")
        if entry.get("schemas_created"):
            parts.append(f"{entry['schemas_created']} schemas")
        if entry.get("topics_created"):
            parts.append(f"{entry['topics_created']} topics")
        if entry.get("edges_strengthened"):
            parts.append(f"{entry['edges_strengthened']} edges strengthened")
        if entry.get("edges_pruned"):
            parts.append(f"{entry['edges_pruned']} pruned")
        if entry.get("contradictions_resolved"):
            parts.append(f"{entry['contradictions_resolved']} contradictions resolved")
        if entry.get("engrams_merged"):
            parts.append(f"{entry['engrams_merged']} merged")
        summary = ", ".join(parts) if parts else "no changes"

        lines.append(f"\n- [{trigger}] {ts}{dur_str}")
        lines.append(f"  {summary}")

        sm = entry.get("self_model_updates")
        if sm and isinstance(sm, dict) and sm.get("maturity_stage"):
            lines.append(f"  Self-model: {sm['maturity_stage']} ({sm.get('total_engrams', '?')} engrams, {sm.get('schema_count', '?')} schemas)")

    return "\n".join(lines)


async def _get_memory_stats(args: dict) -> str:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        resp = await c.get(f"{MEMORY_BASE}/stats")
        resp.raise_for_status()
        data = resp.json()

    lines = ["Memory system statistics:"]

    total = data.get("total_engrams", data.get("engram_count"))
    if total is not None:
        lines.append(f"\nTotal engrams: {total}")
    if "total_edges" in data:
        lines.append(f"Total edges: {data['total_edges']}")
    if "total_archived" in data:
        lines.append(f"Archived: {data['total_archived']}")

    if data.get("by_type"):
        lines.append("\nBy type:")
        for etype, info in data["by_type"].items():
            if isinstance(info, dict):
                superseded = info.get("superseded", 0)
                sup_note = f" ({superseded} superseded)" if superseded else ""
                lines.append(f"  - {etype}: {info.get('total', '?')}{sup_note}")
            else:
                lines.append(f"  - {etype}: {info}")

    if data.get("by_relation"):
        top_relations = sorted(
            data["by_relation"].items(),
            key=lambda x: x[1].get("count", 0) if isinstance(x[1], dict) else x[1],
            reverse=True,
        )[:5]
        lines.append("\nTop edge types:")
        for rel, info in top_relations:
            if isinstance(info, dict):
                lines.append(f"  - {rel}: {info['count']} (avg weight: {info.get('avg_weight', '?')})")
            else:
                lines.append(f"  - {rel}: {info}")

    if data.get("by_source_type"):
        lines.append("\nBy source:")
        for stype, count in data["by_source_type"].items():
            lines.append(f"  - {stype}: {count}")

    return "\n".join(lines)


async def _trigger_consolidation(args: dict) -> str:
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as c:
        resp = await c.post(f"{MEMORY_BASE}/consolidate")
        resp.raise_for_status()
        data = resp.json()

    if isinstance(data, dict) and data.get("skipped"):
        return (
            f"Consolidation skipped: {data.get('reason', 'already running')}. "
            "Use get_consolidation_status to check when the last cycle ran."
        )

    lines = ["Consolidation cycle completed."]
    if isinstance(data, dict):
        parts = []
        if data.get("engrams_reviewed"):
            parts.append(f"{data['engrams_reviewed']} engrams reviewed")
        if data.get("schemas_created"):
            parts.append(f"{data['schemas_created']} schemas created")
        if data.get("topics_created"):
            parts.append(f"{data['topics_created']} topics created")
        if data.get("edges_strengthened"):
            parts.append(f"{data['edges_strengthened']} edges strengthened")
        if data.get("edges_pruned"):
            parts.append(f"{data['edges_pruned']} edges pruned")
        if data.get("contradictions_resolved"):
            parts.append(f"{data['contradictions_resolved']} contradictions resolved")
        if parts:
            lines.append(", ".join(parts))
        sm = data.get("self_model_updates")
        if sm and isinstance(sm, dict) and sm.get("maturity_stage"):
            lines.append(f"Self-model: {sm['maturity_stage']}")

    return "\n".join(lines)


async def _get_router_status(args: dict) -> str:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        resp = await c.get(f"{MEMORY_BASE}/router-status")
        resp.raise_for_status()
        data = resp.json()

    mode = data.get("mode", "unknown")
    obs = data.get("observation_count", 0)
    labeled = data.get("labeled_count", 0)
    model_loaded = data.get("model_loaded", False)

    lines = [f"Neural Router: {mode}"]
    lines.append(f"Observations: {obs} total, {labeled} labeled")

    if model_loaded:
        arch = data.get("architecture", "unknown")
        lines.append(f"Trained model active ({arch}) -- retrieval uses learned ranking")
    elif labeled >= 200:
        lines.append("Ready for training -- enough labeled data, model not yet trained")
    else:
        lines.append(f"Collecting data -- {labeled}/200 labeled observations needed before training")
        lines.append("Currently using cosine similarity only for retrieval ranking")

    if data.get("message"):
        lines.append(f"Status: {data['message']}")

    return "\n".join(lines)
