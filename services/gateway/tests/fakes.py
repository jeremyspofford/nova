"""Local ASGI stand-ins for a real ollama and a real OpenAI-compatible
backend. httpx talks to them over StreamingASGITransport, so the exact
client code under test (headers, byte-for-byte streaming, error handling)
is the real one, with no socket anywhere.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
from dataclasses import dataclass, field

import httpx
from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response, StreamingResponse
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
        # Never leave an exception unretrieved — it would print during
        # teardown. `stream()` below also explicitly awaits `task` on the
        # natural end-of-queue path to convert a driven-app exception into
        # the real network-failure shape callers must handle, but an early
        # `.aclose()` (GeneratorExit before that point) only calls
        # `task.cancel()`, which is a no-op once the task has already
        # finished — this callback is what retrieves it in that case.
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


# ollama's POST /api/show answer for qwen3:8b, in the LIVE shape verified
# 2026-09-06: `capabilities` is a manifest of what the model has (a value
# not listed is not stated, not denied), `details` is the /api/tags detail
# object, `model_info` is the flat GGUF key/value map whose context-length
# key is namespaced by `general.architecture`, and `license` is the whole
# licence text. Trimmed to the keys the gateway reads plus the ones it
# must ignore.
QWEN3_8B_SHOW: dict = {
    "license": (
        "                                 Apache License\n"
        "                           Version 2.0, January 2004\n"
        "                        http://www.apache.org/licenses/\n"
    ),
    "modelfile": '# Modelfile generated by "ollama show"\nFROM /models/blobs/sha256-abc\n',
    "parameters": 'stop                           "<|im_start|>"',
    "template": "{{- if .Messages }}...{{ end }}",
    "details": {
        "parent_model": "",
        "format": "gguf",
        "family": "qwen3",
        "families": ["qwen3"],
        "parameter_size": "8.2B",
        "quantization_level": "Q4_K_M",
    },
    "model_info": {
        "general.architecture": "qwen3",
        "general.basename": "Qwen3",
        "general.file_type": 15,
        "general.parameter_count": 8190735360,
        "general.quantization_version": 2,
        "general.size_label": "8B",
        "general.type": "model",
        "qwen3.attention.head_count": 32,
        "qwen3.block_count": 36,
        "qwen3.context_length": 40960,
        "qwen3.embedding_length": 4096,
        "tokenizer.ggml.model": "gpt2",
    },
    "capabilities": ["completion", "tools", "thinking"],
    "modified_at": "2026-08-30T12:00:00.000000-07:00",
}


def _derived_show(name: str) -> dict:
    """A live-shaped /api/show body for any tag the fake lists: the real
    qwen3:8b answer with the family/architecture taken from the tag's
    name, so a fake listing `mistral:7b` shows a `mistral` model whose
    context key is `mistral.context_length` — the namespacing rule the
    reader has to get right."""
    if name == "qwen3:8b":
        return copy.deepcopy(QWEN3_8B_SHOW)
    family = name.partition(":")[0].rpartition("/")[2] or "unknown"
    show = copy.deepcopy(QWEN3_8B_SHOW)
    show["details"]["family"] = family
    show["details"]["families"] = [family]
    show["model_info"] = {
        "general.architecture": family,
        "general.parameter_count": 4_022_468_096,
        f"{family}.context_length": 40960,
        f"{family}.embedding_length": 2560,
    }
    show["details"]["parameter_size"] = "4.0B"
    return show


@dataclass
class FakeOllama:
    """Stands in for a real ollama server: the OpenAI-compat completions
    endpoint plus ollama's own /api/tags, /api/version, /api/pull, /api/ps
    and /api/show.

    /api/tags rows carry the live shape (name, model, modified_at, size,
    digest, details) derived from the tag's /api/show body; `tag_rows`
    overrides any of those keys per tag (a test changes a digest to model
    a re-pull). `show` is what POST /api/show answers per tag — filled for
    every initial tag; a name with no entry gets ollama's own 404 shape.
    """

    deltas: tuple[str, ...] = ("Hel", "lo")
    fail_after: int | None = None  # raise mid-stream after this many deltas
    tags: tuple[str, ...] = ("qwen3:8b", "qwen3:4b")
    show: dict[str, dict] = field(default_factory=dict)
    tag_rows: dict[str, dict] = field(default_factory=dict)
    # /api/show fan-out observability: sleep this long inside the handler
    # and record how many requests overlapped, so a test can prove the
    # gateway's concurrency bound without a real server.
    show_delay_s: float = 0.0
    show_in_flight: int = 0
    show_max_in_flight: int = 0
    version_status: int = 200
    pull_status: int = 200
    pull_lines: tuple[str, ...] = ('{"status":"pulling"}', '{"status":"success"}')
    probe_status: int = 200
    probe_content: str = "hi there"
    # ollama's /v1 states usage on the final chunk when asked (include_usage)
    # and always on a non-stream answer.
    prompt_tokens: int | None = 12
    completion_tokens: int | None = 5
    vram_bytes: int | None = 5_000_000_000
    probe_model_name: str = "qwen3:8b"
    # /api/ps's resident-model list for the free-VRAM calc (app/fit.py via
    # admin.py). None means "fall back to the single vram_bytes/
    # probe_model_name pair above" (existing probe tests' shape); an
    # explicit list lets a test say exactly what's resident, including
    # more than one model or none at all.
    ps_models: list[dict] | None = None
    # When set, /api/pull emits every line but the last, then waits for the
    # event before finishing — the only way a test can observe a pull that
    # is genuinely still in flight (the ASGI test transport buffers a whole
    # response, so an ungated stream is over before the client sees it).
    pull_gate: asyncio.Event | None = None
    seen: list[tuple[str, dict | None]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.app = Starlette(
            routes=[
                Route("/v1/chat/completions", self._completions, methods=["POST"]),
                Route("/api/tags", self._tags, methods=["GET"]),
                Route("/api/version", self._version, methods=["GET"]),
                Route("/api/pull", self._pull, methods=["POST"]),
                Route("/api/ps", self._ps, methods=["GET"]),
                Route("/api/show", self._show, methods=["POST"]),
                Route("/api/delete", self._delete, methods=["DELETE"]),
            ]
        )
        for name in self.tags:
            self.show.setdefault(name, _derived_show(name))

    async def _record(self, request) -> dict | None:
        raw = await request.body()
        body = json.loads(raw) if raw else None
        self.seen.append((request.url.path, body))
        return body

    def _tag_row(self, name: str) -> dict:
        """One live-shaped /api/tags row. The digest is content-addressed
        the way ollama's is (here: of the name), the size is a Q4_K_M-ish
        byte count of the parameter count, and details mirror /api/show's
        plus the context/embedding lengths /api/tags also states."""
        show = self.show.get(name) or _derived_show(name)
        details = dict(show.get("details") or {})
        info = show.get("model_info") or {}
        arch = info.get("general.architecture", "")
        for key in ("context_length", "embedding_length"):
            value = info.get(f"{arch}.{key}")
            if isinstance(value, int):
                details[key] = value
        count = info.get("general.parameter_count") or 1_000_000_000
        row = {
            "name": name,
            "model": name,
            "modified_at": show.get("modified_at", "2026-08-30T12:00:00.000000-07:00"),
            "size": int(count * 0.638),
            "digest": "sha256:" + hashlib.sha256(name.encode()).hexdigest(),
            "details": details,
        }
        row.update(self.tag_rows.get(name) or {})
        return row

    async def _show(self, request):
        body = await self._record(request)
        name = (body or {}).get("model") or (body or {}).get("name")
        self.show_in_flight += 1
        self.show_max_in_flight = max(self.show_max_in_flight, self.show_in_flight)
        try:
            if self.show_delay_s:
                await asyncio.sleep(self.show_delay_s)
        finally:
            self.show_in_flight -= 1
        if name not in self.show:
            # ollama's own words and shape for an unknown model.
            return JSONResponse({"error": f"model '{name}' not found"}, status_code=404)
        return JSONResponse(self.show[name])

    async def _delete(self, request):
        body = await self._record(request)
        name = (body or {}).get("model") or (body or {}).get("name")
        if name not in self.tags:
            return JSONResponse({"error": f"model '{name}' not found"}, status_code=404)
        self.tags = tuple(t for t in self.tags if t != name)
        self.show.pop(name, None)
        return Response(status_code=200)

    async def _completions(self, request):
        body = await self._record(request)
        if not (body or {}).get("stream"):
            if self.probe_status != 200:
                return JSONResponse({"error": "probe refused"}, status_code=self.probe_status)
            answer: dict = {
                "choices": [{"message": {"role": "assistant", "content": self.probe_content}}]
            }
            if self.prompt_tokens is not None and self.completion_tokens is not None:
                answer["usage"] = {
                    "prompt_tokens": self.prompt_tokens,
                    "completion_tokens": self.completion_tokens,
                    "total_tokens": self.prompt_tokens + self.completion_tokens,
                }
            return JSONResponse(answer)

        wants_usage = bool(((body or {}).get("stream_options") or {}).get("include_usage"))

        async def stream():
            for index, delta in enumerate(self.deltas):
                yield _sse({"choices": [{"delta": {"content": delta}}]})
                if self.fail_after is not None and index + 1 == self.fail_after:
                    raise RuntimeError("simulated ollama crash mid-stream")
            if (
                wants_usage
                and self.prompt_tokens is not None
                and self.completion_tokens is not None
            ):
                yield _sse(
                    {
                        "choices": [],
                        "usage": {
                            "prompt_tokens": self.prompt_tokens,
                            "completion_tokens": self.completion_tokens,
                            "total_tokens": self.prompt_tokens + self.completion_tokens,
                        },
                    }
                )
            yield "data: [DONE]\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream")

    async def _tags(self, request):
        await self._record(request)
        return JSONResponse({"models": [self._tag_row(name) for name in self.tags]})

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
            for index, line in enumerate(self.pull_lines):
                if self.pull_gate is not None and index == len(self.pull_lines) - 1:
                    await self.pull_gate.wait()
                yield f"{line}\n"

        return StreamingResponse(lines(), media_type="application/x-ndjson")

    async def _ps(self, request):
        await self._record(request)
        if self.ps_models is not None:
            models = self.ps_models
        else:
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
    deltas: tuple[str, ...] = ("ok",)
    # S10 metering: emit a final `usage` chunk when the request asked for
    # one (stream_options.include_usage) — the OpenAI/OpenRouter/ollama
    # behaviour; `cost` is OpenRouter's `usage.cost`, emitted only when the
    # request carried `usage: {include: true}`. `rejects_usage_fields`
    # answers 400 naming the field, the way a strict proxy does.
    prompt_tokens: int | None = 12
    completion_tokens: int | None = 5
    cost: float | None = None
    rejects_usage_fields: bool = False
    seen_auth: list[str | None] = field(default_factory=list)
    seen_headers: list[dict] = field(default_factory=list)
    seen: list[tuple[str, dict | None]] = field(default_factory=list)
    # The URL prefix the fake serves under — `/v1` for most providers,
    # `/openai/v1` for an Azure- or Bedrock-shaped one.
    prefix: str = "/v1"
    # OpenRouter-shaped: /models answers 200 to ANY key (or none) …
    models_public: bool = False
    # … so only a completion can prove the key. When set, /chat/completions
    # 401s unless the bearer matches.
    accepts_key: str | None = None
    # What a WRONG key gets on /models when the listing is not public —
    # 401 normally; 429 models a provider that rate-limits the second call.
    models_wrong_key_status: int = 401

    def __post_init__(self) -> None:
        self.app = Starlette(
            routes=[
                Route(f"{self.prefix}/models", self._models, methods=["GET"]),
                Route(f"{self.prefix}/chat/completions", self._completions, methods=["POST"]),
            ]
        )

    def _note(self, request) -> None:
        self.seen_auth.append(request.headers.get("authorization"))
        self.seen_headers.append({k.lower(): v for k, v in request.headers.items()})

    def _key_ok(self, request) -> bool:
        if self.accepts_key is None:
            return True
        return request.headers.get("authorization") == f"Bearer {self.accepts_key}"

    async def _models(self, request):
        self._note(request)
        self.seen.append((request.url.path, None))
        if not self.models_public and not self._key_ok(request):
            return JSONResponse(
                {"error": {"message": "Invalid API key"}}, status_code=self.models_wrong_key_status
            )
        return JSONResponse(self.models_body, status_code=self.models_status)

    async def _completions(self, request):
        raw = await request.body()
        body = json.loads(raw) if raw else None
        self._note(request)
        self.seen.append((request.url.path, body))
        if not self._key_ok(request):
            return JSONResponse(
                {"error": {"message": "User not found.", "code": 401}}, status_code=401
            )
        if self.completions_status != 200:
            return JSONResponse({"error": "refused"}, status_code=self.completions_status)
        body = body or {}
        if self.rejects_usage_fields and ("stream_options" in body or "usage" in body):
            return JSONResponse(
                {"error": {"message": "Unrecognized request argument supplied: stream_options"}},
                status_code=400,
            )
        usage = self._usage(body)
        if not body.get("stream"):
            payload = dict(self.completions_body)
            if usage is not None:
                payload["usage"] = usage
            return JSONResponse(payload)

        async def stream():
            for delta in self.deltas:
                yield _sse({"choices": [{"delta": {"content": delta}}]})
            if usage is not None and (body.get("stream_options") or {}).get("include_usage"):
                yield _sse({"choices": [], "usage": usage})
            yield "data: [DONE]\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream")

    def _usage(self, body: dict) -> dict | None:
        if self.prompt_tokens is None or self.completion_tokens is None:
            return None
        usage: dict = {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.prompt_tokens + self.completion_tokens,
        }
        if self.cost is not None and (body.get("usage") or {}).get("include"):
            usage["cost"] = self.cost
        return usage


def _anthropic_sse(event: dict) -> str:
    return f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"


# The `capabilities` object on a GET /v1/models row, in the live shape
# verified 2026-09-06. There is NO tools flag anywhere in it — the listing
# does not say whether a model calls tools, and the fake must not invent
# one for the reader to find.
ANTHROPIC_LIVE_CAPABILITIES: dict = {
    "image_input": {"supported": True},
    "pdf_input": {"supported": True},
    "thinking": {"supported": True, "types": {"adaptive": True, "enabled": True}},
    "effort": {"supported": True, "levels": ["low", "medium", "high"]},
    "structured_outputs": {"supported": True},
}


@dataclass
class FakeAnthropic:
    """Stands in for api.anthropic.com: POST /v1/messages (streamed with the
    documented event sequence, or a whole message) and GET /v1/models
    (paged). `blocks` is the content the fake "generates": a str is a text
    block, a dict {name, input} is a tool_use block. Every request's
    headers and body are recorded for the tests to read back."""

    blocks: tuple = ("Hello",)
    stop_reason: str = "end_turn"
    input_tokens: int = 25
    output_tokens: int = 12
    # Prompt-cache counts stated on message_start (S10); None = not stated.
    cache_read_input_tokens: int | None = None
    cache_creation_input_tokens: int | None = None
    status: int = 200
    error_body: dict | None = None
    # Emit an in-stream `error` event after this many blocks (None: never).
    error_after: int | None = None
    # End the stream WITHOUT message_stop (a dropped upstream).
    truncate: bool = False
    models: tuple[str, ...] = ("claude-opus-5", "claude-sonnet-5")
    models_status: int = 200
    page_size: int = 1000
    # api.anthropic.com's /v1/models is behind x-api-key; a proxy's may be
    # public. `accepts_key` None = any key is fine (the pre-existing tests'
    # shape); set it and /v1/models (unless public) and /v1/messages 401
    # any other key. `models_wrong_key_status` overrides what a wrong key
    # gets on /v1/models (e.g. 429) when the listing is not public.
    accepts_key: str | None = None
    models_public: bool = False
    models_wrong_key_status: int = 401
    # The `capabilities` object stamped on every /v1/models row (the live
    # shape by default); None leaves it off, as an older proxy would.
    model_capabilities: dict | None = field(
        default_factory=lambda: copy.deepcopy(ANTHROPIC_LIVE_CAPABILITIES)
    )
    seen: list[tuple[str, dict | None]] = field(default_factory=list)
    seen_headers: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.app = Starlette(
            routes=[
                Route("/v1/messages", self._messages, methods=["POST"]),
                Route("/v1/models", self._models, methods=["GET"]),
            ]
        )

    async def _record(self, request) -> dict | None:
        raw = await request.body()
        body = json.loads(raw) if raw else None
        self.seen.append((request.url.path, body))
        self.seen_headers.append({k.lower(): v for k, v in request.headers.items()})
        return body

    def _content_blocks(self) -> list[dict]:
        out = []
        for index, block in enumerate(self.blocks):
            if isinstance(block, str):
                out.append({"type": "text", "text": block})
            else:
                out.append(
                    {
                        "type": "tool_use",
                        "id": f"toolu_{index:02d}",
                        "name": block["name"],
                        "input": block.get("input", {}),
                    }
                )
        return out

    @staticmethod
    def _invalid(body: dict | None) -> str | None:
        """The Messages API's request rules this fake refuses like the real
        one does: max_tokens present, a non-empty messages array whose first
        role is user, roles alternating, and every tool_result answering a
        tool_use earlier in the same request."""
        if not body or not isinstance(body.get("max_tokens"), int) or body["max_tokens"] < 1:
            return "max_tokens: field required"
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return "messages: at least one message is required"
        if messages[0].get("role") != "user":
            return 'messages: first message must use the "user" role'
        seen: set[str] = set()
        last = None
        for message in messages:
            role = message.get("role")
            if role == last:
                return 'messages: roles must alternate between "user" and "assistant"'
            last = role
            content = message.get("content")
            if isinstance(content, list):
                for block in content:
                    if role == "assistant" and block.get("type") == "tool_use":
                        seen.add(str(block.get("id")))
                    if role == "user" and block.get("type") == "tool_result":
                        if str(block.get("tool_use_id")) not in seen:
                            return (
                                f"messages: tool_result {block.get('tool_use_id')!r} has no "
                                "matching tool_use"
                            )
            elif isinstance(content, str) and not content:
                return "messages: text content blocks must be non-empty"
        for key in ("temperature", "top_p", "top_k"):
            if key in body:
                return f"{key}: not supported on this model"
        return None

    def _key_ok(self, request) -> bool:
        if self.accepts_key is None:
            return True
        return request.headers.get("x-api-key") == self.accepts_key

    def _start_usage(self) -> dict:
        usage: dict = {"input_tokens": self.input_tokens, "output_tokens": 1}
        if self.cache_read_input_tokens is not None:
            usage["cache_read_input_tokens"] = self.cache_read_input_tokens
        if self.cache_creation_input_tokens is not None:
            usage["cache_creation_input_tokens"] = self.cache_creation_input_tokens
        return usage

    async def _messages(self, request):
        body = await self._record(request)
        if not self._key_ok(request):
            return JSONResponse(
                {
                    "type": "error",
                    "error": {"type": "authentication_error", "message": "invalid x-api-key"},
                },
                status_code=401,
            )
        invalid = self._invalid(body)
        if invalid is not None:
            return JSONResponse(
                {"type": "error", "error": {"type": "invalid_request_error", "message": invalid}},
                status_code=400,
            )
        if self.status != 200:
            return JSONResponse(
                self.error_body
                or {"type": "error", "error": {"type": "invalid_request_error", "message": "nope"}},
                status_code=self.status,
            )
        model = (body or {}).get("model", "claude-fake")
        if not (body or {}).get("stream"):
            return JSONResponse(
                {
                    "id": "msg_fake",
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": self._content_blocks(),
                    "stop_reason": self.stop_reason,
                    "stop_sequence": None,
                    "usage": {**self._start_usage(), "output_tokens": self.output_tokens},
                }
            )

        async def stream():
            yield _anthropic_sse(
                {
                    "type": "message_start",
                    "message": {
                        "id": "msg_fake",
                        "type": "message",
                        "role": "assistant",
                        "model": model,
                        "content": [],
                        "stop_reason": None,
                        "usage": self._start_usage(),
                    },
                }
            )
            yield 'event: ping\ndata: {"type": "ping"}\n\n'
            for index, block in enumerate(self._content_blocks()):
                if self.error_after is not None and index == self.error_after:
                    yield _anthropic_sse(
                        {
                            "type": "error",
                            "error": {"type": "overloaded_error", "message": "Overloaded"},
                        }
                    )
                    return
                if block["type"] == "text":
                    yield _anthropic_sse(
                        {
                            "type": "content_block_start",
                            "index": index,
                            "content_block": {"type": "text", "text": ""},
                        }
                    )
                    text = block["text"]
                    for piece in (text[: len(text) // 2], text[len(text) // 2 :]):
                        if piece:
                            yield _anthropic_sse(
                                {
                                    "type": "content_block_delta",
                                    "index": index,
                                    "delta": {"type": "text_delta", "text": piece},
                                }
                            )
                else:
                    yield _anthropic_sse(
                        {
                            "type": "content_block_start",
                            "index": index,
                            "content_block": {
                                "type": "tool_use",
                                "id": block["id"],
                                "name": block["name"],
                                "input": {},
                            },
                        }
                    )
                    payload = json.dumps(block["input"])
                    yield _anthropic_sse(
                        {
                            "type": "content_block_delta",
                            "index": index,
                            "delta": {"type": "input_json_delta", "partial_json": ""},
                        }
                    )
                    for piece in (payload[: len(payload) // 2], payload[len(payload) // 2 :]):
                        yield _anthropic_sse(
                            {
                                "type": "content_block_delta",
                                "index": index,
                                "delta": {"type": "input_json_delta", "partial_json": piece},
                            }
                        )
                yield _anthropic_sse({"type": "content_block_stop", "index": index})
            if self.truncate:
                return
            yield _anthropic_sse(
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": self.stop_reason, "stop_sequence": None},
                    "usage": {"output_tokens": self.output_tokens},
                }
            )
            yield _anthropic_sse({"type": "message_stop"})

        return StreamingResponse(stream(), media_type="text/event-stream")

    async def _models(self, request):
        await self._record(request)
        if not self.models_public and not self._key_ok(request):
            return JSONResponse(
                {
                    "type": "error",
                    "error": {"type": "authentication_error", "message": "invalid x-api-key"},
                },
                status_code=self.models_wrong_key_status,
            )
        if self.models_status != 200:
            return JSONResponse(
                {
                    "type": "error",
                    "error": {"type": "authentication_error", "message": "invalid x-api-key"},
                },
                status_code=self.models_status,
            )
        after = request.query_params.get("after_id")
        ids = list(self.models)
        start = ids.index(after) + 1 if after in ids else 0
        page = ids[start : start + self.page_size]
        has_more = start + self.page_size < len(ids)
        rows = []
        for m in page:
            row: dict = {"type": "model", "id": m, "display_name": m.title()}
            if self.model_capabilities is not None:
                row["capabilities"] = self.model_capabilities
            rows.append(row)
        return JSONResponse(
            {
                "data": rows,
                "has_more": has_more,
                "first_id": page[0] if page else None,
                "last_id": page[-1] if page else None,
            }
        )


# ── S10a: the two upstream catalogues a pull is sized from ────────────────


@dataclass
class FakeHFHub:
    """Stands in for huggingface.co's Hub API, in the shapes verified live on
    2026-09-06: GET /api/models (a JSON list, paged by an opaque `cursor`
    query param advertised in the response's `Link: <url>; rel="next"`
    header) and GET /api/models/{org}/{repo}?blobs=true (the detail body,
    `siblings` included). Page N of `pages` is served for cursor
    "cursor-N" (page 0 for no cursor); `status` forces a non-200 on the
    listing (a 429 with `headers` like Retry-After / ratelimit). Every
    request's path and RAW query string is recorded, so a test can pin the
    exact query the client builds."""

    pages: tuple[list[dict], ...] = ([],)
    repos: dict[str, dict] = field(default_factory=dict)
    # "org/repo" -> (status, body) for a detail the Hub refuses (gated, private).
    refusals: dict[str, tuple[int, dict]] = field(default_factory=dict)
    status: int = 200
    headers: dict[str, str] = field(default_factory=dict)
    delay_s: float = 0.0
    seen: list[tuple[str, str]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.app = Starlette(
            routes=[
                Route("/api/models", self._search, methods=["GET"]),
                Route("/api/models/{org}/{repo}", self._detail, methods=["GET"]),
            ]
        )

    async def _record(self, request) -> None:
        self.seen.append((request.url.path, request.url.query))
        if self.delay_s:
            await asyncio.sleep(self.delay_s)

    async def _search(self, request):
        await self._record(request)
        if self.status != 200:
            return JSONResponse(
                {"error": "Too Many Requests"}, status_code=self.status, headers=self.headers
            )
        cursor = request.query_params.get("cursor")
        index = int(cursor.removeprefix("cursor-")) if cursor else 0
        page = list(self.pages[index]) if index < len(self.pages) else []
        headers = {}
        if index + 1 < len(self.pages):
            rest = "&".join(
                f"{k}={v}" for k, v in request.query_params.multi_items() if k != "cursor"
            )
            headers["Link"] = (
                f'<https://huggingface.co/api/models?{rest}&cursor=cursor-{index + 1}>; rel="next"'
            )
        return JSONResponse(page, headers=headers)

    async def _detail(self, request):
        await self._record(request)
        if self.status != 200:  # a rate limit covers every /api call alike
            return JSONResponse(
                {"error": "Too Many Requests"}, status_code=self.status, headers=self.headers
            )
        key = f"{request.path_params['org']}/{request.path_params['repo']}"
        if key in self.refusals:
            status, body = self.refusals[key]
            return JSONResponse(body, status_code=status)
        if key not in self.repos:
            return JSONResponse({"error": "Repository not found"}, status_code=404)
        return JSONResponse(self.repos[key])


@dataclass
class FakeOllamaRegistry:
    """Stands in for registry.ollama.ai, as verified live on 2026-09-06:
    GET /v2/{ns}/{name}/manifests/{tag} answers the manifest as text/plain
    with a Docker-Content-Digest header, GET /v2/{ns}/{name}/blobs/{digest}
    answers the config blob, and anything unknown is a registry-shaped 404.
    Keys of `manifests` and `digests` are "ns/name/tag"; keys of `blobs`
    are digests."""

    manifests: dict[str, dict] = field(default_factory=dict)
    blobs: dict[str, dict] = field(default_factory=dict)
    digests: dict[str, str] = field(default_factory=dict)
    status: int | None = None  # force every answer to this status
    # The live registry (2026-09-06) answers a blob GET with a 307 to its
    # blob store on another host; the store route below plays that host.
    redirect_blobs: bool = False
    delay_s: float = 0.0
    seen: list[tuple[str, dict[str, str]]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.app = Starlette(
            routes=[
                Route("/v2/{ns}/{name}/manifests/{tag}", self._manifest, methods=["GET"]),
                Route("/v2/{ns}/{name}/blobs/{digest}", self._blob, methods=["GET"]),
                Route("/store/{digest}", self._store, methods=["GET"]),
            ]
        )

    async def _record(self, request) -> None:
        self.seen.append((request.url.path, {k.lower(): v for k, v in request.headers.items()}))
        if self.delay_s:
            await asyncio.sleep(self.delay_s)

    @staticmethod
    def _not_found(code: str):
        return JSONResponse(
            {"errors": [{"code": code, "message": code.lower().replace("_", " ")}]},
            status_code=404,
        )

    async def _manifest(self, request):
        await self._record(request)
        if self.status is not None:
            return JSONResponse({"errors": [{"code": "FORCED"}]}, status_code=self.status)
        p = request.path_params
        key = f"{p['ns']}/{p['name']}/{p['tag']}"
        if key not in self.manifests:
            return self._not_found("MANIFEST_UNKNOWN")
        headers = {}
        if key in self.digests:
            headers["Docker-Content-Digest"] = self.digests[key]
        return Response(json.dumps(self.manifests[key]), media_type="text/plain", headers=headers)

    async def _blob(self, request):
        await self._record(request)
        if self.status is not None:
            return JSONResponse({"errors": [{"code": "FORCED"}]}, status_code=self.status)
        digest = request.path_params["digest"]
        if digest not in self.blobs:
            return self._not_found("BLOB_UNKNOWN")
        if self.redirect_blobs:
            return Response(
                status_code=307, headers={"Location": f"https://blobs.test/store/{digest}"}
            )
        return Response(json.dumps(self.blobs[digest]), media_type="application/octet-stream")

    async def _store(self, request):
        await self._record(request)
        digest = request.path_params["digest"]
        if digest not in self.blobs:
            return Response(status_code=404)
        return Response(json.dumps(self.blobs[digest]), media_type="application/octet-stream")
