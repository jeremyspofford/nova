"""The host git steps of a landing (S32 spec §5.2 steps 1, 2 and 7's
dirty_outside) — over an injectable runner.

Every command is argv-only git (no shell). In production the runner is
`agent_runner`: shell.exec through the agent on the machine that holds the
repository (tools/devices._command), exactly as start_change and
change_commit reach it. Tests hand in a runner that runs real git in a
temporary repository.

What is read, and why it is read this way:
  - Listings use `-c core.quotepath=false` and git's C-quoting is undone by
    `unquote` — never `-z`: a NUL in a shell.exec result would travel on into
    spans and audit text.
  - Statuses and diffs use `--no-renames` (a rename is the old path deleted
    and the new one added, so both select their suites) and diffs
    `--no-color --no-ext-diff --no-textconv`, so the owner's own git config
    never changes what is parsed or stored.
  - A listing the runner cut (shell.exec caps output at 64 KiB) is never
    acted on in part — it is a stated failure. The patch is the one output
    that may be cut: it is stored with `patch_truncated`.
  - Every nonzero exit is a ToolFailure quoting the command, its exit and
    git's own words; a conflicting rebase is the one failure that is an
    outcome (`Conflict`), and it is aborted first.
"""

from __future__ import annotations

import posixpath
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from app import code_repo
from app.tools import changes
from app.tools.base import ToolFailure
from app.tools.devices import _command

# The module's own bound on the stored patch. shell.exec already caps its
# output at 64 KiB (novad caps.OutputCap), which the runner reports as
# `truncated`; this bound holds for a runner without a cap.
PATCH_MAX = 1 << 20

# novad's shell.exec suffixes (apps/novad/internal/caps/shell.go): the cap
# note capWriter appends, then the exit note a nonzero exit appends.
_CUT_NOTE = re.compile(r"\n\[truncated at \d+ KiB\]\Z")
_EXIT_NOTE = "\n[process exited with code {code}]"

_LISTING = ("-c", "core.quotepath=false")
_STATUS = ("status", "--porcelain", "--no-renames", "--untracked-files=all")
_DIFF = ("diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames")

# Step 3's clean copy.
JUDGE_TRIES = 20
_JUDGE = re.compile(r"[0-9a-f]{6}")
_SHA = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
_WORKTREE_LINE = "worktree "

_ESCAPES = {
    "a": 0x07,
    "b": 0x08,
    "f": 0x0C,
    "n": 0x0A,
    "r": 0x0D,
    "t": 0x09,
    "v": 0x0B,
    "\\": 0x5C,
    '"': 0x22,
}


@dataclass(frozen=True)
class Ran:
    """One command's outcome: its exit code, its output (stdout + stderr) and
    whether the runner cut the output."""

    exit: int
    output: str
    truncated: bool = False


Runner = Callable[[list[str]], Awaitable[Ran]]


@dataclass(frozen=True)
class Conflict:
    """Step 2's rebase stopped on conflicting files; it was aborted."""

    base_sha: str
    files: tuple[str, ...]


@dataclass(frozen=True)
class Prepared:
    """Her branch, up to date with main, and what the landing judges."""

    branch: str
    base_sha: str
    commit_sha: str
    rebased: bool
    changed: tuple[str, ...]
    deleted: tuple[str, ...]
    patch: str
    patch_truncated: bool


def _quote(argv: list[str]) -> str:
    return " ".join(argv)


def unquote(name: str) -> str:
    """A path as git printed it, with its C-quoting undone ("h\\303\\251" ->
    "hé"). An unquoted name is returned as it is."""
    if len(name) < 2 or not (name.startswith('"') and name.endswith('"')):
        return name
    body = name[1:-1]
    out = bytearray()
    i = 0
    while i < len(body):
        char = body[i]
        if char != "\\" or i + 1 == len(body):
            out += char.encode()
            i += 1
            continue
        nxt = body[i + 1]
        if nxt in _ESCAPES:
            out.append(_ESCAPES[nxt])
            i += 2
        elif body[i + 1 : i + 4].isdigit() and len(body[i + 1 : i + 4]) == 3:
            out.append(int(body[i + 1 : i + 4], 8) & 0xFF)
            i += 4
        else:
            out += char.encode()
            i += 1
    return out.decode("utf-8", "replace")


