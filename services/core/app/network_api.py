"""/api/v1/network — Nova's address for another device (S47), as core's one
reader states it. The Settings panels encode THIS, never window.location: the
owner opening Nova on the hub at 127.0.0.1 must still get a QR code another
device can open."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app import identity, network
from app.identity import Person

router = APIRouter(prefix="/api/v1/network", tags=["network"])


@router.get("/address")
async def get_address(person: Person = Depends(identity.require_person)) -> dict:
    return network.address().as_json()
