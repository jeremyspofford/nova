"""S32.3 T8: a landing's suites as S30c jobs in the judge box
(docs/plans/rebuild/s32/spec.md §5.2 step 5).

landing_run.run_suites starts each planned command (landing_plan.
planned_commands: ruff first, then each suite's commands with main's argv
exactly) as ONE job.start on the repository's machine, cwd in the clean
copy — so novad runs it in the judge box nova-box-<judge>, and box.Heavy
(exact argv in its dir) holds the CPU lock for a whole suite. It polls
job.status to a terminal state, reads the whole log back with job.log, and
builds the row's result with landing_plan.suite_result.

Criteria:
  C1 Each planned command, in plan order and one at a time, is one job.start
     with main's exact argv, cwd = the copy's root for dir "." else
     <copy>/<dir>, change = the judge id, the checkout, the repo's default
     branch and the owner's box limits; pytest commands carry env
     PYTEST_ADDOPTS=-rs, others no env.
  C2 Each job has its device_jobs row before the send — ran_in box, box
     nova-box-<judge>, the landing's turn, env NAMES only — and its terminal
     record is stored on that row.
  C3 job.status is polled every poll_s until terminal; the landing row's
     stage names the command and whether it waits for the CPU lock or runs;
     the results are stored on the landing's suites after each command.
  C4 The result comes from the terminal record (state, exit, reason, seconds
     from started/ended) and the WHOLE log (read by offset past one 256 KiB
     read, at most LOG_MAX from its end): counts and skip reasons are read
     from all of it, not a tail.
  C5 Failures are stated, never passed: a start the agent refuses (the box
     limit, an old agent) is failed_to_start with its words; an unanswered
     start is followed by status (a job the agent never had is
     could_not_measure); a record of another job or one core cannot read is
     could_not_measure; a failing poll is retried until the ceiling; the
     ceiling stops the job (could_not_measure, timed out); a log that cannot
     be read never passes.
  C6 The run stops at the first command that did not pass (later ones are
     never started; the verdict names them as not run), and a landing that
     is no longer running starts nothing more.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app import code_repos, landing_run, landings
from app.landing_git import Copy
from app.landing_plan import Plan, PlannedSuite, planned_commands, verdict
from app.tools.base import ToolFailure
from tests.conftest import requires_db
from tests.test_devices_ws import _enroll

pytestmark = requires_db

CHECKOUT = "/srv/nova"
JUDGE = "5eed01"
COPY = Copy(judge=JUDGE, path=f"{CHECKOUT}/.worktrees/nova-{JUDGE}")
BOX = f"nova-box-{JUDGE}"
PYTEST = ("uv", "run", "pytest")
RUFF = ("ruff", "check", "--", "services/core/app/x.py")
NPM = ("npm", "test")
TSC = ("npx", "tsc", "--noEmit")
_HEX12 = re.compile(r"^[0-9a-f]{12}$")

PASS_PYTEST = (
    "....\nSKIPPED [1] tests/test_x.py:3: not on this platform\n"
    "=== 4 passed, 1 skipped in 2.0s ===\n"
)
PASS_RUFF = "All checks passed!\n"
PASS_VITEST = "      Tests  12 passed (12)\n"

T0 = datetime(2026, 10, 13, 9, 0, 0, tzinfo=UTC)


def _plan(*, ruff: bool = True, web: bool = False) -> Plan:
    suites = [PlannedSuite("core", "services/core", (PYTEST,))]
    if web:
        suites.append(PlannedSuite("web", "apps/web", (NPM, TSC)))
    return Plan(
        suites=tuple(suites),
        ruff_files=("services/core/app/x.py",) if ruff else (),
        protected=(),
        uncovered=(),
    )


class Script:
    """How the fake agent answers for one argv."""

    def __init__(
        self,
        *,
        log: str = "",
        exit_code: int | None = 0,
        final: str = "done",
        reason: str = "",
        live: tuple[str, ...] = ("running",),
        start: dict | None = None,
        start_raises: str | None = None,
        start_creates: bool = True,
        status_raises: int = 0,
        never_ends: bool = False,
        status_override: dict | None = None,
        status_error: str | None = None,
        stop_done: bool = False,
        log_bad_offset: bool = False,
        log_other_job: bool = False,
        log_error: str | None = None,
        seconds: float = 200.1,
        times: bool = True,
    ):
        self.log = log
        self.exit_code = exit_code
        self.final = final
        self.reason = reason
        self.live = list(live)
        self.start = start
        self.start_raises = start_raises
        self.start_creates = start_creates
        self.status_raises = status_raises
        self.never_ends = never_ends
        self.status_override = status_override
        self.status_error = status_error
        self.stop_done = stop_done
        self.log_bad_offset = log_bad_offset
        self.log_other_job = log_other_job
        self.log_error = log_error
        self.seconds = seconds
        self.times = times


class Agent:
    """Stands in for devices._command on the repo machine: job.start /
    job.status / job.log / job.stop with novad's shapes (caps/job.go)."""

    def __init__(self, scripts: dict[tuple, Script], pool=None):
        self.scripts = scripts
        self.pool = pool
        self.sent: list[tuple[str, dict]] = []
        self.jobs: dict[str, dict] = {}
        self.row_at_send: dict[str, dict | None] = {}
        self.row_at_first_status: dict[str, str] = {}
        self.on_start = None  # async hook(argv) before a job.start is answered

    async def __call__(self, pool, row, capability, args, *, ctx=None, timeout=None):
        self.sent.append((capability, dict(args)))
        if capability == "job.start":
            return await self._start(args)
        if capability == "job.status":
            return await self._status(args["job_id"])
        if capability == "job.log":
            return self._log(args)
        if capability == "job.stop":
            return self._stop(args["job_id"])
        raise AssertionError(f"unexpected capability {capability}")

    async def _start(self, args: dict) -> dict:
        argv = tuple(args["argv"])
        script = self.scripts[argv]
        jid = args["job_id"]
        if self.pool is not None:
            r = await self.pool.fetchrow("SELECT * FROM device_jobs WHERE id = $1", jid)
            self.row_at_send[jid] = dict(r) if r else None
        if self.on_start is not None:
            await self.on_start(argv)
        if script.start_raises is not None:
            if script.start_creates:
                self.jobs[jid] = {"script": script, "args": args, "polls": 0}
            raise ToolFailure(script.start_raises)
        if script.start is not None:
            return dict(script.start)
        self.jobs[jid] = {"script": script, "args": args, "polls": 0}
        state = script.live[0] if script.live else "running"
        return {
            "ok": True,
            "output": f"started job {jid} in the box {BOX} ({state})",
            "meta": {"job": jid, "state": state, "box": BOX, "survives_agent": True},
        }

    def _record(self, jid: str, state: str) -> dict:
        job = self.jobs[jid]
        script, args = job["script"], job["args"]
        rec = {
            "job": jid,
            "state": state,
            "argv": list(args["argv"]),
            "cwd": args["cwd"],
            "ran_in": "box",
            "box": BOX,
            "lock_waited_s": 0,
            "log_bytes": len(script.log.encode()),
        }
        if script.times and state != "waiting_lock":
            rec["started_at"] = T0.isoformat()
        if state in ("done", "failed_to_start", "stopped", "lost"):
            if script.times:
                rec["ended_at"] = (T0 + timedelta(seconds=script.seconds)).isoformat()
            if script.exit_code is not None and state != "failed_to_start":
                rec["exit_code"] = script.exit_code
            if script.reason:
                rec["reason"] = script.reason
        return rec

    async def _status(self, jid: str) -> dict:
        if self.pool is not None and jid not in self.row_at_first_status:
            self.row_at_first_status[jid] = await self.pool.fetchval(
                "SELECT state FROM device_jobs WHERE id = $1", jid
            )
        job = self.jobs.get(jid)
        if job is None:
            return {"ok": False, "error": f"no job {jid} on this device"}
        script = job["script"]
        if script.status_raises > 0:
            script.status_raises -= 1
            raise ToolFailure("Beelink is not connected")
        if script.status_error is not None:
            return {"ok": False, "error": script.status_error}
        if script.status_override is not None:
            return {"ok": True, "output": "", "meta": dict(script.status_override)}
        i = job["polls"]
        job["polls"] += 1
        if job.get("stopped"):
            state = "stopped"
        elif script.never_ends:
            state = "running"
        elif i < len(script.live):
            state = script.live[i]
        else:
            state = script.final
        return {"ok": True, "output": state, "meta": self._record(jid, state)}

    def _log(self, args: dict) -> dict:
        jid = args["job_id"]
        script = self.jobs[jid]["script"]
        if script.log_error is not None:
            return {"ok": False, "error": script.log_error}
        raw = script.log.encode()
        total = len(raw)
        cap = 256 * 1024
        assert not ("tail_bytes" in args and ("offset" in args or "length" in args))
        if "tail_bytes" in args:
            assert args["tail_bytes"] <= cap
            length = min(args["tail_bytes"], total)
            offset = total - length
        else:
            offset = args.get("offset", 0)
            length = args.get("length", cap)
            assert length <= cap
            length = max(0, min(length, total - offset))
        buf = raw[offset : offset + length]
        said = offset + 1 if script.log_bad_offset and "offset" in args else offset
        return {
            "ok": True,
            "output": buf.decode("utf-8", "replace"),
            "meta": {
                "job": "0123456789ab" if script.log_other_job else jid,
                "bytes_total": total,
                "offset": said,
                "length": len(buf),
            },
        }

    def _stop(self, jid: str) -> dict:
        job = self.jobs[jid]
        job["stopped"] = True
        script = job["script"]
        if script.stop_done:
            return {"ok": True, "output": f"{jid} had ended", "meta": self._record(jid, "done")}
        script.exit_code = 143
        script.reason = "stopped by job.stop"
        return {"ok": True, "output": f"stopped {jid}", "meta": self._record(jid, "stopped")}

    def caps(self, capability: str) -> list[dict]:
        return [a for c, a in self.sent if c == capability]


