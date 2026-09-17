"""The process-wide asyncpg pool for the gateway.

One pool, created on first use and closed with the app. Callers await
get_pool() rather than opening connections of their own, so the number of
connections the gateway holds is a property of this file alone.
"""
from __future__ import annotations

import os

import asyncpg

_pool: asyncpg.Pool | None = None


async def init_pool() -> asyncpg.Pool:
    """Create the pool if it does not exist yet, and return it."""
    global _pool
    if _pool is None:
        dsn = os.environ.get("DATABASE_URL", "")
        if not dsn:
            raise RuntimeError("DATABASE_URL unset — gateway cannot serve without its database")
        _pool = await asyncpg.create_pool(dsn, min_size=1, max_size=10)
    return _pool


async def get_pool() -> asyncpg.Pool:
    return await init_pool()


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
