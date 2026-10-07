"""/api/v1/about — the About page's one read (app/about.py).

`refresh=true` re-asks GitHub whether there is anything newer instead of
answering from the ten-minute cache; everything else is read live on every
call either way."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from app import about, db, identity, nova_updates
from app.identity import Person

router = APIRouter(prefix="/api/v1/about", tags=["about"])


@router.get("")
async def get_about(
    request: Request, refresh: bool = False, _person: Person = Depends(identity.require_person)
) -> dict:
    return await about.about(request.app, refresh=refresh)


@router.post("/update")
async def start_update(request: Request, person: Person = Depends(identity.require_person)) -> dict:
    """The page's "Update now": the same start as nova_update. 409 with the
    reason when it cannot run; otherwise the opened attempt, which says it
    started and nothing more."""
    try:
        row = await nova_updates.start(request.app, await db.get_pool(), requested_by=person.name)
    except nova_updates.CannotUpdate as exc:
        raise HTTPException(status_code=409, detail=exc.reason) from exc
    return {"update": row}
