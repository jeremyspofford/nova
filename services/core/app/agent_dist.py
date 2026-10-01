"""The hub's build of Nova's agent (S42b, hub D13).

agent-dist (deploy/agent-dist/build.sh) builds the six targets from the
committed apps/novad tree into /dist/<version>/, with manifest.json and
SHA256SUMS, and writes the version into /dist/current last. This module is
core's one reader of it. A build is served only when every file's bytes match
its manifest — hashed once per file state, not per request — and the manifest
goes out signed with core's own key, the key every agent pinned, so an agent
can tell the hub's build from any other (P19).

Its download paths answer anyone (agent_dist_api), so what is served is what
was checked:

  * a caller's name is looked up among the six, never joined into a path;
  * every file of the build is opened without following a link and must be
    a regular file — a FIFO is refused without waiting for a writer;
  * the hash cache is keyed by the OPEN file's identity and times (device,
    inode, size, mtime, ctime), so a file replaced, or rewritten with its
    mtime put back, is hashed again;
  * a download streams from the very open file that was checked, re-hashed
    as it goes, its last chunk held back until the whole body matches — so a
    response that completes is the manifest's bytes, and a file changed under
    it makes the response fail instead.

Every DistUnavailable reason is public for the same reason, so none names a
host path, a user or a key: a file is named by its build name, an OS error by
its strerror, and a pointer that is not a version is not echoed.

A version is a hash of the apps/novad tree (P2). It has no order: an agent on
another version is "behind the hub's build", never "older".
"""

from __future__ import annotations

import asyncio
import errno
import hashlib
import json
import logging
import os
import re
import stat
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO

from app import devices, envelopes

logger = logging.getLogger("core")

DIST_DIR_ENV = "NOVA_AGENT_DIST_DIR"
DEFAULT_DIST_DIR = "/dist"
TARGETS: tuple[tuple[str, str], ...] = (
    ("linux", "amd64"),
    ("linux", "arm64"),
    ("darwin", "amd64"),
    ("darwin", "arm64"),
    ("windows", "amd64"),
    ("windows", "arm64"),
)
# The manifest's own wire version (agent-dist writes 1). A manifest of another
# version may mean other things by the same keys, so it is refused, never
# re-signed as a 1.
MANIFEST_VERSION = 1
_VERSION = re.compile(r"[0-9a-f]{12}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
# Stream and hash in this size: memory per download stays one chunk.
CHUNK = 1 << 16
_HASH_CHUNK = 1 << 20
# Every file of a build opens through this: no link followed, no wait on a
# FIFO (O_NONBLOCK changes nothing for a regular file's reads).
_OPEN_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_NONBLOCK", 0)
    | getattr(os, "O_CLOEXEC", 0)
)


def file_key(goos: str, arch: str) -> str:
    return f"{goos}-{arch}"


def file_name(goos: str, arch: str) -> str:
    return f"novad-{goos}-{arch}" + (".exe" if goos == "windows" else "")


FILE_NAMES = frozenset(file_name(g, a) for g, a in TARGETS)
_FILE_KEYS = frozenset(file_key(g, a) for g, a in TARGETS)
# A served name back to its target: the one way a caller's name becomes a
# file is this lookup — the path is then built from the target's own name.
_TARGET_OF: dict[str, tuple[str, str]] = {file_name(g, a): (g, a) for g, a in TARGETS}
# The seven exact public paths (identity.PUBLIC_PATHS lists them literally;
# test_agent_dist pins that the two agree).
PUBLIC_PATHS = frozenset(
    {"/api/v1/agent/manifest", *(f"/api/v1/agent/dist/{n}" for n in FILE_NAMES)}
)


class DistUnavailable(RuntimeError):
    """There is no build to serve, or it does not match itself — the reason,
    in words, which the API and her tools state as given."""


@dataclass(frozen=True)
class Build:
    version: str
    built_at: str
    go: str
    files: dict = field(default_factory=dict)

    def file_for(self, goos: str | None, arch: str | None) -> dict | None:
        return self.files.get(file_key(goos or "", arch or ""))

    def manifest(self) -> dict:
        return {
            "v": MANIFEST_VERSION,
            "version": self.version,
            "built_at": self.built_at,
            "go": self.go,
            "files": {key: dict(entry) for key, entry in self.files.items()},
        }


@dataclass
class OpenFile:
    """One of the build's files, open for reading and checked against the
    manifest through this very open file — what a download streams, so the
    bytes served are the bytes checked (`stream`)."""

    version: str
    name: str
    sha256: str
    size: int
    file: BinaryIO

    def close(self) -> None:
        self.file.close()


