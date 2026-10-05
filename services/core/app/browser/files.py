"""The files her browser makes, brought into her workspace (S38).

The engine writes a download or a screenshot into its own volume
(v4_browser_output, `/output` in its container), and core sees the same volume
at BROWSER_OUTPUT_DIR. Only a file the engine REPORTED — a "Downloaded file …
to …" event, a screenshot's result link — is brought in: copied into the
calling turn's workspace, its size and sha256 checked against the source, and
only then is the source removed. "Copied" is never said on a file nobody
measured.

The source side's whole job is to distrust the engine's volume: a
misbehaving or compromised engine, or just a page that chose a name, a
console log (written on every page that logs an error, measured
2026-09-30), a directory link, a FIFO, a file that keeps growing. So a name
is reduced to one safe file name, a path is contained in her workspace by
the workspace tools' own gate, an existing file is never overwritten, the
engine's path is refused unless it is flat, the file actually opened is the
one checked and the one copied — never a second lookup of the same path,
which something else could answer differently the second time — and a link
in the engine's volume is refused rather than followed.
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
MAX_NAME_BYTES = 200


class HandoffError(Exception):
    """A stated reason a reported file was not brought in."""


@dataclass(frozen=True)
class Brought:
    path: str  # relative to the workspace root it was brought into
    bytes: int
    # None once the engine's copy is gone (removed now, or already gone);
    # otherwise the OS's own reason it is still there. Never a failure: the
    # file already landed in her workspace, and a retry must not duplicate
    # it just because the engine's own cleanup could not run.
    left_in_engine: str | None = None


def output_dir_from_env() -> Path:
    return Path(os.environ.get(OUTPUT_DIR_ENV) or DEFAULT_OUTPUT_DIR)


def _cut_utf8(text: str, max_bytes: int) -> str:
    """The longest prefix of `text` whose UTF-8 encoding fits in
    `max_bytes`, cut only on a character boundary — Python slicing is
    always between code points, so this can never split one into an
    invalid tail."""
    if max_bytes <= 0:
        return ""
    if len(text.encode("utf-8", "surrogatepass")) <= max_bytes:
        return text
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if len(text[:mid].encode("utf-8", "surrogatepass")) <= max_bytes:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo]


def safe_name(name: str, fallback: str = "download") -> str:
    """One file name a page cannot use to reach anywhere: the last path
    segment, no control characters, no leading dots, at most
    MAX_NAME_BYTES of UTF-8 (an extension of up to 16 characters kept).
    Stripping whitespace and leading dots is repeated to a fixed point — a
    single pass left " . . " as the bare, dangerous name "." — and
    `fallback` is what is left when nothing meaningful survives that."""
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    base = "".join(ch for ch in base if ch.isprintable() and ch not in '<>:"|?*')
    previous = None
    while base != previous:
        previous = base
        base = base.strip().lstrip(".")
    if not base:
        return fallback
    if len(base.encode("utf-8", "surrogatepass")) > MAX_NAME_BYTES:
        stem, dot, ext = base.rpartition(".")
        ext_bytes = len(ext.encode("utf-8", "surrogatepass"))
        if dot and 0 < len(ext) <= 16 and ext_bytes < MAX_NAME_BYTES:
            base = _cut_utf8(stem, MAX_NAME_BYTES - ext_bytes - 1) + "." + ext
        else:
            base = _cut_utf8(base, MAX_NAME_BYTES)
    return base


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _remove(path: Path) -> str | None:
    """Unlink `path` and say whether it is now gone: None when the unlink
    returned or the path was already gone, else the OS's own reason it is
    not. Never raises — a failed removal is reported here, never thrown,
    so a caller can say so without turning it into a failure of its own."""
    try:
        os.unlink(path)
    except FileNotFoundError:
        return None
    except OSError as exc:
        return exc.strerror or str(exc)
    return None


def source_of(engine_path: str, output_dir: Path) -> Path:
    """Where core sees a file the engine reported at `engine_path`. The
    engine reports flat paths only — every capture is `/output/<name>`,
    never a subfolder — so a path with another "/" after the prefix is
    refused outright: nothing is opened and nothing is removed, which is
    what keeps a directory link planted in the engine's own volume from
    ever being walked into."""
    if not engine_path.startswith(ENGINE_OUTPUT):
        raise HandoffError(f"the engine named {engine_path!r}, which is not in its output folder")
    rel = engine_path[len(ENGINE_OUTPUT) :]
    if not rel or "\x00" in rel or "/" in rel or rel in (".", ".."):
        raise HandoffError(
            f"the engine named {engine_path!r}, which is not one flat file in its output folder"
        )
    return output_dir / rel


def _checked_open(source: Path, lstat_info: os.stat_result) -> int:
    """Open `source` exactly once, trusting nothing between the caller's
    lstat and this call: O_NOFOLLOW refuses a link swapped in since,
    O_NONBLOCK keeps a FIFO (or anything else that would otherwise wait for
    a peer) from blocking the open itself, and the descriptor's OWN fstat —
    never a second lstat of the path, which a second swap could answer for
    a third object — decides whether this is still the regular file
    `lstat_info` described, by device and inode, before a single byte is
    read."""
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(source, flags)
    except OSError as exc:
        raise HandoffError(f"could not open {source.name}: {exc.strerror or exc}") from exc
    try:
        fstat = os.fstat(fd)
    except OSError as exc:
        os.close(fd)
        raise HandoffError(
            f"could not check {source.name} after opening it: {exc.strerror or exc}"
        ) from exc
    if (
        not stat.S_ISREG(fstat.st_mode)
        or fstat.st_dev != lstat_info.st_dev
        or fstat.st_ino != lstat_info.st_ino
    ):
        os.close(fd)
        raise HandoffError(
            f"the engine's {source.name} changed underneath this check; nothing was kept"
        )
    return fd


def _publish(tmp_name: str, destination_dir: Path, wanted: str) -> Path:
    """Link the checked temp file to a free name by trying candidates with
    os.link directly, never a Path.exists() pre-check: exists() is False
    for a dangling symlink, while os.link still finds that name taken, so a
    pre-check and a link can disagree and loop on the same name forever.
    FileExistsError — whatever the name was actually holding — means taken,
    try the next, bounded at 999 candidates; the tmp file is unlinked only
    once a link has actually landed."""
    stem, dot, ext = wanted.rpartition(".")
    if not dot or not stem:
        stem, ext = wanted, ""
    for n in range(1, 1000):
        candidate = destination_dir / (
            wanted if n == 1 else (f"{stem} ({n}).{ext}" if ext else f"{stem} ({n})")
        )
        try:
            os.link(tmp_name, candidate)
        except FileExistsError:
            continue
        except OSError as exc:
            raise HandoffError(f"could not publish {wanted!r}: {exc.strerror or exc}") from exc
        try:
            os.unlink(tmp_name)
        except OSError as exc:
            raise HandoffError(
                f"published {wanted!r} but could not remove its temporary file: "
                f"{exc.strerror or exc}"
            ) from exc
        return candidate
    raise HandoffError(f"{destination_dir.name}/ already holds 999 files named like {wanted!r}")


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
    if stat.S_ISDIR(info.st_mode):
        raise HandoffError(
            f"the engine reported {engine_path}, which is a directory, not a file; "
            "it was left where it was"
        )
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        reason = _remove(source)
        if reason is not None:
            raise HandoffError(
                f"the engine reported {engine_path}, which is not a plain file, and it "
                f"could not be removed: {reason}"
            )
        raise HandoffError(
            f"the engine reported {engine_path}, which is not a plain file; it was removed"
        )
    if info.st_size > MAX_BRING_BYTES:
        reason = _remove(source)
        if reason is not None:
            raise HandoffError(
                f"{source.name} is {info.st_size:,} bytes, over the 1 GiB a download may bring "
                f"into the workspace; it was not copied, and the engine's copy could not be "
                f"removed: {reason}"
            )
        raise HandoffError(
            f"{source.name} is {info.st_size:,} bytes, over the 1 GiB a download may bring into "
            "the workspace; it was not copied, and the engine's copy was removed"
        )

    # Opened and checked FIRST, before anything in the workspace is
    # touched: a source that fails this (a link or FIFO swapped in since
    # the lstat above) is refused without ever creating `folder/`.
    source_fd = _checked_open(source, info)
    try:
        wanted = safe_name(name or source.name)
        workspace_root = workspace_root.resolve()
        try:
            destination_dir = _resolve_within(workspace_root, folder)
        except ToolFailure as exc:
            raise HandoffError(str(exc)) from None
        try:
            destination_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise HandoffError(f"could not create {folder}/: {exc.strerror or exc}") from exc
        try:
            tmp_fd, tmp_name = tempfile.mkstemp(
                dir=destination_dir, prefix=f".{wanted}.", suffix=".part"
            )
        except OSError as exc:
            raise HandoffError(
                f"could not create a temporary file in {folder}/: {exc.strerror or exc}"
            ) from exc

        try:
            digest = hashlib.sha256()
            copied = 0
            try:
                while copied < info.st_size:
                    chunk = os.read(source_fd, min(1024 * 1024, info.st_size - copied))
                    if not chunk:
                        break
                    os.write(tmp_fd, chunk)
                    digest.update(chunk)
                    copied += len(chunk)
                extra = os.read(source_fd, 1)  # must be EOF — a growing file is refused
                os.fsync(tmp_fd)
            finally:
                os.close(tmp_fd)
            if copied != info.st_size or extra:
                raise HandoffError(
                    f"the copy of {source.name} did not match the engine's file; nothing was kept"
                )
            if _sha256(Path(tmp_name)) != digest.hexdigest() or os.path.getsize(tmp_name) != copied:
                raise HandoffError(
                    f"the copy of {source.name} did not match the engine's file; nothing was kept"
                )
            destination = _publish(tmp_name, destination_dir, wanted)
        except OSError as exc:
            with contextlib.suppress(OSError):
                os.unlink(tmp_name)
            raise HandoffError(f"could not write {folder}/{wanted}: {exc.strerror or exc}") from exc
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp_name)
            raise
    finally:
        with contextlib.suppress(OSError):
            os.close(source_fd)

    left_in_engine = _remove(source)
    return Brought(
        path=destination.relative_to(workspace_root).as_posix(),
        bytes=info.st_size,
        left_in_engine=left_in_engine,
    )
