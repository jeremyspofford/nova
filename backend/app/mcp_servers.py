"""MCP server registry — the mcp_servers/mcp_tools_cache tables (migration
031). Registration is operator-only: it sits behind the auth middleware, and
a stdio server's command must be an allow-listed launcher (_STDIO_COMMANDS)
because registering one is, by construction, asking Nova to execute it.
There is deliberately no agent-facing tool on top of this module — an
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
           "enabled", "always_inject", "read_only", "tools_hash", "status",
           "status_detail", "last_seen", "created_at", "updated_at",
           "created_by")
_EDIT_FIELDS = {"url", "command", "args", "headers", "read_only"}
# Settable at creation only, and deliberately NOT in _EDIT_FIELDS: a server
# cannot be laundered from 'action' to 'operator' by a later PATCH, which is
# what would silence mcp_client's outbound guard. `tools_hash` is here so an
# action can register a server with the hash of the tool list the operator
# actually reviewed on the card — see refresh() below.
_CREATE_ONLY_FIELDS = {"created_by", "tools_hash"}
_TRANSPORTS = ("http", "stdio")

# A stdio server's `command` is EXECUTED, verbatim, in the mcp-runner
# container (mcp-runner/server.py hands it to StdioServerParameters). This
# module's docstring used to claim registration was "edit-mode gated in
# router_chat.py"; edit_mode was deleted on 2026-07-21 and nothing replaced
# it, so POST /api/v1/mcp/servers with transport='stdio' was an arbitrary-exec
# endpoint sitting behind nothing but the auth middleware. Note that merely
# listing a server's tools already runs the binary — the tools_hash approval
# below defends against description poisoning, never against execution.
#
# An allow-list rather than an operator toggle: this is how MCP servers are
# actually launched, it costs a real setup nothing, and it does not
# reintroduce the edit-mode friction Jeremy removed on purpose. Widen it here
# if a launcher is genuinely missing.
_STDIO_COMMANDS = {"npx", "uvx", "uv", "node", "python", "python3", "deno", "bun"}


def _check_stdio_command(command: str) -> None:
    """Raise ValueError unless `command` is a bare, allow-listed launcher."""
    cmd = (command or "").strip()
    base = cmd.rsplit("/", 1)[-1]
    if base != cmd:
        raise ValueError(
            f"stdio command must be a bare launcher name, not a path ({cmd!r})")
    if base not in sorted(_STDIO_COMMANDS):
        raise ValueError(
            f"stdio command {base!r} is not an allowed launcher. Allowed: "
            f"{', '.join(sorted(_STDIO_COMMANDS))}. The server's own package "
            f"goes in args, e.g. command='npx', args=['-y','@scope/pkg'].")


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
    if transport == "stdio":
        if not str(fields.get("command") or "").strip():
            raise ValueError("command is required for stdio transport")
        _check_stdio_command(str(fields["command"]))
    fields = {k: v for k, v in fields.items()
              if k in _EDIT_FIELDS or k in _CREATE_ONLY_FIELDS}
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
    log.info("MCP server registered by %s: %s (%s)",
             fields.get("created_by") or "operator", name, transport)
    return _row(r)


async def update(server_id: str, **fields) -> str:
    """Returns 'updated' | 'not_found'. Pure field-set — callers decide
    whether a field change (or an enable flip) warrants a refresh()."""
    allowed = _EDIT_FIELDS | {"enabled", "always_inject"}
    fields = {k: v for k, v in fields.items() if k in allowed}
    if not fields:
        return "not_found"
    # PATCH is the other way to reach exec: a connection-field change makes
    # router_chat re-refresh, which runs the command.
    if fields.get("command"):
        _check_stdio_command(str(fields["command"]))
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
    'error' without touching the cache.

    THE FIRST LIST IS ONLY FREE FOR THE OPERATOR. `stored_hash is None` means
    nobody has ever approved this server's tools, and accepting whatever
    turns up puts a stranger's tool DESCRIPTIONS into every granted agent's
    prompt unread. That is a defensible default when the operator typed the
    URL into Library -> Tools himself — he chose the host and can read the
    list right there. It is not defensible for a server that arrived through
    an approved recommendation, where the whole point is that one click did
    the work. Those must be registered with `tools_hash` already set to the
    hash of the list shown on the card (actions/mcp_server.execute), so this
    function has a baseline to check rather than a blank to fill in. A
    hash-less action-created server is a code path that skipped the review,
    and it is refused rather than trusted."""
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
        unreviewed = (stored_hash is None
                      and server.get("created_by") not in (None, "operator"))
        if unreviewed and not approve:
            log.warning("MCP server '%s' was created by %s with no reviewed "
                        "tool list — refusing to adopt one", server["name"],
                        server.get("created_by"))
            await conn.execute(
                "UPDATE mcp_servers SET status = 'error', status_detail = "
                "'registered without an approved tool list — no one has read "
                "these tool descriptions', last_seen = now(), updated_at = now() "
                "WHERE id = $1::uuid", server_id)
        elif stored_hash is None or approve or new_hash == stored_hash:
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


async def read_only_slugs() -> set[str]:
    """Names of servers THE OPERATOR declared read-only.

    Read fresh rather than cached: revoking the declaration has to take
    effect on the next tool call, not at the next restart. It is one indexed
    lookup on a table with single-digit rows.

    `created_by = 'operator'` is load-bearing, and the docstring said
    "operator" before the query did. This set is the one class of MCP tool
    `tools.registry.is_actor()` treats as safe on a TAINTED turn — a turn
    already carrying fetched text. That was sound while only a person could
    tick the box. It stopped being sound the moment a model could fill in an
    `mcp_server.add` plan, because `read_only` is a plain boolean on that
    form: propose a server with `read_only: true`, and its tools would be
    exempted from the untrusted-context fence by the model's own say-so.

    So the exemption follows WHO DECLARED IT, which is the same provenance
    test `mcp_client._guard_url` already applies to where a server may dial.
    An action-created server can still be read-only in every other sense;
    it just cannot vouch for itself.
    """
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT name FROM mcp_servers "
            " WHERE read_only AND enabled AND created_by = 'operator'")
    return {r["name"] for r in rows}
