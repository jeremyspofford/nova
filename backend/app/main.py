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


async def _report_stale_grants() -> None:
    """Log every agent grant that names a tool this build does not define.

    A stale grant is invisible until an agent happens to run: `retry_ingest_job`
    was granted to `main` and defined nowhere for ~18h on 2026-08-04, and the
    only place it surfaced was a degraded-grant line in five chat turns, which
    told the operator a service was down. It was not — a worktree backend had
    applied a migration to the shared live DB ahead of the code in this
    checkout, so the grant row arrived before the tool existed.

    Reported, never fatal. Refusing to boot on this would turn a routine
    migration-order skew into an outage, and the running system degrades
    honestly on its own (see runner's degraded-grant split). MCP grants are
    excluded: those resolve against a sidecar that is legitimately down at
    boot and comes back by itself.

    Derived from the same resolver the runtime uses, so a tool added tomorrow
    silences this with no edit here.
    """
    try:
        from app.agents import registry as agent_registry
        from app.tools import registry as tool_registry
        for agent in await agent_registry.list_agents():
            missing = [n for n in await tool_registry.degraded_grants(agent)
                       if not n.startswith("mcp:")]
            if missing:
                log.error(
                    "STALE GRANT: agent %r is granted %s, which no tool in "
                    "this build defines. The grant will never resolve — "
                    "remove it, or deploy the code that provides it.",
                    agent.get("name"), ", ".join(missing))
    except Exception:   # noqa: BLE001 — a boot report must never stop the boot
        log.exception("stale-grant check failed")


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
    await _report_stale_grants()
    await settings_store.warm()
    await providers.warm()
    await rules.warm()
    await memory.startup()
    # elect before the first scheduler tick so a single instance is leader
    # from the start; followers keep retrying every 30s in the background
    await leader.start()
    await ingest_backfill.run()   # one-time repair: anchor drifting source ingests
    # an eval runs in-process, so a restart (including any --reload edit)
    # kills it; without this its row stays 'running' and reads as in-flight.
    # BACKGROUNDED, and deliberately late: a run we did not kill may be alive
    # in another process, and the only way to tell is to let the heartbeat
    # window pass. Reaping eagerly at boot marked a live run "interrupted"
    # mid-execution — see eval_runs.reconcile_orphans.
    from app import bg, eval_runs
    bg.spawn(eval_runs.reconcile_orphans(delay_s=eval_runs.STALE_AFTER_S + 15),
             name="eval-orphan-reap")
    # Same failure, different table: a process dying mid-register leaves an
    # action run reading as in-flight forever. Eager and awaited, unlike the
    # eval reaper above — an action run only ever executes on the leader, in
    # THIS process, so a row still 'running' at boot cannot be alive
    # elsewhere and there is no heartbeat window to wait out.
    from app import action_worker
    await action_worker.reset_orphans()
    # DID SOMETHING REDEPLOY US WHILE WE WERE GONE? A backend redeploy kills
    # the turn that asked for it, so the verdict is parked in the sidecar —
    # the one process that does not restart — and read exactly once by
    # whoever asks first. Without this, the single capability she has that
    # ends her own turn would be the one that never reports its outcome.
    # Backgrounded: it is an HTTP call to a sidecar that may be absent, and a
    # boot must not wait on it.
    from app.tools import builtin as _builtin
    bg.spawn(_builtin.report_pending_redeploy(), name="redeploy-report")
    # Size the local models' context windows before anything trims against
    # them. Backgrounded: it is metadata probes against ollama, which may be
    # absent or slow, and a boot must not wait on it.
    # RETRIES, rather than running once. `cached()` falls through to
    # `_last_known`, which never expires, so it returns None only when
    # `resolve()` has NEVER succeeded in this process — and a boot probe that
    # failed left it that way forever. MEASURED: ollama:ornith:9b sized at the
    # 60,000-token unknown-window default for 34 spans across two days,
    # 2026-08-01 19:59 to 2026-08-03 14:16. The cadence is not the fix; the
    # retry is. create_task, not bg.spawn, because bg only logs on completion
    # and a `while True` handed to it would still be pending at shutdown.
    from app import local_context
    context_warm_task = asyncio.create_task(local_context.warm_loop())
    scheduler_task = asyncio.create_task(scheduler.loop())
    warmer_task = asyncio.create_task(model_warmer.loop())
    ingest_task = asyncio.create_task(ingest_worker.loop())
    action_task = asyncio.create_task(action_worker.loop())
    provider_health_task = asyncio.create_task(providers.health_loop())
    log.info("Backend ready")
    yield
    log.info("Shutting down...")
    for task in (scheduler_task, warmer_task, ingest_task, action_task,
                 provider_health_task, context_warm_task):
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


# The name the in-network proxies dial this service by. Not derivable from
# inside the container: socket.gethostname() and $HOSTNAME are both the
# container ID (measured 2026-08-05 — `bb047e280a41`), reverse DNS on our own
# address gives the same ID back, and the com.docker.compose.service label
# needs the docker socket. It has to be listed because vite's dev proxy runs
# changeOrigin:true: measured on the same day, EVERY request through :5173
# reaches us as `Host: backend:8000` with the browser's own Host destroyed.
# It is not a rebinding vector — a bare label with no public TLD is a name no
# attacker can win the DNS for, so no browser can be steered onto it.
_SERVICE_HOST = "backend"


