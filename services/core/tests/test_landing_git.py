"""S32.3 T5: the host git steps of a landing — commit check, bring it up to
date (fetch + rebase, conflict aborted), what changed, the stored patch, and
dirty_outside (docs/plans/rebuild/s32/spec.md §5.2 steps 1, 2 and 7).

These run REAL git: a bare "origin", a clone of it (the checkout), one
worktree of hers on nova/<id>-<slug>, and an "upstream" clone that moves main
on origin the way another landing would. The runner executes each argv in no
shell, output = stdout + stderr, like the agent's shell.exec.

Criteria:
  C1 land_check (sync step 1): uncommitted work (modified, untracked, deleted,
     staged) -> Error 'uncommitted changes in <files>; call change_commit
     first' naming each file, sorted, exact; a detached HEAD -> Error; no
     commit beyond origin/<main> -> Error 'nothing to land'; else her branch.
  C2 prepare fetches main and rebases a branch that is behind (her ref moves,
     origin/<main> is an ancestor, her files kept), committed as Nova and
     never signed; a branch already on main is not rebased; base_sha is
     origin/<main> after the fetch; the checkout's branch never moves.
  C3 A conflicting rebase -> Conflict(base_sha, files), aborted: no rebase in
     progress, branch at its original SHA, worktree clean; a rebase failing
     with no conflicted file is a ToolFailure quoting git, aborted too.
  C4 changed/deleted come from base..commit only; rename = delete + add;
     names exact.
  C5 patch = git diff base..commit; binary as 'Binary files ... differ';
     bounded at PATCH_MAX on a UTF-8 boundary (patch_truncated); a runner-cut
     diff is patch_truncated; a small patch is whole.
  C6 dirty_outside lists the checkout's own dirty paths, [] when clean, a cut
     flag when truncated; never raises for a dirty tree.
  C7 agent_runner: argv-only shell.exec, nonzero exit returned (not raised),
     novad's exit/truncation markers stripped, ok:false -> ToolFailure; every
     failing git step is a ToolFailure quoting git; a truncated listing is a
     ToolFailure, never a partial list.
"""

from __future__ import annotations

import asyncio
import os
import re
import stat
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from app import landing_git
from app.landing_git import Conflict, Prepared, Ran
from app.tools import changes
from app.tools.base import ToolFailure

ID = "a1b2c3"
BRANCH = f"nova/{ID}-week"
HOST = "mini-pc"


def _git(cwd: Path, *argv: str) -> str:
    done = subprocess.run(
        ["git", "-C", str(cwd), *argv], capture_output=True, text=True, check=True
    )
    return done.stdout.strip()


def _commit(cwd: Path, message: str) -> str:
    _git(cwd, "add", "-A")
    _git(cwd, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message)
    return _git(cwd, "rev-parse", "HEAD")


@dataclass
class Repo:
    origin: Path
    checkout: Path
    worktree: Path
    upstream: Path

    def head(self, where: Path | None = None) -> str:
        return _git(where or self.worktree, "rev-parse", "HEAD")

    def move_main(self, name: str, text: str, message: str = "main moved") -> str:
        """Another landing moves main on origin (not yet fetched by the checkout)."""
        _git(self.upstream, "pull", "-q", "--ff-only", "origin", "main")
        path = self.upstream / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        sha = _commit(self.upstream, message)
        _git(self.upstream, "push", "-q", "origin", "main")
        return sha


@pytest.fixture
def repo(tmp_path, monkeypatch) -> Repo:
    gitconfig = tmp_path / "gitconfig"
    # The machine's own identity is the owner's and it signs every commit with
    # a program that always fails: her rebase must never use either.
    gitconfig.write_text(
        "[user]\n\tname = Owner\n\temail = owner@example.com\n"
        "[init]\n\tdefaultBranch = main\n"
        "[commit]\n\tgpgsign = true\n"
        "[gpg]\n\tprogram = false\n"
        "[color]\n\tui = always\n"
    )
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(gitconfig))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for name in (
        "GIT_AUTHOR_NAME",
        "GIT_AUTHOR_EMAIL",
        "GIT_COMMITTER_NAME",
        "GIT_COMMITTER_EMAIL",
    ):
        monkeypatch.delenv(name, raising=False)
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "--bare", "-q", str(origin)], check=True)
    checkout = tmp_path / "nova"
    subprocess.run(["git", "clone", "-q", str(origin), str(checkout)], check=True)
    (checkout / ".gitignore").write_text(".worktrees/\n")
    (checkout / "README.md").write_text("# Nova\n")
    (checkout / "a.txt").write_text("one\ntwo\nthree\n")
    (checkout / "old.txt").write_text("old\n")
    _commit(checkout, "init")
    _git(checkout, "push", "-q", "origin", "main")
    worktree = checkout / ".worktrees" / f"nova-{ID}"
    _git(checkout, "worktree", "add", "-q", "-b", BRANCH, str(worktree), "main")
    upstream = tmp_path / "upstream"
    subprocess.run(["git", "clone", "-q", str(origin), str(upstream)], check=True)
    return Repo(origin=origin, checkout=checkout, worktree=worktree, upstream=upstream)


