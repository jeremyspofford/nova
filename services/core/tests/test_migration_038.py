"""Migration 038 (S42b): re-pair codes, audit epochs, the door, a revoked
agent's knocks, and the update ledger — each a column or constraint the slice
reads, pinned here so a later migration cannot quietly drop one."""

from __future__ import annotations

import uuid
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import asyncpg
import pytest

from app.main import MIGRATIONS_DIR
from app.migrations_runner import discover_migrations, run_migrations
from tests.conftest import TEST_DSN, requires_db

pytestmark = requires_db

MIGRATION = Path(MIGRATIONS_DIR) / "038_agent_lifecycle.sql"


async def _columns(pool, table: str) -> set[str]:
    rows = await pool.fetch(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = $1",
        table,
    )
    return {r["column_name"] for r in rows}


async def _device(pool) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO devices (name, platform, hostname, pubkey) "
        "VALUES ($1, 'linux', 'h', $2) RETURNING id",
        f"m-{uuid.uuid4().hex[:6]}",
        "ab" * 32,
    )


async def test_the_columns_the_slice_reads_exist(pool):
    assert {"device_id", "name"} <= await _columns(pool, "pairing_codes")
    assert {"audit_epoch", "last_transport", "last_refused_at"} <= await _columns(pool, "devices")
    assert "epoch" in await _columns(pool, "device_audit")
    assert {
        "device_id",
        "from_version",
        "version",
        "sha256",
        "path",
        "requested_by",
        "sent_at",
        "outcome",
        "outcome_at",
        "reason",
    } <= await _columns(pool, "agent_updates")


async def test_the_door_is_one_of_the_known_doors_or_unknown(pool):
    device = await _device(pool)
    await pool.execute("UPDATE devices SET last_transport = 'host' WHERE id = $1", device)
    await pool.execute("UPDATE devices SET last_transport = NULL WHERE id = $1", device)
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute("UPDATE devices SET last_transport = 'lan' WHERE id = $1", device)


async def test_the_audit_chain_is_keyed_by_epoch(pool):
    cols = await pool.fetch(
        "SELECT a.attname FROM pg_index i "
        "JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) "
        "WHERE i.indrelid = 'device_audit'::regclass AND i.indisprimary"
    )
    assert {c["attname"] for c in cols} == {"device_id", "epoch", "seq"}


async def test_one_update_in_flight_at_a_time(pool):
    a, b = await _device(pool), await _device(pool)
    insert = (
        "INSERT INTO agent_updates (device_id, version, sha256, path, requested_by) "
        "VALUES ($1, 'aaaaaaaaaaaa', $2, 'capability', 'nova')"
    )
    await pool.execute(insert, a, "c" * 64)
    with pytest.raises(asyncpg.UniqueViolationError):
        await pool.execute(insert, b, "c" * 64)
    await pool.execute(
        "UPDATE agent_updates SET outcome = 'confirmed', outcome_at = now() WHERE device_id = $1", a
    )
    await pool.execute(insert, b, "c" * 64)  # the first is decided: the next may go


async def test_an_open_attempt_has_no_outcome_time_and_a_decided_one_has_one(pool):
    device = await _device(pool)
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute(
            "INSERT INTO agent_updates (device_id, version, sha256, path, requested_by, outcome) "
            "VALUES ($1, 'aaaaaaaaaaaa', $2, 'capability', 'nova', 'confirmed')",
            device,
            "c" * 64,
        )


async def test_the_migration_runs_twice(pool):
    await pool.execute(MIGRATION.read_text(encoding="utf-8"))


def _scoped_dsn(schema: str) -> str:
    """TEST_DSN, but every unqualified name this connection creates or reads
    resolves inside `schema` — never `public`, where the rest of the suite's
    (once 038 exists) already-migrated schema lives."""
    parts = urlsplit(TEST_DSN)
    query = dict(parse_qsl(parts.query))
    query["options"] = f"-csearch_path={schema}"
    return urlunsplit(parts._replace(query=urlencode(query)))