class Clock:
    def __init__(self, pool=None, landing_id=None):
        self.now = 0.0
        self.slept: list[float] = []
        self.pool = pool
        self.landing_id = landing_id
        self.stages: list[str | None] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, s: float) -> None:
        self.slept.append(s)
        self.now += s
        if self.pool is not None:
            self.stages.append(
                await self.pool.fetchval(
                    "SELECT stage FROM landings WHERE id = $1", self.landing_id
                )
            )


async def _setup(pool, monkeypatch, scripts: dict[tuple, Script]):
    device_id, _ = await _enroll(pool, name="Beelink")
    row = {"id": device_id, "name": "Beelink"}
    turn = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model) VALUES ('chat', NULL, 'm') RETURNING id"
    )
    landing = await landings.insert(
        pool, change_id="ab12cd", repo="nova", branch="nova/ab12cd-iso-week", turn_id=turn
    )
    agent = Agent(scripts, pool)
    monkeypatch.setattr(landing_run, "_command", agent)
    clock = Clock(pool, landing)
    return row, turn, landing, agent, clock


async def _run(pool, row, turn, landing, clock, plan, **kw):
    return await landing_run.run_suites(
        pool,
        row,
        None,
        landing_id=landing,
        turn_id=turn,
        checkout=CHECKOUT,
        branch="main",
        copy=COPY,
        plan=plan,
        poll_s=kw.pop("poll_s", 10.0),
        ceiling_s=kw.pop("ceiling_s", 3600.0),
        sleep=clock.sleep,
        clock=clock,
        **kw,
    )


