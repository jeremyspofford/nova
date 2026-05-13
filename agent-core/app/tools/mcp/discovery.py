"""MCP tool discovery — list_tools, tier classification, DB override lookup."""
from __future__ import annotations

import logging

from .lifecycle import _classify_tier as classify_tier  # noqa: F401  (re-export)
from .client import StdioMCPClient

logger = logging.getLogger(__name__)


def extract_tool_verb(tool_name: str) -> str:
    """Return the leading verb segment of a tool name.

    Examples:
        "get_user"       → "get"
        "filesystem.list_files" → "list"   (uses last dot-segment)
        "delete"         → "delete"
    """
    segment = tool_name.lower().split(".")[-1]
    # Take everything up to the first underscore (or the whole word).
    return segment.split("_")[0]


async def discover_tools(
    client: StdioMCPClient,
    server_id: str,
    pool,
) -> list[dict]:
    """Call list_tools on the client, apply tier heuristic + DB overrides.

    Returns a list of dicts with keys:
        name, description, input_schema, auto_tier, effective_tier
    """
    raw_tools = await client.list_tools()

    # Bulk-fetch DB overrides for this server to avoid N+1.
    overrides: dict[str, str] = {}
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT tool_name, tier_override "
                "FROM mcp_tool_overrides "
                "WHERE mcp_server_id = $1::uuid AND tier_override IS NOT NULL",
                server_id,
            )
        for row in rows:
            overrides[row["tool_name"]] = row["tier_override"]
    except Exception as exc:
        logger.warning("discovery: failed to load tier overrides for %s: %s", server_id[:8], exc)

    result: list[dict] = []
    for t in raw_tools:
        name = t.get("name", "")
        if not name:
            continue

        auto_tier = classify_tier(name).value
        effective_tier = overrides.get(name, auto_tier)

        result.append({
            "name": name,
            "description": t.get("description", ""),
            "input_schema": t.get("inputSchema", {"type": "object", "properties": {}}),
            "auto_tier": auto_tier,
            "effective_tier": effective_tier,
        })

    return result