async def test_an_upgrade_with_existing_rows_keeps_them_and_038_reruns_clean(tmp_path):
    """The realistic deploy shape the tests above cannot reach: a database
    already at 037, carrying a device, its audit chain and a pairing code
    from before 038 existed. run_migrations takes a directory, not a target
    number, so "migrate to 037" is staged honestly — by copying the real
    files numbered <= 37 into their own directory and running the same
    unmodified runner over it, never a parallel reimplementation and never
    fake SQL. It runs inside its own schema (never `public`, which the rest
    of the suite owns), so it cannot collide with any other test's tables."""
    schema = "s42b_mig038_upgrade_test"
    admin = await asyncpg.connect(TEST_DSN)
    try:
        await admin.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
        await admin.execute(f"CREATE SCHEMA {schema}")
    finally:
        await admin.close()
    scoped = _scoped_dsn(schema)
    try:
        staged = tmp_path / "upto037"
        staged.mkdir()
        for f in discover_migrations(MIGRATION.parent):
            if int(f.name.split("_", 1)[0]) <= 37:
                (staged / f.name).symlink_to(f)
        await run_migrations(scoped, staged)

        conn = await asyncpg.connect(scoped)
        try:
            device_id = await conn.fetchval(
                "INSERT INTO devices (name, platform, hostname, pubkey) "
                "VALUES ('pre-038', 'linux', 'h', $1) RETURNING id",
                "ab" * 32,
            )
            await conn.execute(
                "INSERT INTO device_audit (device_id, seq, prev_hash, hash, ts, ok) "
                "VALUES ($1, 0, NULL, 'h0', now(), true), ($1, 1, 'h0', 'h1', now(), true)",
                device_id,
            )
            code_id = await conn.fetchval(
                "INSERT INTO pairing_codes (code_hash, expires_at) "
                "VALUES ('pre038hash', now() + interval '10 minutes') RETURNING id"
            )
        finally:
            await conn.close()

        # The real 038 file, same directory, same runner — the upgrade a
        # live install actually performs: N-1 already applied, N lands.
        (staged / MIGRATION.name).symlink_to(MIGRATION)
        await run_migrations(scoped, staged)

        conn = await asyncpg.connect(scoped)
        try:
            epochs = [
                r["epoch"]
                for r in await conn.fetch(
                    "SELECT epoch FROM device_audit WHERE device_id = $1 ORDER BY seq",
                    device_id,
                )
            ]
            assert epochs == [0, 0]
            assert (
                await conn.fetchval("SELECT audit_epoch FROM devices WHERE id = $1", device_id) == 0
            )

            # the pre-existing pairing code takes the new column exactly
            # like a freshly minted one would
            assert (
                await conn.fetchval("SELECT device_id FROM pairing_codes WHERE id = $1", code_id)
                is None
            )
            await conn.execute(
                "UPDATE pairing_codes SET device_id = $1, name = 'reclaimed' WHERE id = $2",
                device_id,
                code_id,
            )

            pk_cols = {
                r["attname"]
                for r in await conn.fetch(
                    "SELECT a.attname FROM pg_index i "
                    "JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) "
                    "WHERE i.indrelid = $1::regclass AND i.indisprimary",
                    f"{schema}.device_audit",
                )
            }
            assert pk_cols == {"device_id", "epoch", "seq"}

            # P9 holds for data this schema carried across the upgrade, not
            # only for rows inserted after it — a second device, paired only
            # post-upgrade, still cannot send while the first is in flight.
            await conn.execute(
                "INSERT INTO agent_updates (device_id, version, sha256, path, requested_by) "
                "VALUES ($1, 'aaaaaaaaaaaa', $2, 'capability', 'nova')",
                device_id,
                "c" * 64,
            )
            other_device = await conn.fetchval(
                "INSERT INTO devices (name, platform, hostname, pubkey) "
                "VALUES ('post-038', 'linux', 'h', $1) RETURNING id",
                "cd" * 32,
            )
            with pytest.raises(asyncpg.UniqueViolationError):
                await conn.execute(
                    "INSERT INTO agent_updates (device_id, version, sha256, path, requested_by) "
                    "VALUES ($1, 'bbbbbbbbbbbb', $2, 'capability', 'nova')",
                    other_device,
                    "d" * 64,
                )

            # Re-running the migration's own SQL — not just the tracking
            # table's skip-if-applied path — against a schema that now has
            # both the new shape and the carried-over data changes nothing.
            sql = MIGRATION.read_text(encoding="utf-8")
            await conn.execute(sql)
            await conn.execute(sql)

            epochs_again = [
                r["epoch"]
                for r in await conn.fetch(
                    "SELECT epoch FROM device_audit WHERE device_id = $1 ORDER BY seq",
                    device_id,
                )
            ]
            assert epochs_again == [0, 0]
            assert (
                await conn.fetchval(
                    "SELECT count(*) FROM agent_updates WHERE device_id = $1", device_id
                )
                == 1
            )
        finally:
            await conn.close()
    finally:
        admin = await asyncpg.connect(TEST_DSN)
        try:
            await admin.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
        finally:
            await admin.close()
