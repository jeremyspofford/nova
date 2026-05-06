"""Legacy mock fixtures from before the real-DB migration.

Imported explicitly by tests still using mocks. Not auto-loaded
via pytest_plugins. Migrate consumers to conftest.py fixtures
when the surrounding code is touched.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest


@pytest.fixture
def mock_redis():
    """Mock async Redis client. Use real `redis_test` fixture for new tests."""
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)
    redis.setex = AsyncMock()
    return redis


@pytest.fixture
def mock_session():
    """Mock SQLAlchemy async session. Use real `db_session` fixture for new tests."""
    session = AsyncMock()
    return session