# (path, device, inode, size, mtime_ns, ctime_ns) -> sha256: a file is hashed
# once per state, and one state is kept per path.
_HASHES: dict[tuple, str] = {}


def dist_dir() -> Path:
    return Path(os.environ.get(DIST_DIR_ENV) or DEFAULT_DIST_DIR)


def _said(exc: OSError) -> str:
    """An OS error in words that name no path: str(exc) carries the file name."""
    return exc.strerror or type(exc).__name__


def _is_count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _open(path: Path, what: str) -> BinaryIO:
    """`path` open for reading, unbuffered — never through a symbolic link and
    only when it is a regular file. FileNotFoundError passes through for the
    caller to say what a missing file means; any other failure is a
    DistUnavailable naming `what`."""
    try:
        fd = os.open(path, _OPEN_FLAGS)
    except FileNotFoundError:
        raise
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise DistUnavailable(
                f"{what} is a symbolic link — a build holds only regular files"
            ) from exc
        raise DistUnavailable(f"{what} could not be read ({_said(exc)})") from exc
    try:
        mode = os.fstat(fd).st_mode
    except OSError as exc:
        os.close(fd)
        raise DistUnavailable(f"{what} could not be read ({_said(exc)})") from exc
    if not stat.S_ISREG(mode):
        os.close(fd)
        raise DistUnavailable(f"{what} is not a regular file")
    try:
        return os.fdopen(fd, "rb", buffering=0)
    except BaseException:
        os.close(fd)
        raise


def _read_small(path: Path, what: str) -> bytes:
    with _open(path, what) as f:
        return f.read()


