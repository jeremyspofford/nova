#!/usr/bin/env python3
"""Idempotent setup for memory-service unit-test database.

Creates nova_test DB, installs pgvector + pg_trgm extensions, applies
the engram schema. Re-running drops nothing — safe to invoke before
every test session. Pass --reset to drop and recreate.

Connects via asyncpg (already a memory-service dependency). No host-level
psql install needed; matches Nova's "ships with everything" posture.

Usage:
    cd memory-service
    uv run scripts/setup_test_db.py
    uv run scripts/setup_test_db.py --reset
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

import asyncpg


SCHEMA_FILE = Path(__file__).resolve().parent.parent / "app" / "db" / "schema.sql"


def _autoload_env() -> None:
    """Load repo-root .env if present so POSTGRES_PASSWORD overrides apply.

    `uv run` does not auto-load .env; pydantic-settings does, but our raw
    scripts use os.environ directly. Symlinking .env into a worktree (or
    leaving the main worktree's .env in place) lets users override
    Postgres credentials without setting shell env vars.
    """
    # memory-service/scripts/foo.py → ../../ is the repo root
    env_file = Path(__file__).resolve().parent.parent.parent / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        # Don't clobber values already set via shell
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _conn_kwargs(database: str) -> dict:
    """Build asyncpg connect kwargs from POSTGRES_* env vars; defaults match docker-compose."""
    _autoload_env()
    return {
        "user": os.environ.get("POSTGRES_USER", "nova"),
        "password": os.environ.get("POSTGRES_PASSWORD", "nova_dev_password"),
        "host": os.environ.get("POSTGRES_HOST", "localhost"),
        "port": int(os.environ.get("POSTGRES_PORT", "5432")),
        "database": database,
    }


def _test_db_name() -> str:
    return os.environ.get("TEST_DB_NAME", "nova_test")


async def _database_exists(conn: asyncpg.Connection, name: str) -> bool:
    return bool(await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", name))


async def _setup(reset: bool) -> None:
    db_name = _test_db_name()

    # 1. Connect to the maintenance DB to create/drop the test DB
    admin = await asyncpg.connect(**_conn_kwargs("postgres"))
    try:
        if reset:
            print(f"[setup_test_db] --reset: dropping {db_name}")
            # Identifier interpolation only — no user-supplied input
            await admin.execute(f'DROP DATABASE IF EXISTS "{db_name}"')

        if not await _database_exists(admin, db_name):
            owner = _conn_kwargs("postgres")["user"]
            print(f"[setup_test_db] creating database {db_name} (owner={owner})")
            await admin.execute(f'CREATE DATABASE "{db_name}" OWNER "{owner}"')
        else:
            print(f"[setup_test_db] {db_name} already exists; skipping CREATE")
    finally:
        await admin.close()

    # 2. Apply schema to the test DB (IF NOT EXISTS guards make this idempotent)
    if not SCHEMA_FILE.exists():
        sys.exit(f"[setup_test_db] FATAL: schema file not found at {SCHEMA_FILE}")
    schema_sql = SCHEMA_FILE.read_text()
    print(f"[setup_test_db] applying schema from {SCHEMA_FILE}")

    test_conn = await asyncpg.connect(**_conn_kwargs(db_name))
    try:
        # asyncpg's simple-query protocol (no parameters) supports multi-statement SQL
        await test_conn.execute(schema_sql)
    finally:
        await test_conn.close()

    print(f"[setup_test_db] {db_name} ready")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--reset", action="store_true", help="Drop and recreate the test DB")
    args = parser.parse_args()
    asyncio.run(_setup(reset=args.reset))


if __name__ == "__main__":
    main()
