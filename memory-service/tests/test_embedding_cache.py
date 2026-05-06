"""Tests for batch embedding cache hit/miss/write-through."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

from .conftest_legacy import (  # noqa: F401  (fixtures used as args)
    mock_redis,
    mock_session,
)

FAKE_EMBEDDING = [0.1, 0.2, 0.3]
FAKE_EMBEDDING_2 = [0.4, 0.5, 0.6]


async def test_batch_all_cached_in_redis(mock_redis, mock_session):
    """When all texts are cached in Redis, no gateway call is made."""
    mock_redis.get = AsyncMock(return_value=json.dumps(FAKE_EMBEDDING).encode())

    with (
        patch("app.embedding.get_redis", return_value=mock_redis),
        patch("app.embedding.settings") as mock_settings,
    ):
        mock_settings.embedding_model = "test-model"
        mock_settings.llm_gateway_url = "http://fake:8001"
        mock_settings.redis_embedding_cache_ttl = 86400

        from app.embedding import get_embeddings_batch

        result = await get_embeddings_batch(["hello", "world"], mock_session)

    assert len(result) == 2
    assert result[0] == FAKE_EMBEDDING
    assert result[1] == FAKE_EMBEDDING


async def test_batch_miss_calls_gateway(mock_redis, mock_session):
    """Cache miss triggers gateway call and writes through to both caches."""
    mock_redis.get = AsyncMock(return_value=None)

    # Mock PostgreSQL cache miss
    mock_result = MagicMock()
    mock_result.fetchone.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)

    # Mock httpx response
    mock_httpx_resp = AsyncMock()
    mock_httpx_resp.json.return_value = {
        "embeddings": [FAKE_EMBEDDING, FAKE_EMBEDDING_2]
    }
    mock_httpx_resp.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_httpx_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with (
        patch("app.embedding.get_redis", return_value=mock_redis),
        patch("app.embedding.httpx.AsyncClient", return_value=mock_client),
        patch("app.embedding.settings") as mock_settings,
    ):
        mock_settings.embedding_model = "test-model"
        mock_settings.llm_gateway_url = "http://fake:8001"
        mock_settings.redis_embedding_cache_ttl = 86400

        from app.embedding import get_embeddings_batch

        result = await get_embeddings_batch(["hello", "world"], mock_session)

    assert result == [FAKE_EMBEDDING, FAKE_EMBEDDING_2]
    # Verify write-through to Redis (setex called for each miss)
    assert mock_redis.setex.call_count == 2


async def test_batch_partial_cache_hit(mock_redis, mock_session):
    """Mixed hits/misses: only misses go to gateway."""
    # First text cached, second not
    call_count = 0

    async def redis_get(key):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return json.dumps(FAKE_EMBEDDING).encode()
        return None

    mock_redis.get = redis_get

    # Mock PostgreSQL cache miss for second text
    mock_result = MagicMock()
    mock_result.fetchone.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)

    # Mock httpx — should only be called with 1 text (the miss)
    mock_httpx_resp = AsyncMock()
    mock_httpx_resp.json.return_value = {"embeddings": [FAKE_EMBEDDING_2]}
    mock_httpx_resp.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_httpx_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with (
        patch("app.embedding.get_redis", return_value=mock_redis),
        patch("app.embedding.httpx.AsyncClient", return_value=mock_client),
        patch("app.embedding.settings") as mock_settings,
    ):
        mock_settings.embedding_model = "test-model"
        mock_settings.llm_gateway_url = "http://fake:8001"
        mock_settings.redis_embedding_cache_ttl = 86400

        from app.embedding import get_embeddings_batch

        result = await get_embeddings_batch(["hello", "world"], mock_session)

    assert result[0] == FAKE_EMBEDDING  # from cache
    assert result[1] == FAKE_EMBEDDING_2  # from gateway
    # Gateway called with only 1 text
    mock_client.post.assert_called_once()
    call_args = mock_client.post.call_args
    assert len(call_args[1]["json"]["texts"]) == 1