@dataclass
class RealRunner:
    """Runs each argv for real, in no shell; output = stdout + stderr."""

    seen: list[list[str]] = field(default_factory=list)

    async def __call__(self, argv: list[str]) -> Ran:
        self.seen.append(list(argv))
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=dict(os.environ),
        )
        out, _ = await proc.communicate()
        return Ran(exit=proc.returncode, output=out.decode("utf-8", "replace"))


@pytest.fixture
def run() -> RealRunner:
    return RealRunner()


async def _prepare(run, repo: Repo):
    return await landing_git.prepare(
        run, checkout=str(repo.checkout), worktree=str(repo.worktree), main="main", host=HOST
    )


def _edit(repo: Repo, name: str, text: str, message: str = "her change") -> str:
    path = repo.worktree / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return _commit(repo.worktree, message)


def _rebase_in_progress(repo: Repo) -> bool:
    gitdir = Path(_git(repo.worktree, "rev-parse", "--absolute-git-dir"))
    return (gitdir / "rebase-merge").exists() or (gitdir / "rebase-apply").exists()


# -- C1: land_check -----------------------------------------------------------


@pytest.mark.parametrize(
    "dirty, named",
    [
        ("modified", ["a.txt"]),
        ("untracked", ["new dir/fresh file.txt"]),
        ("deleted", ["old.txt"]),
        ("staged", ["staged.txt"]),
        ("unicode", ["héllo wörld.txt"]),
        ("several", ["a.txt", "b/z.txt", "old.txt"]),
    ],
)
async def test_c1_uncommitted_work_is_named_and_refused(repo, run, dirty, named):
    _edit(repo, "mine.txt", "mine\n")
    wt = repo.worktree
    if dirty == "modified":
        (wt / "a.txt").write_text("changed\n")
    elif dirty == "untracked":
        (wt / "new dir").mkdir()
        (wt / "new dir" / "fresh file.txt").write_text("x\n")
    elif dirty == "deleted":
        (wt / "old.txt").unlink()
    elif dirty == "staged":
        (wt / "staged.txt").write_text("s\n")
        _git(wt, "add", "staged.txt")
    elif dirty == "unicode":
        (wt / "héllo wörld.txt").write_text("u\n")
    else:
        (wt / "old.txt").unlink()
        (wt / "b").mkdir()
        (wt / "b" / "z.txt").write_text("z\n")
        (wt / "a.txt").write_text("changed\n")
    with pytest.raises(ToolFailure) as exc:
        await landing_git.land_check(run, str(wt), "main")
    assert str(exc.value) == f"uncommitted changes in {', '.join(named)}; call change_commit first"


async def test_c1_commit_check_passes_a_clean_worktree(repo, run):
    _edit(repo, "mine.txt", "mine\n")
    assert await landing_git.commit_check(run, str(repo.worktree)) is None


async def test_c1_a_committed_branch_ahead_returns_its_name(repo, run):
    _edit(repo, "mine.txt", "mine\n")
    assert await landing_git.land_check(run, str(repo.worktree), "main") == BRANCH


async def test_c1_nothing_beyond_main_is_nothing_to_land(repo, run):
    with pytest.raises(ToolFailure) as exc:
        await landing_git.land_check(run, str(repo.worktree), "main")
    assert "nothing to land" in str(exc.value)
    assert BRANCH in str(exc.value)


async def test_c1_a_detached_head_is_refused(repo, run):
    sha = _edit(repo, "mine.txt", "mine\n")
    _git(repo.worktree, "checkout", "-q", "--detach", sha)
    with pytest.raises(ToolFailure) as exc:
        await landing_git.land_check(run, str(repo.worktree), "main")
    # Exact words: the test's own tmp path carries "detached" too.
    assert f"{repo.worktree} is on a detached HEAD" in str(exc.value)


# -- C2: up to date -------------------------------------------------------------


async def test_c2_a_branch_behind_is_rebased_onto_the_fetched_main(repo, run):
    mine = _edit(repo, "mine.txt", "mine\n")
    moved = repo.move_main("theirs.txt", "theirs\n")
    checkout_head = repo.head(repo.checkout)
    got = await _prepare(run, repo)
    assert isinstance(got, Prepared)
    assert got.rebased is True
    assert got.branch == BRANCH
    assert got.base_sha == moved
    assert _git(repo.checkout, "rev-parse", "refs/remotes/origin/main") == moved
    assert got.commit_sha != mine
    assert got.commit_sha == repo.head() == _git(repo.checkout, "rev-parse", BRANCH)
    _git(repo.worktree, "merge-base", "--is-ancestor", moved, got.commit_sha)  # check=True
    assert (repo.worktree / "mine.txt").read_text() == "mine\n"
    assert (repo.worktree / "theirs.txt").read_text() == "theirs\n"
    # The checkout never moves: only her branch does.
    assert repo.head(repo.checkout) == checkout_head


async def test_c2_the_rebase_is_nova_and_never_signed(repo, run):
    _edit(repo, "mine.txt", "mine\n")
    repo.move_main("theirs.txt", "theirs\n")
    got = await _prepare(run, repo)
    assert isinstance(got, Prepared) and got.rebased
    committer = _git(repo.worktree, "log", "-1", "--format=%cn <%ce>|%G?|%an <%ae>")
    who, sig, author = committer.split("|")
    assert who == f"Nova <nova@{HOST}>"
    assert sig == "N"
    # Her commit's author is kept (change_commit wrote it).
    assert author == "Owner <owner@example.com>"


