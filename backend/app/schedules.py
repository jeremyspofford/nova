"""When does this run next? Calendar recurrence, not just "every N minutes".

Jeremy, 2026-08-06:

    "scheduling things shouldn't just be a number of minutes, we should be
     able to set a date, or every monday, things like that, just like I might
     on apple's reminders app, or google reminders or calendars."

He hit it the same evening. He asked "can you remember to tell me tomorrow to
see what their current rate is?", and the only thing `automations` could
express was `interval_minutes`, so "tomorrow" became `next_run_at = now +
1440 minutes` — a reminder that fires forever, daily, at whatever o'clock he
happened to ask. Nova called it a "one-shot morning reminder" in its own
description and then told him it would fire at 5:24 PM, because there was no
field in which either sentence could be true.

WHY THIS FILE IS PURE, AND WHY THAT IS THE WHOLE DESIGN. The scheduler already
reads exactly one thing — `automations.next_run_at <= now()` — so recurrence
never has to touch it. Everything here is "given a spec and a moment, when is
the next moment", which is a function with no database, no clock of its own
and no side effects, and therefore the one piece of this feature that can be
exhaustively tested. `record_run` calls it and writes the answer down.

THE OPERATOR'S TIMEZONE IS NOT OPTIONAL. "Every Monday at 9" means nine in the
morning where he is, and a UTC-only scheduler is how a weekly job ends up
firing on Sunday evening for half the year. All arithmetic happens in
`nova.timezone` and only the final answer is converted back, so a DST boundary
moves the UTC instant rather than the wall-clock time he asked for.
"""

from __future__ import annotations

import re
from datetime import date as _date, datetime, time, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

#: Accepted `every` values. `minutes` is the old world, kept exactly as it was
#: so every existing row keeps behaving identically with no migration of data.
KINDS = ("minutes", "hour", "day", "week", "month", "once")

_DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")

#: A floor for repeating schedules, matching the old `interval_minutes >= 5`.
#: `once` is exempt: a one-shot at a named instant is not a rate.
MIN_INTERVAL_MIN = 5


class ScheduleError(ValueError):
    """Bad spec. The message is shown to whoever wrote it — operator or model
    — so it names the field and says what to write instead."""


