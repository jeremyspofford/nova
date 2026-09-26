"""Core migration 036 (S42a): devices.platform gets the CHECK it never had,
and devices gain the facts their agent reports — a dated pair — plus the
machine_uid index the duplicate-agent check reads."""

from __future__ import annotations

import asyncpg
import pytest

from app.main import MIGRATIONS_DIR
from tests.conftest import requires_db

pytestmark = requires_db

MIGRATION = MIGRATIONS_DIR / "036_agent_facts.sql"
PUBKEY = "ab" * 32


async def _device(pool, name: str, platform: str = "linux"):
    return await pool.fetchval(
        "INSERT INTO devices (name, platform, hostname, pubkey) VALUES ($1, $2, 'h', $3) "
        "RETURNING id",
        name,
        platform,
        PUBKEY,
    )


async def test_the_runner_applies_it(pool):
    names = {r["filename"] for r in await pool.fetch("SELECT filename FROM schema_migrations")}
    assert "036_agent_facts.sql" in names


async def test_a_platform_outside_the_four_becomes_unknown_and_the_check_holds(pool):
    # Stand where a pre-036 database stood: no CHECK, a free-text platform.
    await pool.execute("ALTER TABLE devices DROP CONSTRAINT devices_platform")
    old = await _device(pool, "old-box", "FreeBSD")
    await pool.execute(MIGRATION.read_text())
    assert await pool.fetchval("SELECT platform FROM devices WHERE id = $1", old) == "unknown"
    with pytest.raises(asyncpg.CheckViolationError):
        await _device(pool, "new-box", "freebsd")
    for platform in ("linux", "darwin", "windows", "unknown"):
        await _device(pool, f"box-{platform}", platform)


async def test_facts_are_a_dated_pair(pool):
    device = await _device(pool, "pair")
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute("UPDATE devices SET facts = '{}'::jsonb WHERE id = $1", device)
    await pool.execute(
        "UPDATE devices SET facts = $2, facts_at = now() WHERE id = $1", device, {"v": 2}
    )
    assert await pool.fetchval("SELECT facts FROM devices WHERE id = $1", device) == {"v": 2}


async def test_the_machine_uid_index_exists(pool):
    found = await pool.fetchval(
        "SELECT indexdef FROM pg_indexes WHERE tablename = 'devices' "
        "AND indexname = 'devices_machine_uid'"
    )
    assert found is not None and "machine_uid" in found and "revoked_at IS NULL" in found


async def test_applied_twice_it_changes_nothing_more(pool):
    device = await _device(pool, "twice", "windows")
    sql = MIGRATION.read_text()
    await pool.execute(sql)
    await pool.execute(sql)
    assert await pool.fetchval("SELECT platform FROM devices WHERE id = $1", device) == "windows"
