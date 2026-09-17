"""The schedule function is pure and pinned: every shape, every refusal by
name, both DST edges of America/New_York in 2026, and the month clamp."""
from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app import schedule
from app.schedule import SpecError, describe, next_after, validate

NY = "America/New_York"


def utc(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


# -- validate: the closed set of shapes -------------------------------------------


@pytest.mark.parametrize(
    "spec, normalized",
    [
        ({"kind": "once", "at": "2026-09-06T14:32"}, {"kind": "once", "at": "2026-09-06T14:32"}),
        # Seconds are dropped — a timer fires on a minute; the tick is 60 s.
        ({"kind": "once", "at": "2026-09-06T14:32:17"}, {"kind": "once", "at": "2026-09-06T14:32"}),
        ({"kind": "minutes", "every": 5}, {"kind": "minutes", "every": 5}),
        ({"kind": "hour", "minute": 0}, {"kind": "hour", "minute": 0}),
        ({"kind": "day", "at": "07:00"}, {"kind": "day", "at": "07:00"}),
        (
            {"kind": "week", "days": ["mon", "fri"], "at": "18:30"},
            {"kind": "week", "days": ["mon", "fri"], "at": "18:30"},
        ),
        ({"kind": "month", "day": 31, "at": "09:00"}, {"kind": "month", "day": 31, "at": "09:00"}),
    ],
)
def test_every_shape_validates_and_normalizes(spec, normalized):
    assert validate(spec) == normalized


@pytest.mark.parametrize(
    "spec, names",
    [
        ("every day", ["object"]),
        ({}, ["kind"]),
        ({"kind": "daily", "at": "07:00"}, ["daily", "once, minutes, hour, day, week, month"]),
        # An unknown key is refused BY NAME, not ignored.
        ({"kind": "day", "at": "07:00", "tz": "UTC"}, ["'tz'", "day"]),
        ({"kind": "day"}, ["'at'", "day"]),
        ({"kind": "once", "at": "2026-09-06T14:32+02:00"}, ["offset"]),
        ({"kind": "once", "at": "tomorrow at 2"}, ["ISO 8601"]),
        ({"kind": "once", "at": 1757169120}, ["ISO 8601"]),
        ({"kind": "minutes", "every": 4}, ["every", "at least 5"]),
        ({"kind": "minutes", "every": True}, ["every"]),
        ({"kind": "minutes", "every": "5"}, ["every"]),
        ({"kind": "hour", "minute": 60}, ["minute", "0..59"]),
        ({"kind": "hour", "minute": -1}, ["minute"]),
        ({"kind": "day", "at": "7:00"}, ["at", "HH:MM"]),
        ({"kind": "day", "at": "24:00"}, ["at", "23:59"]),
        ({"kind": "day", "at": "07:60"}, ["at"]),
        ({"kind": "week", "days": [], "at": "07:00"}, ["days", "non-empty"]),
        ({"kind": "week", "days": ["monday"], "at": "07:00"}, ["'monday'", "mon, tue"]),
        ({"kind": "week", "days": ["mon", "mon"], "at": "07:00"}, ["repeats 'mon'"]),
        ({"kind": "week", "days": "mon", "at": "07:00"}, ["days"]),
        # v3's `spec.get("day") or 1` turned this into day 1. Refused by name.
        ({"kind": "month", "day": 0, "at": "07:00"}, ["day", "1..31"]),
        ({"kind": "month", "day": 32, "at": "07:00"}, ["day"]),
        ({"kind": "month", "day": "15", "at": "07:00"}, ["day"]),
    ],
)
def test_a_bad_spec_is_refused_naming_the_field(spec, names):
    with pytest.raises(SpecError) as excinfo:
        validate(spec)
    for name in names:
        assert name in str(excinfo.value), (name, str(excinfo.value))


def test_validate_reads_every_field_with_a_presence_check_never_a_default():
    """The whole point of refusing `day: 0` above, stated as a source pin: no
    `.get(...)` CALL anywhere in validate's body — every field is read after
    an explicit `in` check. (An AST walk, so the docstring naming the banned
    idiom does not trip it.)"""
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(validate))
    gets = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "get"
    ]
    lines = [g.lineno for g in gets]
    assert gets == [], f"validate reads a field through .get() at line(s) {lines}"


# -- next_after: wall time in, UTC out ---------------------------------------------


def test_once_in_the_future_is_that_wall_time_in_the_zone():
    # 14:32 in New York on 6 Sep (EDT, UTC-4) is 18:32 UTC.
    nxt = next_after({"kind": "once", "at": "2026-09-06T14:32"}, utc(2026, 9, 6, 18, 0), NY)
    assert nxt == utc(2026, 9, 6, 18, 32)


def test_once_at_or_before_after_is_none():
    spec = {"kind": "once", "at": "2026-09-06T14:32"}
    assert next_after(spec, utc(2026, 9, 6, 18, 32), NY) is None  # exactly at
    assert next_after(spec, utc(2026, 9, 6, 19, 0), NY) is None  # past


