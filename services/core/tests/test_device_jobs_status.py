"""S30c T11 (2026-10-12): reading a job back, its log, and ending it.

device_job_start (T10) leaves a job running on a machine. Here she reads it:
device_job_status asks the agent's `job.status` NOW (never the stored row),
writes what the agent recorded onto that device's own device_jobs row, and —
once the job has ended — files a `run` fact (exit_code, argv, cwd, ran_in,
box, job) so tests_passed / ran_command read a job exactly as they read a
device_run. device_job_log reads its log by range; device_job_stop ends it.

Criteria (tracker .epics/s30c.md, ## T11):
  C1 registered and classified (registry, live_facts, capability coverage,
     the guard's `close` kind).
  C2 status reads the agent live and updates THAT device's row; no job ->
     job.list, nothing written.
  C3 job + run facts; the guard reads them (exit 0 stands, exit 1 corrected,
     running backs nothing).
  C4 unknown id, malformed id, an old agent, an unreadable record, admit.
  C5 log ranges.
  C6 stop.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app import chat, device_jobs, devices_ws, guards, live_facts, tools, traces
from app.tools.base import ToolContext
from tests.conftest import requires_db
from tests.test_capability_coverage import EXCUSED
from tests.test_devices_ws import (  # noqa: F401
    _clean_hub,
    _command_frames,
    _person,
)
from tests.test_outside_worktree_flag import _connect_host

pytestmark = requires_db

STATUS = "device_job_status"
LOG = "device_job_log"
STOP = "device_job_stop"
MINI = "Beelink Mini S"
OTHER = "studio-pc"
SUITE = ["uv", "run", "pytest", "-q"]
SUITE_CWD = "/srv/nova/.worktrees/nova-5d1e0a/services/core"
BOX = "nova-box-5d1e0a"
STARTED = "2026-10-12T09:15:02.123456Z"
ENDED = "2026-10-12T09:21:44Z"


def _record(job_id, state, *, exit_code=None, ran_in="box", reason="", log_bytes=91234):
    """The agent's statusMeta (caps/job.go) for a job."""
    meta = {
        "job": job_id,
        "state": state,
        "argv": SUITE,
        "cwd": SUITE_CWD,
        "ran_in": ran_in,
        "lock_waited_s": 12.5,
        "log_bytes": log_bytes,
    }
    if ran_in == "box":
        meta["box"] = BOX
    if state in ("running", "waiting_lock", "done", "stopped", "lost"):
        meta["started_at"] = STARTED
    if state in ("done", "stopped", "lost", "failed_to_start"):
        meta["ended_at"] = ENDED
    if exit_code is not None:
        meta["exit_code"] = exit_code
    if reason:
        meta["reason"] = reason
    return meta


def _answers(state, **kw):
    def answer(envelope):
        job_id = envelope["args"]["job_id"]
        words = f"job {job_id} {state}"
        if kw.get("exit_code") is not None:
            words += f" exit {kw['exit_code']}"
        return {
            "ok": True,
            "output": words,
            "exit_code": None,
            "meta": _record(job_id, state, **kw),
        }

    return answer


def _refused(error):
    def answer(envelope):
        return {"ok": False, "error": error, "exit_code": None}

    return answer


async def _turn(pool) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model) VALUES ('chat', NULL, 'm') RETURNING id"
    )


async def _device_id(pool, name):
    return await pool.fetchval("SELECT id FROM devices WHERE name = $1", name)


async def _job_row(pool, name, *, state="running", ran_in="box"):
    """A job device_job_start would have left on `name`'s row."""
    job_id = await device_jobs.insert(
        pool,
        device_id=await _device_id(pool, name),
        turn_id=None,
        argv=SUITE,
        cwd=SUITE_CWD,
        env=None,
        ran_in=ran_in,
        box=BOX if ran_in == "box" else None,
    )
    if state in device_jobs.STARTED_STATES:
        await device_jobs.mark_started(pool, job_id, state)
    return job_id


