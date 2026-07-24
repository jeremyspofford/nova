"""Tool registry — one place that builds agent toolsets and dispatches execution.

An agent's toolset = (builtins ∩ its allowed_tools) + all enabled DB-defined
tools. allowed_tools = NULL means "all builtins". DB tools are data
(execution_type='http_call'), so creating one takes effect immediately.
"""

import asyncio
import json
import logging
import time
import uuid
from typing import Optional
from urllib.parse import urlparse

from app import db
from app.tools import builtin
from app.tools.http_executor import execute_http_tool

log = logging.getLogger(__name__)

BUILTIN_TOOLS = builtin.BUILTIN_TOOLS


async def _load_db_tools() -> dict[str, dict]:
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, name, description, parameters_schema, execution_type, execution_spec "
            "FROM tools WHERE enabled = true")
    out = {}
    for r in rows:
        schema = r["parameters_schema"]
        if isinstance(schema, str):
            schema = json.loads(schema)
        out[r["name"]] = {
            "name": r["name"],
            "description": r["description"],
            "parameters": schema,
            "execution_type": r["execution_type"],
            "execution_spec": r["execution_spec"],
        }
    return out


def _to_llm_def(tool: dict) -> dict:
    return {"type": "function", "function": {
        "name": tool["name"],
        "description": tool["description"],
        "parameters": tool["parameters"],
    }}


_MCP_REFRESH_INFLIGHT: set[str] = set()


async def _load_mcp_tools() -> dict[str, dict]:
    """Cached MCP tool defs for enabled+connected servers, namespaced
    mcp:<server>/<tool> and tagged with '_server_name'/'_always_inject' —
    extra keys _to_llm_def ignores, used by the eager/lazy split below and
    by the phase-2 lazy-loading helpers. Reads mcp_tools_cache only — never
    a live network call on the chat-turn hot path. A stale server
    (last_seen older than the TTL setting) gets a fire-and-forget
    background refresh, the same pattern as the background model pull in
    models_catalog.py."""
    from app import settings_store

    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT s.id, s.name AS server_name, s.last_seen, s.always_inject, "
            "       c.name AS tool_name, c.description, c.parameters_schema "
            "FROM mcp_servers s JOIN mcp_tools_cache c ON c.server_id = s.id "
            "WHERE s.enabled = true AND s.status = 'connected'")

    ttl_min = float(settings_store.get("mcp.tools_refresh_ttl_min") or 15)
    stale: dict[str, None] = {}
    out: dict[str, dict] = {}
    for r in rows:
        schema = r["parameters_schema"]
        if isinstance(schema, str):
            schema = json.loads(schema)
        full_name = f"mcp:{r['server_name']}/{r['tool_name']}"
        out[full_name] = {"name": full_name, "description": r["description"],
                          "parameters": schema, "_server_name": r["server_name"],
                          "_always_inject": r["always_inject"]}
        last_seen = r["last_seen"]
        if last_seen is None or (time.time() - last_seen.timestamp()) > ttl_min * 60:
            stale[str(r["id"])] = None

    for server_id in stale:
        if server_id in _MCP_REFRESH_INFLIGHT:
            continue
        _MCP_REFRESH_INFLIGHT.add(server_id)

        async def _bg(sid=server_id):
            from app import mcp_servers
            try:
                await mcp_servers.refresh(sid)
            except Exception:
                log.exception("Background MCP refresh failed for %s", sid)
            finally:
                _MCP_REFRESH_INFLIGHT.discard(sid)

        asyncio.ensure_future(_bg())

    return out


def _granted_mcp_tools(agent: dict) -> tuple[bool, set[str], set[str]]:
    """(has_grants, named, wildcards) for an agent's MCP grants. MCP tools
    are never implied by allowed_tools=None — each server is a distinct
    trust decision, granted per agent via a named 'mcp:<server>/<tool>' or
    wildcard 'mcp:<server>:*' entry, even for an otherwise-unrestricted
    agent (docs/plans/mcp-client.md)."""
    allowed = agent.get("allowed_tools")
    if allowed is None:
        return False, set(), set()
    named = set(allowed)
    wildcards = {n[:-2] for n in named if n.startswith("mcp:") and n.endswith(":*")}
    return True, named, wildcards


def _mcp_granted(full_name: str, named: set[str], wildcards: set[str]) -> bool:
    return full_name in named or full_name.split("/", 1)[0] in wildcards


_FIND_MCP_TOOLS_DEF = {
    "name": "find_mcp_tools",
    "description": ("Search the MCP servers listed in the '## MCP servers "
                    "(not loaded)' block above — their tools aren't in your "
                    "toolset yet. A match becomes callable IMMEDIATELY, in "
                    "this same turn: call it right after finding it."),
    "parameters": {"type": "object", "properties": {
        "query": {"type": "string",
                  "description": "keyword(s) to match against tool names/descriptions"},
    }, "required": ["query"]},
}


