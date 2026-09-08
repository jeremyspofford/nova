"""The tick: claim due timers, run each firing as a traced turn, record it.

`tick_once` does its claim in ONE short transaction — `SELECT ... FOR UPDATE
SKIP LOCKED` over due, unpaused rows; per row INSERT the `running` firing and
UPDATE the timer's next_fire_at — and COMMITs before any firing runs. The claim
IS the exactly-once guarantee: two ticks (in one process or in N) on one due
row produce ONE firing, because the second either skips the locked row or,
after the commit, no longer finds it due. Running OUTSIDE the transaction is
the other half: a model turn can take minutes and must never hold a row lock.

Every firing is a turn (`traces.open_turn(kind=<timer kind>)`), so Activity
shows reminder / scheduled / job turns beside chat turns and a firing's
`turn_id` links to its spans. A reminder is delivered by CODE: the chat row is
written through chat._persist_assistant, and each device notification is a
real `device_notify` call through chat._run_tool, so its span, redaction and
facts are exactly the chat's own and a delivery is `ok` only from the device's
own result frame. A scheduled instruction runs through chat._run_turn with
`ingest=False` — she must not remember the instruction as something he said
today, every day. A job runs the handler timers.JOBS names, under a `job`
span; an unknown handler is a REFUSED firing and pauses the row with that
reason, never a model call.

Nothing here asks anyone for anything (owner ruling 2026-09-03): the path from
claim to run awaits only the work.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime

import asyncpg

from app import chat, devices_ws, identity, peers, schedule, settings_store, timers, tools, traces
from app.identity import Person

logger = logging.getLogger("core")

CLAIM_LIMIT = 20
# The startup sweep's words: the process that was running it is gone.
INTERRUPTED_REASON = "core restarted while this firing was running"
# The graceful path's words: lifespan cancelled the ticker while this ran.
SHUTDOWN_REASON = "core shut down while this firing was running"
FIRING_OK, FIRING_ERROR, FIRING_REFUSED, FIRING_INTERRUPTED = (
    "ok",
    "error",
    "refused",
    "interrupted",
)

# The firing ids THIS process is running right now — the scheduler's
# traces.INFLIGHT. sweep_orphaned_firings excludes it, derived from the live
# set, so a caller that ever sweeps while a firing is live cannot kill its row.
RUNNING: set[uuid.UUID] = set()


@dataclass
class Outcome:
    status: str
    reason: str | None = None
    delivery: dict = field(default_factory=dict)
    # A refusal that should also stop the row (an unknown job handler) states
    # why here; the timer is paused with these words regardless of the count.
    pause_reason: str | None = None


# -- the claim ---------------------------------------------------------------


async def tick_once(app, pool: asyncpg.Pool, *, now: datetime | None = None) -> list[uuid.UUID]:
    """Claim every due timer (up to CLAIM_LIMIT) in one transaction, then run
    each claimed firing outside it. Returns the firing ids this tick ran.
    `now` defaults to the database clock; tests pass one."""
    claimed: list[tuple[asyncpg.Record, uuid.UUID, datetime]] = []
    async with pool.acquire() as conn, conn.transaction():
        if now is None:
            now = await conn.fetchval("SELECT now()")
        rows = await conn.fetch(
            "SELECT * FROM timers WHERE paused_at IS NULL AND next_fire_at IS NOT NULL "
            "AND next_fire_at <= $1 ORDER BY next_fire_at LIMIT $2 FOR UPDATE SKIP LOCKED",
            now,
            CLAIM_LIMIT,
        )
        for row in rows:
            try:
                nxt = _next_fire(row, now)
            except Exception as exc:
                # A stored spec that cannot be advanced (a zone the system no
                # longer knows, say) is a fact about the row, stated on it: the
                # row is paused with the reason rather than left due forever,
                # and nothing fires from a spec that cannot say when next.
                reason = f"could not compute the next fire: {peers.reason(exc)}"
                logger.error("timer %s: %s", row["id"], reason)
                await conn.execute(
                    "UPDATE timers SET paused_at = now(), paused_reason = $2, updated_at = now() "
                    "WHERE id = $1",
                    row["id"],
                    reason,
                )
                continue
            firing_id = await conn.fetchval(
                "INSERT INTO timer_firings (timer_id, scheduled_for, status) "
                "VALUES ($1, $2, 'running') RETURNING id",
                row["id"],
                row["next_fire_at"],
            )
            await conn.execute(
                "UPDATE timers SET next_fire_at = $2, updated_at = now() WHERE id = $1",
                row["id"],
                nxt,
            )
            claimed.append((row, firing_id, row["next_fire_at"]))
    # COMMITTED. From here nothing holds a lock.
    for row, firing_id, scheduled_for in claimed:
        await _run_firing(app, pool, row, firing_id, scheduled_for)
    return [firing_id for _row, firing_id, _at in claimed]


def _next_fire(row: asyncpg.Record, now: datetime) -> datetime | None:
    """The row's next instant after the one being claimed. Computed from the
    scheduled instant so an on-time repeat keeps its grid (a 5-minute row stays
    on :00/:05/:10); but if that answer is ALSO already due — the row was
    missed, core was down — it is recomputed from now, so a 5-minute timer
    that missed an hour fires once and resumes, not twelve times in a row. The
    missed instant is still the truth of this firing's `scheduled_for`."""
    nxt = schedule.next_after(row["schedule"], row["next_fire_at"], row["timezone"])
    if nxt is not None and nxt <= now:
        nxt = schedule.next_after(row["schedule"], now, row["timezone"])
    return nxt


