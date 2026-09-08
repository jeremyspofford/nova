"""/api/v1/agents — the Agents page's surface over the agent store
(app/agents.py), plus the two lists the page's form is built from:
`/api/v1/tools` (the live registry) and `/api/v1/skills` (the files under
`<WORKSPACE_ROOT>/skills/`).

Nothing here decides anything. Every write is one store call, every
refusal is the store's own words (AgentError → 400, quoted verbatim), and
the sentence a create/update/delete returns (`text`) is the one the store
composed from what it READ BACK after the commit — the same sentence Nova's
own tools return, so the page and a reply never disagree.

Agents are household objects: any authenticated person sees and edits every
agent (activity.py's stance — this is "what does the household run", not
"what did I make"), so nothing is ownership-scoped. `require_person` is
only the same auth every route has.

Everything the page shows beyond the row's own columns is DERIVED at the
request, never stored:

  * `state` — whether the agent is working right now, and on what. The
    fact is `traces.DOING`, a process-local map written by the turn loop
    for every turn it runs and gone with the process. A `turns` row alone
    cannot carry liveness: a stored "working" flag would still say
    'thinking' a day after the process that set it was killed (the exact
    lie traces.INFLIGHT exists to prevent for the chat page). So working
    means: the newest open row (`status IS NULL`) for this agent whose id
    is a key of DOING right now; `doing` is the map's word for it and
    `since` the row's started_at. No such row → idle, the rest null.
  * `last_active` — the latest `turns.started_at` with this agent_id, or
    null when it has never run.
  * `bound_timers` — the timers rows naming this agent, the same shape
    `agents.bound_timers` returns, read for the whole page in one query.
  * `spent_month_usd` — the gateway's ledger for the agent's derived role
    (`agent_<name>`), read through `spend_api.report` — the SAME report the
    Spend page and the cap check read — ONCE per request for every row. A
    ledger that cannot be read leaves the figure null and says why in
    `spend_note`; it is never shown as 0, because 0 is a real figure (an
    agent that ran nothing this month) and "unknown" is not.
  * `skills` / `unknown_tools` — each skill name checked against the
    directory, each tool name against the registry, at the call; a file or
    a tool that has since gone is flagged, never dropped.

Money is a float in JSON; the client formats it.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any

import asyncpg
from fastapi import APIRouter, Body, Depends, HTTPException, Request

from app import agents, conversations, db, identity, spend_api, tools, traces
from app.agents import Agent, AgentError, AgentSpec, RouteOutcome
from app.identity import Person

router = APIRouter(prefix="/api/v1", tags=["agents"])

# The origin the row records for anything made through this router.
CREATED_VIA = "page"

# The keys a POST body may carry — AgentSpec's fields, by name.
SPEC_FIELDS = frozenset(
    {
        "name",
        "purpose",
        "instructions",
        "tools",
        "skills",
        "monthly_cap_usd",
        "max_tool_rounds",
        "read_shared_memory",
        "model_chain",
    }
)
REQUIRED_FIELDS = ("name", "purpose", "instructions", "tools")


# ── refusals ───────────────────────────────────────────────────────────────


def _refused(exc: AgentError) -> HTTPException:
    """The store's refusal, verbatim, as a 400 — the page shows the words."""
    return HTTPException(status_code=400, detail=str(exc))


def _not_found(name: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"no agent named {name}")


async def _agent_or_404(pool: asyncpg.Pool, name: str) -> Agent:
    agent = await agents.by_name(pool, name)
    if agent is None:
        raise _not_found(name)
    return agent


# ── the body → the spec ────────────────────────────────────────────────────


def _names(value: Any, what: str) -> Any:
    """A JSON list becomes the tuple the spec holds. Anything else is handed
    to the store's validator AS IS so its refusal ("tools must be a list of
    names") is the one the page sees — except a JSON object, which the
    validator would iterate as its keys and silently accept."""
    if value is None:
        return ()
    if isinstance(value, list | tuple):
        return tuple(value)
    if isinstance(value, dict):
        raise HTTPException(status_code=400, detail=f"{what} must be a list of names")
    return value


