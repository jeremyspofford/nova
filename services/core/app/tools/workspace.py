"""The four filesystem tools, and the boundary they may never leave.

Everything here happens inside WORKSPACE_ROOT (a dedicated docker volume
in the running stack, `v4_workspace`, mounted at /data/workspace). The
containment gate is the same one the memory service's store uses: resolve
the path and require the REALPATH to stay under the root. That single
check covers traversal (`..` collapses during resolve()), absolute
escapes (`Path('/root') / '/etc/passwd'` is just `/etc/passwd`, which
plainly fails the prefix test) and symlinks pointing outside (resolve()
dereferences the ones that already exist on disk before the check runs).
It is never a string comparison.

Writes are atomic — tmp file in the same directory, fsync, os.replace —
and then VERIFIED: the file is stat'ed and its size compared against what
was meant to land before this reports a single byte written. os.replace
returning without raising is not evidence that the file is there.

Deletes are the same shape read backwards. The path moves, with one
os.replace, into TRASH_DIR under the same root, and the result is reported
only after BOTH halves are checked — the path is gone, and the file is in
the trash. She has claimed a deletion she never made before; the trash is
what makes that claim checkable afterwards, and the two-ended verification
is what stops this function making it.
"""
from __future__ import annotations

import contextlib
import os
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from app.tools.base import RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure

WORKSPACE_ROOT_ENV = "WORKSPACE_ROOT"
DEFAULT_WORKSPACE_ROOT = "/data/workspace"

# 256 KB in, 32 KB out. The write cap keeps a runaway generation from
# filling the volume; the read cap keeps a big file from eating the whole
# context window on one tool result. Both are stated when they bite —
# silent truncation would have the model believe it read a whole file.
MAX_WRITE_BYTES = 256 * 1024
MAX_READ_BYTES = 32 * 1024
MAX_LIST_ENTRIES = 200

# Delete is the only irreversible shape in this toolset, so it is not a
# deletion: the path is moved, atomically, into a trash directory under the
# same root, where nothing else in the system can see it and a week is long
# enough for the owner to notice a mistake. The window is pruned by the next
# delete rather than by a job — a directory nobody ever deletes from does not
# need sweeping, and a scheduled sweep is one more thing that can die quietly.
TRASH_DIR = ".trash"
TRASH_KEEP_DAYS = 7
TRASH_STAMP_FORMAT = "%Y%m%dT%H%M%SZ"


def root_from_env() -> Path:
    return Path(os.environ.get(WORKSPACE_ROOT_ENV) or DEFAULT_WORKSPACE_ROOT)


def _resolve_within(root: Path, rel: str) -> Path:
    """The one gate. See the module docstring for why this covers all three
    escape shapes; the failure names the reason back to the model so it can
    correct the call rather than guess."""
    if not rel.strip():
        raise ToolFailure("the path is empty — name a file inside the workspace")
    resolved = (root / rel).resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError:
        raise ToolFailure(
            f"{rel!r} resolves outside the workspace — every path must stay inside it"
        ) from None
    return resolved


