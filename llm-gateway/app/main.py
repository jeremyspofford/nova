"""Nova LLM Gateway — main entrypoint."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from app.config import settings
from app.discovery import discovery_router
from app.health import health_router
from app.openai_router import openai_router
from app.router import router
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from nova_contracts.logging import configure_logging
from nova_worker_common.admin_secret import AdminSecretResolver
from nova_worker_common.service_auth import (
    TrustedNetworkMiddleware,
    create_admin_auth_dep,
    load_trusted_cidrs_from_env,
    parse_cidrs,
)

configure_logging("llm-gateway", settings.log_level)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # FC-002: refuse to start with the literal default or empty admin secret.
    # An unset/default secret silently accepts every X-Admin-Secret header in dev
    # configurations and is the most common production-misconfiguration footgun.
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

    log.info("LLM Gateway starting")
    # Set API keys from config into LiteLLM env
    if settings.anthropic_api_key:
        os.environ["ANTHROPIC_API_KEY"] = settings.anthropic_api_key
    if settings.openai_api_key:
        os.environ["OPENAI_API_KEY"] = settings.openai_api_key

    # One-time migration: retire legacy nova:config:llm.ollama_url.
    # The dual-key transition shipped with the bundled-Ollama refactor; this
    # migration copies any value to the canonical inference.url and deletes
    # the legacy key. Idempotent: no-op if the legacy key isn't set.
    try:
        import redis.asyncio as aioredis
        _migration_redis = aioredis.from_url(settings.redis_url, decode_responses=True)
        try:
            legacy = await _migration_redis.get("nova:config:llm.ollama_url")
            canonical = await _migration_redis.get("nova:config:inference.url")
            if legacy:
                if not canonical:
                    await _migration_redis.set("nova:config:inference.url", legacy)
                    log.info("Migrated nova:config:llm.ollama_url → inference.url (value: %s)", legacy)
                else:
                    log.info("Both inference.url and llm.ollama_url were set; keeping canonical inference.url, dropping legacy")
                await _migration_redis.delete("nova:config:llm.ollama_url")
        finally:
            await _migration_redis.aclose()
    except Exception as e:
        log.warning("llm.ollama_url migration skipped: %s", e)

    # Auto-register any Ollama models that are pulled but not in the registry
    try:
        from app.registry import sync_ollama_models
        added = await sync_ollama_models()
        if added:
            log.info("Synced %d Ollama model(s) into registry", added)
    except Exception as e:
        log.warning("Failed to sync Ollama models at startup: %s", e)

    # Probe vLLM/sglang at startup so they appear as available in the catalog
    try:
        from app.registry import sync_vllm_models
        added = await sync_vllm_models()
        if added:
            log.info("Synced %d vLLM model(s) into registry", added)
    except Exception as e:
        log.debug("vLLM not available at startup: %s", e)

    # Feature-flags SDK wiring (B7c). See memory-service/app/main.py for
    # canonical comments.
    from pathlib import Path as _Path
    import httpx as _httpx
    from nova_contracts.feature_flags import init_cache_file
    from nova_contracts.feature_flags_http import warm_cache_from_http
    from nova_contracts.feature_flags_pubsub import PubsubSubscriber

    init_cache_file(_Path("/app/data/flag-cache/llm-gateway.json"))
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

    log.info("LLM Gateway ready")
    yield
    log.info("LLM Gateway shutting down")

    # Feature-flags shutdown (B7c)
    try:
        await _flag_subscriber.stop()
    except Exception:
        log.warning("Feature-flags subscriber stop failed", exc_info=True)
    try:
        await _flag_http_client.aclose()
    except Exception:
        log.warning("Feature-flags HTTP client aclose failed", exc_info=True)

    from app.rate_limiter import close as close_rate_limiter
    from app.response_cache import close as close_response_cache
    await close_rate_limiter()
    await close_response_cache()
    from app.editor_tracker import close as close_editor_tracker
    await close_editor_tracker()
    from app.discovery import close_redis as close_discovery_redis
    from app.registry import close_strategy_redis
    await close_discovery_redis()
    await close_strategy_redis()
    await _admin_resolver.close()


app = FastAPI(
    title="Nova LLM Gateway",
    version="0.1.0",
    description="ModelProvider abstraction layer — route any model request to any provider",
    lifespan=lifespan,
)

# ── Auth (SEC-003) ───────────────────────────────────────────────────────────
# Service-level auth: trusted-network bypass (Docker internal, Tailscale, LAN)
# OR X-Admin-Secret. Health endpoints stay open for Docker healthchecks +
# dashboard startup probes. See nova_worker_common/service_auth.py.
_trusted_cidrs = parse_cidrs(settings.trusted_network_cidrs) if settings.trusted_network_cidrs else load_trusted_cidrs_from_env()
_admin_resolver = AdminSecretResolver(redis_url=settings.redis_url, fallback=settings.nova_admin_secret)
_admin_auth = create_admin_auth_dep(_admin_resolver)

app.add_middleware(TrustedNetworkMiddleware, trusted_cidrs=_trusted_cidrs)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_allowed_origins.split(",") if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Health routes stay open — used by Docker healthcheck + dashboard startup screen.
app.include_router(health_router)
app.include_router(health_router, prefix="/v1")  # also expose at /v1/health/* for dashboard proxy
# All other routes require auth.
app.include_router(discovery_router, prefix="/v1", dependencies=[Depends(_admin_auth)])
app.include_router(router, dependencies=[Depends(_admin_auth)])
app.include_router(openai_router, dependencies=[Depends(_admin_auth)])
