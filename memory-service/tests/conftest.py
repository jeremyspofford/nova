"""Real-Postgres-with-pgvector fixtures for memory-service unit tests.

Pattern: a session-scoped `db_engine` connects to nova_test (already
populated by `memory-service/scripts/setup_test_db.py`). A function-scoped `db_session`
wraps each test in an outer BEGIN; teardown ROLLBACKs everything.

This gives full pgvector / HNSW / recursive-CTE fidelity with zero
per-test schema cost.
"""

from __future__ import annotations

import os

import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


def _test_database_url() -> str:
    """Compose async DB URL from env, defaulting to local docker-compose Postgres."""
    user = os.environ.get("POSTGRES_USER", "nova")
    password = os.environ.get("POSTGRES_PASSWORD", "nova_dev_password")
    host = os.environ.get("POSTGRES_HOST", "localhost")
    port = os.environ.get("POSTGRES_PORT", "5432")
    db = os.environ.get("TEST_DB_NAME", "nova_test")
    return f"postgresql+asyncpg://{user}:{password}@{host}:{port}/{db}"


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def db_engine():
    """One async engine per pytest session.

    `loop_scope="session"` keeps the engine bound to a single event loop
    that lives for the whole session, sidestepping pytest-asyncio's default
    function-scoped event loop (which would invalidate session-scoped async
    objects). Requires pytest-asyncio>=0.23.
    """
    engine = create_async_engine(_test_database_url(), pool_pre_ping=True)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture(scope="function", loop_scope="session")
async def db_session(db_engine):
    """Per-test AsyncSession wrapped in BEGIN…ROLLBACK.

    Inserts/updates inside the test do not persist. Tests are fully
    isolated from each other.
    """
    connection = await db_engine.connect()
    transaction = await connection.begin()
    factory = async_sessionmaker(
        bind=connection,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    session = factory()
    try:
        yield session
    finally:
        await session.close()
        await transaction.rollback()
        await connection.close()
