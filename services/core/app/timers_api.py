"""/api/v1/timers — the Schedules page's read/pause/resume/run/delete surface
over the timers store (app/timers.py). Nothing here decides anything: every
write is one store call, every refusal is the store's own words with the
status it named (TimerRefused → HTTPException), and every row the client sees
is `timers.timer_spec` — the SAME serialisation her tools read — plus
`last_firing`, derived here from `timer_firings`.

Who sees what is the store's rule, not this module's: `timers.owned` returns a
person's own timer or any job, and someone else's id is a 404, never a 403
(conversations.owned_conversation's stance — someone else's is not found).
There is no operator-role gate anywhere in this service (identity.py says so
by name); `require_person` is the same auth every route has.

`last_firing` lives in this layer rather than in `timer_spec` because the
store's rows are RETURNING projections of the `timers` table from every write
path (create, pause, resume) and the newest firing is a fact about a
DIFFERENT table. The API reads it in ONE batched query for exactly the rows it
is about to return (never one query per row) and states it verbatim: a firing
still `running` is shown running, with `ended_at` null — never coerced into an
outcome it has not reached (activity.py's stance on a NULL turn status).

Cursor paging is activity.py's idiom: newest-first, `before` is the last id of
the previous page, and a cursor the server does not know is a 404 — never a
silent restart from the top that would look like paging working when it did
not.

`agent` (S12) is the NAME of the agent a scheduled row runs as, or null: the
row stores only agent_id, and the name is read from the agents table for the
rows about to be returned (one batched query, like last_firing) — derived at
read time, never a label on the timer that a delete could leave stale. The
binding surface is `PUT /{id}/agent {agent: name | null}`: the name resolves
through `agents.by_name` (unknown is a 404 naming the agents that exist), the
kind rule is the store's own refusal (`timers.bind_agent`, a 400 in its words),
and the answer is the row as written.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel

from app import agents, db, identity, timers
from app.identity import Person
from app.timers import TimerRefused

router = APIRouter(prefix="/api/v1/timers", tags=["timers"])

DEFAULT_LIMIT = 50
MAX_LIMIT = 200
# The words a pause carries when the page's button sends none. paused_reason
# is NOT NULL whenever paused_at is (migration 019's CHECK), so the row always
# says why it stopped; a click without a typed reason still says where from.
DEFAULT_PAUSE_REASON = "paused from the Schedules page"


class PauseBody(BaseModel):
    reason: str | None = None


class AgentBody(BaseModel):
    # Required, nullable: null unbinds; a body without the key is a 422, so a
    # client that forgot the field can never unbind by accident.
    agent: str | None


def _refused(exc: TimerRefused) -> HTTPException:
    """The store's refusal, verbatim, with the status IT named."""
    return HTTPException(status_code=exc.status_code, detail=exc.reason)


async def last_firings(
    pool: asyncpg.Pool, timer_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, dict | None]:
    """The newest firing of each timer as {status, ended_at, reason}, or None
    for a timer that has never fired. One query for the whole page, ordered the
    way firings_for pages (started_at DESC, id DESC) so "newest" means the same
    thing on the row and in its expanded history."""
    ids = list(timer_ids)
    newest: dict[uuid.UUID, dict | None] = dict.fromkeys(ids)
    if not ids:
        return newest
    rows = await pool.fetch(
        "SELECT DISTINCT ON (timer_id) timer_id, status, ended_at, reason FROM timer_firings "
        "WHERE timer_id = ANY($1::uuid[]) ORDER BY timer_id, started_at DESC, id DESC",
        ids,
    )
    for row in rows:
        newest[row["timer_id"]] = {
            "status": row["status"],
            "ended_at": row["ended_at"].isoformat() if row["ended_at"] else None,
            "reason": row["reason"],
        }
    return newest


async def agent_names(
    pool: asyncpg.Pool, agent_ids: Iterable[uuid.UUID | None]
) -> dict[uuid.UUID, str]:
    """The name of every agent among `agent_ids` (Nones skipped), one query
    for the whole page. An id with no row is simply absent — under migration
    021's ON DELETE RESTRICT that cannot happen, and if it ever did the
    caller shows a null name beside the id rather than inventing one."""
    ids = sorted({agent_id for agent_id in agent_ids if agent_id is not None}, key=str)
    if not ids:
        return {}
    rows = await pool.fetch("SELECT id, name FROM agents WHERE id = ANY($1::uuid[])", ids)
    return {row["id"]: row["name"] for row in rows}


async def _timers_json(pool: asyncpg.Pool, rows: list[asyncpg.Record]) -> list[dict]:
    newest = await last_firings(pool, [row["id"] for row in rows])
    names = await agent_names(pool, (row["agent_id"] for row in rows))
    return [
        {
            **timers.timer_spec(row),
            "agent": names.get(row["agent_id"]) if row["agent_id"] is not None else None,
            "last_firing": newest[row["id"]],
        }
        for row in rows
    ]


async def _timer_json(pool: asyncpg.Pool, row: asyncpg.Record) -> dict:
    (one,) = await _timers_json(pool, [row])
    return one


