"""
Memory Tools — agent-callable knowledge retrieval and writing.

These tools talk to the neutral memory API (/api/v1/memory/*) on the
memory-service, so they work identically whichever backend is active
(engram graph or OKF markdown bundle).

Tools provided:
  what_do_i_know   -- lightweight overview of what memory holds
  search_memory    -- ranked retrieval for a query
  recall_topic     -- comprehensive recall about one entity/topic
  read_memory      -- full content of one memory item by id
  read_source      -- full content of a source record (engram backend)
  remember         -- write a durable memory (concept file / engram)
  get_memory_stats -- backend name, item counts, health
"""
from __future__ import annotations

import logging

import httpx
from nova_contracts import BlastRadius, ToolDefinition

log = logging.getLogger(__name__)

MEMORY_BASE = "http://memory-service:8002/api/v1/memory"
ENGRAM_BASE = "http://memory-service:8002/api/v1/engrams"
_TIMEOUT = httpx.Timeout(15.0)

# ─── Tool definitions (what the LLM sees) ────────────────────────────────────

MEMORY_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="what_do_i_know",
        description=(
            "Get a lightweight overview of what knowledge you have in memory — "
            "topic areas, recent entries, counts. NOT the actual knowledge. Use "
            "this FIRST to understand what you know before deeper retrieval. "
            "Costs almost zero context tokens."
        ),
        parameters={
            "type": "object",
            "properties": {},
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="search_memory",
        description=(
            "Search your memory for knowledge relevant to a query. Returns ranked "
            "excerpts with memory ids and source attribution. Use this when you "
            "need to recall specific information. Follow up with read_memory on "
            "an id when an excerpt isn't detailed enough."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What to search for in memory",
                },
                "depth": {
                    "type": "string",
                    "enum": ["shallow", "standard", "deep"],
                    "description": "shallow=few results, standard=default, deep=widest recall",
                },
            },
            "required": ["query"],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="recall_topic",
        description=(
            "Retrieve everything connected to a specific entity or topic — a "
            "person, project, concept, or tool. Wider than search_memory: use "
            "when you want comprehensive recall rather than one fact."
        ),
        parameters={
            "type": "object",
            "properties": {
                "entity": {
                    "type": "string",
                    "description": "The entity/topic to recall (e.g., 'Jeremy', 'Nova', 'Python')",
                },
            },
            "required": ["entity"],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="read_memory",
        description=(
            "Read the full content of one memory item by its id (as returned by "
            "search_memory/recall_topic). Use when an excerpt isn't enough."
        ),
        parameters={
            "type": "object",
            "properties": {
                "memory_id": {
                    "type": "string",
                    "description": "Memory id, e.g. 'topics/gpu-setup.md' or an engram UUID",
                },
            },
            "required": ["memory_id"],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="read_source",
        description=(
            "Read the full content of a source document (raw material behind "
            "memories — articles, conversations, crawled pages). Only available "
            "on the engram backend; on the markdown backend use read_memory."
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
        name="remember",
        description=(
            "Write a durable memory. Use for facts, preferences, decisions, and "
            "learnings worth keeping long-term — NOT for transient conversation "
            "state. On the markdown backend this creates/updates a concept file "
            "(topics/people/projects/preferences) that humans can read and edit; "
            "give it a clear title and 1-line description. Re-using an existing "
            "title appends an update to that file."
        ),
        parameters={
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "The memory content (markdown welcome)",
                },
                "title": {
                    "type": "string",
                    "description": "Short concept title, e.g. 'Jeremy GPU Setup'",
                },
                "type": {
                    "type": "string",
                    "enum": ["note", "fact", "preference", "person", "project", "procedure", "reflection"],
                    "description": "What kind of memory this is (default: note)",
                },
                "description": {
                    "type": "string",
                    "description": "One-line summary shown in memory indexes",
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Cross-cutting tags",
                },
                "target": {
                    "type": "string",
                    "description": "Optional existing memory id to append to (overrides title-based placement)",
                },
            },
            "required": ["text", "title"],
        },
        blast_radius=BlastRadius.MUTATE,
    ),
    ToolDefinition(
        name="get_memory_stats",
        description=(
            "Get statistics about the memory system: active backend, item counts, "
            "link/edge counts, last ingestion time. Use this to monitor memory "
            "health and growth."
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
        elif name == "read_memory":
            return await _read_memory(arguments)
        elif name == "read_source":
            return await _read_source(arguments)
        elif name == "remember":
            return await _remember(arguments)
        elif name == "get_memory_stats":
            return await _get_memory_stats(arguments)
        else:
            return f"Unknown memory tool: {name}"
    except httpx.TimeoutException:
        return "Memory service timed out. Try again."
    except Exception as e:
        log.warning("Memory tool '%s' failed: %s", name, e)
        return f"Memory tool error: {e}"


async def _context(query: str, depth: str = "standard") -> dict:
    """Shared retrieval call — mark_used=true because an agent explicitly
    asking IS the usage signal (no post-hoc mark-used needed)."""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        resp = await c.post(
            f"{MEMORY_BASE}/context",
            json={"query": query, "depth": depth, "mark_used": True},
        )
        resp.raise_for_status()
        return resp.json()


async def _what_do_i_know(args: dict) -> str:
    # Backend-aware: engram has richer topic/domain views; okf's root index
    # (returned by an empty-query context call) IS the overview.
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        backend_resp = await c.get(f"{MEMORY_BASE}/backend")
        backend = backend_resp.json().get("backend", "engram") if backend_resp.status_code == 200 else "engram"

        if backend == "engram":
            resp = await c.get(f"{ENGRAM_BASE}/sources/domain-summary")
            if resp.status_code == 200:
                data = resp.json()
                lines = [
                    f"Knowledge overview ({data.get('engram_count', '?')} memories "
                    f"from {data.get('source_count', '?')} sources):"
                ]
                if data.get("domains"):
                    lines.append(f"\nKey topics: {', '.join(data['domains'][:10])}")
                if data.get("recent_sources"):
                    lines.append("\nRecent sources:")
                    for s in data["recent_sources"][:10]:
                        lines.append(f"  - [{s.get('kind', '?')}] {s.get('title', '?')}")
                return "\n".join(lines)

        resp = await c.post(f"{MEMORY_BASE}/context", json={"query": ""})
        resp.raise_for_status()
        ctx = resp.json().get("context", "")
    return ctx or "Memory is empty — nothing stored yet."


def _format_hits(data: dict, empty_msg: str) -> str:
    context = data.get("context", "")
    ids = data.get("memory_ids", [])
    if not context and not ids:
        return empty_msg
    lines = [context]
    if ids:
        lines.append("\nMemory ids (for read_memory): " + ", ".join(ids))
    return "\n".join(lines)


async def _search_memory(args: dict) -> str:
    data = await _context(args.get("query", ""), args.get("depth", "standard"))
    return _format_hits(data, "No relevant memories found.")


async def _recall_topic(args: dict) -> str:
    entity = args.get("entity", "")
    data = await _context(entity, depth="deep")
    return _format_hits(data, f"No knowledge found about '{entity}'.")


async def _read_memory(args: dict) -> str:
    memory_id = args.get("memory_id", "")
    if not memory_id:
        return "memory_id is required."
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        resp = await c.get(f"{MEMORY_BASE}/item/{memory_id}")
        if resp.status_code == 404:
            return f"Memory '{memory_id}' not found."
        resp.raise_for_status()
        data = resp.json()

    content = data.get("content", "")
    if len(content) > 15000:
        content = content[:15000] + f"\n\n[... truncated, {len(content)} chars total]"
    header = f"# {data.get('title', memory_id)} [{data.get('type', '?')}] ({memory_id})"
    return f"{header}\n\n{content}"


async def _read_source(args: dict) -> str:
    source_id = args.get("source_id", "")
    if not source_id:
        return "source_id is required."

    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        meta_resp = await c.get(f"{ENGRAM_BASE}/sources/{source_id}")
        if meta_resp.status_code == 404:
            return f"Source '{source_id}' not found."
        meta_resp.raise_for_status()
        meta = meta_resp.json()

        content_resp = await c.get(f"{ENGRAM_BASE}/sources/{source_id}/content")
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


async def _remember(args: dict) -> str:
    text = args.get("text", "").strip()
    title = args.get("title", "").strip()
    if not text or not title:
        return "Both text and title are required."

    okf_meta = {
        "type": args.get("type", "note"),
        "title": title,
    }
    if args.get("description"):
        okf_meta["description"] = args["description"]
    if args.get("tags"):
        okf_meta["tags"] = args["tags"]
    if args.get("target"):
        okf_meta["target"] = args["target"]

    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as c:
        resp = await c.post(
            f"{MEMORY_BASE}/ingest",
            json={
                "raw_text": text,
                "source_type": "tool",
                "metadata": {"okf": okf_meta},
            },
        )
        resp.raise_for_status()
        data = resp.json()

    ids = data.get("item_ids", [])
    if data.get("items_created"):
        return f"Remembered as new memory: {ids[0] if ids else title}"
    if data.get("items_updated"):
        return f"Appended to existing memory: {ids[0] if ids else title}"
    return "Memory write accepted (no items reported — backend may process asynchronously)."


async def _get_memory_stats(args: dict) -> str:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        resp = await c.get(f"{MEMORY_BASE}/stats")
        resp.raise_for_status()
        data = resp.json()

    lines = [f"Memory backend: {data.get('provider_name', '?')}"]
    lines.append(f"Total items: {data.get('total_items', 0)}")
    if data.get("total_edges"):
        lines.append(f"Links/edges: {data['total_edges']}")
    if data.get("last_ingestion"):
        lines.append(f"Last ingestion: {data['last_ingestion']}")
    if data.get("capabilities"):
        lines.append(f"Capabilities: {', '.join(data['capabilities'])}")
    meta = data.get("metadata") or {}
    if meta.get("bundle_path"):
        lines.append(f"Bundle path: {meta['bundle_path']}")
    return "\n".join(lines)
