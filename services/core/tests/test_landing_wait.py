"""S38c T6: landing_status(id, wait_s) — waiting for a verdict inside one turn
(docs/plans/rebuild/s38c/spec.md §5.7 item 3, §12 Q9).

On 2026-10-14 she polled landing_status while a landing ran; three identical
"running" readings tripped the repeated-call guard and the turn stopped at 24
rounds, so she never saw the red. A bounded wait re-reads the row every
POLL_S seconds for up to wait_s (at most 90), returns as soon as the verdict
or the stage changes, and at the deadline says how long it waited and how long
the landing has run — so each reading is new and the live-reading rule in
chat.RoundProgress counts it as progress.

The wait's sleep, monotonic clock and wall clock are faked (FakeClock), so no
test sleeps for real; the rows are real (scratch DB).

Criteria:
  C1 The schema offers an optional whole-number `wait_s`, 1..WAIT_MAX_S (90);
     "30" and 30.0 are 30; 0, 91, -1, 2.5, true, "abc" are refused before the
     executor (ok False, nothing read, nothing slept).
  C2 wait_s without an id is a stated refusal naming id — nothing is waited.
  C3 A landing not running when asked returns at once: no sleep, and the same
     text a read without wait_s gives.
  C4 The wait re-reads the row every POLL_S s (no sleep past the deadline) and
     returns at the first poll whose verdict left running ("The verdict came in
     after waiting N s.") or whose stage text changed ("The stage moved from X
     to Y after waiting N s."), followed by the full status of that reading; a
     changed reason alone does not end it; one landing fact is filed, from the
     last row read.
  C5 With no change by the deadline it returns after exactly wait_s seconds of
     sleeping: "Still running at stage X, waited N s, M min S s since it
     started." then the full status; the age is the wall clock minus the
     row's created_at.
  C6 The owner's stop ends the wait: with ctx.progress bound (a chat turn) each
     poll reports through it, and the TurnStopped it raises passes out of
     dispatch with no further sleep; with no progress bound,
     traces.stop_requested(turn) returns "Stopped waiting after N s: this turn
     is stopping." then the status, with no further sleep.
  C7 The guards: three deadline readings of one running landing at one stage,
     with identical arguments, through chat.RoundProgress return no stop
     (neither repeated_call nor no_new_results), for wait_s 90 and wait_s 1
     alike, and their texts are pairwise different; three reads WITHOUT wait_s
     still stop on repeated_call (the 10-14 failure is what wait_s fixes, not
     a change to the guard).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app import chat, landings, tools, traces
from app.tools import landing as landing_tools
from app.tools import schema
from app.tools.base import ToolContext, TurnStopped
from tests.conftest import requires_db
from tests.test_repo_land import BRANCH, ID, _ctx, _turn

pytestmark = requires_db

T0 = datetime(2026, 10, 14, 12, 0, 0, tzinfo=UTC)
# The wall clock when a call starts: the landing began 4 min 12 s earlier.
AGE_S = 252
STAGE = "running main's suites"


class FakeClock:
    """The wait's three seams. sleep advances both clocks by what was asked
    and then runs `on_sleep(n)` (n = sleeps so far), where a test changes
    the row the way the background landing would."""

    def __init__(self) -> None:
        self.mono = 1000.0
        self.wall = T0 + timedelta(seconds=AGE_S)
        self.sleeps: list[float] = []
        self.on_sleep = None

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.mono += seconds
        self.wall += timedelta(seconds=seconds)
        if self.on_sleep is not None:
            await self.on_sleep(len(self.sleeps))

    def monotonic(self) -> float:
        return self.mono

    def now(self) -> datetime:
        return self.wall


@pytest.fixture
def clock(monkeypatch):
    fake = FakeClock()
    monkeypatch.setattr(landing_tools, "_sleep", fake.sleep)
    monkeypatch.setattr(landing_tools, "_clock", fake.monotonic)
    monkeypatch.setattr(landing_tools, "_now", fake.now)
    return fake


@pytest.fixture
def registered(monkeypatch):
    monkeypatch.setitem(
        tools.REGISTRY, landing_tools.LANDING_STATUS, landing_tools.LANDING_STATUS_TOOL
    )


async def _running(pool, stage: str | None = STAGE) -> uuid.UUID:
    lid = await landings.insert(pool, change_id=ID, repo="nova", branch=BRANCH, turn_id=None)
    if stage is not None:
        await landings.update(pool, lid, stage=stage)
    await pool.execute("UPDATE landings SET created_at = $2 WHERE id = $1", lid, T0)
    return lid


async def _call(pool, args: dict, *, ctx: ToolContext | None = None, facts=None):
    if ctx is None:
        ctx = _ctx(await _turn(pool), facts)
    return await asyncio.wait_for(tools.dispatch(landing_tools.LANDING_STATUS, args, ctx), 10)


# -- C1: the schema ---------------------------------------------------------------


def test_c1_the_schema_offers_an_optional_bounded_whole_number_wait_s():
    params = landing_tools.LANDING_STATUS_TOOL.parameters
    assert set(params["properties"]) == {"id", "wait_s"}
    wait = params["properties"]["wait_s"]
    assert wait["type"] == "integer"
    assert wait["minimum"] == 1
    assert wait["maximum"] == landing_tools.WAIT_MAX_S == 90
    assert wait[schema.WHOLE_NUMBER] is True
    assert params.get("required", []) == []
    assert params["additionalProperties"] is False
    description = landing_tools.LANDING_STATUS_TOOL.description
    assert "wait_s" in description and "90" in description


@pytest.mark.parametrize("bad", [0, 91, -1, 2.5, True, "abc", "90.5", None])
async def test_c1_an_out_of_range_or_malformed_wait_s_is_refused(pool, registered, clock, bad):
    lid = await _running(pool)
    facts: list[dict] = []
    result, ok = await _call(pool, {"id": str(lid), "wait_s": bad}, facts=facts)
    assert ok is False, result
    assert "wait_s" in result
    assert clock.sleeps == []
    assert facts == []


@pytest.mark.parametrize("spelled", ["30", 30.0])
async def test_c1_a_whole_number_spelled_otherwise_is_that_number(pool, registered, clock, spelled):
    lid = await _running(pool)
    result, ok = await _call(pool, {"id": str(lid), "wait_s": spelled})
    assert ok is True, result
    assert sum(clock.sleeps) == 30
    assert "waited 30 s" in result


# -- C2: wait_s needs an id -------------------------------------------------------


async def test_c2_wait_s_without_an_id_is_refused_and_nothing_waits(pool, registered, clock):
    await _running(pool)
    facts: list[dict] = []
    result, ok = await _call(pool, {"wait_s": 30}, facts=facts)
    assert ok is False, result
    assert result.startswith(tools.ERROR_PREFIX)
    assert "wait_s" in result and "id" in result
    assert "with no id landing_status lists your latest landings" in result
    assert clock.sleeps == []
    assert facts == []


# -- C3: a landing that is not running returns at once ----------------------------


@pytest.mark.parametrize("verdict", ["green", "red", "could_not_measure", "conflict"])
async def test_c3_a_finished_landing_returns_at_once_as_a_plain_read(
    pool, registered, clock, verdict
):
    lid = await _running(pool)
    await landings.finish(pool, lid, verdict, reason="done before she asked")
    plain, ok_plain = await _call(pool, {"id": str(lid)})
    waited, ok = await _call(pool, {"id": str(lid), "wait_s": 90})
    assert ok is True and ok_plain is True, waited
    assert clock.sleeps == []
    assert waited == plain


# -- C4: the verdict or the stage changes mid-wait --------------------------------


async def test_c4_a_verdict_mid_wait_returns_at_that_poll(pool, registered, clock):
    lid = await _running(pool)

    async def judge(n: int) -> None:
        if n == 3:
            await landings.finish(pool, lid, "red", reason="core `uv run pytest` exited 1")

    clock.on_sleep = judge
    facts: list[dict] = []
    result, ok = await _call(pool, {"id": str(lid), "wait_s": 90}, facts=facts)
    assert ok is True, result
    assert len(clock.sleeps) == 3
    lines = result.splitlines()
    assert lines[0] == "The verdict came in after waiting 6 s."
    assert lines[1] == f"Landing {lid} — red"
    assert "Reason: core `uv run pytest` exited 1" in result
    assert [f["landing"]["verdict"] for f in facts] == ["red"]


async def test_c4_a_stage_change_mid_wait_returns_at_that_poll(pool, registered, clock):
    lid = await _running(pool)

    async def move(n: int) -> None:
        if n == 2:
            await landings.update(pool, lid, stage="publishing")

    clock.on_sleep = move
    facts: list[dict] = []
    result, ok = await _call(pool, {"id": str(lid), "wait_s": 90}, facts=facts)
    assert ok is True, result
    assert len(clock.sleeps) == 2
    lines = result.splitlines()
    assert lines[0] == f"The stage moved from {STAGE} to publishing after waiting 4 s."
    assert lines[1] == f"Landing {lid} — running"
    assert "Stage: publishing" in result
    assert [f["landing"]["verdict"] for f in facts] == ["running"]


async def test_c4_a_first_stage_from_queued_counts_as_a_change(pool, registered, clock):
    lid = await _running(pool, stage=None)

    async def move(n: int) -> None:
        if n == 1:
            await landings.update(pool, lid, stage="rebasing")

    clock.on_sleep = move
    result, ok = await _call(pool, {"id": str(lid), "wait_s": 90})
    assert ok is True, result
    assert result.splitlines()[0] == "The stage moved from queued to rebasing after waiting 2 s."


async def test_c4_a_reason_change_alone_does_not_end_the_wait(pool, registered, clock):
    lid = await _running(pool)

    async def note(n: int) -> None:
        if n == 1:
            await landings.append_reason(pool, lid, "stopped this change's box to judge it")

    clock.on_sleep = note
    result, ok = await _call(pool, {"id": str(lid), "wait_s": 10})
    assert ok is True, result
    assert sum(clock.sleeps) == 10
    assert result.splitlines()[0].startswith(f"Still running at stage {STAGE}, waited 10 s")
    assert "Reason: stopped this change's box to judge it" in result


async def test_c4_each_poll_is_at_most_poll_s_and_none_passes_the_deadline(pool, registered, clock):
    lid = await _running(pool)
    result, ok = await _call(pool, {"id": str(lid), "wait_s": 5})
    assert ok is True, result
    assert landing_tools.POLL_S == 2
    assert clock.sleeps == [2, 2, 1]


async def test_c4_a_row_gone_mid_wait_is_stated(pool, registered, clock):
    lid = await _running(pool)

    async def drop(n: int) -> None:
        if n == 1:
            await pool.execute("DELETE FROM landings WHERE id = $1", lid)

    clock.on_sleep = drop
    result, ok = await _call(pool, {"id": str(lid), "wait_s": 90})
    assert ok is False, result
    assert f"landing {lid} is gone from the record while waiting on it" in result
    assert len(clock.sleeps) == 1


# -- C5: the deadline ---------------------------------------------------------------


async def test_c5_the_deadline_says_how_long_it_waited_and_how_old_the_landing_is(
    pool, registered, clock
):
    lid = await _running(pool)
    facts: list[dict] = []
    result, ok = await _call(pool, {"id": str(lid), "wait_s": 90}, facts=facts)
    assert ok is True, result
    assert sum(clock.sleeps) == 90
    assert all(s <= landing_tools.POLL_S for s in clock.sleeps)
    lines = result.splitlines()
    # 252 s old at the call, 90 s waited: 342 s = 5 min 42 s.
    assert lines[0] == f"Still running at stage {STAGE}, waited 90 s, 5 min 42 s since it started."
    assert lines[1] == f"Landing {lid} — running"
    assert f"Stage: {STAGE}" in result
    assert [f["landing"]["verdict"] for f in facts] == ["running"]


async def test_c5_a_queued_landing_names_its_stage_queued(pool, registered, clock):
    lid = await _running(pool, stage=None)
    result, ok = await _call(pool, {"id": str(lid), "wait_s": 1})
    assert ok is True, result
    assert result.splitlines()[0] == (
        "Still running at stage queued, waited 1 s, 4 min 13 s since it started."
    )


# -- C6: the owner's stop -----------------------------------------------------------


async def test_c6_with_progress_bound_the_stop_raised_through_it_ends_the_wait(
    pool, registered, clock
):
    lid = await _running(pool)
    turn = await _turn(pool)
    reports: list = []

    def progress(detail) -> None:
        reports.append(detail)
        if len(reports) == 3:
            raise TurnStopped("the owner pressed Stop", "while running landing_status")

    ctx = ToolContext(
        app=None,
        person=None,
        workspace_root=_ctx(turn).workspace_root,
        turn_id=turn,
        progress=progress,
    )
    with pytest.raises(TurnStopped):
        await _call(pool, {"id": str(lid), "wait_s": 90}, ctx=ctx)
    assert len(clock.sleeps) == 2  # no sleep after the poll that raised
    assert all(str(lid) in str(r) for r in reports)


async def test_c6_without_progress_a_requested_stop_is_said(pool, registered, clock, monkeypatch):
    lid = await _running(pool)
    turn = await _turn(pool)

    async def press(n: int) -> None:
        if n == 2:
            monkeypatch.setitem(traces.STOPPING, turn, "the owner pressed Stop")

    clock.on_sleep = press
    result, ok = await _call(pool, {"id": str(lid), "wait_s": 90}, ctx=_ctx(turn))
    assert ok is True, result
    assert len(clock.sleeps) == 2
    lines = result.splitlines()
    assert lines[0] == "Stopped waiting after 4 s: this turn is stopping."
    assert lines[1] == f"Landing {lid} — running"


async def test_c6_a_stop_already_asked_waits_not_at_all(pool, registered, clock, monkeypatch):
    lid = await _running(pool)
    turn = await _turn(pool)
    monkeypatch.setitem(traces.STOPPING, turn, "the owner pressed Stop")
    result, ok = await _call(pool, {"id": str(lid), "wait_s": 90}, ctx=_ctx(turn))
    assert ok is True, result
    assert clock.sleeps == []
    assert result.splitlines()[0] == "Stopped waiting after 0 s: this turn is stopping."


# -- C7: the guards the 10-14 walk hit ----------------------------------------------


def _tool_call(args: dict, i: int) -> chat.ToolCall:
    return chat.ToolCall(
        id=f"call_{i}", name=landing_tools.LANDING_STATUS, arguments=json.dumps(args)
    )


@pytest.mark.parametrize("wait_s", [90, 1])
async def test_c7_three_deadline_readings_do_not_trip_the_circling_stop(
    pool, registered, clock, wait_s
):
    assert landing_tools.LANDING_STATUS in tools.live_reading_tool_names()
    lid = await _running(pool)
    args = {"id": str(lid), "wait_s": wait_s}
    progress = chat.RoundProgress()
    texts: list[str] = []
    outcomes = []
    for i in range(chat.SAME_CALL_LIMIT + chat.STALE_ROUNDS_LIMIT):
        result, ok = await _call(pool, args)
        assert ok is True, result
        assert result.startswith(f"Still running at stage {STAGE}, waited {wait_s} s")
        texts.append(result)
        outcomes.append(progress.after_round([_tool_call(args, i)], [result]))
    assert outcomes == [None] * len(outcomes)
    assert len(set(texts)) == len(texts)


async def test_c7_three_reads_without_wait_s_still_stop_on_repeated_call(pool, registered, clock):
    lid = await _running(pool)
    args = {"id": str(lid)}
    progress = chat.RoundProgress()
    outcomes = []
    for i in range(chat.SAME_CALL_LIMIT):
        result, ok = await _call(pool, args)
        assert ok is True, result
        outcomes.append(progress.after_round([_tool_call(args, i)], [result]))
    assert outcomes[-1] == chat.STOP_REPEATED_CALL
