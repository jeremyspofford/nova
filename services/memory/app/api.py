"""HTTP surface: /ingest, /recall, /forget, /export.

store.py and index.py are pure concerns that know nothing about each
other or about HTTP; this module is the only place that wires them
together, and it owns keeping the index consistent with the filesystem
after every write/delete (the brief: "updated on every write/delete").

Bearer auth on every one of these routes is handled upstream by
app.auth.bearer_auth_middleware (mounted once in main.py) — nothing here
re-checks it.
"""

from __future__ import annotations

import io
import logging
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from starlette.responses import StreamingResponse

from app.index import BM25Index
from app.store import MemoryStore, PathEscape, StoredFile, split_entries

logger = logging.getLogger("memory.api")

router = APIRouter()

DEFAULT_ROOT = "/data/memory"

# Keyed by resolved root path. A real deployment has exactly one
# MEMORY_ROOT for the process's whole life, so the first request that
# needs it does the "full rescan at startup" the brief asks for — see
# warm_context(), called from main.py's lifespan, for making that
# literally true rather than merely true-on-first-request. Tests use a
# fresh tmp-dir root per test, so they always hit a cold build here too,
# which is exactly how "restart rescan" is exercised without any special
# reset hook.
_contexts: dict[str, tuple[MemoryStore, BM25Index]] = {}


def _current_root() -> Path:
    return Path(os.environ.get("MEMORY_ROOT", DEFAULT_ROOT)).resolve()


def _index_document(index: BM25Index, stored: StoredFile) -> list[str]:
    """Put one file into the index as its EXCHANGES, and return their unit ids.

    A day of conversation is one file — up to 21 KB of it — and indexing it
    whole was measured (docs/plans/rebuild/slice-13-memory.md) to put the
    400-character excerpt an average of thousands of characters away from the
    answer, because the excerpt centres on wherever the question's ordinary
    words happen to cluster and in a transcript that is almost never near the
    fact. So the INDEX is chunked at the '## HH:MM' headings the store already
    writes; the file on disk is untouched, iter_all still yields whole files,
    and /forget still deletes whole files.

    Every unit keeps the file's title, kind and date, so a hit still says which
    day it came from, and carries the file as its `document` so scope, deletion
    and re-indexing all still work on files.

    Units already indexed for this document and no longer present (a journal
    re-read after an append, an exchange edited out by hand) are retired first:
    an index that only ever gains chunks would go on citing spans that are not
    in the file any more.
    """
    entries = split_entries(stored.body)
    title = stored.meta.get("title", "")
    kind = stored.meta.get("kind", "topic")
    created = stored.meta.get("created")
    if not entries:
        # A topic note has no headings: one unit, id == the file's own path,
        # exactly as before chunking existed.
        index.remove(stored.rel_path)
        index.upsert(stored.rel_path, title=title, kind=kind, created=created, body=stored.body)
        return [stored.rel_path]
    live = set()
    for entry in entries:
        unit_id = f"{stored.rel_path}#{entry.fragment}"
        live.add(unit_id)
        index.upsert(
            unit_id,
            title=title,
            kind=kind,
            created=created,
            body=entry.text,
            document=stored.rel_path,
            fragment=entry.fragment,
        )
    for stale in index.units_for(stored.rel_path):
        if stale not in live:
            index.remove_unit(stale)
    return [f"{stored.rel_path}#{entry.fragment}" for entry in entries]


def _build_context(root: Path) -> tuple[MemoryStore, BM25Index]:
    store = MemoryStore(root)
    index = BM25Index()
    for stored in store.iter_all():
        # store.iter_all() only guarantees the YAML frontmatter block
        # parsed as a mapping — it does not validate individual fields.
        # A file with valid structure but a missing/unparseable
        # `created` (hand-edited, corrupted, from a future schema) makes
        # index.upsert()'s date coercion raise. That is exactly the same
        # class of problem as a file that fails to parse at all: log it,
        # name it, skip it, and keep the rest of the store intact —
        # never let one bad file take down a full rescan (startup via
        # warm_context(), or a request via the lazy path here).
        try:
            _index_document(index, stored)
        except ValueError as exc:
            logger.warning("skipping unindexable memory file %s: %s", stored.rel_path, exc)
    return store, index


def _context() -> tuple[MemoryStore, BM25Index]:
    root = _current_root()
    key = str(root)
    ctx = _contexts.get(key)
    if ctx is None:
        ctx = _build_context(root)
        _contexts[key] = ctx
    return ctx


def warm_context() -> None:
    """Force the full rescan now instead of on the first request. Called
    from main.py's lifespan so "built by full rescan at startup" is true
    of the real deployment, not just of the lazy-init fallback."""
    _context()


class Exchange(BaseModel):
    user: str
    assistant: str


class IngestRequest(BaseModel):
    person_id: str
    conversation_id: str
    exchange: Exchange


class RecallRequest(BaseModel):
    query: str
    person_id: str
    k: int = 5


class SaveRequest(BaseModel):
    person_id: str
    title: str
    content: str


class ForgetRequest(BaseModel):
    person_id: str
    path: str