def _passing(web: bool = False) -> dict[tuple, Script]:
    scripts = {RUFF: Script(log=PASS_RUFF), PYTEST: Script(log=PASS_PYTEST)}
    if web:
        scripts[NPM] = Script(log=PASS_VITEST)
        scripts[TSC] = Script(log="")
    return scripts


async def _job_rows(pool) -> list[dict]:
    return [dict(r) for r in await pool.fetch("SELECT * FROM device_jobs ORDER BY created_at")]


# -- C1 ------------------------------------------------------------------------


async def test_c1_each_planned_command_is_one_job_start_in_the_copy(pool, monkeypatch):
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, _passing(web=True))
    plan = _plan(web=True)
    results = await _run(pool, row, turn, landing, clock, plan)
    starts = agent.caps("job.start")
    assert [tuple(s["argv"]) for s in starts] == [c for _s, _d, c in planned_commands(plan)]
    assert [s["cwd"] for s in starts] == [
        COPY.path,
        f"{COPY.path}/services/core",
        f"{COPY.path}/apps/web",
        f"{COPY.path}/apps/web",
    ]
    limits = await code_repos.box_limits(pool)
    for s in starts:
        assert s["change"] == JUDGE
        assert s["checkout"] == CHECKOUT
        assert s["branch"] == "main"
        assert s["limits"] == limits
        assert _HEX12.fullmatch(s["job_id"])
        assert set(s) <= {"job_id", "argv", "cwd", "change", "checkout", "branch", "limits", "env"}
    assert [r["suite"] for r in results] == ["ruff", "core", "web", "web"]
    assert all(r["outcome"] == "passed" for r in results)


