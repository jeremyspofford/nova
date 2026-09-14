"""Fit verdicts: pure, table-driven over (needed, free, total) VRAM triples.

No I/O here — admin.py owns reading the CARD (app/devices_vram.py, one live
nvidia-smi call), ollama's /api/ps, and the probes table; this module only
ever answers "given these numbers, does it fit" so the boundaries are
testable without a database or a network call.

Ruling S2e-R2: the verdict is computed from FREE VRAM, never installed-sum
and never a static per-tier floor alone. S22 made that free number actually
move: it is the card's own live figure plus what a switch would evict, so
a consumer this container cannot even enumerate (a game on the Windows
side) shows up in it. See fit.py's "THE FRAME, STATED ONCE".
"""

from __future__ import annotations

import pathlib

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
    """Precedence (S22): a probe row's measurement beats the registry's own
    byte count, which beats the hand-written curated integer."""

    def test_prefers_the_probe_row_when_one_exists(self):
        model = {"slug": "qwen3:8b", "min_vram_gb": 10}
        probe_row = {"vram_mb": 9508}
        needed_gb, source = fit.needed_gb_for(model, probe_row, 6_000_000_000)
        assert needed_gb == pytest.approx(9508 / 1024)
        assert source == fit.SOURCE_VERIFIED

    def test_prefers_the_registry_byte_count_over_the_curated_integer(self):
        """The bytes are a fact about the copy on this host; min_vram_gb is
        somebody's memory of a measurement, re-anchored in the old
        whole-card frame and therefore high in this one."""
        model = {"slug": "qwen3:8b", "min_vram_gb": 10}
        needed_gb, source = fit.needed_gb_for(model, None, 6 * 1024**3)
        assert needed_gb == pytest.approx(6.0)
        assert source == fit.SOURCE_ESTIMATED

    def test_falls_back_to_the_curated_estimate_when_nothing_else_is_known(self):
        model = {"slug": "qwen3:8b", "min_vram_gb": 10}
        needed_gb, source = fit.needed_gb_for(model, None)
        assert needed_gb == 10
        assert source == fit.SOURCE_ESTIMATED

    def test_falls_back_when_the_probe_row_has_no_vram_reading(self):
        # A remote/cloud probe succeeds but never learns a VRAM figure —
        # nothing was resident on this host to read.
        model = {"slug": "some-model", "min_vram_gb": 10}
        needed_gb, source = fit.needed_gb_for(model, {"vram_mb": None})
        assert needed_gb == 10
        assert source == fit.SOURCE_ESTIMATED

    def test_none_when_the_model_is_sized_by_nothing_at_all(self):
        """Not a zero. compute_fit renders this as an honest `unknown`; a
        zero would render as `comfortable` on any card."""
        needed_gb, source = fit.needed_gb_for({}, None, None)
        assert needed_gb is None
        assert source == fit.SOURCE_ESTIMATED


# (free_mb from the card, resident table) -> expected free_gb after a
# switch. Ruling S2f-R2 ("the 8B won't fit" bug): a local model switch
# EVICTS whatever ollama already has resident, so a resident entry on this
# same engine is not a competitor for a candidate's fit — it is added back
# to the card's live free figure, not left out of it.
#
# S22 deleted the `swappable` flag the old version summed over. Its own
# docstring conceded nothing ever produced an entry carrying it, which made
# the subtraction a no-op dressed as a computation; a genuinely
# non-reclaimable consumer now shows up where it belongs, in the card's
# live `used` reading, and therefore in `free_mb` below.
FREE_AFTER_SWITCH_CASES = [
    # Nothing resident on an idle 24GB card: free is what the driver says,
    # baseline already subtracted for us (~2.6GB of Xwayland/WSL2 here).
    (21.4 * 1024, [], 21.4),
    # The exact walk scenario: a 17.4GB model (qwen3.8:27b, size_vram) is
    # resident, so the card reports only ~4GB free. Instantaneous free is
    # too little for an 8B candidate — precisely the bug this ruling fixes.
    # Adding back what the switch evicts returns 21.4GB.
    (4.0 * 1024, [{"model": "qwen3.8:27b", "vram_mb": 17.4 * 1024}], 21.4),
    # Two resident entries (ollama holding more than one model at once) are
    # both evicted by a switch, so both come back.
    (1.0 * 1024, [{"vram_mb": 9508}, {"vram_mb": 4096}], (1.0 * 1024 + 13604) / 1024),
    # THE CASE THE OLD MATH COULD NOT EXPRESS (2026-09-12): a video game
    # holds 7GB of the card. Nothing is resident in ollama, so nothing is
    # added back, and free is 7GB lower than an idle machine's — a number
    # that MOVES, where the old one was pinned to total forever.
    (14.4 * 1024, [], 14.4),
]


@pytest.mark.parametrize(("free_mb", "resident", "expected_free_gb"), FREE_AFTER_SWITCH_CASES)
def test_free_gb_after_switch(free_mb, resident, expected_free_gb):
    assert fit.free_gb_after_switch(free_mb, resident) == pytest.approx(expected_free_gb)


def test_the_swappable_flag_is_gone_for_good():
    """A tripwire, not a formality. The flag made free VRAM identically
    total VRAM for the life of v4, and the day someone reintroduces it the
    free number stops moving again — which is the entire failure this slice
    exists to have caught."""
    assert not hasattr(fit, "free_vram_gb_for_switch")
    source = (pathlib.Path(fit.__file__)).read_text()
    assert "swappable" not in source.split('"""')[2]