def test_minutes_is_a_duration_on_the_instant():
    assert next_after({"kind": "minutes", "every": 5}, utc(2026, 9, 6, 18, 0), NY) == utc(
        2026, 9, 6, 18, 5
    )
    # Across the spring-forward gap five minutes is still five minutes.
    assert next_after({"kind": "minutes", "every": 30}, utc(2026, 3, 8, 6, 45), NY) == utc(
        2026, 3, 8, 7, 15
    )


def test_hour_is_the_next_wall_minute_strictly_after():
    spec = {"kind": "hour", "minute": 30}
    assert next_after(spec, utc(2026, 9, 6, 18, 0), NY) == utc(2026, 9, 6, 18, 30)
    assert next_after(spec, utc(2026, 9, 6, 18, 30), NY) == utc(2026, 9, 6, 19, 30)  # strictly
    # Half-hour zone: the wall minute is the ZONE's, not UTC's.
    assert next_after(spec, utc(2026, 9, 6, 18, 0), "Asia/Kolkata") == utc(2026, 9, 6, 19, 0)


def test_day_holds_the_wall_time_across_dst_forward_2026_03_08():
    """07:00 New York is 12:00 UTC on 7 Mar (EST) and 11:00 UTC on 8 Mar
    (EDT): the clock on the wall is what is held, so the UTC gap is 23 h."""
    spec = {"kind": "day", "at": "07:00"}
    first = next_after(spec, utc(2026, 3, 6, 20, 0), NY)
    assert first == utc(2026, 3, 7, 12, 0)
    second = next_after(spec, first, NY)
    assert second == utc(2026, 3, 8, 11, 0)


def test_a_wall_time_inside_the_dst_gap_is_the_first_instant_after_it():
    """02:30 does not exist on 2026-03-08 in New York (the clock jumps 02:00 ->
    03:00). The timer fires at the first possible reading, 03:00 EDT = 07:00
    UTC — not an hour late (07:30) and not skipped to the 9th."""
    spec = {"kind": "day", "at": "02:30"}
    assert next_after(spec, utc(2026, 3, 7, 12, 0), NY) == utc(2026, 3, 8, 7, 0)
    # And the day after, 02:30 exists again: 06:30 UTC under EDT.
    assert next_after(spec, utc(2026, 3, 8, 7, 0), NY) == utc(2026, 3, 9, 6, 30)


def test_hourly_is_a_cadence_across_the_dst_gap_one_firing_per_real_hour():
    """`hour` is computed on the instant: from 01:30 EST the next :30 reading
    is 03:30 EDT, one real hour later — not 03:00 (a reading other than :30)
    and not two firings thirty minutes apart."""
    spec = {"kind": "hour", "minute": 30}
    at_0130_est = utc(2026, 3, 8, 6, 30)
    nxt = next_after(spec, at_0130_est, NY)
    assert nxt == utc(2026, 3, 8, 7, 30)  # 03:30 EDT
    assert next_after(spec, nxt, NY) == utc(2026, 3, 8, 8, 30)  # 04:30 EDT


def test_hourly_does_not_skip_the_repeated_hour_on_the_fall_back_night_2026_11_01():
    """01:30 EDT (05:30Z), then 01:30 EST (06:30Z), then 02:30 EST (07:30Z):
    every real hour. The fold=0 rule that is right for `day` would jump from
    05:30Z straight to 07:30Z — a two-hour hole once a year."""
    spec = {"kind": "hour", "minute": 30}
    first = next_after(spec, utc(2026, 11, 1, 5, 0), NY)
    assert first == utc(2026, 11, 1, 5, 30)
    second = next_after(spec, first, NY)
    assert second == utc(2026, 11, 1, 6, 30)
    assert second.astimezone(schedule._zone(NY)).tzname() == "EST"
    assert next_after(spec, second, NY) == utc(2026, 11, 1, 7, 30)


def test_an_ambiguous_fall_back_time_takes_the_first_occurrence_2026_11_01():
    """01:30 happens twice on 2026-11-01 in New York (EDT then EST). fold=0:
    the first, 05:30 UTC. From there the next is 01:30 EST on the 2nd — one
    wall time fires once per wall day, never twice in one night."""
    spec = {"kind": "day", "at": "01:30"}
    first = next_after(spec, utc(2026, 10, 31, 12, 0), NY)
    assert first == utc(2026, 11, 1, 5, 30)
    assert first.astimezone(schedule._zone(NY)).tzname() == "EDT"
    second = next_after(spec, first, NY)
    assert second == utc(2026, 11, 2, 6, 30)
    assert second.astimezone(schedule._zone(NY)).tzname() == "EST"


