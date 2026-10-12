"""S30c T10 (2026-10-12): device_job_start — work that outlives her turn.

She hands argv (+cwd, env) to a paired machine's agent as a job: core writes
the device_jobs row FIRST (state `starting`, the turn that started it, env
names only), then sends the agent's `job.start` with that row's id. A cwd
inside a change worktree on the repo machine runs in that change's box (the
same route as device_run, spec s32 §4.4) — never a host fallback. The result
says where it runs and whether it survives the agent; a `job` fact is filed,
never a `run` fact (a started job has no exit code yet).

Criteria (tracker .epics/s30c.md, ## T10):
  C1 registered, not reads_only, its schema, EXCUSED in capability coverage.
  C2 host job: one job.start, the row written before the send with the same
     id + turn_id, moved only off `starting`; survives_agent stated.
  C3 box route (box args, ran_in box), owner's host environment, @folder cwd.
  C4 one job fact, no run fact; lifted to the span; env values never land.
  C5 an old agent, any other refusal, no answer.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app import chat, device_jobs, devices_ws, tools, traces
from app.tools import devices as device_tools
from app.tools.base import ToolContext
from tests.conftest import requires_db
from tests.test_capability_coverage import EXCUSED
from tests.test_device_run_box import (
    BOX,
    CHANGE,
    CWD,
    HOST,
    LIMITS,
    NAME,
    OUTSIDE_WARNING,
    REPO,
    _limits,
    _repo_row,
    recorded,  # noqa: F401
)
from tests.test_devices_ws import (  # noqa: F401
    _clean_hub,
    _command_frames,
    _person,
    _wait_for_facts_key,
)
from tests.test_outside_worktree_flag import _connect_host

pytestmark = requires_db

TOOL = "device_job_start"
LAPTOP = "laptop"
SECRET = "t10-secret-value-7c1e"
ARGV = ["sleep", "200"]
SUITE = ["uv", "run", "pytest"]
HOST_ENV_WORDS = "(on the host: this repo's environment is host, set by the owner)"


def _started(state="running", *, survives=True, why=None, ran_in="host", **extra):
    """An agent that started it (caps/job.go jobStart's meta)."""

    def answer(envelope):
        meta = {
            "job": envelope["args"]["job_id"],
            "state": state,
            "survives_agent": survives,
            "detach": "setsid",
            "ran_in": ran_in,
            "pid": 4242,
            **extra,
        }
        if why is not None:
            meta["why"] = why
        return {"ok": True, "output": f"started job {meta['job']}", "exit_code": None, "meta": meta}

    return answer


def _refused(error, meta=None):
    def answer(envelope):
        out = {"ok": False, "error": error, "exit_code": None}
        if meta is not None:
            out["meta"] = meta
        return out

    return answer


async def _turn(pool) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model) VALUES ('chat', NULL, 'm') RETURNING id"
    )


async def _rows(pool) -> list[dict]:
    return [dict(r) for r in await pool.fetch("SELECT * FROM device_jobs ORDER BY created_at")]


async def _device_id(pool, name):
    return await pool.fetchval("SELECT id FROM devices WHERE name = $1", name)


async def _start(pool, conn, device, args, answer=None, *, span=False, before_answer=None):
    """Dispatch device_job_start (or chat._run_tool when span) with a real
    turn id, answering every command frame with answer(envelope). The row
    each envelope's job_id names is read AT THE SEND, before the answer.
    Returns a dict: result, ok, facts, sent (envelopes), at_send (rows read
    when each frame was sent), span, turn_id."""
    person = await _person(pool)
    turn_id = await _turn(pool)
    facts: list[dict] = []
    at_send: list[dict | None] = []
    ctx = ToolContext(
        app=None, person=person, workspace_root=Path("/tmp"), facts_sink=facts, turn_id=turn_id
    )

    async def responder():
        while True:
            frame = await conn.next_sent()
            if not isinstance(frame, dict) or frame.get("type") != "command":
                continue
            envelope = frame["envelope"]
            at_send.append(await device_jobs.get(pool, envelope["args"].get("job_id")))
            if before_answer is not None:
                await before_answer(envelope)
            if answer is None:
                continue
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
            call = chat.ToolCall(id="c1", name=TOOL, arguments=json.dumps(args))
            result, ok = await chat._run_tool(turn, ctx, call)
            (the_span,) = turn.spans
        else:
            result, ok = await tools.dispatch(TOOL, args, ctx)
    finally:
        task.cancel()
    return {
        "result": result,
        "ok": ok,
        "facts": facts,
        "sent": [f["envelope"] for f in _command_frames(conn)],
        "at_send": at_send,
        "span": the_span,
        "turn_id": turn_id,
    }