async def _call(pool, conn, device, tool, args, answer=None, *, span=False):
    """Dispatch `tool` (or chat._run_tool when span), answering every command
    frame with answer(envelope)."""
    person = await _person(pool)
    turn_id = await _turn(pool)
    facts: list[dict] = []
    ctx = ToolContext(
        app=None, person=person, workspace_root=Path("/tmp"), facts_sink=facts, turn_id=turn_id
    )

    async def responder():
        while True:
            frame = await conn.next_sent()
            if not isinstance(frame, dict) or frame.get("type") != "command":
                continue
            if answer is None:
                continue
            envelope = frame["envelope"]
            fields = dict(answer(envelope))
            meta = fields.pop("meta", None)
            reply = device.result(envelope, **fields)
            if meta is not None:
                reply["meta"] = meta
            conn.feed(reply)

    task = asyncio.create_task(responder())
    the_span = None
    try:
        if span:
            turn = traces.Turn(id=turn_id, started_at=datetime.now(UTC))
            call = chat.ToolCall(id="c1", name=tool, arguments=json.dumps(args))
            result, ok = await chat._run_tool(turn, ctx, call)
            (the_span,) = turn.spans
        else:
            result, ok = await tools.dispatch(tool, args, ctx)
    finally:
        task.cancel()
    return {
        "result": result,
        "ok": ok,
        "facts": facts,
        "sent": [f["envelope"] for f in _command_frames(conn)],
        "span": the_span,
    }


async def _mini(pool):
    device, conn, _task = await _connect_host(pool, name=MINI, hostname="beelink")
    return device, conn


def _job_facts(facts):
    return [f["job"] for f in facts if isinstance(f, dict) and isinstance(f.get("job"), dict)]


def _run_facts(facts):
    return [f for f in facts if isinstance(f, dict) and "run" in f]


# -- C1: registered and classified --------------------------------------------------


def test_c1_status_and_log_are_reads_only_with_their_schemas():
    status = tools.REGISTRY[STATUS]
    assert status.reads_only is True and status.ephemeral is True
    assert set(status.parameters["properties"]) == {"device", "job"}
    assert status.parameters["required"] == ["device"]
    log = tools.REGISTRY[LOG]
    assert log.reads_only is True and log.ephemeral is True
    assert set(log.parameters["properties"]) == {"device", "job", "offset", "length", "tail_bytes"}
    assert set(log.parameters["required"]) == {"device", "job"}
    for key in ("length", "tail_bytes"):
        assert log.parameters["properties"][key]["maximum"] == 262144
        assert log.parameters["properties"][key]["minimum"] == 0
    assert log.parameters["properties"]["offset"]["minimum"] == 0


def test_c1_stop_changes_something():
    stop = tools.REGISTRY[STOP]
    assert stop.reads_only is False and stop.ephemeral is False
    assert set(stop.parameters["required"]) == {"device", "job"}


def test_c1_the_descriptions_say_what_each_reads():
    assert "exit code" in tools.REGISTRY[STATUS].description
    assert "bytes" in tools.REGISTRY[LOG].description
    assert "stop" in tools.REGISTRY[STOP].description.lower()


def test_c1_live_facts_run_status_unasked_and_never_the_log():
    assert STATUS in live_facts.AUTO_RUN
    assert live_facts.may_run_unasked(STATUS) is None
    assert LOG not in live_facts.AUTO_RUN
    assert live_facts.NOT_AUTO_RUN[LOG].strip()
    assert live_facts.may_run_unasked(LOG) == live_facts.NOT_AUTO_RUN[LOG]
    assert live_facts.may_run_unasked(STOP) is not None
    assert STOP not in live_facts.AUTO_RUN and STOP not in live_facts.NOT_AUTO_RUN


def test_c1_capability_coverage_excuses_all_three():
    for name in (STATUS, LOG, STOP):
        assert "device_run" in EXCUSED[name], name


DELL = "DELL-XPS-8950"


def _guard_span(name, *, ok=True):
    from types import SimpleNamespace

    return SimpleNamespace(
        kind="tool", name=name, meta={"ok": ok, "args_redacted": {"device": DELL, "job": "a" * 12}}
    )


def _claim(reply, spans=()):
    return guards.device_completion_check(reply, list(spans), tools.tool_names(), (DELL,))


def test_c1_an_ok_stop_backs_a_stopped_claim_on_its_machine():
    reply = f"I stopped the test job on your {DELL}."
    claim = _claim(reply)
    assert claim is not None and STOP in claim.tools
    assert _claim(reply, [_guard_span(STOP)]) is None
    assert _claim(reply, [_guard_span(STOP, ok=False)]) is not None


