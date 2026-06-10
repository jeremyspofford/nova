"""
Embedding client — calls LLM Gateway for embeddings, caches in Redis (24h) and PostgreSQL.
Consumers never see vectors; they only pass text in and receive memories out.
"""

from __future__ import annotations

import hashlib
import json
import logging

import redis.asyncio as aioredis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.http_client import get_http_client

log = logging.getLogger(__name__)

_redis: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=False)
    return _redis


async def close_redis() -> None:
    """Close the module-level Redis connection. Call at shutdown."""
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None


def _cache_key(text_hash: str) -> str:
    return f"nova:embed:{text_hash}"


def _hash_text(text: str, model: str) -> str:
    return hashlib.sha256(f"{model}:{text}".encode()).hexdigest()


async def get_embedding(
    content: str,
    session: AsyncSession,
    model: str = settings.embedding_model,
) -> list[float]:
    """
    Get embedding for text. Cache hit order: Redis (1ms) → PostgreSQL → LLM Gateway.
    """
    text_hash = _hash_text(content, model)
    redis_key = _cache_key(text_hash)

    # L1: Redis cache
    redis = get_redis()
    cached = await redis.get(redis_key)
    if cached:
        return json.loads(cached)

    # L2: PostgreSQL embedding cache
    row = await session.execute(
        text(
            "SELECT embedding FROM embedding_cache WHERE content_hash = :h AND model = :m"
        ),
        {"h": text_hash, "m": model},
    )
    db_row = row.fetchone()
    if db_row:
        embedding = _parse_pg_vector(str(db_row[0]))
        await redis.setex(
            redis_key, settings.redis_embedding_cache_ttl, json.dumps(embedding)
        )
        return embedding

    # L3: LLM Gateway
    embedding = await _call_llm_gateway(content, model)

    # Write-through to both caches
    await redis.setex(
        redis_key, settings.redis_embedding_cache_ttl, json.dumps(embedding)
    )
    await session.execute(
        text("""
            INSERT INTO embedding_cache (content_hash, embedding, model)
            VALUES (:h, CAST(:e AS halfvec), :m)
            ON CONFLICT (content_hash) DO NOTHING
        """),
        {"h": text_hash, "e": to_pg_vector(embedding), "m": model},
    )

    return embedding


async def get_embeddings_batch(
    texts: list[str],
    session: AsyncSession,
    model: str = settings.embedding_model,
) -> list[list[float]]:
    """Batch embedding with 3-tier cache (Redis → PostgreSQL → LLM Gateway)."""
    redis = get_redis()
    results: dict[int, list[float]] = {}
    miss_indices: list[int] = []

    # Check L1 (Redis) and L2 (PostgreSQL) for each text
    for i, t in enumerate(texts):
        text_hash = _hash_text(t, model)
        redis_key = _cache_key(text_hash)

        # L1: Redis
        cached = await redis.get(redis_key)
        if cached:
            results[i] = json.loads(cached)
            continue

        # L2: PostgreSQL embedding_cache
        row = await session.execute(
            text(
                "SELECT embedding FROM embedding_cache WHERE content_hash = :h AND model = :m"
            ),
            {"h": text_hash, "m": model},
        )
        db_row = row.fetchone()
        if db_row:
            embedding = _parse_pg_vector(str(db_row[0]))
            await redis.setex(
                redis_key, settings.redis_embedding_cache_ttl, json.dumps(embedding)
            )
            results[i] = embedding
            continue

        miss_indices.append(i)

    # L3: Batch-call gateway for cache misses only (with retry + fallback)
    if miss_indices:
        miss_texts = [texts[i] for i in miss_indices]
        batch_embeddings = await _call_llm_gateway_batch(miss_texts, model)

        for j, idx in enumerate(miss_indices):
            embedding = batch_embeddings[j]
            results[idx] = embedding

            # Write-through to both caches
            t = texts[idx]
            text_hash = _hash_text(t, model)
            redis_key = _cache_key(text_hash)
            await redis.setex(
                redis_key, settings.redis_embedding_cache_ttl, json.dumps(embedding)
            )
            await session.execute(
                text("""
                    INSERT INTO embedding_cache (content_hash, embedding, model)
                    VALUES (:h, CAST(:e AS halfvec), :m)
                    ON CONFLICT (content_hash) DO NOTHING
                """),
                {"h": text_hash, "e": to_pg_vector(embedding), "m": model},
            )

    return [results[i] for i in range(len(texts))]


# Track primary model failures to skip straight to fallback
_primary_failed_until: float = 0.0
_PRIMARY_FAIL_COOLDOWN = 60.0  # seconds before retrying primary model


async def _call_with_retry_fallback(
    payload: dict,
    model: str,
    extract: str,  # "single" → embeddings[0], "batch" → embeddings
) -> list[float] | list[list[float]]:
    """Call LLM gateway /embed with retry + fallback model."""
    import asyncio as _aio
    import time as _time

    global _primary_failed_until

    models_to_try = [model]
    if model != settings.embedding_fallback_model:
        models_to_try.append(settings.embedding_fallback_model)

    # Skip primary model if it recently failed (avoids retry delays)
    if _primary_failed_until > _time.monotonic():
        models_to_try = [m for m in models_to_try if m != model] or models_to_try

    for model_to_try in models_to_try:
        is_fallback = model_to_try != model
        if is_fallback:
            log.info("Using fallback embedding model: %s", model_to_try)
        for attempt in range(settings.embedding_max_retries):
            try:
                client = get_http_client()
                resp = await client.post(
                    f"{settings.llm_gateway_url}/embed",
                    json={"model": model_to_try, **payload},
                    timeout=10.0,
                )
                resp.raise_for_status()
                data = resp.json()
                # Primary model recovered — clear the cooldown
                if not is_fallback:
                    _primary_failed_until = 0.0
                return (
                    data["embeddings"][0] if extract == "single" else data["embeddings"]
                )
            except Exception:
                if attempt < settings.embedding_max_retries - 1:
                    await _aio.sleep(settings.embedding_retry_delay)
                elif not is_fallback:
                    log.warning(
                        "Primary embedding model %s failed after %d retries, cooling down for %ds",
                        model_to_try,
                        settings.embedding_max_retries,
                        int(_PRIMARY_FAIL_COOLDOWN),
                    )
                    _primary_failed_until = _time.monotonic() + _PRIMARY_FAIL_COOLDOWN

    raise RuntimeError(
        f"All embedding attempts failed for model {model} and fallback {settings.embedding_fallback_model}"
    )


async def _call_llm_gateway(input_text: str, model: str) -> list[float]:
    """Single-text embedding with retry + fallback."""
    return await _call_with_retry_fallback({"texts": [input_text]}, model, "single")


async def _call_llm_gateway_batch(texts: list[str], model: str) -> list[list[float]]:
    """Batch embedding with retry + fallback."""
    return await _call_with_retry_fallback({"texts": texts}, model, "batch")


def _parse_pg_vector(vec_str: str) -> list[float]:
    """Parse PostgreSQL vector string '[0.1,0.2,...]' to Python list."""
    return [float(x) for x in vec_str.strip("[]").split(",")]


def to_pg_vector(embedding: list[float]) -> str:
    """Serialize a Python list of floats into a pgvector-compatible string."""
    return "[" + ",".join(str(v) for v in embedding) + "]"
