"""Unit tests for the task state machine transition rules (audit bug 2).

Pure logic — validates the VALID_TRANSITIONS map, no DB. The CAS write path
is exercised by the integration pipeline tests.

Run:
    cd tests && uv run --with-requirements requirements.txt pytest test_task_state_machine.py -v
"""
from __future__ import annotations

import pytest
from _service_app import service_app


@pytest.fixture
def sm():
    with service_app("orchestrator") as import_module:
        yield import_module("app.pipeline.state_machine")


def test_submitted_can_start_running_stages(sm):
    """A submitted task picked up by the worker must be able to run — refusing
    the transition doesn't stop execution, it zombifies the row."""
    for target in (
        "queued", "context_running", "task_running", "completing",
        "failed", "cancelled",
    ):
        assert sm._is_valid_transition("submitted", target), target


def test_terminal_states_stay_terminal(sm):
    for terminal in ("complete", "failed", "cancelled"):
        for target in ("queued", "context_running", "completing", "complete"):
            assert not sm._is_valid_transition(terminal, target), (terminal, target)


def test_backwards_transitions_rejected(sm):
    assert not sm._is_valid_transition("complete", "queued")
    assert not sm._is_valid_transition("completing", "context_running")
    assert not sm._is_valid_transition("queued", "submitted")


def test_dynamic_running_statuses(sm):
    # Unknown *_running roles fall back to the dynamic rule
    assert sm._is_valid_transition("newrole_running", "completing")
    assert sm._is_valid_transition("newrole_running", "other_running")
    assert not sm._is_valid_transition("newrole_running", "queued")