async def test_c2_a_branch_on_main_is_not_rebased(repo, run):
    mine = _edit(repo, "mine.txt", "mine\n")
    got = await _prepare(run, repo)
    assert isinstance(got, Prepared)
    assert got.rebased is False
    assert got.commit_sha == mine == repo.head()
    assert got.base_sha == _git(repo.checkout, "rev-parse", "main")
    assert not any("rebase" in argv for argv in run.seen)


async def test_c2_the_fetch_runs_from_the_checkout_with_an_explicit_refspec(repo, run):
    _edit(repo, "mine.txt", "mine\n")
    await _prepare(run, repo)
    fetches = [argv for argv in run.seen if "fetch" in argv]
    assert fetches == [
        [
            "git",
            "-C",
            str(repo.checkout),
            "fetch",
            "--no-tags",
            "origin",
            "+refs/heads/main:refs/remotes/origin/main",
        ]
    ]


async def test_c2_her_commits_already_on_main_leave_nothing_to_land(repo, run):
    _edit(repo, "same.txt", "same\n")
    repo.move_main("same.txt", "same\n", "the same change, landed elsewhere")
    with pytest.raises(ToolFailure) as exc:
        await _prepare(run, repo)
    assert "nothing to land" in str(exc.value)


async def test_c2_prepare_rechecks_uncommitted_work(repo, run):
    _edit(repo, "mine.txt", "mine\n")
    (repo.worktree / "late.txt").write_text("forgot\n")
    with pytest.raises(ToolFailure) as exc:
        await _prepare(run, repo)
    assert str(exc.value) == "uncommitted changes in late.txt; call change_commit first"
    assert not any("fetch" in argv for argv in run.seen)


# -- C3: conflict ---------------------------------------------------------------


async def test_c3_a_conflict_is_returned_and_the_rebase_aborted(repo, run):
    mine = _edit(repo, "a.txt", "one\nMINE\nthree\n")
    (repo.worktree / "z.txt").write_text("z\n")
    _commit(repo.worktree, "second")
    original = repo.head()
    _git(repo.upstream, "pull", "-q", "--ff-only", "origin", "main")
    (repo.upstream / "a.txt").write_text("one\nTHEIRS\nthree\n")
    (repo.upstream / "z.txt").write_text("theirs z\n")
    moved = _commit(repo.upstream, "theirs")
    _git(repo.upstream, "push", "-q", "origin", "main")
    got = await _prepare(run, repo)
    # The rebase stops at her first commit, which conflicts on a.txt alone.
    assert got == Conflict(base_sha=moved, files=("a.txt",))
    assert not _rebase_in_progress(repo)
    assert repo.head() == original
    assert _git(repo.worktree, "rev-parse", "--abbrev-ref", "HEAD") == BRANCH
    assert _git(repo.worktree, "status", "--porcelain") == ""
    assert mine != original


async def test_c3_every_conflicted_file_is_named_sorted(repo, run):
    _git(repo.worktree, "rm", "-q", "old.txt")
    (repo.worktree / "a.txt").write_text("one\nMINE\nthree\n")
    _commit(repo.worktree, "mine")
    _git(repo.upstream, "pull", "-q", "--ff-only", "origin", "main")
    (repo.upstream / "old.txt").write_text("edited upstream\n")
    (repo.upstream / "a.txt").write_text("one\nTHEIRS\nthree\n")
    moved = _commit(repo.upstream, "theirs")
    _git(repo.upstream, "push", "-q", "origin", "main")
    got = await _prepare(run, repo)
    assert got == Conflict(base_sha=moved, files=("a.txt", "old.txt"))
    assert not _rebase_in_progress(repo)


async def test_c3_a_rebase_failing_without_a_conflict_is_stated_and_aborted(repo, run):
    _edit(repo, "mine.txt", "mine\n")
    original = repo.head()
    repo.move_main("theirs.txt", "theirs\n")
    hooks = repo.checkout / ".git" / "hooks"
    hook = hooks / "pre-rebase"
    hook.write_text("#!/bin/sh\necho 'pre-rebase hook says no' >&2\nexit 1\n")
    hook.chmod(0o755)
    with pytest.raises(ToolFailure) as exc:
        await _prepare(run, repo)
    assert "pre-rebase hook says no" in str(exc.value)
    assert "rebase" in str(exc.value)
    assert not _rebase_in_progress(repo)
    assert repo.head() == original


# -- C4: what changed -------------------------------------------------------------


async def test_c4_changed_and_deleted_come_from_her_commits_only(repo, run):
    (repo.worktree / "a.txt").write_text("one\ntwo\nthree\nfour\n")
    (repo.worktree / "new file.py").write_text("x = 1\n")
    (repo.worktree / "dir").mkdir()
    (repo.worktree / "dir" / "héllo.txt").write_text("h\n")
    (repo.worktree / 'q"uote.txt').write_text("q\n")
    (repo.worktree / "old.txt").unlink()
    _commit(repo.worktree, "mine")
    repo.move_main("main-only.txt", "theirs\n")
    got = await _prepare(run, repo)
    assert isinstance(got, Prepared)
    assert got.changed == ("a.txt", "dir/héllo.txt", "new file.py", 'q"uote.txt')
    assert got.deleted == ("old.txt",)
    assert "main-only.txt" not in got.changed + got.deleted


