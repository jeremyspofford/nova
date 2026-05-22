"""Derive per-tool outcome from task_events records.

task_events stores tool names in dot-notation (original form), not the
sanitized form sent to the LLM. Compare against the original tool name.
"""
from __future__ import annotations
import httpx
from audit_tool_use.types import Outcome


def derive_outcome(events: list[dict], *, expected_tool: str) -> Outcome:
    proposed = False
    last_result: dict | None = None
    saw_error = False
    for ev in events:
        et = ev.get("event_type")
        payload = ev.get("payload") or {}
        if payload.get("name") != expected_tool:
            continue
        if et == "tool_call_proposed":
            proposed = True
        elif et == "tool_call_result":
            last_result = payload
            if "error" in payload and payload["error"]:
                saw_error = True
        elif et in {"tool_call_error", "tool_call_denied"}:
            saw_error = True
    if not proposed:
        return Outcome.NOT_CALLED
    if saw_error:
        return Outcome.CALLED_ERROR
    if last_result is not None:
        return Outcome.CALLED_OK
    # Proposed but no result and no error yet — treat as error (truncated stream)
    return Outcome.CALLED_ERROR


async def fetch_task_events(
    base_url: str, task_id: str, admin_headers: dict, timeout_s: float = 10.0,
) -> list[dict]:
    """Fetch the full event log for a task. Returns events in chronological order.

    The live agent-core API wraps the list in {"events": [...]}. Be defensive
    against both shapes — accept either the wrapped or unwrapped form.
    """
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        r = await client.get(f"{base_url}/api/v1/tasks/{task_id}/events", headers=admin_headers)
        r.raise_for_status()
    body = r.json()
    if isinstance(body, dict) and "events" in body:
        return body["events"]
    return body