def agent_runner(pool, row, ctx) -> Runner:
    """The production runner: argv-only shell.exec through the agent on the
    repository's machine. A nonzero exit is returned, never raised; the agent
    failing to run the command at all is a ToolFailure in its words."""

    async def run(argv: list[str]) -> Ran:
        argv = list(argv)
        result = await _command(pool, row, "shell.exec", {"argv": argv}, ctx=ctx)
        if not result.get("ok"):
            error = result.get("error") or "the device reported a failure with no reason"
            raise ToolFailure(f"{row['name']}: could not run `{_quote(argv)}`: {error}")
        code = result.get("exit_code")
        if not isinstance(code, int) or isinstance(code, bool):
            raise ToolFailure(
                f"{row['name']}: `{_quote(argv)}` returned no exit code — whether it "
                "succeeded is not known"
            )
        output = str(result.get("output") or "")
        note = _EXIT_NOTE.format(code=code)
        if code != 0 and output.endswith(note):
            output = output[: -len(note)]
        cut = _CUT_NOTE.search(output)
        if cut:
            output = output[: cut.start()]
        return Ran(exit=code, output=output, truncated=bool(cut))

    return run


async def _ok(run: Runner, argv: list[str], *, what: str = "") -> Ran:
    ran = await run(argv)
    if ran.exit != 0:
        said = ran.output.strip() or "(no output)"
        lead = f"{what}: " if what else ""
        raise ToolFailure(f"{lead}`{_quote(argv)}` exited {ran.exit}: {said}")
    return ran


async def _value(run: Runner, argv: list[str]) -> str:
    return (await _ok(run, argv)).output.strip()


def _lines(output: str) -> list[str]:
    # Split on "\n" only: with quotepath off, a name may carry U+2028 or a
    # form feed's neighbours that str.splitlines would split on.
    return [line for line in output.split("\n") if line.strip()]


async def _listing(run: Runner, argv: list[str]) -> list[str]:
    ran = await _ok(run, argv)
    if ran.truncated:
        raise ToolFailure(
            f"`{_quote(argv)}`: its output was cut at the agent's output limit, so the "
            "listing is not complete — it is not acted on in part"
        )
    return _lines(ran.output)


def _status_paths(lines: list[str]) -> list[str]:
    # Porcelain v1: "XY <path>" (no "->": renames are off).
    return sorted({unquote(line[3:]) for line in lines if len(line) > 3})


async def commit_check(run: Runner, worktree: str) -> None:
    """Spec §5.2 step 1: uncommitted work in the worktree is an Error naming
    every file."""
    lines = await _listing(run, ["git", "-C", worktree, *_LISTING, *_STATUS])
    files = _status_paths(lines)
    if files:
        raise ToolFailure(f"uncommitted changes in {', '.join(files)}; call change_commit first")


async def _branch(run: Runner, worktree: str) -> str:
    argv = ["git", "-C", worktree, "symbolic-ref", "--short", "-q", "HEAD"]
    ran = await run(argv)
    if ran.exit == 1:
        raise ToolFailure(
            f"{worktree} is on a detached HEAD, not on its change's branch — a landing "
            "lands a branch; check its branch out again in the worktree"
        )
    if ran.exit != 0:
        said = ran.output.strip() or "(no output)"
        raise ToolFailure(f"`{_quote(argv)}` exited {ran.exit}: {said}")
    return ran.output.strip()


async def _ahead(run: Runner, worktree: str, base: str) -> int:
    count = await _value(run, ["git", "-C", worktree, "rev-list", "--count", f"{base}..HEAD"])
    try:
        return int(count)
    except ValueError:
        raise ToolFailure(
            f"`git rev-list --count {base}..HEAD` in {worktree} printed {count!r}, not a count"
        ) from None


def _nothing(branch: str, main: str, after: str = "") -> ToolFailure:
    return ToolFailure(
        f"nothing to land: {branch} has no commit beyond origin/{main}{after} — commit your "
        "work with change_commit first"
    )


