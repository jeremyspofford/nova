"""walk-fixes T4 (turn 8719a8f1, 2026-10-10): her notes workspace is never
mistaken for a change's worktree.

After start_change she wrote README.md with workspace_write_file — the notes
workspace on the hub, not the worktree — and said the worktree's README.md was
updated. Criteria:
  (a) every workspace_* description says it is her notes workspace on the hub
      (not a code repository, not a device, not a change's worktree) and names
      device_read_file / device_edit_file / device_write_file for those;
  (c) a workspace write or delete in a turn where a change is open (a
      {"change", "worktree_path"} fact on the turn's facts_sink — start_change
      or list_changes recorded it earlier) still RUNS (owner ruling 09-03: no
      gates), then its result ends with a warning naming the worktree path and
      device_edit_file / device_write_file, and its span carries
      not_the_worktree: true. Without a change fact: no warning, no flag.
      Reads never warn.
((b), start_change's result text, is in test_start_change.py.)
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

import pytest

from app import chat, tools, traces
from app.tools.base import ToolContext

WT = "/home/jeremy/workspace/nova/.worktrees/nova-3e8ab0"
WT_2 = "/home/jeremy/workspace/nova/.worktrees/nova-a1b2c3"
CHANGE = {"change": "3e8ab0", "worktree_path": WT, "branch": "nova/3e8ab0-edit-test"}
WORKSPACE_TOOLS = (
    "workspace_write_file",
    "workspace_read_file",
    "workspace_list_files",
    "workspace_delete",
)


def _ctx(root, facts):
    return ToolContext(app=None, person=None, workspace_root=root, facts_sink=facts)


async def _run(root, facts, name, args):
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    result, ok = await chat._run_tool(
        turn, _ctx(root, facts), chat.ToolCall(id="c1", name=name, arguments=json.dumps(args))
    )
    (span,) = turn.spans
    return result, ok, span


# -- (a) the descriptions --------------------------------------------------------


@pytest.mark.parametrize("name", WORKSPACE_TOOLS)
def test_a_each_workspace_tool_says_it_is_her_notes_workspace_on_the_hub(name):
    description = tools.REGISTRY[name].description
    for words in (
        "notes workspace on the hub",
        "not a code repository",
        "not a device",
        "not a change's worktree",
        "device_read_file",
        "device_edit_file",
        "device_write_file",
    ):
        assert words in description, (name, words)


# -- (c) the warning and the flag ------------------------------------------------


async def test_c_a_write_after_start_change_runs_then_warns_and_flags(tmp_path):
    facts = [dict(CHANGE)]
    result, ok, span = await _run(
        tmp_path, facts, "workspace_write_file", {"path": "README.md", "content": "# x\n"}
    )
    assert ok is True
    assert (tmp_path / "README.md").read_text() == "# x\n"  # warn, never refuse
    assert result.startswith("Wrote README.md")
    tail = result.splitlines()[-1]
    assert tail.startswith("Warning:")
    for words in ("notes workspace", WT, "device_edit_file", "device_write_file"):
        assert words in tail, words
    assert span.meta["not_the_worktree"] is True
    assert {"not_the_worktree": WT, "tool": "workspace_write_file"} in span.meta["facts"]


async def test_c_a_delete_after_a_change_warns_and_flags(tmp_path):
    (tmp_path / "README.md").write_text("old")
    result, ok, span = await _run(
        tmp_path, [dict(CHANGE)], "workspace_delete", {"path": "README.md"}
    )
    assert ok is True
    assert not (tmp_path / "README.md").exists()
    assert result.splitlines()[-1].startswith("Warning:") and WT in result
    assert span.meta["not_the_worktree"] is True


async def test_c_two_open_changes_are_both_named(tmp_path):
    facts = [dict(CHANGE), {"change": "a1b2c3", "worktree_path": WT_2, "branch": None}]
    result, ok, _span = await _run(
        tmp_path, facts, "workspace_write_file", {"path": "a.md", "content": "a"}
    )
    assert ok is True
    assert WT in result and WT_2 in result


async def test_c_no_change_this_turn_no_warning_no_flag(tmp_path):
    facts = [{"device": "DELL-XPS-8950", "connected": True}]
    result, ok, span = await _run(
        tmp_path, facts, "workspace_write_file", {"path": "groceries.md", "content": "eggs"}
    )
    assert ok is True
    assert result == "Wrote groceries.md (4 bytes)"
    assert "not_the_worktree" not in span.meta
    assert not [f for f in facts if "not_the_worktree" in f]


async def test_c_no_facts_sink_no_warning(tmp_path):
    result, ok = await tools.dispatch(
        "workspace_write_file", {"path": "a.md", "content": "a"}, _ctx(tmp_path, None)
    )
    assert ok is True and "Warning" not in result


@pytest.mark.parametrize(
    ("name", "args"),
    [("workspace_read_file", {"path": "a.md"}), ("workspace_list_files", {})],
)
async def test_c_reads_after_a_change_never_warn(tmp_path, name, args):
    (tmp_path / "a.md").write_text("a")
    result, ok, span = await _run(tmp_path, [dict(CHANGE)], name, args)
    assert ok is True
    assert "Warning" not in result
    assert "not_the_worktree" not in span.meta


async def test_c_a_failed_write_after_a_change_carries_no_warning(tmp_path):
    (tmp_path / "d").mkdir()
    result, ok, span = await _run(
        tmp_path, [dict(CHANGE)], "workspace_write_file", {"path": "d", "content": "a"}
    )
    assert ok is False
    assert "Warning" not in result
    assert "not_the_worktree" not in span.meta
