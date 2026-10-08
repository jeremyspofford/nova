"""T3 (worktrees epic, 2026-10-08): device_run takes an optional `cwd`.

The incident: asked to build a feature, she ran `sh -c "cd <checkout> && ..."`
because device_run had no working directory and started in the agent's home;
four turns lost rounds to git exit 128 ("not a git repository"). novad's
shell.exec already reads args.cwd (apps/novad/internal/caps/shell.go — pinned
by shell_unix_test.go); core never sent it.

Criteria:
  C1 the schema offers `cwd` (a string, optional) and the description says
     relative paths and git run from it.
  C2 cwd is checked exactly like an fs path (_check_fs_path): a relative cwd,
     a non-absolute Windows cwd, or an unreported @folder is a stated refusal
     BEFORE the wire; an absolute one is sent normalized; an @folder the agent
     reported passes through unresolved.
  C3 sent as shell.exec args {"argv", "cwd"} only when given; without it the
     frame is {"argv"} alone, as before.
  C4 the result's first line is "<name> ran <argv> — exit <code> in <cwd>",
     and guards._RUN_PREAMBLE still matches it.
  C5 a cwd that does not exist comes back as the agent's stated failure — a
     ToolFailure naming the cwd (Go's own words name only the program) —
     never a success.
"""

from __future__ import annotations

import asyncio

import pytest

from app import guards, tools
from tests.conftest import requires_db
from tests.test_devices_ws import (
    _close,
    _command_frames,
    _connect,
    _ctx,
    _person,
    _wait_for_facts_key,
)

pytestmark = requires_db


async def _run_once(pool, conn, device, args, *, ok=True, output="", exit_code=0, error=None):
    """Dispatch device_run, answer the one command frame it sends, and return
    (result text, ok, the frame's envelope args)."""
    person = await _person(pool)
    seen: dict = {}

    async def answer():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        assert frame["type"] == "command" and frame["envelope"]["capability"] == "shell.exec"
        seen.update(frame["envelope"]["args"])
        conn.feed(
            device.result(frame["envelope"], ok=ok, output=output, exit_code=exit_code, error=error)
        )

    ans = asyncio.create_task(answer())
    result, dispatched_ok = await tools.dispatch("device_run", args, _ctx(person))
    if not seen:
        ans.cancel()
        pytest.fail(f"device_run sent no command frame; it said: {result}")
    await asyncio.wait_for(ans, 2)
    return result, dispatched_ok, seen


# -- C1: the schema ----------------------------------------------------------


def test_c1_the_schema_offers_an_optional_string_cwd():
    params = tools.REGISTRY["device_run"].parameters
    assert params["properties"]["cwd"]["type"] == "string"
    assert "cwd" not in params["required"]
    assert set(params["required"]) == {"device", "argv"}


def test_c1_the_description_says_relative_paths_and_git_run_from_cwd():
    tool = tools.REGISTRY["device_run"]
    text = (tool.description + " " + tool.parameters["properties"]["cwd"]["description"]).lower()
    assert "cwd" in text
    assert "relative" in text
    assert "git" in text


# -- C2: checked like an fs path, before the wire ------------------------------


async def test_c2_a_relative_cwd_is_refused_before_the_wire(pool):
    _id, _device, conn, task = await _connect(pool, name="laptop")
    person = await _person(pool)
    result, ok = await tools.dispatch(
        "device_run",
        {"device": "laptop", "argv": ["git", "status"], "cwd": "workspace/nova"},
        _ctx(person),
    )
    assert ok is False
    assert "must be absolute" in result
    assert _command_frames(conn) == []
    await _close(conn, task)


async def test_c2_a_non_absolute_windows_cwd_is_refused_before_the_wire(pool):
    _id, _device, conn, task = await _connect(pool, name="dell", platform="windows")
    person = await _person(pool)
    result, ok = await tools.dispatch(
        "device_run",
        {"device": "dell", "argv": ["cmd", "/c", "dir"], "cwd": "\\Users\\sam"},
        _ctx(person),
    )
    assert ok is False
    assert "must be absolute on Windows" in result
    assert _command_frames(conn) == []
    await _close(conn, task)


async def test_c2_an_unreported_folder_cwd_is_a_stated_cannot(pool):
    _id, _device, conn, task = await _connect(pool, name="laptop")
    person = await _person(pool)
    result, ok = await tools.dispatch(
        "device_run",
        {"device": "laptop", "argv": ["ls"], "cwd": "@desktop"},
        _ctx(person),
    )
    assert ok is False
    assert "did not report its desktop folder" in result
    assert _command_frames(conn) == []
    await _close(conn, task)


