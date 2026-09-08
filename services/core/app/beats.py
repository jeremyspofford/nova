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
    socket reads; the model is only asked when there is something to say.
    It delivers NOTHING — no chat message he sees, no push. The digest does
    that (S11-3); the watch beat's own line lands in the beats' conversation.
  * `digest` — daily, at the hour the owner sets. Writes the ONE message.

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

Nothing here asks anyone for anything (owner ruling 2026-09-03). A beat states
what it could not do; it never decides what it may not.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING

import asyncpg

from app import chat, identity, peers, schedule, settings_store, traces
from app.identity import Person

if TYPE_CHECKING:  # app.checks is imported at CALL time — see _proactive.
    from app import checks

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


async def _run(pool: asyncpg.Pool, turn: traces.Turn, name: str, note: str):
    """The shared body of the two seams below: state what this beat did in its
    own conversation, and make the firing's verdict the fact of that write."""
    scheduler = _scheduler()
    rung, reason = await _say(pool, turn, note)
    delivery = {"beat": name, "chat": rung}
    if reason is None:
        return scheduler.Outcome(scheduler.FIRING_OK, None, delivery)
    return scheduler.Outcome(scheduler.FIRING_ERROR, reason, delivery)


DIGEST_UNBUILT = (
    "Digest beat: the notice store is not wired into the digest yet, so there is nothing "
    "to summarise and nothing was sent. The digest lands in S11-3."
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
    # Said every time, because this beat's honesty depends on it: it records
    # and it clears, and the digest (S11-3) is the only thing that tells him.
    parts.append("Nothing was delivered — the digest is what reaches him.")
    return "Watch beat: " + " ".join(parts)


async def _record_check(
    pool: asyncpg.Pool, turn: traces.Turn, firing_id, run: checks.CheckRun
) -> tuple[int, int, int]:
    """Write down what one check found, then clear what it no longer finds.
    Returns (new, folded, cleared).

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
    cleared = await notices.reconcile(pool, check_name=run.check, live_fingerprints=set(live))
    return new, len(live) - new, len(cleared)


async def _run_checks(app, pool: asyncpg.Pool, turn: traces.Turn, firing_id) -> WatchResult:
    """Run every registered check, write down what they found, clear what they
    no longer find, and count all of it.

    Nothing a check can do raises out of here: `checks.run_all` already turns
    every failure into ran=False with the reason in words, and a check whose
    notices could not be written is DEMOTED to the same shape with the reason
    for that — so one broken write costs that check's result and not the other
    eleven checks' records.
    """
    checks, _notices = _proactive()
    effective: list[checks.CheckRun] = []
    new = folded = cleared = 0
    with turn.span("checks", "run_all") as span:
        for run in await checks.run_all(app, pool):
            if not run.ran:
                effective.append(run)
                continue
            try:
                run_new, run_folded, run_cleared = await _record_check(pool, turn, firing_id, run)
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
        runs = tuple(effective)
        # ONE computation of quiet, and it lives beside the registry: every
        # check ran and none flagged, and an empty run is not vacuously quiet.
        is_quiet, why = checks.quiet(runs)
        result = WatchResult(
            runs=runs, quiet=is_quiet, not_quiet=why, new=new, folded=folded, cleared=cleared
        )
        # Inside the span, not after it: the trace is where anyone looks first,
        # and these are the same numbers the sentence is composed from.
        span.meta.update(result.as_delivery())
    return result


NOTHING_RAN = "no check ran, so this beat watched nothing — that is a broken beat, not a quiet one"


async def _watch(app, pool: asyncpg.Pool, turn: traces.Turn, firing_id):
    """The hourly beat: run every registered check and write down what they
    found.

    It DELIVERS NOTHING. No chat message he sees, no push, no device: that is
    the digest (S11-3), which is written on purpose at an hour he set. What
    lands here is the beat's own line in the beats' own inactive conversation,
    saying what ran, what could not, and what was recorded or cleared.

    Three verdicts, and they are different facts:

      * OK and quiet — every check ran, every finding was written down, and
        nothing was flagged.
      * OK and INCOMPLETE — some check could not run. The line names each one
        and why, and says it is not an all-clear. NOT an error: a check that
        cannot run is usually the operator's world (an unconfigured link, too
        little history to compute a mean), and five of those in a row must not
        pause the one timer whose job is to keep watching.
      * ERROR — the beat's own record could not be written, or NO check ran at
        all. Both mean this beat is not evidence of anything.
    """
    scheduler = _scheduler()
    result = await _run_checks(app, pool, turn, firing_id)
    rung, failure = await _say(pool, turn, watch_line(result))
    delivery = {"beat": WATCH, "chat": rung, "watch": result.as_delivery()}
    if failure is not None:
        return scheduler.Outcome(scheduler.FIRING_ERROR, failure, delivery)
    if not result.ran:
        return scheduler.Outcome(
            scheduler.FIRING_ERROR, f"{NOTHING_RAN}: {result.not_quiet}", delivery
        )
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


async def _digest(app, pool: asyncpg.Pool, turn: traces.Turn, firing_id):
    """The daily beat: ONE message about everything raised since the last one.

    S11-3 fills this in: read the deliverable notices (state in raised/failed,
    cleared_at IS NULL — a repeat of something that never landed is not a
    repeat), compose one message, write the chat rung and the Inbox rung (that
    rung is what marks the firing ok), and write each channel's own verdict
    back onto the notice — `ok` only from the channel's own result, `failed`
    with the stated reason, `stated` for "no paired device was connected".
    Only the stack family may bypass this and push at any hour, and that is
    declared in the CHECK, never in a reply.
    """
    return await _run(pool, turn, DIGEST, DIGEST_UNBUILT)


# Name -> the coroutine that runs it, the same binding JOBS uses. run_beat
# refuses a name that is not here rather than routing an unknown row to a
# model.
_RUNNERS = {WATCH: _watch, DIGEST: _digest}