def _display(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix() or "."
    except ValueError:  # pragma: no cover - _resolve_within already forbids this
        return str(path)


def _atomic_write(path: Path, data: bytes) -> None:
    """Same shape as the memory service's store: a crash anywhere in here
    leaves the previous file (or no file), never a half-written one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise


async def write_file(args: dict, ctx: ToolContext) -> str:
    root = ctx.workspace_root.resolve()
    data = args["content"].encode("utf-8")
    if len(data) > MAX_WRITE_BYTES:
        # Refused whole, never trimmed to fit: a file the model believes it
        # wrote in full but which stops mid-sentence is a worse outcome than
        # a refusal it can act on.
        raise ToolFailure(
            f"the content is {len(data)} bytes, over the {MAX_WRITE_BYTES}-byte limit "
            "for one file — write less, or split it across files"
        )

    path = _resolve_within(root, args["path"])
    if path.is_dir():
        raise ToolFailure(f"{_display(root, path)!r} is a directory, not a file")

    try:
        _atomic_write(path, data)
    except OSError as exc:
        raise ToolFailure(f"could not write {_display(root, path)} — {exc}") from exc

    # Verify before reporting. Anything short of "the file is there and it
    # is the size it should be" is a failure with the reason stated.
    if not path.is_file():
        raise ToolFailure(
            f"the write of {_display(root, path)} did not verify — the file is not there "
            "afterwards"
        )
    landed = path.stat().st_size
    if landed != len(data):
        raise ToolFailure(
            f"the write of {_display(root, path)} did not verify — {landed} bytes on disk, "
            f"{len(data)} expected"
        )
    return f"Wrote {_display(root, path)} ({landed} bytes)"


async def read_file(args: dict, ctx: ToolContext) -> str:
    root = ctx.workspace_root.resolve()
    path = _resolve_within(root, args["path"])
    if path.is_dir():
        raise ToolFailure(
            f"{_display(root, path)!r} is a directory — use workspace_list_files for it"
        )
    if not path.is_file():
        raise ToolFailure(f"there is no file at {_display(root, path)!r} in the workspace")

    try:
        data = path.read_bytes()
    except OSError as exc:
        raise ToolFailure(f"could not read {_display(root, path)} — {exc}") from exc

    if len(data) <= MAX_READ_BYTES:
        return data.decode("utf-8", errors="replace")
    # errors="replace" because the cut lands mid-character on any multi-byte
    # file; a replacement character is honest about that, an exception here
    # would say "unreadable file" about a perfectly readable one.
    head = data[:MAX_READ_BYTES].decode("utf-8", errors="replace")
    return f"{head}\n[truncated: file is {len(data)} bytes]"


def iter_contained_files(root: Path, base: Path):
    """Every real file under `base`, sorted, with symlinks refused rather
    than followed. Not a string check: a symlink is skipped outright, and
    every remaining candidate still has its realpath resolved and checked
    against `root` before it is trusted, so a link cannot smuggle a file
    from outside the root into the result. This is the second half of the
    module's one gate (see the module docstring) — `_resolve_within`
    contains a single caller-supplied path, this contains a directory
    walk — and it is exported so a read-only consumer of the workspace
    (the operator's Files viewer, app/workspace_api.py) can list it without
    re-deriving the same check.

    It also skips the trash. A deleted file is gone as far as every reader of
    the workspace is concerned — her listing tool and the operator's Files
    page both come through here, so neither needs its own rule and neither can
    drift from the other.
    """
    trash = root / TRASH_DIR
    for path in sorted(base.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        if path == trash or trash in path.parents:
            continue
        try:
            path.resolve(strict=True).relative_to(root)
        except (ValueError, OSError):
            continue
        yield path


async def list_files(args: dict, ctx: ToolContext) -> str:
    root = ctx.workspace_root.resolve()
    requested = args.get("path") or ""
    base = _resolve_within(root, requested) if requested.strip() else root
    label = _display(root, base) if base != root else "the workspace root"

    if not base.is_dir():
        if base == root:
            # Nothing has ever been written to the volume. That is an empty
            # workspace, not a broken one.
            return f"No files under {label} yet."
        raise ToolFailure(f"there is no directory at {requested!r} in the workspace")

    entries: list[tuple[str, int]] = [
        (_display(root, path), path.stat().st_size) for path in iter_contained_files(root, base)
    ]

    if not entries:
        return f"No files under {label} yet."

    shown = entries[:MAX_LIST_ENTRIES]
    plural = "" if len(entries) == 1 else "s"
    lines = [f"{len(entries)} file{plural} under {label}:"]
    lines += [f"{name}  {size} bytes" for name, size in shown]
    if len(entries) > MAX_LIST_ENTRIES:
        lines.append(f"[truncated: {len(entries) - MAX_LIST_ENTRIES} more entries not shown]")
    return "\n".join(lines)


def _trash_destination(trash_root: Path, name: str) -> Path:
    """A name that cannot collide with one already in the trash. Two deletes of
    the same filename in the same second is the ordinary case (she clears four
    near-duplicates in one breath), and os.replace would silently overwrite the
    first with the second — losing the very file the trash exists to keep."""
    stamp = datetime.now(UTC).strftime(TRASH_STAMP_FORMAT)
    candidate = trash_root / f"{stamp}-{name}"
    counter = 2
    while candidate.exists():
        candidate = trash_root / f"{stamp}-{counter}-{name}"
        counter += 1
    return candidate


def _trashed_at(name: str) -> datetime | None:
    """When an entry ENTERED the trash, read off the name this module wrote.

    Not the file's mtime. os.replace preserves it, so a note written a month
    ago and deleted today would carry a month-old mtime into the trash and be
    swept by the very next delete — no grace at all for exactly the files most
    likely to be worth recovering. The name is the one record of the move, so
    the name is what the window is measured from. A name this module did not
    write parses to None and is never pruned: keeping an unknown file forever
    is the harmless failure, deleting it early is not.
    """
    try:
        return datetime.strptime(name.split("-", 1)[0], TRASH_STAMP_FORMAT).replace(tzinfo=UTC)
    except ValueError:
        return None


def _prune_trash(trash_root: Path) -> int:
    """Drop trash older than the window, and return how many ACTUALLY went.

    An entry that will not delete is left alone and not counted. Silence about
    it would be the reverse of the rule this module is built on: the number in
    the result is what happened, never what was attempted.
    """
    if not trash_root.is_dir():
        return 0
    cutoff = datetime.now(UTC).timestamp() - TRASH_KEEP_DAYS * 86400
    pruned = 0
    for entry in sorted(trash_root.iterdir()):
        trashed_at = _trashed_at(entry.name)
        if trashed_at is None or trashed_at.timestamp() >= cutoff:
            continue
        try:
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            else:
                entry.unlink()
        except OSError:
            continue
        if not entry.exists() and not entry.is_symlink():
            pruned += 1
    return pruned


async def delete(args: dict, ctx: ToolContext) -> str:
    root = ctx.workspace_root.resolve()
    requested = args["path"]
    path = _resolve_within(root, requested)
    display = _display(root, path)
    trash_root = root / TRASH_DIR

    if path == root:
        raise ToolFailure(
            "the workspace root itself cannot be deleted — name a file or a directory inside it"
        )
    if path == trash_root or trash_root in path.parents:
        raise ToolFailure(
            f"{display!r} is in the trash — deleted files are already there, and the trash "
            f"empties itself after {TRASH_KEEP_DAYS} days"
        )
    # The UNRESOLVED path, and before exists(). _resolve_within dereferences a
    # link, so by here `path` is the target: acting on it would delete the real
    # file and leave the dangling link, which is the opposite of what was asked
    # and silent about it. A link pointing OUT is already refused by
    # containment; this is the one pointing in. Checking raw also means a
    # broken link is reported as a link rather than as a missing target.
    if (root / requested).is_symlink():
        raise ToolFailure(
            f"{requested!r} is a symbolic link — deleting it would act on what it points "
            "at, so it is refused; name that file directly if you mean it"
        )
    if not path.exists():
        raise ToolFailure(f"there is nothing at {display!r} in the workspace")

    was_dir = path.is_dir()
    removed: list[str] = [display]
    had_entries = False
    if was_dir:
        contained = [_display(root, item) for item in iter_contained_files(root, path)]
        had_entries = any(path.iterdir())
        recursive = bool(args.get("recursive"))
        if not recursive and had_entries:
            count = len(contained)
            holds = f"holds {count} file{'' if count == 1 else 's'}" if count else "is not empty"
            raise ToolFailure(
                f"{display!r} is a directory and {holds} — pass recursive: true to delete it "
                "and everything in it"
            )
        removed = contained

    size = 0 if was_dir else path.stat().st_size
    pruned = _prune_trash(trash_root)

    try:
        trash_root.mkdir(parents=True, exist_ok=True)
        destination = _trash_destination(trash_root, path.name)
        os.replace(path, destination)
    except OSError as exc:
        raise ToolFailure(f"could not delete {display} — {exc}") from exc

    # Verified from both ends, because os.replace returning without raising is
    # not evidence: the path has to be gone AND the file has to be in the trash.
    # A delete that reports success on either half alone is the failure shape
    # this codebase keeps finding.
    if path.exists() or path.is_symlink():
        raise ToolFailure(f"the delete of {display} did not verify — it is still there afterwards")
    if not destination.exists():
        raise ToolFailure(
            f"the delete of {display} did not verify — it is not in the trash afterwards"
        )

    if was_dir:
        count = len(removed)
        if count:
            plural = "" if count == 1 else "s"
            lines = [f"Deleted the directory {display} and the {count} file{plural} in it:"]
            lines += removed[:MAX_LIST_ENTRIES]
            if count > MAX_LIST_ENTRIES:
                lines.append(f"[truncated: {count - MAX_LIST_ENTRIES} more not shown]")
        elif had_entries:
            # It held no FILES and it was not empty. "Empty directory" here
            # would be a small lie in the owner's only account of what went.
            lines = [f"Deleted the directory {display} and the empty folders inside it."]
        else:
            lines = [f"Deleted the empty directory {display}."]
    else:
        lines = [f"Deleted {display} ({size} bytes)."]
    lines.append(f"It is in the trash and recoverable for {TRASH_KEEP_DAYS} days.")
    if pruned:
        plural = "y" if pruned == 1 else "ies"
        lines.append(f"Also emptied {pruned} trash entr{plural} older than that.")
    return "\n".join(lines)


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="workspace_write_file",
        description=(
            "Write a text file in your workspace, creating parent directories as needed. "
            "Overwrites the file if it already exists. Read it back afterwards to confirm."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path relative to the workspace root, e.g. 'groceries.md'.",
                },
                "content": {"type": "string", "description": "The full text of the file."},
            },
            "required": ["path", "content"],
            "additionalProperties": False,
        },
        executor=write_file,
    ),
    Tool(
        name="workspace_read_file",
        description="Read a text file from your workspace.",
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path relative to the workspace root.",
                }
            },
            "required": ["path"],
            "additionalProperties": False,
        },
        executor=read_file,
        reads_only=True,
    ),
    Tool(
        name="workspace_list_files",
        description="List the files in your workspace, recursively, with their sizes.",
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": (
                        "Optional subdirectory to list, relative to the workspace root. "
                        "Omit for everything."
                    ),
                }
            },
            "required": [],
            "additionalProperties": False,
        },
        executor=list_files,
        reads_only=True,
        # Its result IS a listing: the presented-listing guard reads this
        # declaration to know a real listing was produced this turn.
        result_kind=RESULT_KIND_LISTING,
    ),
    Tool(
        name="workspace_delete",
        description=(
            "Delete a file, or a directory and everything in it, from your workspace. "
            "What you delete is moved to a trash that empties itself after a week, so a "
            "mistake can be undone. List the directory first if you are not sure what is "
            "in it."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path relative to the workspace root, e.g. 'groceries.md'.",
                },
                "recursive": {
                    "type": "boolean",
                    "description": (
                        "Required to delete a directory that is not empty. It takes "
                        "everything underneath it."
                    ),
                },
            },
            "required": ["path"],
            "additionalProperties": False,
        },
        executor=delete,
    ),
)
