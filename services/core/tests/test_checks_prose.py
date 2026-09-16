"""S25.2.1 — the shared vocabulary a card's sentence is built from.

Pure functions, so these are pure tests: no database, no beat, no clock. The
one property worth more than the rest is the LAST describe — that nothing
here can put a word meaning "now" into a sentence that is written once and
read for weeks.
"""

from __future__ import annotations

import ast
import datetime as dt
import re
from pathlib import Path
from zoneinfo import ZoneInfo

from app import checks
from app.checks import prose

CHICAGO = ZoneInfo("America/Chicago")
UTC = dt.UTC

# 2026-09-11 is a Friday in UTC — and 7:35pm UTC is 2:35pm in Chicago, still
# the Friday. The pair matters: it is what proves the zone is applied rather
# than the string being formatted from the UTC fields.
FRIDAY = dt.datetime(2026, 9, 11, 19, 35, 29, tzinfo=UTC)


def test_counts_read_as_words_until_words_stop_helping():
    assert prose.times(1) == "once"
    assert prose.times(2) == "twice"
    assert prose.times(3) == "three times"
    assert prose.times(12) == "twelve times"
    # Past that a number is reporting a magnitude, and spelling it out reads
    # as a stunt rather than as prose.
    assert prose.times(37) == "37 times"


def test_a_day_is_named_in_his_zone_not_the_boxs():
    assert prose.on_day(FRIDAY, CHICAGO) == "Friday 11 September 2026"
    # The same instant, one zone east of the date line's problem: 7:35pm UTC
    # is 4:35am Saturday in Tokyo, and the sentence must say Saturday.
    assert prose.on_day(FRIDAY, ZoneInfo("Asia/Tokyo")) == "Saturday 12 September 2026"


def test_a_naive_timestamp_is_read_as_utc_rather_than_guessed():
    """Every timestamp a check holds came from a `timestamptz` column, so a
    naive one is a bug upstream. Reading it as the box's local time would
    move the sentence by hours and hide that."""
    naive = FRIDAY.replace(tzinfo=None)
    assert prose.on_day(naive, CHICAGO) == prose.on_day(FRIDAY, CHICAGO)
    assert prose.at_clock(naive, CHICAGO) == prose.at_clock(FRIDAY, CHICAGO)


def test_the_clock_is_written_the_way_it_is_said():
    assert prose.at_clock(FRIDAY, CHICAGO) == "2:35pm"
    assert prose.at_clock(dt.datetime(2026, 9, 11, 5, 4, tzinfo=UTC), CHICAGO) == "12:04am"
    assert prose.at_clock(dt.datetime(2026, 9, 11, 17, 0, tzinfo=UTC), CHICAGO) == "12:00pm"


def test_a_span_is_one_unit_and_never_rounds_up():
    assert prose.lasting(0) == "0 seconds"
    assert prose.lasting(1) == "1 second"
    assert prose.lasting(59.9) == "59 seconds"
    assert prose.lasting(60) == "1 minute"
    assert prose.lasting(3599) == "59 minutes"
    assert prose.lasting(3600 * 25) == "1 day"
    # Truncated, not rounded: at 3 days and 23 hours it still says 3 days,
    # because a card must never claim more time has passed than has.
    assert prose.lasting(86400 * 3 + 3600 * 23) == "3 days"
    assert prose.lasting(-5) == "0 seconds"


def test_a_name_reaches_him_the_way_he_typed_it():
    """`repr()` was doing this and brought Python's punctuation along: the
    quoting style flips when the name contains an apostrophe, and anything
    non-ASCII arrives as escapes."""
    assert prose.named("Jeremy's backup") == "“Jeremy's backup”"
    assert prose.named("café run") == "“café run”"