async def test_c4_a_rename_is_the_old_deleted_and_the_new_changed(repo, run):
    _git(repo.worktree, "mv", "old.txt", "renamed.txt")
    _commit(repo.worktree, "rename")
    got = await _prepare(run, repo)
    assert isinstance(got, Prepared)
    assert got.changed == ("renamed.txt",)
    assert got.deleted == ("old.txt",)


@pytest.mark.parametrize(
    "quoted, plain",
    [
        ("plain.txt", "plain.txt"),
        ('"h\\303\\251llo.txt"', "héllo.txt"),
        ('"tab\\there"', "tab\there"),
        ('"new\\nline"', "new\nline"),
        ('"q\\"uote"', 'q"uote'),
        ('"back\\\\slash"', "back\\slash"),
        ('"\\a\\b\\f\\r\\v"', "\a\b\f\r\v"),
    ],
)
def test_c4_unquote_reads_gits_c_quoting(quoted, plain):
    assert landing_git.unquote(quoted) == plain


async def test_c4_a_newline_in_a_name_is_read_exactly(repo, run):
    (repo.worktree / "new\nline.txt").write_text("n\n")
    _commit(repo.worktree, "newline name")
    got = await _prepare(run, repo)
    assert isinstance(got, Prepared)
    assert got.changed == ("new\nline.txt",)


# -- C5: the patch ------------------------------------------------------------------


async def test_c5_the_patch_is_her_diff_against_main(repo, run):
    mine = _edit(repo, "a.txt", "one\nTWO\nthree\n")
    got = await _prepare(run, repo)
    assert isinstance(got, Prepared)
    expected = _git(repo.worktree, "diff", "--no-color", got.base_sha, mine)
    assert got.patch.strip() == expected
    assert "-two\n+TWO" in got.patch
    assert "\x1b[" not in got.patch
    assert got.patch_truncated is False


async def test_c5_a_binary_file_is_named_not_dumped(repo, run):
    (repo.worktree / "blob.bin").write_bytes(bytes(range(256)) * 4)
    _commit(repo.worktree, "binary")
    got = await _prepare(run, repo)
    assert isinstance(got, Prepared)
    assert "Binary files /dev/null and b/blob.bin differ" in got.patch
    assert "\x00" not in got.patch


async def test_c5_a_large_patch_is_bounded_on_a_utf8_boundary(repo, run, monkeypatch):
    monkeypatch.setattr(landing_git, "PATCH_MAX", 1001)
    (repo.worktree / "big.txt").write_text("é" * 3000 + "\n")
    _commit(repo.worktree, "big")
    got = await _prepare(run, repo)
    assert isinstance(got, Prepared)
    assert got.patch_truncated is True
    assert len(got.patch.encode()) <= 1001
    assert len(got.patch.encode()) >= 999
    assert got.patch.encode().decode("utf-8") == got.patch
    assert "�" not in got.patch
    full = _git(repo.worktree, "diff", "--no-color", got.base_sha, got.commit_sha)
    assert full.startswith(got.patch)


async def test_c5_a_patch_the_runner_cut_is_flagged(repo, run):
    _edit(repo, "a.txt", "one\nTWO\nthree\n")

    async def cutting(argv):
        ran = await run(argv)
        if "diff" in argv and "--name-status" not in argv and "--name-only" not in argv:
            return Ran(exit=ran.exit, output=ran.output[:40], truncated=True)
        return ran

    got = await _prepare(cutting, repo)
    assert isinstance(got, Prepared)
    assert got.patch_truncated is True
    assert len(got.patch) == 40


# -- C6: dirty_outside ---------------------------------------------------------------


async def test_c6_the_checkouts_own_dirty_paths_are_listed(repo, run):
    _edit(repo, "mine.txt", "mine\n")
    (repo.worktree / "hers-uncommitted.txt").write_text("w\n")
    (repo.checkout / "a.txt").write_text("owner editing\n")
    (repo.checkout / "scratch notes.md").write_text("n\n")
    (repo.checkout / "old.txt").unlink()
    files, cut = await landing_git.dirty_outside(run, str(repo.checkout))
    assert files == ["a.txt", "old.txt", "scratch notes.md"]
    assert cut is False


async def test_c6_a_clean_checkout_is_empty(repo, run):
    assert await landing_git.dirty_outside(run, str(repo.checkout)) == ([], False)


async def test_c6_a_cut_listing_is_flagged_not_raised(repo, run):
    (repo.checkout / "a.txt").write_text("owner editing\n")

    async def cutting(argv):
        ran = await run(argv)
        return Ran(exit=ran.exit, output=ran.output, truncated=True)

    files, cut = await landing_git.dirty_outside(cutting, str(repo.checkout))
    assert cut is True
    assert files == ["a.txt"]


async def test_c6_a_listing_cut_mid_line_drops_the_partial_name(repo, run):
    (repo.checkout / "a.txt").write_text("owner editing\n")
    (repo.checkout / "scratch notes.md").write_text("n\n")

    async def cutting(argv):
        ran = await run(argv)
        return Ran(
            exit=ran.exit, output=ran.output[: ran.output.index("scratch") + 3], truncated=True
        )

    files, cut = await landing_git.dirty_outside(cutting, str(repo.checkout))
    assert cut is True
    assert files == ["a.txt"]


