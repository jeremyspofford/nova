"""The beat spine and the watch beat's wiring: two seeded rows that belong to
the owner, one inactive conversation his chat page can never pick up, a firing
that goes through the ordinary tick — claim, turn, span, firing receipt —
without putting a bubble anywhere he sees, and a watch beat that runs the real
check registry, writes what it finds down as notices, clears what it no longer
finds, and says which of those it did in a sentence composed from the counts.

The pin that matters most here: QUIET is computed, never claimed. A beat where
any check could not run says so and names it; only a beat where every check ran
and none flagged says "quiet"."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from app import (
    beats,
    chat,
    checks,
    conversations,
    devices,
    devices_ws,
    guards,
    notices,
    scheduler,
    settings_store,
    timers,
)
from app.checks import Check, CheckRun, Finding
from app.identity import Person
from app.main import app
from app.timers import TimerRefused
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice, FakeWSConn
from tests.fakes import FakeGateway

pytestmark = requires_db

NY = "America/New_York"
# Far enough ahead that every seeded beat is due when the tick is handed it;
# nothing here waits on a wall clock.
LATER = datetime(2031, 6, 1, 14, 0, tzinfo=UTC)
TURN_STATUS = "SELECT status FROM turns WHERE id = $1"


async def _owner(pool) -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id"
    )
    return Person(id=pid, name="jeremy", role="owner")


async def _setting(pool, key: str, value) -> None:
    """Straight into the table: proactive.digest_at has no SETTING_DEFS entry
    yet (S11-6 adds it), so the settings API would refuse the key by name."""
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        key,
        value,
    )


async def _beat_rows(pool) -> dict:
    rows = await pool.fetch(
        "SELECT * FROM timers WHERE kind = $1 ORDER BY created_at", beats.BEAT_KIND
    )
    return {row["payload"]["handler"]: row for row in rows}


async def _firings(pool, timer_id):
    return await pool.fetch(
        "SELECT * FROM timer_firings WHERE timer_id = $1 ORDER BY started_at", timer_id
    )


def _check(name: str, findings, *, urgent: bool = False, raises: Exception | None = None) -> Check:
    """A registered check whose result this test decides. The registry is what
    run_all reads, so a fake family is the only way to make a beat's outcome
    deterministic without twelve real socket probes."""

    async def run(app_, pool_):
        if raises is not None:
            raise raises
        return list(findings)

    return Check(name=name, describe=f"{name} (a test)", urgent=urgent, run=run)


@pytest.fixture
def only(monkeypatch):
    """Run the beat over exactly these checks. run_all and notices.record both
    read the module-level REGISTRY at call time, so swapping it is enough."""

    def _use(*items: Check) -> None:
        monkeypatch.setattr(checks, "REGISTRY", {item.name: item for item in items})

    return _use


@pytest.fixture(autouse=True)
async def _proactive_on(pool):
    """Turn the engine ON for every test in this file that has a database.

    S11-6 gave the engine a switch, `proactive.enabled`, and it ships FALSE:
    the beats exist from the first tick and do nothing until he turns them on.
    Every test below is about what a beat DOES once it is on, so each one turns
    it on first — and the two tests that pin the switch itself (at the bottom
    of this file) turn it back off explicitly, so the gate is proved by a test
    that states it rather than by the absence of this fixture.

    """
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ($1, 'true'::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        beats.ENABLED_KEY,
    )


async def _notices(pool):
    return await pool.fetch(
        "SELECT check_name, finding_key, fingerprint, state, repeats, cleared_at, turn_id, "
        "firing_id FROM notices ORDER BY first_seen_at"
    )


async def _messages(pool, conversation_id):
    return await pool.fetch(
        "SELECT role, content, turn_id FROM messages WHERE conversation_id = $1 "
        "ORDER BY created_at",
        conversation_id,
    )


# -- seeding --------------------------------------------------------------------


async def test_seeding_is_idempotent_and_both_beats_belong_to_the_owner(pool):
    owner = await _owner(pool)
    await _setting(pool, "nova.timezone", NY)
    # True is the READ-BACK — every beat in BEATS was found as a row after the
    # write — not the fact of having been called. scheduler.run_forever stops
    # asking on it, so it may never be optimistic.
    assert await beats.ensure_beats(pool) is True
    assert await beats.ensure_beats(pool) is True  # a second start makes no third row

    rows = await _beat_rows(pool)
    assert sorted(rows) == ["digest", "watch"]
    for name, row in rows.items():
        assert row["person_id"] == owner.id, f"{name} must be the owner's: its findings are his"
        assert row["created_via"] == "system"
        assert row["timezone"] == NY
        assert row["paused_at"] is None and row["next_fire_at"] is not None
        assert row["title"] == beats.BEAT_TITLES[name]
    # Hourly and daily, the two cadences the slice asked for.
    assert rows["watch"]["schedule"] == {"kind": "hour", "minute": beats.WATCH_SCHEDULE["minute"]}
    assert rows["digest"]["schedule"] == {"kind": "day", "at": beats.DEFAULT_DIGEST_AT}
    assert await pool.fetchval("SELECT count(*) FROM conversations") == 1


async def test_seeding_leaves_an_existing_row_alone(pool):
    """A restart must not undo a pause or a retime — those are the operator's."""
    await _owner(pool)
    await beats.ensure_beats(pool)
    watch = (await _beat_rows(pool))["watch"]
    await timers.pause(pool, watch["id"], reason="quiet week")
    await beats.ensure_beats(pool)
    again = await timers.get(pool, watch["id"])
    assert again["paused_at"] is not None and again["paused_reason"] == "quiet week"
    assert len(await _beat_rows(pool)) == 2


async def test_the_digest_hour_comes_from_the_setting_when_it_is_there(pool):
    await _owner(pool)
    await _setting(pool, beats.DIGEST_AT_KEY, "21:30")
    await beats.ensure_beats(pool)
    assert (await _beat_rows(pool))["digest"]["schedule"] == {"kind": "day", "at": "21:30"}


async def test_a_digest_hour_that_is_not_a_time_is_said_out_loud_not_stored(pool, caplog):
    await _owner(pool)
    await _setting(pool, beats.DIGEST_AT_KEY, "half past whenever")
    with caplog.at_level(logging.WARNING, logger="core"):
        await beats.ensure_beats(pool)
    assert (await _beat_rows(pool))["digest"]["schedule"] == {
        "kind": "day",
        "at": beats.DEFAULT_DIGEST_AT,
    }
    (line,) = [r.getMessage() for r in caplog.records if beats.DIGEST_AT_KEY in r.getMessage()]
    assert "half past whenever" in line and beats.DEFAULT_DIGEST_AT in line


async def test_with_no_owner_yet_nothing_is_seeded_and_the_reason_is_stated(pool, caplog):
    """A fresh install before registration: the beats are HIS, and 019's CHECK
    will not take a person-less one. Stated, not raised — the next start seeds."""
    with caplog.at_level(logging.INFO, logger="core"):
        assert await beats.ensure_beats(pool) is False
    assert await _beat_rows(pool) == {}
    assert any("no owner account exists yet" in r.getMessage() for r in caplog.records)


async def test_a_stored_timezone_that_will_not_load_stops_the_seed_with_the_reason(pool, caplog):
    """The digest is a wall-clock hour. A zone that will not load would make
    that hour a guess, so nothing is written and the log says why —
    scheduler._owner_timezone would have swallowed it into UTC."""
    await _owner(pool)
    await _setting(pool, "nova.timezone", "Mars/Olympus_Mons")
    with caplog.at_level(logging.ERROR, logger="core"):
        assert await beats.ensure_beats(pool) is False
    assert await _beat_rows(pool) == {}
    assert any("not seeded" in r.getMessage() for r in caplog.records)


# -- the quiet conversation -------------------------------------------------------


async def test_the_beat_conversation_is_inactive_and_active_conversation_never_returns_it(pool):
    owner = await _owner(pool)
    await beats.ensure_beats(pool)
    beat_conversation = await beats.beat_conversation(pool)

    row = await pool.fetchrow("SELECT * FROM conversations WHERE id = $1", beat_conversation)
    assert row["active"] is False
    assert row["person_id"] == owner.id
    # active_conversation picks the newest ACTIVE row — with only the beats'
    # conversation in the table it MAKES one rather than handing his chat page
    # a beat's working notes.
    active = await conversations.active_conversation(pool, owner)
    assert active["id"] != beat_conversation
    # And it stays that way once a real chat exists.
    assert (await conversations.active_conversation(pool, owner))["id"] == active["id"]
    assert await beats.beat_conversation(pool) == beat_conversation  # stable, not re-created


async def test_both_beat_rows_point_at_that_one_conversation(pool):
    await _owner(pool)
    await beats.ensure_beats(pool)
    beat_conversation = await beats.beat_conversation(pool)
    rows = await _beat_rows(pool)
    assert {row["conversation_id"] for row in rows.values()} == {beat_conversation}


async def test_a_deleted_beat_conversation_is_replaced_and_the_rows_are_re_pointed(pool):
    await _owner(pool)
    await beats.ensure_beats(pool)
    first = await beats.beat_conversation(pool)
    await pool.execute("DELETE FROM conversations WHERE id = $1", first)
    # 019's ON DELETE SET NULL: the rows would otherwise fire into nowhere.
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM timers WHERE kind = $1 AND conversation_id IS NULL",
            beats.BEAT_KIND,
        )
        == 2
    )
    second = await beats.beat_conversation(pool)
    assert second != first
    rows = await _beat_rows(pool)
    assert {row["conversation_id"] for row in rows.values()} == {second}


async def test_beat_conversation_says_so_when_there_is_no_owner(pool):
    with pytest.raises(RuntimeError, match="no owner account exists yet"):
        await beats.beat_conversation(pool)


# -- a firing ---------------------------------------------------------------------


async def _only_watch(pool):
    """Seed the beats and pause the digest, so a test that counts what the
    watch beat wrote is not also reading the digest's line."""
    await beats.ensure_beats(pool)
    rows = await _beat_rows(pool)
    await timers.pause(pool, rows["digest"]["id"], reason="this test is about the watch beat")
    return rows["watch"]


def _finding(key: str, **facts) -> Finding:
    return Finding(key=key, title=f"{key} is true", facts=facts or {"n": 1})


