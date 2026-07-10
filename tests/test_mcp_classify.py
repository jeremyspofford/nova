"""Unit tests for MCP tool blast-radius classification (Slice 0 — MCP consent gate).

Pure logic — no services needed. Orchestrator's ``app.*`` is imported in
isolation via tests/_service_app.py so it coexists with other services' ``app``
packages in one pytest session.

Run:
    cd tests && uv run --with-requirements requirements.txt pytest test_mcp_classify.py -v
"""
from __future__ import annotations

import pytest
from _service_app import service_app


@pytest.fixture
def clf():
    with service_app("orchestrator") as import_module:
        yield import_module("app.tools.mcp_classify")


def test_read_verbs_auto_allow(clf):
    for name in (
        "mcp__ha__get_state",
        "mcp__fs__list_dir",
        "mcp__brave__search_web",
        "mcp__fs__read_file",
        "mcp__db__query_rows",
    ):
        assert clf.classify(name).value == "read", name


def test_write_verbs_require_consent(clf):
    for name in (
        "mcp__ha__light.turn_on",
        "mcp__ha__climate.set_temperature",
        "mcp__n8n__run_workflow",
        "mcp__x__create_thing",
    ):
        assert clf.classify(name).value == "mutate", name


def test_destructive_verbs(clf):
    for name in (
        "mcp__ha__lock.unlock",
        "mcp__adguard__flush_blocklist",
        "mcp__fs__delete_file",
        "mcp__x__get_and_delete",  # destruct beats read when both tokens present
    ):
        assert clf.classify(name).value == "destruct", name


def test_unknown_defaults_to_mutate_fail_closed(clf):
    # No leading read verb → fail closed to MUTATE, never silently READ.
    # 'HassGetState' *is* a read, but a vendor-prefixed name can't be trusted by
    # heuristic alone — the Home Assistant catalog template overrides it to READ.
    assert clf.classify("mcp__ha__HassTurnOn").value == "mutate"
    assert clf.classify("mcp__ha__HassGetState").value == "mutate"
    assert clf.classify("mcp__weird__zorp").value == "mutate"


def test_operator_override_wins(clf):
    # Override downgrades an otherwise-destruct tool (operator's explicit call).
    meta = {"tool_blast_radius": {"lock.unlock": "read"}}
    assert clf.classify("mcp__ha__lock.unlock", meta).value == "read"
    # Server-wide default via '*'.
    star = {"tool_blast_radius": {"*": "read"}}
    assert clf.classify("mcp__ha__anything_at_all", star).value == "read"
    # A bad override value falls through to the heuristic rather than crashing.
    bad = {"tool_blast_radius": {"lock.unlock": "not-a-radius"}}
    assert clf.classify("mcp__ha__lock.unlock", bad).value == "destruct"


def test_target_extraction(clf):
    assert clf.target_of({"entity_id": "light.office"}) == "light.office"
    assert clf.target_of({"path": "/etc/hosts"}) == "/etc/hosts"
    assert clf.target_of({"entity_id": ["lock.front", "lock.back"]}) == "lock.front"
    assert clf.target_of({"nested": {"entity_id": "x"}}) is None  # 'nested' isn't a target key
    assert clf.target_of({}) is None
    assert clf.target_of(None) is None


def test_provider_kind(clf):
    assert clf.provider_kind_of("homeassistant") == "homeassistant"
    assert clf.provider_kind_of("srv", {"provider_kind": "home_assistant"}) == "home_assistant"
