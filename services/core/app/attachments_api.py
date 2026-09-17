"""/api/v1/attachments — taking a file he gave her.

One route, and everything it does is verified: the bytes are read, sniffed,
written into the workspace, and the row is read back from the statement that
wrote it. The answer is the row, not the request restated.

WHAT THIS IS NOT: a second file store. The bytes land in the workspace she
already has tools over, so the next thing that happens to this file happens
through `workspace_read_file` and appears on the trace. See app/attachments.py.

THE UPLOAD IS ITS OWN REQUEST, before the message that carries it. He picks a
file, then types, then sends — and the send (`POST /chat/stream`) names the
ids it is carrying. Doing it in one multipart request with the message would
mean a photo on a phone connection holds the chat POST open for its whole
upload, and the turn could not start until the last byte landed.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse

from app import attachments, conversations, db, identity
from app.attachments import AttachmentError
from app.identity import Person
from app.tools.workspace import root_from_env

router = APIRouter(prefix="/api/v1/attachments", tags=["attachments"])


@router.post("")
async def upload(
    conversation_id: uuid.UUID = Form(...),
    file: UploadFile = File(...),
    person: Person = Depends(identity.require_person),
) -> dict:
    """Take one file into a conversation he owns.

    Ownership is checked the way every conversation route checks it, so a
    conversation that is not his is NOT FOUND rather than forbidden — the
    same answer, so nothing here tells a stranger which conversations exist.

    A file too big for the ceiling is a 413 with the size and the limit in
    words. It has to be stated rather than merely enforced: nginx refuses the
    same request at the same ceiling with a bare 413 and no sentence, and
    "the upload failed" with no number is how someone tries the same photo
    three times.
    """
    pool = await db.get_pool()
    await conversations.owned_conversation(pool, person, conversation_id)
    body = await file.read()
    try:
        row = await attachments.store(
            pool,
            conversation_id=conversation_id,
            person_id=person.id,
            filename=file.filename or "",
            body=body,
        )
    except AttachmentError as exc:
        # 413 for the ceiling, 400 for a file that is unusable for another
        # reason (empty, nameless). Both carry the store's own sentence.
        status = 413 if "limit is" in str(exc) else 400
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    return {"attachment": attachments.as_json(row), "max_bytes": attachments.MAX_BYTES}


@router.get("/{attachment_id}/content")
async def content(
    attachment_id: uuid.UUID, person: Person = Depends(identity.require_person)
) -> Response:
    """The bytes, so a picture he sent can be drawn in the transcript.

    Scoped to the person who uploaded it: someone else's file is NOT FOUND
    rather than forbidden, the same answer every conversation route gives.

    `Content-Disposition: inline` with the filename, so an image renders in
    place and anything else keeps the name he chose when he saves it. The
    media type is the SNIFFED one from the row, never a guess from the
    extension here — the same value the turn routed on, so what the browser
    renders and what she was sent cannot be two different opinions about one
    file.

    A row whose file has gone is a 410, not a 404: the difference is "this
    never existed" versus "this existed and the bytes are gone", and only the
    second one means the workspace was swept or edited underneath it.
    """
    pool = await db.get_pool()
    row = await pool.fetchrow(
        "SELECT * FROM attachments WHERE id = $1 AND person_id = $2", attachment_id, person.id
    )
    if row is None:
        raise HTTPException(status_code=404, detail=f"no attachment {attachment_id} here")
    file = attachments.Attachment.from_row(row)
    target = root_from_env() / file.path
    if not target.exists():
        raise HTTPException(
            status_code=410,
            detail=f"{file.filename} is recorded but its file is no longer in the workspace",
        )
    return FileResponse(
        target,
        media_type=file.media_type,
        filename=file.filename,
        content_disposition_type="inline",
    )


@router.get("/limits")
async def limits(person: Person = Depends(identity.require_person)) -> dict:
    """What the client should refuse before it starts uploading.

    The page reads this rather than carrying its own copy: a limit written in
    two places is a limit that disagrees with itself the day one of them
    changes, and the half that would be wrong is the one that tells him.
    """
    return {"max_bytes": attachments.MAX_BYTES}
