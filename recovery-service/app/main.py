"""
Nova Recovery Service — resilient backup, restore, and disaster recovery.

Designed to stay alive when all other Nova services are down.
Only depends on: Postgres (for backups) and Docker socket (for service management).
"""

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from nova_worker_common.service_auth import (
    TrustedNetworkMiddleware,
    load_trusted_cidrs_from_env,
)

from .config import settings
from .inference.routes import router as inference_router
from .routes import router

logger = logging.getLogger("nova.recovery")


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio

    from .db import close_pool, init_pool
    from .inference.hardware import sync_hardware_from_file
    from .redis_client import close_redis
    from .scheduler import checkpoint_loop

    # FC-002: refuse to start with the literal default admin secret.
    if settings.admin_secret == "nova-admin-secret-change-me":
        if os.getenv("NOVA_ALLOW_DEFAULT_ADMIN_SECRET") != "1":
            raise RuntimeError(
                "NOVA_ADMIN_SECRET is set to the literal default. "
                "Run scripts/install.sh to generate a strong secret, "
                "or set NOVA_ALLOW_DEFAULT_ADMIN_SECRET=1 to bypass (dev/test only)."
            )
        logger.warning(
            "NOVA_ADMIN_SECRET is the literal default — bypass active. "
            "Do not use this configuration in production."
        )

    await init_pool()
    checkpoint_task = asyncio.create_task(checkpoint_loop())

    # Sync hardware info from data/hardware.json (written by setup.sh) into Redis
    try:
        await sync_hardware_from_file()
    except Exception:
        logger.warning("Hardware sync failed — will detect on first request", exc_info=True)

    logger.info("Recovery service ready — port %s, backups at %s", settings.port, settings.backup_dir)
    yield
    checkpoint_task.cancel()
    await close_pool()
    await close_redis()


app = FastAPI(
    title="Nova Recovery Service",
    version="0.1.0",
    lifespan=lifespan,
)

# Trusted-network middleware stamps request.state.is_trusted_network so admin
# routes can bypass auth for callers on loopback / Docker bridge / LAN /
# Tailscale — symmetric with orchestrator + memory + cortex + llm-gateway.
app.add_middleware(TrustedNetworkMiddleware, trusted_cidrs=load_trusted_cidrs_from_env())

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_allowed_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
app.include_router(inference_router)
