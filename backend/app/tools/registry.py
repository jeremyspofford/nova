"""Tool registry — one place that builds agent toolsets and dispatches execution.

An agent's toolset = (builtins ∩ its allowed_tools) + all enabled DB-defined
tools. allowed_tools = NULL means "all builtins". DB tools are data
(execution_type='http_call'), so creating one takes effect immediately.
"""

import json
import logging
import time
import uuid
from typing import Optional
from urllib.parse import urlparse

from app import bg, db, goals, redact, settings_store
from app.tools import builtin, fixtures
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


# ── wire names ───────────────────────────────────────────────────────────
# Providers constrain tool names to ^[a-zA-Z0-9_-]{1,128}$ — Anthropic 400s
# on anything else. Nova's canonical MCP name is `mcp:<server>/<tool>`, which
# contains both a colon and a slash, so the FIRST real MCP server registered
# broke every turn for that agent with "tools.13.custom.name: String should
# match pattern". The client shipped complete and had simply never been
# exercised against a live server, because none had ever been registered.
#
# The canonical form stays canonical everywhere it matters — grants, the
# ACTOR check, the audit trail. Only the copy handed to the model is
# rewritten, and execute_tool accepts either form so the round trip closes.
_WIRE_SEP = "__"


def wire_name(name: str) -> str:
    if not name.startswith("mcp:"):
        return name
    return "mcp" + _WIRE_SEP + name[len("mcp:"):].replace("/", _WIRE_SEP, 1)


def canonical_name(name: str) -> str:
    """Wire form back to `mcp:<server>/<tool>`; anything else untouched."""
    prefix = "mcp" + _WIRE_SEP
    if not name.startswith(prefix):
        return name
    rest = name[len(prefix):]
    server, sep, tool = rest.partition(_WIRE_SEP)
    return f"mcp:{server}/{tool}" if sep else name


