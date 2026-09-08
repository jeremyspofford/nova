"""The schedule function: one closed set of spec shapes, computed in wall time.

Pure — no clock, no database. `validate` refuses every unknown key and every
missing field BY NAME (v3's `spec.get("day") or 1` turned "day 0" into "day
1" without a word; nothing here reads a field through a default), `next_after`
does all of its arithmetic in the spec's IANA zone and converts ONLY the answer
to UTC, and `describe` is the one place the words come from, so her reply and
the Schedules page cannot disagree about the same row.

The six shapes:

    {"kind": "once",    "at": "<ISO 8601 local wall time, no offset>"}
    {"kind": "minutes", "every": N}                    # N >= 5
    {"kind": "hour",    "minute": M}                   # 0..59
    {"kind": "day",     "at": "HH:MM"}
    {"kind": "week",    "days": ["mon", ...], "at": "HH:MM"}
    {"kind": "month",   "day": D, "at": "HH:MM"}       # D 1..31, clamped

Daylight saving, decided once here (pinned in tests/test_schedule.py against
America/New_York's 2026-03-08 forward and 2026-11-01 back transitions):

  * a wall time that does not exist on a forward day (02:30 on 2026-03-08)
    resolves to the FIRST INSTANT AFTER THE GAP (03:00 EDT) — the timer fires
    as soon as that clock reading is possible, never an hour late and never
    skipped;
  * an ambiguous wall time on a fall-back day (01:30 on 2026-11-01, which
    happens twice) takes the FIRST occurrence (fold=0, EDT) — one wall time
    fires once per wall day;
  * `hour` and `minutes` are CADENCES, not wall times, and are computed on
    the instant: `hour` is the next instant whose clock in the zone reads
    :MM, so it fires once per real hour through both transitions (01:30 EDT,
    01:30 EST, 02:30 EST on the fall-back night; 01:30 EST then 03:30 EDT
    across the gap) — never twice in thirty minutes, never a two-hour hole,
    never at a reading other than :MM.

A relative request ("in 20 minutes") is resolved by the CALLER into a `once`
at an absolute local wall time before validation; the store never holds a
duration, so nothing can re-resolve it later against a different "now".
"""
from __future__ import annotations

import calendar
import re
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

KINDS = ("once", "minutes", "hour", "day", "week", "month")
# The fields each kind carries, and nothing else. `kind` itself is implied.
FIELDS: dict[str, tuple[str, ...]] = {
    "once": ("at",),
    "minutes": ("every",),
    "hour": ("minute",),
    "day": ("at",),
    "week": ("days", "at"),
    "month": ("day", "at"),
}
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
MIN_EVERY_MINUTES = 5

_HHMM_RE = re.compile(r"^(\d{2}):(\d{2})$")
_SHAPES = (
    'once {"kind":"once","at":"YYYY-MM-DDTHH:MM"} (local wall time, no offset); '
    'minutes {"kind":"minutes","every":N} (N >= 5); '
    'hour {"kind":"hour","minute":M} (0..59); '
    'day {"kind":"day","at":"HH:MM"}; '
    'week {"kind":"week","days":["mon",...],"at":"HH:MM"}; '
    'month {"kind":"month","day":D,"at":"HH:MM"} (1..31, clamped to the month)'
)


class SpecError(ValueError):
    """A spec that cannot be stored, with the field and the accepted shape named."""


def _is_int(value: object) -> bool:
    # bool is an int to python and not to anyone reading a schedule: `true`
    # must never be stored as minute 1.
    return type(value) is int