async def test_c1_the_argv_sent_is_mains_exactly(pool, monkeypatch):
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, _passing())
    await _run(pool, row, turn, landing, clock, _plan())
    sent = [s["argv"] for s in agent.caps("job.start")]
    assert sent == [list(RUFF), list(PYTEST)]
    assert all(isinstance(s, list) for s in sent)


async def test_c1_only_pytest_carries_pytest_addopts(pool, monkeypatch):
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, _passing(web=True))
    await _run(pool, row, turn, landing, clock, _plan(web=True))
    envs = {tuple(s["argv"]): s.get("env") for s in agent.caps("job.start")}
    assert envs[PYTEST] == {"PYTEST_ADDOPTS": "-rs"}
    assert envs[RUFF] is None and envs[NPM] is None and envs[TSC] is None
    assert all("env" not in s for s in agent.caps("job.start") if tuple(s["argv"]) != PYTEST)


async def test_c1_one_job_at_a_time(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF].live = ("waiting_lock", "running", "running")
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    await _run(pool, row, turn, landing, clock, _plan())
    kinds = [c for c, _a in agent.sent]
    second = [i for i, c in enumerate(kinds) if c == "job.start"][1]
    first_id = agent.caps("job.start")[0]["job_id"]
    statuses_before = [
        a for c, a in agent.sent[:second] if c == "job.status" and a["job_id"] == first_id
    ]
    assert len(statuses_before) == 4  # three live answers, then done
    assert all(c != "job.start" for c in kinds[1:second])


@pytest.mark.parametrize(
    "suite_dir,want",
    [
        (".", COPY.path),
        ("services/core", f"{COPY.path}/services/core"),
        ("apps/web", f"{COPY.path}/apps/web"),
    ],
)
def test_c1_the_cwd_is_the_copy_or_its_dir(suite_dir, want):
    assert landing_run.command_cwd(COPY, suite_dir) == want


@pytest.mark.parametrize("bad", ["", "/abs", "../up", "a/../../b", "a//b", "a/./b", "a/"])
def test_c1_a_dir_outside_the_copy_is_refused(bad):
    with pytest.raises(ValueError):
        landing_run.command_cwd(COPY, bad)


