"""S32.3 T2: change_commit — she commits her own worktree, on the host
(docs/plans/rebuild/s32/spec.md §5.1; nova-codes.md decision 6).

The box mounts the repository's .git read-only, so a commit happens on the
machine that holds the checkout, through its agent (shell.exec, argv only),
in the worktree DERIVED from the change id — never a path she passes. The
author is Nova, the trailers say which turn and which coder wrote it.

These tests run REAL git: the fake agent executes each shell.exec argv in a
temporary repository (a bare "origin" and a clone with one worktree of hers),
so what the commit holds is read back from git itself, never from the fake.

Criteria:
  C1 Every change in the worktree (modified, new, deleted) is committed in the
     worktree on the repo machine, through shell.exec argv-only git; the
     author AND committer are `Nova <nova@<NOVA_REPO_HOST>>` whatever the
     machine's own git identity is; a signing config on the machine never
     signs her commit (it is not the owner's) or blocks it; the checkout's
     own branch does not move.
  C2 The commit carries `Nova-Turn: <ctx.turn_id>` and `Nova-Coder:
     <ctx.coder>` trailers; no coder recorded -> `Nova-Coder: nova-loop (model
     not recorded)` and the result says so; no turn -> `Nova-Turn: not
     recorded`; a newline in the coder never forges a trailer, and a message
     carrying a Nova-Turn/Nova-Coder line is refused before anything is sent.
  C3 The result carries the full commit SHA and the commit's stat; a fact
     {"commit": {"device", "change", "sha", "files"}, "target": <worktree>}
     lands on facts_sink (no top-level "device" or "change" key).
  C4 Stated refusals, nothing committed: nothing to commit -> Error "nothing
     to commit in <worktree>"; a change id with no open worktree -> Error
     naming it and list_changes, no add or commit sent; a malformed change id
     is refused before anything is sent (schema.py reads no `pattern`, so
     the executor checks it); a blank message -> Error; a
     failing git commit (a hook) is an Error quoting git's words, no fact.
  C5 ToolContext.coder exists (None by default) and chat binds it per call:
     'nova-loop <provider:model that served the round>' for her turn,
     'nova-agent <agent id> <model>' for an agent's; a later judge call never
     replaces the round's model; no round -> the turn's model; nothing -> None.
  C6 The tool: change_commit, exactly {change: 6-hex, message: non-empty
     string} required with no extras, a write (not reads_only), not ephemeral.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from app import chat, tools, traces
from app.tools import changes
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice, FakeWSConn
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_devices_ws import _clean_hub, _close, _person  # noqa: F401
from tests.test_start_change import _connect

HOST = "mini-pc"
ID = "a1b2c3"
BRANCH = f"nova/{ID}-shortcuts"
TURN = uuid.UUID("0f0e0d0c-0b0a-0908-0706-050403020100")
CODER = "nova-loop ollama:qwen3:8b"
NOVA = f"Nova <nova@{HOST}>"


def _git(cwd: Path, *argv: str) -> str:
    done = subprocess.run(
        ["git", "-C", str(cwd), *argv], capture_output=True, text=True, check=True
    )
    return done.stdout.strip()


@dataclass
class Repo:
    root: Path
    checkout: Path
    worktree: Path

    def head(self, where: Path | None = None) -> str:
        return _git(where or self.worktree, "rev-parse", "HEAD")

    def show(self, fmt: str) -> str:
        return _git(self.worktree, "log", "-1", f"--format={fmt}")


@pytest.fixture
def repo(tmp_path, monkeypatch) -> Repo:
    """A bare origin, a clone of it (the checkout NOVA_CHECKOUT names) and one
    worktree of hers at .worktrees/nova-<ID> on nova/<ID>-shortcuts. The
    machine's own git identity is the owner's, and it is set to sign every
    commit with a program that always fails."""
    gitconfig = tmp_path / "gitconfig"
    gitconfig.write_text(
        "[user]\n\tname = Owner\n\temail = owner@example.com\n"
        "[init]\n\tdefaultBranch = main\n"
        "[commit]\n\tgpgsign = true\n"
        "[gpg]\n\tprogram = false\n"
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
    (checkout / "a.txt").write_text("one\ntwo\n")
    _git(checkout, "add", "-A")
    _git(checkout, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init")
    _git(checkout, "push", "-q", "origin", "main")
    worktree = checkout / ".worktrees" / f"nova-{ID}"
    _git(checkout, "worktree", "add", "-q", "-b", BRANCH, str(worktree), "main")
    monkeypatch.setenv("NOVA_CHECKOUT", str(checkout))
    monkeypatch.setenv("NOVA_REPO_HOST", HOST)
    monkeypatch.setenv("NOVA_REPO_BRANCH", "main")
    return Repo(root=tmp_path, checkout=checkout, worktree=worktree)


@pytest.fixture
def registered(monkeypatch):
    """change_commit in the registry for dispatch (T13 registers it for real
    and moves the pins)."""
    monkeypatch.setitem(tools.REGISTRY, changes.CHANGE_COMMIT, changes.CHANGE_COMMIT_TOOL)


@dataclass
class RealGitAgent:
    """Runs every shell.exec argv for real, in no shell, and answers like the
    agent does (output = stdout + stderr, the exit code). Any other
    capability is an unknown one."""

    seen: list[dict] = field(default_factory=list)

    async def answer(self, envelope: dict) -> dict:
        self.seen.append(envelope)
        if envelope["capability"] != "shell.exec":
            return {"ok": False, "output": "", "exit_code": None, "error": "unknown capability"}
        argv = envelope["args"]["argv"]
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=dict(os.environ),
        )
        out, _ = await proc.communicate()
        return {"ok": True, "output": out.decode(), "exit_code": proc.returncode, "error": None}

    def argvs(self) -> list[list[str]]:
        return [e["args"]["argv"] for e in self.seen if e["capability"] == "shell.exec"]

    def ran(self, word: str) -> bool:
        return any(word in argv for argv in self.argvs())


async def _serve(conn: FakeWSConn, device: FakeDevice, agent: RealGitAgent) -> None:
    while True:
        frame = await conn.next_sent()
        if not isinstance(frame, dict) or frame.get("type") != "command":
            continue
        conn.feed(device.result(frame["envelope"], **await agent.answer(frame["envelope"])))


def _ctx(person, facts, *, turn_id=TURN, coder=CODER) -> ToolContext:
    return ToolContext(
        app=None,
        person=person,
        workspace_root=Path("/tmp"),
        facts_sink=facts,
        turn_id=turn_id,
        coder=coder,
    )


async def _commit(pool, args: dict, **ctx_kw):
    """Dispatch change_commit while a real-git agent answers; returns
    (result, ok, facts, agent)."""
    device, conn, task = await _connect(pool)
    agent = RealGitAgent()
    person = await _person(pool)
    facts: list[dict] = []
    server = asyncio.create_task(_serve(conn, device, agent))
    try:
        result, ok = await asyncio.wait_for(
            tools.dispatch(changes.CHANGE_COMMIT, args, _ctx(person, facts, **ctx_kw)), 20
        )
    finally:
        server.cancel()
        await _close(conn, task)
    return result, ok, facts, agent


def _edit(repo: Repo) -> None:
    (repo.worktree / "a.txt").write_text("one\ntwo\nthree\n")
    (repo.worktree / "new.txt").write_text("fresh\n")
    (repo.worktree / "README.md").unlink()


def _trailers(repo: Repo, key: str) -> list[str]:
    raw = repo.show(f"%(trailers:key={key},valueonly,separator=%x00)")
    return [value for value in raw.split("\x00") if value]


# -- C1: every change, on the host, as Nova, never signed --------------------------


@requires_db
async def test_c1_every_change_in_the_worktree_is_committed_through_argv_git(
    pool, repo, registered
):
    before_main = repo.head(repo.checkout)
    base = repo.head()
    _edit(repo)
    result, ok, _facts, agent = await _commit(pool, {"change": ID, "message": "Add three"})
    assert ok is True, result
    assert repo.head() != base
    assert _git(repo.worktree, "rev-parse", "HEAD~1") == base
    changed = _git(repo.worktree, "show", "--name-status", "--format=", "HEAD")
    assert sorted(changed.splitlines()) == ["A\tnew.txt", "D\tREADME.md", "M\ta.txt"]
    assert _git(repo.worktree, "status", "--porcelain") == ""
    assert repo.show("%s") == "Add three"
    # The checkout's own branch never moved: the commit is on her branch only.
    assert repo.head(repo.checkout) == before_main
    assert _git(repo.worktree, "rev-parse", "--abbrev-ref", "HEAD") == BRANCH
    # argv-only git through shell.exec, nothing else asked of the agent.
    assert {e["capability"] for e in agent.seen} == {"shell.exec"}
    assert all(argv[0] == "git" for argv in agent.argvs())
    commits = [argv for argv in agent.argvs() if "commit" in argv]
    assert len(commits) == 1
    assert commits[0][:3] == ["git", "-C", str(repo.worktree)]


@requires_db
async def test_c1_author_and_committer_are_nova_at_the_repo_host(pool, repo, registered):
    _edit(repo)
    result, ok, _facts, _agent = await _commit(pool, {"change": ID, "message": "Add three"})
    assert ok is True, result
    assert repo.show("%an <%ae>") == NOVA
    assert repo.show("%cn <%ce>") == NOVA


@requires_db
async def test_c1_an_author_in_the_agents_environment_never_replaces_nova(
    pool, repo, registered, monkeypatch
):
    # GIT_AUTHOR_* in the agent's environment outranks user.* config; the
    # explicit --author outranks it.
    monkeypatch.setenv("GIT_AUTHOR_NAME", "Owner Env")
    monkeypatch.setenv("GIT_AUTHOR_EMAIL", "owner-env@example.com")
    _edit(repo)
    result, ok, _facts, _agent = await _commit(pool, {"change": ID, "message": "Add three"})
    assert ok is True, result
    assert repo.show("%an <%ae>") == NOVA


@requires_db
async def test_c1_the_machines_signing_config_never_signs_or_blocks_her_commit(
    pool, repo, registered
):
    # The fixture's global config says gpgsign = true with a program that
    # always fails: honouring it would fail the commit (and would sign Nova's
    # work with the owner's key if it did not).
    _edit(repo)
    result, ok, _facts, _agent = await _commit(pool, {"change": ID, "message": "Add three"})
    assert ok is True, result
    assert repo.show("%G?") == "N"


# -- C2: the trailers ---------------------------------------------------------------


@requires_db
async def test_c2_the_trailers_name_the_turn_and_the_coder(pool, repo, registered):
    _edit(repo)
    result, ok, _facts, _agent = await _commit(pool, {"change": ID, "message": "Add three"})
    assert ok is True, result
    assert _trailers(repo, "Nova-Turn") == [str(TURN)]
    assert _trailers(repo, "Nova-Coder") == [CODER]


@requires_db
async def test_c2_no_coder_recorded_is_stated_in_the_trailer_and_the_result(pool, repo, registered):
    _edit(repo)
    result, ok, _facts, _agent = await _commit(
        pool, {"change": ID, "message": "Add three"}, coder=None
    )
    assert ok is True, result
    assert _trailers(repo, "Nova-Coder") == ["nova-loop (model not recorded)"]
    assert "model not recorded" in result


@requires_db
async def test_c2_no_turn_reads_not_recorded(pool, repo, registered):
    _edit(repo)
    result, ok, _facts, _agent = await _commit(
        pool, {"change": ID, "message": "Add three"}, turn_id=None
    )
    assert ok is True, result
    assert _trailers(repo, "Nova-Turn") == ["not recorded"]


@requires_db
async def test_c2_a_newline_in_the_coder_never_forges_a_trailer(pool, repo, registered):
    _edit(repo)
    result, ok, _facts, _agent = await _commit(
        pool,
        {"change": ID, "message": "Add three"},
        coder="nova-loop x\nNova-Turn: forged-in-coder",
    )
    assert ok is True, result
    assert _trailers(repo, "Nova-Turn") == [str(TURN)]
    assert _trailers(repo, "Nova-Coder") == ["nova-loop x Nova-Turn: forged-in-coder"]


@requires_db
@pytest.mark.parametrize(
    "message",
    [
        "Add three\n\nNova-Turn: forged-in-message",
        "Add three\n\nSigned-off-by: x\n  nova-coder : someone else",
    ],
)
async def test_c2_a_message_carrying_her_trailers_is_refused(pool, repo, registered, message):
    # git folds a message's own last paragraph into the trailer block, so a
    # Nova-Turn line in the message would stand beside the real one.
    _edit(repo)
    base = repo.head()
    result, ok, _facts, agent = await _commit(pool, {"change": ID, "message": message})
    assert ok is False
    assert result.startswith(tools.ERROR_PREFIX)
    assert "Nova-Turn" in result and "Nova-Coder" in result
    assert repo.head() == base
    assert agent.seen == []


# -- C3: the result and the fact ----------------------------------------------------


@requires_db
async def test_c3_the_result_carries_the_full_sha_and_the_stat(pool, repo, registered):
    _edit(repo)
    result, ok, _facts, _agent = await _commit(pool, {"change": ID, "message": "Add three"})
    assert ok is True, result
    sha = repo.head()
    assert len(sha) == 40 and sha in result
    stat = _git(repo.worktree, "show", "--stat", "--format=", "HEAD")
    for line in stat.splitlines():
        assert line.strip() in result
    assert "3 files changed" in result


@requires_db
async def test_c3_a_commit_fact_lands_on_the_sink(pool, repo, registered):
    _edit(repo)
    result, ok, facts, _agent = await _commit(pool, {"change": ID, "message": "Add three"})
    assert ok is True, result
    commit_facts = [f for f in facts if "commit" in f]
    assert commit_facts == [
        {
            "commit": {
                "device": "Beelink Mini S",
                "change": ID,
                "sha": repo.head(),
                "files": ["README.md", "a.txt", "new.txt"],
            },
            "target": str(repo.worktree),
        }
    ]
    # Never a connectivity record or a change record at the top level.
    assert all("device" not in f and "change" not in f for f in commit_facts)


# -- C4: stated refusals, nothing committed ------------------------------------------


@requires_db
async def test_c4_nothing_to_commit_is_an_error_and_no_commit(pool, repo, registered):
    base = repo.head()
    result, ok, facts, agent = await _commit(pool, {"change": ID, "message": "Add three"})
    assert ok is False
    assert result.startswith(tools.ERROR_PREFIX)
    assert f"nothing to commit in {repo.worktree}" in result
    assert repo.head() == base
    assert not agent.ran("commit") and not agent.ran("add")
    assert not [f for f in facts if "commit" in f]


@requires_db
async def test_c4_a_change_with_no_open_worktree_is_named(pool, repo, registered):
    _edit(repo)
    base = repo.head()
    result, ok, _facts, agent = await _commit(pool, {"change": "ffffff", "message": "x"})
    assert ok is False
    assert result.startswith(tools.ERROR_PREFIX)
    assert "ffffff" in result and "list_changes" in result
    assert not agent.ran("commit") and not agent.ran("add") and not agent.ran("status")
    assert repo.head() == base


@requires_db
@pytest.mark.parametrize("change", ["../x", "A1B2C3", "a1b2c", "a1b2c3d", "a1b2c3/../.."])
async def test_c4_a_malformed_change_is_refused_with_nothing_sent(pool, repo, registered, change):
    _edit(repo)
    result, ok, _facts, agent = await _commit(pool, {"change": change, "message": "x"})
    assert ok is False
    assert result.startswith(tools.ERROR_PREFIX)
    assert agent.seen == []


@requires_db
@pytest.mark.parametrize("message", [" ", "\n\t ", ""])
async def test_c4_a_blank_message_is_refused(pool, repo, registered, message):
    _edit(repo)
    base = repo.head()
    result, ok, _facts, agent = await _commit(pool, {"change": ID, "message": message})
    assert ok is False
    assert result.startswith(tools.ERROR_PREFIX)
    assert repo.head() == base
    assert not agent.ran("commit")


@requires_db
async def test_c4_a_failing_commit_quotes_git_and_files_no_fact(pool, repo, registered):
    hook = repo.checkout / ".git" / "hooks" / "pre-commit"
    hook.write_text("#!/bin/sh\necho 'hook says no: lint failed' >&2\nexit 1\n")
    hook.chmod(0o755)
    _edit(repo)
    base = repo.head()
    result, ok, facts, _agent = await _commit(pool, {"change": ID, "message": "Add three"})
    assert ok is False
    assert result.startswith(tools.ERROR_PREFIX)
    assert "hook says no: lint failed" in result and "exited 1" in result
    assert repo.head() == base
    assert not [f for f in facts if "commit" in f]


# -- C5: the coder on the context, bound by chat --------------------------------------


def test_c5_tool_context_coder_defaults_to_none(tmp_path):
    ctx = ToolContext(app=None, person=None, workspace_root=tmp_path)
    assert ctx.coder is None


def _round(turn: traces.Turn, *, served_by: str | None, model: str = "chat-pick") -> None:
    with turn.span("llm_call", model) as span:
        span.meta["model"] = model
        span.meta["round"] = 1
        span.meta["purpose"] = "chat"
        if served_by is not None:
            span.meta["served_by"] = served_by


def _turn(model: str | None = "pick", agent_id=None) -> traces.Turn:
    from datetime import UTC, datetime

    return traces.Turn(
        id=uuid.uuid4(), started_at=datetime.now(UTC), model=model, agent_id=agent_id
    )


def test_c5_the_coder_is_the_model_that_served_the_round():
    turn = _turn()
    _round(turn, served_by="ollama:qwen3:8b")
    _round(turn, served_by="openrouter:google/gemini-2.5-pro")
    assert chat._coder_of(turn) == "nova-loop openrouter:google/gemini-2.5-pro"


def test_c5_a_later_judge_call_never_replaces_the_rounds_model():
    turn = _turn()
    _round(turn, served_by="ollama:qwen3:8b")
    with turn.span("llm_call", "judge-model") as span:
        span.meta["model"] = "judge-model"
        span.meta["purpose"] = "judge"
        span.meta["served_by"] = "openrouter:judge"
    assert chat._coder_of(turn) == "nova-loop ollama:qwen3:8b"


def test_c5_without_served_by_the_round_asked_model_then_the_turns_model():
    turn = _turn(model="the-pick")
    _round(turn, served_by=None, model="asked-model")
    assert chat._coder_of(turn) == "nova-loop asked-model"
    bare = _turn(model="the-pick")
    assert chat._coder_of(bare) == "nova-loop the-pick"
    assert chat._coder_of(_turn(model=None)) is None
    assert chat._coder_of(_turn(model="")) is None


def test_c5_an_agent_turn_names_the_agent():
    agent_id = uuid.uuid4()
    turn = _turn(agent_id=agent_id)
    _round(turn, served_by="ollama:qwen3:8b")
    assert chat._coder_of(turn) == f"nova-agent {agent_id} ollama:qwen3:8b"


SCHEMA = {"type": "object", "properties": {}, "additionalProperties": False}


def _spy(monkeypatch, name: str = "fake_coder_spy") -> list:
    seen: list = []

    async def spy(args: dict, ctx: ToolContext) -> str:
        seen.append(ctx.coder)
        return "seen"

    monkeypatch.setitem(
        tools.REGISTRY,
        name,
        Tool(name=name, description="d", parameters=SCHEMA, executor=spy, reads_only=True),
    )
    return seen


def _call(call_id: str, name: str) -> dict:
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps({})},
                        }
                    ]
                }
            }
        ]
    }


def _text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


@requires_db
async def test_c5_a_chat_turn_hands_its_tools_the_coder_that_served_it(
    owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "ws"))
    seen = _spy(monkeypatch)
    gateway = ScriptedGateway(
        rounds=((_call("c1", "fake_coder_spy"),), (_text("done"),)),
        served_by="openrouter:anthropic/claude-x",
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "look"})
    assert resp.status_code == 200, resp.text
    assert seen == ["nova-loop openrouter:anthropic/claude-x"]


# -- C6: the tool --------------------------------------------------------------------


def test_c6_the_tool_definition():
    tool = changes.CHANGE_COMMIT_TOOL
    assert tool.name == changes.CHANGE_COMMIT == "change_commit"
    assert tool.executor is changes.change_commit
    assert tool.reads_only is False
    assert tool.ephemeral is False
    params = tool.parameters
    assert params["required"] == ["change", "message"]
    assert params["additionalProperties"] is False
    assert set(params["properties"]) == {"change", "message"}
    assert params["properties"]["change"]["pattern"] == "^[0-9a-f]{6}$"
    assert params["properties"]["message"]["minLength"] == 1
    words = tool.description.lower()
    assert "commit" in words and "nova-turn" in words and "repo_land" in words
