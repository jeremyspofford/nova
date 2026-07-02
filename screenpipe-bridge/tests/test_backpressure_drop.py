from datetime import datetime, timezone

import pytest
import redis.asyncio as redis_async
from app.main import BridgePipeline
from app.session_aggregator import FocusSession


def _session(app: str) -> FocusSession:
    now = datetime.now(timezone.utc)
    return FocusSession(
        app=app, window="W", url=None,
        started_at=now, ended_at=now,
        content="x", word_count=1, event_count=1, frame_ids=[],
    )


@pytest.mark.asyncio
async def test_full_buffer_drops_newest_session():
    """When the producer can't keep up, bounded buffer drops newest after capacity."""
    redis_db0 = redis_async.from_url("redis://localhost:6379/0")
    redis_db10 = redis_async.from_url("redis://localhost:6379/10")
    pipeline = BridgePipeline(
        redis_db0=redis_db0,
        redis_db10=redis_db10,
        denylist_apps=[], denylist_url_patterns=[], denylist_window_titles=[],
        buffer_size=2,
        device_id="primary",
        trust=0.80,
        producer_blocked=True,  # test-only flag: consumer blocks forever after dequeue
        queue_key="memory:ingestion:queue:test",  # avoid live consumer
    )
    await pipeline.start_consumer()
    try:
        await pipeline._handle_finalized(_session("a"))
        await pipeline._handle_finalized(_session("b"))
        await pipeline._handle_finalized(_session("c"))  # should drop "c"
        await pipeline._handle_finalized(_session("d"))  # should drop "d"

        # The consumer dequeued "a" and is blocked; "b" remains buffered;
        # "c" and "d" exceed buffer capacity → dropped.
        assert pipeline.dropped_count("buffer_full") == 2
    finally:
        await pipeline.stop()
        await redis_db0.aclose()
        await redis_db10.aclose()
