"""The Files tab — browsing and editing the places Nova keeps things.

A path is reachable here only if it resolves inside exactly one DECLARED
root. That makes the guard an allowlist rather than a filter: exposing a new
place is a deliberate edit to `_roots()`, never the absence of an exclusion
someone forgot to write. A filter over `./data` would have to be maintained
against every directory a future feature creates, and the day it drifts is
the day it leaks.

What is deliberately NOT a root, and why, so nobody adds one back by
accident:

  - `.env` — every provider key, the Postgres password, NOVA_AUTH_TOKEN and
    the Tailscale auth key, in one file. This process talks to cloud models.
    Config already has Settings; secret VALUES already have secret_store.
  - `data/runtime` — a ServiceAccount bearer token, mounted `:ro` by compose
    precisely so nothing in the backend rewrites it.
  - `data/wake-training` — household voiceprint clips. Biometric samples with
    their own surface in Settings → Voice.
  - the source tree — `patches.py` already litigated this one: a writable
    checkout belongs with the coder sidecar's private clone, behind review.
    An editor here would be a second, unreviewed authority over consents.py,
    rules.py and migrations/, and nothing at this layer can tell the
    operator's browser from an agent holding the same bearer token.

Documents are NOT a root. Attachments are content-addressed blobs — the
directory is the first two hex characters of a sha and no filename is ever
stored — so there is no address space to navigate, and a tree faked from the
`kind` column showed strictly less than Library -> Documents already does.
A second, worse view of the same rows is not a feature.

The two roots differ in what they even CAN support, so their rules are not
a policy table that could be edited to say something the storage cannot do:

  memory     real markdown tree, but only two levels deep — OkfStore.
             iter_files() globs `<type-dir>/*.md` and nothing else, so a
             subfolder here is a folder she structurally cannot read. New
             folders are refused for that reason, not as a preference.
  workspace  an ordinary directory with no index and no references. Full
             CRUD, arbitrary nesting, because nothing downstream cares.
"""

import errno
import logging
import os
import secrets
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import db
from app.config import settings
from app.memory import links
from app.memory.memory import memory
from app.memory.store import TYPE_DIRS, _PINNABLE_DIRS

log = logging.getLogger(__name__)
router = APIRouter()

MEMORY, WORKSPACE = "memory", "workspace"

# Read/write ceiling for the text editor. The point is not the disk cost —
# it is that a 12 MB line-less blob wedges the browser tab, and "the editor
# hung" is a worse answer than a sentence saying the file is too big.
MAX_TEXT_BYTES = 1 * 1024 * 1024

# The type dirs, as the store spells them — imported rather than restated so
# that a new memory type shows up here the day it is added to the store.
_MEMORY_DIRS = frozenset(TYPE_DIRS.values())


@dataclass(frozen=True)
class _Root:
    key: str
    label: str
    note: str
    base: Optional[Path]        # None => virtual (documents)
    writable: bool              # may file CONTENT be written?
    can_mkdir: bool             # may the operator create folders?


def _roots() -> dict[str, _Root]:
    """Built per call from settings, so a relocated memory dir is picked up
    without a restart of anything but the setting."""
    return {
        MEMORY: _Root(
            MEMORY, "Memory",
            "Her notes, as markdown. Editing here writes exactly what you "
            "type and then reindexes.",
            Path(settings.okf_memory_dir).resolve(), True, False),
        WORKSPACE: _Root(
            WORKSPACE, "Workspace",
            "Scratch space. Anything she makes, and anything you drop in.",
            Path(settings.workspace_dir).resolve(), True, True),
    }


def _root(key: str) -> _Root:
    r = _roots().get(key)
    if not r:
        raise HTTPException(404, f"There is no '{key}' root.")
    return r


def _fs_root(key: str) -> _Root:
    r = _root(key)
    if r.base is None:
        raise HTTPException(400, f"{r.label} is not a filesystem tree.")
    if not r.base.exists():
        # Checked here rather than in one handler: new_folder used to mkdir
        # the missing root back into existence inside the container's own
        # writable layer, which is precisely the outcome this refusal exists
        # to prevent. The only way a root goes missing is a missing bind
        # mount, and files written into a container layer are thrown away by
        # the next `up -d`.
        raise HTTPException(
            503, f"{r.label} is not mounted — expected {r.base}. Check the "
                 f"backend's volumes in docker-compose.yml.")
    return r