async def _laptop(pool):
    device, conn, _task = await _connect_host(pool, name=LAPTOP, hostname="laptop-host")
    return device, conn


def _job_facts(facts):
    return [f["job"] for f in facts if isinstance(f, dict) and isinstance(f.get("job"), dict)]


def _run_facts(facts):
    return [f for f in facts if isinstance(f, dict) and "run" in f]


# -- C1: registered and classified ------------------------------------------------


def test_c1_registered_not_reads_only_with_its_schema():
    tool = tools.REGISTRY[TOOL]
    assert tool.reads_only is False
    assert tool.ephemeral is False
    params = tool.parameters
    assert set(params["properties"]) == {"device", "argv", "cwd", "env"}
    assert set(params["required"]) == {"device", "argv"}
    assert params["additionalProperties"] is False
    assert params["properties"]["argv"]["minItems"] == 1
    assert params["properties"]["argv"]["items"] == {"type": "string"}
    assert params["properties"]["env"]["additionalProperties"] == {"type": "string"}


def test_c1_the_description_says_it_outlives_the_turn_and_where_box_jobs_run():
    words = tools.REGISTRY[TOOL].description
    assert "outlive" in words
    assert "box" in words and ".worktrees/nova-" in words


def test_c1_capability_coverage_excuses_it_with_device_runs_row():
    assert "device_run" in EXCUSED[TOOL] and "can't run commands" in EXCUSED[TOOL]


# -- C2: a host job ------------------------------------------------------------------


async def test_c2_a_host_job_is_one_job_start_with_its_row_written_first(pool):
    device, conn = await _laptop(pool)
    args = {"device": LAPTOP, "argv": ARGV, "cwd": "/srv/work", "env": {"NOVA_X": SECRET}}
    out = await _start(pool, conn, device, args, _started())
    assert out["ok"] is True, out["result"]
    (envelope,) = out["sent"]
    assert envelope["capability"] == "job.start"
    job_id = envelope["args"]["job_id"]
    assert device_jobs.valid_id(job_id)
    assert envelope["args"] == {
        "job_id": job_id,
        "argv": ARGV,
        "cwd": "/srv/work",
        "env": {"NOVA_X": SECRET},
    }
    (row,) = out["at_send"]
    assert row is not None, "the row must exist before job.start is sent"
    assert row["state"] == "starting"
    assert row["turn_id"] == out["turn_id"]
    assert row["device_id"] == await _device_id(pool, LAPTOP)
    assert row["argv"] == ARGV
    assert row["cwd"] == "/srv/work"
    assert row["env_keys"] == ["NOVA_X"]
    assert row["ran_in"] == "host" and row["box"] is None
    after = await device_jobs.get(pool, job_id)
    assert after["state"] == "running"
    assert f"started job {job_id} on {LAPTOP} (ran_in host)" in out["result"]
    assert "outlives this turn and the agent" in out["result"]
    assert SECRET not in out["result"]


async def test_c2_without_cwd_or_env_the_args_carry_neither(pool):
    device, conn = await _laptop(pool)
    out = await _start(pool, conn, device, {"device": LAPTOP, "argv": ARGV}, _started())
    (envelope,) = out["sent"]
    assert set(envelope["args"]) == {"job_id", "argv"}
    (row,) = await _rows(pool)
    assert row["cwd"] is None and row["env_keys"] == []
    assert row["id"] == envelope["args"]["job_id"]


async def test_c2_not_surviving_the_agent_is_stated_with_why(pool):
    device, conn = await _laptop(pool)
    why = "systemd-run --user failed: no user bus; a restart of novad's service ends the job"
    out = await _start(
        pool, conn, device, {"device": LAPTOP, "argv": ARGV}, _started(survives=False, why=why)
    )
    assert out["ok"] is True
    assert "survives_agent: false" in out["result"]
    assert why in out["result"]
    assert "outlives this turn and the agent" not in out["result"]


async def test_c2_an_agent_that_does_not_say_whether_it_survives_is_not_read_as_surviving(pool):
    device, conn = await _laptop(pool)

    def answer(envelope):
        meta = {"job": envelope["args"]["job_id"], "state": "running", "ran_in": "host"}
        return {"ok": True, "output": "", "exit_code": None, "meta": meta}

    out = await _start(pool, conn, device, {"device": LAPTOP, "argv": ARGV}, answer)
    assert out["ok"] is True
    assert "outlives this turn and the agent" not in out["result"]
    assert "not confirmed" in out["result"]


