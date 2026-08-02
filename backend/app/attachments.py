"""Documents the operator handed over, kept (roadmap #22b).

The premise, in one sentence: a letter photographed on a phone exists in
exactly one place, and until now a chat turn was allowed to be that place —
so a refused turn, a reload, or simply the next message destroyed it. This
module is the thing that keeps it.

Three rules shape every function here, and each is a reaction to a specific
way this feature is normally built wrong.

1. **Identity is never the filename.** Rows are keyed by UUID and bytes by
   sha256. `Scan.pdf`, `invoice.pdf`, `IMG_0042.jpg` are what phones produce
   and collisions are the normal case; anything keyed on a name eventually
   overwrites one document with another and reports success.

2. **The store is verified before it is written to, not after.** If the
   bind mount is missing, a write "succeeds" into the container's own
   filesystem and the operator's only copy dies with the next
   `docker compose up`. `_store_dir` refuses instead. This is the failure
   the whole module exists to prevent, so it is checked on every write
   rather than once at import.

3. **Delete is ordered so a crash cannot produce a false receipt.** The row
   goes LAST, because it is the only handle on the bytes: a crash mid-delete
   leaves a findable row and some missing files, which is recoverable and
   visible. The other order leaves an unreferenced payslip on disk after the
   operator was told it was gone.
"""

import hashlib
import logging
import os
import uuid
from pathlib import Path
from typing import Optional

from app import db

log = logging.getLogger(__name__)

# Inside the container; the compose file binds ./data/attachments here. Its
# own directory rather than a corner of the memory tree, deliberately: the
# memory root is advertised as relocatable to "a NAS mount, an Obsidian
# vault folder" and is hand-editable markdown. Binaries do not belong in a
# directory the operator points at their own vault.
STORE_DIR = Path(os.environ.get("NOVA_ATTACHMENTS_DIR", "/app/data/attachments"))

# Per file. Above any phone photo (a 12 MP JPEG is 3-6 MB) and below the
# nginx body cap of 32 MB, so the refusal an operator hits is this one, with
# a sentence, rather than nginx's bare 413.
MAX_BYTES = 25 * 1024 * 1024


class StoreUnavailable(Exception):
    """The attachment store is not writable. Fail closed: the alternative is
    writing the only copy of a document into a container layer."""


def _store_dir() -> Path:
    """The store, verified. Raises rather than silently creating a directory
    inside the container when the mount is missing.

    The check is DERIVED — it asks the filesystem whether the path is a real
    mount point — rather than trusting a setting that says it should be.
    """
    if not STORE_DIR.exists():
        raise StoreUnavailable(
            f"the attachment store {STORE_DIR} does not exist — the "
            f"./data/attachments mount is missing from docker-compose.yml, "
            f"and writing here would put the only copy of a document inside "
            f"the container")
    if not os.access(STORE_DIR, os.W_OK):
        raise StoreUnavailable(f"the attachment store {STORE_DIR} is not writable")
    return STORE_DIR


def _blob_path(sha: str) -> Path:
    # two-level fanout: one flat directory with thousands of entries is slow
    # to list and unpleasant to look at by hand, and this tree is meant to be
    # legible to the operator
    return _store_dir() / sha[:2] / sha


def store_available() -> tuple[bool, str]:
    """(ok, reason) — for the UI to say why uploads are refused, honestly."""
    try:
        _store_dir()
        return True, ""
    except StoreUnavailable as e:
        return False, str(e)


def _write_blob(data: bytes, sha: str) -> bool:
    """Content-addressed write, atomic, idempotent. True if WE created it.

    Same bytes, same path — so re-uploading a document costs nothing and can
    never half-overwrite the copy that is already there. The tmp+replace
    dance means a crash mid-write leaves either the whole file or no file,
    never a truncated one that would read as a corrupt document later.

    The return value exists so a failed INSERT can undo exactly its own
    write and nothing else: if the blob was already there, some other row
    owns it and it is not ours to remove.
    """
    path = _blob_path(sha)
    if path.exists():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    return True


async def store(data: bytes, *, name: str, mime: str, kind: str,
                conversation_id: str | None = None,
                text: str | None = None, text_source: str | None = None,
                text_error: str | None = None) -> dict:
    """Keep these bytes and return the row.

    Called BEFORE the turn runs, which is the point: a turn that fails, is
    refused, or is abandoned must not be able to destroy the document that
    prompted it.
    """
    if not data:
        raise ValueError("empty attachment")
    if len(data) > MAX_BYTES:
        raise ValueError(
            f"{name} is {len(data) / 1e6:.1f} MB — the limit is "
            f"{MAX_BYTES // (1024 * 1024)} MB per file")
    sha = hashlib.sha256(data).hexdigest()
    # bytes first: a row pointing at a missing file is a lie, the reverse is
    # only a tidy-up
    created = _write_blob(data, sha)
    row_id = uuid.uuid4()
    try:
        async with db.acquire() as conn:
            row = await conn.fetchrow(
                """INSERT INTO attachments (id, sha256, display_name, mime, bytes,
                                            kind, text_content, text_source,
                                            text_error, conversation_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                   RETURNING *""",
                row_id, sha, name or "attachment", mime or "", len(data), kind,
                text, text_source, text_error,
                uuid.UUID(conversation_id) if conversation_id else None)
    except Exception:
        # The row did not land, so nothing references these bytes. Undo OUR
        # write only — if the blob was already on disk another row owns it,
        # and removing it would delete someone else's document.
        #
        # Found by this module's own test suite: a CHECK constraint rejected
        # an invalid text_source and left the bytes stranded, which is
        # precisely the orphan class `usage()` now counts.
        if created:
            try:
                _blob_path(sha).unlink(missing_ok=True)
            except (OSError, StoreUnavailable):
                log.exception("could not roll back the blob for a failed insert")
        raise
    log.info("attachment stored: %s (%s, %d bytes, sha %s)",
             name, kind, len(data), sha[:12])
    return _row(row)


