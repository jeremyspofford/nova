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
from datetime import datetime
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
BEATS = (WATCH, DIGEST)

# timers.kind and turns.kind. Spelled separately because they are two different
# columns in two different tables that happen to agree; a future rename of one
# must not silently move the other.
BEAT_KIND = "beat"
BEAT_TURN_KIND = "beat"

BEAT_TITLES: dict[str, str] = {
    WATCH: "Watch: run the checks every hour and act on what they find",
    DIGEST: "Digest: one message a day about what she found",
}

# Hourly, at :05 rather than :00. A firing runs serially inside one tick, and
# :00 is where wall-clock reminders pile up — a beat that took a minute there
# would delay them all.
WATCH_SCHEDULE = {"kind": "hour", "minute": 5}

# The digest's hour. The setting does not exist yet (S11-6 adds it to
# SETTING_DEFS with a validator that returns the problem in words), so it is
# read defensively: through settings_store the moment the def lands, straight
# off the table until then, and never trusted without validating it as a real
# schedule.
DIGEST_AT_KEY = "proactive.digest_at"
DEFAULT_DIGEST_AT = "08:00"

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
    specs = {WATCH: schedule.validate(WATCH_SCHEDULE), DIGEST: await _digest_spec(pool)}
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
            "ran": list(self.ran),
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
    delivery = {"beat": WATCH, "chat": rung, "watch": result.as_delivery()}
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


async def _cleared_since(pool: asyncpg.Pool, firing_id) -> tuple[list, int]:
    """The notices whose condition ended since the last digest that REACHED
    him, most recent first, and how many more there were than the brief carries.

    "The last digest" is derived from the record a digest writes about itself —
    `delivery.digest.delivered`, which is `Delivered.reached`, which is the chat
    row read back. Not from the last firing (a digest that failed told him
    nothing, so its window is still owed) and not from the last time anything
    was delivered (an urgent push is one sentence about the stack and says
    nothing about what cleared). With no such firing yet, the window is
    everything: he has never been told anything.
    """
    since = None
    if firing_id is not None:
        since = await pool.fetchval(
            "SELECT max(started_at) FROM timer_firings "
            "WHERE timer_id = (SELECT timer_id FROM timer_firings WHERE id = $1) "
            "AND id <> $1 AND (delivery #>> '{digest,delivered}') = 'true'",
            firing_id,
        )
    rows = await pool.fetch(
        "SELECT title, check_name, cleared_at FROM notices "
        "WHERE cleared_at IS NOT NULL AND ($1::timestamptz IS NULL OR cleared_at > $1) "
        "ORDER BY cleared_at DESC LIMIT $2",
        since,
        DIGEST_CLEARED_LIMIT + 1,
    )
    return list(rows[:DIGEST_CLEARED_LIMIT]), max(len(rows) - DIGEST_CLEARED_LIMIT, 0)


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
            "SELECT f.delivery -> 'watch' AS watch FROM timer_firings f "
            "JOIN timers t ON t.id = f.timer_id "
            "WHERE t.kind = $1 AND t.payload->>'handler' = $2 AND f.delivery ? 'watch' "
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
    ran = watch.get("ran") if isinstance(watch.get("ran"), list) else []
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


async def _digest(app, pool: asyncpg.Pool, turn: traces.Turn, firing_id):
    """The daily beat: ONE message about everything still owed him.

    Nothing outstanding is the ordinary day and it is QUIET: the beat writes its
    own code-composed line into the beats' own conversation, delivers nothing at
    all, and records ok. A digest that spoke every day about nothing is the
    noise this slice exists to avoid.

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

    Finally the ladder: `delivery.deliver(urgent=False)`, which writes the chat
    row into his ACTIVE conversation and reads it back. `reached` is that row,
    and it is what decides whether every notice is marked delivered with the
    receipt or failed with the ladder's own words. A failed digest is a failed
    firing, and every notice in it is still owed him tomorrow.
    """
    scheduler = _scheduler()
    _checks_module, notices = _proactive()
    outstanding = await notices.deliverable(pool)
    if not outstanding:
        rung, failure = await _say(pool, turn, DIGEST_NOTHING)
        record = {
            "beat": DIGEST,
            "chat": rung,
            "note": DIGEST_NOTHING_NOTE,
            "digest": {"delivered": False, "notices": 0, "reason": DIGEST_NOTHING_NOTE},
        }
        if failure is not None:
            return scheduler.Outcome(scheduler.FIRING_ERROR, failure, record)
        return scheduler.Outcome(scheduler.FIRING_OK, None, record)

    person = await _person(pool, turn)
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
        # The database clock, the one every other time in this file comes from
        # — a wall clock here could disagree with the timestamps beside it.
        now=await pool.fetchval("SELECT now()"),
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
    message = "\n\n".join([text.strip(), *corrections])

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
_RUNNERS = {WATCH: _watch, DIGEST: _digest}
