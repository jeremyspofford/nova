"""MCP client — the one place Nova speaks the Model Context Protocol wire
format (mirrors llm/openai_compat.py's role for the LLM API).

HTTP transport connects directly (streamable-http). Stdio transport has no
runtime here at all (no Node, no general exec sandbox) — it's relayed
through the mcp-runner sidecar, which spawns the subprocess and speaks
stdio MCP itself via the same SDK. Either way this module returns the same
(status, tools, error) / result shape, so callers (mcp_servers.py,
tools/registry.py) never branch on transport.

API confirmed against the installed `mcp` package (1.28.1) directly —
`from mcp import ClientSession` + `mcp.client.streamable_http.streamablehttp_client`,
not scraped docs (that library's client surface moves).
"""

import hashlib
import json
import logging
from datetime import timedelta
from typing import Optional

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from app.config import settings

log = logging.getLogger(__name__)

_CONNECT_TIMEOUT_S = 10.0  # list_tools should be fast; call_tool uses the caller's timeout


def tool_list_hash(tools: list[dict]) -> str:
    """Hash over name+description only — the prompt-injection-relevant
    surface. A schema-only change doesn't need re-approval; a description
    change does (that's the text that lands in agent prompts)."""
    material = json.dumps(sorted((t["name"], t["description"]) for t in tools),
                          sort_keys=True)
    return hashlib.sha256(material.encode()).hexdigest()


async def connect_and_list(server: dict) -> tuple[str, list[dict], Optional[str]]:
    """Connect to an MCP server (either transport) and list its tools.

    Returns (status, tools, error_detail): status is 'connected' or 'error';
    tools is [] on error. Never raises — every failure mode becomes an
    'error' status with a human-readable detail string, so callers never
    need their own try/except around this.
    """
    if server["transport"] == "stdio":
        return await _stdio_connect_and_list(server)
    if server["transport"] != "http":
        return "error", [], f"unknown transport: {server['transport']}"
    url = server.get("url") or ""
    if not url:
        return "error", [], "no url configured"
    headers = server.get("headers") or {}
    try:
        async with streamablehttp_client(url, headers=headers,
                                         timeout=_CONNECT_TIMEOUT_S) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.list_tools()
        tools = [{"name": t.name, "description": t.description or "",
                  "parameters_schema": t.inputSchema or
                  {"type": "object", "properties": {}}}
                 for t in result.tools]
        return "connected", tools, None
    except Exception as e:
        log.warning("MCP connect failed for server '%s' (%s): %s",
                    server.get("name"), url, e)
        return "error", [], str(e)


async def _stdio_connect_and_list(server: dict) -> tuple[str, list[dict], Optional[str]]:
    command = server.get("command") or ""
    if not command:
        return "error", [], "no command configured"
    try:
        async with httpx.AsyncClient(timeout=_CONNECT_TIMEOUT_S + 5) as client:
            resp = await client.post(f"{settings.mcp_runner_url}/list_tools",
                                     json={"command": command, "args": server.get("args") or []})
            resp.raise_for_status()
        return "connected", resp.json()["tools"], None
    except Exception as e:
        log.warning("mcp-runner list_tools failed for server '%s' (%s): %s",
                    server.get("name"), command, e)
        return "error", [], str(e)


async def call_tool(server: dict, tool_name: str, args: dict,
                    timeout: float, size_cap_kb: int) -> str:
    """Live tool call — a fresh session per call (MCP streamable-HTTP and
    the mcp-runner sidecar are both stateless-friendly; no persistent
    -connection lifecycle to manage). Raises on failure; callers wrap this
    in the same try/except-log-and-return-error shape as the DB http_call
    tool path."""
    if server["transport"] == "stdio":
        content, is_error = await _stdio_call_tool(server, tool_name, args, timeout)
    elif server["transport"] == "http":
        content, is_error = await _http_call_tool(server, tool_name, args, timeout)
    else:
        raise ValueError(f"unknown transport: {server['transport']}")

    parts = [c.get("text", "") for c in content if c.get("type") == "text"]
    text = "\n".join(parts) if parts else json.dumps(content)
    cap = size_cap_kb * 1024
    if len(text) > cap:
        text = text[:cap] + f"\n...[truncated at {size_cap_kb}KB]"
    if is_error:
        return f"Error from MCP tool '{tool_name}': {text}"
    return text


async def _stdio_call_tool(server: dict, tool_name: str, args: dict,
                           timeout: float) -> tuple[list[dict], bool]:
    command = server.get("command") or ""
    async with httpx.AsyncClient(timeout=timeout + 5) as client:
        resp = await client.post(f"{settings.mcp_runner_url}/call_tool", json={
            "command": command, "args": server.get("args") or [],
            "tool_name": tool_name, "arguments": args})
        resp.raise_for_status()
    body = resp.json()
    return body["content"], bool(body.get("isError"))


async def _http_call_tool(server: dict, tool_name: str, args: dict,
                          timeout: float) -> tuple[list[dict], bool]:
    url = server.get("url") or ""
    headers = server.get("headers") or {}
    async with streamablehttp_client(url, headers=headers, timeout=timeout) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(
                tool_name, args, read_timeout_seconds=timedelta(seconds=timeout))
    content = [c.model_dump(mode="json") for c in result.content]
    return content, bool(result.isError)
