"""Her landing tools (S32.3; spec docs/plans/rebuild/s32/spec.md §5.2-§5.4).

repo_land(change) is §5.2: its step 1 runs in the call — the worktree is the
one DERIVED from the change id, its work is committed, and it has at least
one commit beyond origin/<main> — and any failure there is an Error with
nothing written. Then a `running` row is written (app/landings.py) and the
landing goes on in the background (app/landing_run.py: rebase, main's
suites, a clean copy judged in a fresh box, the verdict, the publish on
green, the close); the call returns the landing's id at once. Nothing here
decides whether she may land: a landing that cannot run says why.
"""

from __future__ import annotations

import posixpath
import re
import uuid
from dataclasses import dataclass

from app import code_repo, code_repos, db, landing_git, landing_run, landings
from app.tools import changes
from app.tools.base import RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure
from app.tools.devices import admit_row, box_name

REPO_LAND = "repo_land"


async def repo_land(args: dict, ctx: ToolContext) -> str:
    change = args["change"]
    # Checked here, before anything is sent: tools/schema.py does not read
    # `pattern`, and the id becomes part of a path on the machine.
    if not isinstance(change, str) or not changes._CHANGE_ID.fullmatch(change):
        raise ToolFailure(
            f"{change!r} is not a change id — it is the 6 hex after nova- in the worktree's "
            "name (list_changes names your open changes)"
        )
    row, repo = await code_repo.repo_machine(ctx.app)
    pool = await admit_row(row, ctx)
    if pool is None:
        raise ToolFailure(
            f"cannot: {row['name']} is a replayed machine — a landing needs its record in "
            "the database and a real box to judge in"
        )
    checkout = repo.rstrip("/") or "/"
    worktree = changes._worktree_of(checkout, change)
    listing = await changes._git(
        pool, row, ctx, ["git", "-C", checkout, "worktree", "list", "--porcelain"]
    )
    open_paths = {
        posixpath.normpath(entry["path"])
        for entry in changes._porcelain_entries(listing)
        if changes._is_hers(entry["path"], checkout)
    }
    if worktree not in open_paths:
        raise ToolFailure(
            f"no open change {change} on {row['name']}: {worktree} is not a worktree of yours "
            "— list_changes names your open changes"
        )
    running = (await landings.last_per_change(pool, [change])).get(change)
    if running is not None and running["verdict"] == "running":
        raise ToolFailure(
            f"landing {running['id']} of change {change} is still running — read it with "
            "landing_status; one change lands once at a time"
        )
    main = await changes._base(pool, row, ctx, checkout)
    run = landing_git.agent_runner(pool, row, ctx)
    branch = await landing_git.land_check(run, worktree, main)
    sha, author, coder = await landing_git.provenance(run, worktree)
    host = code_repo.repo_host()
    landing_id = await landings.insert(
        pool,
        change_id=change,
        repo=code_repos.NOVA,
        branch=branch,
        turn_id=ctx.turn_id,
        author=author,
        coder=coder,
        commit_sha=sha,
        stage="queued",
    )
    landing_run.start(
        pool,
        row,
        ctx,
        landing_id=landing_id,
        change=change,
        checkout=checkout,
        worktree=worktree,
        main=main,
        host=host,
        turn_id=ctx.turn_id,
    )
    # Filed in the CALL (the background task's ctx has no sink): a claim in
    # this turn that it landed is held to a running landing.
    _file(
        ctx,
        {"id": landing_id, "change_id": change, "verdict": "running", "merged_sha": None},
    )
    return (
        f"Landing {landing_id} started for change {change} ({branch} at {sha}) on "
        f"{row['name']}.\n"
        "It runs in the background: rebase onto origin/"
        f"{main}, a clean copy of the commit judged in a fresh box by main's suites, then — "
        f"only if green — a PR and the same commit on {main}, and the change's worktree and "
        "box closed. Red, could_not_measure or a conflict never merge; the change stays "
        "yours to fix.\n"
        f"The verdict is not known yet: read it with landing_status({landing_id})."
    )


