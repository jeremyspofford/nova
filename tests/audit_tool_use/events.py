"""Derive per-tool outcome from task_events records.

task_events stores tool names in dot-notation (original form), not the
sanitized form sent to the LLM. Compare against the original tool name.
"""
from __future__ import annotations
import httpx
from audit_tool_use.types import Outcome


def derive_outcome(events: list[dict], *, expected_tool: str) -> Outcome:
    """Derive a per-trial Outcome by walking task_events.

    Live agent-core event shape (verified 2026-05-22):
      tool_call_proposed: payload has `tool_name` + `call_id` + `args`
      tool_call_started:  payload has `call_id` only
      tool_call_result:   payload has `call_id` + `result` (no tool_name)
      tool_call_error:    payload has `call_id` + `error` (no tool_name)
      tool_call_denied:   payload has `call_id` (no tool_name)

    Result/error/denied events DON'T carry the tool name — we map them back
    to the proposed event via call_id. Tool names in payload are dot-notation
    (original form, not the sanitized form sent to the LLM).
    """
    # First pass: find tool_call_proposed events for the expected tool, indexed by call_id
    proposed_call_ids: set[str] = set()
    for ev in events:
        if ev.get("event_type") != "tool_call_proposed":
            continue
        payload = ev.get("payload") or {}
        if payload.get("tool_name") == expected_tool:
            cid = payload.get("call_id")
            if cid:
                proposed_call_ids.add(cid)

    if not proposed_call_ids:
        return Outcome.NOT_CALLED

    # Second pass: among events matching our call_ids, derive success/error
    last_result: dict | None = None
    saw_error = False
    for ev in events:
        et = ev.get("event_type")
        payload = ev.get("payload") or {}
        cid = payload.get("call_id")
        if not cid or cid not in proposed_call_ids:
            continue
        if et == "tool_call_result":
            last_result = payload.get("result") or {}
            # The dispatcher wraps tool errors as {"error": "..."} in the result
            if isinstance(last_result, dict) and "error" in last_result and last_result["error"]:
                saw_error = True
        elif et in {"tool_call_error", "tool_call_denied"}:
            saw_error = True

    if saw_error:
        return Outcome.CALLED_ERROR
    if last_result is not None:
        return Outcome.CALLED_OK
    # Proposed but no result and no error — truncated stream
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