async def test_a_due_beat_opens_a_beat_turn_that_lands_in_the_beats_own_conversation(pool, only):
    """The gate for the spine: the beat fires through the ordinary tick, the
    turn is kind `beat`, and everything it wrote is in the inactive
    conversation — his own chat is untouched."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("all_fine", []))
    await beats.ensure_beats(pool)
    beat_conversation = await beats.beat_conversation(pool)
    watch = (await _beat_rows(pool))["watch"]

    fired = await scheduler.tick_once(app, pool, now=LATER)
    assert len(fired) == 2  # both beats were due

    (firing,) = await _firings(pool, watch["id"])
    assert firing["status"] == "ok" and firing["reason"] is None
    assert firing["delivery"]["beat"] == "watch"
    assert firing["delivery"]["chat"] == {"ok": True}
    assert firing["delivery"]["watch"] == {
        "ran": ["all_fine"],
        "could_not": {},
        "findings": 0,
        "new": 0,
        "folded": 0,
        "cleared": 0,
        "quiet": True,
        "pushed": 0,
        "push_failed": 0,
    }
    turn = await pool.fetchrow("SELECT * FROM turns WHERE id = $1", firing["turn_id"])
    assert turn["kind"] == beats.BEAT_TURN_KIND
    assert turn["conversation_id"] == beat_conversation
    assert turn["person_id"] == owner.id  # a beat's spend is his
    assert turn["status"] == "ok"
    spans = {
        (row["kind"], row["name"]): row["meta"]
        for row in await pool.fetch(
            "SELECT kind, name, meta FROM turn_spans WHERE turn_id = $1", turn["id"]
        )
    }
    assert spans[("beat", "watch")]["status"] == scheduler.FIRING_OK
    # The trace carries the same numbers the sentence was composed from.
    assert spans[("checks", "run_all")]["quiet"] is True

    landed = [m["content"] for m in await _messages(pool, beat_conversation)]
    assert landed[0].startswith("Watch beat: all 1 check ran and none flagged — quiet.")
    assert beats.DIGEST_NOTHING in landed  # nothing outstanding: the digest is quiet
    assert all(m["turn_id"] is not None for m in await _messages(pool, beat_conversation))
    # The whole point: nothing in the thread he reads.
    assert await _messages(pool, his_chat["id"]) == []


async def test_every_finding_is_written_down_stamped_with_the_turn_and_the_firing(pool, only):
    """The wiring, end to end: run_all -> notices.record. A notice names both
    the beat turn that found it and the firing that ran, which is the
    provenance the Inbox opens — and `firing_id` reaching the row is the whole
    reason run_beat is handed one."""
    await _owner(pool)
    only(_check("work_thing", [_finding("timer_failing:1", failures=4)]))
    watch = await _only_watch(pool)

    await scheduler.tick_once(app, pool, now=LATER)
    (firing,) = await _firings(pool, watch["id"])
    (row,) = await _notices(pool)
    assert row["check_name"] == "work_thing"
    assert row["finding_key"] == "timer_failing:1"
    assert row["state"] == notices.RAISED and row["repeats"] == 1
    assert row["cleared_at"] is None
    assert row["turn_id"] == firing["turn_id"]
    assert row["firing_id"] == firing["id"]
    assert firing["delivery"]["watch"]["new"] == 1
    line = (await _messages(pool, watch["conversation_id"]))[0]["content"]
    assert "1 finding(s) from work_thing" in line and "1 new" in line


async def test_the_same_facts_an_hour_later_fold_and_the_beat_counts_it(pool, only):
    """Suppression is countable, never silent: the second sighting bumps
    repeats on the ONE live row and the beat's own line says it folded."""
    await _owner(pool)
    only(_check("work_thing", [_finding("timer_failing:1", failures=4)]))
    watch = await _only_watch(pool)

    await scheduler.tick_once(app, pool, now=LATER)
    await scheduler.tick_once(app, pool, now=LATER + timedelta(hours=2))

    (row,) = await _notices(pool)
    assert row["repeats"] == 2 and row["cleared_at"] is None
    second = (await _firings(pool, watch["id"]))[1]
    assert second["delivery"]["watch"] == {
        "ran": ["work_thing"],
        "could_not": {},
        "findings": 1,
        "new": 0,
        "folded": 1,
        "cleared": 0,
        "quiet": False,
        "pushed": 0,
        "push_failed": 0,
    }
    # Every check ran, so the firing carries no reason: the record is the line.
    assert second["status"] == scheduler.FIRING_OK and second["reason"] is None
    line = (await _messages(pool, watch["conversation_id"]))[1]["content"]
    assert "0 new and 1 folded onto a notice already raised" in line


async def test_a_condition_that_ended_is_cleared_and_the_same_facts_are_news_again(pool, only):
    """The hole the review found. A notice folded while its condition was still
    true, and nothing said when it FINISHED — so a fixed thing that broke again
    folded onto a week-old row and he was never told. The beat reconciles: the
    check RAN and no longer returns those facts, so the row is cleared, its
    fingerprint is free, and the next sighting is a NEW notice."""
    await _owner(pool)
    finding = _finding("timer_failing:1", failures=4)
    registry = {"findings": [finding]}

    async def run(app_, pool_):
        return list(registry["findings"])

    only(Check(name="work_thing", describe="w", urgent=False, run=run))
    watch = await _only_watch(pool)

    await scheduler.tick_once(app, pool, now=LATER)
    registry["findings"] = []  # he fixed it
    await scheduler.tick_once(app, pool, now=LATER + timedelta(hours=2))
    (cleared,) = await _notices(pool)
    assert cleared["cleared_at"] is not None
    second = (await _firings(pool, watch["id"]))[1]
    assert second["delivery"]["watch"]["cleared"] == 1
    assert second["delivery"]["watch"]["quiet"] is True
    assert (
        "1 notice cleared: those conditions ended."
        in (await _messages(pool, watch["conversation_id"]))[1]["content"]
    )

    registry["findings"] = [finding]  # and it broke again
    await scheduler.tick_once(app, pool, now=LATER + timedelta(hours=4))
    rows = await _notices(pool)
    assert len(rows) == 2, "a condition that cleared and came back is NEWS, not a fold"
    assert rows[0]["fingerprint"] == rows[1]["fingerprint"]
    assert rows[1]["cleared_at"] is None and rows[1]["repeats"] == 1
    assert (await _firings(pool, watch["id"]))[2]["delivery"]["watch"]["new"] == 1


async def test_a_check_that_did_not_run_clears_nothing_and_the_beat_is_not_an_all_clear(pool, only):
    """A probe that could not be made has watched nothing. Its live notices
    stay live — clearing them would be the all-clear-that-checked-nothing
    defect in its quietest form — and the beat says which check was missing and
    why, instead of reading like a beat that found nothing."""
    await _owner(pool)
    finding = _finding("timer_failing:1", failures=4)
    state = {"raise": False}

    async def run(app_, pool_):
        if state["raise"]:
            raise checks.CannotCheck("the ledger did not answer")
        return [finding]

    # Two checks: one that stops answering, and one that keeps running and
    # finds nothing. The second is what makes this an INCOMPLETE beat rather
    # than a beat that watched nothing at all.
    only(Check(name="work_thing", describe="w", urgent=False, run=run), _check("other", []))
    watch = await _only_watch(pool)

    await scheduler.tick_once(app, pool, now=LATER)
    state["raise"] = True
    await scheduler.tick_once(app, pool, now=LATER + timedelta(hours=2))

    (row,) = await _notices(pool)
    assert row["cleared_at"] is None, "a check that did not run must clear nothing"
    second = (await _firings(pool, watch["id"]))[1]
    # An OK firing, deliberately: a check that cannot run is usually the
    # operator's world, and five in a row must not pause the one timer whose
    # job is to keep watching. The reason on the row is what says it happened.
    assert second["status"] == scheduler.FIRING_OK
    assert "work_thing — the ledger did not answer" in second["reason"]
    assert second["delivery"]["watch"] == {
        "ran": ["other"],
        "could_not": {"work_thing": "the ledger did not answer"},
        "findings": 0,
        "new": 0,
        "folded": 0,
        "cleared": 0,
        "quiet": False,
        "pushed": 0,
        "push_failed": 0,
    }
    line = (await _messages(pool, watch["conversation_id"]))[1]["content"]
    assert "1 of 2 checks ran" in line and "the ledger did not answer" in line
    assert "— quiet." not in line and "all clear" not in line.lower()


async def test_a_beat_where_no_check_ran_at_all_is_an_error_never_a_quiet_beat(pool, only):
    """`ran` empty is not a clean night, it is a beat that watched nothing —
    an ERROR, so it counts toward the pause ceiling and shows red on the page."""
    await _owner(pool)
    only(_check("work_thing", [], raises=checks.CannotCheck("the database refused")))
    watch = await _only_watch(pool)

    await scheduler.tick_once(app, pool, now=LATER)
    (firing,) = await _firings(pool, watch["id"])
    assert firing["status"] == scheduler.FIRING_ERROR
    assert beats.NOTHING_RAN in firing["reason"]
    assert "the database refused" in firing["reason"]
    assert await pool.fetchval(TURN_STATUS, firing["turn_id"]) == "error"


async def test_a_finding_that_cannot_be_written_down_demotes_that_check_and_clears_nothing(
    pool, only, monkeypatch
):
    """It watched, and nobody can read what it saw. That is not a clean run: it
    must not read quiet, and above all it must not reconcile — clearing on
    fingerprints we failed to store would mark a still-true condition
    finished."""
    await _owner(pool)
    only(
        _check("first", [_finding("a")]),
        _check("second", [_finding("b")]),
    )
    watch = await _only_watch(pool)
    await scheduler.tick_once(app, pool, now=LATER)
    assert len(await _notices(pool)) == 2

    real_record = notices.record

    async def refuse(pool_, finding, **kwargs):
        if kwargs["check_name"] == "second":
            raise RuntimeError("the disk is full")
        return await real_record(pool_, finding, **kwargs)

    monkeypatch.setattr(notices, "record", refuse)
    await scheduler.tick_once(app, pool, now=LATER + timedelta(hours=2))

    assert [row["cleared_at"] for row in await _notices(pool)] == [None, None]
    second = (await _firings(pool, watch["id"]))[1]
    assert second["status"] == scheduler.FIRING_OK
    assert second["delivery"]["watch"]["ran"] == ["first"]
    assert "the disk is full" in second["delivery"]["watch"]["could_not"]["second"]
    assert "could not be written down" in second["reason"]


