"""Redis queue helpers for Nova worker services."""

#: The memory ingestion queue (db0). All producers push here; the
#: memory-service consumer dispatches payloads to the active backend.
MEMORY_INGESTION_QUEUE = "memory:ingestion:queue"
import json

import redis.asyncio as aioredis


async def create_redis_client(url: str) -> aioredis.Redis:
    """Create an async Redis client from a URL (e.g. ``redis://redis:6379/0``)."""
    return aioredis.from_url(url, decode_responses=True)


async def close_redis_client(client: aioredis.Redis) -> None:
    """Close an async Redis client."""
    await client.aclose()


async def push_to_memory_queue(
    redis_client: aioredis.Redis,
    raw_text: str,
    source_type: str,
    source_id: str | None = None,
    metadata: dict | None = None,
) -> None:
    """JSON-encode and LPUSH a payload to the memory ingestion queue."""
    payload: dict = {
        "raw_text": raw_text,
        "source_type": source_type,
    }
    if source_id is not None:
        payload["source_id"] = source_id
    if metadata is not None:
        payload["metadata"] = metadata
    await redis_client.lpush(MEMORY_INGESTION_QUEUE, json.dumps(payload))


async def push_to_notification_queue(
    redis_client: aioredis.Redis,
    queue_name: str,
    data: dict,
) -> None:
    """JSON-encode and LPUSH arbitrary data to any Redis queue."""
    await redis_client.lpush(queue_name, json.dumps(data))
