"""Her side of scheduling: create_timer / list_timers / cancel_timer through
dispatch, against a real database.

Every refusal is pinned BY NAME — the model reads these words and decides what
to send next, so a refusal that names the wrong field is a defect, not a
wording choice. The no-timezone sentence is pinned verbatim (the plan's exact
words), the confirmation's words are proved to be describe()'s (the same
sentence the Schedules page reads off the row), the list is proved to be the
person's own, and a cancel by an ambiguous title is proved to list the
candidates rather than guess.
"""
from __future__ import annotations

import re
import time
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app import schedule, timers, tools
from app.identity import Person
from app.main import app
from app.tools import timers as timer_tools
from app.tools.base import ToolContext
from tests.conftest import requires_db

pytestmark = requires_db

NY = "America/New_York"
NO_TIMEZONE_RESULT = (
    "Error: no timezone is set for this instance yet — it is set in Settings → General (or "
    'during setup); relative reminders ("in 20 minutes") work without one.'
)


async def _person(pool, name: str = "jeremy", role: str = "owner") -> tuple[Person, uuid.UUID]:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, $2) RETURNING id", name, role
    )
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", pid
    )
    return Person(id=pid, name=name, role=role), conversation


async def _set_timezone(pool, zone: str) -> None:
    # The same row Settings → General writes (settings_store.write_setting).
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('nova.timezone', $1::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        zone,
    )


def _ctx(person: Person, tmp_path) -> ToolContext:
    return ToolContext(app=app, person=person, workspace_root=tmp_path)


async def _create(ctx, **args) -> tuple[str, bool]:
    return await tools.dispatch("create_timer", args, ctx)


async def _rows(pool, person: Person):
    return await pool.fetch(
        "SELECT * FROM timers WHERE person_id = $1 ORDER BY created_at", person.id
    )


def _tomorrow_at(hour: int = 7) -> str:
    return (datetime.now(UTC) + timedelta(days=1)).strftime(f"%Y-%m-%d {hour:02d}:00")


# -- relative creation: the row, its words, where it lands ----------------------


async def test_a_relative_reminder_is_a_row_with_describes_words_and_lands_in_the_active_chat(
    pool, tmp_path
):
    person, conversation = await _person(pool)
    before = await pool.fetchval("SELECT now()")

    result, ok = await _create(_ctx(person, tmp_path), text="stretch", in_minutes=2)

    assert ok is True, result
    (row,) = await _rows(pool, person)
    assert row["kind"] == "reminder"
    assert row["title"] == "stretch"
    assert row["payload"] == {"message": "stretch", "device": None}
    assert row["schedule"]["kind"] == "once"
    assert row["created_via"] == "chat"
    # The ToolContext carries no turn, so provenance stays NULL rather than
    # inventing one (see tools/timers.py) — and the row lands in the person's
    # ACTIVE conversation, the one the chat page shows.
    assert row["created_turn_id"] is None
    assert row["conversation_id"] == conversation
    # "in 2 minutes" is at least two minutes, never one-and-some-seconds: the
    # wall time is rounded UP to the minute.
    delta = row["next_fire_at"] - before
    assert timedelta(minutes=2) <= delta <= timedelta(minutes=3)
    # No timezone set -> resolved in UTC, and the row says so.
    assert row["timezone"] == "UTC"
    # The confirmation's words ARE describe()'s — the Schedules page reads the
    # same sentence off the same row (timer_spec's schedule_words), plus the
    # relative distance only the creating turn knows "now" for.
    assert timers.timer_spec(row)["schedule_words"] in result
    assert re.search(r"\(in \d+ minutes?\)", result), result
    assert result.startswith(f"Reminder set (id {str(row['id'])[:8]}): 'stretch' — once, ")
    assert "in this chat and as a notification on every connected paired device" in result


async def test_a_relative_reminder_creates_the_active_conversation_when_the_person_has_none(
    pool, tmp_path
):
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('new', 'adult') RETURNING id"
    )
    person = Person(id=pid, name="new", role="adult")
    result, ok = await _create(_ctx(person, tmp_path), text="water", in_minutes=5)
    assert ok is True, result
    (row,) = await _rows(pool, person)
    active = await pool.fetchval(
        "SELECT id FROM conversations WHERE person_id = $1 AND active", pid
    )
    assert row["conversation_id"] == active


async def _pair(pool, name: str, *, revoked: bool = False) -> None:
    """A paired device row — the same table devices.enroll writes."""
    await pool.execute(
        "INSERT INTO devices (name, platform, hostname, pubkey, revoked_at) "
        "VALUES ($1, 'linux', $1, $2, CASE WHEN $3 THEN now() END)",
        name,
        uuid.uuid4().hex * 2,
        revoked,
    )