async def test_the_watch_beat_delivers_nothing_and_says_so(pool, only):
    """This sub-slice records and clears; the DIGEST is what reaches him
    (S11-3). Nothing lands in his conversation and no device is notified."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("work_thing", [_finding("timer_failing:1", failures=4)]))
    watch = await _only_watch(pool)
    await scheduler.tick_once(app, pool, now=LATER)

    assert await _messages(pool, his_chat["id"]) == []
    (firing,) = await _firings(pool, watch["id"])
    assert "devices" not in firing["delivery"]
    line = (await _messages(pool, watch["conversation_id"]))[0]["content"]
    assert "Nothing was delivered — the digest is what reaches him." in line


# -- quiet is computed, never claimed ---------------------------------------------


def _result(*runs, new: int = 0, folded: int = 0, cleared: int = 0) -> beats.WatchResult:
    """A WatchResult built the way _run_checks builds one: quiet comes from
    checks.quiet over the runs, never from the caller."""
    is_quiet, why = checks.quiet(runs)
    return beats.WatchResult(
        runs=tuple(runs), quiet=is_quiet, not_quiet=why, new=new, folded=folded, cleared=cleared
    )


def test_quiet_is_said_only_when_every_check_ran_and_none_flagged():
    line = beats.watch_line(
        _result(
            CheckRun(check="a", ran=True, reason=None), CheckRun(check="b", ran=True, reason=None)
        )
    )
    assert line.startswith("Watch beat: all 2 checks ran and none flagged — quiet.")


def test_a_beat_with_a_check_that_did_not_run_says_so_and_never_says_quiet():
    """The v3 incident in reverse: there, a beat pushed the harness's own
    "this turn produced no reply" text to a phone as news and recorded
    success. An incomplete beat names the check and its reason."""
    line = beats.watch_line(
        _result(
            CheckRun(check="a", ran=True, reason=None),
            CheckRun(check="b", ran=False, reason="the gateway link is not configured"),
        )
    )
    assert "1 of 2 checks ran" in line
    assert "b — the gateway link is not configured" in line
    assert "quiet." not in line and "all clear" not in line.lower()


def test_the_line_counts_new_folded_and_cleared_from_the_numbers_not_from_a_sentence():
    line = beats.watch_line(
        _result(
            CheckRun(
                check="a",
                ran=True,
                reason=None,
                findings=(Finding(key="k", title="t", facts={}),),
            ),
            new=1,
            folded=0,
            cleared=3,
        )
    )
    assert "Of 1 finding, 1 new and 0 folded onto a notice already raised." in line
    assert "3 notices cleared: those conditions ended." in line


def test_an_empty_beat_is_not_vacuously_quiet():
    """all() over no checks is True, which would let a registry that failed to
    import report a perfect night having looked at nothing."""
    result = _result()
    assert result.quiet is False
    assert result.ran == () and result.total == 0
    assert "no check ran" in beats.watch_line(result)


async def test_an_unknown_beat_name_is_refused_and_pauses_the_row(pool, only):
    """The same fact an unknown job handler states: nothing else can make that
    row do anything, and re-running it hourly would write the refusal 24 times
    a day."""
    owner = await _owner(pool)
    only(_check("all_fine", []))
    await beats.ensure_beats(pool)
    timer_id = await pool.fetchval(
        "INSERT INTO timers (person_id, kind, title, payload, schedule, timezone, "
        "next_fire_at, created_via) "
        "VALUES ($1, $2, 'rogue', $3::jsonb, $4::jsonb, 'UTC', $5, 'system') RETURNING id",
        owner.id,
        beats.BEAT_KIND,
        {"handler": "nope"},
        {"kind": "hour", "minute": 0},
        datetime(2031, 1, 1, tzinfo=UTC),
    )
    await scheduler.tick_once(app, pool, now=LATER)
    (firing,) = await _firings(pool, timer_id)
    assert firing["status"] == scheduler.FIRING_REFUSED
    assert "no beat named 'nope'" in firing["reason"]
    row = await timers.get(pool, timer_id)
    assert row["paused_at"] is not None and "no beat named 'nope'" in row["paused_reason"]


async def test_a_beat_whose_record_cannot_be_written_is_a_failed_firing(pool, only, monkeypatch):
    """No silent fallback: the firing's verdict is the fact of the write, not
    the fact that the beat ran."""
    await _owner(pool)
    only(_check("all_fine", []))
    await beats.ensure_beats(pool)
    watch = (await _beat_rows(pool))["watch"]

    async def refuse(*args, **kwargs):
        raise RuntimeError("the disk is full")

    monkeypatch.setattr(chat, "_persist_assistant", refuse)
    await scheduler.tick_once(app, pool, now=LATER)
    (firing,) = await _firings(pool, watch["id"])
    assert firing["status"] == scheduler.FIRING_ERROR
    assert "the disk is full" in firing["reason"]
    assert firing["delivery"]["chat"]["ok"] is False
    assert await pool.fetchval(TURN_STATUS, firing["turn_id"]) == "error"


# -- what a beat is NOT -----------------------------------------------------------


async def test_a_beat_cannot_be_created_from_the_tool_path(pool):
    """Seeded from code alone: a beat that does not exist in app/beats.py can
    never become a row, whatever asks for one."""
    owner = await _owner(pool)
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", owner.id
    )
    with pytest.raises(TimerRefused, match="ensure_beats|seeded from code"):
        await timers.create(
            pool,
            person=owner,
            kind="beat",
            title="my own beat",
            payload={"handler": "watch"},
            spec={"kind": "hour", "minute": 0},
            tz="UTC",
            conversation_id=conversation,
            created_via="chat",
        )
    assert await pool.fetchval("SELECT count(*) FROM timers") == 0


def test_beat_is_a_kind_the_store_knows_and_never_a_person_kind():
    assert "beat" in timers.KINDS and "beat" in timers.SEEDED_KINDS
    assert "beat" not in timers.PERSON_KINDS
    # The tool's own enum is built from its own list of person kinds, so the
    # create_timer schema still offers only reminder and scheduled.
    from app.tools import timers as timers_tool

    assert "beat" not in timers_tool.KINDS


def test_a_beat_turn_walks_the_beat_chain():
    """Without this the gateway gets no X-Nova-Role: it serves the explicit
    model with no chain and no fallback, and meters the spend under a NULL
    role, so an hourly beat's cost would be invisible on the Spend page."""
    assert chat._ROLE_BY_KIND[beats.BEAT_TURN_KIND] == "beat"


def test_the_beat_role_is_one_the_gateway_will_take():
    """`beat` is not a gateway built-in, so it must satisfy the ledger's role
    pattern — that is the one rule the gateway applies to X-Nova-Role, and it
    is also what makes the spend meterable under the role."""
    import re

    assert re.fullmatch(r"[a-z_]{1,32}", chat._ROLE_BY_KIND[beats.BEAT_TURN_KIND])


def test_the_beats_three_settings_are_the_registry_own_defs():
    """This pin used to say the defs had NOT landed (the beat read the table
    directly while S11-6 was still to come). S11-6 registered all three, so it
    moved deliberately: every key beats reads is a def, which is what makes
    `read_value` return the def's default instead of KeyError, and what makes
    the settings page able to show them at all."""
    for key in (beats.DIGEST_AT_KEY, beats.ENABLED_KEY, beats.MAX_NOTICES_KEY):
        assert key in settings_store.DEFS_BY_KEY, key
        assert key.startswith("proactive.")
    # The digest's hour is seeded from the def's own default, so the row and
    # the settings page cannot start out disagreeing.
    assert settings_store.DEFS_BY_KEY[beats.DIGEST_AT_KEY].default == beats.DEFAULT_DIGEST_AT
    # And the two settings a write re-times the digest for are the two the
    # firing is actually computed from.
    assert beats.retimes_the_digest() == (beats.DIGEST_AT_KEY, "nova.timezone")


def test_every_beat_has_a_title_and_a_runner():
    """A beat in BEATS without either would seed a row nothing could run — the
    firing would refuse it hourly and pause it."""
    assert set(beats.BEATS) == set(beats.BEAT_TITLES) == set(beats._RUNNERS)


async def test_a_beat_that_raises_is_an_error_whose_reason_is_on_the_span(pool, monkeypatch):
    """The trace is where anyone looks first, so the exception's words are on
    the span as well as on the firing — never a bare class name."""
    await _owner(pool)
    await beats.ensure_beats(pool)
    watch = (await _beat_rows(pool))["watch"]

    async def explodes(app_, pool_, turn, firing_id):
        raise RuntimeError("the check registry is on fire")

    monkeypatch.setitem(beats._RUNNERS, beats.WATCH, explodes)
    await scheduler.tick_once(app, pool, now=LATER)
    (firing,) = await _firings(pool, watch["id"])
    assert firing["status"] == scheduler.FIRING_ERROR
    assert "the check registry is on fire" in firing["reason"]
    (span,) = await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE turn_id = $1 AND kind = 'beat'",
        firing["turn_id"],
    )
    assert span["name"] == beats.WATCH
    assert "the check registry is on fire" in span["meta"]["error"]


# -- the two ways she speaks (S11-3) ----------------------------------------------
#
# The watch beat records; the DIGEST is what reaches him, once a day — except
# for the one urgent family, which goes out the moment its row exists, at any
# hour, with a sentence composed in code. Everything below is that split, and
# every pin here is one rule in different clothes: a delivery that reached
# nobody is a FAILED delivery, never a quiet success.


@pytest.fixture(autouse=True)
def _clean_hub():
    """The hub is process-global, so a socket left registered by one test would
    make the next test's beat push to a device it never connected."""
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    yield
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()


async def _run_beat(pool, name: str, *, now: datetime):
    """Fire exactly ONE beat and hand back its firing row.

    tick_once claims by `next_fire_at`, and the two seeded beats have no
    guaranteed order between them — so the other one is put OUT OF REACH and
    this one is made due, rather than trusting whichever the seed happened to
    time first.

    Out of reach rather than PAUSED, changed 2026-09-09: the claim reads
    `paused_at IS NULL AND next_fire_at <= now`, so moving the instant selects
    one beat exactly as well — and the digest now reads `paused_at` off the
    watch row to say why nothing was watched, so a harness that paused the
    watch beat in order to run the digest would have made every digest in this
    file report its own scaffolding as a dead beat. A pause a TEST sets on the
    other beat is left alone for the same reason.
    """
    rows = await _beat_rows(pool)
    for other, row in rows.items():
        if other == name:
            await pool.execute(
                "UPDATE timers SET paused_at = NULL, paused_reason = NULL, next_fire_at = $2 "
                "WHERE id = $1",
                row["id"],
                now - timedelta(minutes=1),
            )
        else:
            await pool.execute(
                "UPDATE timers SET next_fire_at = $2 WHERE id = $1",
                row["id"],
                now + timedelta(days=365),
            )
    fired = await scheduler.tick_once(app, pool, now=now)
    assert len(fired) == 1, "exactly one beat should have been due"
    return (await _firings(pool, rows[name]["id"]))[-1]


async def _connect(pool, *, name: str):
    """Enroll and drive serve() to a registered socket (test_delivery's shape)."""
    device = FakeDevice()
    creator = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('adult', 'adult') RETURNING id"
    )
    code = await devices.mint_pairing_code(pool, created_by=creator)
    enrolled = await devices.enroll(
        pool,
        code=code["code"],
        pubkey=device.pubkey_hex,
        name=name,
        platform="linux",
        hostname="host",
    )
    device.device_id = enrolled["device_id"]
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    ready = await asyncio.wait_for(device.handshake(conn), 2)
    assert ready["type"] == "ready"
    return device, conn, task


async def _close(conn, task) -> None:
    conn.feed_close()
    await asyncio.wait_for(task, 2)


def _brief(gateway) -> str:
    """The user message the digest handed the model — the code-composed brief."""
    payloads = [body for path, body in gateway.seen if path == "/v1/chat/completions"]
    assert len(payloads) == 1, f"the digest asks for exactly one round, not {len(payloads)}"
    return payloads[0]["messages"][-1]["content"]


def _prose(content: str) -> str:
    """The model's own words, without the code-composed facts the backend
    appends beneath them.

    The pin moved on 2026-09-09: every digest now carries a COVERAGE line (and
    a STILL STANDING tail when something is standing), separated from the prose
    by a blank line — the delegate facts-line idiom, in the one message a day.
    The prose is still asserted exactly; what is new is what stands under it.
    """
    return content.split("\n\n")[0]


def _facts_lines(content: str) -> list[str]:
    """Everything the backend appended under the prose."""
    return content.split("\n\n")[1:]


def _urgent_finding() -> Finding:
    return Finding(
        key="peer_down:gateway",
        title="the gateway has not answered for 40 minutes",
        facts={"peer": "gateway", "state": "unreachable"},
    )


# -- one message a day ------------------------------------------------------------


