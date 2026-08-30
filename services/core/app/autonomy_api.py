"""GET/POST /api/v1/autonomy — Settings -> Autonomy's read of every gateable
action class's current disposition and graduation progress, and the only
route that revokes an earned promotion.

Both handlers do nothing autonomy.py does not already do: GET is
`autonomy.state` verbatim (the real stored counters — no fake numbers); POST
.../revoke is `autonomy.revoke`, which only ever flips a class this same
loop promoted (`earned=true`) — revoking a class that never graduated (or is
already consent, or does not exist) changes nothing and is reported as a 404,
never a silent success. Same auth stance as every other route in core:
identity.require_person (see consents_api.py's docstring on the missing
operator-role gate).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app import autonomy, db, identity
from app.identity import Person

router = APIRouter(prefix="/api/v1/autonomy", tags=["autonomy"])


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
