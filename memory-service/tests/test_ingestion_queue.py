"""Queue-mechanics tests for app.ingestion — the backend-agnostic consumer.

The memory backend is mocked; these tests pin the Redis BLMOVE +
processing-list crash-safety behavior and the dispatch contract
(payload fields → backend.write kwargs).
"""

from __future__ import annotations

import asyncio
import json
import logging
from unittest.mock import AsyncMock

import pytest

from app import ingestion
from app.config import settings


class _FakeBackend:
    name = "okf"

    def __init__(self):
        self.write = AsyncMock(return_value=None)


@pytest.fixture
def fake_backend(monkeypatch):
    backend = _FakeBackend()

    async def _get_backend():
        return backend

    # _dispatch_event does `from app.backends import get_backend`
    import app.backends as backends_mod

    monkeypatch.setattr(backends_mod, "get_backend", _get_backend)
    return backend


@pytest.fixture
def use_test_redis(monkeypatch, redis_test):
    monkeypatch.setattr(ingestion, "get_redis", lambda: redis_test)
    return redis_test


def _payload(**overrides) -> str:
    event = {
        "raw_text": "Jeremy prefers dark roast coffee",
        "source_type": "chat",
        "source_id": None,
        "session_id": "s-1",
        "occurred_at": "2026-07-02T12:00:00+00:00",
        "metadata": {"origin": "test"},
        "tenant_id": "00000000-0000-0000-0000-000000000001",
    }
    event.update(overrides)
    return json.dumps(event)


async def test_dispatch_routes_payload_fields_to_backend_write(fake_backend):
    await ingestion._dispatch_event(_payload())

    fake_backend.write.assert_awaited_once()
    args, kwargs = fake_backend.write.await_args
    assert args[0] == "Jeremy prefers dark roast coffee"
    assert kwargs["source_type"] == "chat"
    assert kwargs["session_id"] == "s-1"
    assert kwargs["metadata"] == {"origin": "test"}
    assert kwargs["tenant_id"] == "00000000-0000-0000-0000-000000000001"


async def test_guarded_event_removed_from_processing_on_success(
    fake_backend, use_test_redis
):
    redis = use_test_redis
    processing = ingestion._processing_list_name()
    payload = _payload()
    await redis.lpush(processing, payload)

    await ingestion._process_event_guarded(payload, payload.encode(), processing)

    assert await redis.llen(processing) == 0
    fake_backend.write.assert_awaited_once()


async def test_guarded_event_removed_from_processing_on_failure(
    fake_backend, use_test_redis, caplog
):
    redis = use_test_redis
    processing = ingestion._processing_list_name()
    payload = _payload()
    await redis.lpush(processing, payload)
    fake_backend.write.side_effect = RuntimeError("backend down")

    with caplog.at_level(logging.ERROR, logger="app.ingestion"):
        await ingestion._process_event_guarded(payload, payload.encode(), processing)

    assert await redis.llen(processing) == 0
    assert any("ingestion failed" in r.message for r in caplog.records)


async def test_recover_processing_list_restores_orphaned_payloads(use_test_redis):
    redis = use_test_redis
    processing = ingestion._processing_list_name()
    await redis.lpush(processing, _payload(session_id="a"), _payload(session_id="b"))

    recovered = await ingestion._recover_processing_list(redis)

    assert recovered == 2
    assert await redis.llen(processing) == 0
    assert await redis.llen(settings.ingestion_queue) == 2


async def test_recover_processing_list_noop_when_empty(use_test_redis):
    assert await ingestion._recover_processing_list(use_test_redis) == 0


async def test_loop_consumes_queue_and_dispatches(
    fake_backend, use_test_redis, monkeypatch
):
    redis = use_test_redis
    monkeypatch.setattr(settings, "ingestion_batch_timeout", 1.0)
    await redis.lpush(settings.ingestion_queue, _payload())

    task = asyncio.create_task(ingestion.ingestion_loop())
    try:
        for _ in range(50):
            if fake_backend.write.await_count:
                break
            await asyncio.sleep(0.1)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    fake_backend.write.assert_awaited_once()
    assert await redis.llen(settings.ingestion_queue) == 0
    assert await redis.llen(ingestion._processing_list_name()) == 0


async def test_loop_drops_malformed_json(fake_backend, use_test_redis, monkeypatch):
    redis = use_test_redis
    monkeypatch.setattr(settings, "ingestion_batch_timeout", 1.0)
    await redis.lpush(settings.ingestion_queue, "not-json{{{")

    task = asyncio.create_task(ingestion.ingestion_loop())
    try:
        for _ in range(50):
            if (
                await redis.llen(settings.ingestion_queue) == 0
                and await redis.llen(ingestion._processing_list_name()) == 0
            ):
                break
            await asyncio.sleep(0.1)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    fake_backend.write.assert_not_awaited()
    assert await redis.llen(settings.ingestion_queue) == 0
    assert await redis.llen(ingestion._processing_list_name()) == 0


async def test_writes_bounded_by_semaphore(fake_backend, use_test_redis):
    redis = use_test_redis
    processing = ingestion._processing_list_name()
    in_flight = 0
    peak = 0
    gate = asyncio.Event()

    async def slow_write(*a, **kw):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await gate.wait()
        in_flight -= 1

    fake_backend.write.side_effect = slow_write

    payloads = [_payload(session_id=f"s-{i}") for i in range(6)]
    for p in payloads:
        await redis.lpush(processing, p)
    tasks = [
        asyncio.create_task(
            ingestion._process_event_guarded(p, p.encode(), processing)
        )
        for p in payloads
    ]
    await asyncio.sleep(0.3)
    assert peak <= 5  # semaphore cap
    gate.set()
    await asyncio.gather(*tasks)
    assert peak == 5