async def test_a_named_paired_device_is_kept_and_stated(pool, tmp_path):
    person, _ = await _person(pool)
    await _pair(pool, "desk")
    result, ok = await _create(_ctx(person, tmp_path), text="stand up", in_minutes=1, device="desk")
    assert ok is True, result
    (row,) = await _rows(pool, person)
    assert row["payload"] == {"message": "stand up", "device": "desk"}
    assert "as a notification on 'desk'" in result


async def test_a_device_nobody_paired_is_refused_naming_the_paired_ones(pool, tmp_path):
    """The confirmation would promise "on 'dsek'" and nothing would check it
    until the firing; the refusal's alternatives are the LIVE rows (a revoked
    device is not one)."""
    person, _ = await _person(pool)
    await _pair(pool, "desk")
    await _pair(pool, "laptop")
    await _pair(pool, "old-phone", revoked=True)
    result, ok = await _create(_ctx(person, tmp_path), text="stand up", in_minutes=1, device="dsek")
    assert ok is False
    assert result == "Error: no paired device named 'dsek' — paired devices are: 'desk', 'laptop'"
    assert await _rows(pool, person) == []
    # A revoked device is gone for this purpose too.
    result, ok = await _create(
        _ctx(person, tmp_path), text="stand up", in_minutes=1, device="old-phone"
    )
    assert ok is False
    assert result.startswith("Error: no paired device named 'old-phone' — paired devices are:")


async def test_a_device_with_none_paired_says_so_and_names_the_way_out(pool, tmp_path):
    person, _ = await _person(pool)
    result, ok = await _create(_ctx(person, tmp_path), text="stand up", in_minutes=1, device="desk")
    assert ok is False
    assert result == (
        "Error: no paired device named 'desk' — no device is paired at all; omit device and "
        "the reminder lands in chat"
    )
    result, ok = await _create(_ctx(person, tmp_path), text="stand up", in_minutes=1, device="  ")
    assert ok is False
    assert "device is empty" in result
    assert await _rows(pool, person) == []


# -- the fall-back hour: a duration is a duration -----------------------------------------


def test_relative_spec_writes_utc_when_the_zone_cannot_name_the_instant():
    """America/New_York 2026-11-01: 01:00-02:00 happens twice. A naive wall
    time loses the fold and schedule.resolve takes fold=0, so 'in 90 minutes'
    at 00:58 EDT would land on 01:28 EDT (30 minutes away) and 'in 2 minutes'
    at 01:28 EST on 01:30 EDT — an hour AGO, refused as past. Both must resolve
    to the instant asked for; the row is written in UTC for that hour."""
    zone = schedule._zone(NY)
    # 00:58 EDT + 90 minutes = 01:28 EST (second occurrence of 01:28).
    now = datetime(2026, 11, 1, 4, 58, 30, tzinfo=UTC)
    spec, tz = timer_tools._relative_spec(now, 90, NY)
    assert tz == "UTC"
    assert spec == {"kind": "once", "at": "2026-11-01T06:29"}
    assert schedule.next_after(spec, now, tz) == datetime(2026, 11, 1, 6, 29, tzinfo=UTC)
    # 01:28 EST + 2 minutes = 01:30 EST; 01:30 EDT would be 05:30Z, in the past.
    now = datetime(2026, 11, 1, 6, 28, tzinfo=UTC)
    spec, tz = timer_tools._relative_spec(now, 2, NY)
    assert tz == "UTC"
    assert spec == {"kind": "once", "at": "2026-11-01T06:30"}
    assert schedule.next_after(spec, now, tz) == datetime(2026, 11, 1, 6, 30, tzinfo=UTC)
    # The FIRST occurrence is nameable in the zone and stays there.
    now = datetime(2026, 11, 1, 4, 58, tzinfo=UTC)
    spec, tz = timer_tools._relative_spec(now, 10, NY)
    assert tz == NY
    assert spec == {"kind": "once", "at": "2026-11-01T01:08"}
    assert schedule.next_after(spec, now, tz) == datetime(2026, 11, 1, 5, 8, tzinfo=UTC)
    # Spring forward (2026-03-08, 02:00 -> 03:00): the target exists, stays NY.
    now = datetime(2026, 3, 8, 6, 58, tzinfo=UTC)  # 01:58 EST
    spec, tz = timer_tools._relative_spec(now, 5, NY)
    assert tz == NY
    assert spec == {"kind": "once", "at": "2026-03-08T03:03"}
    assert schedule.resolve(datetime(2026, 3, 8, 3, 3), zone) == now + timedelta(minutes=5)
    # An ordinary day: the zone, rounded up to the minute.
    now = datetime(2026, 9, 7, 18, 0, 1, tzinfo=UTC)
    spec, tz = timer_tools._relative_spec(now, 2, NY)
    assert (spec, tz) == ({"kind": "once", "at": "2026-09-07T14:03"}, NY)


