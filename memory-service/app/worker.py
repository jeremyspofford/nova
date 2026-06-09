# memory-service/app/worker.py
import asyncio
import json
import logging

import httpx
import redis.asyncio as aioredis

from .config import settings
from .db import get_pool
from . import embed, store

logger = logging.getLogger(__name__)

MAX_FAILURES = 5
_failure_counts: dict[str, int] = {}

_http: httpx.AsyncClient | None = None


def _get_http_client() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=30.0)
    return _http


async def close_http() -> None:
    global _http
    if _http:
        await _http.aclose()
        _http = None


async def _get_tags(content: str) -> list[str]:
    try:
        client = _get_http_client()
        r = await client.post(
            f"{settings.llm_gateway_url}/complete",
            json={
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are classifying a memory fragment for a personal AI assistant. "
                            "Output 3-8 short lowercase tags (underscore_separated, no spaces). "
                            "Capture topics, entities, intent, and temporal context. "
                            "Reply with a JSON array of strings only."
                        ),
                    },
                    {"role": "user", "content": content[:2000]},
                ],
                "model": "auto",
                "max_tokens": 100,
            },
        )
        r.raise_for_status()
        raw = r.json().get("content", "[]").strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        return json.loads(raw)
    except Exception as exc:
        logger.warning("Tag generation failed: %s", exc)
        return []


async def _process(memory_id: str) -> None:
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT content FROM memories WHERE id = $1::uuid AND embedding IS NULL",
        memory_id,
    )
    if not row:
        return

    content = row["content"]
    embedding = await embed.embed_text(content)

    if embedding is None:
        count = _failure_counts.get(memory_id, 0) + 1
        _failure_counts[memory_id] = count
        if count >= MAX_FAILURES:
            logger.warning(
                "Memory %s failed embedding %d times — leaving unembedded (keyword fallback active)",
                memory_id, count,
            )
            _failure_counts.pop(memory_id, None)
        return

    tags = await _get_tags(content)
    await store.update_embedding_and_tags(pool, memory_id, embedding, tags)
    _failure_counts.pop(memory_id, None)
    logger.debug("Embedded memory %s, tags=%s", memory_id, tags)


async def embed_worker() -> None:
    r = aioredis.from_url(settings.redis_url, decode_responses=True)
    logger.info("Embed worker running")
    try:
        while True:
            try:
                result = await r.blpop("memory:embed:queue", timeout=0.5)
                if result:
                    _, memory_id = result
                    await _process(memory_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Worker iteration error: %s", exc)
                await asyncio.sleep(1)
    except asyncio.CancelledError:
        logger.info("Embed worker shutting down")
    finally:
        await r.aclose()


async def extract_worker() -> None:
    """Drain memory:extract:queue — each job is a JSON exchange payload that
    extraction distills into structured memories (or stores verbatim on LLM
    failure — never drops)."""
    from . import extraction

    r = aioredis.from_url(settings.redis_url, decode_responses=True)
    logger.info("Extract worker running")
    try:
        while True:
            try:
                result = await r.blpop("memory:extract:queue", timeout=0.5)
                if result:
                    _, raw = result
                    try:
                        payload = json.loads(raw)
                    except json.JSONDecodeError:
                        logger.warning("Dropping malformed extract job: %.100s", raw)
                        continue
                    pool = await get_pool()
                    await extraction.process_exchange(pool, r, payload)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Extract worker iteration error: %s", exc)
                await asyncio.sleep(1)
    except asyncio.CancelledError:
        logger.info("Extract worker shutting down")
    finally:
        await r.aclose()


async def recover_unembedded(pool) -> None:
    ids = await store.get_unembedded_ids(pool, limit=50)
    if not ids:
        return
    r = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        for mid in ids:
            await r.rpush("memory:embed:queue", mid)
        logger.info("Re-queued %d unembedded memories for processing", len(ids))
    finally:
        await r.aclose()