def _to_llm_def(tool: dict) -> dict:
    return {"type": "function", "function": {
        "name": wire_name(tool["name"]),
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

        bg.spawn(_bg(), name="mcp-refresh")

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
    from app import capability_events as ce
    ce.record(ce.TOOL, name, "created", actor="operator", detail={"host": host})
    return {"id": str(row["id"]), "name": name}


async def set_tool_enabled(tool_id: str, enabled: bool) -> bool:
    async with db.acquire() as conn:
        row = await conn.fetchrow("SELECT name FROM tools WHERE id = $1",
                                  uuid.UUID(tool_id))
        result = await conn.execute(
            "UPDATE tools SET enabled = $2, updated_at = now() WHERE id = $1",
            uuid.UUID(tool_id), enabled)
    ok = result.endswith("1")
    if ok and row:
        from app import capability_events as ce
        ce.record(ce.TOOL, row["name"], "enabled" if enabled else "disabled",
                  actor="operator")
    return ok


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
    from app import capability_events as ce
    ce.record(ce.TOOL, row["name"], "deleted", actor="operator")
    return "deleted"


def is_error_result(result: str) -> bool:
    """Did this tool result represent a failure?

    Tools deliberately never raise into the runner — they return a string the
    model can read and act on, and every failure path in this module and in
    builtin.py writes one of two prefixes. That convention had no reader,
    though: the trace span recorded status="ok" for all of them, so the Turn
    Inspector drew failed tools green and the observability error rate
    counted zero. Honest receipts start with noticing.
    """
    head = result.lstrip()[:40].lower()
    return head.startswith("error") or head.startswith("blocked by rule")


# ── the fence: which tools may not run on untrusted context ──────────────
#
# ACTOR = a verb whose effect ESCAPES memory. Changing what Nova or her
# agents can do, and destroying things. Deliberately NOT "anything that
# writes": `ingestion` exists to turn fetched web pages into topics, so a
# rule that blocked writes under untrusted context would break the one agent
# designed to handle untrusted content — and it holds none of these.
#
# The set is small on purpose. Every entry is a verb where a poisoned page
# reaching the model turns into a durable change to the system.
ACTOR_TOOLS = frozenset({
    "manage_agents",       # who exists and what they may call
    "manage_tools",        # what exists to call
    "manage_rules",        # the guardrails themselves
    "manage_automations",  # unattended future turns
    "pull_model",          # what runs on the box
    "delete_memory_item",  # destruction
    "manage_tool_hosts",   # where an http_call tool may reach
})


# ── goal scope: which verbs an approved goal may pre-authorise ─────────────
#
# Jeremy, 2026-07-28, enumerating what should need approval: agent creation,
# tool creation, model pulls, automations — with rules explicitly left alone
# and research always allowed.
#
# So this is a SUBSET of ACTOR_TOOLS, and the two exclusions are the point.
# `manage_rules` already burns a single-use consent for anything that weakens
# a guardrail; letting a goal pre-approve that would turn the strictest gate
# in the system into the weakest, since one approval would then cover every
# later weakening. `delete_memory_item` is destruction of the operator's own
# knowledge, which is not "building what you need" — it is the one thing a
# wrong goal could not undo.
#
# Everything here CREATES capability. That is the honest line: a goal buys
# permission to build, never permission to remove a protection or erase a
# record.
GOAL_SCOPED_TOOLS = frozenset({
    "manage_agents",
    "manage_tools",
    "manage_automations",
    "pull_model",
    "manage_tool_hosts",
})


def is_actor(name: str, db_tools: Optional[dict] = None,
             read_only_servers: Optional[set[str]] = None) -> bool:
    """True for tools that may not run on untrusted context.

    Fail CLOSED for anything not recognised. An MCP tool can do literally
    anything its server implements, and a DB tool that is not a plain GET is
    a write to somewhere — neither can be assumed harmless. A GET-only
    http_call IS a read, and treating it as an actor would block "what's the
    weather" on most turns for no safety gained.
    """
    if name in ACTOR_TOOLS:
        return True
    if name in BUILTIN_TOOLS:
        return False
    if name.startswith("mcp:"):
        # An MCP server can implement anything, and its tool NAMES are
        # attacker-adjacent metadata — `read_file` proves nothing. So the
        # operator declares the server read-only at registration and the
        # backend enforces the consequence; undeclared stays an actor.
        server = name[len("mcp:"):].split("/", 1)[0]
        return server not in (read_only_servers or set())
    tool = (db_tools or {}).get(name)
    if tool is None:
        return True
    spec = tool.get("execution_spec") or {}
    if isinstance(spec, str):
        try:
            spec = json.loads(spec)
        except ValueError:
            return True
    return str(spec.get("method", "GET")).upper() != "GET"


async def _read_only_servers() -> set[str]:
    try:
        from app import mcp_servers
        return await mcp_servers.read_only_slugs()
    except Exception:
        log.exception("read-only MCP servers unavailable; treating all as actors")
        return set()          # fail closed


async def execute_tool(name: str, args: dict, ctx: dict) -> str:
    """Single dispatch point for every tool call (dispatch_to_agent is runner-inlined).

    ctx may carry 'granted' (the tool names actually offered to the calling
    agent) — enforced here so a model inventing an ungranted tool name is
    refused rather than executed.
    """
    # the model answers with the wire name it was given
    name = canonical_name(name)
    granted = ctx.get("granted")
    if granted is not None and name not in granted:
        return f"Error: tool '{name}' is not granted to this agent"

    # THE CONTAINMENT INVARIANT (docs/plans/capability-and-containment.md):
    # no turn may both hold untrusted-origin text in its context and execute
    # a tool classified as ACTOR. Checked here because this is the single
    # dispatch point, and mechanically because the alternative — telling the
    # model in its prompt to be careful — is the control that already failed
    # twice this week.
    #
    # The inversion is the point: "search memory, then act on what you find"
    # is the move that defeats a prompt warning, and here it is the very act
    # that disarms the tool.
    if ctx.get("untrusted_context") and is_actor(
            name, await _load_db_tools(), await _read_only_servers()):
        return (f"Error: '{name}' changes what this system can do, and this "
                f"turn is holding text from an outside source (a fetched "
                f"page, a transcript, or an earlier conversation). Refused "
                f"mechanically — untrusted text must not be able to reach a "
                f"tool like this. Tell the operator what you would have done "
                f"and let them decide.")

    # THE GOAL GATE. Verbs that CREATE capability run only against a standing
    # approval — an active goal whose approved_verbs contain this one, spent
    # atomically. Without it, the answer is not "no", it is "propose a goal":
    # the refusal names the exact call that turns this into a yes, because a
    # gate that dead-ends gets removed and a gate that routes gets used.
    #
    # This is the half Jeremy asked for that did not exist. The other half is
    # a correction: until now `manage_agents`, `manage_tools` and
    # `manage_automations` were entirely UNGATED — Nova told him on
    # 2026-07-28 that agent and tool creation "requires operator approval",
    # and it did not. She was describing guardrails she did not have, which
    # is the same class of error as claiming a capability she lacks, pointed
    # the other way and considerably worse.
    if name in GOAL_SCOPED_TOOLS and settings_store.get("autonomy.goal_scoped_actions"):
        goal = await goals.spend(name, agent_name=ctx.get("agent_name"))
        if not goal:
            return (
                f"Error: '{name}' changes what this system can do, so it runs "
                f"only under a goal the operator has approved. No active goal "
                f"currently pre-approves '{name}' (one may have expired or "
                f"run out of its approved actions).\n\n"
                f"Do this instead: call propose_goal with a clear title, a "
                f"specific finish line the operator can check, and the verbs "
                f"you need — including '{name}'. They get one card to approve, "
                f"and then you can work without asking again until the goal "
                f"is met. Do not retry this call before that approval.")
        ctx.setdefault("goals_spent", []).append(
            {"id": goal["id"], "title": goal["title"], "verb": name})

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

    # eval record/replay (docs/plans/model-eval-pipeline.md). Below the grant
    # and rule gates on purpose — both contestants must meet identical
    # enforcement — and above every executor, so a replay-only tool can never
    # reach the real world. No-op outside an eval run.
    replayed = fixtures.intercept(name, args)
    if replayed is not None:
        return replayed

    result = await _dispatch(name, args, ctx)
    fixtures.observe(name, args, result)  # full result: redaction is downstream
    return result


async def _dispatch(name: str, args: dict, ctx: dict) -> str:
    """Run the tool for real: builtin, then DB http_call, then MCP."""
    if name in BUILTIN_TOOLS:
        try:
            return await BUILTIN_TOOLS[name]["execute"](args, ctx)
        except Exception as e:
            # The exception text becomes the tool RESULT — model context, a
            # messages row for 30 days, and the SSE stream. httpx puts the
            # entire request URL, query string included, inside its exception
            # string, so `{e}` is a credential leak on every failed fetch.
            log.exception("Builtin tool %s failed", name)
            return f"Error executing {name}: {redact.scrub_text(str(e), 500)}"

    db_tools = await _load_db_tools()
    if name in db_tools:
        tool = db_tools[name]
        if tool["execution_type"] == "http_call":
            try:
                return await execute_http_tool(tool, args)
            except Exception as e:
                log.exception("HTTP tool %s failed", name)
                return f"Error executing {name}: {redact.scrub_text(str(e), 500)}"
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
            return f"Error executing {name}: {redact.scrub_text(str(e), 500)}"

    return f"Error: unknown tool '{name}'"
