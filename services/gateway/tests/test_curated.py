"""The curated model catalog: a static file, loaded and sanity-checked.

Every entry is a debt marker (verify_at_walk) until Task 7's DoD walk
proves the slug against the live ollama library — never presented as a
certain fact here.
"""
from __future__ import annotations

from app import curated

REQUIRED_FIELDS = {"slug", "label", "family", "params_b", "min_vram_gb", "size_gb", "note"}
EXPECTED_FAMILIES = {"27b", "14b", "8b", "4b", "2b"}


def test_load_curated_returns_one_entry_per_tier_family():
    entries = curated.load_curated()
    families = {e["family"] for e in entries}
    assert families == EXPECTED_FAMILIES


def test_every_entry_has_the_required_fields():
    for entry in curated.load_curated():
        assert REQUIRED_FIELDS <= set(entry)


def test_every_slug_is_marked_unverified():
    for entry in curated.load_curated():
        assert entry["verify_at_walk"] is True


def test_the_27b_entry_carries_the_pin_note():
    entries = curated.load_curated()
    entry = next(e for e in entries if e["family"] == "27b")
    assert entry["note"] == "pin: verify released slug at DoD walk"


def test_load_curated_accepts_an_explicit_path(tmp_path):
    custom = tmp_path / "custom.json"
    custom.write_text('[{"slug": "x", "family": "8b"}]')
    assert curated.load_curated(custom) == [{"slug": "x", "family": "8b"}]
