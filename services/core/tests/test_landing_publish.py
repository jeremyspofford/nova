"""S32.3 T9: publishing a green landing (docs/plans/rebuild/s32/spec.md §5.2
step 7 and §9.2) — push her branch, open a PR with the verdict, put the
judged SHA on main (fast-forward only), fast-forward the deploy checkout.

These run REAL git against a bare "origin" in tmp (never github.com) and a
FAKE `gh` first on PATH that records its argv and answers as told. Nothing
here can reach the network.

Criteria:
  C1 Green only: publish with any other verdict raises ValueError and runs
     nothing.
  C2 A green landing: the JUDGED SHA (not a later commit of hers) is pushed
     to origin's <branch>; one `gh pr create --repo <slug from origin>
     --base <main> --head <branch> --title <the commit's subject> --body
     <pr_body>`; origin's main IS the judged SHA (fast-forward, same SHA);
     the deploy checkout's HEAD is that SHA, still on main; Published carries
     merged_sha = sha, the PR's URL, and a push_result naming the branch,
     the PR, main and the checkout.
  C3 Main moved during the landing: the main push is refused -> merged_sha
     None, origin's main keeps the other commit, the PR is kept, push_result
     says 'main moved during the landing; land again' with git's words; the
     checkout does not move.
  C4 An earlier step failing stops there, stated, never merged: her branch
     push refused (someone else pushed it) -> no gh, no main push; gh
     failing (an error, no URL, gh not runnable) -> main untouched, the
     branch pushed and said so; a PR already open for the branch is reused
     (its URL read from gh's words) and the landing goes on.
  C5 The checkout not following after GitHub took it: on another branch, or
     a dirty file in the way -> merged_sha = sha (it IS on main), push_result
     says the deploy checkout did not follow and why; its branch never moves.
  C6 Inputs and argv: every command is argv-only (git -C <checkout>, gh);
     repo_slug reads owner/repo from scp-like, ssh:// and https URLs (with
     or without .git) and refuses one it cannot read; a malformed sha,
     branch (main itself, '-'-led, blank) or checkout is stated with nothing
     run; an unreadable origin URL is stated, nothing pushed.
  C7 pr_body carries the verdict, the landing id, the judged SHA, each
     suite's command, exit and counts, and the protected files (or none).
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from app import landing_git
from app.landing_git import Published, Ran
from app.tools.base import ToolFailure

ID = "a1b2c3"
BRANCH = f"nova/{ID}-week"
LANDING = "5f0c7c1e-1111-4222-8333-444455556666"
PR = "https://github.com/acme/nova/pull/7"
SUITES = [
    {
        "suite": "ruff",
        "command": ["ruff", "check", "--", "services/core/app/x.py"],
        "state": "done",
        "exit": 0,
        "passed": None,
        "failed": None,
        "skipped": None,
        "seconds": 0.4,
        "outcome": "passed",
    },
    {
        "suite": "core",
        "command": ["uv", "run", "pytest"],
        "state": "done",
        "exit": 0,
        "passed": 812,
        "failed": 0,
        "skipped": 3,
        "seconds": 345.2,
        "outcome": "passed",
    },
]

FAKE_GH = """\
import json, os, sys
with open(os.environ["FAKE_GH_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
mode = os.environ.get("FAKE_GH_MODE", "ok")
if sys.argv[1:3] != ["pr", "create"]:
    print("fake gh: only `pr create` is expected", file=sys.stderr)
    sys.exit(2)
if mode == "ok":
    print("Creating pull request for x into main in acme/nova\\n", file=sys.stderr)
    print("@PR@")
    sys.exit(0)
if mode == "exists":
    print('a pull request for branch "x" into branch "main" already exists:', file=sys.stderr)
    print("https://github.com/acme/nova/pull/3", file=sys.stderr)
    sys.exit(1)
if mode == "nourl":
    print("done", file=sys.stderr)
    sys.exit(0)
print("HTTP 401: Bad credentials (https://api.github.com/graphql)", file=sys.stderr)
sys.exit(1)
""".replace("@PR@", PR)


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
    sha: str
    main_before: str
    gh_log: Path

    def origin_ref(self, name: str) -> str | None:
        done = subprocess.run(
            ["git", "-C", str(self.origin), "rev-parse", "--verify", "-q", f"refs/heads/{name}"],
            capture_output=True,
            text=True,
        )
        return done.stdout.strip() or None

    def gh_calls(self) -> list[list[str]]:
        if not self.gh_log.exists():
            return []
        return [json.loads(line) for line in self.gh_log.read_text().splitlines() if line]

    def move_main(self) -> str:
        _git(self.upstream, "pull", "-q", "--ff-only", "origin", "main")
        (self.upstream / "other.txt").write_text("another landing\n")
        sha = _commit(self.upstream, "another landing")
        _git(self.upstream, "push", "-q", "origin", "main")
        return sha


@pytest.fixture
def repo(tmp_path, monkeypatch) -> Repo:
    gitconfig = tmp_path / "gitconfig"
    gitconfig.write_text(
        "[user]\n\tname = Owner\n\temail = owner@example.com\n"
        "[init]\n\tdefaultBranch = main\n"
        "[color]\n\tui = always\n"
    )
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(gitconfig))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    # The fake gh is the only gh this test can reach.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    gh = bin_dir / "gh"
    gh.write_text(f"#!{sys.executable}\n{FAKE_GH}")
    gh.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    gh_log = tmp_path / "gh.log"
    monkeypatch.setenv("FAKE_GH_LOG", str(gh_log))
    monkeypatch.setenv("FAKE_GH_MODE", "ok")
    for name in ("GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_REPO"):
        monkeypatch.delenv(name, raising=False)
    assert shutil.which("gh") == str(gh)

    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "--bare", "-q", str(origin)], check=True)
    checkout = tmp_path / "nova"
    subprocess.run(["git", "clone", "-q", str(origin), str(checkout)], check=True)
    (checkout / ".gitignore").write_text(".worktrees/\n")
    (checkout / "a.txt").write_text("one\n")
    main_before = _commit(checkout, "init")
    _git(checkout, "push", "-q", "origin", "main")
    worktree = checkout / ".worktrees" / f"nova-{ID}"
    _git(checkout, "worktree", "add", "-q", "-b", BRANCH, str(worktree), "main")
    (worktree / "a.txt").write_text("one\ntwo\n")
    sha = _commit(worktree, "get_time: include the ISO week\n\nNova-Turn: t1")
    upstream = tmp_path / "upstream"
    subprocess.run(["git", "clone", "-q", str(origin), str(upstream)], check=True)
    return Repo(
        origin=origin,
        checkout=checkout,
        worktree=worktree,
        upstream=upstream,
        sha=sha,
        main_before=main_before,
        gh_log=gh_log,
    )


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


async def _publish(run, repo: Repo, **over) -> Published:
    kwargs = dict(
        verdict="green",
        checkout=str(repo.checkout),
        branch=BRANCH,
        main="main",
        sha=repo.sha,
        landing_id=LANDING,
        suites=SUITES,
        protected=[],
    )
    kwargs.update(over)
    return await landing_git.publish(run, **kwargs)


def _pushes_to(run: RealRunner, ref: str) -> list[list[str]]:
    return [a for a in run.seen if "push" in a and any(x.endswith(f":{ref}") for x in a)]


# -- C1: green only -------------------------------------------------------------


@pytest.mark.parametrize("verdict", ["red", "could_not_measure", "conflict", "running", "", None])
async def test_c1_only_a_green_landing_is_published(run, repo, verdict):
    with pytest.raises(ValueError, match="green"):
        await _publish(run, repo, verdict=verdict)
    assert run.seen == []
    assert repo.origin_ref(BRANCH) is None
    assert repo.origin_ref("main") == repo.main_before
    assert repo.gh_calls() == []


# -- C2: a green landing reaches main ----------------------------------------------


async def test_c2_a_green_landing_lands_the_judged_sha_everywhere(run, repo):
    published = await _publish(run, repo)
    assert published.merged_sha == repo.sha
    assert published.pr_url == PR
    assert repo.origin_ref(BRANCH) == repo.sha
    assert repo.origin_ref("main") == repo.sha  # fast-forward: the SAME SHA judged
    assert _git(repo.checkout, "rev-parse", "HEAD") == repo.sha
    assert _git(repo.checkout, "symbolic-ref", "--short", "HEAD") == "main"
    assert (repo.checkout / "a.txt").read_text() == "one\ntwo\n"


async def test_c2_the_push_result_names_each_step(run, repo):
    published = await _publish(run, repo)
    said = published.push_result
    assert BRANCH in said
    assert PR in said
    assert repo.sha in said
    assert "main" in said
    assert "deploy checkout" in said and "did not" not in said


async def test_c2_the_judged_sha_is_published_not_a_later_commit(run, repo):
    (repo.worktree / "later.txt").write_text("after the judge\n")
    later = _commit(repo.worktree, "a later commit, never judged")
    published = await _publish(run, repo)
    assert published.merged_sha == repo.sha
    assert repo.origin_ref(BRANCH) == repo.sha
    assert repo.origin_ref("main") == repo.sha
    assert _git(repo.checkout, "rev-parse", "HEAD") == repo.sha
    assert later != repo.sha
    assert not (repo.checkout / "later.txt").exists()


async def test_c2_the_pr_is_opened_once_with_the_verdict(run, repo):
    await _publish(run, repo, protected=["services/core/app/guards.py"])
    calls = repo.gh_calls()
    assert len(calls) == 1
    argv = calls[0]
    assert argv[:2] == ["pr", "create"]

    def opt(name: str) -> str:
        return argv[argv.index(name) + 1]

    assert opt("--repo") == landing_git.repo_slug(str(repo.origin))
    assert opt("--base") == "main"
    assert opt("--head") == BRANCH
    assert opt("--title") == "get_time: include the ISO week"
    assert opt("--body") == landing_git.pr_body(
        landing_id=LANDING,
        sha=repo.sha,
        suites=SUITES,
        protected=["services/core/app/guards.py"],
    )


async def test_c2_the_steps_run_in_order_branch_pr_main_checkout(run, repo):
    await _publish(run, repo)
    joined = [" ".join(a) for a in run.seen]
    branch_push = next(i for i, a in enumerate(joined) if f":refs/heads/{BRANCH}" in a)
    pr = next(i for i, a in enumerate(run.seen) if a[0] == "gh")
    main_push = next(i for i, a in enumerate(joined) if a.endswith(":refs/heads/main"))
    follow = next(i for i, a in enumerate(run.seen) if "merge" in a)
    assert branch_push < pr < main_push < follow


async def test_c2_a_rebased_branch_already_on_origin_is_replaced(run, repo):
    # An earlier landing pushed her branch before she rebased it.
    _git(repo.checkout, "push", "-q", "origin", f"{BRANCH}:refs/heads/{BRANCH}")
    _git(repo.worktree, "-c", "commit.gpgsign=false", "commit", "-q", "--amend", "-m", "again")
    rebased = _git(repo.worktree, "rev-parse", "HEAD")
    published = await _publish(run, repo, sha=rebased)
    assert published.merged_sha == rebased
    assert repo.origin_ref(BRANCH) == rebased


# -- C3: main moved during the landing ----------------------------------------------------


async def test_c3_main_moved_is_never_merged(run, repo):
    other = repo.move_main()
    published = await _publish(run, repo)
    assert published.merged_sha is None
    assert published.pr_url == PR
    assert "main moved during the landing; land again" in published.push_result
    assert "rejected" in published.push_result  # git's own words
    assert repo.origin_ref("main") == other
    assert _git(repo.checkout, "rev-parse", "HEAD") == repo.main_before
    assert not any("merge" in a for a in run.seen)


# -- C4: an earlier step failing stops there ------------------------------------------------


async def test_c4_a_branch_push_refused_stops_before_gh_and_main(run, repo):
    # Someone else pushed her branch after the checkout last saw origin.
    _git(repo.upstream, "checkout", "-q", "-b", BRANCH, "origin/main")
    (repo.upstream / "theirs.txt").write_text("not hers\n")
    theirs = _commit(repo.upstream, "theirs")
    _git(repo.upstream, "push", "-q", "origin", BRANCH)
    published = await _publish(run, repo)
    assert published.merged_sha is None
    assert published.pr_url is None
    assert "pushing" in published.push_result and BRANCH in published.push_result
    assert "rejected" in published.push_result
    assert repo.origin_ref(BRANCH) == theirs
    assert repo.origin_ref("main") == repo.main_before
    assert repo.gh_calls() == []
    assert _pushes_to(run, "refs/heads/main") == []


@pytest.mark.parametrize(
    "mode, words",
    [
        ("fail", "`gh pr create` exited 1: HTTP 401: Bad credentials"),
        ("nourl", "printed no pull request URL"),
    ],
)
async def test_c4_gh_failing_never_reaches_main(run, repo, monkeypatch, mode, words):
    monkeypatch.setenv("FAKE_GH_MODE", mode)
    published = await _publish(run, repo)
    assert published.merged_sha is None
    assert published.pr_url is None
    assert words in published.push_result
    assert f"{BRANCH} was pushed" in published.push_result
    assert repo.origin_ref(BRANCH) == repo.sha
    assert repo.origin_ref("main") == repo.main_before
    assert _pushes_to(run, "refs/heads/main") == []
    assert _git(repo.checkout, "rev-parse", "HEAD") == repo.main_before


async def test_c4_gh_not_runnable_is_stated(repo):
    seen: list[list[str]] = []
    real = RealRunner()

    async def runner(argv):
        seen.append(list(argv))
        if argv[0] == "gh":
            raise ToolFailure(
                'mini-pc: could not run `gh pr create`: could not run "gh": not found'
            )
        return await real(argv)

    published = await _publish(runner, repo)
    assert published.merged_sha is None
    assert published.pr_url is None
    assert 'could not run "gh"' in published.push_result
    assert repo.origin_ref("main") == repo.main_before
    assert not any(a[0] == "git" and a[-1].endswith(":refs/heads/main") for a in seen)


async def test_c4_a_pr_already_open_is_reused(run, repo, monkeypatch):
    monkeypatch.setenv("FAKE_GH_MODE", "exists")
    published = await _publish(run, repo)
    assert published.pr_url == "https://github.com/acme/nova/pull/3"
    assert published.merged_sha == repo.sha
    assert repo.origin_ref("main") == repo.sha


async def test_c4_a_runner_failure_on_a_git_step_is_stated_never_raised(repo):
    real = RealRunner()

    async def runner(argv):
        if argv[0] == "git" and "push" in argv:
            raise ToolFailure("mini-pc is offline")
        return await real(argv)

    published = await _publish(runner, repo)
    assert published.merged_sha is None
    assert "mini-pc is offline" in published.push_result
    assert repo.origin_ref("main") == repo.main_before


async def test_c4_a_runner_failure_on_the_main_push_is_never_merged(repo):
    # The branch push and the PR went; only the push of the judged SHA to
    # main fails in the runner (the agent dropped mid-landing). Main was never
    # pushed, so nothing may claim merged — and it is stated, never raised.
    real = RealRunner()
    main_push = f"{repo.sha}:refs/heads/main"

    async def runner(argv):
        if argv[0] == "git" and "push" in argv and argv[-1] == main_push:
            raise ToolFailure("mini-pc is offline")
        return await real(argv)

    published = await _publish(runner, repo)
    assert published.merged_sha is None
    assert published.pr_url == PR
    assert "mini-pc is offline" in published.push_result
    assert "not merged" in published.push_result
    assert repo.origin_ref(BRANCH) == repo.sha  # the branch did go
    assert repo.origin_ref("main") == repo.main_before
    assert _git(repo.checkout, "rev-parse", "HEAD") == repo.main_before
    assert len(repo.gh_calls()) == 1


@pytest.mark.parametrize("step", ["symbolic-ref", "merge", "rev-parse"])
async def test_c4_a_runner_failure_at_the_follow_step_is_stated_never_raised(repo, step):
    # Main took the judged SHA; the deploy checkout's step then fails in the
    # runner. The landing IS merged (origin's main is the SHA) and the
    # checkout not following is stated with the runner's words.
    real = RealRunner()

    async def runner(argv):
        if argv[0] == "git" and argv[3] == step:
            raise ToolFailure("mini-pc is offline")
        return await real(argv)

    published = await _publish(runner, repo)
    assert published.merged_sha == repo.sha
    assert published.pr_url == PR
    assert repo.origin_ref("main") == repo.sha
    assert "deploy checkout did not follow" in published.push_result
    assert "mini-pc is offline" in published.push_result


# -- C5: the deploy checkout not following ----------------------------------------------------


async def test_c5_a_checkout_on_another_branch_does_not_follow(run, repo):
    _git(repo.checkout, "checkout", "-q", "-b", "owner-work")
    published = await _publish(run, repo)
    assert published.merged_sha == repo.sha
    assert repo.origin_ref("main") == repo.sha
    assert "deploy checkout did not follow" in published.push_result
    assert "owner-work" in published.push_result
    assert _git(repo.checkout, "symbolic-ref", "--short", "HEAD") == "owner-work"
    assert _git(repo.checkout, "rev-parse", "HEAD") == repo.main_before
    assert _git(repo.checkout, "rev-parse", "main") == repo.main_before


async def test_c5_a_dirty_file_in_the_way_is_stated(run, repo):
    (repo.checkout / "a.txt").write_text("owner's own edit\n")
    published = await _publish(run, repo)
    assert published.merged_sha == repo.sha
    assert published.pr_url == PR
    assert "deploy checkout did not follow" in published.push_result
    assert "a.txt" in published.push_result  # git's words name the file
    assert _git(repo.checkout, "rev-parse", "HEAD") == repo.main_before
    assert (repo.checkout / "a.txt").read_text() == "owner's own edit\n"


async def test_c5_a_dirty_file_out_of_the_way_still_follows(run, repo):
    (repo.checkout / "notes.txt").write_text("untracked, not in her change\n")
    published = await _publish(run, repo)
    assert published.merged_sha == repo.sha
    assert "did not follow" not in published.push_result
    assert _git(repo.checkout, "rev-parse", "HEAD") == repo.sha


async def test_c5_a_merge_that_did_not_move_head_is_never_called_followed(repo):
    real = RealRunner()

    async def runner(argv):
        if "merge" in argv:
            return Ran(exit=0, output="")  # says it went, did nothing
        return await real(argv)

    published = await _publish(runner, repo)
    assert published.merged_sha == repo.sha
    assert "deploy checkout did not follow" in published.push_result
    assert repo.main_before in published.push_result


# -- C6: inputs and argv ------------------------------------------------------------------------


async def test_c6_every_command_is_argv_git_from_the_checkout_or_gh(run, repo):
    await _publish(run, repo)
    assert run.seen
    for argv in run.seen:
        assert argv[0] in ("git", "gh"), argv
        if argv[0] == "git":
            assert argv[1:3] == ["-C", str(repo.checkout)], argv


@pytest.mark.parametrize(
    "url, slug",
    [
        ("git@github.com:jeremyspofford/nova.git", "jeremyspofford/nova"),
        ("git@github.com:jeremyspofford/nova", "jeremyspofford/nova"),
        ("https://github.com/jeremyspofford/nova.git", "jeremyspofford/nova"),
        ("https://github.com/jeremyspofford/nova/", "jeremyspofford/nova"),
        ("ssh://git@github.com/acme/tool.git", "acme/tool"),
        ("github-nova:acme/tool.git", "acme/tool"),
        ("/tmp/x/acme/origin.git", "acme/origin"),
    ],
)
def test_c6_repo_slug_reads_owner_and_repo(url, slug):
    assert landing_git.repo_slug(url) == slug


@pytest.mark.parametrize("url", ["", "   ", "nova.git", "git@github.com:", "https://github.com/"])
def test_c6_repo_slug_refuses_what_it_cannot_read(url):
    with pytest.raises(ToolFailure, match="owner/repo"):
        landing_git.repo_slug(url)


@pytest.mark.parametrize(
    "over",
    [
        {"sha": "abc123"},
        {"sha": "HEAD"},
        {"sha": None},
        {"branch": "main"},
        {"branch": "-f"},
        {"branch": ""},
        {"branch": "nova/x y"},
        {"checkout": "relative/nova"},
        {"checkout": "/"},
        {"main": ""},
    ],
)
async def test_c6_malformed_inputs_are_stated_and_nothing_runs(run, repo, over):
    published = await _publish(run, repo, **over)
    assert published.merged_sha is None
    assert published.pr_url is None
    assert published.push_result.startswith("not published:")
    assert run.seen == []
    assert repo.origin_ref("main") == repo.main_before


async def test_c6_an_origin_without_a_url_is_stated_nothing_pushed(run, repo):
    _git(repo.checkout, "remote", "set-url", "origin", "nova.git")
    published = await _publish(run, repo)
    assert published.merged_sha is None
    assert published.push_result.startswith("not published:")
    assert "owner/repo" in published.push_result
    assert not any("push" in a for a in run.seen)
    assert repo.origin_ref(BRANCH) is None


# -- C7: the PR body -------------------------------------------------------------------------------


def test_c7_the_body_carries_the_verdict_and_every_suite():
    body = landing_git.pr_body(
        landing_id=LANDING,
        sha="f" * 40,
        suites=SUITES,
        protected=["services/core/app/guards.py", "tests/test_no_approvals.py"],
    )
    assert "green" in body
    assert LANDING in body
    assert "f" * 40 in body
    assert "ruff check -- services/core/app/x.py" in body
    assert "uv run pytest" in body
    assert "812 passed" in body and "0 failed" in body and "3 skipped" in body
    assert "exit 0" in body
    assert "services/core/app/guards.py" in body
    assert "tests/test_no_approvals.py" in body


def test_c7_no_protected_file_says_none():
    body = landing_git.pr_body(landing_id=LANDING, sha="f" * 40, suites=SUITES, protected=[])
    assert "Protected files touched: none" in body


def test_c7_unknown_counts_are_not_printed_as_zero():
    body = landing_git.pr_body(landing_id=LANDING, sha="f" * 40, suites=SUITES[:1], protected=[])
    ruff_line = next(line for line in body.splitlines() if "ruff check" in line)
    assert "exit 0" in ruff_line
    assert "0 passed" not in ruff_line
    assert "None" not in body
