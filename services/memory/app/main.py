"""FastAPI entrypoint for the memory service."""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

import asyncpg
from fastapi import FastAPI

from app.api import router as memory_router
from app.api import warm_context
from app.auth import bearer_auth_middleware
from app.logging_conf import configure_logging
from app.migrations_runner import run_migrations

SERVICE_NAME = "memory"
SERVICE_VERSION = "0.0.1"
MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"

configure_logging(SERVICE_NAME)
logger = logging.getLogger(SERVICE_NAME)


@asynccontextmanager
async def lifespan(app: FastAPI):
    dsn = os.environ.get("DATABASE_URL", "")
    if not dsn:
        raise RuntimeError("DATABASE_URL unset — cannot run migrations")
    try:
        await run_migrations(dsn, MIGRATIONS_DIR)
    except Exception:
        logger.exception("migrations failed — refusing to start")
        raise
    # Full rescan now rather than on the first /recall — see
    # app.api.warm_context for why this makes "built by full rescan at
    # startup" literally true in the running service.
    warm_context()
    yield


app = FastAPI(title=SERVICE_NAME, lifespan=lifespan)
app.middleware("http")(bearer_auth_middleware)
app.include_router(memory_router)


@app.get("/health/live")
async def health_live() -> dict:
    return {"status": "live"}


@app.get("/status")
async def status() -> dict:
    return {
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "db_reachable": await _db_reachable(),
    }


async def _db_reachable() -> bool:
    dsn = os.environ.get("DATABASE_URL", "")
    if not dsn:
        return False
    try:
        conn = await asyncio.wait_for(asyncpg.connect(dsn), timeout=1.0)
    except Exception:
        return False
    await conn.close()
    return True
