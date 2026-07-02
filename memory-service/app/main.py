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
from app.memory_router import memory_router
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
    _okf_maintenance_task = asyncio.create_task(
        _okf_maintenance_loop(), name="okf-maintenance"
    )

    # Feature-flags SDK wiring (Phase B7b). Cold-boot fallback file lives in
    # /app/data/flag-cache (ephemeral across image rebuilds; preserved across
    # restarts; SR3 partition behavior holds within a single deployed image
    # version). Host bind-mount for cross-rebuild persistence is a follow-up.
    from pathlib import Path as _Path

    import httpx as _httpx
    from nova_contracts.feature_flags import init_cache_file
    from nova_contracts.feature_flags_http import warm_cache_from_http
    from nova_contracts.feature_flags_pubsub import PubsubSubscriber

    _flag_cache_path = _Path("/app/data/flag-cache/memory-service.json")
    init_cache_file(_flag_cache_path)
    log.info("Feature-flags cache file initialized: %s", _flag_cache_path)

    _flag_http_client = _httpx.AsyncClient(timeout=5.0)
    _flag_orch_url = settings.orchestrator_url.rstrip("/")
    try:
        await warm_cache_from_http(_flag_http_client, _flag_orch_url)
    except Exception:
        # warm_cache_from_http already logs WARNING on failure; the fallback
        # is whatever was on disk + in-code defaults. Memory-service starts
        # regardless so a partition can't pin it down.
        log.warning(
            "Feature-flags warm at startup hit an unexpected error",
            exc_info=True,
        )

    _flag_subscriber = PubsubSubscriber(
        redis_url=settings.redis_url,
        http_client=_flag_http_client,
        base_url=_flag_orch_url,
    )
    await _flag_subscriber.start()
    log.info("Feature-flags pubsub subscriber started")

    log.info("Memory Service ready")

    yield

    log.info(
        "Memory Service shutting down — waiting up to 15s for active work to finish"
    )

    # Feature-flags shutdown (B7b). Stop subscriber first so it won't try
    # to refetch during teardown; then close the HTTP client.
    try:
        await _flag_subscriber.stop()
    except Exception:
        log.warning("Feature-flags subscriber stop failed", exc_info=True)
    try:
        await _flag_http_client.aclose()
    except Exception:
        log.warning("Feature-flags HTTP client aclose failed", exc_info=True)

    # Give tasks a grace period to complete current work before cancelling
    _ingestion_task.cancel()
    _consolidation_task.cancel()
    _neural_router_task.cancel()
    _okf_maintenance_task.cancel()
    try:
        await asyncio.wait_for(
            asyncio.gather(
                _ingestion_task,
                _consolidation_task,
                _neural_router_task,
                _okf_maintenance_task,
                return_exceptions=True,
            ),
            timeout=15.0,
        )
    except asyncio.TimeoutError:
        log.warning("Shutdown grace period expired — some tasks may not have completed")
    await close_embedding_redis()
    from app.backends import close_config_redis
    await close_config_redis()
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


async def _okf_maintenance_loop():
    """Retention backstop for the OKF backend: archive old journal files and
    refresh the BM25 index every 6h. Runs regardless of brain_enabled so the
    journal inbox can't grow unbounded; the LLM-driven curation goal is the
    quality layer on top."""
    from app.backends import current_backend_name, get_backend

    while True:
        await asyncio.sleep(6 * 3600)
        try:
            if await current_backend_name() == "okf":
                backend = await get_backend()
                stats = await backend.consolidate()
                if stats.get("journals_archived"):
                    log.info("OKF maintenance: %s", stats)
        except Exception:
            log.warning("OKF maintenance cycle failed", exc_info=True)


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
# Neutral backend-agnostic surface — the only API consumers should target.
app.include_router(memory_router, dependencies=[Depends(_admin_auth)])
# Engram-internal inspection surface (graph, consolidation log, sources).
# Only meaningful while memory.backend=engram; stays mounted because backend
# selection is runtime config and FastAPI routes are fixed at startup.
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
