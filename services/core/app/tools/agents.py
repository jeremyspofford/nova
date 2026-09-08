"""Her agent tools (S12): hand a task to an agent, and make, change, remove
or list agents — thin wrappers over app/agents.py, the one writer the
Agents page uses too.

Every executor imports `app.agents` FUNCTION-LOCALLY. app/agents.py imports
app.tools at module level (it validates a subset against the registry), so
a module-level import here would be a real cycle — and the tools package
must import nothing that reaches app.chat (test_tools_registry imports it
cold in a subprocess; test_tools_agents pins that neither app.chat nor
app.agents is loaded by that import). The `_agents()` shape is the one
tools/timers.py already uses for refuse_person_write.

Nothing here decides whether a call MAY run. The refusals are stated
CANNOTs: an agent has no delegate of its own (this slice's depth-1 bound —
"put what you need in your report and Nova will route it"), a name no
agent has, a spec the one validator refuses (quoted verbatim). Every
result is the store's own sentence composed from what it READ BACK after
the commit — the same words the page shows.

The create/update parameter names are exactly the API's POST body fields
(agents_api.SPEC_FIELDS), pinned: v3 dropped an operator-only field
(`fallback_model`) from the chat tool silently, so Nova could not set what
the page could. Both tools build their schema from ONE field table below.
"""

from __future__ import annotations

from app import db
from app.tools.base import RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure

# The delegation refusal an agent's turn gets, word for word.
AGENT_CANNOT_DELEGATE = (
    "an agent cannot delegate — put what you need in your report and Nova will route it"
)


def _agents():
    # Function-local on purpose — see the module docstring.
    from app import agents

    return agents


def _actor(ctx: ToolContext) -> str:
    """Who the ledger names for a create/update/delete: the turn's person.
    A context with no identity cannot be attributed, so it is refused in
    words rather than recorded as nobody."""
    name = getattr(getattr(ctx, "person", None), "name", None)
    if not isinstance(name, str) or not name.strip():
        raise ToolFailure("this turn has no identity, so the change could not be attributed")
    return name


def _obj(properties: dict, required: list[str]) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


# ── delegate ───────────────────────────────────────────────────────────────


async def delegate_to_agent(args: dict, ctx: ToolContext) -> str:
    agents = _agents()
    if getattr(getattr(ctx, "person", None), "role", None) == agents.AGENT_PERSON_ROLE:
        # The depth-1 bound, stated as a fact of this slice's shape (like the
        # round cap): an agent's turn cannot open another agent's turn. It is
        # filed through agents.delegation_refused so this refusal writes the
        # SAME facts entry every refusal-before-run writes — status 'refused',
        # so the trace says no delegation ran rather than leaving the span's
        # silence to be read as a child turn that failed. (2026-09-08)
        raise agents.delegation_refused(
            ctx, str(args.get("agent") or "").strip(), AGENT_CANNOT_DELEGATE
        )
    return await agents.delegate(ctx, args)


# ── create / update / delete / list ────────────────────────────────────────