# -- one firing ----------------------------------------------------------------


async def _run_firing(
    app, pool: asyncpg.Pool, row: asyncpg.Record, firing_id: uuid.UUID, scheduled_for: datetime
) -> None:
    kind = row["kind"]
    RUNNING.add(firing_id)
    turn: traces.Turn | None = None
    scheduler_closes_turn = kind != "scheduled"
    outcome = Outcome(FIRING_ERROR, "the firing did not reach an outcome")
    try:
        model = None
        if kind == "scheduled":
            model = await settings_store.read_value(pool, "chat.model")
        turn = await traces.open_turn(
            pool, kind=kind, conversation_id=row["conversation_id"], model=model
        )
        # Linked the moment the turn exists, so a firing cut off mid-run still
        # points at the trace of what it got done.
        await pool.execute(
            "UPDATE timer_firings SET turn_id = $2 WHERE id = $1", firing_id, turn.id
        )
        if kind == "reminder":
            outcome = await _fire_reminder(app, pool, row, turn)
        elif kind == "scheduled":
            outcome = await _fire_scheduled(app, pool, row, turn, model, scheduled_for)
        elif kind == "job":
            outcome = await _fire_job(pool, row, turn)
        else:
            outcome = Outcome(FIRING_REFUSED, f"no firing path for timer kind {kind!r}")
    except asyncio.CancelledError:
        # A graceful shutdown (lifespan cancels the ticker mid-firing) is not a
        # failure of the timer: the firing is closed `interrupted` with the
        # reason, its count untouched — the same fact the startup sweep states
        # for a SIGKILL, so five redeploys cannot pause a long scheduled turn.
        # Re-raised after the finally: the ticker still has to stop.
        outcome = Outcome(FIRING_INTERRUPTED, SHUTDOWN_REASON)
        raise
    except Exception as exc:
        logger.exception("timer %s firing %s failed unexpectedly", row["id"], firing_id)
        outcome = Outcome(FIRING_ERROR, f"the firing failed — {peers.reason(exc)[:300]}")
    finally:
        try:
            if turn is not None:
                await _close_if_still_open(pool, turn, outcome, scheduler_closes_turn)
        except Exception:
            logger.exception("could not close the turn of firing %s", firing_id)
        try:
            await _record(pool, row, firing_id, outcome)
        except Exception:
            logger.exception("could not record firing %s", firing_id)
        RUNNING.discard(firing_id)