@router.post("/ingest")
async def ingest(req: IngestRequest) -> dict:
    store, index = _context()
    user_text = req.exchange.user.strip()
    assistant_text = req.exchange.assistant.strip()
    entry = f"User: {user_text}\n\nAssistant: {assistant_text}"

    try:
        abs_path, _created_new = store.append_journal(req.person_id, entry)
    except PathEscape as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    # Verify mechanically before reporting success: re-read the file
    # from disk and confirm both halves of the exchange actually landed.
    # Never report an append that was not checked.
    on_disk = abs_path.read_text(encoding="utf-8")
    if user_text not in on_disk or assistant_text not in on_disk:
        raise HTTPException(status_code=500, detail="ingest write did not verify")

    stored = store.read(abs_path)
    units = _index_document(index, stored)
    # State what is true, then check it anyway. append_journal writes the
    # "## HH:MM" heading and split_entries reads it; if those two ever stop
    # agreeing, this file falls back to being indexed whole and chunking is
    # silently off — recall gets worse and nothing says why. A journal that
    # did not come out as exchanges is a fault, not a quieter success.
    if not any("#" in unit for unit in units):
        raise HTTPException(
            status_code=500,
            detail="the exchange was written but the journal was not indexed as exchanges",
        )
    return {"path": stored.rel_path, "appended": True}


@router.post("/save")
async def save(req: SaveRequest) -> dict:
    """Write one topic note for a person and confirm it landed.

    This is what a caller uses to record something deliberately, as
    opposed to /ingest's automatic journalling of an exchange. It never
    replaces an existing note: a title whose slug is taken gets a
    numbered sibling, because the caller asked to save something, not to
    lose something.
    """
    store, index = _context()
    title = req.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is empty — a note needs a name")
    content = req.content.strip()
    if not content:
        # Nothing to write means nothing to verify, and a save that cannot
        # be checked must not answer "saved".
        raise HTTPException(status_code=400, detail="content is empty — there is nothing to save")

    try:
        abs_path = store.create_topic(req.person_id, title, content)
    except PathEscape as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"could not write the note: {exc}") from None

    # Verify mechanically before reporting success — re-read from disk and
    # confirm the body is actually in the file, exactly as /ingest does.
    if not abs_path.is_file():
        raise HTTPException(status_code=500, detail="the save did not verify — no file on disk")
    if content not in abs_path.read_text(encoding="utf-8"):
        raise HTTPException(
            status_code=500, detail="the save did not verify — the note's content is not in it"
        )

    stored = store.read(abs_path)
    _index_document(index, stored)
    return {"path": stored.rel_path, "saved": True}


@router.post("/recall")
async def recall(req: RecallRequest) -> dict:
    """What these notes hold on a question — or a stated nothing.

    The answer is {hits, found, statement}, not a bare list, because a bare
    list could only ever say "no hits" and this route now has three different
    things to say: here is what matched; the notes hold no answer, and here is
    why; and (as an HTTP failure, never as an empty list) the notes could not
    be read at all. `statement` is the sentence a caller can repeat — the
    relevance floor is this service's rule, so the words for it belong here and
    not in whatever calls it.
    """
    store, index = _context()
    try:
        person_root = store.person_root(req.person_id)
    except PathEscape as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    scope_prefix = store.rel_path(person_root) + "/"
    outcome = index.search_detail(req.query, scope_prefix=scope_prefix, k=max(req.k, 0))
    hits = outcome.hits

    # Scope is mechanical: re-assert the resolved path of every hit
    # before it leaves the process, even though the index was only ever
    # asked to search inside scope_prefix. This is the load-bearing
    # check, not the index's own filtering.
    safe_hits = []
    for hit in hits:
        # A hit's id names an exchange ("...md#16:32"); the FILE is what the
        # scope check resolves, and the index hands it over as its own field
        # rather than the check re-splitting the id and getting the rule
        # slightly different from the one that built it.
        try:
            resolved = store.resolve_in_person(req.person_id, hit["document"])
        except PathEscape:
            logger.error("index produced an out-of-scope hit: %s", hit["document"])
            continue
        if not resolved.is_file():
            continue
        safe_hits.append(hit)

    if safe_hits:
        return {
            "hits": safe_hits,
            "found": True,
            "statement": (
                f"{len(safe_hits)} note(s) matched and cleared the relevance floor, "
                "best match first."
            ),
        }
    # No hits: say WHICH nothing this is. index.search_detail gives the reason
    # when it found nothing; when it found something and every hit was then
    # dropped by the scope re-check above, the index and the disk disagree, and
    # that is a fault to name rather than an answer to report as an empty one.
    reason = outcome.reason or (
        "the notes that matched are no longer on disk, so this search could not be completed"
    )
    return {
        "hits": [],
        "found": False,
        "statement": f"These notes hold no answer to that — {reason}.",
    }


@router.post("/forget")
async def forget(req: ForgetRequest) -> dict:
    store, index = _context()
    try:
        resolved = store.resolve_in_person(req.person_id, req.path)
    except PathEscape as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="no such memory file")

    canonical = store.rel_path(resolved)
    store.delete(resolved)
    if resolved.exists():
        raise HTTPException(status_code=500, detail="forget did not verify deletion")

    index.remove(canonical)
    return {"path": canonical, "deleted": True}


@router.get("/export")
async def export(person_id: str = Query(...)) -> StreamingResponse:
    store, _index = _context()
    try:
        data = store.export_tar_gz(person_id)
    except PathEscape as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/gzip",
        headers={"Content-Disposition": f'attachment; filename="{person_id}.tar.gz"'},
    )
