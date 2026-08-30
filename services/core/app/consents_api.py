"""GET/POST /api/v1/consents — the operator's window onto pending approval
cards, and the only place one is decided.

Authenticated exactly like every other route in core (identity.require_person
— a session cookie or the service bearer): there is no separate "operator"
role gate here because none exists anywhere in this service yet (a future
role-scoping slice, named out of scope in the S3 plan, can narrow this to
admin/owner specifically). What this module guarantees on its own:

  * GET never writes — it is card_spec built straight off consents rows via
    consents.pending_for_conversation / pending_all, nothing derived by a
    guess;
  * POST .../decide calls consents.decide and NOTHING else — it does not
    execute the action (ruling S3-R4: the funnel is the only executor, on the
    model's next attempt). A missing or already-decided consent is a stated
    404, never a silent no-op that could be read as "yes, that worked."
"""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import consents, db, identity
from app.identity import Person

router = APIRouter(prefix="/api/v1/consents", tags=["consents"])


class ConsentDecision(BaseModel):
    decision: Literal["approve", "deny"]


@router.get("")
async def list_consents(
    conversation_id: uuid.UUID | None = None,
    # Unused beyond the auth check itself: every authenticated person sees
    # the same pending set, the same stance activity.py takes for the turn
    # ledger — see this module's docstring on role-scoping being deferred.
    _person: Person = Depends(identity.require_person),
) -> dict:
    pool = await db.get_pool()
    if conversation_id is not None:
        cards = await consents.pending_for_conversation(pool, conversation_id)
    else:
        cards = await consents.pending_all(pool)
    return {"consents": cards}


@router.post("/{consent_id}/decide")
async def decide_consent(
    consent_id: uuid.UUID,
    body: ConsentDecision,
    person: Person = Depends(identity.require_person),
) -> dict:
    pool = await db.get_pool()
    card = await consents.decide(
        pool,
        consent_id=consent_id,
        approve=body.decision == "approve",
        decided_by=person.id,
    )
    if card is None:
        # Missing, or already decided by someone else (or by this same
        # person, earlier) — consents.decide's UPDATE ... WHERE status =
        # 'pending' found no row either way, and a decision that changed
        # nothing must never be reported as if it had.
        raise HTTPException(
            status_code=404,
            detail=f"no pending consent {consent_id} to decide — it may already be decided",
        )
    return {"consent": card}