async def land_check(run: Runner, worktree: str, main: str) -> str:
    """The synchronous step 1 of repo_land: committed, on a branch, and at
    least one commit beyond the machine's origin/<main>. Returns the branch."""
    await commit_check(run, worktree)
    branch = await _branch(run, worktree)
    if await _ahead(run, worktree, f"refs/remotes/origin/{main}") == 0:
        raise _nothing(branch, main)
    return branch


async def _rebase(
    run: Runner, worktree: str, branch: str, base: str, original: str, host: str
) -> Conflict | None:
    """Rebase her branch onto base in the worktree, as Nova and unsigned.
    None when it went through; a Conflict (aborted) when files conflicted; a
    ToolFailure (aborted) for any other failure."""
    argv = [
        "git",
        "-C",
        worktree,
        "-c",
        "user.name=Nova",
        "-c",
        f"user.email=nova@{host}",
        "-c",
        "commit.gpgsign=false",
        "rebase",
        base,
    ]
    ran = await run(argv)
    if ran.exit == 0:
        return None
    files: list[str] = []
    listing_error = ""
    try:
        files = sorted(
            {
                unquote(line)
                for line in await _listing(
                    run,
                    ["git", "-C", worktree, *_LISTING, "diff", "--name-only", "--diff-filter=U"],
                )
            }
        )
    except ToolFailure as exc:
        listing_error = str(exc)
    abort = await run(["git", "-C", worktree, "rebase", "--abort"])
    # The fact is where the branch is now, not what --abort printed (it fails
    # when the rebase never started, e.g. a refusing hook).
    head = await run(["git", "-C", worktree, "rev-parse", "HEAD"])
    on = await run(["git", "-C", worktree, "symbolic-ref", "--short", "-q", "HEAD"])
    if head.output.strip() != original or on.output.strip() != branch:
        said = abort.output.strip() or "(no output)"
        raise ToolFailure(
            f"rebasing {branch} onto origin failed and the abort did not put it back: "
            f"`git rebase --abort` exited {abort.exit}: {said} — {worktree} may be mid-rebase"
        )
    if listing_error:
        raise ToolFailure(f"rebasing {branch} stopped (aborted): {listing_error}")
    if files:
        return Conflict(base_sha=base, files=tuple(files))
    said = ran.output.strip() or "(no output)"
    raise ToolFailure(
        f"rebasing {branch} onto {base} failed (aborted; the branch is unchanged): "
        f"`{_quote(argv)}` exited {ran.exit}: {said}"
    )


