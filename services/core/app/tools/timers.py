"""Her side of scheduling: create_timer, list_timers, cancel_timer.

Three flat tools with STRUCTURED fields — the model never hands this module a
date sentence to parse. "In two minutes" arrives as `in_minutes: 2`, "at seven
tomorrow" as `at: "2026-09-07 07:00"`, "every day at seven" as `repeat:
{"every": "day", "at": "07:00"}`. Prose never causes an action; the fields do,
and every field is checked here or in app/schedule.py by name before a row
exists.

What this module DECIDES, and nothing else:

  * a RELATIVE request is resolved by this caller into a `once` at an absolute
    local wall time in the household's zone (UTC when none is set — a duration
    is a duration in every zone, so relative is always allowed; UTC also for
    the one wall time a year the zone cannot name unambiguously, the DST
    fall-back hour — see _relative_spec), and the store never holds the
    duration (app/schedule.py's rule);
  * a named `device` must be a PAIRED device now (devices.get_live_by_name) —
    the confirmation names it, so something has to have checked it;
  * an ABSOLUTE `at` or a `repeat` names a wall clock, and a wall clock needs a
    zone: with `nova.timezone` still unset (no stored value — the default 'UTC'
    would silently make 07:00 mean 07:00 UTC, which is the wrong time for
    nearly everyone) the call is refused with the one sentence that says where
    the zone is set. Never a wrong time.

Everything about what a row CAN be — the spec shapes, a once already past, the
payload a kind carries — is refused by app/timers.py and app/schedule.py and
restated here as the `Error:` result the model reads; nothing here asks anyone
or decides that a call MAY not run (owner ruling 2026-09-03).

The words she confirms with come from schedule.describe(), the same function
the Schedules page reads, so her reply and the page cannot disagree about one
row. list_timers declares RESULT_KIND_LISTING so the presented-listing guard
learns of it from the registry, never from a name.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import asyncpg

from app import conversations, db, devices, schedule, settings_store
from app.identity import Person
from app.tools.base import RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure

TIMEZONE_KEY = "nova.timezone"
# The plan's exact sentence (slice-09 "Her side"); dispatch prefixes "Error: ".
NO_TIMEZONE = (
    "no timezone is set for this instance yet — it is set in Settings → General (or during "
    'setup); relative reminders ("in 20 minutes") work without one.'
)
KINDS = ("reminder", "scheduled")
REPEAT_EVERY = ("minutes", "hour", "day", "week", "month")
# The repeat fields each cadence takes, in the TOOL's vocabulary, so a refusal
# names the field the model sent ("n"), not the spec's word for it ("every").
REPEAT_FIELDS: dict[str, tuple[str, ...]] = {
    "minutes": ("n",),
    "hour": ("at",),
    "day": ("at",),
    "week": ("days", "at"),
    "month": ("day", "at"),
}
MAX_TITLE_CHARS = 80
SHORT_ID_CHARS = 8
# One year: past that a "relative" reminder is a date, and `at` says it better.
MAX_IN_MINUTES = 366 * 24 * 60
# list_timers / cancel_timer read up to this many rows; a household with more
# is TOLD the list is the newest N of M rather than shown a list that reads as
# complete (timers.list_for's default of 50 would hide the 51st silently).
LIST_LIMIT = 1000
_AT_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$")
_HHMM_RE = re.compile(r"^(?:(\d{2}):)?(\d{2})$")


# -- the household's zone ------------------------------------------------------


async def household_timezone(pool: asyncpg.Pool | asyncpg.Connection) -> tuple[str, bool]:
    """(zone, is_set). `is_set` is whether a value is STORED, not whether it
    differs from the default: a household that lives in UTC and said so is set;
    one that never answered the onboarding step is not, even though both read
    'UTC' through settings_store.read_value. A stored zone that no longer loads
    is a ToolFailure naming it — never silently UTC."""
    row = await pool.fetchrow("SELECT value FROM settings WHERE key = $1", TIMEZONE_KEY)
    if row is None:
        return settings_store.DEFS_BY_KEY[TIMEZONE_KEY].default, False
    zone = row["value"]
    problem = settings_store.DEFS_BY_KEY[TIMEZONE_KEY].validate(zone)
    if problem is not None:
        raise ToolFailure(f"the stored timezone cannot be used — {problem}")
    return zone, True


def _store():
    """app.timers, imported at call time. At module time it would close a cycle:
    app.timers imports app.scheduler (for fire_now), the scheduler imports
    app.chat, and chat reads tools.ERROR_PREFIX while this package is still
    being assembled — so `import app.tools` first (every test does) would die
    half-built. The store is a plain module either way; nothing here consults a
    table for permission (tests/test_no_approvals.py pins the package entry)."""
    from app import timers

    return timers


def _agents():
    """app.agents, imported at call time for the same reason as _store: it
    imports app.tools at its top (for the registry), so naming it here at
    module time would close the cycle while this package is half-built."""
    from app import agents

    return agents


def _is_agent(ctx: ToolContext) -> bool:
    """An agent turn's ctx.person is a Person VALUE with role 'agent' and no
    people row (app/agents.py); the role string is read from there so it is
    spelled once."""
    return getattr(ctx.person, "role", None) == _agents().AGENT_PERSON_ROLE


def _person(ctx: ToolContext) -> Person:
    person = ctx.person
    if person is None or getattr(person, "id", None) is None:
        raise ToolFailure("this turn has no identity, so a timer cannot belong to anyone")
    return person


def _short(timer_id: uuid.UUID) -> str:
    return str(timer_id)[:SHORT_ID_CHARS]


# -- create_timer ---------------------------------------------------------------


def _relative_spec(now: datetime, minutes: int, zone: str) -> tuple[dict, str]:
    """ "in N minutes" -> (a `once` at the local wall time N minutes from the
    database clock, the zone that wall time is computed in), rounded UP to the
    minute so "in 2 minutes" is never one minute and a few seconds. Resolved
    HERE, once; the row holds the instant.

    A duration is a duration in every zone, and the store holds a WALL time:
    in the fall-back hour (America/New_York 2026-11-01, 01:00-02:00 happens
    twice) the wall time loses the fold and schedule.resolve takes the first
    occurrence, so "in 90 minutes" at 00:58 EDT would fire in 30, and "in 2
    minutes" at 01:28 EST would resolve to 01:30 EDT — an hour ago — and be
    refused as past. When the zone cannot name the instant unambiguously, the
    row is written in UTC (which has no fold) and says so in its words; the
    instant is what he asked for either way."""
    target = now + timedelta(minutes=minutes)
    if target.second or target.microsecond:
        target = target.replace(second=0, microsecond=0) + timedelta(minutes=1)
    tz = zone
    wall = target.astimezone(ZoneInfo(zone)).replace(tzinfo=None)
    if schedule.resolve(wall, ZoneInfo(zone)) != target:
        tz = "UTC"
        wall = target.astimezone(UTC).replace(tzinfo=None)
    return {"kind": "once", "at": wall.isoformat(timespec="minutes")}, tz


def _absolute_spec(at: Any) -> dict:
    if not isinstance(at, str) or _AT_RE.match(at.strip()) is None:
        raise ToolFailure(
            f"at must be a local wall time written 'YYYY-MM-DD HH:MM' (24-hour), got {at!r}"
        )
    match = _AT_RE.match(at.strip())
    assert match is not None
    return {"kind": "once", "at": f"{match.group(1)}T{match.group(2)}"}


def _hour_minute(at: Any) -> int:
    """`repeat.at` for an hourly cadence: the minute past each hour, given as
    'MM' or '00:MM'. An hour part other than 00 is refused rather than dropped:
    '09:45' names a time of day, which is every=day's shape, and silently
    reading it as ":45 past every hour" would be a wrong time."""
    if not isinstance(at, str) or _HHMM_RE.match(at.strip()) is None:
        raise ToolFailure(
            f"for every=hour, at names the minute past each hour as 'MM' or '00:MM', got {at!r}"
        )
    match = _HHMM_RE.match(at.strip())
    assert match is not None
    hour, minute = match.group(1), int(match.group(2))
    if hour is not None and int(hour) != 0:
        raise ToolFailure(
            f"for every=hour, at is the minute past each hour ('MM' or '00:MM'); {at!r} names "
            f"an hour too — for a time of day use repeat every=day with at {at!r}"
        )
    if not 0 <= minute <= 59:
        raise ToolFailure(f"for every=hour, at must be a minute 0..59, got {at!r}")
    return minute


def _repeat_spec(repeat: Any) -> dict:
    """The tool's repeat object -> a schedule spec, unknown and missing fields
    refused by the tool's own names; the spec's VALUES are then checked by
    schedule.validate, whose reasons come back verbatim."""
    if not isinstance(repeat, dict):
        raise ToolFailure(f"repeat must be an object, got {type(repeat).__name__}")
    if "every" not in repeat:
        raise ToolFailure(f"repeat needs 'every', one of {', '.join(REPEAT_EVERY)}")
    every = repeat["every"]
    if every not in REPEAT_EVERY:
        raise ToolFailure(f"repeat.every must be one of {', '.join(REPEAT_EVERY)}, got {every!r}")
    allowed = REPEAT_FIELDS[every]
    unknown = sorted(k for k in repeat if k != "every" and k not in allowed)
    if unknown:
        raise ToolFailure(
            f"repeat every={every} does not take {', '.join(map(repr, unknown))} — "
            f"it takes {', '.join(allowed) or 'nothing else'}"
        )
    spec: dict = {}
    if every == "minutes":
        if "n" not in repeat:
            raise ToolFailure("repeat every=minutes needs 'n', the number of minutes between runs")
        spec = {"kind": "minutes", "every": repeat["n"]}
    elif every == "hour":
        spec = {"kind": "hour", "minute": _hour_minute(repeat["at"]) if "at" in repeat else 0}
    else:
        if "at" not in repeat:
            raise ToolFailure(f"repeat every={every} needs 'at', the time of day as 'HH:MM'")
        spec = {"kind": every, "at": repeat["at"]}
        if every == "week":
            if "days" not in repeat:
                raise ToolFailure('repeat every=week needs \'days\', a list like ["mon", "wed"]')
            spec["days"] = repeat["days"]
        if every == "month":
            if "day" not in repeat:
                raise ToolFailure("repeat every=month needs 'day', the day of the month 1..31")
            spec["day"] = repeat["day"]
    try:
        return schedule.validate(spec)
    except schedule.SpecError as exc:
        raise ToolFailure(str(exc)) from exc


async def _paired_device_or_refuse(pool: asyncpg.Pool, name: Any) -> None:
    """A named device must be a paired, unrevoked row NOW — otherwise the tool
    would confirm "as a notification on 'dsek'" and nothing would check the
    promise until the firing. Connected-ness is transient and is the firing's
    business; pairing is the fact that can be checked at creation. The
    alternatives offered are the live rows, never a list someone maintains."""
    if not isinstance(name, str) or not name.strip():
        raise ToolFailure("device is empty — name a paired device, or omit it to notify them all")
    if await devices.get_live_by_name(pool, name) is not None:
        return
    names = [
        r["name"]
        for r in await pool.fetch("SELECT name FROM devices WHERE revoked_at IS NULL ORDER BY name")
    ]
    if not names:
        raise ToolFailure(
            f"no paired device named {name!r} — no device is paired at all; omit device "
            "and the reminder lands in chat"
        )
    raise ToolFailure(
        f"no paired device named {name!r} — paired devices are: "
        + ", ".join(repr(n) for n in names)
    )


async def _agent_or_refuse(pool: asyncpg.Pool, name: str):
    """The agent a scheduled turn will run AS, resolved by name against the
    agents table NOW (agents.by_name) — the row the firing loads by id later.
    Unknown is refused naming the agents that exist, read live, never a list
    kept here."""
    agents = _agents()
    agent = await agents.by_name(pool, name.strip())
    if agent is not None:
        return agent
    live = await agents.names(pool)
    listed = f"the agents are: {', '.join(live)}" if live else "there are no agents"
    raise ToolFailure(f"no agent named {name.strip()!r} — {listed}")


def _title(text: str) -> str:
    words = " ".join(text.split())
    if len(words) <= MAX_TITLE_CHARS:
        return words
    return words[: MAX_TITLE_CHARS - 1].rstrip() + "…"


async def create_timer(args: dict, ctx: ToolContext) -> str:
    # An agent's ctx.person has no people row, and the conversation this row
    # would land in is inserted for that person_id — postgres would refuse
    # the foreign key anyway; this refuses first, in words the agent can act
    # on (put it in the report), instead of a constraint name.
    _agents().refuse_person_write(ctx, "a timer")
    person = _person(ctx)
    pool = await db.get_pool()

    text = args["text"]
    if not isinstance(text, str) or not text.strip():
        raise ToolFailure("text is empty — what should the reminder say (or the turn do)?")
    kind = args.get("kind", "reminder")
    if kind not in KINDS:
        raise ToolFailure(f"kind must be one of {', '.join(KINDS)}, got {kind!r}")
    device = args.get("device")
    if kind == "scheduled" and device is not None:
        raise ToolFailure(
            "device only applies to a reminder — a scheduled turn replies in chat, "
            "it does not notify a device"
        )
    agent_name = args.get("agent")
    if agent_name is not None:
        if not isinstance(agent_name, str) or not agent_name.strip():
            raise ToolFailure(
                "agent is empty — name an agent (from list_agents), or omit it to run the "
                "turn yourself"
            )
        if kind != "scheduled":
            # The store refuses this too (before its CHECK); said here in the
            # tool's own vocabulary so the model hears it beside `kind`.
            raise ToolFailure(
                "only a scheduled turn can be bound to an agent — a reminder is delivered by "
                "code, not run as a turn"
            )

    given = [name for name in ("in_minutes", "at", "repeat") if name in args]
    if len(given) != 1:
        have = ", ".join(given) if given else "none of them"
        raise ToolFailure(
            "give exactly one of in_minutes (a relative reminder), at (an absolute local "
            f"time) or repeat (a recurring schedule) — you gave {have}"
        )
    if device is not None:
        await _paired_device_or_refuse(pool, device)
    agent = await _agent_or_refuse(pool, agent_name) if agent_name is not None else None
    zone, zone_set = await household_timezone(pool)
    now = await pool.fetchval("SELECT now()")
    tz = zone
    if given == ["in_minutes"]:
        spec, tz = _relative_spec(now, args["in_minutes"], zone)
    else:
        if not zone_set:
            raise ToolFailure(NO_TIMEZONE)
        spec = _absolute_spec(args["at"]) if given == ["at"] else _repeat_spec(args["repeat"])

    # The turn's own conversation is not on the ToolContext (it carries app,
    # person, workspace root and the facts sink — nothing that names a turn),
    # so the row lands in the person's ACTIVE conversation: the thread the chat
    # page shows, which for a chat-created timer is the one being typed in.
    conversation = await conversations.active_conversation(pool, person)
    store = _store()
    payload = (
        {"message": text.strip(), "device": device}
        if kind == "reminder"
        else {"instruction": text.strip()}
    )
    try:
        row = await store.create(
            pool,
            person=person,
            kind=kind,
            title=_title(text),
            payload=payload,
            spec=spec,
            tz=tz,
            conversation_id=conversation["id"],
            created_via="chat",
            # Provenance would want the turn id; the context does not expose it
            # (see above), so it stays NULL rather than widening ToolContext.
            created_turn_id=None,
            agent_id=None if agent is None else agent.id,
        )
    except store.TimerRefused as exc:
        raise ToolFailure(exc.reason) from exc

    words = schedule.describe(row["schedule"], tz, row["next_fire_at"], now=now)
    if kind == "reminder":
        where = (
            f"in this chat and as a notification on {device!r}"
            if device
            else "in this chat and as a notification on every connected paired device"
        )
        return (
            f"Reminder set (id {_short(row['id'])}): {row['title']!r} — {words}. "
            f"It will land {where}."
        )
    # "runs as coder" is said from the row that was WRITTEN (its agent_id),
    # named through the agent resolved above — never from the argument alone.
    who = "Its" if row["agent_id"] is None else f"It runs as {agent.name}; its"
    return (
        f"Scheduled turn set (id {_short(row['id'])}): {row['title']!r} — {words}. "
        f"{who} reply will land in this chat."
    )


# -- list_timers ------------------------------------------------------------------


def _line(row: asyncpg.Record, runs_as: dict[uuid.UUID, str] | None = None) -> str:
    """One listing line. `runs_as` is the agent name per agent_id, read from
    the agents table by the caller (_agent_names); when it is given, a bound
    row says who runs it. None (the agent's own bound listing, cancel's
    candidates) states nothing about the binding rather than guessing."""
    spec = _store().timer_spec(row)
    line = f"- {_short(row['id'])} {row['kind']} {row['title']!r}: {spec['schedule_words']}"
    if runs_as is not None and row["agent_id"] is not None:
        name = runs_as.get(row["agent_id"])
        # A bound id with no agents row cannot happen under migration 021's
        # RESTRICT; if it ever did, the line says so instead of dropping it.
        line += (
            f" — runs as {name}"
            if name is not None
            else f" — runs as an agent that no longer exists ({_short(row['agent_id'])})"
        )
    if row["paused_at"] is not None:
        line += f" — PAUSED: {row['paused_reason']}"
    return line


async def _agent_names(pool: asyncpg.Pool, rows: list[asyncpg.Record]) -> dict[uuid.UUID, str]:
    """The name of every agent the rows are bound to, in one query, read live
    from the agents table — the listing's "runs as coder" is what the table
    says now, never a label stored on the timer."""
    ids = sorted({r["agent_id"] for r in rows if r["agent_id"] is not None}, key=str)
    if not ids:
        return {}
    found = await pool.fetch("SELECT id, name FROM agents WHERE id = ANY($1::uuid[])", ids)
    return {r["id"]: r["name"] for r in found}


async def _visible(pool: asyncpg.Pool, person: Person) -> tuple[list[asyncpg.Record], int]:
    """(the newest LIST_LIMIT rows this person can see, how many there are) —
    the same set timers.list_for pages for the Schedules page. The count is
    read so a truncated list can SAY it is truncated."""
    total = await pool.fetchval(
        "SELECT count(*) FROM timers WHERE person_id = $1 OR kind = 'job'", person.id
    )
    rows = await _store().list_for(pool, person, limit=LIST_LIMIT)
    return rows, total


def _truncated_note(shown: int, total: int) -> str | None:
    if total <= shown:
        return None
    return f"(showing the newest {shown} of {total} — the Schedules page has the rest)"


def _bound_listing(rows: list[asyncpg.Record]) -> str:
    """What an agent turn sees: the scheduled turns bound to run AS it. It has
    no person-scoped set to show (its Person is a value with no row, so
    list_for would answer for nobody), and the rows it is bound to belong to
    the owner who set them — listed here, cancelled only by a person."""
    if not rows:
        return "no timers are bound to you"
    return "\n".join(["timers bound to you:", *(_line(r) for r in rows)])


async def list_timers(args: dict, ctx: ToolContext) -> str:
    """The person's own timers plus the install's jobs (timers.list_for's set —
    the same rows the Schedules page shows this person), one line each. An
    agent turn is shown the other axis instead: the timers bound to it."""
    person = _person(ctx)
    pool = await db.get_pool()
    if _is_agent(ctx):
        return _bound_listing(await _store().list_bound(pool, person.id))
    rows, total = await _visible(pool, person)
    if not rows:
        return "No timers: nothing is scheduled and no reminder is set."
    own = [r for r in rows if r["kind"] != "job"]
    jobs = [r for r in rows if r["kind"] == "job"]
    runs_as = await _agent_names(pool, own)
    lines: list[str] = []
    if own:
        noun = "timer" if len(own) == 1 else "timers"
        lines.append(f"{len(own)} {noun} of yours (id, kind, title, schedule):")
        lines.extend(_line(r, runs_as) for r in own)
    else:
        lines.append("No reminders or scheduled turns of yours.")
    if jobs:
        lines.append(f"{len(jobs)} housekeeping job{'s' if len(jobs) != 1 else ''} (system):")
        lines.extend(_line(r) for r in jobs)
    note = _truncated_note(len(rows), total)
    if note:
        lines.append(note)
    return "\n".join(lines)


# -- cancel_timer -------------------------------------------------------------------


def _matches(row: asyncpg.Record, key: str) -> bool:
    """A full id, a short-id prefix (at least SHORT_ID_CHARS hex characters), or
    the title, compared case-insensitively after whitespace is collapsed."""
    identity = str(row["id"])
    lowered = key.lower()
    if lowered == identity:
        return True
    if len(lowered) >= SHORT_ID_CHARS and identity.startswith(lowered):
        return True
    return " ".join(row["title"].split()).lower() == " ".join(key.split()).lower()


async def cancel_timer(args: dict, ctx: ToolContext) -> str:
    # A timer is a person's row (see create_timer): an agent turn is refused
    # in words before anything is read, never shown "no timer of yours".
    _agents().refuse_person_write(ctx, "a timer")
    person = _person(ctx)
    pool = await db.get_pool()
    key = args["id_or_title"]
    if not isinstance(key, str) or not key.strip():
        raise ToolFailure("id_or_title is empty — give the timer's id or its title")
    key = key.strip()
    # Her OWN rows only: a job belongs to the install (paused from the Schedules
    # page, never cancelled from chat) and another person's timer is not hers to
    # see, so neither is a candidate.
    store = _store()
    rows, total = await _visible(pool, person)
    own = [r for r in rows if r["kind"] != "job"]
    candidates = [r for r in own if _matches(r, key)]
    if not candidates:
        if not own:
            raise ToolFailure(
                f"no timer matches {key!r} — you have no reminders or scheduled turns"
            )
        note = _truncated_note(len(rows), total)
        if note:
            # Searched the newest LIST_LIMIT only: say so instead of a flat "none".
            raise ToolFailure(
                f"no timer among the newest {len(rows)} of {total} matches {key!r} — "
                "cancel an older one by its full id from the Schedules page"
            )
        listed = "; ".join(f"{_short(r['id'])} {r['title']!r}" for r in own)
        raise ToolFailure(f"no timer of yours matches {key!r} — yours are: {listed}")
    if len(candidates) > 1:
        listed = "\n".join(_line(r) for r in candidates)
        raise ToolFailure(f"{key!r} matches {len(candidates)} timers — say which by id:\n{listed}")
    row = candidates[0]
    try:
        await store.delete(pool, row["id"])
    except store.TimerRefused as exc:
        raise ToolFailure(exc.reason) from exc
    words = store.timer_spec(row)["schedule_words"]
    return f"Cancelled {row['kind']} {row['title']!r} (id {_short(row['id'])}; was {words})."


# -- the tools ------------------------------------------------------------------------


def _obj(properties: dict, required: list[str]) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="create_timer",
        description=(
            "Set a reminder or schedule an instruction to run later. Give EXACTLY ONE of "
            "in_minutes (relative: 'in 20 minutes'), at (an absolute local time) or repeat "
            "(recurring). A reminder delivers `text` verbatim into this chat and as a desktop "
            "notification; a scheduled timer runs `text` as an instruction for you at that "
            "time and replies in this chat — or, with `agent`, as that agent (its tools, "
            "its folder, its cap), still replying in this chat. Absolute and repeating "
            "times use the household timezone (Settings → General); relative reminders "
            "need none."
        ),
        parameters=_obj(
            {
                "text": {
                    "type": "string",
                    "description": (
                        "For a reminder: the message to deliver, in the person's own words. "
                        "For a scheduled timer: the instruction to run."
                    ),
                },
                "kind": {
                    "type": "string",
                    "enum": list(KINDS),
                    "description": "'reminder' (default) or 'scheduled'.",
                },
                "in_minutes": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_IN_MINUTES,
                    "description": (
                        "Relative: fire this many minutes from now (up to one year; further "
                        "out, use at)."
                    ),
                },
                "at": {
                    "type": "string",
                    "description": (
                        "Absolute: a local wall time as 'YYYY-MM-DD HH:MM' (24-hour) in the "
                        "household timezone."
                    ),
                },
                "repeat": {
                    "type": "object",
                    "description": (
                        "Recurring: {every: 'minutes'|'hour'|'day'|'week'|'month', n?: minutes "
                        "between runs (every=minutes, at least 5), at?: 'HH:MM' time of day "
                        "(day/week/month; for hour, the minute past each hour as 'MM'), days?: "
                        "['mon',...] (week), day?: 1..31 (month)}."
                    ),
                },
                "device": {
                    "type": "string",
                    "description": (
                        "Reminders only: notify just this paired device (by name). Omit to "
                        "notify every connected paired device."
                    ),
                },
                "agent": {
                    "type": "string",
                    "description": (
                        "Scheduled only: the agent (by name, as list_agents shows it) the "
                        "turn runs as. Omit to run it yourself."
                    ),
                },
            },
            ["text"],
        ),
        executor=create_timer,
    ),
    Tool(
        name="list_timers",
        description=(
            "List this person's reminders and scheduled turns (and the system's housekeeping "
            "jobs): id, kind, title, when each next fires, which agent runs it (if any), and "
            "whether it is paused. An agent sees the scheduled turns bound to run as it. "
            "Takes no arguments."
        ),
        parameters=_obj({}, []),
        executor=list_timers,
        reads_only=True,
        result_kind=RESULT_KIND_LISTING,
    ),
    Tool(
        name="cancel_timer",
        description=(
            "Cancel one of this person's reminders or scheduled turns, by id (from "
            "list_timers) or by its exact title. An ambiguous title is refused with the "
            "candidates — never a guess."
        ),
        parameters=_obj(
            {
                "id_or_title": {
                    "type": "string",
                    "description": "The timer's id (full or the short form shown) or its title.",
                }
            },
            ["id_or_title"],
        ),
        executor=cancel_timer,
    ),
)
