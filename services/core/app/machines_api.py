"""/api/v1/machines — the Settings tile's surface over the machines that run
models (S40). Every answer is the gateway's reading through app/machines.py;
the one write is the serving switch, answered with the value READ BACK.

The switch is availability, never permission (D2): the gateway's routing is
its only reader, and nothing anywhere waits on it."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, StrictBool

from app import identity, machines
from app.identity import Person

router = APIRouter(prefix="/api/v1/machines", tags=["machines"])


class ServingBody(BaseModel):
    # Required: a body without it is a 422, so a client that forgot the field
    # can never flip a machine's switch by accident (notices_api.MuteBody).
    # Strict: a lax bool would read "no" or 0 as off — a switch position is
    # true or false, nothing that coerces to one.
    serving: StrictBool


@router.get("")
async def list_machines(
    request: Request, live: bool = False, person: Person = Depends(identity.require_person)
) -> dict:
    try:
        views = await machines.plant().engines(request.app, live=live)
    except machines.PlantUnavailable as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"machines": [machines.machine_json(view) for view in views]}


@router.patch("/{name}")
async def set_serving(
    name: str,
    body: ServingBody,
    request: Request,
    person: Person = Depends(identity.require_person),
) -> dict:
    try:
        back = await machines.plant().set_serving(request.app, name, body.serving)
    except machines.UnknownMachine as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except machines.PlantUnavailable as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return machines.machine_json(back)