def test_nothing_here_can_write_a_word_that_means_now():
    """The load-bearing one. A title is composed ONCE — `notices.record`
    folds a repeat onto the live row and never rewrites `title` — so it is
    read hours or weeks after it was written. "paused since this morning" is
    then simply false, and false reads as authoritative.

    Every phrase this module can produce is checked against the vocabulary
    that would make that possible. The relative phrasing belongs to the
    card, which knows what time it is.
    """
    relative = ("today", "yesterday", "tomorrow", "this ", "ago", "now", "tonight", "last night")
    phrases = [
        prose.on_day(FRIDAY, CHICAGO),
        prose.since_day(FRIDAY, CHICAGO),
        prose.at_clock(FRIDAY, CHICAGO),
        prose.lasting(86400 * 3),
        prose.times(3),
        prose.named("a timer"),
    ]
    for phrase in phrases:
        for word in relative:
            assert word not in phrase.lower(), f"{phrase!r} contains {word!r}"


def test_since_is_the_same_day_with_the_word_in_front():
    """Not a second format that could drift from the first."""
    assert prose.since_day(FRIDAY, CHICAGO) == f"since {prose.on_day(FRIDAY, CHICAGO)}"


# ---------------------------------------------------------------------------
# What refuses, when a future check writes for a log again
# ---------------------------------------------------------------------------


