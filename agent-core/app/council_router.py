"""Council mode control + guards — kill switch and daily budget for chat refinement.

Same discipline as proactivity: council runs cost real time and tokens, so the
chat toggle is gated by app_config `council.enabled` and a rolling 24h budget
(`council.daily_budget`, default 20). Blocked turns run standard and say why in
their metadata — never silently.
"""
import json
import logging
import time

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel

from .config import settings
from .db import get_pool
from .scheduler.guards import get_config, set_config

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/council", tags=["council"])


def _require_admin(x_admin_secret: str | None = Header(default=None)) -> None:
    if not x_admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing admin secret")
    if x_admin_secret != settings.admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin secret")


async def _runs_last_24h(pool) -> list[float]:
    raw = await get_config(pool, "council.runs", "[]")
    try:
        runs = [float(t) for t in json.loads(raw)]
    except (ValueError, TypeError):
        runs = []
    cutoff = time.time() - 86400
    return [t for t in runs if t > cutoff]


async def council_allowed(pool) -> tuple[bool, str | None]:
    """(allowed, block_reason) for running a council refinement right now."""
    enabled = await get_config(pool, "council.enabled", "true")
    if enabled.strip().lower() == "false":
        return False, "council is disabled (kill switch)"
    raw_budget = await get_config(pool, "council.daily_budget", "20")
    try:
        budget = int(raw_budget)
    except ValueError:
        budget = 20
    used = len(await _runs_last_24h(pool))
    if used >= budget:
        return False, f"daily council budget reached ({used}/{budget})"
    return True, None


async def record_council_run(pool) -> None:
    runs = await _runs_last_24h(pool)
    runs.append(time.time())
    await set_config(pool, "council.runs", json.dumps(runs))


class CouncilUpdate(BaseModel):
    enabled: bool | None = None
    daily_budget: int | None = None


async def _state(pool) -> dict:
    enabled = (await get_config(pool, "council.enabled", "true")).strip().lower() != "false"
    raw_budget = await get_config(pool, "council.daily_budget", "20")
    try:
        budget = int(raw_budget)
    except ValueError:
        budget = 20
    return {
        "enabled": enabled,
        "daily_budget": budget,
        "runs_today": len(await _runs_last_24h(pool)),
    }


@router.get("")
async def get_council(_: None = Depends(_require_admin)) -> dict:
    return await _state(await get_pool())


@router.put("")
async def update_council(body: CouncilUpdate, _: None = Depends(_require_admin)) -> dict:
    pool = await get_pool()
    if body.enabled is not None:
        await set_config(pool, "council.enabled", "true" if body.enabled else "false")
    if body.daily_budget is not None:
        if body.daily_budget < 0:
            raise HTTPException(status_code=422, detail="daily_budget must be >= 0")
        await set_config(pool, "council.daily_budget", str(body.daily_budget))
    return await _state(pool)
