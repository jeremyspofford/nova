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

S10a (2026-09-06) demoted the file to the catalogue's VETTED layer. The
pin moved deliberately: `use_cases` joined REQUIRED_FIELDS (a hand-set,
dated pick from a fixed taxonomy) and `size_gb` left it (a pull is sized
live from the registry manifest or the Hugging Face sibling — a typed
number that outlived a re-pushed tag was a stale figure dressed as fact).
The loader now refuses a file that breaks either rule.
"""

from __future__ import annotations

import json
import re

import pytest

from app import curated

REQUIRED_FIELDS = {
    "slug",
    "label",
    "family",
    "params_b",
    "min_vram_gb",
    "note",
    "verify_at_walk",
    "verified_at",
    "verified_url",
    "use_cases",
    "use_cases_verified_at",
}
EXPECTED_FAMILIES = {"27b", "14b", "8b", "4b", "2b"}

VALID_ENTRY = {
    "slug": "x:1b",
    "label": "X 1B",
    "family": "8b",
    "params_b": 1,
    "min_vram_gb": 2,
    "note": "test-only",
    "use_cases": ["chat"],
    "use_cases_verified_at": "2026-09-06",
    "verify_at_walk": False,
    "verified_at": "2026-09-06",
    "verified_url": "https://ollama.com/library/x/tags",
}


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


def test_use_cases_are_from_the_fixed_taxonomy():
    """Every use case an entry claims is one of the nine the catalogue
    filters on — a value outside the taxonomy would be a filter nothing
    else can match — and each entry claims at least one, once."""
    for entry in curated.load_curated():
        use_cases = entry["use_cases"]
        assert isinstance(use_cases, list) and use_cases, entry["slug"]
        assert set(use_cases) <= set(curated.USE_CASES), entry["slug"]
        assert len(set(use_cases)) == len(use_cases), entry["slug"]


def test_vision_is_claimed_only_where_the_model_takes_image_input():
    """The v3 editorial rule, kept: gemma4 is the one curated pick that
    takes images; a Qwen3 text model claiming vision would be a lie the UI
    turns into a filter match."""
    by_slug = {e["slug"]: set(e["use_cases"]) for e in curated.load_curated()}
    assert "vision" in by_slug["gemma4:12b"]
    for slug, use_cases in by_slug.items():
        if slug != "gemma4:12b":
            assert "vision" not in use_cases, slug


def test_no_entry_carries_a_typed_size_any_more():
    """The size a pull needs is DERIVED live (registry manifest / Hugging
    Face sibling); a number typed here would go stale the day a tag is
    re-pushed and still read as a measurement."""
    for entry in curated.load_curated():
        assert "size_gb" not in entry, entry["slug"]


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
    custom.write_text(json.dumps([VALID_ENTRY]))
    assert curated.load_curated(custom) == [VALID_ENTRY]


@pytest.mark.parametrize(
    ("mutation", "words"),
    [
        (lambda e: e.pop("min_vram_gb"), "missing min_vram_gb"),
        (lambda e: e.pop("use_cases"), "missing use_cases"),
        (lambda e: e.update(use_cases=["chat", "gaming"]), "outside the taxonomy"),
        (lambda e: e.update(use_cases=[]), "non-empty list"),
        (lambda e: e.update(use_cases=["chat", "chat"]), "repeats"),
        (lambda e: e.update(size_gb=1.2), "size_gb"),
    ],
)
def test_the_loader_refuses_a_file_that_breaks_the_rules(tmp_path, mutation, words):
    """A bad edit fails the first load, naming the entry and the rule —
    never a filter on the Models page that silently matches nothing."""
    entry = dict(VALID_ENTRY)
    mutation(entry)
    custom = tmp_path / "custom.json"
    custom.write_text(json.dumps([entry]))
    with pytest.raises(curated.CuratedInvalid) as exc:
        curated.load_curated(custom)
    assert words in str(exc.value)
    assert "x:1b" in str(exc.value)


def test_the_loader_refuses_a_duplicated_slug(tmp_path):
    custom = tmp_path / "custom.json"
    custom.write_text(json.dumps([VALID_ENTRY, VALID_ENTRY]))
    with pytest.raises(curated.CuratedInvalid, match="more than once"):
        curated.load_curated(custom)