# ONE table of the spec's fields, shared by create_agent and update_agent so
# their parameter names cannot drift from each other or from the API body
# (agents_api.SPEC_FIELDS — pinned in test_tools_agents). `monthly_cap_usd`
# declares no JSON type on purpose: null means "no cap" and the page can
# send it, so the tool must accept it too; the store's one validator
# (agents._cap_decimal) refuses anything that is not dollars-or-null, in
# words, exactly as it does for the page.
_FIELDS: dict[str, dict] = {
    "name": {
        "type": "string",
        "description": (
            "The agent's name: lowercase letters and underscores, starting with a letter, at "
            "most 26 characters (it becomes the routing role agent_<name> and the folder "
            "agents/<name>/). 'nova' is reserved."
        ),
    },
    "purpose": {
        "type": "string",
        "description": "One line on what the agent is for — shown in your roster.",
    },
    "instructions": {
        "type": "string",
        "description": "The agent's own system instructions: how it should work.",
    },
    "tools": {
        "type": "array",
        "items": {"type": "string"},
        "description": (
            "The registered tool names the agent is given (its whole hand). delegate_to_agent "
            "is not allowed in an agent's tools."
        ),
    },
    "skills": {
        "type": "array",
        "items": {"type": "string"},
        "description": (
            "Skill files to attach by name — each must exist as skills/<name>.md in the "
            "workspace (write one with workspace_write_file first)."
        ),
    },
    "monthly_cap_usd": {
        "minimum": 0,
        "description": (
            "Dollars per month the agent may spend, or null for no cap. It stops and says so "
            "when the ledger shows it reached."
        ),
    },
    # The bounds are literals because this module cannot import app.agents at
    # module level (the cycle, see the docstring), and a schema that advertises
    # a range the one validator then refuses is a hand she is shown and cannot
    # play. test_tools_agents pins them equal to agents.MIN_ROUNDS/MAX_ROUNDS —
    # that pin is the mechanism keeping the two in step. (2026-09-08)
    "max_tool_rounds": {
        "type": "integer",
        "minimum": 1,
        "maximum": 50,
        "description": "Tool rounds per task, 1..50 (default: the agents.max_tool_rounds setting).",
    },
    "read_shared_memory": {
        "type": "boolean",
        "description": (
            "Whether the household's shared notes are recalled for the agent (default false: "
            "it reads only its own notes)."
        ),
    },
    "model_chain": {
        "type": "array",
        "items": {"type": "string"},
        "description": (
            "Its routing chain, as provider:model ids in order (default []: it routes like the "
            "chat chain until one is set here or on Settings → Routing)."
        ),
    },
}
CREATE_REQUIRED = ["name", "purpose", "instructions", "tools"]


def _lists_as_tuples(args: dict) -> dict:
    out = dict(args)
    for key in ("tools", "skills", "model_chain"):
        if key in out and out[key] is not None:
            out[key] = tuple(out[key])
    return out


async def create_agent(args: dict, ctx: ToolContext) -> str:
    agents = _agents()
    actor = _actor(ctx)
    given = _lists_as_tuples(args)
    spec = agents.AgentSpec(
        name=given["name"],
        purpose=given["purpose"],
        instructions=given["instructions"],
        tools=given["tools"],
        skills=given.get("skills") or (),
        monthly_cap_usd=given.get("monthly_cap_usd"),
        max_tool_rounds=given.get("max_tool_rounds"),
        read_shared_memory=bool(given.get("read_shared_memory", False)),
        model_chain=given.get("model_chain") or (),
    )
    pool = await db.get_pool()
    try:
        result = await agents.create(
            pool, ctx.app, spec, created_via="chat", created_turn_id=None, actor=actor
        )
    except agents.AgentError as exc:
        raise ToolFailure(str(exc)) from exc
    return result.text


async def update_agent(args: dict, ctx: ToolContext) -> str:
    agents = _agents()
    actor = _actor(ctx)
    name = args["name"]
    changes = {key: value for key, value in _lists_as_tuples(args).items() if key != "name"}
    if not changes:
        raise ToolFailure(
            f"nothing to change for agent {name} — give at least one of: "
            f"{', '.join(sorted(agents.UPDATABLE))}"
        )
    pool = await db.get_pool()
    try:
        result = await agents.update(pool, ctx.app, name, changes, actor=actor)
    except agents.AgentError as exc:
        raise ToolFailure(str(exc)) from exc
    return result.text


async def delete_agent(args: dict, ctx: ToolContext) -> str:
    agents = _agents()
    actor = _actor(ctx)
    pool = await db.get_pool()
    try:
        result = await agents.delete(pool, ctx.app, args["name"], actor=actor)
    except agents.AgentError as exc:
        raise ToolFailure(str(exc)) from exc
    return result.text


def _tools_words(row: dict) -> str:
    unknown = set(row.get("unknown_tools") or ())
    names = [f"{n} (no longer exists)" if n in unknown else n for n in row.get("tools") or ()]
    return ", ".join(names) or "none"


def _cap_words(agents, row: dict) -> str:
    cap = row.get("monthly_cap_usd")
    words = "cap none" if cap is None else f"cap {agents.money(cap)}"
    note = row.get("spend_note")
    if note is not None:
        return f"{words} ({note})"
    return f"{words} (spent {agents.money(row.get('spent_month_usd') or 0.0)} this month)"


