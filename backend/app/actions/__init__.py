"""Recommendation actions — approving a card can execute a typed plan.

The contract, in one line: **Approve executes when the card carries a typed
plan that is a complete description of a final state the backend already has
an operator-only route for. Approve never runs a model.**

Three things follow from that and each one is enforced somewhere in this
package rather than asked for in a prompt:

* `parse()` is the only door in. A document that does not typecheck against
  `schemas.ActionDoc` never reaches the database, so `create()` refuses it
  in the same turn the model proposed it and the model gets a field-level
  reason it can act on.
* `preflight()` checks the plan against the NETWORK before the operator
  reads the card. This is the part that matters most in practice: a model
  can be confidently wrong about a URL, and a card that says "ready" because
  the model said so is worse than no card. The OSSInsight recommendation
  this package was written for names an endpoint that answers 405 to an MCP
  `initialize`; preflight is what puts that fact on the card.
* `assert_routes_exist()` runs at boot and refuses to start if any action
  type names an operator route that is not there. That is the mechanical
  form of "an executor may only exist where the operator can already do this
  from the UI" — the rule cannot rot quietly, it takes the backend down.

There is deliberately NO LLM client and NO agents.runner import in this
package, at module scope or inside a function. Execution is Python reading a
parsed document. `tests/test_recommendation_actions.py` walks the AST to keep
it that way, because the dominant idiom in this codebase is the late local
import and a `from app.llm import ...` three levels inside a function would
otherwise pass review.
"""

import asyncio
import json
import logging
import uuid as uuid_mod
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

from pydantic import TypeAdapter, ValidationError

from app import db
from app.actions.schemas import ActionDoc, McpServerAdd

log = logging.getLogger(__name__)

# A preflight is one DNS resolve plus one MCP handshake. mcp_client bounds
# the handshake at 10s; this bounds the whole thing so a server that accepts
# a connection and then says nothing cannot hold a background task open.
PREFLIGHT_TIMEOUT_S = 25.0

_ADAPTER = TypeAdapter(ActionDoc)


@dataclass(frozen=True)
class Spec:
    """One action type.

    `operator_route` is the name of the function in `router_chat` whose
    effect this action reproduces. It is not documentation — `assert_routes_
    exist()` resolves it at boot.

    `execute` is None until phase 2 lands the executor, and the UI DERIVES
    its button label from it rather than hardcoding one. That matters: a
    button reading "Approve & install" while nothing installs would be the
    exact dishonesty this lane exists to remove. Setting `execute` on a Spec
    is the single edit that makes the button promise more, and until then
    the card says approving records a decision, because it does.
    """
    model: type
    operator_route: str
    describe: Callable[[Any], str]
    preflight: Callable[..., Awaitable[tuple[str, str]]]
    execute: Optional[Callable[..., Awaitable[dict]]] = None


# ── mcp_server.add ────────────────────────────────────────────────────────

def _describe_mcp(doc: McpServerAdd) -> str:
    lines = [f'Register MCP server "{doc.name}"',
             f"    URL         {doc.url}",
             "    Transport   streamable HTTP"]
    if doc.headers:
        lines.append("    Headers     " + ", ".join(
            f"{k}: {v}" for k, v in sorted(doc.headers.items())))
    lines.append(f"    Read-only   {'yes' if doc.read_only else 'no'}")
    lines.append("    Grants      " + (
        f"then grant its tools to {', '.join(doc.grant_to)}"
        if doc.grant_to else
        "none — tools are registered, not granted to any agent"))
    return "\n".join(lines)


async def _preflight_mcp(doc: McpServerAdd, *, operator: bool) -> tuple[str, str]:
    """Resolve, then actually speak MCP to the thing and see what answers.

    HEADERS ARE DROPPED unless the operator triggered this by hand. A model
    choosing both a URL and the headers sent to it is an exfiltration
    primitive, and `fetch_url` does not hand her one. The automatic path
    therefore probes anonymously; a server that needs a credential comes back
    'blocked' with its own 401, and the operator's `Test` button is the path
    that sends the real headers.
    """
    from app import mcp_client, net_guard

    err = await net_guard.validate_target(doc.url)
    if err:
        return "blocked", err

    probe = {"name": doc.name, "transport": "http", "url": doc.url,
             "headers": doc.headers if operator else {},
             "created_by": "action"}
    status, tools, detail = await mcp_client.connect_and_list(probe)
    if status != "connected":
        # no "could not connect:" prefix — the card already says it cannot
        # run, and the operator is here for the reason, not the restatement
        return "blocked", detail or "could not connect"
    if not tools:
        return "blocked", "connected, but the server exposes no tools"
    shown = ", ".join(t["name"] for t in tools[:10])
    more = f" (+{len(tools) - 10} more)" if len(tools) > 10 else ""
    return "ready", f"{len(tools)} tools: {shown}{more}"


