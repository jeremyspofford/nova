"""GET /api/v1/activity — the operator's read-only window into the turn
ledger written by traces.py (see chat.py's `_run_turn`, which is the only
writer). Nothing here writes: the ledger is append-by-the-turn-path only,
and this module exists to read it back, verbatim, never guessed at.

A turn's `status` stays NULL until traces.close_turn() runs, so a turn still
in flight (or one a crashed process left behind) is NULL here — this module
must never turn that NULL into "ok" or "error", because the whole point of
the ledger is that an unfinished turn looks unfinished. (Since S2c a client
disconnect no longer abandons a turn: it finishes server-side and closes
'ok', so a lingering NULL means genuinely still-running, not walked-away.)

Cursor pagination orders newest-first by (started_at, id), not started_at
alone: two turns can share a started_at value (same millisecond, or a test
that pins it explicitly), and ordering by started_at alone would either
skip or repeat whichever of them landed on a page boundary. id is not
meaningful on its own — UUIDs are random — so it is only ever a tiebreaker
alongside started_at, never a substitute for it.
"""

from __future__ import annotations

import uuid

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query

from app import db, identity
from app.identity import Person

router = APIRouter(prefix="/api/v1/activity", tags=["activity"])

DEFAULT_LIMIT = 50
MAX_LIMIT = 200

# Every read in this module starts from this projection: the turn's own
# columns, plus its span counts. Each count is a scalar subquery
# CORRELATED on t.id — scoped to exactly the turn(s) this query actually
# returns — rather than a GROUP BY over the whole turn_spans table joined
# in: the list query only ever returns up to MAX_LIMIT rows (bounded by
# `turns_started_at_id`, migration 003) and the drill-in returns exactly
# one, so a global aggregate would do wildly more work than either needs,
# and would only get more wasteful as turn_spans grows. turn_spans_turn
# (turn_id, started_at) — migration 002 — is what makes each lookup an
# indexed scan rather than a table scan.
#
# S12: the agents join. `agent` is the NAME read off the agents row the
# turn's agent_id points at — derived on every read, never a name stored on
# the turn — so a deleted agent's turns come back with agent null (021 SETs
# agent_id NULL) while `role`, the routing role the rounds actually walked,
# stays as the turn recorded it. NULL role = Nova's own turn, routed by kind.
_TURN_SELECT = """
    SELECT
        t.id, t.kind, t.model, t.status, t.started_at, t.conversation_id, t.person_id,
        t.role, a.name AS agent,
        CASE WHEN t.ended_at IS NULL THEN NULL
             ELSE (EXTRACT(EPOCH FROM (t.ended_at - t.started_at)) * 1000)::bigint
        END AS duration_ms,
        COALESCE(
            (SELECT count(*) FILTER (WHERE kind = 'tool')
             FROM turn_spans WHERE turn_id = t.id), 0
        ) AS tool_call_count,
        COALESCE(
            (SELECT count(*) FILTER (WHERE kind = 'llm_call')
             FROM turn_spans WHERE turn_id = t.id), 0
        ) AS llm_round_count
    FROM turns t
    LEFT JOIN agents a ON a.id = t.agent_id
"""


def _turn_json(row: asyncpg.Record) -> dict:
    return {
        "id": str(row["id"]),
        "kind": row["kind"],
        "model": row["model"],
        "person_id": str(row["person_id"]) if row["person_id"] else None,
        # NULL passes straight through as JSON null. Coercing it to "ok" or
        # "error" here would be exactly the guess the ledger exists to
        # avoid — see the module docstring.
        "status": row["status"],
        "started_at": row["started_at"].isoformat(),
        "duration_ms": row["duration_ms"],
        "tool_call_count": row["tool_call_count"],
        "llm_round_count": row["llm_round_count"],
        "conversation_id": str(row["conversation_id"]) if row["conversation_id"] else None,
        # S12: WHO did the work (an agent's name, null for Nova herself or a
        # since-deleted agent — see _TURN_SELECT) and which routing role its
        # gateway rounds walked (null = derived from kind, as before).
        "agent": row["agent"],
        "role": row["role"],
    }


def _span_json(row: asyncpg.Record) -> dict:
    return {
        "kind": row["kind"],
        "name": row["name"],
        "started_at": row["started_at"].isoformat(),
        "duration_ms": row["duration_ms"],
        # asyncpg decodes jsonb to native python (see db.py's type codec),
        # so meta — including the polymorphic args_redacted inside it,
        # object or clipped string — reaches the client exactly as stored.
        "meta": row["meta"],
    }


@router.get("")
async def list_activity(
    limit: int = Query(DEFAULT_LIMIT, ge=1),
    before: uuid.UUID | None = None,
    agent: str | None = None,
    # Unused beyond the dependency itself: this view answers "what did
    # Nova do", not "what did I do", and is not scoped by who is asking —
    # requiring a Person here is only the same auth every other route has.
    _person: Person = Depends(identity.require_person),
) -> dict:
    pool = await db.get_pool()
    capped = min(limit, MAX_LIMIT)

    # kind='eval' turns are the evals harness replaying a case against a model
    # (app/evals/runner.py); they are NOT something "Nova did" for the operator,
    # so they are filtered out of this feed. They are the ONLY kind filtered:
    # an agent's turn (kind 'agent', S12) is work done for the operator and is
    # listed, badged by the agents join. The drill-in below is deliberately
    # NOT filtered — an eval_runs row links to its turn's trace, and T3 needs
    # /activity/<id> to resolve for it.
    conditions = ["t.kind <> 'eval'"]
    params: list = []

    if agent is not None:
        # S12: one agent's turns, matched on the agents row's name through
        # the join — so a name no agent holds (a typo, or an agent deleted
        # since, whose turns lost their agent_id) matches nothing and comes
        # back as an EMPTY list, not a 404: "this agent has done nothing yet"
        # is a true answer for a fresh agent's Traces tab, where a 404 would
        # read as a broken page. A blank name is a name no agent can hold
        # (021's CHECK) and is filtered the same way, never widened to all.
        params.append(agent)
        conditions.append(f"a.name = ${len(params)}")

    if before is not None:
        cursor = await pool.fetchrow("SELECT started_at FROM turns WHERE id = $1", before)
        if cursor is None:
            # A stale or invented cursor gets a clear refusal, never a silent
            # "here is the whole list from the top" — that would look like a
            # cursor working when it did not.
            raise HTTPException(status_code=404, detail=f"no turn {before} to page before")
        params.extend([cursor["started_at"], before])
        conditions.append(f"(t.started_at, t.id) < (${len(params) - 1}, ${len(params)})")

    params.append(capped)
    rows = await pool.fetch(
        f"{_TURN_SELECT} WHERE {' AND '.join(conditions)} "
        f"ORDER BY t.started_at DESC, t.id DESC LIMIT ${len(params)}",
        *params,
    )
    return {"turns": [_turn_json(row) for row in rows]}


@router.get("/{turn_id}")
async def get_activity(
    turn_id: uuid.UUID, _person: Person = Depends(identity.require_person)
) -> dict:
    pool = await db.get_pool()
    turn_row = await pool.fetchrow(f"{_TURN_SELECT} WHERE t.id = $1", turn_id)
    if turn_row is None:
        raise HTTPException(status_code=404, detail=f"no turn {turn_id} here")

    span_rows = await pool.fetch(
        "SELECT kind, name, started_at, duration_ms, meta FROM turn_spans "
        "WHERE turn_id = $1 ORDER BY started_at",
        turn_id,
    )
    return {
        "turn": _turn_json(turn_row),
        "spans": [_span_json(row) for row in span_rows],
    }