async def test_a_relative_reminder_in_the_fall_back_hour_is_a_row_at_the_asked_instant(
    pool, tmp_path, monkeypatch
):
    """Through dispatch: the database clock is pinned to 01:28 EST and the row's
    next_fire_at is two minutes later — not refused, not an hour early."""
    person, _ = await _person(pool)
    await _set_timezone(pool, NY)
    now = datetime(2026, 11, 1, 6, 28, tzinfo=UTC)
    real_fetchval = type(pool).fetchval

    async def pinned(self, query, *args, **kwargs):
        if query == "SELECT now()":
            return now
        return await real_fetchval(self, query, *args, **kwargs)

    monkeypatch.setattr(type(pool), "fetchval", pinned)
    result, ok = await _create(_ctx(person, tmp_path), text="stretch", in_minutes=2)
    assert ok is True, result
    (row,) = await _rows(pool, person)
    assert row["timezone"] == "UTC"
    assert row["next_fire_at"] == now + timedelta(minutes=2)
    assert "06:30 UTC (in 2 minutes)" in result


async def test_a_scheduled_timer_carries_the_instruction_and_replies_in_chat(pool, tmp_path):
    person, _ = await _person(pool)
    await _set_timezone(pool, NY)
    result, ok = await _create(
        _ctx(person, tmp_path),
        text="tell me what's on my calendar file",
        kind="scheduled",
        repeat={"every": "day", "at": "07:00"},
    )
    assert ok is True, result
    (row,) = await _rows(pool, person)
    assert row["kind"] == "scheduled"
    assert row["payload"] == {"instruction": "tell me what's on my calendar file"}
    assert row["schedule"] == {"kind": "day", "at": "07:00"}
    assert row["timezone"] == NY
    # A repeat's words carry no relative tail: the tool's sentence and the
    # page's schedule_words are IDENTICAL.
    words = timers.timer_spec(row)["schedule_words"]
    assert words == schedule.describe(row["schedule"], NY, row["next_fire_at"])
    assert f"— {words}. Its reply will land in this chat." in result
    assert result.startswith("Scheduled turn set (id ")


async def test_a_long_text_is_the_message_verbatim_and_a_clipped_title(pool, tmp_path):
    person, _ = await _person(pool)
    text = "remember to " + "really " * 30 + "stretch"
    result, ok = await _create(_ctx(person, tmp_path), text=text, in_minutes=3)
    assert ok is True, result
    (row,) = await _rows(pool, person)
    assert row["payload"]["message"] == text
    assert len(row["title"]) <= timer_tools.MAX_TITLE_CHARS
    assert row["title"].endswith("…")


# -- the timezone rule ---------------------------------------------------------------


@pytest.mark.parametrize(
    "args",
    [
        {"text": "wake up", "at": "2031-06-01 07:00"},
        {"text": "summary", "kind": "scheduled", "repeat": {"every": "day", "at": "07:00"}},
    ],
    ids=["absolute_at", "repeat"],
)
async def test_an_absolute_or_repeating_time_with_no_timezone_set_is_refused_verbatim(
    pool, tmp_path, args
):
    """The plan's exact sentence, and no row: a wall clock needs a zone, and
    defaulting to UTC would set the wrong time for nearly everyone."""
    person, _ = await _person(pool)
    result, ok = await _create(_ctx(person, tmp_path), **args)
    assert ok is False
    assert result == NO_TIMEZONE_RESULT
    assert await _rows(pool, person) == []


async def test_a_stored_utc_counts_as_set(pool, tmp_path):
    """"Set" means STORED, not "different from the default": a household that
    lives in UTC and said so during setup gets absolute times."""
    person, _ = await _person(pool)
    await _set_timezone(pool, "UTC")
    result, ok = await _create(_ctx(person, tmp_path), text="wake up", at=_tomorrow_at())
    assert ok is True, result
    (row,) = await _rows(pool, person)
    assert row["timezone"] == "UTC"


async def test_an_absolute_time_is_computed_in_the_household_zone(pool, tmp_path):
    person, _ = await _person(pool)
    await _set_timezone(pool, NY)
    result, ok = await _create(_ctx(person, tmp_path), text="wake up", at="2031-06-01 07:00")
    assert ok is True, result
    (row,) = await _rows(pool, person)
    assert row["schedule"] == {"kind": "once", "at": "2031-06-01T07:00"}
    # 07:00 New York in June is EDT: 11:00 UTC.
    assert row["next_fire_at"] == datetime(2031, 6, 1, 11, 0, tzinfo=UTC)
    assert "07:00 EDT" in result


async def test_a_relative_reminder_resolves_in_the_household_zone_when_set(pool, tmp_path):
    person, _ = await _person(pool)
    await _set_timezone(pool, NY)
    result, ok = await _create(_ctx(person, tmp_path), text="stretch", in_minutes=2)
    assert ok is True, result
    (row,) = await _rows(pool, person)
    assert row["timezone"] == NY
    wall = datetime.fromisoformat(row["schedule"]["at"])
    assert schedule.resolve(wall, schedule._zone(NY)) == row["next_fire_at"]