# ── confinement ──────────────────────────────────────────────────────────

def _confine(base: Path, rel: str, *, allow_root: bool = True) -> Path:
    """`rel` resolved under `base`, or a refusal.

    resolve() runs BEFORE the containment test, so a symlink whose target
    leaves the root is caught rather than followed — the same shape the OKF
    store uses at every id-taking entry point (store.read_file). An absolute
    `rel` is handled by the same test, because `Path('/a') / '/etc/passwd'`
    is `/etc/passwd`, which is not relative to the base; it gets its own
    sentence first only because "leaves the root" would read as a bug.

    `allow_root=False` is what every MUTATION passes. '', '.', './' and
    'sub/..' all resolve to the root itself and pass containment through the
    `p != base` escape hatch, so without this a delete with an empty path
    was an rmtree of the whole tree.
    """
    rel = (rel or "").strip()
    if "\x00" in rel:
        raise HTTPException(400, "That is not a path.")
    # Checked BEFORE the slashes are stripped. Stripping first would quietly
    # turn '/etc/passwd' into 'etc/passwd' and look inside the root for it —
    # confined, but answering "not there" to a question that deserves "that
    # is not how paths work here".
    if rel.startswith("/"):
        raise HTTPException(400, "Paths in the explorer are relative to their root.")
    rel = rel.strip("/")
    base = base.resolve()
    p = (base / rel).resolve() if rel else base
    if p != base and not p.is_relative_to(base):
        raise HTTPException(400, "That path leaves its root.")
    if p == base and not allow_root:
        raise HTTPException(400, "That is the root of the tree, not an item in it.")
    return p


def _refuse_links(base: Path, rel: str) -> None:
    """No component of a MUTATION target may be a symlink.

    _confine resolves before testing containment, which is exactly right for
    reading: a link out of the root is refused. It is wrong for writing. A
    link that stays INSIDE the root still resolves to a different file than
    the operator named, so a rename would move something they never pointed
    at; and a link at a path we DERIVE from a confined one (the save's temp
    file) was never confined at all. A mutation must act on the thing that
    was named, so here the lexical path is walked and any link refused.
    """
    p = base.resolve()
    for part in Path((rel or "").strip().strip("/")).parts:
        p = p / part
        if p.is_symlink():
            raise HTTPException(
                400, f"'{part}' is a link. The explorer changes files, not "
                     f"what they point at.")


def _mutation_target(base: Path, rel: str) -> Path:
    """Confine a path we are about to CHANGE, and refuse a link on the way.

    The order is the whole point, and getting it backwards is a fix that
    looks right and does nothing: `_confine` RESOLVES, so handing its output
    to the link check asks about the link's TARGET, which is never itself a
    link. Only the path as the operator NAMED it can answer "is this a
    link", so the walk happens first, on the raw string.
    """
    _refuse_links(base, rel)
    return _confine(base, rel, allow_root=False)


def _rel(base: Path, p: Path) -> str:
    return "" if p == base.resolve() else str(p.relative_to(base.resolve()))


# ── memory policy — every rule below is a property of the store ───────────

def _index_flag(rel: str) -> Optional[bool]:
    """Is this note actually in the live BM25 index? None = not applicable.

    Asked of `memory.index.docs` rather than inferred from the shape of the
    path. The shape rule (`<type-dir>/*.md`, depth 1, exactly what
    OkfStore.iter_files globs) says only whether a file is ELIGIBLE; a note
    that reached disk out of band is eligible and still absent, and reporting
    it as indexed would tell the operator the opposite of the thing this flag
    exists to warn about.

    soul.md is None, not False: identity is loaded by its own path and was
    never meant to be in the index, so flagging it would dress the one file
    working as designed as the broken one.
    """
    if rel == memory.SOUL_ID:
        return None
    parts = Path(rel).parts
    if not (len(parts) == 2 and parts[0] in _MEMORY_DIRS and rel.endswith(".md")):
        return False
    return rel in memory.index.docs


