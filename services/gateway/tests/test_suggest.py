"""Pure hardware -> tier/model suggestion. No I/O, no DB — table-driven
over every tier boundary from the roadmap's VRAM table."""
from __future__ import annotations

import pytest

from app import curated, suggest

CURATED = curated.load_curated()


def _hw(*vram_mb: int) -> dict:
    return {"gpus": [{"name": "gpu", "vram_mb": v} for v in vram_mb]}


# (largest single GPU, in GB) -> expected tier. Boundaries exactly per the
# roadmap's table: >=24, 16-23, 10-15, 6-9, <6 or none.
BOUNDARY_CASES = [
    (24, suggest.TIER_27B),
    (23, suggest.TIER_14B),
    (16, suggest.TIER_14B),
    (15, suggest.TIER_8B),
    (10, suggest.TIER_8B),
    (9, suggest.TIER_4B),
    (6, suggest.TIER_4B),
    (5, suggest.TIER_3B),
    (None, suggest.TIER_3B),
]


@pytest.mark.parametrize(("vram_gb", "expected_tier"), BOUNDARY_CASES)
def test_tier_for_vram_gb_boundaries(vram_gb, expected_tier):
    assert suggest.tier_for_vram_gb(vram_gb) == expected_tier


def test_multi_gpu_uses_the_largest_single_card_not_the_sum():
    # Two 12GB cards: ollama does not shard, so this must read as one 12GB
    # card (8-12B tier), never as a summed 24GB card (27B-class).
    hw = _hw(12288, 12288)
    vram = suggest.largest_single_gpu_vram_gb(hw)
    assert vram == 12
    assert suggest.tier_for_vram_gb(vram) == suggest.TIER_8B


def test_no_gpus_is_none():
    assert suggest.largest_single_gpu_vram_gb({"gpus": []}) is None
    assert suggest.largest_single_gpu_vram_gb({}) is None


def test_largest_single_gpu_vram_gb_reads_the_hardware_json_shape():
    hw = {"gpus": [{"name": "RTX 3090", "vram_mb": 24576}]}
    assert suggest.largest_single_gpu_vram_gb(hw) == 24


def test_suggest_top_tier_leads_with_the_27b_then_offers_everything_smaller():
    """Tiers cascade DOWN, deliberately.

    This test used to assert the 27B entry and nothing else. It changed at the
    2026-08-28 DoD walk: a 24GB card was offered exactly one model, ollama
    could not start a runner for it (18GB of weights plus a 32K KV cache does
    not fit beside whatever the desktop already holds), and the wizard's model
    step had no other card to click. A single-item "Pick a model" with no
    fallback is a dead end, so every tier now lists its recommendation first
    and then the smaller models that also fit.
    """
    result = suggest.suggest(_hw(24576), CURATED)
    assert result["tier"] == suggest.TIER_27B
    assert [m["slug"] for m in result["models"]] == [
        "qwen3.8:27b",
        "qwen3:14b",
        "qwen3:8b",
        "qwen3:4b",
        "qwen3:1.7b",
    ]
    assert set(result["models"][0]) == {"slug", "label", "params_b", "min_vram_gb", "note"}


def test_lighter_alternatives_say_that_is_what_they_are():
    result = suggest.suggest(_hw(24576), CURATED)
    assert "lighter" not in result["models"][0]["note"].lower()
    for lighter in result["models"][1:]:
        assert "lighter" in lighter["note"].lower(), lighter


def test_a_tier_never_offers_a_model_from_above_it():
    """Cascading down must not become cascading up: an 8GB card must never be
    shown a 14B or a 27B, whatever the ordering logic does."""
    result = suggest.suggest(_hw(12 * 1024), CURATED)
    assert result["tier"] == suggest.TIER_8B
    assert [m["slug"] for m in result["models"]] == ["qwen3:8b", "qwen3:4b", "qwen3:1.7b"]


def test_suggest_14b_tier_also_offers_the_27b_as_a_tight_fit_alternative():
    result = suggest.suggest(_hw(20 * 1024), CURATED)
    assert result["tier"] == suggest.TIER_14B
    slugs = [m["slug"] for m in result["models"]]
    assert slugs == ["qwen3:14b", "qwen3.8:27b", "qwen3:8b", "qwen3:4b", "qwen3:1.7b"]
    tight_fit_note = result["models"][1]["note"]
    assert "tight" in tight_fit_note.lower()


def test_suggest_bottom_tier_rationale_mentions_remote_or_cloud():
    result = suggest.suggest({"gpus": []}, CURATED)
    assert result["tier"] == suggest.TIER_3B
    assert "remote/cloud" in result["rationale"]


def test_suggest_shape_has_exactly_the_pinned_keys():
    result = suggest.suggest(_hw(10240), CURATED)
    assert set(result) == {"tier", "engine_suggestion", "models", "rationale"}
    assert result["engine_suggestion"] == "ollama"