def _flag(value: Any, what: str) -> bool:
    """read_shared_memory must be a JSON boolean. The store takes bool() of
    it, and bool("false") is True — a string here would be read as the
    opposite of what was sent, so it is refused in words instead."""
    if not isinstance(value, bool):
        raise HTTPException(status_code=400, detail=f"{what} must be true or false")
    return value


def _spec_from(body: dict) -> AgentSpec:
    missing = [key for key in REQUIRED_FIELDS if key not in body]
    if missing:
        raise HTTPException(
            status_code=400, detail=f"an agent needs {', '.join(missing)} — none was sent"
        )
    unknown = sorted(set(body) - SPEC_FIELDS)
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=(
                f"an agent has no field(s) {', '.join(unknown)} — the fields are: "
                f"{', '.join(sorted(SPEC_FIELDS))}"
            ),
        )
    return AgentSpec(
        name=body["name"],
        purpose=body["purpose"],
        instructions=body["instructions"],
        tools=_names(body["tools"], "tools"),
        skills=_names(body.get("skills"), "skills"),
        monthly_cap_usd=body.get("monthly_cap_usd"),
        max_tool_rounds=body.get("max_tool_rounds"),
        read_shared_memory=_flag(body.get("read_shared_memory", False), "read_shared_memory"),
        model_chain=_names(body.get("model_chain"), "model_chain"),
    )


def _changes_from(body: dict) -> dict:
    """A PUT body, passed to the store as the subset it is — the store names
    an unknown field and refuses a rename in its own words. Only the two
    shapes the store would misread are checked here (see _names, _flag)."""
    changes = dict(body)
    for key in ("tools", "skills", "model_chain"):
        if key in changes:
            changes[key] = _names(changes[key], key)
    if "read_shared_memory" in changes:
        changes["read_shared_memory"] = _flag(changes["read_shared_memory"], "read_shared_memory")
    return changes


# ── the derived facts, batched for the rows about to be shown ──────────────


async def _bound_timers(
    pool: asyncpg.Pool, ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[dict]]:
    """agents.bound_timers for every id in one query, same shape and order."""
    bound: dict[uuid.UUID, list[dict]] = {agent_id: [] for agent_id in ids}
    if not ids:
        return bound
    rows = await pool.fetch(
        "SELECT agent_id, id, title FROM timers WHERE agent_id = ANY($1::uuid[]) "
        "ORDER BY created_at, id",
        list(ids),
    )
    for row in rows:
        bound[row["agent_id"]].append({"id": str(row["id"]), "title": row["title"]})
    return bound


async def _last_active(pool: asyncpg.Pool, ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, str | None]:
    latest: dict[uuid.UUID, str | None] = dict.fromkeys(ids)
    if not ids:
        return latest
    rows = await pool.fetch(
        "SELECT agent_id, max(started_at) AS latest FROM turns "
        "WHERE agent_id = ANY($1::uuid[]) GROUP BY agent_id",
        list(ids),
    )
    for row in rows:
        latest[row["agent_id"]] = row["latest"].isoformat()
    return latest


IDLE = {"working": False, "doing": None, "since": None, "turn_id": None}


