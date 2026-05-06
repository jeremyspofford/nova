"""Tests for the loop runner — focuses on lifecycle dispatch given each agency mode."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from app.quality_loop.base import (
    AppliedChange,
    Decision,
    Proposal,
    SenseReading,
    Verification,
)
from app.quality_loop.runner import iterate_loop


def _mock_loop(agency: str):
    loop = MagicMock()
    loop.name = "mock"
    loop.watches = ["memory_relevance"]
    loop.agency = agency
    loop.snapshot = AsyncMock(return_value="snap-1")
    loop.sense = AsyncMock(return_value=SenseReading(
        composite=70.0, dimensions={"memory_relevance": 0.7},
        sample_size=7, snapshot_id="snap-1",
    ))
    loop.propose = AsyncMock(return_value=Proposal(
        description="test", changes={"retrieval.top_k": {"from": 5, "to": 7}},
        rationale="test",
    ))
    loop.apply = AsyncMock(return_value=AppliedChange(
        proposal=loop.propose.return_value, applied_at="now",
        revert_actions=[],
    ))
    loop.verify = AsyncMock(return_value=Verification(
        baseline=loop.sense.return_value, after=loop.sense.return_value,
        delta={"composite": 3.0}, significant=True,
    ))
    loop.decide = AsyncMock(return_value=Decision(
        outcome="improved", action="persist", confidence=0.8,
    ))
    loop.revert = AsyncMock()
    return loop


@pytest.mark.asyncio
async def test_alert_only_skips_apply():
    loop = _mock_loop("alert_only")
    with patch("app.quality_loop.runner.get_redis") as mock_redis_fn, \
         patch("app.quality_loop.runner._persist_session", new_callable=AsyncMock) as mock_persist:
        mock_redis = AsyncMock()
        mock_redis.set = AsyncMock(return_value=True)
        mock_redis.delete = AsyncMock()
        mock_redis_fn.return_value = mock_redis
        mock_persist.return_value = "session-id"
        await iterate_loop(loop)
    assert loop.apply.call_count == 0
    assert loop.verify.call_count == 0


@pytest.mark.asyncio
async def test_auto_apply_runs_full_lifecycle():
    loop = _mock_loop("auto_apply")
    with patch("app.quality_loop.runner.get_redis") as mock_redis_fn, \
         patch("app.quality_loop.runner._persist_session", new_callable=AsyncMock) as mock_persist:
        mock_redis = AsyncMock()
        mock_redis.set = AsyncMock(return_value=True)
        mock_redis.delete = AsyncMock()
        mock_redis_fn.return_value = mock_redis
        mock_persist.return_value = "session-id"
        await iterate_loop(loop)
    assert loop.apply.call_count == 1
    assert loop.verify.call_count == 1
    assert loop.decide.call_count == 1


@pytest.mark.asyncio
async def test_propose_for_approval_pauses_after_persist():
    loop = _mock_loop("propose_for_approval")
    with patch("app.quality_loop.runner.get_redis") as mock_redis_fn, \
         patch("app.quality_loop.runner._persist_session", new_callable=AsyncMock) as mock_persist:
        mock_redis = AsyncMock()
        mock_redis.set = AsyncMock(return_value=True)
        mock_redis.delete = AsyncMock()
        mock_redis_fn.return_value = mock_redis
        mock_persist.return_value = "session-id"
        result = await iterate_loop(loop)
    assert loop.apply.call_count == 0
    assert result["decision"] == "pending_approval"
