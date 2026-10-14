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

# How much of a tool call's result lands in its span (result_head, error). The
# Activity page's evidence that the call did what it says. Owned here, not in
# chat, because chat imports live_facts and live_facts records spans too: one
# number both read, so a backend-run check reads identically in the trace to
# the call she made (S29 T7; tests/test_live_facts.py t7).
SPAN_RESULT_HEAD_CHARS = 500

# 'stopped' (S15) is deliberately NOT 'interrupted'. Interrupted means no
# process was running the turn — the startup sweep's word, and the scheduler
# attaches behaviour to it ("the process stopped, the timer did nothing
# wrong"). Someone pressing Stop is the opposite: a process was running it and
# was told to quit. Activity has to be able to tell a redeploy from a button.
VALID_STATUSES = ("ok", "error", "interrupted", "stopped")

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


# Turns someone has asked to stop, and the sentence saying who asked and why
# (S15). Process-local for exactly INFLIGHT's reason: a stop is a fact about
# work happening in THIS process, and a stored flag would still read "stopping"
# a day after the process running it died. Written by the stop route, read by
# the turn itself at the points where it can act on it, popped in
# chat._run_turn's finally beside INFLIGHT.discard and clear_doing.
#
# Derived from INFLIGHT, never a wish anyone can record: a stop for a turn no
# process here is running could not take effect, because nothing would read
# the flag — so ask_to_stop REFUSES rather than accepting and dropping it.
# That also scopes Stop to the owner's chat turns, which is the only kind
# anyone is watching: a scheduler firing's bound and a delegation's parent are
# not people pressing a button and must never be reported as one.
STOPPING: dict[uuid.UUID, str] = {}


def ask_to_stop(turn_id: uuid.UUID, reason: str) -> bool:
    """Record that this turn should stop. False when nothing here is running it.

    A second ask keeps the FIRST reason: the turn is already stopping and the
    second press is not what caused it.
    """
    if turn_id not in INFLIGHT:
        return False
    STOPPING.setdefault(turn_id, reason)
    return True


def stop_requested(turn_id: uuid.UUID) -> str | None:
    """The stated reason this turn should stop, or None to carry on."""
    return STOPPING.get(turn_id)


def clear_stop(turn_id: uuid.UUID) -> None:
    """Forget the ask; a no-op for an id never recorded, like clear_doing."""
    STOPPING.pop(turn_id, None)


@dataclass
class Span:
    kind: str
    name: str | None
    started_at: datetime
    duration_ms: int
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class Action:
    """One call of a tool that CHANGES something (not reads_only) whose
    executor was reached — the action ledger's row before close_turn files it
    into turn_actions (chat-rewind). `undo` is the payload the executor
    appended to ToolContext.undo_sink during this call, or None when it
    appended nothing — and a call with no payload can never be claimed
    reverted. Order on Turn.actions is call order; close_turn numbers it."""

    tool: str
    ok: bool
    undo: Any = None


@dataclass
class ToolResult:
    """One tool result she was sent, in full (S38b). `ref` is the turn's own
    handle for it — r1, r2, ... in call order — the one a summary marker names
    and read_result takes. close_turn files it into tool_results."""

    ref: str
    tool_call_id: str | None
    tool: str
    content: str

    @property
    def chars(self) -> int:
        return len(self.content)


# The full results of each turn chat._run_turn is running right now (S38b):
# turn id -> that Turn's OWN tool_results list, so a result is readable here
# the instant _run_tool keeps it — before any row exists, since close_turn
# writes the rows only when the turn ends. Registered by _run_turn
# (track_results, beside set_doing 'starting') and popped in its finally
# beside clear_doing, on every exit path. A turn _run_turn never ran (the
# scheduler's and delivery's direct _run_tool calls) keeps its results on the
# Turn and in the rows, but never enters this map — nothing would pop it.
# Process-local for DOING's reason: one core process.
RESULTS: dict[uuid.UUID, list[ToolResult]] = {}


def keep_result(turn: Turn, tool_call_id: str | None, tool: str, content: str) -> ToolResult:
    """Keep one result on the turn, numbered next in call order. Synchronous on
    purpose: it is called inside chat._run_tool, where no await may join the
    funnel (test_no_approvals pins the awaits); the database sees it only in
    close_turn's one transaction, like turn.actions."""
    kept = ToolResult(
        ref=f"r{len(turn.tool_results) + 1}",
        tool_call_id=tool_call_id,
        tool=tool,
        content=content,
    )
    turn.tool_results.append(kept)
    return kept


def track_results(turn: Turn) -> None:
    """Make this turn's results readable by turn id while it runs."""
    RESULTS[turn.id] = turn.tool_results


def results_of(turn_id: uuid.UUID) -> list[ToolResult] | None:
    """The running turn's kept results, or None when this process is not
    running it through chat (never a guess from the database)."""
    return RESULTS.get(turn_id)


def clear_results(turn_id: uuid.UUID) -> None:
    """Forget the turn's live results; a no-op for an id never tracked."""
    RESULTS.pop(turn_id, None)