# -- C2 ------------------------------------------------------------------------


async def test_c2_each_job_has_its_row_in_the_box_with_the_turn_and_env_names(pool, monkeypatch):
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, _passing())
    await _run(pool, row, turn, landing, clock, _plan())
    rows = await _job_rows(pool)
    assert [r["argv"] for r in rows] == [list(RUFF), list(PYTEST)]
    assert [r["id"] for r in rows] == [s["job_id"] for s in agent.caps("job.start")]
    for r in rows:
        assert r["device_id"] == row["id"]
        assert r["turn_id"] == turn
        assert r["ran_in"] == "box"
        assert r["box"] == BOX
        assert r["state"] == "done"
        assert r["exit_code"] == 0
        assert "-rs" not in repr(r)
    assert rows[0]["env_keys"] == []
    assert rows[1]["env_keys"] == ["PYTEST_ADDOPTS"]
    assert rows[0]["cwd"] == COPY.path
    assert rows[1]["cwd"] == f"{COPY.path}/services/core"


async def test_c2_the_row_is_written_before_the_send(pool, monkeypatch):
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, _passing())
    await _run(pool, row, turn, landing, clock, _plan())
    assert agent.row_at_send
    for jid, at_send in agent.row_at_send.items():
        assert at_send is not None, jid
        assert at_send["state"] == "starting"


async def test_c2_a_failed_run_is_stored_on_its_row(pool, monkeypatch):
    scripts = _passing()
    scripts[PYTEST] = Script(log="=== 1 failed, 3 passed in 1.0s ===\n", exit_code=1)
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    await _run(pool, row, turn, landing, clock, _plan())
    rows = await _job_rows(pool)
    assert rows[1]["state"] == "done" and rows[1]["exit_code"] == 1
    assert rows[1]["ended_at"] is not None


# -- C3 ------------------------------------------------------------------------


async def test_c3_status_is_polled_every_poll_s_until_terminal(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF].live = ("waiting_lock", "running", "running")
    scripts[PYTEST].live = ()
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    await _run(pool, row, turn, landing, clock, _plan(), poll_s=7.5)
    assert clock.slept == [7.5, 7.5, 7.5]
    ruff_id = agent.caps("job.start")[0]["job_id"]
    assert len([a for a in agent.caps("job.status") if a["job_id"] == ruff_id]) == 4


async def test_c3_the_stage_names_the_command_and_its_state(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF].live = ()
    scripts[PYTEST].live = ("waiting_lock", "running")
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    await _run(pool, row, turn, landing, clock, _plan())
    assert len(clock.stages) == 2
    waiting, running = clock.stages
    assert "core" in waiting and "uv run pytest" in waiting and "2/2" in waiting
    assert "waiting for the CPU lock" in waiting
    assert "core" in running and "uv run pytest" in running and "running" in running
    assert "CPU lock" not in running


async def test_c3_results_are_stored_on_the_landing_after_each_command(pool, monkeypatch):
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, _passing())
    seen: list[list] = []

    async def hook(argv):
        seen.append((await landings.get(pool, landing))["suites"])

    agent.on_start = hook
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert [len(s) for s in seen] == [0, 1]
    assert seen[1][0]["suite"] == "ruff" and seen[1][0]["outcome"] == "passed"
    stored = (await landings.get(pool, landing))["suites"]
    assert stored == results
    assert [r["suite"] for r in stored] == ["ruff", "core"]


# -- C4 ------------------------------------------------------------------------


async def test_c4_the_result_comes_from_the_terminal_record(pool, monkeypatch):
    scripts = _passing()
    scripts[PYTEST] = Script(
        log="F.\n=== 2 failed, 5 passed in 1.0s ===\n", exit_code=1, seconds=321.44
    )
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    core = results[1]
    assert core["suite"] == "core"
    assert core["command"] == list(PYTEST)
    assert core["state"] == "done"
    assert core["exit"] == 1
    assert (core["failed"], core["passed"]) == (2, 5)
    assert core["seconds"] == 321.4
    assert core["outcome"] == "failed"
    assert "2 failed, 5 passed" in core["tail"]


