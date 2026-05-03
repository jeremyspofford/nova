import asyncio
from datetime import datetime, timezone

import pytest
import redis.asyncio as redis_async

from app.main import BridgePipeline
from app.session_aggregator import FocusSession


def _session(app: str = "Test") -> FocusSession:
    now = datetime.now(timezone.utc)
    return FocusSession(
        app=app, window="W", url=None,
        started_at=now, ended_at=now,
        content="x", word_count=1, event_count=1, frame_ids=[],
    )


@pytest.mark.asyncio
async def test_paused_state_discards_sessions_with_paused_counter():
    """When paused_check returns True, sessions are dropped with reason 'paused'."""
    redis_db0 = redis_async.from_url("redis://localhost:6379/0")
    redis_db10 = redis_async.from_url("redis://localhost:6379/10")
    paused_state = {"paused": True}
    pipeline = BridgePipeline(
        redis_db0=redis_db0,
        redis_db10=redis_db10,
        denylist_apps=[], denylist_url_patterns=[], denylist_window_titles=[],
        buffer_size=10,
        paused_check=lambda: paused_state["paused"],
        queue_key="engram:ingestion:queue:test_pause",
    )
    await pipeline.start_consumer()
    try:
        # Three sessions while paused -> all dropped as 'paused'
        await pipeline._handle_finalized(_session("a"))
        await pipeline._handle_finalized(_session("b"))
        await pipeline._handle_finalized(_session("c"))
        assert pipeline.dropped_count("paused") == 3

        # Resume -> sessions go through (not dropped as paused)
        paused_state["paused"] = False
        await pipeline._handle_finalized(_session("d"))
        # Paused drop counter must remain at 3 after resuming
        assert pipeline.dropped_count("paused") == 3
    finally:
        await pipeline.stop()
        await redis_db0.aclose()
        await redis_db10.aclose()