@pytest.mark.parametrize(
    "reply",
    [
        f"I deleted the old logs on your {DELL}.",
        f"I ran the test suite on your {DELL}.",
        f"I've started the test suite on your {DELL}.",
    ],
)
def test_c1_a_stop_never_backs_another_action(reply):
    claim = _claim(reply, [_guard_span(STOP)])
    assert claim is not None, reply
    assert STOP not in claim.tools


# -- C2: status reads the agent live and updates the device's row ---------------------


async def test_c2_a_status_is_one_job_status_and_its_end_lands_on_the_row(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)
    out = await _call(
        pool, conn, device, STATUS, {"device": MINI, "job": job_id}, _answers("done", exit_code=3)
    )
    assert out["ok"] is True, out["result"]
    (envelope,) = out["sent"]
    assert envelope["capability"] == "job.status"
    assert envelope["args"] == {"job_id": job_id}
    row = await device_jobs.get(pool, job_id)
    assert row["state"] == "done"
    assert row["exit_code"] == 3
    assert row["started_at"] == datetime.fromisoformat(STARTED)
    assert row["ended_at"] == datetime.fromisoformat(ENDED)
    assert row["log_bytes"] == 91234
    text = out["result"]
    assert f"job {job_id} on {MINI}" in text
    assert "done" in text and "exit 3" in text
    assert f"box {BOX}" in text
    assert "91234 bytes" in text


async def test_c2_a_terminal_reason_and_a_null_exit_are_stored(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)
    why = "its wrapper (pid 812) is gone with no end recorded"
    out = await _call(
        pool,
        conn,
        device,
        STATUS,
        {"device": MINI, "job": job_id},
        _answers("lost", reason=why, log_bytes=0),
    )
    assert out["ok"] is True, out["result"]
    row = await device_jobs.get(pool, job_id)
    assert row["state"] == "lost" and row["exit_code"] is None
    assert row["reason"] == why and row["log_bytes"] == 0
    assert why in out["result"]


async def test_c2_a_live_state_moves_a_live_row(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI, state="waiting_lock")
    out = await _call(
        pool,
        conn,
        device,
        STATUS,
        {"device": MINI, "job": job_id},
        _answers("running", log_bytes=77),
    )
    assert out["ok"] is True, out["result"]
    row = await device_jobs.get(pool, job_id)
    assert row["state"] == "running"
    assert row["log_bytes"] == 77
    assert row["started_at"] == datetime.fromisoformat(STARTED)
    assert row["exit_code"] is None and row["ended_at"] is None
    assert "running" in out["result"] and "no exit code yet" in out["result"]


async def test_c2_a_live_state_never_reopens_an_ended_row(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)
    did = await _device_id(pool, MINI)
    frame = {
        "job_id": job_id,
        "state": "done",
        "exit_code": 0,
        "started_at": STARTED,
        "ended_at": ENDED,
        "log_bytes": 5,
        "reason": "",
    }
    assert await device_jobs.apply_frame(pool, did, frame, epoch=0) == device_jobs.STORED
    await _call(pool, conn, device, STATUS, {"device": MINI, "job": job_id}, _answers("running"))
    row = await device_jobs.get(pool, job_id)
    assert row["state"] == "done" and row["exit_code"] == 0 and row["log_bytes"] == 5


async def test_c2_another_devices_row_with_that_id_is_untouched(pool):
    await _connect_host(pool, name=OTHER, hostname="studio")
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, OTHER)
    out = await _call(
        pool, conn, device, STATUS, {"device": MINI, "job": job_id}, _answers("done", exit_code=0)
    )
    assert out["ok"] is True, out["result"]
    row = await device_jobs.get(pool, job_id)
    assert row["state"] == "running" and row["exit_code"] is None


async def test_c2_without_a_job_it_lists_and_writes_nothing(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)

    def answer(envelope):
        listed = _record(job_id, "done", exit_code=0)
        return {
            "ok": True,
            "output": f"{job_id} done exit 0  uv run pytest -q",
            "exit_code": None,
            "meta": {"jobs": [listed], "total": 1},
        }

    out = await _call(pool, conn, device, STATUS, {"device": MINI}, answer)
    assert out["ok"] is True, out["result"]
    (envelope,) = out["sent"]
    assert envelope["capability"] == "job.list"
    assert envelope["args"] == {}
    assert f"{job_id} done exit 0" in out["result"]
    assert MINI in out["result"]
    row = await device_jobs.get(pool, job_id)
    assert row["state"] == "running"
    assert _run_facts(out["facts"]) == []


