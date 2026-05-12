"""Built-in tools for creating and managing schedules."""
from __future__ import annotations
import json
import logging
from typing import Any

from ..registry import tool, Tier
from ..context import ToolContext
from ...scheduler.utils import compute_next_fire

logger = logging.getLogger(__name__)


@tool(tier=Tier.MUTATE, reversible=True, timeout_s=15, name="schedule_create")
async def schedule_create(
    name: str,
    prompt: str,
    trigger: str,
    *,
    ctx: ToolContext,
) -> dict:
    """Create a new schedule. trigger must be a JSON object with a 'type' field.

    Supported types: cron (+ expr), interval (+ every_seconds), once (+ at),
    webhook, fs_watch (+ path, on, pattern), task_complete (+ task_id, on_status).
    Returns the created schedule row including its id.
    """
    # Accept trigger as dict (from tool dispatch) or JSON string.
    if isinstance(trigger, str):
        try:
            trigger_dict: dict[str, Any] = json.loads(trigger)
        except Exception:
            return {"error": f"trigger must be a JSON object, got: {trigger!r}"}
    else:
        trigger_dict = dict(trigger)

    trigger_type = trigger_dict.get("type")
    if not trigger_type:
        return {"error": "trigger.type is required"}

    # Compute initial next_fire for time-based triggers.
    next_fire = None
    try:
        next_fire = compute_next_fire(trigger_dict)
    except Exception as exc:
        return {"error": f"Invalid trigger: {exc}"}

    async with ctx.pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO schedules (name, prompt, trigger, enabled, next_fire, created_by)
            VALUES ($1, $2, $3, true, $4, 'nova')
            RETURNING id, name, prompt, trigger, enabled, next_fire, created_by, created_at, fire_count
            """,
            name, prompt, json.dumps(trigger_dict), next_fire,
        )
    if row is None:
        return {"error": "Insert failed"}

    nf = row.get("next_fire")
    return {
        "id": str(row["id"]),
        "name": row.get("name", name),
        "prompt": row.get("prompt", prompt),
        "trigger": row.get("trigger", trigger_dict),
        "enabled": row.get("enabled", True),
        "next_fire": nf.isoformat() if nf else None,
        "created_by": row.get("created_by", "nova"),
        "fire_count": row.get("fire_count", 0),
    }


@tool(tier=Tier.MUTATE, reversible=True, timeout_s=10, name="schedule_disable")
async def schedule_disable(
    schedule_id: str,
    *,
    ctx: ToolContext,
) -> dict:
    """Disable a schedule by id. The schedule will stop firing until re-enabled."""
    async with ctx.pool.acquire() as conn:
        result = await conn.execute(
            "UPDATE schedules SET enabled = false WHERE id = $1::uuid",
            schedule_id,
        )
    if result == "UPDATE 0":
        return {"error": f"Schedule not found: {schedule_id}"}
    return {"schedule_id": schedule_id, "enabled": False}


@tool(tier=Tier.DESTRUCT, timeout_s=10, name="schedule_delete")
async def schedule_delete(
    schedule_id: str,
    *,
    ctx: ToolContext,
) -> dict:
    """Permanently delete a schedule. All associated task history is preserved but unlinked."""
    async with ctx.pool.acquire() as conn:
        # Unlink tasks first to avoid FK violation.
        await conn.execute(
            "UPDATE tasks SET schedule_id = NULL WHERE schedule_id = $1::uuid",
            schedule_id,
        )
        result = await conn.execute(
            "DELETE FROM schedules WHERE id = $1::uuid",
            schedule_id,
        )
    if result == "DELETE 0":
        return {"error": f"Schedule not found: {schedule_id}"}
    return {"deleted": schedule_id}
