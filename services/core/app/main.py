"""FastAPI entrypoint for the core service."""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

import asyncpg
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import activity, auth_api, chat, conversations, db, proxies, settings_store, workspace_api
from app.identity import identity_middleware
from app.logging_conf import configure_logging
from app.migrations_runner import run_migrations

SERVICE_NAME = "core"
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
    await db.init_pool()
    try:
        yield
    finally:
        # Let detached work (in-flight turns that outlived their browser,
        # memory ingest, trace closes) finish before the pool it needs
        # disappears.
        await chat.drain_background()
        await db.close_pool()


app = FastAPI(title=SERVICE_NAME, lifespan=lifespan)
app.middleware("http")(identity_middleware)
app.include_router(auth_api.router)
app.include_router(settings_store.router)
app.include_router(conversations.router)
app.include_router(chat.router)
app.include_router(activity.router)
app.include_router(proxies.router)
app.include_router(workspace_api.router)


@app.exception_handler(StarletteHTTPException)
async def stated_error(request, exc: StarletteHTTPException) -> JSONResponse:
    """Every refusal in this service has the same shape: {"error": reason}."""
    return JSONResponse(
        {"error": exc.detail}, status_code=exc.status_code, headers=getattr(exc, "headers", None)
    )


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
