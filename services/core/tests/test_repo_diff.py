"""S32.3 T12: repo_diff — a change's diff against main, by file, with ranges
(docs/plans/rebuild/s32/spec.md §5.4).

Her COMMITTED work (what repo_land would judge) against the merge base of
her HEAD with the machine's origin/<main> as last fetched — three-dot, so
main's own later commits never show as hers. Real git in tmp through a fake
agent that runs each shell.exec argv for real (test_repo_land's fixtures);
nothing reaches the network.

Criteria:
  C1 Refusals, an Error with nothing else read: a malformed change id
     (nothing sent); no open worktree of hers for the id (named, with
     list_changes); a `path` that is not one of the change's files (its
     files named).
  C2 The summary: base (merge base) and HEAD SHAs, branch, commits ahead;
     one line per file of her committed work — path, added/modified/deleted,
     +added -removed (a binary file said, no counts), new-side line ranges
     from the hunks (a removal-only hunk "removed after line N"); main's
     later commits never appear; a body line that looks like a header is not
     a file; a quoted path is unquoted; no commit beyond main is said
     plainly, not an Error.
  C3 Uncommitted and untracked worktree files are named as NOT in the diff,
     or "Nothing uncommitted".
  C4 With `path`: that file's unified diff; one longer than DIFF_SHOW is cut
     on a line boundary and says so.
  C5 A partial read is never presented as whole: a git failure is an Error
     in git's words; a cut file listing refuses; a cut -U0 diff leaves the
     files past the cut "ranges not read".
  C8 The tool: a read (reads_only, ephemeral, listing), {change} required,
     {path} optional, no extra properties.
"""

from __future__ import annotations

import asyncio
import subprocess
from dataclasses import dataclass, field

import pytest

from app import tools
from app.landing_git import Ran
from app.tools import landing as landing_tools
from app.tools.base import RESULT_KIND_LISTING, ToolFailure
from tests import test_repo_land as _land
from tests.conftest import requires_db
from tests.test_devices_ws import _close, _person
from tests.test_repo_land import (
    BRANCH,
    BRANCH2,
    ID,
    ID2,
    Agent,
    RealRunner,
    _commit,
    _ctx,
    _git,
    _serve,
    _turn,
)
from tests.test_start_change import _connect

pytestmark = requires_db

repo = _land.repo

LONG = "".join(f"L{i}\n" for i in range(1, 11))
LONG_AFTER = "L1\nL2\nL4\nL5\nL6\nL7x\nL8\nL9\nL10\nL11\nL12\n"
X_PY = "services/core/app/x.py"
LONG_PY = "services/core/app/long.py"
NEW_PY = "services/core/app/new.py"
TEST_X = "services/core/tests/test_x.py"
BIN = "services/core/app/img.bin"


@pytest.fixture
def registered(monkeypatch):
    monkeypatch.setitem(tools.REGISTRY, landing_tools.REPO_DIFF, landing_tools.REPO_DIFF_TOOL)


async def _dispatch(pool, args: dict, agent: Agent | None = None):
    device, conn, task = await _connect(pool)
    agent = agent or Agent()
    await _person(pool)
    turn = await _turn(pool)
    facts: list[dict] = []
    server = asyncio.create_task(_serve(conn, device, agent))
    try:
        result, ok = await asyncio.wait_for(
            tools.dispatch(landing_tools.REPO_DIFF, args, _ctx(turn, facts)), 30
        )
    finally:
        server.cancel()
        await _close(conn, task)
    return result, ok, agent


def _fetch(repo) -> None:
    _git(repo.checkout, "fetch", "-q", "origin")


def _wide_change(repo):
    """Change ID2 off a main that holds long.py: one Nova commit that edits
    long.py (a removal, a replacement, an addition), adds new.py, deletes
    test_x.py and adds a binary file."""
    repo.push_main({LONG_PY: LONG}, "long file")
    _fetch(repo)
    worktree = repo.add_change(ID2, BRANCH2, None)
    (worktree / LONG_PY).write_text(LONG_AFTER)
    (worktree / NEW_PY).write_text("N1\nN2\nN3\n")
    (worktree / TEST_X).unlink()
    (worktree / BIN).write_bytes(b"\x00\x01\x02binary\x00")
    _commit(worktree, "wide change", nova=True)
    return worktree


def _line_of(result: str, path: str) -> str:
    lines = [line for line in result.splitlines() if line.startswith(f"- {path} ")]
    assert len(lines) == 1, (path, result)
    return lines[0]


# -- C1: refusals ----------------------------------------------------------------