async def test_two_findings_in_a_day_produce_exactly_one_chat_message(pool, only, mount_peers):
    """The gate for this sub-slice. Two things went wrong; he hears once."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(
        _check("work_thing", [_finding("timer_failing:1", failures=4)]),
        _check("money_thing", [_finding("agent_over_cap:coder", spent_usd=41)]),
    )
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)
    assert len(await _notices(pool)) == 2
    assert await _messages(pool, his_chat["id"]) == [], "the watch beat tells him nothing"

    gateway = FakeGateway(deltas=("Two things are still standing from today's checks.",))
    mount_peers(gateway=gateway)
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    landed = await _messages(pool, his_chat["id"])
    assert len(landed) == 1, "one digest a day, whatever it carries"
    assert _prose(landed[0]["content"]) == "Two things are still standing from today's checks."
    # Provenance, appended in code beneath her prose and present on a good day
    # as loudly as on a bad one: "all quiet" must never mean "I was not there".
    assert any(
        line.startswith(beats.COVERAGE_PREFIX) for line in _facts_lines(landed[0]["content"])
    )
    assert landed[0]["turn_id"] == firing["turn_id"], "his message is badged from the beat's trace"
    assert firing["status"] == scheduler.FIRING_OK and firing["reason"] is None
    assert firing["delivery"]["chat"] == {"ok": True}
    assert firing["delivery"]["digest"]["delivered"] is True
    assert firing["delivery"]["digest"]["notices"] == 2
    assert "devices" not in firing["delivery"], "a digest never reaches for a device"
    assert [row["state"] for row in await _notices(pool)] == ["delivered", "delivered"]

    # The brief is composed in CODE from the rows: each check's own title, the
    # derived facts the fingerprint was computed over, and the sighting count.
    brief = _brief(gateway)
    assert "timer_failing:1 is true" in brief and "failures=4" in brief
    assert "agent_over_cap:coder is true" in brief and "spent_usd=41" in brief
    assert "seen 1 time(s)" in brief
    payload = [b for p, b in gateway.seen if p == "/v1/chat/completions"][0]
    assert "tools" not in payload, "no tool is advertised: there is no round she could act in"


async def test_a_day_with_nothing_to_tell_him_produces_no_message_at_all(pool, only, mount_peers):
    """A beat that found nothing must be able to say nothing. The line it does
    write goes into its own inactive conversation, and no model is asked at
    all — there is nothing to write about."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("all_fine", []))
    await beats.ensure_beats(pool)
    beat_conversation = await beats.beat_conversation(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)

    gateway = FakeGateway(deltas=("must never be asked",))
    mount_peers(gateway=gateway)
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    assert await _messages(pool, his_chat["id"]) == []
    assert firing["status"] == scheduler.FIRING_OK and firing["reason"] is None
    digest = dict(firing["delivery"]["digest"])
    # Coverage rides the record of a quiet day too, and is computed BEFORE the
    # early return (2026-09-09): the day the watch beat stops IS a quiet day,
    # and it is the one day the provenance line has to appear. This day was
    # watched — one pass — so the quiet stands and nothing is sent.
    assert digest.pop("coverage")["passes"] == 1
    assert digest == {
        "delivered": False,
        "notices": 0,
        "reason": beats.DIGEST_NOTHING_NOTE,
    }
    assert gateway.seen == [], "a quiet digest costs nothing: no model is asked"
    assert beats.DIGEST_NOTHING in [
        row["content"] for row in await _messages(pool, beat_conversation)
    ]


# -- the urgent bypass ------------------------------------------------------------


async def test_an_urgent_finding_pushes_immediately_with_a_code_composed_sentence(
    pool, only, mount_peers
):
    """The other gate: the one urgent family arrives the moment it is found, at
    whatever hour, on chat AND on every connected device — and the sentence is
    composed from the check's own title and facts, because the whole point of a
    one-item urgent list is that it needs no prose."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    phone, conn, task = await _connect(pool, name="phone")
    gateway = FakeGateway(deltas=("must never be asked",))
    mount_peers(gateway=gateway)
    only(_check("stack_gateway", [_urgent_finding()], urgent=True))
    await beats.ensure_beats(pool)

    fire = asyncio.create_task(_run_beat(pool, beats.WATCH, now=LATER))
    command = await asyncio.wait_for(phone.answer_command(conn), 5)
    firing = await asyncio.wait_for(fire, 10)

    said = (
        "Urgent (stack_gateway): the gateway has not answered for 40 minutes "
        "— peer=gateway, state=unreachable"
    )
    assert [row["content"] for row in await _messages(pool, his_chat["id"])] == [said]
    assert command["envelope"]["args"]["message"] == said
    assert gateway.seen == [], "urgency is a property of the check, so no model is asked"

    (row,) = await _notices(pool)
    assert row["state"] == notices.DELIVERED
    assert firing["delivery"]["watch"]["pushed"] == 1
    assert firing["delivery"]["watch"]["push_failed"] == 0
    (record,) = firing["delivery"]["urgent"]
    assert record["reached"] is True
    assert record["receipt"] == {"chat": {"ok": True}, "devices": [{"name": "phone", "ok": True}]}
    assert firing["status"] == scheduler.FIRING_OK
    await _close(conn, task)


async def test_the_watch_beats_own_line_counts_the_push_instead_of_claiming_silence(pool, only):
    """The line the watch beat writes about itself is composed from the counts,
    so a beat that DID deliver never says "nothing was delivered"."""
    await _owner(pool)
    only(_check("stack_gateway", [_urgent_finding()], urgent=True))
    await beats.ensure_beats(pool)
    beat_conversation = await beats.beat_conversation(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)

    line = (await _messages(pool, beat_conversation))[0]["content"]
    assert "1 urgent notice went out immediately — everything else waits for the digest." in line
    assert "Nothing was delivered" not in line


async def test_the_same_urgent_finding_an_hour_later_folds_and_does_not_push_again(pool, only):
    """That is what the fold is FOR. v3 re-worded two findings into fourteen
    phone pushes in eight hours; the fingerprint is over the facts, so the same
    facts are the same news and the same news is told once."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("stack_gateway", [_urgent_finding()], urgent=True))
    await beats.ensure_beats(pool)

    await _run_beat(pool, beats.WATCH, now=LATER)
    assert len(await _messages(pool, his_chat["id"])) == 1
    second = await _run_beat(pool, beats.WATCH, now=LATER + timedelta(hours=1))

    assert len(await _messages(pool, his_chat["id"])) == 1, "a fold delivers nothing"
    (row,) = await _notices(pool)
    assert row["repeats"] == 2 and row["state"] == notices.DELIVERED
    assert second["delivery"]["watch"]["folded"] == 1
    assert second["delivery"]["watch"]["pushed"] == 0
    assert "urgent" not in second["delivery"], "no push was attempted, so none is recorded"


async def test_a_failed_urgent_delivery_pushes_again_on_the_next_sighting(pool, only, monkeypatch):
    """A repeat of something that never landed is not a repeat. The condition
    is DERIVED from the notices store's own deliverable states, so a failed row
    is still owed and the next sighting tries again."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("stack_gateway", [_urgent_finding()], urgent=True))
    await beats.ensure_beats(pool)

    real = chat._persist_assistant
    # A flag rather than undoing the patch: `only` uses the same monkeypatch
    # instance, so undoing here would restore the real twelve-check registry
    # underneath the next beat as well.
    broken = {"disk": True}

    async def refuse(pool_, conversation_id, text, turn_id=None):
        # Only HIS conversation: the beat's own record still lands, so this is
        # a failed DELIVERY and not a broken beat.
        if broken["disk"] and conversation_id == his_chat["id"]:
            raise RuntimeError("the disk is full")
        return await real(pool_, conversation_id, text, turn_id)

    monkeypatch.setattr(chat, "_persist_assistant", refuse)
    first = await _run_beat(pool, beats.WATCH, now=LATER)

    assert await _messages(pool, his_chat["id"]) == []
    (row,) = await _notices(pool)
    assert row["state"] == notices.FAILED
    assert first["status"] == scheduler.FIRING_ERROR
    assert beats.PUSH_FAILED in first["reason"] and "the disk is full" in first["reason"]
    assert first["delivery"]["watch"]["push_failed"] == 1

    broken["disk"] = False
    second = await _run_beat(pool, beats.WATCH, now=LATER + timedelta(hours=1))

    assert len(await _messages(pool, his_chat["id"])) == 1, "the retry is the point"
    (row,) = await _notices(pool)
    assert row["state"] == notices.DELIVERED and row["repeats"] == 2
    assert second["delivery"]["watch"]["pushed"] == 1
    assert second["status"] == scheduler.FIRING_OK


def test_only_a_notice_nobody_was_told_about_pushes():
    """The predicate is two fields wide and both are derived: urgency from the
    check family, "still owed" from notices.DELIVERABLE_STATES. Nothing about
    `is_new` — a failed push would otherwise be suppressed forever."""
    assert set(notices.DELIVERABLE_STATES) == {notices.RAISED, notices.FAILED}
    for state in notices.STATES:
        expected = state in notices.DELIVERABLE_STATES
        assert beats.wants_push(SimpleNamespace(urgent=True, state=state)) is expected
        assert beats.wants_push(SimpleNamespace(urgent=False, state=state)) is False


def test_the_urgent_sentence_names_the_check_that_made_it_urgent():
    """The S11 gate: an urgent notice says which check made it urgent. Composed
    from the row, never from a model."""
    said = beats.urgent_line(
        SimpleNamespace(
            check_name="stack_database",
            title="the database refused a connection",
            facts={"error": "too many clients", "peer": "postgres"},
        )
    )
    assert said == (
        "Urgent (stack_database): the database refused a connection "
        "— error=too many clients, peer=postgres"
    )


# -- what the digest may and may not carry ----------------------------------------


async def test_the_digest_never_carries_an_urgent_notice_that_already_went_out(
    pool, only, mount_peers
):
    """It cannot: a pushed notice is `delivered`, and deliverable() reads only
    what is still owed. The ordinary finding beside it is still told."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(
        _check("stack_gateway", [_urgent_finding()], urgent=True),
        _check("work_thing", [_finding("timer_failing:1", failures=4)]),
    )
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)

    gateway = FakeGateway(deltas=("A timer has failed four nights running.",))
    mount_peers(gateway=gateway)
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    brief = _brief(gateway)
    assert "timer_failing:1 is true" in brief
    assert "the gateway has not answered" not in brief, "he was already told, at the hour"
    assert firing["delivery"]["digest"]["notices"] == 1
    # Two messages in his chat: the urgent push at the hour, the digest after.
    assert [_prose(row["content"]) for row in await _messages(pool, his_chat["id"])] == [
        "Urgent (stack_gateway): the gateway has not answered for 40 minutes "
        "— peer=gateway, state=unreachable",
        "A timer has failed four nights running.",
    ]


