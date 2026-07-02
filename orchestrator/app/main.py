"""Nova Orchestrator — main entrypoint."""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from app.auth_router import router as auth_router
from app.capabilities.router import router as capabilities_router
from app.clients import close_clients
from app.config import settings
from app.db import close_db, init_db
from app.friction_router import router as friction_router
from app.goals_router import goals_router
from app.health import health_router
from app.intel_router import intel_router
from app.knowledge_router import knowledge_router
from app.pipeline_router import router as pipeline_router
from app.queue import queue_worker
from app.reaper import cleanup_stale_running_on_startup, reaper_loop
from app.router import router
from app.stimulus import close_redis as close_stimulus_redis
from app.store import close_redis, ensure_primary_agent, recover_stale_agents
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from nova_contracts.logging import configure_logging

configure_logging("orchestrator", settings.log_level)
log = logging.getLogger(__name__)


async def _ensure_default_tenant() -> None:
    """Idempotently re-seed the default tenant and the synthetic-admin user.

    Migration 020 seeds the tenant once, but a factory reset / data wipe can
    clear these tables without re-running migrations — leaving tenant-scoped
    inserts (usage_events) and the trusted-network admin (conversations,
    which FK to users.id) to fail. Re-seeding on every boot self-heals both.
    The synthetic admin id/tenant mirror auth._SYNTHETIC_ADMIN so trusted-
    network / dev sessions can persist conversations.
    """
    from app.db import get_pool

    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            tenant_row = await conn.fetchrow(
                """
                INSERT INTO tenants (id, name)
                VALUES ('00000000-0000-0000-0000-000000000001', 'Default')
                ON CONFLICT (id) DO NOTHING
                RETURNING id
                """
            )
            user_row = await conn.fetchrow(
                """
                INSERT INTO users (id, email, display_name, is_admin, role, tenant_id, provider)
                VALUES ('00000000-0000-0000-0000-000000000000', 'admin@local', 'Admin',
                        true, 'owner', '00000000-0000-0000-0000-000000000001', 'local')
                ON CONFLICT (id) DO NOTHING
                RETURNING id
                """
            )
        if tenant_row is not None or user_row is not None:
            log.warning(
                "Default tenant/admin user was missing — re-seeded. This usually "
                "means those tables were cleared by a data wipe."
            )
    except Exception:
        log.warning("Default-tenant/admin ensure failed", exc_info=True)


# Curated interactive-chat tool surface: enough to be useful (search the web,
# use memory, light file ops) without overwhelming small local models with the
# full ~70-tool registry. Widen/clear from Settings → Tool Permissions.
_DEFAULT_CHAT_TOOLS = [
    "web_search", "web_fetch",
    "what_do_i_know", "search_memory", "recall_topic", "read_memory", "remember",
    "read_file", "list_dir", "run_shell",
]


async def _ensure_default_toolset() -> None:
    """Seed tool_permissions.default_allowed_tools if it's missing."""
    import json as _json

    from app.db import get_pool

    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT value FROM platform_config WHERE key = 'tool_permissions'"
            )
            current = {}
            if row and row["value"]:
                current = row["value"] if isinstance(row["value"], dict) else _json.loads(row["value"])
            if current.get("default_allowed_tools"):
                return  # user/migration already set it — don't override
            current.setdefault("disabled_groups", [])
            current["default_allowed_tools"] = _DEFAULT_CHAT_TOOLS
            await conn.execute(
                """
                INSERT INTO platform_config (key, value, description)
                VALUES ('tool_permissions', $1::jsonb,
                        'Default agent tool surface (default_allowed_tools = chat allowlist).')
                ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()
                """,
                _json.dumps(current),
            )
        log.warning(
            "tool_permissions.default_allowed_tools was missing — seeded the "
            "curated chat toolset (%d tools).", len(_DEFAULT_CHAT_TOOLS)
        )
    except Exception:
        log.warning("Default-toolset ensure failed", exc_info=True)