# -- C3: facts, and the guard reading them ---------------------------------------------


async def test_c3_an_ended_job_files_one_job_fact_and_one_run_fact(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)
    out = await _call(
        pool, conn, device, STATUS, {"device": MINI, "job": job_id}, _answers("done", exit_code=0)
    )
    (job,) = _job_facts(out["facts"])
    assert job == {
        "id": job_id,
        "state": "done",
        "device": MINI,
        "argv": SUITE,
        "cwd": SUITE_CWD,
        "ran_in": "box",
        "box": BOX,
    }
    (run,) = _run_facts(out["facts"])
    assert run["run"] == {
        "exit_code": 0,
        "device": MINI,
        "argv": SUITE,
        "cwd": SUITE_CWD,
        "ran_in": "box",
        "box": BOX,
        "job": job_id,
    }
    assert run["target"] == "uv run pytest -q"


async def test_c3_a_host_job_fact_has_no_box(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI, ran_in="host")
    out = await _call(
        pool,
        conn,
        device,
        STATUS,
        {"device": MINI, "job": job_id},
        # 2026-10-12 (amended C3): was `stopped` exit 143; a stopped job files
        # no run fact now, so the host run fact is read from a job that ended.
        _answers("done", exit_code=2, ran_in="host"),
    )
    (job,) = _job_facts(out["facts"])
    assert job["ran_in"] == "host" and "box" not in job
    (run,) = _run_facts(out["facts"])
    assert run["run"]["exit_code"] == 2 and run["run"]["ran_in"] == "host"
    assert "box" not in run["run"]
    assert "ran_in host" in out["result"]


@pytest.mark.parametrize("state", ["running", "waiting_lock", "failed_to_start"])
async def test_c3_a_job_that_has_not_run_to_an_end_files_no_run_fact(pool, state):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)
    reason = "fork/exec uv: no such file" if state == "failed_to_start" else ""
    out = await _call(
        pool, conn, device, STATUS, {"device": MINI, "job": job_id}, _answers(state, reason=reason)
    )
    assert out["ok"] is True, out["result"]
    assert _run_facts(out["facts"]) == []
    (job,) = _job_facts(out["facts"])
    assert job["state"] == state
    if state == "waiting_lock":
        assert "Waiting for the CPU lock (waited 12.5 s)" in out["result"]
    if state == "running":
        assert "no exit code yet" in out["result"]


async def test_c3_a_lost_job_that_never_started_files_no_run_fact(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)

    def answer(envelope):
        meta = _record(envelope["args"]["job_id"], "lost", reason="its agent ended first")
        del meta["started_at"]
        return {"ok": True, "output": "lost", "exit_code": None, "meta": meta}

    out = await _call(pool, conn, device, STATUS, {"device": MINI, "job": job_id}, answer)
    assert out["ok"] is True, out["result"]
    assert _run_facts(out["facts"]) == []
    assert (await device_jobs.get(pool, job_id))["state"] == "lost"


async def _status_span(pool, state, exit_code=None):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)
    out = await _call(
        pool,
        conn,
        device,
        STATUS,
        {"device": MINI, "job": job_id},
        _answers(state, exit_code=exit_code),
        span=True,
    )
    return job_id, out["span"]


async def test_c3_all_tests_passed_after_an_exit_zero_job_stands(pool):
    job_id, span = await _status_span(pool, "done", 0)
    assert span.meta["job"] == job_id
    assert span.meta["ran_in"] == "box" and span.meta["box"] == BOX
    assert guards.narration_check("All tests passed.", [span]) is None


async def test_c3_all_tests_passed_after_an_exit_one_job_is_corrected(pool):
    _job_id, span = await _status_span(pool, "done", 1)
    correction = guards.narration_check("All tests passed.", [span])
    assert correction is not None
    assert correction.text == guards.TESTS_FAILED_RUN_TEXT.format(
        command="uv run pytest -q", outcome="exited 1"
    )


async def test_c3_a_running_job_backs_nothing(pool):
    _job_id, span = await _status_span(pool, "running")
    correction = guards.narration_check("All tests passed.", [span])
    assert correction is not None and correction.text == guards.TESTS_NO_RUNNER_TEXT


