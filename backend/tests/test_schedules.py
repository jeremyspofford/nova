""""Tomorrow" is a date, not 1440 minutes from whenever you asked.

    docker compose exec backend python tests/test_schedules.py

Jeremy, 2026-08-06: "scheduling things shouldn't just be a number of minutes,
we should be able to set a date, or every monday, things like that, just like
I might on apple's reminders app."

He hit it the same evening. He asked "can you remember to tell me tomorrow to
see what their current rate is?" and the only thing `automations` could express
was `interval_minutes`, so "tomorrow" became `now + 1440 minutes` — a reminder
that fires every day forever, at whatever o'clock he happened to ask. Nova
called it a "one-shot morning reminder" in its own description and then told
him it would fire at 5:24 PM, because there was no field in which either
sentence could be true.

`app/schedules.py` is pure on purpose — the scheduler reads `next_run_at` and
nothing else, so recurrence is entirely "given a spec and a moment, when is the
next moment". That makes it the one part of this feature that can be pinned
exhaustively, which is what this file does.
"""

import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, "/app/backend")

from app import schedules                                # noqa: E402

FAILURES: list[str] = []
NY = "America/New_York"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def at(y, m, d, hh=0, mm=0, tz=NY):
    """A local wall-clock moment, as the UTC instant the scheduler stores."""
    return datetime(y, m, d, hh, mm, tzinfo=ZoneInfo(tz)).astimezone(timezone.utc)


def local(dt, tz=NY):
    return dt.astimezone(ZoneInfo(tz))


def test_the_ask_he_actually_made():
    print("\n1. \"REMIND ME TOMORROW\" — the reminder that started this")
    # Thursday 2026-08-06, 5:24 PM, exactly when he asked.
    now = at(2026, 8, 6, 17, 24)
    spec = schedules.validate({"every": "once", "date": "2026-08-07",
                               "at": "09:00"})
    nxt = schedules.next_after(spec, now, NY)
    check("1.1 it fires tomorrow", local(nxt).date().isoformat() == "2026-08-07",
          str(local(nxt)))
    check("1.2 …at the time asked for, not the time of the request",
          (local(nxt).hour, local(nxt).minute) == (9, 0), str(local(nxt)))
    # THE HALF THE OLD MODEL COULD NOT EXPRESS AT ALL.
    check("1.3 …and then never again",
          schedules.next_after(spec, nxt, NY) is None,
          "an interval would have repeated it every day forever")
    check("1.4 the row knows it is a one-shot, so the caller can stop it",
          schedules.is_one_shot(spec))
    check("1.5 …and it describes itself in his words",
          schedules.describe(spec) == "once, on 2026-08-07 at 09:00",
          schedules.describe(spec))


def test_weekly():
    print("\n2. EVERY MONDAY")
    spec = schedules.validate({"every": "week", "on": ["mon"], "at": "09:00"})
    # from a Thursday
    nxt = schedules.next_after(spec, at(2026, 8, 6, 17, 0), NY)
    check("2.1 from Thursday it lands on the next Monday",
          local(nxt).weekday() == 0 and local(nxt).date().isoformat() == "2026-08-10",
          str(local(nxt)))
    # from Monday BEFORE the time — today still counts
    nxt = schedules.next_after(spec, at(2026, 8, 10, 8, 0), NY)
    check("2.2 on Monday morning it is still today",
          local(nxt).date().isoformat() == "2026-08-10", str(local(nxt)))
    # from Monday AFTER the time — a full week, not "skip to Tuesday"
    nxt = schedules.next_after(spec, at(2026, 8, 10, 9, 1), NY)
    check("2.3 once Monday's time has passed it is next Monday",
          local(nxt).date().isoformat() == "2026-08-17", str(local(nxt)))

    multi = schedules.validate({"every": "week", "on": ["thu", "mon"],
                                "at": "09:00"})
    check("2.4 days are normalised, so two spellings are one document",
          multi["on"] == ["mon", "thu"], str(multi["on"]))
    nxt = schedules.next_after(multi, at(2026, 8, 10, 9, 1), NY)
    check("2.5 …and the nearer of the two wins",
          local(nxt).date().isoformat() == "2026-08-13", str(local(nxt)))
    check("2.6 it reads as a sentence",
          schedules.describe(multi) == "every Mon, Thu at 09:00",
          schedules.describe(multi))


