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

T8 adds the senders API, /api/v1/event-senders (Settings > Events, spec §2.1):
deliberately OFF the intake's prefix, so no GET/PATCH/DELETE can ever match the
public matcher and no sender name collides with a route. Every route needs an
identity (require_person: the owner's session); a sender's token is just a
wrong bearer here. The token is returned once, by the POST that made it (or,
for one Nova added, by the one-time reveal) — no GET returns it.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from starlette.responses import JSONResponse

from app import db, events, identity
from app.identity import Person

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
    try:
        event_id = await events.accept(pool, sender, payload, request.headers.get("content-type"))
    except events.Refused as gone:
        # Deleted or switched off while the body was read: the same refusal.
        await events.refuse(pool, sender, gone.reason)
        return JSONResponse(REFUSED_BODY, status_code=401, headers={"WWW-Authenticate": "Bearer"})
    # The turn is spawned, never awaited here: the caller gets its 202 at once
    # and the turn runs to completion whoever is still connected (spec §2.2).
    await events.start_event_turn(request.app, pool, sender)
    return {"id": str(event_id)}


# -- T8: the senders API --------------------------------------------------------------

senders_router = APIRouter(prefix="/api/v1/event-senders", tags=["events"])


def _route_json(route) -> dict:
    return {"registered": route.registered, "detail": route.detail}


def _only(body: Any, keys: set[str]) -> dict:
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="the body is a JSON object")
    extra = sorted(set(body) - keys)
    if extra:
        raise HTTPException(
            status_code=400,
            detail=f"unknown field(s) {', '.join(extra)} — this takes {', '.join(sorted(keys))}",
        )
    return body


@senders_router.get("")
async def list_senders(_person: Person = Depends(identity.require_person)) -> list[dict]:
    return await events.list_senders(await db.get_pool())


@senders_router.post("", status_code=201)
async def add_sender(
    request: Request,
    body: Any = Body(...),
    _person: Person = Depends(identity.require_person),
) -> dict:
    name = _only(body, {"name"}).get("name")
    if not isinstance(name, str):
        raise HTTPException(status_code=400, detail="name is required, as text")
    pool = await db.get_pool()
    try:
        created = await events.create_sender(request.app, pool, name, added_by="owner")
    except events.SenderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except events.RouteFailed as exc:
        raise HTTPException(
            status_code=502, detail=f"sender {name!r} was not added — {exc}"
        ) from exc
    return {**created.sender, "token": created.token, "route": _route_json(created.route)}


@senders_router.post("/{name}/token")
async def reveal_token(name: str, _person: Person = Depends(identity.require_person)) -> dict:
    """The one reveal of a token Nova's event_sender_add kept for this screen."""
    token = await events.take_token_once(await db.get_pool(), name)
    if token is None:
        raise HTTPException(
            status_code=404,
            detail=f"no token waits for {name!r}: it was shown once already, or never kept",
        )
    return {"name": name, "token": token}


@senders_router.patch("/{name}")
async def switch_sender(
    name: str, body: Any = Body(...), _person: Person = Depends(identity.require_person)
) -> dict:
    enabled = _only(body, {"enabled"}).get("enabled")
    if not isinstance(enabled, bool):
        raise HTTPException(status_code=400, detail="enabled is required, true or false")
    try:
        return await events.set_enabled(await db.get_pool(), name, enabled)
    except events.NoSuchSender as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@senders_router.delete("/{name}")
async def delete_sender(
    name: str, request: Request, _person: Person = Depends(identity.require_person)
) -> dict:
    try:
        deleted = await events.delete_sender(request.app, await db.get_pool(), name)
    except events.NoSuchSender as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except events.SenderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "deleted": deleted.name,
        "failed_events": deleted.failed_events,
        "route": _route_json(deleted.route),
    }
