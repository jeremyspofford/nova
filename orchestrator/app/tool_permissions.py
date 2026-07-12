"""
Tool permission helpers — reads/writes disabled tool groups from platform_config.

Default: everything enabled. Only stores what's OFF (disabled_groups list).
Key in platform_config: "tool_permissions" → {"disabled_groups": ["Web"]}

Permission resolution flow:
  platform_config (disabled_groups)
       │
       ▼
  get_disabled_tool_groups() → set[str]
       │
       ▼
  resolve_effective_tools(allowed_tools=None)
       ├─ filter registry by disabled groups
       ├─ filter MCP tools by disabled groups
       └─ optionally filter by pod allowed_tools
       │
       ▼
  list[ToolDefinition]  (passed to LLM)
"""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

from app.db import get_pool
from nova_contracts import ToolDefinition

if TYPE_CHECKING:
    from app.tools.sandbox import SandboxTier

log = logging.getLogger(__name__)

_CONFIG_KEY = "tool_permissions"


async def get_disabled_tool_groups() -> set[str]:
    """Return the set of disabled tool group names. Empty set = all enabled."""
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT value FROM platform_config WHERE key = $1", _CONFIG_KEY
        )
    if not row:
        return set()
    val = row["value"]
    if isinstance(val, str):
        val = json.loads(val)
    if isinstance(val, dict):
        return set(val.get("disabled_groups", []))
    return set()


async def get_default_allowed_tools() -> list[str] | None:
    """Return the global default tool allowlist, or None if unset.

    When set, agent turns that don't carry their own pod allowlist (i.e. the
    interactive chat path) see ONLY these tools. This keeps the default surface
    tiny so small local models reliably emit tool calls and the system prompt
    stays small — everything else (web, git, hardware, etc.) is reachable
    through run_shell. Other tools remain registered; widen or clear this list
    from the dashboard to expose them.
    """
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT value FROM platform_config WHERE key = $1", _CONFIG_KEY
        )
    if not row:
        return None
    val = row["value"]
    if isinstance(val, str):
        val = json.loads(val)
    if isinstance(val, dict):
        allow = val.get("default_allowed_tools")
        if isinstance(allow, list) and allow:
            return [str(t) for t in allow]
    return None


async def resolve_effective_tools(
    allowed_tools: list[str] | None = None,
    sandbox_tier: "SandboxTier | None" = None,
    *,
    default_allowlist_fallback: bool = True,
) -> tuple[list[ToolDefinition], set[str]]:
    """Centralized permission resolution — single entry point for all callers.

    Returns (effective_tools, disabled_groups) so callers can pass disabled_groups
    to the system prompt builder without a second DB query.

    Layers:
      1. Global permissions (disabled_groups from platform_config)
      2. Tier-aware descriptions (swap code/git tool descriptions for home/root)
      3. Pod allowlist (optional — filters within permitted tools)
    """
    from app.tools import get_permitted_tools
    from app.tools.sandbox import SandboxTier, get_sandbox

    disabled = await get_disabled_tool_groups()
    tools = get_permitted_tools(disabled)

    # Resolve tier: explicit param > contextvar > default (workspace)
    tier = sandbox_tier or get_sandbox()

    # Swap in tier-aware descriptions for Code and Git tools
    if tier not in (SandboxTier.workspace, SandboxTier.isolated):
        from app.tools.code_tools import get_code_tools
        from app.tools.git_tools import get_git_tools
        tier_tools = get_code_tools(tier) + get_git_tools(tier)
        tier_by_name = {t.name: t for t in tier_tools}
        tools = [tier_by_name.get(t.name, t) for t in tools]

    # Tool-level allowlist: an explicit pod allowlist wins; otherwise chat
    # surfaces fall back to the global default allowlist (minimal surface).
    # Pipeline agents pass default_allowlist_fallback=False — a NULL pod
    # allowlist there means "all permitted tools", not "chat minimal": goal
    # work (briefings, curation, intel) needs the full registry.
    if allowed_tools is None and default_allowlist_fallback:
        allowed_tools = await get_default_allowed_tools()
    if allowed_tools is not None:
        allowed_set = set(allowed_tools)
        tools = [t for t in tools if t.name in allowed_set]
        tools.extend(_pinned_mcp_tools(allowed_set, {t.name for t in tools}, disabled))

    return tools, disabled


