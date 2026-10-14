"""S37c T6: her own monitoring is a sender (spec §2.6, §9 Q2).

A NEW notice of a monitored family (the urgent stack checks, failing timers,
degraded inference — read from the check registry, never a list kept here)
files a `monitor` event with the notice's facts as its payload, and she looks
into it in an event turn. Two controls, both code:

* the loop guard — a notice about an event turn (the event_outcomes family,
  or any notice whose turn or facts name an event turn) never becomes an
  event, so her own investigation can never feed itself;
* one per fingerprint — a notice already the subject of an open or recent
  monitor event does not start another."""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import replace
from datetime import timedelta

import pytest

from app import beats, chat, checks, events, notices, traces
from app.checks import Check, CheckRun, Finding, inference, stack, work
from app.checks import events as event_checks
from app.identity import Person
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeMemory, Refusal, ScriptedGateway

MODEL = "qwen3:8b"


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


@pytest.fixture
def shut():
    """Latch shutdown so a filed event stays queued for the test to read."""
    chat.begin_shutdown()
    try:
        yield
    finally:
        chat.accept_queued_turns_again()


async def _owner(pool) -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id"
    )
    return Person(id=pid, name="jeremy", role="owner")


async def _set_model(pool, model: str = MODEL) -> None:
    await pool.execute("INSERT INTO settings (key, value) VALUES ('chat.model', $1::jsonb)", model)


async def _beat_turn(pool) -> traces.Turn:
    return await traces.open_turn(pool, kind="beat")


def _stack_finding(state: str = "unreachable") -> Finding:
    return Finding(
        key="peer_down:memory",
        title="the memory service is not answering",
        facts={"peer": "memory", "state": state},
        urgent=True,
    )


def _timer_finding(timer_id: str | None = None, kind: str = "github_ci") -> Finding:
    return Finding(
        key=f"timer_failing:{timer_id or uuid.uuid4()}",
        title="a timer has failed 3 times in a row",
        facts={
            "timer_id": timer_id or str(uuid.uuid4()),
            "kind": kind,
            "consecutive_failures": 3,
            "pause_ceiling": 5,
        },
    )


def _degraded_finding() -> Finding:
    return Finding(
        key="inference_degraded:qwen3:27b",
        title="qwen3:27b is generating at 0.3 tok/s; its usual here is 30",
        facts={"model": "qwen3:27b", "served_on": "local", "slowdown_bucket": 100},
    )


async def _record(pool, check_name: str, *findings: Finding, turn=None, person=None):
    turn = turn or await _beat_turn(pool)
    run = CheckRun(check=check_name, ran=True, reason=None, findings=tuple(findings))
    result = await beats._record_check(app, pool, turn, None, run, person)
    return turn, result


async def _monitor_events(pool) -> list:
    return await pool.fetch(
        "SELECT * FROM events WHERE sender = 'monitor' ORDER BY received_at, id"
    )


async def _notice(pool, check_name: str):
    row = await pool.fetchrow(
        "SELECT id FROM notices WHERE check_name = $1 ORDER BY first_seen_at DESC LIMIT 1",
        check_name,
    )
    return await notices.get(pool, row["id"])


# -- C1: which notices qualify, derived from the registry ------------------------


def test_the_monitored_set_is_derived_from_the_registry():
    """The urgent stack checks by derivation, plus the two families that say
    so on their own Check — failing timers and degraded inference. Read off the
    registry and the families' own NAMES, never retyped beside them."""
    monitored = set(checks.monitored_names())
    assert set(checks.urgent_names()) <= monitored
    assert set(stack.NAMES) <= monitored
    assert monitored == set(checks.urgent_names()) | {"work_failing_timers", "inference_degraded"}
    assert "work_failing_timers" in work.NAMES and "inference_degraded" in inference.NAMES
    assert checks.REGISTRY["work_failing_timers"].monitor is True
    assert checks.REGISTRY["inference_degraded"].monitor is True
    assert event_checks.OUTCOMES not in monitored
    assert checks.REGISTRY[event_checks.OUTCOMES].monitor is False


def test_a_family_flagged_monitor_joins_the_set_and_an_unflagged_one_does_not(monkeypatch):
    async def run(app_, pool_):
        return []

    flagged = Check(name="fake_flagged", describe="x", urgent=False, run=run, monitor=True)
    plain = Check(name="fake_plain", describe="x", urgent=False, run=run)
    urgent = Check(name="fake_urgent", describe="x", urgent=True, run=run)
    monkeypatch.setattr(checks, "REGISTRY", {c.name: c for c in (flagged, plain, urgent)})
    assert checks.monitored_names() == ["fake_flagged", "fake_urgent"]


