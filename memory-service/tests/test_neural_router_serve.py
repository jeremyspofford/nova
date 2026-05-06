"""Unit tests for memory-service/app/engram/neural_router/serve.py.

Strategy
--------
* Module-level cache variables (_cached_model, _cached_arch, etc.) are reset
  between tests via monkeypatch so tests are fully independent.
* ScalarReranker is used as the stub model -- it's a real PyTorch module with
  the right interface, avoiding MagicMock's silent attribute creation.
* Settings are patched on the `serve` module's `settings` reference so we
  don't need to rebuild the Settings object.
* No DB or Redis required -- all tests are pure-Python unit tests.
"""

from __future__ import annotations

import pytest
from app.engram.neural_router import RERANK_EXCLUDED_TYPES, serve
from app.engram.neural_router.model import ScalarReranker

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _reset_cache(monkeypatch):
    """Reset all four module-level cache variables to their initial state."""
    monkeypatch.setattr(serve, "_cached_model", None)
    monkeypatch.setattr(serve, "_cached_arch", None)
    monkeypatch.setattr(serve, "_cached_trained_at", None)
    monkeypatch.setattr(serve, "_cached_tenant_id", None)


def _minimal_candidate(
    engram_type: str = "fact", cosine_similarity: float = 0.8
) -> dict:
    """Return a minimal valid candidate dict for neural_rerank."""
    return {
        "cosine_similarity": cosine_similarity,
        "importance": 0.7,
        "activation": 0.5,
        "last_accessed": None,
        "type": engram_type,
        "convergence_paths": 1,
        "outcome_avg": 0.6,
        "outcome_count": 3,
    }


def _make_scalar_model() -> ScalarReranker:
    """Return a freshly initialised ScalarReranker in eval mode."""
    model = ScalarReranker()
    model.eval()
    return model


# ---------------------------------------------------------------------------
# Model cache -- get_cached_model
# ---------------------------------------------------------------------------


def test_get_cached_model_returns_none_when_unloaded(monkeypatch):
    """Before any model is loaded the cache holds (None, None)."""
    _reset_cache(monkeypatch)
    model, arch = serve.get_cached_model()
    assert model is None
    assert arch is None


def test_get_cached_model_returns_model_and_arch_after_injection(monkeypatch):
    """After the cache variables are set, get_cached_model echoes them back."""
    _reset_cache(monkeypatch)
    stub = _make_scalar_model()
    monkeypatch.setattr(serve, "_cached_model", stub)
    monkeypatch.setattr(serve, "_cached_arch", "scalar")

    model, arch = serve.get_cached_model()
    assert model is stub
    assert arch == "scalar"


def test_get_cached_model_returns_none_after_explicit_clear(monkeypatch):
    """Clearing the cache mid-test reflects immediately in get_cached_model."""
    stub = _make_scalar_model()
    monkeypatch.setattr(serve, "_cached_model", stub)
    monkeypatch.setattr(serve, "_cached_arch", "scalar")

    # Confirm it's populated, then clear
    model_before, _ = serve.get_cached_model()
    assert model_before is stub

    monkeypatch.setattr(serve, "_cached_model", None)
    monkeypatch.setattr(serve, "_cached_arch", None)

    model_after, arch_after = serve.get_cached_model()
    assert model_after is None
    assert arch_after is None


# ---------------------------------------------------------------------------
# load_latest_model -- skip when row is older than cached trained_at
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_load_latest_model_skips_when_row_not_newer(monkeypatch):
    """load_latest_model returns False and leaves the cache untouched when the
    DB row's trained_at is older than (or equal to) the cached model's
    trained_at.
    """
    from datetime import datetime, timezone

    cached_time = datetime(2025, 1, 2, tzinfo=timezone.utc)
    older_time = datetime(2025, 1, 1, tzinfo=timezone.utc)

    stub = _make_scalar_model()
    monkeypatch.setattr(serve, "_cached_model", stub)
    monkeypatch.setattr(serve, "_cached_arch", "scalar")
    monkeypatch.setattr(serve, "_cached_trained_at", cached_time)
    monkeypatch.setattr(
        serve, "_cached_tenant_id", "00000000-0000-0000-0000-000000000001"
    )

    class _FakeRow:
        architecture = "scalar"
        trained_at = older_time
        # weights never read in the skip path, but defined for completeness
        weights = b""

    class _FakeResult:
        def fetchone(self):
            return _FakeRow()

    class _FakeSession:
        async def execute(self, *args, **kwargs):
            return _FakeResult()

    result = await serve.load_latest_model(
        _FakeSession(), tenant_id="00000000-0000-0000-0000-000000000001"
    )
    assert result is False
    # Cache should not have changed
    assert serve._cached_model is stub