REPO_LAND_TOOL = Tool(
    name=REPO_LAND,
    description=(
        "Land one of your changes on main: checks the change is committed (call change_commit "
        "first) and ahead of main, then returns a landing id at once while the landing runs in "
        "the background — rebase onto main, a clean copy of the commit judged by main's suites "
        "in a fresh box, and only on green a PR plus the same commit on main and the deploy "
        "checkout. The verdict comes later: read it with landing_status. Pass the change's "
        "6-hex id (from start_change or list_changes)."
    ),
    parameters={
        "type": "object",
        "properties": {
            "change": {
                "type": "string",
                "pattern": changes._CHANGE_SHAPE,
                "description": "The change's id: the 6 hex after nova- in its worktree's name.",
            }
        },
        "required": ["change"],
        "additionalProperties": False,
    },
    executor=repo_land,
    reads_only=False,
    ephemeral=False,
)


# -- landing_status and close_change (T11) --------------------------------------
#
# landing_status reads a landing back from its row — the record every claim
# about a landing is held to — and files a `landing` fact for each row it
# read (T13's `landed` and `tests_passed` claims read them). close_change
# takes a change down without landing it: its box, then its worktree; the
# branch is kept, so committed work is never lost.

LANDING_STATUS = "landing_status"
CLOSE_CHANGE = "close_change"
# How many landings landing_status lists when no id is given.
RECENT = 10
NO_LANDINGS = "No landing of yours yet."
_SHORT = 7


def landing_fact(row: dict) -> dict:
    """The `landing` fact for a landing row: what a claim about it is held
    to. Strings only (it is serialised with the turn's facts); merged_sha is
    None unless the row carries one — only a green, published landing does."""
    suites = row.get("suites") or []
    return {
        "landing": {
            "id": str(row["id"]),
            "change": row["change_id"],
            "verdict": row["verdict"],
            "merged_sha": row.get("merged_sha"),
            "suites": [
                {"suite": su.get("suite"), "exit": su.get("exit"), "outcome": su.get("outcome")}
                for su in suites
                if isinstance(su, dict)
            ],
        }
    }


def _file(ctx: ToolContext, row: dict) -> None:
    if ctx.facts_sink is not None:
        ctx.facts_sink.append(landing_fact(row))


def _when(value) -> str:
    return value.isoformat(timespec="seconds") if value is not None else "unknown"


def _argv_text(su: dict) -> str:
    argv = su.get("command")
    if isinstance(argv, (list, tuple)):
        return " ".join(str(a) for a in argv)
    return str(argv or "?")


def _suite_line(su: dict) -> str:
    exit_code = su.get("exit")
    parts = [str(su.get("outcome") or su.get("state") or "unknown")]
    parts.append(f"exit {exit_code}" if exit_code is not None else "no exit code")
    parts.extend(
        f"{su[key]} {key}"
        for key in ("passed", "failed", "skipped")
        if isinstance(su.get(key), int) and not isinstance(su.get(key), bool)
    )
    seconds = su.get("seconds")
    if isinstance(seconds, (int, float)) and not isinstance(seconds, bool):
        parts.append(f"{seconds:g} s")
    return f"- {su.get('suite')} `{_argv_text(su)}` — {', '.join(parts)}"


def _merge_line(row: dict) -> str:
    verdict = row["verdict"]
    if verdict == "green" and row.get("merged_sha"):
        return f"Merged: {row['merged_sha']} is on main"
    if verdict == "green" and row.get("push_result"):
        return f"Not merged: {row['push_result']}"
    if verdict == "green":
        return "Not merged: green, and its publish (branch, PR, main) has not finished yet"
    if verdict == "running":
        return "Not merged: the verdict is not known yet"
    return f"Not merged: a {verdict} landing never merges"


