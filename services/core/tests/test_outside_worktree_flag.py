"""T4 (worktrees epic, 2026-10-08): the outside-worktree FLAG — never a refusal.

The incident (turn 91ecef9a-cd7b-4e15-b8e1-ab478954b9a9): asked to build
keyboard shortcuts, she ran device_run on the hub as
["sh", "-c", "cd /home/jeremy/workspace/nova && git checkout -b ..."], made a
branch IN the owner's live deploy checkout, rewrote files there, and the next
./install deployed her WIP. Owner ruling 2026-10-08 ("Worktree by default +
flag"), under the 09-03 no-approvals ruling: a call that touches the live
checkout outside her .worktrees/nova-* STILL RUNS; its result carries a stated
warning and the trace marks it. No gate, no new Tool/ToolContext field —
tests/test_no_approvals.py stays green and unchanged.

Criteria:
  C1 device_run on the repo machine (row hostname == NOVA_REPO_HOST,
     case-insensitive; NOVA_CHECKOUT set) whose cwd or argv touches the checkout
     outside .worktrees/nova-* RUNS as asked (the frame is sent, ok), keeps its
     first line, and its result's LAST line is the warning naming the checkout
     and start_change; the fact {"outside_worktree": <repo>, "tool":
     "device_run"} lands on facts_sink — with NO "device" key (that key is read
     as a connectivity record by the state guard).
  C2 device_write_file whose path is outside: written as asked, same last-line
     warning and fact (tool "device_write_file"); a FAILED outside call still
     names the warning in its stated failure and still records the fact.
  C3 no flag, no fact: inside .worktrees/nova-<id> (cwd, argv, write path);
     another machine running the very same argv; NOVA_CHECKOUT or
     NOVA_REPO_HOST unset; a path that merely shares a prefix; reads
     (device_read_file, device_list_files) of the checkout itself. Zero cost:
     the check reads the admitted row, never the device table again
     (code_repo.repo_machine / plant().live_devices are never called).
  C4 chat._run_tool sets span.meta["outside_worktree"] = True when THIS call's
     facts slice holds an outside_worktree fact, and leaves the key absent
     otherwise (a fact an earlier call left on the sink does not mark a later
     span).
  C5 never a refusal: a flagged call is ok=True on dispatch and on its span
     (no "error"); test_no_approvals.py is untouched (run in the Test line).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime

import pytest

from app import chat, code_repo, devices, devices_ws, guards, machines, tools, traces
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice, FakeWSConn
from tests.test_devices_ws import _clean_hub, _close, _command_frames, _ctx, _person  # noqa: F401

pytestmark = requires_db

REPO = "/home/jeremy/workspace/nova"
HOST = "mini-pc"
WARNING = (
    f"Warning: this touched the live checkout {REPO}, not a worktree of yours — start a "
    "change with start_change and work inside its .worktrees/nova-<id>."
)
INCIDENT_ARGV = [
    "sh",
    "-c",
    f"cd {REPO} && git checkout -b feat/keybindings-shortcuts-session-switcher",
]
WT = f"{REPO}/.worktrees/nova-a1b2c3"


@pytest.fixture
def recorded(monkeypatch):
    monkeypatch.setenv("NOVA_CHECKOUT", REPO)
    monkeypatch.setenv("NOVA_REPO_HOST", HOST)


async def _connect_host(pool, *, name: str, hostname: str):
    """test_devices_ws._connect, with the hostname chosen (it pins "host")."""
    device = FakeDevice()
    person = await _person(pool)
    code = await devices.mint_pairing_code(pool, created_by=person.id)
    enrolled = await devices.enroll(
        pool,
        code=code["code"],
        pubkey=device.pubkey_hex,
        name=name,
        platform="linux",
        hostname=hostname,
    )
    device_id = uuid.UUID(enrolled["device_id"])
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    challenge = await asyncio.wait_for(conn.next_sent(), 2)
    conn.feed(
        {"type": "auth", "device_id": str(device_id), "sig": device.sign_nonce(challenge["nonce"])}
    )
    ready = await asyncio.wait_for(conn.next_sent(), 2)
    assert ready["type"] == "ready"
    return device, conn, task


async def _call(pool, conn, device, tool, args, *, ok=True, output="", exit_code=0, error=None):
    """Dispatch `tool`, answer the one command frame it sends; returns
    (result, ok, facts sink, frames sent)."""
    person = await _person(pool)
    facts: list[dict] = []

    async def answer():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        assert frame["type"] == "command"
        conn.feed(
            device.result(frame["envelope"], ok=ok, output=output, exit_code=exit_code, error=error)
        )

    ans = asyncio.create_task(answer())
    result, dispatched_ok = await tools.dispatch(tool, args, _ctx(person, facts=facts))
    await asyncio.wait_for(ans, 2)
    return result, dispatched_ok, facts, _command_frames(conn)


def _flags(facts: list[dict]) -> list[dict]:
    return [f for f in facts if "outside_worktree" in f]


# -- C1: device_run outside runs, then warns ------------------------------------


async def test_c1_the_incident_argv_runs_and_ends_with_the_warning(pool, recorded):
    device, conn, task = await _connect_host(pool, name="Beelink Mini S", hostname=HOST)
    result, ok, facts, frames = await _call(
        pool,
        conn,
        device,
        "device_run",
        {"device": "Beelink Mini S", "argv": INCIDENT_ARGV},
        output="Switched to a new branch 'feat/keybindings-shortcuts-session-switcher'",
    )
    assert ok is True
    assert len(frames) == 1 and frames[0]["envelope"]["args"]["argv"] == INCIDENT_ARGV
    lines = result.splitlines()
    assert lines[0] == f"Beelink Mini S ran {INCIDENT_ARGV} — exit 0"
    assert guards._RUN_PREAMBLE.search(lines[0]) is not None
    assert "Switched to a new branch" in result
    assert lines[-1] == WARNING
    await _close(conn, task)


async def test_c1_a_cwd_on_the_checkout_runs_and_ends_with_the_warning(pool, recorded):
    device, conn, task = await _connect_host(pool, name="Beelink Mini S", hostname=HOST)
    result, ok, _facts, frames = await _call(
        pool,
        conn,
        device,
        "device_run",
        {"device": "Beelink Mini S", "argv": ["git", "status"], "cwd": REPO},
        output="On branch main",
    )
    assert ok is True
    assert frames[0]["envelope"]["args"] == {"argv": ["git", "status"], "cwd": REPO}
    lines = result.splitlines()
    assert lines[0] == f"Beelink Mini S ran ['git', 'status'] — exit 0 in {REPO}"
    assert lines[-1] == WARNING
    await _close(conn, task)


@pytest.mark.parametrize(
    "args",
    [
        {"argv": INCIDENT_ARGV},
        {"argv": ["git", "status"], "cwd": REPO},
        {"argv": ["git", "status"], "cwd": f"{REPO}/services/core"},
        # Claude's own worktrees are under the checkout but are not hers.
        {"argv": ["ls"], "cwd": f"{REPO}/.claude/worktrees/hub-2"},
        # A worktree cwd does not hide an argv that reaches the checkout.
        {"argv": ["cp", "x", f"{REPO}/apps/web/a.ts"], "cwd": WT},
    ],
)
async def test_c1_the_fact_names_the_checkout_and_the_tool_and_no_device(pool, recorded, args):
    device, conn, task = await _connect_host(pool, name="Beelink Mini S", hostname=HOST)
    _result, ok, facts, _frames = await _call(
        pool, conn, device, "device_run", {"device": "Beelink Mini S", **args}
    )
    assert ok is True
    assert _flags(facts) == [{"outside_worktree": REPO, "tool": "device_run"}]
    await _close(conn, task)


async def test_c1_the_hostname_match_is_case_insensitive(pool, recorded, monkeypatch):
    monkeypatch.setenv("NOVA_REPO_HOST", "MINI-PC")
    device, conn, task = await _connect_host(pool, name="Beelink Mini S", hostname=HOST)
    result, ok, facts, _frames = await _call(
        pool, conn, device, "device_run", {"device": "Beelink Mini S", "argv": INCIDENT_ARGV}
    )
    assert ok is True
    assert result.splitlines()[-1] == WARNING
    assert len(_flags(facts)) == 1
    await _close(conn, task)


# -- C2: device_write_file outside, and a failed outside call -------------------


async def test_c2_a_write_outside_is_written_and_warned(pool, recorded):
    device, conn, task = await _connect_host(pool, name="Beelink Mini S", hostname=HOST)
    path = f"{REPO}/apps/web/src/shortcuts.ts"
    result, ok, facts, frames = await _call(
        pool,
        conn,
        device,
        "device_write_file",
        {"device": "Beelink Mini S", "path": path, "content": "export {}\n"},
    )
    assert ok is True
    assert frames[0]["envelope"]["capability"] == "fs.write"
    assert frames[0]["envelope"]["args"]["path"] == path
    lines = result.splitlines()
    assert lines[0] == f"Wrote {path} on Beelink Mini S."
    assert lines[-1] == WARNING
    assert _flags(facts) == [{"outside_worktree": REPO, "tool": "device_write_file"}]
    await _close(conn, task)


async def test_c2_a_failed_outside_run_still_says_the_warning_and_records_the_fact(pool, recorded):
    device, conn, task = await _connect_host(pool, name="Beelink Mini S", hostname=HOST)
    result, ok, facts, _frames = await _call(
        pool,
        conn,
        device,
        "device_run",
        {"device": "Beelink Mini S", "argv": ["git", "status"], "cwd": f"{REPO}/gone"},
        ok=False,
        exit_code=None,
        error='could not run "git": fork/exec /usr/bin/git: no such file or directory',
    )
    assert ok is False
    assert f"{REPO}/gone" in result  # T3's stated failure, kept
    assert WARNING in result
    assert _flags(facts) == [{"outside_worktree": REPO, "tool": "device_run"}]
    await _close(conn, task)


# -- C3: no flag, and zero cost --------------------------------------------------


@pytest.mark.parametrize(
    "args",
    [
        {"argv": ["git", "status"], "cwd": WT},
        {"argv": ["git", "status"], "cwd": f"{WT}/services/core"},
        {"argv": ["sh", "-c", f"cd {WT} && git commit -am wip"]},
        {"argv": ["ls"], "cwd": "/home/jeremy"},
        # Shares a prefix, is not the checkout.
        {"argv": ["sh", "-c", f"cd {REPO}-old && git status"]},
        {"argv": ["git", "status"], "cwd": f"{REPO}-old"},
    ],
)
async def test_c3_inside_her_worktree_or_off_the_checkout_no_flag(pool, recorded, args):
    device, conn, task = await _connect_host(pool, name="Beelink Mini S", hostname=HOST)
    result, ok, facts, _frames = await _call(
        pool, conn, device, "device_run", {"device": "Beelink Mini S", **args}
    )
    assert ok is True
    assert "Warning:" not in result
    assert _flags(facts) == []
    await _close(conn, task)


async def test_c3_a_write_inside_her_worktree_no_flag(pool, recorded):
    device, conn, task = await _connect_host(pool, name="Beelink Mini S", hostname=HOST)
    result, ok, facts, _frames = await _call(
        pool,
        conn,
        device,
        "device_write_file",
        {"device": "Beelink Mini S", "path": f"{WT}/README.md", "content": "x"},
    )
    assert ok is True
    assert result == f"Wrote {WT}/README.md on Beelink Mini S."
    assert _flags(facts) == []
    await _close(conn, task)


async def test_c3_another_machine_running_the_incident_argv_no_flag(pool, recorded):
    device, conn, task = await _connect_host(pool, name="Dell", hostname="DELL-XPS-8950")
    result, ok, facts, _frames = await _call(
        pool, conn, device, "device_run", {"device": "Dell", "argv": INCIDENT_ARGV}
    )
    assert ok is True
    assert "Warning:" not in result
    assert _flags(facts) == []
    await _close(conn, task)


@pytest.mark.parametrize("unset", ["NOVA_CHECKOUT", "NOVA_REPO_HOST"])
async def test_c3_unrecorded_no_flag(pool, recorded, monkeypatch, unset):
    monkeypatch.delenv(unset)
    device, conn, task = await _connect_host(pool, name="Beelink Mini S", hostname=HOST)
    result, ok, facts, _frames = await _call(
        pool, conn, device, "device_run", {"device": "Beelink Mini S", "argv": INCIDENT_ARGV}
    )
    assert ok is True
    assert "Warning:" not in result
    assert _flags(facts) == []
    await _close(conn, task)


@pytest.mark.parametrize(
    ("tool", "path", "output"),
    [
        ("device_read_file", f"{REPO}/AGENTS.md", "# Nova"),
        ("device_list_files", REPO, "AGENTS.md\napps\nservices"),
    ],
)
async def test_c3_reads_of_the_checkout_never_flag(pool, recorded, tool, path, output):
    device, conn, task = await _connect_host(pool, name="Beelink Mini S", hostname=HOST)
    result, ok, facts, _frames = await _call(
        pool, conn, device, tool, {"device": "Beelink Mini S", "path": path}, output=output
    )
    assert ok is True, result
    assert "Warning:" not in result
    assert _flags(facts) == []
    await _close(conn, task)


async def test_c3_the_check_never_reads_the_device_table_again(pool, recorded, monkeypatch):
    """Zero cost: the admitted row already carries its hostname, so the flag
    must not resolve the repo machine (a second device-table read per call)."""

    async def never(*_a, **_k):
        raise AssertionError("the flag must not resolve the repo machine")

    monkeypatch.setattr(code_repo, "repo_machine", never)
    monkeypatch.setattr(machines.GatewayPlant, "live_devices", never)
    device, conn, task = await _connect_host(pool, name="Beelink Mini S", hostname=HOST)
    result, ok, facts, _frames = await _call(
        pool, conn, device, "device_run", {"device": "Beelink Mini S", "argv": INCIDENT_ARGV}
    )
    assert ok is True, result
    assert result.splitlines()[-1] == WARNING
    assert len(_flags(facts)) == 1
    await _close(conn, task)


# -- C4: the span carries it -----------------------------------------------------


def _spy(monkeypatch, name: str, fact: dict | None):
    async def executor(args, ctx):
        if fact is not None:
            ctx.facts_sink.append(fact)
        return "did it"

    monkeypatch.setitem(
        tools.REGISTRY,
        name,
        tools.Tool(
            name=name,
            description="d",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            executor=executor,
        ),
    )


def _turn() -> traces.Turn:
    return traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))


async def test_c4_the_span_is_marked_when_this_call_left_the_fact(monkeypatch, tmp_path):
    _spy(monkeypatch, "spy_out", {"outside_worktree": REPO, "tool": "spy_out"})
    turn = _turn()
    ctx = tools.ToolContext(app=None, person=None, workspace_root=tmp_path, facts_sink=[])
    result, ok = await chat._run_tool(
        turn, ctx, chat.ToolCall(id="c1", name="spy_out", arguments="{}")
    )
    assert ok is True
    (span,) = turn.spans
    assert span.meta["outside_worktree"] is True
    assert "error" not in span.meta  # C5: marked, not refused


async def test_c4_no_fact_no_mark_and_an_earlier_fact_does_not_leak(monkeypatch, tmp_path):
    _spy(monkeypatch, "spy_plain", None)
    turn = _turn()
    earlier = {"outside_worktree": REPO, "tool": "device_run"}
    ctx = tools.ToolContext(app=None, person=None, workspace_root=tmp_path, facts_sink=[earlier])
    _result, ok = await chat._run_tool(
        turn, ctx, chat.ToolCall(id="c1", name="spy_plain", arguments="{}")
    )
    assert ok is True
    (span,) = turn.spans
    assert "outside_worktree" not in span.meta


async def test_c4_a_device_run_through_run_tool_marks_its_span(pool, recorded):
    device, conn, task = await _connect_host(pool, name="Beelink Mini S", hostname=HOST)
    person = await _person(pool)

    async def answer():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        conn.feed(device.result(frame["envelope"], output="ok"))

    ans = asyncio.create_task(answer())
    turn = _turn()
    call = chat.ToolCall(
        id="c1",
        name="device_run",
        arguments=json.dumps({"device": "Beelink Mini S", "argv": INCIDENT_ARGV}),
    )
    result, ok = await chat._run_tool(turn, _ctx(person, facts=[]), call)
    await asyncio.wait_for(ans, 2)
    assert ok is True, result  # C5: it ran
    (span,) = turn.spans
    assert span.meta["ok"] is True and "error" not in span.meta
    assert span.meta["outside_worktree"] is True
    assert {"outside_worktree": REPO, "tool": "device_run"} in span.meta["facts"]
    await _close(conn, task)


# -- COVERAGE (T4): failures without a cwd, and a failed write ---------------------


async def test_c2_a_failed_outside_run_without_cwd_still_warns(pool, recorded):
    """The argv alone reached the checkout and the agent reported a failure:
    the stated failure keeps the agent's words AND the warning (not only the
    cwd branch)."""
    device, conn, task = await _connect_host(pool, name="Beelink Mini S", hostname=HOST)
    result, ok, facts, _frames = await _call(
        pool,
        conn,
        device,
        "device_run",
        {"device": "Beelink Mini S", "argv": INCIDENT_ARGV},
        ok=False,
        exit_code=None,
        error="fatal: a branch named 'feat/x' already exists",
    )
    assert ok is False
    assert "fatal: a branch named 'feat/x' already exists" in result
    assert result.splitlines()[-1] == WARNING
    assert _flags(facts) == [{"outside_worktree": REPO, "tool": "device_run"}]
    await _close(conn, task)


async def test_c2_a_failed_outside_write_still_warns(pool, recorded):
    device, conn, task = await _connect_host(pool, name="Beelink Mini S", hostname=HOST)
    result, ok, facts, _frames = await _call(
        pool,
        conn,
        device,
        "device_write_file",
        {"device": "Beelink Mini S", "path": f"{REPO}/AGENTS.md", "content": "x"},
        ok=False,
        error="permission denied",
    )
    assert ok is False
    assert "permission denied" in result
    assert result.splitlines()[-1] == WARNING
    assert _flags(facts) == [{"outside_worktree": REPO, "tool": "device_write_file"}]
    await _close(conn, task)
