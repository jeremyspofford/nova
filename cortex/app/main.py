"""Nova Cortex — autonomous brain service."""
import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from nova_worker_common.admin_secret import AdminSecretResolver
from nova_worker_common.service_auth import (
    TrustedNetworkMiddleware,
    create_admin_auth_dep,
    load_trusted_cidrs_from_env,
    parse_cidrs,
)

from . import loop
from .budget import close_redis as close_budget_redis
from .clients import close_clients, init_clients
from .config import settings
from .db import close_pool, init_pool
from .health import health_router
from .journal import close_notify_redis
from .router import cortex_router
from .stimulus import close_redis

logging.basicConfig(level=getattr(logging, settings.log_level, logging.INFO))
log = logging.getLogger("nova.cortex")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # FC-002: refuse to start with the literal default admin secret.
    if settings.admin_secret == "nova-admin-secret-change-me":
        if os.getenv("NOVA_ALLOW_DEFAULT_ADMIN_SECRET") != "1":
            raise RuntimeError(
                "NOVA_ADMIN_SECRET is set to the literal default. "
                "Run scripts/install.sh to generate a strong secret, "
                "or set NOVA_ALLOW_DEFAULT_ADMIN_SECRET=1 to bypass (dev/test only)."
            )
        log.warning(
            "NOVA_ADMIN_SECRET is the literal default — bypass active. "
            "Do not use this configuration in production."
        )

    await init_pool()
    await init_clients()
    await loop.start()

    # Recover in-flight tasks from last run
    try:
        from .db import get_pool
        from .task_monitor import dispatch as _monitor_dispatch
        pool = get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT g.id as goal_id, g.current_plan->>'task_id' as task_id
                FROM goals g
                WHERE g.status = 'active'
                  AND g.current_plan->>'task_id' IS NOT NULL
                  AND EXISTS (
                      SELECT 1 FROM tasks t
                      WHERE t.id::text = g.current_plan->>'task_id'
                        AND t.status NOT IN ('complete', 'failed', 'cancelled')
                  )
            """)
            for row in rows:
                if row["task_id"]:
                    _monitor_dispatch(row["task_id"], str(row["goal_id"]), 0, "recovered")
            if rows:
                log.info("Recovered %d in-flight tasks from previous run", len(rows))
    except Exception as e:
        log.warning("Failed to recover in-flight tasks: %s", e)

    # Feature-flags SDK wiring (B7d). See memory-service/app/main.py for
    # canonical comments.
    from pathlib import Path as _Path
    import httpx as _httpx
    from nova_contracts.feature_flags import init_cache_file
    from nova_contracts.feature_flags_http import warm_cache_from_http
    from nova_contracts.feature_flags_pubsub import PubsubSubscriber

    init_cache_file(_Path("/app/data/flag-cache/cortex.json"))
    _flag_http_client = _httpx.AsyncClient(timeout=5.0)
    _flag_orch_url = settings.orchestrator_url.rstrip("/")
    try:
        await warm_cache_from_http(_flag_http_client, _flag_orch_url)
    except Exception:
        log.warning("Feature-flags warm at startup hit an unexpected error",
                    exc_info=True)
    _flag_subscriber = PubsubSubscriber(
        redis_url=settings.redis_url,
        http_client=_flag_http_client,
        base_url=_flag_orch_url,
    )
    await _flag_subscriber.start()
    log.info("Feature-flags pubsub subscriber started")

    log.info("Cortex service ready — port %s, cycle interval %ds",
             settings.port, settings.cycle_interval_seconds)

    yield

    log.info("Cortex shutting down")

    # Feature-flags shutdown (B7d)
    try:
        await _flag_subscriber.stop()
    except Exception:
        log.warning("Feature-flags subscriber stop failed", exc_info=True)
    try:
        await _flag_http_client.aclose()
    except Exception:
        log.warning("Feature-flags HTTP client aclose failed", exc_info=True)

    await loop.stop()
    await close_clients()
    await close_redis()
    await close_budget_redis()
    await close_notify_redis()
    await _admin_resolver.close()
    await close_pool()


app = FastAPI(
    title="Nova Cortex",
    version="0.1.0",
    description="Autonomous brain service — thinking loop, goals, drives",
    lifespan=lifespan,
)

# ── Auth (SEC-004) ───────────────────────────────────────────────────────────
_trusted_cidrs = parse_cidrs(settings.trusted_network_cidrs) if settings.trusted_network_cidrs else load_trusted_cidrs_from_env()
_admin_resolver = AdminSecretResolver(redis_url=settings.redis_url, fallback=settings.admin_secret)
_admin_auth = create_admin_auth_dep(_admin_resolver)

app.add_middleware(TrustedNetworkMiddleware, trusted_cidrs=_trusted_cidrs)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_allowed_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)  # open
app.include_router(cortex_router, dependencies=[Depends(_admin_auth)])
