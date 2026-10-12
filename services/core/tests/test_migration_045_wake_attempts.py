"""Migration 045 (S46a T4): wake_attempts, the wake ledger.

Each row is one attempt to wake a machine, and it can only say what its own
columns show: the CHECKs refuse an outcome the evidence on the row does not
carry, so no writer — wake_attempts.py today, anything later — can store
"ready" for a machine whose model never answered. MAC and addresses here are
documentation values (the repo is public)."""

from __future__ import annotations

import uuid
from datetime import datetime
from pathlib import Path

import asyncpg
import pytest

from app.main import MIGRATIONS_DIR
from app.migrations_runner import _migration_number, discover_migrations
from tests.conftest import _TABLES, requires_db

pytestmark = requires_db

MIGRATION = Path(MIGRATIONS_DIR) / "045_wake_attempts.sql"
MAC = "02:00:5e:10:00:01"  # locally administered, not a real card
BROADCAST = "192.0.2.255"  # TEST-NET-1


def _sql() -> str:
    assert MIGRATION.is_file(), f"{MIGRATION.name} does not exist"
    return MIGRATION.read_text(encoding="utf-8")


def test_the_runner_discovers_045_right_after_044():
    names = [f.name for f in discover_migrations(MIGRATIONS_DIR)]
    assert MIGRATION.name in names, f"{MIGRATION.name} not discovered"
    numbers = [_migration_number(Path(n)) for n in names]
    assert numbers.index(45) == numbers.index(44) + 1


def test_conftest_drops_and_truncates_the_table_ahead_of_devices_and_turns():
    assert "wake_attempts" in _TABLES
    assert _TABLES.index("wake_attempts") < _TABLES.index("devices")
    assert _TABLES.index("wake_attempts") < _TABLES.index("turns")


async def test_the_suite_database_has_045_applied(pool):
    applied = {r["filename"] for r in await pool.fetch("SELECT filename FROM schema_migrations")}
    assert MIGRATION.name in applied
    assert "044_no_round_ceiling.sql" in applied


async def test_the_columns_are_the_ledger(pool):
    rows = await pool.fetch(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
        "WHERE table_name = 'wake_attempts'"
    )
    cols = {r["column_name"]: (r["data_type"], r["is_nullable"]) for r in rows}
    assert cols == {
        "id": ("uuid", "NO"),
        "device_id": ("uuid", "NO"),
        "relay_device_id": ("uuid", "YES"),
        "adapter": ("text", "YES"),
        "mac": ("macaddr", "YES"),
        "relay_iface": ("text", "YES"),
        "broadcast": ("inet", "YES"),
        "packets": ("integer", "YES"),
        "trigger": ("text", "NO"),
        "created_at": ("timestamp with time zone", "NO"),
        "sent_at": ("timestamp with time zone", "YES"),
        "deadline_s": ("integer", "NO"),
        "answered_at": ("timestamp with time zone", "YES"),
        "serving_at": ("timestamp with time zone", "YES"),
        "outcome": ("text", "YES"),
        "decided_at": ("timestamp with time zone", "YES"),
        "reason": ("text", "YES"),
        "turn_id": ("uuid", "YES"),
        "test_id": ("uuid", "YES"),
    }


async def test_a_rerun_is_a_no_op(pool):
    sql = _sql()
    async with pool.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        try:
            device = await _device(conn)
            await _insert(conn, device)
            await conn.execute(sql)
            assert await conn.fetchval("SELECT count(*) FROM wake_attempts") == 1
        finally:
            await tx.rollback()


# ── the CHECKs: no outcome the row does not show ───────────────────────────


async def _device(conn, name: str = "box") -> uuid.UUID:
    return await conn.fetchval(
        "INSERT INTO devices (name, platform, hostname, pubkey) "
        "VALUES ($1, 'windows', $1, $2) RETURNING id",
        name,
        "ab" * 32,
    )


_SENT = {
    "adapter": "Wi-Fi",
    "mac": MAC,
    "relay_iface": "eth0",
    "broadcast": BROADCAST,
    "packets": 6,
    "sent_at": "now",
}


async def _insert(conn, device, **cols) -> uuid.UUID:
    row = {"device_id": device, "trigger": "tool", "deadline_s": 120, **_SENT, **cols}
    row = {k: v for k, v in row.items() if v is not _DROP}
    names = list(row)
    values = [_cast(k, v) for k, v in row.items()]
    placeholders = ", ".join(f"${i + 1}" + _TYPES.get(k, "") for i, k in enumerate(names))
    return await conn.fetchval(
        f"INSERT INTO wake_attempts ({', '.join(names)}) VALUES ({placeholders}) RETURNING id",
        *values,
    )


_DROP = object()
_TYPES = {
    "mac": "::macaddr",
    "broadcast": "::inet",
    "sent_at": "::timestamptz",
    "answered_at": "::timestamptz",
    "serving_at": "::timestamptz",
    "decided_at": "::timestamptz",
}


def _cast(key, value):
    if value is None:
        return None
    if key in ("sent_at", "answered_at", "serving_at", "decided_at"):
        return datetime.fromisoformat({"now": T0}.get(value, value))
    if key == "test_id":
        return uuid.UUID(value)
    return value


