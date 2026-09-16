"""S28 — a file he gave her in the conversation.

THE FILE GOES IN THE WORKSPACE, and that is the whole design decision. She
already has `workspace_read_file`, `workspace_list_files`,
`workspace_write_file` and `workspace_delete` over `/data/workspace`, so an
attachment does not need a storage concept of its own: it needs to land
somewhere she can already reach. What follows from that is the point —

  * she reads it with the tools she has, so the read lands on the TRACE
    rather than being asserted in a reply;
  * she can act on it later, in a turn days afterwards, because it is a real
    file with a real path and not a blob attached to one request;
  * nothing here needs a "give the model the file" special case, because
    the only kind that truly needs one is an image.

The row in `attachments` is the RECORD of what arrived — never a second copy
of the bytes, which would be free to disagree with the file.

WHAT IS SNIFFED, NOT TRUSTED. The media type comes from the bytes, not from
the browser's `Content-Type` and not from the filename's extension. Both of
those are claims made by whatever sent the request, and the model routing
downstream turns that claim into a decision: "this is an image" is what
moves a turn onto a different model. A .png that is really a zip must not
make that decision.
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import asyncpg

from app.tools.workspace import _resolve_within, root_from_env

# The ceiling, in one place, stated by every refusal that hits it (owner's
# call, 2026-09-16: 100 MB). nginx carries the same number — `client_max_body_size`
# in apps/web/nginx.conf — and the two disagreeing is the v3 trap this slice
# was warned about: the dev server accepted what the one-origin build
# rejected, so attachments worked everywhere except the phone.
MAX_BYTES = 100 * 1024 * 1024

# Where they land inside the workspace. A folder per conversation, so "what
# did I send in that thread" is answerable with `workspace_list_files` and
# nothing else.
FOLDER = "attachments"

# What the bytes say they are. Sniffed by signature; the browser's declared
# type is not consulted at all.
_SIGNATURES: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"%PDF-", "application/pdf"),
    (b"OggS", "audio/ogg"),
    (b"fLaC", "audio/flac"),
    (b"ID3", "audio/mpeg"),
)

# The kinds a turn treats specially, derived from the media type rather than
# listed per format — `image/anything` is an image.
IMAGE = "image"
AUDIO = "audio"
PDF = "application/pdf"


class AttachmentError(Exception):
    """A stated reason a file could not be taken: too big, empty, or a name
    that is not a name. The text is meant to be shown as-is, and every one of
    them is a CANNOT — never a refusal on the owner's behalf."""


@dataclass(frozen=True)
class Attachment:
    id: uuid.UUID
    conversation_id: uuid.UUID
    message_id: uuid.UUID | None
    person_id: uuid.UUID
    filename: str
    media_type: str
    size_bytes: int
    path: str
    extracted_text: str | None
    extract_note: str | None
    created_at: datetime

    @property
    def kind(self) -> str:
        """The family, for a turn deciding what to do with it. Derived from
        the media type's own first half, so a format nobody has met yet
        ("image/avif") is an image without an edit here."""
        return self.media_type.split("/", 1)[0]

    @classmethod
    def from_row(cls, record: asyncpg.Record) -> Attachment:
        return cls(**{f: record[f] for f in cls.__dataclass_fields__})


def sniff(head: bytes, *, filename: str) -> str:
    """What these bytes ARE.

    Signatures first, because they are the only evidence in the request that
    the sender did not write. The extension is consulted ONLY for kinds that
    have no signature worth trusting — plain text, which is defined by not
    being anything else — and even then the bytes have to decode.
    """
    for magic, media_type in _SIGNATURES:
        if head.startswith(magic):
            return media_type
    # RIFF containers name their own form four bytes in: WEBP and WAV share
    # the header and are not remotely the same thing.
    if head[:4] == b"RIFF" and len(head) >= 12:
        if head[8:12] == b"WEBP":
            return "image/webp"
        if head[8:12] == b"WAVE":
            return "audio/wav"
    # ISO-BMFF (mp4/m4a) carries its brand at offset 4.
    if len(head) >= 12 and head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand.startswith((b"M4A", b"M4B")):
            return "audio/mp4"
        return "video/mp4"
    # A NUL byte means binary, and "does it decode" does not catch it: the C0
    # control characters are all perfectly valid UTF-8, so a file of
    # \x00\x01\x02 decodes cleanly and is not text by any other measure.
    # This is the oldest heuristic there is because nothing better exists —
    # text files do not contain NUL.
    if b"\x00" in head:
        return "application/octet-stream"
    try:
        head.decode("utf-8")
    except UnicodeDecodeError:
        return "application/octet-stream"
    # It decodes, so it is text. The extension picks WHICH text, because
    # `.csv` and `.md` are the same bytes with different meanings and the
    # only place that meaning exists is the name he gave it.
    suffix = Path(filename).suffix.lower()
    return {
        ".csv": "text/csv",
        ".json": "application/json",
        ".md": "text/markdown",
        ".html": "text/html",
        ".xml": "text/xml",
    }.get(suffix, "text/plain")


