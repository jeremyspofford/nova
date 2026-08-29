"""GET /api/v1/workspace/{files,file,raw} — the operator's read-only window
into what Nova wrote into her workspace (the tools in
app/tools/workspace.py, which run inside the same WORKSPACE_ROOT).

Every path a caller supplies goes through THAT module's `_resolve_within`
— imported, never re-derived — the same realpath-containment gate the
tools themselves are proved against in test_tools_workspace.py. A
traversal, an absolute escape, or a symlink pointing outside the root is
refused here in exactly the terms it is refused when Nova tries it. The
recursive listing reuses `iter_contained_files` the same way — it is the
half of the gate that walks a directory rather than resolving one
caller-supplied path, exported from workspace.py for exactly this.

This module never inserts, updates or deletes a database row, and never
calls write_text/write_bytes/os.replace on the filesystem either — it only
ever stats and reads bytes off the workspace volume. test_workspace_api.py
pins this by grepping the module's own source for exactly those write
verbs, so a future edit that adds one back fails loudly rather than
quietly.
"""
from __future__ import annotations

import mimetypes
import re
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from app import identity
from app.identity import Person
from app.tools.base import ToolFailure
from app.tools.workspace import _display, _resolve_within, iter_contained_files, root_from_env

router = APIRouter(prefix="/api/v1/workspace", tags=["workspace"])

# _resolve_within only forbids a path escaping the root — it says nothing
# about which characters make up the final component, and the write
# tool's _atomic_write does not either. A POSIX filename may legally
# contain a double-quote or a raw CR/LF (proved in test_workspace_api.py
# by creating exactly such files directly on disk), so a filename is never
# trusted to go straight into a header value: control characters (CR/LF
# among them — that pair is what turns one header into an injected
# second one) and the quote that would terminate an RFC 6266 quoted-string
# early are stripped from the ASCII fallback name.
_UNSAFE_IN_QUOTED_ASCII = re.compile(r'["\x00-\x1f\x7f]')


def _content_disposition(filename: str) -> str:
    """An `attachment` Content-Disposition value safe to interpolate
    verbatim into a response header, whatever `filename` actually
    contains. The RFC 5987 `filename*` parameter carries the real name
    intact — percent-encoding neutralises the quote, CR/LF and everything
    else a raw byte could do inside a header — and `filename=` is the
    plain ASCII fallback RFC 6266 reserves for clients that do not
    understand `filename*`, with anything that could break out of its
    quoted-string stripped rather than the real name ever reaching the
    header unescaped.
    """
    ascii_name = filename.encode("ascii", "replace").decode("ascii")
    ascii_name = _UNSAFE_IN_QUOTED_ASCII.sub("_", ascii_name)
    encoded = quote(filename, safe="")
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{encoded}'

# The listing cap protects the response size the same way the tool's
# MAX_LIST_ENTRIES protects the model's context — a different number
# because this is rendered in a scrollable table, not spent out of a
# context window, but the same shape: capped, and the truncation stated
# rather than silently dropped.
MAX_LIST_ENTRIES = 500

# 256 KB, distinct from the tool's own 32 KB read cap (workspace.py's
# MAX_READ_BYTES): the tool result rides in the model's context, this is a
# browser tab. Both caps refuse whole rather than truncate silently, but
# they answer different questions and are allowed different numbers.
MAX_TEXT_BYTES = 256 * 1024


def _entry(root: Path, path: Path) -> dict:
    stat = path.stat()
    return {
        "path": _display(root, path),
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat(),
    }


def _resolve_or_400(root: Path, path_param: str) -> Path:
    try:
        return _resolve_within(root, path_param)
    except ToolFailure as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


def _existing_file_or_error(root: Path, path_param: str) -> Path:
    """Shared by /file and /raw: resolve, then the same not-a-directory /
    404 story either route tells."""
    target = _resolve_or_400(root, path_param)
    if target.is_dir():
        raise HTTPException(
            status_code=400, detail=f"{path_param!r} is a directory, not a file"
        )
    if not target.is_file():
        raise HTTPException(
            status_code=404, detail=f"there is no file at {path_param!r} in the workspace"
        )
    return target


@router.get("/files")
async def list_workspace_files(_person: Person = Depends(identity.require_person)) -> dict:
    root = root_from_env().resolve()
    if not root.is_dir():
        # Nothing has ever been written to the volume — an empty workspace,
        # not a broken one (same stance as the tool's list_files).
        return {"files": [], "total": 0, "truncated": False}

    entries = [_entry(root, path) for path in iter_contained_files(root, root)]
    return {
        "files": entries[:MAX_LIST_ENTRIES],
        "total": len(entries),
        "truncated": len(entries) > MAX_LIST_ENTRIES,
    }


@router.get("/file")
async def get_workspace_file(
    path: str = Query(...), _person: Person = Depends(identity.require_person)
) -> dict:
    root = root_from_env().resolve()
    target = _existing_file_or_error(root, path)
    stat = target.stat()
    body: dict = {
        "path": _display(root, target),
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat(),
        "text": None,
        "binary": False,
        "too_large": False,
    }

    if stat.st_size > MAX_TEXT_BYTES:
        # Refused whole, never a truncated preview that reads as the whole
        # file — the same stance write_file takes on the way in.
        body["too_large"] = True
        return body

    data = target.read_bytes()
    try:
        body["text"] = data.decode("utf-8")
    except UnicodeDecodeError:
        # Not text — say so rather than dumping the bytes into a JSON
        # string field, which would either mangle them or blow up the
        # response for no reason a viewer can render anyway.
        body["binary"] = True
    return body


@router.get("/raw")
async def get_workspace_raw(
    path: str = Query(...), _person: Person = Depends(identity.require_person)
) -> Response:
    root = root_from_env().resolve()
    target = _existing_file_or_error(root, path)
    data = target.read_bytes()
    media_type, _ = mimetypes.guess_type(target.name)
    return Response(
        content=data,
        media_type=media_type or "application/octet-stream",
        headers={"Content-Disposition": _content_disposition(target.name)},
    )
