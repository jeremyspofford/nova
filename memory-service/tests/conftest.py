"""Shared fixtures for memory-service unit tests.

Run from memory-service/:  uv run pytest tests/ -x -q
Requires a local Redis on localhost:6379 (docker compose redis works).
Tests use db15 and FLUSHDB at setup, so they never touch live data.
"""

from __future__ import annotations

import os

import pytest_asyncio
import redis.asyncio as aioredis


@pytest_asyncio.fixture(loop_scope="session")
async def redis_test():
    """Per-test isolated Redis client on db15.

    FLUSHDB at setup (not teardown) so a previous failed test
    doesn't leave keys around.
    """
    host = os.environ.get("REDIS_HOST", "localhost")
    port = int(os.environ.get("REDIS_PORT", "6379"))
    client = aioredis.from_url(f"redis://{host}:{port}/15")
    await client.flushdb()
    try:
        yield client
    finally:
        await client.aclose()