# Amended C3 (2026-10-12): only a job that ran to its end (`done`) files a run
# fact. A stopped job's exit code is the stop's (a runner that traps TERM exits
# 0), and a lost job's end is unknown: neither is a finished run.


@pytest.mark.parametrize(
    ("state", "exit_code"), [("stopped", 0), ("stopped", 143), ("lost", None), ("lost", 0)]
)
async def test_c3_a_stopped_or_lost_job_files_its_job_fact_and_no_run_fact(pool, state, exit_code):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)
    out = await _call(
        pool,
        conn,
        device,
        STATUS,
        {"device": MINI, "job": job_id},
        _answers(state, exit_code=exit_code, reason="ended early"),
    )
    assert out["ok"] is True, out["result"]
    (job,) = _job_facts(out["facts"])
    assert job["state"] == state and job["id"] == job_id
    assert _run_facts(out["facts"]) == []
    assert "did not run to its end" in out["result"]
    row = await device_jobs.get(pool, job_id)
    assert row["state"] == state and row["exit_code"] == exit_code


async def test_c3_a_done_job_says_nothing_about_not_running_to_its_end(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)
    out = await _call(
        pool, conn, device, STATUS, {"device": MINI, "job": job_id}, _answers("done", exit_code=0)
    )
    assert "did not run to its end" not in out["result"]


@pytest.mark.parametrize(("state", "exit_code"), [("stopped", 0), ("lost", None), ("lost", 0)])
async def test_c3_all_tests_passed_after_a_stopped_or_lost_job_is_corrected(pool, state, exit_code):
    _job_id, span = await _status_span(pool, state, exit_code)
    correction = guards.narration_check("All tests passed.", [span])
    assert correction is not None and correction.text == guards.TESTS_NO_RUNNER_TEXT


RAN_SUITE = "I ran `uv run pytest -q` on the Beelink."


async def test_c3_i_ran_the_suite_after_a_done_job_stands(pool):
    _job_id, span = await _status_span(pool, "done", 0)
    assert guards.narration_check(RAN_SUITE, [span]) is None


async def test_c3_i_ran_the_suite_after_a_stopped_exit_zero_job_is_corrected(pool):
    _job_id, span = await _status_span(pool, "stopped", 0)
    assert guards.narration_check(RAN_SUITE, [span]) is not None


async def test_c3_all_tests_passed_after_a_stop_with_exit_zero_is_corrected(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)
    out = await _call(
        pool,
        conn,
        device,
        STOP,
        {"device": MINI, "job": job_id},
        _answers("stopped", exit_code=0, reason="stopped on request"),
        span=True,
    )
    assert out["ok"] is True, out["result"]
    assert _run_facts(out["facts"]) == []
    correction = guards.narration_check("All tests passed.", [out["span"]])
    assert correction is not None and correction.text == guards.TESTS_NO_RUNNER_TEXT


# -- C4: what cannot be read says so ---------------------------------------------------


async def test_c4_an_unknown_id_quotes_the_agent(pool):
    device, conn = await _mini(pool)
    made_up = "0123456789ab"
    out = await _call(
        pool,
        conn,
        device,
        STATUS,
        {"device": MINI, "job": made_up},
        _refused(f"no job {made_up} on this device"),
    )
    assert out["ok"] is False
    assert f"{MINI}: no job {made_up} on this device" in out["result"]
    assert len(out["sent"]) == 1
    assert _run_facts(out["facts"]) == [] and _job_facts(out["facts"]) == []


async def test_c4_an_unknown_id_leaves_its_row_alone(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)
    out = await _call(
        pool,
        conn,
        device,
        STATUS,
        {"device": MINI, "job": job_id},
        _refused(f"no job {job_id} on this device"),
    )
    assert out["ok"] is False
    row = await device_jobs.get(pool, job_id)
    assert row["state"] == "running"


async def test_c4_a_malformed_id_is_no_job_with_the_agents_words(pool):
    device, conn = await _mini(pool)
    words = 'job id "job-42" is not 12 lowercase hex characters'
    out = await _call(
        pool, conn, device, STATUS, {"device": MINI, "job": "job-42"}, _refused(words)
    )
    assert out["ok"] is False
    assert "no job job-42 on this device" in out["result"]
    assert words in out["result"]
    (envelope,) = out["sent"]
    assert envelope["args"] == {"job_id": "job-42"}


