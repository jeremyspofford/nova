"""Conversations and their messages — scoped to the person who owns them."""

from __future__ import annotations

import logging
import uuid

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

from app import db, identity, queued, traces
from app.identity import Person

router = APIRouter(prefix="/api/v1/conversations", tags=["conversations"])
logger = logging.getLogger("core")


def as_json(row: asyncpg.Record) -> dict:
    return {
        "id": str(row["id"]),
        "title": row["title"],
        "created_at": row["created_at"].isoformat(),
    }


async def conversation_busy(
    # A Pool or the caller's Connection: the queue gate asks this INSIDE the
    # transaction that holds the conversation's advisory lock, so the answer is
    # still true when it is acted on.
    pool: asyncpg.Pool | asyncpg.Connection,
    conversation_id: uuid.UUID,
) -> bool:
    """Is ANY turn for this conversation running in this process right now?

    The gate the queue is built on (S15), and deliberately WIDER than
    `has_pending_turn`'s reading of INFLIGHT. INFLIGHT holds only the owner's
    chat turns — its own docstring says so, and the scheduler never joins it —
    but a timer firing runs a turn in the owner's own conversation through the
    same loop. A gate that read only INFLIGHT would let a typed message
    interleave with a scheduled turn, which is precisely the defect the gate
    exists to stop.

    So it reads `traces.DOING` too: that map is written by `_run_turn` for EVERY
    turn it runs — chat, scheduled, beat, eval, agent — which makes this derived
    from the live work rather than from a set someone remembered to join.
    """
    rows = await pool.fetch(
        "SELECT id FROM turns WHERE conversation_id = $1 AND status IS NULL", conversation_id
    )
    return any(row["id"] in traces.INFLIGHT or row["id"] in traces.DOING for row in rows)


async def pending_turn_id(pool: asyncpg.Pool, conversation_id: uuid.UUID) -> uuid.UUID | None:
    """WHICH turn of this conversation is running here, if any (S15).

    The same two live facts `has_pending_turn` derives its boolean from, kept as
    the id — because the tab that most needs to stop a turn is the one that
    RELOADED into it, and such a tab never saw the meta frame that would have
    told it the turn's id. Without this it can show "still responding" over a
    turn it cannot reach, which is the ten-hour hang of 2026-09-10 exactly.

    The newest such row wins if there were somehow two; there should never be.
    """
    rows = await pool.fetch(
        "SELECT id FROM turns WHERE conversation_id = $1 AND status IS NULL "
        "ORDER BY started_at DESC",
        conversation_id,
    )
    for row in rows:
        if row["id"] in traces.INFLIGHT:
            return row["id"]
    return None


async def has_pending_turn(pool: asyncpg.Pool, conversation_id: uuid.UUID) -> bool:
    """Is a turn for this conversation running in THIS process right now?

    Derived from two live facts, never a flag someone maintains: the ledger
    (a turn opens with status NULL and closes in traces.close_turn) AND the
    process's own traces.INFLIGHT set. A NULL row alone is not enough — a
    process killed mid-turn never runs close_turn, and the row it leaves
    behind would otherwise read as "still responding" forever (the 2026-09-01
    defect: one such row, one day of a spinner over nothing). Since S2c a
    client disconnect finishes the turn server-side rather than abandoning
    it, so a NULL row that IS in INFLIGHT means genuinely still-generating —
    exactly what a reloaded client polls on before rendering the reply.

    A NULL row this process is running NEITHER as a chat turn (INFLIGHT) nor as
    any other kind (traces.DOING) is never reported pending. It should not exist
    at all — the startup sweep (traces.sweep_orphaned_turns) closes every
    orphan before the first request — so one here is a tripwire: logged at
    WARNING, because it means the sweep was bypassed, not that a turn is
    running. DOING joined that test in S15: a timer firing's turn lives in the
    owner's conversation and never joins INFLIGHT, so it used to be warned about
    on every poll as though it were an orphan.

    S15 also widened what "pending" means by one fact: an accepted-but-unsent
    QUEUED message. An answer is just as much still coming for one of those, and
    a reloaded tab polls on this flag — if it cleared in the gap between a turn
    closing and the drain opening the next one, that tab would stop polling and
    the queued reply would never appear.
    """
    rows = await pool.fetch(
        "SELECT id, started_at FROM turns WHERE conversation_id = $1 AND status IS NULL",
        conversation_id,
    )
    pending = False
    for row in rows:
        if row["id"] in traces.INFLIGHT or row["id"] in traces.DOING:
            pending = True
            continue
        logger.warning(
            "turn %s (conversation %s, started %s) has status NULL but no process is running "
            "it — not reported pending; either its close failed in this process "
            "(see 'could not close turn') or the startup sweep was bypassed",
            row["id"],
            conversation_id,
            row["started_at"].isoformat(),
        )
    return pending or await queued.any_waiting(pool, conversation_id)


