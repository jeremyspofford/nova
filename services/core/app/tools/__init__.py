"""The tool registry, and the single path a tool is ever called through.

The registry is code, not configuration: a tool exists because a module in
this package declares it, and there is no database row, no grant and no
per-person allow-list in this slice. What contains the blast radius today
is the toolset itself — a dedicated workspace volume, memory calls scoped
to the turn's own person, and a fetch that cannot reach this machine or
this network. The policy layer that decides WHO may call WHAT is a later
slice, and it will wrap dispatch() rather than replace it.

dispatch() is the only entry point on purpose. Two properties hold there
and nowhere else:

  * arguments are validated against the tool's own advertised schema
    BEFORE the executor is looked at, so a call that does not match
    executes nothing at all and comes back as a retryable error;
  * an executor cannot throw into the caller. Every failure — a stated
    refusal, an unreachable peer, a bug — becomes an `Error: ...` result
    plus ok=False, because the caller is a token stream and an exception
    there is a truncated reply with no reason in it.
"""
from __future__ import annotations

import json
import logging

from app.tools import memory_tools, schema, util, web, workspace
from app.tools.base import ERROR_PREFIX, Tool, ToolContext, ToolFailure

__all__ = [
    "ERROR_PREFIX",
    "REGISTRY",
    "Tool",
    "ToolContext",
    "ToolFailure",
    "advertised_tools",
    "context_for",
    "dispatch",
    "tool_names",
]

logger = logging.getLogger("core")

REGISTRY: dict[str, Tool] = {
    tool.name: tool
    for tool in (*workspace.TOOLS, *memory_tools.TOOLS, *util.TOOLS, *web.TOOLS)
}


def tool_names() -> list[str]:
    return sorted(REGISTRY)


def context_for(app, person) -> ToolContext:
    """The context a turn hands its tools. The workspace root is read from
    the environment once, here, so a single read decides the boundary for
    every filesystem call that turn makes."""
    return ToolContext(app=app, person=person, workspace_root=workspace.root_from_env())


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
    except ToolFailure as exc:
        return f"{ERROR_PREFIX}{exc}", False
    except Exception as exc:
        # Not a refusal anybody wrote — a bug. It is reported to the log in
        # full and to the model in one line, and it still cannot reach the
        # stream as an exception.
        logger.exception("tool %s raised", name)
        return f"{ERROR_PREFIX}{name} failed unexpectedly — {type(exc).__name__}: {exc}", False

    if not isinstance(result, str) or not result.strip():
        # An empty tool result reads to the model as "it worked, and there
        # was nothing to say" — which is a claim nothing checked. A tool
        # that has nothing to report says so in words or it failed.
        logger.error("tool %s returned an empty result", name)
        return f"{ERROR_PREFIX}{name} returned an empty result, so nothing was confirmed", False
    return result, True
