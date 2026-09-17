"""`load_skill` — the one way a written-down procedure reaches a turn.

The tool is the record as much as the reader: the roster names skills and
never carries their bodies, so the SPAN this call leaves is what makes "she
used a skill" a fact rather than something inferred from the shape of a reply.
Everything here is about what it refuses to hand over.
"""

from __future__ import annotations

import pytest

from app import skills, tools
from app.tools.base import ToolContext
from app.tools.workspace import WORKSPACE_ROOT_ENV
from tests.conftest import requires_db

pytestmark = requires_db


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    """Skills live at <WORKSPACE_ROOT>/skills/ for the whole household, NOT
    under the caller's own folder — an agent turn whose root is agents/<name>/
    reads the same procedures Nova does."""
    root = tmp_path / "workspace"
    root.mkdir()
    monkeypatch.setenv(WORKSPACE_ROOT_ENV, str(root))
    return root


def _ctx(root) -> ToolContext:
    return ToolContext(app=None, person=None, workspace_root=root)


async def _seed(pool, root, name, *, status, body="1. list the files\n2. read each one\n"):
    await skills.create(
        pool,
        name=name,
        title=f"title {name}",
        summary=f"asked as: '{name} please'",
        created_via="page",
        body=body,
        root=root,
    )
    if status != skills.DRAFT:
        reason = "the ledger said so" if status == skills.FLAGGED else None
        await skills.set_status(pool, name, status, reason=reason)


async def test_an_active_skill_comes_back_with_its_body(pool, workspace):
    await _seed(pool, workspace, "tidy", status=skills.ACTIVE)
    result, ok = await tools.dispatch("load_skill", {"name": "tidy"}, _ctx(workspace))
    assert ok
    assert "1. list the files" in result
    assert "title tidy" in result


async def test_the_body_is_framed_as_a_record_not_an_instruction(pool, workspace):
    await _seed(pool, workspace, "tidy", status=skills.ACTIVE)
    result, _ = await tools.dispatch("load_skill", {"name": "tidy"}, _ctx(workspace))
    # The same discipline as the memory header: what she is handed is what
    # worked before, and it does not become true by being written down.
    assert "worked before" in result
    assert "check it still fits" in result


@pytest.mark.parametrize("status", [skills.DRAFT, skills.FLAGGED, skills.RETIRED])
async def test_a_skill_that_is_not_active_is_refused_by_status(pool, workspace, status):
    await _seed(pool, workspace, "pulled", status=status)
    result, ok = await tools.dispatch("load_skill", {"name": "pulled"}, _ctx(workspace))
    assert not ok
    assert status in result
    assert "1. list the files" not in result


async def test_an_unknown_name_is_refused_with_what_does_exist(pool, workspace):
    await _seed(pool, workspace, "tidy", status=skills.ACTIVE)
    result, ok = await tools.dispatch("load_skill", {"name": "nope"}, _ctx(workspace))
    assert not ok
    assert "tidy" in result


async def test_a_row_whose_file_is_gone_refuses_instead_of_reading_as_empty(pool, workspace):
    await _seed(pool, workspace, "tidy", status=skills.ACTIVE)
    skills.body_path("tidy", workspace).unlink()
    result, ok = await tools.dispatch("load_skill", {"name": "tidy"}, _ctx(workspace))
    assert not ok
    assert "file is missing" in result


async def test_the_skill_is_read_from_the_household_root_not_the_callers_folder(pool, workspace):
    """An agent's context root is agents/<name>/. If the tool resolved skills
    under it, every agent turn would find none and say so — a capability that
    silently disappears for exactly the callers most likely to need it."""
    await _seed(pool, workspace, "tidy", status=skills.ACTIVE)
    agent_root = workspace / "agents" / "coder"
    agent_root.mkdir(parents=True)
    result, ok = await tools.dispatch("load_skill", {"name": "tidy"}, _ctx(agent_root))
    assert ok
    assert "1. list the files" in result


# ── run_skill (S18) ────────────────────────────────────────────────────────

SCRIPT = {
    "version": 1,
    "steps": [
        {"tool": "workspace_read_file", "args": {"path": "{{ p }}"}, "for_each": "paths", "as": "p"},
        {"tool": "workspace_delete", "args": {"path": "{{ p }}"}, "for_each": "paths", "as": "p"},
    ],
}
SCRIPT_INPUTS = {
    "type": "object",
    "properties": {"paths": {"type": "array", "items": {"type": "string"}}},
    "required": ["paths"],
    "additionalProperties": False,
}


async def _scripted(pool, root, name="tidy"):
    await _seed(pool, root, name, status=skills.ACTIVE)
    await skills.set_script(pool, name, SCRIPT, SCRIPT_INPUTS)


async def test_a_script_runs_every_step_through_the_registry(pool, workspace):
    await _scripted(pool, workspace)
    for note in ("a.md", "b.md"):
        (workspace / note).write_text("superseded", encoding="utf-8")

    result, ok = await tools.dispatch(
        "run_skill", {"name": "tidy", "inputs": {"paths": ["a.md", "b.md"]}}, _ctx(workspace)
    )

    assert ok, result
    assert "All 4 steps ran" in result
    # The files really went, and to the trash the delete tool keeps.
    assert not (workspace / "a.md").exists()
    assert not (workspace / "b.md").exists()


async def test_a_failing_step_stops_the_run_and_the_tool_reports_it_as_a_failure(
    pool, workspace
):
    await _scripted(pool, workspace)
    (workspace / "a.md").write_text("superseded", encoding="utf-8")

    result, ok = await tools.dispatch(
        "run_skill", {"name": "tidy", "inputs": {"paths": ["a.md", "gone.md"]}}, _ctx(workspace)
    )

    assert not ok
    assert "step 1" in result
    assert "gone.md" in result
    # a.md was read and deleted only if its step came before the failure; the
    # shape under test is that the run STOPPED, and said so.
    assert "not attempted" in result


async def test_inputs_that_do_not_match_the_schema_are_refused_before_anything_runs(
    pool, workspace
):
    await _scripted(pool, workspace)
    (workspace / "a.md").write_text("superseded", encoding="utf-8")

    result, ok = await tools.dispatch(
        "run_skill", {"name": "tidy", "inputs": {"path": "a.md"}}, _ctx(workspace)
    )

    assert not ok
    assert (workspace / "a.md").is_file()


async def test_an_unscripted_skill_names_the_tool_that_does_read_one(pool, workspace):
    """A model that reached for the wrong verb is told the right one, rather
    than left to guess from a refusal."""
    await _seed(pool, workspace, "prose", status=skills.ACTIVE)

    result, ok = await tools.dispatch(
        "run_skill", {"name": "prose", "inputs": {}}, _ctx(workspace)
    )

    assert not ok
    assert skills.LOAD_TOOL in result


async def test_a_retired_script_is_refused_by_status_like_any_other_skill(pool, workspace):
    await _scripted(pool, workspace)
    await skills.set_status(pool, "tidy", skills.RETIRED)

    result, ok = await tools.dispatch(
        "run_skill", {"name": "tidy", "inputs": {"paths": []}}, _ctx(workspace)
    )

    assert not ok
    assert skills.RETIRED in result
