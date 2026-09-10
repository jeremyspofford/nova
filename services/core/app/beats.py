"""The beat: the timer kind that gives Nova attention.

She only ever speaks when spoken to. Everything she could notice — a timer
that has failed five nights running, an agent over its cap, backups that
quietly stopped — is in the database and invisible to him. A BEAT is the
fourth timer kind, and it is a timer rather than a new loop so that it
inherits, already tested, the `FOR UPDATE SKIP LOCKED` claim that makes a
firing exactly-once, the pause-after-5-consecutive-failures ceiling with its
reason on the row, the firings history with its per-channel delivery receipt,
retention, and "Run now" on the Schedules page.

Two rows, seeded from code here (never creatable from chat — timers.create
refuses every SEEDED_KINDS kind by name):

  * `watch`  — hourly. Runs every registered check (app/checks), writes what
    they found down as notices, and clears the notices whose condition a check
    that RAN no longer finds. Cheap, because the fact checks are database and
    socket reads; no model is asked at all. It delivers nothing EXCEPT the one
    urgent family — the stack being down, the only entry on the list Jeremy set
    — which goes out the moment its row exists, at any hour, in a sentence
    composed in code from the check's own title and facts. Everything else
    waits; the watch beat's own line lands in the beats' conversation.
  * `digest` — daily, at the hour the owner sets. Writes the ONE message, and
    only on the days there is something to write about.

Both belong to the OWNER: a beat's findings are his, its spend is his, and
its digest lands in his conversation. (Migration 019's
`timers_job_has_no_person` CHECK already makes a person-less beat
unrepresentable — only a job may have no person.)

Where a beat's turn lands: `chat._run_turn` is the only writer of an assistant
message and it ALWAYS writes one, so every scheduled firing today puts a
bubble in his chat. A beat must be able to find nothing and say nothing, so it
gets its own INACTIVE conversation — the same trick an agent's log
conversation uses (agents._insert_log_conversation), for the same reason:
`conversations.active_conversation(owner)` picks the newest ACTIVE row, so it
can never hand the chat page a beat's working notes. The digest is what
reaches him, and it is written on purpose.

Why a beat does not go through `chat._run_turn`, stated once here because it
looks like an omission: _run_turn is the only writer of an assistant row AND
the only closer of its turn, and a beat's turn is opened and closed by
`scheduler._run_firing` (`scheduler_closes_turn` is True for every kind but
`scheduled`) — running one inside a beat would write the turn's spans twice.
It would also write the message twice, because `delivery.deliver` is what puts
the row in his ACTIVE conversation and reads it back, which is the ONE fact
"delivered" is allowed to mean here. So the digest asks for exactly one round
through `chat._gateway_round` — the same code path, the same `llm_call` span,
the same markup strip — and this module runs the guards that apply over what
comes back. The chat guards that do NOT apply are left out deliberately:
`narration_check` reads THIS turn's tool spans, and a digest's whole job is to
relay what an earlier watch turn did ("I restarted the gateway"), so running it
here would append a contradiction under every true sentence she wrote.

And the digest's TURN stays on the beats' conversation even though its MESSAGE
lands in his: `conversations.has_pending_turn` reports a NULL-status turn as
pending only when it is in `traces.INFLIGHT`, which by contract holds the
owner's chat turns alone — a beat turn parked against his conversation would
trip that function's "the sweep was bypassed" tripwire on every poll of his
chat page for as long as the beat ran. The message carries `turn_id`, so the
transcript is badged from the trace either way, which is the link that matters.

Nothing here asks anyone for anything (owner ruling 2026-09-03). A beat states
what it could not do; it never decides what it may not.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import asyncpg

from app import chat, guards, identity, peers, schedule, settings_store, traces
from app.identity import Person

if TYPE_CHECKING:  # app.checks is imported at CALL time — see _proactive.
    from app import checks
    from app import notices as notices_module

logger = logging.getLogger("core")

# The two beats. The name is the beat's IDENTITY and lives in payload.handler,
# exactly as a job's handler does, so the row can be found by what it is rather
# than by a title someone might edit.
WATCH = "watch"
DIGEST = "digest"
DISTIL = "distil"
BEATS = (WATCH, DIGEST, DISTIL)

# timers.kind and turns.kind. Spelled separately because they are two different
# columns in two different tables that happen to agree; a future rename of one
# must not silently move the other.
BEAT_KIND = "beat"
BEAT_TURN_KIND = "beat"

BEAT_TITLES: dict[str, str] = {
    WATCH: "Watch: run the checks every hour and act on what they find",
    DIGEST: "Digest: one message a day about what she found",
    DISTIL: "Distil: turn what was said into facts her memory can find",
}

# Hourly, at :05 rather than :00. A firing runs serially inside one tick, and
# :00 is where wall-clock reminders pile up — a beat that took a minute there
# would delay them all.
WATCH_SCHEDULE = {"kind": "hour", "minute": 5}

# Hourly too, at :35 — off the watch beat's :05 so the two never share a tick,
# and nowhere near :00. Hourly rather than daily because "keep up" was the
# owner's word for it and a pass over an hour with nothing said in it costs
# NOTHING: the window comes back empty and the model is never asked. The price
# of the cadence is paid only in hours he actually talked to her.
DISTIL_SCHEDULE = {"kind": "hour", "minute": 35}

# The beats the proactive switch gates, and it is not all of them.
#
# `proactive.enabled` is about whether she goes looking for things to tell him
# and then tells him. Distillation tells him nothing — it writes down what was
# already said, into his own notes, so that recall can find it. That is memory
# hygiene, and an install that never turned the proactive engine on would
# otherwise have a memory that quietly never learned anything, with the reason
# buried in a setting about a different feature.
GATED_BY_PROACTIVE = (WATCH, DIGEST)

# How far back a distil pass reads when the beat has no history to derive a
# mark from — a fresh install, or the first firing after this beat was added.
# One day rather than the whole archive: the backfill is a deliberate separate
# pass over everything, and a beat that quietly tried to swallow twelve days on
# its first tick would be doing the backfill's job without anyone asking.
DISTIL_FIRST_WINDOW = timedelta(days=1)
# The most a single catch-up pass reaches back for, however long the beat was
# down. A machine asleep for a week must not produce one enormous read; what
# is older than this is the backfill's to do, and the line says so.
DISTIL_MAX_WINDOW = timedelta(days=2)

# The digest's hour. Read defensively — through settings_store when the def is
# registered, straight off the table if it ever is not — and never trusted
# without validating it as a real schedule.
DIGEST_AT_KEY = "proactive.digest_at"
DEFAULT_DIGEST_AT = "08:00"

# The switch. It ships FALSE (SETTING_DEFS says so), and while it is false a
# beat that fires does nothing and states that on its firing. This is a fact
# about configuration, not a decision about what she may do: nothing here asks
# anyone for anything, and the owner ruling of 2026-09-03 stands — the check
# says the engine is off, never that a beat is not allowed to run.
ENABLED_KEY = "proactive.enabled"
PROACTIVE_OFF = (
    "the proactive engine is off (proactive.enabled is false), so this beat ran nothing: no "
    "check was made, nothing was recorded, nothing was cleared and nothing was delivered. "
    "Turn the setting on and the next firing does the work."
)

# The backstop under "one message a day": the most findings one digest may
# carry. What does not fit is HELD, never dropped — it is still deliverable and
# the next digest owes it to him — and the count is recorded on the firing.
MAX_NOTICES_KEY = "proactive.max_notices_per_day"

# The title of the beats' own inactive conversation. It is how the row is found
# again — a conversation has no other identity column, and an agent's log gets
# its id stored on the agents row, which beats have nowhere to put.
BEAT_CONVERSATION_TITLE = "beats"

# One advisory lock key for every seeding write here, so two processes starting
# at once produce ONE conversation and ONE row per beat. Migration 019's
# `timers_one_row_per_job` unique index is partial on `kind = 'job'` and so
# does not cover beats, and 022 adds no equivalent — this lock is what stands
# in for it. The number is the ASCII of "beat", which makes it greppable rather
# than magic.
_SEED_LOCK = 0x62656174


def _scheduler():
    """app.scheduler, imported at call time. The scheduler imports THIS module
    at the top for its `beat` branch, so importing it back at module level
    would close the cycle; the same one-way idiom tools/timers._store uses."""
    from app import scheduler

    return scheduler


def _proactive():
    """(app.checks, app.notices), imported at call time for the same reason.

    app.checks registers its families at import, and one of them (checks.work)
    reads timers — so app.checks reaches app.timers, which imports
    app.scheduler, which imports THIS module. At module level that closes the
    cycle and the scheduler's own body then reads a beats attribute that does
    not exist yet. Importing here costs a sys.modules lookup and keeps the
    dependency one-way.
    """
    from app import checks, notices

    return checks, notices


def _delivery():
    """app.delivery, imported at call time for the same reason again.

    delivery imports app.tools at module level, and the tool registry pulls
    app.tools.timers -> app.timers -> app.scheduler -> THIS module. At module
    level that closes the cycle and the scheduler's body then reads
    `beats.BEAT_KIND` before it exists. The one-way idiom, a third time.
    """
    from app import delivery

    return delivery


async def _zone(conn) -> str | None:
    """The household's IANA zone, or None when the stored one cannot be used.

    `tools.timers.household_timezone` is the one reader that distinguishes
    "stored UTC" from "never answered" and raises on a zone that no longer
    loads — `scheduler._owner_timezone` swallows both into UTC, which would
    silently put the digest in the wrong place. A zone that will not load is
    operator data, not a code defect: it is stated and returns None, and the
    caller declines to seed rather than writing a row whose daily hour is a
    guess. A household that never answered gets the default zone, said out
    loud, because a cadence beat is right in any zone and the digest can be
    re-timed the moment he answers.
    """
    # Function-local: app.tools reaches app.timers, which imports app.scheduler,
    # which imports this module.
    from app.tools.base import ToolFailure
    from app.tools.timers import household_timezone

    try:
        zone, is_set = await household_timezone(conn)
    except ToolFailure as exc:
        logger.error("the beats were not seeded — %s", exc)
        return None
    if not is_set:
        logger.info(
            "no household timezone is set yet, so the beats are seeded in %s — set "
            "nova.timezone and the digest can be re-timed to a real local hour",
            zone,
        )
    return zone


async def _digest_spec(pool_or_conn) -> dict:
    """The digest's validated `day` spec, from the setting when it is readable.

    Three states, and each one says which it was: the def exists (read it the
    normal way), the def has not landed yet (read the row, default when there
    is none), and the stored value is not a wall time (say what is wrong with
    it in schedule.py's own words and use the default). The value is validated
    by BUILDING the spec — schedule.validate is the only parser of "HH:MM"
    here, so this cannot disagree with what the tick will later compute.
    """
    definition = settings_store.DEFS_BY_KEY.get(DIGEST_AT_KEY)
    if definition is not None:
        value = await settings_store.read_value(pool_or_conn, DIGEST_AT_KEY)
    else:
        row = await pool_or_conn.fetchrow(
            "SELECT value FROM settings WHERE key = $1", DIGEST_AT_KEY
        )
        value = DEFAULT_DIGEST_AT if row is None else row["value"]
    try:
        return schedule.validate({"kind": "day", "at": value})
    except schedule.SpecError as exc:
        logger.warning(
            "%s is %r, which is not a time of day (%s) — the digest is seeded at %s",
            DIGEST_AT_KEY,
            value,
            exc,
            DEFAULT_DIGEST_AT,
        )
        return schedule.validate({"kind": "day", "at": DEFAULT_DIGEST_AT})


async def _conversation(conn, owner: Person) -> uuid.UUID:
    """The beats' inactive conversation — found by title, created if missing —
    and every beat row re-pointed at it.

    INACTIVE so conversations.active_conversation(owner), which picks the
    newest ACTIVE row, can never hand his chat page a beat's working notes.
    Deleting that conversation nulls the beat rows' column (019's ON DELETE
    SET NULL), so a fresh one is made and the rows are pointed back at it
    rather than firing into nowhere. Callers hold _SEED_LOCK, so the
    find-then-create cannot race itself.
    """
    conversation_id = await conn.fetchval(
        "SELECT id FROM conversations WHERE person_id = $1 AND NOT active AND title = $2 "
        "ORDER BY created_at LIMIT 1",
        owner.id,
        BEAT_CONVERSATION_TITLE,
    )
    if conversation_id is None:
        conversation_id = await conn.fetchval(
            "INSERT INTO conversations (person_id, active, title) VALUES ($1, false, $2) "
            "RETURNING id",
            owner.id,
            BEAT_CONVERSATION_TITLE,
        )
        logger.info("the beats got a new inactive conversation (%s)", conversation_id)
    await conn.execute(
        "UPDATE timers SET conversation_id = $2, updated_at = now() "
        "WHERE kind = $1 AND conversation_id IS DISTINCT FROM $2",
        BEAT_KIND,
        conversation_id,
    )
    return conversation_id


async def beat_conversation(pool: asyncpg.Pool) -> uuid.UUID:
    """The conversation every beat turn writes into. See _conversation."""
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock($1)", _SEED_LOCK)
        owner = await identity.owner(conn)
        if owner is None:
            raise RuntimeError(
                "no owner account exists yet, so the beats have no conversation to write into"
            )
        return await _conversation(conn, owner)


async def ensure_beats(pool: asyncpg.Pool) -> bool:
    """Seed the two beat rows if they are missing; return whether they exist.
    Idempotent, and safe to call from two processes at once.

    Called at startup beside timers.ensure_jobs, and again from the scheduler's
    own loop until it returns True (scheduler.run_forever says why), and
    derived from BEATS rather than from a list in a migration: a migration-
    seeded row would be removed by the tests' TRUNCATE and nothing would put it
    back.

    The RETURN VALUE is the read-back, not the fact of having been called: True
    only when every beat in BEATS was found as a row afterwards. That is what
    lets a caller stop asking without claiming a seed it never verified.

    Existing rows are LEFT ALONE — their schedule, their pause, their timezone
    are the operator's. Re-timing the digest when he changes the hour or the
    household zone is a write of its own (S11-6), not a side effect of a
    restart, or resuming a paused beat would be undone by the next deploy.

    Two things stop the seed and SAY so instead of writing a half-right row:
    no owner account yet (a fresh install before registration — the beats are
    his, and 019's CHECK will not take a person-less one), and a stored
    timezone that will not load (the digest hour would be a guess). Both are
    operator state, not code defects, so neither raises and both return False:
    a caller that is still asking will seed them the moment they are fixed.
    """
    owner = await identity.owner(pool)
    if owner is None:
        logger.info(
            "no owner account exists yet — the beats are not seeded; they are seeded on a "
            "later tick, once someone has registered"
        )
        return False
    zone = await _zone(pool)
    if zone is None:
        return False
    specs = {
        WATCH: schedule.validate(WATCH_SCHEDULE),
        DIGEST: await _digest_spec(pool),
        DISTIL: schedule.validate(DISTIL_SCHEDULE),
    }
    seeded: list[str] = []
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock($1)", _SEED_LOCK)
        conversation_id = await _conversation(conn, owner)
        now = await conn.fetchval("SELECT now()")
        for name in BEATS:
            existing = await conn.fetchval(
                "SELECT id FROM timers WHERE kind = $1 AND payload->>'handler' = $2",
                BEAT_KIND,
                name,
            )
            if existing is not None:
                continue
            spec = specs[name]
            await conn.execute(
                "INSERT INTO timers (person_id, kind, title, payload, schedule, timezone, "
                "conversation_id, next_fire_at, created_via) "
                "VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, 'system')",
                owner.id,
                BEAT_KIND,
                BEAT_TITLES[name],
                {"handler": name},
                spec,
                zone,
                conversation_id,
                schedule.next_after(spec, now, zone),
            )
            seeded.append(name)
    # Read back what was claimed: a seed that reported success over a row that
    # is not there is the defect this repo repeats most often.
    handlers = {
        row["handler"]
        for row in await pool.fetch(
            "SELECT payload->>'handler' AS handler FROM timers WHERE kind = $1", BEAT_KIND
        )
    }
    missing = sorted(set(BEATS) - handlers)
    if missing:
        raise RuntimeError(
            f"the beats {', '.join(missing)} are still not rows after seeding them — "
            "something else is deleting them"
        )
    for name in seeded:
        logger.info("seeded beat %r (%s)", name, schedule.describe(specs[name], zone, None))
    return True


async def proactive_off(pool: asyncpg.Pool) -> str | None:
    """None when the engine is ON; otherwise the words a firing states.

    Only JSON `true` is on. Anything else — the default, an explicit false, or
    a value someone wrote straight into the table that is not a boolean at all
    — leaves the engine off, and the sentence SAYS which of those it was: a
    stored "true" (the string) reading as off is exactly the kind of thing that
    must appear on the firing rather than being quietly treated as either
    answer.
    """
    value = await settings_store.read_value(pool, ENABLED_KEY)
    if value is True:
        return None
    if value is False:
        return PROACTIVE_OFF
    return f"{PROACTIVE_OFF} (the stored value is {value!r}, which is neither true nor false)"


def retimes_the_digest() -> tuple[str, str]:
    """The settings the digest beat's next firing is computed FROM: the hour,
    and the zone that hour is read on. `settings_store.write_setting` asks this
    module rather than keeping its own copy of the list, so a key renamed here
    moves the re-time with it.

    A function rather than a constant because the zone's key lives in
    app.tools.timers, which reaches app.timers -> app.scheduler -> this module:
    the same call-time import idiom as _zone, one line lower down.
    """
    from app.tools.timers import TIMEZONE_KEY

    return (DIGEST_AT_KEY, TIMEZONE_KEY)


async def retime_digest(pool: asyncpg.Pool) -> str:
    """Move the digest beat onto the hour the settings NOW say, and say where
    it landed — in words read back from the row that was written.

    This exists because `ensure_beats` leaves existing rows alone on purpose: a
    seed that re-timed on every startup would undo a pause or a hand-set hour
    at the next deploy. So the digest moves when one of `retimes_the_digest()`
    is WRITTEN, from the route that writes it, and never by polling.

    Nothing here raises for operator state. Three answers, each stating which
    it was: the zone will not load (the hour would be a guess, so the row is
    left exactly as it is); there is no digest row yet (a fresh install before
    anyone registered — it is seeded with the new time at the next tick); or it
    moved, and the sentence is `schedule.describe` over the stored row. A
    PAUSED digest is re-timed and said to be paused: the pause is the
    operator's and a setting write is not a resume.
    """
    zone = await _zone(pool)
    if zone is None:
        return (
            "the digest was not re-timed: the stored timezone cannot be used (the log names "
            "it), so its local hour would be a guess — fix nova.timezone and write the hour "
            "again"
        )
    spec = await _digest_spec(pool)
    now = await pool.fetchval("SELECT now()")
    row = await pool.fetchrow(
        "UPDATE timers SET schedule = $1::jsonb, timezone = $2, next_fire_at = $3, "
        "updated_at = now() WHERE kind = $4 AND payload->>'handler' = $5 "
        "RETURNING schedule, timezone, next_fire_at, paused_at",
        spec,
        zone,
        schedule.next_after(spec, now, zone),
        BEAT_KIND,
        DIGEST,
    )
    if row is None:
        return (
            "there is no digest beat row yet, so nothing was re-timed — it is seeded with "
            "this time the first time the scheduler can seed it"
        )
    # The words come from what postgres returned, not from what was sent: a
    # re-time that says where the digest is must be reading the row it moved.
    words = schedule.describe(row["schedule"], row["timezone"], row["next_fire_at"])
    if row["paused_at"] is not None:
        return f"the digest is {words}, but it is paused, so it does not fire until it is resumed"
    return f"the digest is {words}"


# -- the watch beat's own history ----------------------------------------------
#
# Its schedule row and the instants it actually STARTED, with whether each of
# those firings made a PASS. The digest reads them to say how much of the span
# since the last message was really watched. They live here because THIS module
# is where a beat's identity is — `payload.handler`, never a title someone
# could edit — and a copy of that join in another file is a copy that drifts.

# The two keys the watch beat writes about ITSELF, spelled once. `_watch` files
# its WatchResult under `delivery.watch` and `WatchResult.as_delivery()` puts
# the checks that ran under `ran`; both readers below and `_last_pass` compose
# their paths from these, so a rename moves the writer and every reader
# together instead of leaving a query that silently matches nothing.
_WATCH_RECORD = "watch"
_WATCH_RAN = "ran"
_RAN_PATH = f"'{{{_WATCH_RECORD},{_WATCH_RAN}}}'"

# What makes a firing a PASS, in SQL: the beat's own record of itself carries a
# non-empty list of checks that ran.
#
# A ROW is not a pass, and that distinction is the whole point of this fragment
# (2026-09-09). A firing row exists from the moment the scheduler CLAIMS it,
# and several kinds of firing watch nothing at all: `proactive.enabled` false
# returns FIRING_OK having never called a check, a shutdown leaves the row
# `interrupted`, anything that fails before the checks leaves it `error`. Three
# days with the engine switched off would otherwise report "the watch beat ran
# 75 times" — the exact lie this line exists to prevent. `jsonb_typeof` guards
# the length: a record written in some other shape is not a pass either, and it
# must not raise instead of saying so.
_WATCH_PASS = (
    f"jsonb_typeof(f.delivery #> {_RAN_PATH}) = 'array' "
    f"AND jsonb_array_length(f.delivery #> {_RAN_PATH}) > 0"
)

# One SQL fragment, so every reader below selects the same rows from the same
# join and cannot disagree about which timer the watch beat is.
_WATCH_FIRINGS = (
    f"SELECT f.started_at, ({_WATCH_PASS}) AS made_a_pass FROM timer_firings f "
    "JOIN timers t ON t.id = f.timer_id "
    "WHERE t.kind = $1 AND t.payload->>'handler' = $2"
)


@dataclass(frozen=True)
class WatchFiring:
    """One row of the watch beat's history: when it started, and whether that
    firing actually looked at anything.

    Two facts, kept apart on purpose, because the digest says both. `made_a_pass`
    is read off the record the beat writes about itself rather than off the
    firing's status — being claimed, and even finishing OK, is not evidence that
    a check ran.
    """

    started_at: datetime
    made_a_pass: bool


async def watch_row(pool: asyncpg.Pool) -> asyncpg.Record | None:
    """The watch beat's own timer row, or None when it has not been seeded.

    `schedule` and `timezone` give the coverage sentence its yardstick — the
    owner can retime the beat on the Schedules page, so "hourly" is a fact
    about a row and never a constant in this file. `paused_at` and
    `paused_reason` are the CAUSE the loudest version of that sentence names:
    a beat paused after five consecutive failures, or by his own hand, will not
    run again by itself, and saying only that it did not run would leave the
    reason sitting unread in the row.
    """
    return await pool.fetchrow(
        "SELECT id, schedule, timezone, paused_at, paused_reason, next_fire_at FROM timers "
        "WHERE kind = $1 AND payload->>'handler' = $2",
        BEAT_KIND,
        WATCH,
    )


async def watch_firings(
    pool: asyncpg.Pool, *, since: datetime | None = None, until: datetime | None = None
) -> list[WatchFiring]:
    """Every firing of the watch beat in (`since`, `until`], oldest first.

    `started_at`, not `scheduled_for`: coverage is about real time in which
    something was looked at, and a firing that ran nine hours late covered the
    hour it actually ran in, not the hour it was meant for.

    `until` is not decoration. The caller passes the SAME instant it uses as
    the closing boundary of the span, so a firing that begins after the mark —
    the digest's own model round takes minutes, and the watch beat is hourly —
    cannot be counted inside a window that ends before it. Without it the count
    and the boundary disagree, and the trailing gap is understated by exactly
    the time the round took.
    """
    rows = await pool.fetch(
        f"{_WATCH_FIRINGS} AND ($3::timestamptz IS NULL OR f.started_at > $3) "
        "AND ($4::timestamptz IS NULL OR f.started_at <= $4) ORDER BY f.started_at",
        BEAT_KIND,
        WATCH,
        since,
        until,
    )
    return [WatchFiring(row["started_at"], bool(row["made_a_pass"])) for row in rows]


# -- one firing ---------------------------------------------------------------


async def run_beat(app, pool: asyncpg.Pool, row: asyncpg.Record, firing_id, turn: traces.Turn):
    """One beat firing, under a `beat` span named for the beat that ran.

    `turn` is the turn `scheduler._run_firing` already opened (kind `beat`,
    the beats' conversation, the owner, the household zone) — it comes in
    rather than being opened here because the firing row is linked to its
    turn the moment that turn exists, and because one function closes it.
    `firing_id` goes to the runner and is stamped on every notice it records:
    a notice then names both the turn that found it and the firing that ran,
    which is the provenance the Inbox opens.

    An unknown beat name is REFUSED and pauses the row with the reason, the
    same fact an unknown job handler states: nothing else can make that row do
    anything, and re-running it hourly would only write the same refusal 24
    times a day. A beat that RAISES is an error whose reason is the exception
    in words, on the span as well as on the firing — the scheduler would
    otherwise be the only place that says what went wrong, and the trace is
    where anyone looks first.

    The engine's switch is read HERE, where the work starts, so it gates both
    beats through one line rather than each runner remembering to look. A beat
    that fires while `proactive.enabled` is false does nothing at all and says
    so, and the firing is OK: the row did exactly what the configuration says,
    so it is not a failure and must not count toward the pause ceiling — five
    quiet hours would otherwise pause the beats permanently and turning the
    setting on would do nothing. Reading the switch inside the span means a
    database that cannot answer becomes this firing's error, in words, rather
    than a beat that silently decides it is off.
    """
    scheduler = _scheduler()
    payload = row["payload"]
    name = payload["handler"] if "handler" in payload else None
    runner = _RUNNERS.get(name) if isinstance(name, str) else None
    if runner is None:
        reason = f"no beat named {name!r} — the beats are {', '.join(BEATS)}"
        return scheduler.Outcome(scheduler.FIRING_REFUSED, reason, {}, pause_reason=reason)
    with turn.span("beat", name) as span:
        try:
            # Read only for the beats it is about. Distillation writes into his
            # own notes and tells him nothing, so a switch about whether she
            # goes looking and speaks up has no business stopping it.
            off = await proactive_off(pool) if name in GATED_BY_PROACTIVE else None
            if off is not None:
                outcome = scheduler.Outcome(
                    scheduler.FIRING_OK, off, {"beat": name, "proactive": {"enabled": False}}
                )
            else:
                outcome = await runner(app, pool, turn, firing_id)
        except Exception as exc:  # noqa: BLE001 - the reason is the record
            reason = f"the {name} beat failed — {peers.reason(exc)[:300]}"
            span.meta["error"] = reason
            logger.exception("beat %s failed", name)
            return scheduler.Outcome(scheduler.FIRING_ERROR, reason, {"beat": name})
        span.meta["status"] = outcome.status
        if outcome.reason:
            span.meta["reason"] = outcome.reason
    return outcome


async def _say(pool: asyncpg.Pool, turn: traces.Turn, text: str) -> tuple[dict, str | None]:
    """Write one line into the beats' own conversation and say whether it
    landed. Returns the delivery rung and the reason it failed, if it did —
    the same shape and the same vocabulary a reminder's chat rung uses, so the
    Schedules page renders a beat's receipt with the code it already has."""
    if turn.conversation_id is None:
        reason = "the beats have no conversation to write into"
        return {"ok": False, "reason": reason}, reason
    try:
        await chat._persist_assistant(pool, turn.conversation_id, text, turn.id)
    except Exception as exc:  # noqa: BLE001 - the reason is the record
        reason = f"could not write the beat's own record: {peers.reason(exc)}"
        return {"ok": False, "reason": reason}, reason
    return {"ok": True}, None


def _stated(*reasons: str | None) -> str | None:
    """The reasons that were actually given, joined — or None when there were
    none. Never an empty string: a blank reason reads as "no problem", which is
    the silence every verdict in this module refuses to produce."""
    said = [reason for reason in reasons if reason]
    return "; ".join(said) if said else None


def duration_words(gap: timedelta) -> str:
    """A span of time in words: "9h 18m", "45m", "2d 3h".

    ONE rendering, shared by the digest's coverage sentence and the coverage
    check's own title (app/checks/work.py imports it), so the gap he reads
    about in the daily message and the gap on the Inbox row are the same number
    said the same way. Coarse above an hour on purpose — the exact instants are
    in the finding's facts, and a reader of a sentence wants the size.
    """
    seconds = max(0, int(gap.total_seconds()))
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    days, hours = divmod(hours, 24)
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes:02d}m"
    if minutes:
        return f"{minutes}m"
    return f"{seconds}s"


async def _person(pool: asyncpg.Pool, turn: traces.Turn) -> Person | None:
    """The person this beat is FOR, read from the turn the scheduler opened.

    Derived from the row rather than from identity.owner: the beats are the
    owner's by construction (019's `timers_job_has_no_person` CHECK plus
    ensure_beats), and reading the turn means a beat can never deliver to
    somebody other than the person its firing is billed to. None means that
    person is gone, which the callers state rather than paper over — delivery
    to nobody is a failed delivery, not a quiet one.
    """
    if turn.person_id is None:
        return None
    row = await pool.fetchrow("SELECT id, name, role FROM people WHERE id = $1", turn.person_id)
    if row is None:
        return None
    return Person(id=row["id"], name=row["name"], role=row["role"])


# ── the urgent bypass ─────────────────────────────────────────────────────────
#
# The one thing that may interrupt the digest and reach him at any hour. The
# list has EXACTLY ONE entry — the stack being down — declared by the CHECK in
# code (checks.Check.urgent, pinned by tests/test_checks.py), so nothing a model
# writes can promote a finding into a 3am push. Because that list is one item
# and its evidence is a socket rather than a sentence, the volume is bounded by
# the list rather than by a clock.

URGENT_PREFIX = "Urgent"

PUSH_FAILED = "an urgent notice reached nobody"


def _facts_words(facts: dict) -> str:
    """A finding's derived facts, in words, sorted. ONE rendering, shared by
    the urgent sentence and the digest's brief — the two places a fact is shown
    to a human must not be able to describe the same row differently."""
    return ", ".join(f"{key}={value}" for key, value in sorted((facts or {}).items()))


def urgent_line(notice: notices_module.Notice) -> str:
    """The sentence an urgent notice pushes with, composed in CODE.

    The model is never asked for it. The whole point of a one-item urgent list
    is that its findings are verified from a socket rather than from prose, so
    the words are the check's own title, the name of the check that declared
    the urgency, and the derived facts the fingerprint was computed over —
    nothing a model could re-word into a second push (v3 hashed the model's
    text and turned two findings into fourteen phone pushes in eight hours).
    """
    facts = _facts_words(notice.facts)
    detail = f" — {facts}" if facts else ""
    return f"{URGENT_PREFIX} ({notice.check_name}): {notice.title}{detail}"


def wants_push(notice: notices_module.Notice) -> bool:
    """Does this urgent notice still owe him a push?

    DERIVED from the notices store's own definition of what he has not been
    told — `notices.DELIVERABLE_STATES` — never from a second list kept here,
    and deliberately not from `is_new`:

      * a NEW row is `raised`, so it pushes;
      * a fold onto a row whose push FAILED leaves it `failed`, so it pushes
        again — a repeat of something that never landed is not a repeat, and
        `is_new` alone would have suppressed it forever;
      * a fold onto a `delivered` or `seen` row does not push. That is what the
        fold is FOR;
      * a `muted` row does not push. A mute is his own noise preference, and
        identical facts are the same fingerprint whether or not the condition
        blinked off and on in between.

    One predicate, and it moves by itself the day the store's own definition of
    "still owed" moves.
    """
    _checks, notices = _proactive()
    return bool(notice.urgent) and notice.state in notices.DELIVERABLE_STATES


@dataclass(frozen=True)
class Push:
    """One urgent notice's own delivery, and whether anybody was reached.

    `reached` is `Delivered.reached` — the chat row read back — and `reason` is
    every stated failure this push produced, including a delivery that landed
    but could not be written back onto the row. `ok` needs BOTH: a push nobody
    recorded would be pushed again next hour, so it is not a success.
    """

    notice_id: uuid.UUID
    title: str
    reached: bool
    receipt: dict
    reason: str | None = None

    @property
    def ok(self) -> bool:
        return self.reached and self.reason is None

    def as_record(self) -> dict:
        """What the firing stores about this push — the notice it was about,
        the channel receipts, and the reason when there is one."""
        record: dict = {
            "notice": str(self.notice_id),
            "title": self.title,
            "reached": self.reached,
            "receipt": self.receipt,
        }
        if self.reason is not None:
            record["reason"] = self.reason
        return record


async def _record_push(
    pool: asyncpg.Pool,
    notice_id: uuid.UUID,
    *,
    reached: bool,
    receipt: dict,
    reason: str | None,
) -> str | None:
    """Write the channel's own verdict back onto the notice. Returns the reason
    it could not be written, if it could not.

    Never swallowed: a push that went out and was not recorded stays
    deliverable and goes out again next hour, which is a fact the beat has to
    state rather than discover later.
    """
    _checks, notices = _proactive()
    try:
        if reached:
            await notices.mark_delivered(pool, notice_id, delivery=receipt)
        else:
            await notices.mark_failed(pool, notice_id, reason or "the delivery stated no reason")
    except Exception as exc:  # noqa: BLE001 - the reason is the record
        logger.exception("the urgent push for notice %s could not be recorded", notice_id)
        return (
            f"the push for notice {notice_id} could not be recorded onto the row — "
            f"{peers.reason(exc)}"
        )
    return None


async def _push_urgent(
    app, pool: asyncpg.Pool, turn: traces.Turn, person: Person | None, notice
) -> Push:
    """Deliver ONE urgent notice now, at whatever hour it is.

    Chat always, and a device too because `urgent=True` — the ladder decides
    per channel what "delivered" means, and this function decides nothing about
    it. Nothing here raises: a check that ran must not lose its result because
    a socket was shut, so every failure comes back as a Push whose `reason` the
    watch beat states on its firing.
    """
    delivery = _delivery()
    with turn.span("urgent", notice.check_name) as span:
        span.meta["notice"] = str(notice.id)
        span.meta["fingerprint"] = notice.fingerprint
        span.meta["state_before"] = notice.state
        try:
            result = await delivery.deliver(
                app, pool, text=urgent_line(notice), urgent=True, person=person, turn=turn
            )
        except Exception as exc:  # noqa: BLE001 - the reason is the record
            reason = f"the urgent push could not be made — {peers.reason(exc)[:300]}"
            span.meta["error"] = reason
            logger.exception("the urgent push for notice %s could not be made", notice.id)
            noted = await _record_push(pool, notice.id, reached=False, receipt={}, reason=reason)
            return Push(notice.id, notice.title, False, {}, _stated(reason, noted))
        span.meta["reached"] = result.reached
        noted = await _record_push(
            pool, notice.id, reached=result.reached, receipt=result.receipt, reason=result.reason
        )
        if noted is not None:
            span.meta["record_error"] = noted
        return Push(
            notice.id,
            notice.title,
            result.reached,
            result.receipt,
            _stated(result.reason, noted),
        )


@dataclass(frozen=True)
class WatchResult:
    """What one watch beat actually did: the checks' own results, plus what
    writing them down produced. Nothing here is a claim — every field is
    counted from an outcome, and `quiet` is `checks.quiet`'s answer rather
    than a flag anyone set.

    `runs` are the EFFECTIVE runs. A check that ran but whose findings could
    not be written down is demoted to `ran=False` with that reason before it
    gets here: it watched the world and told nobody, so it is not evidence of
    anything, it must not make the beat read quiet, and above all it must not
    reconcile — clearing on fingerprints we failed to store would mark a
    still-true condition finished.
    """

    runs: tuple[checks.CheckRun, ...]
    # checks.quiet's answer and, when it is False, its words. ONE computation
    # of quiet in the codebase, and it lives beside the check registry.
    quiet: bool
    not_quiet: str | None
    new: int
    folded: int
    cleared: int
    # Every urgent notice this beat tried to push, in the order it tried. An
    # ATTEMPT list, not a success list — `pushed` and `push_failed` are counted
    # off each one's own verdict below, so the record can never say a push
    # landed because it was made.
    pushes: tuple[Push, ...] = ()

    @property
    def pushed(self) -> int:
        return sum(1 for push in self.pushes if push.ok)

    @property
    def push_failed(self) -> int:
        return sum(1 for push in self.pushes if not push.ok)

    @property
    def push_failure(self) -> str | None:
        """Every stated reason a push did not land, or None."""
        return _stated(*(push.reason for push in self.pushes))

    @property
    def total(self) -> int:
        """Every check this beat had a result for — the registry's whole set,
        counted from the runs rather than from the registry, so the number in
        the sentence is the number that was actually asked."""
        return len(self.runs)

    @property
    def ran(self) -> tuple[str, ...]:
        return tuple(run.check for run in self.runs if run.ran)

    @property
    def could_not(self) -> tuple[tuple[str, str], ...]:
        return tuple(
            (run.check, run.reason or "no reason stated") for run in self.runs if not run.ran
        )

    @property
    def findings(self) -> int:
        """Findings that were WRITTEN DOWN. A demoted run carries none, so this
        can never count a finding no notice holds."""
        return sum(len(run.findings) for run in self.runs if run.ran)

    @property
    def complete(self) -> bool:
        return not self.could_not

    def as_delivery(self) -> dict:
        """The firing's own record of the beat, in the numbers the sentence was
        composed from — jsonb, so anyone reading `timer_firings.delivery` sees
        exactly what the line claims."""
        return {
            # The key the digest's coverage query reads a PASS out of, spelled
            # once beside the join that reads it (2026-09-09).
            _WATCH_RAN: list(self.ran),
            "could_not": dict(self.could_not),
            "findings": self.findings,
            "new": self.new,
            "folded": self.folded,
            "cleared": self.cleared,
            "quiet": self.quiet,
            # Counted from each Push's own verdict, so a beat can never record
            # a push it only attempted. Both numbers are always present: a
            # missing key would read as "none failed" and as "we never looked",
            # which are different facts.
            "pushed": self.pushed,
            "push_failed": self.push_failed,
        }


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def watch_line(result: WatchResult) -> str:
    """The watch beat's own sentence, composed in CODE from what happened.

    Never written by a model and never a fixed string: the numbers are the
    outcome's and the words are chosen by which of them are true. QUIET is
    said only when `checks.quiet` says so — every check ran and none flagged —
    and when it does not, its reason is quoted rather than paraphrased, so the
    line names every check that watched nothing and why. That is the whole
    point of this slice: a beat that CHECKED nothing must never read like a
    beat that FOUND nothing.
    """
    if result.quiet:
        parts = [f"all {_plural(result.total, 'check')} ran and none flagged — quiet."]
    else:
        parts = [
            f"{len(result.ran)} of {result.total} checks ran, and this beat is not quiet: "
            f"{result.not_quiet}."
        ]
    if result.findings:
        parts.append(
            f"Of {_plural(result.findings, 'finding')}, {result.new} new and "
            f"{result.folded} folded onto a notice already raised."
        )
    if result.cleared:
        parts.append(f"{_plural(result.cleared, 'notice')} cleared: those conditions ended.")
    # Said every time, because this beat's honesty depends on it. The watch
    # beat delivers nothing EXCEPT the one urgent family, and which of those
    # two happened is counted, never assumed: a beat that pushed says how many
    # went out and how many reached nobody, and a beat that pushed nothing says
    # so in the same sentence it always did.
    if result.pushes:
        said = []
        if result.pushed:
            said.append(f"{_plural(result.pushed, 'urgent notice')} went out immediately")
        if result.push_failed:
            said.append(f"{_plural(result.push_failed, 'urgent notice')} reached nobody")
        parts.append(" and ".join(said) + " — everything else waits for the digest.")
    else:
        parts.append("Nothing was delivered — the digest is what reaches him.")
    return "Watch beat: " + " ".join(parts)


async def _record_check(
    app,
    pool: asyncpg.Pool,
    turn: traces.Turn,
    firing_id,
    run: checks.CheckRun,
    person: Person | None,
) -> tuple[int, int, int, list[Push]]:
    """Write down what one check found, push the urgent ones now, then clear
    what it no longer finds. Returns (new, folded, cleared, pushes).

    THE URGENT BYPASS happens here, one row at a time, the moment the row
    exists — before the reconcile, before the beat's own line, and without
    waiting for the digest. The condition is `wants_push`, derived from the row
    postgres just wrote: urgency comes from the check family in code and
    "still owed" comes from the notices store's own state set, so nothing this
    function decides can promote a finding or suppress one it never delivered.

    RECONCILING is the other half of folding, and it happens only for a check
    that RAN: every live notice of this check whose fingerprint is not among
    this beat's findings has stopped being true, so it is cleared and its
    fingerprint is free to be NEWS again if it comes back. Without it, "one
    live row per fingerprint" would mean "tell him once, ever" — a thing that
    was fixed and broke again would fold onto a week-old row and he would
    never hear. A check that did not run clears nothing: a probe that could
    not be made has watched nothing. (notices.reconcile refuses an
    unregistered name; THIS side of that line — never calling it for a check
    that did not run — is the caller's, and it is the `continue` in
    _run_checks.)

    `turn_id` and `firing_id` are stamped on every notice this writes, so a
    row always names the beat turn that found it AND the firing that ran —
    both survive the turn being swept (ON DELETE SET NULL).
    """
    _checks, notices = _proactive()
    live: list[str] = []
    pushes: list[Push] = []
    new = 0
    for finding in run.findings:
        notice, is_new = await notices.record(
            pool, finding, check_name=run.check, turn_id=turn.id, firing_id=firing_id
        )
        # The fingerprint READ BACK from the row postgres wrote, not one
        # computed here — what is cleared has to be decided against what is
        # actually stored.
        live.append(notice.fingerprint)
        new += 1 if is_new else 0
        if wants_push(notice):
            pushes.append(await _push_urgent(app, pool, turn, person, notice))
    cleared = await notices.reconcile(pool, check_name=run.check, live_fingerprints=set(live))
    return new, len(live) - new, len(cleared), pushes


async def _run_checks(
    app, pool: asyncpg.Pool, turn: traces.Turn, firing_id, person: Person | None
) -> WatchResult:
    """Run every registered check, write down what they found, push the urgent
    ones, clear what they no longer find, and count all of it.

    Nothing a check can do raises out of here: `checks.run_all` already turns
    every failure into ran=False with the reason in words, and a check whose
    notices could not be written is DEMOTED to the same shape with the reason
    for that — so one broken write costs that check's result and not the other
    eleven checks' records. A PUSH that fails is not one of those: _push_urgent
    never raises, so a shut socket costs the delivery and never the check's
    result — the check watched the world correctly, and saying otherwise would
    make the beat reconcile nothing on a fact it did establish.
    """
    checks, _notices = _proactive()
    effective: list[checks.CheckRun] = []
    pushes: list[Push] = []
    new = folded = cleared = 0
    with turn.span("checks", "run_all") as span:
        for run in await checks.run_all(app, pool):
            if not run.ran:
                effective.append(run)
                continue
            try:
                run_new, run_folded, run_cleared, run_pushes = await _record_check(
                    app, pool, turn, firing_id, run, person
                )
            except Exception as exc:  # noqa: BLE001 - the reason is the record
                logger.exception("the %s check's findings could not be recorded", run.check)
                effective.append(
                    replace(
                        run,
                        ran=False,
                        reason=f"it ran, but its findings could not be written down — "
                        f"{peers.reason(exc)}",
                        findings=(),
                    )
                )
                continue
            effective.append(run)
            new += run_new
            folded += run_folded
            cleared += run_cleared
            pushes.extend(run_pushes)
        runs = tuple(effective)
        # ONE computation of quiet, and it lives beside the registry: every
        # check ran and none flagged, and an empty run is not vacuously quiet.
        is_quiet, why = checks.quiet(runs)
        result = WatchResult(
            runs=runs,
            quiet=is_quiet,
            not_quiet=why,
            new=new,
            folded=folded,
            cleared=cleared,
            pushes=tuple(pushes),
        )
        # Inside the span, not after it: the trace is where anyone looks first,
        # and these are the same numbers the sentence is composed from.
        span.meta.update(result.as_delivery())
    return result


NOTHING_RAN = "no check ran, so this beat watched nothing — that is a broken beat, not a quiet one"


async def _watch(app, pool: asyncpg.Pool, turn: traces.Turn, firing_id):
    """The hourly beat: run every registered check, write down what they found,
    and push the ONE urgent family immediately.

    Everything else it finds DELIVERS NOTHING. No chat message he sees, no
    device: that is the digest, written on purpose at an hour he set. The
    exception is the urgent family — the stack being down, the only entry on
    the list Jeremy set — which goes out the moment its row exists, at any
    hour, with a sentence composed in code from the check's own title and
    facts. What lands in the beats' own inactive conversation either way is the
    beat's own line, saying what ran, what could not, what was recorded or
    cleared, and what went out.

    Four verdicts, and they are different facts:

      * OK and quiet — every check ran, every finding was written down, and
        nothing was flagged.
      * OK and INCOMPLETE — some check could not run. The line names each one
        and why, and says it is not an all-clear. NOT an error: a check that
        cannot run is usually the operator's world (an unconfigured link, too
        little history to compute a mean), and five of those in a row must not
        pause the one timer whose job is to keep watching.
      * ERROR — an urgent push reached nobody. The one family that may wake him
        did not, and that shows red rather than sitting inside a receipt: the
        notice is marked failed, so it goes out again on the next sighting and
        the digest still owes it to him, but the firing does not read ok. (A
        chat rung that fails is core refusing writes, which fails this beat's
        own record on the next line anyway.)
      * ERROR — the beat's own record could not be written, or NO check ran at
        all. Both mean this beat is not evidence of anything.
    """
    scheduler = _scheduler()
    # Loaded once, before the checks: an urgent finding is delivered inside the
    # run and every push is for the same person, so reading it twelve times
    # would only give twelve chances to disagree with itself.
    person = await _person(pool, turn)
    result = await _run_checks(app, pool, turn, firing_id, person)
    rung, failure = await _say(pool, turn, watch_line(result))
    delivery = {"beat": WATCH, "chat": rung, _WATCH_RECORD: result.as_delivery()}
    if result.pushes:
        # Only when something was actually pushed. An empty list would read as
        # "we looked and found nothing to push", which is a different fact from
        # a beat that had no urgent finding at all.
        delivery["urgent"] = [push.as_record() for push in result.pushes]
    if failure is not None:
        return scheduler.Outcome(scheduler.FIRING_ERROR, failure, delivery)
    if not result.ran:
        return scheduler.Outcome(
            scheduler.FIRING_ERROR, f"{NOTHING_RAN}: {result.not_quiet}", delivery
        )
    push_failure = result.push_failure
    if push_failure is not None:
        return scheduler.Outcome(scheduler.FIRING_ERROR, f"{PUSH_FAILED}: {push_failure}", delivery)
    if result.complete:
        return scheduler.Outcome(scheduler.FIRING_OK, None, delivery)
    # An OK firing that still carries a reason: the beat did its work and the
    # record says which checks watched nothing, so nobody reading the firing
    # can mistake an incomplete beat for a clean one.
    return scheduler.Outcome(
        scheduler.FIRING_OK,
        f"{len(result.ran)} of {result.total} checks ran: "
        + "; ".join(f"{name} — {why}" for name, why in result.could_not),
        delivery,
    )


# ── the digest ────────────────────────────────────────────────────────────────
#
# ONE message a day, unless something urgent already went out. It is the only
# place a beat speaks on purpose, and the only place a beat asks a model for
# words: the sentence he reads is prose, and prose about a machine is exactly
# what needs a model — but every FACT in it comes from a brief this file
# composes out of rows, and every claim in the reply is checked back against
# those rows before it is delivered.
#
# The one thing this beat may never be is the vehicle for an urgent notice. It
# cannot be: an urgent notice that went out is `delivered`, and
# notices.deliverable() reads only what is still owed. One that FAILED is still
# owed, and lands here — which is the whole reason `failed` is a deliverable
# state rather than a finished one.

# What the beat says in its own conversation on a day with nothing to tell him.
# Code-composed, like every other beat line: no model is asked, because there is
# nothing to write about.
DIGEST_NOTHING_NOTE = "no notice was waiting to be delivered, so nothing was sent"
DIGEST_NOTHING = (
    # Says only what notices.deliverable() actually computed. "Everything was
    # delivered or cleared" would be the wider claim and a false one — a muted
    # row is neither, and it is excluded from that query too.
    "Digest beat: no notice is waiting to be delivered — nothing stands that he has not been "
    "told about, and no failed delivery is still owed — so nothing was sent. He hears from "
    "this beat on the days there is something to hear."
)

# A digest with nobody to write to. Stated BEFORE the model is asked, so a
# message that cannot be delivered is never paid for.
DIGEST_NO_PERSON = (
    "the person this beat belongs to no longer exists, so there is nobody to write the "
    "digest to — nothing was composed and nothing was sent"
)

# The structural detector's verdict (guards.model_wrote_nothing): every llm_call
# span of this turn reports zero completion characters, so the text was composed
# by the backend and not by the model. v3 pushed exactly that — its harness's own
# "this turn produced no reply" line — to a phone as news and recorded a success.
DIGEST_NOT_WRITTEN = (
    "the model wrote nothing this turn, so there is no digest to deliver — the text a beat "
    "sends has to be text a model actually wrote"
)
DIGEST_NO_TEXT = "the round came back with no words in it, so there was nothing to deliver"

# How many cleared notices the brief may carry, and how many delivered titles
# the delivery guard is judged against. Bounds, not filters: what is left out is
# COUNTED and said in the brief, never dropped silently.
DIGEST_CLEARED_LIMIT = 20
DIGEST_DELIVERED_LIMIT = 200

# How many STILL STANDING notices the digest's code-composed tail may name.
# Same rule as the two above: a bound, not a filter — what is left out is
# counted in the same sentence and stays in the Inbox.
DIGEST_STANDING_LIMIT = 10

# The two code-composed lines the backend appends UNDER whatever the model
# wrote. The model writes the prose; these are the facts, and neither can
# overstate the other — the delegate facts-line idiom, in the one message a
# day.
#
# COVERAGE goes out every time, on a good day as loudly as on a bad one. It is
# provenance, and it exists because of the night of 2026-09-09: the host slept
# from 02:00 to 11:23 UTC, the hourly watch beat ran twice in twelve hours, and
# nothing lied — the firing history recorded the gap exactly — but a digest
# composed only from findings would have reported them without ever saying that
# nothing had been watched for nine of those hours. A reader assumes the hourly
# cover he was promised. "All quiet" must never be able to mean "I was not
# there", so the sentence that says how much was watched is not conditional on
# there being bad news.
COVERAGE_PREFIX = "Coverage:"

# How wide a hole in the watching is worth breaking a quiet day's silence for,
# as a multiple of the beat's OWN interval. One missed pass spans two
# intervals and a late tick barely more than one, so three means at least two
# consecutive passes did not happen.
#
# This exists because of a live miss (2026-09-10). `unproven` counted only
# three states — no pass at all, paused, unreadable — so nine passes with an
# eleven-hour hole in the middle read as a watched day and the digest said
# nothing. A real outage had happened inside that hole: ollama went
# unreachable at 00:32, both models walled, and the next pass was eleven hours
# later by which time it had recovered. His machine sleeps every night, so
# that is not a rare shape, it is the ordinary one — and "some passes
# happened" was standing in for "the span was watched".
GAP_MULTIPLE = 3
# How many firings ahead to ask the schedule for. The widest spacing among
# them is the expectation, so an irregular shape (weekdays only, the first of
# the month) is judged against its own widest ordinary gap rather than its
# average.
INTERVAL_SAMPLES = 8


def _expected_interval(row) -> timedelta | None:
    """How long the watch beat's own schedule says it goes between firings.

    DERIVED by asking the schedule for its next several firings, never a
    hardcoded "hourly": the owner can retime the beat on the Schedules page
    and the yardstick has to move with it. A schedule that cannot be read, or
    one that fires once and never again, has no interval and the gap is then
    reported without a judgement rather than judged against a guess.
    """
    if row is None:
        return None
    try:
        spec, zone = row["schedule"], row["timezone"]
        at = datetime.now(UTC)
        firings = []
        for _ in range(INTERVAL_SAMPLES):
            at = schedule.next_after(spec, at, zone)
            if at is None:
                break
            firings.append(at)
    except Exception:  # noqa: BLE001 — no yardstick is a stated absence, not a crash
        return None
    if len(firings) < 2:
        return None
    return max(
        (later - earlier for earlier, later in zip(firings, firings[1:], strict=False)),
        default=None,
    )


COVERAGE_UNREADABLE = (
    f"{COVERAGE_PREFIX} the watch beat's own firing history could not be read, so this message "
    "cannot say how much of the time since the last digest was actually watched"
)
COVERAGE_NOTHING = (
    f"{COVERAGE_PREFIX} the watch beat has no firing on record at all, so nothing above was "
    "watched by it — this is not an all-clear."
)
NOT_AN_ALL_CLEAR = "so nothing above was watched in that time — this is not an all-clear."

# The one thing that can make a QUIET day speak (2026-09-09). Nothing owed and
# nothing watched are the same silence from the outside, and the day the watch
# beat stops is the day the difference matters most — a paused beat raises
# nothing new, deliverable() empties, and every digest after that writes
# nothing at all, forever, with no check able to notice because checks run only
# from that beat. So on a day with nothing to report AND nothing to show for
# the watching, the digest sends this and the coverage line under it. Composed
# in code, no model asked: there is nothing to write about, and the whole point
# of the sentence is that a model had no hand in it.
DIGEST_UNWATCHED = (
    "Nothing is waiting to be delivered. On any other day that would be the whole of it and "
    "you would hear nothing at all — you are hearing this because there is nothing to show "
    "that anything was WATCHED either, so today's quiet is not evidence that anything is fine."
)
DIGEST_UNWATCHED_NOTE = (
    "no notice was waiting to be delivered, and nothing showed that the watch beat made a pass "
    "over the span either, so the coverage line went out on its own"
)
# The other quiet day that has to speak (2026-09-10): the beat DID run, so
# every sentence above would be false, but it left a hole wide enough that the
# quiet only covers part of the span.
DIGEST_PARTLY_WATCHED = (
    "Nothing is waiting to be delivered. You are hearing this anyway because there was a "
    "stretch in which nothing was watched at all, so today's quiet covers only the part of "
    "the day I was actually looking at."
)
DIGEST_PARTLY_WATCHED_NOTE = (
    "no notice was waiting to be delivered, but the watch beat left a gap wide enough that the "
    "quiet covers only part of the span, so the coverage line went out on its own"
)

STANDING_PREFIX = "Still standing, already reported and not repeated here:"
STANDING_WHY = "They stay in the Inbox until they clear."
STANDING_UNREADABLE = (
    "What is still standing from earlier digests could not be read, so this message cannot name it"
)

DIGEST_SYSTEM = (
    "You are Nova, writing the one proactive message you send the owner each day. You have "
    "no tools this turn and nothing was looked up for you: the brief below is the whole of "
    "what you know. Report it — do not investigate it, do not offer to do anything, and do "
    "not ask a question. He reads this hours after you write it."
)

DIGEST_ASK = (
    "Write ONE short message to {name}: a few sentences of plain prose, no heading, no list, "
    "no greeting and no sign-off. Say what is standing, how long each thing has been true, "
    "and what you did about it. Say nothing this brief does not state — every claim in your "
    "reply is checked mechanically against these rows, and a correction is appended to the "
    "message he actually reads if one does not hold."
)


def digest_brief(
    *,
    name: str,
    outstanding: Sequence,
    cleared: Sequence,
    cleared_more: int,
    runs: Sequence,
    now: datetime,
    zone: str,
    notes: Sequence[str],
) -> str:
    """The model's whole input, composed HERE out of rows.

    Nothing in it is a sentence anybody wrote about the world: each finding is
    the check's own title beside the derived facts the fingerprint was computed
    over, its sighting count, and — when she acted — the note her own turn
    recorded. The cleared list is rows too, which is what lets the digest say
    what got better rather than only what is wrong.

    `notes` are the reads that FAILED. They go into the brief rather than being
    swallowed, because a digest composed over a partial view must be able to say
    so; and they go into the firing's record as well.
    """
    lines = [
        f"[Digest beat — the one message a day. Local time now: "
        f"{schedule.local_words(now, zone)}.]",
        "",
        "Everything below was read from the notices store by the backend. It is the whole of "
        "what you know this turn.",
        "",
        f"STANDING ({len(outstanding)}), oldest first — he has not been told about these:",
    ]
    _checks, notices = _proactive()
    for index, notice in enumerate(outstanding, start=1):
        lines.append(f"{index}. {notice.title}")
        lines.append(f"   found by the {notice.check_name} check (key {notice.finding_key})")
        facts = _facts_words(notice.facts)
        if facts:
            lines.append(f"   facts: {facts}")
        lines.append(
            f"   seen {notice.repeats} time(s); first "
            f"{schedule.local_words(notice.first_seen_at, zone)}, last "
            f"{schedule.local_words(notice.last_seen_at, zone)}"
        )
        if notice.acted and notice.acted_note:
            lines.append(f"   what you did about it: {notice.acted_note}")
        else:
            lines.append("   you have not acted on this")
        if notice.state == notices.FAILED and notice.failed_reason:
            lines.append(f"   an earlier delivery of this reached nobody: {notice.failed_reason}")
    if cleared:
        lines.append("")
        lines.append(f"CLEARED since the last digest that reached him ({len(cleared)}):")
        for row in cleared:
            lines.append(
                f"   {row['title']} (the {row['check_name']} check; cleared "
                f"{schedule.local_words(row['cleared_at'], zone)})"
            )
        if cleared_more:
            lines.append(f"   and {cleared_more} more, not listed here")
    ran = [run.check for run in runs if run.ran]
    could_not = [(run.check, run.reason or "no reason stated") for run in runs if not run.ran]
    lines.append("")
    lines.append(f"THE LAST WATCH PASS: {len(ran)} of {len(runs)} checks ran.")
    for check_name, reason in could_not:
        lines.append(
            f"   {check_name} could not run — {reason}. Nothing was verified about what it "
            "watches, so this is not an all-clear."
        )
    for note in notes:
        lines.append("")
        lines.append(f"NOT READ: {note}")
    lines.append("")
    lines.append(DIGEST_ASK.format(name=name))
    return "\n".join(lines)


async def _notice_cap(pool: asyncpg.Pool) -> int:
    """How many notices one digest may carry: the setting, or the def's own
    default when the stored value cannot be used.

    Same shape as _digest_spec one screen up — an operator value that will not
    do is SAID in the log and the default stands. A cap of zero read literally
    would compose a message about nothing while the notices piled up unread,
    which looks exactly like a quiet day; the setting's own validator refuses
    that at the write, and this is the second half of the same rule for a value
    that reached the table another way.
    """
    definition = settings_store.DEFS_BY_KEY[MAX_NOTICES_KEY]
    value = await settings_store.read_value(pool, MAX_NOTICES_KEY)
    if type(value) is int:
        problem = definition.validate(value)
        if problem is None:
            return value
    else:
        problem = f"it is a {type(value).__name__}, not a whole number"
    logger.warning(
        "%s is %r — %s; this digest carries at most %s",
        MAX_NOTICES_KEY,
        value,
        problem,
        definition.default,
    )
    return definition.default


async def _owed_today(pool: asyncpg.Pool, notices) -> tuple[list, int]:
    """What this digest reports, and how many findings it HELD BACK.

    The backstop under "one message a day": a night when fifty things break
    still produces a message rather than a log. Nothing is dropped — the rows
    beyond the cap are not marked delivered, so they stay deliverable and the
    next digest owes them to him — and the number is recorded on the firing,
    because suppression here is countable or it is silence.

    deliverable() is oldest first, so what is kept is what has been standing
    longest and what waits is the newest.
    """
    owed = await notices.deliverable(pool)
    cap = await _notice_cap(pool)
    return owed[:cap], max(0, len(owed) - cap)


async def _last_digest_at(pool: asyncpg.Pool, firing_id) -> datetime | None:
    """When the last digest that REACHED him started, or None when none has.

    "The last digest" is derived from the record a digest writes about itself —
    `delivery.digest.delivered`, which is `Delivered.reached`, which is the chat
    row read back. Not from the last firing (a digest that failed told him
    nothing, so its window is still owed) and not from the last time anything
    was delivered (an urgent push is one sentence about the stack and says
    nothing about what cleared). With no such firing yet, the window is
    everything: he has never been told anything.

    ONE definition of "since the last digest", because two readers now use it —
    what has cleared, and how much of the span was watched — and a message
    whose two halves counted from different instants would be worse than
    either half alone.
    """
    if firing_id is None:
        return None
    return await pool.fetchval(
        "SELECT max(started_at) FROM timer_firings "
        "WHERE timer_id = (SELECT timer_id FROM timer_firings WHERE id = $1) "
        "AND id <> $1 AND (delivery #>> '{digest,delivered}') = 'true'",
        firing_id,
    )


async def _cleared_since(pool: asyncpg.Pool, firing_id) -> tuple[list, int]:
    """The notices whose condition ended since the last digest that REACHED
    him, most recent first, and how many more there were than the brief carries.

    The overflow is COUNTED, not inferred from the page (2026-09-09): fetching
    one row past the limit and subtracting saturates at 1, so a night when
    thirty conditions ended would have read "and 1 more".
    """
    since = await _last_digest_at(pool, firing_id)
    where = "cleared_at IS NOT NULL AND ($1::timestamptz IS NULL OR cleared_at > $1)"
    total = await pool.fetchval(f"SELECT count(*) FROM notices WHERE {where}", since)
    rows = await pool.fetch(
        f"SELECT title, check_name, cleared_at FROM notices WHERE {where} "
        "ORDER BY cleared_at DESC LIMIT $2",
        since,
        DIGEST_CLEARED_LIMIT,
    )
    return list(rows), max(int(total) - len(rows), 0)


async def _last_pass(pool: asyncpg.Pool, outstanding: Sequence) -> tuple[tuple, str | None]:
    """The CheckRuns the digest's observation guard judges an all-clear against,
    rebuilt from two live records rather than from a memory of them.

    The last watch firing's own `delivery.watch` says which checks ran and which
    could not, with the reason each stated; the outstanding notices say what was
    found. `checks.quiet` over the result is therefore the SAME computation the
    watch beat used, so a digest that writes "everything looks fine" while three
    probes could not be made is contradicted by the beat's own arithmetic and
    not by a phrase list. Returns the runs and, when the record could not be
    read, the reason — the digest still goes out, and it goes out SAYING the
    pass could not be read.
    """
    checks, _notices = _proactive()
    by_check: dict[str, list] = {}
    for notice in outstanding:
        by_check.setdefault(notice.check_name, []).append(
            checks.Finding(key=notice.finding_key, title=notice.title, facts=notice.facts)
        )
    watch: dict = {}
    note: str | None = None
    try:
        row = await pool.fetchrow(
            f"SELECT f.delivery -> '{_WATCH_RECORD}' AS watch FROM timer_firings f "
            "JOIN timers t ON t.id = f.timer_id "
            f"WHERE t.kind = $1 AND t.payload->>'handler' = $2 AND f.delivery ? '{_WATCH_RECORD}' "
            "ORDER BY f.started_at DESC LIMIT 1",
            BEAT_KIND,
            WATCH,
        )
        if row is not None and isinstance(row["watch"], dict):
            watch = row["watch"]
    except Exception as exc:  # noqa: BLE001 - the reason is the record
        logger.exception("the last watch pass could not be read for the digest")
        note = (
            "the last watch pass could not be read, so this digest cannot say which checks "
            f"ran — {peers.reason(exc)}"
        )
    could_not = watch.get("could_not") if isinstance(watch.get("could_not"), dict) else {}
    ran = watch.get(_WATCH_RAN) if isinstance(watch.get(_WATCH_RAN), list) else []
    runs = [
        checks.CheckRun(check=name, ran=True, reason=None, findings=tuple(by_check.get(name, ())))
        for name in sorted((set(ran) | set(by_check)) - set(could_not))
    ]
    runs.extend(
        checks.CheckRun(check=name, ran=False, reason=str(reason))
        for name, reason in sorted(could_not.items())
    )
    return tuple(runs), note


async def _delivered_titles(pool: asyncpg.Pool) -> tuple[list[str], str | None]:
    """The titles of everything he HAS been told about — the delivery guard's
    one fact source, and the only one that lives outside this turn.

    Fails open with the failure recorded: an unreadable table must not silence
    a digest, and it must not silently disarm a guard either, so the reason
    comes back and is stated on the firing.
    """
    _checks, notices = _proactive()
    try:
        rows = await pool.fetch(
            "SELECT title FROM notices WHERE state = ANY($1::text[]) "
            "ORDER BY last_seen_at DESC LIMIT $2",
            [notices.DELIVERED, notices.SEEN],
            DIGEST_DELIVERED_LIMIT,
        )
    except Exception as exc:  # noqa: BLE001 - the reason is the record
        logger.exception("the delivered notices could not be read for the digest")
        return [], (
            "what has already been delivered could not be read, so an 'I already told you' "
            f"in this message was not checked — {peers.reason(exc)}"
        )
    return [row["title"] for row in rows], None


# ── the two facts lines the backend appends ──────────────────────────────────


@dataclass(frozen=True)
class Coverage:
    """How much of the span since the last digest the watch beat actually
    covered, counted from its own firing rows.

    Two numbers, and keeping them apart is the point (2026-09-09). `firings` is
    how many times the beat STARTED; `passes` is how many of those firings ran
    a check. They are usually the same and when they are not the difference is
    the news: the engine's switch being off returns FIRING_OK having never
    called a check, a shutdown leaves the row `interrupted`, a failure before
    the checks leaves it `error`. A line counting rows alone would report "the
    watch beat ran 75 times" over three days with the engine off — the exact
    lie this sentence exists to prevent — so the sentence states both numbers
    rather than quietly reporting the smaller one.

    `longest_gap` is the widest stretch inside the span in which no PASS was
    made, measured over the boundaries [window start, every pass, the mark], so
    a span with one pass at its very beginning reports the twenty-three hours
    after it rather than "no gap".

    `paused_at`/`paused_reason` come off the watch beat's own timer row. A
    paused beat will not run again by itself, so the sentence that says nothing
    was watched carries WHY in the same breath: the cause is already in the row
    and leaving it there would make the loudest line in the message the least
    useful one.

    `unreadable` is the honest empty state. When the history could not be read
    this says so in the message and on the firing; it never falls back to a
    number nobody counted, because a coverage sentence that reads well and was
    not computed is worse than no sentence at all.
    """

    firings: int
    passes: int
    # The instant the span starts at: the last digest that reached him, or —
    # when there has never been one — the beat's first firing on record. Which
    # of the two it was is `from_a_digest`, because they mean different things
    # to a reader and the sentence says which.
    window_start: datetime | None
    from_a_digest: bool
    longest_gap: timedelta | None
    paused_at: datetime | None = None
    paused_reason: str | None = None
    # schedule.describe over the watch beat's own row ("every hour at :05
    # America/New_York"), so the gap has a yardstick beside it. A stored zone
    # that no longer loads leaves this None and states why in `schedule_note`
    # rather than quietly dropping the clause.
    schedule_words: str | None = None
    schedule_note: str | None = None
    # The beat's own interval, derived from its schedule (see
    # _expected_interval). It is the yardstick `blind_spell` measures the
    # longest gap against; None means there is no yardstick, and a gap is then
    # reported without a judgement rather than judged against a guess.
    expected_interval: timedelta | None = None
    unreadable: str | None = None

    @property
    def blind_spell(self) -> timedelta | None:
        """The stretch nobody watched, when it is wide enough to be news.

        A gap of one interval is a late tick. `GAP_MULTIPLE` of them means at
        least two consecutive passes did not happen, which on an hourly beat
        is hours of the day in which anything could have broken and recovered
        unseen — and did, on 2026-09-10.
        """
        if self.longest_gap is None or self.expected_interval is None:
            return None
        if self.expected_interval <= timedelta(0):
            return None
        if self.longest_gap < self.expected_interval * GAP_MULTIPLE:
            return None
        return self.longest_gap

    @property
    def unproven(self) -> bool:
        """Is this span one that CANNOT be shown to have been watched?

        FOUR ways, and the digest speaks on any of them even on a day with
        nothing else to say: no pass was made, the beat is paused (so no pass
        will be made), the history could not be read at all — never reporting
        full coverage for a history nobody could count is the same rule as the
        unreadable line itself — or a `blind_spell`, a hole wide enough that
        the span was only partly watched.

        The fourth was added on 2026-09-10 after it was missed live. The other
        three all mean "nothing was watched", and a day with SOME passes was
        therefore treated as a watched day: nine passes with an eleven-hour
        hole read exactly like full cover, and the digest stayed silent on the
        morning after an outage that had happened and recovered inside the
        hole. On a machine that sleeps nightly that is the ordinary shape, not
        a rare one.

        This is what closes the silent death. Checks run only from the watch
        beat, so no check can ever see its own beat stop: a paused watch beat
        raises nothing new, `deliverable()` empties out once the standing
        findings are delivered, and every digest after that writes NOTHING,
        forever, with nothing else in the system able to notice.
        """
        return (
            self.unreadable is not None
            or self.passes == 0
            or self.paused_at is not None
            or self.blind_spell is not None
        )

    def _paused_words(self, zone: str) -> str:
        """The pause, in words, or "". Never just "it is paused": the reason is
        on the row and a symptom without its cause is the sentence this whole
        line is a reaction to."""
        if self.paused_at is None:
            return ""
        why = self.paused_reason or "no reason was recorded on the row"
        return (
            f" The beat is PAUSED (since {schedule.local_words(self.paused_at, zone)}) and will "
            f"not run again until it is resumed — {why}."
        )

    def line(self, zone: str) -> str:
        """The sentence, composed here in code. Never asked of a model: it is
        the one claim in the message whose whole point is that a model had no
        hand in it."""
        if self.unreadable is not None:
            return f"{COVERAGE_UNREADABLE} — {self.unreadable}."
        if self.window_start is None:
            return COVERAGE_NOTHING + self._paused_words(zone)
        since = (
            f"the last digest that reached you ({schedule.local_words(self.window_start, zone)})"
            if self.from_a_digest
            else f"its first firing on record ({schedule.local_words(self.window_start, zone)})"
        )
        if not self.passes:
            # Both shapes of "nothing was watched", and they are different
            # facts: a beat that never fired, and a beat that fired and looked
            # at nothing. Neither is allowed to read as an all-clear.
            did = (
                f"has not run at all since {since}"
                if not self.firings
                else (
                    f"fired {_plural(self.firings, 'time')} since {since} and not one of those "
                    "firings ran a check"
                )
            )
            return (
                f"{COVERAGE_PREFIX} the watch beat {did}, {NOT_AN_ALL_CLEAR}"
                + self._paused_words(zone)
            )
        made = (
            "every one of them making a pass"
            if self.passes == self.firings
            else f"{self.passes} of them making a pass"
        )
        words = (
            f"{COVERAGE_PREFIX} the watch beat fired {_plural(self.firings, 'time')} since "
            f"{since}, {made}"
        )
        if self.longest_gap is not None:
            words += (
                f", and the longest it went without a pass was {duration_words(self.longest_gap)}"
            )
        spell = self.blind_spell
        if spell is not None:
            words += (
                f" — a stretch of {duration_words(spell)} in which nothing was watched at all, "
                "so the quiet over that stretch is a fact about the watcher rather than about "
                "the world"
            )
        if self.schedule_words:
            words += f" (it is scheduled {self.schedule_words})"
        elif self.schedule_note:
            words += (
                " (its own schedule could not be read, so there is nothing here to compare "
                f"that against — {self.schedule_note})"
            )
        return words + "." + self._paused_words(zone)

    def as_record(self) -> dict:
        """What the firing stores, in the numbers the sentence was composed
        from — so `timer_firings.delivery` can be checked against the message
        he actually read."""
        record: dict = {
            "firings": self.firings,
            "passes": self.passes,
            "from_a_digest": self.from_a_digest,
        }
        if self.window_start is not None:
            record["window_start"] = self.window_start.isoformat()
        if self.longest_gap is not None:
            record["longest_gap_s"] = round(self.longest_gap.total_seconds())
        if self.expected_interval is not None:
            record["expected_interval_s"] = round(self.expected_interval.total_seconds())
        # Recorded only when it is one, so the firing row says which quiet
        # days had a hole in them and which were watched throughout.
        if self.blind_spell is not None:
            record["blind_spell_s"] = round(self.blind_spell.total_seconds())
        if self.paused_at is not None:
            record["paused_at"] = self.paused_at.isoformat()
            record["paused_reason"] = self.paused_reason
        if self.unreadable is not None:
            record["unreadable"] = self.unreadable
        return record


async def _coverage(pool: asyncpg.Pool, firing_id, mark: datetime) -> Coverage:
    """Count the watch beat's PASSES since the last digest that reached him.

    `mark` closes the span and bounds the firing query, one instant for both:
    a count taken over a wider window than the boundary it is reported against
    would understate the trailing gap and could count a firing that starts
    after the mark. It is read fresh in `_digest` immediately before this call
    rather than reused from earlier in the beat.

    Nothing here raises: a coverage line is provenance under a message that is
    already composed, and losing the whole digest because a history read failed
    would trade a small silence for a large one. The failure is stated in the
    line itself and recorded on the firing instead.

    The gap is measured over the boundaries [window start, every pass, mark]
    and not just between passes, so the two cases that read as "no gap" while
    covering nothing — one pass at the very start of the span, one at the very
    end — are counted like any other stretch.
    """
    try:
        since = await _last_digest_at(pool, firing_id)
        firings = await watch_firings(pool, since=since, until=mark)
        row = await watch_row(pool)
    except Exception as exc:  # noqa: BLE001 - the reason is the record
        logger.exception("the watch beat's firing history could not be read for the digest")
        return Coverage(
            firings=0,
            passes=0,
            window_start=None,
            from_a_digest=False,
            longest_gap=None,
            unreadable=peers.reason(exc),
        )
    words = note = None
    paused_at = paused_reason = None
    if row is not None:
        paused_at, paused_reason = row["paused_at"], row["paused_reason"]
        try:
            words = schedule.describe(row["schedule"], row["timezone"], None)
        except Exception as exc:  # noqa: BLE001 - said, never silently dropped
            note = peers.reason(exc)
    passes = [firing.started_at for firing in firings if firing.made_a_pass]
    # With no digest on record the span starts at the beat's own first firing:
    # he has never been told anything, so everything it has ever done is new.
    window_start = since if since is not None else (firings[0].started_at if firings else None)
    longest = None
    if window_start is not None:
        marks = [window_start, *passes, mark]
        longest = max(
            (later - earlier for earlier, later in zip(marks, marks[1:], strict=False)),
            default=None,
        )
    return Coverage(
        firings=len(firings),
        passes=len(passes),
        window_start=window_start,
        from_a_digest=since is not None,
        longest_gap=longest,
        paused_at=paused_at,
        paused_reason=paused_reason,
        schedule_words=words,
        schedule_note=note,
        expected_interval=_expected_interval(row),
    )


def _standing_predicate(notices) -> str:
    """The SQL for "still true, already told, and not muted", DERIVED from the
    notices store's own definition of what is still owed.

    Named states would be a second, weaker copy of that definition — and were
    (2026-09-09): spelling this as `delivered` or `seen` hardcoded two of the
    five states, and a LIVE notice whose delivery FAILED and which he then
    marked seen fell between the two halves of the message and was never named
    again. `deliverable()` is `_LIVE AND _UNREAD AND state = ANY(...)`, so the
    complement of it inside the live, unmuted rows is exactly what has already
    been told — including that one. The store's private fragments are read on
    purpose rather than re-spelled: one definition of live and of unread, so
    the two halves of one message stay disjoint BY CONSTRUCTION and cannot
    drift into overlapping or into leaving a row in neither.
    """
    return (
        f"{notices._LIVE} AND state <> '{notices.MUTED}' "
        f"AND NOT ({notices._UNREAD} AND state = ANY($1::text[]))"
    )


async def _standing(pool: asyncpg.Pool) -> tuple[list, int, str | None]:
    """The notices that are still TRUE and that he has already been told about,
    longest-standing first — plus how many more there were, plus the reason
    they could not be read, if they could not.

    Its own small query on purpose. `notices.deliverable()` means "still owed"
    and that meaning is settled; widening it to include what has already been
    delivered would make the digest deliver these rows again and mark them
    again, which is precisely what must not happen. The two sets cannot even
    overlap: this predicate is the complement of that one.

    `muted` is absent, and that is the whole point of a mute: he asked to stop
    hearing about those facts, and a tail that re-listed them every morning
    would be the v3 re-armed nag with a new name.

    The overflow is COUNTED, not inferred from the page (2026-09-09): fetching
    one row past the limit and subtracting saturates at 1, so forty standing
    notices read as "and 1 more".
    """
    _checks, notices = _proactive()
    predicate = _standing_predicate(notices)
    states = list(notices.DELIVERABLE_STATES)
    try:
        total = await pool.fetchval(f"SELECT count(*) FROM notices WHERE {predicate}", states)
        rows = await pool.fetch(
            f"SELECT title, check_name, repeats FROM notices WHERE {predicate} "
            "ORDER BY first_seen_at LIMIT $2",
            states,
            DIGEST_STANDING_LIMIT,
        )
    except Exception as exc:  # noqa: BLE001 - the reason is the record
        logger.exception("the standing notices could not be read for the digest")
        return [], 0, peers.reason(exc)
    return list(rows), max(int(total) - len(rows), 0), None


def standing_line(rows: Sequence, more: int, note: str | None) -> str | None:
    """One line naming what is still true and was reported before — or None.

    NAMED, never re-explained, and never re-delivered: these rows keep the
    state they already have, nothing marks them again, and the sentence is a
    list of titles with the sighting count rather than the finding written out
    a second time. A daily re-listing of the same standing problem, with its
    facts and its history, is exactly the nag this whole design exists to
    avoid — the Inbox is where standing things live, and this line is the
    pointer to it.

    It rides a message that already exists. On a day with nothing outstanding
    the digest writes nothing at all and this is never reached, which is
    deliberate: a standing problem must not be able to cause a message, or
    "one message a day unless there is something to say" would become "one
    message a day, forever, from the first thing that ever broke".
    """
    if note is not None:
        return f"{STANDING_UNREADABLE} — {note}."
    if not rows:
        return None
    named = "; ".join(f"{row['title']} (seen {_plural(row['repeats'], 'time')})" for row in rows)
    tail = f", and {more} more" if more else ""
    return f"{STANDING_PREFIX} {named}{tail}. {STANDING_WHY}"


def _guard(turn: traces.Turn, name: str, check, *args) -> str | None:
    """Run one beat guard over the reply, fail open, and file a `guard` span
    when it fires.

    Fail-open is chat.py's rule for every guard and it is the right one here
    too: a guard that raises must never eat the one message he gets that day.
    A guard that FIRES files the span, so the correction he reads can be traced
    back to the line of code that added it.
    """
    try:
        correction = check(*args)
    except Exception:  # noqa: BLE001 - the reply ships uncorrected, loudly
        logger.exception("the %s guard raised; the digest ships uncorrected", name)
        return None
    if correction is None:
        return None
    with turn.span("guard", name) as span:
        span.meta["claims"] = [
            {"kind": claim.kind, "target": claim.target} for claim in correction.claims
        ]
    return correction.text


def _unwritten(turn: traces.Turn, text: str, failure: str | None) -> str | None:
    """Why this turn has nothing to deliver, or None when it has words.

    The structural detector goes FIRST, because it is a fact about who wrote
    the text rather than about whether the call succeeded: a round that
    produced nothing is recorded as such on its own span (chat.EMPTY_ROUND),
    and that recording is what stops a backend-composed sentence being pushed
    as news. The round's own stated failure comes next, and a round that
    returned only whitespace last — all three deliver nothing, and each says
    which it was.
    """
    if guards.model_wrote_nothing(turn.spans):
        return _stated(DIGEST_NOT_WRITTEN, failure)
    if failure is not None:
        return failure
    if not text.strip():
        return DIGEST_NO_TEXT
    return None


async def _mark_digest(pool: asyncpg.Pool, outstanding: Sequence, result) -> str | None:
    """Write the delivery's verdict back onto every notice the digest carried.

    `reached` decides which transition it is, and it is the chat row read back
    — never the fact that a write was attempted. A failed digest marks each one
    FAILED with the ladder's own words, which keeps it deliverable, so the next
    digest still owes it to him. Returns the reason a write did not land, if
    one did not: a delivery that was made and not recorded would be told again
    tomorrow, so it is stated rather than swallowed.
    """
    _checks, notices = _proactive()
    problems: list[str] = []
    for notice in outstanding:
        try:
            if result.reached:
                await notices.mark_delivered(pool, notice.id, delivery=result.receipt)
            else:
                await notices.mark_failed(pool, notice.id, result.reason)
        except Exception as exc:  # noqa: BLE001 - the reason is the record
            logger.exception("notice %s could not be marked after the digest", notice.id)
            problems.append(f"notice {notice.id} — {peers.reason(exc)}")
    if not problems:
        return None
    return "the digest's outcome could not be written onto " + "; ".join(problems)


async def _quiet_digest(
    app, pool: asyncpg.Pool, turn: traces.Turn, coverage: Coverage, person: Person | None
):
    """A day with nothing outstanding — and whether that is QUIET or SILENT.

    Quiet is the ordinary day and it is unchanged: passes were made, nothing is
    owed, the beat writes its own code-composed line into the beats' own
    conversation and he hears nothing at all. A digest that spoke every day
    about nothing is the noise this slice exists to avoid.

    SILENT is the other day, and it is the one this function exists for
    (2026-09-09). `coverage.unproven` is true when no pass was made over the
    whole span, when the watch beat is paused, or when its history could not be
    read — and any of those means the quiet is a fact about the watcher rather
    than about the world. Nothing else in the system can catch it: `run_all` is
    called only from the watch beat, so no check can ever see its own beat
    stop, and once a paused beat raises nothing new `deliverable()` empties out
    and every digest after that writes NOTHING, forever. So the digest speaks:
    one short line composed HERE, in code, with no model asked, and the
    coverage sentence under it naming what did not happen and — off the timer
    row's own `paused_reason` — why.

    It goes through the same non-urgent ladder every digest uses, so "he was
    told" means the same thing on this day as on any other: the chat row read
    back, and a firing that reads ERROR when nobody was reached.
    """
    scheduler = _scheduler()
    record: dict = {
        "beat": DIGEST,
        "digest": {"delivered": False, "notices": 0, "coverage": coverage.as_record()},
    }
    if not coverage.unproven:
        rung, failure = await _say(pool, turn, DIGEST_NOTHING)
        record["chat"] = rung
        record["note"] = DIGEST_NOTHING_NOTE
        record["digest"]["reason"] = DIGEST_NOTHING_NOTE
        if failure is not None:
            return scheduler.Outcome(scheduler.FIRING_ERROR, failure, record)
        return scheduler.Outcome(scheduler.FIRING_OK, None, record)

    # Which silence is being broken decides which sentence is true. A beat that
    # never ran and a beat that ran with a hole in it are different facts, and
    # the "nothing was WATCHED" wording is simply false about the second.
    partly = coverage.passes > 0 and coverage.blind_spell is not None
    opening = DIGEST_PARTLY_WATCHED if partly else DIGEST_UNWATCHED
    note = DIGEST_PARTLY_WATCHED_NOTE if partly else DIGEST_UNWATCHED_NOTE
    record["note"] = note
    record["digest"]["reason"] = note
    if person is None:
        # Stated, never swallowed: there is nobody to tell, which is a worse
        # version of the same silence and must not read as a delivery.
        record["digest"]["unable"] = DIGEST_NO_PERSON
        return scheduler.Outcome(scheduler.FIRING_ERROR, DIGEST_NO_PERSON, record)
    message = "\n\n".join([opening, coverage.line(turn.timezone)])
    delivery = _delivery()
    result = await delivery.deliver(app, pool, text=message, urgent=False, person=person, turn=turn)
    record.update(result.receipt)
    record["digest"]["delivered"] = result.reached
    if not result.reached:
        return scheduler.Outcome(scheduler.FIRING_ERROR, result.reason, record)
    return scheduler.Outcome(scheduler.FIRING_OK, None, record)


async def _digest(app, pool: asyncpg.Pool, turn: traces.Turn, firing_id):
    """The daily beat: ONE message about everything still owed him.

    Nothing outstanding is the ordinary day and it is QUIET: the beat writes its
    own code-composed line into the beats' own conversation, delivers nothing at
    all, and records ok. A digest that spoke every day about nothing is the
    noise this slice exists to avoid. The exception, and the reason coverage is
    computed before that early return, is a quiet day on which nothing was
    WATCHED — see `_quiet_digest`.

    Otherwise it composes. The brief is built HERE, from rows: each deliverable
    notice with its title, its derived facts, its sighting count and what she
    did about it, plus what has CLEARED since the last digest that reached him,
    plus which checks could not run on the last watch pass. The model is asked
    for one short message and for nothing else — no tools are advertised, so
    there is no round it could act in.

    Then four mechanical checks over what came back, before anybody is told:
    the structural detector (text the model did not write is not delivered),
    the observation guard (an all-clear the pass does not support, or a fault no
    finding names), the delivery guard ("I already told you" about something no
    notice delivered) and the novelty guard ("this is new" about facts already
    counted). Each fires as an APPENDED correction — the prose beside it may be
    perfectly true, and dropping it would cost him the message.

    How many findings one message may carry is `proactive.max_notices_per_day`
    (_owed_today): what does not fit is HELD, not dropped — those rows are
    never marked delivered, so they are still owed tomorrow — and the count
    goes on the firing.

    Then two lines the BACKEND composes and appends under the prose, the
    delegate facts-line idiom: the model writes the sentences, the backend
    writes the numbers, and neither can overstate the other. COVERAGE goes out
    every time — how many times the watch beat FIRED since the last digest that
    reached him, how many of those firings actually made a pass, and the
    longest stretch without one, off its own rows — because a digest that
    reports findings without saying how much was watched lets "all quiet" mean
    "I was not there". STILL STANDING goes out only when
    something is: one line naming what is still true and was reported before,
    with its sighting count, NOT re-explained and NOT re-delivered (those rows
    keep the state they have; nothing marks them again). Both ride the message;
    neither can cause one.

    Finally the ladder: `delivery.deliver(urgent=False)`, which writes the chat
    row into his ACTIVE conversation and reads it back. `reached` is that row,
    and it is what decides whether every notice is marked delivered with the
    receipt or failed with the ladder's own words. A failed digest is a failed
    firing, and every notice in it is still owed him tomorrow.
    """
    scheduler = _scheduler()
    _checks_module, notices = _proactive()
    outstanding, held_back = await _owed_today(pool, notices)
    # The database clock, the one every other time in this file comes from — a
    # wall clock here could disagree with the timestamps beside it. Read ONCE
    # and used both as the coverage span's closing boundary and as the bound on
    # the query that counts it, so the count and the boundary cannot be two
    # different instants.
    now = await pool.fetchval("SELECT now()")
    # BEFORE the quiet early-return, because the quiet return is precisely
    # where this was missing (2026-09-09): on the one day it matters most — the
    # day the watch beat stopped — the provenance line never appeared at all.
    coverage = await _coverage(pool, firing_id, now)
    person = await _person(pool, turn)
    if not outstanding:
        return await _quiet_digest(app, pool, turn, coverage, person)

    if person is None:
        return scheduler.Outcome(
            scheduler.FIRING_ERROR,
            DIGEST_NO_PERSON,
            {
                "beat": DIGEST,
                "digest": {
                    "delivered": False,
                    "notices": len(outstanding),
                    "reason": DIGEST_NO_PERSON,
                },
            },
        )

    notes: list[str] = []
    try:
        cleared, cleared_more = await _cleared_since(pool, firing_id)
    except Exception as exc:  # noqa: BLE001 - the reason is the record
        logger.exception("the cleared notices could not be read for the digest")
        cleared, cleared_more = [], 0
        notes.append(
            "what has cleared since the last digest could not be read, so this message "
            f"cannot say what got better — {peers.reason(exc)}"
        )
    runs, pass_note = await _last_pass(pool, outstanding)
    if pass_note is not None:
        notes.append(pass_note)
    delivered_titles, delivered_note = await _delivered_titles(pool)
    if delivered_note is not None:
        notes.append(delivered_note)

    brief = digest_brief(
        name=person.name,
        outstanding=outstanding,
        cleared=cleared,
        cleared_more=cleared_more,
        runs=runs,
        now=now,
        zone=turn.timezone,
        notes=notes,
    )
    try:
        text, calls, failure = await chat._gateway_round(
            app,
            turn,
            turn.model or "",
            [{"role": "system", "content": DIGEST_SYSTEM}, {"role": "user", "content": brief}],
            [],
            round_number=1,
            on_delta=None,
        )
    finally:
        # _gateway_round sets DOING and only chat._run_turn's finally pops it.
        # A beat that never runs one would leave this turn reading "thinking"
        # in Activity for as long as the process lives.
        traces.clear_doing(turn.id)

    is_quiet, not_quiet = _checks_module.quiet(runs)
    record: dict = {
        "beat": DIGEST,
        "digest": {
            "delivered": False,
            "notices": len(outstanding),
            "cleared": len(cleared),
            "quiet": is_quiet,
            "not_quiet": not_quiet,
        },
    }
    if held_back:
        # Only when the cap actually bit. The rows are untouched and still
        # deliverable, so this counts what tomorrow still owes him.
        record["digest"]["held_back"] = held_back
    if notes:
        record["digest"]["not_read"] = list(notes)
    if calls:
        # No tool was advertised, so anything here is markup the model wrote as
        # text. _gateway_round already stripped it and nothing dispatches it
        # (the 2026-09-03 ruling); it is counted so the record says it happened.
        record["digest"]["markup_calls"] = len(calls)

    unwritten = _unwritten(turn, text, failure)
    if unwritten is not None:
        # Nothing is delivered and nothing is marked: no delivery was attempted,
        # so every notice stays exactly as deliverable as it was and tomorrow's
        # digest still owes them to him.
        record["digest"]["unable"] = unwritten
        return scheduler.Outcome(scheduler.FIRING_ERROR, unwritten, record)

    # The subjects she may speak about are the notices this digest is REPORTING,
    # taken from the rows rather than from `runs`: a check that could not run
    # this hour still has live notices, and reading the vocabulary off the runs
    # would drop them — putting "no check produced that this pass" under a
    # sentence about a finding that is standing in the brief right above it.
    # `runs` decides only whether the pass was clear.
    findings = [
        _checks_module.Finding(key=notice.finding_key, title=notice.title, facts=notice.facts)
        for notice in outstanding
    ]
    corrections = [
        correction
        for correction in (
            _guard(turn, "observation", guards.observation_check, text, findings, runs),
            _guard(turn, "delivery_claim", guards.delivery_claim_check, text, delivered_titles),
            _guard(
                turn,
                "novelty_claim",
                guards.novelty_claim_check,
                text,
                {notice.title: notice.repeats for notice in outstanding},
            ),
        )
        if correction is not None
    ]
    if corrections:
        record["digest"]["corrections"] = len(corrections)

    # The facts the BACKEND writes, appended under the model's prose: the model
    # was never told these numbers and cannot overstate them, and they are here
    # whatever it wrote. Coverage always — that is the point of it — and the
    # standing tail only when something is standing.
    standing, standing_more, standing_note = await _standing(pool)
    record["digest"]["coverage"] = coverage.as_record()
    if standing or standing_more:
        record["digest"]["standing"] = len(standing) + standing_more
    if standing_note is not None:
        record["digest"]["standing_unreadable"] = standing_note
    facts_lines = [coverage.line(turn.timezone)]
    tail = standing_line(standing, standing_more, standing_note)
    if tail is not None:
        facts_lines.append(tail)
    message = "\n\n".join([text.strip(), *corrections, *facts_lines])

    delivery = _delivery()
    result = await delivery.deliver(app, pool, text=message, urgent=False, person=person, turn=turn)
    record.update(result.receipt)
    record["digest"]["delivered"] = result.reached
    problem = await _mark_digest(pool, outstanding, result)
    if problem is not None:
        record["digest"]["record_error"] = problem
    if not result.reached:
        return scheduler.Outcome(scheduler.FIRING_ERROR, _stated(result.reason, problem), record)
    if problem is not None:
        return scheduler.Outcome(scheduler.FIRING_ERROR, problem, record)
    return scheduler.Outcome(scheduler.FIRING_OK, None, record)


# Name -> the coroutine that runs it, the same binding JOBS uses. run_beat
# refuses a name that is not here rather than routing an unknown row to a
# model.
# -- distil -------------------------------------------------------------------
#
# Recall is only as good as what is stored, and almost everything stored is raw
# transcript. This beat writes the facts down.


# The record this beat leaves about itself, and the path a later firing reads
# to find the mark. `written` is the count of notes that LANDED — memory
# confirmed the path — so a run that verified ten facts and could save none
# says zero here and is not a pass. Same discipline as _WATCH_PASS: a firing
# row exists from the moment it is claimed, and being claimed is not evidence.
_DISTIL_RECORD = "distil"
_DISTIL_MARK = "{delivery,distil,wrote_through}"
_DISTIL_PASS = "f.delivery #>> '{distil,wrote_through}' IS NOT NULL"


@dataclass(frozen=True)
class DistilResult:
    """What one distil pass actually did. Every number is counted from an
    outcome, never from an attempt: `written` is the length of the list of
    paths memory confirmed, and `failed` is the reasons it did not."""

    # From the extractor: how much conversation was read, how many facts the
    # model proposed, how many lost their citation or their live source.
    read: int = 0
    proposed: int = 0
    dropped: int = 0
    folded: int = 0
    # From the writes: the paths memory confirmed, and the reasons for the rest.
    written: tuple[str, ...] = ()
    failed: tuple[str, ...] = ()
    # Every limit on this pass, in words — a subject list that could not be
    # read, a window that was clipped, a peer that could not be reached.
    limits: tuple[str, ...] = ()
    # The reason there was no pass at all, when there was none.
    reason: str | None = None

    @property
    def ran(self) -> bool:
        return self.reason is None


def distil_line(result: DistilResult, span: timedelta) -> str:
    """The beat's own line, composed from the counts.

    It says what LANDED first and what stopped it second, because the first
    clause is what gets read. A pass that wrote nothing says which of the two
    nothings it was: nothing was said in the window, or something was and none
    of it could be written down.
    """
    covered = f"the {duration_words(span)} since the last pass"
    if not result.ran:
        return f"Distil: no pass over {covered} — {result.reason}"
    if result.read == 0:
        return f"Distil: nothing was said in {covered}, so there was nothing to write down."
    parts = [
        f"Distil: read {_plural(result.read, 'message')} from {covered}, "
        f"proposed {result.proposed}, wrote {_plural(len(result.written), 'note')}"
    ]
    if result.folded:
        parts.append(f"{result.folded} restated a fact already proposed in this pass")
    if result.dropped:
        parts.append(f"{_plural(result.dropped, 'proposal')} dropped as unverifiable")
    if result.failed:
        parts.append(f"could not be saved: {'; '.join(result.failed)}")
    if result.limits:
        parts.append(f"limits on this pass: {'; '.join(result.limits)}")
    return ". ".join(parts) + "."


async def distil_span(pool: asyncpg.Pool, now: datetime) -> tuple[timedelta, str | None]:
    """How far back this pass reads, and the limit on that when there is one.

    DERIVED FROM THE BEAT'S OWN FIRING HISTORY, the way the review check derives
    its cadence — no new table and no counter to drift. The mark is the start of
    the most recent firing that actually WROTE something through; a firing that
    was claimed, or that ran and saved nothing, marks nothing, so the next pass
    reads the same window again rather than stepping over an hour nobody
    distilled.

    Two bounds, both stated. With no such firing at all this reads
    DISTIL_FIRST_WINDOW, because swallowing the whole archive on the first tick
    would be doing the backfill's job without anyone asking for it. However long
    the beat was down, one pass reaches back at most DISTIL_MAX_WINDOW and SAYS
    what it did not reach — the older conversation is still there and still
    distillable, and a silently clipped window is how "she has nothing on that"
    gets said about something he told her.
    """
    last = await pool.fetchval(
        "SELECT max(f.started_at) FROM timer_firings f JOIN timers t ON t.id = f.timer_id "
        f"WHERE t.kind = $1 AND t.payload->>'handler' = $2 AND {_DISTIL_PASS}",
        BEAT_KIND,
        DISTIL,
    )
    if last is None:
        return DISTIL_FIRST_WINDOW, None
    span = now - last
    if span <= DISTIL_MAX_WINDOW:
        return max(span, timedelta(0)), None
    return DISTIL_MAX_WINDOW, (
        f"the last pass that wrote anything was {duration_words(span)} ago, and one pass reads "
        f"at most {duration_words(DISTIL_MAX_WINDOW)} — what was said before that is still "
        "undistilled and needs a backfill"
    )


async def _distil(app, pool: asyncpg.Pool, turn: traces.Turn, firing_id):
    """One distil pass: read what was said, verify it, write the facts down.

    NOT gated by proactive.enabled (see GATED_BY_PROACTIVE) and it delivers
    nothing to him — the only thing it writes outside his notes is its own line
    in the beats' conversation.

    The counts on the firing are of what LANDED. `wrote_through` is stamped
    ONLY when a note was actually saved, because that value is the mark the
    next pass reads: recording it for a pass that saved nothing would step the
    window past conversation nobody ever distilled, and the facts in it would
    be lost silently, which is the failure this whole slice is about.
    """
    scheduler = _scheduler()
    # Imported at call time, like _proactive's checks: app.distil reaches the
    # gateway and the tool registry, and a module-level import here would tie
    # the scheduler's import graph to both.
    from app import distil as distil_module

    person = await _person(pool, turn)
    now = await pool.fetchval("SELECT now()")
    span, clipped = await distil_span(pool, now)

    if person is None:
        result = DistilResult(reason="there is no owner account, so there are no notes to write")
    else:
        with turn.span("distil") as work:
            found = await distil_module.distil(app, pool, person, since=span)
            work.meta["read"] = found.read
            work.meta["proposed"] = found.proposed
            work.meta["verified"] = found.verified
            written, failed = await distil_module.write_facts(app, person, found.facts)
            work.meta["written"] = len(written)
            if failed:
                work.meta["failed"] = list(failed)
        result = DistilResult(
            read=found.read,
            proposed=found.proposed,
            dropped=found.dropped,
            folded=found.folded,
            written=written,
            failed=failed,
            limits=tuple(x for x in (*found.limits, clipped) if x),
            reason=found.reason,
        )

    rung, say_failed = await _say(pool, turn, distil_line(result, span))
    delivery: dict = {
        "beat": DISTIL,
        "chat": rung,
        _DISTIL_RECORD: {
            "read": result.read,
            "proposed": result.proposed,
            "dropped": result.dropped,
            "written": list(result.written),
            "failed": list(result.failed),
        },
    }
    if result.written:
        # The mark, and only when something landed. `now` rather than the
        # instant the writes finished: the window this pass READ ended at now,
        # and dating the mark later would skip whatever was said while it ran.
        delivery[_DISTIL_RECORD]["wrote_through"] = now.isoformat()

    problem = _stated(
        say_failed,
        result.reason if not result.ran else None,
        f"{_plural(len(result.failed), 'fact')} could not be saved" if result.failed else None,
    )
    if problem is not None:
        return scheduler.Outcome(scheduler.FIRING_ERROR, problem, delivery)
    return scheduler.Outcome(scheduler.FIRING_OK, distil_line(result, span), delivery)


_RUNNERS = {WATCH: _watch, DIGEST: _digest, DISTIL: _distil}
