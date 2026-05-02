"""
Introspect Tools — read-only platform self-awareness for Nova agents.

These tools let agents query Nova's own configuration, knowledge sources,
and MCP server state. This is the "read-only platform tools" component of
the P0 Self-Introspection roadmap item.

Security boundary:
  - platform_config entries with is_secret=true: key names visible, values masked
  - knowledge credentials: labels and metadata visible, encrypted data never exposed
  - MCP servers: connection status and tool catalogs visible, env vars masked

Adding a new tool:
  1. Add a ToolDefinition to INTROSPECT_TOOLS
  2. Add a case in execute_tool()
  3. Implement the async _execute_* function
"""
from __future__ import annotations

import json
import logging

from nova_contracts import BlastRadius, ToolDefinition

log = logging.getLogger(__name__)

# ─── Tool definitions (what the LLM sees) ────────────────────────────────────

INTROSPECT_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="get_platform_config",
        description=(
            "Query Nova's platform configuration. Returns config keys, values, "
            "and descriptions from the platform_config store. Secret values are "
            "masked but their keys are visible so you know what's configured. "
            "Use this to check routing strategy, default models, auth settings, "
            "context budgets, inference backend state, or any platform setting."
        ),
        parameters={
            "type": "object",
            "properties": {
                "namespace": {
                    "type": "string",
                    "description": (
                        "Optional dot-prefix filter. Examples: 'llm' (routing/models), "
                        "'nova' (identity/persona), 'inference' (backend state), "
                        "'context' (token budgets), 'pipeline' (stage config), "
                        "'auth' (authentication), 'shell' (sandbox). "
                        "Omit to return all config entries."
                    ),
                },
            },
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="list_knowledge_sources",
        description=(
            "List all configured knowledge sources — URLs and content feeds that "
            "Nova crawls or monitors. Returns each source's name, URL, type, "
            "status, scope, and whether it has a credential attached. Use this "
            "to find out what the user has configured for crawling (LinkedIn, "
            "GitHub, websites, etc.) or to check crawl status."
        ),
        parameters={
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "description": "Filter by status: 'active', 'paused', 'error', 'restricted'. Omit for all.",
                },
                "scope": {
                    "type": "string",
                    "description": "Filter by scope: 'personal', 'shared'. Omit for all.",
                },
            },
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="list_mcp_servers",
        description=(
            "List all connected MCP (Model Context Protocol) servers and their "
            "available tools. Shows server name, connection status, transport type, "
            "and the full tool catalog for each server. Use this to discover what "
            "external tools are available (e.g. Firecrawl, filesystem, Brave Search)."
        ),
        parameters={"type": "object", "properties": {}, "required": []},
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="get_user_profile",
        description=(
            "Get information about the current user — display name, email, role, "
            "and account status. Use this to personalize responses or check what "
            "the user's role and permissions are."
        ),
        parameters={
            "type": "object",
            "properties": {
                "user_id": {
                    "type": "string",
                    "description": "UUID of the user. Omit to get the platform owner (first admin).",
                },
            },
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
]


# ─── Tool execution ─────────────────────────────────────────────────────────

async def execute_tool(name: str, arguments: dict) -> str:
    """Dispatch an introspection tool call by name."""
    log.info("Executing introspect tool: %s  args=%s", name, arguments)
    try:
        if name == "get_platform_config":
            return await _execute_get_platform_config(
                namespace=arguments.get("namespace"),
            )
        elif name == "list_knowledge_sources":
            return await _execute_list_knowledge_sources(
                status=arguments.get("status"),
                scope=arguments.get("scope"),
            )
        elif name == "list_mcp_servers":
            return await _execute_list_mcp_servers()
        elif name == "get_user_profile":
            return await _execute_get_user_profile(
                user_id=arguments.get("user_id"),
            )
        else:
            return f"Unknown introspect tool '{name}'"
    except Exception as e:
        log.error("Introspect tool %s failed: %s", name, e, exc_info=True)
        return f"Tool '{name}' failed: {e}"


# ─── Tool implementations ───────────────────────────────────────────────────

async def _execute_get_platform_config(namespace: str | None = None) -> str:
    """Query platform_config entries. Masks secret values."""
    from app.db import get_pool

    pool = get_pool()

    if namespace:
        rows = await pool.fetch(
            """
            SELECT key, value, description, is_secret
            FROM platform_config
            WHERE key LIKE $1 || '.%' OR key = $1
            ORDER BY key
            """,
            namespace,
        )
    else:
        rows = await pool.fetch(
            "SELECT key, value, description, is_secret FROM platform_config ORDER BY key"
        )

    if not rows:
        if namespace:
            return f"No config entries found for namespace '{namespace}'."
        return "No platform config entries found."

    sections = [f"=== Platform Configuration{f' ({namespace}.*)' if namespace else ''} ==="]
    for r in rows:
        key = r["key"]
        is_secret = r["is_secret"]
        desc = r["description"] or ""

        if is_secret:
            val_display = "[SECRET — configured]" if r["value"] is not None else "[SECRET — not set]"
        else:
            raw_val = r["value"]
            # JSONB comes back as Python objects — format for display
            if isinstance(raw_val, (dict, list)):
                val_display = json.dumps(raw_val)
            elif raw_val is None:
                val_display = "(not set)"
            else:
                val_display = json.dumps(raw_val)

        line = f"  {key:45s} = {val_display}"
        if desc:
            line += f"  # {desc}"
        sections.append(line)

    sections.append(f"\n{len(rows)} entries returned.")
    return "\n".join(sections)