# -- C7: the runner contract and stated failures --------------------------------------


async def test_c7_an_unreachable_origin_is_a_stated_failure_quoting_git(repo, run):
    _edit(repo, "mine.txt", "mine\n")
    _git(repo.checkout, "remote", "set-url", "origin", str(repo.origin) + "-gone")
    with pytest.raises(ToolFailure) as exc:
        await _prepare(run, repo)
    said = str(exc.value)
    assert "fetch" in said
    assert "exited 128" in said
    assert "-gone" in said


async def test_c7_a_truncated_listing_is_a_failure_never_a_partial_list(repo, run):
    (repo.worktree / "a.txt").write_text("changed\n")

    async def cutting(argv):
        ran = await run(argv)
        return Ran(exit=ran.exit, output=ran.output, truncated=True)

    with pytest.raises(ToolFailure) as exc:
        await landing_git.commit_check(cutting, str(repo.worktree))
    assert "cut" in str(exc.value) or "truncated" in str(exc.value)


async def test_c7_a_truncated_changed_file_list_is_a_failure(repo, run):
    _edit(repo, "mine.txt", "mine\n")

    async def cutting(argv):
        ran = await run(argv)
        if "--name-status" in argv:
            return Ran(exit=ran.exit, output=ran.output, truncated=True)
        return ran

    with pytest.raises(ToolFailure) as exc:
        await _prepare(cutting, repo)
    assert "truncated" in str(exc.value) or "cut" in str(exc.value)


async def test_c7_every_command_is_argv_git(repo, run):
    _edit(repo, "mine.txt", "mine\n")
    repo.move_main("theirs.txt", "theirs\n")
    await landing_git.land_check(run, str(repo.worktree), "main")
    await _prepare(run, repo)
    await landing_git.dirty_outside(run, str(repo.checkout))
    assert run.seen
    for argv in run.seen:
        assert argv[0] == "git"
        assert argv[1] == "-C"
        assert argv[2] in (str(repo.worktree), str(repo.checkout))


@dataclass
class FakeCommand:
    answer: dict
    calls: list[tuple] = field(default_factory=list)

    async def __call__(self, pool, row, capability, args, *, ctx=None, timeout=None):
        self.calls.append((pool, row, capability, args, ctx))
        return self.answer


ROW = {"name": "mini-pc"}


async def test_c7_agent_runner_sends_argv_only_shell_exec(monkeypatch):
    fake = FakeCommand({"ok": True, "output": "hello\n", "exit_code": 0, "error": None})
    monkeypatch.setattr(landing_git, "_command", fake)
    ctx = object()
    ran = await landing_git.agent_runner("POOL", ROW, ctx)(["git", "-C", "/r", "status"])
    assert ran == Ran(exit=0, output="hello\n", truncated=False)
    assert fake.calls == [("POOL", ROW, "shell.exec", {"argv": ["git", "-C", "/r", "status"]}, ctx)]


async def test_c7_agent_runner_returns_a_nonzero_exit_without_novads_marker(monkeypatch):
    output = "fatal: no such ref\n\n[process exited with code 128]"
    fake = FakeCommand({"ok": True, "output": output, "exit_code": 128, "error": None})
    monkeypatch.setattr(landing_git, "_command", fake)
    ran = await landing_git.agent_runner(None, ROW, None)(["git", "fetch"])
    assert ran == Ran(exit=128, output="fatal: no such ref\n", truncated=False)


async def test_c7_agent_runner_reads_novads_truncation_marker(monkeypatch):
    output = "a\nb\n\n[truncated at 64 KiB]\n[process exited with code 1]"
    fake = FakeCommand({"ok": True, "output": output, "exit_code": 1, "error": None})
    monkeypatch.setattr(landing_git, "_command", fake)
    ran = await landing_git.agent_runner(None, ROW, None)(["git", "diff"])
    assert ran == Ran(exit=1, output="a\nb\n", truncated=True)


async def test_c7_agent_runner_keeps_a_marker_shaped_line_inside_the_output(monkeypatch):
    output = "[truncated at 64 KiB]\nreal line\n"
    fake = FakeCommand({"ok": True, "output": output, "exit_code": 0, "error": None})
    monkeypatch.setattr(landing_git, "_command", fake)
    ran = await landing_git.agent_runner(None, ROW, None)(["git", "diff"])
    assert ran == Ran(exit=0, output=output, truncated=False)


async def test_c7_agent_runner_states_an_agent_failure(monkeypatch):
    fake = FakeCommand(
        {"ok": False, "output": "", "exit_code": None, "error": "timed out; partial output:"}
    )
    monkeypatch.setattr(landing_git, "_command", fake)
    with pytest.raises(ToolFailure) as exc:
        await landing_git.agent_runner(None, ROW, None)(["git", "fetch", "origin"])
    assert str(exc.value) == "mini-pc: could not run `git fetch origin`: timed out; partial output:"


