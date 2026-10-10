"""T5 (worktrees epic, 2026-10-08): start_change — a change of hers starts in
its own git worktree (docs/plans/rebuild/nova-codes.md "S32 — A worktree per
change": branch nova/<id>-<slug>, worktree <repo>/.worktrees/nova-<id>, the
tool returns AGENTS.md from that worktree; several can be open at once).

The incident it answers (turn 91ecef9a-cd7b-4e15-b8e1-ab478954b9a9): she made a
branch IN the owner's live deploy checkout and the next ./install deployed her
WIP. start_change runs git THROUGH the repo machine's own agent (shell.exec,
argv only — core's container has no checkout), on the machine ./install
recorded (NOVA_REPO_HOST) at the path it recorded (NOVA_CHECKOUT).

Criteria:
  C1 Stated cannots before any git runs: no repo recorded (NOVA_CHECKOUT or
     NOVA_REPO_HOST unset) names ./install; the repo machine paired but not
     connected says so; no device / several devices with that hostname name
     what is paired. Each is an Error result with ZERO command frames sent.
  C2 Fetch first, then branch off origin/<base>: base is NOVA_REPO_BRANCH when
     recorded, else the machine's `git -C <repo> symbolic-ref --short
     refs/remotes/origin/HEAD`; `git -C <repo> fetch origin <base>` is sent
     BEFORE `git -C <repo> worktree add -b nova/<id>-<slug>
     <repo>/.worktrees/nova-<id> origin/<base>` (exact argv); every command is
     argv-only git (no shell), and AGENTS.md is read by fs.read from the new
     worktree.
  C3 The id is derived so two changes never collide: new_id() is 6 lowercase
     hex; an id already used by a .worktrees/nova-<id> or a nova/<id>-* branch
     on the machine is never used; two changes with the same title get two
     worktrees. slug(title) is [a-z0-9-] runs joined by "-", <= 40, never
     empty ("change").
  C4 The result is the facts a coder needs: the worktree path, the branch, the
     base branch and its commit (`git -C <wt> rev-parse HEAD`), "run every
     command with cwd <wt>", then AGENTS.md's text — ok=True. The fact
     {"change": id, "worktree_path": wt, "branch": b} lands on facts_sink (no
     "device" key: that is a connectivity record), it reaches the span's
     meta.facts through chat._run_tool, and start_change's own git never
     raises the outside_worktree flag.
  C5 Never a fake success: any nonzero git exit or agent ok:false is an Error
     result quoting git's / the agent's words, and nothing after it is sent
     (no worktree add after a failed fetch); a step failing AFTER the worktree
     exists says the worktree exists and names its path and branch.
  C6 Registered: start_change is in tools.REGISTRY, takes exactly {"title":
     string} (required, no extras), is neither reads_only nor ephemeral, and
     its description says it makes a worktree and to use its cwd.
     (test_tools_registry's pins moved with it, deliberately.)
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

import pytest

from app import chat, devices, devices_ws, tools, traces
from app.tools import changes
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice, FakeWSConn
from tests.test_devices_ws import _clean_hub, _close, _ctx, _person  # noqa: F401

REPO = "/home/jeremy/workspace/nova"
HOST = "mini-pc"
SHA = "0123456789abcdef0123456789abcdef01234567"
AGENTS = "# Nova v4\n\n## When you change code\n\nWork only in your worktree.\n"
TITLE = "Add keyboard shortcuts"
ID = "a1b2c3"
WT = f"{REPO}/.worktrees/nova-{ID}"
BRANCH = f"nova/{ID}-add-keyboard-shortcuts"


@pytest.fixture
def recorded(monkeypatch):
    monkeypatch.setenv("NOVA_CHECKOUT", REPO)
    monkeypatch.setenv("NOVA_REPO_HOST", HOST)
    monkeypatch.setenv("NOVA_REPO_BRANCH", "main")


@pytest.fixture
def fixed_id(monkeypatch):
    monkeypatch.setattr(changes, "new_id", lambda: ID)


# -- a fake machine that holds the checkout ------------------------------------


@dataclass
class FakeRepo:
    """Answers start_change's git the way the hub's checkout would. `fail`
    maps a step ("symbolic-ref", "fetch", "add", "rev-parse", "agents") to
    (exit_code, output) — or to "agent" for an agent-level ok:false."""

    origin_head: str = "origin/main"
    worktrees: list[str] = field(default_factory=list)  # existing paths
    branches: list[str] = field(default_factory=list)  # existing short names
    fail: dict = field(default_factory=dict)
    seen: list[dict] = field(default_factory=list)  # every envelope, in order

    def _step(self, envelope: dict) -> str:
        if envelope["capability"] == "fs.read":
            return "agents"
        argv = envelope["args"].get("argv") or []
        words = argv[3:] if argv[:2] == ["git", "-C"] else argv[1:]
        if words[:1] == ["symbolic-ref"]:
            return "symbolic-ref"
        if words[:1] == ["fetch"]:
            return "fetch"
        if words[:2] == ["worktree", "add"]:
            return "add"
        if words[:2] == ["worktree", "list"]:
            return "worktree-list"
        if words[:1] in (["branch"], ["for-each-ref"], ["show-ref"]):
            return "branch-list"
        if words[:2] == ["rev-parse", "HEAD"]:
            return "rev-parse"
        return "other"

    def answer(self, envelope: dict) -> dict:
        self.seen.append(envelope)
        step = self._step(envelope)
        failing = self.fail.get(step)
        if failing == "agent":
            return {"ok": False, "output": "", "exit_code": None, "error": "command timed out"}
        if failing is not None:
            code, output = failing
            return {"ok": True, "output": output, "exit_code": code, "error": None}
        if step == "agents":
            return {"ok": True, "output": AGENTS, "exit_code": 0, "error": None}
        if step == "symbolic-ref":
            return {"ok": True, "output": self.origin_head + "\n", "exit_code": 0, "error": None}
        if step == "worktree-list":
            out = f"worktree {REPO}\nHEAD {SHA}\nbranch refs/heads/main\n\n"
            for path in self.worktrees:
                out += f"worktree {path}\nHEAD {SHA}\nbranch refs/heads/x\n\n"
            return {"ok": True, "output": out, "exit_code": 0, "error": None}
        if step == "branch-list":
            out = "".join(f"{b}\n" for b in self.branches)
            return {"ok": True, "output": out, "exit_code": 0, "error": None}
        if step == "add":
            argv = envelope["args"]["argv"]
            path = argv[argv.index("-b") + 2]
            if path in self.worktrees:
                return {
                    "ok": True,
                    "output": f"fatal: '{path}' already exists",
                    "exit_code": 128,
                    "error": None,
                }
            self.worktrees.append(path)
            self.branches.append(argv[argv.index("-b") + 1])
            return {
                "ok": True,
                "output": "Preparing worktree (new branch)",
                "exit_code": 0,
                "error": None,
            }
        if step == "rev-parse":
            return {"ok": True, "output": SHA + "\n", "exit_code": 0, "error": None}
        return {"ok": True, "output": "", "exit_code": 0, "error": None}

    def argvs(self) -> list[list[str]]:
        return [e["args"]["argv"] for e in self.seen if e["capability"] == "shell.exec"]

    def steps(self) -> list[str]:
        return [self._step(e) for e in self.seen]


async def _enroll(pool, *, name: str, hostname: str):
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
    return device, uuid.UUID(enrolled["device_id"])


async def _connect(pool, *, name: str = "Beelink Mini S", hostname: str = HOST):
    device, device_id = await _enroll(pool, name=name, hostname=hostname)
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    challenge = await asyncio.wait_for(conn.next_sent(), 2)
    conn.feed(
        {"type": "auth", "device_id": str(device_id), "sig": device.sign_nonce(challenge["nonce"])}
    )
    ready = await asyncio.wait_for(conn.next_sent(), 2)
    assert ready["type"] == "ready"
    return device, conn, task


async def _serve(conn: FakeWSConn, device: FakeDevice, repo: FakeRepo) -> None:
    while True:
        frame = await conn.next_sent()
        if not isinstance(frame, dict) or frame.get("type") != "command":
            continue
        answer = repo.answer(frame["envelope"])
        conn.feed(device.result(frame["envelope"], **answer))


async def _start(pool, conn, device, repo: FakeRepo, args: dict | None = None):
    """Dispatch start_change while the fake machine answers; returns
    (result, ok, facts)."""
    person = await _person(pool)
    facts: list[dict] = []
    server = asyncio.create_task(_serve(conn, device, repo))
    try:
        result, ok = await asyncio.wait_for(
            tools.dispatch("start_change", args or {"title": TITLE}, _ctx(person, facts=facts)),
            10,
        )
    finally:
        server.cancel()
    return result, ok, facts


def _change_facts(facts: list[dict]) -> list[dict]:
    return [f for f in facts if "change" in f]


# -- C1: stated cannots, nothing sent --------------------------------------------


@requires_db
@pytest.mark.parametrize("unset", ["NOVA_CHECKOUT", "NOVA_REPO_HOST"])
async def test_c1_nothing_recorded_is_a_cannot_naming_install(pool, recorded, monkeypatch, unset):
    monkeypatch.delenv(unset)
    device, conn, task = await _connect(pool)
    repo = FakeRepo()
    result, ok, _facts = await _start(pool, conn, device, repo)
    assert ok is False
    assert result.startswith(tools.ERROR_PREFIX)
    assert "cannot" in result and unset in result and "./install" in result
    assert repo.seen == []
    await _close(conn, task)


@requires_db
async def test_c1_the_repo_machine_offline_is_stated_and_nothing_is_sent(pool, recorded):
    await _enroll(pool, name="Beelink Mini S", hostname=HOST)  # paired, never connected
    person = await _person(pool)
    result, ok = await tools.dispatch("start_change", {"title": TITLE}, _ctx(person, facts=[]))
    assert ok is False
    assert result.startswith(tools.ERROR_PREFIX)
    assert "Beelink Mini S" in result and "not connected" in result


@requires_db
async def test_c1_no_device_with_that_hostname_names_what_is_paired(pool, recorded):
    device, conn, task = await _connect(pool, name="Dell", hostname="DELL-XPS-8950")
    repo = FakeRepo()
    result, ok, _facts = await _start(pool, conn, device, repo)
    assert ok is False
    assert "cannot" in result and HOST in result and "DELL-XPS-8950" in result
    assert repo.seen == []
    await _close(conn, task)


@requires_db
async def test_c1_a_shared_hostname_is_a_cannot_never_a_pick(pool, recorded):
    await _enroll(pool, name="Old Beelink", hostname=HOST)
    device, conn, task = await _connect(pool, name="Beelink Mini S", hostname=HOST)
    repo = FakeRepo()
    result, ok, _facts = await _start(pool, conn, device, repo)
    assert ok is False
    assert "cannot" in result and "Old Beelink" in result and "Beelink Mini S" in result
    assert repo.seen == []
    await _close(conn, task)


# -- C2: fetch first, branch off origin/<base>, argv-only git ----------------------


@requires_db
async def test_c2_fetch_is_sent_before_the_exact_worktree_add(pool, recorded, fixed_id):
    device, conn, task = await _connect(pool)
    repo = FakeRepo()
    _result, ok, _facts = await _start(pool, conn, device, repo)
    assert ok is True
    argvs = repo.argvs()
    fetch = ["git", "-C", REPO, "fetch", "origin", "main"]
    add = ["git", "-C", REPO, "worktree", "add", "-b", BRANCH, WT, "origin/main"]
    assert fetch in argvs and add in argvs
    assert argvs.index(fetch) < argvs.index(add)
    await _close(conn, task)


@requires_db
async def test_c2_a_recorded_branch_is_the_base_without_asking_origin_head(
    pool, recorded, fixed_id
):
    device, conn, task = await _connect(pool)
    repo = FakeRepo(origin_head="origin/trunk")
    _result, ok, _facts = await _start(pool, conn, device, repo)
    assert ok is True
    assert "symbolic-ref" not in repo.steps()
    assert ["git", "-C", REPO, "fetch", "origin", "main"] in repo.argvs()
    await _close(conn, task)


@requires_db
async def test_c2_without_a_recorded_branch_the_base_is_origin_head(
    pool, recorded, fixed_id, monkeypatch
):
    monkeypatch.delenv("NOVA_REPO_BRANCH")
    device, conn, task = await _connect(pool)
    repo = FakeRepo(origin_head="origin/trunk")
    result, ok, _facts = await _start(pool, conn, device, repo)
    assert ok is True
    argvs = repo.argvs()
    symref = ["git", "-C", REPO, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]
    fetch = ["git", "-C", REPO, "fetch", "origin", "trunk"]
    add = ["git", "-C", REPO, "worktree", "add", "-b", BRANCH, WT, "origin/trunk"]
    assert argvs.index(symref) < argvs.index(fetch) < argvs.index(add)
    assert "trunk" in result
    await _close(conn, task)


@requires_db
async def test_c2_every_command_is_argv_only_git_and_agents_md_comes_from_the_worktree(
    pool, recorded, fixed_id
):
    device, conn, task = await _connect(pool)
    repo = FakeRepo()
    _result, ok, _facts = await _start(pool, conn, device, repo)
    assert ok is True
    assert {e["capability"] for e in repo.seen} == {"shell.exec", "fs.read"}
    for argv in repo.argvs():
        assert argv[0] == "git", argv
        assert not any(word in ("sh", "bash", "-c") for word in argv), argv
    reads = [e["args"]["path"] for e in repo.seen if e["capability"] == "fs.read"]
    assert reads == [f"{WT}/AGENTS.md"]
    await _close(conn, task)


@requires_db
async def test_c2_a_recorded_branch_git_would_read_as_an_option_is_a_cannot_and_sends_nothing(
    pool, recorded, fixed_id, monkeypatch
):
    # argv-only is not enough on its own: a base starting with "-" reaches git
    # as an OPTION (`git fetch origin --upload-pack=...`). The recorded value
    # is shape-checked before any frame is sent.
    monkeypatch.setenv("NOVA_REPO_BRANCH", "--upload-pack=touch /tmp/x")
    device, conn, task = await _connect(pool)
    repo = FakeRepo()
    result, ok, facts = await _start(pool, conn, device, repo)
    assert ok is False
    assert result.startswith(tools.ERROR_PREFIX)
    assert "NOVA_REPO_BRANCH" in result
    assert repo.seen == []
    assert _change_facts(facts) == []
    await _close(conn, task)


@requires_db
@pytest.mark.parametrize("head", ["origin/--upload-pack=x", "upstream/main", "origin/a..b"])
async def test_c2_an_origin_head_that_is_not_a_branch_of_origin_fetches_nothing(
    pool, recorded, fixed_id, monkeypatch, head
):
    monkeypatch.delenv("NOVA_REPO_BRANCH")
    device, conn, task = await _connect(pool)
    repo = FakeRepo(origin_head=head)
    result, ok, _facts = await _start(pool, conn, device, repo)
    assert ok is False
    assert head in result
    assert repo.steps() == ["symbolic-ref"]
    await _close(conn, task)


# -- C3: ids never collide; slugs ----------------------------------------------------


def test_c3_new_id_is_six_lowercase_hex_and_varies():
    ids = [changes.new_id() for _ in range(200)]
    for value in ids:
        assert re.fullmatch(r"[0-9a-f]{6}", value), value
    assert len(set(ids)) >= 190


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("Add keyboard shortcuts", "add-keyboard-shortcuts"),
        ("Fix: the WS/hub reconnect!!", "fix-the-ws-hub-reconnect"),
        ("  --Spaces   and---dashes--  ", "spaces-and-dashes"),
        ("v4 README", "v4-readme"),
        ("", "change"),
        ("!!!", "change"),
        ("日本語", "change"),
    ],
)
def test_c3_slug_of_a_title(title, expected):
    assert changes.slug(title) == expected


def test_c3_a_long_slug_is_at_most_forty_and_never_ends_in_a_dash():
    value = changes.slug("word " * 30 + "x")
    assert len(value) <= 40
    assert re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", value), value


@requires_db
async def test_c3_an_id_already_used_on_the_machine_is_never_used(pool, recorded, monkeypatch):
    candidates = iter(["aaaaaa", "bbbbbb", "cccccc"])
    monkeypatch.setattr(changes, "new_id", lambda: next(candidates))
    device, conn, task = await _connect(pool)
    repo = FakeRepo(
        worktrees=[f"{REPO}/.worktrees/nova-aaaaaa"],
        branches=["main", "nova/bbbbbb-older-change"],
    )
    result, ok, _facts = await _start(pool, conn, device, repo)
    assert ok is True
    (add,) = [a for a in repo.argvs() if a[3:5] == ["worktree", "add"]]
    assert add[add.index("-b") + 1] == "nova/cccccc-add-keyboard-shortcuts"
    assert add[add.index("-b") + 2] == f"{REPO}/.worktrees/nova-cccccc"
    assert f"{REPO}/.worktrees/nova-cccccc" in result
    await _close(conn, task)


@requires_db
async def test_c3_two_changes_with_the_same_title_get_two_worktrees(pool, recorded):
    device, conn, task = await _connect(pool)
    repo = FakeRepo()
    first, ok1, _ = await _start(pool, conn, device, repo)
    second, ok2, _ = await _start(pool, conn, device, repo)
    assert ok1 is True and ok2 is True
    adds = [a for a in repo.argvs() if a[3:5] == ["worktree", "add"]]
    paths = [a[a.index("-b") + 2] for a in adds]
    assert len(paths) == 2 and paths[0] != paths[1]
    for path in paths:
        assert re.fullmatch(re.escape(REPO) + r"/\.worktrees/nova-[0-9a-f]{6}", path), path
    await _close(conn, task)


# -- C4: the result and the fact ---------------------------------------------------


@requires_db
async def test_c4_the_result_names_path_branch_base_commit_cwd_and_agents_md(
    pool, recorded, fixed_id
):
    device, conn, task = await _connect(pool)
    repo = FakeRepo()
    result, ok, _facts = await _start(pool, conn, device, repo)
    assert ok is True
    assert not result.startswith(tools.ERROR_PREFIX)
    for part in (WT, BRANCH, "origin/main", SHA, f"cwd {WT}"):
        assert part in result, part
    assert result.rstrip().endswith(AGENTS.rstrip())
    await _close(conn, task)


@requires_db
async def test_c4_the_change_fact_and_no_outside_flag(pool, recorded, fixed_id):
    device, conn, task = await _connect(pool)
    repo = FakeRepo()
    _result, ok, facts = await _start(pool, conn, device, repo)
    assert ok is True
    assert _change_facts(facts) == [{"change": ID, "worktree_path": WT, "branch": BRANCH}]
    assert not [f for f in facts if "outside_worktree" in f]
    await _close(conn, task)


@requires_db
async def test_c4_the_change_fact_reaches_the_span(pool, recorded, fixed_id):
    device, conn, task = await _connect(pool)
    repo = FakeRepo()
    person = await _person(pool)
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    ctx = _ctx(person, facts=[])
    server = asyncio.create_task(_serve(conn, device, repo))
    try:
        _result, ok = await asyncio.wait_for(
            chat._run_tool(
                turn,
                ctx,
                chat.ToolCall(id="c1", name="start_change", arguments=json.dumps({"title": TITLE})),
            ),
            10,
        )
    finally:
        server.cancel()
    assert ok is True
    (span,) = turn.spans
    assert {"change": ID, "worktree_path": WT, "branch": BRANCH} in span.meta["facts"]
    assert "outside_worktree" not in span.meta
    await _close(conn, task)


# -- C5: never a fake success --------------------------------------------------------


@requires_db
async def test_c5_a_failed_fetch_quotes_git_and_adds_no_worktree(pool, recorded, fixed_id):
    device, conn, task = await _connect(pool)
    said = "fatal: could not read from remote repository."
    repo = FakeRepo(fail={"fetch": (128, said)})
    result, ok, facts = await _start(pool, conn, device, repo)
    assert ok is False
    assert result.startswith(tools.ERROR_PREFIX)
    assert said in result and "128" in result
    assert "add" not in repo.steps()
    assert _change_facts(facts) == []
    await _close(conn, task)


@requires_db
async def test_c5_an_underivable_base_quotes_git_and_fetches_nothing(
    pool, recorded, fixed_id, monkeypatch
):
    monkeypatch.delenv("NOVA_REPO_BRANCH")
    device, conn, task = await _connect(pool)
    said = "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref"
    repo = FakeRepo(fail={"symbolic-ref": (128, said)})
    result, ok, _facts = await _start(pool, conn, device, repo)
    assert ok is False
    assert said in result
    assert "fetch" not in repo.steps() and "add" not in repo.steps()
    await _close(conn, task)


@requires_db
async def test_c5_a_failed_worktree_add_quotes_git(pool, recorded, fixed_id):
    device, conn, task = await _connect(pool)
    said = f"fatal: a branch named '{BRANCH}' already exists"
    repo = FakeRepo(fail={"add": (128, said)})
    result, ok, facts = await _start(pool, conn, device, repo)
    assert ok is False
    assert said in result
    assert _change_facts(facts) == []
    await _close(conn, task)


@requires_db
async def test_c5_an_agent_failure_is_stated_not_success(pool, recorded, fixed_id):
    device, conn, task = await _connect(pool)
    repo = FakeRepo(fail={"fetch": "agent"})
    result, ok, _facts = await _start(pool, conn, device, repo)
    assert ok is False
    assert "command timed out" in result
    assert "add" not in repo.steps()
    await _close(conn, task)


@requires_db
@pytest.mark.parametrize(
    ("step", "failing", "words"),
    [
        ("rev-parse", (128, "fatal: not a git repository"), "fatal: not a git repository"),
        ("agents", "agent", "command timed out"),
    ],
)
async def test_c5_a_failure_after_the_worktree_exists_says_what_exists(
    pool, recorded, fixed_id, step, failing, words
):
    device, conn, task = await _connect(pool)
    repo = FakeRepo(fail={step: failing})
    result, ok, _facts = await _start(pool, conn, device, repo)
    assert ok is False
    assert result.startswith(tools.ERROR_PREFIX)
    assert words in result
    assert WT in result and BRANCH in result and "exists" in result
    await _close(conn, task)


# -- C6: registered, shaped, a writer ----------------------------------------------


def test_c6_start_change_is_registered_as_a_writer_that_persists():
    tool = tools.REGISTRY["start_change"]
    assert tool.reads_only is False
    assert tool.ephemeral is False


def test_c6_it_takes_exactly_a_title():
    params = tools.REGISTRY["start_change"].parameters
    assert params["type"] == "object"
    assert set(params["properties"]) == {"title"}
    assert params["properties"]["title"]["type"] == "string"
    assert params["required"] == ["title"]
    assert params["additionalProperties"] is False


def test_c6_its_description_says_worktree_and_cwd():
    description = tools.REGISTRY["start_change"].description
    assert "worktree" in description and "cwd" in description


async def test_c6_a_missing_title_executes_nothing(monkeypatch, tmp_path):
    called = []

    async def spy(args, ctx):
        called.append(args)
        return "x"

    if "start_change" in tools.REGISTRY:
        monkeypatch.setitem(
            tools.REGISTRY,
            "start_change",
            dataclasses.replace(tools.REGISTRY["start_change"], executor=spy),
        )
    ctx = tools.ToolContext(app=None, person=None, workspace_root=tmp_path, facts_sink=[])
    result, ok = await tools.dispatch("start_change", {}, ctx)
    assert ok is False and called == []
    assert "title" in result


# -- walk-fixes T4 (turn 8719a8f1): the result names the tools for the worktree ----


@requires_db
async def test_walk_t4_the_result_names_the_device_tools_for_the_worktree(pool, recorded, fixed_id):
    # After start_change she wrote README.md with workspace_write_file — her
    # notes workspace on the hub. The result must name what edits the worktree.
    device, conn, task = await _connect(pool)
    result, ok, _facts = await _start(pool, conn, device, FakeRepo())
    assert ok is True
    for tool in ("device_edit_file", "device_write_file", "device_read_file", "device_search"):
        assert tool in result, tool
    assert f"device_run with cwd {WT}" in result
    assert "workspace" in result and "not this worktree" in result
    assert result.rstrip().endswith(AGENTS.rstrip())
    await _close(conn, task)