def _pinned_mcp_tools(
    allowed_set: set[str], present: set[str], disabled: set[str],
) -> list[ToolDefinition]:
    """Schemas for mcp__ names an allowlist pins explicitly.

    Lazy loading keeps MCP schemas out of get_permitted_tools, so a pod
    that allowlists specific mcp__ tools would silently lose them. An
    explicit pin means "this pod's job IS that integration" — inject those
    schemas directly rather than making every run start with a load call.
    Admin-disabled server groups still win.
    """
    wanted = {n for n in allowed_set if n.startswith("mcp__") and n not in present}
    if not wanted:
        return []
    pinned: list[ToolDefinition] = []
    try:
        from app.pipeline.tools.registry import get_mcp_tool_definitions
        for t in get_mcp_tool_definitions():
            if t.name not in wanted:
                continue
            parts = t.name.split("__")
            if len(parts) >= 2 and f"MCP: {parts[1]}" in disabled:
                continue
            pinned.append(t)
    except Exception:
        log.debug("MCP registry unavailable while resolving pinned tools")
    return pinned


def get_valid_group_names() -> set[str]:
    """Return all valid group names (built-in + MCP)."""
    from app.tools import get_registry

    names = {g.name for g in get_registry()}

    # Include MCP group names
    try:
        from app.pipeline.tools.registry import get_mcp_tool_definitions
        for t in get_mcp_tool_definitions():
            parts = t.name.split("__")
            if len(parts) >= 2:
                names.add(f"MCP: {parts[1]}")
    except Exception:
        pass

    return names


async def set_disabled_groups(groups: set[str]) -> None:
    """Replace the full set of disabled groups."""
    await _save_disabled_groups(groups)


async def get_tool_groups_with_status() -> list[dict]:
    """Return all groups with enabled/disabled status and tool names.

    Includes both static built-in groups and MCP server groups.
    """
    from app.tools import get_registry

    disabled = await get_disabled_tool_groups()
    groups: list[dict] = []

    # Static built-in groups
    for g in get_registry():
        groups.append({
            "name": g.name,
            "display_name": g.display_name,
            "description": g.description,
            "tools": [t.name for t in g.tools],
            "tool_count": len(g.tools),
            "enabled": g.name not in disabled,
            "is_mcp": False,
        })

    # MCP server groups
    try:
        from app.pipeline.tools.registry import get_mcp_tool_definitions
        mcp_tools = get_mcp_tool_definitions()
        # Group by server name
        servers: dict[str, list[str]] = {}
        for t in mcp_tools:
            parts = t.name.split("__")
            if len(parts) >= 2:
                server = parts[1]
                servers.setdefault(server, []).append(t.name)
        for server, tools in sorted(servers.items()):
            group_name = f"MCP: {server}"
            groups.append({
                "name": group_name,
                "display_name": f"MCP: {server}",
                "description": f"Tools from MCP server '{server}'",
                "tools": tools,
                "tool_count": len(tools),
                "enabled": group_name not in disabled,
                "is_mcp": True,
            })
    except Exception:
        pass

    return groups


async def _save_disabled_groups(groups: set[str]) -> None:
    """Persist disabled groups to platform_config."""
    pool = get_pool()
    value = json.dumps({"disabled_groups": sorted(groups)})
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO platform_config (key, value, description, updated_at)
            VALUES ($1, $2::jsonb, $3, NOW())
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = NOW()
            """,
            _CONFIG_KEY,
            value,
            "Tool groups disabled by admin. Empty list = all enabled.",
        )
