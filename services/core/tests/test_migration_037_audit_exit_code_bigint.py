"""Core migration 037: device_audit.exit_code widens from int4 to int8.

Windows process exit codes are a Win32 DWORD — uint32, up to 4294967295 —
and novad sends the raw value (apps/novad/internal/caps/shell.go). int4
could not hold 0x80070005 (2147942405): asyncpg's DataError on the INSERT in
devices_ws.ingest_audit escaped the frame handler and took the socket down
on every reconnect. This pins the column at bigint, that re-running the
migration on an already-widened column changes nothing, and that the values
that broke int4 — plus a negative, signal-derived code — store and read
back exactly."""

from __future__ import annotations

import pytest

from app.main import MIGRATIONS_DIR
from tests.conftest import requires_db

pytestmark = requires_db

MIGRATION = MIGRATIONS_DIR / "037_audit_exit_code_bigint.sql"
PUBKEY = "cd" * 32


async def _device(pool, name: str = "dell") -> str:
    return await pool.fetchval(
        "INSERT INTO devices (name, platform, hostname, pubkey) VALUES ($1, 'windows', 'h', $2) "
        "RETURNING id",
        name,
        PUBKEY,
    )


async def _audit_row(pool, device_id, seq: int, exit_code: int) -> None:
    await pool.execute(
        "INSERT INTO device_audit (device_id, seq, prev_hash, hash, ts, envelope_id, "
        "capability, summary, ok, exit_code) "
        "VALUES ($1, $2, NULL, 'h', now(), 'env-1', 'shell.exec', 's', true, $3)",
        device_id,
        seq,
        exit_code,
    )


async def _exit_code_type(pool) -> str:
    return await pool.fetchval(
        "SELECT data_type FROM information_schema.columns "
        "WHERE table_name = 'device_audit' AND column_name = 'exit_code'"
    )


async def test_the_runner_applies_it(pool):
    names = {r["filename"] for r in await pool.fetch("SELECT filename FROM schema_migrations")}
    assert "037_audit_exit_code_bigint.sql" in names


async def test_the_column_is_bigint(pool):
    assert await _exit_code_type(pool) == "bigint"


async def test_applied_twice_it_changes_nothing_more(pool):
    device_id = await _device(pool)
    await _audit_row(pool, device_id, 0, 4294967295)
    sql = MIGRATION.read_text()
    await pool.execute(sql)
    await pool.execute(sql)
    assert await _exit_code_type(pool) == "bigint"
    assert (
        await pool.fetchval(
            "SELECT exit_code FROM device_audit WHERE device_id = $1 AND seq = 0", device_id
        )
        == 4294967295
    )


@pytest.mark.parametrize(
    "exit_code",
    [2147942405, 4294967295, -1],
    ids=["windows-access-denied-0x80070005", "uint32-max", "negative-signal-code"],
)
async def test_values_that_broke_int4_store_and_read_back_exactly(pool, exit_code):
    device_id = await _device(pool)
    await _audit_row(pool, device_id, 0, exit_code)
    stored = await pool.fetchval(
        "SELECT exit_code FROM device_audit WHERE device_id = $1 AND seq = 0", device_id
    )
    assert stored == exit_code