@pytest.mark.parametrize("bad", ["xyz", "A1B2C3", "a1b2c", "a1b2c3d", "../a1b", " a1b2c3"])
async def test_c1_a_malformed_change_is_refused_with_nothing_sent(pool, repo, registered, bad):
    result, ok, agent = await _dispatch(pool, {"change": bad})
    assert ok is False, result
    assert "not a change id" in result
    assert agent.seen == []


async def test_c1_a_change_with_no_open_worktree_is_named(pool, repo, registered):
    result, ok, agent = await _dispatch(pool, {"change": ID2})
    assert ok is False, result
    assert f"no open change {ID2}" in result
    assert "list_changes" in result
    # Only the worktree listing was read.
    assert all("worktree" in e["args"]["argv"] for e in agent.seen)


async def test_c1_a_path_not_in_the_change_is_refused_naming_its_files(pool, repo, registered):
    result, ok, _agent = await _dispatch(pool, {"change": ID, "path": "README.md"})
    assert ok is False, result
    assert "'README.md' is not a file of change" in result
    assert X_PY in result


# -- C2: the summary -------------------------------------------------------------


async def test_c2_the_summary_names_each_file_with_status_counts_and_ranges(pool, repo, registered):
    worktree = _wide_change(repo)
    base = _git(worktree, "merge-base", "origin/main", "HEAD")
    head = _git(worktree, "rev-parse", "HEAD")
    result, ok, _agent = await _dispatch(pool, {"change": ID2})
    assert ok is True, result
    assert f"Base: {base}" in result
    assert f"HEAD {head}" in result
    assert BRANCH2 in result
    assert "1 commit beyond it" in result
    assert _line_of(result, LONG_PY) == (
        f"- {LONG_PY} — modified, +3 -2 — removed after line 2, line 6, lines 10-11"
    )
    assert _line_of(result, NEW_PY) == f"- {NEW_PY} — added, +3 -0 — lines 1-3"
    assert _line_of(result, TEST_X) == f"- {TEST_X} — deleted, +0 -2"
    assert _line_of(result, BIN) == f"- {BIN} — added, binary (no line counts)"
    assert "Files (4):" in result


async def test_c2_mains_later_commits_are_never_hers(pool, repo, registered):
    repo.push_main({"README.md": "# Nova moved on\n", "services/gateway/g.py": "G = 1\n"})
    _fetch(repo)
    result, ok, _agent = await _dispatch(pool, {"change": ID})
    assert ok is True, result
    assert "README.md" not in result
    assert "services/gateway/g.py" not in result
    assert _line_of(result, X_PY) == f"- {X_PY} — modified, +1 -1 — line 1"
    assert "Files (1):" in result
    # The base is where her branch left main, not main's new head.
    assert f"Base: {repo.main_before} (where {BRANCH} left origin/main" in result


async def test_c2_two_commits_are_counted(pool, repo, registered):
    (repo.worktree / NEW_PY).write_text("N\n")
    _commit(repo.worktree, "second", nova=True)
    result, ok, _agent = await _dispatch(pool, {"change": ID})
    assert ok is True, result
    assert "2 commits beyond it" in result
    assert "Files (2):" in result


async def test_c2_a_body_line_that_looks_like_a_header_is_not_a_file(pool, repo, registered):
    path = "services/core/app/tricky.txt"
    repo.push_main({path: "keep\n-- old\n@@ -1 +1 @@\nkeep2\n"}, "tricky")
    _fetch(repo)
    worktree = repo.add_change(ID2, BRANCH2, None)
    # Removed "-- old" shows as "--- old"; added "++ b/new" as "+++ b/new";
    # an added "@@ -9 +9 @@" line as "+@@ ...": none is a header.
    (worktree / path).write_text("keep\n++ b/new\n@@ -9 +9,4 @@\nkeep2\n")
    _commit(worktree, "tricky", nova=True)
    result, ok, _agent = await _dispatch(pool, {"change": ID2})
    assert ok is True, result
    assert "Files (1):" in result
    assert _line_of(result, path) == f"- {path} — modified, +2 -2 — lines 2-3"
    assert "b/new" not in result


async def test_c2_a_quoted_path_is_unquoted(pool, repo, registered):
    name = 'services/core/app/café "q" x.py'
    (repo.worktree / name).write_text("Q = 1\n")
    _commit(repo.worktree, "quoted", nova=True)
    result, ok, _agent = await _dispatch(pool, {"change": ID})
    assert ok is True, result
    assert _line_of(result, name) == f"- {name} — added, +1 -0 — line 1"