# -- C2: a new notice of a monitored family files one monitor event -------------


@requires_db
async def test_a_new_urgent_stack_notice_files_one_monitor_event(pool, shut):
    await events.ensure_builtins(pool)
    turn, _ = await _record(pool, "stack_memory", _stack_finding())
    notice = await _notice(pool, "stack_memory")

    (row,) = await _monitor_events(pool)
    assert row["state"] == "queued"
    assert row["fingerprint"] == notice.fingerprint
    assert row["urgent"] is True
    assert row["content_type"] == "application/json"
    payload = json.loads(row["payload"])
    assert payload == {
        "check": "stack_memory",
        "notice": str(notice.id),
        "title": notice.title,
        "facts": notice.facts,
        "urgent": True,
    }
    # On the beat turn's record: which notice, which event.
    await traces.close_turn(pool, turn, "ok")
    spans = await pool.fetch(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND kind = 'event'", turn.id
    )
    (span,) = spans
    meta = span["meta"] if isinstance(span["meta"], dict) else json.loads(span["meta"])
    assert meta["notice"] == str(notice.id)
    assert meta["event_id"] == str(row["id"])


@requires_db
@pytest.mark.parametrize(
    ("check_name", "finding"),
    [("work_failing_timers", _timer_finding()), ("inference_degraded", _degraded_finding())],
    ids=["failing_timers", "degraded_inference"],
)
async def test_failing_timers_and_degraded_inference_file_a_monitor_event(
    pool, shut, check_name, finding
):
    await events.ensure_builtins(pool)
    await _record(pool, check_name, finding)
    notice = await _notice(pool, check_name)
    (row,) = await _monitor_events(pool)
    assert row["urgent"] is False
    assert row["fingerprint"] == notice.fingerprint
    assert json.loads(row["payload"])["facts"] == notice.facts


@requires_db
async def test_a_family_that_is_not_monitored_files_nothing(pool, shut):
    await events.ensure_builtins(pool)
    await _record(
        pool,
        "work_paused_timers",
        Finding(key="timer_paused:x", title="a timer is paused", facts={"timer_id": "x"}),
    )
    assert await _notice(pool, "work_paused_timers")
    assert await _monitor_events(pool) == []


@requires_db
async def test_a_fold_files_nothing_more(pool, shut):
    await events.ensure_builtins(pool)
    await _record(pool, "stack_memory", _stack_finding())
    # The same facts an hour later fold onto the live notice: not new, no event.
    await pool.execute("UPDATE events SET state = 'done' WHERE sender = 'monitor'")
    await pool.execute(
        "UPDATE events SET received_at = now() - interval '30 days' WHERE sender = 'monitor'"
    )
    _turn, (new, folded, _cleared, _pushes) = await _record(pool, "stack_memory", _stack_finding())
    assert (new, folded) == (0, 1)
    assert len(await _monitor_events(pool)) == 1


@requires_db
async def test_a_monitor_sender_that_is_off_files_nothing(pool, shut):
    await events.ensure_builtins(pool)
    await pool.execute("UPDATE event_senders SET enabled = false WHERE name = 'monitor'")
    await _record(pool, "stack_memory", _stack_finding())
    assert await _notice(pool, "stack_memory")
    assert await _monitor_events(pool) == []


@requires_db
async def test_with_no_monitor_sender_nothing_is_filed(pool, shut):
    await _record(pool, "stack_memory", _stack_finding())
    assert await _notice(pool, "stack_memory")
    assert await _monitor_events(pool) == []


@requires_db
async def test_a_notice_he_muted_files_nothing(pool, shut):
    await events.ensure_builtins(pool)
    await pool.execute(
        "INSERT INTO notice_mutes (check_name, finding_key) VALUES ('stack_memory', $1)",
        _stack_finding().key,
    )
    await _record(pool, "stack_memory", _stack_finding())
    assert (await _notice(pool, "stack_memory")).state == notices.MUTED
    assert await _monitor_events(pool) == []


# -- C3: the loop guard -----------------------------------------------------------


async def _event_turn(pool) -> traces.Turn:
    return await traces.open_turn(pool, kind=events.EVENT_KIND, role="event_monitor")


