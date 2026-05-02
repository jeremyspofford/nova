"""
Nova Tool Registry — aggregates all tool sets into a single interface.

The runner imports ALL_TOOLS and execute_tool from here; it never
imports from individual tool modules directly. Adding a new tool set:
  1. Create orchestrator/app/tools/<name>_tools.py
  2. Import its list and execute_tool here
  3. Add to _REGISTRY below — it becomes a permission group automatically

MCP tools are dynamic — registered via the MCP server registry at runtime.
Use get_all_tools() when building a tool list for an LLM request to include
them; ALL_TOOLS only contains the static built-ins.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from app.tools.code_tools import CODE_TOOLS
from app.tools.code_tools import execute_tool as _exec_code
from app.tools.config_tools import CONFIG_TOOLS
from app.tools.config_tools import execute_tool as _exec_config
from app.tools.diagnosis_tools import DIAGNOSIS_TOOLS
from app.tools.diagnosis_tools import execute_tool as _exec_diagnosis
from app.tools.git_tools import GIT_TOOLS
from app.tools.git_tools import execute_tool as _exec_git
from app.tools.github_external_tools import GITHUB_EXTERNAL_TOOLS
from app.tools.github_external_tools import execute_tool as _exec_github_external
from app.tools.github_tools import GITHUB_TOOLS
from app.tools.github_tools import execute_tool as _exec_github
from app.tools.intel_tools import INTEL_TOOLS
from app.tools.intel_tools import execute_tool as _exec_intel
from app.tools.introspect_tools import INTROSPECT_TOOLS
from app.tools.introspect_tools import execute_tool as _exec_introspect
from app.tools.memory_tools import MEMORY_TOOLS
from app.tools.memory_tools import execute_tool as _exec_memory
from app.tools.platform_tools import PLATFORM_TOOLS
from app.tools.platform_tools import execute_tool as _exec_platform
from app.tools.web_tools import WEB_TOOLS
from app.tools.web_tools import execute_tool as _exec_web
from nova_contracts import ToolDefinition

# ── Registry ──────────────────────────────────────────────────────────────────

@dataclass
class ToolGroup:
    name: str           # Stable internal ID — used in DB, API, and pod allowlists
    display_name: str   # User-facing label — shown in dashboard UI
    description: str
    tools: list[ToolDefinition]
    executor: Callable

_REGISTRY: list[ToolGroup] = [
    ToolGroup("Platform", "Agent Management",  "Manage agents and list available models",        PLATFORM_TOOLS, _exec_platform),
    ToolGroup("Code",     "Files & Shell",     "Read, write, and search files; run shell",       CODE_TOOLS,     _exec_code),
    ToolGroup("Git",      "Version Control",   "View status, diffs, logs, and create commits",   GIT_TOOLS,      _exec_git),
    ToolGroup("Web",      "Internet Access",   "Search the internet and fetch web pages",        WEB_TOOLS,      _exec_web),
    ToolGroup("Diagnosis", "Self-Diagnosis",  "Diagnose task failures, check service health, analyse errors", DIAGNOSIS_TOOLS, _exec_diagnosis),
    ToolGroup("Introspect", "Platform Awareness", "Query platform config, knowledge sources, MCP servers, user profiles", INTROSPECT_TOOLS, _exec_introspect),
    ToolGroup("Memory", "Knowledge Retrieval", "Search, recall, and read from Nova's memory system", MEMORY_TOOLS, _exec_memory),
    ToolGroup("Intel", "Intelligence Analysis", "Query intel feeds, create recommendations, check dismissed content", INTEL_TOOLS, _exec_intel),
    ToolGroup("Config", "Skills & Rules", "Manage prompt skills and behavior rules", CONFIG_TOOLS, _exec_config),
    ToolGroup("GitHub", "Self-Modification", "Create branches, push code, and manage pull requests on Nova's own repo", GITHUB_TOOLS, _exec_github),
    ToolGroup("github_external", "GitHub (External Repos)", "Read CI runs, logs, diffs, and locate bugs on arbitrary GitHub repos.", GITHUB_EXTERNAL_TOOLS, _exec_github_external),
]

# Derived from registry — same shapes the rest of the codebase expects
ALL_TOOLS: list[ToolDefinition] = [t for g in _REGISTRY for t in g.tools]

# Fast name → executor lookup built once at import time
_DISPATCH: dict[str, Callable] = {}
_GROUP_NAMES: dict[str, set[str]] = {}
for _g in _REGISTRY:
    names = {t.name for t in _g.tools}
    _GROUP_NAMES[_g.name] = names
    for _n in names:
        _DISPATCH[_n] = _g.executor


# ── Public API ────────────────────────────────────────────────────────────────

def get_tool_groups() -> dict[str, list[str]]:
    """Return group name → list of tool names (static built-ins only)."""
    return {g.name: [t.name for t in g.tools] for g in _REGISTRY}


def get_registry() -> list[ToolGroup]:
    """Return the full registry for permission UI / introspection."""
    return list(_REGISTRY)


def get_permitted_tools(disabled_groups: set[str]) -> list[ToolDefinition]:
    """Return all tools except those in disabled groups.

    Filters both static built-ins and MCP tools. MCP groups are prefixed
    with "MCP: " — e.g. disabling "MCP: filesystem" removes all tools
    from the filesystem MCP server.
    """
    if not disabled_groups:
        return get_all_tools()

    # Filter static tools
    tools: list[ToolDefinition] = []
    for g in _REGISTRY:
        if g.name not in disabled_groups:
            tools.extend(g.tools)

    # Filter MCP tools
    try:
        from app.pipeline.tools.registry import get_mcp_tool_definitions
        for t in get_mcp_tool_definitions():
            # mcp__{server}__{tool} → server name → "MCP: {server}"
            parts = t.name.split("__")
            if len(parts) >= 2:
                mcp_group = f"MCP: {parts[1]}"
                if mcp_group not in disabled_groups:
                    tools.append(t)
            else:
                tools.append(t)
    except Exception:
        pass

    return tools


def get_all_tools() -> list[ToolDefinition]:
    """
    Return all available tools: built-ins + dynamically-registered MCP tools.

    Call this when building a tool list for an LLM request so MCP server tools
    are included. Do NOT call at module import time — MCP servers are loaded
    asynchronously after startup.
    """
    try:
        from app.pipeline.tools.registry import get_mcp_tool_definitions
        return ALL_TOOLS + get_mcp_tool_definitions()
    except Exception:
        # MCP registry unavailable (e.g., during tests) — fall back to built-ins
        return list(ALL_TOOLS)


async def execute_tool(name: str, arguments: dict) -> str:
    """Dispatch a tool call to the appropriate module."""
    # ── Hard rule enforcement (pre-execution) ──
    try:
        from app.rules import check_hard_rules
        allowed, violation_msg = await check_hard_rules(name, arguments)
        if not allowed:
            return f"Tool execution blocked: {violation_msg}"
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("Rule check failed: %s", e)

    # MCP tools are namespaced as mcp__{server}__{tool}
    if name.startswith("mcp__"):
        try:
            from app.pipeline.tools.registry import execute_mcp_tool
            return await execute_mcp_tool(name, arguments)
        except Exception as e:
            return f"MCP dispatch error: {e}"

    executor = _DISPATCH.get(name)
    if executor:
        return await executor(name, arguments)

    all_names = [t.name for t in ALL_TOOLS]
    return f"Unknown tool '{name}'. Available: {all_names}"
