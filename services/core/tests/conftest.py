"""Fixtures for the DB-backed core suites.

Every core concern (people, conversations, traces, settings) is stored in
postgres, so these tests need a real one: TEST_DATABASE_URL, same contract
as Task 1's migration test. Unset means skip with a stated reason — never
a pass that proved nothing.
"""
from __future__ import annotations

import asyncio
import os

import asyncpg
import pytest
from httpx import ASGITransport, AsyncClient

from app import chat, db
from app.main import MIGRATIONS_DIR, app
from app.migrations_runner import run_migrations
from tests import fakes

TEST_DSN = os.environ.get("TEST_DATABASE_URL", "")
SKIP_REASON = "TEST_DATABASE_URL not set — no dockerized postgres available for this run"
requires_db = pytest.mark.skipif(not TEST_DSN, reason=SKIP_REASON)

SERVICE_TOKEN = "test-service-token"
BASE_URL = "http://test"
OWNER = {"name": "jeremy", "password": "correct horse battery staple"}

# Truncation order is child-before-parent so CASCADE never surprises us.
# core_signing_key is deliberately NOT here: it is created once per install
# and every enrolled device pins it, so it behaves like schema, not per-test
# state. Tests that need it absent delete it themselves.
_TABLES = (
    # S11: notices references turns and timer_firings (both ON DELETE SET
    # NULL), so it is a child of two tables further down this list and drops
    # and truncates ahead of either.
    "notices",
    "timer_firings",
    "timers",
    # S12: timers.agent_id references agents (RESTRICT), so agents goes after
    # timers. agents ↔ turns reference each other (turns.agent_id and
    # agents.created_turn_id), so no order satisfies both — the CASCADE on
    # the DROP and on the TRUNCATE is what makes the cycle a non-issue.
    "agents",
    "device_audit",
    "devices",
    "pairing_codes",
    "governance_events",
    "eval_runs",
    "eval_suite_runs",
    "turn_spans",
    "turns",
    "messages",
    "conversations",
    "sessions",
    "settings",
    "people",
)

_schema_built = False


async def _build_schema() -> None:
    """Drop anything this suite owns, then migrate from empty."""
    conn = await asyncpg.connect(TEST_DSN)
    try:
        # core_signing_key is not in _TABLES (never per-test truncated) but must
        # still be dropped for a clean re-migration, or migration 011's CREATE
        # would collide with a leftover from a prior run.
        await conn.execute(
            f"DROP TABLE IF EXISTS {', '.join(_TABLES)}, core_signing_key CASCADE"
        )
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
        # Same order as the real shutdown: let fired-and-forgotten work land
        # before the pool it needs goes away.
        await asyncio.wait_for(chat.drain_background(), timeout=15)
        await db.close_pool()


@pytest.fixture
async def client(pool, monkeypatch):
    """ASGI client with the service bearer configured (the normal state)."""
    monkeypatch.setenv("SERVICE_TOKEN", SERVICE_TOKEN)
    from app import auth_api, devices_api

    # Both limiters are process-global by design (one household, one process),
    # so a test that trips one would otherwise lock the next test out.
    auth_api._LOGIN_FAILURES.clear()
    devices_api._ENROLL_FAILURES.clear()
    async with AsyncClient(transport=ASGITransport(app=app), base_url=BASE_URL) as c:
        yield c


@pytest.fixture
async def owner_client(client):
    """A client carrying the registered owner's session cookie."""
    resp = await client.post("/api/v1/auth/register", json=OWNER)
    assert resp.status_code == 200, resp.text
    return client


@pytest.fixture
def mount_peers(monkeypatch):
    """Point core's gateway/memory links at local ASGI fakes, by URL."""

    def _mount(gateway=None, memory=None, *, gateway_delay: float = 0.0) -> None:
        transports = {}
        if gateway is not None:
            monkeypatch.setenv("GATEWAY_URL", fakes.GATEWAY_URL)
            monkeypatch.setenv("CORE_GATEWAY_TOKEN", fakes.GATEWAY_TOKEN)
            transports[fakes.GATEWAY_URL] = fakes.StreamingASGITransport(
                gateway.app, delay=gateway_delay
            )
        if memory is not None:
            monkeypatch.setenv("MEMORY_URL", fakes.MEMORY_URL)
            monkeypatch.setenv("CORE_MEMORY_TOKEN", fakes.MEMORY_TOKEN)
            transports[fakes.MEMORY_URL] = fakes.StreamingASGITransport(memory.app)
        app.state.peer_transports = transports

    yield _mount
    app.state.peer_transports = {}
