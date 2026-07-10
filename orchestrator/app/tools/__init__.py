"""
Nova Tool Registry — aggregates all tool sets into a single interface.

The runner imports ALL_TOOLS and execute_tool from here; it never
imports from individual tool modules directly. Adding a new tool set:
  1. Create orchestrator/app/tools/<name>_tools.py
  2. Import its list and execute_tool here
  3. Add to _REGISTRY below — it becomes a permission group automatically

MCP tools are dynamic — registered via the MCP server registry at runtime.
Use get_all_tools() when building a tool list for an LLM request to include
them; ALL_TOOLS only contains the static built-ins.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from app.tools.browser_tools import BROWSER_TOOLS
from app.tools.browser_tools import execute_tool as _exec_browser
from app.tools.checkpoint_tools import CHECKPOINT_TOOL_NAME, CHECKPOINT_TOOLS
from app.tools.checkpoint_tools import execute_tool as _exec_checkpoint
from app.tools.code_tools import CODE_TOOLS
from app.tools.code_tools import execute_tool as _exec_code
from app.tools.config_tools import CONFIG_TOOLS
from app.tools.config_tools import execute_tool as _exec_config
from app.tools.diagnosis_tools import DIAGNOSIS_TOOLS
from app.tools.diagnosis_tools import execute_tool as _exec_diagnosis
from app.tools.git_tools import GIT_TOOLS
from app.tools.git_tools import execute_tool as _exec_git
from app.tools.github_external_tools import GITHUB_EXTERNAL_TOOLS
from app.tools.github_external_tools import execute_tool as _exec_github_external
from app.tools.github_tools import GITHUB_TOOLS
from app.tools.github_tools import execute_tool as _exec_github
from app.tools.intel_tools import INTEL_TOOLS
from app.tools.intel_tools import execute_tool as _exec_intel
from app.tools.introspect_tools import INTROSPECT_TOOLS
from app.tools.introspect_tools import execute_tool as _exec_introspect
from app.tools.memory_tools import MEMORY_TOOLS
from app.tools.memory_tools import execute_tool as _exec_memory
from app.tools.notify_tools import NOTIFY_TOOLS
from app.tools.notify_tools import execute_tool as _exec_notify
from app.tools.platform_tools import PLATFORM_TOOLS
from app.tools.platform_tools import execute_tool as _exec_platform
from app.tools.web_tools import WEB_TOOLS
from app.tools.web_tools import execute_tool as _exec_web
from nova_contracts import ToolDefinition

# ── Registry ──────────────────────────────────────────────────────────────────

@dataclass
class ToolGroup:
    name: str           # Stable internal ID — used in DB, API, and pod allowlists
    display_name: str   # User-facing label — shown in dashboard UI
    description: str
    tools: list[ToolDefinition]
    executor: Callable

_REGISTRY: list[ToolGroup] = [
    ToolGroup("Platform", "Agent Management",  "Manage agents and list available models",        PLATFORM_TOOLS, _exec_platform),
    ToolGroup("Code",     "Files & Shell",     "Read, write, and search files; run shell",       CODE_TOOLS,     _exec_code),
    ToolGroup("Git",      "Version Control",   "View status, diffs, logs, and create commits",   GIT_TOOLS,      _exec_git),
    ToolGroup("Web",      "Internet Access",   "Search the internet and fetch web pages",        WEB_TOOLS,      _exec_web),
    ToolGroup("Browser",  "Browser Automation", "Drive a real browser: navigate, read, fill forms, sign up for accounts, store credentials", BROWSER_TOOLS, _exec_browser),
    ToolGroup("Checkpoint", "Human Checkpoint", "Park a task and ask the operator for input (CAPTCHAs, verification codes, judgment calls)", CHECKPOINT_TOOLS, _exec_checkpoint),
    ToolGroup("Notify", "Phone Push", "Send informational push notifications to the operator's phone", NOTIFY_TOOLS, _exec_notify),
    ToolGroup("Diagnosis", "Self-Diagnosis",  "Diagnose task failures, check service health, analyse errors", DIAGNOSIS_TOOLS, _exec_diagnosis),
    ToolGroup("Introspect", "Platform Awareness", "Query platform config, knowledge sources, MCP servers, user profiles", INTROSPECT_TOOLS, _exec_introspect),
    ToolGroup("Memory", "Knowledge Retrieval", "Search, recall, and read from Nova's memory system", MEMORY_TOOLS, _exec_memory),
    ToolGroup("Intel", "Intelligence Analysis", "Query intel feeds, create recommendations, check dismissed content", INTEL_TOOLS, _exec_intel),
    ToolGroup("Config", "Skills & Rules", "Manage prompt skills and behavior rules", CONFIG_TOOLS, _exec_config),
    ToolGroup("GitHub", "Self-Modification", "Create branches, push code, and manage pull requests on Nova's own repo", GITHUB_TOOLS, _exec_github),
    ToolGroup("github_external", "GitHub (External Repos)", "Read CI runs, logs, diffs, and locate bugs on arbitrary GitHub repos.", GITHUB_EXTERNAL_TOOLS, _exec_github_external),
]

# Derived from registry — same shapes the rest of the codebase expects
ALL_TOOLS: list[ToolDefinition] = [t for g in _REGISTRY for t in g.tools]

# Fast name → executor lookup built once at import time
_DISPATCH: dict[str, Callable] = {}
_GROUP_NAMES: dict[str, set[str]] = {}
for _g in _REGISTRY:
    names = {t.name for t in _g.tools}
    _GROUP_NAMES[_g.name] = names
    for _n in names:
        _DISPATCH[_n] = _g.executor


# ── Public API ────────────────────────────────────────────────────────────────

def get_tool_groups() -> dict[str, list[str]]:
    """Return group name → list of tool names (static built-ins only)."""
    return {g.name: [t.name for t in g.tools] for g in _REGISTRY}


def get_registry() -> list[ToolGroup]:
    """Return the full registry for permission UI / introspection."""
    return list(_REGISTRY)


def get_permitted_tools(disabled_groups: set[str]) -> list[ToolDefinition]:
    """Return all tools except those in disabled groups.

    Filters both static built-ins and MCP tools. MCP groups are prefixed
    with "MCP: " — e.g. disabling "MCP: filesystem" removes all tools
    from the filesystem MCP server.
    """
    if not disabled_groups:
        return get_all_tools()

    # Filter static tools
    tools: list[ToolDefinition] = []
    for g in _REGISTRY:
        if g.name not in disabled_groups:
            tools.extend(g.tools)

    # Filter MCP tools
    try:
        from app.pipeline.tools.registry import get_mcp_tool_definitions
        for t in get_mcp_tool_definitions():
            # mcp__{server}__{tool} → server name → "MCP: {server}"
            parts = t.name.split("__")
            if len(parts) >= 2:
                mcp_group = f"MCP: {parts[1]}"
                if mcp_group not in disabled_groups:
                    tools.append(t)
            else:
                tools.append(t)
    except Exception:
        pass

    return tools


def get_all_tools() -> list[ToolDefinition]:
    """
    Return all available tools: built-ins + dynamically-registered MCP tools.

    Call this when building a tool list for an LLM request so MCP server tools
    are included. Do NOT call at module import time — MCP servers are loaded
    asynchronously after startup.
    """
    try:
        from app.pipeline.tools.registry import get_mcp_tool_definitions
        return ALL_TOOLS + get_mcp_tool_definitions()
    except Exception:
        # MCP registry unavailable (e.g., during tests) — fall back to built-ins
        return list(ALL_TOOLS)


async def execute_tool(
    name: str,
    arguments: dict,
    *,
    context: dict | None = None,
) -> str:
    """Dispatch a tool call to the appropriate module.

    `context` carries task-scope info — tenant_id, user_id, task_id,
    actor_kind, actor_id, credential_id — that credentialed tools
    (currently github_external) need in order to:
      - look up the right credential's secret from the vault
      - run consent.gate (creates pending approval for MUTATE/DESTRUCT)
      - write capability_audit rows tagged to the task

    Non-credentialed tools (Code, Memory, Web, …) ignore context. Callers
    that don't know about credentialed tools (most legacy paths) can omit
    context entirely; only github_external invocations need it, and those
    fail loud with a clear error rather than crashing on `missing 'secret'`.
    """
    # ── Hard rule enforcement (pre-execution) ──
    try:
        from app.rules import check_hard_rules
        allowed, violation_msg = await check_hard_rules(name, arguments)
        if not allowed:
            return f"Tool execution blocked: {violation_msg}"
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("Rule check failed: %s", e)

    # MCP tools are namespaced as mcp__{server}__{tool}. Route through the
    # consent gate so MUTATE/DESTRUCT MCP actions (unlock a door, fire an n8n
    # workflow, flush a DNS blocklist) require approval — READ MCP tools (sensor
    # reads, searches) stay on the fast path. Before Slice 0 these bypassed
    # consent entirely.
    if name.startswith("mcp__"):
        return await _dispatch_mcp_via_consent(name, arguments, context)

    # github_external tools require a credential. Route through the capability
    # platform (consent gate + secret resolution + audit) instead of calling
    # the underlying executor directly. The agent runner is expected to pass
    # `context` for any task that runs on a pod with these tools in scope.
    if name in _GROUP_NAMES.get("github_external", set()):
        return await _dispatch_github_external_via_capabilities(name, arguments, context)

    # The checkpoint tool needs the task scope (task_id, tenant, actor) to
    # create the approval row the pipeline executor parks the task against.
    if name == CHECKPOINT_TOOL_NAME:
        return await _exec_checkpoint(name, arguments, context)

    executor = _DISPATCH.get(name)
    if executor:
        # Idempotency guard for irreversible, outward-facing tools. Nova's
        # recovery paths (reaper re-enqueue, checkpoint stage resume) can replay
        # a tool call that already fired its side effect; the ledger makes such
        # a replay return the cached result instead of acting twice. Only
        # applied when we have a task scope to key on — unscoped calls (no
        # task_id in context) fall through to a normal execute.
        from app.tool_idempotency import IDEMPOTENT_TOOLS, run_idempotent
        task_id = (context or {}).get("task_id")
        if name in IDEMPOTENT_TOOLS and task_id:
            return await run_idempotent(
                str(task_id), name, arguments, lambda: executor(name, arguments),
            )
        return await executor(name, arguments)

    all_names = [t.name for t in ALL_TOOLS]
    return f"Unknown tool '{name}'. Available: {all_names}"


async def _dispatch_mcp_via_consent(
    name: str, arguments: dict, context: dict | None,
) -> str:
    """Dispatch an MCP tool through the capability consent gate.

    MCP calls used to bypass consent entirely. Now: classify the tool's blast
    radius (``mcp_classify``); READ/PROPOSE run immediately (parity with native
    read tools — no nagging on sensor reads), MUTATE/DESTRUCT flow through
    ``capabilities.executor.execute_tool`` so they create a pending approval +
    capability_audit row and only run once the operator (or a matching consent
    rule) approves. On approval the approval worker re-executes the call via
    ``executor.execute_approved``'s ``mcp__`` branch.
    """
    from nova_contracts import BlastRadius

    from app.pipeline.tools.registry import execute_mcp_tool, get_server_meta
    from app.tools import mcp_classify

    parts = name.split("__", 2)
    server_name = parts[1] if len(parts) == 3 else ""
    meta_entry = get_server_meta(server_name)
    server_metadata = meta_entry.get("metadata") or {}
    transport = meta_entry.get("transport", "stdio")
    blast = mcp_classify.classify(name, server_metadata)

    async def _run() -> str:
        try:
            return await execute_mcp_tool(name, arguments)
        except Exception as e:  # noqa: BLE001 — surface as tool text, never crash the turn
            return f"MCP dispatch error: {e}"

    # Fast path: read-only tools don't gate.
    if blast in (BlastRadius.READ, BlastRadius.PROPOSE):
        return await _run()

    # MUTATE / DESTRUCT → consent gate + audit via the capability platform.
    import json as _json
    from uuid import UUID as _UUID

    from app.capabilities.executor import execute_tool as cap_execute_tool
    from app.db import get_pool

    ctx = context or {}
    default_tenant = _UUID("00000000-0000-0000-0000-000000000001")

    def _uuid(value: object) -> _UUID | None:
        if not value:
            return None
        try:
            return _UUID(str(value))
        except (ValueError, TypeError):
            return None

    async def _underlying(args: dict, secret: str | None) -> dict:
        # Runs only if the gate allowed (or a rule auto-approved). The MCP
        # server holds its own credentials via env/secrets, so `secret` is None.
        return {"result": await _run()}

    provider_kind = mcp_classify.provider_kind_of(server_name, server_metadata)
    target = mcp_classify.target_of(arguments)
    from app.capabilities.preview import build_action_preview
    preview = build_action_preview(
        tool_name=name, provider_kind=provider_kind, target=target,
        args=arguments, blast_radius=blast,
    )

    result = await cap_execute_tool(
        get_pool(),
        tenant_id=_uuid(ctx.get("tenant_id")) or default_tenant,
        user_id=_uuid(ctx.get("user_id")),
        task_id=_uuid(ctx.get("task_id")),
        actor_kind=ctx.get("actor_kind", "agent"),
        actor_id=str(ctx.get("actor_id") or "mcp"),
        tool_name=name,
        tool_kind="mcp_http" if transport == "http" else "mcp_stdio",
        blast_radius=blast,
        reversible=(blast == BlastRadius.MUTATE),
        provider_kind=provider_kind,
        target=target,
        credential_id=None,
        args=arguments,
        underlying=_underlying,
        diff_preview=preview,
    )

    if isinstance(result, dict):
        status = result.get("status")
        if status == "consent_pending":
            return _json.dumps({
                "status": "consent_pending",
                "approval_id": result.get("approval_id"),
                "message": (
                    f"'{name}' is a {blast.value.upper()} action and needs your "
                    "approval before it runs. It's waiting in Pending Approvals."
                ),
            })
        if status == "user_rejected":
            return _json.dumps({
                "status": "user_rejected",
                "message": f"'{name}' was denied and did not run.",
            })
        inner = result.get("result")
        if isinstance(inner, str):
            return inner
        return _json.dumps(result)
    return str(result)


async def _dispatch_github_external_via_capabilities(
    name: str, arguments: dict, context: dict | None,
) -> str:
    """Route github_external tool through capabilities.executor.

    Returns a JSON-serialized string (the agent runner consumes it as a
    Message content). On consent_pending the result includes the approval_id
    so an external observer can correlate to the dashboard's approval card.
    """
    import json as _json
    from uuid import UUID as _UUID

    from app.capabilities.executor import execute_tool as cap_execute_tool
    from app.config import settings
    from app.db import get_pool
    from app.tools.github_external_tools import (
        GITHUB_EXTERNAL_TOOLS,
    )
    from app.tools.github_external_tools import (
        execute_tool as _github_external_execute,
    )

    if not context or not context.get("credential_id"):
        return _json.dumps({
            "status": "error",
            "message": (
                f"Tool '{name}' requires a credential, but no credential_id "
                f"was provided in the agent's task context. The watched_repo's "
                f"credential_id must be threaded from the goal/task metadata "
                f"into the agent runner. Refusing to call without it."
            ),
        })

    tool_def = next((t for t in GITHUB_EXTERNAL_TOOLS if t.name == name), None)
    if tool_def is None:
        return _json.dumps({
            "status": "error",
            "message": f"github_external tool '{name}' has no ToolDefinition",
        })

    def _as_uuid(value, field):
        if value is None or value == "":
            return None
        if isinstance(value, _UUID):
            return value
        try:
            return _UUID(str(value))
        except (ValueError, AttributeError, TypeError) as exc:
            raise ValueError(f"context.{field}={value!r} is not a valid UUID") from exc

    api_base = settings.github_api_base_url

    async def _underlying(args: dict, secret: str | None) -> dict:
        # capabilities.executor passes secret it just decrypted from the vault.
        # Our github_external execute_tool expects it as a kwarg.
        if secret is None:
            return {"status": "error", "message": "no credential resolved"}
        result = await _github_external_execute(name, args, secret=secret, api_base=api_base)
        return result if isinstance(result, dict) else {"result": result}

    try:
        tenant_id = _as_uuid(context.get("tenant_id"), "tenant_id")
        if tenant_id is None:
            return _json.dumps({
                "status": "error",
                "message": "context.tenant_id is required",
            })
        user_id = _as_uuid(context.get("user_id"), "user_id")
        task_id = _as_uuid(context.get("task_id"), "task_id")
        credential_id = _as_uuid(context["credential_id"], "credential_id")
    except ValueError as exc:
        return _json.dumps({"status": "error", "message": str(exc)})

    pool = get_pool()
    try:
        result = await cap_execute_tool(
            pool,
            tenant_id=tenant_id,
            user_id=user_id,
            task_id=task_id,
            actor_kind=context.get("actor_kind", "agent"),
            actor_id=context.get("actor_id", "agent"),
            tool_name=name,
            tool_kind="native",
            blast_radius=tool_def.blast_radius,
            reversible=getattr(tool_def, "reversible", True),
            provider_kind="github",
            target=arguments.get("repo"),
            credential_id=credential_id,
            args=arguments,
            underlying=_underlying,
        )
        return _json.dumps(result, default=str)
    except Exception as exc:
        # Capability executor re-raises tool errors; surface a structured
        # result so the agent's tool-result message stays parseable.
        return _json.dumps({
            "status": "error",
            "message": f"{type(exc).__name__}: {exc}",
        })