def _bare_host(value: str) -> str:
    """Hostname out of a Host header or an origin: lowercased, port dropped,
    IPv6 brackets removed. Returns "" for anything unparseable.

    Deliberately does NOT validate or normalise beyond that, and the result is
    only ever compared against a known set — never used to build a URL."""
    from urllib.parse import urlsplit
    value = (value or "").strip()
    if not value:
        return ""
    if "://" not in value:
        value = "//" + value          # a bare Host is not a URL until it is
    try:
        return (urlsplit(value).hostname or "").lower()
    except ValueError:                # malformed IPv6 brackets
        return ""


def _nova_hosts() -> frozenset[str]:
    """The hostnames this backend answers to, port-stripped.

    Derived from the same `_nova_origins()` the cross-site fallback uses, so
    setting ui.public_url is the only way to add one and nothing here rots.
    This is NOT the set of names the operator may front nginx with — a tunnel
    or tailnet name arrives through the `web` proxy, and that path is governed
    by the proxy exemption in `_host_refused` rather than by this set."""
    hosts = {_bare_host(o) for o in _nova_origins()}
    hosts.add(_SERVICE_HOST)
    hosts.discard("")
    return frozenset(hosts)


def _host_is_nova(request: Request) -> bool:
    """True when the Host header names Nova rather than a domain the caller
    chose. Closes DNS rebinding, which defeats every other rail here: the
    attacker points evil.test at 127.0.0.1, so their page's packets really do
    come from this machine (`_is_local` is True via the docker gateway) and
    the browser really does consider the fetch same-origin (`Sec-Fetch-Site:
    same-origin`, so `_browser_cross_site` is False). Verified live
    2026-08-05: `curl -H 'Host: evil.test:8000' -H 'Sec-Fetch-Site:
    same-origin' http://127.0.0.1:8000/api/v1/auth/token` returned 200 and the
    admin token with no Authorization header. The Host is the one part of that
    request the attacker cannot launder, because it is the name they had to
    own to run the attack at all."""
    return _bare_host(request.headers.get("host", "")) in _nova_hosts()


def _via_trusted_proxy(request: Request) -> bool:
    """True when `web` or `frontend` is the immediate peer, i.e. the Host we
    see is whatever that proxy chose to send rather than the client's own."""
    peer = request.client.host if request.client else None
    return peer is not None and peer in _proxy_ips()


def _host_refused(request: Request) -> bool:
    """True when the request must be rejected outright for naming a foreign
    host. Pure decision; `host_allowlist_middleware` only turns it into a 400.

    Scoped to the direct path on purpose. Measured 2026-08-05: every caller
    that reaches :8000 without a proxy in front sends a loopback Host, so
    refusing a foreign one there costs nothing — while a request relayed by
    `web` carries whatever name the operator fronts nginx with (a .ts.net
    node, a tunnel), which this process cannot enumerate. 400ing those would
    take out the phone path on :8080, the one surface the web service exists
    for. Rebinding through nginx is still refused, one layer down: it loses
    `trusted_local` in auth_middleware and gets a 401.

    /health is exempt, and NOT because the probes would otherwise fail: the
    three names they dial today all land in the derived set anyway — backend
    probes `http://localhost:8000/health` (compose:143), web probes
    `http://127.0.0.1/health` (compose:502) and nginx relays that on as
    `Host: backend:8000`. The exemption is there so liveness never becomes a
    function of ui.public_url. Anything that can red the `docker compose ps`
    column when a setting changes is a rail that gets deleted the first time
    it does, so this one is kept off that path by construction."""
    if request.url.path == "/health":
        return False
    if _via_trusted_proxy(request):
        return False
    return not _host_is_nova(request)


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
    packets look — nor to a request that reached us under a name we do not
    answer to, however local its packets look."""
    token = settings.nova_auth_token
    if token and request.url.path.startswith("/api/"):
        supplied = request.headers.get("authorization", "")
        authed = hmac.compare_digest(supplied, f"Bearer {token}")
        trusted_local = (settings.nova_trust_localhost
                         and _is_local(request)
                         and _host_is_nova(request)
                         and not _browser_cross_site(request))
        if not authed and not trusted_local:
            # masked forensics: enough to diagnose entry/transport issues,
            # never the secret itself
            log.warning(
                "auth failed: path=%s host=%s real_ip=%s fetch_site=%s "
                "origin=%s got_len=%d got_prefix=%r",
                request.url.path, request.headers.get("host"),
                request.headers.get("x-real-ip"),
                request.headers.get("sec-fetch-site"),
                request.headers.get("origin"),
                len(supplied), supplied[:14])
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


# Registered AFTER auth_middleware so it runs BEFORE it: Starlette inserts
# each added middleware at index 0, so the last one declared is the outermost.
# A request naming a host we do not answer to should never get as far as a
# trust decision.
#
# Hand-rolled rather than Starlette's TrustedHostMiddleware, which takes its
# allow-list once at construction. settings_store is not warm until lifespan
# runs, so a list built at import time could never contain ui.public_url's
# host — the check would have to be hardcoded, which is the one thing it must
# not be.
@app.middleware("http")
async def host_allowlist_middleware(request: Request, call_next):
    """Refuse requests that arrive under a hostname that is not Nova's.

    Guarantees only this: a Host we do not recognise, arriving without a
    trusted proxy in front, gets a 400 and touches no route. It deliberately
    does NOT police the proxied path (see `_host_refused`), and it is not the
    load-bearing half of the rebinding fix — `_host_is_nova` inside
    auth_middleware is, because that one applies to every surface and cannot
    be widened by an operator's reverse-proxy choices."""
    if _host_refused(request):
        log.warning("host refused: path=%s host=%s peer=%s",
                    request.url.path, request.headers.get("host"),
                    request.client.host if request.client else None)
        return JSONResponse({"detail": "invalid host"}, status_code=400)
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
