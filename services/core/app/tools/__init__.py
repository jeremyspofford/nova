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
import uuid

from app.tools import devices, memory_tools, schema, util, web, web_search, workspace
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


def context_for(
    app,
    person,
    *,
    conversation_id: uuid.UUID | None = None,
    agent: str = "chat",
    consent_sink: list[dict] | None = None,
) -> ToolContext:
    """The context a turn hands its tools. The workspace root is read from
    the environment once, here, so a single read decides the boundary for
    every filesystem call that turn makes. `conversation_id`/`agent` are what
    the policy kernel binds a raised consent to; `consent_sink`, when given,
    collects any card the funnel raises this turn for the caller to surface."""
    return ToolContext(
        app=app,
        person=person,
        workspace_root=workspace.root_from_env(),
        agent=agent,
        conversation_id=conversation_id,
        consent_sink=consent_sink,
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

    # The policy gate (D-012): the executor below is reachable ONLY on an ALLOW
    # from the one kernel. This wraps dispatch's schema/executor contract rather
    # than replacing it — validation still runs first, and the (ok mechanical,
    # no throw) guarantees still hold, including here: an authorizer that itself
    # fails is a fail-closed stated refusal, never an exception into the stream.
    from app import policy  # local import keeps the tools package import-cycle-free

    try:
        decision = await policy.authorize(ctx, name, parsed)
    except Exception as exc:
        logger.exception("authorizing %s failed", name)
        return (
            _retryable(f"could not authorize {name} — {type(exc).__name__}: {exc}"),
            False,
        )

    if decision.outcome == policy.DENY:
        # A stated refusal the model must relay, not retry: it starts with the
        # error prefix so the transcript reads it as a refusal.
        return f"{ERROR_PREFIX}{decision.reason}", False
    if decision.outcome == policy.REQUIRE_CONSENT:
        # NOT an error: the action is waiting on the operator, so the model
        # should tell them, not loop retrying. The card is already persisted;
        # the sink lets the caller surface it inline.
        card = decision.card_spec or {}
        if ctx.consent_sink is not None:
            ctx.consent_sink.append(card)
        return f"Awaiting your approval: {card.get('summary', name)}", False
    if not decision.is_allow:
        # An outcome this funnel does not know how to act on is refused, never
        # run — the kernel gained a decision the executor path has not.
        return _retryable(f"{name} was neither allowed nor refused cleanly"), False

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

    if decision.track_outcome:
        # Earned autonomy (S3-R5): policy.authorize marked this run — a
        # burned consent, or an already-earned-auto class — as one to count.
        # This is the ONLY place the run's real ok/fail reaches autonomy.py;
        # the kernel decided beforehand, this never re-decides, only records.
        from app import autonomy, db  # local import: same import-cycle reason as policy above

        pool = await db.get_pool()
        await autonomy.record_outcome(pool, action_class=name, succeeded=ok)

    return result, ok
