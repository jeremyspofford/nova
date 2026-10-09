"""T1 (S29a, 2026-10-09): device calls file structured facts from the agent's
own result frame — a run's exit code, a file's path.

The measured defect (S29 PLAN, re-measured 10-09): the exit code reached the
trace only as prose in the result ("<name> ran <argv> — exit 1"), and device
reads and writes recorded nothing, so "All 40 tests passed" over an exit-1 run
and "I read README.md on the Dell" over an ok read were both judged against
prose. T2-T5 read these facts; T1 only files them.

Criteria:
  C1 device_run, on an ok result frame, files exactly one run fact
     {"run": {"exit_code", "device", "argv", "cwd"}, "target": " ".join(argv)}:
     exit_code is the frame's, device the row's name, argv as sent, cwd the
     checked (normalized) cwd or None when none was given.
  C2 the exit code is the frame's whatever it is: a nonzero exit (ok frame,
     exit 1) files exit_code 1 and the call still succeeds; a failed frame
     (ok false) still files its run fact — exit_code as the frame gave it —
     and the call still fails. A call refused before the wire (a relative cwd)
     sent no frame and files no run fact.
  C3 device_read_file / device_write_file on ok file exactly one file fact
     {"file": {"op": "read"|"write", "device"}, "target": <checked path>}
     (normalized, the same path the frame carried). A failed frame or a
     refusal before the wire files no file fact.
  C4 the new facts carry no top-level "device" key (the state guard reads that
     key as a connectivity record), and chat._run_tool lifts them to
     span.meta["facts"].
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime

import pytest

from app import chat, tools, traces
from app.tools import devices
from tests.conftest import requires_db
from tests.test_devices_ws import _close, _command_frames, _connect, _ctx, _person

pytestmark = requires_db


@pytest.fixture(autouse=True)
def _no_checkout(monkeypatch):
    """The outside-worktree flag is not under test here; keep it off."""
    monkeypatch.delenv("NOVA_CHECKOUT", raising=False)
    monkeypatch.delenv("NOVA_REPO_HOST", raising=False)


async def _call(pool, conn, device, tool, args, *, ok=True, output="", exit_code=0, error=None):
    """Dispatch `tool`, answer the one command frame it sends; returns
    (result, ok, facts sink, the frame's envelope args)."""
    person = await _person(pool)
    facts: list[dict] = []
    seen: dict = {}

    async def answer():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        assert frame["type"] == "command"
        seen.update(frame["envelope"]["args"])
        conn.feed(
            device.result(frame["envelope"], ok=ok, output=output, exit_code=exit_code, error=error)
        )

    ans = asyncio.create_task(answer())
    result, dispatched_ok = await tools.dispatch(tool, args, _ctx(person, facts=facts))
    if not seen:
        ans.cancel()
        pytest.fail(f"{tool} sent no command frame; it said: {result}")
    await asyncio.wait_for(ans, 2)
    return result, dispatched_ok, facts, seen


def _runs(facts: list[dict]) -> list[dict]:
    return [f for f in facts if "run" in f]


def _files(facts: list[dict]) -> list[dict]:
    return [f for f in facts if "file" in f]


# -- C1: a run fact on an ok frame ---------------------------------------------


async def test_c1_device_run_files_a_run_fact_with_exit_code_device_argv(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    argv = ["python3", "--version"]
    result, ok, facts, _sent = await _call(
        pool, conn, device, "device_run", {"device": "mini", "argv": argv}, output="Python 3.12.3"
    )
    assert ok is True, result
    assert _runs(facts) == [
        {
            "run": {"exit_code": 0, "device": "mini", "argv": argv, "cwd": None},
            "target": "python3 --version",
        }
    ]
    await _close(conn, task)


async def test_c1_the_run_fact_carries_the_checked_cwd(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    argv = ["git", "status"]
    _result, ok, facts, sent = await _call(
        pool,
        conn,
        device,
        "device_run",
        {"device": "mini", "argv": argv, "cwd": "/home/sam/./work/../nova/"},
    )
    assert ok is True
    (fact,) = _runs(facts)
    assert fact["run"]["cwd"] == "/home/sam/nova" == sent["cwd"]
    assert fact["target"] == "git status"
    await _close(conn, task)


# -- C2: nonzero, failed, refused ----------------------------------------------


async def test_c2_a_nonzero_exit_files_its_exit_code_and_the_call_succeeds(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    argv = ["uv", "run", "pytest", "-q"]
    result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_run",
        {"device": "mini", "argv": argv},
        output="1 failed, 39 passed",
        exit_code=1,
    )
    assert ok is True, result
    assert "exit 1" in result.splitlines()[0]
    (fact,) = _runs(facts)
    assert fact["run"]["exit_code"] == 1
    assert fact["target"] == "uv run pytest -q"
    await _close(conn, task)


async def test_c2_a_failed_frame_still_files_its_run_fact_and_fails(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    argv = ["nosuchprogram"]
    result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_run",
        {"device": "mini", "argv": argv},
        ok=False,
        exit_code=None,
        error='could not run "nosuchprogram": executable file not found in $PATH',
    )
    assert ok is False
    assert "executable file not found" in result
    assert _runs(facts) == [
        {
            "run": {"exit_code": None, "device": "mini", "argv": argv, "cwd": None},
            "target": "nosuchprogram",
        }
    ]
    await _close(conn, task)


async def test_c2_a_failed_frame_files_the_exit_code_it_carried(pool):
    """COVERAGE: a failed frame that DID carry a code (127, not found) files
    that code, not None: the fact is the frame's, whatever its ok says."""
    _id, device, conn, task = await _connect(pool, name="mini")
    _result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_run",
        {"device": "mini", "argv": ["gti", "status"]},
        ok=False,
        exit_code=127,
        error="command not found",
    )
    assert ok is False
    (fact,) = _runs(facts)
    assert fact["run"]["exit_code"] == 127
    await _close(conn, task)


async def test_c2_a_run_refused_before_the_wire_files_no_run_fact(pool):
    _id, _device, conn, task = await _connect(pool, name="mini")
    person = await _person(pool)
    facts: list[dict] = []
    result, ok = await tools.dispatch(
        "device_run",
        {"device": "mini", "argv": ["git", "status"], "cwd": "workspace/nova"},
        _ctx(person, facts=facts),
    )
    assert ok is False and "must be absolute" in result
    assert _command_frames(conn) == []
    assert _runs(facts) == []
    await _close(conn, task)


# -- C3: file facts on device reads and writes ----------------------------------


async def test_c3_an_ok_read_files_a_read_fact_on_the_checked_path(pool):
    _id, device, conn, task = await _connect(pool, name="dell")
    result, ok, facts, sent = await _call(
        pool,
        conn,
        device,
        "device_read_file",
        {"device": "dell", "path": "/home/sam/./nova/README.md"},
        output="# Nova",
    )
    assert ok is True, result
    assert sent["path"] == "/home/sam/nova/README.md"
    assert _files(facts) == [
        {"file": {"op": "read", "device": "dell"}, "target": "/home/sam/nova/README.md"}
    ]
    await _close(conn, task)


async def test_c3_an_ok_write_files_a_write_fact_on_the_checked_path(pool):
    _id, device, conn, task = await _connect(pool, name="dell")
    result, ok, facts, sent = await _call(
        pool,
        conn,
        device,
        "device_write_file",
        {"device": "dell", "path": "/home/sam/notes/../notes.md", "content": "hi"},
    )
    assert ok is True, result
    assert sent["path"] == "/home/sam/notes.md"
    assert _files(facts) == [
        {"file": {"op": "write", "device": "dell"}, "target": "/home/sam/notes.md"}
    ]
    await _close(conn, task)


async def test_c3_a_failed_read_files_no_file_fact(pool):
    _id, device, conn, task = await _connect(pool, name="dell")
    _result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_read_file",
        {"device": "dell", "path": "/home/sam/missing.md"},
        ok=False,
        exit_code=None,
        error="open /home/sam/missing.md: no such file or directory",
    )
    assert ok is False
    assert _files(facts) == []
    await _close(conn, task)


async def test_c3_a_failed_write_files_no_file_fact(pool):
    _id, device, conn, task = await _connect(pool, name="dell")
    _result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_write_file",
        {"device": "dell", "path": "/root/locked.md", "content": "hi"},
        ok=False,
        exit_code=None,
        error="open /root/locked.md: permission denied",
    )
    assert ok is False
    assert _files(facts) == []
    await _close(conn, task)


