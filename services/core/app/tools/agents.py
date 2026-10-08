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

import json

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
    if ctx.undo_sink is not None:
        # The row this call created, by id as well as name: a rewind deletes
        # exactly it, never a later agent that reused the name.
        ctx.undo_sink.append({"name": result.agent.name, "agent_id": str(result.agent.id)})
    return result.text


# The columns an undo payload carries for update_agent, and the ones the
# create ledger event records the spec by. `model_chain` is not a column (it
# is the gateway route), so it is in neither: an update that carries a chain
# records no undo payload at all, and a rewind lists that call as not undone
# rather than restoring the fields and claiming the call put back.
_COLUMN_FIELDS = (
    "purpose",
    "instructions",
    "tools",
    "skills",
    "monthly_cap_usd",
    "read_shared_memory",
)


def _field_value(agent, key: str):
    """One column of an agent row, JSON-able: lists for the name tuples, a
    float for the Decimal cap (None stays None) — the same shape the ledger's
    _spec_meta records, so a value read back compares with a value stored."""
    value = getattr(agent, key)
    if key in ("tools", "skills"):
        return list(value)
    if key == "monthly_cap_usd":
        return None if value is None else float(value)
    return value


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
    before = await agents.by_name(pool, name) if ctx.undo_sink is not None else None
    try:
        result = await agents.update(pool, ctx.app, name, changes, actor=actor)
    except agents.AgentError as exc:
        raise ToolFailure(str(exc)) from exc
    if ctx.undo_sink is not None and before is not None and "model_chain" not in changes:
        fields = sorted(key for key in changes if key in _COLUMN_FIELDS)
        ctx.undo_sink.append(
            {
                "name": name,
                "prior": {key: _field_value(before, key) for key in fields},
                "landed": {key: _field_value(result.agent, key) for key in fields},
            }
        )
    return result.text


async def _agent_or_gone(pool, name: str, agent_id: str | None = None):
    agent = await _agents().by_name(pool, name)
    if agent is None or (agent_id is not None and str(agent.id) != agent_id):
        raise ToolFailure(f"agent {name} is already gone — nothing to put back")
    return agent


async def _created_spec(pool, agent_id) -> dict | None:
    """The spec the agent was CREATED with, from the governance ledger's
    agent.created event (written in the create's own transaction)."""
    meta = await pool.fetchval(
        "SELECT meta FROM governance_events WHERE kind = $1 AND subject_ref = $2 "
        "ORDER BY created_at DESC LIMIT 1",
        _agents().governance.AGENT_CREATED,
        agent_id,
    )
    if isinstance(meta, str):
        meta = json.loads(meta)
    return meta if isinstance(meta, dict) else None


async def revert_create_agent(payload: dict, ctx: ToolContext) -> str:
    """Put back one create_agent call (chat-rewind): delete the agent it
    created, through the one delete path, and VERIFY it is absent by name. An
    agent changed since its creation (its row no longer matches the spec the
    ledger recorded at create) is refused — deleting it would destroy changes
    this call did not make. The folder is kept by design and the line says so."""
    agents = _agents()
    name, agent_id = payload.get("name"), payload.get("agent_id")
    if not isinstance(name, str) or not isinstance(agent_id, str):
        raise ToolFailure(f"the recorded agent is unreadable: {payload!r}"[:300])
    actor = _actor(ctx)
    pool = await db.get_pool()
    agent = await _agent_or_gone(pool, name, agent_id)
    created = await _created_spec(pool, agent.id)
    if created is None:
        raise ToolFailure(
            f"agent {name} has no creation record in the ledger, so whether it changed since "
            "cannot be checked — not deleted"
        )
    moved = [key for key in _COLUMN_FIELDS if _field_value(agent, key) != created.get(key)]
    if moved:
        raise ToolFailure(
            f"agent {name} has changed since it was created ({', '.join(moved)}) — "
            "not deleted, so those changes are kept"
        )
    try:
        await agents.delete(pool, ctx.app, name, actor=actor)
    except agents.AgentError as exc:
        raise ToolFailure(str(exc)) from exc
    if await agents.by_name(pool, name) is not None:
        raise ToolFailure(f"agent {name} is still there after the delete — it did not verify")
    return (
        f"Deleted agent {name}; its folder agents/{name}/ was kept, as were its memory notes "
        "and log conversation."
    )


async def revert_update_agent(payload: dict, ctx: ToolContext) -> str:
    """Put back one update_agent call (chat-rewind): write the changed
    fields' prior values back through the one writer, and VERIFY they read
    back. Refused when the agent is gone or any of those fields moved since
    the call landed — the later change is not this call's to overwrite."""
    agents = _agents()
    name, prior, landed = payload.get("name"), payload.get("prior"), payload.get("landed")
    if not isinstance(name, str) or not isinstance(prior, dict) or not isinstance(landed, dict):
        raise ToolFailure(f"the recorded agent update is unreadable: {payload!r}"[:300])
    unknown = sorted(set(prior) - set(_COLUMN_FIELDS))
    if unknown or set(prior) != set(landed):
        raise ToolFailure(f"the recorded agent update names fields it cannot put back: {unknown}")
    actor = _actor(ctx)
    pool = await db.get_pool()
    agent = await _agent_or_gone(pool, name)
    moved = [key for key in landed if _field_value(agent, key) != landed[key]]
    if moved:
        raise ToolFailure(
            f"agent {name} has changed since that update ({', '.join(sorted(moved))}) — "
            "not put back, so the later change is kept"
        )
    try:
        await agents.update(pool, ctx.app, name, dict(prior), actor=actor)
    except agents.AgentError as exc:
        raise ToolFailure(str(exc)) from exc
    fresh = await agents.by_name(pool, name)
    if fresh is None:
        raise ToolFailure(f"agent {name} could not be read back after the restore")
    wrong = [key for key in prior if _field_value(fresh, key) != prior[key]]
    if wrong:
        raise ToolFailure(
            f"agent {name}'s {', '.join(sorted(wrong))} did not read back as the prior "
            "value — the restore did not verify"
        )
    return f"Put agent {name}'s {', '.join(sorted(prior))} back to what it was before."


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
        revert=revert_create_agent,
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
        revert=revert_update_agent,
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
        reads_only=True,
        result_kind=RESULT_KIND_LISTING,
        # Each row carries the agent's cap and its month-to-date spend, read
        # from the same ledger spend_report reads. A figure quoted out of this
        # result IS a figure read from the record (S15).
        reports_spend=True,
    ),
)