def _status_text(row: dict) -> str:
    verdict = row["verdict"]
    lines = [
        f"Landing {row['id']} — {verdict}",
        f"Change: {row['change_id']} (branch {row['branch']}, repo {row['repo']})",
        f"Started: {_when(row.get('created_at'))}"
        + (
            f"; finished {_when(row.get('finished_at'))}"
            if row.get("finished_at") is not None
            else "; still running"
        ),
    ]
    if verdict == "running":
        lines.append(f"Stage: {row.get('stage') or 'queued'}")
    if row.get("reason"):
        lines.append(f"Reason: {row['reason']}")
    lines.append(f"Base (main): {row.get('base_sha') or 'not known yet'}")
    lines.append(f"Judged commit: {row.get('commit_sha') or 'not known yet'}")
    lines.append(
        f"Author: {row.get('author') or 'not recorded'}; coder: "
        f"{row.get('coder') or 'not recorded'}"
    )
    lines.append(_merge_line(row))
    if row.get("pr_url"):
        lines.append(f"PR: {row['pr_url']}")
    if row.get("merged_sha") and row.get("push_result"):
        lines.append(f"Publish: {row['push_result']}")
    if row.get("conflict_files"):
        lines.append(f"Conflict in: {', '.join(row['conflict_files'])}")
    suites = [su for su in (row.get("suites") or []) if isinstance(su, dict)]
    if suites:
        lines.append("Suites:")
        for su in suites:
            lines.append(_suite_line(su))
            if su.get("outcome") != "passed":
                if su.get("why"):
                    lines.append(f"  why: {su['why']}")
                if su.get("tail"):
                    lines.append("  tail:")
                    lines.extend(f"    {line}" for line in str(su["tail"]).splitlines())
    else:
        lines.append("Suites: none ran yet" if verdict == "running" else "Suites: none ran")
    protected = row.get("protected") or []
    dirty = row.get("dirty_outside") or []
    lines.append(f"Protected files touched: {', '.join(protected) if protected else 'none'}")
    lines.append("Dirty in the checkout (never judged): " + (", ".join(dirty) if dirty else "none"))
    if row.get("patch_truncated"):
        lines.append("Stored patch: cut at its limit (repo_diff reads the full diff)")
    return "\n".join(lines)


def _listing_line(row: dict) -> str:
    merged = f", merged {row['merged_sha'][:_SHORT]}" if row.get("merged_sha") else ""
    return (
        f"- {row['id']} — change {row['change_id']} ({row['branch']}) — "
        f"{row['verdict']}{merged} — started {_when(row.get('created_at'))}"
    )


async def landing_status(args: dict, ctx: ToolContext) -> str:
    pool = await db.get_pool()
    wanted = args.get("id")
    if wanted is None:
        total = await pool.fetchval("SELECT count(*) FROM landings")
        rows = [
            dict(r)
            for r in await pool.fetch(
                "SELECT * FROM landings ORDER BY created_at DESC, id LIMIT $1", RECENT
            )
        ]
        if not rows:
            return NO_LANDINGS
        for row in rows:
            _file(ctx, row)
        return "\n".join(
            [
                f"Your latest {len(rows)} landings (of {total}), newest first — "
                "landing_status(id) reads one in full:",
                *(_listing_line(row) for row in rows),
            ]
        )
    try:
        landing_id = uuid.UUID(wanted.strip()) if isinstance(wanted, str) else None
    except ValueError:
        landing_id = None
    if landing_id is None:
        raise ToolFailure(
            f"{wanted!r} is not a landing id — repo_land returned it; landing_status with "
            "no id lists your latest landings"
        )
    row = await landings.get(pool, landing_id)
    if row is None:
        raise ToolFailure(
            f"no landing {landing_id} — landing_status with no id lists your latest landings"
        )
    _file(ctx, row)
    return _status_text(row)


LANDING_STATUS_TOOL = Tool(
    name=LANDING_STATUS,
    description=(
        "Read one of your landings back from its record: its verdict (running, green, red, "
        "could_not_measure or conflict), where a running one is, each suite's command, exit "
        "and counts (the tail of one that did not pass), the merged SHA and PR of a green one, "
        "the protected files it touched and the checkout's own uncommitted files. Pass the id "
        "repo_land returned; with no id it lists your latest landings."
    ),
    parameters={
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": "The landing's id, as repo_land returned it. Omit to list.",
            }
        },
        "additionalProperties": False,
    },
    executor=landing_status,
    reads_only=True,
    ephemeral=True,
    result_kind=RESULT_KIND_LISTING,
)


