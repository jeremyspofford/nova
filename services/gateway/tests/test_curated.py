"""The curated model catalog: a static file, loaded and sanity-checked.

Task 4 shipped every entry marked `verify_at_walk: true` — a debt marker
saying "nobody has checked this slug against the live library yet". Task 7's
DoD walk checked all five against ollama.com on 2026-08-28 (each base slug
200, each exact tag present on the library's own tags page) and discharged
the debt, so the assertion here is now the opposite one: nothing ships
carrying an unverified slug, and every entry names where it was verified.

Slice 2e (2026-08-29) re-verified all five original slugs against the live
library again (still 200, still present) and diversified the catalog beyond
a single family: gemma4:12b and llama3.1:8b were added at the 14b/8b tiers
respectively, each verified the same way. `family` names a TIER BUCKET
(the roadmap's size class), not a model vendor — more than one entry can
now share a bucket, which is exactly the point.
"""
from __future__ import annotations

import re

from app import curated

REQUIRED_FIELDS = {
    "slug",
    "label",
    "family",
    "params_b",
    "min_vram_gb",
    "size_gb",
    "note",
    "verify_at_walk",
    "verified_at",
    "verified_url",
}
EXPECTED_FAMILIES = {"27b", "14b", "8b", "4b", "2b"}


def test_load_curated_covers_every_tier_family():
    entries = curated.load_curated()
    families = {e["family"] for e in entries}
    assert families == EXPECTED_FAMILIES


def test_the_catalog_is_diversified_beyond_a_single_family():
    """The S1/S2 carry: a single-family (qwen-only) catalog with slugs never
    re-checked. At least one main tier (14b or 8b) must now offer more than
    one model, and at least one of the extras must be a non-qwen slug."""
    entries = curated.load_curated()
    by_family: dict[str, list[str]] = {}
    for e in entries:
        by_family.setdefault(e["family"], []).append(e["slug"])
    diversified_tiers = {family: slugs for family, slugs in by_family.items() if len(slugs) > 1}
    assert diversified_tiers, "no tier offers more than one model"
    non_qwen_slugs = [
        slug
        for slugs in diversified_tiers.values()
        for slug in slugs
        if not slug.startswith("qwen")
    ]
    assert non_qwen_slugs, "diversification added no non-qwen slug"


def test_every_entry_has_the_required_fields():
    for entry in curated.load_curated():
        assert REQUIRED_FIELDS <= set(entry)


def test_no_entry_still_carries_the_unverified_marker():
    for entry in curated.load_curated():
        assert entry["verify_at_walk"] is False, f"{entry['slug']} is still unverified"


def test_every_entry_names_where_its_slug_was_verified():
    """The evidence has to point at the model's own library page — a URL for
    some other model would be a verification of nothing."""
    for entry in curated.load_curated():
        base = entry["slug"].split(":")[0]
        assert entry["verified_url"] == f"https://ollama.com/library/{base}/tags"
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", entry["verified_at"])


def test_the_27b_entry_is_the_qwen38_pin_resolved():
    entries = curated.load_curated()
    entry = next(e for e in entries if e["family"] == "27b")
    assert entry["slug"] == "qwen3.8:27b"
    # The old note was "pin: verify released slug at DoD walk". It is gone
    # because the pin resolved — leaving it would advertise a debt that has
    # been paid.
    assert "verify" not in entry["note"]


def test_load_curated_accepts_an_explicit_path(tmp_path):
    custom = tmp_path / "custom.json"
    custom.write_text('[{"slug": "x", "family": "8b"}]')
    assert curated.load_curated(custom) == [{"slug": "x", "family": "8b"}]
