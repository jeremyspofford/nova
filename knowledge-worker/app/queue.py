"""Dual-Redis queue helpers -- knowledge-worker state (db8) and engram ingestion (db0)."""
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
_redis_engram = None  # db0 — engram ingestion queue


async def init_queues() -> None:
    global _redis_state, _redis_engram
    _redis_state = await create_redis_client(settings.redis_url)
    parsed = urlparse(settings.redis_url)
    engram_url = urlunparse(parsed._replace(path="/0"))
    _redis_engram = await create_redis_client(engram_url)
    log.info("Redis queues initialized (state=db8, engram=db0)")


def get_state_redis():
    if _redis_state is None:
        raise RuntimeError("State Redis client not initialized")
    return _redis_state


def get_engram_redis():
    if _redis_engram is None:
        raise RuntimeError("Engram Redis client not initialized")
    return _redis_engram


async def push_to_engram(
    raw_text: str,
    source_type: str = "knowledge",
    source_id: str | None = None,
    metadata: dict | None = None,
) -> None:
    """Push content to memory-service's engram ingestion queue."""
    await _push_memory(
        _redis_engram,
        raw_text=raw_text,
        source_type=source_type,
        source_id=source_id,
        metadata=metadata,
    )


async def close_queues() -> None:
    global _redis_state, _redis_engram
    if _redis_state:
        await close_redis_client(_redis_state)
        _redis_state = None
    if _redis_engram:
        await close_redis_client(_redis_engram)
        _redis_engram = None
