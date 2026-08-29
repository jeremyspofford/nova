"""Fit verdicts: pure, table-driven over (needed, free, total) VRAM triples.

No I/O here — admin.py owns reading hardware.json, ollama's /api/ps, and the
probes table; this module only ever answers "given these numbers, does it
fit" so the boundaries are testable without a database or a network call.

Ruling S2e-R2: the verdict is computed from FREE VRAM (what's left after
whatever ollama already has resident), never installed-sum, and never a
static per-tier floor alone. See fit.py's module docstring for the
nvidia_smi-vs-size_vram anomaly this margin exists to cover.
"""
from __future__ import annotations

import pytest

from app import fit

# (needed_gb, free_gb, total_gb) -> expected verdict. TIGHT_HEADROOM_FRACTION
# is 0.25: comfortable needs MORE than a quarter of free VRAM left over after
# loading; anything less (down to exactly fitting) is tight; needing more
# than is free at all is wont_fit.
BOUNDARY_CASES = [
    # Exactly the S2 27B-on-24GB-card scenario (tests/e2e/measurements/
    # s2-two-model.json): 16.594 GB measured need, ~22 GB free of 24 —
    # headroom 5.406/22 = 24.6%, just under the 25% line: tight. This is
    # deliberate — see fit.py's docstring on the nvidia_smi anomaly.
    (16.594, 22.0, 24.0, fit.VERDICT_TIGHT),
    # Round numbers at the exact 25% boundary: headroom/free == 0.25 is
    # NOT "more than a quarter" -> tight, not comfortable.
    (75.0, 100.0, 100.0, fit.VERDICT_TIGHT),
    # One GB over the line: headroom/free = 26/100 > 0.25 -> comfortable.
    (74.0, 100.0, 100.0, fit.VERDICT_COMFORTABLE),
    # Needs exactly what's free: zero headroom, still loads -> tight, not
    # won't-fit (won't-fit is reserved for needing MORE than is free).
    (100.0, 100.0, 100.0, fit.VERDICT_TIGHT),
    # One GB more than is free -> wont_fit.
    (100.1, 100.0, 100.0, fit.VERDICT_WONT_FIT),
    # The S2 8B measurement: 9.508 GB of 22 GB free -> comfortable headroom
    # (56.8%).
    (9.508, 22.0, 24.0, fit.VERDICT_COMFORTABLE),
    # The plan's own worked example ("loads at ~22/24 GB — tight"): almost
    # nothing free is left over.
    (22.0, 24.0, 24.0, fit.VERDICT_TIGHT),
]


@pytest.mark.parametrize(("needed_gb", "free_gb", "total_gb", "expected"), BOUNDARY_CASES)
def test_compute_fit_boundaries(needed_gb, free_gb, total_gb, expected):
    result = fit.compute_fit(needed_gb, free_gb, total_gb, source=fit.SOURCE_ESTIMATED)
    assert result["verdict"] == expected


@pytest.mark.parametrize("missing", ["needed_gb", "free_gb", "total_gb"])
def test_compute_fit_unknown_when_any_number_is_missing(missing):
    values = {"needed_gb": 10.0, "free_gb": 20.0, "total_gb": 24.0}
    values[missing] = None
    result = fit.compute_fit(**values, source=fit.SOURCE_ESTIMATED, reason="stated reason")
    assert result["verdict"] == fit.VERDICT_UNKNOWN
    assert result["reason"] == "stated reason"


def test_compute_fit_unknown_has_a_default_reason_when_none_given():
    result = fit.compute_fit(None, None, None, source=fit.SOURCE_ESTIMATED)
    assert result["verdict"] == fit.VERDICT_UNKNOWN
    assert result["reason"]


def test_compute_fit_never_invents_numbers_it_was_not_given():
    """Ruling S2e-R2: the field that is actually undetermined renders as
    None — but a real free_gb/total_gb the caller DID have is reported
    as-is, not wiped out just because needed_gb happened to be unknown."""
    result = fit.compute_fit(
        None, 20.0, 24.0, source=fit.SOURCE_ESTIMATED, reason="no probe, no estimate"
    )
    assert result["needed_gb"] is None
    assert result["free_gb"] == 20.0
    assert result["total_gb"] == 24.0