async def test_c2_a_terminal_frame_stored_before_the_answer_is_kept(pool):
    device, conn = await _laptop(pool)
    did = await _device_id(pool, LAPTOP)

    async def ended_first(envelope):
        frame = {
            "type": "job",
            "job_id": envelope["args"]["job_id"],
            "state": "done",
            "exit_code": 0,
            "started_at": "2026-10-12T09:00:00Z",
            "ended_at": "2026-10-12T09:00:01Z",
            "log_bytes": 3,
            "reason": "",
        }
        assert await device_jobs.apply_frame(pool, did, frame, epoch=0) == device_jobs.STORED

    out = await _start(
        pool,
        conn,
        device,
        {"device": LAPTOP, "argv": ["true"]},
        _started(),
        before_answer=ended_first,
    )
    assert out["ok"] is True
    (row,) = await _rows(pool)
    assert row["state"] == "done" and row["exit_code"] == 0


async def test_c2_a_waiting_lock_answer_is_stored(pool):
    device, conn = await _laptop(pool)
    await _start(pool, conn, device, {"device": LAPTOP, "argv": ARGV}, _started("waiting_lock"))
    (row,) = await _rows(pool)
    assert row["state"] == "waiting_lock"


async def test_c2_an_unknown_device_sends_nothing_and_writes_no_row(pool):
    device, conn = await _laptop(pool)
    out = await _start(pool, conn, device, {"device": "nope", "argv": ARGV}, _started())
    assert out["ok"] is False
    assert out["sent"] == []
    assert await _rows(pool) == []


async def test_c2_an_offline_device_sends_nothing_and_writes_no_row(pool):
    device, conn = await _laptop(pool)
    devices_ws.hub._conns.clear()
    out = await _start(pool, conn, device, {"device": LAPTOP, "argv": ARGV}, _started())
    assert out["ok"] is False
    assert "not connected" in out["result"]
    assert out["sent"] == []
    assert await _rows(pool) == []


# -- C3: the box route, the owner's host, an @folder ---------------------------------


