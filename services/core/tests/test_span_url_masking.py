"""An address in a span argument keeps its host and path and loses what a
token rides in — user info, query, fragment (S38). For every tool: a reset
link read with fetch_url leaks the same way as one opened in her browser."""

from __future__ import annotations

from app import chat, tools
from tests.test_span_masking import _register_stand_in


def test_a_url_argument_loses_its_query_fragment_and_user():
    recorded = chat._span_arguments(
        {"url": "https://user:hunter22@example.invalid/reset?token=abc123#done"}
    )
    assert recorded == {
        "url": "https://<masked:13 chars>@example.invalid/reset?<masked:12 chars>#<masked:4 chars>"
    }
    assert "abc123" not in str(recorded) and "hunter22" not in str(recorded)


def test_a_plain_address_is_kept_as_it_was():
    assert chat._span_arguments({"url": "https://example.invalid/docs/page"}) == {
        "url": "https://example.invalid/docs/page"
    }


def test_the_rule_applies_to_every_tool_not_only_the_browser():
    raw = '{"url": "https://api.example.invalid/v1/items?page=2&key=s3cret"}'
    recorded = chat._span_arguments(raw)
    assert recorded == {"url": "https://api.example.invalid/v1/items?<masked:17 chars>"}


def test_what_is_not_an_http_address_is_left_alone():
    for value in ("not a url", "ftp://host/file?x=1", "http://[bad", ""):
        assert chat._span_arguments({"url": value}) == {"url": value}


def test_a_hostless_address_still_loses_its_query_and_fragment():
    """Fix round 1: `https:///reset?token=abc123` has an empty netloc — no
    host at all — but it is still an http(s) value, so the rule still
    applies to its query and fragment. An empty netloc gives no
    `<masked:0 chars>@` prefix (there is no user info to mask)."""
    assert chat._span_arguments({"url": "https:///reset?token=abc123"}) == {
        "url": "https:///reset?<masked:12 chars>"
    }
    assert chat._span_arguments({"url": "https:///reset#done"}) == {
        "url": "https:///reset#<masked:4 chars>"
    }
    assert chat._span_arguments({"url": "https:///reset?token=abc123#done"}) == {
        "url": "https:///reset?<masked:12 chars>#<masked:4 chars>"
    }


def test_other_keys_are_untouched_and_credentials_still_masked():
    recorded = chat._span_arguments({"query": "a?b=c", "token": "secret-value", "url": None})
    assert recorded == {"query": "a?b=c", "token": "<masked:12 chars>", "url": None}


def test_a_declared_origin_only_url_composes_with_the_new_masking(monkeypatch):
    """The two rules compose (S37a + S38). `_origin_only` runs first: a tool
    that declares `url` in `Tool.traced_as_origin` already arrives at
    `_redact` reduced to its bare origin, so this branch has nothing left to
    mask. An undeclared tool's `url` — fetch_url, her browser tools — never
    goes through `_origin_only`, so this branch is what strips it: the same
    address, scheme/host/path kept, user info and query masked."""
    _register_stand_in(monkeypatch)
    address = "https://u:p@h.invalid:8123/private_abc/mcp?k=1"

    declared = chat._span_arguments({"url": address}, "stand_in")
    assert declared == {"url": "https://h.invalid:8123"}

    assert tools.REGISTRY["fetch_url"].traced_as_origin == ()
    undeclared = chat._span_arguments({"url": address}, "fetch_url")
    assert undeclared == {
        "url": "https://<masked:3 chars>@h.invalid:8123/private_abc/mcp?<masked:3 chars>"
    }
