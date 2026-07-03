"""
Memory ingestion worker — consumes raw events from the Redis queue and routes
each payload to the active memory backend's write().

Runs as an asyncio background task on the memory:ingestion:queue.
Zero impact on chat latency — all processing is async background work.

Crash safety: uses BLMOVE (main → processing list) + LREM-after-success
pattern so a kill/OOM/container-restart during a write doesn't vaporize
the payload. On startup, any items still in the processing list from a
prior crashed run are pushed back to the main queue.
"""

from __future__ import annotations

import asyncio
import json
import logging

from app.config import settings
from app.redis_client import get_redis

log = logging.getLogger(__name__)

# Concurrency limit for backend writes (backpressure)
_write_semaphore = asyncio.Semaphore(5)

# Suffix for the companion "processing" list that holds in-flight payloads
# so a mid-work crash doesn't lose them.
_PROCESSING_SUFFIX = ":processing"


def _processing_list_name() -> str:
    return settings.ingestion_queue + _PROCESSING_SUFFIX


async def _recover_processing_list(redis) -> int:
    """On startup, push any orphaned in-flight payloads back to the main queue.
    These come from a prior worker that was killed before it could LREM them.
    Returns the number of payloads recovered."""
    processing = _processing_list_name()
    items = await redis.lrange(processing, 0, -1)
    if not items:
        return 0
    async with redis.pipeline(transaction=True) as pipe:
        for item in items:
            # Push to head so recovered items are handled FIRST (FIFO preservation
            # with BRPOP-style tail consumption).
            pipe.lpush(settings.ingestion_queue, item)
        pipe.delete(processing)
        await pipe.execute()
    return len(items)


async def _dispatch_event(payload_str: str) -> None:
    """Route a queue payload to the active memory backend."""
    from app.backends import get_backend

    backend = await get_backend()
    event = json.loads(payload_str)
    await backend.write(
        event.get("raw_text", ""),
        source_type=event.get("source_type", "chat"),
        source_id=event.get("source_id"),
        session_id=event.get("session_id"),
        occurred_at=event.get("occurred_at"),
        metadata=event.get("metadata", {}),
        tenant_id=event.get("tenant_id"),
    )


async def _process_event_guarded(
    payload_str: str,
    payload_raw,
    processing_list: str,
) -> None:
    """Run one queue event under the write semaphore with error handling.
    Removes the payload from the processing list on completion (success or
    caught failure). Only uncaught crashes leave items behind for recovery."""
    redis = get_redis()
    try:
        async with _write_semaphore:
            await _dispatch_event(payload_str)
    except Exception:
        log.exception("Memory ingestion failed for event: %s", payload_str[:200])
    finally:
        # Even on failure, drop from processing — the reliability win here is
        # specifically around CRASHES, not logical failures.
        try:
            await redis.lrem(processing_list, 1, payload_raw)
        except Exception:
            log.warning("Failed to clear payload from processing list", exc_info=True)


async def ingestion_loop() -> None:
    """Main ingestion loop — atomic BLMOVE from queue to processing list, then
    process each event. Startup recovers any orphaned in-flight payloads."""
    if not settings.ingestion_enabled:
        log.info("Memory ingestion disabled")
        return

    redis = get_redis()
    queue = settings.ingestion_queue
    processing = _processing_list_name()

    # Crash recovery: items left in the processing list are from a prior
    # worker that died before completing them.
    recovered = await _recover_processing_list(redis)
    if recovered:
        log.info(
            "Recovered %d orphaned ingestion payload(s) from processing list", recovered
        )

    log.info("Memory ingestion worker started (queue=%s)", queue)

    while True:
        try:
            # BLMOVE atomically pops the tail of the main queue and pushes it
            # to the head of the processing list. Returns None on timeout.
            payload_raw = await redis.blmove(
                queue,
                processing,
                int(settings.ingestion_batch_timeout),
                src="RIGHT",
                dest="LEFT",
            )
            if payload_raw is None:
                continue

            # Keep the raw value for LREM (Redis matches by byte equality);
            # decode only for JSON parsing / downstream use.
            payload_str = (
                payload_raw.decode("utf-8")
                if isinstance(payload_raw, bytes)
                else payload_raw
            )

            try:
                json.loads(payload_str)
            except json.JSONDecodeError:
                log.warning(
                    "Malformed ingestion event (not valid JSON), dropping: %s",
                    payload_str[:200],
                )
                try:
                    await redis.lrem(processing, 1, payload_raw)
                except Exception:
                    log.warning(
                        "Failed to clear malformed payload from processing list",
                        exc_info=True,
                    )
                continue

            # Fire into background so the loop isn't blocked. The semaphore
            # inside _process_event_guarded bounds concurrent backend writes.
            asyncio.create_task(
                _process_event_guarded(payload_str, payload_raw, processing),
                name="memory-ingest",
            )

        except asyncio.CancelledError:
            log.info("Memory ingestion worker shutting down")
            break
        except Exception:
            log.exception("Memory ingestion error — will retry")
            await asyncio.sleep(1.0)
