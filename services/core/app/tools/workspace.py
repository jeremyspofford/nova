"""The three filesystem tools, and the boundary they may never leave.

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
"""
from __future__ import annotations

import contextlib
import os
import tempfile
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
    """
    for path in sorted(base.rglob("*")):
        if path.is_symlink() or not path.is_file():
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
        # Its result IS a listing: the presented-listing guard reads this
        # declaration to know a real listing was produced this turn.
        result_kind=RESULT_KIND_LISTING,
    ),
)
