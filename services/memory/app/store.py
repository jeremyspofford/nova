"""File-backed memory store.

Layout under MEMORY_ROOT:
    people/<person_id>/journals/YYYY-MM-DD.md   one append-file per day
    people/<person_id>/topics/<slug>.md         free-form notes

(household/ and guests/ arrive in a later slice; the per-person layout
exists now so that slice adds rows, not a migration.)

Every file is YAML frontmatter (id, owner, kind, title, created, tags)
followed by a markdown body. Writes are always atomic: a tmp file in the
same directory, fsync'd, then renamed over the target with os.replace
(atomic on POSIX) — a crash between the write and the rename leaves the
previous file (or no file at all) intact, never a half-written one.

Postgres (nova_memory) stores nothing here beyond Task 1's
schema_migrations table — the BM25 index this store feeds (index.py) is
entirely in-process for this slice. The DB seam exists for a later slice
to use, it is simply unused by S1's memory service.
"""

from __future__ import annotations

import contextlib
import io
import logging
import os
import re
import tarfile
import tempfile
import uuid
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path

import yaml

logger = logging.getLogger("memory.store")

_FRONTMATTER_START = "---\n"
_FRONTMATTER_END = "\n---\n"
_SLUG_RE = re.compile(r"[^a-z0-9-]+")

# The heading append_journal writes in front of every exchange. This module
# writes that line, so this module owns reading it back: split_entries() below
# is the exact inverse of append_journal(), and nothing else may re-derive the
# shape of a journal from a regex of its own.
_ENTRY_HEADING_RE = re.compile(r"^## (\d{1,2}:\d{2})[ \t]*$", re.M)

# How many same-slug notes one person may hold before create_topic gives up
# and says so. A cap that is hit is a stated failure, never a silent
# overwrite of note number one.
MAX_SLUG_ATTEMPTS = 200


class PathEscape(ValueError):
    """A path resolved outside the boundary it was required to stay in.

    Raised naming the reason — the API layer turns this into a 400 that
    names it back to the caller, never a silent refusal.
    """


@dataclass(frozen=True)
class StoredFile:
    rel_path: str  # POSIX, relative to MEMORY_ROOT, e.g. "people/x/topics/a.md"
    abs_path: Path
    meta: dict
    body: str


@dataclass(frozen=True)
class Entry:
    """One '## HH:MM' exchange inside a journal body — the unit recall indexes.

    `fragment` is the name that goes after the '#' in a citable id
    ("people/x/journals/2026-09-09.md#16:32"). `start`/`end` are character
    offsets into the BODY the entry was split out of, heading included, so an
    id resolves back to an exact span of the file rather than to a re-search
    of it: body[entry.start:entry.end] is what was cited, byte for byte.
    """

    fragment: str
    text: str  # the exchange without its heading — what gets indexed and excerpted
    start: int
    end: int


def split_entries(body: str) -> list[Entry]:
    """A journal body -> its exchanges, in file order.

    Two entries can land in the same minute (two exchanges inside sixty
    seconds), which would give two chunks the same id, so a repeated time gets
    "-2", "-3" appended in file order. That rule lives ONLY here, and
    find_entry() below looks an id up by recomputing these same names rather
    than by parsing them, so the two can never drift apart.

    Text before the first heading — whitespace in every file the service
    writes, but a hand-edited note could carry a preamble — comes back as an
    entry named "start". Dropping it would be content silently missing from
    the index, which is the one outcome this function may not have.

    A body with no headings at all (a topic note) returns [], and the caller
    indexes the whole file as one unit.
    """
    matches = list(_ENTRY_HEADING_RE.finditer(body))
    if not matches:
        return []
    entries: list[Entry] = []
    preamble = body[: matches[0].start()]
    if preamble.strip():
        entries.append(
            Entry(fragment="start", text=preamble.strip(), start=0, end=matches[0].start())
        )
    seen: Counter = Counter()
    for i, match in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        at = match.group(1)
        seen[at] += 1
        fragment = at if seen[at] == 1 else f"{at}-{seen[at]}"
        entries.append(
            Entry(
                fragment=fragment,
                text=body[match.end() : end].strip(),
                start=match.start(),
                end=end,
            )
        )
    return entries


def find_entry(body: str, fragment: str) -> Entry | None:
    """The entry a citable id names, or None when the file no longer holds it.

    None is a fact — the file was rewritten, the entry is gone — and callers
    must say that rather than quietly citing a neighbouring exchange.
    """
    for entry in split_entries(body):
        if entry.fragment == fragment:
            return entry
    return None


