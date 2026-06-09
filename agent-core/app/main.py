# agent-core/app/main.py
import asyncio
import asyncpg
import logging
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
import httpx

import os

from .config import settings
from .db import close_pool, get_pool
from .loop.main import close_llm_client, run_task, set_task_complete_dispatch_fn
from .secrets import store as secrets_store
from .conversations_router import router as conversations_router
from .memories_proxy_router import router as memories_proxy_router
from .mcp_router import router as mcp_router
from .schedules_router import router as schedules_router
from .secrets.router import router as secrets_router
from .tasks_router import router as tasks_router
from .approvals_router import router as approvals_router
from nova_contracts import HealthStatus

# Importing tools_builtin triggers @tool self-registration as a side effect.
from .tools import tools_builtin  # noqa: F401
from .tools.mcp import mcp_manager
from .tools.mcp.registry import boot_mcp_servers
from .tools.tools_builtin.memory import close_mem_client
from .scheduler import scheduler_loop, fire_task_complete_schedules
from .watchers import WatcherManager

logging.basicConfig(level=settings.log_level)
logger = logging.getLogger(__name__)

_watcher_manager: WatcherManager | None = None
_scheduler_task: asyncio.Task | None = None


_ENV_SECRET_MAP = {
    "ANTHROPIC_API_KEY": ("anthropic_api_key", "Anthropic API key"),
    "OPENAI_API_KEY": ("openai_api_key", "OpenAI API key"),
    "GROQ_API_KEY": ("groq_api_key", "Groq API key"),
    "GEMINI_API_KEY": ("gemini_api_key", "Gemini API key"),
}


async def _bootstrap_secrets_from_env(pool: asyncpg.Pool) -> None:
    """Seed the secrets table from .env on first boot. Idempotent — never overwrites."""
    if not settings.credential_master_key:
        logger.warning("CREDENTIAL_MASTER_KEY not set — skipping secret bootstrap")
        return
    for env_var, (secret_name, purpose) in _ENV_SECRET_MAP.items():
        value = os.environ.get(env_var)
        if not value:
            continue
        if await secrets_store.secret_exists(pool, secret_name):
            continue
        await secrets_store.set_secret(pool, secret_name, value, purpose, settings.credential_master_key)
        logger.info("Bootstrapped secret from env: %s", secret_name)


async def run_migrations(pool: asyncpg.Pool) -> None:
    migrations_dir = Path(__file__).parent / "migrations"
    sql_files = sorted(migrations_dir.glob("*.sql"))
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ DEFAULT now()
            )
        """)
        applied = {r["filename"] for r in await conn.fetch("SELECT filename FROM schema_migrations")}
        for f in sql_files:
            if f.name not in applied:
                logger.info(f"Running migration: {f.name}")
                async with conn.transaction():
                    await conn.execute(f.read_text())
                    await conn.execute("INSERT INTO schema_migrations (filename) VALUES ($1)", f.name)


async def _dispatch_task(prompt: str, source: str, schedule_id: str | None, *, pool) -> str:
    """Create a task row and fire-and-forget the agent loop."""
    task_id = str(uuid.uuid4())
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO tasks (id, prompt, goal, status, source, schedule_id) "
            "VALUES ($1, $2, $2, 'pending', $3, $4)",
            task_id, prompt, source, schedule_id,
        )

    def _on_done(fut: asyncio.Future) -> None:
        if not fut.cancelled() and fut.exception():
            logger.error(
                "scheduler-dispatched task %s failed: %s", task_id[:8], fut.exception()
            )

    t = asyncio.create_task(run_task(task_id, prompt, pool))
    t.add_done_callback(_on_done)
    return task_id


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _watcher_manager, _scheduler_task

    pool = await get_pool()
    await run_migrations(pool)
    await _bootstrap_secrets_from_env(pool)
    mcp_manager.set_pool(pool)
    try:
        await boot_mcp_servers(pool)
    except Exception as exc:
        logger.warning("MCP boot failed (continuing): %s", exc)

    async def dispatch_fn(prompt: str, source: str, schedule_id: str | None = None) -> str:
        return await _dispatch_task(prompt, source, schedule_id, pool=pool)

    app.state.dispatch_fn = dispatch_fn
    set_task_complete_dispatch_fn(dispatch_fn)
    _watcher_manager = WatcherManager()

    # Boot existing fs_watch schedules from the DB.
    try:
        rows = await pool.fetch(
            "SELECT id, trigger FROM schedules WHERE enabled = true AND trigger->>'type' = 'fs_watch'"
        )
        for row in rows:
            t = row["trigger"]
            if isinstance(t, str):
                import json
                t = json.loads(t)
            _watcher_manager.start(
                schedule_id=str(row["id"]),
                path=t["path"],
                on_events=t.get("on", ["created", "modified"]),
                pattern=t.get("pattern", "*"),
            )
    except Exception as exc:
        logger.warning("Could not boot fs_watch schedules: %s", exc)

    _scheduler_task = asyncio.create_task(scheduler_loop(pool, dispatch_fn))

    def _on_sched_done(fut: asyncio.Future) -> None:
        if not fut.cancelled() and fut.exception():
            logger.error("scheduler loop crashed: %s", fut.exception())

    _scheduler_task.add_done_callback(_on_sched_done)

    logger.info("agent-core started")
    yield

    if _scheduler_task:
        _scheduler_task.cancel()
        try:
            await _scheduler_task
        except asyncio.CancelledError:
            pass

    if _watcher_manager:
        _watcher_manager.stop_all()

    await mcp_manager.shutdown_all()
    await close_llm_client()
    await close_mem_client()
    await close_pool()
    logger.info("agent-core stopped")


app = FastAPI(title="agent-core", version="2.0.0", lifespan=lifespan)
app.include_router(conversations_router)
app.include_router(memories_proxy_router)
app.include_router(mcp_router)
app.include_router(schedules_router)
app.include_router(secrets_router)
app.include_router(tasks_router)
app.include_router(approvals_router)


@app.get("/api/v1/identity")
async def get_identity():
    """Nova's display identity — name, greeting, avatar defaults."""
    return {
        "name": "Nova",
        "greeting": "Hello! I'm Nova, your autonomous AI assistant. How can I help you today?",
        "avatarUrl": None,
        "isDefaultAvatar": True,
    }


