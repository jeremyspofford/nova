"""T6 (worktrees epic, 2026-10-08): list_changes — her open changes, so a later
turn can find and resume one (docs/plans/rebuild/nova-codes.md "S32 — A
worktree per change": several can be open at once).

Derived, never stored: the listing is `git worktree list --porcelain` on the
machine that holds her checkout (NOVA_REPO_HOST / NOVA_CHECKOUT, resolved by
code_repo.repo_machine), run through that machine's agent as argv-only git.
Only <repo>/.worktrees/nova-<id> entries are hers — the checkout itself and
Claude's own worktrees (.claude/worktrees/*, .worktrees/<lane>) are not.

Criteria:
  C1 Stated cannots before any git runs: nothing recorded (NOVA_CHECKOUT or
     NOVA_REPO_HOST unset) names the key and ./install; the repo machine
     paired but not connected says so; no device / several devices with that
     hostname is a cannot naming them. Each is an Error result with ZERO
     command frames sent.
  C2 One argv-only `git -C <repo> worktree list --porcelain` reads the
     worktrees, and only entries whose path is <repo>/.worktrees/nova-<id>
     are listed: the main checkout, .claude/worktrees/*, .worktrees/<lane>,
     a sibling <repo>-old/.worktrees/nova-x and anything else never are.
  C3 One line per change of hers: its path, its branch (refs/heads/
     stripped; a detached HEAD says "detached"), its HEAD as a short sha (7),
     and whether it has uncommitted changes — read by one argv-only
     `git -C <wt> status --porcelain` per listed worktree ("uncommitted
     changes" when it prints anything, "clean" when not). A status that fails
     keeps the entry and says the state is unknown in git's own words — never
     "clean".
  C4 Empty is said plainly and failure is never empty: no change of hers ->
     exactly "No change of yours is open." (ok=True); a nonzero `worktree
     list` exit or an agent ok:false is an Error result quoting git's / the
     agent's words — never the empty sentence.
  C5 Registered as a read: list_changes is in tools.REGISTRY, reads_only and
     ephemeral, result_kind RESULT_KIND_LISTING (the presented-listing guard
     learns it from the registry), takes no arguments (an empty object, no
     extras); it records no fact carrying a "device" key and never raises the
     outside_worktree flag. (test_tools_registry's name and reads_only pins
     moved with it, deliberately.)
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

import pytest

from app import chat, devices, devices_ws, tools, traces
from app.tools import changes
from app.tools.base import RESULT_KIND_LISTING
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice, FakeWSConn
from tests.test_devices_ws import _clean_hub, _close, _ctx, _person  # noqa: F401

REPO = "/home/jeremy/workspace/nova"
HOST = "mini-pc"
SHA_A = "aaaaaaa1111111111111111111111111111111111"[:40]
SHA_B = "bbbbbbb2222222222222222222222222222222222"[:40]
SHA_MAIN = "0123456789abcdef0123456789abcdef01234567"
WT_A = f"{REPO}/.worktrees/nova-a1b2c3"
WT_B = f"{REPO}/.worktrees/nova-d4e5f6"
BRANCH_A = "nova/a1b2c3-add-keyboard-shortcuts"
BRANCH_B = "nova/d4e5f6-fix-readme"


@pytest.fixture
def recorded(monkeypatch):
    monkeypatch.setenv("NOVA_CHECKOUT", REPO)
    monkeypatch.setenv("NOVA_REPO_HOST", HOST)


# -- a fake machine that holds the checkout ------------------------------------


def _entry(path: str, sha: str, branch: str | None) -> str:
    head = f"branch refs/heads/{branch}" if branch else "detached"
    return f"worktree {path}\nHEAD {sha}\n{head}\n\n"


MAIN_ENTRY = _entry(REPO, SHA_MAIN, "main")


@dataclass
class FakeRepo:
    """Answers list_changes' git the way the hub's checkout would.

    `listing` is the porcelain output of `worktree list`; `dirty` maps a
    worktree path to its `status --porcelain` output; `fail` maps "list" or a
    worktree path to (exit_code, output), or to "agent" for an agent-level
    ok:false."""

    listing: str = MAIN_ENTRY
    dirty: dict = field(default_factory=dict)
    fail: dict = field(default_factory=dict)
    seen: list[dict] = field(default_factory=list)

    def answer(self, envelope: dict) -> dict:
        self.seen.append(envelope)
        argv = envelope["args"].get("argv") or []
        if argv[3:5] == ["worktree", "list"]:
            key, output = "list", self.listing
        elif argv[3:5] == ["status", "--porcelain"]:
            key, output = argv[2], self.dirty.get(argv[2], "")
        else:
            key, output = None, ""
        failing = self.fail.get(key)
        if failing == "agent":
            return {"ok": False, "output": "", "exit_code": None, "error": "command timed out"}
        if failing is not None:
            code, said = failing
            return {"ok": True, "output": said, "exit_code": code, "error": None}
        return {"ok": True, "output": output, "exit_code": 0, "error": None}

    def argvs(self) -> list[list[str]]:
        return [e["args"]["argv"] for e in self.seen if e["capability"] == "shell.exec"]


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
        conn.feed(device.result(frame["envelope"], **repo.answer(frame["envelope"])))


async def _list(pool, conn, device, repo: FakeRepo, args: dict | None = None):
    """Dispatch list_changes while the fake machine answers; (result, ok, facts)."""
    person = await _person(pool)
    facts: list[dict] = []
    server = asyncio.create_task(_serve(conn, device, repo))
    try:
        result, ok = await asyncio.wait_for(
            tools.dispatch("list_changes", args or {}, _ctx(person, facts=facts)), 10
        )
    finally:
        server.cancel()
    return result, ok, facts


def _line_naming(result: str, path: str) -> str:
    (line,) = [line for line in result.splitlines() if path in line]
    return line


# -- C1: stated cannots, nothing sent --------------------------------------------


@requires_db
@pytest.mark.parametrize("unset", ["NOVA_CHECKOUT", "NOVA_REPO_HOST"])
async def test_c1_nothing_recorded_is_a_cannot_naming_install(pool, recorded, monkeypatch, unset):
    monkeypatch.delenv(unset)
    device, conn, task = await _connect(pool)
    repo = FakeRepo()
    result, ok, _facts = await _list(pool, conn, device, repo)
    assert ok is False
    assert result.startswith(tools.ERROR_PREFIX)
    assert "cannot" in result and unset in result and "./install" in result
    assert repo.seen == []
    await _close(conn, task)


@requires_db
async def test_c1_the_repo_machine_offline_is_stated(pool, recorded):
    await _enroll(pool, name="Beelink Mini S", hostname=HOST)  # paired, never connected
    person = await _person(pool)
    result, ok = await tools.dispatch("list_changes", {}, _ctx(person, facts=[]))
    assert ok is False
    assert result.startswith(tools.ERROR_PREFIX)
    assert "Beelink Mini S" in result and "not connected" in result
    assert changes.NO_CHANGES not in result


@requires_db
async def test_c1_no_device_with_that_hostname_names_what_is_paired(pool, recorded):
    device, conn, task = await _connect(pool, name="Dell", hostname="DELL-XPS-8950")
    repo = FakeRepo()
    result, ok, _facts = await _list(pool, conn, device, repo)
    assert ok is False
    assert "cannot" in result and HOST in result and "DELL-XPS-8950" in result
    assert repo.seen == []
    await _close(conn, task)


@requires_db
async def test_c1_a_shared_hostname_is_a_cannot_never_a_pick(pool, recorded):
    await _enroll(pool, name="Old Beelink", hostname=HOST)
    device, conn, task = await _connect(pool, name="Beelink Mini S", hostname=HOST)
    repo = FakeRepo()
    result, ok, _facts = await _list(pool, conn, device, repo)
    assert ok is False
    assert "cannot" in result and "Old Beelink" in result and "Beelink Mini S" in result
    assert repo.seen == []
    await _close(conn, task)


# -- C2: derived from `git worktree list`, only hers ---------------------------------


@requires_db
async def test_c2_the_listing_is_one_argv_only_worktree_list(pool, recorded):
    device, conn, task = await _connect(pool)
    repo = FakeRepo(listing=MAIN_ENTRY + _entry(WT_A, SHA_A, BRANCH_A))
    _result, ok, _facts = await _list(pool, conn, device, repo)
    assert ok is True
    assert {e["capability"] for e in repo.seen} == {"shell.exec"}
    argvs = repo.argvs()
    assert argvs[0] == ["git", "-C", REPO, "worktree", "list", "--porcelain"]
    assert [a for a in argvs if a[3:5] == ["worktree", "list"]] == [argvs[0]]
    for argv in argvs:
        assert argv[0] == "git", argv
        assert not any(word in ("sh", "bash", "-c") for word in argv), argv
    await _close(conn, task)


@requires_db
async def test_c2_only_her_worktrees_are_listed(pool, recorded):
    device, conn, task = await _connect(pool)
    others = [
        f"{REPO}/.claude/worktrees/hub-2-hub-4-sessions-aef48f",
        f"{REPO}/.worktrees/capped-answer",
        f"{REPO}/.worktrees/nova-",
        f"{REPO}-old/.worktrees/nova-zzzzzz",
        "/tmp/elsewhere",
    ]
    listing = MAIN_ENTRY + _entry(WT_A, SHA_A, BRANCH_A)
    for path in others:
        listing += _entry(path, SHA_B, "some/lane")
    listing += _entry(WT_B, SHA_B, BRANCH_B)
    repo = FakeRepo(listing=listing)
    result, ok, _facts = await _list(pool, conn, device, repo)
    assert ok is True
    # Paths are compared as whole words, never as substrings: the main
    # checkout and the empty-id "<repo>/.worktrees/nova-" are prefixes of
    # WT_A/WT_B, so a substring check could never pass on a correct listing.
    named = {word for word in result.split() if word.startswith("/")}
    assert named == {WT_A, WT_B}, named
    for path in [*others, REPO]:
        assert path not in named, path
    assert "some/lane" not in result
    assert not [line for line in result.splitlines() if f"{REPO} " in line + " "]
    # And status was only asked of hers.
    statused = [a[2] for a in repo.argvs() if a[3:5] == ["status", "--porcelain"]]
    assert sorted(statused) == sorted([WT_A, WT_B])
    await _close(conn, task)


@requires_db
async def test_c2_a_worktree_nested_inside_one_of_hers_is_not_a_change(pool, recorded):
    # Only <repo>/.worktrees/nova-<id> itself is a change: a worktree living
    # under one of hers (checkout_scope calls it "worktree" too) is not.
    device, conn, task = await _connect(pool)
    nested = [f"{WT_A}/vendor/lib", f"{REPO}/.worktrees/nova-zz9/inner"]
    listing = MAIN_ENTRY + _entry(WT_A, SHA_A, BRANCH_A)
    for path in nested:
        listing += _entry(path, SHA_B, "some/lane")
    repo = FakeRepo(listing=listing)
    result, ok, _facts = await _list(pool, conn, device, repo)
    assert ok is True
    named = {word for word in result.split() if word.startswith("/")}
    assert named == {WT_A}, named
    assert "some/lane" not in result
    statused = [a[2] for a in repo.argvs() if a[3:5] == ["status", "--porcelain"]]
    assert statused == [WT_A]
    await _close(conn, task)


# -- C3: one line each: path, branch, short sha, uncommitted? ------------------------


@requires_db
async def test_c3_each_change_names_path_branch_and_short_head(pool, recorded):
    device, conn, task = await _connect(pool)
    repo = FakeRepo(
        listing=MAIN_ENTRY + _entry(WT_A, SHA_A, BRANCH_A) + _entry(WT_B, SHA_B, BRANCH_B)
    )
    result, ok, _facts = await _list(pool, conn, device, repo)
    assert ok is True
    line_a = _line_naming(result, WT_A)
    assert BRANCH_A in line_a and SHA_A[:7] in line_a
    assert SHA_A not in line_a  # short, not the full sha
    assert "refs/heads/" not in line_a
    line_b = _line_naming(result, WT_B)
    assert BRANCH_B in line_b and SHA_B[:7] in line_b
    await _close(conn, task)


@requires_db
async def test_c3_a_detached_worktree_says_detached(pool, recorded):
    device, conn, task = await _connect(pool)
    repo = FakeRepo(listing=MAIN_ENTRY + _entry(WT_A, SHA_A, None))
    result, ok, _facts = await _list(pool, conn, device, repo)
    assert ok is True
    line = _line_naming(result, WT_A)
    assert "detached" in line and SHA_A[:7] in line
    await _close(conn, task)


@requires_db
async def test_c3_uncommitted_changes_are_said_per_worktree(pool, recorded):
    device, conn, task = await _connect(pool)
    repo = FakeRepo(
        listing=MAIN_ENTRY + _entry(WT_A, SHA_A, BRANCH_A) + _entry(WT_B, SHA_B, BRANCH_B),
        dirty={WT_A: " M deploy/README.md\n?? notes.txt\n"},
    )
    result, ok, _facts = await _list(pool, conn, device, repo)
    assert ok is True
    line_a = _line_naming(result, WT_A)
    line_b = _line_naming(result, WT_B)
    assert "uncommitted changes" in line_a and "clean" not in line_a
    assert "clean" in line_b and "uncommitted" not in line_b
    statuses = [a for a in repo.argvs() if a[3:5] == ["status", "--porcelain"]]
    assert sorted(statuses) == sorted(
        [["git", "-C", WT_A, "status", "--porcelain"], ["git", "-C", WT_B, "status", "--porcelain"]]
    )
    await _close(conn, task)


@requires_db
@pytest.mark.parametrize(
    ("failing", "words"),
    [
        ((128, "fatal: not a git repository"), "fatal: not a git repository"),
        ("agent", "command timed out"),
    ],
)
async def test_c3_a_failed_status_keeps_the_entry_and_never_says_clean(
    pool, recorded, failing, words
):
    device, conn, task = await _connect(pool)
    repo = FakeRepo(
        listing=MAIN_ENTRY + _entry(WT_A, SHA_A, BRANCH_A) + _entry(WT_B, SHA_B, BRANCH_B),
        fail={WT_A: failing},
    )
    result, ok, _facts = await _list(pool, conn, device, repo)
    assert ok is True
    line_a = _line_naming(result, WT_A)
    assert BRANCH_A in line_a
    assert "unknown" in line_a and words in line_a
    assert "clean" not in line_a
    assert "clean" in _line_naming(result, WT_B)
    await _close(conn, task)


# -- C4: empty said plainly; failure never empty --------------------------------------


@requires_db
@pytest.mark.parametrize(
    "listing",
    [
        MAIN_ENTRY,
        MAIN_ENTRY + _entry(f"{REPO}/.claude/worktrees/x", SHA_B, "claude/x"),
        MAIN_ENTRY + _entry(f"{REPO}/.worktrees/capped-answer", SHA_B, "lane"),
    ],
)
async def test_c4_none_of_hers_is_said_plainly(pool, recorded, listing):
    device, conn, task = await _connect(pool)
    repo = FakeRepo(listing=listing)
    result, ok, _facts = await _list(pool, conn, device, repo)
    assert ok is True
    assert result.strip() == changes.NO_CHANGES == "No change of yours is open."
    assert [a for a in repo.argvs() if a[3:5] == ["status", "--porcelain"]] == []
    await _close(conn, task)


@requires_db
async def test_c4_a_failed_worktree_list_quotes_git_and_is_never_empty(pool, recorded):
    device, conn, task = await _connect(pool)
    said = "fatal: not a git repository (or any of the parent directories): .git"
    repo = FakeRepo(fail={"list": (128, said)})
    result, ok, _facts = await _list(pool, conn, device, repo)
    assert ok is False
    assert result.startswith(tools.ERROR_PREFIX)
    assert said in result and "128" in result
    assert changes.NO_CHANGES not in result
    await _close(conn, task)


@requires_db
async def test_c4_an_agent_failure_is_stated_never_empty(pool, recorded):
    device, conn, task = await _connect(pool)
    repo = FakeRepo(fail={"list": "agent"})
    result, ok, _facts = await _list(pool, conn, device, repo)
    assert ok is False
    assert "command timed out" in result
    assert changes.NO_CHANGES not in result
    await _close(conn, task)


# -- C5: registered as a read --------------------------------------------------------


def test_c5_list_changes_is_registered_as_an_ephemeral_read_listing():
    tool = tools.REGISTRY["list_changes"]
    assert tool.reads_only is True
    assert tool.ephemeral is True
    assert tool.result_kind == RESULT_KIND_LISTING
    assert "list_changes" in tools.tool_names_by_result_kind(RESULT_KIND_LISTING)


def test_c5_it_takes_no_arguments():
    params = tools.REGISTRY["list_changes"].parameters
    assert params["type"] == "object"
    assert params.get("properties", {}) == {}
    assert params.get("required", []) == []
    assert params["additionalProperties"] is False


def test_c5_its_description_says_worktree_and_start_change():
    description = tools.REGISTRY["list_changes"].description
    assert "worktree" in description and "start_change" in description


@requires_db
async def test_c5_no_device_fact_and_no_outside_flag_on_the_span(pool, recorded):
    device, conn, task = await _connect(pool)
    repo = FakeRepo(listing=MAIN_ENTRY + _entry(WT_A, SHA_A, BRANCH_A))
    person = await _person(pool)
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    facts: list[dict] = []
    ctx = _ctx(person, facts=facts)
    server = asyncio.create_task(_serve(conn, device, repo))
    try:
        _result, ok = await asyncio.wait_for(
            chat._run_tool(
                turn, ctx, chat.ToolCall(id="c1", name="list_changes", arguments=json.dumps({}))
            ),
            10,
        )
    finally:
        server.cancel()
    assert ok is True
    (span,) = turn.spans
    assert span.meta["ok"] is True
    assert "outside_worktree" not in span.meta
    assert not [f for f in facts if "outside_worktree" in f]
    # A fact carrying "device" is read as a CONNECTIVITY record (the state
    # guard): the only one allowed is the funnel's own {"device", "connected"}.
    assert all(set(f) == {"device", "connected"} for f in facts if "device" in f)
    await _close(conn, task)
