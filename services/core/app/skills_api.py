"""/api/v1/skills — the Skills page's surface over app/skills.py (S17).

Nothing here decides anything. Every write is one store call and every refusal
is the store's own words (ValueError → 400, quoted verbatim), so the page and
Nova's own reads can never disagree about what a skill is.

ONE LIST, ROWS AND ORPHAN FILES ALIKE. A skill file with no row is not hidden:
agents have named files under `skills/` since S12 and those grants still work,
so the list carries them with a null status and says the row is missing. The
Agents form reads the same endpoint for the names it offers.

WHAT IS DERIVED AT THE REQUEST, never stored:

  * `file_present` — the file checked at the call, so one deleted by hand
    shows as gone rather than as a procedure that cannot be read.
  * `uses` — the ledger's counts for this skill: how many uses were watched,
    how many of those went badly, and how many were never watched at all. The
    third number is separate on purpose: folding unwatched uses into "fine"
    is reading silence as success.
  * `source_turns` — which of the turns a skill was distilled from still
    exist. Retention sweeps turns, and a provenance link that 404s should say
    the turn aged out rather than look like a bug.

THE DRAFT FROM A NOTICE. `POST {"from_notice": <id>}` composes a draft from
the facts the beat's check recorded — its step shape — by resolving the turns
that walked it NOW. So the draft is made from everything that has happened by
the time the owner asks, not from what was true the hour the beat ran.
"""

from __future__ import annotations

import uuid
from typing import Any

import asyncpg
from fastapi import APIRouter, Body, Depends, HTTPException

from app import db, identity, skills
from app.checks import skills as skills_check
from app.identity import Person

router = APIRouter(prefix="/api/v1", tags=["skills"])

CREATED_VIA = "page"


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


async def _uses(pool: asyncpg.Pool, skill_id: uuid.UUID) -> dict:
    row = await pool.fetchrow(
        "SELECT count(*) AS total, "
        "count(*) FILTER (WHERE outcome_known) AS watched, "
        "count(*) FILTER (WHERE outcome_known AND (failed_calls > 0 OR guard_fires > 0)) "
        "AS rough, max(loaded_at) AS last_used FROM skill_uses WHERE skill_id = $1",
        skill_id,
    )
    return {
        "total": row["total"],
        "watched": row["watched"],
        "rough": row["rough"],
        "unwatched": row["total"] - row["watched"],
        "last_used": row["last_used"].isoformat() if row["last_used"] else None,
    }


def _row_json(skill: skills.Skill, *, file_present: bool, uses: dict) -> dict[str, Any]:
    return {
        "name": skill.name,
        "title": skill.title,
        "summary": skill.summary,
        "status": skill.status,
        "created_via": skill.created_via,
        "step_names": list(skill.step_names),
        "flagged_reason": skill.flagged_reason,
        "file_present": file_present,
        "uses": uses,
        "created_at": skill.created_at.isoformat(),
        "updated_at": skill.updated_at.isoformat(),
    }


@router.get("/skills")
async def list_skills(_person: Person = Depends(identity.require_person)) -> list[dict]:
    pool = await db.get_pool()
    rows = await skills.list_all(pool)
    files = {entry["name"]: entry for entry in skills.list_body_files()}
    out = []
    for skill in rows:
        entry = files.pop(skill.name, None)
        out.append(
            {
                **_row_json(
                    skill, file_present=entry is not None, uses=await _uses(pool, skill.id)
                ),
                "size": None if entry is None else entry["size"],
                "modified": None if entry is None else entry["modified"],
            }
        )
    # Files nobody has made a row for. Named, never dropped: an agent may
    # already be granted one, and the Agents form offers these too.
    out += [
        {
            "name": entry["name"],
            "title": None,
            "summary": None,
            "status": None,
            "created_via": None,
            "step_names": [],
            "flagged_reason": None,
            "file_present": True,
            "uses": None,
            "created_at": None,
            "updated_at": None,
            "size": entry["size"],
            "modified": entry["modified"],
        }
        for entry in files.values()
    ]
    return sorted(out, key=lambda item: item["name"])