async def test_an_urgent_notice_that_reached_nobody_is_still_owed_and_lands_in_the_digest(
    pool, only, mount_peers, monkeypatch
):
    """`failed` is a deliverable state, not a finished one — otherwise ONE bad
    push would suppress a still-true finding forever."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("stack_gateway", [_urgent_finding()], urgent=True))
    await beats.ensure_beats(pool)

    real = chat._persist_assistant
    # See the note above: undo() would restore the real registry too.
    broken = {"disk": True}

    async def refuse(pool_, conversation_id, text, turn_id=None):
        if broken["disk"] and conversation_id == his_chat["id"]:
            raise RuntimeError("the disk is full")
        return await real(pool_, conversation_id, text, turn_id)

    monkeypatch.setattr(chat, "_persist_assistant", refuse)
    await _run_beat(pool, beats.WATCH, now=LATER)
    broken["disk"] = False

    gateway = FakeGateway(deltas=("The gateway went quiet last night; here is what I saw.",))
    mount_peers(gateway=gateway)
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    brief = _brief(gateway)
    assert "the gateway has not answered for 40 minutes" in brief
    assert "an earlier delivery of this reached nobody" in brief
    assert firing["delivery"]["digest"]["delivered"] is True
    assert (await _notices(pool))[0]["state"] == notices.DELIVERED


async def test_a_digest_whose_chat_rung_fails_marks_every_notice_failed_and_tells_him_next_time(
    pool, only, mount_peers, monkeypatch
):
    """A delivery that reached nobody is a FAILED delivery. Each notice records
    the ladder's own words, stays deliverable, and is in the next digest."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(
        _check("work_thing", [_finding("timer_failing:1", failures=4)]),
        _check("money_thing", [_finding("agent_over_cap:coder", spent_usd=41)]),
    )
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)

    real = chat._persist_assistant
    # See the note above: undo() would restore the real registry too.
    broken = {"disk": True}

    async def refuse(pool_, conversation_id, text, turn_id=None):
        if broken["disk"] and conversation_id == his_chat["id"]:
            raise RuntimeError("the disk is full")
        return await real(pool_, conversation_id, text, turn_id)

    monkeypatch.setattr(chat, "_persist_assistant", refuse)
    mount_peers(gateway=FakeGateway(deltas=("Two things came up today.",)))
    failed = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    assert await _messages(pool, his_chat["id"]) == []
    assert failed["status"] == scheduler.FIRING_ERROR
    assert "the disk is full" in failed["reason"]
    assert failed["delivery"]["chat"]["ok"] is False
    assert failed["delivery"]["digest"]["delivered"] is False
    rows = await _notices(pool)
    assert [row["state"] for row in rows] == [notices.FAILED, notices.FAILED]
    reasons = await pool.fetch("SELECT failed_reason FROM notices")
    assert all("the disk is full" in row["failed_reason"] for row in reasons)

    broken["disk"] = False
    gateway = FakeGateway(deltas=("Still two things standing.",))
    mount_peers(gateway=gateway)
    again = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(hours=24))

    assert again["delivery"]["digest"]["notices"] == 2, "nobody was told, so it is still owed"
    assert [_prose(row["content"]) for row in await _messages(pool, his_chat["id"])] == [
        "Still two things standing."
    ]
    assert [row["state"] for row in await _notices(pool)] == [
        notices.DELIVERED,
        notices.DELIVERED,
    ]


# -- the guards, over the one message he reads ------------------------------------


async def test_a_beat_whose_reply_the_model_did_not_write_delivers_nothing(pool, only, mount_peers):
    """The v3 incident exactly: a beat pushed the harness's own "this turn
    produced no reply" text to a phone as news and recorded success. A round
    that produced nothing is recorded as such on its own span, and that
    recording — not a sentence — is what stops the delivery."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("work_thing", [_finding("timer_failing:1", failures=4)]))
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)

    mount_peers(gateway=FakeGateway(deltas=()))  # a round with no content at all
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    assert await _messages(pool, his_chat["id"]) == []
    assert firing["status"] == scheduler.FIRING_ERROR
    assert beats.DIGEST_NOT_WRITTEN in firing["reason"]
    assert beats.DIGEST_NOT_WRITTEN in firing["delivery"]["digest"]["unable"]
    assert firing["delivery"]["digest"]["delivered"] is False
    # Nothing was attempted, so nothing is marked: it is owed exactly as before.
    (row,) = await _notices(pool)
    assert row["state"] == notices.RAISED
    span = await pool.fetchrow(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND kind = 'llm_call'", firing["turn_id"]
    )
    assert span["meta"]["error_class"] == chat.EMPTY_ROUND
    assert guards.model_wrote_nothing([SimpleNamespace(kind="llm_call", meta=span["meta"])])


async def test_an_all_clear_while_a_check_could_not_run_is_corrected_and_the_beat_is_not_quiet(
    pool, only, mount_peers
):
    """Quiet is COMPUTED, by the same checks.quiet the watch beat used, over the
    runs the last pass actually recorded. A digest that writes "everything looks
    fine" while a probe could not be made is contradicted in the message he
    reads, and the firing does not record the pass as quiet."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(
        _check("work_thing", [_finding("timer_failing:1", failures=4)]),
        _check("stack_ollama", [], raises=checks.CannotCheck("the gateway link is not configured")),
    )
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)

    gateway = FakeGateway(deltas=("Everything looks fine.",))
    mount_peers(gateway=gateway)
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    (message,) = await _messages(pool, his_chat["id"])
    assert message["content"].startswith("Everything looks fine.")
    assert guards.ALL_CLEAR_NOT_RUN_CORRECTION.format(unrun=1, total=2) in message["content"]
    assert firing["delivery"]["digest"]["quiet"] is False
    assert "stack_ollama" in firing["delivery"]["digest"]["not_quiet"]
    assert firing["delivery"]["digest"]["corrections"] == 1
    # The brief told her the truth first — the guard is the second line, not the
    # only one.
    assert "stack_ollama could not run — the gateway link is not configured" in _brief(gateway)
    span = await pool.fetchrow(
        "SELECT name FROM turn_spans WHERE turn_id = $1 AND kind = 'guard'", firing["turn_id"]
    )
    assert span["name"] == "observation"


async def test_the_digest_says_what_got_better_since_the_last_one(pool, only, mount_peers):
    """Half of "she tells you once" is telling you when it STOPPED. The cleared
    list is read from rows the reconcile wrote — the same rows that free a
    fingerprint — so the digest can say what got better without anyone
    remembering it."""
    owner = await _owner(pool)
    await conversations.active_conversation(pool, owner)
    standing = {
        "work": [_finding("timer_failing:1", failures=4)],
        "money": [_finding("agent_over_cap:coder", spent_usd=41)],
    }

    async def work(app_, pool_):
        return list(standing["work"])

    async def money(app_, pool_):
        return list(standing["money"])

    only(
        Check(name="work_thing", describe="w", urgent=False, run=work),
        Check(name="money_thing", describe="m", urgent=False, run=money),
    )
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)
    standing["work"] = []  # he fixed it
    await _run_beat(pool, beats.WATCH, now=LATER + timedelta(hours=1))

    gateway = FakeGateway(deltas=("The coder agent is over its cap; the timer is sorted.",))
    mount_peers(gateway=gateway)
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(hours=2))

    brief = _brief(gateway)
    standing_half, cleared_half = brief.split("CLEARED since the last digest")
    assert "agent_over_cap:coder is true" in standing_half
    assert "timer_failing:1 is true" in cleared_half
    digest = dict(firing["delivery"]["digest"])
    # Provenance rides every digest now (2026-09-09); the rest of the record is
    # unchanged, and the coverage numbers have their own tests below.
    assert digest.pop("coverage")["passes"] == 2
    assert digest == {
        "delivered": True,
        "notices": 1,
        "cleared": 1,
        "quiet": False,
        "not_quiet": "1 finding(s) from money_thing",
    }
    # A relayed fault whose subject a finding names is BACKED, so the guard says
    # nothing: a correction under her own true sentence would be the worst
    # thing this family could do to the one message he reads.
    (message,) = await _messages(pool, (await conversations.active_conversation(pool, owner))["id"])
    assert _prose(message["content"]) == "The coder agent is over its cap; the timer is sorted."


def test_the_brief_is_rows_it_says_what_she_did_and_what_reached_nobody():
    """digest_brief is pure and composed from the notice rows: the check's own
    title, the derived facts the fingerprint was computed over, the sighting
    count, her own acted note, and — for a notice whose delivery failed — the
    fact that nobody was told. No sentence anyone wrote about the world."""
    now = datetime(2031, 6, 1, 14, 0, tzinfo=UTC)
    outstanding = [
        SimpleNamespace(
            title="the coder agent is over its monthly cap",
            check_name="money_caps",
            finding_key="agent_over_cap:coder",
            facts={"spent_usd": 41, "cap_usd": 40},
            repeats=3,
            first_seen_at=now,
            last_seen_at=now,
            acted=True,
            acted_note="lowered its round budget to 4",
            state=notices.RAISED,
            failed_reason=None,
        ),
        SimpleNamespace(
            title="the nightly backup timer is paused",
            check_name="work_timers",
            finding_key="timer_paused:9",
            facts={},
            repeats=1,
            first_seen_at=now,
            last_seen_at=now,
            acted=False,
            acted_note=None,
            state=notices.FAILED,
            failed_reason="the disk is full",
        ),
    ]
    brief = beats.digest_brief(
        name="jeremy",
        outstanding=outstanding,
        cleared=[],
        cleared_more=0,
        runs=(
            CheckRun(check="money_caps", ran=True, reason=None),
            CheckRun(check="stack_ollama", ran=False, reason="the gateway link is not configured"),
        ),
        now=now,
        zone="UTC",
        notes=["the cleared notices could not be read — RuntimeError: boom"],
    )
    assert "STANDING (2)" in brief
    assert "facts: cap_usd=40, spent_usd=41" in brief
    assert "seen 3 time(s)" in brief
    assert "what you did about it: lowered its round budget to 4" in brief
    assert "you have not acted on this" in brief
    assert "an earlier delivery of this reached nobody: the disk is full" in brief
    assert "THE LAST WATCH PASS: 1 of 2 checks ran." in brief
    assert "stack_ollama could not run — the gateway link is not configured" in brief
    # A read that FAILED is in the brief, not swallowed: a message composed over
    # a partial view has to be able to say so.
    assert "NOT READ: the cleared notices could not be read — RuntimeError: boom" in brief
    assert brief.endswith(beats.DIGEST_ASK.format(name="jeremy"))


# -- the facts the backend appends (2026-09-09) -----------------------------------
#
# The engine's first unattended night. The host slept from 02:00 to 11:23 UTC:
# the hourly watch beat ran at 01:05, at 02:05, and then not for nine hours.
# Nothing lied — the firing history holds the gap exactly — but the 07:30
# digest would have reported its findings without ever saying that nothing had
# been watched for nine of the previous twelve. A reader assumes the hourly
# cover he was promised, and silence reading as coverage is the whole defect
# class this slice exists to eliminate.
#
# Two lines the BACKEND composes and appends under whatever the model wrote,
# the delegate facts-line idiom: the model writes the prose, the backend writes
# the numbers, neither can overstate the other.
#
#   * COVERAGE, every time, good day or bad: how many times the watch beat
#     FIRED since the last digest that reached him, how many of those firings
#     actually made a PASS, and the longest it went without one. Provenance, so
#     "all quiet" can never mean "I was not there".
#   * STILL STANDING, only when something is: what is still true and was
#     already reported, named with its sighting count — not re-explained, not
#     re-delivered, and never able to CAUSE a message.
#
# Three of these pins moved on the review of the same day and each says why
# where it sits: a firing ROW is not a pass; coverage is computed BEFORE the
# quiet early-return, so the one day the watch beat stops is not the one day
# the digest says nothing; and what is "already told" is derived from the
# notices store's own definition of what is still owed rather than named
# state by state.


