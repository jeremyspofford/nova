"""Dispatch guards for autonomous (created_by='nova') schedules.

User-created schedules are never guarded — the user asked for those fires. Nova's
own schedules pass three checks before dispatch: the kill switch
(app_config proactivity.enabled), a rolling 24h dispatch budget
(proactivity.daily_task_budget), and the active completion model supporting tool
calls (verified through llm-gateway; unknown counts as allowed, only a definitive
"no tools" blocks).
"""
from __future__ import annotations

import logging
import time

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

_CAPS_TTL = 600.0
_caps_cache: tuple[float, bool | None] | None = None


async def get_config(pool, key: str, default: str) -> str:
    try:
        value = await pool.fetchval("SELECT value FROM app_config WHERE key = $1", key)
        return value if value is not None else default
    except Exception as exc:
        logger.warning("app_config read failed for %s: %s", key, exc)
        return default


async def set_config(pool, key: str, value: str) -> None:
    try:
        await pool.execute(
            "INSERT INTO app_config (key, value) VALUES ($1, $2) "
            "ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()",
            key, value,
        )
    except Exception as exc:
        logger.warning("app_config write failed for %s: %s", key, exc)


async def completion_model_supports_tools(force: bool = False) -> bool | None:
    """True/False from llm-gateway's capability check; None when undeterminable."""
    global _caps_cache
    now = time.monotonic()
    if not force and _caps_cache is not None and (now - _caps_cache[0]) < _CAPS_TTL:
        return _caps_cache[1]
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{settings.llm_gateway_url}/models/capabilities")
            r.raise_for_status()
            tools = r.json().get("tools")
            tools = tools if isinstance(tools, bool) else None
    except Exception as exc:
        logger.debug("capability check unavailable: %s", exc)
        tools = None
    _caps_cache = (now, tools)
    return tools


async def nova_dispatches_last_24h(pool) -> int:
    try:
        return await pool.fetchval(
            """SELECT count(*) FROM tasks t
               JOIN schedules s ON t.schedule_id = s.id
               WHERE s.created_by = 'nova'
                 AND t.created_at > now() - interval '24 hours'"""
        ) or 0
    except Exception as exc:
        logger.warning("budget count failed: %s", exc)
        return 0


async def check_nova_dispatch(pool) -> tuple[bool, str | None]:
    """(allowed, block_reason) for dispatching a nova-created schedule right now."""
    enabled = await get_config(pool, "proactivity.enabled", "true")
    if enabled.strip().lower() == "false":
        return False, "proactivity is disabled (kill switch)"

    raw_budget = await get_config(pool, "proactivity.daily_task_budget", "12")
    try:
        budget = int(raw_budget)
    except ValueError:
        logger.warning("invalid proactivity.daily_task_budget %r — using 12", raw_budget)
        budget = 12
    used = await nova_dispatches_last_24h(pool)
    if used >= budget:
        return False, f"daily task budget reached ({used}/{budget})"

    tools = await completion_model_supports_tools()
    if tools is False:
        return False, "active completion model does not support tool calling"

    return True, None


async def note_block_state(pool, schedule_id, reason: str | None) -> None:
    """Track guard-state transitions; post one thread note when a block first appears.

    Silent skipping was the original sin of this roadmap item — when proactive runs
    stop happening, the pulse's chat thread says why. Repeat skips for the same
    reason only log; clearing the block resets the state without posting.
    """
    prev = await get_config(pool, "proactivity.last_block_reason", "")
    new = reason or ""
    if new == prev:
        return
    await set_config(pool, "proactivity.last_block_reason", new)
    if new:
        from .results import post_schedule_result
        await post_schedule_result(
            pool, "guard", schedule_id, "completed",
            f"Proactive runs are paused: {new}",
        )