async def close_change(args: dict, ctx: ToolContext) -> str:
    change = args["change"]
    if not isinstance(change, str) or not changes._CHANGE_ID.fullmatch(change):
        raise ToolFailure(
            f"{change!r} is not a change id — it is the 6 hex after nova- in the worktree's "
            "name (list_changes names your open changes)"
        )
    row, repo = await code_repo.repo_machine(ctx.app)
    pool = await admit_row(row, ctx)
    if pool is None:
        raise ToolFailure(
            f"cannot: {row['name']} is a replayed machine — closing a change needs its "
            "landing record and a real box to remove"
        )
    checkout = repo.rstrip("/") or "/"
    worktree = changes._worktree_of(checkout, change)
    listing = await changes._git(
        pool, row, ctx, ["git", "-C", checkout, "worktree", "list", "--porcelain"]
    )
    entries = {
        posixpath.normpath(entry["path"]): entry
        for entry in changes._porcelain_entries(listing)
        if changes._is_hers(entry["path"], checkout)
    }
    entry = entries.get(worktree)
    if entry is None:
        raise ToolFailure(
            f"no open change {change} on {row['name']}: {worktree} is not a worktree of yours "
            "— list_changes names your open changes"
        )
    last = (await landings.last_per_change(pool, [change])).get(change)
    if last is not None and last["verdict"] == "running":
        raise ToolFailure(
            f"landing {last['id']} of change {change} is still running in its worktree — "
            "read it with landing_status; close the change once it has finished"
        )
    run = landing_git.agent_runner(pool, row, ctx)
    try:
        lines = await landing_git._listing(
            run, ["git", "-C", worktree, *landing_git._LISTING, *landing_git._STATUS]
        )
    except ToolFailure as exc:
        discarded = (
            "what uncommitted work it held could not be read before it was removed: "
            + " ".join(str(exc).split())
        )
    else:
        files = landing_git._status_paths(lines)
        discarded = (
            f"uncommitted work discarded: {', '.join(files)}"
            if files
            else "nothing uncommitted was discarded"
        )

    box = box_name(change)
    done: list[str] = []
    failed: list[str] = []
    why = await changes.remove_box(pool, row, ctx, change)
    if why:
        failed.append(f"the box {box} was not removed: {why}")
    else:
        done.append(f"the box {box} removed")
    try:
        await landing_git.remove_worktree(run, checkout=checkout, worktree=worktree, force=True)
    except ToolFailure as exc:
        failed.append(f"the worktree {worktree} was not removed: {' '.join(str(exc).split())}")
    else:
        done.append(f"the worktree {worktree} removed ({discarded})")
    branch = entry["branch"] or "detached"
    head = entry["head"] or "unknown"
    kept = (
        f"Branch {branch} kept at {head[:_SHORT]}."
        if entry["branch"]
        else (f"It was detached at {head[:_SHORT]}; no branch to keep.")
    )
    if failed:
        raise ToolFailure(
            f"change {change} on {row['name']} was not fully closed: "
            + "; ".join(failed)
            + (f". Done: {'; '.join(done)}." if done else ". Nothing was removed.")
            + f" {kept}"
        )
    return (
        f"Closed change {change} on {row['name']} without landing it: "
        + "; ".join(done)
        + f".\n{kept}"
    )


CLOSE_CHANGE_TOOL = Tool(
    name=CLOSE_CHANGE,
    description=(
        "Close one of your changes without landing it: removes the change's box (and its "
        "database) and its worktree on the machine that holds your repository. Its branch is "
        "kept, so committed work stays; uncommitted work in the worktree is discarded and "
        "named. Pass the change's 6-hex id (from start_change or list_changes)."
    ),
    parameters={
        "type": "object",
        "properties": {
            "change": {
                "type": "string",
                "pattern": changes._CHANGE_SHAPE,
                "description": "The change's id: the 6 hex after nova- in its worktree's name.",
            }
        },
        "required": ["change"],
        "additionalProperties": False,
    },
    executor=close_change,
    reads_only=False,
    ephemeral=False,
)


# -- repo_diff and stack_status (T12) -------------------------------------------
#
# Two reads on the machine that holds her repository, through its agent.
# repo_diff is her COMMITTED work — what repo_land would judge — against the
# merge base of her HEAD with origin/<main> as last fetched: three-dot, so
# main's own later commits are never shown as hers, and nothing is fetched (a
# read changes nothing). stack_status reads the running containers' image
# labels (spec §6) and holds them to main's head. Neither presents a partial
# read as whole: a cut listing refuses, a cut diff says which files it did not
# reach.