async def test_a_stored_zone_that_no_longer_loads_is_stated_not_defaulted(pool, tmp_path):
    person, _ = await _person(pool)
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('nova.timezone', $1::jsonb)", "Mars/Olympus"
    )
    result, ok = await _create(_ctx(person, tmp_path), text="stretch", in_minutes=2)
    assert ok is False
    assert result.startswith("Error: the stored timezone cannot be used — ")
    assert "Mars/Olympus" in result
    assert await _rows(pool, person) == []


# -- every refusal, by name -----------------------------------------------------------------


@pytest.mark.parametrize(
    "args,expected",
    [
        # exactly one of in_minutes / at / repeat
        ({"text": "x"}, "give exactly one of in_minutes"),
        ({"text": "x"}, "you gave none of them"),
        ({"text": "x", "in_minutes": 2, "at": "2031-06-01 07:00"}, "you gave in_minutes, at"),
        (
            {"text": "x", "in_minutes": 2, "repeat": {"every": "day", "at": "07:00"}},
            "you gave in_minutes, repeat",
        ),
        # the flat fields
        ({"text": "   ", "in_minutes": 2}, "text is empty"),
        ({"text": "x", "kind": "job", "in_minutes": 2}, "kind must be one of reminder, scheduled"),
        (
            {"text": "x", "kind": "scheduled", "in_minutes": 2, "device": "desk"},
            "device only applies to a reminder",
        ),
        # the schema, before the executor
        ({"text": "x", "in_minutes": 0}, "argument 'in_minutes' must be at least 1"),
        (
            {"text": "x", "in_minutes": 10**10},
            "argument 'in_minutes' must be at most 527040, got 10000000000",
        ),
        ({"text": "x", "when": "later"}, "unknown argument 'when'"),
        ({"in_minutes": 2}, "missing required argument 'text'"),
        ({"text": "x", "in_minutes": "2"}, "argument 'in_minutes' must be an integer"),
    ],
    ids=[
        "none_given",
        "none_given_named",
        "two_given",
        "two_given_repeat",
        "empty_text",
        "bad_kind",
        "device_on_scheduled",
        "in_minutes_zero",
        "in_minutes_beyond_a_year",
        "unknown_argument",
        "missing_text",
        "in_minutes_string",
    ],
)
async def test_each_flat_refusal_names_its_rule(pool, tmp_path, args, expected):
    person, _ = await _person(pool)
    result, ok = await _create(_ctx(person, tmp_path), **args)
    assert ok is False
    assert result.startswith("Error: ")
    assert expected in result, result
    assert await _rows(pool, person) == []


@pytest.mark.parametrize(
    "args,expected",
    [
        (
            {"text": "x", "at": "tomorrow at 7"},
            "at must be a local wall time written 'YYYY-MM-DD HH:MM'",
        ),
        ({"text": "x", "at": "2031-06-01T07:00:00+02:00"}, "at must be a local wall time"),
        ({"text": "x", "at": "2020-01-01 07:00"}, "is already in the past"),
        (
            {"text": "x", "repeat": {}},
            "repeat needs 'every', one of minutes, hour, day, week, month",
        ),
        ({"text": "x", "repeat": {"every": "fortnight"}}, "repeat.every must be one of"),
        (
            {"text": "x", "repeat": {"every": "day", "at": "07:00", "days": ["mon"]}},
            "repeat every=day does not take 'days' — it takes at",
        ),
        ({"text": "x", "repeat": {"every": "day"}}, "repeat every=day needs 'at'"),
        ({"text": "x", "repeat": {"every": "minutes"}}, "repeat every=minutes needs 'n'"),
        # a VALUE the schedule module refuses comes back in its own words
        (
            {"text": "x", "repeat": {"every": "minutes", "n": 2}},
            "every must be a whole number of minutes, at least 5, got 2",
        ),
        (
            {"text": "x", "repeat": {"every": "week", "at": "07:00"}},
            "repeat every=week needs 'days'",
        ),
        (
            {"text": "x", "repeat": {"every": "week", "days": ["funday"], "at": "07:00"}},
            "days contains 'funday'",
        ),
        (
            {"text": "x", "repeat": {"every": "month", "at": "07:00"}},
            "repeat every=month needs 'day'",
        ),
        (
            {"text": "x", "repeat": {"every": "month", "day": 0, "at": "07:00"}},
            "day must be a whole number 1..31, got 0",
        ),
        ({"text": "x", "repeat": {"every": "day", "at": "7am"}}, "at must be HH:MM"),
        (
            {"text": "x", "repeat": {"every": "hour", "at": "quarter past"}},
            "for every=hour, at names the minute past each hour",
        ),
        # the tool's own range check, in the tool's vocabulary ("at", not "minute")
        (
            {"text": "x", "repeat": {"every": "hour", "at": "99"}},
            "for every=hour, at must be a minute 0..59, got '99'",
        ),
        # an hour part is a time of day, every=day's shape — never silently dropped
        (
            {"text": "x", "repeat": {"every": "hour", "at": "09:45"}},
            "'09:45' names an hour too — for a time of day use repeat every=day with at '09:45'",
        ),
        ({"text": "x", "repeat": "daily"}, "argument 'repeat' must be an object"),
    ],
    ids=[
        "at_prose",
        "at_with_offset",
        "at_in_the_past",
        "repeat_no_every",
        "repeat_unknown_every",
        "repeat_unknown_field_named_in_tool_words",
        "repeat_day_missing_at",
        "repeat_minutes_missing_n",
        "repeat_minutes_below_five",
        "repeat_week_missing_days",
        "repeat_week_bad_day",
        "repeat_month_missing_day",
        "repeat_month_day_zero",
        "repeat_bad_hhmm",
        "repeat_hour_bad_minute",
        "repeat_hour_minute_out_of_range",
        "repeat_hour_with_an_hour_part",
        "repeat_not_an_object",
    ],
)
async def test_each_absolute_and_repeat_refusal_names_its_field(pool, tmp_path, args, expected):
    person, _ = await _person(pool)
    await _set_timezone(pool, NY)
    result, ok = await _create(_ctx(person, tmp_path), **args)
    assert ok is False
    assert result.startswith("Error: ")
    assert expected in result, result
    assert await _rows(pool, person) == []


