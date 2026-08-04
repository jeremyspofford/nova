"""Nova backend — FastAPI app."""

import asyncio
import hmac
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app import (db, http as http_pool, ingest_backfill, ingest_worker,
                 leader, model_warmer, rules, scheduler, settings_store)
from app.config import settings
from app.llm import providers
from app.memory.memory import memory
from app.router_chat import router as chat_router
from app.router_coder import router as coder_router
from app.router_files import router as files_router
from app.router_system import router as system_router
from app.router_voice import router as voice_router

logging.basicConfig(level=settings.get_log_level())
log = logging.getLogger(__name__)


def _refuse_split_state() -> None:
    """A secondary pointed at a central PG while keeping the default local
    memory dir is a split-brain entity — half its mind in the shared DB,
    half on a disk no other instance can see (remote-shared-state trap).
    Refuse loudly unless the operator explicitly opts in.

    Reads the HOST path, not the container one. It used to check
    settings.okf_memory_dir, which docker-compose hardcodes to
    /app/data/memory — one of the very strings in the default set below — so
    with a remote DATABASE_URL this always fired, and the remedy it printed
    ("point NOVA_MEMORY_DIR at the shared memory dir") could never clear it,
    because NOVA_MEMORY_DIR only moves the host side of the bind mount. The
    container path is invariant by design; the host path is the one that
    says whether the store is actually shared, and compose already passes it
    as NOVA_MEMORY_DIR_HOST."""
    import os
    from urllib.parse import urlparse

    host = (urlparse(settings.database_url).hostname or "").lower()
    local_db = host in {"postgres", "localhost", "127.0.0.1", "::1", ""}
    mem_dir = os.environ.get("NOVA_MEMORY_DIR_HOST") or settings.okf_memory_dir
    default_mem = mem_dir.rstrip("/") in {
        "./data/memory", "data/memory", "/app/data/memory"}
    if not local_db and default_mem \
            and os.environ.get("NOVA_ALLOW_SPLIT_STATE") != "1":
        raise RuntimeError(
            "DATABASE_URL points at a remote postgres but NOVA_MEMORY_DIR is "
            "the local default — one brain, two memory homes. Point "
            "NOVA_MEMORY_DIR at the shared memory dir, or set "
            "NOVA_ALLOW_SPLIT_STATE=1 to run split on purpose.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Starting Nova backend...")
    _refuse_split_state()
    # An action type whose operator route has been renamed or deleted is a
    # capability the model can reach and the operator cannot. Refuse to boot
    # rather than let that rule rot into a comment.
    from app import actions
    actions.assert_routes_exist()
    await db.init_pool()
    await db.run_migrations()
    await settings_store.warm()
    await providers.warm()
    await rules.warm()
    await memory.startup()
    # elect before the first scheduler tick so a single instance is leader
    # from the start; followers keep retrying every 30s in the background
    await leader.start()
    await ingest_backfill.run()   # one-time repair: anchor drifting source ingests
    # an eval runs in-process, so a restart (including any --reload edit)
    # kills it; without this its row stays 'running' and reads as in-flight
    from app import eval_runs
    await eval_runs.reconcile_orphans()
    # same reasoning for an action run: the process dying mid-register leaves
    # a row that reads as in-flight forever
    from app import action_worker
    await action_worker.reset_orphans()
    # Size the local models' context windows before anything trims against
    # them. Backgrounded: it is metadata probes against ollama, which may be
    # absent or slow, and a boot must not wait on it.
    from app import bg, local_context
    bg.spawn(local_context.warm(), name="local-context-warm")
    scheduler_task = asyncio.create_task(scheduler.loop())
    warmer_task = asyncio.create_task(model_warmer.loop())
    ingest_task = asyncio.create_task(ingest_worker.loop())
    action_task = asyncio.create_task(action_worker.loop())
    provider_health_task = asyncio.create_task(providers.health_loop())
    log.info("Backend ready")
    yield
    log.info("Shutting down...")
    for task in (scheduler_task, warmer_task, ingest_task, action_task,
                 provider_health_task):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    await leader.stop()   # releases the advisory lock promptly on clean exit
    await http_pool.aclose()
    await db.close_pool()


app = FastAPI(title="Nova Backend", lifespan=lifespan)

# NO CORS MIDDLEWARE, deliberately. Nova is same-origin everywhere it is
# meant to be used: vite proxies /api in dev (:5173), nginx serves the build
# and the API from one origin in prod (:8080), and the tailnet URL points at
# that same nginx. Nothing legitimate reads this API cross-origin.
#
# It used to run allow_origins=["*"] + allow_methods=["*"], which combined
# with the tokenless-localhost path below into a drive-by: any page the
# operator visited could fetch http://127.0.0.1:8000/api/v1/auth/token, READ
# the response (that is what the wildcard grants), and keep the admin token
# forever. Cross-origin writes preflighted successfully too, so the same page
# could register a stdio MCP server and get code execution. Verified live
# 2026-07-24. Absent CORS headers, the browser now refuses to hand any
# cross-origin response back to the page that asked.


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