def _memory_writable(rel: str) -> None:
    """Refuse anything the store itself would refuse to rewrite.

    `_PINNABLE_DIRS` is the store's own answer to "what may be replaced" —
    imported, not restated, so journals stay out of reach here for the same
    reason they are out of reach there: they are the record of what happened,
    and there is a surgical forget path for the one case that needs it.
    """
    parts = Path(rel).parts
    if rel == memory.SOUL_ID:
        raise HTTPException(
            403, "soul.md is her identity and is kept in sync with the "
                 "persona setting — edit it in Settings, not here.")
    if len(parts) != 2 or parts[0] not in _PINNABLE_DIRS:
        raise HTTPException(
            403, f"Only {', '.join(sorted(_PINNABLE_DIRS))} items can be "
                 f"written here. Journals are the record of what happened.")
    if not rel.endswith(".md"):
        raise HTTPException(403, "Memory holds markdown notes — the name must end in .md.")


async def _memory_referenced_by(doc_id: str) -> list[str]:
    """Rows that point at this doc id BY PATH, read live.

    Renaming a note is the one edit with no repair path: wiki-links resolve
    by title so they survive, but these columns hold the file path and
    nothing reconciles them. Rather than orphan a row silently, the rename
    refuses and names what is holding it.
    """
    out: list[str] = []
    async with db.acquire() as conn:
        n = await conn.fetchval(
            "SELECT count(*) FROM media_ingests WHERE full_transcript_item_id = $1",
            doc_id)
        if n:
            out.append(f"{n} media ingest{'s' if n > 1 else ''}")
        n = await conn.fetchval(
            "SELECT count(*) FROM ingest_jobs WHERE result_item_id = $1", doc_id)
        if n:
            out.append(f"{n} ingest job{'s' if n > 1 else ''}")
    return out


async def _reindex(doc_id: str, path: Optional[Path]) -> None:
    """The one call that keeps the in-process BM25 index honest.

    There is no watcher and no reindex-on-read: an out-of-band write is
    invisible to search, the catalogue and the tag tiers until this runs,
    while the universe graph (which re-reads disk every call) already shows
    it. So "it appeared in the graph" is never evidence the index is
    consistent. `_index_file` is not self-locking; every caller in the tree
    holds `memory._lock`, and so do we.
    """
    mtime = path.stat().st_mtime if path and path.exists() else 0.0
    async with memory._lock:
        memory._index_file(doc_id, mtime)


# ── listing ──────────────────────────────────────────────────────────────

def _entry(p: Path, base: Path, root: _Root) -> Optional[dict]:
    try:
        real = p.resolve()
        if real != base.resolve() and not real.is_relative_to(base.resolve()):
            return None            # a symlink pointing out of the root
        st = p.stat()
    except OSError:
        return None                # vanished or dangling between glob and stat
    rel = _rel(base, real)
    is_dir = p.is_dir()
    e = {"name": p.name, "path": rel, "dir": is_dir,
         "bytes": 0 if is_dir else st.st_size, "mtime": st.st_mtime}
    # soul.md is deliberately outside iter_files — identity is loaded by its
    # own path, not retrieved by search — so flagging it "not indexed" would
    # dress the one file that is working as designed as the broken one.
    if root.key == MEMORY and not is_dir:
        flag = _index_flag(rel)
        if flag is not None:
            e["indexed"] = flag
    return e


def _list_fs(root: _Root, rel: str) -> list[dict]:
    base = root.base
    assert base is not None
    p = _confine(base, rel)
    if not p.exists():
        raise HTTPException(404, "That folder is not there.")
    if not p.is_dir():
        raise HTTPException(400, "That is a file, not a folder.")
    out = [e for c in p.iterdir() if (e := _entry(c, base, root))]
    out.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    return out


@router.get("/api/v1/files/roots")
async def list_roots():
    return {"roots": [
        {"key": r.key, "label": r.label, "note": r.note,
         "writable": r.writable, "can_mkdir": r.can_mkdir,
         "exists": r.base is None or r.base.exists()}
        for r in _roots().values()]}


@router.get("/api/v1/files/list")
async def list_dir(root: str, path: str = ""):
    return {"entries": _list_fs(_fs_root(root), path)}


# ── read ─────────────────────────────────────────────────────────────────

