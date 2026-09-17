"""One vocabulary for the sentences on a card (S25.2.1).

A card's sentence is composed IN CODE, by the check that found it, and that
does not change here. A model-written card is a claim nobody checked, and
the Inbox is the one surface where the sentence IS the product. What was
wrong is not that the sentences are derived; it is that they were written
for a log:

    the beat 'Distil: turn what was said into facts her memory can find' is
    paused since 2026-09-11T14:35:29+00:00 — no beat named 'distil'

Accurate, and unreadable. So: better composition, same authorship. Fifteen
checks share this vocabulary rather than each inventing one, which is also
the only way the Inbox reads like one voice instead of fifteen.

THE CONSTRAINT THAT SHAPES EVERY FUNCTION HERE
----------------------------------------------
A title is written ONCE. `notices.record` folds a repeat sighting onto the
live row with `repeats = repeats + 1, last_seen_at = now()` and does not
touch `title` — deliberately, since the sentence belongs to the fingerprint
it was raised under. A title is therefore read hours or weeks after it was
composed, and anything in it that means "relative to now" has become false
by then. "paused since this morning", frozen on a Tuesday card and read on
Friday, is worse than the ISO timestamp it replaced: unreadable is a
nuisance, wrong is a defect.

So everything here is ABSOLUTE and stays true — "on Thursday 11 September
2026" — and the relative phrasing he actually wants when he opens the Inbox
("paused since Thursday morning", "3 days ago") is rendered by the CARD from
`facts`, at read time, where `now` is known and the answer can be right.

That is the same split as the linked subjects (S25.2.2): the FACT goes in
`facts`, and the rendering happens where it can be correct. A check that
wants the timestamp in words puts it in both — the sentence carries the
stable form so the digest reads well, and `facts` carries the ISO string so
the card can say "two days ago" as the days pass.
"""

from __future__ import annotations

import datetime as dt
import logging
from zoneinfo import ZoneInfo

logger = logging.getLogger("core")

# One run's cached timezone. Namespaced like every other run_cache key so two
# users of the scratch cannot collide.
_ZONE_KEY = "checks.prose.zone"

# Spelled-out counts read as prose up to here and as noise past it: "she
# tried fourteen times" is a sentence, "she tried 37 times" is a measurement,
# and a card carrying a number that large is reporting a magnitude rather
# than telling a story about it.
_WORDS = (
    "zero",
    "once",
    "twice",
    "three times",
    "four times",
    "five times",
    "six times",
    "seven times",
    "eight times",
    "nine times",
    "ten times",
    "eleven times",
    "twelve times",
)


def times(n: int) -> str:
    """A count of occurrences, in words where words read better.

    `once` and `twice` rather than "1 times"/"2 times", which is the whole
    reason a check cannot just interpolate the integer.
    """
    if 0 <= n < len(_WORDS):
        return _WORDS[n]
    return f"{n} times"


def on_day(when: dt.datetime, tz: ZoneInfo) -> str:
    """A moment, as a day he can place: "Thursday 11 September 2026".

    The weekday earns its place — for anything recent it is how a person
    actually locates a day — and so does the year, because this string is
    frozen into a title that outlives the year it was written in. No
    "today", no "yesterday", no "this morning": see the module docstring for
    why a stored sentence may not contain a word that means "now".

    Naive datetimes are read as UTC rather than as local time. Every
    timestamp a check has comes from postgres `timestamptz`, so a naive one
    is a bug upstream, and guessing the box's local zone would hide it.
    """
    if when.tzinfo is None:
        when = when.replace(tzinfo=dt.UTC)
    local = when.astimezone(tz)
    return f"{local:%A} {local.day} {local:%B %Y}"


def on_date(day: dt.date) -> str:
    """A calendar DAY that was never a moment: "Friday 11 September 2026".

    No timezone, and not because one was forgotten. A `date` is already the
    answer to "which day" — the ledger's spend day, a month boundary — so
    converting it through a zone could only move it to the wrong one.
    """
    return f"{day:%A} {day.day} {day:%B %Y}"


def since_day(when: dt.datetime, tz: ZoneInfo) -> str:
    """ "since Thursday 11 September 2026" — `on_day` where the sentence wants
    a duration rather than a date."""
    return f"since {on_day(when, tz)}"


def at_clock(when: dt.datetime, tz: ZoneInfo) -> str:
    """The time of day, where the hour is part of the fact: "2:35pm".

    Lowercase and without a leading zero, which is how it is written down
    rather than how a clock displays it.
    """
    if when.tzinfo is None:
        when = when.replace(tzinfo=dt.UTC)
    local = when.astimezone(tz)
    return f"{local.hour % 12 or 12}:{local:%M}{'am' if local.hour < 12 else 'pm'}"


def lasting(seconds: float) -> str:
    """A span of time, at ONE unit of precision: "3 days", "4 hours",
    "12 minutes", "8 seconds".

    One unit on purpose. "3 days, 4 hours and 12 minutes" is a stopwatch
    reading, and a card is trying to tell him roughly how long something has
    been wrong. The value is truncated rather than rounded, so the sentence
    never claims more time has passed than actually has.
    """
    seconds = max(0.0, float(seconds))
    for size, unit in ((86400.0, "day"), (3600.0, "hour"), (60.0, "minute")):
        if seconds >= size:
            n = int(seconds // size)
            return f"{n} {unit}" if n == 1 else f"{n} {unit}s"
    n = int(seconds)
    return "1 second" if n == 1 else f"{n} seconds"


def named(text: str) -> str:
    """A thing with a name, quoted so the sentence around it stays legible.

    `repr()` was doing this job and brought Python's punctuation with it —
    the quote style flips to double when the name contains an apostrophe, and
    a non-ASCII name comes back as escapes. A name the owner gave something
    should reach him the way he typed it.
    """
    return f"“{text}”"


async def zone(pool) -> ZoneInfo:
    """His timezone, read ONCE per beat run and shared by every check in it.

    Fifteen checks each reading `settings` for the same string would be
    fifteen queries for one beat's worth of sentences, so the answer lands
    in `checks.run_cache()` — whose lifetime is exactly one `run_all`.

    A stored zone that will not load falls back to UTC and SAYS SO in the
    log. The alternative was letting `ToolFailure` out of a title composer,
    which would turn a bad settings row into "the check could not run" for
    every check at once — a misconfigured clock must not read as a blind
    box. The sentence is then an hour or two out and honestly recorded;
    `beats` already refuses to re-time the digest against the same value,
    with the reason.
    """
    from app.checks import run_cache

    cache = run_cache()
    hit = cache.get(_ZONE_KEY)
    if isinstance(hit, ZoneInfo):
        return hit

    from app.tools.timers import household_timezone

    try:
        name, _is_set = await household_timezone(pool)
        found = ZoneInfo(name)
    except Exception as exc:  # noqa: BLE001 - the reason is the record
        logger.warning(
            "the household timezone could not be read, so this beat's cards are timed in UTC — %s",
            exc,
        )
        found = ZoneInfo("UTC")
    cache[_ZONE_KEY] = found
    return found
