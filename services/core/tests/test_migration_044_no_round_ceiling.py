"""Migration 044 (no-ceiling, owner 2026-10-08): no count of tool rounds stops a
turn, so the agents.max_tool_rounds setting is gone and its stored row with it.

Same convention as 017's autonomy.graduation_runs: a forward-only DELETE, since
an orphan row would be invisible to the registry (settings_store reads defs
only) and would sit in the table meaning nothing. T6 appends the agents
column drop (its CHECK goes with the column) to this same file: no agent has
rounds any more either."""

from __future__ import annotations

import json
from pathlib import Path

from app import settings_store
from app.main import MIGRATIONS_DIR
from app.migrations_runner import _migration_number, discover_migrations
from tests.conftest import requires_db

pytestmark = requires_db

MIGRATION = Path(MIGRATIONS_DIR) / "044_no_round_ceiling.sql"
ROUNDS_KEY = "agents.max_tool_rounds"
OTHER_KEY = "chat.model"


def _sql() -> str:
    assert MIGRATION.is_file(), f"{MIGRATION.name} does not exist"
    return MIGRATION.read_text(encoding="utf-8")


async def _count(conn, key: str) -> int:
    return await conn.fetchval("SELECT count(*) FROM settings WHERE key = $1", key)


async def test_the_migration_deletes_the_stored_limit_and_keeps_every_other_setting(pool):
    sql = _sql()
    async with pool.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        try:
            await conn.execute(
                "INSERT INTO settings (key, value) "
                "VALUES ($1, '50'::jsonb), ($2, '\"qwen3:8b\"'::jsonb)",
                ROUNDS_KEY,
                OTHER_KEY,
            )
            assert await _count(conn, ROUNDS_KEY) == 1

            await conn.execute(sql)
            assert await _count(conn, ROUNDS_KEY) == 0
            assert (
                await conn.fetchval("SELECT value FROM settings WHERE key = $1", OTHER_KEY)
                == "qwen3:8b"
            )

            await conn.execute(sql)  # a re-run is a no-op, never an error
            assert await _count(conn, ROUNDS_KEY) == 0
            assert await _count(conn, OTHER_KEY) == 1
        finally:
            await tx.rollback()


async def test_every_live_setting_row_survives_the_migration(pool):
    """Every other setting means every def the registry has — the agents.*
    sibling (agents.responsiveness_check) above all, since an IN-list or a
    prefix delete would take it with the limit."""
    sql = _sql()
    keys = sorted(d.key for d in settings_store.SETTING_DEFS)
    assert "agents.responsiveness_check" in keys
    async with pool.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        try:
            await conn.execute("DELETE FROM settings")
            for d in settings_store.SETTING_DEFS:
                await conn.execute(
                    "INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)",
                    d.key,
                    json.dumps(d.default),
                )
            await conn.execute(
                "INSERT INTO settings (key, value) VALUES ($1, '50'::jsonb)", ROUNDS_KEY
            )

            await conn.execute(sql)

            rows = await conn.fetch("SELECT key FROM settings ORDER BY key")
            assert [r["key"] for r in rows] == keys
        finally:
            await tx.rollback()


def test_the_migration_names_only_the_one_key():
    """It deletes by the exact key — never a LIKE that would take another
    agents.* setting (agents.responsiveness_check) with it."""
    sql = _sql()
    assert f"'{ROUNDS_KEY}'" in sql
    assert "LIKE" not in sql.upper()


def test_the_runner_discovers_044_right_after_043():
    names = [f.name for f in discover_migrations(MIGRATIONS_DIR)]
    assert MIGRATION.name in names, f"{MIGRATION.name} not discovered"
    numbers = [_migration_number(Path(n)) for n in names]
    assert numbers.index(44) == numbers.index(43) + 1


async def test_the_suite_database_has_044_applied(pool):
    """conftest runs the real runner over MIGRATIONS_DIR: 044 is recorded, and
    after 043."""
    rows = await pool.fetch("SELECT filename FROM schema_migrations")
    applied = {r["filename"] for r in rows}
    assert MIGRATION.name in applied
    assert "043_chat_sessions.sql" in applied


# ── T6: the per-agent column goes too ──────────────────────────────────────

ROUNDS_COLUMN = "max_tool_rounds"


async def _has_rounds_column(conn) -> bool:
    return await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'agents' AND column_name = $1)",
        ROUNDS_COLUMN,
    )


async def _checks_naming_rounds(conn) -> list[str]:
    rows = await conn.fetch(
        "SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c "
        "JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'agents' AND c.contype = 'c'"
    )
    return [r["def"] for r in rows if ROUNDS_COLUMN in r["def"]]


async def test_the_suite_database_agents_table_has_no_rounds_column(pool):
    """conftest migrates from empty through 044: the column and its CHECK are gone."""
    async with pool.acquire() as conn:
        assert not await _has_rounds_column(conn)
        assert await _checks_naming_rounds(conn) == []


def test_the_migration_drops_the_column_if_it_exists():
    """Forward-only and re-runnable: IF EXISTS, the 017 convention. No separate
    DROP CONSTRAINT — the column-level CHECK goes with the column."""
    sql = " ".join(_sql().split())
    assert "ALTER TABLE agents DROP COLUMN IF EXISTS max_tool_rounds;" in sql
    # The settings DELETE still runs in the same file.
    assert f"DELETE FROM settings WHERE key = '{ROUNDS_KEY}';" in sql


async def _coder_row(conn, stage: str) -> dict:
    """The whole coder row. Each stage gets its own statement text: asyncpg
    caches a prepared `SELECT *` by its text, and re-running a cached one
    after the column drop fails with InvalidCachedStatementError (it cannot
    re-prepare inside the transaction)."""
    return dict(await conn.fetchrow(f"SELECT * FROM agents WHERE name = 'coder' -- {stage}"))


async def test_the_migration_drops_the_column_and_keeps_every_agent_row(pool):
    """On a pre-044 table (the column put back as 021 made it, with a row
    holding a value) the migration drops the column and CHECK; the row and
    every other column survive unchanged; a re-run is a no-op."""
    sql = _sql()
    async with pool.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        try:
            await conn.execute(
                "ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_tool_rounds int NOT NULL "
                "DEFAULT 8 CHECK (max_tool_rounds BETWEEN 1 AND 50)"
            )
            # Whichever state the table is in, a row made without naming the
            # column takes 8 (021 gave it no default).
            await conn.execute("ALTER TABLE agents ALTER COLUMN max_tool_rounds SET DEFAULT 8")
            await conn.execute(
                "INSERT INTO agents (name, purpose, instructions, tools, created_via) "
                "VALUES ('coder', 'writes code', 'be terse', ARRAY['get_time'], 'page')"
            )
            before = await _coder_row(conn, "before")
            assert before[ROUNDS_COLUMN] == 8

            await conn.execute(sql)

            assert not await _has_rounds_column(conn)
            assert await _checks_naming_rounds(conn) == []
            after = await _coder_row(conn, "after")
            before.pop(ROUNDS_COLUMN)
            assert after == before

            await conn.execute(sql)  # a re-run is a no-op, never an error
            assert not await _has_rounds_column(conn)
            assert await _coder_row(conn, "rerun") == after
        finally:
            await tx.rollback()
