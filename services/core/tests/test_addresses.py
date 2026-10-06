"""app.addresses.scrub finds an http(s) address whatever the case of its
scheme (S38 final review fix round 2, N2): `HTTPS://u:pw@h/r?token=…` and
`Https://…` used to pass through whole — in a title, an engine error, an
acted-on name and a dialog's message."""

from __future__ import annotations

import time

import pytest

from app import addresses


@pytest.mark.parametrize("scheme", ["HTTPS://", "Https://", "hTTp://", "HTTP://", "https://"])
def test_scrub_reduces_an_address_whatever_the_case_of_its_scheme(scheme):
    said = addresses.scrub(f"see {scheme}u:pw@h.example/r?token=SECRET#frag now")
    assert "SECRET" not in said and "u:pw" not in said and "frag" not in said, said
    assert said == f"see {scheme.rstrip(':/').lower()}://h.example/r now"


def test_a_scheme_glued_to_a_word_is_still_found_as_before():
    # Unchanged semantics: no word boundary was ever required before a scheme.
    assert addresses.scrub("xHTTPS://h.example/r?t=S") == "xhttps://h.example/r"


def test_a_colon_slash_slash_with_no_http_scheme_is_left_alone():
    assert addresses.scrub("ftp://u:pw@h/x?y and s3://b/k?v") == "ftp://u:pw@h/x?y and s3://b/k?v"


def test_scrub_stays_linear_on_a_4mib_mixed_case_url_dense_text():
    """Ruling I1 of Task 5, in mixed case: a text built entirely of
    any-case scheme URLs, and one of `://` with no scheme before it. Same
    budget as the lower-case pin in test_browser_tools.py."""
    for unit in ("HtTp://a ", "hTTPS://a ", "x://a "):
        text = unit * 500_000
        started = time.perf_counter()
        addresses.scrub(text)
        elapsed = time.perf_counter() - started
        assert elapsed < 4.0, (unit, elapsed)


# ── hub, after final fix round 2: user info may hold a quote or a bracket ────
#
# RFC 3986 lets user info carry `'`, `(`, `)` and the other sub-delims. The
# scrub ended a URL at those, so `https://alice:hun'ter2@b/…` became the
# candidate `https://alice:hun` — no `@` to recognise — and the password went
# through whole, in `scrub` and in `scrub_bounded`.

_STOP_IN_USER_INFO = [
    "see https://alice:hun'ter2@bank.example/p?tok=SECRET now",
    "see https://alice:hun(ter2@bank.example/p now",
    'see https://alice:hun"ter2@bank.example/p now',
    "see HTTPS://alice:hu[nter2@bank.example/p now",
    "see https://alice:hu<nter2@bank.example/p now",
]


@pytest.mark.parametrize("text", _STOP_IN_USER_INFO)
def test_scrub_drops_user_info_that_holds_a_quote_or_a_bracket(text):
    said = addresses.scrub(text)
    for secret in ("alice", "hun", "ter2", "SECRET"):
        assert secret not in said, said
    assert "bank.example/p" in said


@pytest.mark.parametrize("text", _STOP_IN_USER_INFO)
def test_scrub_bounded_never_leaves_user_info_at_any_cut(text):
    for limit in range(1, len(text) + 1):
        said, _left = addresses.scrub_bounded(text, limit)
        for secret in ("alice", "ter2", "SECRET"):
            assert secret not in said, (limit, said)


def test_a_bracket_around_a_plain_address_still_ends_it():
    assert addresses.scrub("see (https://b.example/x) ok") == "see (https://b.example/x) ok"
    assert addresses.scrub("'https://b.example/x?t=S'") == "'https://b.example/x'"


def test_scrub_stays_linear_when_every_authority_holds_an_at_sign():
    """`_host_start` scans each authority to its first `/`; a text of
    URLs with `@`-dense, quote-dense user info must stay linear."""
    for unit in ("https://a'b@c@d ", "http://(@(@(@x/ ", "https://@@@@ "):
        text = unit * 300_000
        started = time.perf_counter()
        addresses.scrub(text)
        elapsed = time.perf_counter() - started
        assert elapsed < 4.0, (unit, elapsed)