async def _close_if_still_open(
    pool: asyncpg.Pool, turn: traces.Turn, outcome: Outcome, scheduler_closes_turn: bool
) -> None:
    """Every firing's turn reaches a terminal status. A reminder or job turn is
    the scheduler's own to close. A scheduled turn is closed by chat._run_turn
    (its ONLY closer) — but a scheduled firing REFUSED before _run_turn ran (no
    model set, conversation gone) would leave its row NULL until the next
    startup sweep, reading as 'still running' in Activity. So the live status
    is read back, never assumed: still NULL means nothing closed it, and it is
    closed here with the outcome's verdict."""
    if not scheduler_closes_turn:
        status = await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id)
        if status is not None:
            return
    if outcome.status == FIRING_OK:
        status = "ok"
    elif outcome.status == FIRING_INTERRUPTED:
        status = "interrupted"
    else:
        status = "error"
    await traces.close_turn(pool, turn, status)


async def _record(
    pool: asyncpg.Pool, row: asyncpg.Record, firing_id: uuid.UUID, outcome: Outcome
) -> None:
    """Close the firing row and move the timer's failure count. Reset on ok;
    +1 on error/refused; untouched on interrupted (the process stopped, the
    timer did nothing wrong); at FAILURES_BEFORE_PAUSE the row is paused with
    the last reason, so a timer that cannot run stops trying and SAYS so on
    the page instead of failing quietly every day."""
    await pool.execute(
        "UPDATE timer_firings SET status = $2, ended_at = now(), reason = $3, "
        "delivery = $4::jsonb WHERE id = $1",
        firing_id,
        outcome.status,
        outcome.reason,
        outcome.delivery,
    )
    if outcome.status == FIRING_INTERRUPTED:
        return
    if outcome.status == FIRING_OK:
        await pool.execute(
            "UPDATE timers SET consecutive_failures = 0, updated_at = now() WHERE id = $1",
            row["id"],
        )
        return
    pause_reason = outcome.pause_reason or (
        f"paused after {timers.FAILURES_BEFORE_PAUSE} consecutive failures: {outcome.reason}"
    )
    updated = await pool.fetchrow(
        "UPDATE timers SET consecutive_failures = consecutive_failures + 1, "
        "paused_at = CASE WHEN paused_at IS NULL AND ($3 OR consecutive_failures + 1 >= $4) "
        "  THEN now() ELSE paused_at END, "
        "paused_reason = CASE WHEN paused_at IS NULL AND ($3 OR consecutive_failures + 1 >= $4) "
        "  THEN $2 ELSE paused_reason END, updated_at = now() "
        "WHERE id = $1 RETURNING consecutive_failures, paused_at",
        row["id"],
        pause_reason,
        outcome.pause_reason is not None,
        timers.FAILURES_BEFORE_PAUSE,
    )
    if updated is not None and updated["paused_at"] is not None:
        logger.warning("timer %s (%s) paused: %s", row["id"], row["title"], pause_reason)


async def _person_of(pool: asyncpg.Pool, row: asyncpg.Record) -> Person | None:
    person = await pool.fetchrow(
        "SELECT id, name, role FROM people WHERE id = $1", row["person_id"]
    )
    return identity._person(person)


# -- reminder ------------------------------------------------------------------


async def _connected_device_names(pool: asyncpg.Pool) -> list[str]:
    """Every paired, live device whose socket is in the hub RIGHT NOW: the hub's
    live set intersected with the registry's unrevoked rows, sorted by name."""
    ids = [uuid.UUID(did) for did in devices_ws.hub.connected_ids()]
    if not ids:
        return []
    rows = await pool.fetch(
        "SELECT name FROM devices WHERE revoked_at IS NULL AND id = ANY($1::uuid[]) ORDER BY name",
        ids,
    )
    return [r["name"] for r in rows]