def test_daily_and_monthly():
    print("\n3. EVERY DAY, EVERY MONTH")
    day = schedules.validate({"every": "day", "at": "07:30"})
    nxt = schedules.next_after(day, at(2026, 8, 6, 7, 31), NY)
    check("3.1 past today's time, it is tomorrow",
          local(nxt).date().isoformat() == "2026-08-07"
          and (local(nxt).hour, local(nxt).minute) == (7, 30), str(local(nxt)))

    month = schedules.validate({"every": "month", "day": 31, "at": "09:00"})
    nxt = schedules.next_after(month, at(2026, 9, 1, 10, 0), NY)
    # CLAMPED, NOT SKIPPED. September has 30 days; skipping it is how a
    # monthly job silently runs seven times a year.
    check("3.2 day 31 in a 30-day month means its last day",
          local(nxt).date().isoformat() == "2026-09-30", str(local(nxt)))
    nxt = schedules.next_after(month, at(2026, 1, 31, 10, 0), NY)
    check("3.3 …and February is clamped too, not skipped",
          local(nxt).date().isoformat() == "2026-02-28", str(local(nxt)))


def test_the_clock_he_lives_on():
    print("\n4. HIS WALL CLOCK, NOT UTC")
    spec = schedules.validate({"every": "day", "at": "09:00"})
    # Across the US DST boundary (2026-11-01, 02:00). A job asked for 9am must
    # stay at 9am; it is the UTC instant that moves, not the time he sees.
    # Both sample points are deliberately on OPPOSITE sides of the change —
    # the first version of this check picked two dates that were both after it
    # and proved nothing.
    before = schedules.next_after(spec, at(2026, 10, 29, 12, 0), NY)   # -> Oct 30, EDT
    after = schedules.next_after(spec, at(2026, 11, 2, 12, 0), NY)     # -> Nov 3, EST
    check("4.1 09:00 before the change is 09:00 local",
          (local(before).hour, local(before).minute) == (9, 0), str(local(before)))
    check("4.2 09:00 after the change is still 09:00 local",
          (local(after).hour, local(after).minute) == (9, 0), str(local(after)))
    check("4.3 …and the UTC instant moved by the hour, which is the point",
          before.hour != after.hour, f"{before.hour}Z vs {after.hour}Z")


def test_the_old_world_is_untouched():
    print("\n5. EVERY EXISTING ROW BEHAVES EXACTLY AS IT DID")
    now = datetime(2026, 8, 6, 21, 24, tzinfo=timezone.utc)
    # No spec at all — the NULL column every current automation has.
    nxt = schedules.next_after(None, now, NY, interval_minutes=360)
    check("5.1 a NULL schedule is still `now + interval_minutes`",
          (nxt - now).total_seconds() == 360 * 60, str(nxt - now))
    check("5.2 …and the old shape is expressible in the new one",
          (schedules.next_after({"every": "minutes", "n": 360}, now, NY) - now
           ).total_seconds() == 360 * 60)
    check("5.3 a NULL schedule describes itself the old way",
          schedules.describe(None, 360) == "every 360 minutes")
    # STRICTLY after, because record_run passes the moment the run finished —
    # `>=` would return that same instant and fire the job again immediately.
    same = schedules.next_after({"every": "day", "at": "09:00"},
                                at(2026, 8, 6, 9, 0), NY)
    check("5.4 a firing exactly now moves to the NEXT one, never itself",
          local(same).date().isoformat() == "2026-08-07", str(local(same)))


def test_a_bad_spec_is_refused_by_field():
    print("\n6. A BAD SPEC IS REFUSED, NAMING THE FIELD")
    bad = [
        ({"every": "fortnight"}, "every"),
        ({"every": "week", "on": ["funday"], "at": "09:00"}, "on"),
        ({"every": "week", "on": [], "at": "09:00"}, "on"),
        ({"every": "day", "at": "9am"}, "at"),
        ({"every": "day", "at": "25:00"}, "at"),
        ({"every": "month", "day": 0}, "day"),
        ({"every": "month", "day": 32}, "day"),
        ({"every": "once", "date": "tomorrow"}, "date"),
        ({"every": "minutes", "n": 1}, "n"),
        # A TYPO IS REFUSED, NOT IGNORED. `{"every":"day","on":["mon"]}` read
        # as a silent daily job would be a schedule he believes he set and
        # never did — the same class as a tool reporting success it did not
        # check.
        ({"every": "day", "at": "09:00", "on": ["mon"]}, "on"),
    ]
    for spec, field in bad:
        try:
            schedules.validate(spec)
            check(f"6.x refuses {spec}", False, "accepted it")
        except schedules.ScheduleError as e:
            check(f"6.x refuses {str(spec)[:44]}", field in str(e), str(e)[:70])

    check("6.y a one-shot in the past has no next firing",
          schedules.next_after(
              schedules.validate({"every": "once", "date": "2020-01-01",
                                  "at": "09:00"}),
              at(2026, 8, 6, 12, 0), NY) is None,
          "create() refuses this rather than storing a row that never runs")


def main() -> int:
    test_the_ask_he_actually_made()
    test_weekly()
    test_daily_and_monthly()
    test_the_clock_he_lives_on()
    test_the_old_world_is_untouched()
    test_a_bad_spec_is_refused_by_field()
    if FAILURES:
        print(f"\nFAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