async def test_c2_no_commit_beyond_main_is_said_plainly(pool, repo, registered):
    repo.add_change(ID2, BRANCH2, None)
    result, ok, _agent = await _dispatch(pool, {"change": ID2})
    assert ok is True, result
    assert f"No committed change against main: {BRANCH2} has no commit beyond" in result
    assert "Files (" not in result


async def test_c2_ranges_beyond_the_cap_are_counted_not_listed(pool, repo, registered):
    path = "services/core/app/many.py"
    before = "".join(f"K{i}\nS{i}\n" for i in range(30))
    repo.push_main({path: before}, "many")
    _fetch(repo)
    worktree = repo.add_change(ID2, BRANCH2, None)
    (worktree / path).write_text("".join(f"K{i}x\nS{i}\n" for i in range(30)))
    _commit(worktree, "many", nova=True)
    result, ok, _agent = await _dispatch(pool, {"change": ID2})
    assert ok is True, result
    line = _line_of(result, path)
    assert line.count("line ") == landing_tools.RANGES_SHOWN
    assert f"and {30 - landing_tools.RANGES_SHOWN} more" in line
    assert "line 59" not in line


# -- C3: uncommitted work ---------------------------------------------------------


async def test_c3_uncommitted_work_is_named_as_not_in_the_diff(pool, repo, registered):
    (repo.worktree / X_PY).write_text("A = 3\nB = 3\n")
    (repo.worktree / "scratch.txt").write_text("notes\n")
    result, ok, _agent = await _dispatch(pool, {"change": ID})
    assert ok is True, result
    uncommitted = next(line for line in result.splitlines() if "NOT in this diff" in line)
    assert X_PY in uncommitted and "scratch.txt" in uncommitted
    assert "change_commit" in uncommitted
    # The committed diff is what is shown.
    assert _line_of(result, X_PY) == f"- {X_PY} — modified, +1 -1 — line 1"
    assert "scratch.txt" not in _line_of(result, X_PY)


async def test_c3_a_clean_worktree_says_nothing_uncommitted(pool, repo, registered):
    result, ok, _agent = await _dispatch(pool, {"change": ID})
    assert ok is True, result
    assert "Nothing uncommitted." in result
    assert "NOT in this diff" not in result


# -- C4: one file's diff -----------------------------------------------------------


async def test_c4_a_path_shows_that_files_unified_diff(pool, repo, registered):
    result, ok, _agent = await _dispatch(pool, {"change": ID, "path": X_PY})
    assert ok is True, result
    assert "@@ -1 +1 @@" in result
    assert "-A = 1" in result and "+A = 2" in result
    assert f"--- a/{X_PY}" in result
    assert "cut" not in result


async def test_c4_a_deleted_file_can_be_read(pool, repo, registered):
    _wide_change(repo)
    result, ok, _agent = await _dispatch(pool, {"change": ID2, "path": TEST_X})
    assert ok is True, result
    assert "-def test_x():" in result
    # Only that file.
    assert LONG_PY not in result


async def test_c4_a_glob_that_is_not_a_file_is_refused(pool, repo, registered):
    _wide_change(repo)
    result, ok, _agent = await _dispatch(pool, {"change": ID2, "path": "services/core/app/*.py"})
    assert ok is False, result
    assert "is not a file of change" in result


async def test_c4_a_path_is_read_literally_never_as_a_glob(pool, repo, registered):
    glob = "services/core/app/x[ab].py"
    (repo.worktree / glob).write_text("GLOB = 1\n")
    (repo.worktree / "services/core/app/xa.py").write_text("XA = 1\n")
    _commit(repo.worktree, "glob-named file", nova=True)
    result, ok, _agent = await _dispatch(pool, {"change": ID, "path": glob})
    assert ok is True, result
    assert "+GLOB = 1" in result
    # As a glob, x[ab].py would match xa.py too.
    assert "XA = 1" not in result and "xa.py" not in result


async def test_c4_a_long_diff_is_cut_on_a_line_boundary_and_said(pool, repo, registered):
    path = "services/core/app/big.py"
    body = "".join(f"BIG_{i:05d} = {'x' * 20}\n" for i in range(2000))
    (repo.worktree / path).write_text(body)
    _commit(repo.worktree, "big", nova=True)
    result, ok, _agent = await _dispatch(pool, {"change": ID, "path": path})
    assert ok is True, result
    assert "cut" in result and "16 KiB" in result
    shown = [line for line in result.splitlines() if line.startswith("+BIG_")]
    assert shown, result
    assert len("\n".join(shown).encode()) <= landing_tools.DIFF_SHOW
    # Every shown line is whole.
    assert all(line == f"+BIG_{line[5:10]} = {'x' * 20}" for line in shown)
    assert "BIG_01999" not in result