_TYPES: dict[str, Spec] = {
    "mcp_server.add": Spec(
        model=McpServerAdd,
        operator_route="create_mcp_server_endpoint",
        describe=_describe_mcp,
        preflight=_preflight_mcp,
    ),
}


# ── the package surface ───────────────────────────────────────────────────

def _first_error(e: ValidationError) -> str:
    err = e.errors()[0]
    loc = ".".join(str(p) for p in err.get("loc", ()) if p != "function-after")
    msg = err.get("msg", "invalid")
    if msg.startswith("Value error, "):
        msg = msg[len("Value error, "):]
    return f"{loc or 'action'} — {msg}"


def parse(raw: Any) -> Any:
    """Parse an action document. Raises ValueError with a field-level reason.

    The ValueError text is surfaced verbatim to the model in the tool result,
    so it has to name the field and say what to do instead.
    """
    try:
        return _ADAPTER.validate_python(raw)
    except ValidationError as e:
        raise ValueError(_first_error(e)) from None


def describe(raw: Any) -> Optional[str]:
    """Render the plan the operator will read, SERVER-SIDE, from the same
    parsed document an executor would receive.

    Rendering this in the frontend from the raw jsonb would let the card and
    the executor disagree about what Approve does. They cannot disagree if
    only one of them is allowed to speak.
    """
    if raw is None:
        return None
    try:
        doc = parse(raw)
    except ValueError as e:
        return f"This plan is not valid and cannot run: {e}"
    return _TYPES[doc.type].describe(doc)


def is_executable(raw: Any) -> bool:
    """Does an executor exist for this plan yet?

    Derived from the Spec, so the card's promise tracks the code rather than
    a label somebody remembers to update.
    """
    if raw is None:
        return False
    try:
        doc = parse(raw)
    except ValueError:
        return False
    return _TYPES[doc.type].execute is not None


async def preflight(rec_id: str, *, operator: bool = False) -> Optional[dict]:
    """Check a card's plan against reality and record the verdict on the row.

    Never raises: a preflight that fails is a 'blocked' card with the reason
    on it, which is the whole point. A preflight that fails BECAUSE of a bug
    in preflight would otherwise take out the background task that raised
    the card.
    """
    try:
        rid = uuid_mod.UUID(str(rec_id))
    except ValueError:
        return None
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            "SELECT id, action FROM recommendations WHERE id = $1", rid)
    if r is None or r["action"] is None:
        return None
    raw = json.loads(r["action"]) if isinstance(r["action"], str) else r["action"]

    try:
        doc = parse(raw)
    except ValueError as e:
        state, detail = "blocked", f"invalid action document: {e}"
    else:
        spec = _TYPES[doc.type]
        try:
            state, detail = await asyncio.wait_for(
                spec.preflight(doc, operator=operator), PREFLIGHT_TIMEOUT_S)
        except asyncio.TimeoutError:
            state, detail = "blocked", (
                f"preflight timed out after {PREFLIGHT_TIMEOUT_S:.0f}s")
        except Exception as e:                      # noqa: BLE001 — see docstring
            log.exception("preflight raised for recommendation %s", rid)
            state, detail = "blocked", f"preflight error: {e}"

    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "UPDATE recommendations SET action_state = $2, action_detail = $3, "
            "action_checked_at = now() WHERE id = $1 "
            "RETURNING action_state, action_detail, action_checked_at", rid, state, detail)
    log.info("Action preflight for %s: %s (%s)", rid, state, detail)
    return dict(row) if row else None


def assert_routes_exist() -> None:
    """Boot gate: every action type must name a real operator route.

    An executor that has no operator equivalent is a capability the model can
    reach and the operator cannot, which inverts the whole permission model.
    Checking it at boot means the rule is load-bearing rather than aspirational.
    """
    from app import router_chat
    missing = [f"{name} -> router_chat.{spec.operator_route}"
               for name, spec in _TYPES.items()
               if not callable(getattr(router_chat, spec.operator_route, None))]
    if missing:
        raise RuntimeError(
            "action types name operator routes that do not exist: "
            + "; ".join(missing))
