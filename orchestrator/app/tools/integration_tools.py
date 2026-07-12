"""
Integration Tools — lazy loading of MCP server toolsets.

Connected MCP servers no longer inject their full tool schemas into every
LLM call (AdGuard Home alone is 65 tools; three integrations cost 10-25k
tokens per stage call, and small local models get worse at tool selection
as the list grows). Instead each server contributes one line to a
capability index embedded in this meta-tool's description, and the agent
calls load_integration_tools(server=...) to pull in a server's real
schemas for the remainder of the conversation.

The splice into the live tool list happens in the agent tool loop
(app.agents.runner._run_tool_loop) — this module only builds the
meta-tool definition and resolves a load request into (receipt text,
tool definitions).

A server can opt out of lazy loading with metadata.always_inject=true
(Settings → MCP servers): its schemas then ride along in every call as
before, and it is dropped from the capability index.
"""
from __future__ import annotations

import logging

from nova_contracts import BlastRadius, ToolDefinition

log = logging.getLogger(__name__)

LOAD_INTEGRATION_TOOL_NAME = "load_integration_tools"


def _lazy_index(disabled_groups: set[str] | None = None) -> list[dict]:
    """Capability index filtered by admin-disabled MCP groups."""
    from app.pipeline.tools.registry import get_capability_index

    disabled = disabled_groups or set()
    return [
        entry for entry in get_capability_index()
        if f"MCP: {entry['server']}" not in disabled
    ]


def build_load_integration_tool(
    disabled_groups: set[str] | None = None,
) -> ToolDefinition | None:
    """Build the meta-tool, or None when no lazy server is connected.

    The definition is rebuilt per request on purpose: the description
    embeds the live capability index (so every agent — chat or pipeline —
    sees what exists without a separate prompt block) and the server
    parameter is an enum of the currently loadable names (so small local
    models can't misspell a server).
    """
    index = _lazy_index(disabled_groups)
    if not index:
        return None

    lines = [
        f"- {e['server']} — {e['description'] or 'no description'} ({e['tool_count']} tools)"
        for e in index
    ]
    return ToolDefinition(
        name=LOAD_INTEGRATION_TOOL_NAME,
        description=(
            "Load the tools of a connected integration (MCP server) into this "
            "conversation. Integration tools are not listed until loaded — "
            "call this first when a request involves one of these "
            "integrations, then call the tools it adds.\n"
            "Connected integrations:\n" + "\n".join(lines)
        ),
        parameters={
            "type": "object",
            "properties": {
                "server": {
                    "type": "string",
                    "description": "Integration to load, from the connected list",
                    "enum": [e["server"] for e in index],
                },
            },
            "required": ["server"],
        },
        blast_radius=BlastRadius.READ,
    )


async def load_server_tools(
    server: str,
    disabled_groups: set[str] | None = None,
) -> tuple[str, list[ToolDefinition]]:
    """Resolve a load request → (receipt text for the model, definitions).

    The receipt lists what became available so the model can pick its next
    call without re-asking. Unknown/disconnected servers and admin-disabled
    groups return an explanatory text and no definitions — never an
    exception (tool results must stay parseable turn content).
    """
    from app.pipeline.tools.registry import get_server_tool_definitions

    if disabled_groups is None:
        try:
            from app.tool_permissions import get_disabled_tool_groups
            disabled_groups = await get_disabled_tool_groups()
        except Exception as e:
            log.warning("Could not resolve disabled tool groups: %s", e)
            disabled_groups = set()

    if f"MCP: {server}" in disabled_groups:
        return (
            f"Integration '{server}' is disabled by your admin. If the user "
            "needs it, suggest re-enabling it in Settings.",
            [],
        )

    defs = get_server_tool_definitions(server)
    if not defs:
        available = [e["server"] for e in _lazy_index(disabled_groups)]
        return (
            f"Integration '{server}' is not connected. "
            f"Loadable integrations: {available or 'none'}",
            [],
        )

    lines = []
    for t in defs:
        # First sentence, without the "[server]" prefix the registry adds
        desc = (t.description or "").split(".")[0].strip()
        if desc.startswith(f"[{server}]"):
            desc = desc[len(server) + 2:].strip()
        lines.append(f"- {t.name} — {desc}" if desc else f"- {t.name}")

    receipt = (
        f"Loaded {len(defs)} tools from '{server}'. They are now available "
        "as regular tools for the rest of this task:\n" + "\n".join(lines)
    )
    return receipt, defs


async def execute_tool(name: str, arguments: dict) -> str:
    """Plain executor for dispatch paths outside the agent tool loop.

    The loop handles this tool specially (it must splice the definitions
    into the live tool list); this fallback still answers with the receipt
    so a direct execute_tool() call degrades gracefully instead of
    'Unknown tool'.
    """
    if name != LOAD_INTEGRATION_TOOL_NAME:
        return f"Unknown integration tool '{name}'"
    text, _ = await load_server_tools(str(arguments.get("server", "")))
    return text
