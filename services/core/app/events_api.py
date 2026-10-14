"""S37c: the event intake, POST /api/v1/events/{sender} (spec §2.2).

Public in core (identity.EVENT_INTAKE_RE: POST, a valid sender name, the whole
path), so the only key this route takes is the sender's own token, checked by
events.verify against its stored hash in constant time. CORE_TOKEN and a
session cookie are just wrong tokens here: a sender's key reaches this one
route, which stores data, and nothing else (spec §4).

Every refusal answers the same 401 body; the reason is kept on a refused row
and in the log (by sender name only), so a caller cannot probe which senders
exist or are off. The token is checked BEFORE the body is read, and the read
itself stops past events.MAX_PAYLOAD_BYTES, whatever Content-Length says.

Reach: localhost and the tailnet only (spec §9 Q3) — nginx carves nothing out
for this path, so the public gate covers it like the rest of the app.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from starlette.responses import JSONResponse

from app import db, events

router = APIRouter(prefix="/api/v1/events", tags=["events"])

REFUSED_BODY = {"error": "refused: this sender does not take that token"}
_BEARER_PREFIX = "Bearer "


def _presented(request: Request) -> str:
    header = request.headers.get("authorization", "")
    return header[len(_BEARER_PREFIX) :] if header.startswith(_BEARER_PREFIX) else ""


async def _read_capped(request: Request) -> bytes | None:
    """The body, or None as soon as it passes the cap (never read whole)."""
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > events.MAX_PAYLOAD_BYTES:
            return None
    return bytes(body)


@router.post("/{sender}", status_code=202)
async def intake(sender: str, request: Request):
    pool = await db.get_pool()
    verdict = await events.verify(pool, sender, _presented(request))
    if not verdict.ok:
        await events.refuse(pool, sender, verdict.reason)
        return JSONResponse(REFUSED_BODY, status_code=401, headers={"WWW-Authenticate": "Bearer"})
    body = await _read_capped(request)
    if body is None:
        await events.refuse(pool, sender, events.TOO_BIG)
        return JSONResponse({"error": f"refused: {events.TOO_BIG}"}, status_code=413)
    payload = events.decode_payload(body)
    if payload is None:
        await events.refuse(pool, sender, events.NOT_TEXT)
        return JSONResponse({"error": f"refused: {events.NOT_TEXT}"}, status_code=400)
    event_id = await events.accept(pool, sender, payload, request.headers.get("content-type"))
    # The turn is spawned, never awaited here: the caller gets its 202 at once
    # and the turn runs to completion whoever is still connected (spec §2.2).
    await events.start_event_turn(request.app, pool, sender)
    return {"id": str(event_id)}