async def lazy_mcp_index(agent: dict) -> dict[str, int]:
    """server name -> tool count, for this agent's granted MCP servers that
    are enabled+connected+NOT always_inject. Drives the phase-2 system
    -prompt index line and whether find_mcp_tools is offered at all."""
    has_grants, named, wildcards = _granted_mcp_tools(agent)
    if not has_grants:
        return {}
    counts: dict[str, int] = {}
    for full_name, tool in (await _load_mcp_tools()).items():
        if tool["_always_inject"]:
            continue
        if _mcp_granted(full_name, named, wildcards):
            counts[tool["_server_name"]] = counts.get(tool["_server_name"], 0) + 1
    return counts


async def search_lazy_mcp_tools(agent: dict, query: str) -> list[dict]:
    """LLM-shaped defs matching query among this agent's lazy (not
    always_inject) granted MCP servers — backs the find_mcp_tools
    meta-tool the runner special-cases mid-turn."""
    has_grants, named, wildcards = _granted_mcp_tools(agent)
    if not has_grants:
        return []
    # keyword match, not phrase match — a query like "uppercase echo text"
    # must still find a tool named echo_upper with an unrelated description
    words = [w for w in query.lower().split() if len(w) >= 3]
    matches = []
    for full_name, tool in (await _load_mcp_tools()).items():
        if tool["_always_inject"] or not _mcp_granted(full_name, named, wildcards):
            continue
        haystack = f"{tool['name']} {tool['description']}".lower()
        if not words or any(w in haystack for w in words):
            matches.append(_to_llm_def(tool))
    return matches


def builtin_def(name: str) -> dict:
    """One builtin's LLM def — for turn-scoped grants the agent's own list
    doesn't carry (e.g. remember_speaker on unknown-voice turns)."""
    return _to_llm_def(BUILTIN_TOOLS[name])


async def get_agent_tools(agent: dict, exclude: Optional[set[str]] = None) -> list[dict]:
    """LLM tool definitions for an agent.

    allowed_tools governs DB-defined tools exactly like builtins:
    None => everything; a list => only the named tools, with the special
    grant 'db:*' meaning "all DB-defined tools". MCP tools follow the same
    grant syntax but are never implied by allowed_tools=None (see
    _granted_mcp_tools). always_inject servers ship full defs eagerly here;
    other granted servers contribute only an index line (_mcp_index_block
    in runner.py) plus the find_mcp_tools meta-tool, added below whenever
    that index is non-empty (phase 2 lazy loading).
    """
    exclude = exclude or set()
    allowed = agent.get("allowed_tools")

    if allowed is None:
        builtin_names = list(BUILTIN_TOOLS)
        all_db, named = True, set()
    else:
        builtin_names = [n for n in allowed if n in BUILTIN_TOOLS]
        all_db = "db:*" in allowed
        named = set(allowed)

    defs = [_to_llm_def(BUILTIN_TOOLS[n]) for n in builtin_names if n not in exclude]

    for name, tool in (await _load_db_tools()).items():
        if name in exclude or name in BUILTIN_TOOLS:
            continue
        if all_db or name in named:
            defs.append(_to_llm_def(tool))

    has_grants, mcp_named, mcp_wildcards = _granted_mcp_tools(agent)
    if has_grants:
        has_lazy = False
        for full_name, tool in (await _load_mcp_tools()).items():
            if full_name in exclude or not _mcp_granted(full_name, mcp_named, mcp_wildcards):
                continue
            if tool["_always_inject"]:
                defs.append(_to_llm_def(tool))
            else:
                has_lazy = True
        if has_lazy and "find_mcp_tools" not in exclude:
            defs.append(_to_llm_def(_FIND_MCP_TOOLS_DEF))
    return defs


# ── operator CRUD (HTTP API surface; the manage_tools builtin is the
#    agent-facing equivalent — both enforce the same host allowlist) ──────

async def list_all_tools() -> dict:
    """Everything the Tools tab renders: builtins (read-only), DB tools with
    their enabled/is_system state, and the host allowlist for creates."""
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, name, description, execution_type, execution_spec, "
            "enabled, is_system FROM tools ORDER BY name")
        hosts = await conn.fetch("SELECT host FROM tool_host_allowlist ORDER BY host")
    db_tools = []
    for r in rows:
        spec = r["execution_spec"]
        if isinstance(spec, str):
            spec = json.loads(spec)
        db_tools.append({
            "id": str(r["id"]), "name": r["name"], "description": r["description"],
            "execution_type": r["execution_type"], "enabled": r["enabled"],
            "is_system": r["is_system"],
            "method": spec.get("method"), "url_template": spec.get("url_template"),
        })
    builtins = [{"name": t["name"], "description": t["description"]}
                for t in BUILTIN_TOOLS.values()]
    return {"builtins": builtins, "db_tools": db_tools,
            "allowed_hosts": [r["host"] for r in hosts]}


