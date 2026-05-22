"""Unit tests for derive_outcome — use real-shape fixture events captured
from the live agent-core /api/v1/tasks/{id}/events endpoint.

Real shape (verified 2026-05-22):
  tool_call_proposed payload: {tool_name, call_id, args, caller_role}
  tool_call_started  payload: {call_id}
  tool_call_result   payload: {call_id, result: {...}}     # no tool_name
  tool_call_error    payload: {call_id, error: "..."}      # no tool_name
  tool_call_denied   payload: {call_id}                    # no tool_name

So derive_outcome must correlate result/error/denied events back to their
proposed event via call_id — they don't carry tool_name themselves.
"""
import pytest
from audit_tool_use.events import derive_outcome
from audit_tool_use.types import Outcome


def test_no_tool_call_proposed_returns_not_called():
    events = [{"event_type": "task_started"}, {"event_type": "task_completed"}]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.NOT_CALLED


def test_tool_call_proposed_then_error_returns_called_error():
    events = [
        {"event_type": "tool_call_proposed", "payload": {"tool_name": "fs.write", "call_id": "c1"}},
        {"event_type": "tool_call_error", "payload": {"call_id": "c1", "error": "boom"}},
    ]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.CALLED_ERROR


def test_tool_call_proposed_then_clean_result_returns_called_ok():
    events = [
        {"event_type": "tool_call_proposed", "payload": {"tool_name": "fs.write", "call_id": "c1"}},
        {"event_type": "tool_call_started", "payload": {"call_id": "c1"}},
        {"event_type": "tool_call_result", "payload": {"call_id": "c1", "result": {"bytes_written": 12}}},
    ]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.CALLED_OK


def test_tool_call_result_with_error_key_returns_called_error():
    """The dispatcher wraps tool errors as {error: ...} INSIDE the result payload."""
    events = [
        {"event_type": "tool_call_proposed", "payload": {"tool_name": "fs.write", "call_id": "c1"}},
        {"event_type": "tool_call_result", "payload": {"call_id": "c1", "result": {"error": "Path outside workspace"}}},
    ]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.CALLED_ERROR


def test_tool_call_denied_returns_called_error():
    """If the user denies approval, dispatcher emits tool_call_denied with only call_id."""
    events = [
        {"event_type": "tool_call_proposed", "payload": {"tool_name": "fs.write", "call_id": "c1"}},
        {"event_type": "tool_call_denied", "payload": {"call_id": "c1"}},
    ]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.CALLED_ERROR


def test_unrelated_tool_calls_ignored():
    events = [
        {"event_type": "tool_call_proposed", "payload": {"tool_name": "memory.search", "call_id": "c1"}},
        {"event_type": "tool_call_result", "payload": {"call_id": "c1", "result": {}}},
    ]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.NOT_CALLED


def test_correlation_by_call_id_only_includes_matching_events():
    """A different tool's result events (different call_id) must not affect outcome."""
    events = [
        {"event_type": "tool_call_proposed", "payload": {"tool_name": "fs.write", "call_id": "c1"}},
        {"event_type": "tool_call_proposed", "payload": {"tool_name": "memory.search", "call_id": "c2"}},
        {"event_type": "tool_call_error", "payload": {"call_id": "c2", "error": "boom"}},
        {"event_type": "tool_call_result", "payload": {"call_id": "c1", "result": {"ok": True}}},
    ]
    # fs.write's c1 succeeded; memory.search's c2 failed but we're asking about fs.write
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.CALLED_OK


def test_derive_outcome_requires_list_not_wrapper_dict():
    wrapper = {"events": [{"event_type": "task_started"}]}
    with pytest.raises(AttributeError):
        derive_outcome(wrapper, expected_tool="fs.write")  # type: ignore[arg-type]
