"""Local ASGI stand-ins for the gateway and memory services.

Mounted by URL on app.state.peer_transports, so core's real outbound path
runs — same client, same bearer header, same SSE parsing — with no peer
process anywhere. Both fakes refuse a request that arrives without the
right bearer, so "core sends its token" is a tested fact.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx
from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route


class StreamingASGITransport(httpx.AsyncBaseTransport):
    """An ASGI transport that streams instead of buffering.

    httpx's own ASGITransport collects the whole response before handing it
    back, which would make every "as the deltas arrive" property in the
    chat path untestable — the fake would always look instantaneous. This
    one hands each body chunk to the caller as the app sends it.
    """

    def __init__(self, app, *, delay: float = 0.0) -> None:
        self.app = app
        # Simulates a slow peer: sleeps before doing anything else, honoring
        # the caller's own read-timeout budget the same way a real socket
        # would — if `delay` exceeds it, this raises httpx.ReadTimeout after
        # waiting exactly that budget, rather than a real client timeout
        # never firing because this transport (unlike httpx's own) does not
        # otherwise enforce request.extensions["timeout"] at all.
        self.delay = delay

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self.delay:
            read_timeout = (request.extensions.get("timeout") or {}).get("read")
            if read_timeout is not None and self.delay > read_timeout:
                await asyncio.sleep(read_timeout)
                raise httpx.ReadTimeout(
                    f"simulated: no response within {read_timeout}s", request=request
                )
            await asyncio.sleep(self.delay)
        body = await request.aread()
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.1"},
            "http_version": "1.1",
            "method": request.method,
            "headers": [(k.lower(), v) for k, v in request.headers.raw],
            "scheme": request.url.scheme,
            "path": request.url.path,
            "raw_path": request.url.raw_path.split(b"?")[0],
            "query_string": request.url.query,
            "server": (request.url.host, request.url.port),
            "client": ("127.0.0.1", 12345),
            "root_path": "",
        }
        head: dict = {}
        started = asyncio.Event()
        chunks: asyncio.Queue = asyncio.Queue()
        request_sent = False

        async def receive():
            nonlocal request_sent
            if not request_sent:
                request_sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            await asyncio.Event().wait()  # nothing more arrives until we are cancelled

        async def send(message) -> None:
            if message["type"] == "http.response.start":
                head["status"] = message["status"]
                head["headers"] = [(k.decode(), v.decode()) for k, v in message.get("headers", [])]
                started.set()
            elif message["type"] == "http.response.body":
                chunk = message.get("body", b"")
                if chunk:
                    await chunks.put(chunk)
                if not message.get("more_body", False):
                    await chunks.put(None)

        async def run() -> None:
            try:
                await self.app(scope, receive, send)
            finally:
                started.set()
                await chunks.put(None)

        task = asyncio.create_task(run())
        # Never leave an exception unretrieved — it would print during teardown.
        task.add_done_callback(lambda t: t.cancelled() or t.exception())
        await started.wait()
        if "status" not in head:
            await task  # the app died before responding; let the test see why
            raise RuntimeError("fake peer finished without sending a response")

        async def stream():
            try:
                while True:
                    chunk = await chunks.get()
                    if chunk is None:
                        break
                    yield chunk
            finally:
                task.cancel()

        return httpx.Response(
            head["status"], headers=head["headers"], content=stream(), request=request
        )


GATEWAY_URL = "http://gateway.test"
GATEWAY_TOKEN = "gateway-link-token"
MEMORY_URL = "http://memory.test"
MEMORY_TOKEN = "memory-link-token"
# An outside origin for fetch_url's tests. Its host resolves to nothing
# real; the suites that use it point tools.web.resolve_addresses at a
# public-looking address so the SSRF guard runs for real and passes.
WEB_ORIGIN = "http://public.test"
# The bundled SearXNG's URL for web_search's tests. Set as SEARXNG_URL so the
# tool reads it, and mounted as the origin FakeSearx answers on. Unlike
# WEB_ORIGIN there is no SSRF guard in web_search — searxng is a trusted,
# in-network battery, not a URL the model chose.
SEARXNG_URL = "http://searxng.test"


def _bearer_ok(request, token: str) -> bool:
    return request.headers.get("authorization") == f"Bearer {token}"


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


@dataclass
class FakeGateway:
    """An OpenAI-compatible completions endpoint plus the admin surface."""

    deltas: tuple[str, ...] = ("Hello", " there")
    status: int = 200
    served_by: str = "ollama:qwen3:8b"
    usage: dict | None = None
    error_chunk: str | None = None
    # When set, the stream stalls here until the event fires — the "client
    # hung up while the model was still talking" case.
    hold: asyncio.Event | None = None
    # Deltas emitted AFTER the hold releases — i.e. content the gateway sends
    # once the browser has already disconnected. A durable turn must capture
    # these too, so the persisted reply is the WHOLE answer, not the prefix
    # that happened to arrive before the client left.
    after_hold: tuple[str, ...] = ()
    admin_status: int = 200
    # The model catalogue (S10a): when set, /admin/catalog answers this body
    # and /admin/catalog/hf this page (with hf_status); when None they fall
    # back to the admin echo above, as the proxy tests expect.
    catalog_body: dict | None = None
    hf_body: dict | None = None
    hf_status: int = 200
    # /admin/pull answers this status with `pull_body` instead of streaming
    # when it is not 200 (the gateway's 400/404/409 refusals).
    pull_status: int = 200
    pull_body: dict | None = None
    admin_body: dict = field(default_factory=lambda: {"gpus": []})
    pull_lines: tuple[str, ...] = ('{"status":"pulling"}', '{"status":"success"}')
    seen: list[tuple[str, dict | None]] = field(default_factory=list)
    # Raw query strings as they arrived, to prove nothing was re-encoded.
    queries: list[bytes] = field(default_factory=list)
    # S10: every request's headers (lower-cased), so a test can read the
    # attribution core stamped (X-Nova-Purpose, -Role, -Turn-Id, -Person,
    # -Timezone); `spend_body` is the ledger rollup /admin/spend serves.
    seen_headers: list[dict[str, str]] = field(default_factory=list)
    spend_body: dict | None = None
    # S10-2: what /admin/route/explain answers (None: the admin echo) and the
    # X-Nova-Route header the completion carries (None: none).
    explain_body: dict | None = None
    route_header: str | None = None

    def __post_init__(self) -> None:
        self.app = Starlette(
            routes=[
                Route("/v1/chat/completions", self._completions, methods=["POST"]),
                Route("/admin/hardware", self._admin, methods=["GET"]),
                Route("/admin/suggest", self._admin, methods=["GET"]),
                Route("/admin/probe", self._admin, methods=["POST"]),
                Route("/admin/backend", self._admin, methods=["GET", "PUT"]),
                Route("/admin/pull", self._pull, methods=["POST"]),
                # Not under /admin — this is the OpenAI-compat data-plane route
                # (services/gateway/app/data_plane.py), reused here since the
                # fake only needs to echo admin_body and record the call.
                Route("/v1/models", self._admin, methods=["GET"]),
                # The provider registry (S10-pre) — same echo, same record.
                Route("/admin/providers", self._admin, methods=["GET", "POST"]),
                Route("/admin/providers/presets", self._admin, methods=["GET"]),
                Route("/admin/providers/{name}", self._admin, methods=["GET", "PUT", "DELETE"]),
                Route("/admin/providers/{name}/default", self._admin, methods=["PUT"]),
                Route("/admin/providers/{name}/models", self._admin, methods=["GET"]),
                # The model catalogue (S10a) — same echo, same record.
                Route("/admin/catalog", self._catalog, methods=["GET"]),
                Route("/admin/catalog/hf", self._hf, methods=["GET"]),
                Route("/admin/catalog/hf/{org}/{repo}", self._admin, methods=["GET"]),
                Route("/admin/catalog/resolve", self._admin, methods=["GET"]),
                Route("/admin/catalog/drift", self._admin, methods=["POST"]),
                Route("/admin/models", self._admin, methods=["DELETE"]),
                Route("/admin/spend", self._spend, methods=["GET"]),
                Route("/admin/spend/events", self._admin, methods=["GET"]),
                Route("/admin/spend/caps", self._admin, methods=["GET", "PUT"]),
                Route("/admin/spend/prices", self._admin, methods=["GET", "PUT", "DELETE"]),
                Route("/admin/routes", self._admin, methods=["GET"]),
                # S12: agents.unregister_route DELETEs a derived role's row.
                Route("/admin/routes/{role}", self._admin, methods=["PUT", "DELETE"]),
                Route("/admin/route/explain", self._explain, methods=["GET"]),
                Route("/admin/routes/walls/{provider}", self._admin, methods=["DELETE"]),
            ]
        )

    async def _record(self, request) -> dict | None:
        raw = await request.body()
        body = json.loads(raw) if raw else None
        self.seen.append((request.url.path, body))
        self.queries.append(request.scope["query_string"])
        self.seen_headers.append({k.lower(): v for k, v in request.headers.items()})
        return body

    async def _explain(self, request):
        if self.explain_body is None:
            return await self._admin(request)
        await self._record(request)
        if not _bearer_ok(request, GATEWAY_TOKEN):
            return JSONResponse({"error": "bad gateway bearer"}, status_code=401)
        return JSONResponse(self.explain_body)

    async def _spend(self, request):
        if self.spend_body is None:
            return await self._admin(request)
        await self._record(request)
        if not _bearer_ok(request, GATEWAY_TOKEN):
            return JSONResponse({"error": "bad gateway bearer"}, status_code=401)
        return JSONResponse(self.spend_body)

    async def _completions(self, request):
        await self._record(request)
        if not _bearer_ok(request, GATEWAY_TOKEN):
            return JSONResponse({"error": "bad gateway bearer"}, status_code=401)
        if self.status != 200:
            return JSONResponse({"error": {"message": "backend refused"}}, status_code=self.status)

        async def stream():
            for delta in self.deltas:
                yield _sse({"choices": [{"delta": {"content": delta}}]})
            if self.hold is not None:
                await self.hold.wait()
            for delta in self.after_hold:
                yield _sse({"choices": [{"delta": {"content": delta}}]})
            if self.error_chunk is not None:
                yield _sse({"error": {"message": self.error_chunk}})
            if self.usage is not None:
                yield _sse({"choices": [], "usage": self.usage})
            yield "data: [DONE]\n\n"

        headers = {"X-Nova-Served-By": self.served_by}
        if self.route_header is not None:
            headers["X-Nova-Route"] = self.route_header
        return StreamingResponse(stream(), media_type="text/event-stream", headers=headers)

    async def _admin(self, request):
        await self._record(request)
        if not _bearer_ok(request, GATEWAY_TOKEN):
            return JSONResponse({"error": "bad gateway bearer"}, status_code=401)
        return JSONResponse(self.admin_body, status_code=self.admin_status)

    async def _catalog(self, request):
        if self.catalog_body is None:
            return await self._admin(request)
        await self._record(request)
        if not _bearer_ok(request, GATEWAY_TOKEN):
            return JSONResponse({"error": "bad gateway bearer"}, status_code=401)
        return JSONResponse(self.catalog_body)

    async def _hf(self, request):
        if self.hf_body is None:
            return await self._admin(request)
        await self._record(request)
        if not _bearer_ok(request, GATEWAY_TOKEN):
            return JSONResponse({"error": "bad gateway bearer"}, status_code=401)
        return JSONResponse(self.hf_body, status_code=self.hf_status)

    async def _pull(self, request):
        await self._record(request)
        if not _bearer_ok(request, GATEWAY_TOKEN):
            return JSONResponse({"error": "bad gateway bearer"}, status_code=401)
        if self.pull_status != 200:
            body = self.pull_body or {"error": "refused"}
            return JSONResponse(body, status_code=self.pull_status)

        async def lines():
            for line in self.pull_lines:
                yield f"{line}\n"

        return StreamingResponse(lines(), media_type="application/x-ndjson")


@dataclass
class FakeMemory:
    """/recall, /ingest, /save and /forget, with every call recorded.

    /forget mirrors the real memory service's per-PATH semantics: by default
    (forget_status left at None) it returns 200 only for a path this fake
    actually "wrote" via a prior /ingest call — tracked in `journal_paths`,
    keyed by the exact rel-path the real store.append_journal scheme
    produces (people/<person_id>/journals/<UTC date>.md) — and 404 for any
    other path, including one that merely looks plausible. That makes a test
    asserting "cleanup's forget succeeded" an assertion against the REAL path
    an ingest wrote, not the runner's own reconstructed string compared to
    itself. `forget_status`, when set to an int, overrides this path check
    and always answers with that status instead — for a test that wants to
    simulate an outright memory-service failure (a 500) rather than a
    legitimate not-found.
    """

    results: tuple[dict, ...] = ()
    recall_status: int = 200
    ingest_status: int = 200
    save_status: int = 200
    save_body: dict | None = None
    forget_status: int | None = None
    recalls: list[dict] = field(default_factory=list)
    ingests: list[dict] = field(default_factory=list)
    saves: list[dict] = field(default_factory=list)
    forgets: list[dict] = field(default_factory=list)
    # Same calls as `forgets`, each with the response status actually sent —
    # so a test can assert a specific path got 200, not just that /forget was
    # called with some body.
    forget_results: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.ingested = asyncio.Event()
        # The set of journal paths a real store would now have on disk —
        # populated by _ingest, consumed by _forget. Real-form paths only
        # ("people/<person_id>/journals/<date>.md"), matching
        # services/memory/app/store.py's append_journal exactly.
        self.journal_paths: set[str] = set()
        self.app = Starlette(
            routes=[
                Route("/recall", self._recall, methods=["POST"]),
                Route("/ingest", self._ingest, methods=["POST"]),
                Route("/save", self._save, methods=["POST"]),
                Route("/forget", self._forget, methods=["POST"]),
            ]
        )

    async def _save(self, request):
        body = await request.json()
        self.saves.append(body)
        if not _bearer_ok(request, MEMORY_TOKEN):
            return JSONResponse({"error": "bad memory bearer"}, status_code=401)
        if self.save_status != 200:
            return JSONResponse({"error": "could not save"}, status_code=self.save_status)
        if self.save_body is not None:
            return JSONResponse(self.save_body)
        slug = "-".join(str(body.get("title", "note")).lower().split())
        return JSONResponse({"path": f"people/x/topics/{slug}.md", "saved": True})

    async def _recall(self, request):
        body = await request.json()
        self.recalls.append(body)
        if not _bearer_ok(request, MEMORY_TOKEN):
            return JSONResponse({"error": "bad memory bearer"}, status_code=401)
        if self.recall_status != 200:
            return JSONResponse({"error": "index unavailable"}, status_code=self.recall_status)
        return JSONResponse({"results": list(self.results)})

    async def _ingest(self, request):
        body = await request.json()
        self.ingests.append(body)
        self.ingested.set()
        if not _bearer_ok(request, MEMORY_TOKEN):
            return JSONResponse({"error": "bad memory bearer"}, status_code=401)
        if self.ingest_status != 200:
            return Response(status_code=self.ingest_status)
        # The real-form path a real store would have just written to
        # (services/memory/app/store.py's append_journal: one file per
        # person per UTC day) — recorded so _forget can answer truthfully.
        person_id = body.get("person_id", "")
        today = datetime.now(UTC).date().isoformat()
        path = f"people/{person_id}/journals/{today}.md"
        self.journal_paths.add(path)
        return JSONResponse({"path": path, "appended": True})

    async def _forget(self, request):
        body = await request.json()
        self.forgets.append(body)
        if not _bearer_ok(request, MEMORY_TOKEN):
            self.forget_results.append({**body, "status": 401})
            return JSONResponse({"error": "bad memory bearer"}, status_code=401)
        path = body.get("path")
        status = (
            self.forget_status
            if self.forget_status is not None
            else (200 if path in self.journal_paths else 404)
        )
        self.forget_results.append({**body, "status": status})
        if status != 200:
            return JSONResponse({"error": "no such memory file"}, status_code=status)
        self.journal_paths.discard(path)
        return JSONResponse({"path": path, "deleted": True})


@dataclass
class FakeWeb:
    """A public-looking web server for fetch_url: one page per behaviour.

    Reached through the same by-URL transport map the peer fakes use, so
    the tool's real code path runs — guard, redirect walk, caps, extraction
    — without a socket.
    """

    big_bytes: int = 600 * 1024
    requested: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.app = Starlette(
            routes=[
                Route("/page.html", self._html),
                Route("/plain.txt", self._plain),
                Route("/data.json", self._json),
                Route("/big.txt", self._big),
                Route("/image.png", self._image),
                Route("/gone", self._gone),
                Route("/redirect", self._redirect),
                Route("/redirect-to-private", self._redirect_private),
                Route("/hop/{n:int}", self._hop),
                Route("/redirect-without-location", self._redirect_no_location),
                Route("/post-only", self._echo_method, methods=["GET", "POST"]),
            ]
        )

    def _seen(self, request) -> None:
        self.requested.append(request.url.path)

    async def _html(self, request):
        self._seen(request)
        body = (
            "<!doctype html><html><head><title>Tea</title>"
            "<style>body { color: red }</style>"
            "<script>var secret = 'do not read me'</script></head>"
            "<body><!-- a comment --><h1>Tea &amp; biscuits</h1>"
            "<p>Steep for <b>three</b> minutes.</p></body></html>"
        )
        return Response(body, media_type="text/html; charset=utf-8")

    async def _plain(self, request):
        self._seen(request)
        return Response("just some text", media_type="text/plain")

    async def _json(self, request):
        self._seen(request)
        return JSONResponse({"temperature_c": 21})

    async def _big(self, request):
        self._seen(request)
        return Response("z" * self.big_bytes, media_type="text/plain")

    async def _image(self, request):
        self._seen(request)
        return Response(b"\x89PNG\r\n", media_type="image/png")

    async def _gone(self, request):
        self._seen(request)
        return Response("nothing here", status_code=404, media_type="text/plain")

    async def _redirect(self, request):
        self._seen(request)
        return Response(status_code=302, headers={"location": "/page.html"})

    async def _redirect_private(self, request):
        self._seen(request)
        return Response(status_code=302, headers={"location": "http://private.test/secret"})

    async def _redirect_no_location(self, request):
        self._seen(request)
        return Response(status_code=302)

    async def _hop(self, request):
        self._seen(request)
        n = int(request.path_params["n"])
        return Response(status_code=302, headers={"location": f"/hop/{n + 1}"})

    async def _echo_method(self, request):
        self._seen(request)
        return Response(request.method, media_type="text/plain")


@dataclass
class FakeSearx:
    """The SearXNG JSON API for web_search: GET /search?format=json.

    Reached through the same by-URL transport map FakeWeb uses, so web_search's
    real request, JSON parse and formatting run with no socket. `results` is
    handed back verbatim as SearXNG's results[] array; `status`, `body` and
    `content_type` let a test make the service answer an error, or a 200 that is
    not JSON (the botdetection HTML block page settings.yml disables the limiter
    to avoid), so the tool's stated-failure paths are exercised for real.
    """

    results: tuple[dict, ...] = ()
    # When set, a request carrying &categories=news gets THIS result set instead of
    # `results` — so the recency path's "news empty → general fallback" can be
    # tested distinctly. Left None, every category returns `results` and the
    # single-search tests are unchanged.
    news_results: tuple[dict, ...] | None = None
    status: int = 200
    body: str | None = None  # when set, returned verbatim instead of JSON
    content_type: str = "application/json"
    queries: list[str] = field(default_factory=list)
    formats: list[str] = field(default_factory=list)
    categories: list[str] = field(default_factory=list)  # the &categories= per request

    def __post_init__(self) -> None:
        self.app = Starlette(routes=[Route("/search", self._search, methods=["GET"])])

    async def _search(self, request):
        query = request.query_params.get("q", "")
        category = request.query_params.get("categories", "")
        self.queries.append(query)
        self.formats.append(request.query_params.get("format", ""))
        self.categories.append(category)
        if self.body is not None:
            return Response(self.body, status_code=self.status, media_type=self.content_type)
        if self.status != 200:
            return JSONResponse({"error": "unavailable"}, status_code=self.status)
        if category == "news" and self.news_results is not None:
            results = self.news_results
        else:
            results = self.results
        return JSONResponse({"query": query, "results": list(results)})


@dataclass
class Refusal:
    """A gateway round that answers with a status instead of a stream."""

    status: int
    body: dict


@dataclass
class ScriptedGateway:
    """A completions endpoint that plays one scripted round per call.

    Each entry in `rounds` is either the tuple of SSE chunk payloads that
    round emits (verbatim, so a test can pin an exact wire shape) or a
    Refusal. Running past the end of the script is a loud 500 rather than a
    quiet empty round — a loop calling more times than the test expects
    must fail the test, not pass it.
    """

    rounds: tuple = ()
    served_by: str = "ollama:qwen3:8b"
    seen: list[tuple[str, dict | None]] = field(default_factory=list)
    # When set, the round whose index is `hold_before` stalls before emitting
    # anything until the event fires — so a test can hang up the client after
    # an earlier round's tools have run but before this round answers, and
    # prove the detached completion still finishes the remaining rounds.
    hold: asyncio.Event | None = None
    hold_before: int = 0

    def __post_init__(self) -> None:
        self.calls = 0
        self.app = Starlette(
            routes=[Route("/v1/chat/completions", self._completions, methods=["POST"])]
        )

    @property
    def payloads(self) -> list[dict]:
        return [body for _path, body in self.seen if body is not None]

    async def _completions(self, request):
        raw = await request.body()
        self.seen.append(("/v1/chat/completions", json.loads(raw) if raw else None))
        if not _bearer_ok(request, GATEWAY_TOKEN):
            return JSONResponse({"error": "bad gateway bearer"}, status_code=401)

        index = self.calls
        self.calls += 1
        if index >= len(self.rounds):
            return JSONResponse(
                {"error": {"message": f"the test script has no round {index + 1}"}},
                status_code=500,
            )
        script = self.rounds[index]
        if isinstance(script, Refusal):
            return JSONResponse(script.body, status_code=script.status)

        async def stream():
            if self.hold is not None and index == self.hold_before:
                await self.hold.wait()
            for chunk in script:
                yield _sse(chunk)
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"X-Nova-Served-By": self.served_by},
        )