@router.get("/skills/{name}")
async def read_skill(name: str, _person: Person = Depends(identity.require_person)) -> dict:
    pool = await db.get_pool()
    skill = await skills.get(pool, name)
    if skill is None:
        raise HTTPException(status_code=404, detail=f"no skill named {name!r}")
    body = skills.body_text(name)
    turns = await pool.fetch(
        "SELECT id, started_at, kind FROM turns WHERE id = ANY($1::uuid[]) ORDER BY started_at",
        list(skill.source_turn_ids),
    )
    alive = {row["id"] for row in turns}
    return {
        **_row_json(skill, file_present=body is not None, uses=await _uses(pool, skill.id)),
        "body": body,
        "source_turns": [
            {
                "id": str(turn_id),
                # Retention sweeps turns; a provenance link that has aged out
                # says so rather than 404ing out of the page.
                "present": turn_id in alive,
            }
            for turn_id in skill.source_turn_ids
        ],
    }


@router.post("/skills")
async def create_skill(
    body: dict = Body(...), _person: Person = Depends(identity.require_person)
) -> dict:
    pool = await db.get_pool()
    notice_id = body.get("from_notice")
    name = (body.get("name") or "").strip()
    if not name:
        raise _bad("a skill needs a name — it is also the file it lives in")
    try:
        if notice_id:
            steps = await _steps_from_notice(pool, notice_id)
            turn_ids = await skills_check.turns_matching(pool, steps)
            if not turn_ids:
                raise _bad(
                    "the turns that walked that procedure are no longer in the ledger, so "
                    "there is nothing to compose a draft from"
                )
            skill = await skills.draft_from_turns(
                pool, name=name, turn_ids=turn_ids, created_via=CREATED_VIA
            )
        else:
            skill = await skills.create(
                pool,
                name=name,
                title=(body.get("title") or "").strip(),
                summary=(body.get("summary") or "").strip(),
                created_via=CREATED_VIA,
                body=body.get("body") or "",
            )
    except ValueError as exc:
        raise _bad(str(exc)) from exc
    except asyncpg.UniqueViolationError as exc:
        raise _bad(f"a skill named {name!r} already exists") from exc
    return await read_skill(skill.name, _person)


async def _steps_from_notice(pool: asyncpg.Pool, notice_id: str) -> list[str]:
    try:
        parsed = uuid.UUID(str(notice_id))
    except ValueError as exc:
        raise _bad(f"{notice_id!r} is not a notice id") from exc
    record = await pool.fetchrow("SELECT check_name, facts FROM notices WHERE id = $1", parsed)
    if record is None:
        raise HTTPException(status_code=404, detail=f"no notice {notice_id}")
    steps = (record["facts"] or {}).get("steps")
    if not isinstance(steps, list) or not all(isinstance(step, str) for step in steps):
        raise _bad(
            f"notice {notice_id} is a {record['check_name']} finding and carries no procedure"
        )
    return steps


@router.patch("/skills/{name}")
async def update_skill(
    name: str, body: dict = Body(...), _person: Person = Depends(identity.require_person)
) -> dict:
    pool = await db.get_pool()
    if await skills.get(pool, name) is None:
        raise HTTPException(status_code=404, detail=f"no skill named {name!r}")
    status = body.get("status")
    try:
        if any(key in body for key in ("title", "summary", "body")):
            await skills.update(
                pool,
                name,
                title=body.get("title"),
                summary=body.get("summary"),
                body=body.get("body"),
            )
        if status is not None:
            await skills.set_status(pool, name, status, reason=body.get("reason"))
    except ValueError as exc:
        raise _bad(str(exc)) from exc
    return await read_skill(name, _person)


@router.delete("/skills/{name}")
async def delete_skill(name: str, _person: Person = Depends(identity.require_person)) -> dict:
    pool = await db.get_pool()
    if not await skills.delete(pool, name):
        raise HTTPException(status_code=404, detail=f"no skill named {name!r}")
    path = skills.body_path(name)
    # Said plainly: the row is gone and the file is not. Deleting a file is
    # the workspace's verb — it has a trash and a stated window — and this
    # route quietly unlinking one would be the only destructive act here.
    return {
        "name": name,
        "deleted": True,
        "text": f"The skill {name!r} is no longer listed. Its file is still at {path}.",
    }
