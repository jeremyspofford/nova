"""Browser Worker — Playwright automation service for Nova agents."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI

from app.browser import manager
from app.config import settings
from app.routes import router

logging.basicConfig(level=settings.log_level)
log = logging.getLogger(__name__)

_reaper_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # FC-002: refuse to start with the literal default or empty admin secret.
    if settings.nova_admin_secret in ("", "nova-admin-secret-change-me"):
        if os.getenv("NOVA_ALLOW_DEFAULT_ADMIN_SECRET") != "1":
            raise RuntimeError(
                "NOVA_ADMIN_SECRET is unset or set to the literal default. "
                "Run scripts/install.sh to generate a strong secret, "
                "or set NOVA_ALLOW_DEFAULT_ADMIN_SECRET=1 to bypass (dev/test only)."
            )
        log.warning("NOVA_ADMIN_SECRET bypass active — dev/test only.")

    global _reaper_task
    await manager.start()
    _reaper_task = asyncio.create_task(manager.reaper_loop(), name="browser-session-reaper")
    log.info("Browser Worker ready")
    yield
    if _reaper_task:
        _reaper_task.cancel()
    await manager.stop()
    # Close the admin-auth Redis connection (db11) — otherwise it leaks across
    # restarts, the exact pattern CLAUDE.md warns about (TD-09).
    try:
        await _admin_resolver.close()
    except Exception as e:
        log.debug("admin resolver close failed: %s", e)
    log.info("Browser Worker shutdown complete")


app = FastAPI(
    title="Nova Browser Worker",
    version="0.1.0",
    description="Playwright automation: navigate, snapshot, act, submit forms",
    lifespan=lifespan,
)

# ── Auth (SEC-004) ───────────────────────────────────────────────────────────
from nova_worker_common.admin_secret import AdminSecretResolver  # noqa: E402
from nova_worker_common.service_auth import (  # noqa: E402
    TrustedNetworkMiddleware,
    create_admin_auth_dep,
    load_trusted_cidrs_from_env,
    parse_cidrs,
)

_trusted_cidrs = (
    parse_cidrs(settings.trusted_network_cidrs)
    if settings.trusted_network_cidrs
    else load_trusted_cidrs_from_env()
)
_admin_resolver = AdminSecretResolver(
    redis_url=settings.redis_url, fallback=settings.nova_admin_secret
)
_admin_auth = create_admin_auth_dep(_admin_resolver)

app.add_middleware(TrustedNetworkMiddleware, trusted_cidrs=_trusted_cidrs)


@app.get("/health/live")
async def health_live():
    return {"status": "ok", "service": "browser-worker"}


@app.get("/health/ready")
async def health_ready():
    return {"status": "ready", "sessions": manager.session_count()}


app.include_router(router, dependencies=[Depends(_admin_auth)])
