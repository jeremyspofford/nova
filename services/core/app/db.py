"""The process-wide asyncpg pool.

One pool, created on first use and closed with the app. Callers await
`get_pool()` rather than opening connections of their own, so the number of
connections core holds is a property of this file alone.
"""
from __future__ import annotations

import json
import os

import asyncpg

_pool: asyncpg.Pool | None = None


async def _configure(conn: asyncpg.Connection) -> None:
    # jsonb crosses the wire as python objects rather than as text both ways.
    await conn.set_type_codec(
        "jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
    )


async def init_pool() -> asyncpg.Pool:
    """Create the pool if it does not exist yet, and return it."""
    global _pool
    if _pool is None:
        dsn = os.environ.get("DATABASE_URL", "")
        if not dsn:
            raise RuntimeError("DATABASE_URL unset — core cannot serve without its database")
        _pool = await asyncpg.create_pool(dsn, min_size=1, max_size=10, init=_configure)
    return _pool


async def get_pool() -> asyncpg.Pool:
    return await init_pool()


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
