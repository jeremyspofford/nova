"""Database connection and migrations."""

import asyncpg
import logging
from pathlib import Path
from app.config import settings

log = logging.getLogger(__name__)

pool = None


async def init_pool():
    """Initialize the database connection pool."""
    global pool
    pool = await asyncpg.create_pool(
        settings.database_url,
        min_size=5,
        max_size=20,
    )
    log.info("Database pool initialized")


async def close_pool():
    """Close the database connection pool."""
    global pool
    if pool:
        await pool.close()
        log.info("Database pool closed")


async def get_connection():
    """Get a connection from the pool."""
    return pool.acquire()


async def run_migrations():
    """Run SQL migrations from migrations/ directory."""
    if not pool:
        raise RuntimeError("Pool not initialized")

    migrations_dir = Path(__file__).parent / "migrations"
    if not migrations_dir.exists():
        log.info("No migrations directory found, skipping migrations")
        return

    async with pool.acquire() as conn:
        # Create schema_migrations table if it doesn't exist
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ DEFAULT now()
            );
        """)

        # Run all migrations in order
        migration_files = sorted(migrations_dir.glob("*.sql"))
        for migration_file in migration_files:
            filename = migration_file.name

            # Check if already applied
            result = await conn.fetch("SELECT 1 FROM schema_migrations WHERE filename = $1", filename)
            if result:
                log.debug(f"Migration {filename} already applied")
                continue

            # Read and execute migration
            with open(migration_file) as f:
                migration_sql = f.read()

            log.info(f"Running migration: {filename}")
            try:
                await conn.execute(migration_sql)
                await conn.execute("INSERT INTO schema_migrations (filename) VALUES ($1)", filename)
            except Exception as e:
                log.error(f"Migration {filename} failed: {e}")
                raise
