"""The timers store: rows, jobs, and the retention job.

A TIMER is a row (migration 019); its kind is `reminder` (delivery is code),
`scheduled` (an instruction run as a model turn), `job` (a code handler bound
by name in JOBS) or `beat` (S11's watch and digest, bound by name in
app/beats.py). Everything that WRITES `timers` lives here, so the API and
the tools only ever call these functions; the tick that runs them is
app/scheduler.py.

Two refusals here are about what a row CAN be, never about who may act:
`create` refuses a spec that does not validate, a `once` already in the past,
a zone that does not load, and every SEEDED_KINDS kind from anywhere — those
rows are seeded from code alone, so a job handler or a beat that does not
exist in code can never be a row. `TimerRefused` carries the words and the
status the API should state (devices.DeviceRefused's shape). A third (S12):
only a `scheduled` row can be bound to an agent (`create(agent_id=)`,
`bind_agent`) — refused in words here before migration 021's CHECK would
refuse it by constraint name.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import asyncpg

from app import schedule, scheduler
from app.identity import Person

logger = logging.getLogger("core")

PERSON_KINDS = ("reminder", "scheduled")
# The kinds CODE seeds, and where each row comes from. A person never creates
# one: `create` refuses every key here by name, so a job handler or a beat that
# does not exist in code can never become a row, and the refusal says where the
# row does come from instead of merely declining. Derived — adding a seeded
# kind here adds it to KINDS and to the refusal in one edit.
SEEDED_KINDS: dict[str, str] = {
    "job": "timers.JOBS, seeded by ensure_jobs at startup",
    "beat": "app/beats.py, seeded by beats.ensure_beats at startup",
}
KINDS = PERSON_KINDS + tuple(SEEDED_KINDS)
CREATED_VIA = ("chat", "page", "system")
FAILURES_BEFORE_PAUSE = 5
RETENTION_DAYS = 30

# Jobs bind a NAME to a code handler. A job row is legitimate only if its
# handler is here — the scheduler refuses a firing whose handler is unknown
# and pauses the row with that reason, never routing it to a model. Derived:
# add an entry here and ensure_jobs seeds it at the next startup.
JOBS: dict[str, Callable[[asyncpg.Pool], Awaitable[str]]] = {}
# The schedule each job is seeded with, computed in UTC (jobs belong to the
# install, not to a person's zone).
JOB_SCHEDULES: dict[str, dict] = {"retention": {"kind": "day", "at": "03:30"}}
JOB_TITLES: dict[str, str] = {"retention": "Prune firing history older than 30 days"}

# agent_id (migration 021, S12): WHO runs a scheduled row — NULL is Nova.
# person_id stays the owner who set it, so list_for / owned / the Schedules
# page are untouched by a binding; only the firing reads the other column.
_COLUMNS = (
    "id, person_id, agent_id, kind, title, payload, schedule, timezone, conversation_id, "
    "next_fire_at, paused_at, paused_reason, consecutive_failures, created_via, "
    "created_turn_id, created_at, updated_at"
)
_FIRING_COLUMNS = (
    "id, timer_id, scheduled_for, started_at, ended_at, status, reason, turn_id, delivery"
)


class TimerRefused(Exception):
    """A stated refusal from the store, with the words the caller sees and the
    status the API should answer with. Anything else raised here is a bug."""

    def __init__(self, reason: str, *, status_code: int = 400) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status_code = status_code


# -- the retention job ----------------------------------------------------------


async def retention(pool: asyncpg.Pool) -> str:
    """Delete firings older than RETENTION_DAYS and say how many went. Age-based,
    never a row cap: a cap makes count(*) lie about how many times a timer ran
    ([[automation-runs-capped-at-50]])."""
    tag = await pool.execute(
        "DELETE FROM timer_firings WHERE started_at < now() - make_interval(days => $1)",
        RETENTION_DAYS,
    )
    # asyncpg's command tag is "DELETE <n>"; a malformed tag is a real failure.
    count = int(tag.rsplit(" ", 1)[1])
    noun = "firing" if count == 1 else "firings"
    return f"deleted {count} {noun} older than {RETENTION_DAYS} days"


JOBS["retention"] = retention


# -- rows ----------------------------------------------------------------------


def _schedule_words(row: asyncpg.Record) -> str:
    """describe()'s sentence, or the reason there is none. A stored zone the
    system no longer knows must not 500 the whole listing over one row; the
    tick pauses such a row with the same reason."""
    try:
        return schedule.describe(row["schedule"], row["timezone"], row["next_fire_at"])
    except schedule.SpecError as exc:
        return f"cannot describe this schedule: {exc}"


def timer_spec(row: asyncpg.Record) -> dict:
    """The row as the API and the page read it. `schedule_words` is derived
    from describe() here, so the page and her reply share one sentence."""
    return {
        "id": str(row["id"]),
        "kind": row["kind"],
        # The agent this row runs as (null: Nova). The NAME is not here on
        # purpose — it is a fact about the agents table, joined by whoever
        # shows it (timers_api, the list tool), never a label stored on the
        # timer that could outlive a rename or a delete.
        "agent_id": str(row["agent_id"]) if row["agent_id"] else None,
        "title": row["title"],
        "payload": row["payload"],
        "schedule": row["schedule"],
        "schedule_words": _schedule_words(row),
        "timezone": row["timezone"],
        "conversation_id": str(row["conversation_id"]) if row["conversation_id"] else None,
        "next_fire_at": row["next_fire_at"].isoformat() if row["next_fire_at"] else None,
        "paused_at": row["paused_at"].isoformat() if row["paused_at"] else None,
        "paused_reason": row["paused_reason"],
        "consecutive_failures": row["consecutive_failures"],
        "created_via": row["created_via"],
        "created_at": row["created_at"].isoformat(),
    }


def firing_spec(row: asyncpg.Record) -> dict:
    return {
        "id": str(row["id"]),
        "timer_id": str(row["timer_id"]),
        "scheduled_for": row["scheduled_for"].isoformat(),
        "started_at": row["started_at"].isoformat(),
        "ended_at": row["ended_at"].isoformat() if row["ended_at"] else None,
        "status": row["status"],
        "reason": row["reason"],
        "turn_id": str(row["turn_id"]) if row["turn_id"] else None,
        "delivery": row["delivery"],
    }


def _clean_payload(kind: str, payload: Any) -> dict:
    """The payload a kind carries, and nothing else — unknown keys refused by
    name, every required field read with a presence check."""
    if not isinstance(payload, dict):
        raise TimerRefused(f"payload must be an object, got {type(payload).__name__}")
    if kind == "reminder":
        allowed = ("message", "device")
        unknown = sorted(k for k in payload if k not in allowed)
        if unknown:
            raise TimerRefused(
                f"a reminder payload does not take {', '.join(map(repr, unknown))} — "
                "it takes message and device"
            )
        if "message" not in payload or not isinstance(payload["message"], str):
            raise TimerRefused("a reminder payload needs a string 'message'")
        message = payload["message"].strip()
        if not message:
            raise TimerRefused("a reminder's message is empty — what should it say?")
        device = payload["device"] if "device" in payload else None
        if device is not None and (not isinstance(device, str) or not device.strip()):
            raise TimerRefused("a reminder's 'device' must be a device name or null")
        return {"message": message, "device": device.strip() if device else None}
    if kind == "scheduled":
        unknown = sorted(k for k in payload if k != "instruction")
        if unknown:
            raise TimerRefused(
                f"a scheduled payload does not take {', '.join(map(repr, unknown))} — "
                "it takes instruction"
            )
        if "instruction" not in payload or not isinstance(payload["instruction"], str):
            raise TimerRefused("a scheduled payload needs a string 'instruction'")
        instruction = payload["instruction"].strip()
        if not instruction:
            raise TimerRefused("a scheduled timer's instruction is empty — what should she do?")
        return {"instruction": instruction}
    raise TimerRefused(f"no payload shape for kind {kind!r}")


def _clean_zone(tz: Any) -> str:
    if not isinstance(tz, str) or not tz.strip():
        raise TimerRefused("timezone must be an IANA zone name (e.g. America/New_York)")
    try:
        ZoneInfo(tz)
    except Exception as exc:
        raise TimerRefused(f"{tz!r} is not an IANA timezone (e.g. America/New_York)") from exc
    return tz


async def create(
    pool: asyncpg.Pool,
    *,
    person: Person,
    kind: str,
    title: str,
    payload: dict,
    spec: dict,
    tz: str,
    conversation_id: uuid.UUID | None,
    created_via: str,
    created_turn_id: uuid.UUID | None = None,
    agent_id: uuid.UUID | None = None,
) -> asyncpg.Record:
    """A reminder or scheduled timer for `person`, with its first fire computed.

    Validates the spec (schedule.validate), computes next_fire_at from the
    DATABASE clock (the same clock the tick claims against, so a "once" a
    second from now is due on the next tick and never lost between two
    clocks), and refuses a once already in the past — a row that would fire
    the moment it was created is not what "at 14:32" asked for. A SEEDED_KINDS
    kind is refused from here: those rows come from code alone (JOBS via
    ensure_jobs, the beats via beats.ensure_beats).

    `agent_id` (S12) binds a SCHEDULED row to the agent that runs it; any
    other kind is refused in words before the timers_agent_only_scheduled
    CHECK would refuse it by constraint name. An id naming no agent is a
    stated refusal too (the foreign key's violation, read and worded)."""
    if kind in SEEDED_KINDS:
        raise TimerRefused(
            f"{kind} timers are seeded from code — {SEEDED_KINDS[kind]} — never created here"
        )
    if kind not in PERSON_KINDS:
        raise TimerRefused(f"unknown timer kind {kind!r} — one of {', '.join(PERSON_KINDS)}")
    if created_via not in CREATED_VIA:
        raise TimerRefused(
            f"created_via must be one of {', '.join(CREATED_VIA)}, got {created_via!r}"
        )
    clean_title = (title or "").strip() if isinstance(title, str) else ""
    if not clean_title:
        raise TimerRefused("a timer needs a title — the words the list shows for it")
    clean_payload = _clean_payload(kind, payload)
    try:
        clean_spec = schedule.validate(spec)
    except schedule.SpecError as exc:
        raise TimerRefused(str(exc)) from exc
    zone = _clean_zone(tz)
    if kind == "reminder" and conversation_id is None:
        raise TimerRefused("a reminder needs the conversation it lands in")
    if kind == "scheduled" and conversation_id is None:
        raise TimerRefused("a scheduled timer needs the conversation its replies land in")
    if agent_id is not None and kind != "scheduled":
        raise TimerRefused(_agent_only_scheduled(kind))

    now = await pool.fetchval("SELECT now()")
    next_fire = schedule.next_after(clean_spec, now, zone)
    if next_fire is None:
        asked = schedule.resolve(datetime.fromisoformat(clean_spec["at"]), ZoneInfo(zone))
        raise TimerRefused(
            f"{schedule.local_words(asked, zone)} is already in the past — a reminder cannot "
            "be set for a time that has gone"
        )
    try:
        return await pool.fetchrow(
            f"INSERT INTO timers (person_id, kind, title, payload, schedule, timezone, "
            f"conversation_id, next_fire_at, created_via, created_turn_id, agent_id) "
            f"VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11) "
            f"RETURNING {_COLUMNS}",
            person.id,
            kind,
            clean_title,
            clean_payload,
            clean_spec,
            zone,
            conversation_id,
            next_fire,
            created_via,
            created_turn_id,
            agent_id,
        )
    except asyncpg.ForeignKeyViolationError as exc:
        refused = _agent_gone(exc, agent_id)
        if refused is None:
            raise
        raise refused from exc


def _agent_only_scheduled(kind: str) -> str:
    """The words for binding a row that is not a scheduled turn — stated
    BEFORE postgres would state it as a constraint name."""
    return f"only a scheduled turn can be bound to an agent — this is a {kind}"


def _agent_gone(exc: asyncpg.ForeignKeyViolationError, agent_id) -> TimerRefused | None:
    """A foreign-key violation on the agents reference, worded (the agent was
    deleted between the caller's name lookup and this write); None for any
    other foreign key, which is not this function's to explain — the caller
    re-raises it as it was."""
    if "agent" in (exc.constraint_name or ""):
        return TimerRefused(
            f"no agent with id {agent_id} exists — it may have just been deleted",
            status_code=404,
        )
    return None


async def get(pool: asyncpg.Pool, timer_id: uuid.UUID) -> asyncpg.Record | None:
    return await pool.fetchrow(f"SELECT {_COLUMNS} FROM timers WHERE id = $1", timer_id)


async def owned(pool: asyncpg.Pool, person: Person, timer_id: uuid.UUID) -> asyncpg.Record:
    """The person's own timer, or any job — otherwise a 404, never a 403
    (conversations.owned_conversation's rule: someone else's is not found)."""
    row = await pool.fetchrow(
        f"SELECT {_COLUMNS} FROM timers WHERE id = $1 AND (person_id = $2 OR kind = 'job')",
        timer_id,
        person.id,
    )
    if row is None:
        raise TimerRefused(f"no timer {timer_id} here", status_code=404)
    return row


async def list_for(
    pool: asyncpg.Pool, person: Person, *, limit: int = 50, before: uuid.UUID | None = None
) -> list[asyncpg.Record]:
    """The person's timers plus every job, newest first; `before` is the last id
    of the previous page."""
    if before is None:
        return await pool.fetch(
            f"SELECT {_COLUMNS} FROM timers WHERE person_id = $1 OR kind = 'job' "
            f"ORDER BY created_at DESC, id DESC LIMIT $2",
            person.id,
            limit,
        )
    return await pool.fetch(
        f"SELECT {_COLUMNS} FROM timers WHERE (person_id = $1 OR kind = 'job') "
        f"AND (created_at, id) < (SELECT created_at, id FROM timers WHERE id = $3) "
        f"ORDER BY created_at DESC, id DESC LIMIT $2",
        person.id,
        limit,
        before,
    )


async def list_bound(pool: asyncpg.Pool, agent_id: uuid.UUID) -> list[asyncpg.Record]:
    """The timers an agent RUNS (agent_id = this agent, migration 021), newest
    first — the set list_timers shows an agent turn. person_id stays the
    owner who set each one, so the same rows are still his in list_for; this
    is the other axis, who does the work. No page: an agent is bound to a
    timer by an owner's action, one at a time, never in the hundreds."""
    return await pool.fetch(
        f"SELECT {_COLUMNS} FROM timers WHERE agent_id = $1 ORDER BY created_at DESC, id DESC",
        agent_id,
    )


async def _existing(pool: asyncpg.Pool, timer_id: uuid.UUID) -> asyncpg.Record:
    row = await get(pool, timer_id)
    if row is None:
        raise TimerRefused(f"no timer {timer_id}", status_code=404)
    return row


async def pause(pool: asyncpg.Pool, timer_id: uuid.UUID, *, reason: str) -> asyncpg.Record:
    """Stamp paused_at with the reason. A paused row is never claimed by the
    tick (the claim's WHERE clause). Pausing a paused row is refused — the
    original reason is the record of why it stopped, and overwriting it would
    hide a 5-failures pause behind a later click."""
    clean = (reason or "").strip() if isinstance(reason, str) else ""
    if not clean:
        raise TimerRefused("a pause needs a reason — it is what the page shows on the row")
    row = await _existing(pool, timer_id)
    if row["paused_at"] is not None:
        raise TimerRefused(
            f"{row['title']!r} is already paused: {row['paused_reason']}", status_code=409
        )
    return await pool.fetchrow(
        f"UPDATE timers SET paused_at = now(), paused_reason = $2, updated_at = now() "
        f"WHERE id = $1 AND paused_at IS NULL RETURNING {_COLUMNS}",
        timer_id,
        clean,
    )


async def resume(pool: asyncpg.Pool, timer_id: uuid.UUID) -> asyncpg.Record:
    """Clear the pause and the failure count. A paused `once` still in the
    future keeps its instant (that is the time asked for); a once already past
    keeps it too and so fires late on the next tick — a late reminder, stated
    as such by its scheduled_for; a repeat is recomputed from now so a daily
    row paused for a week fires once tomorrow, not seven times today."""
    row = await _existing(pool, timer_id)
    if row["paused_at"] is None:
        raise TimerRefused(f"{row['title']!r} is not paused", status_code=409)
    next_fire = row["next_fire_at"]
    if row["schedule"]["kind"] != "once":
        now = await pool.fetchval("SELECT now()")
        next_fire = schedule.next_after(row["schedule"], now, row["timezone"])
    return await pool.fetchrow(
        f"UPDATE timers SET paused_at = NULL, paused_reason = NULL, consecutive_failures = 0, "
        f"next_fire_at = $2, updated_at = now() WHERE id = $1 RETURNING {_COLUMNS}",
        timer_id,
        next_fire,
    )


async def bind_agent(
    pool: asyncpg.Pool, person: Person, timer_id: uuid.UUID, agent_id: uuid.UUID | None
) -> asyncpg.Record:
    """Bind the person's scheduled timer to the agent that will run it, or
    unbind it (None) — the row as written. Scoped through `owned`, so an id
    that is not this person's (or nobody's) is a 404 the way every other
    per-timer write is; a row that is not a scheduled turn is refused in
    words before the CHECK constraint would. person_id is untouched: the
    owner who set it still owns it, sees it, cancels it."""
    row = await owned(pool, person, timer_id)
    if row["kind"] != "scheduled":
        raise TimerRefused(_agent_only_scheduled(row["kind"]))
    try:
        updated = await pool.fetchrow(
            f"UPDATE timers SET agent_id = $2, updated_at = now() WHERE id = $1 "
            f"RETURNING {_COLUMNS}",
            timer_id,
            agent_id,
        )
    except asyncpg.ForeignKeyViolationError as exc:
        refused = _agent_gone(exc, agent_id)
        if refused is None:
            raise
        raise refused from exc
    if updated is None:
        # Deleted between the read above and this write: nothing was bound,
        # and saying so beats handing back the stale row as if it were.
        raise TimerRefused(f"no timer {timer_id}", status_code=404)
    return updated


async def delete(pool: asyncpg.Pool, timer_id: uuid.UUID) -> None:
    """Remove the row (its firings cascade). A missing id is a 404, so a delete
    never reports success over nothing."""
    tag = await pool.execute("DELETE FROM timers WHERE id = $1", timer_id)
    if tag == "DELETE 0":
        raise TimerRefused(f"no timer {timer_id}", status_code=404)


async def fire_now(pool: asyncpg.Pool, timer_id: uuid.UUID, *, app) -> asyncpg.Record:
    """ "Run now": make the row due this instant, then run ONE tick, so the run
    goes through the same claim and leaves the same firing row as any other.
    Returns that firing. A paused row is refused — the claim never picks a
    paused row up, so setting it due would do nothing and reading "ran" off
    that would be a lie. `app` is the FastAPI app (the gateway/memory seams a
    scheduled turn needs), which is why it rides in as a keyword."""
    row = await _existing(pool, timer_id)
    if row["paused_at"] is not None:
        raise TimerRefused(
            f"{row['title']!r} is paused ({row['paused_reason']}) — resume it to run it",
            status_code=409,
        )
    # Conditional on the instant this call READ: if the loop's tick claimed the
    # row in between (it holds the row FOR UPDATE while it advances
    # next_fire_at, so this UPDATE waits for its commit and then re-checks the
    # WHERE on the new version), zero rows match — re-dueing it anyway would
    # fire the same row twice, once for each tick (DoD 5: nothing fires twice).
    # Then the honest thing to hand back is the firing THAT tick opened for the
    # instant we saw, not a second run.
    due_at = await pool.fetchval(
        "UPDATE timers SET next_fire_at = now(), updated_at = now() "
        "WHERE id = $1 AND next_fire_at IS NOT DISTINCT FROM $2 RETURNING next_fire_at",
        timer_id,
        row["next_fire_at"],
    )
    if due_at is None:
        claimed = await pool.fetchrow(
            f"SELECT {_FIRING_COLUMNS} FROM timer_firings "
            f"WHERE timer_id = $1 AND scheduled_for = $2 ORDER BY started_at DESC LIMIT 1",
            timer_id,
            row["next_fire_at"],
        )
        if claimed is None:
            raise TimerRefused(
                f"{row['title']!r} was claimed by another tick as this ran and its firing "
                "is not visible yet — check the Schedules page",
                status_code=409,
            )
        return claimed
    await scheduler.tick_once(app, pool)
    firing = await pool.fetchrow(
        f"SELECT {_FIRING_COLUMNS} FROM timer_firings WHERE timer_id = $1 AND scheduled_for = $2 "
        f"ORDER BY started_at DESC LIMIT 1",
        timer_id,
        due_at,
    )
    if firing is None:
        # Another tick (or another process) may have claimed it first, or the
        # tick raised. Either way there is no firing to hand back, and inventing
        # one is exactly the report-unchecked defect.
        raise TimerRefused(
            f"{row['title']!r} was made due but this tick did not claim it — check the "
            "Schedules page for the firing another tick may have run",
            status_code=409,
        )
    return firing


async def firings_for(
    pool: asyncpg.Pool, timer_id: uuid.UUID, *, limit: int = 50, before: uuid.UUID | None = None
) -> list[asyncpg.Record]:
    """This timer's firings, newest first; `before` is the id of the last one
    seen, paged on (started_at, id) like Activity."""
    if before is None:
        return await pool.fetch(
            f"SELECT {_FIRING_COLUMNS} FROM timer_firings WHERE timer_id = $1 "
            f"ORDER BY started_at DESC, id DESC LIMIT $2",
            timer_id,
            limit,
        )
    return await pool.fetch(
        f"SELECT {_FIRING_COLUMNS} FROM timer_firings WHERE timer_id = $1 "
        f"AND (started_at, id) < (SELECT started_at, id FROM timer_firings WHERE id = $3) "
        f"ORDER BY started_at DESC, id DESC LIMIT $2",
        timer_id,
        limit,
        before,
    )


# -- jobs ------------------------------------------------------------------------


async def ensure_jobs(pool: asyncpg.Pool) -> list[str]:
    """Seed a row for every JOBS handler that has none; return the names seeded.

    Called at startup (main.lifespan). The gateway's ensure-builtin pattern:
    INSERT ... ON CONFLICT DO NOTHING against the one-row-per-job unique index,
    so two starts racing each other cannot make two rows, and a migration never
    seeds it (a TRUNCATE in the tests would remove a migration-seeded row and
    nothing would put it back). Derived from JOBS, never a list here: a handler
    added in code gets its row on the next start."""
    seeded: list[str] = []
    now = await pool.fetchval("SELECT now()")
    for name in JOBS:
        if name not in JOB_SCHEDULES or name not in JOB_TITLES:
            # Loud and in words: a handler without its schedule and title is a
            # code defect that must stop startup, not a KeyError to decode.
            raise RuntimeError(f"JOBS[{name!r}] has no JOB_SCHEDULES/JOB_TITLES entry")
        spec = schedule.validate(JOB_SCHEDULES[name])
        row = await pool.fetchrow(
            "INSERT INTO timers (person_id, kind, title, payload, schedule, timezone, "
            "next_fire_at, created_via) "
            "VALUES (NULL, 'job', $1, $2::jsonb, $3::jsonb, 'UTC', $4, 'system') "
            "ON CONFLICT ((payload->>'handler')) WHERE kind = 'job' DO NOTHING RETURNING id",
            JOB_TITLES[name],
            {"handler": name},
            spec,
            schedule.next_after(spec, now, "UTC"),
        )
        if row is not None:
            seeded.append(name)
            logger.info("seeded job timer %r (%s)", name, schedule.describe(spec, "UTC", None))
    return seeded
