"""S38c T5: a landing's judge box never waits on the change's own idle box
(docs/plans/rebuild/s38c/spec.md §5.7 (2), §12 Q8).

Before the suites run, landing_run reads the boxes once (box.status) and the
owner's box.max_running live. When every slot is taken, the landed change's
own box is one of them and stopping it frees the slot the judge needs, it
sends novad's box.stop for that change only and says so on the row. Other
changes' boxes are never touched: when they hold every slot, novad's start
refusal names them (could_not_measure, as before). Every way the stop does
not happen is said on the row, and the landing is judged as before.

Faked here: the agent (`_command`, for box.status/box.stop), the git steps
(landing_git), the plan and verdict, and run_suites — T8's own tests cover
the suites. Nothing reaches a device or the network.

Criteria:
  C1 full slots incl. her running box, the stop freeing the slot -> one
     box.status, then exactly one box.stop {"change": <change>}, then
     run_suites; the row says "stopped this change's box to judge it; it
     starts again on your next command".
  C2 no box.stop, no note: a free slot, her box stopped or absent, other
     boxes alone filling every slot; the judge's id is never counted.
  C3 a stop not done is said and judging proceeds: an old agent, a refusal,
     no answer, an answer with no record; stopped false says nothing.
  C4 box.status unreadable -> said, no box.stop, judging proceeds.
  C5 the stop note survives the verdict (red, an exception, green).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app import code_repos, landing_git, landing_plan, landing_run, landings
from app.landing_git import Copy, Prepared
from app.landing_plan import Verdict
from app.tools import changes
from app.tools.base import ToolFailure
from tests.conftest import requires_db

pytestmark = requires_db

CHANGE = "ab12cd"
OTHER = "0ff1ce"
THIRD = "c0ffee"
JUDGE = "5eed01"
CHECKOUT = "/srv/nova"
WORKTREE = f"{CHECKOUT}/.worktrees/nova-{CHANGE}"
ROW = {"id": None, "name": "Beelink"}
STOPPED = "stopped this change's box to judge it; it starts again on your next command"
UNKNOWN = 'unknown capability "box.stop"'


class Agent:
    """The fake agent: box.status answers `boxes` (or `status`), box.stop
    answers `stop` (a dict, or an exception to raise). Every call — and
    run_suites — goes into `calls`, in order."""

    def __init__(self, boxes=None, *, status=None, stop=None):
        self.boxes = boxes if boxes is not None else {}
        self.status = status
        self.stop = stop
        self.calls: list[tuple] = []

    async def __call__(self, pool, row, capability, args, ctx=None, **kw):
        self.calls.append((capability, dict(args)))
        if capability == "box.status":
            if isinstance(self.status, BaseException):
                raise self.status
            if self.status is not None:
                return self.status
            return {"ok": True, "output": "", "meta": {"boxes": dict(self.boxes)}}
        if capability == "box.stop":
            answer = self.stop
            if isinstance(answer, BaseException):
                raise answer
            if answer is None:
                name = f"nova-box-{args['change']}"
                answer = {
                    "ok": True,
                    "output": f"{name} stopped",
                    "meta": {"box": name, "stopped": True},
                }
            return answer
        raise AssertionError(f"unexpected capability {capability}")

    def caps(self) -> list[str]:
        return [c for c, _ in self.calls]

    def stops(self) -> list[dict]:
        return [a for c, a in self.calls if c == "box.stop"]


async def _setup(pool, monkeypatch, agent: Agent, *, outcome=None, suites_raise=None):
    turn = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model) VALUES ('chat', NULL, 'm') RETURNING id"
    )
    landing = await landings.insert(
        pool, change_id=CHANGE, repo="nova", branch=f"nova/{CHANGE}-x", turn_id=turn
    )
    monkeypatch.setattr(changes, "_command", agent)
    monkeypatch.setattr(landing_run, "_command", agent)

    async def prepare(run, **kw):
        return Prepared(
            branch=f"nova/{CHANGE}-x",
            base_sha="a" * 40,
            commit_sha="b" * 40,
            rebased=False,
            changed=("services/core/app/x.py",),
            deleted=(),
            patch="diff",
            patch_truncated=False,
        )

    async def dirty_outside(run, checkout):
        return [], False

    async def main_suites(run, **kw):
        return "toml"

    async def make_copy(run, **kw):
        return Copy(judge=JUDGE, path=f"{CHECKOUT}/.worktrees/nova-{JUDGE}")

    async def remove_copy(run, **kw):
        return None

    async def remove_box(pool, row, ctx, change):
        return ""

    async def run_suites(pool, row, ctx, **kw):
        agent.calls.append(("run_suites", {"judge": kw["copy"].judge}))
        if suites_raise is not None:
            raise suites_raise
        return []

    monkeypatch.setattr(landing_git, "prepare", prepare)
    monkeypatch.setattr(landing_git, "dirty_outside", dirty_outside)
    monkeypatch.setattr(landing_git, "main_suites", main_suites)
    monkeypatch.setattr(landing_git, "make_copy", make_copy)
    monkeypatch.setattr(landing_git, "remove_copy", remove_copy)
    monkeypatch.setattr(changes, "remove_box", remove_box)
    monkeypatch.setattr(landing_run, "run_suites", run_suites)
    monkeypatch.setattr(
        landing_plan, "plan", lambda toml, changed, deleted=(): SimpleNamespace(protected=())
    )
    verdict = outcome or Verdict("red", "ruff `ruff check` failed (exit 1)")
    monkeypatch.setattr(landing_plan, "verdict", lambda plan, results, box_error="": verdict)
    return turn, landing


async def _land(pool, turn, landing) -> dict:
    await landing_run.land(
        pool,
        ROW,
        None,
        landing_id=landing,
        change=CHANGE,
        checkout=CHECKOUT,
        worktree=WORKTREE,
        main="main",
        host="mini-pc",
        turn_id=turn,
        run=object(),
    )
    return await landings.get(pool, landing)


def _max_running(monkeypatch, n: int) -> None:
    real = code_repos.box_limits

    async def limits(pool):
        return {**(await real(pool)), "max_running": n}

    monkeypatch.setattr(code_repos, "box_limits", limits)


# -- C1 ------------------------------------------------------------------------


async def test_c1_full_slots_with_her_box_stop_it_then_judge(pool, monkeypatch):
    # The owner's default box.max_running is 2, read live.
    agent = Agent({CHANGE: "running", OTHER: "running"})
    turn, landing = await _setup(pool, monkeypatch, agent)
    got = await _land(pool, turn, landing)
    assert agent.caps() == ["box.status", "box.stop", "run_suites"]
    assert agent.stops() == [{"change": CHANGE}]
    assert STOPPED in got["reason"]


async def test_c1_the_limit_is_read_live_not_assumed(pool, monkeypatch):
    _max_running(monkeypatch, 3)
    agent = Agent({CHANGE: "running", OTHER: "running", THIRD: "running"})
    turn, landing = await _setup(pool, monkeypatch, agent)
    await _land(pool, turn, landing)
    assert agent.stops() == [{"change": CHANGE}]
    # Under the same three boxes a limit of 4 leaves a slot free.
    _max_running(monkeypatch, 4)
    agent2 = Agent({CHANGE: "running", OTHER: "running", THIRD: "running"})
    turn2, landing2 = await _setup(pool, monkeypatch, agent2)
    got = await _land(pool, turn2, landing2)
    assert agent2.stops() == []
    assert STOPPED not in (got["reason"] or "")


async def test_c1_a_limit_of_one_held_by_her_box_alone(pool, monkeypatch):
    _max_running(monkeypatch, 1)
    agent = Agent({CHANGE: "running", OTHER: "stopped"})
    turn, landing = await _setup(pool, monkeypatch, agent)
    got = await _land(pool, turn, landing)
    assert agent.stops() == [{"change": CHANGE}]
    assert STOPPED in got["reason"]


async def test_c1_the_note_is_on_the_row_before_the_suites_run(pool, monkeypatch):
    agent = Agent({CHANGE: "running", OTHER: "running"})
    turn, landing = await _setup(pool, monkeypatch, agent)
    seen: list = []

    async def run_suites(pool_, row, ctx, **kw):
        seen.append((await landings.get(pool, landing))["reason"])
        return []

    monkeypatch.setattr(landing_run, "run_suites", run_suites)
    await _land(pool, turn, landing)
    assert seen == [STOPPED]


# -- C2 ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "boxes",
    [
        {CHANGE: "running"},  # a free slot
        {CHANGE: "running", OTHER: "stopped"},  # a free slot
        {OTHER: "running", THIRD: "running"},  # her box absent
        {CHANGE: "stopped", OTHER: "running", THIRD: "running"},  # her box stopped
        {CHANGE: "running", OTHER: "running", THIRD: "running"},  # others alone fill both
        {CHANGE: "running", JUDGE: "running"},  # the judge's own id never counts
        {},
    ],
)
async def test_c2_no_stop_when_it_is_not_needed_or_would_not_help(pool, monkeypatch, boxes):
    agent = Agent(boxes)
    turn, landing = await _setup(pool, monkeypatch, agent)
    got = await _land(pool, turn, landing)
    assert agent.caps() == ["box.status", "run_suites"]
    assert got["reason"] == "ruff `ruff check` failed (exit 1)"


async def test_c2_no_other_changes_box_is_ever_stopped(pool, monkeypatch):
    for boxes in (
        {CHANGE: "running", OTHER: "running"},
        {OTHER: "running", THIRD: "running"},
        {CHANGE: "running", OTHER: "running", THIRD: "running"},
    ):
        agent = Agent(boxes)
        turn, landing = await _setup(pool, monkeypatch, agent)
        await _land(pool, turn, landing)
        assert all(a == {"change": CHANGE} for a in agent.stops()), boxes


# -- C3 ------------------------------------------------------------------------


def _full() -> dict:
    return {CHANGE: "running", OTHER: "running"}


@pytest.mark.parametrize(
    "stop, words",
    [
        (
            {"ok": False, "error": f"{UNKNOWN} (this agent is older)"},
            f"this change's box nova-box-{CHANGE} was not stopped to judge it: the agent "
            "predates box.stop — update it with machine_update",
        ),
        (
            {
                "ok": False,
                "error": f"cannot stop the box nova-box-{CHANGE}: it runs live job j1 — stop it "
                "with job.stop or wait for it; nothing was stopped",
            },
            f"this change's box nova-box-{CHANGE} was not stopped to judge it: Beelink: cannot "
            f"stop the box nova-box-{CHANGE}: it runs live job j1 — stop it with job.stop or "
            "wait for it; nothing was stopped",
        ),
        (
            ToolFailure("Beelink is not connected"),
            f"this change's box nova-box-{CHANGE} was not stopped to judge it: Beelink is not "
            "connected",
        ),
        (
            {"ok": True, "output": "done", "meta": None},
            f"this change's box nova-box-{CHANGE} was not stopped to judge it: Beelink answered "
            "box.stop with no record of stopping it",
        ),
        (
            {"ok": True, "output": "done", "meta": {"box": "nova-box-0ff1ce", "stopped": True}},
            f"this change's box nova-box-{CHANGE} was not stopped to judge it: Beelink answered "
            "box.stop with no record of stopping it",
        ),
        (
            {"ok": True, "output": "done", "meta": {"box": f"nova-box-{CHANGE}", "stopped": "yes"}},
            f"this change's box nova-box-{CHANGE} was not stopped to judge it: Beelink answered "
            "box.stop with no record of stopping it",
        ),
    ],
)
async def test_c3_a_stop_not_done_is_said_and_judging_proceeds(pool, monkeypatch, stop, words):
    agent = Agent(_full(), stop=stop)
    turn, landing = await _setup(pool, monkeypatch, agent)
    got = await _land(pool, turn, landing)
    assert agent.caps() == ["box.status", "box.stop", "run_suites"]
    assert words in got["reason"]
    assert STOPPED not in got["reason"]


async def test_c3_stopped_false_says_nothing(pool, monkeypatch):
    stop = {
        "ok": True,
        "output": f"nova-box-{CHANGE} was not running; nothing was stopped",
        "meta": {"box": f"nova-box-{CHANGE}", "stopped": False},
    }
    agent = Agent(_full(), stop=stop)
    turn, landing = await _setup(pool, monkeypatch, agent)
    got = await _land(pool, turn, landing)
    assert agent.caps() == ["box.status", "box.stop", "run_suites"]
    assert got["reason"] == "ruff `ruff check` failed (exit 1)"


# -- C4 ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "status, why",
    [
        (ToolFailure("Beelink is not connected"), "Beelink is not connected"),
        ({"ok": False, "error": "docker: permission denied"}, "Beelink: docker: permission denied"),
        (
            {"ok": False, "error": 'unknown capability "box.status"'},
            "Beelink's agent predates the box — update it with machine_update; nothing was run",
        ),
        ({"ok": True, "output": "", "meta": {}}, "the agent's box.status named no boxes"),
        (
            {"ok": True, "output": "", "meta": {"boxes": {CHANGE: "paused"}}},
            "the agent's box.status said 'paused'",
        ),
    ],
)
async def test_c4_unreadable_boxes_are_said_and_judging_proceeds(pool, monkeypatch, status, why):
    agent = Agent(status=status)
    turn, landing = await _setup(pool, monkeypatch, agent)
    got = await _land(pool, turn, landing)
    assert agent.caps() == ["box.status", "run_suites"]
    assert f"the box slots could not be read before judging: {why}" in got["reason"]


# -- C5 ------------------------------------------------------------------------


async def test_c5_a_red_verdict_keeps_the_stop_note(pool, monkeypatch):
    agent = Agent(_full())
    turn, landing = await _setup(pool, monkeypatch, agent)
    got = await _land(pool, turn, landing)
    assert got["verdict"] == "red"
    assert got["reason"] == f"ruff `ruff check` failed (exit 1); {STOPPED}"


async def test_c5_an_exception_keeps_the_stop_note(pool, monkeypatch):
    agent = Agent(_full())
    turn, landing = await _setup(pool, monkeypatch, agent, suites_raise=ToolFailure("boom"))
    got = await _land(pool, turn, landing)
    assert got["verdict"] == "could_not_measure"
    assert got["reason"] == f"boom; {STOPPED}"


async def test_c5_a_could_not_measure_verdict_keeps_a_status_note(pool, monkeypatch):
    agent = Agent(status=ToolFailure("Beelink is not connected"))
    outcome = Verdict("could_not_measure", "1/1 ruff: failed_to_start")
    turn, landing = await _setup(pool, monkeypatch, agent, outcome=outcome)
    got = await _land(pool, turn, landing)
    assert got["reason"] == (
        "1/1 ruff: failed_to_start; the box slots could not be read before judging: "
        "Beelink is not connected"
    )


async def test_c5_green_keeps_the_stop_note(pool, monkeypatch):
    agent = Agent(_full())
    turn, landing = await _setup(pool, monkeypatch, agent, outcome=Verdict("green", ""))

    async def publish(run, **kw):
        return landing_git.Published(merged_sha=None, pr_url=None, push_result="not pushed")

    monkeypatch.setattr(landing_git, "publish", publish)
    got = await _land(pool, turn, landing)
    assert got["verdict"] == "green"
    assert got["reason"].startswith(STOPPED)


# -- changes.stop_box ------------------------------------------------------------


async def test_stop_box_refuses_a_bad_change_before_sending(monkeypatch):
    agent = Agent()
    monkeypatch.setattr(changes, "_command", agent)
    stopped, why = await changes.stop_box(None, ROW, None, "../etc")
    assert stopped is False and "not a change id" in why
    assert agent.calls == []


async def test_stop_box_reads_stopped_from_the_record(monkeypatch):
    agent = Agent()
    monkeypatch.setattr(changes, "_command", agent)
    assert await changes.stop_box(None, ROW, None, CHANGE) == (True, "")
    agent.stop = {"ok": True, "meta": {"box": f"nova-box-{CHANGE}", "stopped": False}}
    assert await changes.stop_box(None, ROW, None, CHANGE) == (False, "")
    assert agent.stops() == [{"change": CHANGE}, {"change": CHANGE}]