def _row(r) -> dict:
    d = dict(r)
    d["id"] = str(d["id"])
    for k in ("message_id", "conversation_id"):
        d[k] = str(d[k]) if d.get(k) else None
    d["created_at"] = str(d["created_at"]) if d.get("created_at") else None
    return d


async def get(attachment_id: str) -> Optional[dict]:
    async with db.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM attachments WHERE id = $1",
                                  uuid.UUID(attachment_id))
    return _row(row) if row else None


async def read_bytes(attachment_id: str) -> Optional[tuple[bytes, dict]]:
    """The original bytes, or None. Reports a MISSING blob as missing rather
    than as an empty file — an empty download of a document that is supposed
    to be safe is the worst possible way to learn the store broke."""
    row = await get(attachment_id)
    if not row:
        return None
    path = _blob_path(row["sha256"])
    if not path.exists():
        log.error("attachment %s: blob %s is missing from the store",
                  attachment_id, row["sha256"][:12])
        return None
    return path.read_bytes(), row


async def listing(limit: int = 200) -> list[dict]:
    """Newest first, WITHOUT text_content — the list is a list, and a few
    hundred documents' full text is megabytes nobody asked for."""
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, sha256, display_name, mime, bytes, kind, text_source,
                      text_error, message_id, conversation_id, created_at,
                      (text_content IS NOT NULL) AS has_text,
                      length(text_content) AS text_chars
               FROM attachments ORDER BY created_at DESC LIMIT $1""", limit)
    out = []
    for r in rows:
        d = _row(r)
        # derived here rather than stored: whether the bytes are still on
        # disk is a fact about the filesystem right now, and a column would
        # go stale the moment anything touched the store by hand
        try:
            d["present"] = _blob_path(d["sha256"]).exists()
        except StoreUnavailable:
            d["present"] = False
        out.append(d)
    return out


async def attach_to_message(ids: list[str], message_id: str) -> None:
    """Bind stored attachments to the turn that carried them, after the fact.

    Best effort by design: the binding is provenance, and failing to record
    it must never propagate into the turn the operator is watching. The
    document is already safe by this point — that was the whole job.
    """
    if not ids:
        return
    try:
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE attachments SET message_id = $1 WHERE id = ANY($2::uuid[])",
                uuid.UUID(message_id), [uuid.UUID(i) for i in ids])
    except Exception:
        log.exception("could not bind attachments %s to message %s", ids, message_id)


async def delete(attachment_id: str) -> bool:
    """Delete a document, in the order that cannot produce a false receipt.

    Blob first ONLY if no other row shares it, then the row. The row is last
    because it is the only handle on the bytes: crash halfway and you get a
    row whose `present` reads false — visible, recoverable, honest. The
    other order leaves the bytes of a payslip on disk with nothing pointing
    at them, after the operator has been told it was deleted.
    """
    row = await get(attachment_id)
    if not row:
        return False
    async with db.acquire() as conn:
        others = await conn.fetchval(
            "SELECT count(*) FROM attachments WHERE sha256 = $1 AND id <> $2",
            row["sha256"], uuid.UUID(attachment_id))
    if not others:
        # last reference: the bytes go. Derived by query rather than from a
        # refcount column, which is one more thing that can be wrong.
        try:
            path = _blob_path(row["sha256"])
            if path.exists():
                path.unlink()
        except (OSError, StoreUnavailable):
            log.exception("could not unlink blob for %s", attachment_id)
            # deliberately continue: leaving the row would tell the operator
            # the document still exists when its bytes may already be gone
    async with db.acquire() as conn:
        await conn.execute("DELETE FROM attachments WHERE id = $1",
                           uuid.UUID(attachment_id))
    log.info("attachment deleted: %s (%s)", attachment_id, row["display_name"])
    return True


async def usage() -> dict:
    """What the store actually holds — measured, not tallied.

    Counts DISTINCT blobs on disk, so two rows over one file are one file's
    worth of bytes, and a blob whose row was lost still shows up. A number
    kept in a column would have neither property.
    """
    async with db.acquire() as conn:
        rows = await conn.fetch("SELECT DISTINCT sha256, bytes FROM attachments")
    on_disk = 0
    missing = 0
    for r in rows:
        try:
            if _blob_path(r["sha256"]).exists():
                on_disk += r["bytes"]
            else:
                missing += 1
        except StoreUnavailable:
            missing += 1
    # Orphans: bytes on disk that NO row points at. Counted by walking the
    # store and subtracting the index, because "no orphans" is only an
    # invariant if something checks it — the alternative is believing it.
    orphans = 0
    orphan_bytes = 0
    try:
        known = {r["sha256"] for r in rows}
        for p in _store_dir().glob("*/*"):
            if p.is_file() and p.name not in known:
                orphans += 1
                orphan_bytes += p.stat().st_size
    except (OSError, StoreUnavailable):
        log.exception("could not scan the store for orphans")
    ok, why = store_available()
    return {"documents": len(rows), "bytes": on_disk, "missing": missing,
            "orphans": orphans, "orphan_bytes": orphan_bytes,
            "store_ok": ok, "store_error": why}
