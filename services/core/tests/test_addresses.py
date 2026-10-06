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
