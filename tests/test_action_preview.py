"""Unit tests for consent-gate action previews (Slice 3).

Pure logic — no services. Orchestrator's app.* is imported in isolation via
tests/_service_app.py.

Run:
    cd tests && uv run --with-requirements requirements.txt pytest test_action_preview.py -v
"""
from __future__ import annotations

import pytest
from _service_app import service_app


@pytest.fixture
def pv():
    with service_app("orchestrator") as import_module:
        yield import_module("app.capabilities.preview")


def test_destructive_action_is_flagged(pv):
    out = pv.build_action_preview(
        tool_name="mcp__ha__lock.unlock",
        provider_kind="home_assistant",
        target="lock.front_door",
        args={"entity_id": "lock.front_door"},
        blast_radius="destruct",
    )
    assert out == "⚠ Irreversible — Home Assistant → unlock on lock.front_door"


def test_mutate_action_with_salient_arg(pv):
    out = pv.build_action_preview(
        tool_name="mcp__n8n__run_workflow",
        provider_kind="n8n",
        target="wf-123",
        args={"workflow_id": "wf-123", "mode": "manual"},
        blast_radius="mutate",
    )
    # target (== workflow_id) not repeated as an arg; mode surfaced; no warning.
    assert out == "n8n → run workflow on wf-123  (mode=manual)"


def test_secret_args_are_suppressed(pv):
    out = pv.build_action_preview(
        tool_name="mcp__gh__create_issue",
        provider_kind="github",
        target="owner/repo",
        args={"token": "ghp_SECRET", "title": "Bug"},
        blast_radius="mutate",
    )
    assert "ghp_SECRET" not in out
    assert out == "GitHub → create issue on owner/repo  (title=Bug)"


def test_unknown_provider_falls_back_to_server_name(pv):
    out = pv.build_action_preview(
        tool_name="mcp__weird__do_thing", provider_kind=None, target=None, args={},
    )
    assert out == "weird → do thing"


def test_long_arg_value_truncated(pv):
    out = pv.build_action_preview(
        tool_name="mcp__x__set_note", provider_kind="x", target=None,
        args={"note": "z" * 200}, blast_radius="mutate",
    )
    assert "…" in out and len(out) < 120
