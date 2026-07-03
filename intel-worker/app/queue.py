"""Memory ingestion queue helper — delegates to nova-worker-common."""
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

_redis_memory: aioredis.Redis | None = None  # db0


async def init_queues() -> None:
    global _redis_memory
    parsed = urlparse(settings.redis_url)
    memory_url = urlunparse(parsed._replace(path="/0"))
    _redis_memory = await create_redis_client(memory_url)
    log.info("Redis queue initialized (memory=db0)")


async def push_to_memory_queue(item: dict) -> None:
    """Push content to memory-service's ingestion queue."""
    await _push_memory(
        _redis_memory,
        raw_text=f"{item.get('title', '')}\n\n{item.get('body', '')}",
        source_type="intel",
        metadata={
            "feed_name": item.get("feed_name", ""),
            "url": item.get("url", ""),
            "content_item_id": item.get("id", ""),
        },
    )


async def close_queues() -> None:
    global _redis_memory
    if _redis_memory:
        await close_redis_client(_redis_memory)
        _redis_memory = None