async def _bootstrap_platform_secrets_from_env() -> None:
    """SEC-006a — sync platform_secrets ↔ .env on every orchestrator startup.

    Two passes, both idempotent:

      1. **Bootstrap** — for each managed key, if ``platform_secrets`` has no
         entry AND ``os.environ`` has a non-empty value, copy it in.
         Existing platform_secrets entries are NEVER overwritten — once a
         user rotates via the dashboard, that wins forever.
      2. **Apply** — for orchestrator-internal consumers that read
         ``settings`` directly (``oauth.py``, ``github_tools.py``), copy the
         platform_secrets value into the running ``Settings`` instance so
         every existing call site picks up the right value without code
         changes.

    The end goal is to drop the ``.env`` bind-mount to ``:ro``: once an
    install has booted at least once, every secret the user supplied via
    .env is mirrored into encrypted platform_secrets and the .env file is
    no longer the source of truth.
    """
    from app.db import get_pool
    from app.secrets_store import get_secret, set_secret

    # Full list of secret-bearing keys Nova manages — LLM providers and
    # orchestrator-internal credentials. Adding a new key here is the only
    # place a new secret needs to be registered.
    BOOTSTRAP_KEYS = [
        "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY",
        "GEMINI_API_KEY", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY",
        "GITHUB_TOKEN", "CHATGPT_ACCESS_TOKEN",
        "GOOGLE_CLIENT_SECRET", "NOVA_GITHUB_PAT",
    ]

    # Settings attributes that orchestrator code reads directly and that
    # therefore need a runtime override when platform_secrets has them.
    SETTINGS_OVERRIDES = {
        "GOOGLE_CLIENT_SECRET": "google_client_secret",
        "NOVA_GITHUB_PAT": "nova_github_pat",
    }

    pool = get_pool()
    bootstrapped: list[str] = []
    applied: list[str] = []

    for key in BOOTSTRAP_KEYS:
        existing = await get_secret(pool, key)
        if not existing:
            env_val = os.environ.get(key, "")
            if env_val:
                await set_secret(pool, key, env_val)
                bootstrapped.append(key)
                existing = env_val
        if existing and key in SETTINGS_OVERRIDES:
            attr = SETTINGS_OVERRIDES[key]
            if getattr(settings, attr, "") != existing:
                setattr(settings, attr, existing)
                applied.append(attr)

    if bootstrapped:
        log.info(
            "platform_secrets: bootstrapped %d key(s) from .env: %s",
            len(bootstrapped), sorted(bootstrapped),
        )
    if applied:
        log.info(
            "platform_secrets: applied %d override(s) to settings: %s",
            len(applied), sorted(applied),
        )


async def _seed_config_from_env() -> None:
    """Seed platform_config from .env values for existing deployments.

    Only writes if the DB value is still the default and the .env value differs.
    Never overwrites DB with .env — DB is the source of truth once set.
    """
    import json

    from app.db import get_pool

    SEEDS = {
        # (config_key, env_value, default_db_value)
        "trusted_networks": (
            settings.trusted_networks,
            "127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,::1/128",
        ),
        "trusted_proxy_header": (settings.trusted_proxy_header, ""),
        "auth.require_auth": (str(settings.require_auth).lower(), "true"),
        "auth.registration_mode": (settings.registration_mode, "invite"),
    }

    pool = get_pool()
    seeded = []
    try:
        async with pool.acquire() as conn:
            for key, (env_val, default_val) in SEEDS.items():
                if not env_val or env_val == default_val:
                    continue
                row = await conn.fetchrow(
                    "SELECT value #>> '{}' AS val FROM platform_config WHERE key = $1", key
                )
                if not row:
                    continue
                db_val = row["val"] or ""
                # Strip JSON string quotes for comparison
                if db_val.startswith('"') and db_val.endswith('"'):
                    try:
                        db_val = json.loads(db_val)
                    except Exception:
                        pass
                if db_val == default_val or db_val == "":
                    json_val = json.dumps(env_val)
                    await conn.execute(
                        "UPDATE platform_config SET value = $2::jsonb, updated_at = NOW() WHERE key = $1",
                        key, json_val,
                    )
                    seeded.append(key)
        if seeded:
            log.info("Seeded platform_config from .env: %s", seeded)
    except Exception:
        log.warning("Failed to seed platform_config from .env (DB not ready?)", exc_info=True)