async def _fired(pool, timer_id, *ats: datetime, made_a_pass: bool = True) -> None:
    """Watch firing rows at exactly these instants. Written by hand because a
    real tick stamps every firing with now(), and a night's worth of history is
    the thing under test.

    `made_a_pass` is the difference between a ROW and a PASS: the record a beat
    writes about ITSELF is where "a check actually ran" lives, and a firing
    without one watched nothing — the engine switched off, a shutdown, an error
    before the checks.
    """
    for at in ats:
        await pool.execute(
            "INSERT INTO timer_firings (timer_id, scheduled_for, started_at, ended_at, status, "
            "delivery) VALUES ($1, $2, $2, $2, 'ok', $3::jsonb)",
            timer_id,
            at,
            {"beat": beats.WATCH, "watch": {"ran": ["work_thing"]}} if made_a_pass else {},
        )


async def _watch_history(pool, *hours_back: float, made_a_pass: bool = True) -> None:
    """Watch firings that many hours before the one real pass this test ran, so
    every interval below is exact rather than a wall-clock near-miss."""
    watch = (await _beat_rows(pool))["watch"]
    (real,) = await _firings(pool, watch["id"])
    await _fired(
        pool,
        watch["id"],
        *(real["started_at"] - timedelta(hours=h) for h in hours_back),
        made_a_pass=made_a_pass,
    )


async def _first_watch_start(pool) -> datetime:
    return (await beats.watch_firings(pool))[0].started_at


async def _pause_the_watch_beat(pool, reason: str) -> None:
    await pool.execute(
        "UPDATE timers SET paused_at = now(), paused_reason = $1 "
        "WHERE kind = $2 AND payload->>'handler' = $3",
        reason,
        beats.BEAT_KIND,
        beats.WATCH,
    )


def _line(content: str, prefix: str) -> str | None:
    for line in _facts_lines(content):
        if line.startswith(prefix):
            return line
    return None


async def test_the_coverage_line_is_there_on_a_good_day_too(pool, only, mount_peers):
    """It is PROVENANCE, not news. A digest that reports findings without
    saying how much was watched lets "all quiet" mean "I was not there", so the
    sentence is not conditional on the numbers being bad."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("work_thing", [_finding("timer_failing:1", failures=4)]))
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)
    await _watch_history(pool, 6, 5, 4, 3, 2, 1)

    gateway = FakeGateway(deltas=("One thing is still standing.",))
    mount_peers(gateway=gateway)
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    (message,) = await _messages(pool, his_chat["id"])
    coverage = _line(message["content"], beats.COVERAGE_PREFIX)
    assert coverage is not None, "the coverage line goes out every time"
    assert "fired 7 times" in coverage and "every one of them making a pass" in coverage
    assert "the longest it went without a pass was 1h 00m" in coverage
    assert "every hour at :05" in coverage, "the gap needs its yardstick beside it"
    # The firing carries the numbers the sentence was composed from, so the
    # record can be checked against the message he actually read.
    assert firing["delivery"]["digest"]["coverage"] == {
        "firings": 7,
        "passes": 7,
        "from_a_digest": False,
        "window_start": (await _first_watch_start(pool)).isoformat(),
        "longest_gap_s": 3600,
    }


async def test_a_firing_row_is_not_a_pass_and_the_line_says_both_numbers(pool, only, mount_peers):
    """The review's CRITICAL, 2026-09-09. A row is written the moment the
    scheduler CLAIMS a firing, and several kinds of firing watch nothing at
    all: `proactive.enabled` false returns FIRING_OK having never called a
    check, a shutdown leaves the row interrupted, a failure before the checks
    leaves it error. Counting rows would have reported "the watch beat ran 75
    times" after three days with the engine switched off — the exact lie this
    line exists to prevent.

    So a PASS is read off the record the beat writes about itself, and the
    difference is STATED rather than papered over with the smaller number."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("work_thing", [_finding("timer_failing:1", failures=4)]))
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)
    await _watch_history(pool, 6, 5, 4, 3, 2, 1, made_a_pass=False)

    mount_peers(gateway=FakeGateway(deltas=("One thing is still standing.",)))
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    (message,) = await _messages(pool, his_chat["id"])
    coverage = _line(message["content"], beats.COVERAGE_PREFIX)
    assert "fired 7 times" in coverage and "1 of them making a pass" in coverage
    record = firing["delivery"]["digest"]["coverage"]
    assert (record["firings"], record["passes"]) == (7, 1)
    # And the gap is measured between PASSES: six firings that watched nothing
    # do not shorten a six-hour hole in the watching.
    assert record["longest_gap_s"] == 6 * 3600
    assert "the longest it went without a pass was 6h 00m" in coverage


async def test_the_night_the_host_slept_is_in_the_coverage_line(pool, only, mount_peers):
    """The 2026-09-09 shape, in rows: two passes and then a nine-hour hole. The
    findings are reported exactly as before; what is new is that the message
    also says how much of the span was watched."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("work_thing", [_finding("timer_paused:9", reason="an agent was deleted")]))
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)
    await _watch_history(pool, 12, 11)

    mount_peers(gateway=FakeGateway(deltas=("A timer is still paused.",)))
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    (message,) = await _messages(pool, his_chat["id"])
    coverage = _line(message["content"], beats.COVERAGE_PREFIX)
    assert "fired 3 times" in coverage
    assert "the longest it went without a pass was 11h 00m" in coverage
    assert firing["delivery"]["digest"]["coverage"]["longest_gap_s"] == 11 * 3600


async def test_a_watch_beat_that_has_not_run_since_the_last_digest_says_exactly_that(
    pool, only, mount_peers
):
    """The loudest version of the same fact, on a day that still has findings
    of its own to carry it: the beat did not run at all. Said in the message,
    not left as an absence."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("work_thing", [_finding("timer_paused:9", reason="an agent was deleted")]))
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)
    mount_peers(gateway=FakeGateway(deltas=("A timer is still paused.",)))
    await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    # Something new to report, and no watch pass since that digest reached him.
    await notices.record(
        pool,
        Finding(key="timer_failing:1", title="timer_failing:1 is true", facts={"failures": 4}),
        check_name="work_thing",
        turn_id=None,
        firing_id=None,
    )
    mount_peers(gateway=FakeGateway(deltas=("A timer has failed four nights running.",)))
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(hours=25))

    latest = (await _messages(pool, his_chat["id"]))[-1]
    coverage = _line(latest["content"], beats.COVERAGE_PREFIX)
    assert "has not run at all since the last digest that reached you" in coverage
    assert beats.NOT_AN_ALL_CLEAR in coverage
    assert firing["delivery"]["digest"]["coverage"]["passes"] == 0
    assert firing["delivery"]["digest"]["coverage"]["from_a_digest"] is True


async def test_firings_that_watched_nothing_are_not_an_all_clear_either(pool, only, mount_peers):
    """The other shape of zero passes, and a different fact from a beat that
    never fired: it fired on schedule all night and every one of those firings
    ran no check. The sentence says which of the two happened."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("work_thing", [_finding("timer_paused:9", reason="an agent was deleted")]))
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)
    mount_peers(gateway=FakeGateway(deltas=("A timer is still paused.",)))
    await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    # Three firings INSIDE the span — after the digest that reached him — each
    # of which ran no check. Placed off that digest's own start so the span
    # they sit in is the one the next digest measures.
    (told_him,) = await _firings(pool, (await _beat_rows(pool))["digest"]["id"])
    await _fired(
        pool,
        (await _beat_rows(pool))["watch"]["id"],
        *(told_him["started_at"] + timedelta(milliseconds=ms) for ms in (1, 2, 3)),
        made_a_pass=False,
    )
    await notices.record(
        pool,
        Finding(key="timer_failing:1", title="timer_failing:1 is true", facts={"failures": 4}),
        check_name="work_thing",
        turn_id=None,
        firing_id=None,
    )
    mount_peers(gateway=FakeGateway(deltas=("A timer has failed four nights running.",)))
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(hours=25))

    coverage = _line((await _messages(pool, his_chat["id"]))[-1]["content"], beats.COVERAGE_PREFIX)
    assert "fired 3 times" in coverage and "not one of those firings ran a check" in coverage
    assert beats.NOT_AN_ALL_CLEAR in coverage
    record = firing["delivery"]["digest"]["coverage"]
    assert (record["firings"], record["passes"]) == (3, 0)


async def test_a_history_that_cannot_be_read_says_so_rather_than_a_number_nobody_counted(
    pool, only, mount_peers, monkeypatch
):
    """A coverage sentence that reads well and was not computed is worse than
    no sentence at all — and losing the whole digest over it would trade a
    small silence for a large one, so it is stated in the line and on the
    firing and the message still goes."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("work_thing", [_finding("timer_failing:1", failures=4)]))
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)

    async def gone(*args, **kwargs):
        raise RuntimeError("the firing history is gone")

    monkeypatch.setattr(beats, "watch_firings", gone)
    mount_peers(gateway=FakeGateway(deltas=("One thing is still standing.",)))
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    (message,) = await _messages(pool, his_chat["id"])
    assert message["content"].startswith("One thing is still standing.")
    coverage = _line(message["content"], beats.COVERAGE_PREFIX)
    assert coverage.startswith(beats.COVERAGE_UNREADABLE)
    assert "the firing history is gone" in coverage
    assert "the firing history is gone" in firing["delivery"]["digest"]["coverage"]["unreadable"]


async def test_a_firing_after_the_mark_is_not_counted_in_a_span_that_ended_before_it(pool):
    """The review's clock defect, 2026-09-09. `now` was captured before the
    model round and reused as the span's closing boundary up to ten minutes
    later, so the trailing gap was understated and a firing that began DURING
    the round was counted while sitting after the boundary. One instant does
    both jobs: it closes the span and it bounds the query."""
    await _owner(pool)
    await beats.ensure_beats(pool)
    watch = (await _beat_rows(pool))["watch"]
    mark = await pool.fetchval("SELECT now()")
    before, after = mark - timedelta(hours=1), mark + timedelta(minutes=10)
    await _fired(pool, watch["id"], before, after)

    assert [f.started_at for f in await beats.watch_firings(pool, until=mark)] == [before]
    assert len(await beats.watch_firings(pool)) == 2, "unbounded, the row is still there"
    coverage = await beats._coverage(pool, None, mark)
    assert (coverage.firings, coverage.passes) == (1, 1)
    assert coverage.longest_gap == timedelta(hours=1)


# -- the silent death: the day the watch beat stops -------------------------------
#
# The review's MAJOR, and the worst of the six. The quiet early-return happened
# BEFORE coverage was computed, so the provenance line never appeared on the one
# day it mattered most. Nothing else in the system can catch it: `run_all` is
# called only from the watch beat, so no check can ever see its own beat stop —
# once the beat is paused or off nothing new is raised, `deliverable()` empties
# out as the standing findings are delivered, and every digest after that writes
# NOTHING, forever. So coverage is computed first, and a quiet day with nothing
# to show for the watching SPEAKS.