def _state_words(state: dict) -> str:
    if not state.get("working"):
        return "idle"
    return f"working: {state.get('doing')} since {state.get('since')}"


def roster_row(agents, row: dict) -> str:
    """One agent, one line, every clause a derived fact from
    agents.list_with_state — the same row the Agents page renders."""
    skills = [s["name"] + ("" if s.get("present") else " (file missing)") for s in row["skills"]]
    parts = [
        f"{row['name']} — {' '.join(str(row['purpose']).split())}",
        f"tools: {_tools_words(row)}",
    ]
    if skills:
        parts.append(f"skills: {', '.join(skills)}")
    parts.extend(
        [
            f"rounds {row['max_tool_rounds']}",
            _cap_words(agents, row),
            _state_words(row.get("state") or {}),
        ]
    )
    return " · ".join(parts)


async def list_agents(args: dict, ctx: ToolContext) -> str:
    agents = _agents()
    pool = await db.get_pool()
    rows = await agents.list_with_state(pool, ctx.app)
    if not rows:
        return "no agents yet"
    return "\n".join(roster_row(agents, row) for row in rows)


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="delegate_to_agent",
        description=(
            "Hand a task to one of the household's agents (your roster names them) and wait "
            "for it to finish — it runs to completion in this call, in its own folder "
            "agents/<name>/ with its own tools and rounds. The result starts with a facts line "
            "the backend wrote from the agent's trace (status, rounds, calls, the files it "
            "actually wrote), then the agent's own report. Relay from the facts line; a result "
            "starting 'Error:' means the agent did not finish. One delegation runs at a time."
        ),
        parameters=_obj(
            {
                "agent": {"type": "string", "description": "The agent's name, from your roster."},
                "task": {
                    "type": "string",
                    "description": "What the agent should do, in full — it sees only this.",
                },
                "context": {
                    "type": "string",
                    "description": (
                        "Anything from this conversation the agent needs to know (it cannot "
                        "read this chat)."
                    ),
                },
                "deliverable": {
                    "type": "string",
                    "description": (
                        "What to write and where, as a path relative to its folder "
                        "(e.g. 'notes/plan.md'), when the task should produce a file."
                    ),
                },
            },
            ["agent", "task"],
        ),
        executor=delegate_to_agent,
        # Its result enumerates the files the agent wrote, so a relay of that
        # list is a backed listing.
        result_kind=RESULT_KIND_LISTING,
    ),
    Tool(
        name="create_agent",
        description=(
            "Create an agent: a specialist you can delegate to, with its own instructions, "
            "tool subset, folder agents/<name>/, routing role agent_<name>, round budget and "
            "monthly cap. Every field the Agents page can set is settable here. The result "
            "states what was created as it was read back (row, folder, route, would-serve "
            "model); a refusal names the rule."
        ),
        parameters=_obj(dict(_FIELDS), CREATE_REQUIRED),
        executor=create_agent,
    ),
    Tool(
        name="update_agent",
        description=(
            "Change an existing agent's fields (any but the name — an agent cannot be renamed; "
            "delete and create another). Give the name and at least one field; omitted fields "
            "are left as they are. monthly_cap_usd null removes the cap."
        ),
        parameters=_obj(dict(_FIELDS), ["name"]),
        executor=update_agent,
    ),
    Tool(
        name="delete_agent",
        description=(
            "Delete an agent by name. Every scheduled timer bound to it is paused (and named "
            "in the result); its folder, its notes and its log conversation are left in place, "
            "and the result says so."
        ),
        parameters=_obj({"name": dict(_FIELDS["name"])}, ["name"]),
        executor=delete_agent,
    ),
    Tool(
        name="list_agents",
        description=(
            "List the household's agents: purpose, tools, rounds, cap and what each spent "
            "this month (or that the ledger could not be read), and whether each is idle or "
            "working right now and on what. Takes no arguments."
        ),
        parameters=_obj({}, []),
        executor=list_agents,
        result_kind=RESULT_KIND_LISTING,
    ),
)
