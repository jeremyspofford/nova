"""
Notify Tools -- let agents reach the operator's phone.

send_push publishes through the same ntfy channel as approvals and
checkpoints (app/notifier.py). It exists so scheduled goals can DELIVER
their output — the seeded "Morning briefing" goal composes a digest and
sends it here — and so any agent can surface something the operator
should see soon without parking the task on a checkpoint.

A send_push is informational only: it cannot ask for a decision (that is
request_human_checkpoint's job) and it never blocks the task.
"""
from __future__ import annotations

import logging
import time
from collections import deque

from nova_contracts import BlastRadius, ToolDefinition

from app.notifier import notify

log = logging.getLogger(__name__)

# Storm brake: a runaway agent loop must not buzz the phone hundreds of
# times. Sliding one-hour window, in-process — resets on restart, which is
# fine: notification storms are a single-process phenomenon.
_WINDOW_SECONDS = 3600.0
_MAX_PER_WINDOW = 10
_sent_at: deque[float] = deque()


def _rate_limited() -> bool:
    """True if the hourly send budget is exhausted; otherwise consumes a slot.

    A slot is consumed even if the subsequent publish fails — retrying a
    failing push in a loop is exactly the storm this exists to stop.
    """
    now = time.monotonic()
    while _sent_at and now - _sent_at[0] > _WINDOW_SECONDS:
        _sent_at.popleft()
    if len(_sent_at) >= _MAX_PER_WINDOW:
        return True
    _sent_at.append(now)
    return False


NOTIFY_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="send_push",
        description=(
            "Send an informational push notification to the operator's phone. "
            "It cannot ask for a decision (use request_human_checkpoint when "
            "you need input) and does not pause the task. Use it to deliver "
            "digests — e.g. the morning briefing — or to surface something "
            "the operator should see soon. Plain text only; messages are "
            "truncated at 1500 characters. Rate-limited: if sending fails or "
            "the limit is reached, put the content in your task output "
            "instead of retrying."
        ),
        parameters={
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Notification title (truncated at 200 chars)",
                },
                "message": {
                    "type": "string",
                    "description": "Notification body, plain text (truncated at 1500 chars)",
                },
                "priority": {
                    "type": "integer",
                    "description": "ntfy priority 1 (silent) … 5 (urgent). Default 3.",
                },
            },
            "required": ["title", "message"],
        },
        blast_radius=BlastRadius.MUTATE,
    ),
]


async def execute_tool(name: str, args: dict) -> str:
    if name != "send_push":
        return f"Unknown notify tool: {name}"

    title = (args.get("title") or "").strip()
    message = (args.get("message") or "").strip()
    if not title or not message:
        return "Error: title and message are both required."

    priority = args.get("priority")
    if priority is not None:
        try:
            priority = max(1, min(5, int(priority)))
        except (TypeError, ValueError):
            priority = None

    if _rate_limited():
        log.warning("send_push rate-limited (title=%r)", title[:80])
        return (
            f"Error: push rate limit reached ({_MAX_PER_WINDOW}/hour). Not sent — "
            "do not retry; include this content in your task output instead."
        )

    log.info("Executing notify tool: send_push  title=%r", title[:80])

    sent = await notify("agent_push", title=title, message=message, priority=priority)
    if sent:
        return f"Push sent: {title!r}"
    return (
        "Push not sent (notifications disabled or ntfy unreachable). "
        "Include the content in your task output instead."
    )