_LOCAL_IPS = (_GATEWAY_IP, "127.0.0.1", "::1")

# The only containers allowed to speak for someone else. `web` is nginx
# (proxy_set_header X-Real-IP $remote_addr) and `frontend` is the vite dev
# proxy; both publish on 127.0.0.1 so their X-Real-IP is the host's view of
# the real client.
_PROXY_HOSTNAMES = ("web", "frontend")
_proxy_cache: tuple[float, frozenset[str]] | None = None
_PROXY_TTL_S = 60.0


def _proxy_ips() -> frozenset[str]:
    """Current compose addresses of the trusted proxies. Resolved, not
    configured, because container IPs change on every recreate."""
    global _proxy_cache
    import socket
    import time as _time
    now = _time.monotonic()
    if _proxy_cache and now - _proxy_cache[0] < _PROXY_TTL_S:
        return _proxy_cache[1]
    ips: set[str] = set()
    for name in _PROXY_HOSTNAMES:
        try:
            ips.update(i[4][0] for i in socket.getaddrinfo(
                name, None, proto=socket.IPPROTO_TCP))
        except OSError:
            pass          # profile off or not started — simply not a proxy
    _proxy_cache = (now, frozenset(ips))
    return _proxy_cache[1]


def _is_local(request: Request) -> bool:
    """True when the ORIGINAL client is this machine.

    This used to answer "is X-Real-IP absent?", and absence was read as "came
    straight to :8000 or through the vite proxy, both bound to 127.0.0.1".
    The premise was wrong: :8000 is published on 127.0.0.1 of the HOST, but
    inside the compose network the port is open to every sidecar. So media,
    searxng and mcp-runner — the three services that chew on untrusted input
    — could GET /api/v1/auth/token with no token at all (verified live
    2026-07-24, 200 from both). X-Real-IP is also just a header, so a
    compromised sidecar could forge one and be trusted anyway.

    Ask the socket instead. Only the docker gateway means "the host reached
    our published port", and X-Real-IP is believed solely from a proxy we
    can name."""
    peer = request.client.host if request.client else None
    if peer in _LOCAL_IPS:
        return True
    if peer in _proxy_ips():
        return request.headers.get("x-real-ip") in _LOCAL_IPS
    return False


def _nova_origins() -> set[str]:
    """The origins that ARE Nova — dev server, one-origin build, and the
    operator's configured public URL. Only consulted as the fallback for
    browsers too old to send Sec-Fetch-Site."""
    origins = {f"http://{host}:{port}"
               for host in ("127.0.0.1", "localhost", "[::1]")
               for port in ("5173", "8080", "8000")}
    try:
        public = (settings_store.get("ui.public_url") or "").strip().rstrip("/")
    except Exception:
        public = ""
    if public:
        origins.add(public)
    return origins


def _browser_cross_site(request: Request) -> bool:
    """True when a BROWSER says this request was initiated by another site.

    `_is_local` answers "which machine", which is the wrong question for a
    browser: a page from anywhere runs ON this machine and reaches
    127.0.0.1 with no X-Real-IP, so it used to inherit the tokenless local
    path. Sec-Fetch-Site answers the right question — who asked — and page
    JS cannot forge it (it is a forbidden header name). `same-site` is
    included with `cross-site`: a different origin is a different trust
    domain here regardless of registrable domain.

    Non-browser callers (curl on this host, the phone app, healthchecks)
    send neither header and keep the frictionless local path."""
    site = request.headers.get("sec-fetch-site")
    if site is not None:
        return site in ("cross-site", "same-site")
    origin = request.headers.get("origin")
    if origin:
        return origin.strip().rstrip("/") not in _nova_origins()
    return False


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Single admin token for REMOTE devices; this machine stays tokenless
    (default; NOVA_TRUST_LOCALHOST=false to require it everywhere). Empty
    token = fully open. /health stays public for container healthchecks.

    Localhost trust is machine-level and never extends to a web page: a
    cross-site request always has to carry the token, however local its
    packets look."""
    token = settings.nova_auth_token
    if token and request.url.path.startswith("/api/"):
        supplied = request.headers.get("authorization", "")
        authed = hmac.compare_digest(supplied, f"Bearer {token}")
        trusted_local = (settings.nova_trust_localhost
                         and _is_local(request)
                         and not _browser_cross_site(request))
        if not authed and not trusted_local:
            # masked forensics: enough to diagnose entry/transport issues,
            # never the secret itself
            log.warning(
                "auth failed: path=%s real_ip=%s fetch_site=%s origin=%s "
                "got_len=%d got_prefix=%r",
                request.url.path, request.headers.get("x-real-ip"),
                request.headers.get("sec-fetch-site"),
                request.headers.get("origin"),
                len(supplied), supplied[:14])
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


app.include_router(chat_router)
app.include_router(voice_router)
app.include_router(system_router)
app.include_router(coder_router)
app.include_router(files_router)


@app.get("/health")
async def health():
    try:
        async with db.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return {"status": "ok", "db": "ok"}
    except Exception as e:
        return {"status": "degraded", "db": f"error: {e}"}
