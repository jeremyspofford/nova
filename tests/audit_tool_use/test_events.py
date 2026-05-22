import pytest
from audit_tool_use.events import derive_outcome
from audit_tool_use.types import Outcome


def test_no_tool_call_proposed_returns_not_called():
    events = [{"event_type": "task_started"}, {"event_type": "task_completed"}]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.NOT_CALLED


def test_tool_call_proposed_then_error_returns_called_error():
    events = [
        {"event_type": "tool_call_proposed", "payload": {"name": "fs.write"}},
        {"event_type": "tool_call_error", "payload": {"name": "fs.write", "error": "boom"}},
    ]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.CALLED_ERROR


def test_tool_call_proposed_then_clean_result_returns_called_ok():
    events = [
        {"event_type": "tool_call_proposed", "payload": {"name": "fs.write"}},
        {"event_type": "tool_call_result", "payload": {"name": "fs.write", "size": 12}},
    ]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.CALLED_OK


def test_tool_call_result_with_error_key_returns_called_error():
    events = [
        {"event_type": "tool_call_proposed", "payload": {"name": "fs.write"}},
        {"event_type": "tool_call_result", "payload": {"name": "fs.write", "error": "Path outside workspace"}},
    ]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.CALLED_ERROR


def test_unrelated_tool_calls_ignored():
    events = [
        {"event_type": "tool_call_proposed", "payload": {"name": "memory.search"}},
        {"event_type": "tool_call_result", "payload": {"name": "memory.search"}},
    ]
    assert derive_outcome(events, expected_tool="fs.write") == Outcome.NOT_CALLED


def test_derive_outcome_requires_list_not_wrapper_dict():
    """REGRESSION: live /api/v1/tasks/{id}/events returns {"events": [...]}.
    fetch_task_events MUST unwrap to a list before passing to derive_outcome.
    This test documents the failure mode if someone passes the wrapper directly."""
    wrapper = {"events": [{"event_type": "task_started"}]}
    with pytest.raises(AttributeError):
        derive_outcome(wrapper, expected_tool="fs.write")  # type: ignore[arg-type]
