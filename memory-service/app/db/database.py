"""
Database connection pool and session management.
Uses asyncpg via SQLAlchemy async engine for connection pooling.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from app.config import settings
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

log = logging.getLogger(__name__)

engine = create_async_engine(
    settings.database_url,
    echo=settings.db_echo,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_pre_ping=True,  # detect stale connections
)

AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


@asynccontextmanager
async def get_db():
    """Async context manager providing a database session with auto-commit/rollback."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def run_schema_migrations(*, max_retries: int = 10, delay: float = 2.0) -> None:
    """Execute schema.sql on startup. Idempotent — uses IF NOT EXISTS throughout.

    Retries on connection errors to handle Postgres still starting up.
    """
    import re

    schema_path = Path(__file__).parent / "schema.sql"
    sql = schema_path.read_text()
    # Strip single-line comments BEFORE splitting on ';' to avoid false splits
    # when a comment contains a semicolon (e.g. "-- note; see also X").
    sql_stripped = re.sub(r"--[^\n]*", "", sql)
    # Extract DO $$ ... $$; blocks before splitting on ';' — they contain internal semicolons
    do_blocks: list[str] = []

    def _replace_do(m: re.Match) -> str:
        do_blocks.append(m.group(0))
        return f"__DO_BLOCK_{len(do_blocks) - 1}__"

    sql_safe = re.sub(
        r"DO\s+\$\$.*?\$\$\s*;", _replace_do, sql_stripped, flags=re.DOTALL
    )

    import asyncio

    for attempt in range(1, max_retries + 1):
        try:
            async with engine.begin() as conn:
                for statement in sql_safe.split(";"):
                    stmt = statement.strip()
                    if not stmt:
                        continue
                    m = re.match(r"__DO_BLOCK_(\d+)__", stmt)
                    if m:
                        await conn.exec_driver_sql(do_blocks[int(m.group(1))])
                    else:
                        await conn.exec_driver_sql(stmt)
            log.info("Schema migrations applied")
            return
        except Exception as exc:
            if attempt == max_retries:
                log.error(
                    "Failed to connect to database after %d attempts: %s",
                    max_retries,
                    exc,
                )
                raise
            log.warning(
                "Database not ready (attempt %d/%d): %s — retrying in %.0fs",
                attempt,
                max_retries,
                exc,
                delay,
            )
            await asyncio.sleep(delay)
