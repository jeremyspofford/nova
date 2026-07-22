"""Nova backend — FastAPI app."""

import asyncio
import hmac
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import db, model_warmer, rules, scheduler, settings_store
from app.config import settings
from app.llm import providers
from app.memory.memory import memory
from app.router_chat import router as chat_router
from app.router_voice import router as voice_router

logging.basicConfig(level=settings.get_log_level())
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Starting Nova backend...")
    await db.init_pool()
    await db.run_migrations()
    await settings_store.warm()
    await providers.warm()
    await rules.warm()
    await memory.startup()
    scheduler_task = asyncio.create_task(scheduler.loop())
    warmer_task = asyncio.create_task(model_warmer.loop())
    provider_health_task = asyncio.create_task(providers.health_loop())
    log.info("Backend ready")
    yield
    log.info("Shutting down...")
    for task in (scheduler_task, warmer_task, provider_health_task):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    await db.close_pool()


app = FastAPI(title="Nova Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def _docker_gateway() -> str:
    """The bridge gateway IP — how connections from THIS host appear to
    containers (docker's userland proxy for 127.0.0.1-published ports)."""
    try:
        with open("/proc/net/route") as f:
            for line in f.readlines()[1:]:
                fields = line.split()
                if fields[1] == "00000000":  # default route
                    raw = bytes.fromhex(fields[2])
                    return ".".join(str(b) for b in reversed(raw))
    except (OSError, ValueError, IndexError):
        pass
    return "172.17.0.1"


_GATEWAY_IP = _docker_gateway()


def _is_local(request: Request) -> bool:
    """True when the ORIGINAL client is this machine. nginx overwrites
    X-Real-IP with its own view of the client; no X-Real-IP means the
    request came direct to :8000 or via the vite dev proxy — both bound to
    127.0.0.1 on the host, so only this machine can reach them."""
    real_ip = request.headers.get("x-real-ip")
    if real_ip is None:
        return True
    return real_ip in (_GATEWAY_IP, "127.0.0.1", "::1")


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Single admin token for REMOTE devices; this machine stays tokenless
    (default; NOVA_TRUST_LOCALHOST=false to require it everywhere). Empty
    token = fully open. /health stays public for container healthchecks."""
    token = settings.nova_auth_token
    if token and request.url.path.startswith("/api/"):
        supplied = request.headers.get("authorization", "")
        authed = hmac.compare_digest(supplied, f"Bearer {token}")
        if not authed and not (settings.nova_trust_localhost and _is_local(request)):
            # masked forensics: enough to diagnose entry/transport issues,
            # never the secret itself
            log.warning(
                "auth failed: path=%s real_ip=%s got_len=%d got_prefix=%r",
                request.url.path, request.headers.get("x-real-ip"),
                len(supplied), supplied[:14])
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


app.include_router(chat_router)
app.include_router(voice_router)


@app.get("/health")
async def health():
    try:
        async with db.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return {"status": "ok", "db": "ok"}
    except Exception as e:
        return {"status": "degraded", "db": f"error: {e}"}