def test_week_lands_on_the_same_weekday_next_week_when_today_has_passed():
    # 2026-09-06 is a Sunday. Sunday 18:00 EDT = 22:00 UTC.
    spec = {"kind": "week", "days": ["sun"], "at": "18:00"}
    assert next_after(spec, utc(2026, 9, 6, 12, 0), NY) == utc(2026, 9, 6, 22, 0)
    assert next_after(spec, utc(2026, 9, 6, 22, 0), NY) == utc(2026, 9, 13, 22, 0)
    spec = {"kind": "week", "days": ["mon", "wed"], "at": "09:00"}
    assert next_after(spec, utc(2026, 9, 6, 12, 0), NY) == utc(2026, 9, 7, 13, 0)  # Mon
    assert next_after(spec, utc(2026, 9, 7, 13, 0), NY) == utc(2026, 9, 9, 13, 0)  # Wed


def test_month_day_31_is_clamped_across_february_never_skipped():
    spec = {"kind": "month", "day": 31, "at": "09:00"}
    jan = next_after(spec, utc(2026, 1, 1, 0, 0), "UTC")
    assert jan == utc(2026, 1, 31, 9, 0)
    feb = next_after(spec, jan, "UTC")
    assert feb == utc(2026, 2, 28, 9, 0)  # clamped to the month's last day
    mar = next_after(spec, feb, "UTC")
    assert mar == utc(2026, 3, 31, 9, 0)  # and back to the 31st, not skipped
    apr = next_after(spec, mar, "UTC")
    assert apr == utc(2026, 4, 30, 9, 0)


def test_month_in_a_leap_year_clamps_to_the_29th():
    spec = {"kind": "month", "day": 30, "at": "00:00"}
    assert next_after(spec, utc(2028, 2, 1, 0, 0), "UTC") == utc(2028, 2, 29, 0, 0)


def test_next_after_refuses_a_naive_after_and_an_unknown_zone():
    with pytest.raises(ValueError, match="aware"):
        next_after({"kind": "day", "at": "07:00"}, datetime(2026, 9, 6, 12, 0), NY)
    with pytest.raises(SpecError, match="Mars/Olympus"):
        next_after({"kind": "day", "at": "07:00"}, utc(2026, 9, 6, 12, 0), "Mars/Olympus")


def test_next_after_validates_the_spec_it_is_given():
    with pytest.raises(SpecError, match="day"):
        next_after({"kind": "month", "day": 0, "at": "07:00"}, utc(2026, 9, 6), "UTC")


# -- describe: one sentence for the tool and the page -------------------------------


def test_describe_once_names_the_local_time_and_how_far_away():
    spec = {"kind": "once", "at": "2026-09-06T14:32"}
    nxt = next_after(spec, utc(2026, 9, 6, 18, 0), NY)
    assert describe(spec, NY, nxt, now=utc(2026, 9, 6, 18, 30)) == (
        "once, Sun 6 Sep 2026 14:32 EDT (in 2 minutes)"
    )
    # Without a now there is no relative clause — describe owns no clock.
    assert describe(spec, NY, nxt) == "once, Sun 6 Sep 2026 14:32 EDT"
    assert describe(spec, NY, None) == "once, 2026-09-06 14:32 America/New_York — finished"


def test_describe_repeats_name_the_rule_and_the_next_fire():
    assert describe({"kind": "day", "at": "07:00"}, NY, utc(2026, 9, 7, 11, 0)) == (
        "every day at 07:00 America/New_York, next Mon 7 Sep 07:00 EDT"
    )
    assert describe(
        {"kind": "week", "days": ["mon", "fri"], "at": "18:30"}, NY, utc(2026, 9, 7, 22, 30)
    ) == "every Mon, Fri at 18:30 America/New_York, next Mon 7 Sep 18:30 EDT"
    assert describe({"kind": "minutes", "every": 5}, "UTC", utc(2026, 9, 6, 18, 5)) == (
        "every 5 minutes, next Sun 6 Sep 18:05 UTC"
    )
    assert describe({"kind": "hour", "minute": 15}, "UTC", utc(2026, 9, 6, 18, 15)) == (
        "every hour at :15 UTC, next Sun 6 Sep 18:15 UTC"
    )
    assert describe({"kind": "month", "day": 31, "at": "09:00"}, "UTC", utc(2026, 2, 28, 9)) == (
        "every month on day 31 at 09:00 UTC, next Sat 28 Feb 09:00 UTC"
    )


def test_relative_words_are_coarse_and_never_negative_in_shape():
    now = utc(2026, 9, 6, 18, 0)
    assert schedule._relative(now, utc(2026, 9, 6, 18, 0, 20)) == "in under a minute"
    assert schedule._relative(now, utc(2026, 9, 6, 18, 1)) == "in 1 minute"
    assert schedule._relative(now, utc(2026, 9, 6, 21, 0)) == "in 3 hours"
    assert schedule._relative(now, utc(2026, 9, 9, 18, 0)) == "in 3 days"
    assert schedule._relative(now, utc(2026, 9, 6, 17, 0)) == "already passed"