async def test_a_quiet_day_on_which_nothing_was_watched_still_speaks(pool, only, mount_peers):
    """Nothing owed and nothing watched are the same silence from outside, and
    they are opposite facts. He hears the short code-composed line, and no
    model is asked for it — there is nothing to write about, and the whole
    point of the sentence is that a model had no hand in it."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("work_thing", [_finding("timer_failing:1", failures=4)]))
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)
    mount_peers(gateway=FakeGateway(deltas=("One thing is still standing.",)))
    await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))
    assert await notices.deliverable(pool) == [], "he was told, so nothing is owed"

    gateway = FakeGateway(deltas=("must never be asked",))
    mount_peers(gateway=gateway)
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(hours=25))

    latest = (await _messages(pool, his_chat["id"]))[-1]
    assert latest["content"].startswith(beats.DIGEST_UNWATCHED)
    coverage = _line(latest["content"], beats.COVERAGE_PREFIX)
    assert "has not run at all since the last digest that reached you" in coverage
    assert beats.NOT_AN_ALL_CLEAR in coverage
    assert gateway.seen == [], "composed in code: nothing was asked of a model"
    assert firing["status"] == scheduler.FIRING_OK
    assert firing["delivery"]["digest"]["delivered"] is True
    assert firing["delivery"]["digest"]["reason"] == beats.DIGEST_UNWATCHED_NOTE
    assert firing["delivery"]["digest"]["coverage"]["passes"] == 0


async def test_a_paused_watch_beat_says_so_and_says_why_off_its_own_row(pool, only, mount_peers):
    """The cause is already in the row — `paused_at` and `paused_reason` — and
    the loudest sentence in the message is the wrong place to state a symptom
    and leave the reason unread. A paused beat will not run again by itself, so
    it speaks even on a day whose span had a pass in it."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("work_thing", [_finding("timer_failing:1", failures=4)]))
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)
    mount_peers(gateway=FakeGateway(deltas=("One thing is still standing.",)))
    await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))
    await _run_beat(pool, beats.WATCH, now=LATER + timedelta(hours=1))
    why = "5 consecutive failures: the checks could not reach postgres"
    await _pause_the_watch_beat(pool, why)

    gateway = FakeGateway(deltas=("must never be asked",))
    mount_peers(gateway=gateway)
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(hours=25))

    latest = (await _messages(pool, his_chat["id"]))[-1]
    coverage = _line(latest["content"], beats.COVERAGE_PREFIX)
    assert "PAUSED" in coverage and why in coverage
    assert gateway.seen == []
    record = firing["delivery"]["digest"]["coverage"]
    assert record["paused_reason"] == why and record["paused_at"] is not None
    assert record["passes"] == 1, "it passed before it was paused — and it will not again"


async def test_a_quiet_day_that_was_actually_watched_is_still_silent(pool, only, mount_peers):
    """The other half, unchanged: a digest that spoke every day about nothing
    is the noise this slice exists to avoid. Passes were made and nothing is
    owed, so he hears nothing at all — and the coverage the quiet day was
    judged on is on the firing, where it can be read back."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("work_thing", [_finding("timer_failing:1", failures=4)]))
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)
    mount_peers(gateway=FakeGateway(deltas=("One thing is still standing.",)))
    await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))
    await _run_beat(pool, beats.WATCH, now=LATER + timedelta(hours=1))

    gateway = FakeGateway(deltas=("must never be asked",))
    mount_peers(gateway=gateway)
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(hours=25))

    assert len(await _messages(pool, his_chat["id"])) == 1, "he hears nothing on a watched day"
    assert gateway.seen == []
    standing, _more, _note = await beats._standing(pool)
    assert [row["title"] for row in standing] == ["timer_failing:1 is true"], (
        "something IS standing — the tail rides a message and can never cause one"
    )
    assert firing["delivery"]["digest"]["reason"] == beats.DIGEST_NOTHING_NOTE
    assert firing["delivery"]["digest"]["coverage"]["passes"] == 1


# -- the tail: what is still standing ---------------------------------------------


async def _standing_then_something_new(pool, only, mount_peers):
    """Get one notice DELIVERED and still true, then raise a second one — the
    shape every standing test below needs, made the way production makes it."""
    standing = _finding("timer_paused:9", reason="an agent was deleted")
    fresh = _finding("timer_failing:1", failures=4)
    only(_check("work_thing", [standing]))
    await beats.ensure_beats(pool)
    mount_peers(gateway=FakeGateway(deltas=("The nightly backup timer is paused.",)))
    await _run_beat(pool, beats.WATCH, now=LATER)
    await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))
    only(_check("work_thing", [standing, fresh]))
    await _run_beat(pool, beats.WATCH, now=LATER + timedelta(hours=1))


async def test_a_still_true_notice_he_was_told_about_is_named_again_but_never_explained_again(
    pool, only, mount_peers
):
    """The second half of the same night. The paused-timer notice had been seen
    eight times and was still true, and because it was delivered in the first
    digest, deliverable() would never hand it back — so every digest after that
    went silent about it while the Inbox still showed it. It is named in one
    code-composed line with its sighting count, and that is all."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    await _standing_then_something_new(pool, only, mount_peers)

    gateway = FakeGateway(deltas=("A timer has failed four nights running.",))
    mount_peers(gateway=gateway)
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(hours=25))

    latest = (await _messages(pool, his_chat["id"]))[-1]
    tail = _line(latest["content"], beats.STANDING_PREFIX)
    assert tail is not None
    assert "timer_paused:9 is true (seen 2 times)" in tail
    assert beats.STANDING_WHY in tail
    assert "timer_failing:1" not in tail, "what the digest is reporting is not also standing"
    assert firing["delivery"]["digest"]["standing"] == 1

    # NOT re-explained: the model is never told about it a second time, so it
    # cannot write about it and nothing in the message but the tail names it.
    brief = _brief(gateway)
    assert "timer_paused:9" not in brief
    assert "timer_failing:1 is true" in brief


async def test_a_live_notice_whose_delivery_failed_and_was_then_seen_is_still_named(
    pool, only, mount_peers, monkeypatch
):
    """The review's second MAJOR, 2026-09-09. Naming `delivered` and `seen`
    hardcoded two of the five states, and a live notice that FAILED delivery
    and which he then opened in the Inbox fell between the two halves of the
    message: deliverable() drops it the moment `seen_at` is set, and a
    state-named tail never picked it up — so it was never mentioned again while
    it was still true.

    The predicate is DERIVED now: live, not muted, and not what deliverable()
    would return. Disjoint by construction, and this row lands in the half that
    still names it."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(
        _check("work_thing", [_finding("timer_paused:9", reason="an agent was deleted")]),
        _check("money_thing", [_finding("agent_over_cap:coder", spent_usd=41)]),
    )
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)

    real = chat._persist_assistant
    broken = {"disk": True}

    async def refuse(pool_, conversation_id, text, turn_id=None):
        if broken["disk"] and conversation_id == his_chat["id"]:
            raise RuntimeError("the disk is full")
        return await real(pool_, conversation_id, text, turn_id)

    monkeypatch.setattr(chat, "_persist_assistant", refuse)
    mount_peers(gateway=FakeGateway(deltas=("Two things came up today.",)))
    await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))
    assert await _messages(pool, his_chat["id"]) == [], "nobody was told"

    # He opens ONE of them in the Inbox. It stays `failed` — the only record
    # that nobody was told — and stops being deliverable, because he read it.
    row = await pool.fetchrow("SELECT id FROM notices WHERE finding_key = 'timer_paused:9'")
    await notices.mark_seen(pool, row["id"])
    assert [n.finding_key for n in await notices.deliverable(pool)] == ["agent_over_cap:coder"]

    broken["disk"] = False
    mount_peers(gateway=FakeGateway(deltas=("The coder agent is over its cap.",)))
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(hours=25))

    latest = (await _messages(pool, his_chat["id"]))[-1]
    tail = _line(latest["content"], beats.STANDING_PREFIX)
    assert tail is not None and "timer_paused:9 is true" in tail
    assert firing["delivery"]["digest"]["standing"] == 1
    state = await pool.fetchval("SELECT state FROM notices WHERE id = $1", row["id"])
    assert state == notices.FAILED, "and its state is untouched by being named"


async def test_a_still_standing_notice_is_never_marked_delivered_a_second_time(
    pool, only, mount_peers
):
    """Naming it is not delivering it. The row keeps the state and the receipt
    it already has — a second `delivered_at` would say a channel took it
    tonight, which nothing did."""
    owner = await _owner(pool)
    await conversations.active_conversation(pool, owner)
    await _standing_then_something_new(pool, only, mount_peers)
    query = "SELECT state, delivered_at, seen_at, repeats FROM notices WHERE finding_key = $1"
    before = await pool.fetchrow(query, "timer_paused:9")
    assert before["state"] == notices.DELIVERED

    mount_peers(gateway=FakeGateway(deltas=("A timer has failed four nights running.",)))
    await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(hours=25))

    after = await pool.fetchrow(query, "timer_paused:9")
    assert after["state"] == notices.DELIVERED
    assert after["delivered_at"] == before["delivered_at"], "it was named, not delivered again"
    assert after["seen_at"] is None
    assert len(await notices.deliverable(pool)) == 0, "and it is still not owed to him"


async def test_a_muted_notice_is_never_named_in_the_tail(pool, only, mount_peers):
    """A mute is his own noise preference, and a tail that re-listed muted
    facts every morning would be the v3 re-armed nag with a new name."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    await _standing_then_something_new(pool, only, mount_peers)
    await pool.execute(
        "UPDATE notices SET state = $1, muted_at = now() WHERE finding_key = 'timer_paused:9'",
        notices.MUTED,
    )

    mount_peers(gateway=FakeGateway(deltas=("A timer has failed four nights running.",)))
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(hours=25))

    latest = (await _messages(pool, his_chat["id"]))[-1]
    assert _line(latest["content"], beats.STANDING_PREFIX) is None
    assert "standing" not in firing["delivery"]["digest"]


async def test_the_standing_tail_counts_every_row_it_left_out(pool, only):
    """The review's overflow defect, 2026-09-09: the count was LIMIT+1 minus
    the page, which saturates at 1 — forty standing notices read as "and 1
    more". The overflow is counted separately from the page it did not fit."""
    await _owner(pool)
    only(_check("work_thing", []))
    over = beats.DIGEST_STANDING_LIMIT + 3
    for n in range(over):
        notice, _new = await notices.record(
            pool,
            _finding(f"timer_paused:{n}", reason="an agent was deleted"),
            check_name="work_thing",
            turn_id=None,
            firing_id=None,
        )
        await notices.mark_delivered(pool, notice.id, delivery={"chat": {"ok": True}})

    rows, more, note = await beats._standing(pool)
    assert note is None
    assert len(rows) == beats.DIGEST_STANDING_LIMIT
    assert more == 3, "counted, never inferred from a page one row longer than the limit"
    assert f"and {more} more" in beats.standing_line(rows, more, note)


async def test_the_cleared_tail_counts_every_row_it_left_out(pool, only):
    """The same copied idiom, in the other half of the brief."""
    await _owner(pool)
    only(_check("work_thing", []))
    over = beats.DIGEST_CLEARED_LIMIT + 3
    for n in range(over):
        await notices.record(
            pool,
            _finding(f"timer_paused:{n}", reason="an agent was deleted"),
            check_name="work_thing",
            turn_id=None,
            firing_id=None,
        )
    assert len(await notices.reconcile(pool, check_name="work_thing", live_fingerprints=set())) == (
        over
    )

    cleared, more = await beats._cleared_since(pool, None)
    assert len(cleared) == beats.DIGEST_CLEARED_LIMIT
    assert more == 3


