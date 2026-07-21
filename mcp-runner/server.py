"""mcp-runner — stdio MCP sidecar (docs/plans/mcp-client.md, phase 4).

Bridges HTTP (from the backend, internal compose network only, no
published ports) to stdio MCP servers spawned as subprocesses. A fresh
subprocess + session per request — the same "stateless-friendly, no
persistent-connection lifecycle" choice mcp_client.py makes for the HTTP
transport, applied here to sidestep hand-rolled JSON-RPC framing entirely:
the `mcp` SDK's stdio_client + ClientSession already handle the initialize
handshake, request/response correlation, and content parsing correctly.

Security posture: command/args always come from an mcp_servers row that
was edit_mode-gated at creation time in the backend (never a free string
from an agent or the network) and are exec'd as an argv list via
StdioServerParameters — never through a shell. This container holds no DB
credentials and no Docker socket; a compromised client here can spawn
arbitrary local subprocesses, so it must never be reachable from outside
the backend (no `ports:` in compose — matching inference-control's
posture, adapted: that bridge is zero-parameter by design, this one
legitimately parameterizes on an already-vetted command).
"""

import logging

from fastapi import FastAPI, HTTPException
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

logging.basicConfig(level="INFO")
log = logging.getLogger("mcp-runner")

app = FastAPI()


def _require_command(body: dict) -> tuple[str, list[str]]:
    command = str(body.get("command", "")).strip()
    args = body.get("args") or []
    if not command:
        raise HTTPException(status_code=422, detail="command is required")
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        raise HTTPException(status_code=422, detail="args must be a list of strings")
    return command, args


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/list_tools")
async def list_tools(body: dict):
    command, args = _require_command(body)
    try:
        params = StdioServerParameters(command=command, args=args)
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.list_tools()
        return {"tools": [{"name": t.name, "description": t.description or "",
                           "parameters_schema": t.inputSchema or
                           {"type": "object", "properties": {}}}
                          for t in result.tools]}
    except HTTPException:
        raise
    except Exception as e:
        log.warning("list_tools failed for %s %s: %s", command, args, e)
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/call_tool")
async def call_tool(body: dict):
    command, args = _require_command(body)
    tool_name = str(body.get("tool_name", ""))
    arguments = body.get("arguments") or {}
    if not tool_name:
        raise HTTPException(status_code=422, detail="tool_name is required")
    try:
        params = StdioServerParameters(command=command, args=args)
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(tool_name, arguments)
        return {"content": [c.model_dump(mode="json") for c in result.content],
                "isError": result.isError}
    except HTTPException:
        raise
    except Exception as e:
        log.warning("call_tool failed for %s %s/%s: %s", command, args, tool_name, e)
        raise HTTPException(status_code=502, detail=str(e))