def slugify(text: str) -> str:
    slug = _SLUG_RE.sub("-", text.strip().lower()).strip("-")
    return slug or "note"


def _resolve_within(root: Path, rel: str) -> Path:
    """Resolve `rel` under `root` and assert the realpath stays inside
    root — this is the ONLY gate anything in this module relies on for
    safety. It works for traversal (`..` collapses during resolve()),
    absolute escapes (Path's `/` operator discards `root` entirely when
    `rel` is absolute, so the result plainly fails the prefix check
    below), and symlinks pointing outside (resolve() dereferences any
    symlink components that already exist on disk before the check
    runs). Never a string comparison — always the resolved filesystem
    path.
    """
    candidate = root / rel
    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError:
        raise PathEscape(f"{rel!r} resolves outside {root}") from None
    return resolved


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise


def _atomic_create(path: Path, content: str) -> None:
    """Write `content` to `path`, atomically, and only if nothing is there.

    os.replace (what _atomic_write uses) happily clobbers an existing
    file; os.link refuses one, and refuses it in the kernel rather than in
    a check we ran a moment earlier — so "never overwrite" here is not a
    look-before-you-leap race, it is the operation itself. The tmp file is
    written and fsync'd first, so the name only ever appears once the
    bytes are already durable.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(tmp_name, path)
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)


def _parse(text: str) -> tuple[dict, str]:
    if not text.startswith(_FRONTMATTER_START):
        raise ValueError("missing YAML frontmatter")
    end = text.find(_FRONTMATTER_END, len(_FRONTMATTER_START))
    if end == -1:
        raise ValueError("unterminated YAML frontmatter")
    header = text[len(_FRONTMATTER_START) : end]
    body = text[end + len(_FRONTMATTER_END) :]
    meta = yaml.safe_load(header) or {}
    if not isinstance(meta, dict):
        raise ValueError("frontmatter is not a mapping")
    return meta, body


def _render(meta: dict, body: str) -> str:
    header = yaml.safe_dump(meta, sort_keys=False).strip()
    return f"---\n{header}\n---\n{body}"


class MemoryStore:
    def __init__(self, root: Path | str):
        self.root = Path(root).resolve()
        (self.root / "people").mkdir(parents=True, exist_ok=True)

    # -- boundaries ----------------------------------------------------

    def person_root(self, person_id: str) -> Path:
        if not person_id or "/" in person_id or "\\" in person_id or person_id in (".", ".."):
            raise PathEscape(f"invalid person_id: {person_id!r}")
        return _resolve_within(self.root, f"people/{person_id}")

    def resolve_in_person(self, person_id: str, rel_path: str) -> Path:
        """Resolve rel_path (relative to MEMORY_ROOT, in the same form
        /ingest and /recall hand back) and assert it lands inside
        people/<person_id>/ after realpath normalization. This is the
        mechanical gate /forget relies on for traversal, absolute
        escapes, and symlinks pointing outside — all three collapse to
        the same "does the resolved path stay under person_root" check.
        """
        person_root = self.person_root(person_id)
        resolved = _resolve_within(self.root, rel_path)
        try:
            resolved.relative_to(person_root)
        except ValueError:
            raise PathEscape(f"{rel_path!r} does not resolve inside people/{person_id}/") from None
        return resolved

    def rel_path(self, abs_path: Path) -> str:
        return abs_path.resolve().relative_to(self.root).as_posix()

    # -- journals --------------------------------------------------------

    def append_journal(
        self, person_id: str, entry_body: str, *, when: datetime | None = None
    ) -> tuple[Path, bool]:
        """Append `entry_body` under a '## HH:MM' heading (UTC) to
        today's journal for person_id, creating the file with
        frontmatter if this is the first entry of the day. Returns
        (absolute path, created_new). Callers are responsible for
        verifying the write before reporting success to their own
        caller — this function only guarantees atomicity, not that the
        caller checked.
        """
        moment = when or datetime.now(UTC)
        day = moment.date()
        person_root = self.person_root(person_id)
        path = _resolve_within(person_root, f"journals/{day.isoformat()}.md")
        entry = f"## {moment.strftime('%H:%M')}\n\n{entry_body.strip()}\n"

        if path.exists():
            meta, body = _parse(path.read_text(encoding="utf-8"))
            new_body = (body.rstrip("\n") + "\n\n" + entry) if body.strip() else entry
            created_new = False
        else:
            meta = {
                "id": str(uuid.uuid4()),
                "owner": person_id,
                "kind": "journal",
                "title": f"Journal - {day.isoformat()}",
                "created": day,
                "tags": [],
            }
            new_body = "\n" + entry
            created_new = True

        _atomic_write(path, _render(meta, new_body))
        return path, created_new

    # -- topics ------------------------------------------------------------

    def write_topic(
        self,
        person_id: str,
        slug: str,
        title: str,
        body: str,
        *,
        created: date | None = None,
        tags: list[str] | None = None,
    ) -> Path:
        """Create or overwrite a topic note. No HTTP route in this slice
        creates topics (S1 ships no tool surface at all) — this exists
        because the layout is specified now, and it is how fixtures for
        recall are seeded, both in tests and in a later slice's writer.
        """
        person_root = self.person_root(person_id)
        path = _resolve_within(person_root, f"topics/{slug}.md")
        meta = {
            "id": str(uuid.uuid4()),
            "owner": person_id,
            "kind": "topic",
            "title": title,
            "created": created or datetime.now(UTC).date(),
            "tags": tags or [],
        }
        _atomic_write(path, _render(meta, "\n" + body.strip() + "\n"))
        return path

    def create_topic(
        self,
        person_id: str,
        title: str,
        body: str,
        *,
        created: date | None = None,
        tags: list[str] | None = None,
    ) -> Path:
        """Create a NEW topic note, never replacing one that already exists.

        The slug comes from the title; a slug already taken gets a `-2`,
        `-3`, … suffix. The loop is not a check-then-write race: each
        attempt is an atomic create that fails outright if the name is
        taken, so a name that appeared between two iterations is caught by
        the create rather than missed by an earlier stat.
        """
        person_root = self.person_root(person_id)
        base = slugify(title)
        meta_template = {
            "owner": person_id,
            "kind": "topic",
            "title": title,
            "created": created or datetime.now(UTC).date(),
            "tags": tags or [],
        }
        for attempt in range(1, MAX_SLUG_ATTEMPTS + 1):
            slug = base if attempt == 1 else f"{base}-{attempt}"
            path = _resolve_within(person_root, f"topics/{slug}.md")
            meta = {"id": str(uuid.uuid4()), **meta_template}
            try:
                _atomic_create(path, _render(meta, "\n" + body.strip() + "\n"))
            except FileExistsError:
                continue
            return path
        raise FileExistsError(
            f"{MAX_SLUG_ATTEMPTS} notes already share the slug {base!r} for {person_id}"
        )

    # -- reading -------------------------------------------------------------

    def read(self, abs_path: Path) -> StoredFile:
        meta, body = _parse(abs_path.read_text(encoding="utf-8"))
        return StoredFile(rel_path=self.rel_path(abs_path), abs_path=abs_path, meta=meta, body=body)

    def iter_all(self) -> Iterator[StoredFile]:
        """Every parseable file under people/ — the full rescan the
        index is built from at startup. A file that fails to parse is
        logged and skipped rather than aborting the whole rescan.

        Symlinks are skipped outright, never followed. `read()` derives
        rel_path via `Path.resolve()`, which already keeps a symlink
        from smuggling content in under the wrong rel_path — pointing
        outside MEMORY_ROOT makes resolve()+relative_to() raise (caught
        below as an unparsable file), and pointing at another person's
        real file resolves to THAT file's own true rel_path, never the
        symlink's apparent one. So this isn't the last line of defence;
        it just skips these dirents outright instead of letting rglob()
        walk through a link and lean on a downstream exception to
        notice. /recall's per-hit resolve_in_person check is the actual
        backstop (scope is mechanical there too).
        """
        people_dir = self.root / "people"
        if not people_dir.is_dir():
            return
        for path in sorted(people_dir.rglob("*.md")):
            if path.is_symlink():
                logger.warning("skipping symlinked memory file %s", path)
                continue
            try:
                yield self.read(path)
            except ValueError as exc:
                logger.warning("skipping unparsable memory file %s: %s", path, exc)

    # -- delete ------------------------------------------------------------

    def delete(self, abs_path: Path) -> None:
        abs_path.unlink()

    # -- export --------------------------------------------------------------

    def export_tar_gz(self, person_id: str) -> bytes:
        """tar.gz of people/<person_id>/, arcnames relative to that
        directory. A person with no files yet gets a valid, empty
        archive — never an error.
        """
        person_root = self.person_root(person_id)
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
            if person_root.is_dir():
                for path in sorted(person_root.rglob("*")):
                    if path.is_file():
                        arcname = path.relative_to(person_root).as_posix()
                        tar.add(path, arcname=arcname)
        return buffer.getvalue()
