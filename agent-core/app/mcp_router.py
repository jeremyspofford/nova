"""MCP servers CRUD + tool discovery + tier override endpoints."""
from __future__ import annotations

import json
import logging
import uuid

import asyncpg
from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel

from .config import settings
from .db import get_pool
from .tools.mcp import mcp_manager
from .tools.mcp.discovery import discover_tools
from .tools.mcp.lifecycle import stop_server

logger = logging.getLogger(__name__)
router = APIRouter(tags=["mcp"])


# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------


def _require_admin(x_admin_secret: str | None = Header(default=None)) -> None:
    if settings.admin_secret and x_admin_secret != settings.admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class MCPServerCreate(BaseModel):
    name: str
    command: str
    args: list[str] = []
    env: dict[str, str] = {}
    working_dir: str | None = None
    enabled: bool = True
    transport: str = "stdio"


class MCPServerUpdate(BaseModel):
    command: str | None = None
    args: list[str] | None = None
    env: dict[str, str] | None = None
    working_dir: str | None = None
    enabled: bool | None = None
    transport: str | None = None


class TierOverrideBody(BaseModel):
    tier_override: str | None = None  # None clears the override


def _row_to_dict(row) -> dict:
    env = row["env"]
    if isinstance(env, str):
        try:
            env = json.loads(env)
        except Exception:
            env = {}
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "command": row["command"],
        "args": list(row["args"] or []),
        "env": env or {},
        "working_dir": row["working_dir"],
        "transport": row["transport"],
        "enabled": row["enabled"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "last_started": row["last_started"].isoformat() if row["last_started"] else None,
        "last_error": row["last_error"],
    }


# ---------------------------------------------------------------------------
# MCP server CRUD
# ---------------------------------------------------------------------------


@router.get("/api/v1/mcp/servers")
async def list_servers(_: None = Depends(_require_admin)) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, name, command, args, env, working_dir, transport, "
            "       enabled, created_at, last_started, last_error "
            "FROM mcp_servers ORDER BY created_at DESC"
        )
    return [_row_to_dict(r) for r in rows]


@router.post("/api/v1/mcp/servers", status_code=201)
async def create_server(
    body: MCPServerCreate,
    _: None = Depends(_require_admin),
) -> dict:
    pool = await get_pool()
    server_id = str(uuid.uuid4())
    env_json = json.dumps(body.env)
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO mcp_servers
                    (id, name, command, args, env, working_dir, transport, enabled)
                VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
                RETURNING id, name, command, args, env, working_dir, transport,
                          enabled, created_at, last_started, last_error
                """,
                server_id, body.name, body.command, body.args, env_json,
                body.working_dir, body.transport, body.enabled,
            )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=409, detail=f"MCP server {body.name!r} already exists")

    result = _row_to_dict(row)

    # Best-effort: register, spawn, and discover tools after insert.
    discovered: list[dict] = []
    if body.enabled:
        mcp_manager.register_server_meta(
            body.name, server_id,
            command=body.command,
            args=body.args,
            raw_env=body.env,
            cwd=body.working_dir,
        )
        try:
            mcp = await mcp_manager.ensure_running(server_id, body.name)
            discovered = await discover_tools(mcp.client, server_id, pool)
        except Exception as e:
            logger.warning("Initial discovery failed for %r: %s", body.name, e)

    result["tools"] = discovered
    return result


@router.get("/api/v1/mcp/servers/{server_id}")
async def get_server(
    server_id: str,
    _: None = Depends(_require_admin),
) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, name, command, args, env, working_dir, transport, "
            "       enabled, created_at, last_started, last_error "
            "FROM mcp_servers WHERE id = $1::uuid",
            server_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="MCP server not found")

    result = _row_to_dict(row)

    # Inline tools from the running process (best-effort).
    tools: list[dict] = []
    try:
        mcp = mcp_manager.get_process(row["name"])
        if mcp and mcp.is_alive():
            tools = await discover_tools(mcp.client, server_id, pool)
    except Exception:
        pass
    result["tools"] = tools
    return result


@router.patch("/api/v1/mcp/servers/{server_id}")
async def update_server(
    server_id: str,
    body: MCPServerUpdate,
    _: None = Depends(_require_admin),
) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT id, name, command, args, env, working_dir, transport, enabled "
            "FROM mcp_servers WHERE id = $1::uuid",
            server_id,
        )
    if existing is None:
        raise HTTPException(status_code=404, detail="MCP server not found")

    new_command = body.command if body.command is not None else existing["command"]
    new_args = body.args if body.args is not None else list(existing["args"] or [])
    new_working_dir = body.working_dir if body.working_dir is not None else existing["working_dir"]
    new_transport = body.transport if body.transport is not None else existing["transport"]
    new_enabled = body.enabled if body.enabled is not None else existing["enabled"]

    existing_env = existing["env"]
    if isinstance(existing_env, str):
        existing_env = json.loads(existing_env)
    new_env = body.env if body.env is not None else (existing_env or {})
    env_json = json.dumps(new_env)

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE mcp_servers
            SET command = $2, args = $3, env = $4::jsonb,
                working_dir = $5, transport = $6, enabled = $7
            WHERE id = $1::uuid
            RETURNING id, name, command, args, env, working_dir, transport,
                      enabled, created_at, last_started, last_error
            """,
            server_id, new_command, new_args, env_json,
            new_working_dir, new_transport, new_enabled,
        )
    return _row_to_dict(row)