def _sha256_of(f: BinaryIO, path: Path) -> str:
    """The sha256 of the open file `f`, from the cache when this file is in
    the state it was hashed in. The state is the open file's own fstat, so
    the cache can never answer for another file at the same path."""
    st = os.fstat(f.fileno())
    key = (str(path), st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
    known = _HASHES.get(key)
    if known is None:
        h = hashlib.sha256()
        f.seek(0)
        for chunk in iter(lambda: f.read(_HASH_CHUNK), b""):
            h.update(chunk)
        known = h.hexdigest()
        for stale in [k for k in list(_HASHES) if k[0] == key[0] and k != key]:
            _HASHES.pop(stale, None)
        _HASHES[key] = known
    return known


def _checked(root: Path, version: str, name: str, sha256: str, size: int) -> BinaryIO:
    """One file of the build, open at its start, its size and sha256 checked
    against the manifest's through the open file itself."""
    what = f"{name} in the agent build {version}"
    path = root / version / name
    try:
        f = _open(path, what)
    except FileNotFoundError as exc:
        raise DistUnavailable(f"{name} is missing from the agent build {version}") from exc
    try:
        got_size = os.fstat(f.fileno()).st_size
        if got_size != size:
            raise DistUnavailable(
                f"{what} does not match its manifest (size {got_size}, manifest {size})"
            )
        got = _sha256_of(f, path)
        if got != sha256:
            raise DistUnavailable(
                f"{what} does not match its manifest (sha256 {got[:12]}…, manifest {sha256[:12]}…)"
            )
        f.seek(0)
    except OSError as exc:
        f.close()
        raise DistUnavailable(f"{what} could not be read ({_said(exc)})") from exc
    except BaseException:
        f.close()
        raise
    return f


def _text(value: object) -> str:
    """A manifest's descriptive string (built_at, go): kept when it is short
    one-line text, otherwise "" — not read — rather than a repr or a line
    break carried into what core signs."""
    if isinstance(value, str) and len(value) <= 64 and value.isprintable():
        return value
    return ""


def _current(root: Path) -> Build:
    pointer = "the agent build's current pointer"
    try:
        said = _read_small(root / "current", pointer)
    except FileNotFoundError as exc:
        raise DistUnavailable(
            "no agent build on this hub yet — ./install builds it (agent-dist)"
        ) from exc
    except OSError as exc:
        raise DistUnavailable(f"{pointer} could not be read ({_said(exc)})") from exc
    version = said.decode("utf-8", "replace").strip()
    if not _VERSION.fullmatch(version):
        raise DistUnavailable(f"{pointer} does not name a version (12 hex characters)")
    what = f"the agent build {version}'s manifest"
    try:
        raw = json.loads(_read_small(root / version / "manifest.json", what))
    except FileNotFoundError as exc:
        raise DistUnavailable(f"the agent build {version} has no manifest") from exc
    except OSError as exc:
        raise DistUnavailable(f"{what} could not be read ({_said(exc)})") from exc
    except (ValueError, RecursionError) as exc:
        raise DistUnavailable(f"{what} is not valid JSON") from exc
    if not isinstance(raw, dict):
        raise DistUnavailable(f"{what} does not describe it")
    if not (_is_count(raw.get("v")) and raw["v"] == MANIFEST_VERSION):
        raise DistUnavailable(f"{what} is not version {MANIFEST_VERSION}, the one this core reads")
    if raw.get("version") != version or not isinstance(raw.get("files"), dict):
        raise DistUnavailable(f"{what} does not describe it")
    # Exactly the six (fix round 1): an entry for a file this core does not
    # serve is refused, never dropped from what core signs — a target set
    # core and agent-dist disagree on is said here, not later as an
    # unexplained "not the hub's build". The keys are the build's, and every
    # reason is public, so none is echoed. A missing one is the loop's below.
    if not set(raw["files"]) <= _FILE_KEYS:
        raise DistUnavailable(f"{what} describes files this core does not serve")
    files = {}
    for goos, arch in TARGETS:
        key, name = file_key(goos, arch), file_name(goos, arch)
        entry = raw["files"].get(key)
        if not (
            isinstance(entry, dict)
            and entry.get("name") == name
            and isinstance(entry.get("sha256"), str)
            and _SHA256.fullmatch(entry["sha256"])
            and _is_count(entry.get("size"))
        ):
            raise DistUnavailable(f"{what} does not describe {key}")
        _checked(root, version, name, entry["sha256"], entry["size"]).close()
        files[key] = {"name": name, "sha256": entry["sha256"], "size": entry["size"]}
    return Build(
        version=version,
        built_at=_text(raw.get("built_at")),
        go=_text(raw.get("go")),
        files=files,
    )


def current() -> Build:
    """The hub's current build, every file checked against its manifest, or
    DistUnavailable with the reason."""
    return _current(dist_dir())


def current_version() -> str | None:
    try:
        return current().version
    except DistUnavailable:
        return None


async def read() -> Build:
    """current(), off the event loop: the first read of a new build hashes
    tens of megabytes."""
    return await asyncio.to_thread(current)


async def version() -> str | None:
    return await asyncio.to_thread(current_version)


def open_file(name: str) -> OpenFile:
    """One of the build's files, open and checked: the whole build first —
    one broken file makes every file unavailable — then this file again,
    through the very open file a download streams. `name` is looked up among
    the six and never joined into a path."""
    target = _TARGET_OF.get(name)
    if target is None:
        raise DistUnavailable("that is not one of the agent's builds")
    root = dist_dir()
    build = _current(root)
    entry = build.file_for(*target)
    f = _checked(root, build.version, entry["name"], entry["sha256"], entry["size"])
    return OpenFile(
        version=build.version,
        name=entry["name"],
        sha256=entry["sha256"],
        size=entry["size"],
        file=f,
    )


async def stream(opened: OpenFile, chunk_size: int = CHUNK) -> AsyncIterator[bytes]:
    """The open file's bytes, re-hashed as they go out. The last chunk is held
    back until the whole body has the manifest's size and sha256, so a body
    that completes is the build's; a file changed under the open file raises
    instead, and the response never completes. The file is closed either way."""
    h = hashlib.sha256()
    seen = 0
    held = b""

    def stopped() -> DistUnavailable:
        # Said in the log here as well as raised: behind the identity
        # middleware (Starlette's BaseHTTPMiddleware) an exception raised
        # mid-stream never reaches the server's log — it ends the body short,
        # and uvicorn reports only a response shorter than its Content-Length
        # (which is what cuts the client off: the route always states one).
        reason = DistUnavailable(
            f"{opened.name} in the agent build {opened.version} changed while it was being "
            "sent — the download was stopped"
        )
        logger.error("%s", reason)
        return reason

    try:
        while True:
            chunk = await asyncio.to_thread(opened.file.read, chunk_size)
            if not chunk:
                break
            seen += len(chunk)
            if seen > opened.size:
                raise stopped()
            h.update(chunk)
            if held:
                yield held
            held = chunk
        if seen != opened.size or h.hexdigest() != opened.sha256:
            raise stopped()
        if held:
            yield held
    finally:
        opened.close()


async def signed_manifest(pool, build: Build | None = None) -> dict:
    """`build`'s manifest — or, with none given, the current build's, read
    once here — signed by core's own key over its canonical bytes. A caller
    that describes a build beside its manifest passes the Build it read, so
    what is signed is exactly what it describes (S42b Task 19: a second read
    could find /dist/current flipped to another build)."""
    body = (build if build is not None else await read()).manifest()
    return {"manifest": body, "sig": envelopes.sign(await devices.signing_key(pool), body)}
