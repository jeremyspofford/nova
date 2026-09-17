"""/api/v1/notices — the Inbox's surface over the notices store (app/notices.py).

What she noticed, what she did about it, and the two things he can say back:
"I've read that" and "stop telling me about this". Nothing here decides
anything. Every write is one store call, every row is read BACK from the
statement that wrote it, and the store's own words are what a refusal says.

Neither button is a permission (owner ruling 2026-09-03), and since S25.1.3
neither one does anything the other does. `seen` is a read receipt and
ONLY that: it writes `seen_at`, stops no digest and silences nothing. `mute`
is the one that silences — stop telling me about this condition until it
clears — and the store holds it in `notice_mutes`, keyed on the CONDITION so
a failure count going up cannot come back as a fresh unmuted card. Neither
permits or forbids anything she does, and there is nothing on this router
that she waits on.

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

from app import conversations, db, identity, notices
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
        # WHICH chat row carried it to him, or null (S24/S25.2.4). The page
        # reads THIS and not `delivered_at` to decide whether "talk about
        # this" is possible: a notice delivered by a device push alone has a
        # delivery time and no message, so there is nothing to talk under.
        "delivered_message_id": (
            str(notice.delivered_message_id) if notice.delivered_message_id else None
        ),
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
    muted: bool = Query(False),
    person: Person = Depends(identity.require_person),
) -> dict:
    """The Inbox page: most recently TOLD first (notices._TOLD_AT), so the
    order is his history of being told rather than a ranking of how noisy
    each condition is. Cleared rows are included — "this was true and is not
    any more" is part of the record — and each carries its own `cleared_at`
    for the page to render it by.

    `?muted=true` is the other half of the same table: the rows he silenced,
    which the default view leaves out. `muted_count` rides on BOTH answers so
    the page can label the filter without asking twice — and so the default
    view can say out loud that something is being withheld, which is the
    difference between a filter and a disappearance.
    """
    pool = await db.get_pool()
    rows = await notices.recent(pool, limit=min(limit, MAX_LIMIT), muted=muted)
    # One read of the whole mute table rather than one per row, and attached
    # here rather than carried on the Notice: a mute is about a CONDITION and
    # several rows can share one, so it is not a property of any of them.
    in_force = await notices.mutes(pool)
    listed = []
    for row in rows:
        key = (row.check_name, row.finding_key)
        silenced = key in in_force
        listed.append(
            {
                **notice_json(row),
                # Whether it is silenced NOW, which is not the same as the
                # `muted_at` stamp: clearing a condition forgets its mute and
                # leaves the stamp, because the stamp is the row's history.
                "silenced": silenced,
                # Null means SHE silenced it (S25 Q2) — meaningful only when
                # `silenced` is true.
                "muted_by": str(in_force[key]) if silenced and in_force[key] else None,
            }
        )
    return {
        "notices": listed,
        "unseen_count": await notices.unseen_count(pool),
        "muted_count": await notices.muted_count(pool),
    }


@router.get("/digests")
async def list_digests(
    limit: int = Query(20, ge=1),
    person: Person = Depends(identity.require_person),
) -> dict:
    """ "What you were told on Tuesday" (S25 Q4) — the Inbox by TELLING
    rather than by condition.

    A digest is the group of notices one message carried, derived from
    `delivered_message_id` and never stored. `limit` counts tellings, so the
    oldest group in the answer is whole rather than a fragment presented as
    the whole of it.

    `not_told_yet` rides along because it is the other half of the same
    question: what is standing that no message has carried. It is the same
    fact the Inbox draws as a disabled "talk about this", said once in the
    store so the list and the button cannot disagree.

    DECLARED BEFORE `/{notice_id}` on purpose — FastAPI matches in order,
    and a bare `/digests` would otherwise be read as a notice id and
    answered with the 422 for a malformed UUID.
    """
    pool = await db.get_pool()
    groups = await notices.digests(pool, limit=min(limit, MAX_LIMIT))
    return {
        "digests": [
            {
                "message_id": str(group.message_id),
                "delivered_at": group.delivered_at.isoformat(),
                "notices": [notice_json(row) for row in group.notices],
            }
            for group in groups
        ],
        "not_told_yet": [notice_json(row) for row in await notices.not_told_yet(pool)],
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
        # HIS id, because this is the route he clicks (S25 Q2). Her own tool
        # passes None, and the Inbox renders the difference — a silence he
        # did not ask for must not be indistinguishable from one he did.
        notice = await notices.set_muted(pool, notice_id, body.muted, muted_by=person.id)
    except NoticeError as exc:
        raise _not_found(exc) from exc
    return await _written(pool, notice)


@router.post("/{notice_id}/thread")
async def talk_about_it(
    notice_id: uuid.UUID, person: Person = Depends(identity.require_person)
) -> dict:
    """Open the room off the message that delivered this notice (S25.2.4).

    S24 built the mechanism — a conversation hanging off one message — and
    this is its first consumer. The room is idempotent: asking twice returns
    the same one, because `open_thread` leans on the partial unique index
    rather than checking first.

    A notice that was never DELIVERED has no message, so it has no room, and
    this says so in those words rather than inventing somewhere to talk.
    That is a fact about the world — nobody was told, so there is nothing to
    talk under — and never a decision about him: he can still open the card,
    read it, mute it, and say anything he likes in the main chat.

    Why this lives here rather than the page calling the chat route: the
    Inbox holds a `delivered_message_id` and not the conversation that
    message is in, and handing the page a conversation id just so it can
    hand it back is a fact the client would then be responsible for keeping
    true. `open_thread` derives the conversation by join, and checks he owns
    it in the same query.
    """
    pool = await db.get_pool()
    try:
        notice = await notices.get(pool, notice_id)
    except NoticeError as exc:
        raise _not_found(exc) from exc
    if notice.delivered_message_id is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "this notice has not been delivered, so there is no message to talk under — "
                "it gets a room when the digest or a push carries it to you"
            ),
        )
    row, created = await conversations.open_thread(pool, person, notice.delivered_message_id)
    return {
        "conversation_id": str(row["id"]),
        "parent_message_id": str(row["parent_message_id"]),
        "created": created,
    }