async def create_http_tool(name: str, description: str, url_template: str,
                           method: str = "GET",
                           parameters_schema: Optional[dict] = None) -> dict:
    """Create a declarative http_call tool. Raises ValueError on bad host,
    duplicate name, or missing fields."""
    name, description, url_template = (
        name.strip(), description.strip(), url_template.strip())
    if not name or not description or not url_template:
        raise ValueError("name, description, and url_template are required")
    host = urlparse(url_template).hostname or ""
    async with db.acquire() as conn:
        allowed = await conn.fetchrow(
            "SELECT 1 FROM tool_host_allowlist WHERE host = $1", host)
        if not allowed:
            hosts = [r["host"] for r in
                     await conn.fetch("SELECT host FROM tool_host_allowlist")]
            raise ValueError(f"host '{host}' is not on the operator allowlist ({hosts})")
        spec = {"method": (method or "GET").upper(), "url_template": url_template}
        schema = parameters_schema or {"type": "object", "properties": {}}
        try:
            row = await conn.fetchrow(
                """INSERT INTO tools (name, description, parameters_schema,
                                      execution_type, execution_spec)
                   VALUES ($1, $2, $3, 'http_call', $4) RETURNING id""",
                name, description, json.dumps(schema), json.dumps(spec))
        except Exception as e:  # unique violation etc.
            raise ValueError(f"could not create tool: {e}")
    log.info("Tool created by operator: %s -> %s", name, host)
    return {"id": str(row["id"]), "name": name}


async def set_tool_enabled(tool_id: str, enabled: bool) -> bool:
    async with db.acquire() as conn:
        result = await conn.execute(
            "UPDATE tools SET enabled = $2, updated_at = now() WHERE id = $1",
            uuid.UUID(tool_id), enabled)
    return result.endswith("1")


async def delete_tool(tool_id: str) -> str:
    """'deleted' | 'not_found' | 'is_system'."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT name, is_system FROM tools WHERE id = $1", uuid.UUID(tool_id))
        if not row:
            return "not_found"
        if row["is_system"]:
            return "is_system"
        await conn.execute("DELETE FROM tools WHERE id = $1", uuid.UUID(tool_id))
    log.info("Tool deleted by operator: %s", row["name"])
    return "deleted"


async def execute_tool(name: str, args: dict, ctx: dict) -> str:
    """Single dispatch point for every tool call (dispatch_to_agent is runner-inlined).

    ctx may carry 'granted' (the tool names actually offered to the calling
    agent) — enforced here so a model inventing an ungranted tool name is
    refused rather than executed.
    """
    granted = ctx.get("granted")
    if granted is not None and name not in granted:
        return f"Error: tool '{name}' is not granted to this agent"

    # guardrails — fail-open on engine errors, never on rule matches
    try:
        from app import rules
        verdict = rules.check(name, args, ctx.get("agent_name"))
        if verdict:
            action, rule = verdict
            if action == "block":
                log.warning("Rule '%s' BLOCKED %s by agent %s",
                            rule["name"], name, ctx.get("agent_name"))
                return (f"Blocked by rule '{rule['name']}': "
                        f"{rule['description'] or 'no description'}")
            log.warning("Rule '%s' warned on %s by agent %s",
                        rule["name"], name, ctx.get("agent_name"))
    except Exception:
        log.exception("rules engine failed; allowing call (fail-open)")

    if name in BUILTIN_TOOLS:
        try:
            return await BUILTIN_TOOLS[name]["execute"](args, ctx)
        except Exception as e:
            log.exception("Builtin tool %s failed", name)
            return f"Error executing {name}: {e}"

    db_tools = await _load_db_tools()
    if name in db_tools:
        tool = db_tools[name]
        if tool["execution_type"] == "http_call":
            try:
                return await execute_http_tool(tool, args)
            except Exception as e:
                log.exception("HTTP tool %s failed", name)
                return f"Error executing {name}: {e}"
        return f"Error: tool {name} has unsupported execution_type {tool['execution_type']}"

    if name.startswith("mcp:"):
        server_name, _, tool_name = name[len("mcp:"):].partition("/")
        if not tool_name:
            return f"Error: malformed MCP tool name '{name}'"
        try:
            from app import mcp_client, mcp_servers, settings_store
            server = await mcp_servers.get_by_name(server_name)
            if not server or not server["enabled"] or server["status"] != "connected":
                return f"Error: MCP server '{server_name}' is not available"
            timeout = float(settings_store.get("mcp.call_timeout_s") or 30)
            size_cap_kb = int(settings_store.get("mcp.result_size_cap_kb") or 200)
            return await mcp_client.call_tool(server, tool_name, args, timeout, size_cap_kb)
        except Exception as e:
            log.exception("MCP tool %s failed", name)
            return f"Error executing {name}: {e}"

    return f"Error: unknown tool '{name}'"
