"""MCP server registry — the mcp_servers/mcp_tools_cache tables (migration
031). Registration is operator-only (edit-mode gated in router_chat.py);
there is deliberately no agent-facing tool on top of this module — an
agent that could register a server could grant itself arbitrary
capabilities (docs/plans/mcp-client.md).

refresh()/approve() are the hash-approval mechanics: a server's tool list
(name+description) is hashed at approval time. A later refresh that finds
a different hash flips status to 'error' and leaves the cache untouched —
agents keep using the last-approved tool set until the operator reviews
and re-approves (tool-description poisoning defense: a server can't
silently swap in new instructions and have them reach an agent prompt).
"""

import json
import logging

from app import db, mcp_client

log = logging.getLogger(__name__)

_FIELDS = ("id", "name", "transport", "url", "command", "args", "headers",
           "enabled", "always_inject", "tools_hash", "status", "status_detail",
           "last_seen", "created_at", "updated_at")
_EDIT_FIELDS = {"url", "command", "args", "headers"}
_TRANSPORTS = ("http", "stdio")


def _row(r) -> dict:
    d = {k: r[k] for k in _FIELDS}
    d["id"] = str(d["id"])
    if isinstance(d["headers"], str):
        d["headers"] = json.loads(d["headers"])
    d["args"] = list(d["args"] or [])
    for k in ("last_seen", "created_at", "updated_at"):
        d[k] = str(d[k]) if d[k] else None
    return d


def _raw(r) -> dict:
    """Like _row but headers/args native and id left as-is — the shape
    mcp_client.py expects, not the JSON-API shape."""
    d = dict(r)
    if isinstance(d["headers"], str):
        d["headers"] = json.loads(d["headers"])
    d["args"] = list(d["args"] or [])
    return d


async def list_all() -> list[dict]:
    async with db.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM mcp_servers ORDER BY name")
    return [_row(r) for r in rows]


async def get(server_id: str) -> dict | None:
    async with db.acquire() as conn:
        r = await conn.fetchrow("SELECT * FROM mcp_servers WHERE id = $1::uuid", server_id)
    return _row(r) if r else None


async def get_by_name(name: str) -> dict | None:
    async with db.acquire() as conn:
        r = await conn.fetchrow("SELECT * FROM mcp_servers WHERE name = $1", name)
    return _row(r) if r else None


async def create(name: str, transport: str, **fields) -> dict:
    name = name.strip()
    if not name:
        raise ValueError("name is required")
    if transport not in _TRANSPORTS:
        raise ValueError(f"transport must be one of {_TRANSPORTS}")
    if transport == "http" and not str(fields.get("url") or "").strip():
        raise ValueError("url is required for http transport")
    if transport == "stdio" and not str(fields.get("command") or "").strip():
        raise ValueError("command is required for stdio transport")
    fields = {k: v for k, v in fields.items() if k in _EDIT_FIELDS}
    if "headers" in fields:
        fields["headers"] = json.dumps(fields["headers"] or {})
    cols = ["name", "transport"] + list(fields)
    vals = [name, transport] + list(fields.values())
    placeholders = ", ".join(f"${i + 1}" for i in range(len(vals)))
    async with db.acquire() as conn:
        try:
            r = await conn.fetchrow(
                f"INSERT INTO mcp_servers ({', '.join(cols)}) "
                f"VALUES ({placeholders}) RETURNING *", *vals)
        except Exception as e:  # unique name violation etc.
            raise ValueError(f"could not create server: {e}")
    log.info("MCP server registered by operator: %s (%s)", name, transport)
    return _row(r)


async def update(server_id: str, **fields) -> str:
    """Returns 'updated' | 'not_found'. Pure field-set — callers decide
    whether a field change (or an enable flip) warrants a refresh()."""
    allowed = _EDIT_FIELDS | {"enabled", "always_inject"}
    fields = {k: v for k, v in fields.items() if k in allowed}
    if not fields:
        return "not_found"
    if "headers" in fields:
        fields["headers"] = json.dumps(fields["headers"] or {})
    sets = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(fields))
    async with db.acquire() as conn:
        result = await conn.execute(
            f"UPDATE mcp_servers SET {sets}, updated_at = now() "
            f"WHERE id = $1::uuid", server_id, *fields.values())
    return "updated" if result.endswith(" 1") else "not_found"


async def delete(server_id: str) -> str:
    async with db.acquire() as conn:
        result = await conn.execute("DELETE FROM mcp_servers WHERE id = $1::uuid", server_id)
    return "deleted" if result.endswith(" 1") else "not_found"


async def refresh(server_id: str, *, approve: bool = False) -> dict:
    """Connect, list tools, hash them. On first-ever connect (no stored
    hash) or an explicit approve=True, accept the new hash as the approved
    baseline and sync the cache. Otherwise a hash mismatch flips status to
    'error' without touching the cache."""
    async with db.acquire() as conn:
        raw = await conn.fetchrow("SELECT * FROM mcp_servers WHERE id = $1::uuid", server_id)
    if not raw:
        raise ValueError("server not found")
    server = _raw(raw)

    status, tools, err = await mcp_client.connect_and_list(server)
    async with db.acquire() as conn:
        if status == "error":
            await conn.execute(
                "UPDATE mcp_servers SET status = 'error', status_detail = $2, "
                "updated_at = now() WHERE id = $1::uuid", server_id, err)
            return await get(server_id)

        new_hash = mcp_client.tool_list_hash(tools)
        stored_hash = server["tools_hash"]
        if stored_hash is None or approve or new_hash == stored_hash:
            await conn.execute("DELETE FROM mcp_tools_cache WHERE server_id = $1::uuid", server_id)
            for t in tools:
                await conn.execute(
                    "INSERT INTO mcp_tools_cache (server_id, name, description, parameters_schema) "
                    "VALUES ($1::uuid, $2, $3, $4)",
                    server_id, t["name"], t["description"], json.dumps(t["parameters_schema"]))
            await conn.execute(
                "UPDATE mcp_servers SET status = 'connected', status_detail = NULL, "
                "tools_hash = $2, last_seen = now(), updated_at = now() "
                "WHERE id = $1::uuid", server_id, new_hash)
        else:
            log.warning("MCP server '%s' tool list changed since approval — "
                        "flipping to error, cache untouched", server["name"])
            await conn.execute(
                "UPDATE mcp_servers SET status = 'error', "
                "status_detail = 'tool list changed since approval — review and re-approve', "
                "last_seen = now(), updated_at = now() WHERE id = $1::uuid", server_id)
    return await get(server_id)


async def approve(server_id: str) -> dict:
    return await refresh(server_id, approve=True)


async def list_tools_for(server_id: str) -> list[dict]:
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT name, description, parameters_schema FROM mcp_tools_cache "
            "WHERE server_id = $1::uuid ORDER BY name", server_id)
    out = []
    for r in rows:
        schema = r["parameters_schema"]
        if isinstance(schema, str):
            schema = json.loads(schema)
        out.append({"name": r["name"], "description": r["description"],
                    "parameters_schema": schema})
    return out