async def _reconcile_demoted_env() -> None:
    """Import-then-warn for runtime .env keys now owned by platform_config.

    The Settings UI is the source of truth for these keys (see
    docs/designs/2026-06-30-unified-runtime-config.md §3.6). For each still-set
    .env runtime key:
      - platform_config row missing  -> seed it once (import the .env value so
        removing it from .env later doesn't lose the operator's setting).
      - DB value == .env value        -> silent (consistent).
      - DB value != .env value        -> WARN: the .env value is IGNORED; the
        effective value comes from Settings. Never overwrites the DB — the UI
        is authoritative.
    """
    import json

    from app.config_demotion import DEMOTED_RUNTIME_ENV, explicit_env_value
    from app.db import get_pool

    pool = get_pool()
    try:
        async with pool.acquire() as conn:
            for env_var, cfg_key in DEMOTED_RUNTIME_ENV.items():
                # Read the .env FILE, not os.environ — compose injects a default
                # for every var, so os.environ can't tell an operator's explicit
                # value from a compose fallback.
                env_val = explicit_env_value(env_var)
                if not env_val:
                    continue
                row = await conn.fetchrow(
                    "SELECT value #>> '{}' AS val FROM platform_config WHERE key = $1",
                    cfg_key,
                )
                if row is None:
                    await conn.execute(
                        "INSERT INTO platform_config (key, value, updated_at) "
                        "VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO NOTHING",
                        cfg_key, json.dumps(env_val),
                    )
                    log.info(
                        "Imported .env %s into platform_config %s — Settings now owns it",
                        env_var, cfg_key,
                    )
                    continue
                if row["val"] == env_val:
                    continue
                log.warning(
                    "Config %s is set in .env (%s=%r) but that value is IGNORED — "
                    "the effective value %r comes from Settings (platform_config.%s). "
                    "Remove %s from .env to silence this warning.",
                    cfg_key, env_var, env_val, row["val"], cfg_key, env_var,
                )
    except Exception:
        log.warning("Failed to reconcile demoted .env keys (DB not ready?)", exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Orchestrator starting")

    # FC-002: refuse to start with the literal default admin secret.
    # NOVA_ALLOW_DEFAULT_ADMIN_SECRET=1 is an escape hatch for tests/dev only.
    if settings.nova_admin_secret == "nova-admin-secret-change-me":
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

    # Recover Redis agents stuck in 'running' from a previous crashed process
    recovered = await recover_stale_agents()
    if recovered:
        log.info("Startup: recovered %d stale agent(s) to idle", recovered)

    # Initialize Postgres pool and apply versioned schema migrations
    await init_db()

    # Ensure the default tenant exists. Migration 020 seeds it once, but a
    # factory reset / data wipe can clear the tenants table without re-running
    # migrations — leaving every tenant-scoped insert (usage_events, etc.) to
    # fail its FK. Re-seeding on every boot self-heals that class of breakage.
    await _ensure_default_tenant()

    # Ensure a sane default chat tool surface. Without it, interactive chat
    # sends ALL ~70 registered tools to the model — small local models choke on
    # that payload (and fabricate rather than pick from a huge menu). Migration
    # 086 seeds this once; a wipe clears it. Re-seed if absent.
    await _ensure_default_toolset()

    # Auto-generate JWT secret if not configured
    from app.jwt_auth import ensure_jwt_secret
    await ensure_jwt_secret()

    # Auto-generate credential master key if not configured (T1-04)
    # Day-1 users running `make up` without the install wizard arrive with an
    # empty CREDENTIAL_MASTER_KEY; this self-heals before any credentials
    # endpoint can be hit.
    from app.capabilities.credentials import ensure_credential_master_key
    await ensure_credential_master_key()

    # SEC-006a — mirror .env secret-bearing keys into platform_secrets and
    # apply any platform_secrets values back onto settings for consumers that
    # read settings directly. Must run AFTER ensure_credential_master_key()
    # (the master key is needed to encrypt) and BEFORE any settings-reading
    # code (oauth.py, github_tools.py) handles a request.
    await _bootstrap_platform_secrets_from_env()

    # Seed platform_config from .env for existing deployments
    await _seed_config_from_env()

    # Import-then-warn for runtime keys demoted from .env to platform_config,
    # so the Settings UI is the source of truth and stale .env overrides surface
    # as a startup WARN instead of silently winning.
    await _reconcile_demoted_env()

    # Sync DB config to Redis so LLM gateway has correct values immediately
    from app.config_sync import (
        sync_engram_config_to_redis,
        sync_features_config_to_redis,
        sync_inference_config_to_redis,
        sync_llm_config_to_redis,
        sync_quality_config_to_redis,
        sync_retrieval_config_to_redis,
        sync_screenpipe_config_to_redis,
        sync_voice_config_to_redis,
    )
    await sync_llm_config_to_redis()
    await sync_inference_config_to_redis()
    await sync_engram_config_to_redis()
    await sync_voice_config_to_redis()
    await sync_features_config_to_redis()
    await sync_retrieval_config_to_redis()
    await sync_quality_config_to_redis()
    await sync_screenpipe_config_to_redis()

    # Guarantee one canonical Nova agent exists; prune any duplicates
    primary = await ensure_primary_agent()
    log.info("Primary agent ready: %s model=%s", primary.id, primary.config.model)

    # Ensure Nova self-modification workspace exists
    from pathlib import Path
    Path("/nova/workspace").mkdir(parents=True, exist_ok=True)

    # Defer MCP server load past lifespan yield — load_mcp_servers can take
    # 20+ seconds because MCP child processes (puppeteer, firecrawl) spawn npm
    # and discover tools. Blocking the lifespan on it kept /health/ready from
    # returning 200 until MCP was fully connected. See:
    # docs/perf/2026-05-07-startup-performance-findings.md
    from app.pipeline.tools import load_mcp_servers

    app.state.mcp_load_status = {"status": "in_progress", "count": None, "error": None}

    async def _load_mcp_background() -> None:
        try:
            count = await load_mcp_servers()
            app.state.mcp_load_status = {"status": "complete", "count": count, "error": None}
            log.info("MCP servers loaded: %d connected", count)
        except Exception as exc:  # noqa: BLE001
            app.state.mcp_load_status = {"status": "failed", "count": 0, "error": str(exc)}
            log.exception("MCP server load failed (background task)")

    _mcp_load_task = asyncio.create_task(_load_mcp_background(), name="mcp-load")

    # Force-fail any tasks still in *_running state from a previous crashed process
    await cleanup_stale_running_on_startup()

    # Start background tasks — stored so we can cancel on shutdown
    _queue_task   = asyncio.create_task(queue_worker(),             name="queue-worker")
    _reaper_task  = asyncio.create_task(reaper_loop(),              name="reaper")

    from app.effectiveness import effectiveness_loop
    _effectiveness_task = asyncio.create_task(effectiveness_loop(), name="effectiveness")

    from app.chat_scorer import chat_scorer_loop
    _chat_scorer_task = asyncio.create_task(chat_scorer_loop(), name="chat-scorer")

    from app.auto_friction import auto_friction_subscriber
    _auto_friction_task = asyncio.create_task(auto_friction_subscriber(), name="auto-friction")

    from app.polling_worker import GitHubPoller
    _poller = GitHubPoller()
    _poll_task = asyncio.create_task(_poller.start(), name="github-poller")

    from app.capabilities.approval_worker import approval_worker_loop
    _approval_worker_task = asyncio.create_task(
        approval_worker_loop(), name="approval-worker",
    )
    log.info(
        "Queue worker, reaper, effectiveness loop, chat scorer, auto-friction "
        "subscriber, GitHub poller, and approval-worker started"
    )

    # Register quality loops + apply DB-stored agency
    from app.quality_loop.loops.retrieval_tuning import RetrievalTuningLoop
    from app.quality_loop.registry import get_registry, load_agency_from_config

    registry = get_registry()
    registry.register(RetrievalTuningLoop())
    await load_agency_from_config(registry)
    log.info("Quality loops registered: %s", [loop.name for loop in registry.list()])

    # Feature-flags SDK wiring (Phase B7): warm the cache from our own DB,
    # then subscribe to nova:flags:invalidate so future PATCHes (from any
    # admin client) propagate to in-process FlagDef.value() reads.
    import httpx as _httpx
    from app.db import get_pool as _get_pool_for_flags
    from app.feature_flags_store import warm_cache_from_store
    from nova_contracts.feature_flags_pubsub import PubsubSubscriber

    _flag_http_client = _httpx.AsyncClient(timeout=5.0)
    pool = _get_pool_for_flags()
    try:
        await warm_cache_from_store(pool)
        log.info("Feature-flags cache warmed from store")
    except Exception:
        log.warning(
            "Feature-flags cache warm-from-store failed at startup; "
            "in-code defaults apply until first successful warm",
            exc_info=True,
        )

    _flag_subscriber = PubsubSubscriber(
        redis_url=settings.redis_url,
        http_client=_flag_http_client,
        # Orchestrator subscribes to its own pubsub and re-warms via HTTP
        # to itself. This is a 5ms localhost call and keeps the post-publish
        # path uniform with every other consuming service.
        base_url="http://localhost:8000",
    )
    await _flag_subscriber.start()
    log.info("Feature-flags pubsub subscriber started")

    yield

    log.info("Orchestrator shutting down")

    # Feature-flags shutdown: stop subscriber + close its HTTP client
    try:
        await _flag_subscriber.stop()
    except Exception:
        log.warning("Feature-flags subscriber stop failed", exc_info=True)
    try:
        await _flag_http_client.aclose()
    except Exception:
        log.warning("Feature-flags HTTP client aclose failed", exc_info=True)

    _queue_task.cancel()
    _reaper_task.cancel()
    _effectiveness_task.cancel()
    _chat_scorer_task.cancel()
    _auto_friction_task.cancel()
    _approval_worker_task.cancel()
    _mcp_load_task.cancel()
    await _poller.stop()
    _poll_task.cancel()
    # Wait briefly for graceful shutdown
    await asyncio.gather(
        _queue_task, _reaper_task, _effectiveness_task, _chat_scorer_task,
        _auto_friction_task, _poll_task, _approval_worker_task,
        _mcp_load_task,
        return_exceptions=True,
    )

    # Close approval-worker's Redis connections (producer + consumer sides)
    from app.capabilities.approval_worker import close_approval_worker_redis
    from app.capabilities.consent import close_consent_redis
    await close_approval_worker_redis()
    await close_consent_redis()

    # Gracefully stop MCP server subprocesses
    from app.pipeline.tools import stop_all_servers
    await stop_all_servers()

    await close_clients()
    await close_redis()
    await close_stimulus_redis()
    from app.knowledge_router import close_engram_redis
    await close_engram_redis()
    from app.capture_router import close_capture_redis
    await close_capture_redis()
    # Close the admin-secret config Redis connection (lazy-opened in app.auth)
    from app import auth as _auth
    if _auth._config_redis is not None:
        try:
            await _auth._config_redis.aclose()
        finally:
            _auth._config_redis = None
    await close_db()


app = FastAPI(
    title="Nova Orchestrator",
    version="0.2.0",
    description="Agent lifecycle management and task routing",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_allowed_origins.split(",") if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)

from app.trusted_network import TrustedNetworkMiddleware, parse_cidrs

app.add_middleware(
    TrustedNetworkMiddleware,
    trusted_cidrs=parse_cidrs(settings.trusted_networks),
    proxy_header=settings.trusted_proxy_header,
)

from app.capture_router import router as capture_router
from app.engram_router import router as engram_router
from app.quality_router import quality_router
from app.secrets_router import router as secrets_router
from app.webhooks_router import router as webhooks_router
from app.workspace_router import workspace_router

app.include_router(health_router)
app.include_router(router)
app.include_router(auth_router)
app.include_router(pipeline_router)
from app.feature_flags_router import router as feature_flags_router  # noqa: E402

app.include_router(feature_flags_router)
app.include_router(friction_router)
app.include_router(goals_router)
app.include_router(intel_router)
app.include_router(knowledge_router)
app.include_router(capabilities_router)
app.include_router(engram_router)
app.include_router(workspace_router)
app.include_router(quality_router)
app.include_router(capture_router)
app.include_router(secrets_router)
app.include_router(webhooks_router)