def _tz(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except Exception:                                    # noqa: BLE001
        return ZoneInfo("UTC")


def _parse_time(raw: Any, field: str = "at") -> time:
    m = _TIME_RE.match(str(raw or "").strip())
    if not m:
        raise ScheduleError(
            f"`{field}` must be a 24-hour time like \"09:00\" or \"17:30\", "
            f"got {raw!r}")
    return time(int(m.group(1)), int(m.group(2)))


def validate(spec: Any) -> dict:
    """Normalise a schedule spec, or raise ScheduleError naming the problem.

    Returns a plain dict safe to store as jsonb. Unknown keys are REFUSED
    rather than ignored: a typo'd `on` that silently became "every day" would
    be a schedule the operator believes he set and never did, which is the
    same class of failure as a tool that reports success it did not check.
    """
    if not isinstance(spec, dict):
        raise ScheduleError("schedule must be an object, e.g. "
                            "{\"every\": \"week\", \"on\": [\"mon\"], "
                            "\"at\": \"09:00\"}")
    every = str(spec.get("every") or "").strip().lower()
    if every not in KINDS:
        raise ScheduleError(
            f"`every` must be one of {', '.join(KINDS)} — got {every!r}")

    allowed = {"minutes": {"every", "n"},
               "hour": {"every", "n", "minute"},
               "day": {"every", "at"},
               "week": {"every", "on", "at"},
               "month": {"every", "day", "at"},
               "once": {"every", "date", "at"}}[every]
    extra = set(spec) - allowed
    if extra:
        raise ScheduleError(
            f"`{every}` schedules do not take {', '.join(sorted(extra))}. "
            f"Allowed: {', '.join(sorted(allowed))}")

    if every == "minutes":
        n = int(spec.get("n") or 0)
        if n < MIN_INTERVAL_MIN:
            raise ScheduleError(f"`n` must be at least {MIN_INTERVAL_MIN} minutes")
        return {"every": "minutes", "n": n}

    if every == "hour":
        # `spec.get("n") or 1` would turn a typo'd 0 into 1 — the silent
        # substitution this whole module exists to refuse. Absent means the
        # default; present means it is checked.
        n = int(spec["n"]) if spec.get("n") is not None else 1
        if n < 1:
            raise ScheduleError("`n` must be at least 1 hour")
        minute = int(spec.get("minute") or 0)
        if not 0 <= minute <= 59:
            raise ScheduleError("`minute` must be between 0 and 59")
        return {"every": "hour", "n": n, "minute": minute}

    if every == "day":
        return {"every": "day", "at": _parse_time(spec.get("at", "09:00")).strftime("%H:%M")}

    if every == "week":
        raw = spec.get("on") or []
        if isinstance(raw, str):
            raw = [raw]
        days = [str(d).strip().lower()[:3] for d in raw]
        bad = [d for d in days if d not in _DAYS]
        if bad or not days:
            raise ScheduleError(
                f"`on` must be one or more of {', '.join(_DAYS)} — "
                f"got {raw!r}")
        # Sorted by weekday so two specs meaning the same thing are the same
        # document, and deduplicated so ["mon","mon"] cannot skew anything.
        days = sorted(set(days), key=_DAYS.index)
        return {"every": "week", "on": days,
                "at": _parse_time(spec.get("at", "09:00")).strftime("%H:%M")}

    if every == "month":
        # Same reason as `hour`'s n: `or 1` accepted day 0 and quietly filed it
        # as the 1st, which the suite caught on its first run.
        day = int(spec["day"]) if spec.get("day") is not None else 1
        if not 1 <= day <= 31:
            raise ScheduleError("`day` must be between 1 and 31")
        return {"every": "month", "day": day,
                "at": _parse_time(spec.get("at", "09:00")).strftime("%H:%M")}

    # once
    raw = str(spec.get("date") or "").strip()
    try:
        on = _date.fromisoformat(raw)
    except ValueError:
        raise ScheduleError(
            f"`date` must be YYYY-MM-DD, got {raw!r}") from None
    return {"every": "once", "date": on.isoformat(),
            "at": _parse_time(spec.get("at", "09:00")).strftime("%H:%M")}


def is_one_shot(spec: Optional[dict]) -> bool:
    """Does this schedule fire once and stop?

    The caller DISABLES the automation after a one-shot run rather than
    computing an unreachable `next_run_at`. A row that says "next run: never"
    and stays enabled is a row every later reader has to interpret.
    """
    return bool(spec) and spec.get("every") == "once"


def describe(spec: Optional[dict], interval_minutes: int = 0) -> str:
    """One line, in the operator's words, for a card or a tool result."""
    if not spec:
        return f"every {interval_minutes} minutes"
    e = spec["every"]
    if e == "minutes":
        return f"every {spec['n']} minutes"
    if e == "hour":
        n = spec["n"]
        return (f"every hour at :{spec['minute']:02d}" if n == 1
                else f"every {n} hours at :{spec['minute']:02d}")
    if e == "day":
        return f"every day at {spec['at']}"
    if e == "week":
        names = ", ".join(d.capitalize() for d in spec["on"])
        return f"every {names} at {spec['at']}"
    if e == "month":
        return f"on day {spec['day']} of each month at {spec['at']}"
    return f"once, on {spec['date']} at {spec['at']}"


def _at_on(day: _date, at: str, tz: ZoneInfo) -> datetime:
    h, m = at.split(":")
    return datetime(day.year, day.month, day.day, int(h), int(m), tzinfo=tz)


def next_after(spec: Optional[dict], after: datetime, tz_name: str = "UTC",
               interval_minutes: int = 0) -> Optional[datetime]:
    """The first firing strictly after `after`, in UTC. None if never again.

    `after` may be naive; it is read as UTC, because every caller here holds a
    UTC instant and a naive datetime that silently meant local time would move
    every schedule by the offset.

    STRICTLY AFTER, which is the whole reason this is not `>=`: `record_run`
    calls it with the moment the run finished, and a `>=` would hand back the
    same instant and fire the job again immediately.
    """
    if after.tzinfo is None:
        after = after.replace(tzinfo=timezone.utc)
    if not spec:
        return after + timedelta(minutes=max(interval_minutes, MIN_INTERVAL_MIN))

    tz = _tz(tz_name)
    local = after.astimezone(tz)
    e = spec["every"]

    if e == "minutes":
        return after + timedelta(minutes=spec["n"])
    if e == "hour":
        cand = local.replace(minute=spec["minute"], second=0, microsecond=0)
        while cand <= local:
            cand += timedelta(hours=spec["n"])
        return cand.astimezone(timezone.utc)
    if e == "day":
        cand = _at_on(local.date(), spec["at"], tz)
        if cand <= local:
            cand = _at_on(local.date() + timedelta(days=1), spec["at"], tz)
        return cand.astimezone(timezone.utc)
    if e == "week":
        wanted = {_DAYS.index(d) for d in spec["on"]}
        # At most 8 steps: today, then a full week. The extra day covers "the
        # time has already passed today", which must land on the SAME weekday
        # next week rather than being skipped.
        for step in range(0, 8):
            day = local.date() + timedelta(days=step)
            if day.weekday() not in wanted:
                continue
            cand = _at_on(day, spec["at"], tz)
            if cand > local:
                return cand.astimezone(timezone.utc)
        return None                                   # unreachable; `on` is non-empty
    if e == "month":
        y, m = local.year, local.month
        for _ in range(14):
            last = _month_len(y, m)
            # CLAMPED, not skipped. "Day 31" in a 30-day month means the last
            # day of it — skipping the month is how a monthly job silently
            # runs seven times a year.
            cand = _at_on(_date(y, m, min(spec["day"], last)), spec["at"], tz)
            if cand > local:
                return cand.astimezone(timezone.utc)
            m += 1
            if m == 13:
                y, m = y + 1, 1
        return None
    # once
    cand = _at_on(_date.fromisoformat(spec["date"]), spec["at"], tz)
    return cand.astimezone(timezone.utc) if cand > local else None


def _month_len(year: int, month: int) -> int:
    nxt = _date(year + (month == 12), 1 if month == 12 else month + 1, 1)
    return (nxt - timedelta(days=1)).day
