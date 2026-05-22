"""Check whether an expected tool is registered in agent-core.

MCP tool discovery requires two endpoints:
  GET /api/v1/mcp/servers              → list servers (no tools embedded)
  GET /api/v1/mcp/servers/{id}/tools   → tools for one server

The earlier implementation only hit the first endpoint and looked for a
`tools` field in each server row that the server endpoint never populates.
Result: every MCP tool was incorrectly reported as `mcp-not-registered`,
even when fully working — the 2026-05-22 audit caught this with
browser_navigate (Playwright MCP had 23 tools registered, audit said 0).
"""
from __future__ import annotations

import asyncio

import httpx

_BUILTIN = frozenset({
    "fs.read", "fs.write", "fs.delete",
    "shell.exec", "code.execute",
    "memory.search", "memory.write",
    "nova.secrets.write", "nova.secrets.read",
    "web.search", "web.fetch",
})


def is_builtin_tool(name: str) -> bool:
    return name in _BUILTIN


def find_tool_in_mcp_response(payload: list[dict], tool_name: str) -> bool:
    """Search a flattened list of {server_id, tools[]} records for tool_name."""
    for server in payload or []:
        for tool in server.get("tools") or []:
            if tool.get("name") == tool_name:
                return True
    return False


async def _fetch_server_tools(
    client: httpx.AsyncClient, base_url: str, server_id: str, headers: dict,
) -> list[dict]:
    """Return [{name, ...}, ...] for one server, or [] on error."""
    try:
        r = await client.get(
            f"{base_url}/api/v1/mcp/servers/{server_id}/tools", headers=headers,
        )
        if r.status_code != 200:
            return []
        body = r.json()
        # The endpoint returns a bare list of tool descriptors
        return body if isinstance(body, list) else []
    except Exception:
        return []


async def check_tool_available(
    base_url: str, tool_name: str, admin_headers: dict,
) -> tuple[bool, str | None]:
    if is_builtin_tool(tool_name):
        return True, None
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.get(f"{base_url}/api/v1/mcp/servers", headers=admin_headers)
        if r.status_code != 200:
            return False, f"mcp-list returned {r.status_code}"
        servers = r.json() or []
        # Fetch each server's tools concurrently; merge into the shape
        # find_tool_in_mcp_response expects: [{tools: [...]}, ...]
        tools_lists = await asyncio.gather(
            *(
                _fetch_server_tools(client, base_url, s.get("id", ""), admin_headers)
                for s in servers if s.get("enabled")
            ),
            return_exceptions=False,
        )
    enriched = [{"tools": t} for t in tools_lists]
    if find_tool_in_mcp_response(enriched, tool_name):
        return True, None
    return False, "mcp-not-registered"