async def test_every_repeat_cadence_round_trips_to_its_spec(pool, tmp_path):
    person, _ = await _person(pool)
    await _set_timezone(pool, NY)
    ctx = _ctx(person, tmp_path)
    cases = [
        ({"every": "minutes", "n": 15}, {"kind": "minutes", "every": 15}),
        ({"every": "hour"}, {"kind": "hour", "minute": 0}),
        ({"every": "hour", "at": "00:45"}, {"kind": "hour", "minute": 45}),
        ({"every": "hour", "at": "30"}, {"kind": "hour", "minute": 30}),
        ({"every": "day", "at": "07:00"}, {"kind": "day", "at": "07:00"}),
        (
            {"every": "week", "days": ["mon", "fri"], "at": "08:30"},
            {"kind": "week", "days": ["mon", "fri"], "at": "08:30"},
        ),
        ({"every": "month", "day": 31, "at": "09:00"}, {"kind": "month", "day": 31, "at": "09:00"}),
    ]
    for index, (repeat, spec) in enumerate(cases):
        result, ok = await _create(ctx, text=f"r{index}", kind="scheduled", repeat=repeat)
        assert ok is True, (repeat, result)
    rows = await _rows(pool, person)
    assert [r["schedule"] for r in rows] == [spec for _, spec in cases]
    for row in rows:
        assert row["next_fire_at"] is not None


# -- list_timers ---------------------------------------------------------------------------


async def test_list_shows_the_persons_own_timers_and_the_jobs_never_another_persons(
    pool, tmp_path
):
    jeremy, _ = await _person(pool)
    other, _ = await _person(pool, name="kid", role="kid")
    await _create(_ctx(jeremy, tmp_path), text="stretch", in_minutes=2)
    await _create(_ctx(other, tmp_path), text="homework", in_minutes=30)
    await timers.ensure_jobs(pool)

    result, ok = await tools.dispatch("list_timers", "", _ctx(jeremy, tmp_path))
    assert ok is True
    (row,) = await _rows(pool, jeremy)
    assert result.startswith("1 timer of yours (id, kind, title, schedule):")
    assert f"- {str(row['id'])[:8]} reminder 'stretch': " in result
    assert timers.timer_spec(row)["schedule_words"] in result
    assert "homework" not in result
    # The install's jobs are hers to see (the Schedules page shows them too),
    # stated as system rows.
    assert "1 housekeeping job (system):" in result
    assert f"job {timers.JOB_TITLES['retention']!r}" in result
    assert "PAUSED" not in result


async def test_list_states_a_pause_with_its_reason(pool, tmp_path):
    person, _ = await _person(pool)
    await _create(_ctx(person, tmp_path), text="stretch", in_minutes=2)
    (row,) = await _rows(pool, person)
    await timers.pause(pool, row["id"], reason="not this week")
    result, ok = await tools.dispatch("list_timers", "", _ctx(person, tmp_path))
    assert ok is True
    assert "— PAUSED: not this week" in result


