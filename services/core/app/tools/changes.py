"""Her code changes, each in a git worktree of hers (the S32 worktree part,
epic .epics/worktrees.md T5/T6; spec docs/plans/rebuild/nova-codes.md S32).

start_change runs git THROUGH the agent on the machine that holds her
repository — the one live device whose hostname is NOVA_REPO_HOST, at the path
NOVA_CHECKOUT (app/code_repo.py, both recorded by ./install) — because core's
container has no checkout. Every command is argv-only git (no shell), sent
through the same funnel as device_run (tools/devices._command), and every
nonzero exit or agent failure is an Error result quoting git's own words.

Its own git never raises the outside-worktree flag: that flag lives in
device_run / device_write_file, and this tool does not go through them — the
`git -C <repo>` it sends is the one sanctioned way to touch the checkout
(fetch, and add a worktree under .worktrees/nova-<id>).
"""

from __future__ import annotations

import os
import posixpath
import re
import secrets

from app import code_repo, code_repos, landings
from app.tools.base import RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure
from app.tools.devices import (
    _NO_REASON,
    _UNKNOWN_CAPABILITY,
    _box_failure,
    _command,
    admit_row,
    box_name,
)

START_CHANGE = "start_change"

REPO_BRANCH_ENV = code_repos.REPO_BRANCH_ENV
# Same shape chat.repository_line accepts for this key: a branch name that can
# never be read by git as an option (no leading "-") or a range ("..").
_BRANCH_SHAPE = code_repos.BRANCH_SHAPE
_ORIGIN = "origin/"

SLUG_MAX = 40
_SLUG_WORDS = re.compile(r"[a-z0-9]+")
# How many fresh ids are tried before the collision check gives up (16^6 ids:
# reaching this means the listing itself is wrong, and that is said).
_ID_TRIES = 20
_WORKTREE_LIST_PATH = "worktree "


def slug(title: str) -> str:
    """The branch slug of a change's title: [a-z0-9-], at most 40, never
    empty ("change")."""
    words = _SLUG_WORDS.findall(title.lower()) if isinstance(title, str) else []
    value = "-".join(words)[:SLUG_MAX].strip("-")
    return value or "change"


def new_id() -> str:
    """A fresh change id candidate: 6 lowercase hex."""
    return secrets.token_hex(3)


def _quote(argv: list[str]) -> str:
    return " ".join(argv)


async def _git(pool, row, ctx: ToolContext, argv: list[str], *, after: str = "") -> str:
    """Run one argv-only git command on the repo machine; its output, or a
    ToolFailure quoting git's (or the agent's) words and exit code. `after`
    is appended to the failure — what already exists when a later step fails."""
    tail = f" — {after}" if after else ""
    result = await _command(pool, row, "shell.exec", {"argv": argv}, ctx=ctx)
    if not result.get("ok"):
        error = result.get("error") or "the device reported a failure with no reason"
        raise ToolFailure(f"{row['name']}: could not run `{_quote(argv)}`: {error}{tail}")
    code = result.get("exit_code")
    output = str(result.get("output") or "").strip()
    if code != 0:
        said = output or "(no output)"
        raise ToolFailure(f"{row['name']}: `{_quote(argv)}` exited {code}: {said}{tail}")
    return output


