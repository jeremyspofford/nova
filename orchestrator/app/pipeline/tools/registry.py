"""
MCP Tool Registry — manages active server connections and provides a unified
tool interface that merges Nova's built-in tools with MCP server tools.

Workflow:
  startup  → load_mcp_servers()           Connect to all enabled DB entries
  request  → get_mcp_tool_definitions()   ToolDefinition list for LLM requests
  agent    → execute_mcp_tool(name, args) Dispatch tool call to the right server
  ops      → list_connected_servers()     Health / status check for the dashboard
  runtime  → reload_mcp_server(name)      Hot-reconnect without full restart
  shutdown → stop_all_servers()           Gracefully terminate all subprocesses

Tool naming convention (avoids collisions across servers):
  mcp__{server_name}__{tool_name}
  e.g. mcp__filesystem__read_file, mcp__brave-search__web_search
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import TYPE_CHECKING

from nova_contracts import ToolDefinition

if TYPE_CHECKING:
    from .http_mcp_client import HTTPMCPClient
    from .mcp_client import StdioMCPClient

log = logging.getLogger(__name__)

# name → connected client (populated by load_mcp_servers at startup)
# Values are StdioMCPClient or HTTPMCPClient — both share the same public interface
_active_clients: dict[str, "StdioMCPClient | HTTPMCPClient"] = {}

# name → {"transport": str, "metadata": dict}. Kept in lockstep with _active_clients
# so the consent gate can classify an MCP tool's blast radius (app.tools.mcp_classify)
# without a DB round-trip on every call. Mutated only under _registry_lock.
_server_meta: dict[str, dict] = {}

# Catalog-installed servers store secrets as ${secret:KEY} references in env (the
# plaintext lives encrypted in platform_secrets). Resolve them to real values at
# connect time so nothing sensitive is ever written to mcp_servers.env (JSONB).
_SECRET_REF = re.compile(r"^\$\{secret:([^}]+)\}$")


async def _resolve_secret_refs(env: dict) -> dict:
    """Replace ${secret:KEY} env values with the decrypted platform secret.

    Non-reference values pass through unchanged. A reference to a missing secret
    is dropped (with a WARNING) rather than passed literally to the subprocess.
    """
    if not any(isinstance(v, str) and v.startswith("${secret:") for v in env.values()):
        return env
    from app import secrets_store
    from app.db import get_pool

    pool = get_pool()
    out: dict = {}
    for key, val in env.items():
        match = _SECRET_REF.match(val) if isinstance(val, str) else None
        if match:
            secret_val = await secrets_store.get_secret(pool, match.group(1))
            if secret_val is None:
                log.warning("MCP env %r references missing secret %s — dropping", key, match.group(1))
                continue
            out[key] = secret_val
        else:
            out[key] = val
    return out

# Protects _active_clients against concurrent mutation (reload/disconnect racing
# with tool execution and discovery). Acquire around all dict mutations.
# Sync functions (get_mcp_tool_definitions, get_tools_by_server, list_connected_servers)
# use list() snapshots and are safe without the lock because they never yield to
# the event loop — no concurrent coroutine can mutate the dict mid-execution.
_registry_lock = asyncio.Lock()


# ── Lifecycle ─────────────────────────────────────────────────────────────────

async def load_mcp_servers() -> int:
    """
    Connect to all enabled stdio MCP servers from the database.
    Called once in the orchestrator lifespan. Returns the number connected.

    Errors for individual servers are logged and skipped — a bad config on one
    server should never prevent the orchestrator from starting.
    """
    from app.db import get_pool

    pool = get_pool()
    if pool is None:
        log.warning("DB not available — skipping MCP server load")
        return 0

    connected = 0
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM mcp_servers WHERE enabled = TRUE"
            )
        results = await asyncio.gather(
            *(_connect_server(dict(row)) for row in rows),
            return_exceptions=True,
        )
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                log.error("MCP server '%s' raised during connect: %s", rows[i]["name"], result)
            elif result:
                connected += 1
    except Exception as e:
        log.error("Failed to load MCP servers from DB: %s", e)

    return connected


async def stop_all_servers() -> None:
    """
    Gracefully stop all connected MCP server subprocesses.
    Called in the orchestrator lifespan shutdown.
    """
    async with _registry_lock:
        clients = list(_active_clients.items())
        _active_clients.clear()
        _server_meta.clear()

    async def _stop_one(name: str, client: "StdioMCPClient | HTTPMCPClient") -> None:
        try:
            await client.stop()
        except Exception as e:
            log.warning("Error stopping MCP server '%s': %s", name, e)

    await asyncio.gather(*(_stop_one(n, c) for n, c in clients))
    log.info("All MCP servers stopped")


# ── Server management ─────────────────────────────────────────────────────────

async def reload_mcp_server(name: str) -> bool:
    """
    Reconnect a specific MCP server from its current DB configuration.
    Used when the user edits a server config or manually triggers a reconnect.
    Returns True if successfully connected.
    """
    from app.db import get_pool

    pool = get_pool()
    if pool is None:
        return False

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM mcp_servers WHERE name = $1", name
        )
    if not row:
        log.warning("MCP server '%s' not found in DB for reload", name)
        return False

    return await _connect_server(dict(row))


async def disconnect_server(name: str) -> None:
    """Disconnect and remove a specific MCP server from the active registry."""
    async with _registry_lock:
        client = _active_clients.pop(name, None)
        _server_meta.pop(name, None)
    if client:
        try:
            await client.stop()
        except Exception as e:
            log.warning("Error disconnecting MCP server '%s': %s", name, e)


async def _connect_server(cfg: dict) -> bool:
    """
    Connect to a single MCP server using its DB config dict.
    Dispatches to StdioMCPClient or HTTPMCPClient based on the transport field.
    Replaces any existing connection for the same server name.
    Returns True on success, False on failure.
    """
    name = cfg["name"]
    transport = cfg.get("transport", "stdio")

    # Atomically pop any existing connection under the lock (fixes TOCTOU race
    # where two concurrent _connect_server calls both see the key and race to
    # disconnect, potentially leaking the first client).
    async with _registry_lock:
        old_client = _active_clients.pop(name, None)
        _server_meta.pop(name, None)
    if old_client:
        try:
            await old_client.stop()
        except Exception as e:
            log.warning("Error disconnecting MCP server '%s': %s", name, e)

    try:
        resolved_env = await _resolve_secret_refs(dict(cfg.get("env") or {}))
        if transport == "http":
            from .http_mcp_client import HTTPMCPClient

            url = cfg.get("url")
            if not url:
                log.warning("MCP server '%s' has transport=http but no URL — skipping", name)
                return False

            client = HTTPMCPClient(
                name=name,
                url=url,
                env=resolved_env,
            )
        else:
            from .mcp_client import StdioMCPClient

            if not cfg.get("command"):
                log.warning("MCP server '%s' has no command configured — skipping", name)
                return False

            client = StdioMCPClient(
                name=name,
                command=cfg["command"],
                args=list(cfg.get("args") or []),
                env=resolved_env,
            )

        await client.start()
        await client.list_tools()
        async with _registry_lock:
            _active_clients[name] = client
            _server_meta[name] = {
                "transport": transport,
                "metadata": dict(cfg.get("metadata") or {}),
            }
        log.info(
            "MCP server '%s' connected via %s (%d tools)",
            name, transport, len(client.tools),
        )
        return True
    except Exception as e:
        log.error("Failed to connect MCP server '%s' (%s): %s", name, transport, e)
        return False


# ── Tool discovery & dispatch ─────────────────────────────────────────────────

def get_mcp_tool_definitions() -> list[ToolDefinition]:
    """
    Build ToolDefinition objects for all tools from connected MCP servers.

    Tool names are namespaced: mcp__{server_name}__{tool_name}
    This ensures no collisions with Nova's built-in tools or across servers.
    Descriptions are prefixed with the server name for clarity in the LLM's
    tool list.
    """
    tools: list[ToolDefinition] = []
    # Snapshot to avoid iteration during concurrent mutation
    for client in list(_active_clients.values()):
        if not client.connected:
            continue
        for tool in client.tools:
            tools.append(ToolDefinition(
                name=f"mcp__{tool.server_name}__{tool.name}",
                description=f"[{tool.server_name}] {tool.description}",
                parameters=tool.input_schema,
            ))
    return tools


async def execute_mcp_tool(name: str, arguments: dict) -> str:
    """
    Execute an MCP tool by its fully-qualified namespaced name.

    Args:
        name: Tool name in the format 'mcp__{server_name}__{tool_name}'
        arguments: Arguments dict matching the tool's input schema

    Returns:
        The tool's text output, or an error message string.
    """
    parts = name.split("__", 2)
    if len(parts) != 3 or parts[0] != "mcp":
        return (
            f"Invalid MCP tool name '{name}'. "
            "Expected format: mcp__server_name__tool_name"
        )

    _, server_name, tool_name = parts

    # Snapshot under lock so a concurrent reload can't yank the client between
    # lookup and the await call_tool() below.
    async with _registry_lock:
        client = _active_clients.get(server_name)
        if client is None:
            connected = list(_active_clients.keys())

    if client is None:
        return (
            f"MCP server '{server_name}' is not connected. "
            f"Connected servers: {connected}"
        )

    try:
        log.info("Executing MCP tool: %s (server=%s)  args=%s", tool_name, server_name, arguments)
        result = await client.call_tool(tool_name, arguments)
        log.debug("MCP tool %s returned %d chars", tool_name, len(result))
        await _log_mcp_activity(server_name, tool_name, arguments, len(result))
        return result
    except Exception as e:
        log.error(
            "MCP tool '%s' on server '%s' failed: %s",
            tool_name, server_name, e,
        )
        await _log_mcp_activity(server_name, tool_name, arguments, error=str(e))
        return f"MCP tool error: {e}"


# ── Tool catalog (for dashboard picker) ────────────────────────────────────────

def get_tools_by_server() -> list[dict]:
    """Tool details grouped by MCP server, for the dashboard tool picker."""
    result = []
    for name, client in list(_active_clients.items()):
        if not client.connected:
            continue
        result.append({
            "category": name,
            "source": "mcp",
            "tools": [
                {"name": f"mcp__{name}__{t.name}", "description": t.description}
                for t in client.tools
            ],
        })
    return result


# ── Activity logging ──────────────────────────────────────────────────────────

async def _log_mcp_activity(
    server: str,
    tool: str,
    arguments: dict,
    result_len: int = 0,
    error: str | None = None,
) -> None:
    """Write MCP tool execution to activity_events. Never raises."""
    try:
        from app.activity import emit_activity
        from app.db import get_pool

        pool = get_pool()
        if pool is None:
            return

        if error:
            summary = f"[{server}] {tool} failed: {error[:120]}"
            severity = "warning"
        else:
            # Build a concise summary from the args
            url = arguments.get("url", "")
            query = arguments.get("query", "")
            detail = url or query or ""
            if len(detail) > 80:
                detail = detail[:77] + "..."
            summary = f"[{server}] {tool}"
            if detail:
                summary += f" — {detail}"
            summary += f" ({result_len:,} chars)"
            severity = "info"

        await emit_activity(
            pool,
            event_type="mcp_tool_call",
            service=f"mcp:{server}",
            summary=summary,
            severity=severity,
            metadata={"server": server, "tool": tool, "args": arguments, "result_len": result_len, "error": error},
        )
    except Exception:
        log.debug("Failed to log MCP activity for %s.%s", server, tool, exc_info=True)


# ── Status / health ───────────────────────────────────────────────────────────

def get_server_meta(name: str) -> dict:
    """Transport + metadata for a connected MCP server ({} if unknown/disconnected).

    Consumed by the consent-gate dispatch (app.tools._dispatch_mcp_via_consent) to
    classify an MCP tool's blast radius without hitting Postgres on every call.
    """
    return _server_meta.get(name, {})


def list_connected_servers() -> list[dict]:
    """
    Return connection status for all active MCP server entries.
    Used by the dashboard to show live status alongside DB records.
    """
    return [
        {
            "name": name,
            "connected": client.connected,
            "tool_count": len(client.tools),
            "tools": [t.name for t in client.tools],
        }
        for name, client in list(_active_clients.items())
    ]
