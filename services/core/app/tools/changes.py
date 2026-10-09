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

from app import code_repo
from app.tools.base import RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure
from app.tools.devices import _command, admit_row

START_CHANGE = "start_change"

REPO_BRANCH_ENV = "NOVA_REPO_BRANCH"
# Same shape chat.repository_line accepts for this key: a branch name that can
# never be read by git as an option (no leading "-") or a range ("..").
_BRANCH_SHAPE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}")
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
        ctx.facts_sink.append({"change": change, "worktree_path": worktree, "branch": branch})
    exists = f"the worktree {worktree} exists on branch {branch}"
    commit = await _git(pool, row, ctx, ["git", "-C", worktree, "rev-parse", "HEAD"], after=exists)
    agents_path = f"{worktree}/AGENTS.md"
    read = await _command(pool, row, "fs.read", {"path": agents_path}, ctx=ctx)
    if not read.get("ok"):
        error = read.get("error") or "the device reported a failure with no reason"
        raise ToolFailure(f"{row['name']}: could not read {agents_path}: {error} — {exists}")
    agents = str(read.get("output") or "")
    return (
        f"Started change {change} on {row['name']}.\n"
        f"Worktree: {worktree}\n"
        f"Branch: {branch}\n"
        f"Base: {_ORIGIN}{base} at {commit}\n"
        f"Work only inside it: run every command with cwd {worktree} and write files under "
        "it — never in the checkout itself.\n"
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
    lines = [f"Your open changes on {row['name']} ({len(hers)}):"]
    for entry in hers:
        path = posixpath.normpath(entry["path"])
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
        lines.append(f"- {path} — branch {branch} at {head} — {state}")
    return "\n".join(lines)


TOOLS: tuple[Tool, ...] = (
    Tool(
        name=START_CHANGE,
        description=(
            "Start a change to your own source code: on the machine that holds your repository "
            "it fetches the default branch and makes a new git worktree of yours on a new "
            "branch nova/<id>-<slug> off it, then returns the worktree's path, branch and base "
            "commit and the repository's AGENTS.md (the rules for changing its code). Use it "
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
            "whether it has uncommitted changes. Use it to find a change to resume — then pass "
            "its worktree path as `cwd` to device_run."
        ),
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        executor=list_changes,
        reads_only=True,
        ephemeral=True,
        result_kind=RESULT_KIND_LISTING,
    ),
)
