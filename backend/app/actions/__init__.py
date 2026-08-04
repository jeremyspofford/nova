"""Recommendation actions — approving a card executes a typed plan.

The contract, in one line: **Approve executes when the card carries a typed
plan that is a complete description of a final state the backend already has
an operator-only route for. Approve never runs a model.**

Four things follow from that and each one is enforced somewhere in this
package rather than asked for in a prompt:

* `parse()` is the only door in. A document that does not typecheck against
  `schemas.ActionDoc` never reaches the database, so `create()` refuses it in
  the same turn the model proposed it and the model gets a field-level reason
  it can act on.
* `preflight()` checks the plan against the NETWORK before the operator reads
  the card, and stores what it found. A model can be confidently wrong about
  a URL, and a card that says "ready" because the model said so is worse than
  no card. The OSSInsight recommendation this package was written for names
  an endpoint that answers 405 to an MCP `initialize`; preflight is what puts
  that fact on the card.
* `assert_routes_exist()` runs at boot and refuses to start if any action
  type names an operator route that is not there. That is the mechanical form
  of "an executor may only exist where the operator can already do this from
  the UI" — the rule cannot rot quietly, it takes the backend down.
* Execution is driven by `action_worker`, which claims a run only while the
  recommendation is still `approved` by `operator`. The approval is a
  standing precondition re-checked at claim time, not a fact trusted once.

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
from app.actions import mcp_server as _mcp_server
from app.actions.schemas import ActionDoc, McpServerAdd

log = logging.getLogger(__name__)

# A preflight is one DNS resolve plus one MCP handshake. mcp_client bounds the
# handshake at 10s; this bounds the whole thing so a server that accepts a
# connection and then says nothing cannot hold a background task open.
PREFLIGHT_TIMEOUT_S = 25.0
DEFAULT_EXECUTE_TIMEOUT_S = 120.0

_ADAPTER = TypeAdapter(ActionDoc)


@dataclass(frozen=True)
class Spec:
    """One action type.

    `operator_route` is the name of the function in `router_chat` whose effect
    this action reproduces. It is not documentation — `assert_routes_exist()`
    resolves it at boot.

    `execute` being None means the UI says so: `is_executable()` feeds the
    card, so a plan with no executor renders "approving records your decision
    and nothing is registered" rather than a button that promises more than
    the code can do.
    """
    model: type
    operator_route: str
    describe: Callable[[Any], str]
    preflight: Callable[..., Awaitable[tuple[str, str, Optional[list[dict]]]]]
    execute: Optional[Callable[..., Awaitable[dict]]] = None


_TYPES: dict[str, Spec] = {
    "mcp_server.add": Spec(
        model=McpServerAdd,
        operator_route="create_mcp_server_endpoint",
        describe=_mcp_server.describe,
        preflight=_mcp_server.preflight,
        execute=_mcp_server.execute,
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
    parsed document the executor will receive.

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


_ACTION_GUIDANCE = (
    "OPTIONAL typed plan. Include it when the recommendation IS a concrete "
    "final state this backend can reach on its own; omit it when the work "
    "needs a person, and the card is then a note they read rather than a "
    "button they press. A plan that does not typecheck is refused in this "
    "same turn, naming the field and the reason, so you can correct it and "
    "raise again under the same dedupe_key. You never execute it: the "
    "operator's click does, and only after a preflight has dialled the "
    "target and put what it actually found on the card — so propose the "
    "plan you believe in and let the check disagree with you."
)


def tool_schema() -> Optional[dict]:
    """The `action` parameter for `raise_recommendation`, from the registry.

    DERIVED, because the alternative is a second description of what a model
    may propose, living in the tool definition and drifting from the models
    `parse()` validates against. It would drift silently, too — nothing fails
    when a tool schema is merely wrong, the model just fills in fields the
    door then rejects. Generating it here means the tool can only ever
    advertise what the door accepts, and a new Spec updates the prompt by
    existing.

    Each variant carries its own model docstring, which is where the reasons
    live — McpServerAdd explains why `transport` is `Literal["http"]` and not
    a limitation waiting to be lifted. The model does better work told the
    truth, and the truth is enforced regardless.

    None when nothing is registered: a tool that offers a plan nobody can
    parse is worse than one that offers none.
    """
    variants = []
    for _name, spec in sorted(_TYPES.items()):
        schema = spec.model.model_json_schema()
        schema.pop("title", None)
        variants.append(schema)
    if not variants:
        return None
    if len(variants) == 1:
        only = dict(variants[0])
        # keep the model's own description; lead with the contract
        only["description"] = _ACTION_GUIDANCE + "\n\n" + str(
            only.get("description") or "").strip()
        return only
    return {"description": _ACTION_GUIDANCE, "anyOf": variants}


async def preflight(rec_id: str, *, operator: bool = False) -> Optional[dict]:
    """Check a card's plan against reality and record the verdict on the row.

    Also stores the tool list it found. That is not decoration: with one-click
    grants the operator reads those descriptions on the card, and the executor
    binds to their hash, so this column is the review that
    `mcp_servers.refresh()` would otherwise skip.

    Never raises: a preflight that fails is a 'blocked' card with the reason
    on it, which is the whole point. A preflight that fails BECAUSE of a bug
    in preflight would otherwise take out the background task that raised the
    card.
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

    tools: Optional[list[dict]] = None
    try:
        doc = parse(raw)
    except ValueError as e:
        state, detail = "blocked", f"invalid action document: {e}"
    else:
        spec = _TYPES[doc.type]
        try:
            state, detail, tools = await asyncio.wait_for(
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
            "action_tools = $4, action_checked_at = now() WHERE id = $1 "
            "RETURNING action_state, action_detail, action_checked_at",
            rid, state, detail, json.dumps(tools) if tools is not None else None)
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