def _title_expressions() -> list[tuple[str, int, ast.expr]]:
    """Every `title=` argument of every `Finding(...)` built in app/checks,
    read out of the live source.

    DERIVED, not a list someone maintains: a check family added next month is
    walked by this the day it lands, which is the only way a rule about how
    cards are written survives the person who wrote it.
    """
    found: list[tuple[str, int, ast.expr]] = []
    for path in sorted(Path(checks.__file__).parent.glob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = node.func.id if isinstance(node.func, ast.Name) else None
            if name != "Finding":
                continue
            for kw in node.keywords:
                if kw.arg == "title":
                    found.append((path.name, node.lineno, kw.value))
    return found


def test_every_check_family_is_actually_walked_by_the_guard_below():
    """The guard is worthless if it silently walks nothing — a quiet reporter
    is indistinguishable from a dead one. So: the families are found, and
    each one really does build titles."""
    titles = _title_expressions()
    assert len(titles) >= 10, f"only {len(titles)} Finding(title=...) sites were found"
    families = {name for name, _line, _expr in titles}
    assert {"work.py", "money.py", "stack.py", "skills.py"} <= families


def test_no_cards_sentence_may_carry_a_machine_timestamp():
    """The defect S25.2.1 names, as a line of code that refuses.

        the beat 'Distil: …' is paused since 2026-09-11T14:35:29+00:00

    `isoformat()` is how that got there, and it is never what a person wants
    to read. The ISO string still belongs in `facts` — the card renders "two
    days ago" from it — so this rule is about the SENTENCE only, and looks at
    the title expression alone.
    """
    offenders = []
    for name, line, expr in _title_expressions():
        for node in ast.walk(expr):
            if isinstance(node, ast.Attribute) and node.attr == "isoformat":
                offenders.append(f"{name}:{line}")
    assert offenders == [], (
        "these cards would be stamped with a machine timestamp — compose the "
        f"day with checks.prose instead: {offenders}"
    )


# The deliberate exceptions, named one expression at a time — the same shape
# the linked-subject rule uses for a subject with no route (S25.2.2). Here the
# repr IS the fact being reported: `stack.database_down` fires when postgres
# answered SELECT 1 with something other than 1, and "answered 1" would hide
# the whole point of the card, which is that the 1 was a string.
_REPR_IS_THE_FACT = {"answer"}


def test_no_cards_sentence_may_carry_a_python_repr():
    """`{name!r}` was the other half of it. It brings Python's punctuation
    into his sentence: the quotes flip style around an apostrophe and a
    non-ASCII name arrives as escapes. `prose.named` is the same intent
    without the language showing through."""
    offenders = []
    for name, line, expr in _title_expressions():
        for node in ast.walk(expr):
            if not isinstance(node, ast.FormattedValue) or node.conversion != ord("r"):
                continue
            if ast.unparse(node.value) in _REPR_IS_THE_FACT:
                continue
            offenders.append(f"{name}:{line}")
    assert offenders == [], f"use prose.named() rather than !r in a card's sentence: {offenders}"


# ---------------------------------------------------------------------------
# S25.2.2 — a subject cannot become quietly unlinkable
# ---------------------------------------------------------------------------

# The web's registry, read where it lives. Keeping a copy of it here would be
# the drift this whole test exists to prevent: the day someone adds a route
# there, the copy is what would be wrong.
_WEB_FORMAT = (
    Path(__file__).resolve().parents[3] / "apps/web/src/pages/inbox/inboxFormat.ts"
)


def _keys_of(block: str, source: str) -> set[str]:
    """The keys of one exported object literal in the TypeScript file.

    Text, not a parser, and the guard below refuses an empty answer for
    exactly that reason: if this ever stops matching, the failure must be
    loud. A guard that silently walks nothing reads identically to a guard
    that found nothing wrong.
    """
    start = source.index(f"export const {block}")
    body = source[start : source.index("\n}", start)]
    return set(re.findall(r"^\s{2}(\w+):", body, re.MULTILINE))


def _fact_keys() -> dict[str, set[str]]:
    """Every key of every `facts={...}` literal in app/checks, by file.

    Derived from the source the same way the title guard is, so a check
    family added next month is walked the day it lands.
    """
    by_file: dict[str, set[str]] = {}
    for path in sorted(Path(checks.__file__).parent.glob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if not (isinstance(node.func, ast.Name) and node.func.id == "Finding"):
                continue
            for kw in node.keywords:
                if kw.arg != "facts" or not isinstance(kw.value, ast.Dict):
                    continue
                for key in kw.value.keys:
                    if isinstance(key, ast.Constant) and isinstance(key.value, str):
                        by_file.setdefault(path.name, set()).add(key.value)
    return by_file


def test_the_subject_registry_is_where_this_test_thinks_it_is():
    """Read before it is trusted: a moved or renamed file must fail here
    rather than turn the rule below into a no-op."""
    assert _WEB_FORMAT.exists(), f"{_WEB_FORMAT} is gone — the rule below is now vacuous"
    source = _WEB_FORMAT.read_text()
    assert _keys_of("SUBJECT_ROUTES", source), "no routes were parsed out of the registry"
    assert _keys_of("UNLINKED_SUBJECTS", source), "no deliberate exceptions were parsed"
    assert _fact_keys(), "no facts were found in any check"


def test_every_id_a_check_emits_is_a_link_or_a_stated_exception():
    """The rule S25.2.2 asks for, as the line of code that refuses.

    A fact whose key ends `_id` names something the owner might want to go
    and look at. It either resolves to a route or is listed as deliberately
    unlinked WITH ITS REASON — a third option (nobody noticed) is what this
    fails on, because an id rendered as grey text says nothing about why it
    cannot be followed.
    """
    source = _WEB_FORMAT.read_text()
    known = _keys_of("SUBJECT_ROUTES", source) | _keys_of("UNLINKED_SUBJECTS", source)
    unaccounted = {
        f"{name}:{key}"
        for name, keys in _fact_keys().items()
        for key in keys
        if key.endswith("_id") and key not in known
    }
    assert unaccounted == set(), (
        "these subjects are neither linked nor deliberately unlinked — add a "
        "route to SUBJECT_ROUTES or a reason to UNLINKED_SUBJECTS in "
        f"{_WEB_FORMAT.name}: {sorted(unaccounted)}"
    )


def test_a_subject_is_never_both_linked_and_deliberately_unlinked():
    """The two halves are a partition. Overlapping, the reason beside an
    unlinked subject would be a sentence that is simply false."""
    source = _WEB_FORMAT.read_text()
    both = _keys_of("SUBJECT_ROUTES", source) & _keys_of("UNLINKED_SUBJECTS", source)
    assert both == set(), f"listed as both linked and unlinked: {sorted(both)}"