def _hhmm(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise SpecError(f"{field} must be a string of the form HH:MM, got {value!r}")
    match = _HHMM_RE.match(value)
    if match is None:
        raise SpecError(f"{field} must be HH:MM (24-hour, two digits each), got {value!r}")
    hour, minute = int(match.group(1)), int(match.group(2))
    if not 0 <= hour <= 23 or not 0 <= minute <= 59:
        raise SpecError(f"{field} must be between 00:00 and 23:59, got {value!r}")
    return value


def _parse_hhmm(value: str) -> tuple[int, int]:
    hour, minute = value.split(":")
    return int(hour), int(minute)


def _local_wall(value: object) -> datetime:
    """A `once` `at`: ISO 8601 wall time with NO offset. An offset would make the
    row carry two zones (its own and the spec's) that could disagree."""
    if not isinstance(value, str):
        raise SpecError(f"at must be an ISO 8601 local wall time string, got {value!r}")
    try:
        wall = datetime.fromisoformat(value)
    except ValueError as exc:
        raise SpecError(
            f"at must be an ISO 8601 local wall time like 2026-09-06T14:32, got {value!r}"
        ) from exc
    if wall.tzinfo is not None:
        raise SpecError(
            f"at must carry no UTC offset — the timer's timezone supplies it, got {value!r}"
        )
    return wall.replace(second=0, microsecond=0)


def validate(spec: Any) -> dict:
    """The spec, normalized, or a SpecError naming the bad field and the shape.

    Every field is read with an explicit presence check — never `spec.get(k)
    or default`, which is how v3 stored day 0 as day 1. Unknown keys are refused
    by name so a misspelt field is a stated error, not a silently ignored one.
    """
    if not isinstance(spec, dict):
        raise SpecError(f"a schedule must be an object, got {type(spec).__name__} — {_SHAPES}")
    if "kind" not in spec:
        raise SpecError(f"a schedule needs a kind, one of {', '.join(KINDS)} — {_SHAPES}")
    kind = spec["kind"]
    if kind not in KINDS:
        raise SpecError(f"unknown schedule kind {kind!r} — one of {', '.join(KINDS)}")
    expected = FIELDS[kind]
    unknown = sorted(k for k in spec if k != "kind" and k not in expected)
    if unknown:
        raise SpecError(
            f"schedule kind {kind!r} does not take {', '.join(map(repr, unknown))} — "
            f"it takes {', '.join(expected)}"
        )
    missing = [k for k in expected if k not in spec]
    if missing:
        raise SpecError(
            f"schedule kind {kind!r} is missing {', '.join(map(repr, missing))} — "
            f"it takes {', '.join(expected)}"
        )

    if kind == "once":
        return {"kind": "once", "at": _local_wall(spec["at"]).isoformat(timespec="minutes")}
    if kind == "minutes":
        every = spec["every"]
        if not _is_int(every) or every < MIN_EVERY_MINUTES:
            raise SpecError(
                f"every must be a whole number of minutes, at least {MIN_EVERY_MINUTES}, "
                f"got {every!r}"
            )
        return {"kind": "minutes", "every": every}
    if kind == "hour":
        minute = spec["minute"]
        if not _is_int(minute) or not 0 <= minute <= 59:
            raise SpecError(f"minute must be a whole number 0..59, got {minute!r}")
        return {"kind": "hour", "minute": minute}
    if kind == "day":
        return {"kind": "day", "at": _hhmm(spec["at"], "at")}
    if kind == "week":
        days = spec["days"]
        if not isinstance(days, list) or not days:
            raise SpecError(
                f"days must be a non-empty list of {', '.join(DAYS)}, got {days!r}"
            )
        seen: list[str] = []
        for day in days:
            if day not in DAYS:
                raise SpecError(f"days contains {day!r} — each must be one of {', '.join(DAYS)}")
            if day in seen:
                raise SpecError(f"days repeats {day!r} — list each day once")
            seen.append(day)
        return {"kind": "week", "days": seen, "at": _hhmm(spec["at"], "at")}
    # month
    day_of_month = spec["day"]
    if not _is_int(day_of_month) or not 1 <= day_of_month <= 31:
        raise SpecError(f"day must be a whole number 1..31, got {day_of_month!r}")
    return {"kind": "month", "day": day_of_month, "at": _hhmm(spec["at"], "at")}


# -- wall time -> instant -----------------------------------------------------


def _zone(tz: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz)
    except Exception as exc:  # ZoneInfoNotFoundError, ValueError for "" or a path
        raise SpecError(f"{tz!r} is not an IANA timezone (e.g. America/New_York)") from exc


def _first_instant_after_gap(wall: datetime, zone: ZoneInfo) -> datetime:
    """`wall` fell into a DST gap. The two PEP 495 readings bracket the
    transition: fold=1 (the offset after the gap) lands BEFORE it, fold=0 (the
    offset before) lands after it, shifted by the gap's length. The transition
    instant itself — the first moment the clock reads >= `wall` — is found
    between them by bisection to the second, which is exact for every real
    zone (transitions fall on whole minutes)."""
    before = wall.replace(tzinfo=zone, fold=1).astimezone(UTC)
    after = wall.replace(tzinfo=zone, fold=0).astimezone(UTC)
    lo, hi = before, after
    while hi - lo > timedelta(seconds=1):
        mid = lo + (hi - lo) / 2
        mid = mid.replace(microsecond=0)
        if mid.astimezone(zone).replace(tzinfo=None) >= wall:
            hi = mid
        else:
            lo = mid
    return hi


def resolve(wall: datetime, zone: ZoneInfo) -> datetime:
    """A naive local wall time -> the UTC instant it names in `zone`.

    Exists: the instant. Ambiguous (fall-back hour): the first occurrence
    (fold=0). Non-existent (spring-forward gap): the first instant after the
    gap. Decided here, once, for every kind."""
    aware = wall.replace(tzinfo=zone, fold=0)
    instant = aware.astimezone(UTC)
    if instant.astimezone(zone).replace(tzinfo=None) == wall:
        return instant
    return _first_instant_after_gap(wall, zone)


def _month_len(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def next_after(spec: dict, after: datetime, tz: str) -> datetime | None:
    """The first firing STRICTLY after `after` (a UTC instant), as a UTC
    instant, or None when a `once` is at or before `after`.

    Strictly after, which is the whole reason this is `>` and not `>=`: the
    tick calls it with the instant a firing was claimed at, and `>=` would hand
    the same instant back and fire the row again on the next tick.

    All arithmetic is in the zone's wall time — `day at 07:00` is 07:00 on the
    clock the household reads, on both sides of a DST change — and ONLY the
    answer is converted to UTC, through `resolve`, which is where the gap and
    fold rules live.
    """
    if after.tzinfo is None:
        raise ValueError("next_after needs an aware UTC instant, got a naive datetime")
    spec = validate(spec)
    zone = _zone(tz)
    local = after.astimezone(zone)
    today = local.date()
    kind = spec["kind"]

    if kind == "once":
        instant = resolve(datetime.fromisoformat(spec["at"]), zone)
        return instant if instant > after else None

    if kind == "minutes":
        # An interval is a DURATION, not a wall time: five minutes is five
        # minutes across a DST change too, so this is the one shape computed
        # on the instant itself.
        return after + timedelta(minutes=spec["every"])

    if kind == "hour":
        # A cadence on the instant, like `minutes`: the next instant strictly
        # after `after` whose clock in the zone reads :MM. Walked minute by
        # minute (offsets are whole minutes in every zone) so it holds through
        # a fall-back hour (01:30 EDT, then 01:30 EST — the fold rule above
        # would skip the second and leave a two-hour hole once a year) and a
        # forward gap (01:30 EST, then 03:30 EDT — never a firing at 03:00).
        candidate = after.replace(second=0, microsecond=0)
        for _ in range(3 * 60 + 1):
            candidate += timedelta(minutes=1)
            if candidate.astimezone(zone).minute == spec["minute"]:
                return candidate
        raise AssertionError("an hourly schedule always has a next instant within 3 hours")

    hour, minute = _parse_hhmm(spec["at"])

    def at_on(day: date) -> datetime:
        return resolve(datetime(day.year, day.month, day.day, hour, minute), zone)

    if kind == "day":
        for step in range(3):
            instant = at_on(today + timedelta(days=step))
            if instant > after:
                return instant
        raise AssertionError("a daily schedule always has a next instant within 3 days")

    if kind == "week":
        wanted = {DAYS.index(d) for d in spec["days"]}
        # Today, then a full week, then one more day: "the time has already
        # passed today" must land on the SAME weekday next week, never be
        # skipped.
        for step in range(9):
            day = today + timedelta(days=step)
            if day.weekday() not in wanted:
                continue
            instant = at_on(day)
            if instant > after:
                return instant
        raise AssertionError("a weekly schedule always has a next instant within 9 days")

    # month
    year, month = today.year, today.month
    for _ in range(14):
        # CLAMPED, never skipped: "day 31" in a 30-day month (or in February)
        # means the last day of it. Skipping the month is how a monthly job
        # silently runs seven times a year.
        day = min(spec["day"], _month_len(year, month))
        instant = at_on(date(year, month, day))
        if instant > after:
            return instant
        month += 1
        if month == 13:
            year, month = year + 1, 1
    raise AssertionError("a monthly schedule always has a next instant within 14 months")


# -- words --------------------------------------------------------------------


def local_words(instant: datetime, tz: str, *, with_year: bool = True) -> str:
    """One instant in the zone's own words: "Sat 6 Sep 2026 14:32 EDT"."""
    local = instant.astimezone(_zone(tz))
    day = f"{local:%a} {local.day} {local:%b}"
    if with_year:
        day = f"{day} {local.year}"
    return f"{day} {local:%H:%M} {local.tzname()}"


def _relative(now: datetime, then: datetime) -> str:
    """"in 2 minutes" / "in 3 hours" / "in 2 days" — coarse on purpose; the
    absolute time stands beside it."""
    seconds = (then - now).total_seconds()
    if seconds < 0:
        return "already passed"
    minutes = round(seconds / 60)
    if minutes < 1:
        return "in under a minute"
    if minutes < 90:
        return f"in {minutes} minute{'s' if minutes != 1 else ''}"
    hours = round(minutes / 60)
    if hours < 36:
        return f"in {hours} hour{'s' if hours != 1 else ''}"
    days = round(hours / 24)
    return f"in {days} day{'s' if days != 1 else ''}"


def describe(spec: dict, tz: str, next: datetime | None, *, now: datetime | None = None) -> str:
    """The words for a schedule and its next firing — the tool's reply and the
    page's row read the SAME sentence from here.

        once, Sat 6 Sep 2026 14:32 EDT (in 2 minutes)
        every day at 07:00 America/New_York, next Sun 7 Sep 07:00 EDT

    `next` is the row's next_fire_at (None only for a `once` that has fired,
    which reads "finished"). `now` is optional and supplied by the caller — this
    module owns no clock; with it, a `once` also says how far away it is.
    """
    spec = validate(spec)
    kind = spec["kind"]
    if kind == "once":
        if next is None:
            return f"once, {spec['at'].replace('T', ' ')} {tz} — finished"
        words = f"once, {local_words(next, tz)}"
        return f"{words} ({_relative(now, next)})" if now is not None else words

    if kind == "minutes":
        head = f"every {spec['every']} minutes"
    elif kind == "hour":
        head = f"every hour at :{spec['minute']:02d} {tz}"
    elif kind == "day":
        head = f"every day at {spec['at']} {tz}"
    elif kind == "week":
        names = ", ".join(d.capitalize() for d in spec["days"])
        head = f"every {names} at {spec['at']} {tz}"
    else:
        head = f"every month on day {spec['day']} at {spec['at']} {tz}"
    if next is None:
        return head
    return f"{head}, next {local_words(next, tz, with_year=False)}"
