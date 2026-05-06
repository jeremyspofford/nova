"""Tests for quality_scorer.py — live (chat) dimension scorers."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from app.quality_scorer import score_safety_compliance


def _make_pool(fetchval_return):
    """Return a (pool, conn) pair that mimics asyncpg pool.acquire() ctx manager."""
    conn = AsyncMock()
    conn.fetchval = AsyncMock(return_value=fetchval_return)
    pool = MagicMock()
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    return pool, conn


@pytest.mark.asyncio
async def test_safety_compliance_no_findings():
    pool, _ = _make_pool(fetchval_return=0)

    result = await score_safety_compliance(task_id="some-uuid", pool=pool)
    assert result is not None
    assert result["dimension"] == "safety_compliance"
    assert result["score"] == 1.0


@pytest.mark.asyncio
async def test_safety_compliance_with_findings():
    pool, _ = _make_pool(fetchval_return=3)

    result = await score_safety_compliance(task_id="some-uuid", pool=pool)
    assert 0.0 <= result["score"] < 1.0
    assert result["metadata"]["finding_count"] == 3