async def test_a_list_longer_than_the_limit_says_it_is_truncated_and_so_does_cancel(
    pool, tmp_path, monkeypatch
):
    """timers.list_for's default page (50) would hide a 51st row behind a list
    that reads as complete, and cancel_timer would then say "no timer of yours
    matches" for a timer that exists. The tool reads a large explicit limit and,
    past it, SAYS so — in the list and in the refusal."""
    person, _ = await _person(pool)
    ctx = _ctx(person, tmp_path)
    for index in range(3):
        result, ok = await _create(ctx, text=f"t{index}", in_minutes=10 + index)
        assert ok is True, result
        time.sleep(0.01)  # distinct created_at, so "newest" is well-defined
    monkeypatch.setattr(timer_tools, "LIST_LIMIT", 2)

    result, ok = await tools.dispatch("list_timers", "", ctx)
    assert ok is True
    assert result.startswith("2 timers of yours")
    assert "'t2'" in result and "'t1'" in result and "'t0'" not in result
    assert result.endswith("(showing the newest 2 of 3 — the Schedules page has the rest)")

    result, ok = await tools.dispatch("cancel_timer", {"id_or_title": "t0"}, ctx)
    assert ok is False
    assert result == (
        "Error: no timer among the newest 2 of 3 matches 't0' — cancel an older one by its "
        "full id from the Schedules page"
    )
    assert len(await _rows(pool, person)) == 3

    monkeypatch.setattr(timer_tools, "LIST_LIMIT", 1000)
    result, ok = await tools.dispatch("list_timers", "", ctx)
    assert ok is True
    assert "showing the newest" not in result
    assert "'t0'" in result


async def test_list_with_nothing_says_so(pool, tmp_path):
    person, _ = await _person(pool)
    result, ok = await tools.dispatch("list_timers", "", _ctx(person, tmp_path))
    assert ok is True
    assert result == "No timers: nothing is scheduled and no reminder is set."


async def test_list_timers_declares_a_listing_result(pool):
    """The presented-listing guard derives "a listing ran" from this declaration,
    never from the name."""
    assert "list_timers" in tools.tool_names_by_result_kind(tools.RESULT_KIND_LISTING)


# -- cancel_timer ----------------------------------------------------------------------------


async def test_cancel_by_full_id_short_id_and_title(pool, tmp_path):
    person, _ = await _person(pool)
    ctx = _ctx(person, tmp_path)
    for text in ("stretch", "water", "walk"):
        await _create(ctx, text=text, in_minutes=5)
    stretch, water, walk = await _rows(pool, person)

    result, ok = await tools.dispatch("cancel_timer", {"id_or_title": str(stretch["id"])}, ctx)
    assert ok is True
    assert result.startswith("Cancelled reminder 'stretch' (id ")
    assert timers.timer_spec(stretch)["schedule_words"] in result

    result, ok = await tools.dispatch("cancel_timer", {"id_or_title": str(water["id"])[:8]}, ctx)
    assert ok is True
    assert "Cancelled reminder 'water'" in result

    result, ok = await tools.dispatch("cancel_timer", {"id_or_title": "  WALK "}, ctx)
    assert ok is True
    assert "Cancelled reminder 'walk'" in result

    assert await _rows(pool, person) == []


async def test_an_ambiguous_title_lists_the_candidates_and_cancels_nothing(pool, tmp_path):
    person, _ = await _person(pool)
    ctx = _ctx(person, tmp_path)
    await _create(ctx, text="stretch", in_minutes=5)
    await _create(ctx, text="stretch", in_minutes=50)
    first, second = await _rows(pool, person)

    result, ok = await tools.dispatch("cancel_timer", {"id_or_title": "stretch"}, ctx)
    assert ok is False
    assert result.startswith("Error: 'stretch' matches 2 timers — say which by id:")
    assert str(first["id"])[:8] in result and str(second["id"])[:8] in result
    assert len(await _rows(pool, person)) == 2


async def test_cancel_refuses_what_is_not_hers_by_name(pool, tmp_path):
    jeremy, _ = await _person(pool)
    other, _ = await _person(pool, name="kid", role="kid")
    await _create(_ctx(jeremy, tmp_path), text="stretch", in_minutes=5)
    await _create(_ctx(other, tmp_path), text="homework", in_minutes=5)
    (theirs,) = await _rows(pool, other)
    await timers.ensure_jobs(pool)
    job_id = await pool.fetchval("SELECT id FROM timers WHERE kind = 'job'")
    ctx = _ctx(jeremy, tmp_path)

    # Another person's timer, by id and by title: not hers, so not found.
    for key in (str(theirs["id"]), "homework"):
        result, ok = await tools.dispatch("cancel_timer", {"id_or_title": key}, ctx)
        assert ok is False
        assert result.startswith(f"Error: no timer of yours matches {key!r} — yours are: ")
        assert "'stretch'" in result
    # A job belongs to the install, not to her: never a cancel candidate.
    for key in (str(job_id), timers.JOB_TITLES["retention"]):
        result, ok = await tools.dispatch("cancel_timer", {"id_or_title": key}, ctx)
        assert ok is False
        assert "no timer of yours matches" in result
    assert len(await _rows(pool, other)) == 1
    assert await pool.fetchval("SELECT count(*) FROM timers WHERE kind = 'job'") == 1


async def test_cancel_with_no_timers_at_all_says_so(pool, tmp_path):
    person, _ = await _person(pool)
    result, ok = await tools.dispatch(
        "cancel_timer", {"id_or_title": "stretch"}, _ctx(person, tmp_path)
    )
    assert ok is False
    assert result == (
        "Error: no timer matches 'stretch' — you have no reminders or scheduled turns"
    )