async def test_c7_agent_runner_states_a_missing_exit_code(monkeypatch):
    fake = FakeCommand({"ok": True, "output": "x", "exit_code": None, "error": None})
    monkeypatch.setattr(landing_git, "_command", fake)
    with pytest.raises(ToolFailure) as exc:
        await landing_git.agent_runner(None, ROW, None)(["git", "status"])
    assert "no exit code" in str(exc.value)


# == T6: the clean copy (spec §5.2 step 3) =====================================
#
#   C1 fresh_judge_id: 6 lowercase hex, not a worktree path's id, not a
#      nova/<id>-* branch, not an existing .worktrees/nova-<id>; all tries
#      taken -> ToolFailure naming the tries, nothing created.
#   C2 make_copy puts the commit's exact tree at .worktrees/nova-<judge>
#      (content, nested dirs, the executable bit; a deleted file absent; her
#      uncommitted/untracked files absent; the SHA given, not her HEAD).
#   C3 The copy is never a git worktree: no .git, not listed, her branch and
#      worktree untouched, the temporary tar gone.
#   C4 A tree whose .gitattributes names export-ignore/export-subst is
#      refused naming the file, nothing created.
#   C5 Failures leave nothing behind and are stated; a malformed SHA or
#      checkout is refused before any command runs.
#   C6 remove_copy removes copy + tar, is fine when gone, refuses a worktree
#      of hers and a malformed id/checkout, and a copy still there after rm
#      is a ToolFailure.
#   C7 Every command is argv-only: git, mkdir, tar, rm, test.

_HEX6 = re.compile(r"[0-9a-f]{6}")
_COMMANDS = {"git", "mkdir", "tar", "rm", "test"}


def _entries(repo: Repo) -> set[str]:
    return {p.name for p in (repo.checkout / ".worktrees").iterdir()}


def _tree(sha: str, repo: Repo) -> set[str]:
    return set(_git(repo.checkout, "ls-tree", "-r", "--name-only", sha).splitlines())


def _files(root: Path) -> set[str]:
    return {str(p.relative_to(root)) for p in root.rglob("*") if p.is_file() or p.is_symlink()}


def _ids(monkeypatch, *ids: str) -> None:
    it = iter(ids)
    monkeypatch.setattr(changes, "new_id", lambda: next(it))


async def _copy(run, repo: Repo, sha: str):
    return await landing_git.make_copy(run, checkout=str(repo.checkout), sha=sha)


# -- T6 C1: the judge id ----------------------------------------------------------


async def test_t6_c1_a_fresh_judge_id_is_six_hex_and_free(repo, run):
    judge = await landing_git.fresh_judge_id(run, str(repo.checkout))
    assert _HEX6.fullmatch(judge)
    assert judge != ID
    assert not (repo.checkout / ".worktrees" / f"nova-{judge}").exists()


@pytest.mark.parametrize("taken", ["worktree", "gone worktree", "branch", "dir", "file"])
async def test_t6_c1_a_taken_id_is_skipped(repo, run, monkeypatch, taken):
    used = ID
    if taken == "gone worktree":
        # git still lists a worktree whose directory was deleted (not pruned).
        used = "f0f0f0"
        gone = repo.checkout / ".worktrees" / f"nova-{used}"
        _git(repo.checkout, "worktree", "add", "-q", "-b", f"x/{used}", str(gone), "main")
        subprocess.run(["rm", "-rf", str(gone)], check=True)
    elif taken == "branch":
        used = "b0b0b0"
        _git(repo.checkout, "branch", f"nova/{used}-old", "main")
    elif taken == "dir":
        used = "c0c0c0"
        (repo.checkout / ".worktrees" / f"nova-{used}").mkdir()
    elif taken == "file":
        used = "c1c1c1"
        (repo.checkout / ".worktrees" / f"nova-{used}").write_text("x\n")
    _ids(monkeypatch, used, "d0d0d0")
    assert await landing_git.fresh_judge_id(run, str(repo.checkout)) == "d0d0d0"


async def test_t6_c1_a_branch_merely_containing_the_id_does_not_take_it(repo, run, monkeypatch):
    _git(repo.checkout, "branch", "other/e0e0e0-x", "main")
    _git(repo.checkout, "branch", "nova/e0e0e0", "main")
    _ids(monkeypatch, "e0e0e0")
    assert await landing_git.fresh_judge_id(run, str(repo.checkout)) == "e0e0e0"


async def test_t6_c1_every_try_taken_is_a_failure_and_nothing_is_created(repo, run, monkeypatch):
    monkeypatch.setattr(changes, "new_id", lambda: ID)
    sha = _edit(repo, "mine.txt", "mine\n")
    before = _entries(repo)
    with pytest.raises(ToolFailure) as caught:
        await _copy(run, repo, sha)
    assert f"{landing_git.JUDGE_TRIES} " in str(caught.value)
    assert _entries(repo) == before


async def test_t6_c1_a_failing_existence_check_is_stated(repo, run):
    async def test_breaks(argv: list[str]) -> Ran:
        if argv[0] == "test":
            return Ran(exit=2, output="test: missing argument")
        return await run(argv)

    with pytest.raises(ToolFailure) as caught:
        await landing_git.fresh_judge_id(test_breaks, str(repo.checkout))
    assert "missing argument" in str(caught.value)