async def _states(pool: asyncpg.Pool, ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, dict]:
    """The working/idle state of each agent, derived as the module docstring
    says: an open turns row of the agent's whose id THIS process is running
    right now (a key of traces.DOING). The running ids are read once and
    handed to the query, so an open row no process is running (a leftover
    the startup sweep has not reached, or a close that failed) can never be
    reported as work in progress; the map is read again for the word, so a
    turn that finished between the query and now reads idle, not 'None'."""
    states: dict[uuid.UUID, dict] = {agent_id: dict(IDLE) for agent_id in ids}
    running = list(traces.DOING)
    if not ids or not running:
        return states
    rows = await pool.fetch(
        "SELECT DISTINCT ON (agent_id) agent_id, id, started_at FROM turns "
        "WHERE agent_id = ANY($1::uuid[]) AND status IS NULL AND id = ANY($2::uuid[]) "
        "ORDER BY agent_id, started_at DESC, id DESC",
        list(ids),
        running,
    )
    for row in rows:
        doing = traces.doing(row["id"])
        if doing is None:
            continue
        states[row["agent_id"]] = {
            "working": True,
            "doing": doing,
            "since": row["started_at"].isoformat(),
            "turn_id": str(row["id"]),
        }
    return states


async def _spend_by_role(app, pool: asyncpg.Pool) -> tuple[dict[str, float], str | None]:
    """The month's spend per routing role from the one ledger report, or
    ({}, why it could not be read). A report with no by_role rollup counts
    as unreadable for the same reason a failed one does: the figure would
    be a guess, and a guess of 0 reads as a fact."""
    try:
        report = await spend_api.report(app, pool, "month")
    except Exception as exc:  # noqa: BLE001 — every failure shape is stated on the row
        detail = getattr(exc, "detail", None) or str(exc) or type(exc).__name__
        return {}, f"ledger unreadable — {detail}"
    rows = report.get("by_role")
    if not isinstance(rows, list):
        return {}, "ledger unreadable — the gateway's report carries no by_role rollup"
    by_role: dict[str, float] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("key"), str):
            continue
        usd = row.get("usd")
        if isinstance(usd, int | float) and not isinstance(usd, bool):
            by_role[row["key"]] = by_role.get(row["key"], 0.0) + float(usd)
    return by_role, None


def _route_json(route: RouteOutcome) -> dict:
    return {"registered": route.registered, "detail": route.detail}


def _agent_json(
    agent: Agent,
    *,
    bound_timers: list[dict],
    last_active: str | None,
    state: dict,
    spent: float | None,
    spend_note: str | None,
) -> dict:
    return {
        "id": str(agent.id),
        "name": agent.name,
        "purpose": agent.purpose,
        "instructions": agent.instructions,
        "tools": list(agent.tools),
        "skills": agents.skills_status(agent),
        "unknown_tools": agents.unknown_tools(agent),
        "monthly_cap_usd": None if agent.monthly_cap_usd is None else float(agent.monthly_cap_usd),
        "max_tool_rounds": agent.max_tool_rounds,
        "read_shared_memory": agent.read_shared_memory,
        "role": agent.role,
        "folder": f"agents/{agent.name}/",
        "log_conversation_id": (
            None if agent.log_conversation_id is None else str(agent.log_conversation_id)
        ),
        "created_via": agent.created_via,
        "created_at": agent.created_at.isoformat(),
        "updated_at": agent.updated_at.isoformat(),
        "bound_timers": bound_timers,
        "spent_month_usd": spent,
        "spend_note": spend_note,
        "last_active": last_active,
        "state": state,
    }


async def _rows_json(app, pool: asyncpg.Pool, rows: Sequence[Agent]) -> list[dict]:
    """The page's rows: three batched reads over exactly these ids and ONE
    ledger report shared by all of them."""
    ids = [agent.id for agent in rows]
    bound = await _bound_timers(pool, ids)
    latest = await _last_active(pool, ids)
    states = await _states(pool, ids)
    by_role, note = await _spend_by_role(app, pool)
    return [
        _agent_json(
            agent,
            bound_timers=bound[agent.id],
            last_active=latest[agent.id],
            state=states[agent.id],
            # A readable ledger with no row for the role: the agent spent
            # nothing this month, a real 0. An unreadable one: null + why.
            spent=None if note is not None else by_role.get(agent.role, 0.0),
            spend_note=note,
        )
        for agent in rows
    ]