@router.get("/api/v1/files/read")
async def read_file(root: str, path: str):
    r = _fs_root(root)
    p = _confine(r.base, path)
    if not p.is_file():
        raise HTTPException(404, "That file is not there.")
    size = p.stat().st_size
    if size > MAX_TEXT_BYTES:
        raise HTTPException(
            413, f"That file is {size // 1024} KB — too big to open in the "
                 f"editor (the limit is {MAX_TEXT_BYTES // 1024} KB). "
                 f"Download it instead.")
    raw = p.read_bytes()
    # A pre-read decode, not a guess by extension: __pycache__-style binaries
    # and images decode to replacement characters, and doc_extract already
    # records what happens when replacement chars are mistaken for text.
    if b"\x00" in raw:
        return {"kind": "binary", "name": p.name, "bytes": size, "editable": False,
                "text": "", "reason": "This file is binary, not text."}
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return {"kind": "binary", "name": p.name, "bytes": size, "editable": False,
                "text": "", "reason": "This file is not valid UTF-8 text."}

    rel = _rel(r.base, p)
    editable = r.writable
    why = ""
    if r.key == MEMORY:
        try:
            _memory_writable(rel)
        except HTTPException as e:
            editable, why = False, str(e.detail)
    return {"kind": "text", "name": p.name, "bytes": size, "text": text,
            "mtime": p.stat().st_mtime, "editable": editable, "reason": why,
            "indexed": _index_flag(rel) if r.key == MEMORY else None,
            **(_link_facts(rel, text) if r.key == MEMORY else {})}


@router.get("/api/v1/files/raw")
async def raw_file(root: str, path: str):
    """The bytes, for anything the text editor will not open — an image she
    generated, a PDF you dropped in Workspace."""
    r = _fs_root(root)
    p = _confine(r.base, path)
    if not p.is_file():
        raise HTTPException(404, "That file is not there.")
    # Never a renderable content type. FileResponse guesses from the
    # extension, so a .html or .svg dropped in Workspace came back as
    # text/html — and the client fetches it as a blob (to carry the bearer
    # token), which strips Content-Disposition and inherits THIS origin, so
    # opening it would run its script against the tab that holds the token.
    return FileResponse(p, filename=p.name, media_type="application/octet-stream",
                        headers={"X-Content-Type-Options": "nosniff"})


# ── mutation ─────────────────────────────────────────────────────────────

class WriteBody(BaseModel):
    root: str
    path: str
    content: str
    # What to do with inbound [[links]] when this save changes the note's
    # title. Absent means "I have not been asked yet" and the save refuses
    # with the count; a value means the operator answered.
    links: Optional[Literal["retarget", "unlink"]] = None
    # The fingerprint of the plan the operator was actually shown. Not a
    # boolean: backup_apply already wrote down why — "a boolean is one
    # careless default away from being true" — and a flag cannot hold the
    # property the dialog claims, because the corpus can gain a referrer
    # while the dialog is open (the summariser and ingest worker emit links
    # unattended). Recomputed under the lock and compared before any write.
    confirm_plan: Optional[str] = None


class PathBody(BaseModel):
    root: str
    path: str


class RenameBody(BaseModel):
    root: str
    path: str
    to: str


def _writable_target(root_key: str, rel: str) -> tuple[_Root, Path]:
    r = _fs_root(root_key)
    if not r.writable:
        raise HTTPException(403, f"{r.label} is read-only.")
    p = _mutation_target(r.base, rel)
    if r.key == MEMORY:
        _memory_writable(_rel(r.base, p))
    return r, p


def _link_facts(rel: str, text: str) -> dict:
    """What opening this note should tell you before you touch it.

    `inbound_links` is the blast radius of a title change, and it belongs in
    the header rather than in the dialog: a warning that arrives only after
    you have typed a new title is a warning that arrives too late.

    One `scan` rather than title_map + find_references, which walked the
    corpus twice per open.
    """
    titles, inbound = links.scan(memory.store)
    parsed = memory.store.read_file(rel)
    title = str((parsed[0].get("title") if parsed else "") or "")
    n = sum(c for _, _, c in inbound.get(links.key(title), [])) if title else 0
    return {"inbound_links": n,
            "dangling": links.dangling_in(memory.store, text, titles)}


def _titles_around(rel: str, content: str) -> tuple[str, str]:
    """The note's title before this save and after it.

    Both sides go through the store's own parser, which already strips and
    de-quotes scalars, so no second normalisation is invented here — the
    thing being compared is exactly what the rest of the store would read.
    """
    before = memory.store.read_file(rel)
    old = str((before[0].get("title") or "") if before else "")
    try:
        fm, _ = memory.store.parse_frontmatter(content)
    except Exception:
        fm = {}
    return old, str(fm.get("title") or "")


