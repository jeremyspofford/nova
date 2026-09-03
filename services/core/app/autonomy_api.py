"""GET/POST/PUT /api/v1/autonomy — Settings -> Autonomy's read of every
gateable action class's current disposition and graduation progress, the only
route that revokes an earned promotion, and the owner's own disposition
control — per class (PUT .../{action_class}) or every class at once (PUT
/api/v1/autonomy, the master control).

The handlers do nothing autonomy.py does not already do: GET is
`autonomy.state` verbatim (the real stored counters — no fake numbers); POST
.../revoke is `autonomy.revoke`, which only ever flips a class this same
loop promoted (`earned=true`) — revoking a class that never graduated (or is
already consent, or does not exist) changes nothing and is reported as a 404,
never a silent success; PUT .../{action_class} is `autonomy.set_disposition`,
which edits the row the kernel reads and records who did it; PUT with no
class segment is `autonomy.set_all_dispositions`, one transaction over every
class that is not already there, one event per changed class. Same auth stance
as every other route in core: identity.require_person (see consents_api.py's
docstring on the missing operator-role gate — an S8 carry; until a role
system exists, any person with a session may set a disposition, exactly as
any person may revoke or decide a consent today).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import autonomy, db, identity
from app.identity import Person

router = APIRouter(prefix="/api/v1/autonomy", tags=["autonomy"])


class DispositionBody(BaseModel):
    # A plain str, not a Literal: autonomy.set_disposition names the bad value
    # in its refusal ("... not 'sometimes'"), which a pydantic schema dump
    # would not.
    disposition: str


@router.get("")
async def list_autonomy_state(_person: Person = Depends(identity.require_person)) -> dict:
    pool = await db.get_pool()
    return {"classes": await autonomy.state(pool)}


@router.post("/{action_class}/revoke")
async def revoke_autonomy(
    action_class: str, person: Person = Depends(identity.require_person)
) -> dict:
    pool = await db.get_pool()
    revoked = await autonomy.revoke(pool, action_class=action_class, actor=str(person.id))
    if not revoked:
        raise HTTPException(
            status_code=404,
            detail=(
                f"{action_class} is not a promoted (earned-auto) class right now — "
                "nothing to revoke"
            ),
        )
    return {"classes": await autonomy.state(pool)}


@router.put("")
async def set_all_dispositions(
    body: DispositionBody, person: Person = Depends(identity.require_person)
) -> dict:
    """The owner sets EVERY class to auto / consent / deny at once — the
    master control. One transaction in autonomy.set_all_dispositions; only
    the classes not already at the value are written and recorded. Returns
    every class's state row (the UI replaces its list wholesale) and the
    names that changed — an empty `changed` is an honest no-op, not an
    error. A bad value is a stated 400, same words as the per-class PUT."""
    pool = await db.get_pool()
    try:
        classes, changed = await autonomy.set_all_dispositions(
            pool, disposition=body.disposition, actor=str(person.id)
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"classes": classes, "changed": changed}


@router.put("/{action_class}")
async def set_disposition(
    action_class: str,
    body: DispositionBody,
    person: Person = Depends(identity.require_person),
) -> dict:
    """The owner sets a class to auto / consent / deny. Not an authorizer: it
    edits the action_classes row policy.authorize reads (see
    autonomy.set_disposition) and the governance ledger records the person who
    did it. Returns the class's state row so the UI can echo it in place."""
    pool = await db.get_pool()
    try:
        entry = await autonomy.set_disposition(
            pool,
            action_class=action_class,
            disposition=body.disposition,
            actor=str(person.id),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"class": entry}