@pytest.mark.parametrize("tool", [STATUS, LOG, STOP])
async def test_c4_an_agent_that_predates_jobs_is_told_to_update(pool, tool):
    device, conn = await _mini(pool)
    out = await _call(
        pool,
        conn,
        device,
        tool,
        {"device": MINI, "job": "aaaaaaaaaaaa"},
        _refused("unknown capability: job.status"),
    )
    assert out["ok"] is False
    assert f"{MINI}'s agent predates jobs — update it with machine_update" in out["result"]


async def test_c4_a_record_core_cannot_read_is_an_error_and_lands_nowhere(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)

    def answer(envelope):
        meta = _record(envelope["args"]["job_id"], "done", exit_code=0)
        meta["exit_code"] = "zero"
        return {"ok": True, "output": "done", "exit_code": None, "meta": meta}

    out = await _call(pool, conn, device, STATUS, {"device": MINI, "job": job_id}, answer)
    assert out["ok"] is False
    assert "exit_code" in out["result"]
    assert _run_facts(out["facts"]) == []
    row = await device_jobs.get(pool, job_id)
    assert row["state"] == "running"


async def test_c4_a_record_for_another_job_is_an_error(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)

    def answer(envelope):
        meta = _record("bbbbbbbbbbbb", "done", exit_code=0)
        return {"ok": True, "output": "done", "exit_code": None, "meta": meta}

    out = await _call(pool, conn, device, STATUS, {"device": MINI, "job": job_id}, answer)
    assert out["ok"] is False
    assert _run_facts(out["facts"]) == []
    assert (await device_jobs.get(pool, job_id))["state"] == "running"


async def test_c4_an_unknown_or_offline_device_sends_nothing(pool):
    device, conn = await _mini(pool)
    out = await _call(pool, conn, device, STATUS, {"device": "nope", "job": "a" * 12})
    assert out["ok"] is False and out["sent"] == []
    devices_ws.hub._conns.clear()
    out = await _call(pool, conn, device, STATUS, {"device": MINI, "job": "a" * 12})
    assert out["ok"] is False and "not connected" in out["result"]
    assert out["sent"] == []


# Amended C4 (2026-10-12, VERIFY gap): a STORED row is never read back as the
# job's state when its agent cannot be read — status is the agent, now.


async def _stored(pool, stored):
    """A job row on MINI left `running`, or `done` exit 0 by an earlier read."""
    job_id = await _job_row(pool, MINI)
    if stored == "done":
        await device_jobs.apply_status(
            pool, await _device_id(pool, MINI), _record(job_id, "done", exit_code=0)
        )
    return job_id, dict(await device_jobs.get(pool, job_id))


def _says_nothing_stored(out, job_id, stored):
    assert out["ok"] is False
    assert _run_facts(out["facts"]) == [] and _job_facts(out["facts"]) == []
    text = out["result"]
    assert stored not in text and "exit 0" not in text and "(stored)" not in text
    assert f"job {job_id} on" not in text


@pytest.mark.parametrize("stored", ["running", "done"])
async def test_c4_an_offline_agent_never_reads_back_the_stored_row(pool, stored):
    device, conn = await _mini(pool)
    job_id, before = await _stored(pool, stored)
    devices_ws.hub._conns.clear()
    out = await _call(pool, conn, device, STATUS, {"device": MINI, "job": job_id})
    _says_nothing_stored(out, job_id, stored)
    assert "not connected" in out["result"]
    assert out["sent"] == []
    assert dict(await device_jobs.get(pool, job_id)) == before


@pytest.mark.parametrize("stored", ["running", "done"])
async def test_c4_an_agent_that_never_answers_never_reads_back_the_stored_row(
    pool, monkeypatch, stored
):
    from app.tools import devices as device_tools

    monkeypatch.setattr(device_tools, "COMMAND_TIMEOUT_SECONDS", 0.3)
    device, conn = await _mini(pool)
    job_id, before = await _stored(pool, stored)
    out = await _call(pool, conn, device, STATUS, {"device": MINI, "job": job_id}, None)
    _says_nothing_stored(out, job_id, stored)
    assert "did not answer" in out["result"]
    (envelope,) = out["sent"]
    assert envelope["capability"] == "job.status"
    assert dict(await device_jobs.get(pool, job_id)) == before


# -- C5: the log ------------------------------------------------------------------------


