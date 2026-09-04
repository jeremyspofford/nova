"""GET /api/v1/governance — the operator-visible audit: every governance event,
newest-first, verbatim off governance.py's ledger. A device enrolled, revoked,
or replaying an audit chain that did not join up — nothing here is derived or
filtered by outcome, and nothing here decides anything: this is read by no
decision path (governance.py's own docstring), it only reads one back.

Same auth stance as every route in core: identity.require_person, no separate
operator-role gate (none exists anywhere in this service — see identity.py's
docstring for why that is named, not silently assumed).
"""
from __future__ import annotations

import uuid

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query

from app import db, governance, identity
from app.identity import Person

router = APIRouter(prefix="/api/v1/governance", tags=["governance"])

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


def _event_json(row: asyncpg.Record) -> dict:
    return {
        "id": str(row["id"]),
        "kind": row["kind"],
        "actor": row["actor"],
        "subject_ref": str(row["subject_ref"]) if row["subject_ref"] else None,
        "meta": row["meta"],
        "created_at": row["created_at"].isoformat(),
    }


@router.get("")
async def list_governance_events(
    limit: int = Query(DEFAULT_LIMIT, ge=1),
    before: uuid.UUID | None = None,
    _person: Person = Depends(identity.require_person),
) -> dict:
    pool = await db.get_pool()
    capped = min(limit, MAX_LIMIT)

    before_created_at = None
    if before is not None:
        cursor = await pool.fetchrow(
            "SELECT created_at FROM governance_events WHERE id = $1", before
        )
        if cursor is None:
            # A stale or invented cursor gets a clear refusal, never a silent
            # "here is the whole list from the top" — see activity.py's same
            # stance on its own `before` cursor.
            raise HTTPException(
                status_code=404, detail=f"no governance event {before} to page before"
            )
        before_created_at = cursor["created_at"]

    rows = await governance.recent_events(
        pool,
        limit=capped,
        before_created_at=before_created_at,
        before_id=before,
    )
    return {"events": [_event_json(row) for row in rows]}
