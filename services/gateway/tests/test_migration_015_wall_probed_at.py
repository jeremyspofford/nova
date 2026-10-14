"""Migration 015 (epic wall-probe, T4): provider_walls.probed_at.

The time the gateway last probed a wall, kept apart from `updated_at` (the
time of its latest refusal) so a probe that failed without a refusal never
fakes a refusal time. Nullable, no default: a wall nobody has probed says so.
"""

from __future__ import annotations

import shutil

import asyncpg
import pytest

import tests.conftest as conftest
from app.main import MIGRATIONS_DIR
from app.migrations_runner import run_migrations
from tests.conftest import TEST_DSN, requires_db

pytestmark = requires_db

MIGRATION = MIGRATIONS_DIR / "015_wall_probed_at.sql"


async def _migrate_to(tmp_path, upto: int) -> None:
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(
            f"DROP TABLE IF EXISTS {', '.join(conftest._TABLES)}, backend_config CASCADE"
        )
        await conn.execute("DROP TABLE IF EXISTS schema_migrations")
    finally:
        await conn.close()
    partial = tmp_path / f"upto_{upto}"
    partial.mkdir(exist_ok=True)
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if int(path.name.split("_")[0]) <= upto:
            shutil.copy(path, partial / path.name)
    await run_migrations(TEST_DSN, partial)


@pytest.fixture
async def legacy(tmp_path):
    """A database exactly as 014 left it, handed back REBUILT to the full
    schema (see test_migration_009_engines for why from here)."""
    await _migrate_to(tmp_path, 14)
    conn = await asyncpg.connect(TEST_DSN)
    try:
        yield conn
    finally:
        await conn.close()
        await conftest._build_schema()


# ── c1: the column, its type, and a wall that stood before it ──────────────


async def test_migration_015_adds_a_nullable_probed_at_with_no_default(pool):
    assert MIGRATION.exists(), MIGRATION
    col = await pool.fetchrow(
        "SELECT data_type, is_nullable, column_default FROM information_schema.columns "
        "WHERE table_name = 'provider_walls' AND column_name = 'probed_at'"
    )
    assert col is not None, "provider_walls has no probed_at"
    assert col["data_type"] == "timestamp with time zone"
    assert col["is_nullable"] == "YES"
    assert col["column_default"] is None


async def test_a_wall_standing_before_015_survives_it_never_probed(legacy):
    await legacy.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key) VALUES "
        "('openrouter', 'openai-chat', 'https://openrouter.test/v1', 'static-bearer', 'sk-1')"
    )
    await legacy.execute(
        "INSERT INTO provider_walls (provider, model, walled_until, reason, status, strikes, "
        "updated_at) VALUES ('openrouter', '', now() + interval '20 hours', "
        "'openrouter refused (402): Insufficient credits', 402, 7, now() - interval '4 hours')"
    )

    await run_migrations(TEST_DSN, MIGRATIONS_DIR)

    rows = await legacy.fetch(
        "SELECT provider, status, strikes, updated_at < now() - interval '3 hours' AS kept, "
        "probed_at FROM provider_walls"
    )
    assert [tuple(r) for r in rows] == [("openrouter", 402, 7, True, None)]