@app.get("/api/v1/auth/providers")
async def auth_providers():
    """Public endpoint — tells the dashboard how auth works on this instance.
    Includes admin_secret on trusted-network installs so the browser can
    auto-configure without manual user input."""
    return {
        "trusted_network": True,
        "google": False,
        "registration_mode": "open",
        "has_users": False,
        "admin_secret": settings.admin_secret,
    }


def _require_admin(x_admin_secret: str | None = Header(default=None)) -> None:
    if not x_admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing admin secret")
    if x_admin_secret != settings.admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin secret")


@app.get("/health/live")
async def health_live():
    return {"status": "ok"}


@app.get("/health/ready")
async def health_ready():
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        db_ok = True
    except Exception as exc:
        logger.warning("DB health check failed: %s", exc)
        db_ok = False
    status = "ok" if db_ok else "error"
    return HealthStatus(status=status, service="agent-core", checks={"db": db_ok})


@app.get("/api/health/ready")
async def api_health_ready():
    """Nginx-proxied alias — browsers call /api/health/ready through the dashboard."""
    return await health_ready()


@app.get("/api/v1/llm/providers")
async def llm_providers(_: None = Depends(_require_admin)):
    """Proxy to llm-gateway /providers — browser-accessible through /api/ nginx block."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{settings.llm_gateway_url}/providers")
        return r.json()
    except Exception as exc:
        logger.warning("llm-gateway unreachable: %s", exc)
        raise HTTPException(status_code=503, detail="llm-gateway unavailable")


@app.get("/api/v1/llm/models")
async def llm_models(refresh: bool = False, _: None = Depends(_require_admin)):
    """Proxy to llm-gateway /models/discover — returns ALL available models per provider."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{settings.llm_gateway_url}/models/discover",
                params={"refresh": "true" if refresh else "false"},
            )
        return r.json()
    except Exception as exc:
        logger.warning("llm-gateway unreachable: %s", exc)
        raise HTTPException(status_code=503, detail="llm-gateway unavailable")


@app.get("/api/v1/llm/resolve")
async def llm_resolve(_: None = Depends(_require_admin)):
    """Proxy to llm-gateway /models/resolve — returns the best model for current strategy."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{settings.llm_gateway_url}/models/resolve")
        if r.status_code == 503:
            raise HTTPException(status_code=503, detail="No models available")
        return r.json()
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("llm-gateway unreachable: %s", exc)
        raise HTTPException(status_code=503, detail="llm-gateway unavailable")


@app.patch("/api/v1/llm/config")
async def llm_config_patch(request: Request, _: None = Depends(_require_admin)):
    """Proxy to llm-gateway PATCH /config."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.patch(
                f"{settings.llm_gateway_url}/config",
                json=body,
                headers={"Content-Type": "application/json"},
            )
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.text)
        return r.json()
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("llm-gateway unreachable: %s", exc)
        raise HTTPException(status_code=503, detail="llm-gateway unavailable")
