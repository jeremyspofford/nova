"""Tests for AQ-002: symmetric negative activation in outcome feedback.

The audit found that process_feedback only reinforced positive-outcome engrams
while never penalizing bad ones. This file locks in the symmetric behavior:
negative scores decrease activation the same way positive scores increase it,
and negative co-retrievals weaken edges (mirroring the positive Hebbian path).

Tests mock the SQLAlchemy session at the .execute() boundary and verify the
shape of each query + parameter set. No real database is required.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from app.engram.outcome_feedback import (
    ACTIVATION_BOOST,
    EDGE_WEIGHT_BOOST,
    EDGE_WEIGHT_FLOOR,
    IMPORTANCE_FLOOR,
    NEGATIVE_THRESHOLD,
    POSITIVE_THRESHOLD,
    process_feedback,
)

from .conftest_legacy import mock_session  # noqa: F401  (fixture used as arg)

EID_A = "11111111-1111-1111-1111-111111111111"
EID_B = "22222222-2222-2222-2222-222222222222"


def _fresh_session():
    """Build a mock session with fetchone() → None (no recalibration, no edges to update)."""
    session = AsyncMock()
    # Default: any SELECT returns None (so recalibration won't fire in most tests),
    # any UPDATE ... RETURNING also returns None (so edge-insert branch is taken).
    result = MagicMock()
    result.fetchone.return_value = None
    session.execute = AsyncMock(return_value=result)
    session.commit = AsyncMock()
    return session


def _executed_sql_snippets(session: AsyncMock) -> list[str]:
    """Return the SQL text for every execute call on the session."""
    return [str(call.args[0]) for call in session.execute.call_args_list]


def _executed_params(session: AsyncMock) -> list[dict]:
    """Return the parameter dict for every execute call on the session."""
    return [
        call.args[1] for call in session.execute.call_args_list if len(call.args) > 1
    ]


# ── Activation symmetry ─────────────────────────────────────────────────────


async def test_positive_outcome_increases_activation():
    """Existing behavior: score > POSITIVE_THRESHOLD triggers the boost UPDATE."""
    session = _fresh_session()
    stats = await process_feedback(
        session,
        [{"engram_id": EID_A, "outcome_score": 0.9, "task_type": "chat"}],
    )
    assert stats["activations"] == 1
    assert stats["deactivations"] == 0
    # Verify an UPDATE with the positive boost formula was issued.
    sqls = _executed_sql_snippets(session)
    assert any("activation + :boost * (1.0 - activation)" in s for s in sqls)


async def test_negative_outcome_decreases_activation():
    """AQ-002: score < NEGATIVE_THRESHOLD triggers the symmetric decay UPDATE."""
    session = _fresh_session()
    stats = await process_feedback(
        session,
        [{"engram_id": EID_A, "outcome_score": 0.2, "task_type": "chat"}],
    )
    assert stats["activations"] == 0
    assert stats["deactivations"] == 1
    sqls = _executed_sql_snippets(session)
    assert any("activation - :boost * activation" in s for s in sqls)
    # Verify the floor parameter matches IMPORTANCE_FLOOR (symmetric to the ceiling of 1.0).
    params = _executed_params(session)
    decay_params = [
        p for p in params if p.get("boost") == ACTIVATION_BOOST and "floor" in p
    ]
    assert decay_params, "expected at least one decay UPDATE with a floor param"
    assert decay_params[0]["floor"] == IMPORTANCE_FLOOR


async def test_neutral_outcome_leaves_activation_alone():
    """Scores in the neutral band (NEGATIVE_THRESHOLD..POSITIVE_THRESHOLD) trigger neither branch."""
    session = _fresh_session()
    stats = await process_feedback(
        session,
        [{"engram_id": EID_A, "outcome_score": 0.55, "task_type": "chat"}],
    )
    assert stats["activations"] == 0
    assert stats["deactivations"] == 0
    sqls = _executed_sql_snippets(session)
    # An outcome_avg UPDATE still fires (tracking), but no activation ± UPDATE.
    assert not any("activation + :boost" in s for s in sqls)
    assert not any("activation - :boost" in s for s in sqls)


async def test_positive_and_negative_magnitudes_are_symmetric():
    """The ACTIVATION_BOOST constant is reused for both directions so the magnitudes match."""
    session_pos = _fresh_session()
    session_neg = _fresh_session()

    await process_feedback(
        session_pos, [{"engram_id": EID_A, "outcome_score": 0.9, "task_type": "chat"}]
    )
    await process_feedback(
        session_neg, [{"engram_id": EID_A, "outcome_score": 0.1, "task_type": "chat"}]
    )

    pos_params = _executed_params(session_pos)
    neg_params = _executed_params(session_neg)
    pos_boost_params = [
        p for p in pos_params if p.get("boost") == ACTIVATION_BOOST and "floor" not in p
    ]
    neg_boost_params = [
        p for p in neg_params if p.get("boost") == ACTIVATION_BOOST and "floor" in p
    ]
    # Both directions hit the UPDATE once and use the same boost constant.
    assert len(pos_boost_params) == 1
    assert len(neg_boost_params) == 1
    assert pos_boost_params[0]["boost"] == neg_boost_params[0]["boost"]


# ── Threshold boundary ──────────────────────────────────────────────────────


async def test_exactly_positive_threshold_is_not_a_boost():
    """The positive branch is strict > POSITIVE_THRESHOLD, not >=."""
    session = _fresh_session()
    stats = await process_feedback(
        session,
        [
            {
                "engram_id": EID_A,
                "outcome_score": POSITIVE_THRESHOLD,
                "task_type": "chat",
            }
        ],
    )
    assert stats["activations"] == 0


async def test_exactly_negative_threshold_is_not_a_decay():
    """The negative branch is strict < NEGATIVE_THRESHOLD, not <=."""
    session = _fresh_session()
    stats = await process_feedback(
        session,
        [
            {
                "engram_id": EID_A,
                "outcome_score": NEGATIVE_THRESHOLD,
                "task_type": "chat",
            }
        ],
    )
    assert stats["deactivations"] == 0


# ── Edge weight symmetry ────────────────────────────────────────────────────


async def test_negative_co_retrieval_weakens_existing_edges():
    """Negative-outcome interactions weaken edges between co-retrieved engrams."""
    session = _fresh_session()
    stats = await process_feedback(
        session,
        [
            {"engram_id": EID_A, "outcome_score": 0.1, "task_type": "chat"},
            {"engram_id": EID_B, "outcome_score": 0.1, "task_type": "chat"},
        ],
    )
    # Both engrams should have their activation decayed.
    assert stats["deactivations"] == 2
    # One edge pair (A,B) weakened.
    assert stats["edges_weakened"] == 1
    assert stats["edges"] == 0  # no edge strengthening on negative
    sqls = _executed_sql_snippets(session)
    assert any("weight = GREATEST(:floor, weight - :boost)" in s for s in sqls)


async def test_negative_co_retrieval_does_not_insert_new_edges():
    """Weakening applies to existing edges only — we don't invent new `related_to`
    rows out of bad-outcome co-occurrences (that would actually strengthen them)."""
    session = _fresh_session()
    await process_feedback(
        session,
        [
            {"engram_id": EID_A, "outcome_score": 0.1, "task_type": "chat"},
            {"engram_id": EID_B, "outcome_score": 0.1, "task_type": "chat"},
        ],
    )
    sqls = _executed_sql_snippets(session)
    assert not any("INSERT INTO engram_edges" in s for s in sqls)


async def test_positive_co_retrieval_still_strengthens_edges():
    """Regression: positive Hebbian path is unchanged by AQ-002."""
    session = _fresh_session()
    stats = await process_feedback(
        session,
        [
            {"engram_id": EID_A, "outcome_score": 0.9, "task_type": "chat"},
            {"engram_id": EID_B, "outcome_score": 0.9, "task_type": "chat"},
        ],
    )
    assert stats["edges"] == 1
    assert stats["edges_weakened"] == 0


async def test_edge_floor_is_respected_in_weakening_update():
    """The weakening UPDATE parameters carry EDGE_WEIGHT_FLOOR as the floor."""
    session = _fresh_session()
    await process_feedback(
        session,
        [
            {"engram_id": EID_A, "outcome_score": 0.1, "task_type": "chat"},
            {"engram_id": EID_B, "outcome_score": 0.1, "task_type": "chat"},
        ],
    )
    params = _executed_params(session)
    weakening_params = [
        p for p in params if "floor" in p and p.get("boost") == EDGE_WEIGHT_BOOST
    ]
    assert weakening_params, "expected at least one edge-weakening UPDATE"
    assert weakening_params[0]["floor"] == EDGE_WEIGHT_FLOOR
