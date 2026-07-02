import json
from datetime import datetime, timezone

import pytest
import redis.asyncio as redis_async
from app.main import BridgePipeline
from app.session_aggregator import FocusSession
from app.tenant import DEFAULT_TENANT


def _session() -> FocusSession:
    now = datetime.now(timezone.utc)
    return FocusSession(
        app="VS Code", window="main.py", url=None,
        started_at=now, ended_at=now,
        content="hello world", word_count=2, event_count=1, frame_ids=["f1"],
    )


@pytest.mark.asyncio
async def test_session_payloads_carry_default_tenant_id():
    """End-to-end: drive session through pipeline, pop payload from Redis, verify tenant_id."""
    test_queue_key = "memory:ingestion:queue:test_tenant"
    redis_db0 = redis_async.from_url("redis://localhost:6379/0")
    redis_db10 = redis_async.from_url("redis://localhost:6379/10")
    await redis_db0.delete(test_queue_key)

    pipeline = BridgePipeline(
        redis_db0=redis_db0, redis_db10=redis_db10,
        denylist_apps=[], denylist_url_patterns=[], denylist_window_titles=[],
        buffer_size=10,
        queue_key=test_queue_key,
    )
    await pipeline.start_consumer()
    try:
        await pipeline._handle_finalized(_session())
        # Wait briefly for consumer to push to Redis
        import asyncio
        await asyncio.sleep(0.2)

        raw = await redis_db0.lpop(test_queue_key)
        assert raw is not None, "no payload in queue — pipeline didn't push"
        payload = json.loads(raw)

        assert payload["tenant_id"] == DEFAULT_TENANT
        # Sanity: also check source_type since the same flow could break
        assert payload["source_type"] == "screenpipe"
    finally:
        await pipeline.stop()
        await redis_db0.delete(test_queue_key)
        await redis_db0.aclose()
        await redis_db10.aclose()
