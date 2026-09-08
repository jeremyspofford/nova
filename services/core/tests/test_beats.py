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

import logging
from datetime import UTC, datetime, timedelta

import pytest

from app import beats, chat, checks, conversations, notices, scheduler, settings_store, timers
from app.checks import Check, CheckRun, Finding
from app.identity import Person
from app.main import app
from app.timers import TimerRefused
from tests.conftest import requires_db

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
    assert beats.DIGEST_UNBUILT in landed
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


def test_the_digest_setting_is_read_through_settings_store_the_moment_it_exists():
    """Read defensively today, normally tomorrow: the def has not landed, and
    the same key is what S11-6 will register."""
    assert beats.DIGEST_AT_KEY not in settings_store.DEFS_BY_KEY
    assert beats.DIGEST_AT_KEY.startswith("proactive.")


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