# postgres `text` refuses a NUL byte, and one result carrying it (a binary
# file read as text) must not fail the whole close — that would lose the
# turn's spans and status with it. Replaced one-for-one, so `chars` holds.
_NUL = "\x00"
_NUL_STANDIN = "\ufffd"


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
    # epic hub-last-resort: the owner's switch (routing.hub_last_resort), read
    # ONCE when the turn opens — open_turn holds the database — and stated on
    # every role-carrying gateway call the turn makes. A round never reads the
    # database for it; a Turn built without it is off, today's headers.
    hub_last_resort: bool = False
    spans: list[Span] = field(default_factory=list)
    # chat-rewind: the action ledger, appended synchronously by chat._run_tool
    # and chat._run_script_step, written by close_turn beside the spans.
    actions: list[Action] = field(default_factory=list)
    tool_results: list[ToolResult] = field(default_factory=list)
    # S38b T3: the summaries written this turn, by tool_call_id (each result
    # at most once; a later round sends the same one again), and the results
    # whose summary failed, with why (not retried this turn). In memory only:
    # what was sent is on the round spans, the full text in tool_results.
    summaries: dict[str, Any] = field(default_factory=dict)
    summary_failures: dict[str, str] = field(default_factory=dict)

    def span(self, kind: str, name: str | None = None) -> SpanRecorder:
        return SpanRecorder(self, kind, name)


def purpose_of(turn: Turn) -> str:
    """What the ledger records a turn's own gateway calls as: its kind. One
    reader for chat's rounds and the decision role's calls (decisions.py), so
    the two are always metered under the same purpose — a copy in each would
    drift."""
    kind = getattr(turn, "kind", None)
    return kind if isinstance(kind, str) and kind else "chat"


async def open_turn(
    # A Pool or a Connection: S15 opens the turn inside the caller's
    # transaction, so the claim on the queued message it answers and the turn
    # row itself commit together — the queued table's CHECK requires that, and
    # a claim naming no turn would read as a message that was sent. Both types
    # answer fetchrow the same way; nothing here needs more.
    pool: asyncpg.Pool | asyncpg.Connection,
    *,
    kind: str = "chat",
    conversation_id: uuid.UUID | None = None,
    model: str | None = None,
    person_id: uuid.UUID | None = None,
    timezone: str = "UTC",
    agent_id: uuid.UUID | None = None,
    role: str | None = None,
) -> Turn:
    from app import settings_store

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
        # Read now, per turn: a Settings write moves the next turn, no restart.
        hub_last_resort=await settings_store.hub_last_resort(pool),
    )


def _without_nul(value: Any) -> Any:
    """`value` with every NUL in every string (keys too, at any depth) swapped
    for U+FFFD. Postgres refuses \\u0000 in jsonb, so one NUL a tool printed
    into a span's result_head used to fail close_turn's whole transaction —
    no spans and no status, for a turn that ran fine. Scrubbed here, at the
    persist boundary, rather than in each writer of span meta: a writer added
    tomorrow is covered without remembering to be."""
    if isinstance(value, str):
        return value.replace("\x00", "\ufffd")
    if isinstance(value, dict):
        return {_without_nul(k): _without_nul(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_without_nul(v) for v in value]
    return value


def _holds_nul(value: Any) -> bool:
    """Whether any string in `value` (keys too, at any depth) holds a NUL."""
    if isinstance(value, str):
        return "\x00" in value
    if isinstance(value, dict):
        return any(_holds_nul(k) or _holds_nul(v) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return any(_holds_nul(v) for v in value)
    return False


def _storable_undo(turn: Turn, action: Action) -> Any:
    """The action's undo payload, or None when jsonb would refuse it. Never
    scrubbed like span meta: an undo payload is what a revert puts back, and a
    NUL swapped for U+FFFD would restore something else and call it undone.
    Dropped instead, the way an oversized prior is never captured — the row
    still lands, and rewind reads None as "recorded nothing to put back"."""
    if not _holds_nul(action.undo):
        return action.undo
    logger.warning(
        "turn %s: %s's undo payload holds a NUL byte jsonb cannot store; "
        "recorded without one, so a rewind lists it as not undone",
        turn.id,
        action.tool,
    )
    return None


async def close_turn(pool: asyncpg.Pool, turn: Turn, status: str) -> None:
    """All the spans, the kept tool results (S38b), the action ledger and the
    final status, in one transaction or not at all — a turn that never closed has neither spans
    nor turn_actions rows, so a rewind can name it as unrecorded rather than
    trust a half-written ledger.

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
                _without_nul(span.meta),
            )
        for kept in turn.tool_results:
            content = kept.content.replace(_NUL, _NUL_STANDIN)
            await conn.execute(
                "INSERT INTO tool_results (turn_id, ref, tool_call_id, tool, content, chars) "
                "VALUES ($1, $2, $3, $4, $5, $6)",
                turn.id,
                kept.ref,
                kept.tool_call_id,
                kept.tool,
                content,
                len(content),
            )
        for seq, action in enumerate(turn.actions):
            await conn.execute(
                "INSERT INTO turn_actions (turn_id, conversation_id, seq, tool, ok, undo) "
                "VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
                turn.id,
                turn.conversation_id,
                seq,
                action.tool,
                action.ok,
                _storable_undo(turn, action),
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