@requires_db
async def test_an_event_outcomes_notice_never_becomes_an_event_even_if_flagged(
    pool, shut, monkeypatch
):
    """The guard is its own line, not a side effect of the flag: with the
    outcomes family flagged monitor, its notice still files nothing."""
    await events.ensure_builtins(pool)
    flagged = replace(checks.REGISTRY[event_checks.OUTCOMES], monitor=True)
    monkeypatch.setitem(checks.REGISTRY, event_checks.OUTCOMES, flagged)
    assert event_checks.OUTCOMES in checks.monitored_names()
    turn = await _event_turn(pool)
    finding = Finding(
        key=f"event_turn:{turn.id}",
        title="An event from monitor failed: the gateway refused",
        facts={
            "sender": "monitor",
            "events": [str(uuid.uuid4())],
            "turn": str(turn.id),
            "outcome": "failed",
        },
    )
    notice, is_new = await notices.record(
        pool, finding, check_name=event_checks.OUTCOMES, turn_id=turn.id, firing_id=None
    )
    assert is_new
    filed = await events.file_monitor(app, pool, notice)
    assert filed.event_id is None and "event turn" in filed.why
    assert await _monitor_events(pool) == []


@requires_db
async def test_an_outcome_with_no_turn_is_still_never_an_event(pool, shut, monkeypatch):
    """An event that failed before any turn opened (no chat model, no owner)
    files an outcome naming no turn at all. It is still about an event, so the
    family itself is the guard, not only the turn it names."""
    await events.ensure_builtins(pool)
    flagged = replace(checks.REGISTRY[event_checks.OUTCOMES], monitor=True)
    monkeypatch.setitem(checks.REGISTRY, event_checks.OUTCOMES, flagged)
    event_id = uuid.uuid4()
    finding = Finding(
        key=f"event:{event_id}",
        title="An event from test failed: no chat model is set",
        facts={"sender": "test", "events": [str(event_id)], "turn": None, "outcome": "failed"},
    )
    await _record(pool, event_checks.OUTCOMES, finding)
    assert await _notice(pool, event_checks.OUTCOMES)
    assert await _monitor_events(pool) == []


@requires_db
@pytest.mark.parametrize("where", ["top", "nested", "notice_turn"])
async def test_a_notice_about_an_event_turn_never_becomes_an_event(pool, shut, where):
    """Its failure, its spend: any notice whose facts (at any depth) or whose
    own turn name an event turn files nothing — a monitored family included."""
    await events.ensure_builtins(pool)
    turn = await _event_turn(pool)
    facts: dict = {"timer_id": "t1", "kind": "x", "consecutive_failures": 3}
    if where == "top":
        facts["turn_id"] = str(turn.id)
    elif where == "nested":
        facts["seen"] = [{"spans": {"turn": str(turn.id)}}]
    finding = Finding(key="timer_failing:t1", title="a timer failed", facts=facts)
    await _record(
        pool, "work_failing_timers", finding, turn=turn if where == "notice_turn" else None
    )
    assert await _notice(pool, "work_failing_timers")
    assert await _monitor_events(pool) == []


@requires_db
async def test_a_notice_naming_a_chat_turn_still_files(pool, shut):
    """The guard is about EVENT turns: a uuid of an ordinary turn, or one that
    names no turn at all, does not trip it."""
    await events.ensure_builtins(pool)
    chat_turn = await traces.open_turn(pool, kind="chat")
    facts = {"timer_id": str(uuid.uuid4()), "turn_id": str(chat_turn.id), "kind": "x"}
    await _record(pool, "work_failing_timers", Finding(key="t:2", title="t", facts=facts))
    assert len(await _monitor_events(pool)) == 1


@requires_db
async def test_a_failing_github_ci_job_is_not_about_an_event_turn_and_files(pool, shut):
    """A 5-min job that keeps failing raises work_failing_timers. That is about
    a timer, not an event turn, so she is told to look (Notes: name it here)."""
    await events.ensure_builtins(pool)
    timer_id = uuid.uuid4()
    await _record(pool, "work_failing_timers", _timer_finding(str(timer_id), kind="job"))
    assert len(await _monitor_events(pool)) == 1


# -- C4: one per fingerprint ------------------------------------------------------


async def _clear_all(pool) -> None:
    await pool.execute("UPDATE notices SET cleared_at = now() WHERE cleared_at IS NULL")


@requires_db
@pytest.mark.parametrize("state", ["queued", "running"])
async def test_an_open_monitor_event_holds_the_fingerprint(pool, shut, state):
    """The condition clears and comes back (a NEW notice, same fingerprint)
    while the first event is still open: no second event."""
    await events.ensure_builtins(pool)
    await _record(pool, "stack_memory", _stack_finding())
    await pool.execute(
        "UPDATE events SET state = $1, received_at = now() - interval '30 days' "
        "WHERE sender = 'monitor'",
        state,
    )
    await _clear_all(pool)
    _t, (new, *_rest) = await _record(pool, "stack_memory", _stack_finding())
    assert new == 1
    assert len(await _monitor_events(pool)) == 1