@pytest.mark.usefixtures("recorded")
async def test_c3_a_worktree_cwd_starts_the_job_in_its_box(pool):
    await _repo_row(pool)
    await _limits(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    out = await _start(
        pool,
        conn,
        device,
        {"device": NAME, "argv": SUITE, "cwd": CWD},
        _started("waiting_lock", ran_in="box", box=BOX, heavy=True),
    )
    assert out["ok"] is True, out["result"]
    (envelope,) = out["sent"]
    assert envelope["capability"] == "job.start"
    job_id = envelope["args"]["job_id"]
    assert envelope["args"] == {
        "job_id": job_id,
        "argv": SUITE,
        "cwd": CWD,
        "change": CHANGE,
        "checkout": REPO,
        "branch": "trunk",
        "limits": LIMITS,
    }
    (row,) = out["at_send"]
    assert row["ran_in"] == "box" and row["box"] == BOX
    assert (await device_jobs.get(pool, job_id))["state"] == "waiting_lock"
    assert f"started job {job_id} on {NAME} (ran_in box {BOX})" in out["result"]


@pytest.mark.usefixtures("recorded")
async def test_c3_a_box_that_cannot_start_is_an_error_and_never_a_host_start(pool):
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    error = f"cannot start the box {BOX}: image missing — nothing was started"
    out = await _start(
        pool, conn, device, {"device": NAME, "argv": SUITE, "cwd": CWD}, _refused(error)
    )
    assert out["ok"] is False
    assert error in out["result"]
    assert [e["capability"] for e in out["sent"]] == ["job.start"]
    (row,) = await _rows(pool)
    assert row["state"] == "failed_to_start" and row["ran_in"] == "box"
    assert error in row["reason"]


@pytest.mark.usefixtures("recorded")
async def test_c3_the_owners_host_environment_starts_it_on_the_host_and_says_so(pool):
    await _repo_row(pool, environment="host")
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    out = await _start(pool, conn, device, {"device": NAME, "argv": SUITE, "cwd": CWD}, _started())
    assert out["ok"] is True
    (envelope,) = out["sent"]
    assert set(envelope["args"]) == {"job_id", "argv", "cwd"}
    (row,) = await _rows(pool)
    assert row["ran_in"] == "host" and row["box"] is None
    assert HOST_ENV_WORDS in out["result"]


@pytest.mark.usefixtures("recorded")
async def test_c3_the_checkout_itself_runs_on_the_host_flagged(pool):
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    out = await _start(
        pool,
        conn,
        device,
        {"device": NAME, "argv": SUITE, "cwd": f"{REPO}/services/core"},
        _started(),
    )
    assert out["ok"] is True
    assert set(out["sent"][0]["args"]) == {"job_id", "argv", "cwd"}
    assert OUTSIDE_WARNING in out["result"]
    assert {"outside_worktree": REPO, "tool": TOOL} in out["facts"]


async def test_c3_an_at_folder_cwd_is_refused_before_anything(pool):
    device, conn = await _laptop(pool)
    # A folder the agent DID report: device_run would send it for the machine
    # to resolve; job.start does not resolve @folders, so a job refuses it.
    conn.feed({"type": "facts", "folders": {"home": "/home/sam"}})
    await _wait_for_facts_key(pool, await _device_id(pool, LAPTOP), "folders")
    out = await _start(
        pool, conn, device, {"device": LAPTOP, "argv": ARGV, "cwd": "@home/work"}, _started()
    )
    assert out["ok"] is False
    assert "absolute path" in out["result"]
    assert out["sent"] == []
    assert await _rows(pool) == []


async def test_c3_a_relative_cwd_is_refused_before_anything(pool):
    device, conn = await _laptop(pool)
    out = await _start(
        pool, conn, device, {"device": LAPTOP, "argv": ARGV, "cwd": "work"}, _started()
    )
    assert out["ok"] is False
    assert out["sent"] == []
    assert await _rows(pool) == []


# -- C4: facts, the span, env -------------------------------------------------------


async def test_c4_one_job_fact_and_no_run_fact(pool):
    device, conn = await _laptop(pool)
    out = await _start(
        pool, conn, device, {"device": LAPTOP, "argv": ARGV, "cwd": "/srv/work"}, _started()
    )
    job_id = out["sent"][0]["args"]["job_id"]
    assert _job_facts(out["facts"]) == [
        {
            "id": job_id,
            "state": "running",
            "device": LAPTOP,
            "argv": ARGV,
            "cwd": "/srv/work",
            "ran_in": "host",
        }
    ]
    assert _run_facts(out["facts"]) == []


@pytest.mark.usefixtures("recorded")
async def test_c4_a_box_job_fact_names_its_box(pool):
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    out = await _start(
        pool,
        conn,
        device,
        {"device": NAME, "argv": SUITE, "cwd": CWD},
        _started(ran_in="box", box=BOX),
    )
    (fact,) = _job_facts(out["facts"])
    assert fact["ran_in"] == "box" and fact["box"] == BOX


async def test_c4_a_refused_start_files_a_failed_to_start_job_fact(pool):
    device, conn = await _laptop(pool)
    out = await _start(
        pool,
        conn,
        device,
        {"device": LAPTOP, "argv": ARGV},
        _refused("job.start needs a string 'job_id'; nothing was started"),
    )
    (fact,) = _job_facts(out["facts"])
    assert fact["state"] == "failed_to_start"
    assert _run_facts(out["facts"]) == []


@pytest.mark.usefixtures("recorded")
async def test_c4_the_span_carries_the_job_and_where_and_never_an_env_value(pool):
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    out = await _start(
        pool,
        conn,
        device,
        {"device": NAME, "argv": SUITE, "cwd": CWD, "env": {"GH_TOKEN": SECRET}},
        _started(ran_in="box", box=BOX),
        span=True,
    )
    assert out["ok"] is True, out["result"]
    span = out["span"]
    job_id = out["sent"][0]["args"]["job_id"]
    assert span.meta["job"] == job_id
    assert span.meta["ran_in"] == "box" and span.meta["box"] == BOX
    dumped = json.dumps(span.meta, default=str)
    assert SECRET not in dumped
    assert span.meta["args_redacted"]["env"] == {"GH_TOKEN": f"<masked:{len(SECRET)} chars>"}
    (row,) = await _rows(pool)
    assert SECRET not in json.dumps(row, default=str)
    assert SECRET not in json.dumps(out["facts"], default=str)


async def test_c4_a_host_job_span_says_host(pool):
    device, conn = await _laptop(pool)
    out = await _start(pool, conn, device, {"device": LAPTOP, "argv": ARGV}, _started(), span=True)
    assert out["span"].meta["ran_in"] == "host"
    assert "box" not in out["span"].meta
    assert out["span"].meta["job"] == out["sent"][0]["args"]["job_id"]


@pytest.mark.parametrize(
    "env",
    [f"A={SECRET}", ["A"], {"A": 1}, {"1X": SECRET}, {"A=B": SECRET}, {f"T {SECRET}": "v"}],
)
async def test_c4_a_bad_env_is_refused_before_the_row_and_the_wire(pool, env):
    device, conn = await _laptop(pool)
    out = await _start(pool, conn, device, {"device": LAPTOP, "argv": ARGV, "env": env}, _started())
    assert out["ok"] is False
    assert "env" in out["result"]
    if isinstance(env, dict):
        # (a string or a list is the schema's refusal, before the executor)
        assert "nothing was started" in out["result"]
    assert SECRET not in out["result"]
    assert out["sent"] == []
    assert await _rows(pool) == []


async def test_c4_the_executor_refuses_a_bad_env_without_the_schema(pool):
    device, conn = await _laptop(pool)
    person = await _person(pool)
    ctx = ToolContext(app=None, person=person, workspace_root=Path("/tmp"), facts_sink=[])
    with pytest.raises(device_tools.ToolFailure, match="env"):
        await tools.REGISTRY[TOOL].executor({"device": LAPTOP, "argv": ARGV, "env": {"A": 1}}, ctx)
    assert _command_frames(conn) == []
    assert await _rows(pool) == []


# -- C5: an old agent, a refusal, no answer -------------------------------------------


async def test_c5_an_agent_that_predates_jobs_is_told_to_update(pool):
    device, conn = await _laptop(pool)
    out = await _start(
        pool,
        conn,
        device,
        {"device": LAPTOP, "argv": ARGV},
        _refused('unknown capability "job.start"'),
    )
    assert out["ok"] is False
    assert (
        f"{LAPTOP}'s agent predates jobs — update it with machine_update; nothing was started"
        in out["result"]
    )
    (row,) = await _rows(pool)
    assert row["state"] == "failed_to_start"
    assert row["reason"] and "predates jobs" in row["reason"]


async def test_c5_any_other_refusal_is_failed_to_start_with_the_agents_reason(pool):
    device, conn = await _laptop(pool)
    reason = 'exec: "nosuch": executable file not found in $PATH'
    out = await _start(
        pool,
        conn,
        device,
        {"device": LAPTOP, "argv": ["nosuch"]},
        _refused(
            f"job abc failed to start: {reason}",
            meta={"state": "failed_to_start", "reason": reason},
        ),
    )
    assert out["ok"] is False
    assert f"{LAPTOP}: job abc failed to start: {reason}" in out["result"]
    (row,) = await _rows(pool)
    assert row["state"] == "failed_to_start"
    assert reason in row["reason"]


async def test_c5_no_answer_leaves_the_row_starting_and_says_it_is_not_confirmed(pool, monkeypatch):
    monkeypatch.setattr(device_tools, "COMMAND_TIMEOUT_SECONDS", 0.3)
    device, conn = await _laptop(pool)
    out = await _start(pool, conn, device, {"device": LAPTOP, "argv": ARGV}, None)
    assert out["ok"] is False
    assert "not confirmed" in out["result"]
    (row,) = await _rows(pool)
    assert row["state"] == "starting"
    assert row["reason"] and "not confirmed" in row["reason"]


# -- C6 (amended in GREEN, 2026-10-12): the device-completion guard -------------------

DELL = "DELL-XPS-8950"


def _guard_span(name: str, *, ok: bool = True):
    from types import SimpleNamespace

    return SimpleNamespace(
        kind="tool",
        name=name,
        meta={"ok": ok, "args_redacted": {"device": DELL, "argv": SUITE}},
    )


def _claim(reply: str, spans=()):
    from app import guards

    return guards.device_completion_check(reply, list(spans), tools.tool_names(), (DELL,))


def test_c6_an_ok_job_start_backs_a_started_claim_on_its_machine():
    reply = f"I've started the test suite on your {DELL}."
    claim = _claim(reply)
    assert claim is not None and "device_job_start" in claim.tools
    assert _claim(reply, [_guard_span(TOOL)]) is None


def test_c6_a_failed_job_start_backs_nothing():
    reply = f"I've started the test suite on your {DELL}."
    assert _claim(reply, [_guard_span(TOOL, ok=False)]) is not None


@pytest.mark.parametrize(
    "reply",
    [f"I deleted the old logs on your {DELL}.", f"I ran the test suite on your {DELL}."],
)
def test_c6_a_job_start_never_backs_a_finished_action(reply):
    claim = _claim(reply, [_guard_span(TOOL)])
    assert claim is not None, reply
    assert "device_job_start" not in claim.tools