async def _owned(pool: asyncpg.Pool, person: Person, timer_id: uuid.UUID) -> asyncpg.Record:
    try:
        return await timers.owned(pool, person, timer_id)
    except TimerRefused as exc:
        raise _refused(exc) from exc


@router.get("")
async def list_timers(
    limit: int = Query(DEFAULT_LIMIT, ge=1),
    before: uuid.UUID | None = None,
    person: Person = Depends(identity.require_person),
) -> dict:
    pool = await db.get_pool()
    capped = min(limit, MAX_LIMIT)
    if before is not None:
        # The cursor must be a row this person could have been shown; anything
        # else is a stale or invented cursor, refused in words (activity.py).
        try:
            await timers.owned(pool, person, before)
        except TimerRefused as exc:
            raise HTTPException(
                status_code=404, detail=f"no timer {before} to page before"
            ) from exc
    rows = await timers.list_for(pool, person, limit=capped, before=before)
    return {"timers": await _timers_json(pool, rows)}


@router.get("/{timer_id}/firings")
async def list_firings(
    timer_id: uuid.UUID,
    limit: int = Query(DEFAULT_LIMIT, ge=1),
    before: uuid.UUID | None = None,
    person: Person = Depends(identity.require_person),
) -> dict:
    pool = await db.get_pool()
    await _owned(pool, person, timer_id)
    capped = min(limit, MAX_LIMIT)
    if before is not None:
        known = await pool.fetchval(
            "SELECT 1 FROM timer_firings WHERE id = $1 AND timer_id = $2", before, timer_id
        )
        if known is None:
            raise HTTPException(
                status_code=404,
                detail=f"no firing {before} of timer {timer_id} to page before",
            )
    rows = await timers.firings_for(pool, timer_id, limit=capped, before=before)
    return {"firings": [timers.firing_spec(row) for row in rows]}


@router.post("/{timer_id}/pause")
async def pause_timer(
    timer_id: uuid.UUID,
    body: PauseBody | None = None,
    person: Person = Depends(identity.require_person),
) -> dict:
    pool = await db.get_pool()
    await _owned(pool, person, timer_id)
    # A missing reason takes the page's default; a reason that WAS sent is the
    # store's to judge (an empty one is refused there, in its words).
    reason = DEFAULT_PAUSE_REASON if body is None or body.reason is None else body.reason
    try:
        row = await timers.pause(pool, timer_id, reason=reason)
    except TimerRefused as exc:
        raise _refused(exc) from exc
    return await _timer_json(pool, row)


@router.post("/{timer_id}/resume")
async def resume_timer(
    timer_id: uuid.UUID, person: Person = Depends(identity.require_person)
) -> dict:
    pool = await db.get_pool()
    await _owned(pool, person, timer_id)
    try:
        row = await timers.resume(pool, timer_id)
    except TimerRefused as exc:
        raise _refused(exc) from exc
    return await _timer_json(pool, row)


@router.put("/{timer_id}/agent")
async def bind_timer_agent(
    timer_id: uuid.UUID,
    body: AgentBody,
    person: Person = Depends(identity.require_person),
) -> dict:
    """Who RUNS this scheduled timer: an agent by name, or null for Nova.
    The name is resolved against the agents table now (a 404 names what does
    exist); the kind rule and the write are the store's (timers.bind_agent),
    and the answer is the row it wrote, with the name read back."""
    pool = await db.get_pool()
    await _owned(pool, person, timer_id)
    agent_id = None
    if body.agent is not None:
        name = body.agent.strip()
        agent = await agents.by_name(pool, name)
        if agent is None:
            live = await agents.names(pool)
            listed = f"the agents are: {', '.join(live)}" if live else "there are no agents"
            raise HTTPException(status_code=404, detail=f"no agent named {name!r} — {listed}")
        agent_id = agent.id
    try:
        row = await timers.bind_agent(pool, person, timer_id, agent_id)
    except TimerRefused as exc:
        raise _refused(exc) from exc
    return await _timer_json(pool, row)


@router.post("/{timer_id}/fire")
async def fire_timer(
    timer_id: uuid.UUID,
    request: Request,
    person: Person = Depends(identity.require_person),
) -> dict:
    """ "Run now": the store makes the row due and runs ONE tick inline, so the
    run goes through the same claim and leaves the same firing row as any
    scheduled one — and that row, read back, is the answer. request.app is the
    FastAPI app a scheduled turn's seams (gateway, memory) hang off."""
    pool = await db.get_pool()
    await _owned(pool, person, timer_id)
    try:
        firing = await timers.fire_now(pool, timer_id, app=request.app)
    except TimerRefused as exc:
        raise _refused(exc) from exc
    return {"firing": timers.firing_spec(firing)}


@router.delete("/{timer_id}", status_code=204)
async def delete_timer(
    timer_id: uuid.UUID, person: Person = Depends(identity.require_person)
) -> Response:
    pool = await db.get_pool()
    await _owned(pool, person, timer_id)
    try:
        await timers.delete(pool, timer_id)
    except TimerRefused as exc:
        raise _refused(exc) from exc
    return Response(status_code=204)