async def test_c2_a_folder_cwd_the_agent_could_not_read_is_refused_in_its_own_words(pool):
    """COVERAGE: the cwd check carries the agent's own reason for a folder it
    could not report (folders_unread), exactly as an fs path does — the
    unreported-folder test above passes even if that reason is dropped."""
    hub_id, _device, conn, task = await _connect(pool, name="laptop")
    conn.feed(
        {
            "type": "facts",
            "net": {"ifaces": []},
            "unreadable": [
                {"item": "folders.desktop", "reason": "this machine names no desktop folder"}
            ],
        }
    )
    await _wait_for_facts_key(pool, hub_id, "unreadable")
    person = await _person(pool)
    result, ok = await tools.dispatch(
        "device_run",
        {"device": "laptop", "argv": ["ls"], "cwd": "@desktop/notes"},
        _ctx(person),
    )
    assert ok is False
    assert "(it said: this machine names no desktop folder)" in result
    assert _command_frames(conn) == []
    await _close(conn, task)


async def test_c2_an_absolute_cwd_is_sent_normalized(pool):
    _id, device, conn, task = await _connect(pool, name="laptop")
    _result, ok, sent = await _run_once(
        pool,
        conn,
        device,
        {"device": "laptop", "argv": ["git", "status"], "cwd": "/home/sam/./work/../nova/"},
    )
    assert ok is True
    assert sent["cwd"] == "/home/sam/nova"
    await _close(conn, task)


async def test_c2_a_reported_folder_cwd_passes_through_unresolved(pool):
    hub_id, device, conn, task = await _connect(pool, name="laptop")
    conn.feed({"type": "facts", "folders": {"desktop": "/home/sam/Desktop"}})
    await _wait_for_facts_key(pool, hub_id, "folders")
    _result, ok, sent = await _run_once(
        pool, conn, device, {"device": "laptop", "argv": ["ls"], "cwd": "@desktop/notes"}
    )
    assert ok is True
    assert sent["cwd"] == "@desktop/notes"
    await _close(conn, task)


# -- C3: on the wire only when given --------------------------------------------


async def test_c3_cwd_rides_the_shell_exec_args_with_argv(pool):
    _id, device, conn, task = await _connect(pool, name="laptop")
    _result, ok, sent = await _run_once(
        pool,
        conn,
        device,
        {"device": "laptop", "argv": ["git", "status"], "cwd": "/home/sam/nova"},
    )
    assert ok is True
    assert sent == {"argv": ["git", "status"], "cwd": "/home/sam/nova"}
    await _close(conn, task)


async def test_c3_without_cwd_the_frame_is_argv_alone(pool):
    _id, device, conn, task = await _connect(pool, name="laptop")
    _result, ok, sent = await _run_once(
        pool, conn, device, {"device": "laptop", "argv": ["git", "status"]}
    )
    assert ok is True
    assert sent == {"argv": ["git", "status"]}
    await _close(conn, task)


# -- C4: the result names where it ran -----------------------------------------


async def test_c4_the_first_line_names_the_cwd_after_the_exit(pool):
    _id, device, conn, task = await _connect(pool, name="laptop")
    result, ok, _sent = await _run_once(
        pool,
        conn,
        device,
        {"device": "laptop", "argv": ["ls"], "cwd": "/home/sam/nova"},
        output="README.md\napps\nservices",
    )
    assert ok is True
    first = result.splitlines()[0]
    assert first == "laptop ran ['ls'] — exit 0 in /home/sam/nova"
    assert guards._RUN_PREAMBLE.search(first) is not None
    await _close(conn, task)


async def test_c4_without_cwd_the_first_line_is_unchanged(pool):
    _id, device, conn, task = await _connect(pool, name="laptop")
    result, ok, _sent = await _run_once(
        pool, conn, device, {"device": "laptop", "argv": ["ls"]}, output="a\nb"
    )
    assert ok is True
    assert result.splitlines()[0] == "laptop ran ['ls'] — exit 0"
    await _close(conn, task)


# -- C5: a missing directory is a stated cannot ----------------------------------


@pytest.mark.parametrize(
    "error",
    [
        'could not run "git": fork/exec /usr/bin/git: no such file or directory',
        None,
    ],
)
async def test_c5_a_missing_cwd_is_the_agents_stated_failure_naming_the_cwd(pool, error):
    _id, device, conn, task = await _connect(pool, name="laptop")
    result, ok, sent = await _run_once(
        pool,
        conn,
        device,
        {"device": "laptop", "argv": ["git", "status"], "cwd": "/home/sam/gone"},
        ok=False,
        exit_code=None,
        error=error,
    )
    assert ok is False
    assert sent["cwd"] == "/home/sam/gone"
    assert "/home/sam/gone" in result
    if error is not None:
        assert error in result
    assert "ran [" not in result  # never dressed as a run
    await _close(conn, task)