async def _fire_reminder(
    app, pool: asyncpg.Pool, row: asyncpg.Record, turn: traces.Turn
) -> Outcome:
    """No model. The chat row is his words verbatim under "Reminder:"; then one
    device_notify per target device through chat._run_tool, so each delivery is
    a real tool span whose `ok` came from the device's own result frame. The
    firing is ok iff the chat row persisted; no connected device is a STATED
    fact in the delivery, not a failure. A conversation that no longer exists
    loses the chat leg only — the devices are still told, because the reminder
    was for him, not for the thread."""
    payload = row["payload"]
    text = f"Reminder: {payload['message']}"
    delivery: dict = {"chat": {"ok": False}, "devices": []}
    if row["conversation_id"] is None:
        delivery["chat"]["reason"] = "the conversation this reminder was for no longer exists"
    else:
        try:
            await chat._persist_assistant(pool, row["conversation_id"], text, turn.id)
            delivery["chat"] = {"ok": True}
        except Exception as exc:
            delivery["chat"] = {
                "ok": False,
                "reason": f"could not write the chat row: {peers.reason(exc)}",
            }

    person = await _person_of(pool, row)
    if person is None:
        delivery["note"] = (
            "the person this reminder was for no longer exists; no device was notified"
        )
        targets: list[str] = []
    elif "device" in payload and payload["device"] is not None:
        targets = [payload["device"]]
    else:
        targets = await _connected_device_names(pool)
        if not targets:
            delivery["note"] = "no paired device was connected"
    if person is not None:
        ctx = tools.context_for(app, person, facts_sink=[])
        for index, name in enumerate(targets, start=1):
            call = chat.ToolCall(
                id=f"call_{index}",
                name="device_notify",
                arguments=json.dumps({"device": name, "message": text}),
            )
            result, ok = await chat._run_tool(turn, ctx, call)
            entry: dict = {"name": name, "ok": ok}
            if not ok:
                entry["reason"] = chat._activity_reason(result) or "the device did not confirm"
            delivery["devices"].append(entry)

    if delivery["chat"]["ok"]:
        return Outcome(FIRING_OK, None, delivery)
    return Outcome(FIRING_ERROR, delivery["chat"]["reason"], delivery)


# -- scheduled -----------------------------------------------------------------


def framed_instruction(title: str, instruction: str, *, now_words: str) -> str:
    """The model's message for a scheduled turn — the instruction framed by
    code so she knows it is a timer speaking, not him, and what time it is."""
    return (
        f"[Scheduled turn — you set this up earlier as '{title}'; the owner may not be "
        f"watching. Local time now: {now_words}.]\n\n{instruction}"
    )


async def _settle_detached(spawned_before: set[asyncio.Task]) -> None:
    """Wait for the detached work THIS turn fired (its atomic trace close) —
    never the whole of chat._BACKGROUND, and never the task this runs in."""
    me = asyncio.current_task()
    while True:
        pending = [
            t for t in chat._BACKGROUND if t not in spawned_before and t is not me and not t.done()
        ]
        if not pending:
            return
        await asyncio.gather(*pending, return_exceptions=True)


def _error_frame(frames: list) -> str | None:
    for frame in frames:
        if not isinstance(frame, str) or not frame.startswith("data: "):
            continue
        payload = frame[len("data: ") :].strip()
        if payload == "[DONE]":
            continue
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and "error" in data:
            return str(data["error"])
    return None


