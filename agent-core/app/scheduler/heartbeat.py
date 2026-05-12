"""Daily briefing builder and alert condition definitions for the scheduler heartbeat."""
from __future__ import annotations
import logging
from typing import Any

logger = logging.getLogger(__name__)

# Alert condition descriptors — keys used by callers to trigger specific alert paths.
ALERT_CONDITIONS: dict[str, str] = {
    "task_failed": "A scheduler-dispatched task has entered the 'failed' state.",
    "mutate_pending_1h": "A MUTATE-tier approval has been pending for more than 1 hour.",
    "destruct_pending_15m": "A DESTRUCT-tier approval has been pending for more than 15 minutes.",
    "fs_watch_error": "A file-watcher Observer has raised an error and may have stopped.",
}


def build_daily_briefing_prompt(
    *,
    since_hours: int,
    completed: int,
    failed: int,
    skipped: int,
    pending_approvals: list[dict[str, Any]],
    next_fires: list[str],
) -> str:
    """Build the daily briefing prompt sent by the heartbeat schedule.

    Returns a concise summary suitable for injecting as a Nova task prompt.
    """
    if completed == 0 and failed == 0 and not pending_approvals and not next_fires:
        return f"Daily Nova briefing (last {since_hours}h): Nothing to report — no tasks ran."

    lines = [f"Daily Nova briefing (last {since_hours}h):"]

    if completed or failed or skipped:
        lines.append(
            f"  Tasks — completed: {completed}, failed: {failed}, skipped: {skipped}"
        )

    if failed:
        lines.append(f"  WARNING: {failed} task(s) failed. Review the task log.")

    if pending_approvals:
        lines.append(f"  Pending approvals ({len(pending_approvals)}):")
        for ap in pending_approvals:
            tool = ap.get("tool_name", "unknown")
            mins = ap.get("waiting_minutes", 0)
            lines.append(f"    - {tool} (waiting {mins}m)")

    if next_fires:
        lines.append("  Upcoming schedule fires:")
        for nf in next_fires:
            lines.append(f"    - {nf}")

    return "\n".join(lines)


async def send_alert(
    condition_key: str,
    detail: str,
    *,
    chat_client=None,
) -> None:
    """Dispatch an alert for the given condition. Catches all exceptions gracefully."""
    description = ALERT_CONDITIONS.get(condition_key, condition_key)
    message = f"[Nova Alert] {description}\n{detail}"
    logger.warning("Alert(%s): %s", condition_key, detail)
    if chat_client is None:
        return
    try:
        await chat_client.send(message)
    except Exception as exc:
        logger.warning("Alert dispatch failed (chat client unavailable): %s", exc)