async def test_t6_c1_the_claim_never_reuses_an_entry_that_appeared(repo, run, monkeypatch):
    # The entry appears between the check and the claim: mkdir without -p
    # refuses, and what was there is left alone.
    sha = _edit(repo, "mine.txt", "mine\n")
    there = repo.checkout / ".worktrees" / "nova-c0c0c0"
    there.mkdir()
    (there / "theirs.txt").write_text("not mine\n")
    _ids(monkeypatch, "c0c0c0")

    async def check_misses(argv: list[str]) -> Ran:
        if argv[0] == "test":
            return Ran(exit=1, output="")
        return await run(argv)

    with pytest.raises(ToolFailure):
        await landing_git.make_copy(check_misses, checkout=str(repo.checkout), sha=sha)
    assert [p.name for p in there.iterdir()] == ["theirs.txt"]


# -- T6 C2: the copy is the commit -------------------------------------------------


async def test_t6_c2_the_copy_is_the_commits_exact_tree(repo, run):
    wt = repo.worktree
    (wt / "a.txt").write_text("committed\n")
    (wt / "sub" / "deep").mkdir(parents=True)
    (wt / "sub" / "deep" / "new.py").write_text("print('hi')\n")
    (wt / "run.sh").write_text("#!/bin/sh\necho ok\n")
    (wt / "run.sh").chmod(0o755)
    (wt / "old.txt").unlink()
    sha = _commit(wt, "her change")
    # After the commit: work she forgot to commit.
    (wt / "a.txt").write_text("DIRTY\n")
    (wt / "stray.txt").write_text("untracked\n")

    copy = await _copy(run, repo, sha)

    root = repo.checkout / ".worktrees" / f"nova-{copy.judge}"
    assert copy.path == str(root)
    assert _HEX6.fullmatch(copy.judge) and copy.judge != ID
    assert _files(root) == _tree(sha, repo)
    for name in _tree(sha, repo):
        assert (root / name).read_bytes() == subprocess.run(
            ["git", "-C", str(repo.checkout), "show", f"{sha}:{name}"],
            capture_output=True,
            check=True,
        ).stdout
    assert (root / "a.txt").read_text() == "committed\n"
    assert not (root / "old.txt").exists()
    assert not (root / "stray.txt").exists()
    assert (root / "run.sh").stat().st_mode & stat.S_IXUSR


async def test_t6_c2_the_sha_given_is_judged_not_her_head(repo, run):
    first = _edit(repo, "a.txt", "first\n")
    _edit(repo, "a.txt", "second\n", "later")
    copy = await _copy(run, repo, first)
    assert (Path(copy.path) / "a.txt").read_text() == "first\n"


# -- T6 C3: never a worktree ---------------------------------------------------------


async def test_t6_c3_the_copy_is_never_a_worktree_and_touches_nothing_of_hers(repo, run):
    sha = _edit(repo, "mine.txt", "mine\n")
    (repo.worktree / "a.txt").write_text("DIRTY\n")
    head, checkout_head = repo.head(), repo.head(repo.checkout)
    status = _git(repo.worktree, "status", "--porcelain")

    copy = await _copy(run, repo, sha)

    root = Path(copy.path)
    assert root.is_dir()
    assert not (root / ".git").exists()
    listed = _git(repo.checkout, "worktree", "list", "--porcelain")
    assert f"worktree {root}\n" not in listed + "\n"
    assert repo.head() == head and repo.head(repo.checkout) == checkout_head
    assert _git(repo.worktree, "symbolic-ref", "--short", "HEAD") == BRANCH
    assert _git(repo.worktree, "status", "--porcelain") == status
    assert not Path(copy.path + ".tar").exists()
    assert _entries(repo) == {f"nova-{ID}", f"nova-{copy.judge}"}


# -- T6 C4: export attributes ---------------------------------------------------------


@pytest.mark.parametrize(
    "name, line",
    [
        (".gitattributes", "tests/** export-ignore"),
        ("sub/.gitattributes", "hidden_test.py export-ignore"),
        (".gitattributes", "version.txt export-subst"),
    ],
)
async def test_t6_c4_export_attributes_are_refused_naming_the_file(repo, run, name, line):
    (repo.worktree / "sub").mkdir(exist_ok=True)
    (repo.worktree / "sub" / "hidden_test.py").write_text("assert False\n")
    sha = _edit(repo, name, line + "\n")
    before = _entries(repo)
    with pytest.raises(ToolFailure) as caught:
        await _copy(run, repo, sha)
    said = str(caught.value)
    assert name in said and "export" in said
    assert _entries(repo) == before


async def test_t6_c4_other_attributes_are_copied(repo, run):
    sha = _edit(repo, ".gitattributes", "*.sh text eol=lf\n")
    copy = await _copy(run, repo, sha)
    assert (Path(copy.path) / ".gitattributes").read_text() == "*.sh text eol=lf\n"


# -- T6 C5: failures leave nothing behind ---------------------------------------------


async def test_t6_c5_an_unknown_sha_quotes_git_and_leaves_nothing(repo, run):
    before = _entries(repo)
    with pytest.raises(ToolFailure) as caught:
        await _copy(run, repo, "0" * 40)
    assert "0" * 40 in str(caught.value) and "exited" in str(caught.value)
    assert _entries(repo) == before


