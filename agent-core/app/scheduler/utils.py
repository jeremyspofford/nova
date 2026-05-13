from __future__ import annotations
import logging
from datetime import datetime, timezone, timedelta
from typing import Any

logger = logging.getLogger(__name__)

try:
    from croniter import croniter as _croniter
    _HAVE_CRONITER = True
except ImportError:
    _HAVE_CRONITER = False
    logger.warning("croniter not installed — cron trigger type disabled")


def compute_next_fire(trigger: dict) -> datetime | None:
    """Return next UTC fire time; None for event-driven triggers."""
    now = datetime.now(timezone.utc)
    t = trigger.get("type")

    if t == "cron":
        if not _HAVE_CRONITER:
            raise RuntimeError("croniter package required for cron triggers")
        itr = _croniter(trigger["expr"], now)
        return itr.get_next(datetime).astimezone(timezone.utc)

    if t == "once":
        at = datetime.fromisoformat(trigger["at"]).astimezone(timezone.utc)
        return at if at > now else now

    if t == "interval":
        return now + timedelta(seconds=int(trigger["every_seconds"]))

    if t in ("webhook", "fs_watch", "task_complete"):
        return None

    raise ValueError(f"Unknown trigger type: {t!r}")


def resolve_placeholders(prompt: str, context: dict[str, Any]) -> str:
    """Replace {key} placeholders in prompt with context values. Unknown keys left intact."""
    for key, value in context.items():
        prompt = prompt.replace(f"{{{key}}}", str(value))
    return prompt