async def test_c4_seconds_are_unknown_without_times(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF].times = False
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert results[0]["seconds"] is None


def _big_log(head: str, tail: str, size: int) -> str:
    filler = ("." * 79 + "\n") * (size // 80 + 1)
    return head + filler + tail


async def test_c4_a_log_past_one_read_is_read_whole(pool, monkeypatch):
    # The -rs line explaining the skip sits more than 256 KiB before the end:
    # read from a tail alone, the skip would be unexplained.
    log = _big_log(
        "SKIPPED [1] tests/test_x.py:3: not on this platform\n",
        "=== 9 passed, 1 skipped in 300.0s ===\n",
        600 * 1024,
    )
    scripts = _passing()
    scripts[PYTEST] = Script(log=log)
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert results[1]["outcome"] == "passed", results[1]["why"]
    assert len(results[1]["tail"].encode()) <= 4096
    core_id = agent.caps("job.start")[1]["job_id"]
    reads = [a for a in agent.caps("job.log") if a["job_id"] == core_id]
    assert len(reads) >= 3
    assert any(a.get("offset") == 0 for a in reads)


async def test_c4_an_environment_skip_far_from_the_end_is_found(pool, monkeypatch):
    log = _big_log(
        "SKIPPED [1] tests/test_db.py: TEST_DATABASE_URL not set — DB-backed tests skipped\n",
        "=== 9 passed, 1 skipped in 300.0s ===\n",
        600 * 1024,
    )
    scripts = _passing()
    scripts[PYTEST] = Script(log=log)
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert results[1]["outcome"] == "could_not_measure"
    assert "because of the box's environment" in results[1]["why"]


async def test_c4_a_log_past_log_max_is_read_from_its_end(pool, monkeypatch):
    monkeypatch.setattr(landing_run, "LOG_MAX", 600 * 1024)
    log = _big_log(
        "HEAD-MARKER\n",
        "SKIPPED [1] tests/test_x.py:3: not on this platform\n"
        "=== 9 passed, 1 skipped in 300.0s ===\n",
        900 * 1024,
    )
    total = len(log.encode())
    scripts = _passing()
    scripts[PYTEST] = Script(log=log)
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert results[1]["outcome"] == "passed", results[1]["why"]
    core_id = agent.caps("job.start")[1]["job_id"]
    reads = [a for a in agent.caps("job.log") if a["job_id"] == core_id]
    offsets = [a["offset"] for a in reads if "offset" in a]
    assert offsets and min(offsets) == total - 600 * 1024
    got = sum(min(a.get("length", 0), total - a["offset"]) for a in reads if "offset" in a) + min(
        256 * 1024, total
    )
    assert got == 600 * 1024


# -- C5 ------------------------------------------------------------------------

LIMIT_WORDS = (
    "cannot start the box nova-box-5eed01: at most 2 boxes run at once (2 running) — "
    "nothing was started"
)


async def test_c5_a_box_that_cannot_start_is_could_not_measure_in_its_words(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF] = Script(start={"ok": False, "error": LIMIT_WORDS})
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert len(results) == 1
    r = results[0]
    assert r["state"] == "failed_to_start"
    assert r["outcome"] == "could_not_measure"
    assert LIMIT_WORDS in r["why"] and "Beelink" in r["why"]
    assert agent.caps("job.status") == []
    rows = await _job_rows(pool)
    assert rows[0]["state"] == "failed_to_start"
    assert LIMIT_WORDS in rows[0]["reason"]
    v = verdict(_plan(), results)
    assert v.verdict == "could_not_measure"
    assert LIMIT_WORDS in v.reason


async def test_c5_an_old_agent_is_told_to_update(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF] = Script(start={"ok": False, "error": "unknown capability: job.start"})
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert results[0]["outcome"] == "could_not_measure"
    assert "predates jobs" in results[0]["why"]
    assert "machine_update" in results[0]["why"]


async def test_c5_an_unanswered_start_of_a_job_the_agent_never_had(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF] = Script(start_raises="Beelink did not answer in 30 s", start_creates=False)
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    r = results[0]
    assert r["outcome"] == "could_not_measure"
    assert "not confirmed" in r["why"]
    assert "no job" in r["why"]
    assert len(agent.caps("job.status")) == 1
    rows = await _job_rows(pool)
    assert rows[0]["state"] == "starting"
    assert "not confirmed" in rows[0]["reason"]


async def test_c5_an_unanswered_start_that_did_start_is_followed_to_its_end(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF] = Script(log=PASS_RUFF, start_raises="Beelink did not answer in 30 s")
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert [r["outcome"] for r in results] == ["passed", "passed"]
    assert (await _job_rows(pool))[0]["state"] == "done"


async def test_c5_a_record_of_another_job_is_could_not_measure(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF] = Script(
        status_override={"job": "0123456789ab", "state": "done", "exit_code": 0, "log_bytes": 0}
    )
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert len(results) == 1
    assert results[0]["outcome"] == "could_not_measure"
    assert "no record of job" in results[0]["why"]


async def test_c5_a_record_core_cannot_read_is_could_not_measure(pool, monkeypatch):
    scripts = _passing()
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)

    async def hook(argv):
        if argv == RUFF:
            jid = agent.caps("job.start")[-1]["job_id"]
            scripts[RUFF].status_override = {"job": jid, "state": "exploded", "log_bytes": 0}

    agent.on_start = hook
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert results[0]["outcome"] == "could_not_measure"
    assert "cannot read" in results[0]["why"]


