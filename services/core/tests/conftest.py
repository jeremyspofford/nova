"""Fixtures for the DB-backed core suites.

Every core concern (people, conversations, traces, settings) is stored in
postgres, so these tests need a real one: TEST_DATABASE_URL, same contract
as Task 1's migration test. Unset means skip with a stated reason — never
a pass that proved nothing.
"""
from __future__ import annotations

import os

import asyncpg
import pytest
from httpx import ASGITransport, AsyncClient

from app import db
from app.main import MIGRATIONS_DIR, app
from app.migrations_runner import run_migrations

TEST_DSN = os.environ.get("TEST_DATABASE_URL", "")
SKIP_REASON = "TEST_DATABASE_URL not set — no dockerized postgres available for this run"
requires_db = pytest.mark.skipif(not TEST_DSN, reason=SKIP_REASON)

SERVICE_TOKEN = "test-service-token"
BASE_URL = "http://test"
OWNER = {"name": "jeremy", "password": "correct horse battery staple"}

# Truncation order is child-before-parent so CASCADE never surprises us.
_TABLES = ("turn_spans", "turns", "messages", "conversations", "sessions", "settings", "people")

_schema_built = False


async def _build_schema() -> None:
    """Drop anything this suite owns, then migrate from empty."""
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(f"DROP TABLE IF EXISTS {', '.join(_TABLES)} CASCADE")
        await conn.execute("DROP TABLE IF EXISTS schema_migrations")
    finally:
        await conn.close()
    await run_migrations(TEST_DSN, MIGRATIONS_DIR)


@pytest.fixture
async def pool(monkeypatch):
    """A live pool over a freshly truncated schema."""
    global _schema_built
    monkeypatch.setenv("DATABASE_URL", TEST_DSN)
    if not _schema_built:
        await _build_schema()
        _schema_built = True
    # The pool belongs to this test's event loop, so it is built and torn
    # down per test rather than shared.
    p = await db.init_pool()
    await p.execute(f"TRUNCATE {', '.join(_TABLES)} RESTART IDENTITY CASCADE")
    try:
        yield p
    finally:
        await db.close_pool()


@pytest.fixture
async def client(pool, monkeypatch):
    """ASGI client with the service bearer configured (the normal state)."""
    monkeypatch.setenv("SERVICE_TOKEN", SERVICE_TOKEN)
    from app import auth_api

    auth_api._LOGIN_FAILURES.clear()
    async with AsyncClient(transport=ASGITransport(app=app), base_url=BASE_URL) as c:
        yield c


@pytest.fixture
async def owner_client(client):
    """A client carrying the registered owner's session cookie."""
    resp = await client.post("/api/v1/auth/register", json=OWNER)
    assert resp.status_code == 200, resp.text
    return client
