"""Engram queue helper — delegates to nova-worker-common."""
import logging
from urllib.parse import urlparse, urlunparse

import redis.asyncio as aioredis
from nova_worker_common.queue import (
    close_redis_client,
    create_redis_client,
)
from nova_worker_common.queue import (
    push_to_memory_queue as _push_memory,
)

from app.config import settings

log = logging.getLogger(__name__)

_redis_engram: aioredis.Redis | None = None  # db0


async def init_queues() -> None:
    global _redis_engram
    parsed = urlparse(settings.redis_url)
    engram_url = urlunparse(parsed._replace(path="/0"))
    _redis_engram = await create_redis_client(engram_url)
    log.info("Redis queue initialized (engram=db0)")


async def push_to_memory_queue(item: dict) -> None:
    """Push content to memory-service's engram ingestion queue."""
    await _push_memory(
        _redis_engram,
        raw_text=f"{item.get('title', '')}\n\n{item.get('body', '')}",
        source_type="intel",
        metadata={
            "feed_name": item.get("feed_name", ""),
            "url": item.get("url", ""),
            "content_item_id": item.get("id", ""),
        },
    )


async def close_queues() -> None:
    global _redis_engram
    if _redis_engram:
        await close_redis_client(_redis_engram)
        _redis_engram = None
