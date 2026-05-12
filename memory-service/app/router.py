# memory-service/app/router.py
import logging
from typing import Optional

import redis.asyncio as aioredis
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from nova_contracts import MemorySearchRequest

from .config import settings
from .db import get_pool
from . import embed, store

router = APIRouter(prefix="/memories", tags=["memories"])
logger = logging.getLogger(__name__)

_redis: aioredis.Redis | None = None


async def _get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


class MemoryWriteRequest(BaseModel):
    content: str
    source_kind: str
    source_uri: Optional[str] = None


# IMPORTANT: /stats must be defined BEFORE /{memory_id} to avoid "stats" matching as an ID
@router.get("/stats")
async def get_stats():
    pool = await get_pool()
    stats = await store.get_stats(pool)
    return {**stats, "degraded": embed.is_degraded()}


@router.post("", status_code=201)
async def write_memory(body: MemoryWriteRequest):
    pool = await get_pool()
    memory_id = await store.write_memory(pool, body.content, body.source_kind, body.source_uri)
    try:
        r = await _get_redis()
        await r.rpush("memory:embed:queue", memory_id)
    except Exception as exc:
        logger.warning("Failed to queue memory for embedding: %s", exc)
    return {"id": memory_id}


@router.get("/{memory_id}")
async def get_memory(memory_id: str):
    pool = await get_pool()
    row = await store.get_memory(pool, memory_id)
    if not row:
        raise HTTPException(status_code=404, detail="Memory not found")
    return row


@router.delete("/{memory_id}", status_code=204)
async def delete_memory(memory_id: str):
    pool = await get_pool()
    tag = await pool.execute(
        "DELETE FROM memories WHERE id = $1::uuid",
        memory_id,
    )
    if tag == "DELETE 0":
        raise HTTPException(status_code=404, detail="Memory not found")


@router.post("/search")
async def search_memories(body: MemorySearchRequest):
    pool = await get_pool()
    embedding = await embed.embed_text(body.query) if not embed.is_degraded() else None
    results = await store.search_memories(
        pool,
        embedding=embedding,
        query=body.query,
        limit=body.limit,
        source_kinds=body.source_kinds,
        tags=body.tags,
        min_similarity=body.min_similarity,
    )
    return {"results": results, "degraded": embed.is_degraded()}


@router.patch("/{memory_id}/used", status_code=204)
async def mark_used(memory_id: str):
    pool = await get_pool()
    await store.mark_used(pool, memory_id)