async def test_c5_a_status_the_agent_refuses_is_could_not_measure(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF] = Script(status_error="cannot read job: permission denied")
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert results[0]["outcome"] == "could_not_measure"
    assert "permission denied" in results[0]["why"]


async def test_c5_a_failing_poll_is_retried(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF] = Script(log=PASS_RUFF, status_raises=2, live=())
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert [r["outcome"] for r in results] == ["passed", "passed"]
    assert clock.slept[:2] == [10.0, 10.0]


async def test_c5_polls_failing_to_the_ceiling_are_could_not_measure(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF] = Script(status_raises=10_000)
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan(), ceiling_s=60.0)
    assert len(results) == 1
    r = results[0]
    assert r["outcome"] == "could_not_measure"
    assert "timed out" in r["why"] and "not connected" in r["why"]
    assert clock.now == 60.0


async def test_c5_the_ceiling_stops_the_job(pool, monkeypatch):
    scripts = _passing()
    scripts[PYTEST] = Script(never_ends=True, log="....")
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan(), ceiling_s=30.0)
    core = results[1]
    core_id = agent.caps("job.start")[1]["job_id"]
    assert agent.caps("job.stop") == [{"job_id": core_id}]
    assert core["outcome"] == "could_not_measure"
    assert core["state"] == "stopped"
    assert "timed out after 30 s" in core["why"]
    rows = await _job_rows(pool)
    assert rows[1]["state"] == "stopped"


async def test_c5_a_log_that_cannot_be_read_never_passes(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF] = Script(log=PASS_RUFF, log_error="cannot read job's log: gone")
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert len(results) == 1
    assert results[0]["outcome"] == "could_not_measure"
    assert "log" in results[0]["why"] and "gone" in results[0]["why"]


async def test_c5_a_failed_run_with_an_unreadable_log_stays_failed(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF] = Script(exit_code=1, log_error="cannot read job's log: gone")
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert results[0]["outcome"] == "failed"
    assert results[0]["exit"] == 1


