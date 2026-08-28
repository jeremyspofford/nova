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
from app.store import MemoryStore, PathEscape

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


def _build_context(root: Path) -> tuple[MemoryStore, BM25Index]:
    store = MemoryStore(root)
    index = BM25Index()
    for stored in store.iter_all():
        index.upsert(
            stored.rel_path,
            title=stored.meta.get("title", ""),
            kind=stored.meta.get("kind", "topic"),
            created=stored.meta.get("created"),
            body=stored.body,
        )
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
    index.upsert(
        stored.rel_path,
        title=stored.meta.get("title", ""),
        kind=stored.meta.get("kind", "journal"),
        created=stored.meta.get("created"),
        body=stored.body,
    )
    return {"path": stored.rel_path, "appended": True}


@router.post("/recall")
async def recall(req: RecallRequest) -> list[dict]:
    store, index = _context()
    try:
        person_root = store.person_root(req.person_id)
    except PathEscape as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    scope_prefix = store.rel_path(person_root) + "/"
    hits = index.search(req.query, scope_prefix=scope_prefix, k=max(req.k, 0))

    # Scope is mechanical: re-assert the resolved path of every hit
    # before it leaves the process, even though the index was only ever
    # asked to search inside scope_prefix. This is the load-bearing
    # check, not the index's own filtering.
    safe_hits = []
    for hit in hits:
        try:
            resolved = store.resolve_in_person(req.person_id, hit["path"])
        except PathEscape:
            logger.error("index produced an out-of-scope hit: %s", hit["path"])
            continue
        if not resolved.is_file():
            continue
        safe_hits.append(hit)
    return safe_hits


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
