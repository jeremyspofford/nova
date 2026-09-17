"""FastAPI entrypoint for the memory service."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import asyncpg
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api import router as memory_router
from app.api import start_vector_backfill, warm_context
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
    # Then the vectors for it, from the cache where possible — on a BACKGROUND
    # task, and deliberately NOT awaited.
    #
    # It was awaited until 2026-09-09, under a whole-pass budget, and the
    # result on the running stack was a log line reading "embedding pass
    # covered 16/75 units and then stopped: the embedding service did not
    # answer within 5s". Nothing was wrong with the service; the budget was
    # on the pass instead of on the call, so a healthy embedder read as a
    # broken one and the backlog never filled. Boot must not wait for work
    # that takes as long as the corpus is big, and the pass must be free to
    # take that long. app.api._backfill_loop says the rest.
    #
    # Never fatal and never quiet: the embedding model is the owner's to pull,
    # so a deployment without one is an ordinary state — it serves lexical
    # recall and every /recall says so — and the pass logs which
    # unavailability it hit, retries it, and logs again when it gives up.
    pass_task = start_vector_backfill()
    try:
        yield
    finally:
        # A pass mid-flight at shutdown is cancelled rather than abandoned:
        # an abandoned task logs "Task was destroyed but it is pending" and
        # nothing says which pass it was. Every vector it had already paid for
        # is on disk (VectorCache.add appends as it goes), so the next start
        # resumes from there and re-embeds nothing.
        if pass_task is not None and not pass_task.done():
            pass_task.cancel()
            with suppress(asyncio.CancelledError):
                await pass_task


app = FastAPI(title=SERVICE_NAME, lifespan=lifespan)
app.middleware("http")(bearer_auth_middleware)
app.include_router(memory_router)


@app.exception_handler(StarletteHTTPException)
async def stated_error(request, exc: StarletteHTTPException) -> JSONResponse:
    """Every refusal in this service has the same shape: {"error": reason}.

    Mirrors core's and gateway's handler (three-service convention) — memory
    was the one service still answering FastAPI's default {"detail": ...}
    for a plain HTTPException, an inconsistency the S2 seam-hygiene batch
    closes (slice-01-carries.md).
    """
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
