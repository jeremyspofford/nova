"""Tests for batch embedding cache hit/miss/write-through.

Migrated from mock-session/mock-redis pattern to real fixtures (MEM-001 Task 5.7).
We monkeypatch get_http_client() (the singleton injected in Sprint P3) rather
than the removed httpx.AsyncClient import.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

# embedding_cache schema requires halfvec(768) — use full-dimension vectors
FAKE_EMBEDDING = [0.1] * 768
FAKE_EMBEDDING_2 = [0.4] * 768


def _make_http_response(embeddings: list) -> MagicMock:
    """Build a fake httpx Response-like object."""
    resp = MagicMock()
    resp.json.return_value = {"embeddings": embeddings}
    resp.raise_for_status = MagicMock()
    return resp


@pytest.mark.asyncio
async def test_batch_all_cached_in_redis(db_session, redis_test, monkeypatch):
    """When all texts are cached in Redis, no gateway call is made."""
    from app import embedding as emb_mod

    # Pre-populate redis_test (db15) with fake embeddings for both texts
    for t in ["hello", "world"]:
        h = emb_mod._hash_text(t, "nomic-embed-text")
        key = emb_mod._cache_key(h)
        await redis_test.set(key, json.dumps(FAKE_EMBEDDING).encode())

    # Point the module at the test Redis instance
    monkeypatch.setattr(emb_mod, "get_redis", lambda: redis_test)

    result = await emb_mod.get_embeddings_batch(["hello", "world"], db_session)

    assert len(result) == 2
    assert result[0] == FAKE_EMBEDDING
    assert result[1] == FAKE_EMBEDDING


@pytest.mark.asyncio
async def test_batch_miss_calls_gateway(db_session, redis_test, monkeypatch):
    """Cache miss triggers gateway call and writes through to both caches."""
    from app import embedding as emb_mod

    # No cache entries — all misses
    monkeypatch.setattr(emb_mod, "get_redis", lambda: redis_test)

    # Mock the HTTP client post
    mock_resp = _make_http_response([FAKE_EMBEDDING, FAKE_EMBEDDING_2])
    mock_client = MagicMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    monkeypatch.setattr(emb_mod, "get_http_client", lambda: mock_client)

    result = await emb_mod.get_embeddings_batch(["hello", "world"], db_session)

    assert result == [FAKE_EMBEDDING, FAKE_EMBEDDING_2]
    # Verify write-through to Redis (setex called for each miss)
    for t in ["hello", "world"]:
        h = emb_mod._hash_text(t, "nomic-embed-text")
        key = emb_mod._cache_key(h)
        cached = await redis_test.get(key)
        assert cached is not None, f"Expected Redis write-through for '{t}'"


@pytest.mark.asyncio
async def test_batch_partial_cache_hit(db_session, redis_test, monkeypatch):
    """Mixed hits/misses: only misses go to gateway."""
    from app import embedding as emb_mod

    # Pre-populate only "hello"
    h = emb_mod._hash_text("hello", "nomic-embed-text")
    await redis_test.set(emb_mod._cache_key(h), json.dumps(FAKE_EMBEDDING).encode())

    monkeypatch.setattr(emb_mod, "get_redis", lambda: redis_test)

    # Mock gateway — should only be called with "world" (1 text)
    mock_resp = _make_http_response([FAKE_EMBEDDING_2])
    mock_client = MagicMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    monkeypatch.setattr(emb_mod, "get_http_client", lambda: mock_client)

    result = await emb_mod.get_embeddings_batch(["hello", "world"], db_session)

    assert result[0] == FAKE_EMBEDDING  # from cache
    assert result[1] == FAKE_EMBEDDING_2  # from gateway
    # Gateway called with only 1 text (the miss)
    mock_client.post.assert_called_once()
    call_kwargs = mock_client.post.call_args[1]
    assert len(call_kwargs["json"]["texts"]) == 1