# A title is spliced verbatim into `[[...]]` across the corpus, so a title
# carrying brackets or a newline would let a retitle write arbitrary prose
# into notes the operator never opened — including journals, which this
# editor otherwise refuses to write at all. Refused independently of that:
# a title containing `]]` also makes its own inbound links unresolvable.
_TITLE_BANNED = set("[]\r\n\t")


def _refuse_bad_title(new_title: str) -> None:
    if _TITLE_BANNED & set(new_title or ""):
        raise HTTPException(
            422, "A title cannot contain square brackets or line breaks — "
                 "links are written as [[title]], so those characters would "
                 "break every link pointing at this note.")


def _refuse_title_collision(rel: str, new_title: str) -> None:
    """Two notes cannot share a title, and there is no confirm for it.

    Resolution is a dict keyed by title, so a duplicate hands every inbound
    link to whichever note the scan reaches last and makes the other
    unreachable by link — silently. No operator intent is served by that, so
    there is nothing to confirm; this is a refusal with no override.
    """
    if not links.key(new_title):
        return
    holders = [d for d in links.title_map(memory.store).get(links.key(new_title), [])
               if d != rel]
    if holders:
        raise HTTPException(409, f"'{holders[0]}' is already titled "
                                 f"“{new_title}”. Two notes with one title means "
                                 f"links to it can only reach one of them, so this "
                                 f"one needs a different title.")


def _title_change_refusal(old: str, new: str, refs: list, plan: str,
                          stale: bool) -> HTTPException:
    """The 409 that carries the whole plan, so the dialog can be honest.

    A structured detail rather than a bare sentence, because the count is the
    entire point — but `message` stays a full sentence so a string-only
    client still gets something true, which is the contract the rest of this
    module keeps.
    """
    notes, occurrences = len(refs), sum(n for _, _, n in refs)
    lead = ("The corpus changed while you were deciding, so here is the "
            "current picture. " if stale else "")
    return HTTPException(409, {
        "code": "title_change_breaks_links",
        "message": (f"{lead}Renaming the title from “{old}” to “{new}” "
                    f"leaves {occurrences} link{'s' if occurrences != 1 else ''} "
                    f"in {notes} other note{'s' if notes != 1 else ''} pointing at a "
                    f"title that will no longer exist. Move them to the new title, "
                    f"or turn them into plain text."),
        "old_title": old, "new_title": new,
        "notes": notes, "occurrences": occurrences,
        "referrers": [{"doc_id": d, "count": n} for d, _, n in refs[:50]],
        "options": ["retarget", "unlink"],
        "plan": plan,
    })


def _os_refusal(e: OSError, p: Path) -> HTTPException:
    """A filesystem error as a sentence.

    Every other refusal in this module explains itself; letting an ordinary
    NotADirectoryError out as a bare 500 with an HTML body is the one answer
    it never otherwise gives.
    """
    if isinstance(e, NotADirectoryError):
        return HTTPException(400, f"Something along the way to '{p.name}' is a file, not a folder.")
    if isinstance(e, IsADirectoryError):
        return HTTPException(400, f"'{p.name}' is a folder.")
    if isinstance(e, FileExistsError):
        return HTTPException(409, f"'{p.name}' is already there.")
    if isinstance(e, PermissionError) or e.errno == errno.EROFS:
        return HTTPException(403, f"The filesystem would not let me write '{p.name}'.")
    if e.errno == errno.ENOSPC:
        return HTTPException(507, "There is no space left on the disk.")
    if e.errno == errno.ENAMETOOLONG:
        return HTTPException(400, "That name is too long for the filesystem.")
    log.warning("files: unexpected OSError on %s: %s", p, e)
    return HTTPException(500, f"The filesystem refused that: {e.strerror or e}.")


def _inherit_owner(p: Path) -> None:
    """Give what we just created the owner of the folder it landed in.

    The backend runs as root, so anything it writes into a bind mount is
    root-owned on the host and the operator cannot edit or delete it without
    sudo — which makes "hand-editable markdown" false for the very files that
    promise it. Copying the parent's uid/gid keeps host ownership intact
    without guessing a uid or making anything world-writable.
    """
    try:
        st = os.stat(p.parent)
        os.chown(p, st.st_uid, st.st_gid, follow_symlinks=False)
    except OSError:
        pass        # not root, or a filesystem with no ownership — not fatal