async def active_conversation(pool: asyncpg.Pool, person: Person) -> asyncpg.Record:
    """The person's active conversation, created on first ask."""
    row = await pool.fetchrow(
        "SELECT id, title, created_at FROM conversations "
        "WHERE person_id = $1 AND active ORDER BY created_at DESC LIMIT 1",
        person.id,
    )
    if row is not None:
        return row
    return await pool.fetchrow(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id, title, created_at",
        person.id,
    )


async def owned_conversation(
    pool: asyncpg.Pool, person: Person, conversation_id: uuid.UUID
) -> asyncpg.Record:
    """That conversation, or a 404 — someone else's is not found, not forbidden."""
    row = await pool.fetchrow(
        "SELECT id, title, created_at FROM conversations WHERE id = $1 AND person_id = $2",
        conversation_id,
        person.id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail=f"no conversation {conversation_id} here")
    return row


async def resolve(
    pool: asyncpg.Pool, person: Person, conversation_id: uuid.UUID | None
) -> asyncpg.Record:
    """A named conversation must be the requester's; otherwise the active one."""
    if conversation_id is not None:
        return await owned_conversation(pool, person, conversation_id)
    return await active_conversation(pool, person)


@router.get("/active")
async def get_active(person: Person = Depends(identity.require_person)) -> dict:
    pool = await db.get_pool()
    conversation = await active_conversation(pool, person)
    return {
        **as_json(conversation),
        # So a client returning after a hard refresh knows a turn is still
        # finishing server-side and should poll for it, rather than showing a
        # truncated reply (S2c). A just-created conversation has none.
        "pending_turn": await has_pending_turn(pool, conversation["id"]),
        # And which one (S15), so that same reloaded client can STOP it. Both
        # are derived from the same two facts; the boolean stays because every
        # existing reader reads it.
        "pending_turn_id": _or_none(await pending_turn_id(pool, conversation["id"])),
        # The messages core has ACCEPTED and not yet answered (S15), oldest
        # first — so a tab that reloaded still shows what it queued, rather than
        # appearing to have lost it.
        "queued": [
            queued.as_json(row, ahead=i)
            for i, row in enumerate(await queued.waiting(pool, conversation["id"]))
        ],
    }


def _or_none(value: uuid.UUID | None) -> str | None:
    return None if value is None else str(value)


def _delegation_json(span: dict) -> dict:
    """One delegate_to_agent span -> {agent, agent_turn_id, status, files}.

    The delegate tool appends ONE facts dict to the turn's facts sink before it
    decides ok, so meta.facts[0] is the run's own verified record — agent,
    child turn id, status read back from the ledger, files derived from the
    child's write spans — on success AND on failure. A delegate span with NO
    facts is a call that never got as far as composing its result (a refused
    argument, a crash before the child turn opened): the one thing it still
    knows is who it was aimed at (args_redacted.agent), and its status is
    'error' — never an 'ok' guessed from silence, and never dropped, or a
    failed hand-off would vanish from the transcript on reload.
    """
    facts = span.get("facts")
    fact = facts[0] if isinstance(facts, list) and facts and isinstance(facts[0], dict) else None
    # args_redacted is polymorphic: an object normally, a clipped STRING when
    # the model's arguments were oversized or unparseable (activity.py pins
    # both shapes) — a string names no agent.
    args = span.get("args")
    aimed_at = args.get("agent") if isinstance(args, dict) else None
    if not isinstance(aimed_at, str):
        aimed_at = None
    if fact is None:
        return {"agent": aimed_at, "agent_turn_id": None, "status": "error", "files": []}
    files = fact.get("files")
    return {
        "agent": fact.get("agent") or aimed_at,
        "agent_turn_id": fact.get("agent_turn_id"),
        # A facts dict without a status is a result that was never composed,
        # the same silence as no facts at all.
        "status": fact.get("status") or "error",
        "files": [str(f) for f in files] if isinstance(files, list) else [],
    }