# ---------------------------------------------------------------------------
# neural_rerank -- disabled via settings
# ---------------------------------------------------------------------------


def test_neural_rerank_returns_unchanged_when_disabled(monkeypatch):
    """When neural_router_enabled is False, neural_rerank returns the first
    max_results candidates without touching the model."""
    _reset_cache(monkeypatch)

    class _FakeSettings:
        neural_router_enabled = False

    monkeypatch.setattr(serve, "settings", _FakeSettings())

    candidates = [_minimal_candidate(cosine_similarity=float(i) / 10) for i in range(5)]
    result = serve.neural_rerank(candidates, max_results=3)

    # Returns a slice, not reranked
    assert result == candidates[:3]


# ---------------------------------------------------------------------------
# neural_rerank -- no model loaded
# ---------------------------------------------------------------------------


def test_neural_rerank_returns_unchanged_when_no_model(monkeypatch):
    """When no model is cached, neural_rerank returns candidates[:max_results]
    in original order without raising."""
    _reset_cache(monkeypatch)

    class _FakeSettings:
        neural_router_enabled = True

    monkeypatch.setattr(serve, "settings", _FakeSettings())

    candidates = [_minimal_candidate(cosine_similarity=0.9 - i * 0.1) for i in range(4)]
    result = serve.neural_rerank(candidates, max_results=2)

    assert result == candidates[:2]


# ---------------------------------------------------------------------------
# neural_rerank -- model loaded, scalar arch
# ---------------------------------------------------------------------------


def test_neural_rerank_reorders_candidates_with_scalar_model(monkeypatch):
    """With a real ScalarReranker loaded, neural_rerank re-ranks and returns
    at most max_results candidates."""
    _reset_cache(monkeypatch)
    stub = _make_scalar_model()
    monkeypatch.setattr(serve, "_cached_model", stub)
    monkeypatch.setattr(serve, "_cached_arch", "scalar")

    class _FakeSettings:
        neural_router_enabled = True

    monkeypatch.setattr(serve, "settings", _FakeSettings())

    candidates = [_minimal_candidate(cosine_similarity=0.5 + i * 0.1) for i in range(5)]
    result = serve.neural_rerank(candidates, max_results=3)

    assert len(result) == 3
    # All returned items are from the original candidate list
    for item in result:
        assert item in candidates


# ---------------------------------------------------------------------------
# neural_rerank -- empty candidate list
# ---------------------------------------------------------------------------


def test_neural_rerank_handles_empty_candidates(monkeypatch):
    """Passing an empty candidate list returns an empty list (no crash)."""
    _reset_cache(monkeypatch)
    stub = _make_scalar_model()
    monkeypatch.setattr(serve, "_cached_model", stub)
    monkeypatch.setattr(serve, "_cached_arch", "scalar")

    class _FakeSettings:
        neural_router_enabled = True

    monkeypatch.setattr(serve, "settings", _FakeSettings())

    result = serve.neural_rerank([], max_results=10)
    assert result == []


# ---------------------------------------------------------------------------
# RERANK_EXCLUDED_TYPES -- topic is defined as excluded
# ---------------------------------------------------------------------------


def test_topic_type_is_in_rerank_excluded_types():
    """The RERANK_EXCLUDED_TYPES constant must include 'topic'.

    This is a contract test: callers upstream are expected to filter topic
    engrams before passing candidates to neural_rerank. The constant being
    present and correct is what allows that contract to hold.

    NOTE: neural_rerank itself does NOT currently filter by type -- exclusion
    is the caller's responsibility. If that design changes, this test should
    be updated to verify serve-level filtering instead.
    """
    assert "topic" in RERANK_EXCLUDED_TYPES
