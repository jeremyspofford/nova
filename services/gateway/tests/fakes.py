"""Local ASGI stand-ins for a real ollama and a real OpenAI-compatible
backend. httpx talks to them over StreamingASGITransport, so the exact
client code under test (headers, byte-for-byte streaming, error handling)
is the real one, with no socket anywhere.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field

import httpx
from starlette.applications import Starlette
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route


class StreamingASGITransport(httpx.AsyncBaseTransport):
    """Streams instead of buffering, like httpx's own ASGITransport does.

    The one behavior that transport does not give us: when the driven ASGI
    app raises partway through a streamed response, this transport surfaces
    that as a genuine httpx.ReadError from aiter_raw() — the shape a real
    dropped connection actually takes — rather than looking like a clean
    end of stream. That is the one property the "mid-stream failure" tests
    need to exercise the real `except httpx.HTTPError` branches.
    """

    def __init__(self, app) -> None:
        self.app = app

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
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
            # Reached only on a natural end of the chunk queue (never on an
            # early .aclose() by the caller, which exits via the `finally`
            # above instead). Awaiting the task turns a driven-app exception
            # into the real network-failure shape callers must handle.
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                raise httpx.ReadError(f"simulated backend failure: {exc}") from exc

        return httpx.Response(
            head["status"], headers=head["headers"], content=stream(), request=request
        )


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


@dataclass
class FakeOllama:
    """Stands in for a real ollama server: the OpenAI-compat completions
    endpoint plus ollama's own /api/tags, /api/version, /api/pull, /api/ps.
    """

    deltas: tuple[str, ...] = ("Hel", "lo")
    fail_after: int | None = None  # raise mid-stream after this many deltas
    tags: tuple[str, ...] = ("qwen3:8b", "qwen3:4b")
    version_status: int = 200
    pull_status: int = 200
    pull_lines: tuple[str, ...] = ('{"status":"pulling"}', '{"status":"success"}')
    probe_status: int = 200
    probe_content: str = "hi there"
    vram_bytes: int | None = 5_000_000_000
    probe_model_name: str = "qwen3:8b"
    seen: list[tuple[str, dict | None]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.app = Starlette(
            routes=[
                Route("/v1/chat/completions", self._completions, methods=["POST"]),
                Route("/api/tags", self._tags, methods=["GET"]),
                Route("/api/version", self._version, methods=["GET"]),
                Route("/api/pull", self._pull, methods=["POST"]),
                Route("/api/ps", self._ps, methods=["GET"]),
            ]
        )

    async def _record(self, request) -> dict | None:
        raw = await request.body()
        body = json.loads(raw) if raw else None
        self.seen.append((request.url.path, body))
        return body

    async def _completions(self, request):
        body = await self._record(request)
        if not (body or {}).get("stream"):
            if self.probe_status != 200:
                return JSONResponse({"error": "probe refused"}, status_code=self.probe_status)
            return JSONResponse(
                {"choices": [{"message": {"role": "assistant", "content": self.probe_content}}]}
            )

        async def stream():
            for index, delta in enumerate(self.deltas):
                yield _sse({"choices": [{"delta": {"content": delta}}]})
                if self.fail_after is not None and index + 1 == self.fail_after:
                    raise RuntimeError("simulated ollama crash mid-stream")
            yield "data: [DONE]\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream")

    async def _tags(self, request):
        await self._record(request)
        return JSONResponse({"models": [{"name": name} for name in self.tags]})

    async def _version(self, request):
        await self._record(request)
        if self.version_status != 200:
            return JSONResponse({"error": "down"}, status_code=self.version_status)
        return JSONResponse({"version": "0.0.0-fake"})

    async def _pull(self, request):
        await self._record(request)
        if self.pull_status != 200:
            return JSONResponse({"error": "model not found"}, status_code=self.pull_status)

        async def lines():
            for line in self.pull_lines:
                yield f"{line}\n"

        return StreamingResponse(lines(), media_type="application/x-ndjson")

    async def _ps(self, request):
        await self._record(request)
        models = []
        if self.vram_bytes is not None:
            models = [{"name": self.probe_model_name, "size_vram": self.vram_bytes}]
        return JSONResponse({"models": models})


@dataclass
class FakeOpenAICompat:
    """Stands in for a remote/cloud OpenAI-compatible server."""

    models_body: dict = field(
        default_factory=lambda: {"object": "list", "data": [{"id": "remote-model"}]}
    )
    models_status: int = 200
    completions_status: int = 200
    completions_body: dict = field(
        default_factory=lambda: {"choices": [{"message": {"content": "ok"}}]}
    )
    seen_auth: list[str | None] = field(default_factory=list)
    seen: list[tuple[str, dict | None]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.app = Starlette(
            routes=[
                Route("/v1/models", self._models, methods=["GET"]),
                Route("/v1/chat/completions", self._completions, methods=["POST"]),
            ]
        )

    async def _models(self, request):
        self.seen_auth.append(request.headers.get("authorization"))
        self.seen.append((request.url.path, None))
        return JSONResponse(self.models_body, status_code=self.models_status)

    async def _completions(self, request):
        raw = await request.body()
        body = json.loads(raw) if raw else None
        self.seen_auth.append(request.headers.get("authorization"))
        self.seen.append((request.url.path, body))
        if self.completions_status != 200:
            return JSONResponse({"error": "refused"}, status_code=self.completions_status)
        return JSONResponse(self.completions_body)
