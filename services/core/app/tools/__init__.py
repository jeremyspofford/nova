"""The tool registry, and the single path a tool is ever called through.

The registry is code, not configuration: a tool exists because a module in
this package declares it, and there is no database row, no grant and no
per-person allow-list — anywhere. Every registered tool runs for every turn
that calls it (owner ruling 2026-09-03: v4 makes no authorization decisions;
nothing here asks the owner or refuses on his behalf). What contains the blast
radius is the toolset itself — a dedicated workspace volume, memory calls
scoped to the turn's own person, a fetch that cannot reach this machine or
this network, and device commands that only a paired, connected machine will
verify and execute.

dispatch() is the only entry point on purpose. Two properties hold there
and nowhere else:

  * arguments are validated against the tool's own advertised schema
    BEFORE the executor is looked at, so a call that does not match
    executes nothing at all and comes back as a retryable error;
  * an executor cannot throw into the caller. Every failure — a stated
    refusal, an unreachable peer, a bug — becomes an `Error: ...` result
    plus ok=False, because the caller is a token stream and an exception
    there is a truncated reply with no reason in it.

A refusal an executor states is a fact about whether the call CAN run (the
path is outside the workspace, the device is offline, the fetch would reach
this network) — never a judgment about whether it MAY. tests/test_no_approvals.py
pins that dispatch awaits nothing but the executor and imports nothing outside
this package: the day someone rebuilds a gate here, that suite is what refuses.
"""
from __future__ import annotations

import json
import logging

from app.tools import devices, memory_tools, schema, util, web, web_search, workspace
from app.tools.base import ERROR_PREFIX, RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure

__all__ = [
    "ERROR_PREFIX",
    "REGISTRY",
    "RESULT_KIND_LISTING",
    "Tool",
    "ToolContext",
    "ToolFailure",
    "advertised_tools",
    "context_for",
    "dispatch",
    "tool_names",
    "tool_names_by_result_kind",
]

logger = logging.getLogger("core")

REGISTRY: dict[str, Tool] = {
    tool.name: tool
    for tool in (
        *workspace.TOOLS,
        *memory_tools.TOOLS,
        *util.TOOLS,
        *web.TOOLS,
        *web_search.TOOLS,
        *devices.TOOLS,
    )
}


def tool_names() -> list[str]:
    return sorted(REGISTRY)


def tool_names_by_result_kind(kind: str) -> list[str]:
    """The registered tools declaring `Tool.result_kind == kind`, sorted.
    Derived from the live registry every call, so a tool added (or
    monkeypatched in) with the declaration is counted by that fact alone."""
    return sorted(name for name, tool in REGISTRY.items() if tool.result_kind == kind)


def context_for(app, person, *, facts_sink: list[dict] | None = None) -> ToolContext:
    """The context a turn hands its tools. The workspace root is read from
    the environment once, here, so a single read decides the boundary for
    every filesystem call that turn makes. `facts_sink` collects the facts a
    call DETERMINED even when it refused (see ToolContext).

    `person` must be a real identity: every route resolves one before a turn
    starts (identity.require_person) and the memory tools scope to it. A None
    here is a caller bug stated at the call site, not a permission decision —
    nothing downstream would refuse on its behalf."""
    if person is None:
        raise ValueError("context_for needs the turn's person — no route runs a turn without one")
    return ToolContext(
        app=app,
        person=person,
        workspace_root=workspace.root_from_env(),
        facts_sink=facts_sink,
    )


def advertised_tools() -> list[dict]:
    """The OpenAI `tools` array, derived from the registry rather than
    written out beside it — a tool added to a module is advertised by that
    fact alone, and can never be advertised with a schema different from
    the one dispatch validates against."""
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            },
        }
        for tool in (REGISTRY[name] for name in tool_names())
    ]


def _retryable(problem: str) -> str:
    """A refusal the model can fix by calling again — so it is told to."""
    return f"{ERROR_PREFIX}{problem} — re-issue the call"


def _parse_arguments(arguments: object) -> tuple[dict | None, str | None]:
    """(parsed arguments, problem). Backends differ: most send the
    arguments as a JSON string, some send them already parsed, and a call
    with no arguments arrives as "" about as often as it arrives as "{}"."""
    if isinstance(arguments, dict):
        return arguments, None
    if arguments is None:
        return {}, None
    if isinstance(arguments, str):
        text = arguments.strip()
        if not text:
            return {}, None
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            return None, f"the arguments were not valid JSON ({exc.msg} at position {exc.pos})"
        if not isinstance(parsed, dict):
            return None, (
                f"the arguments must be a JSON object, got {schema.json_type_name(parsed)}"
            )
        return parsed, None
    return None, f"the arguments must be a JSON object, got {schema.json_type_name(arguments)}"


async def dispatch(name: str, arguments: object, ctx: ToolContext) -> tuple[str, bool]:
    """Run one tool call. Returns (result text for the model, ok).

    `ok` is decided mechanically here and never by reading the text back:
    a caller writing a span or an activity frame must not have to guess
    from prose whether the call worked.

    The whole path is: registry lookup, argument parsing, schema validation,
    executor. Nothing in between reads a table, asks anyone, or decides
    whether the call may happen — a registered tool with valid arguments runs,
    every time. The only things that stop a call are the ones that make it
    impossible to run honestly (no such tool, arguments that do not match the
    schema) and the executor's own stated refusals, and each of those comes
    back as an `Error:` result the model can read.
    """
    tool = REGISTRY.get(name)
    if tool is None:
        return (
            _retryable(
                f"there is no tool named {name!r} — the tools you have are: "
                f"{', '.join(tool_names())}"
            ),
            False,
        )

    parsed, problem = _parse_arguments(arguments)
    if problem is not None:
        return _retryable(problem), False

    problem = schema.validate(tool.parameters, parsed)
    if problem is not None:
        return _retryable(problem), False

    try:
        result = await tool.executor(parsed, ctx)
        ok = True
    except ToolFailure as exc:
        result, ok = f"{ERROR_PREFIX}{exc}", False
    except Exception as exc:
        # Not a refusal anybody wrote — a bug. It is reported to the log in
        # full and to the model in one line, and it still cannot reach the
        # stream as an exception.
        logger.exception("tool %s raised", name)
        result = f"{ERROR_PREFIX}{name} failed unexpectedly — {type(exc).__name__}: {exc}"
        ok = False
    else:
        if not isinstance(result, str) or not result.strip():
            # An empty tool result reads to the model as "it worked, and
            # there was nothing to say" — which is a claim nothing checked.
            # A tool that has nothing to report says so in words or it failed.
            logger.error("tool %s returned an empty result", name)
            result = f"{ERROR_PREFIX}{name} returned an empty result, so nothing was confirmed"
            ok = False

    return result, ok
