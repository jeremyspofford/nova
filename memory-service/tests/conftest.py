"""Real-Postgres-with-pgvector fixtures for memory-service unit tests.

Pattern: a function-scoped `db_session` wraps each test in an outer BEGIN; teardown
ROLLBACKs everything. Each test gets a fresh AsyncEngine (lightweight, pooled).

This gives full pgvector / HNSW / recursive-CTE fidelity with zero
per-test schema cost and zero event loop conflicts.
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


@pytest_asyncio.fixture
async def db_session():
    """Per-test AsyncSession wrapped in BEGIN…ROLLBACK.

    Creates a fresh engine with connection pooling, then wraps the first
    connection in a transaction. Inserts/updates inside the test do not
    persist. Tests are fully isolated from each other.
    """
    engine = create_async_engine(_test_database_url(), pool_pre_ping=True)
    connection = await engine.connect()
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
        await engine.dispose()