def safe_name(filename: str) -> str:
    """A file name that is only a file name.

    Directory parts are dropped, control characters and separators go, and
    the result is length-limited — a browser sends whatever the OS gave it,
    which on some platforms is a full path, and `..` is a name a person can
    genuinely type. Containment is enforced again by `_resolve_within` when
    the path is built; this is about producing something readable rather
    than about safety alone, since a file he cannot recognise in a listing
    is a file he cannot use.
    """
    name = unicodedata.normalize("NFC", filename or "").strip()
    name = name.replace("\\", "/").split("/")[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name)
    name = name.strip(". ")
    if not name:
        raise AttachmentError("that file has no name — a name is how you find it again")
    if len(name) > 200:
        stem, dot, suffix = name.rpartition(".")
        keep = 200 - (len(suffix) + 1 if dot else 0)
        name = f"{stem[:keep]}{dot}{suffix}" if dot else name[:200]
    return name


def _unique(folder: Path, name: str) -> str:
    """A name nothing already holds. Two screenshots called `Screenshot.png`
    are two different files, and the second must not overwrite the first —
    he would be looking at the wrong image and nothing would say so."""
    if not (folder / name).exists():
        return name
    stem, dot, suffix = name.rpartition(".")
    stem, suffix = (stem, f".{suffix}") if dot else (name, "")
    for n in range(2, 1000):
        candidate = f"{stem}-{n}{suffix}"
        if not (folder / candidate).exists():
            return candidate
    raise AttachmentError(f"too many files are already called {name!r} in this conversation")


async def store(
    pool: asyncpg.Pool,
    *,
    conversation_id: uuid.UUID,
    person_id: uuid.UUID,
    filename: str,
    body: bytes,
) -> Attachment:
    """Land the bytes in the workspace and write the record.

    THE FILE IS WRITTEN FIRST and the row second, deliberately. A row with no
    file behind it is a promise the Inbox of this feature cannot keep — she
    would read the path and find nothing — whereas a file with no row is
    inert: it sits in the workspace, visible to her file tools like anything
    else, and the sweep below can find it. Of the two ways to be wrong, only
    one of them lies.
    """
    if not body:
        raise AttachmentError("that file is empty — there is nothing in it to read")
    if len(body) > MAX_BYTES:
        raise AttachmentError(
            f"that file is {len(body) / 1_048_576:.1f} MB and the limit is "
            f"{MAX_BYTES // 1_048_576} MB"
        )
    name = safe_name(filename)
    root = root_from_env()
    folder = _resolve_within(root, f"{FOLDER}/{conversation_id}")
    folder.mkdir(parents=True, exist_ok=True)
    name = _unique(folder, name)
    target = _resolve_within(root, f"{FOLDER}/{conversation_id}/{name}")
    target.write_bytes(body)
    rel = str(target.relative_to(root))

    row = await pool.fetchrow(
        "INSERT INTO attachments "
        "(conversation_id, person_id, filename, media_type, size_bytes, path) "
        "VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
        conversation_id,
        person_id,
        name,
        sniff(body[:64], filename=name),
        len(body),
        rel,
    )
    return Attachment.from_row(row)


async def bind(
    pool: asyncpg.Pool,
    *,
    conversation_id: uuid.UUID,
    person_id: uuid.UUID,
    message_id: uuid.UUID,
    ids: list[uuid.UUID],
) -> list[Attachment]:
    """Attach the named uploads to the message that was just sent.

    Scoped to the conversation AND the person: an id from somewhere else
    binds nothing rather than raising, because the ids come off a client and
    "that is not yours" and "that does not exist" are not distinctions this
    API makes (the same answer `owned_conversation` gives).

    Only unbound rows move. Re-sending an id that already belongs to an
    earlier message would otherwise silently move a file from one message to
    another, and the first message would lose the thing it was about.
    """
    if not ids:
        return []
    rows = await pool.fetch(
        "UPDATE attachments SET message_id = $1 "
        "WHERE id = ANY($2::uuid[]) AND conversation_id = $3 AND person_id = $4 "
        "AND message_id IS NULL RETURNING *",
        message_id,
        ids,
        conversation_id,
        person_id,
    )
    return [Attachment.from_row(row) for row in rows]


async def for_message(pool: asyncpg.Pool, message_id: uuid.UUID) -> list[Attachment]:
    """What one message carried, oldest first — the order he picked them."""
    rows = await pool.fetch(
        "SELECT * FROM attachments WHERE message_id = $1 ORDER BY created_at", message_id
    )
    return [Attachment.from_row(row) for row in rows]