async def _base(pool, row, ctx: ToolContext, repo: str) -> str:
    """The branch a change starts from: NOVA_REPO_BRANCH when recorded, else
    what the machine's own origin/HEAD names."""
    recorded = os.environ.get(REPO_BRANCH_ENV, "").strip()
    if recorded:
        if not _BRANCH_SHAPE.fullmatch(recorded) or ".." in recorded:
            raise ToolFailure(
                f"cannot: {REPO_BRANCH_ENV}={recorded!r} is not a branch name — the owner "
                "records it by running ./install from the checkout"
            )
        return recorded
    head = await _git(
        pool, row, ctx, ["git", "-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]
    )
    base = head[len(_ORIGIN) :] if head.startswith(_ORIGIN) else ""
    if not _BRANCH_SHAPE.fullmatch(base) or ".." in base:
        raise ToolFailure(
            f"cannot: origin/HEAD in {repo} on {row['name']} names {head!r}, not a branch of "
            "origin — so which branch a change starts from is not known"
        )
    return base


async def _taken(pool, row, ctx: ToolContext, repo: str) -> tuple[set[str], set[str]]:
    """(worktree paths, branch names) already on the machine — read before an
    id is picked, so a new change never lands on an old one."""
    listing = await _git(pool, row, ctx, ["git", "-C", repo, "worktree", "list", "--porcelain"])
    paths = {
        line[len(_WORKTREE_LIST_PATH) :].strip()
        for line in listing.splitlines()
        if line.startswith(_WORKTREE_LIST_PATH)
    }
    branches = await _git(
        pool,
        row,
        ctx,
        ["git", "-C", repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    )
    return paths, {line.strip() for line in branches.splitlines() if line.strip()}


def _free_id(repo: str, paths: set[str], branches: set[str]) -> str:
    for _ in range(_ID_TRIES):
        # Looked up on the module at call time, never bound at import.
        candidate = new_id()
        used_path = f"{repo}/{code_repo.WORKTREES_DIR}/{code_repo.WORKTREE_PREFIX}{candidate}"
        used_branch = any(b.startswith(f"nova/{candidate}-") for b in branches)
        if used_path not in paths and not used_branch:
            return candidate
    raise ToolFailure(
        f"cannot: {_ID_TRIES} fresh change ids were all already used by a worktree or a "
        f"nova/<id>-* branch in {repo} — no change was started"
    )


# -- the change's box (S32.2 T10; spec docs/plans/rebuild/s32/spec.md §4.4) ----
#
# start_change starts the box as soon as the worktree exists, so her first
# command in it does not pay the cold start; list_changes says each box's
# state. A box that does not start never fails the change — the worktree is
# real — but the result says so in the agent's words, and device_run in that
# worktree keeps saying so (T9) until it does. Where the owner set the
# repository's environment to host, no box is started and that is said.

_HOST = "host"
_BOX_STATES = ("running", "stopped")
NOT_CREATED = "not created"


def _environment_words(environment: str) -> str:
    if environment == _HOST:
        return f"environment {_HOST} (set by the owner)"
    return f"environment {environment}"


async def _start_box(pool, row, ctx: ToolContext, change: str, repo: str, base: str) -> str:
    """The result lines naming where this change's commands run, after asking
    the agent's box.start once (environment box). Never raises: a box that
    did not start is said, with why."""
    if pool is None:
        # A replay's declared device has no box (as device_run's _box_route).
        return ""
    environment = await code_repos.environment(pool)
    if environment == _HOST:
        return (
            f"Environment: {_HOST} (set by the owner) — commands in this worktree run on the "
            "host, not in a box\n"
        )
    name = box_name(change)
    args = {
        "change": change,
        "checkout": posixpath.normpath(repo),
        # The repo's default branch — the image tag and suites.toml are read
        # from it, never from the change's own nova/<id>-* branch (T9's rule).
        "branch": base,
        "limits": await code_repos.box_limits(pool),
    }
    try:
        result = await _command(pool, row, "box.start", args, ctx=ctx)
    except ToolFailure as failed:
        why = " ".join(str(failed).split())
    else:
        if result.get("ok"):
            said = str(result.get("output") or "").strip() or f"{name} started"
            return (
                f"Environment: {environment} — commands in this worktree run in the box {name}\n"
                f"Box: {said}\n"
            )
        why = _box_failure(result, row)
    return (
        f"Environment: {environment}\n"
        f"The box {name} did not start: {why} — commands in this worktree will say so until "
        "it does\n"
    )


async def _box_states(pool, row, ctx: ToolContext) -> tuple[dict[str, str] | None, str]:
    """(state by change id, "") from one box.status, or (None, why) when it
    cannot be read — never a guess."""
    try:
        result = await _command(pool, row, "box.status", {}, ctx=ctx)
    except ToolFailure as failed:
        return None, " ".join(str(failed).split())
    if not result.get("ok"):
        return None, _box_failure(result, row)
    meta = result.get("meta")
    boxes = meta.get("boxes") if isinstance(meta, dict) else None
    if not isinstance(boxes, dict):
        return None, "the agent's box.status named no boxes"
    for state in boxes.values():
        if state not in _BOX_STATES:
            return None, f"the agent's box.status said {state!r}"
    return boxes, ""


async def remove_box(pool, row, ctx: ToolContext, change: str) -> str:
    """Take the change's box down through the agent's box.remove (S32.3 T7):
    '' when the agent removed it, else the stated reason — never raises, so a
    landing's close or close_change records why and its verdict stands. Only
    the change id is sent; the agent derives every docker name from it."""
    if not isinstance(change, str) or not _CHANGE_ID.fullmatch(change):
        return f"cannot remove a box: {change!r} is not a change id (6 lowercase hex)"
    try:
        result = await _command(pool, row, "box.remove", {"change": change}, ctx=ctx)
    except ToolFailure as failed:
        return " ".join(str(failed).split())
    if result.get("ok"):
        return ""
    error = str(result.get("error") or _NO_REASON)
    if error.startswith(_UNKNOWN_CAPABILITY):
        return f"{row['name']}'s agent predates box removal — update it with machine_update"
    return f"{row['name']}: {error}"


async def stop_box(pool, row, ctx: ToolContext, change: str) -> tuple[bool, str]:
    """Stop the change's box through the agent's box.stop (S38c T5): (True,
    '') when its record says it stopped, (False, '') when it says the box
    was not running, else (False, the stated reason) — never raises. Stopped
    is read from the agent's record {box, stopped}, never from ok alone."""
    if not isinstance(change, str) or not _CHANGE_ID.fullmatch(change):
        return False, f"cannot stop a box: {change!r} is not a change id (6 lowercase hex)"
    try:
        result = await _command(pool, row, "box.stop", {"change": change}, ctx=ctx)
    except ToolFailure as failed:
        return False, " ".join(str(failed).split())
    if not result.get("ok"):
        error = str(result.get("error") or _NO_REASON)
        if error.startswith(_UNKNOWN_CAPABILITY):
            return False, "the agent predates box.stop — update it with machine_update"
        return False, f"{row['name']}: {error}"
    meta = result.get("meta")
    stopped = meta.get("stopped") if isinstance(meta, dict) else None
    if not isinstance(stopped, bool) or meta.get("box") != box_name(change):
        return False, f"{row['name']} answered box.stop with no record of stopping it"
    return stopped, ""


async def start_change(args: dict, ctx: ToolContext) -> str:
    row, repo = await code_repo.repo_machine(ctx.app)
    pool = await admit_row(row, ctx)
    repo = repo.rstrip("/") or "/"
    base = await _base(pool, row, ctx, repo)
    await _git(pool, row, ctx, ["git", "-C", repo, "fetch", "origin", base])
    paths, branches = await _taken(pool, row, ctx, repo)
    change = _free_id(repo, paths, branches)
    branch = f"nova/{change}-{slug(args['title'])}"
    worktree = f"{repo}/{code_repo.WORKTREES_DIR}/{code_repo.WORKTREE_PREFIX}{change}"
    await _git(
        pool,
        row,
        ctx,
        ["git", "-C", repo, "worktree", "add", "-b", branch, worktree, f"{_ORIGIN}{base}"],
    )
    # The worktree exists from here on: the fact says so, and any later
    # failure names it instead of reading as if nothing happened. No "device"
    # key — that is read as a connectivity record (the state guard).
    if ctx.facts_sink is not None:
        # "started" (own-tool-handback T3): THIS turn opened it — the marker
        # the current-change warning keys on. list_changes records the same
        # shape WITHOUT it: a listed change is an old one, not the current.
        ctx.facts_sink.append(
            {"change": change, "worktree_path": worktree, "branch": branch, "started": True}
        )
    exists = f"the worktree {worktree} exists on branch {branch}"
    commit = await _git(pool, row, ctx, ["git", "-C", worktree, "rev-parse", "HEAD"], after=exists)
    agents_path = f"{worktree}/AGENTS.md"
    read = await _command(pool, row, "fs.read", {"path": agents_path}, ctx=ctx)
    if not read.get("ok"):
        error = read.get("error") or "the device reported a failure with no reason"
        raise ToolFailure(f"{row['name']}: could not read {agents_path}: {error} — {exists}")
    agents = str(read.get("output") or "")
    box_lines = await _start_box(pool, row, ctx, change, repo, base)
    return (
        f"Started change {change} on {row['name']}.\n"
        f"Worktree: {worktree}\n"
        f"Branch: {branch}\n"
        f"Base: {_ORIGIN}{base} at {commit}\n"
        f"{box_lines}"
        f"Work only inside it: run every command with cwd {worktree} and write files under "
        "it — never in the checkout itself.\n"
        f"The worktree's files are on {row['name']}: read them with device_read_file or "
        "device_search, change part of a file with device_edit_file, write a new file with "
        f"device_write_file, and run commands with device_run with cwd {worktree}. Your "
        "workspace_* tools are your notes workspace on the hub, not this worktree.\n"
        f"{agents_path}:\n"
        f"{agents}"
    )


LIST_CHANGES = "list_changes"
NO_CHANGES = "No change of yours is open."


_SHORT_SHA = 7
_HEADS = "refs/heads/"


def _porcelain_entries(listing: str) -> list[dict]:
    """`git worktree list --porcelain` as one dict per worktree: path, head,
    branch (None when detached or not said)."""
    entries: list[dict] = []
    current: dict | None = None
    for line in listing.splitlines():
        if line.startswith(_WORKTREE_LIST_PATH):
            current = {"path": line[len(_WORKTREE_LIST_PATH) :].strip(), "head": "", "branch": None}
            entries.append(current)
        elif current is None:
            continue
        elif line.startswith("HEAD "):
            current["head"] = line[len("HEAD ") :].strip()
        elif line.startswith("branch "):
            ref = line[len("branch ") :].strip()
            current["branch"] = ref[len(_HEADS) :] if ref.startswith(_HEADS) else ref
    return entries


def _is_hers(path: str, repo: str) -> bool:
    """Exactly <repo>/.worktrees/nova-<id> — not a directory under one, not
    the checkout, not any other worktree under it."""
    if code_repo.checkout_scope(path, repo) != "worktree":
        return False
    return posixpath.dirname(posixpath.normpath(path)) == f"{repo}/{code_repo.WORKTREES_DIR}"


def _landed(lasts: dict | None, change: str) -> str:
    """' — last landing <id> <verdict>[, merged <sha>]' or ' — never landed';
    '' where no record was read (a replay)."""
    if lasts is None:
        return ""
    last = lasts.get(change)
    if last is None:
        return " — never landed"
    merged = f", merged {last['merged_sha'][:_SHORT_SHA]}" if last.get("merged_sha") else ""
    return f" — last landing {last['id']} {last['verdict']}{merged}"


async def list_changes(args: dict, ctx: ToolContext) -> str:
    """Her open changes, read from `git worktree list --porcelain` on the repo
    machine (derived — never a stored table), one line each."""
    row, repo = await code_repo.repo_machine(ctx.app)
    pool = await admit_row(row, ctx)
    repo = repo.rstrip("/") or "/"
    listing = await _git(pool, row, ctx, ["git", "-C", repo, "worktree", "list", "--porcelain"])
    hers = [e for e in _porcelain_entries(listing) if _is_hers(e["path"], repo)]
    if not hers:
        return NO_CHANGES
    if pool is None:
        boxes, why, where = None, "", ""
    else:
        environment = await code_repos.environment(pool)
        boxes, why = await _box_states(pool, row, ctx)
        where = f" — {_environment_words(environment)}"
    # Each change's newest landing (S32.3 T11), one read for all of them.
    if pool is None:
        lasts = None
    else:
        ids = [
            posixpath.basename(posixpath.normpath(e["path"]))[len(code_repo.WORKTREE_PREFIX) :]
            for e in hers
        ]
        lasts = await landings.last_per_change(pool, ids)
    lines = [f"Your open changes on {row['name']} ({len(hers)}):"]
    for entry in hers:
        path = posixpath.normpath(entry["path"])
        change = posixpath.basename(path)[len(code_repo.WORKTREE_PREFIX) :]
        # The same fact start_change records (walk-fixes T4): a change is open
        # this turn, so a later workspace write says it is not this worktree.
        if ctx.facts_sink is not None:
            ctx.facts_sink.append(
                {"change": change, "worktree_path": path, "branch": entry["branch"]}
            )
        branch = entry["branch"] or "detached"
        head = entry["head"][:_SHORT_SHA] or "unknown"
        try:
            status = await _git(pool, row, ctx, ["git", "-C", path, "status", "--porcelain"])
        except ToolFailure as failed:
            # Never "clean" when it could not be read: the entry stays, and
            # git's (or the agent's) own words say why its state is unknown.
            state = "state unknown: " + " ".join(str(failed).split())
        else:
            state = "uncommitted changes" if status else "clean"
        if pool is None:
            box = ""
        elif boxes is None:
            box = f" — box state unknown: {why}"
        else:
            box = f" — box {boxes.get(change, NOT_CREATED)}"
        lines.append(
            f"- {path} — branch {branch} at {head} — {state}{_landed(lasts, change)}{box}{where}"
        )
    return "\n".join(lines)


# -- committing her change (S32.3 T2; spec docs/plans/rebuild/s32/spec.md §5.1) --
#
# The box mounts the repository's .git read-only, so her commit happens on the
# machine that holds the checkout, through its agent, in the worktree DERIVED
# from the change id. The author is Nova, never whoever's git identity the
# machine carries, and the trailers say which turn and which coder wrote it
# (nova-codes decision 6). Every step is argv-only git; any failure is git's
# own words.

CHANGE_COMMIT = "change_commit"

_CHANGE_SHAPE = "^[0-9a-f]{6}$"
_CHANGE_ID = re.compile(r"[0-9a-f]{6}")
# A line git would read as one of the trailers change_commit writes: the key at
# a line's start (indentation allowed), any case, then the ":" separator.
_OWN_TRAILER = re.compile(r"^[ \t]*nova-(?:turn|coder)[ \t]*:", re.IGNORECASE | re.MULTILINE)
NO_CODER = "nova-loop (model not recorded)"
NO_TURN = "not recorded"


def _one_line(value: str) -> str:
    """A trailer value on one line: a newline in it would start a second
    trailer of its own (a forged Nova-Turn)."""
    return " ".join(str(value).split())


def _worktree_of(repo: str, change: str) -> str:
    return f"{repo}/{code_repo.WORKTREES_DIR}/{code_repo.WORKTREE_PREFIX}{change}"


async def change_commit(args: dict, ctx: ToolContext) -> str:
    change = args["change"]
    message = args["message"]
    # Checked here, before anything is sent: tools/schema.py does not read
    # `pattern`, and the id becomes part of a path on the machine.
    if not _CHANGE_ID.fullmatch(change):
        raise ToolFailure(
            f"{change!r} is not a change id — it is the 6 hex after nova- in the worktree's "
            "name (list_changes names your open changes)"
        )
    if not message.strip():
        raise ToolFailure("the commit message is blank — say what the change does")
    if _OWN_TRAILER.search(message):
        # git folds a message's last paragraph into the trailer block, so a
        # line of hers would stand beside the real trailer as a second one.
        raise ToolFailure(
            "the commit message carries a Nova-Turn or Nova-Coder line — change_commit "
            "writes those trailers itself; take the line out of the message"
        )
    row, repo = await code_repo.repo_machine(ctx.app)
    pool = await admit_row(row, ctx)
    repo = repo.rstrip("/") or "/"
    worktree = _worktree_of(repo, change)
    listing = await _git(pool, row, ctx, ["git", "-C", repo, "worktree", "list", "--porcelain"])
    open_branches = {
        posixpath.normpath(entry["path"]): entry["branch"] or "detached"
        for entry in _porcelain_entries(listing)
        if _is_hers(entry["path"], repo)
    }
    if worktree not in open_branches:
        raise ToolFailure(
            f"no open change {change} on {row['name']}: {worktree} is not a worktree of yours "
            "— list_changes names your open changes"
        )
    status = await _git(pool, row, ctx, ["git", "-C", worktree, "status", "--porcelain"])
    if not status:
        raise ToolFailure(
            f"nothing to commit in {worktree} — it has no changes since its last commit"
        )
    host = code_repo.repo_host()
    nova = f"Nova <nova@{host}>"
    turn = _one_line(ctx.turn_id) if ctx.turn_id is not None else NO_TURN
    coder = _one_line(ctx.coder) if ctx.coder else ""
    await _git(pool, row, ctx, ["git", "-C", worktree, "add", "-A"])
    await _git(
        pool,
        row,
        ctx,
        [
            "git",
            "-C",
            worktree,
            # Author AND committer are Nova (user.* sets both; --author names
            # her even where the environment carries an author of its own).
            # Never signed: a signing key on the machine is the owner's, and
            # her commit is not his.
            "-c",
            "user.name=Nova",
            "-c",
            f"user.email=nova@{host}",
            "-c",
            "commit.gpgsign=false",
            "commit",
            f"--author={nova}",
            "-m",
            message,
            "--trailer",
            f"Nova-Turn: {turn}",
            "--trailer",
            f"Nova-Coder: {coder or NO_CODER}",
        ],
    )
    sha = await _git(pool, row, ctx, ["git", "-C", worktree, "rev-parse", "HEAD"])
    stat = await _git(pool, row, ctx, ["git", "-C", worktree, "show", "--stat", "--format=", sha])
    names = await _git(
        pool,
        row,
        ctx,
        [
            "git",
            "-C",
            worktree,
            "-c",
            "core.quotepath=false",
            "show",
            "--name-only",
            "--format=",
            sha,
        ],
    )
    files = sorted({line.strip() for line in names.splitlines() if line.strip()})
    if ctx.facts_sink is not None:
        # The commit THIS call made — what an edited_file claim can read
        # (T13). Nested, never a top-level "device" (a connectivity record)
        # or "change" (an open-change record) key.
        ctx.facts_sink.append(
            {
                "commit": {"device": row["name"], "change": change, "sha": sha, "files": files},
                "target": worktree,
            }
        )
    coder_line = (
        f"Coder: {coder}"
        if coder
        else f"Coder: {NO_CODER} — this turn named no model, so the trailer says so"
    )
    return (
        f"Committed change {change} on {row['name']}: {sha}\n"
        f"Branch: {open_branches[worktree]} (worktree {worktree})\n"
        f"Author: {nova}\n"
        f"Turn: {turn}\n"
        f"{coder_line}\n"
        f"{stat}\n"
        "Land it with repo_land when it is ready to be judged."
    )


CHANGE_COMMIT_TOOL = Tool(
    name=CHANGE_COMMIT,
    description=(
        "Commit everything changed in one of your changes' worktrees (git add -A, then commit) "
        "on the machine that holds your repository — the box cannot write to .git, so this is "
        "how your work is committed. The author is Nova and the commit carries Nova-Turn and "
        "Nova-Coder trailers naming this turn and the model writing it. Returns the commit SHA "
        "and its stat. Pass the change's 6-hex id (from start_change or list_changes) and a "
        "message saying what the change does; then land it with repo_land."
    ),
    parameters={
        "type": "object",
        "properties": {
            "change": {
                "type": "string",
                "pattern": _CHANGE_SHAPE,
                "description": "The change's id: the 6 hex after nova- in its worktree's name.",
            },
            "message": {
                "type": "string",
                "minLength": 1,
                "description": "The commit message: what the change does.",
            },
        },
        "required": ["change", "message"],
        "additionalProperties": False,
    },
    executor=change_commit,
    reads_only=False,
    ephemeral=False,
)


TOOLS: tuple[Tool, ...] = (
    Tool(
        name=START_CHANGE,
        description=(
            "Start a change to your own source code: on the machine that holds your repository "
            "it fetches the default branch and makes a new git worktree of yours on a new "
            "branch nova/<id>-<slug> off it, starts the change's sealed box (where commands in "
            "the worktree run), then returns the worktree's path, branch and base commit, the "
            "box's state and the repository's AGENTS.md (the rules for changing its code). Use it "
            "before any code work on your repository, then pass the worktree as `cwd` to "
            "device_run and write files only under it. Several changes can be open at once."
        ),
        parameters={
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "A few words naming the change; it becomes the branch slug.",
                }
            },
            "required": ["title"],
            "additionalProperties": False,
        },
        executor=start_change,
        reads_only=False,
        ephemeral=False,
    ),
    Tool(
        name=LIST_CHANGES,
        description=(
            "List your open changes: each git worktree of yours (made by start_change) on the "
            "machine that holds your repository, with its path, branch, short HEAD commit and "
            "whether it has uncommitted changes, and its box's state (running, stopped or not "
            "created) and environment, and its last landing (id and verdict, or never "
            "landed). Use it to find a change to resume — then pass "
            "its worktree path as `cwd` to device_run."
        ),
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        executor=list_changes,
        reads_only=True,
        ephemeral=True,
        result_kind=RESULT_KIND_LISTING,
    ),
    # S32.3 T13 (2026-10-13): registered with the rest of her landing step.
    CHANGE_COMMIT_TOOL,
)
