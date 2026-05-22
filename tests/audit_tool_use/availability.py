"""Check whether an expected tool is registered in agent-core."""
from __future__ import annotations
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
    """Search MCP `/api/v1/mcp/servers` response for a server exposing tool_name."""
    for server in payload or []:
        for tool in server.get("tools") or []:
            if tool.get("name") == tool_name:
                return True
    return False


async def check_tool_available(
    base_url: str, tool_name: str, admin_headers: dict,
) -> tuple[bool, str | None]:
    if is_builtin_tool(tool_name):
        return True, None
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.get(f"{base_url}/api/v1/mcp/servers", headers=admin_headers)
    if r.status_code != 200:
        return False, f"mcp-list returned {r.status_code}"
    if find_tool_in_mcp_response(r.json(), tool_name):
        return True, None
    return False, "mcp-not-registered"
