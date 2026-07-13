"""Database connection and migrations."""

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

        for migration_file in sorted(migrations_dir.glob("*.sql")):
            filename = migration_file.name
            already = await conn.fetchrow(
                "SELECT 1 FROM schema_migrations WHERE filename = $1", filename)
            if already:
                continue
            log.info("Running migration: %s", filename)
            try:
                await conn.execute(migration_file.read_text())
                await conn.execute(
                    "INSERT INTO schema_migrations (filename) VALUES ($1)", filename)
            except Exception:
                log.exception("Migration %s failed", filename)
                raise
