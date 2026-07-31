"""mcp-runner — stdio MCP sidecar (docs/plans/mcp-client.md, phase 4).

Bridges HTTP (from the backend, internal compose network only, no
published ports) to stdio MCP servers spawned as subprocesses. A fresh
subprocess + session per request — the same "stateless-friendly, no
persistent-connection lifecycle" choice mcp_client.py makes for the HTTP
transport, applied here to sidestep hand-rolled JSON-RPC framing entirely:
the `mcp` SDK's stdio_client + ClientSession already handle the initialize
handshake, request/response correlation, and content parsing correctly.

Security posture, corrected 2026-07-31. The paragraph that used to live here
said command/args "always come from an mcp_servers row whose command passed
the backend's launcher allow-list at creation time... never a free string
from an agent or the network". Every clause was true about the BACKEND and
none of it was enforced HERE. Measured: from `nova-searxng-1`, a plain
`POST /call_tool {"command":"sh","args":["-c",...]}` spawned the subprocess.
`sh` is not an allowed launcher. The allow-list guarded the registration
route; this process, the one that actually calls exec, checked nothing.

That is the codebase's own rule with the roles swapped — a description of a
control standing in for the control. So both halves now live at the exec:

  1. `_ALLOWED_LAUNCHERS` is re-checked here, on every request. A drift test
     (backend/tests/test_mcp_runner_guard.py) fails if it stops matching
     mcp_servers._STDIO_COMMANDS, because two copies with no test is how
     scopes.py's duplicate drifted within an hour.
  2. A shared secret. The allow-list alone still leaves `npx -y <package>`
     open to anything on the compose network, and that is arbitrary code by
     another name. NOVA_MCP_RUNNER_TOKEN must match; unset means REFUSE
     EVERYTHING, because a token that defaults to off is not a control.

This container still holds no DB credentials and no Docker socket, and has
no published ports. Nothing above replaces that; it stops the compose
network from being an implicit trust boundary.
"""

import hmac
import logging
import os

from fastapi import FastAPI, Header, HTTPException
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

logging.basicConfig(level="INFO")
log = logging.getLogger("mcp-runner")

app = FastAPI()

# Mirrors mcp_servers._STDIO_COMMANDS. Kept as its own copy on purpose: this
# container must be able to refuse without reaching the DB it deliberately
# cannot see. test_mcp_runner_guard.py is what keeps the two honest.
_ALLOWED_LAUNCHERS = {"npx", "uvx", "uv", "node", "python", "python3",
                      "deno", "bun"}

_TOKEN = os.environ.get("NOVA_MCP_RUNNER_TOKEN", "").strip()
if not _TOKEN:
    log.error("NOVA_MCP_RUNNER_TOKEN is unset — every exec request will be "
              "refused. Set it on both `backend` and `mcp-runner`.")


def _require_auth(authorization: str | None) -> None:
    """Fail closed: no token configured means no request is served."""
    if not _TOKEN:
        raise HTTPException(status_code=503,
                            detail="runner has no token configured")
    presented = ""
    if authorization and authorization.lower().startswith("bearer "):
        presented = authorization[7:].strip()
    if not hmac.compare_digest(presented, _TOKEN):
        raise HTTPException(status_code=401, detail="unauthorized")


def _require_command(body: dict) -> tuple[str, list[str]]:
    command = str(body.get("command", "")).strip()
    args = body.get("args") or []
    if not command:
        raise HTTPException(status_code=422, detail="command is required")
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        raise HTTPException(status_code=422, detail="args must be a list of strings")
    # The same two rules the backend applies at registration, applied where
    # the exec actually happens: a bare name, and one we allow.
    if command.rsplit("/", 1)[-1] != command:
        raise HTTPException(
            status_code=403,
            detail=f"launcher must be a bare name, not a path ({command!r})")
    if command not in _ALLOWED_LAUNCHERS:
        log.warning("refused launcher %r (args=%s)", command, args)
        raise HTTPException(
            status_code=403,
            detail=(f"launcher {command!r} is not allowed. Allowed: "
                    f"{', '.join(sorted(_ALLOWED_LAUNCHERS))}"))
    return command, args


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/list_tools")
async def list_tools(body: dict, authorization: str | None = Header(default=None)):
    _require_auth(authorization)
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
async def call_tool(body: dict, authorization: str | None = Header(default=None)):
    _require_auth(authorization)
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