def _atomic_write(p: Path, data: bytes) -> None:
    """Temp + os.replace, mirroring excise_journal_entry.

    A path DERIVED from a confined path is not itself confined. The temp file
    used to be `.<name>.tmp` opened with write_bytes, so a symlink pre-placed
    at that entirely predictable name redirected the save — and since
    /app/backend is bind-mounted rw from the host checkout, that was an
    arbitrary write into the live source tree, which os.replace then made
    invisible by renaming the link into place. O_EXCL makes the open fail if
    the name exists at all, O_NOFOLLOW makes a link an error rather than a
    redirect, and the random suffix means it cannot be pre-placed to begin
    with. Three independent reasons, because this one is worth over-killing.

    Atomic because memory._lock is an in-process asyncio lock: it does not
    stop a live turn's journal append from interleaving, and a half-written
    note is worse than a rejected save.
    """
    tmp = p.with_name(f".{p.name}.{secrets.token_hex(6)}.tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
        _inherit_owner(tmp)
        os.replace(tmp, p)
    except OSError as e:
        raise _os_refusal(e, p) from e
    finally:
        tmp.unlink(missing_ok=True)


@router.put("/api/v1/files/content")
async def write_content(body: WriteBody):
    """Byte-faithful save.

    What the operator typed is what lands on disk. This deliberately does NOT
    go through memory.write(): its link pass adopts up to five corpus tags
    into frontmatter, appends a `Related:` line to the body and restamps
    `timestamp`, so a save with no edits rewrites 203 of the 214 topics in
    the live corpus. An editor that hands back different bytes than it was
    given is not an editor.
    """
    r, p = _writable_target(body.root, body.path)
    data = body.content.encode("utf-8")
    if len(data) > MAX_TEXT_BYTES:
        raise HTTPException(413, f"That is larger than the {MAX_TEXT_BYTES // 1024} KB limit.")
    if not p.parent.is_dir():
        raise HTTPException(404, "That folder is not there.")
    if p.exists() and p.is_dir():
        raise HTTPException(400, "That is a folder.")

    if r.key != MEMORY:
        _atomic_write(p, data)
        return {"ok": True, "bytes": len(data), "mtime": p.stat().st_mtime}

    rel = _rel(r.base, p)
    old_title, new_title = _titles_around(rel, body.content)
    receipt: Optional[dict] = None

    # Everything below happens under ONE lock, because the plan the operator
    # approved and the corpus the rewrite lands on have to be the same corpus.
    async with memory._lock:
        if links.key(old_title) != links.key(new_title):
            _refuse_bad_title(new_title)
            _refuse_title_collision(rel, new_title)
            refs = links.find_references(memory.store, old_title)
            if refs:
                plan = links.plan_hash(old_title, new_title, refs)
                if not body.links or body.confirm_plan != plan:
                    raise _title_change_refusal(old_title, new_title, refs, plan,
                                                stale=bool(body.confirm_plan))
        # The operator's own bytes land FIRST. Referrers-first would mean a
        # failure here leaves 60 notes pointing at a title that never arrived
        # — strictly worse than the hazard being fixed.
        _atomic_write(p, data)
        memory._index_file(rel, p.stat().st_mtime)

        if links.key(old_title) != links.key(new_title) and body.links:
            changed = links.apply(memory.store, old_title,
                                  new_title if body.links == "retarget" else None)
            for doc_id, mtime, _n, ok in changed:
                if ok:
                    memory._index_file(doc_id, mtime)
            receipt = {
                "action": body.links,
                "from": old_title,
                "to": new_title if body.links == "retarget" else None,
                # Only what was VERIFIED, never the intent — the ntfy receipt
                # convention. A partial rewrite is not self-healing: the next
                # save sees old == new and does nothing, so this list is the
                # only record that a file was missed.
                "notes": sum(1 for _, _, _, ok in changed if ok),
                "occurrences": sum(n for _, _, n, ok in changed if ok),
                "docs": [d for d, _, _, ok in changed if ok],
                "failed": [d for d, _, _, ok in changed if not ok],
            }

    out = {"ok": True, "bytes": len(data), "mtime": p.stat().st_mtime}
    if receipt:
        out["links"] = receipt
    return out


@router.post("/api/v1/files/new-file")
async def new_file(body: PathBody):
    r, p = _writable_target(body.root, body.path)
    if p.exists():
        raise HTTPException(409, f"'{p.name}' is already there.")
    if not p.parent.is_dir():
        raise HTTPException(404, "That folder is not there.")
    seed = ""
    if r.key == MEMORY:
        # A note with no frontmatter indexes as an untitled topic whatever
        # folder it is in, so seed the two fields the index actually reads.
        kind = next((t for t, d in TYPE_DIRS.items()
                     if d == Path(_rel(r.base, p)).parts[0]), "topic")
        title = p.stem.replace("-", " ").replace("_", " ").strip().title()
        seed = f"---\ntype: {kind}\ntitle: {title}\ntags: []\n---\n\n"
    _atomic_write(p, seed.encode("utf-8"))
    if r.key == MEMORY:
        await _reindex(_rel(r.base, p), p)
    return {"ok": True, "path": _rel(r.base, p)}


@router.post("/api/v1/files/new-folder")
async def new_folder(body: PathBody):
    r = _fs_root(body.root)
    if not r.can_mkdir:
        if r.key == MEMORY:
            raise HTTPException(
                403, "Memory is two levels deep by design — she only reads "
                     f"{'/, '.join(sorted(_MEMORY_DIRS))}/*.md, so a folder "
                     "made here would hold notes she could never find.")
        raise HTTPException(403, f"Folders cannot be made in {r.label}.")
    p = _mutation_target(r.base, body.path)
    if p.exists():
        raise HTTPException(409, f"'{p.name}' is already there.")
    made = [q for q in [p, *p.parents] if q.is_relative_to(r.base) and not q.exists()]
    try:
        p.mkdir(parents=True)
    except OSError as e:
        raise _os_refusal(e, p) from e
    for q in sorted(made, key=lambda q: len(q.parts)):
        _inherit_owner(q)
    return {"ok": True, "path": _rel(r.base, p)}


@router.post("/api/v1/files/rename")
async def rename(body: RenameBody):
    r, src = _writable_target(body.root, body.path)
    if not src.exists():
        raise HTTPException(404, "That is not there.")
    name = (body.to or "").strip()
    if not name or "/" in name or name in (".", ".."):
        raise HTTPException(400, "A name, not a path.")
    dst = _mutation_target(r.base, str(Path(_rel(r.base, src)).parent / name))
    if dst.exists():
        raise HTTPException(409, f"'{name}' is already there.")
    old_id = _rel(r.base, src)
    if r.key == MEMORY:
        _memory_writable(_rel(r.base, dst))
        held = await _memory_referenced_by(old_id)
        if held:
            raise HTTPException(
                409, f"'{src.name}' is referenced by {' and '.join(held)}, "
                     f"which point at it by path and would be orphaned. "
                     f"Change the note's title instead — the editor moves "
                     f"inbound links with it, once you confirm.")
    try:
        os.replace(src, dst)
    except OSError as e:
        raise _os_refusal(e, dst) from e
    if r.key == MEMORY:
        await _reindex(old_id, None)                 # evict the old id
        await _reindex(_rel(r.base, dst), dst)       # index the new one
    return {"ok": True, "path": _rel(r.base, dst)}


@router.delete("/api/v1/files/item")
async def delete_item(root: str, path: str, recursive: bool = False):
    r = _fs_root(root)
    if not r.writable:
        raise HTTPException(403, f"{r.label} is read-only.")
    p = _mutation_target(r.base, path)
    if not p.exists():
        raise HTTPException(404, "That is not there.")
    rel = _rel(r.base, p)

    if p.is_dir():
        if r.key == MEMORY:
            raise HTTPException(403, "The memory folders are her structure, not files.")
        kids = list(p.iterdir())
        if kids and not recursive:
            raise HTTPException(409, f"'{p.name}' holds {len(kids)} item"
                                     f"{'s' if len(kids) > 1 else ''}.")
        try:
            shutil.rmtree(p) if kids else p.rmdir()
        except OSError as e:
            raise _os_refusal(e, p) from e
        return {"ok": True}

    if r.key == MEMORY:
        _memory_writable(rel)
        # delete_item, not unlink: it de-references [[wiki-links]] to the
        # deleted title across the corpus and drops the media_ingests row
        # that would otherwise point at a missing file and block re-ingest.
        if not await memory.delete_item(rel):
            raise HTTPException(404, "That note is not there.")
        return {"ok": True}

    try:
        p.unlink()
    except OSError as e:
        raise _os_refusal(e, p) from e
    return {"ok": True}
