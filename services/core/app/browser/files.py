"""The files her browser makes, brought into her workspace (S38).

The engine writes a download or a screenshot into its own volume
(v4_browser_output, `/output` in its container), and core sees the same volume
at BROWSER_OUTPUT_DIR. Only a file the engine REPORTED — a "Downloaded file …
to …" event, a screenshot's result link — is brought in: copied into the
calling turn's workspace, its size and sha256 checked against the source, and
only then is the source removed. "Copied" is never said on a file nobody
measured.

The engine's volume is not her workspace on purpose: it writes console logs
there on every page that logs an error (measured 2026-09-30), and a page
chooses a download's name. So a name is reduced to one safe file name, a path
is contained in her workspace by the workspace tools' own gate, an existing
file is never overwritten, and a link in the engine's volume is refused rather
than followed.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path

from app.browser.page import ENGINE_OUTPUT
from app.tools.base import ToolFailure
from app.tools.workspace import _resolve_within

OUTPUT_DIR_ENV = "BROWSER_OUTPUT_DIR"
DEFAULT_OUTPUT_DIR = "/data/browser-output"
MAX_BRING_BYTES = 1024 * 1024 * 1024  # 1 GiB
MAX_NAME_CHARS = 120


class HandoffError(Exception):
    """A stated reason a reported file was not brought in."""


@dataclass(frozen=True)
class Brought:
    path: str  # relative to the workspace root it was brought into
    bytes: int


def output_dir_from_env() -> Path:
    return Path(os.environ.get(OUTPUT_DIR_ENV) or DEFAULT_OUTPUT_DIR)


def safe_name(name: str, fallback: str = "download") -> str:
    """One file name a page cannot use to reach anywhere: the last path
    segment, no control characters, no leading dots, at most MAX_NAME_CHARS
    (the extension kept)."""
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    base = "".join(ch for ch in base if ch.isprintable() and ch not in '<>:"|?*')
    base = base.strip().lstrip(".").strip()
    if not base:
        return fallback
    if len(base) > MAX_NAME_CHARS:
        stem, dot, ext = base.rpartition(".")
        if dot and 0 < len(ext) <= 16:
            base = stem[: MAX_NAME_CHARS - len(ext) - 1] + "." + ext
        else:
            base = base[:MAX_NAME_CHARS]
    return base


def _free_name(folder: Path, name: str) -> Path:
    candidate = folder / name
    if not candidate.exists():
        return candidate
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        stem, ext = name, ""
    for n in range(2, 1000):
        candidate = folder / (f"{stem} ({n}).{ext}" if ext else f"{stem} ({n})")
        if not candidate.exists():
            return candidate
    raise HandoffError(f"{folder.name}/ already holds 999 files named like {name!r}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_of(engine_path: str, output_dir: Path) -> Path:
    """Where core sees a file the engine reported at `engine_path`."""
    if not engine_path.startswith(ENGINE_OUTPUT):
        raise HandoffError(f"the engine named {engine_path!r}, which is not in its output folder")
    rel = engine_path[len(ENGINE_OUTPUT) :]
    if not rel or "\x00" in rel or any(part in ("", ".", "..") for part in rel.split("/")):
        raise HandoffError(
            f"the engine named {engine_path!r}, which is not one file in its output folder"
        )
    return output_dir / rel


def bring_in(
    engine_path: str,
    *,
    output_dir: Path,
    workspace_root: Path,
    folder: str,
    name: str | None = None,
) -> Brought:
    """Copy the reported file into `<workspace_root>/<folder>/`, check it,
    remove the source, and say where it is. Raises HandoffError with the
    reason when any step cannot be done or checked."""
    source = source_of(engine_path, output_dir)
    try:
        info = os.lstat(source)
    except FileNotFoundError:
        raise HandoffError(f"the engine reported {engine_path}, and it is not there") from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        with contextlib.suppress(OSError):
            os.unlink(source)
        raise HandoffError(
            f"the engine reported {engine_path}, which is not a plain file; it was removed"
        )
    if info.st_size > MAX_BRING_BYTES:
        with contextlib.suppress(OSError):
            os.unlink(source)
        raise HandoffError(
            f"{source.name} is {info.st_size:,} bytes, over the 1 GiB a download may bring into "
            "the workspace; it was not copied, and the engine's copy was removed"
        )
    wanted = safe_name(name or source.name)
    try:
        destination_dir = _resolve_within(workspace_root, folder)
    except ToolFailure as exc:
        raise HandoffError(str(exc)) from None
    destination_dir.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=destination_dir, prefix=f".{wanted}.", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as out, open(source, "rb", opener=_no_follow) as src:
            for chunk in iter(lambda: src.read(1024 * 1024), b""):
                out.write(chunk)
            out.flush()
            os.fsync(out.fileno())
        if os.path.getsize(tmp_name) != info.st_size or _sha256(Path(tmp_name)) != _sha256(source):
            raise HandoffError(
                f"the copy of {source.name} did not match the engine's file; nothing was kept"
            )
        destination = _publish(tmp_name, destination_dir, wanted)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise
    os.unlink(source)
    return Brought(path=destination.relative_to(workspace_root).as_posix(), bytes=info.st_size)


def _publish(tmp_name: str, destination_dir: Path, wanted: str) -> Path:
    """Link the checked temp file to a free name, atomically: a free name
    picked by `_free_name` can be taken by another writer (a second
    download, her own `write_file`) before it is used, and `os.replace`
    would then silently overwrite it -- the one thing an existing file must
    never suffer. `os.link` raises FileExistsError instead when that
    happens, so the next free name is tried, bounded by the same 999-name
    limit `_free_name` itself states. The tmp file is removed only after a
    link actually lands; every other path leaves it for the caller's own
    cleanup to remove."""
    for _ in range(999):
        destination = _free_name(destination_dir, wanted)
        try:
            os.link(tmp_name, destination)
        except FileExistsError:
            continue
        os.unlink(tmp_name)
        return destination
    raise HandoffError(f"{destination_dir.name}/ already holds 999 files named like {wanted!r}")


def _no_follow(path: str, flags: int) -> int:
    return os.open(path, flags | getattr(os, "O_NOFOLLOW", 0))
