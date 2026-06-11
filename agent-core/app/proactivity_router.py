"""Proactivity control endpoints — kill switch + budget for nova-created schedules."""
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel

from .config import settings
from .db import get_pool
from .scheduler.guards import get_config, nova_dispatches_last_24h, set_config

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/proactivity", tags=["proactivity"])


def _require_admin(x_admin_secret: str | None = Header(default=None)) -> None:
    if not x_admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing admin secret")
    if x_admin_secret != settings.admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin secret")


class ProactivityUpdate(BaseModel):
    enabled: bool | None = None
    daily_task_budget: int | None = None


async def _state(pool) -> dict:
    enabled = (await get_config(pool, "proactivity.enabled", "true")).strip().lower() != "false"
    raw_budget = await get_config(pool, "proactivity.daily_task_budget", "12")
    try:
        budget = int(raw_budget)
    except ValueError:
        budget = 12
    schedule_id = await pool.fetchval(
        "SELECT id FROM schedules WHERE created_by = 'nova' AND name = 'nova-self-review'"
    )
    return {
        "enabled": enabled,
        "daily_task_budget": budget,
        "dispatches_today": await nova_dispatches_last_24h(pool),
        "last_block_reason": await get_config(pool, "proactivity.last_block_reason", "") or None,
        "schedule_id": str(schedule_id) if schedule_id else None,
    }


@router.get("")
async def get_proactivity(_: None = Depends(_require_admin)) -> dict:
    return await _state(await get_pool())


@router.put("")
async def update_proactivity(body: ProactivityUpdate, _: None = Depends(_require_admin)) -> dict:
    pool = await get_pool()
    if body.enabled is not None:
        await set_config(pool, "proactivity.enabled", "true" if body.enabled else "false")
    if body.daily_task_budget is not None:
        if body.daily_task_budget < 0:
            raise HTTPException(status_code=422, detail="daily_task_budget must be >= 0")
        await set_config(pool, "proactivity.daily_task_budget", str(body.daily_task_budget))
    return await _state(pool)