async def _fire_scheduled(
    app,
    pool: asyncpg.Pool,
    row: asyncpg.Record,
    turn: traces.Turn,
    model: str,
    scheduled_for: datetime,
) -> Outcome:
    """The instruction as a REAL turn through chat._run_turn: history=[], no
    user row, ingest=False. _run_turn is the only writer of the assistant row
    (with turn_id, so the bubble label is derived from turns.kind) and the only
    closer of this turn, so the outcome is read back from the turn's status the
    way the eval runner reads it — never from the reply's prose.

    The turn runs as the timer's PERSON — for the owner's timers that is
    identity.owner; a timer another person set runs with their memory scope
    and lands in their conversation, never the owner's."""
    delivery: dict = {"chat": {"ok": False}}
    if row["conversation_id"] is None:
        reason = "the conversation this timer replied into no longer exists"
        delivery["chat"]["reason"] = reason
        return Outcome(FIRING_REFUSED, reason, delivery)
    person = await _person_of(pool, row)
    if person is None:
        reason = "the person this timer belonged to no longer exists"
        delivery["chat"]["reason"] = reason
        return Outcome(FIRING_REFUSED, reason, delivery)
    if not isinstance(model, str) or not model.strip():
        reason = "no chat model is set (Settings → Models), so the instruction cannot run"
        delivery["chat"]["reason"] = reason
        return Outcome(FIRING_REFUSED, reason, delivery)

    now = await pool.fetchval("SELECT now()")
    message = framed_instruction(
        row["title"],
        row["payload"]["instruction"],
        now_words=schedule.local_words(now, row["timezone"]),
    )
    max_tool_rounds = int(await settings_store.read_value(pool, "agents.max_tool_rounds"))
    frames: list = []
    spawned_before = set(chat._BACKGROUND)
    await chat._run_turn(
        app,
        pool,
        turn,
        person,
        row["conversation_id"],
        message,
        [],
        model,
        max_tool_rounds,
        frames.append,
        ingest=False,
    )
    await _settle_detached(spawned_before)
    status = await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id)
    if status == "ok":
        delivery["chat"] = {"ok": True}
        return Outcome(FIRING_OK, None, delivery)
    reason = _error_frame(frames) or f"the turn closed with status {status!r}"
    delivery["chat"] = {"ok": False, "reason": reason}
    return Outcome(FIRING_ERROR, reason, delivery)


# -- job -------------------------------------------------------------------------


async def _fire_job(pool: asyncpg.Pool, row: asyncpg.Record, turn: traces.Turn) -> Outcome:
    """The handler timers.JOBS names, under one `job` span carrying its result
    in words. An unknown handler is refused and PAUSES the row with the reason:
    nothing else can make that row do anything, and re-trying daily would only
    write the same refusal again."""
    name = row["payload"]["handler"] if "handler" in row["payload"] else None
    handler = timers.JOBS.get(name) if isinstance(name, str) else None
    if handler is None:
        reason = f"no job handler named {name!r}"
        return Outcome(FIRING_REFUSED, reason, {}, pause_reason=reason)
    with turn.span("job", name) as span:
        try:
            result = await handler(pool)
        except Exception as exc:
            reason = f"job {name!r} failed — {peers.reason(exc)[:300]}"
            span.meta["error"] = reason
            logger.exception("job %s failed", name)
            return Outcome(FIRING_ERROR, reason, {})
        span.meta["result"] = result
    return Outcome(FIRING_OK, None, {"job": {"ok": True, "result": result}})


# -- the loop and the sweep ----------------------------------------------------


async def run_forever(app, pool: asyncpg.Pool, interval_s: float = 60) -> None:
    """tick_once, sleep, repeat — every exception logged, never fatal. Owned by
    main.lifespan as its own task, NOT one of chat._BACKGROUND (a forever task
    in that set would hang drain_background); the lifespan cancels and awaits
    it BEFORE the drain."""
    while True:
        try:
            await tick_once(app, pool)
        except Exception:
            logger.exception("scheduler tick failed; the next tick runs in %ss", interval_s)
        await asyncio.sleep(interval_s)


async def sweep_orphaned_firings(pool: asyncpg.Pool) -> list[uuid.UUID]:
    """Close every `running` firing no process is running as `interrupted`;
    return the ids. Called at startup (main.lifespan, beside the turns and
    eval sweeps) when RUNNING is empty by construction. The exclusion of RUNNING
    is still in the query, derived from the live set. Idempotent. One WARNING
    per row: a firing a restart cut off is a fact the operator should see."""
    rows = await pool.fetch(
        "UPDATE timer_firings SET status = 'interrupted', ended_at = now(), reason = $1 "
        "WHERE status = 'running' AND NOT (id = ANY($2::uuid[])) "
        "RETURNING id, timer_id, scheduled_for, started_at",
        INTERRUPTED_REASON,
        list(RUNNING),
    )
    for row in rows:
        logger.warning(
            "orphaned firing %s of timer %s (scheduled for %s, started %s) closed as "
            "interrupted — no process was running it",
            row["id"],
            row["timer_id"],
            row["scheduled_for"].isoformat(),
            row["started_at"].isoformat(),
        )
    return [row["id"] for row in rows]
