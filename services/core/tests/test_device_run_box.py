"""T9 (S32.2, 2026-10-11): device_run routes a change worktree's command into
its sealed box (spec docs/plans/rebuild/s32/spec.md §4.4).

On the repo machine, a cwd inside <checkout>/.worktrees/nova-<id> is sent as
the agent's `box.exec` (novad runs it by docker exec in nova-box-<id>, started
if stopped); every other cwd runs on the host as today. The result and the
span say where it ran. A box that cannot start is an Error naming why — never
a second send to the host. outside_worktree is unchanged.

Criteria (tracker .epics/s32-2.md, ## T9):
  C1 repo machine + worktree cwd + environment box -> exactly one box.exec
     {argv, cwd, change, checkout, branch, limits(live)}; no shell.exec.
  C2 branch = the repo's default branch (code_repos.default_branch, else the
     base start_change resolves), never the change's nova/<id>-* branch.
  C3 everything else on the host as today, ran_in host; environment host says
     so; elevated in a worktree is admin.exec.
  C4 box result words; any ok:false is an Error with no second command; an
     old agent is told to update.
  C5 the run fact gains ran_in (+ box); chat._run_tool lifts them to the span.
  C6 other-change and outside_worktree warnings unchanged.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime

import pytest

from app import chat, code_repos, guards, tools, traces
from tests.conftest import requires_db
from tests.test_devices_ws import _clean_hub, _command_frames, _ctx, _person  # noqa: F401
from tests.test_outside_worktree_flag import _connect_host

pytestmark = requires_db

REPO = "/home/jeremy/workspace/nova"
HOST = "mini-pc"
NAME = "Beelink Mini S"
CHANGE = "a1b2c3"
WT = f"{REPO}/.worktrees/nova-{CHANGE}"
BOX = f"nova-box-{CHANGE}"
ARGV = ["uv", "run", "pytest", "tests/test_x.py", "-q"]
CWD = f"{WT}/services/core"
# Non-default limits, written through the settings table: what is sent must be
# what is stored now, not the defaults (2/3/512/2).
LIMITS = {"cpus": 3, "memory_gb": 5, "pids": 700, "max_running": 4}
OUTSIDE_WARNING = (
    f"Warning: this touched the live checkout {REPO}, not a worktree of yours — start a "
    "change with start_change and work inside its .worktrees/nova-<id>."
)
HOST_ENV_WORDS = "(on the host: this repo's environment is host, set by the owner)"
ORIGIN_HEAD = ["git", "-C", REPO, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]


@pytest.fixture
def recorded(monkeypatch):
    monkeypatch.setenv("NOVA_CHECKOUT", REPO)
    monkeypatch.setenv("NOVA_REPO_HOST", HOST)
    monkeypatch.delenv(code_repos.REPO_BRANCH_ENV, raising=False)


async def _repo_row(pool, *, branch: str | None = "trunk", environment: str = "box"):
    await pool.execute(
        "INSERT INTO code_repos (name, machine, checkout, default_branch, environment) "
        "VALUES ('nova', $1, $2, $3, $4)",
        HOST,
        REPO,
        branch,
        environment,
    )


async def _limits(pool, limits: dict = LIMITS):
    for name, value in limits.items():
        await pool.execute(
            "INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            f"box.{name}",
            value,
        )


def _ok(env, **extra):
    meta = {"ran_in": "box", "box": BOX, "image": "nova-devbox:t-0123456789ab"}
    return {"ok": True, "output": "1 passed", "exit_code": 0, "meta": meta, **extra}


def _plain(output: str = "", exit_code: int = 0):
    return lambda env: {"ok": True, "output": output, "exit_code": exit_code}


async def _run(pool, conn, device, args, answer=_ok, *, facts=None, span=False):
    """Dispatch device_run (or chat._run_tool when span) and answer EVERY
    command frame it sends with answer(envelope) -> result fields. Returns
    (result, ok, facts, the envelopes sent, the span or None)."""
    person = await _person(pool)
    facts = [] if facts is None else facts

    async def responder():
        while True:
            frame = await conn.next_sent()
            if not isinstance(frame, dict) or frame.get("type") != "command":
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
            turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
            call = chat.ToolCall(id="c1", name="device_run", arguments=json.dumps(args))
            result, ok = await chat._run_tool(turn, _ctx(person, facts=facts), call)
            (the_span,) = turn.spans
        else:
            result, ok = await tools.dispatch("device_run", args, _ctx(person, facts=facts))
    finally:
        task.cancel()
    envelopes = [f["envelope"] for f in _command_frames(conn)]
    return result, ok, facts, envelopes, the_span


def _runs(facts):
    return [f["run"] for f in facts if isinstance(f, dict) and "run" in f]


# -- C1: a worktree cwd goes to its box, and only there ------------------------


async def test_c1_a_worktree_cwd_is_one_box_exec_with_exactly_its_shape(pool, recorded):
    await _repo_row(pool)
    await _limits(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    result, ok, _facts, sent, _ = await _run(
        pool, conn, device, {"device": NAME, "argv": ARGV, "cwd": CWD}
    )
    assert ok is True, result
    (envelope,) = sent
    assert envelope["capability"] == "box.exec"
    assert envelope["args"] == {
        "argv": ARGV,
        "cwd": CWD,
        "change": CHANGE,
        "checkout": REPO,
        "branch": "trunk",
        "limits": LIMITS,
    }


async def test_c1_the_worktree_root_and_a_shouted_hostname_route_to_the_box(
    pool, monkeypatch, recorded
):
    monkeypatch.setenv("NOVA_REPO_HOST", HOST.upper())
    monkeypatch.setenv("NOVA_CHECKOUT", REPO + "/")
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    _r, ok, _f, sent, _ = await _run(pool, conn, device, {"device": NAME, "argv": ARGV, "cwd": WT})
    assert ok is True
    (envelope,) = sent
    assert envelope["capability"] == "box.exec"
    assert envelope["args"]["cwd"] == WT
    assert envelope["args"]["change"] == CHANGE
    assert envelope["args"]["checkout"] == REPO


async def test_c1_without_a_row_the_environment_is_box_and_the_limits_are_the_defaults(
    pool, monkeypatch, recorded
):
    monkeypatch.setenv(code_repos.REPO_BRANCH_ENV, "develop")
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    _r, ok, _f, sent, _ = await _run(pool, conn, device, {"device": NAME, "argv": ARGV, "cwd": CWD})
    assert ok is True
    (envelope,) = sent
    assert envelope["capability"] == "box.exec"
    assert envelope["args"]["branch"] == "develop"
    assert envelope["args"]["limits"] == {"cpus": 2, "memory_gb": 3, "pids": 512, "max_running": 2}


async def test_c1_a_limit_written_now_is_sent_on_the_next_call(pool, recorded):
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    args = {"device": NAME, "argv": ARGV, "cwd": CWD}
    await _run(pool, conn, device, args)
    await _limits(pool, {"memory_gb": 7})
    _r, _done, _f, sent, _ = await _run(pool, conn, device, args)
    assert [e["args"]["limits"]["memory_gb"] for e in sent] == [3, 7]


async def test_c1_the_change_the_checkout_and_the_box_are_read_from_the_cwd(
    pool, monkeypatch, recorded
):
    # Another id than every other test's, and a checkout recorded unclean
    # (novad refuses an unclean checkout, so core sends it normalized).
    monkeypatch.setenv("NOVA_CHECKOUT", "/home//jeremy/workspace/nova")
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    cwd = f"{REPO}/.worktrees/nova-0f9e8d/apps/web"
    result, ok, facts, sent, _ = await _run(
        pool, conn, device, {"device": NAME, "argv": ["npm", "test"], "cwd": cwd}
    )
    assert ok is True, result
    (envelope,) = sent
    assert envelope["args"]["change"] == "0f9e8d"
    assert envelope["args"]["checkout"] == REPO
    assert envelope["args"]["cwd"] == cwd
    assert result.splitlines()[0].endswith(f"in {cwd} (in box nova-box-0f9e8d)")
    (run,) = _runs(facts)
    assert run["box"] == "nova-box-0f9e8d"


# -- C2: the branch is the repo's default, never the change's ----------------


async def test_c2_the_branch_sent_is_the_recorded_default_never_the_changes(
    pool, monkeypatch, recorded
):
    # The row (synced from ./install) is read; nothing about the change's own
    # branch nova/a1b2c3-* reaches the wire, whatever the argv says.
    monkeypatch.setenv(code_repos.REPO_BRANCH_ENV, "develop")
    await _repo_row(pool, branch="trunk")
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    args = {"device": NAME, "argv": ["git", "checkout", f"nova/{CHANGE}-x"], "cwd": WT}
    _r, ok, _f, sent, _ = await _run(pool, conn, device, args)
    assert ok is True
    (envelope,) = sent
    assert envelope["args"]["branch"] == "trunk"
    assert not envelope["args"]["branch"].startswith("nova/")


async def test_c2_an_unrecorded_branch_is_read_from_origin_head_like_start_change(pool, recorded):
    await _repo_row(pool, branch=None)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)

    def answer(env):
        if env["capability"] == "shell.exec":
            return {"ok": True, "output": "origin/stable\n", "exit_code": 0}
        return _ok(env)

    _r, ok, _f, sent, _ = await _run(
        pool, conn, device, {"device": NAME, "argv": ARGV, "cwd": CWD}, answer
    )
    assert ok is True
    assert [e["capability"] for e in sent] == ["shell.exec", "box.exec"]
    assert sent[0]["args"] == {"argv": ORIGIN_HEAD}
    assert sent[1]["args"]["branch"] == "stable"


async def test_c2_an_unreadable_origin_head_runs_nothing_and_says_so(pool, recorded):
    await _repo_row(pool, branch=None)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    result, ok, facts, sent, _ = await _run(
        pool,
        conn,
        device,
        {"device": NAME, "argv": ARGV, "cwd": CWD},
        _plain("fatal: ref refs/remotes/origin/HEAD is not a symbolic ref", 128),
    )
    assert ok is False
    assert [e["args"]["argv"] for e in sent] == [ORIGIN_HEAD]
    assert "not a symbolic ref" in result
    assert result.endswith("nothing was run")
    assert _runs(facts) == []


# -- C3: everything else on the host, as today -----------------------------------


@pytest.mark.parametrize(
    ("extra", "hostname", "flagged"),
    [
        pytest.param({"cwd": REPO}, HOST, True, id="checkout-cwd-flagged"),
        pytest.param({"cwd": CWD}, "other-box", False, id="another-machine"),
        pytest.param({}, HOST, False, id="no-cwd"),
        pytest.param({"cwd": f"{REPO}/.worktrees/nova-foo"}, HOST, False, id="not-a-change-id"),
        pytest.param({"cwd": f"{REPO}/.worktrees/nova-A1B2C3"}, HOST, False, id="upper-hex"),
        pytest.param({"cwd": f"{REPO}/.worktrees/other"}, HOST, True, id="another-coders-tree"),
    ],
)
async def test_c3_anything_else_runs_on_the_host_as_today(pool, recorded, extra, hostname, flagged):
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=hostname)
    args = {"device": NAME, "argv": ["ls"], **extra}
    result, ok, facts, sent, _ = await _run(pool, conn, device, args, _plain("a"))
    assert ok is True
    (envelope,) = sent
    assert envelope["capability"] == "shell.exec"
    assert envelope["args"] == {"argv": ["ls"], **extra}
    (run,) = _runs(facts)
    assert run["ran_in"] == "host"
    assert "box" not in run
    assert "(in box" not in result
    assert result.endswith(OUTSIDE_WARNING) is flagged


@pytest.mark.parametrize("unset", ["NOVA_CHECKOUT", "NOVA_REPO_HOST"])
async def test_c3_with_the_repo_unrecorded_a_worktree_path_runs_on_the_host(
    pool, monkeypatch, recorded, unset
):
    monkeypatch.delenv(unset)
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    _r, ok, facts, sent, _ = await _run(
        pool, conn, device, {"device": NAME, "argv": ["ls"], "cwd": CWD}, _plain()
    )
    assert ok is True
    assert [e["capability"] for e in sent] == ["shell.exec"]
    assert _runs(facts)[0]["ran_in"] == "host"


async def test_c3_environment_host_runs_on_the_host_and_says_the_owner_set_it(pool, recorded):
    await _repo_row(pool, environment="host")
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    result, ok, facts, sent, _ = await _run(
        pool, conn, device, {"device": NAME, "argv": ARGV, "cwd": CWD}, _plain("1 passed")
    )
    assert ok is True
    (envelope,) = sent
    assert envelope["capability"] == "shell.exec"
    assert envelope["args"] == {"argv": ARGV, "cwd": CWD}
    assert result.splitlines()[0] == f"{NAME} ran {ARGV} — exit 0 in {CWD} {HOST_ENV_WORDS}"
    (run,) = _runs(facts)
    assert run["ran_in"] == "host" and "box" not in run


async def test_c3_elevated_in_a_worktree_is_admin_exec_on_the_host(pool, recorded):
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    meta = {"elevated": True, "kind": "sudoers", "ran_as": "root"}
    _r, ok, facts, sent, _ = await _run(
        pool,
        conn,
        device,
        {"device": NAME, "argv": ["id"], "cwd": WT, "elevated": True},
        lambda env: {"ok": True, "output": "uid=0", "exit_code": 0, "meta": meta},
    )
    assert ok is True
    (envelope,) = sent
    assert envelope["capability"] == "admin.exec"
    (run,) = _runs(facts)
    assert run["ran_in"] == "host" and "box" not in run


# -- C4: what a box run says ---------------------------------------------------


async def test_c4_an_ok_box_run_says_it_ran_in_the_box_with_its_exit_code(pool, recorded):
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    result, ok, _f, _s, _ = await _run(
        pool,
        conn,
        device,
        {"device": NAME, "argv": ARGV, "cwd": CWD},
        lambda env: _ok(env, exit_code=3, output="1 failed"),
    )
    assert ok is True
    lines = result.splitlines()
    assert lines[0] == f"{NAME} ran {ARGV} — exit 3 in {CWD} (in box {BOX})"
    assert guards._RUN_PREAMBLE.search(lines[0]) is not None
    assert lines[1] == "1 failed"


@pytest.mark.parametrize(
    "error",
    [
        f"cannot start the box {BOX}: docker: Cannot connect to the Docker daemon — "
        "nothing was run",
        f"the CPU lock {REPO}/deploy/state/cpu.lock stayed held for 100s — nothing was run",
        "box.exec: cwd '/x' is not inside the worktree; nothing was run",
    ],
)
async def test_c4_any_failed_box_frame_is_an_error_and_nothing_goes_to_the_host(
    pool, recorded, error
):
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    result, ok, _f, sent, _ = await _run(
        pool,
        conn,
        device,
        {"device": NAME, "argv": ARGV, "cwd": CWD},
        lambda env: {"ok": False, "output": "", "exit_code": None, "error": error},
    )
    assert ok is False
    assert [e["capability"] for e in sent] == ["box.exec"]
    assert result == f"Error: {NAME}: {error}"


async def test_c4_an_agent_from_before_the_box_is_told_to_update_and_nothing_runs(pool, recorded):
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    result, ok, _f, sent, _ = await _run(
        pool,
        conn,
        device,
        {"device": NAME, "argv": ARGV, "cwd": CWD},
        lambda env: {
            "ok": False,
            "output": "",
            "exit_code": None,
            "error": 'unknown capability "box.exec"',
        },
    )
    assert ok is False
    assert [e["capability"] for e in sent] == ["box.exec"]
    assert result == (
        f"Error: {NAME}'s agent predates the box — update it with machine_update; nothing was run"
    )


# -- C5: ran_in on the run fact and the span ---------------------------------------


async def test_c5_the_box_run_fact_says_where_it_ran(pool, recorded):
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    _r, _done, facts, _s, _ = await _run(
        pool,
        conn,
        device,
        {"device": NAME, "argv": ARGV, "cwd": CWD},
        lambda env: _ok(env, exit_code=1),
    )
    assert _runs(facts) == [
        {
            "exit_code": 1,
            "device": NAME,
            "argv": ARGV,
            "cwd": CWD,
            "ran_in": "box",
            "box": BOX,
        }
    ]


async def test_c5_a_failed_box_frame_still_files_where_it_was_sent(pool, recorded):
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    _r, ok, facts, _s, _ = await _run(
        pool,
        conn,
        device,
        {"device": NAME, "argv": ARGV, "cwd": CWD},
        lambda env: {"ok": False, "exit_code": None, "error": "cannot start the box"},
    )
    assert ok is False
    (run,) = _runs(facts)
    assert run["ran_in"] == "box" and run["box"] == BOX and run["exit_code"] is None


async def test_c5_run_tool_lifts_ran_in_and_the_box_to_the_span(pool, recorded):
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    _r, ok, _f, _s, span = await _run(
        pool, conn, device, {"device": NAME, "argv": ARGV, "cwd": CWD}, span=True
    )
    assert ok is True
    assert span.meta["ran_in"] == "box"
    assert span.meta["box"] == BOX


async def test_c5_a_host_run_marks_its_span_host_with_no_box(pool, recorded):
    await _repo_row(pool, environment="host")
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    # An earlier call's box fact on the sink must not mark this span.
    earlier = [{"run": {"ran_in": "box", "box": "nova-box-ffffff"}, "target": "x"}]
    _r, ok, _f, _s, span = await _run(
        pool,
        conn,
        device,
        {"device": NAME, "argv": ARGV, "cwd": CWD},
        _plain(),
        facts=earlier,
        span=True,
    )
    assert ok is True
    assert span.meta["ran_in"] == "host"
    assert "box" not in span.meta


# -- C6: the warnings are unchanged ---------------------------------------------


async def test_c6_a_box_run_in_another_changes_worktree_still_warns(pool, recorded):
    await _repo_row(pool)
    device, conn, _task = await _connect_host(pool, name=NAME, hostname=HOST)
    current = f"{REPO}/.worktrees/nova-ffffff"
    started = {"change": "ffffff", "worktree_path": current, "branch": "x", "started": True}
    result, ok, facts, sent, _ = await _run(
        pool, conn, device, {"device": NAME, "argv": ARGV, "cwd": CWD}, facts=[started]
    )
    assert ok is True
    assert [e["capability"] for e in sent] == ["box.exec"]
    assert result.splitlines()[-1] == (
        f"Warning: the change you started this turn is {current}; this touched {WT}."
    )
    assert any("other_change_worktree" in f for f in facts)


# -- A5: an eval replay's declared device is answered by its plant, on the host --


async def test_a_replay_device_on_the_repo_hostname_is_never_routed_to_a_box(
    pool, monkeypatch, recorded
):
    from tests.test_machines import _t5_dispatch, _t5_plant, _t5_run_facts

    monkeypatch.setenv("NOVA_REPO_HOST", "EVAL-LAPTOP")
    await _repo_row(pool)
    runs = [{"argv": ["git", "status"], "exit_code": 0, "output": "clean"}]
    result, ok, sink = await _t5_dispatch(
        _t5_plant(runs=runs),
        "device_run",
        {"device": "eval_laptop", "argv": ["git", "status"], "cwd": CWD},
    )
    assert ok is True, result
    assert result.splitlines()[0] == f"eval_laptop ran ['git', 'status'] — exit 0 in {CWD}"
    (fact,) = _t5_run_facts(sink)
    assert fact["run"]["ran_in"] == "host" and "box" not in fact["run"]
