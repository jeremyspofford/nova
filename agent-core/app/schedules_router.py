"""Schedules CRUD endpoints + webhook trigger endpoint."""
from __future__ import annotations
import json
import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel

from .config import settings
from .db import get_pool
from .scheduler.utils import compute_next_fire
from .secrets.store import resolve_refs

logger = logging.getLogger(__name__)
router = APIRouter(tags=["schedules"])

# ---------------------------------------------------------------------------
# Auth helper (mirrors tasks_router.py pattern)
# ---------------------------------------------------------------------------


def _require_admin(x_admin_secret: str | None = Header(default=None)) -> None:
    if not x_admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing admin secret")
    if x_admin_secret != settings.admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin secret")


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class ScheduleCreateRequest(BaseModel):
    name: str
    prompt: str
    trigger: dict[str, Any]
    enabled: bool = True


class ScheduleUpdateRequest(BaseModel):
    name: str | None = None
    prompt: str | None = None
    trigger: dict[str, Any] | None = None
    enabled: bool | None = None


def _row_to_dict(row) -> dict:
    trigger = row["trigger"]
    if isinstance(trigger, str):
        try:
            trigger = json.loads(trigger)
        except Exception:
            pass
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "prompt": row["prompt"],
        "trigger": trigger,
        "enabled": row["enabled"],
        "created_by": row["created_by"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "last_fired": row["last_fired"].isoformat() if row["last_fired"] else None,
        "next_fire": row["next_fire"].isoformat() if row["next_fire"] else None,
        "fire_count": row["fire_count"],
    }


# ---------------------------------------------------------------------------
# CRUD endpoints
# ---------------------------------------------------------------------------


@router.get("/api/v1/schedules")
async def list_schedules(_: None = Depends(_require_admin)) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, name, prompt, trigger, enabled, created_by, created_at,
                      last_fired, next_fire, fire_count
               FROM schedules
               ORDER BY created_at DESC"""
        )
    return [_row_to_dict(r) for r in rows]


@router.post("/api/v1/schedules", status_code=201)
async def create_schedule(
    body: ScheduleCreateRequest,
    _: None = Depends(_require_admin),
) -> dict:
    pool = await get_pool()
    next_fire = None
    try:
        next_fire = compute_next_fire(body.trigger)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid trigger: {exc}")

    trigger_json = json.dumps(body.trigger)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO schedules (name, prompt, trigger, enabled, next_fire)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, name, prompt, trigger, enabled, created_by, created_at,
                      last_fired, next_fire, fire_count
            """,
            body.name, body.prompt, trigger_json, body.enabled, next_fire,
        )
    return _row_to_dict(row)


@router.get("/api/v1/schedules/{schedule_id}")
async def get_schedule(
    schedule_id: str,
    _: None = Depends(_require_admin),
) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT id, name, prompt, trigger, enabled, created_by, created_at,
                      last_fired, next_fire, fire_count
               FROM schedules WHERE id = $1::uuid""",
            schedule_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return _row_to_dict(row)


@router.patch("/api/v1/schedules/{schedule_id}")
async def update_schedule(
    schedule_id: str,
    body: ScheduleUpdateRequest,
    _: None = Depends(_require_admin),
) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, name, prompt, trigger, enabled FROM schedules WHERE id = $1::uuid",
            schedule_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="Schedule not found")

    new_name = body.name if body.name is not None else row["name"]
    new_prompt = body.prompt if body.prompt is not None else row["prompt"]
    new_enabled = body.enabled if body.enabled is not None else row["enabled"]

    existing_trigger = row["trigger"]
    if isinstance(existing_trigger, str):
        existing_trigger = json.loads(existing_trigger)
    new_trigger = body.trigger if body.trigger is not None else existing_trigger
    trigger_json = json.dumps(new_trigger)

    # Recompute next_fire if trigger changed.
    next_fire_clause = ""
    next_fire_val = None
    if body.trigger is not None:
        try:
            next_fire_val = compute_next_fire(new_trigger)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Invalid trigger: {exc}")
        next_fire_clause = ", next_fire = $6"

    async with pool.acquire() as conn:
        if next_fire_clause:
            updated = await conn.fetchrow(
                f"""UPDATE schedules
                    SET name = $2, prompt = $3, trigger = $4, enabled = $5{next_fire_clause}
                    WHERE id = $1::uuid
                    RETURNING id, name, prompt, trigger, enabled, created_by, created_at,
                              last_fired, next_fire, fire_count""",
                schedule_id, new_name, new_prompt, trigger_json, new_enabled, next_fire_val,
            )
        else:
            updated = await conn.fetchrow(
                """UPDATE schedules
                   SET name = $2, prompt = $3, trigger = $4, enabled = $5
                   WHERE id = $1::uuid
                   RETURNING id, name, prompt, trigger, enabled, created_by, created_at,
                             last_fired, next_fire, fire_count""",
                schedule_id, new_name, new_prompt, trigger_json, new_enabled,
            )
    return _row_to_dict(updated)


@router.delete("/api/v1/schedules/{schedule_id}", status_code=204)
async def delete_schedule(
    schedule_id: str,
    _: None = Depends(_require_admin),
) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        # Unlink tasks before deletion.
        await conn.execute(
            "UPDATE tasks SET schedule_id = NULL WHERE schedule_id = $1::uuid",
            schedule_id,
        )
        result = await conn.execute(
            "DELETE FROM schedules WHERE id = $1::uuid",
            schedule_id,
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Schedule not found")


# ---------------------------------------------------------------------------
# Webhook endpoint
# ---------------------------------------------------------------------------

_PAYLOAD_LIMIT = 64 * 1024  # 64 KB


@router.post("/api/v1/webhooks/{schedule_id}", status_code=202)
async def webhook_trigger(
    schedule_id: str,
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict:
    """Trigger a webhook-type schedule. Auth via Bearer token stored as a secret.

    Always returns 401 on any auth or existence failure to avoid leaking schedule IDs.
    """
    # Extract Bearer token.
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    provided_token = authorization.removeprefix("Bearer ").strip()
    if not provided_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    # Enforce payload size limit.
    body_bytes = await request.body()
    if len(body_bytes) > _PAYLOAD_LIMIT:
        raise HTTPException(status_code=413, detail="Payload too large (max 64KB)")

    try:
        payload: dict[str, Any] = json.loads(body_bytes) if body_bytes else {}
    except Exception:
        payload = {}

    pool = await get_pool()

    # Fetch schedule; use generic 401 for any failure to avoid leaking existence.
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """SELECT id, trigger, enabled
                   FROM schedules
                   WHERE id = $1::uuid AND trigger->>'type' = 'webhook'""",
                schedule_id,
            )
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    if row is None or not row["enabled"]:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    trigger = row["trigger"]
    if isinstance(trigger, str):
        trigger = json.loads(trigger)

    token_ref = trigger.get("token_secret")
    if not token_ref:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    # Resolve the ${secret:name} ref to plaintext.
    try:
        expected_token = await resolve_refs(pool, token_ref, settings.credential_master_key)
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    if not isinstance(expected_token, str) or provided_token != expected_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    # Auth passed — dispatch via app.state.dispatch_fn.
    dispatch_fn = getattr(request.app.state, "dispatch_fn", None)
    if dispatch_fn is None:
        logger.error("dispatch_fn not set on app.state — scheduler not running")
        raise HTTPException(status_code=503, detail="Scheduler not available")

    from .scheduler.loop import fire_webhook_schedule
    await fire_webhook_schedule(pool, schedule_id, payload, dispatch_fn)

    return {"queued": True, "schedule_id": schedule_id}