T0 = "2026-10-11T12:00:00Z"
T30 = "2026-10-11T12:00:30Z"
T60 = "2026-10-11T12:01:00Z"
T200 = "2026-10-11T12:03:20Z"


async def _refused(pool, **cols):
    async with pool.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        try:
            device = await _device(conn)
            with pytest.raises(asyncpg.IntegrityConstraintViolationError):
                await _insert(conn, device, **cols)
        finally:
            await tx.rollback()


async def _accepted(pool, **cols):
    async with pool.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        try:
            device = await _device(conn)
            assert await _insert(conn, device, **cols)
        finally:
            await tx.rollback()


async def test_an_open_sent_attempt_is_accepted(pool):
    await _accepted(pool)


@pytest.mark.parametrize(
    "cols",
    [
        {"trigger": "chat"},
        {"deadline_s": 29},
        {"deadline_s": 601},
        {"outcome": "woke", "decided_at": T60},
        {"outcome": "no_answer", "decided_at": None},
        {"outcome": None, "decided_at": T60},
        # ready needs serving_at; answered needs answered_at and no serving.
        {"outcome": "ready", "decided_at": T60, "answered_at": T30},
        {"outcome": "answered", "decided_at": T60},
        {"outcome": "answered", "decided_at": T60, "answered_at": T30, "serving_at": T60},
        {"outcome": "no_answer", "decided_at": T200, "answered_at": T30},
        {"outcome": "no_answer", "decided_at": T200, "serving_at": T30},
        # evidence before the send, or after the deadline, is not evidence.
        {"answered_at": "2026-10-11T11:59:59Z"},
        {"serving_at": "2026-10-11T11:59:59Z"},
        {"answered_at": T200},
        {"serving_at": T200},
        # a sent row says what was sent where.
        {"mac": None},
        {"adapter": None},
        {"relay_iface": None},
        {"broadcast": None},
        {"packets": 0},
        {"packets": None},
        # nothing sent: only relay_cannot / not_asleep, each with its words.
        {"sent_at": None},
        {"sent_at": None, "outcome": "relay_cannot", "decided_at": T0, "reason": None},
        {"outcome": "relay_cannot", "decided_at": T0, "reason": "no relay"},
        {
            "sent_at": None,
            "outcome": "not_asleep",
            "decided_at": T0,
            "reason": "x",
            "answered_at": T30,
        },
    ],
    ids=lambda c: ",".join(f"{k}={v}" for k, v in c.items()),
)
async def test_the_database_refuses_an_outcome_its_columns_do_not_show(pool, cols):
    await _refused(pool, **cols)


@pytest.mark.parametrize(
    "cols",
    [
        {"answered_at": T30, "serving_at": T60, "outcome": "ready", "decided_at": T60},
        {"serving_at": T60, "outcome": "ready", "decided_at": T60},
        {"answered_at": T30, "outcome": "answered", "decided_at": T200},
        {"outcome": "no_answer", "decided_at": T200},
        {"answered_at": "2026-10-11T12:02:00Z"},  # exactly at the deadline
        {"outcome": "stopped", "decided_at": T30, "reason": "the owner stopped the series"},
        {"outcome": "interrupted", "decided_at": T30, "reason": "core restarted"},
        {"trigger": "route"},
        {"trigger": "test", "test_id": str(uuid.uuid4())},
        {
            "sent_at": None,
            "adapter": None,
            "mac": None,
            "relay_iface": None,
            "broadcast": None,
            "packets": None,
            "relay_device_id": None,
            "outcome": "relay_cannot",
            "decided_at": T0,
            "reason": "no connected agent shares box's network",
        },
        {
            "sent_at": None,
            "relay_iface": None,
            "broadcast": None,
            "packets": None,
            "outcome": "not_asleep",
            "decided_at": T0,
            "reason": "box is connected",
        },
    ],
    ids=lambda c: ",".join(f"{k}={v}" for k, v in c.items()),
)
async def test_the_database_accepts_what_the_evidence_shows(pool, cols):
    await _accepted(pool, **cols)


async def test_one_open_attempt_per_machine(pool):
    async with pool.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        try:
            device = await _device(conn)
            other = await _device(conn, "other")
            await _insert(conn, device)
            await _insert(conn, other)  # another machine's attempt is its own
            # a decided one never blocks
            await _insert(conn, device, outcome="no_answer", decided_at=T200)
            with pytest.raises(asyncpg.UniqueViolationError):
                await _insert(conn, device)
        finally:
            await tx.rollback()


async def test_deleting_a_machine_takes_its_attempts_and_a_relay_leaves_a_null(pool):
    async with pool.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        try:
            target = await _device(conn)
            relay = await _device(conn, "hub")
            kept = await _device(conn, "kept")
            await _insert(conn, target, relay_device_id=relay)
            row = await _insert(conn, kept, relay_device_id=relay)
            await conn.execute("DELETE FROM devices WHERE id = $1", relay)
            assert (
                await conn.fetchval("SELECT relay_device_id FROM wake_attempts WHERE id = $1", row)
                is None
            )
            await conn.execute("DELETE FROM devices WHERE id = $1", target)
            assert await conn.fetchval("SELECT count(*) FROM wake_attempts") == 1
        finally:
            await tx.rollback()
