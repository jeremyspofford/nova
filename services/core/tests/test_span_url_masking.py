"""An address in a span argument keeps its host and path and loses what a
token rides in — user info, query, fragment (S38). For every tool: a reset
link read with fetch_url leaks the same way as one opened in her browser."""

from __future__ import annotations

from app import addresses, chat, tools
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
    # Fix round 2 (ruling G34): "http://[bad" MOVED out of this set — it
    # LOOKS like an http(s) address and so is masked whole now (below),
    # never handed back raw just because `urlsplit` could not parse it.
    for value in ("not a url", "ftp://host/file?x=1", ""):
        assert chat._span_arguments({"url": value}) == {"url": value}


def test_an_unparseable_value_shaped_like_http_is_masked_whole():
    """Ruling G34 (fix round 2, B): `urlsplit` raising on a value — an
    unterminated IPv6 host, say — used to make `_address_without_secrets`/
    `addresses.masked` hand it back RAW, on the technicality that there
    were no `.query`/`.fragment` parts to replace. A value shaped like an
    http(s) address that still cannot be parsed is masked WHOLE instead;
    `test_what_is_not_an_http_address_is_left_alone` keeps the three cases
    that do not even look like one."""
    assert chat._span_arguments({"url": "http://[bad"}) == {"url": "<masked:11 chars>"}
    secret = "http://[::1/reset?token=abc123"
    recorded = chat._span_arguments({"url": secret})
    assert recorded == {"url": f"<masked:{len(secret)} chars>"}
    assert "abc123" not in str(recorded)
    # Case-insensitive, and https too — the same rule either way.
    assert chat._span_arguments({"url": "HTTPS://[bad"}) == {"url": "<masked:12 chars>"}


def test_an_unparseable_value_not_shaped_like_http_is_still_left_alone():
    """The other half of G34: masking is about an ADDRESS. A value that
    does not even look like one is not a value this function reveals, so
    an unparseable one of those stays exactly as it was — never masked on
    the grounds that it merely failed to parse."""
    assert chat._span_arguments({"url": "ftp://[bad"}) == {"url": "ftp://[bad"}
    assert chat._span_arguments({"url": "[bad either way"}) == {"url": "[bad either way"}


def test_addresses_shown_drops_user_info_too_on_an_unparseable_value():
    """Fix round 2, B's other half: `addresses.shown` (her tools' and
    page facts' rendering) already dropped the query on a value `urlsplit`
    itself cannot read (m11's own case); it must drop user info the same
    way, by the same str-methods fallback, since there is no `.netloc` to
    read it from the normal way."""
    assert addresses.shown("http://[::1/reset?token=abc123") == "http://[::1/reset"
    assert addresses.shown("http://user:pass@[::1/reset?token=abc123") == "http://[::1/reset"
    assert addresses.shown("http://user:pass@[::1/reset#frag") == "http://[::1/reset"


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