async def _one_json(app, pool: asyncpg.Pool, agent: Agent) -> dict:
    (row,) = await _rows_json(app, pool, [agent])
    return row


# ── routes ─────────────────────────────────────────────────────────────────


@router.get("/agents")
async def list_agents(
    request: Request, _person: Person = Depends(identity.require_person)
) -> list[dict]:
    pool = await db.get_pool()
    return await _rows_json(request.app, pool, await agents.list_all(pool))


@router.post("/agents", status_code=201)
async def create_agent(
    request: Request,
    body: dict[str, Any] = Body(...),
    person: Person = Depends(identity.require_person),
) -> dict:
    pool = await db.get_pool()
    spec = _spec_from(body)
    try:
        result = await agents.create(
            pool,
            request.app,
            spec,
            created_via=CREATED_VIA,
            created_turn_id=None,
            actor=person.name,
        )
    except AgentError as exc:
        raise _refused(exc) from exc
    return {
        **await _one_json(request.app, pool, result.agent),
        "text": result.text,
        "route": _route_json(result.route),
    }


@router.get("/agents/{name}")
async def get_agent(
    name: str, request: Request, _person: Person = Depends(identity.require_person)
) -> dict:
    pool = await db.get_pool()
    return await _one_json(request.app, pool, await _agent_or_404(pool, name))


@router.put("/agents/{name}")
async def update_agent(
    name: str,
    request: Request,
    body: dict[str, Any] = Body(...),
    person: Person = Depends(identity.require_person),
) -> dict:
    pool = await db.get_pool()
    await _agent_or_404(pool, name)
    try:
        result = await agents.update(
            pool, request.app, name, _changes_from(body), actor=person.name
        )
    except AgentError as exc:
        raise _refused(exc) from exc
    return {
        **await _one_json(request.app, pool, result.agent),
        "text": result.text,
        "route": _route_json(result.route),
    }


@router.delete("/agents/{name}")
async def delete_agent(
    name: str, request: Request, person: Person = Depends(identity.require_person)
) -> dict:
    pool = await db.get_pool()
    await _agent_or_404(pool, name)
    try:
        result = await agents.delete(pool, request.app, name, actor=person.name)
    except AgentError as exc:
        raise _refused(exc) from exc
    return {
        "deleted": result.name,
        "paused_timers": result.paused_timers,
        "route": _route_json(result.route),
        "remains": result.remains,
        "text": result.text,
    }


@router.get("/agents/{name}/log")
async def agent_log(name: str, _person: Person = Depends(identity.require_person)) -> list[dict]:
    """The agent's log conversation — the briefs it was handed and the
    reports it wrote — as the chat transcript route renders rows, so a
    served_by or a turn_kind means the same thing on both pages. An agent
    whose log conversation is not there yet (the column is NULL until the
    first delegation recreates it) has nothing to show, and says so with an
    empty list rather than a row it invented."""
    pool = await db.get_pool()
    agent = await _agent_or_404(pool, name)
    if agent.log_conversation_id is None:
        return []
    return await conversations.messages_json(pool, agent.log_conversation_id)


@router.get("/tools")
async def list_tools(_person: Person = Depends(identity.require_person)) -> list[dict]:
    """The live registry, in tool_names() order — the checkbox list the
    form offers, read at the call so a tool registered later is offered by
    that fact alone."""
    return [
        {
            "name": name,
            "description": tools.REGISTRY[name].description,
            "result_kind": tools.REGISTRY[name].result_kind,
            "ephemeral": tools.REGISTRY[name].ephemeral,
        }
        for name in tools.tool_names()
    ]


@router.get("/skills")
async def list_skills(_person: Person = Depends(identity.require_person)) -> list[dict]:
    """The skill files under <WORKSPACE_ROOT>/skills/, read from the
    directory at the call (agents.list_skills says which files count)."""
    return agents.list_skills()
