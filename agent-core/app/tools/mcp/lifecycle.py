"""Boot/stop MCP stdio servers as child processes; register their tools.

Uses asyncio.create_subprocess_exec — argv passed as a list, no shell parsing.
"""
import asyncio
import logging
import os

from ..registry import Tier, register_mcp, unregister_mcp
from . import client as mcp_client

logger = logging.getLogger(__name__)


_READ_VERBS = ("get", "list", "fetch", "read", "search", "query", "describe", "show", "find")
_DESTRUCT_VERBS = ("delete", "remove", "drop", "destroy", "purge", "uninstall")


def _classify_tier(tool_name: str) -> Tier:
    """Verb heuristic — default MUTATE for safety."""
    lname = tool_name.lower().split(".")[-1]
    for v in _READ_VERBS:
        if lname.startswith(v):
            return Tier.READ
    for v in _DESTRUCT_VERBS:
        if lname.startswith(v):
            return Tier.DESTRUCT
    return Tier.MUTATE


async def start_server(
    server_id: str,
    command: str,
    args: list[str],
    env: dict[str, str],
    working_dir: str | None = None,
) -> None:
    """Spawn an MCP server subprocess and register its tools."""
    full_env = {**os.environ, **(env or {})}
    # create_subprocess_exec: argv passed as separate args; no shell interpretation
    proc = await asyncio.create_subprocess_exec(
        command, *(args or []),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=full_env,
        cwd=working_dir,
    )
    client = mcp_client.StdioMCPClient(proc)
    await client.start()

    tools = await client.list_tools()
    mcp_client.set_client(server_id, client)

    for t in tools:
        tool_name = t.get("name", "")
        if not tool_name:
            continue
        tier = _classify_tier(tool_name)
        register_mcp(
            server_id=server_id,
            tool_name=tool_name,
            remote_name=tool_name,
            tier=tier,
            schema={
                "description": t.get("description", ""),
                "inputSchema": t.get("inputSchema", {"type": "object", "properties": {}}),
            },
        )
    logger.info("MCP server %s connected with %d tools", server_id[:8], len(tools))


async def stop_server(server_id: str) -> None:
    """Disconnect MCP server and remove its tools from the registry."""
    client = mcp_client.remove_client(server_id)
    if client is not None:
        try:
            await client.close()
        except Exception as exc:
            logger.warning("error closing MCP client %s: %s", server_id[:8], exc)
    unregister_mcp(server_id)
    logger.info("MCP server %s stopped", server_id[:8])