@requires_db
async def test_a_recent_monitor_event_holds_the_fingerprint(pool, shut):
    await events.ensure_builtins(pool)
    await _record(pool, "stack_memory", _stack_finding())
    within = events.MONITOR_REFILE_WINDOW - timedelta(minutes=5)
    await pool.execute(
        "UPDATE events SET state = 'done', received_at = now() - $1::interval "
        "WHERE sender = 'monitor'",
        within,
    )
    await _clear_all(pool)
    await _record(pool, "stack_memory", _stack_finding())
    assert len(await _monitor_events(pool)) == 1


@requires_db
async def test_past_the_window_the_same_fingerprint_files_again(pool, shut):
    await events.ensure_builtins(pool)
    await _record(pool, "stack_memory", _stack_finding())
    past = events.MONITOR_REFILE_WINDOW + timedelta(minutes=5)
    await pool.execute(
        "UPDATE events SET state = 'done', received_at = now() - $1::interval "
        "WHERE sender = 'monitor'",
        past,
    )
    await _clear_all(pool)
    await _record(pool, "stack_memory", _stack_finding())
    rows = await _monitor_events(pool)
    assert len(rows) == 2
    assert rows[0]["fingerprint"] == rows[1]["fingerprint"]


@requires_db
async def test_a_different_fingerprint_is_not_held(pool, shut):
    await events.ensure_builtins(pool)
    await _record(pool, "stack_memory", _stack_finding("unreachable"))
    await _clear_all(pool)
    await _record(pool, "stack_memory", _stack_finding("http_503"))
    assert len(await _monitor_events(pool)) == 2


@requires_db
async def test_two_filings_at_once_file_one(pool, shut):
    await events.ensure_builtins(pool)
    notice, _ = await notices.record(
        pool, _stack_finding(), check_name="stack_memory", turn_id=None, firing_id=None
    )
    results = await asyncio.gather(*(events.file_monitor(app, pool, notice) for _ in range(6)))
    assert sum(1 for r in results if r.event_id is not None) == 1
    assert len(await _monitor_events(pool)) == 1


# -- C5: she looks at once; the notice names the turn; never breaks the beat ------


@requires_db
async def test_the_event_turn_runs_at_once_and_the_notice_names_it(pool, mount_peers):
    owner = await _owner(pool)
    await _set_model(pool)
    await events.ensure_builtins(pool)
    mount_peers(
        gateway=ScriptedGateway(rounds=((text("Memory was restarting; it answers now."),),)),
        memory=FakeMemory(),
    )
    await _record(pool, "stack_memory", _stack_finding(), person=owner)
    await chat.drain_background()

    (row,) = await _monitor_events(pool)
    assert row["state"] == "done" and row["turn_id"] is not None
    kind = await pool.fetchval("SELECT kind FROM turns WHERE id = $1", row["turn_id"])
    assert kind == events.EVENT_KIND
    notice = await _notice(pool, "stack_memory")
    assert notice.acted is True
    assert notice.acted_turn_id == row["turn_id"]
    assert "Memory was restarting; it answers now." in notice.acted_note
    # Her outcome notice exists and it did not, in turn, file an event.
    assert await _notice(pool, event_checks.OUTCOMES)
    assert len(await _monitor_events(pool)) == 1


@requires_db
async def test_a_failed_monitor_turn_marks_nothing_acted(pool, mount_peers):
    owner = await _owner(pool)
    await _set_model(pool)
    await events.ensure_builtins(pool)
    mount_peers(
        gateway=ScriptedGateway(rounds=(Refusal(503, {"error": {"message": "no backend"}}),)),
        memory=FakeMemory(),
    )
    await _record(pool, "stack_memory", _stack_finding(), person=owner)
    await chat.drain_background()
    (row,) = await _monitor_events(pool)
    assert row["state"] == "failed"
    notice = await _notice(pool, "stack_memory")
    assert notice.acted is False and notice.acted_turn_id is None
    # The failure's own notice is about an event turn: no second event.
    assert await _notice(pool, event_checks.OUTCOMES)
    assert len(await _monitor_events(pool)) == 1


@requires_db
async def test_a_filing_that_breaks_never_breaks_the_check(pool, shut, monkeypatch):
    await events.ensure_builtins(pool)

    async def broken(*args, **kwargs):
        raise RuntimeError("the events table is gone")

    monkeypatch.setattr(events, "_insert_monitor_event", broken)
    _turn, (new, folded, cleared, pushes) = await _record(pool, "stack_memory", _stack_finding())
    assert (new, folded) == (1, 0)
    assert await _notice(pool, "stack_memory")
    assert await _monitor_events(pool) == []
