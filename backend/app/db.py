"""Database connection and migrations."""

import hashlib
import logging
from pathlib import Path

import asyncpg

from app.config import settings

log = logging.getLogger(__name__)

pool: asyncpg.Pool | None = None


async def init_pool():
    global pool
    pool = await asyncpg.create_pool(settings.database_url, min_size=5, max_size=20)
    log.info("Database pool initialized")


async def close_pool():
    global pool
    if pool:
        await pool.close()
        pool = None
        log.info("Database pool closed")


def acquire():
    """Async context manager for a pooled connection: `async with db.acquire() as conn:`"""
    if pool is None:
        raise RuntimeError("Pool not initialized")
    return pool.acquire()


async def run_migrations():
    if pool is None:
        raise RuntimeError("Pool not initialized")

    migrations_dir = Path(__file__).parent / "migrations"
    if not migrations_dir.exists():
        log.info("No migrations directory found, skipping")
        return

    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename   TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ DEFAULT now()
            );
        """)
        # Rows applied before this column existed stay NULL on purpose:
        # hashing them against their CURRENT text would bless whatever drift
        # is already there. NULL reads as "trusted, unverified".
        await conn.execute(
            "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT")

        for migration_file in sorted(migrations_dir.glob("*.sql")):
            filename = migration_file.name
            body = migration_file.read_text()
            digest = hashlib.sha256(body.encode()).hexdigest()
            already = await conn.fetchrow(
                "SELECT checksum FROM schema_migrations WHERE filename = $1", filename)
            if already:
                # Migrations are tracked by FILENAME and never re-run, so
                # editing one that has already been applied is a silent no-op:
                # the repo says one thing, the live DB another, with nothing
                # in between to notice. That has already shipped a dead
                # feature — 037 exists only to repair an edited-after-apply
                # 032, which left raise_recommendation ungranted for days.
                # Loud log, never raise: run_migrations is the first thing
                # lifespan does, so raising crash-loops the backend with no UI
                # left to fix it from, and editing a just-written migration
                # mid-lane is the normal way of working here.
                if already["checksum"] and already["checksum"] != digest:
                    log.error(
                        "Migration %s CHANGED since it was applied — the live "
                        "database does not match the repo. Nothing will re-run "
                        "it; write a follow-up migration with the difference.",
                        filename)
                continue
            log.info("Running migration: %s", filename)
            try:
                # One transaction for the body AND its ledger row: they were
                # separate execute() calls, so a crash in between re-ran the
                # whole migration on the next boot.
                async with conn.transaction():
                    await conn.execute(body)
                    await conn.execute(
                        "INSERT INTO schema_migrations (filename, checksum) "
                        "VALUES ($1, $2)", filename, digest)
            except Exception:
                log.exception("Migration %s failed", filename)
                raise
