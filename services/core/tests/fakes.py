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
                head["headers"] = [
                    (k.decode(), v.decode()) for k, v in message.get("headers", [])
                ]
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
    admin_status: int = 200
    admin_body: dict = field(default_factory=lambda: {"gpus": []})
    pull_lines: tuple[str, ...] = ('{"status":"pulling"}', '{"status":"success"}')
    seen: list[tuple[str, dict | None]] = field(default_factory=list)
    # Raw query strings as they arrived, to prove nothing was re-encoded.
    queries: list[bytes] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.app = Starlette(
            routes=[
                Route("/v1/chat/completions", self._completions, methods=["POST"]),
                Route("/admin/hardware", self._admin, methods=["GET"]),
                Route("/admin/suggest", self._admin, methods=["GET"]),
                Route("/admin/probe", self._admin, methods=["POST"]),
                Route("/admin/backend", self._admin, methods=["GET", "PUT"]),
                Route("/admin/pull", self._pull, methods=["POST"]),
            ]
        )

    async def _record(self, request) -> dict | None:
        raw = await request.body()
        body = json.loads(raw) if raw else None
        self.seen.append((request.url.path, body))
        self.queries.append(request.scope["query_string"])
        return body

    async def _completions(self, request):
        await self._record(request)
        if not _bearer_ok(request, GATEWAY_TOKEN):
            return JSONResponse({"error": "bad gateway bearer"}, status_code=401)
        if self.status != 200:
            return JSONResponse(
                {"error": {"message": "backend refused"}}, status_code=self.status
            )

        async def stream():
            for delta in self.deltas:
                yield _sse({"choices": [{"delta": {"content": delta}}]})
            if self.hold is not None:
                await self.hold.wait()
            if self.error_chunk is not None:
                yield _sse({"error": {"message": self.error_chunk}})
            if self.usage is not None:
                yield _sse({"choices": [], "usage": self.usage})
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"X-Nova-Served-By": self.served_by},
        )

    async def _admin(self, request):
        await self._record(request)
        if not _bearer_ok(request, GATEWAY_TOKEN):
            return JSONResponse({"error": "bad gateway bearer"}, status_code=401)
        return JSONResponse(self.admin_body, status_code=self.admin_status)

    async def _pull(self, request):
        await self._record(request)
        if not _bearer_ok(request, GATEWAY_TOKEN):
            return JSONResponse({"error": "bad gateway bearer"}, status_code=401)

        async def lines():
            for line in self.pull_lines:
                yield f"{line}\n"

        return StreamingResponse(lines(), media_type="application/x-ndjson")


@dataclass
class FakeMemory:
    """/recall and /ingest, with every call recorded."""

    results: tuple[dict, ...] = ()
    recall_status: int = 200
    ingest_status: int = 200
    recalls: list[dict] = field(default_factory=list)
    ingests: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.ingested = asyncio.Event()
        self.app = Starlette(
            routes=[
                Route("/recall", self._recall, methods=["POST"]),
                Route("/ingest", self._ingest, methods=["POST"]),
            ]
        )

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
        return JSONResponse({"path": "journals/today.md", "appended": True})
