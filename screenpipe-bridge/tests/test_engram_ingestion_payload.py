import json
from datetime import datetime, timezone

import pytest
import redis.asyncio as redis_async

from app.engram_producer import EngramProducer
from app.session_aggregator import FocusSession
from app.tenant import DEFAULT_TENANT


_TEST_QUEUE = "engram:ingestion:queue:test"


@pytest.mark.asyncio
async def test_payload_shape_matches_decomposer_contract():
    r = redis_async.from_url("redis://localhost:6379/0")
    await r.delete(_TEST_QUEUE)
    producer = EngramProducer(redis=r, device_id="primary", trust=0.80, queue_key=_TEST_QUEUE)
    started = datetime(2026, 5, 2, 14, 32, 0, tzinfo=timezone.utc)
    ended = datetime(2026, 5, 2, 14, 51, 0, tzinfo=timezone.utc)
    session = FocusSession(
        app="VS Code", window="clients.py — orchestrator",
        url="file:///tmp/clients.py", started_at=started, ended_at=ended,
        content="some screen text\nmore text", word_count=4, event_count=20, frame_ids=["a", "b"],
    )

    await producer.push(session)

    raw = await r.lpop(_TEST_QUEUE)
    payload = json.loads(raw)

    assert payload["raw_text"].startswith("some screen text")
    assert payload["source_type"] == "screenpipe"
    assert payload["tenant_id"] == DEFAULT_TENANT
    assert payload["source_trust"] == 0.80
    assert payload["source_uri"].startswith("screenpipe://primary/2026-05-02T14:32:00")
    assert payload["source_title"].startswith("VS Code — clients.py")
    assert payload["session_id"] == "screenpipe:primary:2026-05-02T14:32:00+00:00"
    assert payload["occurred_at"] == "2026-05-02T14:32:00+00:00"
    assert payload["metadata"]["app"] == "VS Code"
    assert payload["metadata"]["device_id"] == "primary"
    assert "source_id" not in payload  # decomposer creates it

    await r.aclose()