def _log_answer(content, *, total, offset):
    def answer(envelope):
        meta = {
            "job": envelope["args"]["job_id"],
            "bytes_total": total,
            "offset": offset,
            "length": len(content.encode()),
        }
        return {"ok": True, "output": content, "exit_code": None, "meta": meta}

    return answer


async def test_c5_a_range_read_sends_only_its_args_and_names_the_bytes(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)
    out = await _call(
        pool,
        conn,
        device,
        LOG,
        {"device": MINI, "job": job_id, "offset": 4096, "length": 13},
        _log_answer("12 passed in ", total=91234, offset=4096),
    )
    assert out["ok"] is True, out["result"]
    (envelope,) = out["sent"]
    assert envelope["capability"] == "job.log"
    assert envelope["args"] == {"job_id": job_id, "offset": 4096, "length": 13}
    assert "bytes 4096-4109 of 91234" in out["result"]
    assert "more follows: read on by offset" in out["result"]
    assert "12 passed in " in out["result"]
    assert _run_facts(out["facts"]) == []


async def test_c5_a_tail_read_and_a_default_read(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)
    out = await _call(
        pool,
        conn,
        device,
        LOG,
        {"device": MINI, "job": job_id, "tail_bytes": 7},
        _log_answer("failed\n", total=500, offset=493),
    )
    assert out["sent"][0]["args"] == {"job_id": job_id, "tail_bytes": 7}
    assert "bytes 493-500 of 500" in out["result"]
    assert "more follows" not in out["result"]
    out = await _call(
        pool, conn, device, LOG, {"device": MINI, "job": job_id}, _log_answer("", total=0, offset=0)
    )
    assert out["sent"][-1]["args"] == {"job_id": job_id}
    assert "of 0" in out["result"] and "empty" in out["result"]


async def test_c5_a_range_and_a_tail_together_is_an_error_before_the_send(pool):
    device, conn = await _mini(pool)
    out = await _call(
        pool,
        conn,
        device,
        LOG,
        {"device": MINI, "job": "a" * 12, "offset": 0, "tail_bytes": 10},
        _log_answer("x", total=1, offset=0),
    )
    assert out["ok"] is False
    assert "tail_bytes" in out["result"] and "offset" in out["result"]
    assert out["sent"] == []


async def test_c5_an_agent_refusal_is_an_error_with_its_words(pool):
    device, conn = await _mini(pool)
    words = "job.log reads at most 262144 bytes per read; ask for less and read on by offset"
    out = await _call(
        pool, conn, device, LOG, {"device": MINI, "job": "a" * 12, "offset": 9}, _refused(words)
    )
    assert out["ok"] is False
    assert f"{MINI}: {words}" in out["result"]


# -- C6: stop ---------------------------------------------------------------------------


async def test_c6_a_stop_ends_the_row_and_files_its_facts(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)
    out = await _call(
        pool,
        conn,
        device,
        STOP,
        {"device": MINI, "job": job_id},
        _answers("stopped", exit_code=143, reason="stopped on request"),
    )
    assert out["ok"] is True, out["result"]
    (envelope,) = out["sent"]
    assert envelope["capability"] == "job.stop"
    assert envelope["args"] == {"job_id": job_id}
    row = await device_jobs.get(pool, job_id)
    assert row["state"] == "stopped" and row["exit_code"] == 143
    assert row["reason"] == "stopped on request"
    (job,) = _job_facts(out["facts"])
    assert job["state"] == "stopped"
    # 2026-10-12 (amended C6): a stopped job did not run to its end — its job
    # fact is filed, never a run fact (was: run fact with exit 143).
    assert _run_facts(out["facts"]) == []
    assert "stopped" in out["result"] and job_id in out["result"]
    assert "did not run to its end" in out["result"]


async def test_c6_a_refused_stop_is_an_error_and_the_row_stays(pool):
    device, conn = await _mini(pool)
    job_id = await _job_row(pool, MINI)
    words = f"asked job {job_id} to stop, but it recorded no end within 10s; the stop request stays"
    out = await _call(pool, conn, device, STOP, {"device": MINI, "job": job_id}, _refused(words))
    assert out["ok"] is False
    assert f"{MINI}: {words}" in out["result"]
    assert (await device_jobs.get(pool, job_id))["state"] == "running"
    assert _run_facts(out["facts"]) == []