async def test_nothing_standing_leaves_no_tail_at_all(pool, only, mount_peers):
    """The first digest of a fresh install: one thing to report and nothing
    standing behind it. Coverage, and no tail."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("work_thing", [_finding("timer_failing:1", failures=4)]))
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)
    mount_peers(gateway=FakeGateway(deltas=("One thing is still standing.",)))
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    (message,) = await _messages(pool, his_chat["id"])
    assert len(_facts_lines(message["content"])) == 1, "the coverage line and nothing else"
    assert _line(message["content"], beats.STANDING_PREFIX) is None
    assert "standing" not in firing["delivery"]["digest"]


# -- the two lines on their own ---------------------------------------------------


def test_a_beat_with_no_firing_on_record_is_said_rather_than_left_blank():
    line = beats.Coverage(
        firings=0, passes=0, window_start=None, from_a_digest=False, longest_gap=None
    ).line("UTC")
    assert line == beats.COVERAGE_NOTHING


def test_the_coverage_line_says_when_its_own_schedule_could_not_be_read():
    """A stored zone that stops resolving must not silently drop the yardstick."""
    line = beats.Coverage(
        firings=4,
        passes=4,
        window_start=datetime(2026, 9, 9, 7, 30, tzinfo=UTC),
        from_a_digest=True,
        longest_gap=timedelta(hours=9, minutes=18),
        schedule_note="SpecError: 'Mars/Olympus_Mons' is not an IANA timezone",
    ).line("UTC")
    assert "fired 4 times" in line and "9h 18m" in line
    assert "its own schedule could not be read" in line and "Mars/Olympus_Mons" in line


def test_a_pause_with_no_reason_on_the_row_says_that_rather_than_nothing():
    """`paused_reason` is nullable, and "it is paused" with no cause is the
    shape of sentence this line was written to replace."""
    line = beats.Coverage(
        firings=0,
        passes=0,
        window_start=None,
        from_a_digest=False,
        longest_gap=None,
        paused_at=datetime(2026, 9, 9, 2, 0, tzinfo=UTC),
    ).line("UTC")
    assert "PAUSED" in line and "no reason was recorded on the row" in line


def test_coverage_that_cannot_be_shown_is_what_makes_a_quiet_day_speak():
    """One predicate, three ways in — and its complement is the ordinary quiet
    day. Stated here so the condition that breaks the silence is readable
    without a database."""
    watched = beats.Coverage(
        firings=24,
        passes=24,
        window_start=datetime(2026, 9, 9, 7, 30, tzinfo=UTC),
        from_a_digest=True,
        longest_gap=timedelta(hours=1),
    )
    assert watched.unproven is False
    assert replace(watched, passes=0).unproven is True
    assert replace(watched, paused_at=datetime(2026, 9, 9, 8, 0, tzinfo=UTC)).unproven is True
    assert replace(watched, unreadable="the table is gone").unproven is True


def test_the_standing_tail_counts_what_it_could_not_fit_and_never_drops_it():
    rows = [{"title": f"thing {n}", "check_name": "work_thing", "repeats": n} for n in (1, 2)]
    line = beats.standing_line(rows, 3, None)
    assert line.startswith(beats.STANDING_PREFIX)
    assert "thing 1 (seen 1 time)" in line and "thing 2 (seen 2 times)" in line
    assert "and 3 more" in line


def test_the_standing_tail_says_it_could_not_be_read_rather_than_nothing():
    line = beats.standing_line([], 0, "RuntimeError: the table is gone")
    assert line.startswith(beats.STANDING_UNREADABLE) and "the table is gone" in line


def test_nothing_standing_is_no_tail_at_all():
    assert beats.standing_line([], 0, None) is None


def test_a_span_of_time_reads_the_same_wherever_it_is_shown():
    assert beats.duration_words(timedelta(seconds=9)) == "9s"
    assert beats.duration_words(timedelta(minutes=45)) == "45m"
    assert beats.duration_words(timedelta(hours=1)) == "1h 00m"
    assert beats.duration_words(timedelta(hours=9, minutes=18)) == "9h 18m"
    assert beats.duration_words(timedelta(days=2, hours=3)) == "2d 3h"


# -- the switch (S11-6) -----------------------------------------------------------
#
# The engine ships OFF (`proactive.enabled`, default false — SETTING_DEFS says
# so and tests/test_settings.py pins the default). A beat that fires while it is
# off does NOTHING and says so on its firing: a stated fact about configuration,
# never a decision about what she is allowed to do (owner ruling 2026-09-03).
# The autouse fixture at the top of this file turns it on for every other test,
# so these three are the only place it is off — and they say so out loud.


async def _switch_off(pool) -> None:
    await _setting(pool, beats.ENABLED_KEY, False)


async def test_a_beat_that_fires_while_the_engine_is_off_does_nothing_and_says_so(pool, only):
    """Nothing at all: no check run, no notice written, not even the beat's own
    line in its own conversation. The firing is OK because the row did exactly
    what the configuration says."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("work_thing", [_finding("timer_failing:1", failures=4)]))
    await beats.ensure_beats(pool)
    beat_conversation = await beats.beat_conversation(pool)
    await _switch_off(pool)

    firing = await _run_beat(pool, beats.WATCH, now=LATER)

    assert firing["status"] == scheduler.FIRING_OK
    assert firing["reason"] == beats.PROACTIVE_OFF
    assert firing["delivery"] == {"beat": beats.WATCH, "proactive": {"enabled": False}}
    assert await _notices(pool) == [], "no check ran, so there was nothing to write down"
    assert await _messages(pool, his_chat["id"]) == []
    assert await _messages(pool, beat_conversation) == [], "not even its own line"
    # The turn still exists and closed cleanly — the trace says a beat fired
    # and why it did nothing, rather than leaving a hole in Activity.
    assert firing["turn_id"] is not None
    assert await pool.fetchval(TURN_STATUS, firing["turn_id"]) == "ok"
    (span,) = await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE turn_id = $1 AND kind = 'beat'",
        firing["turn_id"],
    )
    assert span["name"] == beats.WATCH
    assert span["meta"]["reason"] == beats.PROACTIVE_OFF


async def test_the_switch_gates_the_digest_and_an_off_beat_never_walks_to_the_pause(
    pool, only, mount_peers
):
    """Both beats, one line of code. And an off firing is OK, which is what
    keeps `consecutive_failures` at zero: five refused firings would pause the
    beats, and turning the setting on later would then do nothing at all."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("work_thing", [_finding("timer_failing:1", failures=4)]))
    await beats.ensure_beats(pool)
    await _run_beat(pool, beats.WATCH, now=LATER)
    assert len(await _notices(pool)) == 1, "something is owed him before the switch goes off"

    await _switch_off(pool)
    gateway = FakeGateway(deltas=("this must never be composed",))
    mount_peers(gateway=gateway)
    for hour in range(1, 7):
        firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(hours=hour))
        assert (firing["status"], firing["reason"]) == (
            scheduler.FIRING_OK,
            beats.PROACTIVE_OFF,
        ), hour

    assert gateway.seen == [], "no model is asked for words nobody will send"
    assert await _messages(pool, his_chat["id"]) == []
    assert [row["state"] for row in await _notices(pool)] == [notices.RAISED], "still owed"
    digest = (await _beat_rows(pool))[beats.DIGEST]
    assert digest["consecutive_failures"] == 0


async def test_a_stored_switch_that_is_not_a_boolean_is_off_and_says_what_it_is(pool, only):
    """Only JSON true is on. A string "true" written straight into the table is
    off — and the firing SAYS that is what it found, because a value that reads
    like yes and behaves like no is exactly what has to appear on the record."""
    await _owner(pool)
    only(_check("work_thing", [_finding("timer_failing:1", failures=4)]))
    await beats.ensure_beats(pool)
    await _setting(pool, beats.ENABLED_KEY, "true")

    firing = await _run_beat(pool, beats.WATCH, now=LATER)

    assert firing["status"] == scheduler.FIRING_OK
    assert firing["reason"].startswith(beats.PROACTIVE_OFF)
    assert "'true'" in firing["reason"] and "neither true nor false" in firing["reason"]
    assert await _notices(pool) == []


async def test_the_digest_carries_at_most_the_days_ceiling_and_holds_the_rest(
    pool, only, mount_peers
):
    """`proactive.max_notices_per_day` is the backstop under "one message a
    day": a night when fifty things break still produces a message rather than
    a log. What does not fit is HELD, not dropped — those rows are never marked
    delivered, so they are still owed — and the count is on the firing, because
    suppression here is countable or it is silence."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(
        _check("work_thing", [_finding("timer_failing:1", failures=4)]),
        _check("money_thing", [_finding("agent_over_cap:coder", spent_usd=41)]),
    )
    await beats.ensure_beats(pool)
    await _setting(pool, beats.MAX_NOTICES_KEY, 1)
    await _run_beat(pool, beats.WATCH, now=LATER)
    assert len(await _notices(pool)) == 2

    gateway = FakeGateway(deltas=("One thing is still standing.",))
    mount_peers(gateway=gateway)
    firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    assert firing["status"] == scheduler.FIRING_OK
    assert firing["delivery"]["digest"]["notices"] == 1
    assert firing["delivery"]["digest"]["held_back"] == 1
    assert "STANDING (1)" in _brief(gateway), "the model is told about one, not two"
    assert [_prose(row["content"]) for row in await _messages(pool, his_chat["id"])] == [
        "One thing is still standing."
    ]
    assert sorted(row["state"] for row in await _notices(pool)) == [
        notices.DELIVERED,
        notices.RAISED,
    ]
    assert len(await notices.deliverable(pool)) == 1, "what did not fit is owed tomorrow"


async def test_a_ceiling_that_could_carry_nothing_is_said_out_loud_and_not_used(
    pool, only, mount_peers, caplog
):
    """The settings def refuses 0 at the write; a 0 that reached the table
    another way is refused here, in the log, and the def's own default stands.
    A cap read literally would compose a message about nothing while the
    notices piled up — a silence that looks exactly like a quiet day."""
    owner = await _owner(pool)
    his_chat = await conversations.active_conversation(pool, owner)
    only(_check("work_thing", [_finding("timer_failing:1", failures=4)]))
    await beats.ensure_beats(pool)
    await _setting(pool, beats.MAX_NOTICES_KEY, 0)
    await _run_beat(pool, beats.WATCH, now=LATER)

    mount_peers(gateway=FakeGateway(deltas=("One thing is still standing.",)))
    with caplog.at_level(logging.WARNING, logger="core"):
        firing = await _run_beat(pool, beats.DIGEST, now=LATER + timedelta(minutes=5))

    assert firing["delivery"]["digest"]["notices"] == 1
    assert "held_back" not in firing["delivery"]["digest"]
    assert len(await _messages(pool, his_chat["id"])) == 1
    assert any(beats.MAX_NOTICES_KEY in r.getMessage() for r in caplog.records)
