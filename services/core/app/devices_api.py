"""/api/v1/devices — mint a pairing code, enroll a machine, edit what it may do.

Every route here is authenticated the way the rest of core is
(identity.require_person — a session cookie or the service bearer) with ONE
deliberate exception: POST /enroll. A daemon on a machine that has never talked
to this instance has no cookie and no bearer; the pairing code IS its
credential, and it is a good one — minted only by an authenticated operator,
shown once, stored hashed, single-use, and dead in ten minutes.

Two consequences of that exception are handled here rather than assumed:

  * /pairing-code stays authed. Minting a code is the authorisation for an
    entire machine, so if that route were public, enrollment being public would
    stop meaning anything.
  * /enroll is rate-limited per address, copying auth_api's login limiter
    (5 failures / 15 minutes / 429). Only the CODE refusal counts as a failure
    — a name collision is an operator typing the same name twice, not somebody
    guessing, and locking them out for it would be a bug wearing a security
    costume. Behind the :3000 nginx origin every request arrives from one
    address, so the limiter degrades to a global one. That is stricter, not
    weaker, and it is why X-Forwarded-For is NOT trusted here: a header the
    caller sets is a bypass, not an identity.

Handlers do nothing devices.py does not already do. Refusals are its
DeviceRefused, re-stated with the status it chose, so the reason the operator
reads is the reason the database enforced.
"""
from __future__ import annotations

import logging
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app import db, devices, identity
from app.identity import Person

router = APIRouter(prefix="/api/v1/devices", tags=["devices"])
logger = logging.getLogger("core")

MAX_ENROLL_FAILURES = 5
ENROLL_WINDOW_SECONDS = 15 * 60

# Per-address failure timestamps. In-memory like auth_api's, and for the same
# reason: one process, one household, and a restart clearing the window is
# acceptable for a route an operator uses a handful of times a year.
_ENROLL_FAILURES: dict[str, list[float]] = {}


class EnrollBody(BaseModel):
    code: str = Field(min_length=1)
    pubkey: str = Field(min_length=1)
    name: str = Field(min_length=1)
    platform: str = Field(min_length=1)
    hostname: str = Field(min_length=1)


class RenameBody(BaseModel):
    name: str = Field(min_length=1)


class GrantsBody(BaseModel):
    # Deliberately loose types: devices.clean_capabilities / clean_fs_roots do
    # the checking, so the operator reads "unknown capability 'fs.raed'"
    # instead of a pydantic schema dump that never names the typo.
    capabilities: list[str]
    fs_roots: list[str]


def _caller(request: Request) -> str:
    """The address a failure is counted against. `request.client` can be absent
    under some ASGI servers; unknown callers share one bucket rather than
    getting an unmetered one."""
    return request.client.host if request.client else "unknown"


def _recent_failures(caller: str) -> list[float]:
    cutoff = time.monotonic() - ENROLL_WINDOW_SECONDS
    recent = [t for t in _ENROLL_FAILURES.get(caller, []) if t > cutoff]
    if recent:
        _ENROLL_FAILURES[caller] = recent
    else:
        _ENROLL_FAILURES.pop(caller, None)
    return recent


def _refuse(exc: devices.DeviceRefused) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.reason)


@router.post("/pairing-code")
async def mint_pairing_code(person: Person = Depends(identity.require_person)) -> dict:
    """Mint a single-use code. The plaintext is in this response and nowhere
    else — the database has only its hash, so a lost code is re-minted, never
    recovered."""
    pool = await db.get_pool()
    return await devices.mint_pairing_code(pool, created_by=person.id)


@router.post("/enroll")
async def enroll(request: Request, body: EnrollBody) -> dict:
    """The one unauthenticated write in core (identity.PUBLIC_PATHS)."""
    caller = _caller(request)
    if len(_recent_failures(caller)) >= MAX_ENROLL_FAILURES:
        raise HTTPException(
            status_code=429,
            detail="too many failed enrollments from this address — try again in 15 minutes",
        )

    pool = await db.get_pool()
    try:
        result = await devices.enroll(
            pool,
            code=body.code,
            pubkey=body.pubkey,
            name=body.name,
            platform=body.platform,
            hostname=body.hostname,
        )
    except devices.DeviceRefused as exc:
        if exc.status_code == 403:
            # A bad code is the only refusal that looks like guessing. Shape
            # errors are refused BEFORE the code is even read, so this cannot
            # be walked around by sending junk.
            _ENROLL_FAILURES.setdefault(caller, []).append(time.monotonic())
        raise _refuse(exc) from exc

    _ENROLL_FAILURES.pop(caller, None)
    logger.info("device enrolled: %s (%s)", result["name"], result["device_id"])
    return result


@router.get("")
async def list_devices(_person: Person = Depends(identity.require_person)) -> dict:
    """Revoked devices included, marked as such: a machine that was revoked is
    part of what the operator needs to see, not something to hide."""
    pool = await db.get_pool()
    return {"devices": await devices.list_devices(pool)}


@router.patch("/{device_id}")
async def rename_device(
    device_id: uuid.UUID,
    body: RenameBody,
    _person: Person = Depends(identity.require_person),
) -> dict:
    pool = await db.get_pool()
    try:
        return {"device": await devices.rename(pool, device_id=device_id, name=body.name)}
    except devices.DeviceRefused as exc:
        raise _refuse(exc) from exc


@router.put("/{device_id}/grants")
async def set_grants(
    device_id: uuid.UUID,
    body: GrantsBody,
    person: Person = Depends(identity.require_person),
) -> dict:
    """Replace this device's grants. The governance event records the before
    and the after, and names the person who clicked it — not "the system"."""
    pool = await db.get_pool()
    try:
        device = await devices.set_grants(
            pool,
            device_id=device_id,
            capabilities=body.capabilities,
            fs_roots=body.fs_roots,
            actor=str(person.id),
        )
    except devices.DeviceRefused as exc:
        raise _refuse(exc) from exc
    return {"device": device}


@router.post("/{device_id}/revoke")
async def revoke_device(
    device_id: uuid.UUID, person: Person = Depends(identity.require_person)
) -> dict:
    pool = await db.get_pool()
    try:
        device = await devices.revoke(pool, device_id=device_id, actor=str(person.id))
    except devices.DeviceRefused as exc:
        raise _refuse(exc) from exc
    return {"device": device}
