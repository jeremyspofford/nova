"""S32.3 T10: repo_land and the landing run (docs/plans/rebuild/s32/spec.md
§5.2 steps 1-8, §9.2, §9.3).

repo_land's sync step (commit check, nothing to land) answers in the call;
the rest runs in the background — rebase onto the fetched main, main's
suites.toml, a clean copy, the suites as jobs (faked here: landing_run's
`run_suites` seam, T8's own tests cover it), the verdict, the publish on
green, and the close.

These run REAL git against a bare "origin" in tmp (never github.com) and a
FAKE `gh` first on PATH. Nothing here can reach the network.

Criteria:
  C1 repo_land's sync step refuses with an Error and writes NO row: a
     malformed change id (nothing sent); no open worktree of hers for the id;
     uncommitted work; no commit beyond origin/<main>; a landing of the same
     change still running (named).
  C2 Otherwise a `running` row (change, repo, branch, turn, author, coder,
     commit_sha) and a result naming the landing id and landing_status,
     returned before the landing finishes; the tool's definition.
  C3 The run rebases onto the fetched main and records base/commit SHA, the
     patch, protected (from MAIN's suites.toml) and dirty_outside; run_suites
     gets a clean copy of the judged commit, main's plan, the default branch
     and the turn; the verdict and suites are recorded.
  C4 Green: the judged SHA on origin's main and branch, a PR, the checkout
     followed; green row with merged_sha/pr_url/push_result; close removes
     judge box + copy, the change's box and her worktree; branch kept.
  C5 Never merged unless green: red / could_not_measure / conflict leave
     main, gh, her worktree and her box alone; a conflict records its files
     and base, aborts, copies nothing and runs nothing.
  C6 Failures are could_not_measure in their own words, never left running,
     the close still runs; a failing close step is appended, the verdict
     stands.
  C7 One landing at a time per repo; startup marks running landings
     could_not_measure; shutdown cancels landing tasks.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from app import landing_git, landing_run, landings, tools
from app.landing_git import Ran
from app.landing_plan import planned_commands, suite_result
from app.main import app, lifespan
from app.tools import changes
from app.tools import landing as landing_tools
from app.tools.base import ToolContext, ToolFailure
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice, FakeWSConn
from tests.test_devices_ws import _close, _person
from tests.test_start_change import _connect

pytestmark = requires_db

HOST = "mini-pc"
ID = "a1b2c3"
ID2 = "d4e5f6"
BRANCH = f"nova/{ID}-iso-week"
BRANCH2 = f"nova/{ID2}-other"
NOVA = f"Nova <nova@{HOST}>"
CODER = "nova-loop ollama:qwen3:8b"
PR = "https://github.com/acme/nova/pull/7"
ROW = {"id": uuid.UUID("11111111-2222-4333-8444-555555555555"), "name": "Beelink"}
REAL_SUITES = Path(__file__).resolve().parents[3] / "deploy" / "devbox" / "suites.toml"

FAKE_GH = """\
import json, os, sys
with open(os.environ["FAKE_GH_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1:3] != ["pr", "create"]:
    print("fake gh: only `pr create` is expected", file=sys.stderr)
    sys.exit(2)
print("@PR@")
""".replace("@PR@", PR)


def _git(cwd: Path, *argv: str) -> str:
    done = subprocess.run(
        ["git", "-C", str(cwd), *argv], capture_output=True, text=True, check=True
    )
    return done.stdout.strip()


def _commit(cwd: Path, message: str, *, nova: bool = False, coder: str = CODER) -> str:
    _git(cwd, "add", "-A")
    extra = []
    if nova:
        extra = [
            "-c",
            "user.name=Nova",
            "-c",
            f"user.email=nova@{HOST}",
        ]
    args = [*extra, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]
    if nova:
        args += ["--trailer", "Nova-Turn: t1", "--trailer", f"Nova-Coder: {coder}"]
    _git(cwd, *args)
    return _git(cwd, "rev-parse", "HEAD")


@dataclass
class Repo:
    origin: Path
    checkout: Path
    worktree: Path
    upstream: Path
    main_before: str
    sha: str
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

    def push_main(self, files: dict[str, str | None], message: str = "another landing") -> str:
        _git(self.upstream, "pull", "-q", "--ff-only", "origin", "main")
        for rel, text in files.items():
            path = self.upstream / rel
            if text is None:
                path.unlink()
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
        sha = _commit(self.upstream, message)
        _git(self.upstream, "push", "-q", "origin", "main")
        return sha

    def add_change(self, change: str, branch: str, files: dict[str, str] | None) -> Path:
        """Another worktree of hers; with files, one Nova commit beyond main."""
        worktree = self.checkout / ".worktrees" / f"nova-{change}"
        _git(self.checkout, "worktree", "add", "-q", "-b", branch, str(worktree), "origin/main")
        if files:
            for rel, text in files.items():
                path = worktree / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            _commit(worktree, f"change {change}", nova=True)
        return worktree


@pytest.fixture
def repo(tmp_path, monkeypatch) -> Repo:
    gitconfig = tmp_path / "gitconfig"
    gitconfig.write_text(
        "[user]\n\tname = Owner\n\temail = owner@example.com\n[init]\n\tdefaultBranch = main\n"
    )
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(gitconfig))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for name in (
        "GIT_AUTHOR_NAME",
        "GIT_AUTHOR_EMAIL",
        "GIT_COMMITTER_NAME",
        "GIT_COMMITTER_EMAIL",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_HOST",
        "GH_REPO",
    ):
        monkeypatch.delenv(name, raising=False)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    gh = bin_dir / "gh"
    gh.write_text(f"#!{sys.executable}\n{FAKE_GH}")
    gh.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    gh_log = tmp_path / "gh.log"
    monkeypatch.setenv("FAKE_GH_LOG", str(gh_log))
    assert shutil.which("gh") == str(gh)

    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "--bare", "-q", str(origin)], check=True)
    checkout = tmp_path / "nova"
    subprocess.run(["git", "clone", "-q", str(origin), str(checkout)], check=True)
    (checkout / ".gitignore").write_text(".worktrees/\n")
    (checkout / "README.md").write_text("# Nova\n")
    suites = checkout / "deploy" / "devbox" / "suites.toml"
    suites.parent.mkdir(parents=True)
    suites.write_text(REAL_SUITES.read_text())
    app_dir = checkout / "services" / "core" / "app"
    app_dir.mkdir(parents=True)
    (app_dir / "x.py").write_text("A = 1\n")
    tests_dir = checkout / "services" / "core" / "tests"
    tests_dir.mkdir(parents=True)
    (tests_dir / "test_x.py").write_text("def test_x():\n    pass\n")
    main_before = _commit(checkout, "init")
    _git(checkout, "push", "-q", "origin", "main")
    upstream = tmp_path / "upstream"
    subprocess.run(["git", "clone", "-q", str(origin), str(upstream)], check=True)
    monkeypatch.setenv("NOVA_CHECKOUT", str(checkout))
    monkeypatch.setenv("NOVA_REPO_HOST", HOST)
    monkeypatch.setenv("NOVA_REPO_BRANCH", "main")
    r = Repo(
        origin=origin,
        checkout=checkout,
        worktree=checkout / ".worktrees" / f"nova-{ID}",
        upstream=upstream,
        main_before=main_before,
        sha="",
        gh_log=gh_log,
    )
    r.add_change(ID, BRANCH, {"services/core/app/x.py": "A = 2\n"})
    r.sha = _git(r.worktree, "rev-parse", "HEAD")
    return r


@dataclass
class RealRunner:
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


def _tree(path: Path) -> dict[str, str]:
    return {str(p.relative_to(path)): p.read_text() for p in sorted(path.rglob("*")) if p.is_file()}


@dataclass
class FakeSuites:
    """Stands in for landing_run.run_suites: records what it was handed (and
    the copy's tree, read while the copy exists), answers every planned
    command with `outcomes` (suite -> 'passed' | 'failed' | 'lost')."""

    outcomes: dict[str, str] = field(default_factory=dict)
    raises: BaseException | None = None
    gate: asyncio.Event | None = None
    gate_calls: int = 1
    entered: asyncio.Event = field(default_factory=asyncio.Event)
    calls: list[dict] = field(default_factory=list)
    trees: list[dict[str, str]] = field(default_factory=list)
    git_in_copy: list[bool] = field(default_factory=list)
    during: object = None

    async def __call__(self, pool, row, ctx, **kw) -> list[dict]:
        self.calls.append(kw)
        copy_path = Path(kw["copy"].path)
        self.trees.append(_tree(copy_path))
        self.git_in_copy.append((copy_path / ".git").exists())
        self.entered.set()
        if self.gate is not None and len(self.calls) <= self.gate_calls:
            await self.gate.wait()
        if self.during is not None:
            self.during()
        if self.raises is not None:
            raise self.raises
        results = []
        for suite, _dir, argv in planned_commands(kw["plan"]):
            outcome = self.outcomes.get(suite, "passed")
            if outcome == "failed":
                results.append(
                    suite_result(
                        suite,
                        argv,
                        state="done",
                        exit_code=1,
                        log="=== 1 failed, 3 passed in 1.0s ===\n",
                        seconds=1.0,
                    )
                )
            elif outcome == "lost":
                results.append(
                    suite_result(
                        suite,
                        argv,
                        state="lost",
                        exit_code=None,
                        log="",
                        seconds=None,
                        reason="the agent restarted",
                    )
                )
            else:
                log = "=== 4 passed in 1.0s ===\n" if "pytest" in argv else "All checks passed!\n"
                results.append(
                    suite_result(suite, argv, state="done", exit_code=0, log=log, seconds=1.0)
                )
            await landings.update(pool, kw["landing_id"], suites=results)
            if outcome != "passed":
                break
        return results


@dataclass
class FakeBoxes:
    words: dict[str, str] = field(default_factory=dict)
    removed: list[str] = field(default_factory=list)

    async def __call__(self, pool, row, ctx, change) -> str:
        self.removed.append(change)
        return self.words.get(change, "")


@pytest.fixture
def suites(monkeypatch) -> FakeSuites:
    fake = FakeSuites()
    monkeypatch.setattr(landing_run, "run_suites", fake)
    return fake


@pytest.fixture
def boxes(monkeypatch) -> FakeBoxes:
    fake = FakeBoxes()
    monkeypatch.setattr(changes, "remove_box", fake)
    return fake


async def _turn(pool) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model) VALUES ('chat', NULL, 'm') RETURNING id"
    )


def _ctx(turn, facts=None) -> ToolContext:
    return ToolContext(
        app=None,
        person=None,
        workspace_root=Path("/tmp"),
        facts_sink=facts,
        turn_id=turn,
        coder=CODER,
    )


async def _land(pool, repo: Repo, *, change=ID, branch=BRANCH, worktree=None) -> dict:
    """Insert a running landing and run it inline (no task); its row after."""
    turn = await _turn(pool)
    lid = await landings.insert(pool, change_id=change, repo="nova", branch=branch, turn_id=turn)
    await asyncio.wait_for(
        landing_run.land(
            pool,
            ROW,
            _ctx(turn),
            landing_id=lid,
            change=change,
            checkout=str(repo.checkout),
            worktree=str(worktree or repo.worktree),
            main="main",
            host=HOST,
            turn_id=turn,
            run=RealRunner(),
        ),
        60,
    )
    row = await landings.get(pool, lid)
    row["_turn"] = turn
    return row


def _copies(repo: Repo) -> list[str]:
    root = repo.checkout / ".worktrees"
    return sorted(p.name for p in root.iterdir()) if root.exists() else []


def _rebase_in_progress(worktree: Path) -> bool:
    gitdir = Path(_git(worktree, "rev-parse", "--absolute-git-dir"))
    return (gitdir / "rebase-merge").exists() or (gitdir / "rebase-apply").exists()


# -- the tool, end to end through the agent ------------------------------------


@dataclass
class Agent:
    """Runs shell.exec argv for real (no shell); box.remove answers ok and is
    recorded; anything else is an unknown capability."""

    seen: list[dict] = field(default_factory=list)

    async def answer(self, envelope: dict) -> dict:
        self.seen.append(envelope)
        cap = envelope["capability"]
        if cap == "box.remove":
            change = envelope["args"]["change"]
            return {"ok": True, "output": f"removed nova-box-{change}", "exit_code": 0}
        if cap != "shell.exec":
            return {"ok": False, "output": "", "exit_code": None, "error": "unknown capability"}
        proc = await asyncio.create_subprocess_exec(
            *envelope["args"]["argv"],
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=dict(os.environ),
        )
        out, _ = await proc.communicate()
        return {"ok": True, "output": out.decode(), "exit_code": proc.returncode, "error": None}

    def removed(self) -> list[str]:
        return [e["args"]["change"] for e in self.seen if e["capability"] == "box.remove"]


async def _serve(conn: FakeWSConn, device: FakeDevice, agent: Agent) -> None:
    while True:
        frame = await conn.next_sent()
        if not isinstance(frame, dict) or frame.get("type") != "command":
            continue
        conn.feed(device.result(frame["envelope"], **await agent.answer(frame["envelope"])))


@pytest.fixture
def registered(monkeypatch):
    monkeypatch.setitem(tools.REGISTRY, landing_tools.REPO_LAND, landing_tools.REPO_LAND_TOOL)


async def _repo_land(pool, args: dict, *, between=None, settle: bool = True):
    """Dispatch repo_land while the agent answers; `between` runs after the
    call returned and before the landing is settled. Returns
    (result, ok, agent, turn)."""
    device, conn, task = await _connect(pool)
    agent = Agent()
    await _person(pool)
    turn = await _turn(pool)
    server = asyncio.create_task(_serve(conn, device, agent))
    try:
        result, ok = await asyncio.wait_for(
            tools.dispatch(landing_tools.REPO_LAND, args, _ctx(turn, [])), 30
        )
        if between is not None:
            await between()
        if settle:
            await asyncio.wait_for(landing_run.settle(), 60)
    finally:
        server.cancel()
        await _close(conn, task)
    return result, ok, agent, turn


async def _count(pool) -> int:
    return await pool.fetchval("SELECT count(*) FROM landings")


# -- C1: the sync step ----------------------------------------------------------


@pytest.mark.parametrize("change", ["ABCDEF", "a1b2c", "a1b2c3d", "../x12", "a1b2c\n", "a1b2cg"])
async def test_c1_a_malformed_change_is_refused_with_nothing_sent(
    pool, repo, registered, suites, change
):
    result, ok, agent, _ = await _repo_land(pool, {"change": change})
    assert ok is False
    assert result.startswith("Error:")
    assert "change" in result
    assert agent.seen == []
    assert await _count(pool) == 0
    assert suites.calls == []


async def test_c1_a_change_with_no_open_worktree_is_named(pool, repo, registered, suites):
    result, ok, agent, _ = await _repo_land(pool, {"change": "ffffff"})
    assert ok is False
    assert "ffffff" in result and "list_changes" in result
    assert await _count(pool) == 0
    # Nothing beyond the listing was asked of the machine.
    argvs = [e["args"]["argv"] for e in agent.seen if e["capability"] == "shell.exec"]
    assert not any("status" in a or "rev-list" in a for a in argvs)


async def test_c1_uncommitted_work_is_refused_naming_the_files(pool, repo, registered, suites):
    (repo.worktree / "services" / "core" / "app" / "y.py").write_text("B = 1\n")
    (repo.worktree / "README.md").write_text("# changed\n")
    result, ok, _agent, _ = await _repo_land(pool, {"change": ID})
    assert ok is False
    assert (
        "uncommitted changes in README.md, services/core/app/y.py; call change_commit first"
        in result
    )
    assert await _count(pool) == 0
    assert suites.calls == []


async def test_c1_nothing_beyond_main_is_refused(pool, repo, registered, suites):
    repo.add_change(ID2, BRANCH2, None)
    result, ok, _agent, _ = await _repo_land(pool, {"change": ID2})
    assert ok is False
    assert "nothing to land" in result
    assert await _count(pool) == 0


async def test_c1_a_landing_of_the_same_change_still_running_is_named(
    pool, repo, registered, suites
):
    earlier = await landings.insert(pool, change_id=ID, repo="nova", branch=BRANCH, turn_id=None)
    result, ok, _agent, _ = await _repo_land(pool, {"change": ID})
    assert ok is False
    assert str(earlier) in result and "landing_status" in result
    assert await _count(pool) == 1
    assert suites.calls == []


async def test_c1_a_finished_landing_of_the_change_does_not_stop_another(
    pool, repo, registered, suites, boxes
):
    earlier = await landings.insert(pool, change_id=ID, repo="nova", branch=BRANCH, turn_id=None)
    await landings.finish(pool, earlier, "red", reason="core failed")
    result, ok, _agent, _ = await _repo_land(pool, {"change": ID})
    assert ok is True, result
    assert await _count(pool) == 2


# -- C2: the row, and the answer at once -----------------------------------------


async def test_c2_a_running_row_is_written_and_the_call_returns_at_once(
    pool, repo, registered, suites
):
    suites.gate = asyncio.Event()
    seen: dict = {}

    async def between():
        await asyncio.wait_for(suites.entered.wait(), 30)
        [row] = await pool.fetch("SELECT * FROM landings")
        seen.update(dict(row))
        suites.gate.set()

    result, ok, agent, turn = await _repo_land(pool, {"change": ID}, between=between)
    assert ok is True, result
    lid = seen["id"]
    assert str(lid) in result
    assert "landing_status" in result
    # While the suites ran, the call had already answered: the row was running.
    assert seen["verdict"] == "running"
    assert seen["change_id"] == ID
    assert seen["repo"] == "nova"
    assert seen["branch"] == BRANCH
    assert seen["turn_id"] == turn
    assert seen["author"] == NOVA
    assert seen["coder"] == CODER
    # And the background landing went on to green through the same agent.
    row = await landings.get(pool, lid)
    assert row["verdict"] == "green", row["reason"]
    assert row["merged_sha"] == row["commit_sha"] == repo.origin_ref("main")
    assert sorted(agent.removed()) == sorted([row["judge_id"], ID])
    assert not repo.worktree.exists()


async def test_c2_the_insert_records_the_heads_sha_before_judging(
    pool, repo, registered, suites, boxes, monkeypatch
):
    # Held before the rebase step, so the row read is what the call wrote.
    gate, entered = asyncio.Event(), asyncio.Event()
    real_prepare = landing_git.prepare

    async def held(*a, **kw):
        entered.set()
        await gate.wait()
        return await real_prepare(*a, **kw)

    monkeypatch.setattr(landing_git, "prepare", held)
    repo.push_main({"other.txt": "another landing\n"})
    seen: dict = {}

    async def between():
        await asyncio.wait_for(entered.wait(), 30)
        seen.update(dict(await pool.fetchrow("SELECT * FROM landings")))
        gate.set()

    result, ok, _agent, _ = await _repo_land(pool, {"change": ID}, between=between)
    assert ok is True, result
    assert seen["commit_sha"] == repo.sha
    assert seen["verdict"] == "running"
    assert seen["base_sha"] is None
    # Once rebased, the row names the commit judged instead.
    row = await landings.get(pool, seen["id"])
    assert row["commit_sha"] != repo.sha and row["verdict"] == "green"


async def test_c2_no_coder_trailer_records_none(pool, repo, registered, suites):
    (repo.worktree / "services" / "core" / "app" / "x.py").write_text("A = 3\n")
    _git(repo.worktree, "add", "-A")
    _git(repo.worktree, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "plain")
    result, ok, _agent, _ = await _repo_land(pool, {"change": ID})
    assert ok is True, result
    row = await pool.fetchrow("SELECT author, coder FROM landings")
    assert row["author"] == "Owner <owner@example.com>"
    assert row["coder"] is None


def test_c2_the_tool_definition():
    tool = landing_tools.REPO_LAND_TOOL
    assert tool.name == "repo_land" == landing_tools.REPO_LAND
    assert tool.parameters == {
        "type": "object",
        "properties": {
            "change": {
                "type": "string",
                "pattern": "^[0-9a-f]{6}$",
                "description": tool.parameters["properties"]["change"]["description"],
            }
        },
        "required": ["change"],
        "additionalProperties": False,
    }
    assert tool.reads_only is False
    assert tool.ephemeral is False
    assert tool.executor is landing_tools.repo_land
    for word in ("landing_status", "change_commit", "main", "background"):
        assert word in tool.description


# -- C3: what is judged and recorded ---------------------------------------------


async def test_c3_a_branch_behind_is_rebased_and_the_row_records_what_was_judged(
    pool, repo, suites, boxes
):
    moved = repo.push_main({"other.txt": "another landing\n"})
    row = await _land(pool, repo)
    assert row["verdict"] == "green", row["reason"]
    assert row["base_sha"] == moved
    assert row["commit_sha"] != repo.sha
    assert _git(repo.checkout, "rev-parse", f"{row['commit_sha']}~1") == moved
    assert row["merged_sha"] == row["commit_sha"]
    assert "+A = 2" in row["patch"] and "-A = 1" in row["patch"]
    assert row["patch_truncated"] is False
    assert row["finished_at"] is not None


async def test_c3_the_suites_get_a_clean_copy_of_the_judged_commit(pool, repo, suites, boxes):
    repo.push_main({"other.txt": "another landing\n"})
    row = await _land(pool, repo)
    [call] = suites.calls
    copy = call["copy"]
    assert copy.judge == row["judge_id"]
    assert copy.path == str(repo.checkout / ".worktrees" / f"nova-{copy.judge}")
    assert copy.judge != ID
    [tree] = suites.trees
    assert tree["services/core/app/x.py"] == "A = 2\n"
    assert tree["other.txt"] == "another landing\n"
    assert suites.git_in_copy == [False]
    assert call["checkout"] == str(repo.checkout)
    assert call["branch"] == "main"
    assert call["turn_id"] == row["_turn"]
    assert call["landing_id"] == row["id"]
    plan = call["plan"]
    assert [s.name for s in plan.suites] == ["core"]
    assert plan.ruff_files == ("services/core/app/x.py",)


async def test_c3_protected_is_read_from_mains_suites_toml(pool, repo, suites, boxes):
    _git(repo.worktree, "reset", "-q", "--hard", "origin/main")
    text = REAL_SUITES.read_text()
    start = text.index("protected = [")
    end = text.index("]", start) + 1
    (repo.worktree / "deploy" / "devbox" / "suites.toml").write_text(
        text[:start] + "protected = []" + text[end:]
    )
    (repo.worktree / "services" / "core" / "tests" / "test_x.py").write_text(
        "def test_x():\n    assert True\n"
    )
    _commit(repo.worktree, "shorten protected", nova=True)
    row = await _land(pool, repo)
    assert row["protected"] == ["services/core/tests/test_x.py"]
    [call] = suites.calls
    assert call["plan"].protected == ("services/core/tests/test_x.py",)
    assert {s.name for s in call["plan"].suites} == {"core", "installer"}


async def test_c3_dirty_outside_lists_the_checkouts_own_dirt(pool, repo, suites, boxes):
    (repo.checkout / "scratch.txt").write_text("the owner's\n")
    row = await _land(pool, repo)
    assert row["dirty_outside"] == ["scratch.txt"]
    assert row["verdict"] == "green"
    assert "scratch.txt" not in suites.trees[0]


async def test_c3_the_suites_are_recorded_on_the_row(pool, repo, suites, boxes):
    row = await _land(pool, repo)
    assert [(s["suite"], s["command"], s["outcome"]) for s in row["suites"]] == [
        ("ruff", ["ruff", "check", "--", "services/core/app/x.py"], "passed"),
        ("core", ["uv", "run", "pytest"], "passed"),
    ]


# -- C4: green ------------------------------------------------------------------


async def test_c4_a_green_landing_is_published_and_closed(pool, repo, suites, boxes):
    row = await _land(pool, repo)
    assert row["verdict"] == "green", row["reason"]
    sha = row["commit_sha"]
    assert sha == repo.sha  # not behind: no rebase
    assert repo.origin_ref("main") == sha
    assert repo.origin_ref(BRANCH) == sha
    [gh] = repo.gh_calls()
    assert gh[:2] == ["pr", "create"]
    assert _git(repo.checkout, "rev-parse", "HEAD") == sha
    assert row["merged_sha"] == sha
    assert row["pr_url"] == PR
    assert "followed" in row["push_result"]
    # Close: the judge box and the copy, her box and her worktree; the branch stays.
    assert boxes.removed == [row["judge_id"], ID]
    assert _copies(repo) == []
    assert not repo.worktree.exists()
    assert ID not in _git(repo.checkout, "worktree", "list")
    assert _git(repo.checkout, "rev-parse", "--verify", f"refs/heads/{BRANCH}") == sha


# -- C5: never merged unless green ------------------------------------------------


@pytest.mark.parametrize(
    ("outcome", "verdict", "words"),
    [("failed", "red", "core `uv run pytest` exit 1"), ("lost", "could_not_measure", "lost")],
)
async def test_c5_a_landing_that_is_not_green_is_never_merged(
    pool, repo, suites, boxes, outcome, verdict, words
):
    suites.outcomes = {"core": outcome}
    row = await _land(pool, repo)
    assert row["verdict"] == verdict
    assert words in row["reason"]
    assert row["merged_sha"] is None and row["pr_url"] is None and row["push_result"] is None
    assert repo.origin_ref("main") == repo.main_before
    assert repo.origin_ref(BRANCH) is None
    assert repo.gh_calls() == []
    assert _git(repo.checkout, "rev-parse", "HEAD") == repo.main_before
    # The judge's box and copy go; her worktree and her box stay.
    assert boxes.removed == [row["judge_id"]]
    assert _copies(repo) == [f"nova-{ID}"]
    assert repo.worktree.exists()
    assert row["finished_at"] is not None


async def test_c5_a_conflict_is_recorded_aborted_and_nothing_is_judged(pool, repo, suites, boxes):
    moved = repo.push_main({"services/core/app/x.py": "A = 3\n"})
    row = await _land(pool, repo)
    assert row["verdict"] == "conflict"
    assert row["conflict_files"] == ["services/core/app/x.py"]
    assert row["base_sha"] == moved
    assert row["reason"].startswith(f"rebasing onto origin/main ({moved}) conflicted in ")
    assert row["reason"].endswith("commit with change_commit and land again")
    assert row["merged_sha"] is None
    assert _git(repo.worktree, "rev-parse", "HEAD") == repo.sha
    assert not _rebase_in_progress(repo.worktree)
    assert suites.calls == []
    assert boxes.removed == []
    assert _copies(repo) == [f"nova-{ID}"]
    assert repo.gh_calls() == []
    assert repo.origin_ref("main") == moved


async def test_c5_a_green_landing_main_moved_under_is_not_merged_and_keeps_her_work(
    pool, repo, suites, boxes
):
    moved: list[str] = []
    suites.during = lambda: moved.append(repo.push_main({"other.txt": "raced\n"}, "raced"))
    row = await _land(pool, repo)
    assert row["verdict"] == "green"
    assert row["merged_sha"] is None
    assert "main moved during the landing; land again" in row["push_result"]
    assert repo.origin_ref("main") == moved[0]
    assert repo.worktree.exists()
    assert boxes.removed == [row["judge_id"]]
    assert _copies(repo) == [f"nova-{ID}"]


# -- C6: failures -------------------------------------------------------------------


async def test_c6_a_broken_suites_toml_on_main_is_could_not_measure(pool, repo, suites, boxes):
    repo.push_main({"deploy/devbox/suites.toml": "protected = [[[\n"})
    row = await _land(pool, repo)
    assert row["verdict"] == "could_not_measure"
    assert "suites.toml" in row["reason"]
    assert suites.calls == []
    assert boxes.removed == []
    assert repo.gh_calls() == []
    assert repo.worktree.exists()


async def test_c6_a_suites_toml_missing_on_main_is_could_not_measure(pool, repo, suites, boxes):
    moved = repo.push_main({"deploy/devbox/suites.toml": None})
    row = await _land(pool, repo)
    assert row["verdict"] == "could_not_measure"
    assert landing_git.SUITES_TOML in row["reason"]
    assert moved[:7] in row["reason"] or moved in row["reason"]
    assert suites.calls == []


async def test_c6_a_copy_make_copy_refuses_is_could_not_measure(pool, repo, suites, boxes):
    (repo.worktree / ".gitattributes").write_text("services/core/tests/** export-ignore\n")
    _commit(repo.worktree, "hide the tests", nova=True)
    row = await _land(pool, repo)
    assert row["verdict"] == "could_not_measure"
    assert ".gitattributes" in row["reason"] and "export-ignore" in row["reason"]
    assert suites.calls == []
    assert _copies(repo) == [f"nova-{ID}"]
    assert repo.gh_calls() == []


@pytest.mark.parametrize(
    "exc",
    [
        ToolFailure("Beelink is not connected"),
        ValueError("suite dir '../x' is not a clean path inside the copy"),
        RuntimeError("an unforeseen bug"),
    ],
    ids=["toolfailure", "valueerror", "runtimeerror"],
)
async def test_c6_run_suites_raising_is_could_not_measure_and_closed(
    pool, repo, suites, boxes, exc
):
    suites.raises = exc
    row = await _land(pool, repo)
    assert row["verdict"] == "could_not_measure"
    assert str(exc) in row["reason"]
    assert row["finished_at"] is not None
    assert boxes.removed == [row["judge_id"]]
    assert _copies(repo) == [f"nova-{ID}"]
    assert repo.worktree.exists()
    assert repo.origin_ref("main") == repo.main_before


async def test_c6_an_unexpected_exception_before_the_copy_is_could_not_measure(
    pool, repo, suites, boxes, monkeypatch
):
    async def broken(*a, **kw):
        raise RuntimeError("disk full")

    monkeypatch.setattr(landing_git, "prepare", broken)
    row = await _land(pool, repo)
    assert row["verdict"] == "could_not_measure"
    assert "disk full" in row["reason"]
    assert suites.calls == []
    assert boxes.removed == []
    assert repo.worktree.exists()


async def test_c6_a_failing_box_removal_is_appended_and_the_verdict_stands(
    pool, repo, suites, boxes
):
    old = "Beelink's agent predates box removal — update it with machine_update"
    boxes.words = {ID: old}
    row = await _land(pool, repo)
    assert row["verdict"] == "green"
    assert row["merged_sha"] == row["commit_sha"]
    assert old in row["reason"]
    assert ID in row["reason"]


async def test_c6_a_judge_box_left_behind_is_said(pool, repo, suites, boxes):
    class Words(dict):
        def get(self, key, default=None):
            return "Beelink: docker said no" if key != ID else ""

    boxes.words = Words()
    row = await _land(pool, repo)
    assert row["verdict"] == "green"
    assert "docker said no" in row["reason"]
    assert row["judge_id"] in row["reason"]


async def test_c6_a_worktree_holding_an_untracked_file_is_kept_and_said(pool, repo, suites, boxes):
    def stray():
        (repo.worktree / "notes.txt").write_text("hers\n")

    suites.during = stray
    row = await _land(pool, repo)
    assert row["verdict"] == "green"
    assert row["merged_sha"] == row["commit_sha"]
    assert repo.worktree.exists()
    assert (repo.worktree / "notes.txt").read_text() == "hers\n"
    assert "worktree" in row["reason"]
    assert str(repo.worktree) in row["reason"]


async def test_c6_a_failing_copy_removal_is_appended(pool, repo, suites, boxes, monkeypatch):
    async def refuse(run, *, checkout, judge):
        raise ToolFailure(f"removing the clean copy: nova-{judge} is still there after `rm -rf`")

    monkeypatch.setattr(landing_git, "remove_copy", refuse)
    row = await _land(pool, repo)
    assert row["verdict"] == "green"
    assert "still there after `rm -rf`" in row["reason"]


# -- C7: one at a time, and never left running -------------------------------------


async def test_c7_a_second_landing_waits_for_the_first(pool, repo, suites, boxes):
    worktree2 = repo.add_change(ID2, BRANCH2, {"services/core/app/y.py": "B = 1\n"})
    suites.gate = asyncio.Event()
    turn = await _turn(pool)
    first = await landings.insert(pool, change_id=ID, repo="nova", branch=BRANCH, turn_id=turn)
    second = await landings.insert(pool, change_id=ID2, repo="nova", branch=BRANCH2, turn_id=turn)
    common = dict(
        checkout=str(repo.checkout), main="main", host=HOST, turn_id=turn, run=RealRunner()
    )
    landing_run.start(
        pool, ROW, _ctx(turn), landing_id=first, change=ID, worktree=str(repo.worktree), **common
    )
    await asyncio.wait_for(suites.entered.wait(), 30)
    landing_run.start(
        pool, ROW, _ctx(turn), landing_id=second, change=ID2, worktree=str(worktree2), **common
    )
    for _ in range(50):
        stage = await pool.fetchval("SELECT stage FROM landings WHERE id = $1", second)
        if stage and "waiting" in stage:
            break
        await asyncio.sleep(0.05)
    assert "waiting" in stage and str(first) in stage
    assert len(suites.calls) == 1
    suites.gate.set()
    await asyncio.wait_for(landing_run.settle(), 60)
    a = await landings.get(pool, first)
    b = await landings.get(pool, second)
    assert a["verdict"] == b["verdict"] == "green"
    assert len(suites.calls) == 2
    # The second was rebased onto what the first put on main.
    assert b["base_sha"] == a["merged_sha"]
    assert repo.origin_ref("main") == b["merged_sha"]


async def test_c7_start_holds_the_task_until_it_ends(pool, repo, suites, boxes):
    turn = await _turn(pool)
    lid = await landings.insert(pool, change_id=ID, repo="nova", branch=BRANCH, turn_id=turn)
    task = landing_run.start(
        pool,
        ROW,
        _ctx(turn),
        landing_id=lid,
        change=ID,
        checkout=str(repo.checkout),
        worktree=str(repo.worktree),
        main="main",
        host=HOST,
        turn_id=turn,
        run=RealRunner(),
    )
    assert task in landing_run._TASKS
    await asyncio.wait_for(landing_run.settle(), 60)
    assert task.done() and task not in landing_run._TASKS
    assert (await landings.get(pool, lid))["verdict"] == "green"


async def test_c7_shutdown_cancels_landing_tasks(pool, repo, suites, boxes):
    suites.gate = asyncio.Event()
    turn = await _turn(pool)
    lid = await landings.insert(pool, change_id=ID, repo="nova", branch=BRANCH, turn_id=turn)
    task = landing_run.start(
        pool,
        ROW,
        _ctx(turn),
        landing_id=lid,
        change=ID,
        checkout=str(repo.checkout),
        worktree=str(repo.worktree),
        main="main",
        host=HOST,
        turn_id=turn,
        run=RealRunner(),
    )
    await asyncio.wait_for(suites.entered.wait(), 30)
    await asyncio.wait_for(landing_run.cancel_landings(), 10)
    assert task.cancelled()
    assert landing_run._TASKS == set()
    # No I/O while cancelled: the row is left for the next startup to close.
    assert (await landings.get(pool, lid))["verdict"] == "running"


async def test_c7_startup_marks_a_running_landing_could_not_measure(pool, monkeypatch):
    from app.browser import agent as browser_agent

    async def already_settled(pool_, app_):
        return True

    monkeypatch.setattr(browser_agent, "ensure_browser_agent", already_settled)
    lid = await landings.insert(pool, change_id=ID, repo="nova", branch=BRANCH, turn_id=None)
    async with lifespan(app):
        row = await landings.get(pool, lid)
        assert row["verdict"] == "could_not_measure"
        assert landings.INTERRUPTED in row["reason"]
        assert row["finished_at"] is not None


def test_c7_shutdown_cancels_landings_in_the_lifespan():
    """The lifespan's shutdown path cancels the landing tasks (a real
    shutdown cannot be driven here without tearing the pool down mid-test)."""
    import inspect

    from app import main

    source = inspect.getsource(main.lifespan)
    assert "landing_run.cancel_landings()" in source
    assert source.index("landings.mark_interrupted(") < source.index("yield")
    assert source.index("landing_run.cancel_landings()") > source.index("yield")