async def test_cancel_with_an_empty_key_is_refused(pool, tmp_path):
    person, _ = await _person(pool)
    result, ok = await tools.dispatch("cancel_timer", {"id_or_title": " "}, _ctx(person, tmp_path))
    assert ok is False
    assert result.startswith("Error: id_or_title is empty")


# -- the rows follow the person -------------------------------------------------------------


async def test_timers_cascade_away_with_the_person(pool, tmp_path):
    """The eval runner's scratch person cascades its timers on cleanup, so an
    eval never leaves a reminder that would later fire into nobody's chat."""
    person, _ = await _person(pool)
    await _create(_ctx(person, tmp_path), text="stretch", in_minutes=2)
    assert len(await _rows(pool, person)) == 1
    await pool.execute("DELETE FROM people WHERE id = $1", person.id)
    assert await pool.fetchval("SELECT count(*) FROM timers") == 0


# -- get_time answers in the household's zone ------------------------------------------------


async def test_get_time_with_no_zone_set_says_so_and_names_where_it_is_set(pool, tmp_path):
    person, _ = await _person(pool)
    result, ok = await tools.dispatch("get_time", "", _ctx(person, tmp_path))
    assert ok is True
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", result)
    assert (
        "(UTC — this instance has no local timezone configured yet; set it in Settings → General)"
        in result
    )
    epoch = int(re.search(r"unix epoch (\d+)", result).group(1))
    assert abs(epoch - time.time()) < 60


async def test_get_time_with_a_zone_set_answers_in_it_with_the_offset_and_the_utc_line(
    pool, tmp_path
):
    person, _ = await _person(pool)
    await _set_timezone(pool, NY)
    result, ok = await tools.dispatch("get_time", "", _ctx(person, tmp_path))
    assert ok is True
    match = re.match(
        r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?([+-]\d{2}:\d{2})) "
        r"\(America/New_York, UTC([+-]\d{4})\); UTC (\S+); unix epoch (\d+)$",
        result,
    )
    assert match, result
    local = datetime.fromisoformat(match.group(1))
    utc = datetime.fromisoformat(match.group(4))
    assert local == utc  # the same instant, quoted on two clocks
    assert match.group(2).replace(":", "") == match.group(3)
    assert match.group(2) in ("-04:00", "-05:00")  # EDT or EST, never +00:00
    assert abs(int(match.group(5)) - time.time()) < 60


async def test_get_time_states_an_unreadable_setting_instead_of_guessing(tmp_path, monkeypatch):
    """No database at all: the UTC time is still a fact and is given; the zone
    is not, and the reason is stated beside it — never a silent 'UTC'."""
    monkeypatch.setenv("DATABASE_URL", "")
    person = Person(id=uuid.uuid4(), name="jeremy", role="owner")
    result, ok = await tools.dispatch("get_time", "", _ctx(person, tmp_path))
    assert ok is True
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", result)
    assert (
        "(UTC — the local timezone setting could not be read: RuntimeError: DATABASE_URL unset"
        in result
    )
    assert "unix epoch" in result


# -- an agent turn: a Person VALUE with no people row --------------------------------------

# agents.refuse_person_write's exact words, after dispatch's "Error: " prefix.
AGENT_REFUSAL = (
    "Error: a timer belongs to a person and an agent is not one — put it in your report and "
    "Nova will do it"
)


async def _agent_row(pool, name: str = "coder") -> uuid.UUID:
    """A minimal agents row (migration 021); conftest's per-test TRUNCATE
    clears it."""
    return await pool.fetchval(
        "INSERT INTO agents (name, purpose, instructions, tools, max_tool_rounds, created_via) "
        "VALUES ($1, 'writes code', 'be terse', ARRAY['get_time'], 5, 'page') RETURNING id",
        name,
    )


def _agent_person(agent_id: uuid.UUID | None = None, name: str = "coder") -> Person:
    """What agents.Agent.person() hands a turn: a Person VALUE whose role is
    'agent' and whose id is an agents row — never a people row."""
    return Person(id=agent_id or uuid.uuid4(), name=name, role="agent")


async def _counts(pool) -> tuple[int, int]:
    return (
        await pool.fetchval("SELECT count(*) FROM timers"),
        await pool.fetchval("SELECT count(*) FROM conversations"),
    )


async def test_create_timer_from_an_agent_turn_is_refused_in_words_and_writes_nothing(
    pool, tmp_path
):
    """An agent's ctx.person has no people row, so create_timer would first
    INSERT the active conversation for that person_id and hit the foreign
    key. It is refused before any write, in words the agent can act on — and
    the same call from the owner still lands, so the guard is on the role,
    never on the tool."""
    owner, _ = await _person(pool)
    before = await _counts(pool)

    result, ok = await _create(_ctx(_agent_person(), tmp_path), text="stretch", in_minutes=2)

    assert ok is False
    assert result == AGENT_REFUSAL
    assert await _counts(pool) == before

    result, ok = await _create(_ctx(owner, tmp_path), text="stretch", in_minutes=2)
    assert ok is True, result
    assert len(await _rows(pool, owner)) == 1