REPO_DIFF = "repo_diff"
STACK_STATUS = "stack_status"
# The most of one file's diff repo_diff(path) shows, cut on a line boundary.
DIFF_SHOW = 16 * 1024
# The most hunk ranges named for one file; the rest are counted.
RANGES_SHOWN = 20
_FULL = 12
_HUNK = re.compile(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
_STATUS_WORDS = {"A": "added", "M": "modified", "D": "deleted", "T": "type changed"}
_CUT_RANGES = "ranges not read (the diff was cut at the agent's output limit)"
# The owner's diff.noprefix / diff.mnemonicPrefix / diff.relative never
# change what is parsed.
_PREFIXES = ("--src-prefix=a/", "--dst-prefix=b/", "--no-relative")


def _diff_argv(worktree: str, base: str, head: str, *extra: str) -> list[str]:
    return [
        "git",
        "-C",
        worktree,
        *landing_git._LISTING,
        *landing_git._DIFF,
        *extra,
        base,
        head,
    ]


def _header_path(rest: str, prefix: str) -> str | None:
    # git ends a ---/+++ name holding a space with a tab (for GNU patch).
    if rest.endswith("\t"):
        rest = rest[:-1]
    if rest == "/dev/null":
        return None
    name = landing_git.unquote(rest)
    return name[len(prefix) :] if name.startswith(prefix) else name


def parse_hunks(output: str, *, cut: bool) -> dict[str, list[tuple[int, int]]]:
    """New-side (start, length) ranges per file from a `git diff -U0`, for
    every file read whole — all of them unless the output was cut, when the
    file being read at the cut (and every file after it) is left out.

    A hunk's body is consumed by COUNT (its header's old and new lengths), so
    a body line such as `+++ x` or `--- y` is never read as a header."""
    lines = output.split("\n")
    if cut:
        lines = lines[:-1]  # the partial last line
    done: dict[str, list[tuple[int, int]]] = {}
    path: str | None = None
    old_path: str | None = None
    ranges: list[tuple[int, int]] = []
    old_left = new_left = 0
    for line in lines:
        if old_left or new_left:
            if line.startswith("\\"):
                continue
            if line.startswith("-") and old_left:
                old_left -= 1
                continue
            if line.startswith("+") and new_left:
                new_left -= 1
                continue
            raise ToolFailure(
                f"`git diff -U0` printed {line!r} inside a hunk — the diff could not be read"
            )
        if line.startswith("diff --git "):
            if path is not None:
                done[path] = ranges
            path, old_path, ranges = None, None, []
        elif line.startswith("--- "):
            old_path = _header_path(line[4:], "a/")
        elif line.startswith("+++ "):
            new = _header_path(line[4:], "b/")
            path = new if new is not None else old_path
        elif line.startswith("@@ ") and path is not None:
            hunk = _HUNK.match(line)
            if hunk is None:
                raise ToolFailure(f"`git diff -U0` printed {line!r}, not a hunk header")
            old_left = int(hunk[2]) if hunk[2] is not None else 1
            new_left = int(hunk[4]) if hunk[4] is not None else 1
            ranges.append((int(hunk[3]), new_left))
    if path is not None and not cut:
        done[path] = ranges
    return done


def _range_words(start: int, length: int) -> str:
    if length == 0:
        return f"removed after line {start}" if start else "removed at the top"
    if length == 1:
        return f"line {start}"
    return f"lines {start}-{start + length - 1}"


def _ranges_text(ranges: list[tuple[int, int]]) -> str:
    words = [_range_words(start, length) for start, length in ranges[:RANGES_SHOWN]]
    if len(ranges) > RANGES_SHOWN:
        words.append(f"and {len(ranges) - RANGES_SHOWN} more")
    return ", ".join(words)


def _file_line(
    path: str,
    status: str,
    counts: tuple[int, int] | None,
    ranges: list[tuple[int, int]] | None,
) -> str:
    word = _STATUS_WORDS.get(status, f"status {status}")
    if counts is None:
        return f"- {path} — {word}, binary (no line counts)"
    line = f"- {path} — {word}, +{counts[0]} -{counts[1]}"
    if status == "D":
        return line
    if ranges is None:
        return f"{line} — {_CUT_RANGES}"
    return f"{line} — {_ranges_text(ranges)}" if ranges else line


async def _name_status(run, worktree: str, base: str, head: str) -> list[tuple[str, str]]:
    files: list[tuple[str, str]] = []
    for line in await landing_git._listing(run, _diff_argv(worktree, base, head, "--name-status")):
        status, sep, name = line.partition("\t")
        if not sep or not status:
            raise ToolFailure(f"`git diff --name-status {base} {head}` printed {line!r}")
        files.append((landing_git.unquote(name), status[0]))
    return files


async def _numstat(run, worktree: str, base: str, head: str) -> dict:
    counts: dict[str, tuple[int, int] | None] = {}
    for line in await landing_git._listing(run, _diff_argv(worktree, base, head, "--numstat")):
        parts = line.split("\t", 2)
        if len(parts) != 3:
            raise ToolFailure(f"`git diff --numstat {base} {head}` printed {line!r}")
        added, removed, name = parts
        name = landing_git.unquote(name)
        if added == "-" and removed == "-":
            counts[name] = None
        elif added.isdigit() and removed.isdigit():
            counts[name] = (int(added), int(removed))
        else:
            raise ToolFailure(f"`git diff --numstat {base} {head}` printed {line!r}")
    return counts


def _bounded(output: str, truncated: bool) -> tuple[str, str]:
    """(what is shown, the cut note or ''): at most DIFF_SHOW bytes, cut on a
    line boundary; output the agent cut is never shown as whole."""
    raw = output.encode()
    if len(raw) <= DIFF_SHOW and not truncated:
        return output.rstrip("\n"), ""
    part = raw[:DIFF_SHOW]
    if len(raw) > DIFF_SHOW or not part.endswith(b"\n"):
        part = part[: part.rfind(b"\n") + 1]
    shown = part.decode("utf-8", "ignore").rstrip("\n")
    if len(raw) > DIFF_SHOW:
        return shown, (
            f"[cut here: this file's diff is longer than {DIFF_SHOW // 1024} KiB — only its "
            "first part is shown]"
        )
    return shown, "[cut here: the agent's output limit cut this file's diff]"


async def diff_text(run, *, worktree: str, main: str, branch: str, path: str | None = None) -> str:
    """The change in `worktree` against origin/<main>'s merge base: by file
    with ranges, or — with `path`, one of its files — that file's diff."""
    change = posixpath.basename(worktree)[len(code_repo.WORKTREE_PREFIX) :]
    remote = f"refs/remotes/origin/{main}"
    base = await landing_git._value(run, ["git", "-C", worktree, "merge-base", remote, "HEAD"])
    head = await landing_git._value(run, ["git", "-C", worktree, "rev-parse", "HEAD"])
    ahead = await landing_git._ahead(run, worktree, base)
    files = await _name_status(run, worktree, base, head)
    uncommitted = landing_git._status_paths(
        await landing_git._listing(
            run, ["git", "-C", worktree, *landing_git._LISTING, *landing_git._STATUS]
        )
    )
    if path is not None:
        status = dict(files).get(path)
        if status is None:
            named = ", ".join(name for name, _ in files) or "none — it has no committed change"
            raise ToolFailure(
                f"{path!r} is not a file of change {change} — its files against {main}: {named}"
            )
        ran = await landing_git._ok(
            run, [*_diff_argv(worktree, base, head, "-U3", *_PREFIXES), "--", f":(literal){path}"]
        )
        shown, note = _bounded(ran.output, ran.truncated)
        lines = [
            f"{path} ({_STATUS_WORDS.get(status, f'status {status}')}) against base {base} "
            f"(HEAD {head}):",
            shown,
        ]
        if note:
            lines.append(note)
        if path in uncommitted:
            lines.append(
                "This file also has uncommitted edits in the worktree, NOT shown "
                "(change_commit first)."
            )
        return "\n".join(lines)

    plural = "commit" if ahead == 1 else "commits"
    lines = [
        f"Base: {base} (where {branch} left origin/{main}, as last fetched); HEAD {head}; "
        f"{ahead} {plural} beyond it."
    ]
    if not files:
        lines.append(
            f"No committed change against {main}: {branch} has no commit beyond {base[:_FULL]}."
            if ahead == 0
            else f"No committed change against {main}: its {ahead} {plural} change no file."
        )
    else:
        counts = await _numstat(run, worktree, base, head)
        ran = await landing_git._ok(run, _diff_argv(worktree, base, head, "-U0", *_PREFIXES))
        hunks = parse_hunks(ran.output, cut=ran.truncated)
        lines.append(f"Files ({len(files)}):")
        for name, status in files:
            if name not in counts:
                raise ToolFailure(
                    f"`git diff --name-status` named {name!r} but `git diff --numstat` did not "
                    "— the diff could not be read"
                )
            ranges = hunks.get(name, None if ran.truncated else [])
            lines.append(_file_line(name, status, counts[name], ranges))
    if uncommitted:
        lines.append(
            "Uncommitted, NOT in this diff (change_commit first): " + ", ".join(uncommitted)
        )
    else:
        lines.append("Nothing uncommitted.")
    if files:
        lines.append("repo_diff with path (one of these files) shows that file's diff.")
    return "\n".join(lines)


async def repo_diff(args: dict, ctx: ToolContext) -> str:
    change = args["change"]
    if not isinstance(change, str) or not changes._CHANGE_ID.fullmatch(change):
        raise ToolFailure(
            f"{change!r} is not a change id — it is the 6 hex after nova- in the worktree's "
            "name (list_changes names your open changes)"
        )
    row, repo = await code_repo.repo_machine(ctx.app)
    pool = await admit_row(row, ctx)
    checkout = repo.rstrip("/") or "/"
    worktree = changes._worktree_of(checkout, change)
    listing = await changes._git(
        pool, row, ctx, ["git", "-C", checkout, "worktree", "list", "--porcelain"]
    )
    entry = next(
        (
            e
            for e in changes._porcelain_entries(listing)
            if changes._is_hers(e["path"], checkout) and posixpath.normpath(e["path"]) == worktree
        ),
        None,
    )
    if entry is None:
        raise ToolFailure(
            f"no open change {change} on {row['name']}: {worktree} is not a worktree of yours "
            "— list_changes names your open changes"
        )
    main = await changes._base(pool, row, ctx, checkout)
    branch = entry["branch"] or f"its detached HEAD {entry['head'][:_SHORT]}"
    text = await diff_text(
        landing_git.agent_runner(pool, row, ctx),
        worktree=worktree,
        main=main,
        branch=branch,
        path=args.get("path"),
    )
    return f"Change {change} ({branch}) on {row['name']} against {main}:\n{text}"


REPO_DIFF_TOOL = Tool(
    name=REPO_DIFF,
    description=(
        "Read one of your changes' committed diff against main, file by file: each file "
        "added, modified or deleted, its +/- line counts and the line ranges it changed; "
        "uncommitted work in the worktree is named as not included (change_commit first). "
        "Pass the change's 6-hex id; add path (one of its files) to read that file's diff."
    ),
    parameters={
        "type": "object",
        "properties": {
            "change": {
                "type": "string",
                "pattern": changes._CHANGE_SHAPE,
                "description": "The change's id: the 6 hex after nova- in its worktree's name.",
            },
            "path": {
                "type": "string",
                "description": (
                    "One of the change's files, repo-relative, to read its diff. Omit for the "
                    "summary."
                ),
            },
        },
        "required": ["change"],
        "additionalProperties": False,
    },
    executor=repo_diff,
    reads_only=True,
    ephemeral=True,
    result_kind=RESULT_KIND_LISTING,
)


# Each service's image is built from these paths of the checkout — install.sh's
# service_source_paths over SERVICE_BUILDS, in its order (a test pins the
# parity). A clean tree's content hash IS the tree hash of the path.
SERVICE_SOURCES = {
    "core": "services/core",
    "gateway": "services/gateway",
    "memory": "services/memory",
    "web": "apps/web",
}
# The stack's compose project directory under the checkout (install.sh's
# DEPLOY_DIR: compose runs -f deploy/docker-compose.yml).
DEPLOY_DIR = "deploy"
HASH_LABEL = "nova.content-hash"
SHA_LABEL = "nova.build-sha"
_SERVICE_LABEL = "com.docker.compose.service"
_DIR_LABEL = "com.docker.compose.project.working_dir"
_PS_FORMAT = "\t".join(
    (
        f'{{{{.Label "{_SERVICE_LABEL}"}}}}',
        f'{{{{.Label "{_DIR_LABEL}"}}}}',
        "{{.State}}",
        f'{{{{.Label "{SHA_LABEL}"}}}}',
        f'{{{{.Label "{HASH_LABEL}"}}}}',
        "{{.Names}}",
    )
)


@dataclass(frozen=True)
class _Container:
    state: str
    sha: str
    content: str
    name: str


def _container_line(svc: str, path: str, c: _Container, want: str | None, head: str) -> str:
    if not c.sha:
        built = f"no {SHA_LABEL} label"
    elif c.sha == head:
        built = f"built from {c.sha[:_FULL]} (main's head)"
    else:
        built = f"built from {c.sha[:_FULL]}"
    lead = f"- {svc} ({c.name}) — {c.state}, {built}"
    if not c.content:
        return (
            f"{lead} — no {HASH_LABEL} label (built outside ./install), so whether it runs "
            "main's source is not known"
        )
    content = f"content {c.content[:_FULL]}"
    if want is None:
        return f"{lead} — {content}: main has no {path}"
    if c.state != "running":
        return f"{lead} — {content}: not running"
    if c.content == want:
        return f"{lead} — {content}: same as main"
    return f"{lead} — {content}: differs from main (main's {path} is {want[:_FULL]})"


async def stack_text(run, *, checkout: str, main: str) -> str:
    """Each service's containers of THIS checkout's stack (compose working_dir
    == <checkout>/deploy), held to origin/<main>'s head as last fetched."""
    remote = f"refs/remotes/origin/{main}"
    head = await landing_git._value(
        run, ["git", "-C", checkout, "rev-parse", "--verify", f"{remote}^{{commit}}"]
    )
    wants: dict[str, str | None] = {}
    for svc, path in SERVICE_SOURCES.items():
        argv = ["git", "-C", checkout, "rev-parse", "--verify", "-q", f"{head}:{path}"]
        ran = await run(argv)
        if ran.exit == 0:
            wants[svc] = ran.output.strip()
        elif ran.exit == 1:
            wants[svc] = None
        else:
            said = ran.output.strip() or "(no output)"
            raise ToolFailure(f"`{' '.join(argv)}` exited {ran.exit}: {said}")
    deploy = posixpath.join(checkout, DEPLOY_DIR)
    listing = await landing_git._listing(
        run,
        ["docker", "ps", "--all", "--filter", f"label={_SERVICE_LABEL}", "--format", _PS_FORMAT],
    )
    mine: dict[str, list[_Container]] = {}
    elsewhere: set[str] = set()
    for line in listing:
        fields = [field.strip() for field in line.split("\t")]
        if len(fields) != 6:
            raise ToolFailure(
                f"`docker ps` printed {line!r}, not the six fields it was asked for — the "
                "stack's state is not read from it"
            )
        svc, where, state, sha, content, name = fields
        if posixpath.normpath(where) != deploy:
            if svc in SERVICE_SOURCES and where:
                elsewhere.add(where)
            continue
        mine.setdefault(svc, []).append(
            _Container(state=state, sha=sha, content=content, name=name)
        )
    lines = [f"The stack of {checkout} against origin/{main} {head} (as last fetched):"]
    on_main = 0
    for svc, path in SERVICE_SOURCES.items():
        want = wants[svc]
        containers = mine.get(svc, [])
        if not containers:
            lines.append(f"- {svc} — not running: no container of this stack")
        for c in containers:
            lines.append(_container_line(svc, path, c, want, head))
        if any(c.state == "running" and want and c.content == want for c in containers):
            on_main += 1
    if not any(svc in mine for svc in SERVICE_SOURCES) and elsewhere:
        lines.append(
            f"No container of this checkout's stack ({deploy}) was found; containers of these "
            f"services run from: {', '.join(sorted(elsewhere))}."
        )
    lines.append(f"{on_main} of {len(SERVICE_SOURCES)} services run main's source.")
    return "\n".join(lines)


async def stack_status(args: dict, ctx: ToolContext) -> str:
    row, repo = await code_repo.repo_machine(ctx.app)
    pool = await admit_row(row, ctx)
    checkout = repo.rstrip("/") or "/"
    main = await changes._base(pool, row, ctx, checkout)
    text = await stack_text(landing_git.agent_runner(pool, row, ctx), checkout=checkout, main=main)
    return f"On {row['name']}: {text}"


STACK_STATUS_TOOL = Tool(
    name=STACK_STATUS,
    description=(
        "Read which code the running Nova stack is on: for core, gateway, memory and web, "
        "each container's state, the commit it was built from and its content hash (from "
        "its image labels), held against main's head and main's own hash of that service's "
        "source — same as main, differs, not running, or not known. Use it after a landing "
        "to see whether the deploy caught up."
    ),
    parameters={"type": "object", "properties": {}, "additionalProperties": False},
    executor=stack_status,
    reads_only=True,
    ephemeral=True,
    result_kind=RESULT_KIND_LISTING,
)


# S32.3 T13 (2026-10-13): her landing step, registered (tools/__init__). The
# commit is changes.CHANGE_COMMIT_TOOL, registered with the change tools.
TOOLS: tuple[Tool, ...] = (
    REPO_LAND_TOOL,
    LANDING_STATUS_TOOL,
    REPO_DIFF_TOOL,
    CLOSE_CHANGE_TOOL,
    STACK_STATUS_TOOL,
)