async def _execute_list_knowledge_sources(
    status: str | None = None,
    scope: str | None = None,
) -> str:
    """List knowledge sources with URLs, types, and crawl status."""
    from app.db import get_pool

    pool = get_pool()

    query = """
        SELECT ks.id, ks.name, ks.url, ks.source_type, ks.status, ks.scope,
               ks.credential_id, ks.last_crawl_at, ks.last_crawl_summary,
               ks.created_at,
               kc.label AS credential_label
        FROM knowledge_sources ks
        LEFT JOIN knowledge_credentials kc ON ks.credential_id = kc.id
        WHERE 1=1
    """
    params: list = []
    idx = 1

    if status:
        query += f" AND ks.status = ${idx}"
        params.append(status)
        idx += 1
    if scope:
        query += f" AND ks.scope = ${idx}"
        params.append(scope)
        idx += 1

    query += " ORDER BY ks.created_at DESC"

    rows = await pool.fetch(query, *params)

    if not rows:
        filters = []
        if status:
            filters.append(f"status={status}")
        if scope:
            filters.append(f"scope={scope}")
        filter_str = f" (filters: {', '.join(filters)})" if filters else ""
        return f"No knowledge sources configured{filter_str}."

    sections = ["=== Knowledge Sources ==="]
    for r in rows:
        sections.append(f"  {r['name']}")
        sections.append(f"    URL:         {r['url']}")
        sections.append(f"    Type:        {r['source_type']}")
        sections.append(f"    Status:      {r['status']}")
        sections.append(f"    Scope:       {r['scope']}")
        if r["credential_label"]:
            sections.append(f"    Credential:  {r['credential_label']} (configured)")
        if r["last_crawl_at"]:
            sections.append(f"    Last crawl:  {r['last_crawl_at'].isoformat()}")
        if r["last_crawl_summary"]:
            sections.append(f"    Summary:     {r['last_crawl_summary'][:200]}")
        sections.append("")

    sections.append(f"{len(rows)} sources total.")
    return "\n".join(sections)


async def _execute_list_mcp_servers() -> str:
    """List connected MCP servers and their tool catalogs."""
    from app.db import get_pool
    from app.pipeline.tools.registry import list_connected_servers

    pool = get_pool()

    # Get DB records (includes disconnected/disabled servers)
    db_rows = await pool.fetch(
        "SELECT name, transport, enabled, command, url FROM mcp_servers ORDER BY name"
    )

    # Get live connection status
    live = {s["name"]: s for s in list_connected_servers()}

    if not db_rows and not live:
        return "No MCP servers configured."

    sections = ["=== MCP Servers ==="]
    for r in db_rows:
        name = r["name"]
        transport = r["transport"]
        enabled = r["enabled"]
        status_info = live.get(name)

        if status_info and status_info["connected"]:
            status = "CONNECTED"
            tool_count = status_info["tool_count"]
            tool_names = status_info.get("tools", [])
        elif not enabled:
            status = "DISABLED"
            tool_count = 0
            tool_names = []
        else:
            status = "DISCONNECTED"
            tool_count = 0
            tool_names = []

        sections.append(f"  {name}  ({transport})  [{status}]  {tool_count} tools")

        # Show endpoint (command for stdio, URL for http) — but mask env vars
        if transport == "http" and r["url"]:
            sections.append(f"    Endpoint: {r['url']}")
        elif r["command"]:
            sections.append(f"    Command:  {r['command']}")

        if tool_names:
            for t in tool_names:
                sections.append(f"    - {t}")
        sections.append("")

    sections.append(f"{len(db_rows)} servers configured, {len(live)} connected.")
    return "\n".join(sections)


async def _execute_get_user_profile(user_id: str | None = None) -> str:
    """Get user profile information."""
    from app.db import get_pool

    pool = get_pool()

    if user_id:
        row = await pool.fetchrow(
            """
            SELECT id, email, display_name, role, status, created_at, last_login_at
            FROM users WHERE id = $1::uuid
            """,
            user_id,
        )
    else:
        # Get the platform owner (first admin/owner user)
        row = await pool.fetchrow(
            """
            SELECT id, email, display_name, role, status, created_at, last_login_at
            FROM users
            WHERE role IN ('owner', 'admin') AND status = 'active'
            ORDER BY created_at ASC
            LIMIT 1
            """
        )

    if not row:
        if user_id:
            return f"User {user_id!r} not found."
        return "No admin/owner user found. Auth may not be configured."

    sections = ["=== User Profile ==="]
    sections.append(f"  Name:       {row['display_name'] or '(not set)'}")
    sections.append(f"  Email:      {row['email'] or '(not set)'}")
    sections.append(f"  Role:       {row['role']}")
    sections.append(f"  Status:     {row['status']}")
    sections.append(f"  User ID:    {row['id']}")
    sections.append(f"  Created:    {row['created_at'].isoformat() if row['created_at'] else 'unknown'}")
    if row["last_login_at"]:
        sections.append(f"  Last login: {row['last_login_at'].isoformat()}")

    return "\n".join(sections)
