"""Unit tests for memory-service/app/engram/cortex_stimulus.py.

Strategy
--------
* `_cortex_redis` is a module-level singleton lazily initialised on the first
  call.  Tests monkeypatch it directly to the `redis_test` client (db15) so
  no real db5 connection is required.
* The function is fire-and-forget — errors are caught internally and logged at
  DEBUG (not WARNING).  Tests that exercise the error path verify no exception
  leaks and that a log record is emitted at DEBUG level.
* Concurrent-push test launches 10 tasks via asyncio.gather and asserts all
  10 items land in the queue.
"""

from __future__ import annotations

import asyncio
import json
import logging

import pytest
from app.engram import cortex_stimulus

# ── helpers ────────────────────────────────────────────────────────────────────


def _patch_client(monkeypatch, client):
    """Point the module-level singleton at `client`."""
    monkeypatch.setattr(cortex_stimulus, "_cortex_redis", client)


# ── tests ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_push_writes_to_cortex_stimuli_key(redis_test, monkeypatch):
    """emit_to_cortex writes exactly one item to the cortex:stimuli list."""
    _patch_client(monkeypatch, redis_test)

    await cortex_stimulus.emit_to_cortex("memory_retrieved")

    length = await redis_test.llen("cortex:stimuli")
    assert length == 1, "Expected exactly one item in cortex:stimuli"


@pytest.mark.asyncio
async def test_payload_shape_matches_de_facto_schema(redis_test, monkeypatch):
    """The serialised stimulus has the expected top-level keys."""
    _patch_client(monkeypatch, redis_test)

    await cortex_stimulus.emit_to_cortex(
        "memory_retrieved", payload={"engram_count": 3}
    )

    raw = await redis_test.lindex("cortex:stimuli", 0)
    assert raw is not None, "Expected at least one entry in cortex:stimuli"

    data = json.loads(raw)
    assert set(data.keys()) >= {"type", "source", "payload", "priority", "timestamp"}
    assert data["type"] == "memory_retrieved"
    assert data["payload"] == {"engram_count": 3}


@pytest.mark.asyncio
async def test_redis_down_logs_and_drops_no_crash(monkeypatch, caplog):
    """When lpush raises, the error is logged at DEBUG and no exception propagates."""

    class _BrokenRedis:
        async def lpush(self, *_args, **_kwargs):
            raise ConnectionError("redis is down")

    monkeypatch.setattr(cortex_stimulus, "_cortex_redis", _BrokenRedis())

    with caplog.at_level(logging.DEBUG, logger="app.engram.cortex_stimulus"):
        # Must not raise
        await cortex_stimulus.emit_to_cortex("some_event")

    assert any(
        "Failed to emit" in r.message or "some_event" in r.message
        for r in caplog.records
    ), "Expected a DEBUG log about the failed emit"


@pytest.mark.asyncio
async def test_payload_includes_timestamp_and_source(redis_test, monkeypatch):
    """Stimulus JSON contains non-empty `timestamp` and `source` fields."""
    _patch_client(monkeypatch, redis_test)

    await cortex_stimulus.emit_to_cortex("test_event")

    raw = await redis_test.lindex("cortex:stimuli", 0)
    data = json.loads(raw)

    assert data.get("source") == "memory-service"
    assert data.get("timestamp"), "timestamp must be a non-empty string"
    # Rough ISO-8601 check
    assert "T" in data["timestamp"], "timestamp should look like an ISO datetime"


@pytest.mark.asyncio
async def test_concurrent_pushes_serialize_correctly(redis_test, monkeypatch):
    """10 concurrent emit_to_cortex calls each land one item in the queue."""
    _patch_client(monkeypatch, redis_test)

    await asyncio.gather(
        *[cortex_stimulus.emit_to_cortex(f"event_{i}") for i in range(10)]
    )

    length = await redis_test.llen("cortex:stimuli")
    assert length == 10, f"Expected 10 items in cortex:stimuli, got {length}"

    # Verify each event type appears exactly once
    items = await redis_test.lrange("cortex:stimuli", 0, -1)
    types = {json.loads(item)["type"] for item in items}
    assert types == {f"event_{i}" for i in range(10)}