async def test_c3_a_read_refused_before_the_wire_files_no_file_fact(pool):
    _id, _device, conn, task = await _connect(pool, name="dell")
    person = await _person(pool)
    facts: list[dict] = []
    result, ok = await tools.dispatch(
        "device_read_file", {"device": "dell", "path": "notes.md"}, _ctx(person, facts=facts)
    )
    assert ok is False and "must be absolute" in result
    assert _command_frames(conn) == []
    assert _files(facts) == []
    await _close(conn, task)


async def test_c3_a_write_refused_before_the_wire_files_no_file_fact(pool):
    """COVERAGE: an oversize write is refused before any frame is sent, and
    a refusal wrote nothing, so it files no write fact."""
    _id, _device, conn, task = await _connect(pool, name="dell")
    person = await _person(pool)
    facts: list[dict] = []
    big = "x" * (devices.WRITE_FILE_CAP_KIB * 1024 + 1)
    result, ok = await tools.dispatch(
        "device_write_file",
        {"device": "dell", "path": "/home/sam/big.md", "content": big},
        _ctx(person, facts=facts),
    )
    assert ok is False and "write cap" in result
    assert _command_frames(conn) == []
    assert _files(facts) == []
    await _close(conn, task)


# -- C4: no top-level device key; lifted to the span ------------------------------


async def test_c4_the_new_facts_carry_no_top_level_device_key(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    _r, _ok, run_facts, _s = await _call(
        pool, conn, device, "device_run", {"device": "mini", "argv": ["true"]}
    )
    _r, _ok, file_facts, _s = await _call(
        pool, conn, device, "device_read_file", {"device": "mini", "path": "/etc/hostname"}
    )
    new = _runs(run_facts) + _files(file_facts)
    assert len(new) == 2
    assert all("device" not in fact for fact in new)
    await _close(conn, task)


async def test_c4_run_tool_lifts_the_run_fact_to_the_span(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    person = await _person(pool)

    async def answer():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        conn.feed(device.result(frame["envelope"], output="Python 3.12.3"))

    ans = asyncio.create_task(answer())
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    call = chat.ToolCall(
        id="c1",
        name="device_run",
        arguments=json.dumps({"device": "mini", "argv": ["python3", "--version"]}),
    )
    result, ok = await chat._run_tool(turn, _ctx(person, facts=[]), call)
    await asyncio.wait_for(ans, 2)
    assert ok is True, result
    (span,) = turn.spans
    runs = [f for f in span.meta.get("facts", []) if "run" in f]
    argv = ["python3", "--version"]
    assert runs == [
        {
            "run": {"exit_code": 0, "device": "mini", "argv": argv, "cwd": None},
            "target": "python3 --version",
        }
    ]
    await _close(conn, task)