async def for_messages(
    pool: asyncpg.Pool, message_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[Attachment]]:
    """The same, for a page of messages, in ONE query — rendering a
    conversation must not be one round trip per message."""
    if not message_ids:
        return {}
    rows = await pool.fetch(
        "SELECT * FROM attachments WHERE message_id = ANY($1::uuid[]) ORDER BY created_at",
        message_ids,
    )
    out: dict[uuid.UUID, list[Attachment]] = {}
    for row in rows:
        out.setdefault(row["message_id"], []).append(Attachment.from_row(row))
    return out


def as_json(attachment: Attachment) -> dict:
    """One attachment as a client reads it. The extracted TEXT is deliberately
    absent: it can be a hundred pages, the page has no use for it, and the
    thing that does use it (the turn) reads it from the row."""
    return {
        "id": str(attachment.id),
        "filename": attachment.filename,
        "media_type": attachment.media_type,
        "kind": attachment.kind,
        "size_bytes": attachment.size_bytes,
        "path": attachment.path,
        "created_at": attachment.created_at.isoformat(),
        # Whether there is text behind this beyond the file itself, and why
        # not when there is not — a scanned PDF and a PDF nobody read are
        # different facts, and only one of them means "no text exists".
        "has_text": attachment.extracted_text is not None,
        "extract_note": attachment.extract_note,
    }


def _size_words(n: int) -> str:
    """A size a person reads. Exact bytes are for a machine; "2.1 MB" is what
    tells him whether the thing he sent is the thing he meant."""
    if n < 1024:
        return f"{n} bytes"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1_048_576:.1f} MB"


def facts_block(rows: list[Attachment], *, unseeable: list[Attachment] | None = None) -> str:
    """What arrived, as FACTS in the turn — never as an instruction.

    Each line names the file, what it is, how big, and WHERE IT IS, because
    the path is the whole point: it is the same string `workspace_read_file`
    takes, so reading what he sent needs no guess and leaves a span. Nothing
    here tells her to read anything; the prompt is not a control (CLAUDE.md),
    and a file she never opens is a file the trace will show she never
    opened.

    `unseeable` names images that could not be shown to any model on this
    box. Said plainly and in the same breath, because the alternative — an
    image silently absent from the turn — is how she ends up describing a
    screenshot from its filename.
    """
    if not rows and not unseeable:
        return ""
    lines = []
    if rows:
        noun = "file" if len(rows) == 1 else "files"
        lines.append(f"He attached {len(rows)} {noun}, in the workspace:")
        for row in rows:
            extra = ""
            if row.extract_note:
                extra = f" — {row.extract_note}"
            elif row.extracted_text is not None:
                extra = " — its text is below"
            lines.append(
                f"- {row.filename} ({row.media_type}, {_size_words(row.size_bytes)}) "
                f"at {row.path}{extra}"
            )
    for row in unseeable or []:
        lines.append(
            f"- {row.filename} is an image at {row.path}, and NO model installed here can "
            "see images, so it is not in this turn. Say that rather than describing it."
        )
    return "\n".join(lines)


def text_block(rows: list[Attachment], *, limit: int = 20_000) -> str:
    """The extracted text of anything that has some, inline.

    A PDF he sent is not useful as a path alone — she would have to read it
    with a tool that cannot parse it. The text goes in the turn, trimmed with
    the trim STATED: a document cut off silently is one she will answer about
    as though she saw all of it.
    """
    out = []
    for row in rows:
        if not row.extracted_text:
            continue
        body = row.extracted_text
        if len(body) > limit:
            body = body[:limit] + (
                f"\n[…trimmed here: {row.filename} has {len(row.extracted_text)} characters "
                f"and this is the first {limit}. The whole file is at {row.path}.]"
            )
        out.append(f"--- {row.filename} ---\n{body}")
    return "\n\n".join(out)


def image_parts(rows: list[Attachment], *, root: Path | None = None) -> list[dict]:
    """Images as the OpenAI-compatible content parts every backend here
    speaks, read from the workspace at send time.

    Read from DISK rather than carried from the upload: the turn that sends
    them may be hours after the upload, and the file is the fact. A file that
    has since gone is skipped rather than sent as an empty string — an empty
    image part is a 400 from the backend, and the caller's `missing` list is
    what says so out loud.
    """
    import base64

    root = root or root_from_env()
    parts = []
    for row in rows:
        target = root / row.path
        if not target.exists():
            continue
        encoded = base64.b64encode(target.read_bytes()).decode("ascii")
        parts.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:{row.media_type};base64,{encoded}"},
            }
        )
    return parts


def missing(rows: list[Attachment], *, root: Path | None = None) -> list[Attachment]:
    """The ones whose file is no longer there. Never silently dropped: a row
    pointing at nothing is a thing she must say, not a thing she must guess
    around."""
    root = root or root_from_env()
    return [row for row in rows if not (root / row.path).exists()]
