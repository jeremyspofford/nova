"""Tool registry — one place that builds agent toolsets and dispatches execution.

An agent's toolset = (builtins ∩ its allowed_tools) + all enabled DB-defined
tools. allowed_tools = NULL means "all builtins". DB tools are data
(execution_type='http_call'), so creating one takes effect immediately.
"""

import json
import logging
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


async def get_agent_tools(agent: dict, exclude: Optional[set[str]] = None) -> list[dict]:
    """LLM tool definitions for an agent.

    allowed_tools governs DB-defined tools exactly like builtins:
    None => everything; a list => only the named tools, with the special
    grant 'db:*' meaning "all DB-defined tools".
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

    return f"Error: unknown tool '{name}'"
