"""MCP dispatcher — tier-gated MCP tool calls with audit chain events."""
from __future__ import annotations

import logging

from .audit import write_event
from .mcp import mcp_manager
from .mcp.discovery import discover_tools
from .registry import Tier

logger = logging.getLogger(__name__)

# Tiers that require explicit user approval before invocation.
_APPROVAL_REQUIRED_TIERS = {Tier.MUTATE.value, Tier.DESTRUCT.value}


async def call_mcp_tool(
    *,
    server_id: str,
    server_name: str,
    tool_name: str,
    args: dict,
    task_id: str,
    pool,
    effective_tier: str,
) -> object:
    """Invoke an MCP tool with audit chain events.

    Writes tool_call_start and tool_call_result (or tool_call_error) events to
    the audit chain.  Ensures the MCP server process is alive before calling.
    On crash: calls handle_crash(); if restarted, retries once.

    Args:
        server_id:      UUID string of the mcp_servers row.
        server_name:    Human-readable server name (for MCPManager lookup).
        tool_name:      MCP tool name to invoke.
        args:           Tool arguments dict.
        task_id:        Parent task UUID string (for audit chain).
        pool:           asyncpg connection pool.
        effective_tier: Resolved tier string (e.g. "READ", "MUTATE").
    """
    await write_event(pool, task_id, "tool_call_start", {
        "server_id": server_id,
        "server_name": server_name,
        "tool_name": tool_name,
        "args": args,
        "tier": effective_tier,
    })

    try:
        mcp = await mcp_manager.ensure_running(server_id, server_name)
        result = await mcp.client.call_tool(tool_name, args)
    except Exception as first_err:
        restarted = await mcp_manager.handle_crash(server_id, server_name, str(first_err))
        if restarted:
            try:
                mcp = await mcp_manager.ensure_running(server_id, server_name)
                result = await mcp.client.call_tool(tool_name, args)
            except Exception as retry_err:
                await write_event(pool, task_id, "tool_call_error", {
                    "server_id": server_id,
                    "tool_name": f"{server_name}/{tool_name}",
                    "error": str(retry_err),
                })
                raise
        else:
            await write_event(pool, task_id, "tool_call_error", {
                "server_id": server_id,
                "tool_name": f"{server_name}/{tool_name}",
                "error": str(first_err),
                "server_disabled": True,
            })
            raise RuntimeError(
                f"MCP server {server_name!r} disabled after repeated crashes"
            ) from first_err

    await write_event(pool, task_id, "tool_call_result", {
        "server_id": server_id,
        "tool_name": tool_name,
        "result": result if isinstance(result, dict) else {"output": str(result)},
    })
    return result
