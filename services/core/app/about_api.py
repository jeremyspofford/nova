"""/api/v1/about — the About page's one read (app/about.py).

`refresh=true` re-asks GitHub whether there is anything newer instead of
answering from the ten-minute cache; everything else is read live on every
call either way."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app import about, identity
from app.identity import Person

router = APIRouter(prefix="/api/v1/about", tags=["about"])


@router.get("")
async def get_about(
    request: Request, refresh: bool = False, _person: Person = Depends(identity.require_person)
) -> dict:
    return await about.about(request.app, refresh=refresh)
