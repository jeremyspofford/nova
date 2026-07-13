"""Chat stream lock — cancel-and-replace semantics (app.chat_stream_lock).

A send while Nova is responding used to 409 until a 120s TTL lapsed; a slow
local model could wall off a conversation for minutes (observed live
2026-07-13: ornith:9b first-load on CPU → every send, any model, 409'd).
Now a new send atomically takes the lock over and the superseded stream
stops at its next ownership check.

Runs against the real Redis (localhost, orchestrator's db2) with
nova-test- prefixed keys. Orchestrator's `app.*` is imported in isolation
(see tests/_service_app.py).
"""
from __future__ import annotations

import os

import pytest_asyncio
import redis.asyncio as aioredis
from _service_app import service_app

REDIS_URL = os.getenv("NOVA_TEST_REDIS_URL", "redis://localhost:6379/2")
KEY = "nova:chat:streaming:nova-test-lock-conv"


@pytest_asyncio.fixture
async def lock_mod():
    with service_app("orchestrator") as import_module:
        store = import_module("app.store")
        lock = import_module("app.chat_stream_lock")

        client = aioredis.from_url(REDIS_URL, decode_responses=True)
        saved = store._redis
        store._redis = client
        try:
            await client.delete(KEY)
            yield lock
        finally:
            await client.delete(KEY)
            await client.aclose()
            store._redis = saved


async def test_first_acquire_is_uncontended(lock_mod):
    token, superseded = await lock_mod.acquire(KEY)
    assert token and superseded is False
    assert await lock_mod.still_owner_and_refresh(KEY, token) is True


async def test_new_send_supersedes_and_old_stream_notices(lock_mod):
    first, _ = await lock_mod.acquire(KEY)
    second, superseded = await lock_mod.acquire(KEY)
    assert superseded is True
    assert first != second
    # The old stream's next ownership check tells it to stop…
    assert await lock_mod.still_owner_and_refresh(KEY, first) is False
    # …while the new one streams on.
    assert await lock_mod.still_owner_and_refresh(KEY, second) is True


async def test_stale_release_never_kicks_the_successor(lock_mod):
    first, _ = await lock_mod.acquire(KEY)
    second, _ = await lock_mod.acquire(KEY)
    await lock_mod.release(KEY, first)  # superseded stream exiting
    assert await lock_mod.still_owner_and_refresh(KEY, second) is True


async def test_owner_release_frees_the_conversation(lock_mod):
    token, _ = await lock_mod.acquire(KEY)
    await lock_mod.release(KEY, token)
    fresh, superseded = await lock_mod.acquire(KEY)
    assert superseded is False


async def test_refresh_extends_the_ttl(lock_mod):
    import app.store as store
    token, _ = await lock_mod.acquire(KEY)
    # Age the key artificially, then confirm a refresh restores the TTL.
    await store._redis.expire(KEY, 5)
    assert await lock_mod.still_owner_and_refresh(KEY, token) is True
    assert await store._redis.ttl(KEY) > 100