async def test_t6_c5_a_failing_extract_removes_the_dir_and_the_tar(repo, run):
    sha = _edit(repo, "mine.txt", "mine\n")
    before = _entries(repo)

    async def failing_tar(argv: list[str]) -> Ran:
        if argv[0] == "tar":
            return Ran(exit=2, output="tar: disk full")
        return await run(argv)

    with pytest.raises(ToolFailure) as caught:
        await landing_git.make_copy(failing_tar, checkout=str(repo.checkout), sha=sha)
    assert "disk full" in str(caught.value)
    assert _entries(repo) == before


@pytest.mark.parametrize(
    "sha", ["", "abc", "HEAD", "g" * 40, "A" * 40, "--output=/tmp/x", "a" * 41, "a" * 39]
)
async def test_t6_c5_a_malformed_sha_runs_nothing(repo, run, sha):
    with pytest.raises(ToolFailure):
        await _copy(run, repo, sha)
    assert run.seen == []


@pytest.mark.parametrize(
    "checkout", ["", "relative/nova", "/", "/srv/../nova", "/srv/nova/", "//x"]
)
async def test_t6_c5_a_malformed_checkout_runs_nothing(run, checkout):
    with pytest.raises(ToolFailure):
        await landing_git.make_copy(run, checkout=checkout, sha="a" * 40)
    with pytest.raises(ToolFailure):
        await landing_git.fresh_judge_id(run, checkout)
    with pytest.raises(ToolFailure):
        await landing_git.remove_copy(run, checkout=checkout, judge="a1a1a1")
    with pytest.raises(ToolFailure):
        landing_git.copy_path(checkout, "a1a1a1")
    assert run.seen == []


# -- T6 C6: removal ---------------------------------------------------------------------


async def test_t6_c6_remove_copy_removes_the_copy_and_its_tar(repo, run):
    sha = _edit(repo, "mine.txt", "mine\n")
    copy = await _copy(run, repo, sha)
    Path(copy.path + ".tar").write_text("left over\n")
    await landing_git.remove_copy(run, checkout=str(repo.checkout), judge=copy.judge)
    assert not Path(copy.path).exists()
    assert not Path(copy.path + ".tar").exists()
    assert _entries(repo) == {f"nova-{ID}"}
    assert (repo.worktree / "mine.txt").read_text() == "mine\n"


async def test_t6_c6_removing_a_gone_copy_is_fine(repo, run):
    await landing_git.remove_copy(run, checkout=str(repo.checkout), judge="e0e0e0")
    assert _entries(repo) == {f"nova-{ID}"}


async def test_t6_c6_a_worktree_of_hers_is_never_removed(repo, run):
    (repo.worktree / "work.txt").write_text("hers\n")
    with pytest.raises(ToolFailure) as caught:
        await landing_git.remove_copy(run, checkout=str(repo.checkout), judge=ID)
    assert "worktree" in str(caught.value)
    assert (repo.worktree / "work.txt").read_text() == "hers\n"
    assert not any(argv[0] == "rm" for argv in run.seen)


@pytest.mark.parametrize("judge", ["", "ABCDEF", "a1b2c", "a1b2c3d", "../x", "a1b2c3/..", " a1b2c"])
async def test_t6_c6_a_malformed_judge_runs_nothing(repo, run, judge):
    with pytest.raises(ToolFailure):
        await landing_git.remove_copy(run, checkout=str(repo.checkout), judge=judge)
    with pytest.raises(ToolFailure):
        landing_git.copy_path(str(repo.checkout), judge)
    assert run.seen == []


async def test_t6_c6_a_copy_still_there_after_rm_is_a_failure(repo, run):
    sha = _edit(repo, "mine.txt", "mine\n")
    copy = await _copy(run, repo, sha)

    async def rm_does_nothing(argv: list[str]) -> Ran:
        if argv[0] == "rm":
            return Ran(exit=0, output="")
        return await run(argv)

    with pytest.raises(ToolFailure) as caught:
        await landing_git.remove_copy(
            rm_does_nothing, checkout=str(repo.checkout), judge=copy.judge
        )
    assert copy.path in str(caught.value)


async def test_t6_c6_a_failing_rm_is_stated(repo, run):
    sha = _edit(repo, "mine.txt", "mine\n")
    copy = await _copy(run, repo, sha)

    async def rm_fails(argv: list[str]) -> Ran:
        if argv[:2] == ["rm", "-rf"]:
            return Ran(exit=1, output="rm: Permission denied")
        return await run(argv)

    with pytest.raises(ToolFailure) as caught:
        await landing_git.remove_copy(rm_fails, checkout=str(repo.checkout), judge=copy.judge)
    assert "Permission denied" in str(caught.value)


# -- T6 C7: argv only ---------------------------------------------------------------------


async def test_t6_c7_every_command_is_argv_only(repo, run):
    sha = _edit(repo, "mine.txt", "mine\n")
    copy = await _copy(run, repo, sha)
    await landing_git.remove_copy(run, checkout=str(repo.checkout), judge=copy.judge)
    assert run.seen
    for argv in run.seen:
        assert all(isinstance(word, str) for word in argv)
        assert argv[0] in _COMMANDS, argv
        assert "-c" not in argv or argv[0] == "git"