@router.delete("/api/v1/mcp/servers/{server_id}", status_code=204)
async def delete_server(
    server_id: str,
    _: None = Depends(_require_admin),
) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "DELETE FROM mcp_servers WHERE id = $1::uuid RETURNING name",
            server_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="MCP server not found")

    server_name = row["name"]

    # Stop the running subprocess and clean up manager state.
    mcp_manager._processes.pop(server_name, None)
    mcp_manager._server_ids.pop(server_name, None)
    mcp_manager._server_meta.pop(server_name, None)
    try:
        await stop_server(server_id)
    except Exception as e:
        logger.warning("Error stopping MCP server %r during delete: %s", server_name, e)


# ---------------------------------------------------------------------------
# Tool discovery + tier overrides
# ---------------------------------------------------------------------------


@router.get("/api/v1/mcp/servers/{server_id}/tools")
async def list_server_tools(
    server_id: str,
    _: None = Depends(_require_admin),
) -> list[dict]:
    """Discover tools from a running MCP server (returns live data from the process)."""
    pool = await get_pool()

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT name, transport FROM mcp_servers WHERE id = $1::uuid",
            server_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="MCP server not found")

    server_name = row["name"]
    try:
        proc = await mcp_manager.ensure_running(server_id, server_name)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    try:
        tools = await discover_tools(proc.client, server_id, pool)
    except Exception as exc:
        logger.warning("tool discovery failed for %s: %s", server_name, exc)
        raise HTTPException(status_code=502, detail=f"Tool discovery failed: {exc}")

    return tools


@router.post("/api/v1/mcp/servers/{server_id}/discover")
async def refresh_tools(
    server_id: str,
    _: None = Depends(_require_admin),
) -> dict:
    """Force re-discovery of tools for a running MCP server."""
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT name FROM mcp_servers WHERE id = $1::uuid AND enabled = true",
        server_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Server not found or disabled")
    mcp = await mcp_manager.ensure_running(server_id, row["name"])
    tools = await discover_tools(mcp.client, server_id, pool)
    return {"tools": tools}


@router.patch("/api/v1/mcp/servers/{server_id}/tools/{tool_name}")
async def set_tool_tier_override(
    server_id: str,
    tool_name: str,
    body: TierOverrideBody,
    _: None = Depends(_require_admin),
) -> dict:
    """Set or clear a tier override for a specific MCP tool."""
    # Validate tier value.
    if body.tier_override is not None and body.tier_override not in ("READ", "MUTATE", "DESTRUCT"):
        raise HTTPException(
            status_code=400,
            detail="tier_override must be READ, MUTATE, or DESTRUCT",
        )

    pool = await get_pool()

    # Verify server exists.
    async with pool.acquire() as conn:
        srv = await conn.fetchrow(
            "SELECT id FROM mcp_servers WHERE id = $1::uuid", server_id
        )
    if srv is None:
        raise HTTPException(status_code=404, detail="MCP server not found")

    async with pool.acquire() as conn:
        if body.tier_override is None:
            # Remove override.
            await conn.execute(
                "DELETE FROM mcp_tool_overrides WHERE mcp_server_id = $1::uuid AND tool_name = $2",
                server_id, tool_name,
            )
        else:
            await conn.execute(
                """
                INSERT INTO mcp_tool_overrides (mcp_server_id, tool_name, tier_override)
                VALUES ($1::uuid, $2, $3)
                ON CONFLICT (mcp_server_id, tool_name)
                DO UPDATE SET tier_override = EXCLUDED.tier_override
                """,
                server_id, tool_name, body.tier_override,
            )

    return {
        "server_id": server_id,
        "tool_name": tool_name,
        "tier_override": body.tier_override,
    }


@router.post("/api/v1/mcp/servers/{server_id}/restart", status_code=202)
async def restart_server_endpoint(
    server_id: str,
    _: None = Depends(_require_admin),
) -> dict:
    """Manually trigger ensure_running for a server (for UI restart buttons)."""
    pool = await get_pool()

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT name, command, args, env, working_dir, transport "
            "FROM mcp_servers WHERE id = $1::uuid AND enabled = true",
            server_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="MCP server not found or not enabled")

    server_name = row["name"]

    # Register with manager if not already known.
    if server_name not in mcp_manager._server_meta:
        env = row["env"]
        if isinstance(env, str):
            try:
                env = json.loads(env)
            except Exception:
                env = {}
        mcp_manager.register_server_meta(
            server_name, server_id,
            command=row["command"],
            args=list(row["args"] or []),
            raw_env=dict(env or {}),
            cwd=row["working_dir"],
        )

    try:
        await mcp_manager.ensure_running(server_id, server_name)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    # Update last_started.
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE mcp_servers SET last_started = now(), last_error = NULL WHERE id = $1::uuid",
            server_id,
        )

    return {"started": True, "server_id": server_id}
