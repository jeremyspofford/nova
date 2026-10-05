"""Credentials never reach the trace (S37a, plan decision P14): a value under a
credential-shaped key is masked by `chat._redact`, before the span is bounded,
for every tool — mcp_connect's token first among them."""

from __future__ import annotations

import json

from app import chat, tools
from app.tools.base import Tool


def test_credential_keys_are_masked_at_any_depth():
    recorded = chat._span_arguments(
        json.dumps(
            {
                "name": "github",
                "url": "https://x.invalid/mcp",
                "token": "ghp_secret_value",
                "headers": {
                    "Authorization": "Bearer abc123",
                    "X-MCP-Toolsets": "actions",
                    "X-Api-Key": "k-9",
                },
                "env": {"GH_TOKEN": "tok-2", "PATH": "/usr/bin"},
                "items": [{"password": "hunter2"}],
            }
        )
    )
    written = json.dumps(recorded)
    for secret in ("ghp_secret_value", "abc123", "k-9", "tok-2", "hunter2"):
        assert secret not in written
    assert recorded["token"] == "<masked:16 chars>"
    assert recorded["headers"]["X-MCP-Toolsets"] == "actions"
    assert recorded["env"]["PATH"] == "/usr/bin"


def test_ordinary_arguments_are_left_as_they_were():
    args = {"path": "notes/today.md", "query": "token budget", "key": "digest", "name": "tidy"}
    assert chat._span_arguments(args) == args


def test_a_null_credential_stays_null():
    assert chat._span_arguments({"token": None}) == {"token": None}


def test_a_huge_credential_is_masked_before_it_is_bounded():
    recorded = chat._span_arguments({"token": "x" * 100_000})
    assert recorded == {"token": "<masked:100000 chars>"}


def test_a_headers_object_header_named_only_for_a_key_is_masked():
    """Ruling F8, superseded in MECHANISM (not intent) by the Task 5 carry
    T5-B-REVISED: a header NAME carrying no 'token'/'secret'/'password'/
    'auth'/'cookie' word, only 'key' (`X-Hass-Key`, ha-mcp's own header), is
    still masked — by `app.mcp.client.is_credential_header`, the SAME
    predicate the client's own reason scrub already uses, not a second word
    list kept here."""
    value = "ha-secret-value"
    recorded = chat._span_arguments({"headers": {"X-Hass-Key": value, "X-MCP-Toolsets": "actions"}})
    assert recorded["headers"]["X-Hass-Key"] == f"<masked:{len(value)} chars>"
    assert recorded["headers"]["X-MCP-Toolsets"] == "actions"


async def _unused_executor(args: dict, ctx) -> str:
    return "unused"


def _register_stand_in(monkeypatch) -> None:
    """A tool that declares `url` as origin-only, registered for the test
    alone (ruling X2-REVISED) — `monkeypatch.setitem` restores the registry
    on teardown, the same pattern every other chat test uses."""
    monkeypatch.setitem(
        tools.REGISTRY,
        "stand_in",
        Tool(
            name="stand_in",
            description="d",
            parameters={"type": "object", "properties": {}},
            executor=_unused_executor,
            traced_as_origin=("url",),
        ),
    )


def test_a_declared_url_argument_is_reduced_to_its_origin(monkeypatch):
    _register_stand_in(monkeypatch)
    recorded = chat._span_arguments(
        {"name": "ha", "url": "https://User:pw@HA.example:8123/private_abc123/mcp?k=1"},
        "stand_in",
    )
    assert recorded["url"] == "https://ha.example:8123"
    written = json.dumps(recorded)
    for secret in ("private_abc123", "pw", "k=1"):
        assert secret not in written


def test_a_declared_argument_that_is_not_a_url_is_masked_whole(monkeypatch):
    _register_stand_in(monkeypatch)
    value = "not a url at all"
    recorded = chat._span_arguments({"url": value}, "stand_in")
    assert recorded == {"url": f"<masked:{len(value)} chars>"}


def test_a_malformed_url_value_is_masked_whole_not_raised(monkeypatch):
    """A bad port makes `urlsplit(...).port` raise ValueError (every existing
    caller of `_normalize_origin` only ever sees an already-validated URL, so
    this never surfaced before). The trace writer has no such guarantee — a
    typo in the model's own argument must still be masked whole, per spec,
    never crash the span it is recorded on."""
    _register_stand_in(monkeypatch)
    value = "https://host:not-a-port/mcp"
    recorded = chat._span_arguments({"url": value}, "stand_in")
    assert recorded == {"url": f"<masked:{len(value)} chars>"}


def test_a_tool_without_the_declaration_leaves_its_url_argument_alone():
    """fetch_url takes no `traced_as_origin` (S38 strips its query
    separately) — its one url argument must come through exactly as sent,
    the same as when no tool_name is passed at all (every test above)."""
    assert tools.REGISTRY["fetch_url"].traced_as_origin == ()
    recorded = chat._span_arguments({"url": "https://x.invalid/mcp"}, "fetch_url")
    assert recorded["url"] == "https://x.invalid/mcp"
