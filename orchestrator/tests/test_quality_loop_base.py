"""Tests for QualityLoop dataclasses and Decision logic."""
from __future__ import annotations

from app.quality_loop.base import (
    SenseReading,
    Verification,
    decide_default,
)


def test_decide_default_persists_on_significant_improvement():
    baseline = SenseReading(composite=70.0, dimensions={}, sample_size=7, snapshot_id="A")
    after = SenseReading(composite=73.0, dimensions={}, sample_size=7, snapshot_id="B")
    v = Verification(baseline=baseline, after=after, delta={"composite": 3.0}, significant=True)
    d = decide_default(v, persist_threshold=2.0, revert_threshold=1.0)
    assert d.action == "persist"
    assert d.outcome == "improved"


def test_decide_default_reverts_on_regression():
    baseline = SenseReading(composite=70.0, dimensions={}, sample_size=7, snapshot_id="A")
    after = SenseReading(composite=68.0, dimensions={}, sample_size=7, snapshot_id="B")
    v = Verification(baseline=baseline, after=after, delta={"composite": -2.0}, significant=True)
    d = decide_default(v)
    assert d.action == "revert"
    assert d.outcome == "regressed"


def test_decide_default_reverts_on_no_change():
    """Below the persist threshold and not regressed -> revert (no_change)."""
    baseline = SenseReading(composite=70.0, dimensions={}, sample_size=7, snapshot_id="A")
    after = SenseReading(composite=70.5, dimensions={}, sample_size=7, snapshot_id="B")
    v = Verification(baseline=baseline, after=after, delta={"composite": 0.5}, significant=False)
    d = decide_default(v)
    assert d.action == "revert"
    assert d.outcome == "no_change"
