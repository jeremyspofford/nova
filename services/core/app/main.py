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

from app import (
    activity,
    agents_api,
    auth_api,
    beats,
    chat,
    conversations,
    db,
    devices_api,
    devices_ws,
    evals_api,
    governance_api,
    models_catalog,
    notices_api,
    proxies,
    queued,
    scheduler,
    settings_store,
    spend_api,
    timers,
    timers_api,
    traces,
    workspace_api,
)
from app.evals import runner as eval_runner
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
    pool = await db.init_pool()
    # This process is starting, not stopping (S15): begin_shutdown() below is a
    # latch on a module global, and a process that went through a lifespan once
    # already would otherwise never drain another queue.
    chat.accept_queued_turns_again()
    # A fresh process runs no turns, so every NULL-status row is an orphan of
    # the process that died — closed as 'interrupted' here, before any request
    # can read it as pending (traces.sweep_orphaned_turns says why).
    await traces.sweep_orphaned_turns(pool)
    # And the messages the dead process had ACCEPTED but not yet sent (S15). A
    # fresh process runs no turns, so nothing will ever END to trigger their
    # drain: each one is cancelled with a stated reason the owner can read,
    # because a 202 nothing keeps is the worst kind of success to report — and
    # they are not silently sent either, since the box may have been down for
    # days (queued.sweep_stranded says why).
    await queued.sweep_stranded(pool)
    # Same fact for eval suite runs: a fresh process runs no jobs, so every
    # 'running' eval_suite_runs row is a suite the dead process was mid-way
    # through — closed 'interrupted' here, before the page can read it as
    # live (runner.sweep_orphaned_suite_runs says why).
    await eval_runner.sweep_orphaned_suite_runs(pool)
    # And for timer firings: a 'running' firing row belongs to the process that
    # died mid-firing — closed 'interrupted' with the reason before the first
    # tick could read it as live (scheduler.sweep_orphaned_firings). Then the
    # job rows JOBS names are seeded if missing, so the retention job exists on
    # a fresh install without a migration seeding it.
    await scheduler.sweep_orphaned_firings(pool)
    await timers.ensure_jobs(pool)
    # And the beat rows (S11), for the same reason and by the same read-back.
    # A fresh install has no owner yet, so this one can honestly decline —
    # scheduler.run_forever keeps asking on its own ticks until it takes, so a
    # brand new box gets its beats without waiting for a restart.
    await beats.ensure_beats(pool)
    # The scheduler loop is its OWN task, never one of chat._BACKGROUND: a
    # forever task in that set would hang drain_background(). It is cancelled
    # and awaited FIRST at shutdown, so no new firing starts while the detached
    # work below is being drained.
    ticker = asyncio.create_task(scheduler.run_forever(app, pool), name="scheduler")
    app.state.scheduler_task = ticker
    try:
        yield
    finally:
        ticker.cancel()
        await asyncio.gather(ticker, return_exceptions=True)
        # No new queued turns from here (S15). drain_background below waits for
        # every detached task and a drained turn spawns another drain, so a
        # queue still draining could hold the process past its grace period and
        # be SIGKILLed part-way — which is how a claimed message ends up with no
        # reply. Set BEFORE the drain, so the two cannot chase each other.
        chat.begin_shutdown()
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
app.include_router(governance_api.router)
app.include_router(devices_api.router)
app.include_router(devices_ws.router)
app.include_router(evals_api.router)
app.include_router(proxies.router)
app.include_router(models_catalog.router)
app.include_router(spend_api.router)
app.include_router(workspace_api.router)
app.include_router(timers_api.router)
app.include_router(agents_api.router)
app.include_router(notices_api.router)


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
