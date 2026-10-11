"""T6 (S30b, 2026-10-11): device_run(elevated) — the standing admin path's run.

Owner ruling 2026-09-03 binds: nothing asks and nothing refuses. An elevated
call is sent as the agent's `admin.exec` (a NEW capability name, so an agent
from before S30b answers "unknown capability" and nothing is ever run
unelevated in its place); the trace marks every elevated call.

Criteria (tracker .epics/s30b.md, T6):
  C1 schema `elevated` boolean; true sends admin.exec {argv[, cwd]}; false or
     absent is shell.exec exactly as before; the description says what it
     means, that nothing asks, and names device_admin_path.
  C2 {"elevated": True, "machine": <name>} is filed before the send (ok,
     cannot, failed frame); chat._run_tool lifts it to span.meta elevated +
     machine; the run fact gains "elevated": True on elevated calls only.
  C3 "cannot: no admin path on this machine" -> "cannot: no admin path on
     <machine>" naming device_admin_path; "unknown capability" -> predates the
     admin path, machine_update; one frame only.
  C4 ok first line keeps _RUN_PREAMBLE then states ran_as.
  C5 no gate (test_no_approvals unchanged); an elevated argv's credential is
     masked in the span like any argv.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime

import pytest

from app import chat, guards, tools, traces
from tests.conftest import requires_db
from tests.test_devices_ws import _close, _command_frames, _connect, _ctx, _person

pytestmark = requires_db

ROOT = {"elevated": True, "kind": "sudoers", "ran_as": "root"}
WIN_ELEVATED = {"elevated": True, "kind": "task", "ran_as": "user_elevated", "user": "DELL\\owner"}
WIN_NOT = {"elevated": True, "kind": "task", "ran_as": "user_not_elevated", "user": "DELL\\owner"}
NO_PATH = "cannot: no admin path on this machine"
UNKNOWN = 'unknown capability "admin.exec"'
T6_GH = "ghp_" + "a1B2" * 9


@pytest.fixture(autouse=True)
def _no_checkout(monkeypatch):
    monkeypatch.delenv("NOVA_CHECKOUT", raising=False)
    monkeypatch.delenv("NOVA_REPO_HOST", raising=False)


def _frame(device, envelope, *, ok=True, output="", exit_code=0, error=None, meta=None):
    frame = device.result(envelope, ok=ok, output=output, exit_code=exit_code, error=error)
    if meta is not None:
        frame["meta"] = meta
    return frame


def _sent_or_fail(task, conn, result):
    if not _command_frames(conn):
        task.cancel()
        pytest.fail(f"device_run sent no command frame; it said: {result}")


async def _call(pool, conn, device, args, **answer):
    """Dispatch device_run, answer its one command frame; returns
    (result, ok, facts, the command frames sent)."""
    person = await _person(pool)
    facts: list[dict] = []

    async def reply():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        assert frame["type"] == "command"
        conn.feed(_frame(device, frame["envelope"], **answer))

    task = asyncio.create_task(reply())
    result, ok = await tools.dispatch("device_run", args, _ctx(person, facts=facts))
    _sent_or_fail(task, conn, result)
    await asyncio.wait_for(task, 2)
    return result, ok, facts, _command_frames(conn)


async def _span(pool, conn, device, args, **answer):
    """The same call through chat._run_tool; returns (result, ok, span)."""
    person = await _person(pool)

    async def reply():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        conn.feed(_frame(device, frame["envelope"], **answer))

    task = asyncio.create_task(reply())
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    call = chat.ToolCall(id="c1", name="device_run", arguments=json.dumps(args))
    result, ok = await chat._run_tool(turn, _ctx(person, facts=[]), call)
    _sent_or_fail(task, conn, result)
    await asyncio.wait_for(task, 2)
    (span,) = turn.spans
    return result, ok, span


def _elevated_facts(facts: list[dict]) -> list[dict]:
    return [f for f in facts if "elevated" in f and "run" not in f]


# -- C1: schema and the capability sent ----------------------------------------


def test_c1_the_schema_offers_elevated_as_an_optional_boolean():
    params = tools.REGISTRY["device_run"].parameters
    assert params["properties"]["elevated"]["type"] == "boolean"
    assert "elevated" not in params["required"]


def test_c1_the_description_says_what_elevated_means_and_that_nothing_asks():
    text = tools.REGISTRY["device_run"].description
    assert "elevated" in text
    assert "root" in text
    assert "nothing asks" in text
    assert "device_admin_path" in text


async def test_c1_elevated_sends_admin_exec_with_argv_and_cwd(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    argv = ["apt-get", "install", "-y", "htop"]
    _r, ok, _f, frames = await _call(
        pool,
        conn,
        device,
        {"device": "mini", "argv": argv, "cwd": "/tmp", "elevated": True},
        meta=ROOT,
    )
    assert ok is True
    (frame,) = frames
    assert frame["envelope"]["capability"] == "admin.exec"
    assert frame["envelope"]["args"] == {"argv": argv, "cwd": "/tmp"}
    await _close(conn, task)


@pytest.mark.parametrize("extra", [{}, {"elevated": False}])
async def test_c1_unelevated_is_shell_exec_as_before(pool, extra):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, facts, frames = await _call(
        pool, conn, device, {"device": "mini", "argv": ["true"], **extra}
    )
    assert ok is True
    (frame,) = frames
    assert frame["envelope"]["capability"] == "shell.exec"
    assert frame["envelope"]["args"] == {"argv": ["true"]}
    assert result.splitlines()[0] == "mini ran ['true'] — exit 0"
    assert _elevated_facts(facts) == []
    (run,) = [f for f in facts if "run" in f]
    assert "elevated" not in run["run"]
    await _close(conn, task)


# -- C2: the fact, the run fact and the span ------------------------------------


async def test_c2_an_ok_elevated_call_files_the_fact_and_marks_the_run(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    _r, ok, facts, _fr = await _call(
        pool, conn, device, {"device": "mini", "argv": ["id", "-u"], "elevated": True}, meta=ROOT
    )
    assert ok is True
    assert _elevated_facts(facts) == [{"elevated": True, "machine": "mini"}]
    assert all("device" not in f for f in _elevated_facts(facts))
    (run,) = [f for f in facts if "run" in f]
    assert run["run"]["elevated"] is True
    assert run["run"]["device"] == "mini"
    await _close(conn, task)


async def test_c2_the_span_carries_elevated_and_machine_on_ok(pool):
    _id, device, conn, task = await _connect(pool, name="Beelink Mini S")
    result, ok, span = await _span(
        pool,
        conn,
        device,
        {
            "device": "Beelink Mini S",
            "argv": ["apt-get", "install", "-y", "htop"],
            "elevated": True,
        },
        meta=ROOT,
    )
    assert ok is True, result
    assert span.meta["elevated"] is True
    assert span.meta["machine"] == "Beelink Mini S"
    assert "device" not in span.meta
    assert "error" not in span.meta
    await _close(conn, task)


async def test_c2_the_span_carries_elevated_on_the_agents_cannot(pool):
    _id, device, conn, task = await _connect(pool, name="DELL-XPS-8950")
    result, ok, span = await _span(
        pool,
        conn,
        device,
        {"device": "DELL-XPS-8950", "argv": ["whoami"], "elevated": True},
        ok=False,
        exit_code=None,
        error=NO_PATH,
    )
    assert ok is False
    assert span.meta["ok"] is False
    assert span.meta["elevated"] is True
    assert span.meta["machine"] == "DELL-XPS-8950"
    assert "no admin path on DELL-XPS-8950" in span.meta["error"]
    await _close(conn, task)


async def test_c2_the_span_carries_elevated_on_a_failed_frame(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    _result, ok, span = await _span(
        pool,
        conn,
        device,
        {"device": "mini", "argv": ["sleep", "999"], "elevated": True},
        ok=False,
        exit_code=None,
        error="timed out; partial output:\n",
    )
    assert ok is False
    assert span.meta["elevated"] is True
    assert span.meta["machine"] == "mini"
    await _close(conn, task)


@pytest.mark.parametrize("how", ["timeout", "dropped"])
async def test_c2_the_span_carries_elevated_when_the_send_fails_at_transport(
    pool, monkeypatch, how
):
    # G11: no result frame ever comes back (the agent never answers, or its
    # socket is gone after the send) -> _command raises; the fact filed before
    # the send still marks the span.
    from app.tools import devices as device_tools

    device_id, _device, conn, task = await _connect(pool, name="mini")
    if how == "timeout":
        monkeypatch.setattr(device_tools, "COMMAND_TIMEOUT_SECONDS", 0.05)
    person = await _person(pool)
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    args = {"device": "mini", "argv": ["apt-get", "update"], "elevated": True}
    call = chat.ToolCall(id="c1", name="device_run", arguments=json.dumps(args))
    run = asyncio.create_task(chat._run_tool(turn, _ctx(person, facts=[]), call))
    frame = await asyncio.wait_for(conn.next_sent(), 2)  # the command left core
    assert frame["type"] == "command"
    if how == "dropped":
        from app import devices_ws

        devices_ws.hub.unregister(device_id, conn)
    _result, ok = await asyncio.wait_for(run, 2)
    assert ok is False
    (span,) = turn.spans
    assert span.meta["ok"] is False
    assert span.meta["elevated"] is True
    assert span.meta["machine"] == "mini"
    await _close(conn, task)


async def test_c2_an_unelevated_span_has_no_elevated_mark(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    _result, ok, span = await _span(pool, conn, device, {"device": "mini", "argv": ["true"]})
    assert ok is True
    assert "elevated" not in span.meta
    assert "machine" not in span.meta
    await _close(conn, task)


async def test_c2_an_earlier_elevated_fact_does_not_mark_a_later_span(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    person = await _person(pool)

    async def reply():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        conn.feed(_frame(device, frame["envelope"]))

    waiter = asyncio.create_task(reply())
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    ctx = _ctx(person, facts=[{"elevated": True, "machine": "mini"}])
    call = chat.ToolCall(
        id="c1", name="device_run", arguments=json.dumps({"device": "mini", "argv": ["true"]})
    )
    _result, ok = await chat._run_tool(turn, ctx, call)
    await asyncio.wait_for(waiter, 2)
    assert ok is True
    (span,) = turn.spans
    assert "elevated" not in span.meta
    await _close(conn, task)


# -- C3: refusals restated, nothing run unelevated ------------------------------


async def test_c3_no_admin_path_is_stated_naming_the_machine_and_the_install_tool(pool):
    _id, device, conn, task = await _connect(pool, name="DELL-XPS-8950", platform="windows")
    result, ok, facts, frames = await _call(
        pool,
        conn,
        device,
        {"device": "DELL-XPS-8950", "argv": ["whoami"], "elevated": True},
        ok=False,
        exit_code=None,
        error=NO_PATH,
    )
    assert ok is False
    assert result.startswith("Error: cannot: no admin path on DELL-XPS-8950")
    assert "device_admin_path" in result
    assert "this machine" not in result
    assert len(frames) == 1
    assert _elevated_facts(facts) == [{"elevated": True, "machine": "DELL-XPS-8950"}]
    await _close(conn, task)


async def test_c3_an_agent_before_the_admin_path_is_told_to_update(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, facts, frames = await _call(
        pool,
        conn,
        device,
        {"device": "mini", "argv": ["apt-get", "update"], "elevated": True},
        ok=False,
        exit_code=None,
        error=UNKNOWN,
    )
    assert ok is False
    assert "mini's agent predates the admin path" in result
    assert "machine_update" in result
    assert "unknown capability" not in result
    # Never retried unelevated: the one frame sent is admin.exec.
    assert [f["envelope"]["capability"] for f in frames] == ["admin.exec"]
    assert _elevated_facts(facts) == [{"elevated": True, "machine": "mini"}]
    await _close(conn, task)


async def test_c3_another_failure_is_the_agents_own_words(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, _facts, _frames = await _call(
        pool,
        conn,
        device,
        {"device": "mini", "argv": ["nope"], "elevated": True},
        ok=False,
        exit_code=None,
        error="could not run: the root side said exec: nope: not found",
    )
    assert ok is False
    assert "the root side said exec: nope: not found" in result
    assert "predates" not in result
    assert "no admin path" not in result
    await _close(conn, task)


# -- C4: the first line ----------------------------------------------------------


@pytest.mark.parametrize(
    ("meta", "tail"),
    [
        (ROOT, " elevated (as root)"),
        (WIN_ELEVATED, " elevated (as DELL\\owner, elevated)"),
        (WIN_NOT, " NOT elevated (as DELL\\owner, without admin rights)"),
        (None, " elevation not confirmed (the agent sent no elevated record)"),
        ({"elevated": True, "ran_as": "who knows"}, " elevation not confirmed"),
    ],
)
async def test_c4_the_first_line_keeps_the_preamble_and_states_who_it_ran_as(pool, meta, tail):
    _id, device, conn, task = await _connect(pool, name="box")
    result, ok, _facts, _frames = await _call(
        pool,
        conn,
        device,
        {"device": "box", "argv": ["whoami"], "elevated": True},
        output="root",
        meta=meta,
    )
    assert ok is True
    first = result.splitlines()[0]
    assert guards._RUN_PREAMBLE.search(first) is not None
    assert first.startswith(f"box ran ['whoami'] — exit 0{tail}")
    assert "root" in result.splitlines()[1:]
    await _close(conn, task)


async def test_c4_the_cwd_follows_the_elevation_words(pool):
    _id, device, conn, task = await _connect(pool, name="box")
    result, ok, _facts, _frames = await _call(
        pool,
        conn,
        device,
        {"device": "box", "argv": ["ls"], "cwd": "/etc", "elevated": True},
        meta=ROOT,
    )
    assert ok is True
    assert result.splitlines()[0] == "box ran ['ls'] — exit 0 elevated (as root) in /etc"
    await _close(conn, task)


# -- C5: masking the same --------------------------------------------------------


async def test_c5_an_elevated_argv_credential_never_reaches_the_span(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    _result, ok, span = await _span(
        pool,
        conn,
        device,
        {"device": "mini", "argv": ["env", f"GH_TOKEN={T6_GH}", "gh"], "elevated": True},
        output=f"logged in with {T6_GH}",
        meta=ROOT,
    )
    assert ok is True
    assert span.meta["elevated"] is True
    assert span.meta["args_redacted"]["argv"][1] == "GH_TOKEN=<masked:40 chars>"
    assert T6_GH not in json.dumps(span.meta, default=str)
    await _close(conn, task)
