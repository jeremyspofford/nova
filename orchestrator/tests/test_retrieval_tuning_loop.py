"""Tests for RetrievalTuningLoop — the first concrete QualityLoop."""
from __future__ import annotations

from app.quality_loop.base import SenseReading
from app.quality_loop.loops.retrieval_tuning import (
    propose_step,
)


def test_propose_step_top_k_up_when_relevance_low():
    """Low memory_relevance suggests trying a higher top_k."""
    current = {"top_k": 5, "threshold": 0.5, "spread_weight": 0.4}
    reading = SenseReading(
        composite=60.0,
        dimensions={"memory_relevance": 0.4, "memory_usage": 0.5},
        sample_size=7, snapshot_id="A",
    )
    proposal = propose_step(current, reading)
    assert proposal is not None
    assert "retrieval.top_k" in proposal.changes
    assert proposal.changes["retrieval.top_k"]["to"] == 7


def test_propose_step_no_change_when_at_target():
    """High memory_relevance + memory_usage = no change."""
    current = {"top_k": 5, "threshold": 0.5, "spread_weight": 0.4}
    reading = SenseReading(
        composite=85.0,
        dimensions={"memory_relevance": 0.85, "memory_usage": 0.8},
        sample_size=7, snapshot_id="A",
    )
    proposal = propose_step(current, reading)
    assert proposal is None


def test_propose_step_clamps_to_bounds():
    """Top_k near upper bound doesn't exceed it."""
    current = {"top_k": 14, "threshold": 0.5, "spread_weight": 0.4}
    reading = SenseReading(
        composite=60.0,
        dimensions={"memory_relevance": 0.4, "memory_usage": 0.5},
        sample_size=7, snapshot_id="A",
    )
    proposal = propose_step(current, reading)
    if proposal and "retrieval.top_k" in proposal.changes:
        assert proposal.changes["retrieval.top_k"]["to"] <= 15
