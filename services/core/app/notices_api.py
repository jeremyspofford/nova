"""/api/v1/notices — the Inbox's surface over the notices store (app/notices.py).

What she noticed, what she did about it, and the two things he can say back:
"I've read that" and "stop telling me about this". Nothing here decides
anything. Every write is one store call, every row is read BACK from the
statement that wrote it, and the store's own words are what a refusal says.

Neither button is a permission (owner ruling 2026-09-03). `seen` is a read
receipt and `mute` is a NOISE preference — stop telling me about these facts
until they change — and the store holds the difference: a muted row keeps its
fingerprint, so identical facts keep folding onto it silently while CHANGED
facts are a different fingerprint and so a fresh, unmuted notice. Neither
permits or forbids anything she does, and there is nothing on this router that
she waits on.

`unseen_count` rides on every answer, including the two writes, because the
badge is the SERVER's count of what he has not read (`notices.unseen_count`,
derived from UNSEEN_STATES) and never the page's guess from the rows it
happens to be holding. A click that changes the count returns the new one in
the same response, so the badge cannot drift from the store between polls.

Notices are household objects, like agents: they belong to the beats, the
beats belong to the owner, and the table carries no person of its own — so
nothing here is ownership-scoped and `require_person` is only the same auth
every route has. A `notice_id` that names no row is a 404 in the store's own
sentence.
"""

from __future__ import annotations

import uuid

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app import db, identity, notices
from app.identity import Person
from app.notices import Notice, NoticeError

router = APIRouter(prefix="/api/v1/notices", tags=["notices"])

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


class MuteBody(BaseModel):
    # Required: a body without the key is a 422, so a client that forgot the
    # field can never mute (or unmute) by accident. The same shape as
    # timers_api's AgentBody, for the same reason.
    muted: bool


def notice_json(notice: Notice) -> dict:
    """One notice as the Inbox reads it. Timestamps are ISO strings and ids are
    strings, the same way timers.timer_spec serialises a row.

    `acted_turn_id` is here so the page can open the trace of the turn that DID
    something about this — a claim she made about acting is checkable by
    clicking it, which is the whole reason the store records the turn id beside
    the note.
    """
    return {
        "id": str(notice.id),
        "check_name": notice.check_name,
        "title": notice.title,
        "facts": notice.facts,
        "urgent": notice.urgent,
        "acted": notice.acted,
        "acted_note": notice.acted_note,
        "acted_turn_id": str(notice.acted_turn_id) if notice.acted_turn_id else None,
        "repeats": notice.repeats,
        "state": notice.state,
        "delivery": notice.delivery,
        "failed_reason": notice.failed_reason,
        "first_seen_at": notice.first_seen_at.isoformat(),
        "last_seen_at": notice.last_seen_at.isoformat(),
        "delivered_at": notice.delivered_at.isoformat() if notice.delivered_at else None,
        "seen_at": notice.seen_at.isoformat() if notice.seen_at else None,
        "muted_at": notice.muted_at.isoformat() if notice.muted_at else None,
        "cleared_at": notice.cleared_at.isoformat() if notice.cleared_at else None,
    }


async def _written(pool: asyncpg.Pool, notice: Notice) -> dict:
    """One write's answer: the row the store wrote, plus the badge counted
    AFTER it — so a click that made something read hands back the number it
    made true, rather than the page decrementing its own copy."""
    return {"notice": notice_json(notice), "unseen_count": await notices.unseen_count(pool)}


def _not_found(exc: NoticeError) -> HTTPException:
    """The store's own sentence, as a 404.

    `mark_seen` and `set_muted` take no values to judge — the only CANNOT
    either can raise is an id that names no row ("no notice with id … exists —
    nothing was written"), which is exactly a 404. Every other NoticeError in
    the store guards a value this router does not send.
    """
    return HTTPException(status_code=404, detail=str(exc))


@router.get("")
async def list_notices(
    limit: int = Query(DEFAULT_LIMIT, ge=1),
    person: Person = Depends(identity.require_person),
) -> dict:
    """The Inbox page: most recently SEEN BY A CHECK first, so what is still
    true today sits above what stopped recurring last week. Cleared rows are
    included — "this was true and is not any more" is part of the record —
    and each carries its own `cleared_at` for the page to render it by."""
    pool = await db.get_pool()
    rows = await notices.recent(pool, limit=min(limit, MAX_LIMIT))
    return {
        "notices": [notice_json(row) for row in rows],
        "unseen_count": await notices.unseen_count(pool),
    }


@router.put("/{notice_id}/seen")
async def mark_seen(
    notice_id: uuid.UUID, person: Person = Depends(identity.require_person)
) -> dict:
    """He read it. The store stamps the FIRST read (a second click is
    idempotent) and leaves a mute or a failed state exactly where it is — the
    receipt is the timestamp, and it is what takes the row out of the badge and
    out of the next digest."""
    pool = await db.get_pool()
    try:
        notice = await notices.mark_seen(pool, notice_id)
    except NoticeError as exc:
        raise _not_found(exc) from exc
    return await _written(pool, notice)


@router.put("/{notice_id}/mute")
async def set_muted(
    notice_id: uuid.UUID,
    body: MuteBody,
    person: Person = Depends(identity.require_person),
) -> dict:
    """Stop telling him about these facts, or start again. Unmuting puts the
    row back into the state its own evidence supports (the store derives it
    from the timestamps rather than remembering a previous one), so a notice
    nobody was ever told about becomes deliverable again and one he had already
    read comes back read."""
    pool = await db.get_pool()
    try:
        notice = await notices.set_muted(pool, notice_id, body.muted)
    except NoticeError as exc:
        raise _not_found(exc) from exc
    return await _written(pool, notice)