async def messages_json(pool: asyncpg.Pool, conversation_id: uuid.UUID) -> list[dict]:
    """The rows of ONE conversation, oldest first, as the chat page renders
    them. No ownership check here — the caller scopes: get_messages proves the
    requester owns the conversation first, and the agents API reads an agent's
    log conversation through this (agents are household objects, so that read
    is not person-scoped, like Activity).

    Everything beyond the row's own columns is derived from the TRACE behind
    it, never from a stored label that could drift:
    `served_by` is read off the turn's llm_call span (the gateway's own
    X-Nova-Served-By, `provider:model`). NULL for user rows, for rows older
    than migration 018, and for a turn whose gateway call never got far enough
    to state one.
    `turn_kind` is the same derivation one join shorter: turns.kind via
    messages.turn_id, so the chat page's "Reminder" / "Scheduled" label on an
    assistant row comes from the turn that wrote it (S9). NULL for a row with
    no turn.
    `agent` (S12) is one join further: the agents row the turn's agent_id
    points at, so an assistant row written by an agent's own turn carries its
    name. None for a user row (it has no turn), for Nova's own turns
    (agent_id NULL), and for a deleted agent's turns (agent_id SET NULL by
    021 — the row keeps its role text in Activity, the transcript loses the
    name rather than inventing one).
    `delegations` (S12) is one entry per delegate_to_agent tool span on the
    row's turn, so a reload can re-draw the chip for each agent Nova handed
    work to in that turn — see _delegation_json for what each entry says.
    """
    # Function-local: app.agents imports app.tools, whose timers module
    # imports this module at top level — the same one-way idiom
    # tools/timers.py uses to reach agents.
    from app import agents

    rows = await pool.fetch(
        "SELECT m.id, m.role, m.content, m.created_at, t.kind AS turn_kind, a.name AS agent, "
        "  (SELECT s.meta->>'served_by' FROM turn_spans s "
        "    WHERE s.turn_id = m.turn_id AND s.kind = 'llm_call' AND s.meta ? 'served_by' "
        "    ORDER BY s.started_at DESC LIMIT 1) AS served_by, "
        "  (SELECT SUM((s.meta->>'cost_usd')::numeric) FROM turn_spans s "
        "    WHERE s.turn_id = m.turn_id AND s.kind = 'llm_call' "
        "    AND s.meta->>'cost_usd' IS NOT NULL) AS cost_usd, "
        "  (SELECT s.meta->>'route_reason' FROM turn_spans s "
        "    WHERE s.turn_id = m.turn_id AND s.kind = 'llm_call' AND s.meta ? 'route_reason' "
        "    ORDER BY s.started_at DESC LIMIT 1) AS route_reason, "
        # Every delegate span on the turn, in the order they ran, carrying just
        # the two meta keys the entry is derived from. jsonb crosses the wire
        # as python objects (db.py's codec), so this lands as a list of dicts.
        "  (SELECT COALESCE(jsonb_agg(jsonb_build_object("
        "      'facts', s.meta->'facts', 'args', s.meta->'args_redacted') "
        "    ORDER BY s.started_at, s.id), '[]'::jsonb) FROM turn_spans s "
        "    WHERE s.turn_id = m.turn_id AND s.kind = 'tool' AND s.name = $2) AS delegate_spans "
        "FROM messages m LEFT JOIN turns t ON t.id = m.turn_id "
        "LEFT JOIN agents a ON a.id = t.agent_id "
        "WHERE m.conversation_id = $1 ORDER BY m.created_at, m.id",
        conversation_id,
        agents.DELEGATE_TOOL,
    )
    return [
        {
            "id": str(row["id"]),
            "role": row["role"],
            "content": row["content"],
            "created_at": row["created_at"].isoformat(),
            "served_by": row["served_by"],
            "turn_kind": row["turn_kind"],
            # S10: the turn's cost summed from its llm_call spans — the
            # gateway's ledger figures, never a stored claim. NULL when
            # no round was priced.
            "cost_usd": float(row["cost_usd"]) if row["cost_usd"] is not None else None,
            # S10-2: the gateway's stated reason when this turn's answer
            # came from a fallback link; null when link 1 served.
            "route_reason": row["route_reason"],
            "agent": row["agent"],
            "delegations": [_delegation_json(span) for span in row["delegate_spans"]],
        }
        for row in rows
    ]


@router.get("/{conversation_id}/messages")
async def get_messages(
    conversation_id: uuid.UUID, person: Person = Depends(identity.require_person)
) -> dict:
    pool = await db.get_pool()
    await owned_conversation(pool, person, conversation_id)
    return {"messages": await messages_json(pool, conversation_id)}


async def clear_messages(pool: asyncpg.Pool, conversation_id: uuid.UUID) -> int:
    """Delete this conversation's transcript rows, and ONLY those.

    "Clear chat" clears the transcript the operator sees and the model's
    history_window source (chat.py reads `messages` for the next turn's
    context) — nothing else. turns/turn_spans and the governance ledger are the
    AUDIT trail and stay untouched (Activity keeps its history; the conversation
    row itself survives, so turns' conversation_id is not even nulled). Durable
    memory lives in a separate service and is not reached from here. Returns the
    number of rows removed, parsed from the command tag, so the caller reports a
    real count rather than an unchecked "ok"."""
    tag = await pool.execute("DELETE FROM messages WHERE conversation_id = $1", conversation_id)
    # asyncpg returns a command tag like "DELETE 3"; the trailing field is the
    # row count. A malformed tag is a real failure, not a silent zero.
    return int(tag.rsplit(" ", 1)[1])


@router.post("/{conversation_id}/clear")
async def clear_conversation(
    conversation_id: uuid.UUID, person: Person = Depends(identity.require_person)
) -> dict:
    """Clear the CURRENT conversation's messages. require_person + ownership:
    someone else's conversation is a 404 (owned_conversation), never touched.
    Deletes rows in `messages` only — see clear_messages on what is deliberately
    left intact (audit + memory)."""
    pool = await db.get_pool()
    await owned_conversation(pool, person, conversation_id)
    cleared = await clear_messages(pool, conversation_id)
    return {"id": str(conversation_id), "cleared": cleared}
