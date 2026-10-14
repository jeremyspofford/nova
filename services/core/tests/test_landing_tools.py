"""S32.3 T11: landing_status and close_change (docs/plans/rebuild/s32/spec.md
§5.3, §5.4), and repo_land's own `landing` fact.

landing_status reads a landing back from its row (migration 050) — the record
every claim about a landing is held to — and files a `landing` fact for each
row it read, so a claim in the same turn can be checked against it (T13).
close_change takes a change down without landing it: its box (box.remove,
T7) and its worktree (`git worktree remove --force`) — the branch is kept.

close_change runs REAL git against a bare "origin" in tmp through a fake
agent that runs each shell.exec argv for real (test_repo_land's fixtures);
nothing reaches the network.

Criteria:
  C1 landing_status(id) reads the row: id, change, branch, verdict, the
     stage of a running one, the reason, base and judged SHA, author/coder;
     for green the merged SHA, the PR and the push result — a green landing
     whose publish did not reach main says it is NOT merged and why; never
     "Merged" for anything but a merged SHA; each suite's command, outcome,
     exit and counts (unknown counts never shown as 0), the tail of a suite
     that did not pass only; protected and dirty_outside (or "none"); a
     conflict's files.
  C2 A malformed or unknown id is an Error naming it and how to find one,
     with no fact filed.
  C3 No id: the newest RECENT landings, newest first, one line each with
     the full id, change, verdict (and merged SHA when merged); none ->
     exactly NO_LANDINGS.
  C4 Facts: each landing landing_status read files one
     {"landing": {id, change, verdict, merged_sha, suites: [{suite, exit,
     outcome}]}} (JSON-serialisable, strings); repo_land files the same
     shape for its new landing (verdict running) IN the call.
  C5 close_change removes the change's box (box.remove {change}) and its
     worktree (gone from disk and from `git worktree list`), keeps its
     branch at its SHA and names it; uncommitted work (modified, untracked)
     is named as discarded, or "nothing uncommitted"; another change is
     untouched.
  C6 close_change refuses, Error and nothing removed: a malformed id
     (nothing sent), no open worktree of hers for the id, a landing of the
     change still running (named); a finished landing does not stop it.
     A step that fails is stated (Error) naming what was and was not
     removed: a box the agent could not remove still lets the worktree go;
     a worktree git refuses to remove is named with git's words.
  C7 The tools: landing_status a read (reads_only, ephemeral, listing),
     schema {id} optional; close_change a write, schema {change} required;
     neither has extra properties.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import uuid

import pytest

from app import landings, tools
from app.landing_plan import suite_result
from app.tools import landing as landing_tools
from app.tools.base import RESULT_KIND_LISTING
from tests import test_repo_land as _land
from tests.conftest import requires_db
from tests.test_devices_ws import _close, _person
from tests.test_repo_land import (
    BRANCH,
    BRANCH2,
    ID,
    ID2,
    Agent,
    Repo,
    _ctx,
    _git,
    _serve,
    _turn,
)
from tests.test_start_change import _connect

pytestmark = requires_db

# test_repo_land's fixtures: a real git checkout + bare origin in tmp, and
# run_suites faked.
repo = _land.repo
suites = _land.suites

SHA_BASE = "0123456789abcdef0123456789abcdef01234567"
SHA_JUDGED = "89abcdef0123456789abcdef0123456789abcdef"
PR_URL = "https://github.com/acme/nova/pull/7"
RUFF = ("ruff", "check", "--", "services/core/app/x.py")
PYTEST = ("uv", "run", "pytest")


@pytest.fixture
def registered(monkeypatch):
    for name, tool in (
        (landing_tools.LANDING_STATUS, landing_tools.LANDING_STATUS_TOOL),
        (landing_tools.CLOSE_CHANGE, landing_tools.CLOSE_CHANGE_TOOL),
        (landing_tools.REPO_LAND, landing_tools.REPO_LAND_TOOL),
    ):
        monkeypatch.setitem(tools.REGISTRY, name, tool)


def _passed(suite: str, argv: tuple[str, ...]) -> dict:
    log = "=== 4 passed, 1 skipped in 2.0s ===\n" if "pytest" in argv else "All checks passed!\n"
    if "pytest" in argv:
        log = "SKIPPED [1] tests/test_x.py:3: needs a GPU\n" + log
    return suite_result(suite, argv, state="done", exit_code=0, log=log, seconds=2.0)


def _failed(suite: str, argv: tuple[str, ...]) -> dict:
    log = "FAILED tests/test_x.py::test_iso_week - AssertionError: 41 != 42\n"
    log += "=== 1 failed, 3 passed in 1.5s ===\n"
    return suite_result(suite, argv, state="done", exit_code=1, log=log, seconds=1.5)


async def _status(pool, args: dict) -> tuple[str, bool, list[dict]]:
    turn = await _turn(pool)
    facts: list[dict] = []
    result, ok = await asyncio.wait_for(
        tools.dispatch(landing_tools.LANDING_STATUS, args, _ctx(turn, facts)), 10
    )
    return result, ok, facts


async def _green(pool, *, merged: bool = True, push_result: str | None = None) -> uuid.UUID:
    lid = await landings.insert(
        pool,
        change_id=ID,
        repo="nova",
        branch=BRANCH,
        turn_id=None,
        author="Nova <nova@mini-pc>",
        coder="nova-loop ollama:qwen3:8b",
        commit_sha=SHA_JUDGED,
    )
    await landings.update(
        pool,
        lid,
        base_sha=SHA_BASE,
        protected=["services/core/tests/test_x.py"],
        dirty_outside=["notes.txt"],
    )
    await landings.finish(
        pool, lid, "green", suites=[_passed("ruff", RUFF), _passed("core", PYTEST)]
    )
    if merged:
        await landings.record_publish(
            pool,
            lid,
            merged_sha=SHA_JUDGED,
            pr_url=PR_URL,
            push_result=push_result or f"pushed {BRANCH}; opened {PR_URL}; main is {SHA_JUDGED}",
        )
    elif push_result is not None:
        await landings.record_publish(
            pool, lid, merged_sha=None, pr_url=PR_URL, push_result=push_result
        )
    return lid


# -- C1: one landing read back ---------------------------------------------------


async def test_c1_a_running_landing_names_its_stage_and_is_not_merged(pool, registered):
    lid = await landings.insert(
        pool, change_id=ID, repo="nova", branch=BRANCH, turn_id=None, commit_sha=SHA_JUDGED
    )
    await landings.update(pool, lid, stage="making the clean copy")
    result, ok, _facts = await _status(pool, {"id": str(lid)})
    assert ok is True, result
    assert str(lid) in result
    assert ID in result and BRANCH in result
    assert "running" in result
    assert "making the clean copy" in result
    assert SHA_JUDGED in result
    assert "Merged:" not in result
    assert "Not merged: the verdict is not known yet" in result


async def test_c1_a_green_merged_landing_names_the_merged_sha_pr_and_suites(pool, registered):
    lid = await _green(pool)
    result, ok, _facts = await _status(pool, {"id": str(lid)})
    assert ok is True, result
    assert "green" in result
    assert f"Merged: {SHA_JUDGED}" in result
    assert PR_URL in result
    assert f"main is {SHA_JUDGED}" in result  # the push result
    assert SHA_BASE in result
    assert "nova-loop ollama:qwen3:8b" in result and "Nova <nova@mini-pc>" in result
    assert "ruff check -- services/core/app/x.py" in result
    assert "uv run pytest" in result
    core = next(line for line in result.splitlines() if "uv run pytest" in line)
    assert "passed" in core and "exit 0" in core and "4 passed" in core and "1 skipped" in core
    assert "services/core/tests/test_x.py" in result
    assert "notes.txt" in result
    # A passing suite's tail is not shown.
    assert "needs a GPU" not in result


async def test_c1_a_green_landing_that_did_not_reach_main_is_not_merged(pool, registered):
    lid = await _green(pool, merged=False, push_result="main moved during the landing; land again")
    result, ok, _facts = await _status(pool, {"id": str(lid)})
    assert ok is True, result
    assert "Merged:" not in result
    assert "Not merged: main moved during the landing; land again" in result


async def test_c1_a_green_landing_still_publishing_is_not_merged(pool, registered):
    lid = await _green(pool, merged=False)
    result, ok, _facts = await _status(pool, {"id": str(lid)})
    assert ok is True, result
    assert "Merged:" not in result
    assert "Not merged" in result and "publish" in result


async def test_c1_a_red_landing_names_the_failing_suite_and_its_tail(pool, registered):
    lid = await landings.insert(
        pool, change_id=ID, repo="nova", branch=BRANCH, turn_id=None, commit_sha=SHA_JUDGED
    )
    await landings.finish(
        pool,
        lid,
        "red",
        reason="core `uv run pytest` exited 1",
        suites=[_passed("ruff", RUFF), _failed("core", PYTEST)],
    )
    result, ok, _facts = await _status(pool, {"id": str(lid)})
    assert ok is True, result
    assert "red" in result
    assert "core `uv run pytest` exited 1" in result
    core = next(line for line in result.splitlines() if "uv run pytest" in line and "-" in line)
    assert "failed" in core and "exit 1" in core and "1 failed" in core
    assert "AssertionError: 41 != 42" in result  # the failing suite's tail
    assert "Merged:" not in result
    assert "Not merged" in result


async def test_c1_unknown_counts_are_never_shown_as_zero(pool, registered):
    lid = await landings.insert(pool, change_id=ID, repo="nova", branch=BRANCH, turn_id=None)
    lost = suite_result(
        "core", PYTEST, state="lost", exit_code=None, log="", seconds=None, reason="agent gone"
    )
    await landings.finish(pool, lid, "could_not_measure", reason="core: agent gone", suites=[lost])
    result, ok, _facts = await _status(pool, {"id": str(lid)})
    assert ok is True, result
    core = next(line for line in result.splitlines() if "uv run pytest" in line)
    assert "0 passed" not in core and "None" not in core
    assert "could_not_measure" in result and "agent gone" in result


async def test_c1_a_conflict_names_its_files(pool, registered):
    lid = await landings.insert(pool, change_id=ID, repo="nova", branch=BRANCH, turn_id=None)
    await landings.finish(
        pool,
        lid,
        "conflict",
        base_sha=SHA_BASE,
        conflict_files=["README.md", "services/core/app/x.py"],
        reason="rebasing conflicted",
    )
    result, ok, _facts = await _status(pool, {"id": str(lid)})
    assert ok is True, result
    assert "conflict" in result
    line = next(line for line in result.splitlines() if "README.md" in line)
    assert "services/core/app/x.py" in line


async def test_c1_nothing_protected_or_dirty_says_none(pool, registered):
    lid = await landings.insert(pool, change_id=ID, repo="nova", branch=BRANCH, turn_id=None)
    result, ok, _facts = await _status(pool, {"id": str(lid)})
    assert ok is True, result
    protected = next(line for line in result.splitlines() if line.startswith("Protected"))
    dirty = next(line for line in result.splitlines() if line.startswith("Dirty"))
    assert protected.endswith("none") and dirty.endswith("none")


# -- C2: an id that names no landing -------------------------------------------


@pytest.mark.parametrize("bad", ["abc", "a1b2c3", "", "  ", "../etc"])
async def test_c2_a_malformed_id_is_an_error_and_files_nothing(pool, registered, bad):
    result, ok, facts = await _status(pool, {"id": bad})
    assert ok is False
    assert result.startswith("Error:")
    assert "landing id" in result
    assert facts == []


async def test_c2_an_unknown_id_is_named_and_files_nothing(pool, registered):
    await _green(pool)
    unknown = uuid.uuid4()
    result, ok, facts = await _status(pool, {"id": str(unknown)})
    assert ok is False
    assert str(unknown) in result
    assert "landing_status" in result  # how to find one
    assert facts == []


# -- C3: the newest landings ----------------------------------------------------


async def test_c3_no_landing_at_all_is_said_plainly(pool, registered):
    result, ok, facts = await _status(pool, {})
    assert ok is True
    assert result.strip() == landing_tools.NO_LANDINGS
    assert facts == []


async def test_c3_the_newest_landings_newest_first(pool, registered):
    ids = []
    for i in range(landing_tools.RECENT + 2):
        change = f"{i:06x}"
        lid = await landings.insert(
            pool, change_id=change, repo="nova", branch=f"nova/{change}-x", turn_id=None
        )
        await pool.execute(
            "UPDATE landings SET created_at = now() - make_interval(mins => $2) WHERE id = $1",
            lid,
            100 - i,
        )
        ids.append(lid)
    result, ok, _facts = await _status(pool, {})
    assert ok is True, result
    shown = [str(i) for i in reversed(ids)][: landing_tools.RECENT]
    lines = [line for line in result.splitlines() if line.startswith("- ")]
    assert len(lines) == landing_tools.RECENT
    for line, lid in zip(lines, shown, strict=True):
        assert lid in line and "running" in line
    assert str(ids[0]) not in result and str(ids[1]) not in result
    assert f"{len(ids)}" in result.splitlines()[0]  # says how many there are


async def test_c3_a_merged_landing_shows_its_merged_sha(pool, registered):
    lid = await _green(pool)
    result, ok, _facts = await _status(pool, {})
    assert ok is True, result
    (line,) = [line for line in result.splitlines() if str(lid) in line]
    assert ID in line and "green" in line and SHA_JUDGED[:7] in line


# -- C4: facts ------------------------------------------------------------------


async def test_c4_a_read_landing_files_one_landing_fact(pool, registered):
    lid = await _green(pool)
    _result, ok, facts = await _status(pool, {"id": str(lid)})
    assert ok is True
    assert facts == [
        {
            "landing": {
                "id": str(lid),
                "change": ID,
                "verdict": "green",
                "merged_sha": SHA_JUDGED,
                "suites": [
                    {"suite": "ruff", "exit": 0, "outcome": "passed"},
                    {"suite": "core", "exit": 0, "outcome": "passed"},
                ],
            }
        }
    ]
    json.dumps(facts)


async def test_c4_a_green_landing_not_on_main_carries_no_merged_sha(pool, registered):
    lid = await _green(pool, merged=False, push_result="main moved during the landing")
    _result, _ok, facts = await _status(pool, {"id": str(lid)})
    (fact,) = facts
    assert fact["landing"]["verdict"] == "green"
    assert fact["landing"]["merged_sha"] is None


async def test_c4_the_listing_files_a_fact_per_landing_shown(pool, registered):
    first = await _green(pool)
    second = await landings.insert(pool, change_id=ID2, repo="nova", branch=BRANCH2, turn_id=None)
    _result, ok, facts = await _status(pool, {})
    assert ok is True
    by_id = {f["landing"]["id"]: f["landing"] for f in facts}
    assert set(by_id) == {str(first), str(second)}
    assert by_id[str(second)]["verdict"] == "running"
    assert by_id[str(second)]["merged_sha"] is None
    assert by_id[str(first)]["merged_sha"] == SHA_JUDGED
    json.dumps(facts)


async def _dispatch(pool, name: str, args: dict, agent: Agent | None = None):
    """Dispatch a tool while the agent answers; (result, ok, agent, facts)."""
    device, conn, task = await _connect(pool)
    agent = agent or Agent()
    await _person(pool)
    turn = await _turn(pool)
    facts: list[dict] = []
    server = asyncio.create_task(_serve(conn, device, agent))
    try:
        result, ok = await asyncio.wait_for(tools.dispatch(name, args, _ctx(turn, facts)), 30)
    finally:
        server.cancel()
        await _close(conn, task)
    return result, ok, agent, facts


async def test_c4_repo_land_files_its_running_landing_in_the_call(
    pool, repo, registered, suites, monkeypatch
):
    started = []
    monkeypatch.setattr(landing_tools.landing_run, "start", lambda *a, **kw: started.append(kw))
    result, ok, _agent, facts = await _dispatch(pool, landing_tools.REPO_LAND, {"change": ID})
    assert ok is True, result
    (row,) = await pool.fetch("SELECT id FROM landings")
    assert started and started[0]["landing_id"] == row["id"]
    landing_facts = [f for f in facts if "landing" in f]
    assert landing_facts == [
        {
            "landing": {
                "id": str(row["id"]),
                "change": ID,
                "verdict": "running",
                "merged_sha": None,
                "suites": [],
            }
        }
    ]


async def test_c4_a_refused_repo_land_files_no_landing(pool, repo, registered, suites):
    (repo.worktree / "y.py").write_text("B = 1\n")
    result, ok, _agent, facts = await _dispatch(pool, landing_tools.REPO_LAND, {"change": ID})
    assert ok is False, result
    assert [f for f in facts if "landing" in f] == []


# -- C5: close_change -------------------------------------------------------------


def _listed(repo: Repo) -> str:
    return _git(repo.checkout, "worktree", "list", "--porcelain")


def _branch_sha(repo: Repo, branch: str) -> str | None:
    done = subprocess.run(
        ["git", "-C", str(repo.checkout), "rev-parse", "--verify", "-q", f"refs/heads/{branch}"],
        capture_output=True,
        text=True,
    )
    return done.stdout.strip() or None


async def test_c5_close_removes_the_box_and_the_worktree_and_keeps_the_branch(
    pool, repo, registered
):
    sha = repo.sha
    result, ok, agent, _facts = await _dispatch(pool, landing_tools.CLOSE_CHANGE, {"change": ID})
    assert ok is True, result
    assert agent.removed() == [ID]
    removes = [e for e in agent.seen if e["capability"] == "box.remove"]
    assert removes[0]["args"] == {"change": ID}
    assert not repo.worktree.exists()
    assert str(repo.worktree) not in _listed(repo)
    assert _branch_sha(repo, BRANCH) == sha
    assert f"nova-box-{ID}" in result
    assert str(repo.worktree) in result
    assert BRANCH in result and sha[:7] in result and "kept" in result
    assert "nothing uncommitted" in result


async def test_c5_uncommitted_work_is_named_as_discarded(pool, repo, registered):
    (repo.worktree / "services" / "core" / "app" / "x.py").write_text("A = 3\n")
    (repo.worktree / "new notes.txt").write_text("draft\n")
    result, ok, _agent, _facts = await _dispatch(pool, landing_tools.CLOSE_CHANGE, {"change": ID})
    assert ok is True, result
    assert not repo.worktree.exists()
    line = next(line for line in result.splitlines() if "discarded" in line)
    assert "new notes.txt" in line and "services/core/app/x.py" in line
    assert "nothing uncommitted" not in result


async def test_c5_another_change_is_untouched(pool, repo, registered):
    other = repo.add_change(ID2, BRANCH2, {"b.txt": "b\n"})
    result, ok, agent, _facts = await _dispatch(pool, landing_tools.CLOSE_CHANGE, {"change": ID})
    assert ok is True, result
    assert agent.removed() == [ID]
    assert other.exists() and (other / "b.txt").read_text() == "b\n"
    assert str(other) in _listed(repo)


# -- C6: close_change's refusals and failures ------------------------------------


@pytest.mark.parametrize("change", ["ABCDEF", "a1b2c", "a1b2c3d", "../x12", "a1b2c\n"])
async def test_c6_a_malformed_change_is_refused_with_nothing_sent(pool, repo, registered, change):
    result, ok, agent, _facts = await _dispatch(
        pool, landing_tools.CLOSE_CHANGE, {"change": change}
    )
    assert ok is False
    assert result.startswith("Error:") and "change" in result
    assert agent.seen == []
    assert repo.worktree.exists()


async def test_c6_no_open_worktree_is_named_and_nothing_removed(pool, repo, registered):
    result, ok, agent, _facts = await _dispatch(
        pool, landing_tools.CLOSE_CHANGE, {"change": "ffffff"}
    )
    assert ok is False
    assert "ffffff" in result and "list_changes" in result
    assert agent.removed() == []
    assert repo.worktree.exists()


async def test_c6_a_running_landing_of_the_change_is_named_and_nothing_removed(
    pool, repo, registered
):
    lid = await landings.insert(pool, change_id=ID, repo="nova", branch=BRANCH, turn_id=None)
    result, ok, agent, _facts = await _dispatch(pool, landing_tools.CLOSE_CHANGE, {"change": ID})
    assert ok is False
    assert str(lid) in result and "landing_status" in result
    assert agent.removed() == []
    assert repo.worktree.exists()
    assert str(repo.worktree) in _listed(repo)


async def test_c6_a_finished_landing_does_not_stop_the_close(pool, repo, registered):
    lid = await landings.insert(pool, change_id=ID, repo="nova", branch=BRANCH, turn_id=None)
    await landings.finish(pool, lid, "red", reason="core failed")
    result, ok, agent, _facts = await _dispatch(pool, landing_tools.CLOSE_CHANGE, {"change": ID})
    assert ok is True, result
    assert agent.removed() == [ID]
    assert not repo.worktree.exists()


class _OldAgent(Agent):
    async def answer(self, envelope: dict) -> dict:
        if envelope["capability"] == "box.remove":
            self.seen.append(envelope)
            return {
                "ok": False,
                "output": "",
                "exit_code": None,
                "error": 'unknown capability "box.remove"',
            }
        return await super().answer(envelope)


async def test_c6_a_box_not_removed_is_stated_and_the_worktree_still_goes(pool, repo, registered):
    result, ok, _agent, _facts = await _dispatch(
        pool, landing_tools.CLOSE_CHANGE, {"change": ID}, _OldAgent()
    )
    assert ok is False
    assert "predates box removal" in result
    assert f"nova-box-{ID}" in result
    assert not repo.worktree.exists()
    assert "removed" in result and str(repo.worktree) in result
    assert _branch_sha(repo, BRANCH) == repo.sha


async def test_c6_a_worktree_git_refuses_to_remove_is_named(pool, repo, registered):
    _git(repo.checkout, "worktree", "lock", "--reason", "held", str(repo.worktree))
    result, ok, agent, _facts = await _dispatch(pool, landing_tools.CLOSE_CHANGE, {"change": ID})
    assert ok is False
    assert repo.worktree.exists()
    assert "locked" in result  # git's own words
    assert str(repo.worktree) in result and "not removed" in result
    assert agent.removed() == [ID]
    assert f"nova-box-{ID} removed" in result


# -- C7: the tool definitions ---------------------------------------------------


def test_c7_landing_status_is_a_read():
    tool = landing_tools.LANDING_STATUS_TOOL
    assert tool.name == "landing_status"
    assert tool.reads_only is True
    assert tool.ephemeral is True
    assert tool.result_kind == RESULT_KIND_LISTING
    assert tool.parameters["type"] == "object"
    assert set(tool.parameters["properties"]) == {"id"}
    assert tool.parameters["properties"]["id"]["type"] == "string"
    assert tool.parameters.get("required", []) == []
    assert tool.parameters["additionalProperties"] is False
    assert "repo_land" in tool.description and "landing" in tool.description


def test_c7_close_change_is_a_write():
    tool = landing_tools.CLOSE_CHANGE_TOOL
    assert tool.name == "close_change"
    assert tool.reads_only is False
    assert tool.ephemeral is False
    assert set(tool.parameters["properties"]) == {"change"}
    assert tool.parameters["required"] == ["change"]
    assert tool.parameters["additionalProperties"] is False
    assert "branch" in tool.description and "box" in tool.description