# -- C5: a partial read is never whole ----------------------------------------------


async def test_c5_a_git_failure_is_an_error_in_gits_words(pool, repo, registered):
    _git(repo.checkout, "update-ref", "-d", "refs/remotes/origin/main")
    result, ok, _agent = await _dispatch(pool, {"change": ID})
    assert ok is False, result
    assert "merge-base" in result and "exited" in result
    assert "Files (" not in result


@dataclass
class CuttingRunner:
    """Runs real git; the first command whose argv holds `marker` comes back
    cut after `keep` bytes (as novad's 64 KiB cap reports it)."""

    marker: str
    keep: int | None = None
    inner: RealRunner = field(default_factory=RealRunner)

    async def __call__(self, argv: list[str]) -> Ran:
        ran = await self.inner(argv)
        if self.marker in argv:
            out = ran.output if self.keep is None else ran.output[: self.keep]
            return Ran(exit=ran.exit, output=out, truncated=True)
        return ran


async def test_c5_a_cut_file_listing_refuses(repo):
    _wide_change(repo)
    worktree = str(repo.checkout / ".worktrees" / f"nova-{ID2}")
    with pytest.raises(ToolFailure, match="not complete"):
        await landing_tools.diff_text(
            CuttingRunner("--name-status"), worktree=worktree, main="main", branch=BRANCH2
        )
    with pytest.raises(ToolFailure, match="not complete"):
        await landing_tools.diff_text(
            CuttingRunner("--numstat"), worktree=worktree, main="main", branch=BRANCH2
        )


async def test_c5_a_cut_hunk_diff_leaves_the_files_past_the_cut_unread(repo):
    _wide_change(repo)
    worktree = str(repo.checkout / ".worktrees" / f"nova-{ID2}")
    whole = await landing_tools.diff_text(
        RealRunner(), worktree=worktree, main="main", branch=BRANCH2
    )
    full = subprocess.run(
        [
            "git",
            "-C",
            worktree,
            "diff",
            "-U0",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "origin/main...HEAD",
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    # Cut inside long.py's hunks: img.bin (binary) comes before it and is
    # whole; long.py and every file after it are not read.
    keep = full.index("+L7x")
    result = await landing_tools.diff_text(
        CuttingRunner("-U0", keep=keep), worktree=worktree, main="main", branch=BRANCH2
    )
    assert _line_of(result, LONG_PY) == (
        f"- {LONG_PY} — modified, +3 -2 — ranges not read (the diff was cut at the agent's "
        "output limit)"
    )
    assert "ranges not read" in _line_of(result, NEW_PY)
    assert _line_of(result, BIN) == f"- {BIN} — added, binary (no line counts)"
    assert "ranges not read" not in whole
    # A deleted file shows no ranges at all, cut or not.
    assert _line_of(result, TEST_X) == f"- {TEST_X} — deleted, +0 -2"


async def test_c5_a_hunk_diff_cut_after_a_whole_file_keeps_its_ranges(repo):
    _wide_change(repo)
    worktree = str(repo.checkout / ".worktrees" / f"nova-{ID2}")
    full = subprocess.run(
        [
            "git",
            "-C",
            worktree,
            "diff",
            "-U0",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "origin/main...HEAD",
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    # Cut right after new.py's header: long.py (before it) is whole.
    keep = full.index(f"+++ b/{NEW_PY}")
    result = await landing_tools.diff_text(
        CuttingRunner("-U0", keep=keep), worktree=worktree, main="main", branch=BRANCH2
    )
    assert _line_of(result, LONG_PY) == (
        f"- {LONG_PY} — modified, +3 -2 — removed after line 2, line 6, lines 10-11"
    )
    assert "ranges not read" in _line_of(result, NEW_PY)


# -- C8: the tool ------------------------------------------------------------------


def test_c8_repo_diff_is_a_read():
    tool = landing_tools.REPO_DIFF_TOOL
    assert tool.name == "repo_diff"
    assert tool.reads_only is True
    assert tool.ephemeral is True
    assert tool.result_kind == RESULT_KIND_LISTING
    assert tool.parameters["type"] == "object"
    assert set(tool.parameters["properties"]) == {"change", "path"}
    assert tool.parameters["required"] == ["change"]
    assert tool.parameters["additionalProperties"] is False
    assert tool.parameters["properties"]["path"]["type"] == "string"
    assert "main" in tool.description and "change" in tool.description