def test_compute_fit_unknown_free_still_reports_a_known_needed_gb():
    """The mirror case: free VRAM is undetermined (e.g. ollama's /api/ps was
    unreachable) but the model's needed_gb (from a probe or the curated
    estimate) is perfectly real — it must not be hidden just because free
    VRAM could not be read."""
    result = fit.compute_fit(
        10.0, None, 24.0, source=fit.SOURCE_ESTIMATED, reason="ollama unreachable"
    )
    assert result["verdict"] == fit.VERDICT_UNKNOWN
    assert result["needed_gb"] == 10.0
    assert result["free_gb"] is None
    assert result["total_gb"] == 24.0
    assert result["reason"] == "ollama unreachable"


def test_compute_fit_carries_the_source_through_on_a_known_verdict():
    result = fit.compute_fit(10.0, 20.0, 24.0, source=fit.SOURCE_VERIFIED)
    assert result["source"] == fit.SOURCE_VERIFIED
    assert result["reason"] is None


def test_compute_fit_rounds_the_numbers_it_reports_but_not_the_math():
    # 16.594 vs 22.0 rounds to 16.6 / 22.0 for display, without the rounding
    # itself flipping which side of a boundary the verdict landed on.
    result = fit.compute_fit(16.594, 22.0, 24.0, source=fit.SOURCE_VERIFIED)
    assert result["needed_gb"] == 16.6
    assert result["free_gb"] == 22.0
    assert result["total_gb"] == 24.0


class TestNeededGbForModel:
    """Precedence: a probe row (measured, from POST /admin/probe) beats the
    curated catalog's min_vram_gb estimate."""

    def test_prefers_the_probe_row_when_one_exists(self):
        model = {"slug": "qwen3:8b", "min_vram_gb": 10}
        probe_row = {"vram_mb": 9508}
        needed_gb, source = fit.needed_gb_for(model, probe_row)
        assert needed_gb == pytest.approx(9508 / 1024)
        assert source == fit.SOURCE_VERIFIED

    def test_falls_back_to_the_curated_estimate_when_no_probe_row(self):
        model = {"slug": "qwen3:8b", "min_vram_gb": 10}
        needed_gb, source = fit.needed_gb_for(model, None)
        assert needed_gb == 10
        assert source == fit.SOURCE_ESTIMATED

    def test_falls_back_when_the_probe_row_has_no_vram_reading(self):
        # A remote/cloud probe succeeds but never learns a VRAM figure
        # (admin.py's _footprint_vram_mb bracket only runs for kind='ollama').
        model = {"slug": "some-model", "min_vram_gb": 10}
        needed_gb, source = fit.needed_gb_for(model, {"vram_mb": None})
        assert needed_gb == 10
        assert source == fit.SOURCE_ESTIMATED


# (total_gb, resident table) -> expected free_gb. Ruling S2f-R2 ("the 8B
# won't fit" bug): a local model switch EVICTS whatever ollama already has
# resident, so a resident entry on this same engine is not a competitor for
# a candidate's fit — it is given back to `total_gb`, not subtracted. Every
# case below still passes the resident table THROUGH the sum (rather than
# short-circuiting to `total_gb`), so a future non-swappable entry has a
# real subtraction to land on instead of the whole mechanism being deleted
# the day one exists.
FREE_FOR_SWITCH_CASES = [
    # Nothing resident: free is simply the whole card.
    (24.0, [], 24.0),
    # The exact walk scenario: a 17.4GB model (qwen3.8:27b, size_vram) is
    # resident. Instantaneous free would be 24 - 17.4 = 6.6GB — too little
    # for an 8B candidate, which is precisely the bug this ruling fixes.
    # Eviction-aware free is the full 24GB: the resident model is swappable.
    (24.0, [{"model": "qwen3.8:27b", "vram_mb": 17.4 * 1024}], 24.0),
    # Two resident entries (a host where ollama loaded more than one model
    # at once) are both swappable — the sum is fully reclaimed too.
    (24.0, [{"vram_mb": 9508}, {"vram_mb": 4096}], 24.0),
    # An entry explicitly marked non-swappable (nothing produces one today —
    # see the module docstring — but the field is real, not a TODO) is the
    # one case that DOES reduce free VRAM: a pinned 2GB model stays loaded
    # through a switch, so only 22GB comes back.
    (
        24.0,
        [
            {"model": "qwen3.8:27b", "vram_mb": 17.4 * 1024, "swappable": True},
            {"model": "pinned:2b", "vram_mb": 2048, "swappable": False},
        ],
        22.0,
    ),
]


@pytest.mark.parametrize(("total_gb", "resident", "expected_free_gb"), FREE_FOR_SWITCH_CASES)
def test_free_vram_gb_for_switch(total_gb, resident, expected_free_gb):
    assert fit.free_vram_gb_for_switch(total_gb, resident) == pytest.approx(expected_free_gb)
