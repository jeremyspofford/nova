"""
Nova Memory Service — main entrypoint.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from app.config import settings
from app.db.database import AsyncSessionLocal, run_schema_migrations
from app.embedding import close_redis as close_embedding_redis
from app.embedding import get_embedding
from app.engram.consolidation import bootstrap_self_model, consolidation_loop
from app.engram.ingestion import ingestion_loop
from app.engram.neural_router.serve import load_latest_model
from app.engram.router import engram_router
from app.health import health_router
from app.http_client import close_http_client
from fastapi import Depends, FastAPI
from nova_contracts.logging import configure_logging
from nova_worker_common.admin_secret import AdminSecretResolver
from nova_worker_common.service_auth import (
    TrustedNetworkMiddleware,
    create_admin_auth_dep,
    load_trusted_cidrs_from_env,
    parse_cidrs,
)

configure_logging("memory-service", settings.log_level)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # FC-002: refuse to start with the literal default or empty admin secret.
    import os

    if settings.nova_admin_secret in ("", "nova-admin-secret-change-me"):
        if os.getenv("NOVA_ALLOW_DEFAULT_ADMIN_SECRET") != "1":
            raise RuntimeError(
                "NOVA_ADMIN_SECRET is unset or set to the literal default. "
                "Run scripts/install.sh to generate a strong secret, "
                "or set NOVA_ALLOW_DEFAULT_ADMIN_SECRET=1 to bypass (dev/test only)."
            )
        log.warning(
            "NOVA_ADMIN_SECRET bypass active — do not use this configuration in production."
        )

    log.info("Memory Service starting — running schema migrations")
    await run_schema_migrations()

    _ingestion_task = asyncio.create_task(ingestion_loop(), name="engram-ingestion")
    _consolidation_task = asyncio.create_task(
        consolidation_loop(), name="engram-consolidation"
    )
    asyncio.create_task(_warmup_embedding(), name="warmup")
    asyncio.create_task(_verify_decomposition_model(), name="verify-decomp-model")
    asyncio.create_task(_bootstrap_self_model(), name="engram-bootstrap")
    _neural_router_task = asyncio.create_task(
        _neural_router_refresh(), name="neural-router-refresh"
    )
    log.info("Memory Service ready")

    yield

    log.info(
        "Memory Service shutting down — waiting up to 15s for active work to finish"
    )
    # Give tasks a grace period to complete current work before cancelling
    _ingestion_task.cancel()
    _consolidation_task.cancel()
    _neural_router_task.cancel()
    try:
        await asyncio.wait_for(
            asyncio.gather(
                _ingestion_task,
                _consolidation_task,
                _neural_router_task,
                return_exceptions=True,
            ),
            timeout=15.0,
        )
    except asyncio.TimeoutError:
        log.warning("Shutdown grace period expired — some tasks may not have completed")
    await close_embedding_redis()
    await close_http_client()
    await _admin_resolver.close()
    log.info("Memory Service shutdown complete")


async def _neural_router_refresh():
    """Background task: periodically check for newer neural router model."""
    while True:
        try:
            async with AsyncSessionLocal() as session:
                await load_latest_model(session)
        except Exception:
            log.debug("Neural router model refresh failed", exc_info=True)
        await asyncio.sleep(settings.neural_router_model_check_interval)


app = FastAPI(
    title="Nova Memory Service",
    version="0.1.0",
    description="Engram-based cognitive memory backend for Nova agents",
    lifespan=lifespan,
)

# ── Auth (SEC-004) ───────────────────────────────────────────────────────────
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

app.include_router(health_router)  # open
app.include_router(engram_router, dependencies=[Depends(_admin_auth)])


async def _warmup_embedding():
    """Fire a dummy embedding to force the model to load into RAM."""
    try:
        async with AsyncSessionLocal() as session:
            await get_embedding("warmup", session)
        log.info("Embedding warmup complete")
    except Exception:
        log.warning(
            "Embedding warmup failed (model may not be available yet)", exc_info=True
        )


async def _verify_decomposition_model():
    """Verify decomposition model is reachable at startup. Logs a clear warning if not."""
    from app.engram.decomposition import resolve_model

    try:
        model = await resolve_model(settings.engram_decomposition_model)
        log.info("Decomposition model resolved: %s", model)
    except Exception:
        log.warning(
            "Decomposition model unavailable — ingestion will skip decomposition until a model is available"
        )


async def _bootstrap_self_model():
    """Seed default self-model engrams on first run."""
    try:
        async with AsyncSessionLocal() as session:
            created = await bootstrap_self_model(session)
            if created:
                await session.commit()
                log.info("Bootstrapped %d self-model engrams", created)
    except Exception:
        log.debug(
            "Self-model bootstrap skipped (table may not exist yet)", exc_info=True
        )
