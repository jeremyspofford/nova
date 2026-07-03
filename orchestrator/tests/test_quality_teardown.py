"""Tests for benchmark memory teardown."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from app.quality_loop.teardown import teardown_benchmark_memories


@pytest.mark.asyncio
async def test_teardown_calls_delete_for_each_memory():
    """teardown iterates the memory_ids list and DELETEs each."""
    mock_client = AsyncMock()
    mock_response = MagicMock(status_code=204)
    mock_client.delete = AsyncMock(return_value=mock_response)

    with patch("app.quality_loop.teardown.httpx.AsyncClient") as mock_ctx:
        mock_ctx.return_value.__aenter__.return_value = mock_client
        deleted = await teardown_benchmark_memories(["id1", "id2", "id3"])

    assert deleted == 3
    assert mock_client.delete.call_count == 3


@pytest.mark.asyncio
async def test_teardown_continues_on_individual_failures():
    """One failed delete doesn't abort the whole teardown."""
    mock_client = AsyncMock()
    mock_client.delete = AsyncMock(side_effect=[
        MagicMock(status_code=204),
        MagicMock(status_code=500),
        MagicMock(status_code=204),
    ])

    with patch("app.quality_loop.teardown.httpx.AsyncClient") as mock_ctx:
        mock_ctx.return_value.__aenter__.return_value = mock_client
        deleted = await teardown_benchmark_memories(["a", "b", "c"])

    assert deleted == 2