async def _changed(
    run: Runner, worktree: str, base: str, sha: str
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    lines = await _listing(
        run, ["git", "-C", worktree, *_LISTING, *_DIFF, "--name-status", base, sha]
    )
    changed: set[str] = set()
    deleted: set[str] = set()
    for line in lines:
        status, sep, path = line.partition("\t")
        if not sep or not status:
            raise ToolFailure(f"`git diff --name-status {base} {sha}` printed {line!r}")
        (deleted if status[0] == "D" else changed).add(unquote(path))
    return tuple(sorted(changed)), tuple(sorted(deleted))


async def _patch(run: Runner, worktree: str, base: str, sha: str) -> tuple[str, bool]:
    ran = await _ok(run, ["git", "-C", worktree, *_LISTING, *_DIFF, base, sha])
    raw = ran.output.encode()
    if len(raw) <= PATCH_MAX:
        return ran.output, ran.truncated
    return raw[:PATCH_MAX].decode("utf-8", "ignore"), True


async def prepare(
    run: Runner, *, checkout: str, worktree: str, main: str, host: str
) -> Prepared | Conflict:
    """Spec §5.2 step 2: fetch main, rebase her branch onto it when it is
    behind (a conflict aborts and comes back as Conflict), and read what the
    landing judges — base and commit SHA, changed and deleted paths, the
    patch."""
    await commit_check(run, worktree)
    branch = await _branch(run, worktree)
    remote = f"refs/remotes/origin/{main}"
    await _ok(
        run,
        [
            "git",
            "-C",
            checkout,
            "fetch",
            "--no-tags",
            "origin",
            f"+refs/heads/{main}:{remote}",
        ],
    )
    base = await _value(
        run, ["git", "-C", checkout, "rev-parse", "--verify", f"{remote}^{{commit}}"]
    )
    original = await _value(run, ["git", "-C", worktree, "rev-parse", "HEAD"])
    behind = await run(["git", "-C", worktree, "merge-base", "--is-ancestor", base, "HEAD"])
    if behind.exit not in (0, 1):
        said = behind.output.strip() or "(no output)"
        raise ToolFailure(
            f"`git merge-base --is-ancestor {base} HEAD` in {worktree} exited {behind.exit}: {said}"
        )
    rebased = behind.exit == 1
    if rebased:
        conflict = await _rebase(run, worktree, branch, base, original, host)
        if conflict is not None:
            return conflict
    sha = await _value(run, ["git", "-C", worktree, "rev-parse", "HEAD"])
    if await _ahead(run, worktree, base) == 0:
        raise _nothing(branch, main, " once rebased onto it (its commits are already there)")
    changed, deleted = await _changed(run, worktree, base, sha)
    patch, cut = await _patch(run, worktree, base, sha)
    return Prepared(
        branch=branch,
        base_sha=base,
        commit_sha=sha,
        rebased=rebased,
        changed=changed,
        deleted=deleted,
        patch=patch,
        patch_truncated=cut,
    )


async def dirty_outside(run: Runner, checkout: str) -> tuple[list[str], bool]:
    """The checkout's own uncommitted and untracked paths (spec §5.2 step 7) —
    a flag, never a stop: it never raises for a dirty tree. The bool says the
    listing was cut (its partial last line is dropped)."""
    ran = await _ok(run, ["git", "-C", checkout, *_LISTING, *_STATUS])
    output = ran.output
    if ran.truncated and not output.endswith("\n"):
        output = output.rpartition("\n")[0]
    return _status_paths(_lines(output)), ran.truncated


# -- step 3: the clean copy (T6) ------------------------------------------------


@dataclass(frozen=True)
class Copy:
    """A landing's clean copy: `git archive <sha>` extracted at
    <checkout>/.worktrees/nova-<judge> — never a git worktree."""

    judge: str
    path: str


def _checkout(checkout: str) -> str:
    """The checkout as an absolute, normalised path that is not the root —
    the copy's path is built from it and later handed to `rm -rf`."""
    if (
        not isinstance(checkout, str)
        or not checkout.startswith("/")
        or checkout == "/"
        or checkout.startswith("//")  # normpath keeps a leading '//'
        or posixpath.normpath(checkout) != checkout
    ):
        raise ToolFailure(f"cannot: {checkout!r} is not an absolute, normalised checkout path")
    return checkout


def copy_path(checkout: str, judge: str) -> str:
    """<checkout>/.worktrees/nova-<judge>, after checking both parts' shape."""
    checkout = _checkout(checkout)
    if not isinstance(judge, str) or not _JUDGE.fullmatch(judge):
        raise ToolFailure(f"cannot: {judge!r} is not a judge id (6 lowercase hex)")
    return f"{checkout}/{code_repo.WORKTREES_DIR}/{code_repo.WORKTREE_PREFIX}{judge}"


async def _worktree_paths(run: Runner, checkout: str) -> set[str]:
    lines = await _listing(
        run, ["git", "-C", checkout, *_LISTING, "worktree", "list", "--porcelain"]
    )
    return {line[len(_WORKTREE_LINE) :] for line in lines if line.startswith(_WORKTREE_LINE)}


async def _exists(run: Runner, path: str) -> bool:
    ran = await run(["test", "-e", path])
    if ran.exit not in (0, 1):
        said = ran.output.strip() or "(no output)"
        raise ToolFailure(f"`test -e {path}` exited {ran.exit}: {said}")
    return ran.exit == 0


async def fresh_judge_id(run: Runner, checkout: str) -> str:
    """A 6-hex id no worktree path, no nova/<id>-* branch and no existing
    .worktrees/nova-<id> entry uses — the change ids' own rule, so the judge
    box (nova-box-<judge>) never meets a change's."""
    checkout = _checkout(checkout)
    paths = await _worktree_paths(run, checkout)
    branches = {
        line.strip()
        for line in await _listing(
            run,
            [
                "git",
                "-C",
                checkout,
                *_LISTING,
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/heads/",
            ],
        )
    }
    for _ in range(JUDGE_TRIES):
        # Looked up on the module at call time, never bound at import.
        candidate = changes.new_id()
        path = copy_path(checkout, candidate)
        if path in paths or any(b.startswith(f"nova/{candidate}-") for b in branches):
            continue
        if await _exists(run, path):
            continue
        return candidate
    raise ToolFailure(
        f"cannot: {JUDGE_TRIES} fresh judge ids were all already used by a worktree, a "
        f"nova/<id>-* branch or an entry in {checkout}/{code_repo.WORKTREES_DIR} — no copy was made"
    )


async def _export_attributes(run: Runner, checkout: str, sha: str) -> list[str]:
    """The .gitattributes files in the commit's tree that name export-ignore
    or export-subst. git archive obeys them (and --attr-source does not turn
    that off), so the copy would not be the commit: a file hidden from it is
    a test the judge never runs."""
    argv = [
        "git",
        "-C",
        checkout,
        *_LISTING,
        "grep",
        "--no-color",
        "-I",
        "-l",
        "-E",
        "export-(ignore|subst)",
        sha,
        "--",
        ":(glob)**/.gitattributes",
    ]
    ran = await run(argv)
    if ran.exit == 1:
        return []
    if ran.exit != 0:
        said = ran.output.strip() or "(no output)"
        raise ToolFailure(f"`{_quote(argv)}` exited {ran.exit}: {said}")
    prefix = f"{sha}:"
    return sorted(
        {
            unquote(line[len(prefix) :] if line.startswith(prefix) else line)
            for line in _lines(ran.output)
        }
    )


async def _discard(run: Runner, path: str) -> None:
    await run(["rm", "-rf", "--", path])
    await run(["rm", "-f", "--", f"{path}.tar"])


async def make_copy(run: Runner, *, checkout: str, sha: str) -> Copy:
    """Spec §5.2 step 3: `git archive <sha>` extracted into a fresh
    .worktrees/nova-<judge>. The worktree is never what is judged — an
    uncommitted file in it cannot reach the copy — and the copy is no git
    worktree, so nothing in it can commit and list_changes never shows it."""
    checkout = _checkout(checkout)
    if not isinstance(sha, str) or not _SHA.fullmatch(sha):
        raise ToolFailure(f"cannot: {sha!r} is not a commit SHA")
    hidden = await _export_attributes(run, checkout, sha)
    if hidden:
        raise ToolFailure(
            f"cannot judge {sha}: {', '.join(hidden)} names export-ignore or export-subst, so "
            "`git archive` would not copy the commit as it is (a file it hides is never "
            "judged) — remove those attributes and commit again"
        )
    await _ok(run, ["mkdir", "-p", "--", f"{checkout}/{code_repo.WORKTREES_DIR}"])
    judge = await fresh_judge_id(run, checkout)
    path = copy_path(checkout, judge)
    # mkdir without -p is the claim: it fails if the entry appeared meanwhile.
    await _ok(run, ["mkdir", "--", path], what="the clean copy")
    tar = f"{path}.tar"
    try:
        await _ok(
            run,
            ["git", "-C", checkout, "archive", "--format=tar", "-o", tar, sha],
            what="the clean copy",
        )
        await _ok(run, ["tar", "-xf", tar, "-C", path], what="the clean copy")
        await _ok(run, ["rm", "-f", "--", tar], what="the clean copy")
    except ToolFailure:
        await _discard(run, path)
        raise
    return Copy(judge=judge, path=path)


async def remove_copy(run: Runner, *, checkout: str, judge: str) -> None:
    """Remove a landing's copy and any tar it left. A path git names as a
    worktree is a change of hers, never a copy — refused. Checked after: a
    copy still there is a failure, never reported as removed."""
    path = copy_path(checkout, judge)
    if path in await _worktree_paths(run, checkout):
        raise ToolFailure(
            f"cannot: {path} is a git worktree (a change of hers), not a landing's copy — "
            "it was not removed"
        )
    await _ok(run, ["rm", "-rf", "--", path], what="removing the clean copy")
    await _ok(run, ["rm", "-f", "--", f"{path}.tar"], what="removing the clean copy")
    if await _exists(run, path):
        raise ToolFailure(f"removing the clean copy: {path} is still there after `rm -rf`")


# -- step 7: publishing a green landing (T9, spec §9.2) --------------------------


@dataclass(frozen=True)
class Published:
    """What a green landing's publish did. merged_sha is set only when the
    judged SHA is on origin's main; push_result says what happened, in every
    case."""

    merged_sha: str | None
    pr_url: str | None
    push_result: str


_PR_URL = re.compile(r"https://\S+/pull/\d+")
_BAD_REF = re.compile(r"[\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{|//")
_REJECTED = "[rejected]"


def repo_slug(url: str) -> str:
    """owner/repo from a remote URL — scp-like (git@host:owner/repo.git, an
    ssh alias host too), ssh://, https:// or a path; gh is handed it as
    --repo so it never guesses from the remotes."""
    text = (url or "").strip().rstrip("/")
    if text.endswith(".git"):
        text = text[: -len(".git")]
    if "://" in text:
        text = text.split("://", 1)[1]
        text = text.split("/", 1)[1] if "/" in text else ""
    elif ":" in text and not text.startswith("/"):
        text = text.split(":", 1)[1]
    parts = [part for part in text.split("/") if part]
    if len(parts) < 2:
        raise ToolFailure(f"cannot read owner/repo from origin's URL {url!r}")
    return f"{parts[-2]}/{parts[-1]}"


def _counts(su: dict) -> str:
    shown = [
        f"{su[key]} {key}"
        for key in ("passed", "failed", "skipped")
        if isinstance(su.get(key), int) and not isinstance(su.get(key), bool)
    ]
    seconds = su.get("seconds")
    if isinstance(seconds, (int, float)) and not isinstance(seconds, bool):
        shown.append(f"{seconds:g} s")
    return f" — {', '.join(shown)}" if shown else ""


def pr_body(*, landing_id: str, sha: str, suites: list[dict], protected: list[str]) -> str:
    """The PR's body: the landing's verdict as its row reads (spec §9.2)."""
    lines = [
        "Landed by Nova's `repo_land`: verdict **green**.",
        "",
        f"- Landing: `{landing_id}`",
        f"- Judged commit: `{sha}` (this exact SHA is what reaches main)",
        "",
        "Suites, run in a clean copy of the judged commit:",
        "",
    ]
    for su in suites:
        command = " ".join(str(word) for word in su.get("command") or [])
        lines.append(f"- {su.get('suite')}: `{command}` exit {su.get('exit')}{_counts(su)}")
    if not suites:
        lines.append("- (none recorded)")
    lines.append("")
    if protected:
        lines.append("Protected files touched (the tests that grade her):")
        lines.extend(f"- `{path}`" for path in protected)
    else:
        lines.append("Protected files touched: none")
    return "\n".join(lines) + "\n"


def _ref_problem(name: object, what: str) -> str:
    if not isinstance(name, str) or not name:
        return f"{what} {name!r} is not a branch name"
    if name.startswith(("-", "/", ".")) or name.endswith(("/", ".", ".lock")):
        return f"{what} {name!r} is not a branch name"
    if _BAD_REF.search(name):
        return f"{what} {name!r} is not a branch name"
    return ""


def _said(ran: Ran) -> str:
    return ran.output.strip() or "(no output)"


async def publish(
    run: Runner,
    *,
    verdict: str,
    checkout: str,
    branch: str,
    main: str,
    sha: str,
    landing_id: str,
    suites: list[dict],
    protected: list[str],
) -> Published:
    """Spec §5.2 step 7 / §9.2: a GREEN landing only. Push the judged SHA to
    her branch on origin, open a PR with the verdict, push that same SHA to
    origin's main (a plain push: fast-forward only, so a main that moved is
    refused and GitHub shows the PR merged with the SHA that was judged),
    then fast-forward the deploy checkout. Each step that fails stops there
    and is stated; nothing is merged that was not pushed to main. Never
    raises for a failing step — only for a verdict that is not green."""
    if verdict != "green":
        raise ValueError(f"only a green landing is published, not {verdict!r}")

    def stated(text: str, *, merged: str | None = None, pr: str | None = None) -> Published:
        return Published(merged_sha=merged, pr_url=pr, push_result=text)

    try:
        checkout = _checkout(checkout)
    except ToolFailure as exc:
        return stated(f"not published: {exc}")
    if not isinstance(sha, str) or not _SHA.fullmatch(sha):
        return stated(f"not published: {sha!r} is not a commit SHA")
    problem = _ref_problem(main, "main") or _ref_problem(branch, "branch")
    if not problem and branch == main:
        problem = f"branch {branch!r} is main itself — a landing lands a branch onto main"
    if problem:
        return stated(f"not published: {problem}")

    git = ["git", "-C", checkout]
    try:
        url = await _value(run, [*git, "remote", "get-url", "origin"])
        slug = repo_slug(url)
        title = await _value(run, [*git, "log", "-1", "--format=%s", sha])
    except ToolFailure as exc:
        return stated(f"not published: {exc}")
    title = title or f"Land {branch}"

    # 1. Her branch, at the judged SHA. The lease refuses to replace a branch
    #    someone else moved since this checkout last saw origin.
    branch_ref = f"refs/heads/{branch}"
    push = [*git, "push", f"--force-with-lease={branch_ref}", "origin", f"{sha}:{branch_ref}"]
    try:
        ran = await run(push)
    except ToolFailure as exc:
        return stated(f"not published: pushing {branch} failed: {exc}")
    if ran.exit != 0:
        return stated(
            f"not published: pushing {branch} failed: `{_quote(push)}` exited {ran.exit}: "
            f"{_said(ran)}"
        )

    # 2. The PR, with the verdict in its body.
    gh = [
        "gh",
        "pr",
        "create",
        "--repo",
        slug,
        "--base",
        main,
        "--head",
        branch,
        "--title",
        title,
        "--body",
        pr_body(landing_id=landing_id, sha=sha, suites=suites, protected=protected),
    ]
    pushed = f"{branch} was pushed; not merged"
    try:
        ran = await run(gh)
    except ToolFailure as exc:
        return stated(f"{pushed}: opening the PR failed: {exc}")
    found = _PR_URL.findall(ran.output)
    if ran.exit != 0 and not (found and "already exists" in ran.output):
        return stated(f"{pushed}: `gh pr create` exited {ran.exit}: {_said(ran)}")
    if not found:
        return stated(f"{pushed}: `gh pr create` printed no pull request URL: {_said(ran)}")
    pr = found[-1]
    opened = "reused the open PR" if ran.exit != 0 else "opened"

    # 3. Main, at the same SHA — fast-forward only.
    main_ref = f"refs/heads/{main}"
    push = [*git, "push", "origin", f"{sha}:{main_ref}"]
    try:
        ran = await run(push)
    except ToolFailure as exc:
        return stated(f"{branch} was pushed and {pr} {opened}; not merged: {exc}", pr=pr)
    if ran.exit != 0:
        lead = (
            "main moved during the landing; land again"
            if _REJECTED in ran.output
            else f"pushing {main} failed"
        )
        return stated(
            f"{branch} was pushed and {pr} {opened}; not merged — {lead}: "
            f"`{_quote(push)}` exited {ran.exit}: {_said(ran)}",
            pr=pr,
        )
    on_main = f"pushed {branch}, {opened} {pr}, {main} fast-forwarded to {sha}"

    # 4. The deploy checkout follows (it is what ./install deploys).
    def not_followed(why: str) -> Published:
        return stated(f"{on_main}; the deploy checkout did not follow: {why}", merged=sha, pr=pr)

    try:
        ran = await run([*git, "symbolic-ref", "--short", "-q", "HEAD"])
        if ran.exit != 0 or ran.output.strip() != main:
            where = ran.output.strip() if ran.exit == 0 else "a detached HEAD"
            return not_followed(f"{checkout} is on {where}, not {main}")
        merge = [*git, "merge", "--ff-only", sha]
        ran = await run(merge)
        if ran.exit != 0:
            return not_followed(f"`{_quote(merge)}` exited {ran.exit}: {_said(ran)}")
        head = await _value(run, [*git, "rev-parse", "HEAD"])
    except ToolFailure as exc:
        return not_followed(str(exc))
    if head != sha:
        return not_followed(f"its HEAD is {head}, not {sha}")
    return stated(f"{on_main}; the deploy checkout followed", merged=sha, pr=pr)


# -- repo_land's own git reads and the close step (T10) -------------------------

SUITES_TOML = "deploy/devbox/suites.toml"
_TRAILER_CODER = "%(trailers:key=Nova-Coder,valueonly)"


async def provenance(run: Runner, worktree: str) -> tuple[str, str, str | None]:
    """(HEAD's SHA, its author as `Name <email>`, its last Nova-Coder trailer
    or None) — what a landing row records as provenance. Never a gate."""
    sha = await _value(run, ["git", "-C", worktree, "rev-parse", "HEAD"])
    author = await _value(run, ["git", "-C", worktree, "log", "-1", "--format=%an <%ae>", sha])
    coders = await _listing(
        run, ["git", "-C", worktree, "log", "-1", f"--format={_TRAILER_CODER}", sha]
    )
    coder = coders[-1].strip() if coders else None
    return sha, author, coder or None


async def main_suites(run: Runner, *, checkout: str, base_sha: str) -> str:
    """deploy/devbox/suites.toml as MAIN has it at `base_sha` (the main the
    change was rebased onto) — never the change's own copy, so a change
    cannot choose its own suites or shorten the protected list. A missing
    file, or one cut at the agent's output limit, is a ToolFailure."""
    checkout = _checkout(checkout)
    if not isinstance(base_sha, str) or not _SHA.fullmatch(base_sha):
        raise ToolFailure(f"cannot: {base_sha!r} is not a commit SHA")
    argv = ["git", "-C", checkout, "show", f"{base_sha}:{SUITES_TOML}"]
    ran = await _ok(run, argv, what=f"reading main's {SUITES_TOML} at {base_sha}")
    if ran.truncated:
        raise ToolFailure(
            f"main's {SUITES_TOML} at {base_sha} was cut at the agent's output limit — "
            "a part of it is never planned from"
        )
    return ran.output


async def remove_worktree(
    run: Runner, *, checkout: str, worktree: str, force: bool = False
) -> None:
    """After a merge (spec §5.2 step 8): `git worktree remove` her worktree —
    never --force there, so an untracked file of hers is never deleted (git
    refuses and says so). close_change passes force=True: she asked to drop
    the change, and names what uncommitted work went (a locked worktree is
    still refused by git). Only <checkout>/.worktrees/nova-<6 hex> that git lists as a
    worktree; checked after: still there is a failure. Her branch is kept."""
    checkout = _checkout(checkout)
    name = posixpath.basename(worktree) if isinstance(worktree, str) else ""
    change = name[len(code_repo.WORKTREE_PREFIX) :]
    if (
        not isinstance(worktree, str)
        or not name.startswith(code_repo.WORKTREE_PREFIX)
        or not _JUDGE.fullmatch(change)
        or worktree != copy_path(checkout, change)
    ):
        raise ToolFailure(f"cannot: {worktree!r} is not a worktree of hers under {checkout}")
    if worktree not in await _worktree_paths(run, checkout):
        raise ToolFailure(f"cannot: {worktree} is not a git worktree — it was not removed")
    await _ok(
        run,
        ["git", "-C", checkout, "worktree", "remove", *(["--force"] if force else []), worktree],
        what=f"removing the worktree {worktree}",
    )
    if await _exists(run, worktree):
        raise ToolFailure(f"removing the worktree: {worktree} is still there")
