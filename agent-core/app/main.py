# agent-core/app/main.py
import asyncpg
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from .config import settings
from .db import close_pool, get_pool
from nova_contracts import HealthStatus

logging.basicConfig(level=settings.log_level)
logger = logging.getLogger(__name__)


async def run_migrations(pool: asyncpg.Pool) -> None:
    migrations_dir = Path(__file__).parent / "migrations"
    sql_files = sorted(migrations_dir.glob("*.sql"))
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ DEFAULT now()
            )
        """)
        applied = {r["filename"] for r in await conn.fetch("SELECT filename FROM schema_migrations")}
        for f in sql_files:
            if f.name not in applied:
                logger.info(f"Running migration: {f.name}")
                async with conn.transaction():
                    await conn.execute(f.read_text())
                    await conn.execute("INSERT INTO schema_migrations (filename) VALUES ($1)", f.name)


@asynccontextmanager
async def lifespan(app: FastAPI):
    pool = await get_pool()
    await run_migrations(pool)
    logger.info("agent-core started")
    yield
    await close_pool()
    logger.info("agent-core stopped")


app = FastAPI(title="agent-core", version="2.0.0", lifespan=lifespan)


@app.get("/health/live")
async def health_live():
    return {"status": "ok"}


@app.get("/health/ready")
async def health_ready():
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        db_ok = True
    except Exception as exc:
        logger.warning("DB health check failed: %s", exc)
        db_ok = False
    status = "ok" if db_ok else "error"
    return HealthStatus(status=status, service="agent-core", checks={"db": db_ok})