async def test_cancel_timer_from_an_agent_turn_is_refused_in_words_and_deletes_nothing(
    pool, tmp_path
):
    owner, _ = await _person(pool)
    result, ok = await _create(_ctx(owner, tmp_path), text="stretch", in_minutes=2)
    assert ok is True, result
    (row,) = await _rows(pool, owner)
    before = await _counts(pool)

    for key in ("stretch", str(row["id"])):
        result, ok = await tools.dispatch(
            "cancel_timer", {"id_or_title": key}, _ctx(_agent_person(), tmp_path)
        )
        assert ok is False
        assert result == AGENT_REFUSAL
    assert await _counts(pool) == before
    assert await pool.fetchval("SELECT count(*) FROM timers WHERE id = $1", row["id"]) == 1

    # The owner's cancel is untouched by the guard.
    result, ok = await tools.dispatch(
        "cancel_timer", {"id_or_title": "stretch"}, _ctx(owner, tmp_path)
    )
    assert ok is True, result
    assert await _rows(pool, owner) == []


async def test_list_timers_from_an_agent_turn_lists_the_timers_bound_to_it(pool, tmp_path):
    """An agent's Person is a value with no row, so the person-scoped list
    would answer for nobody; it is shown the other axis — the scheduled turns
    whose agent_id (migration 021) is its own. person_id stays the owner who
    set them, so the owner's own list still shows every row."""
    owner, _ = await _person(pool)
    await _set_timezone(pool, NY)
    coder = await _agent_row(pool)
    reviewer = await _agent_row(pool, name="reviewer")
    ctx = _ctx(owner, tmp_path)
    result, ok = await _create(ctx, text="stretch", in_minutes=2)
    assert ok is True, result
    result, ok = await _create(
        ctx, text="review the diffs", kind="scheduled", repeat={"every": "day", "at": "07:00"}
    )
    assert ok is True, result
    await timers.ensure_jobs(pool)
    review = next(r for r in await _rows(pool, owner) if r["kind"] == "scheduled")
    await pool.execute("UPDATE timers SET agent_id = $1 WHERE id = $2", coder, review["id"])

    result, ok = await tools.dispatch("list_timers", "", _ctx(_agent_person(coder), tmp_path))
    assert ok is True, result
    assert result.startswith("timers bound to you:\n")
    assert f"- {str(review['id'])[:8]} scheduled 'review the diffs': " in result
    assert timers.timer_spec(review)["schedule_words"] in result
    assert "stretch" not in result
    assert timers.JOB_TITLES["retention"] not in result

    # A pause is stated the same way as in the owner's list.
    await timers.pause(pool, review["id"], reason="not this week")
    result, ok = await tools.dispatch("list_timers", "", _ctx(_agent_person(coder), tmp_path))
    assert ok is True
    assert "— PAUSED: not this week" in result

    # An agent bound to nothing is told so — never shown the owner's rows.
    result, ok = await tools.dispatch(
        "list_timers", "", _ctx(_agent_person(reviewer, name="reviewer"), tmp_path)
    )
    assert ok is True
    assert result == "no timers are bound to you"

    # The owner's set is unchanged by the binding: both rows and the job.
    result, ok = await tools.dispatch("list_timers", "", ctx)
    assert ok is True
    assert result.startswith("2 timers of yours")
    assert "'stretch'" in result and "'review the diffs'" in result
    assert "1 housekeeping job (system):" in result


async def test_list_bound_is_the_store_projection_newest_first(pool, tmp_path):
    """timers.list_bound reads the same columns as list_for (one projection,
    _COLUMNS), so _line / timer_spec read a bound row exactly as an owned one;
    only the agent's own rows come back, newest first."""
    owner, _ = await _person(pool)
    await _set_timezone(pool, NY)
    coder = await _agent_row(pool)
    ctx = _ctx(owner, tmp_path)
    for text in ("first", "second"):
        result, ok = await _create(
            ctx, text=text, kind="scheduled", repeat={"every": "day", "at": "07:00"}
        )
        assert ok is True, result
        time.sleep(0.01)  # distinct created_at, so "newest" is well-defined
    first, second = await _rows(pool, owner)
    await pool.execute(
        "UPDATE timers SET agent_id = $1 WHERE id = ANY($2::uuid[])",
        coder,
        [first["id"], second["id"]],
    )

    rows = await timers.list_bound(pool, coder)
    assert [r["id"] for r in rows] == [second["id"], first["id"]]
    (owned,) = await timers.list_for(pool, owner, limit=1)
    assert list(rows[0].keys()) == list(owned.keys())
    assert await timers.list_bound(pool, uuid.uuid4()) == []
