"""The turn ledger: what a turn did, written once, at the end.

A `turns` row opens when the work starts and carries status NULL until it
closes, so an abandoned turn reads as unfinished rather than as success.
Every span and the final status land in ONE transaction — a half-written
trace is worse than no trace, because it looks complete.

A NULL status on its own is NOT "still running". It is "no close_turn has
run yet", and a process that was SIGKILLed mid-turn never runs one — the
row it leaves behind would read as pending forever (measured 2026-09-01: a
redeploy killed core 10s into a 27B turn and the chat showed "still
responding" for a day). Two facts close that gap mechanically:

  * INFLIGHT is the set of turn ids THIS process is running right now —
    chat.py adds an id the moment open_turn returns and discards it after
    the close, on every exit path. Anything deriving "pending" reads this
    set, never the NULL alone.
  * sweep_orphaned_turns runs at startup, when INFLIGHT is empty by
    construction, and closes every leftover NULL row as 'interrupted' — so
    every turn reaches a terminal status even across process death.

DOING (S12) is the same lesson applied to "what is it doing right now": a
process-local map from turn id to the step in progress, written by
chat._run_turn for every turn it runs and gone with the process, so an
agent can never be reported busy by a row a dead process left behind.
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import asyncpg

logger = logging.getLogger("core")

VALID_STATUSES = ("ok", "error", "interrupted")

# Turn ids this process is actually running: added by chat.chat_stream right
# after open_turn, discarded in chat._run_turn's finally after the shielded
# close. Process-local on purpose — a set in memory dies with the process,
# which is exactly the liveness a database column cannot carry. Only the
# owner's chat turns are registered; an eval turn runs against a scratch
# person and must never feed the owner's pending flag. Correct only with ONE
# core process (no --workers, no replicas) — pinned in test_traces. This set
# answers "is the owner's chat still generating?" and nothing else — what any
# turn is doing right now, chat or not, is DOING below.
INFLIGHT: set[uuid.UUID] = set()

# What each turn this process is running is doing RIGHT NOW: 'starting',
# 'thinking' (a gateway round in progress), or the name of the tool being
# run. Written only by chat._run_turn, for EVERY turn it runs — chat,
# scheduled, eval, agent — and popped in its finally beside INFLIGHT.discard,
# on every exit path. It exists so the Agents page can say "coder is running
# web_search" from a fact rather than a guess, and it is process-local on
# purpose: a stored flag would lie the moment the process died (the row
# would still say 'thinking' a day later), while a map in memory cannot
# outlive the work it describes. A turn absent here is idle as far as this
# process knows; an open row with no DOING entry is an orphan for the sweep.
# Kept apart from INFLIGHT because that set has a narrower contract (only the
# owner's chat turns register, so pending_turn never lies for the chat page)
# and the scheduler never joins it — an agent-bound firing would read idle
# while working. One core process, same as INFLIGHT.
DOING: dict[uuid.UUID, str] = {}


def doing(turn_id: uuid.UUID) -> str | None:
    """What the turn is doing now, or None when this process is not running it."""
    return DOING.get(turn_id)


def set_doing(turn_id: uuid.UUID, what: str) -> None:
    """Record the step a running turn just entered (overwrites the previous one)."""
    DOING[turn_id] = what


def clear_doing(turn_id: uuid.UUID) -> None:
    """Forget the turn; a no-op for an id never recorded, so every exit path
    can call it without first asking whether the turn got as far as 'starting'."""
    DOING.pop(turn_id, None)


@dataclass
class Span:
    kind: str
    name: str | None
    started_at: datetime
    duration_ms: int
    meta: dict[str, Any] = field(default_factory=dict)


class SpanRecorder:
    """Times a block and files the span on the turn, exception or not."""

    def __init__(self, turn: Turn, kind: str, name: str | None) -> None:
        self._turn = turn
        self._kind = kind
        self._name = name
        self.meta: dict[str, Any] = {}

    def __enter__(self) -> SpanRecorder:
        self._started_at = datetime.now(UTC)
        self._t0 = time.perf_counter()
        return self

    def __exit__(self, *exc_info) -> bool:
        self._turn.spans.append(
            Span(
                kind=self._kind,
                name=self._name,
                started_at=self._started_at,
                duration_ms=int((time.perf_counter() - self._t0) * 1000),
                meta=self.meta,
            )
        )
        return False


@dataclass
class Turn:
    id: uuid.UUID
    started_at: datetime
    conversation_id: uuid.UUID | None = None
    model: str | None = None
    # S10: who the turn ran for (attributed to every gateway call) and the
    # owner's zone (so the gateway's monthly cap resets on THEIR first).
    person_id: uuid.UUID | None = None
    timezone: str = "UTC"
    kind: str = "chat"
    # S12: WHO did the work (None = Nova herself) and the routing role its
    # gateway rounds walked (None = derived from kind, as before). person_id
    # above stays the owner the work is FOR — his money, his Activity page.
    agent_id: uuid.UUID | None = None
    role: str | None = None
    spans: list[Span] = field(default_factory=list)

    def span(self, kind: str, name: str | None = None) -> SpanRecorder:
        return SpanRecorder(self, kind, name)


async def open_turn(
    pool: asyncpg.Pool,
    *,
    kind: str = "chat",
    conversation_id: uuid.UUID | None = None,
    model: str | None = None,
    person_id: uuid.UUID | None = None,
    timezone: str = "UTC",
    agent_id: uuid.UUID | None = None,
    role: str | None = None,
) -> Turn:
    # An agent_id naming no agents row is refused by the foreign key, never
    # stored as a dangling reference — the caller learns the agent is gone
    # before the turn exists rather than after it has spent money.
    row = await pool.fetchrow(
        "INSERT INTO turns (kind, conversation_id, model, person_id, agent_id, role) "
        "VALUES ($1, $2, $3, $4, $5, $6) "
        "RETURNING id, started_at, agent_id, role",
        kind,
        conversation_id,
        model,
        person_id,
        agent_id,
        role,
    )
    return Turn(
        id=row["id"],
        started_at=row["started_at"],
        conversation_id=conversation_id,
        model=model,
        person_id=person_id,
        timezone=timezone,
        kind=kind,
        # Read back from the row rather than echoed from the arguments, so the
        # Turn carries what the ledger actually holds.
        agent_id=row["agent_id"],
        role=row["role"],
    )


async def close_turn(pool: asyncpg.Pool, turn: Turn, status: str) -> None:
    """All the spans and the final status, in one transaction or not at all.

    Deliberately leaves DOING alone. The scheduler closes reminder and job
    turns here without ever running chat._run_turn (nothing set DOING for
    them), and chat spawns this close detached and shielded — it can fail
    and be logged while the turn still ends. The one place that always runs
    on every exit of a turn chat ran is _run_turn's finally, so that is the
    one writer that pops DOING, beside INFLIGHT.discard.
    """
    if status not in VALID_STATUSES:
        raise ValueError(f"turn status must be one of {VALID_STATUSES}, got {status!r}")
    async with pool.acquire() as conn, conn.transaction():
        for span in turn.spans:
            await conn.execute(
                "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
                "VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
                turn.id,
                span.kind,
                span.name,
                span.started_at,
                span.duration_ms,
                span.meta,
            )
        await conn.execute(
            "UPDATE turns SET status = $2, ended_at = now() WHERE id = $1", turn.id, status
        )


async def sweep_orphaned_turns(pool: asyncpg.Pool) -> list[uuid.UUID]:
    """Close every turn no process is running as 'interrupted'; return the ids.

    Called at startup (app/main.py's lifespan), when INFLIGHT is empty by
    construction: a fresh process has opened nothing yet, so every NULL row is
    an orphan of the process that died. The exclusion of INFLIGHT is still
    written into the query rather than assumed — a caller that ever runs this
    while turns are live must not kill them — and it is derived from the live
    set, never a list someone maintains. Idempotent: a second call finds
    nothing and returns [].

    Every swept id is logged at WARNING with what was known about it. A turn
    that died mid-flight is a fact the operator should see in the logs, not
    only in Activity — silently tidying it would hide the redeploy that cut
    it off.
    """
    rows = await pool.fetch(
        "UPDATE turns SET status = 'interrupted', ended_at = now() "
        "WHERE status IS NULL AND NOT (id = ANY($1::uuid[])) "
        "RETURNING id, kind, conversation_id, started_at",
        list(INFLIGHT),
    )
    for row in rows:
        logger.warning(
            "orphaned %s turn %s (conversation %s, started %s) closed as interrupted — "
            "no process was running it",
            row["kind"],
            row["id"],
            row["conversation_id"],
            row["started_at"].isoformat(),
        )
    return [row["id"] for row in rows]
