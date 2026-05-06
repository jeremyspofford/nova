"""Smoke tests for the real-DB fixtures themselves."""

from __future__ import annotations

import pytest
from sqlalchemy import text


@pytest.mark.asyncio
async def test_db_session_runs_query(db_session):
    """db_session yields a working AsyncSession against nova_test."""
    result = await db_session.execute(text("SELECT 1 AS v"))
    assert result.scalar() == 1


@pytest.mark.asyncio
async def test_db_session_isolates_inserts(db_session):
    """Inserts inside a test are rolled back at teardown."""
    await db_session.execute(
        text(
            "INSERT INTO engrams (type, content, source_type, importance, "
            "activation, confidence) VALUES "
            "('fact', 'smoke-test-content', 'chat', 0.5, 1.0, 0.8)"
        )
    )
    await db_session.flush()
    count = await db_session.execute(
        text("SELECT count(*) FROM engrams WHERE content = 'smoke-test-content'")
    )
    assert count.scalar() == 1


@pytest.mark.asyncio
async def test_db_session_rollback_persisted(db_session):
    """A second test does not see the first test's insert (rollback worked)."""
    count = await db_session.execute(
        text("SELECT count(*) FROM engrams WHERE content = 'smoke-test-content'")
    )
    assert count.scalar() == 0