async def test_c5_a_wrapper_that_could_not_start_it_is_could_not_measure(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF] = Script(final="failed_to_start", reason="docker exec: box gone", live=())
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert results[0]["outcome"] == "could_not_measure"
    assert "box gone" in results[0]["why"]


# -- C6 ------------------------------------------------------------------------


async def test_c6_the_run_stops_at_the_first_command_not_passed(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF] = Script(log="x.py:1:1: F401 unused\nFound 1 error.\n", exit_code=1)
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert [r["suite"] for r in results] == ["ruff"]
    assert [tuple(s["argv"]) for s in agent.caps("job.start")] == [RUFF]
    v = verdict(_plan(), results)
    assert v.verdict == "red" and "ruff" in v.reason


async def test_c6_a_command_not_measured_leaves_the_rest_as_not_run(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF] = Script(start={"ok": False, "error": LIMIT_WORDS})
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    v = verdict(_plan(), results)
    assert v.verdict == "could_not_measure"
    assert "core `uv run pytest` did not run" in v.reason


async def test_c6_a_landing_no_longer_running_starts_nothing_more(pool, monkeypatch):
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, _passing())

    async def hook(argv):
        if argv == RUFF:
            await landings.finish(pool, landing, "could_not_measure", reason="core restarted")

    agent.on_start = hook
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert [tuple(s["argv"]) for s in agent.caps("job.start")] == [RUFF]
    assert [r["suite"] for r in results] == ["ruff"]


async def test_c6_every_command_passing_is_green(pool, monkeypatch):
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, _passing(web=True))
    plan = _plan(web=True)
    results = await _run(pool, row, turn, landing, clock, plan)
    assert verdict(plan, results).verdict == "green"


async def test_c6_a_landing_id_that_is_not_a_uuid_still_runs_nothing_odd(pool, monkeypatch):
    # The landing row decides: an unknown landing is not running, so nothing starts.
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, _passing())
    results = await _run(pool, row, turn, uuid.uuid4(), clock, _plan())
    assert results == []
    assert agent.caps("job.start") == []


async def test_c2_the_agents_start_answer_moves_the_row(pool, monkeypatch):
    scripts = _passing()
    scripts[PYTEST].live = ("waiting_lock", "running")
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    await _run(pool, row, turn, landing, clock, _plan())
    ruff_id, core_id = (s["job_id"] for s in agent.caps("job.start"))
    assert agent.row_at_first_status == {ruff_id: "running", core_id: "waiting_lock"}


async def test_c5_a_job_that_ended_as_the_stop_arrived_is_read_as_finished(pool, monkeypatch):
    scripts = _passing()
    scripts[PYTEST] = Script(never_ends=True, stop_done=True, log=PASS_PYTEST)
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan(), ceiling_s=30.0)
    assert len(agent.caps("job.stop")) == 1
    assert results[1]["state"] == "done"
    assert results[1]["outcome"] == "passed", results[1]["why"]


async def test_c5_a_log_read_answered_at_another_byte_never_passes(pool, monkeypatch):
    log = _big_log("", "=== 9 passed in 300.0s ===\n", 600 * 1024)
    scripts = _passing()
    scripts[PYTEST] = Script(log=log, log_bad_offset=True)
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert results[1]["outcome"] == "could_not_measure"
    assert "its log could not be read" in results[1]["why"]
    assert "when byte 0 was asked" in results[1]["why"]


async def test_c5_a_log_of_another_job_never_passes(pool, monkeypatch):
    scripts = _passing()
    scripts[RUFF] = Script(log=PASS_RUFF, log_other_job=True)
    row, turn, landing, agent, clock = await _setup(pool, monkeypatch, scripts)
    results = await _run(pool, row, turn, landing, clock, _plan())
    assert results[0]["outcome"] == "could_not_measure"
    assert "its log could not be read" in results[0]["why"]
    assert "no byte range" in results[0]["why"]
