"""Dual-Redis queue helpers -- knowledge-worker state (db8) and memory ingestion (db0)."""
import logging
from urllib.parse import urlparse, urlunparse

from nova_worker_common.queue import (
    close_redis_client,
    create_redis_client,
)
from nova_worker_common.queue import (
    push_to_memory_queue as _push_memory,
)

from app.config import settings

log = logging.getLogger(__name__)

_redis_state = None   # db8 — knowledge-worker own state
_redis_memory = None  # db0 — memory ingestion queue


async def init_queues() -> None:
    global _redis_state, _redis_memory
    _redis_state = await create_redis_client(settings.redis_url)
    parsed = urlparse(settings.redis_url)
    memory_url = urlunparse(parsed._replace(path="/0"))
    _redis_memory = await create_redis_client(memory_url)
    log.info("Redis queues initialized (state=db8, memory=db0)")


def get_state_redis():
    if _redis_state is None:
        raise RuntimeError("State Redis client not initialized")
    return _redis_state


def get_memory_redis():
    if _redis_memory is None:
        raise RuntimeError("Memory Redis client not initialized")
    return _redis_memory


async def push_to_memory(
    raw_text: str,
    source_type: str = "knowledge",
    source_id: str | None = None,
    metadata: dict | None = None,
) -> None:
    """Push content to memory-service's ingestion queue."""
    await _push_memory(
        _redis_memory,
        raw_text=raw_text,
        source_type=source_type,
        source_id=source_id,
        metadata=metadata,
    )


async def close_queues() -> None:
    global _redis_state, _redis_memory
    if _redis_state:
        await close_redis_client(_redis_state)
        _redis_state = None
    if _redis_memory:
        await close_redis_client(_redis_memory)
        _redis_memory = None
