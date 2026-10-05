"""A spec-enforcing MCP server, in process (S37a).

Tests plant it with `client.plant` to exercise the client, and eval cases
declare one (`Case.mcp_servers`) so a turn can use a server whose answers are
fixed. It lives in `app/` rather than `tests/` because the eval runner runs
inside the deployed core, and S38's evals plant a fake Playwright engine the
same way.

It is strict on purpose. A fake that accepts any request proves nothing about
the client (S10-pre's FakeAnthropic lesson): in the MODERN era it refuses a
request whose headers and `_meta` break the 2026-07-28 rules exactly as the
specification says a server must; in the LEGACY era it demands the initialize
handshake and the session header it handed out. `calls` records what arrived,
so a test asserts on what the client SENT, not on what the fake forgave.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import httpx

MODERN = "2026-07-28"
LEGACY_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
SESSION = "fake-session-1"
_JSON = {"content-type": "application/json"}


@dataclass(frozen=True)
class FakeTool:
    """One tool the fake offers, and what it answers, in order (the last answer
    repeats). An answer is a dict with any of:

      text            a text content block
      structured      structuredContent
      is_error        true: the tool ran and failed (isError)
      image           a mime type: an image block of `bytes` zero bytes
      error           {"code": int, "message": str}: a JSON-RPC error instead
      request_state   a string: answer input_required with this state first,
                      and give the rest of this answer once it is echoed
      input_requests  an object: answer input_required asking for these
    """

    name: str
    description: str = ""
    input_schema: dict = field(default_factory=lambda: {"type": "object", "properties": {}})
    results: tuple[dict, ...] = ({"text": "ok"},)

    def listed(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
        }


@dataclass(frozen=True)
class FakeSpec:
    title: str = "Fake MCP server"
    era: str = "modern"  # "modern" | "legacy"
    # How a LEGACY fake refuses a 2026-07-28 server/discover — the three
    # shapes measured in the wild: "200" is HTTP 200 carrying a JSON-RPC
    # error (Home Assistant's /api/mcp, 2026.9); "400" is HTTP 400 with
    # -32600 and a sentence listing its versions (DeepWiki, probed
    # 2026-09-30); "playwright" is HTTP 400 with -32000 "Bad Request: Server
    # not initialized" (the Playwright MCP engine, v0.0.82, measured
    # 2026-10-01 — S38's own browser engine).
    legacy_refusal: str = "200"
    respond: str = "json"  # "json" | "sse"
    progress: bool = False  # sse only: a notifications/progress before each tools/call answer
    token: str | None = None  # set: anything but "Authorization: Bearer <token>" gets 401
    page_size: int = 0  # 0: one tools/list page; n: pages of n joined by nextCursor
    ttl_ms: int = 60_000
    tools: tuple[FakeTool, ...] = ()


class FakeServer:
    """The ASGI app for one FakeSpec."""

    def __init__(self, spec: FakeSpec) -> None:
        self.spec = spec
        self.calls: list[dict] = []
        self.session_live = False
        # Tests: the next SSE answer's stream ends before the answer is sent.
        self.drop_next_answer = False
        self._served: dict[str, int] = {}

    def expire_session(self) -> None:
        self.session_live = False

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        body = b""
        while True:
            event = await receive()
            body += event.get("body", b"")
            if not event.get("more_body"):
                break
        status, out, payload = self._handle(scope["method"], headers, body)
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(k.encode("latin-1"), v.encode("latin-1")) for k, v in out.items()],
            }
        )
        await send({"type": "http.response.body", "body": payload})

    # -- one request ---------------------------------------------------------

    def _handle(self, method: str, headers: dict[str, str], body: bytes) -> tuple[int, dict, bytes]:
        if method != "POST":
            return 405, {}, b""
        if (
            self.spec.token is not None
            and headers.get("authorization") != f"Bearer {self.spec.token}"
        ):
            return 401, _JSON, _dump({"error": "unauthorized"})
        try:
            message = json.loads(body)
        except ValueError:
            return 400, _JSON, _error(None, -32700, "Parse error")
        if (
            not isinstance(message, dict)
            or message.get("jsonrpc") != "2.0"
            or not isinstance(message.get("method"), str)
        ):
            return 400, _JSON, _error(None, -32600, "Invalid Request")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        rid, name = message.get("id"), message["method"]
        self.calls.append({"id": rid, "method": name, "params": params, "headers": headers})
        if self.spec.era == "modern":
            return self._modern(headers, rid, name, params)
        return self._legacy(headers, rid, name, params)

    def _modern(self, headers, rid, method, params):
        accept = headers.get("accept", "")
        if "application/json" not in accept or "text/event-stream" not in accept:
            return (
                406,
                _JSON,
                _error(rid, -32600, "Accept must list application/json and text/event-stream"),
            )
        meta = params.get("_meta") if isinstance(params.get("_meta"), dict) else {}
        version = meta.get("io.modelcontextprotocol/protocolVersion")
        if not isinstance(version, str) or "io.modelcontextprotocol/clientCapabilities" not in meta:
            return (
                400,
                _JSON,
                _error(rid, -32602, "missing protocolVersion or clientCapabilities in _meta"),
            )
        if headers.get("mcp-protocol-version") != version:
            return 400, _JSON, _error(rid, -32020, "Header mismatch: MCP-Protocol-Version")
        if version != MODERN:
            return (
                400,
                _JSON,
                _error(rid, -32022, "Unsupported protocol version", {"supported": [MODERN]}),
            )
        if headers.get("mcp-method") != method:
            return 400, _JSON, _error(rid, -32020, "Header mismatch: Mcp-Method")
        if method == "tools/call":
            if _decoded(headers.get("mcp-name")) != params.get("name"):
                return 400, _JSON, _error(rid, -32020, "Header mismatch: Mcp-Name")
            mismatch = self._param_mismatch(headers, params)
            if mismatch is not None:
                return 400, _JSON, _error(rid, -32020, f"Header mismatch: {mismatch}")
        if method == "server/discover":
            info = {"name": "fake", "title": self.spec.title, "version": "1"}
            return self._answer(
                rid,
                {
                    "resultType": "complete",
                    "supportedVersions": [MODERN],
                    "capabilities": {"tools": {}},
                    "_meta": {"io.modelcontextprotocol/serverInfo": info},
                    "ttlMs": 0,
                    "cacheScope": "private",
                },
            )
        if method == "tools/list":
            page = self._page(params.get("cursor"))
            return self._answer(
                rid,
                {
                    "resultType": "complete",
                    **page,
                    "ttlMs": self.spec.ttl_ms,
                    "cacheScope": "private",
                },
            )
        if method == "tools/call":
            return self._call(rid, params, modern=True)
        return 404, _JSON, _error(rid, -32601, f"Method not found: {method}")

    def _legacy(self, headers, rid, method, params):
        if method == "server/discover":
            if self.spec.legacy_refusal == "400":
                versions = ", ".join(sorted(LEGACY_VERSIONS))
                message = (
                    f"Bad Request: Unsupported protocol version: {MODERN}. "
                    f"Supported versions: {versions}"
                )
                return 400, _JSON, _error("server-error", -32600, message)
            if self.spec.legacy_refusal == "playwright":
                # The real engine (TS SDK): id:null, never the request's —
                # it refuses before it has read the request far enough to
                # echo anything.
                return 400, _JSON, _error(None, -32000, "Bad Request: Server not initialized")
            return 200, _JSON, _error(rid, -32601, "Method not found")
        if method == "initialize":
            offered = params.get("protocolVersion")
            version = offered if offered in LEGACY_VERSIONS else LEGACY_VERSIONS[0]
            self.session_live = True
            info = {"name": "fake", "title": self.spec.title, "version": "1"}
            result = {"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": info}
            return self._answer(rid, result, extra={"mcp-session-id": SESSION})
        if headers.get("mcp-session-id") != SESSION:
            return 400, _JSON, _error(rid, -32600, "Bad Request: No valid session ID provided")
        if not self.session_live:
            if self.spec.legacy_refusal == "playwright":
                # The real engine answers a forgotten session with a
                # PLAIN-TEXT 404, not the generic legacy shape's JSON-RPC
                # envelope — replayed from a cached playwright-core bundle.
                return 404, {"content-type": "text/plain"}, b"Session not found"
            return 404, _JSON, _error(rid, -32001, "Session not found")
        if method == "notifications/initialized":
            return 202, {}, b""
        if headers.get("mcp-protocol-version") not in LEGACY_VERSIONS:
            return 400, _JSON, _error(rid, -32600, "Bad Request: Unsupported protocol version")
        if method == "tools/list":
            return self._answer(rid, self._page(params.get("cursor")))
        if method == "tools/call":
            return self._call(rid, params, modern=False)
        return 200, _JSON, _error(rid, -32601, "Method not found")

    # -- answers -------------------------------------------------------------

    def _page(self, cursor: Any) -> dict:
        tools = [tool.listed() for tool in self.spec.tools]
        if not self.spec.page_size:
            return {"tools": tools}
        start = int(cursor) if isinstance(cursor, str) and cursor.isdigit() else 0
        end = start + self.spec.page_size
        page: dict[str, Any] = {"tools": tools[start:end]}
        if end < len(tools):
            page["nextCursor"] = str(end)
        return page

    def _call(self, rid, params, *, modern: bool):
        name = params.get("name")
        tool = next((t for t in self.spec.tools if t.name == name), None)
        if tool is None:
            return 200, _JSON, _error(rid, -32602, f"Unknown tool: {name}")
        index = self._served.get(name, 0)
        canned = tool.results[min(index, len(tool.results) - 1)]
        if canned.get("input_requests") is not None:
            return self._answer(
                rid,
                {"resultType": "input_required", "inputRequests": canned["input_requests"]},
            )
        state = canned.get("request_state")
        if state is not None and params.get("requestState") != state:
            return self._answer(rid, {"resultType": "input_required", "requestState": state})
        self._served[name] = index + 1
        if "error" in canned:
            return 200, _JSON, _error(rid, canned["error"]["code"], canned["error"]["message"])
        result: dict[str, Any] = {"content": [], "isError": bool(canned.get("is_error"))}
        if "text" in canned:
            result["content"].append({"type": "text", "text": canned["text"]})
        if "image" in canned:
            data = base64.b64encode(b"\0" * int(canned.get("bytes", 16))).decode("ascii")
            result["content"].append({"type": "image", "mimeType": canned["image"], "data": data})
        if "structured" in canned:
            result["structuredContent"] = canned["structured"]
        if modern:
            result["resultType"] = "complete"
        meta = params.get("_meta") if isinstance(params.get("_meta"), dict) else {}
        token = meta.get("progressToken") if self.spec.progress else None
        return self._answer(rid, result, progress_token=token)

    def _answer(self, rid, result, *, extra: dict | None = None, progress_token: Any = None):
        response = {"jsonrpc": "2.0", "id": rid, "result": result}
        headers = dict(extra or {})
        if self.spec.respond != "sse":
            return 200, {**_JSON, **headers}, _dump(response)
        events: list[dict] = []
        if progress_token is not None:
            # The spec sends progress only for a request that carried a
            # token, and echoes that same token back — never one the server
            # invents (this fake used to send str(rid) unconditionally).
            events.append(
                {
                    "jsonrpc": "2.0",
                    "method": "notifications/progress",
                    "params": {
                        "progressToken": progress_token,
                        "progress": 1,
                        "total": 2,
                        "message": "halfway",
                    },
                }
            )
        if self.drop_next_answer:
            self.drop_next_answer = False
        else:
            events.append(response)
        stream = ": keep-alive\n\n" + "".join(
            f"event: message\ndata: {json.dumps(event)}\n\n" for event in events
        )
        return 200, {"content-type": "text/event-stream", **headers}, stream.encode("utf-8")

    def _param_mismatch(self, headers: dict[str, str], params: dict) -> str | None:
        tool = next((t for t in self.spec.tools if t.name == params.get("name")), None)
        if tool is None:
            return None
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        for path, header in _annotated(tool.input_schema):
            value: Any = arguments
            for key in path:
                value = value.get(key) if isinstance(value, dict) else None
            sent = headers.get(f"mcp-param-{header.lower()}")
            if value is None:
                if sent is not None:
                    return f"Mcp-Param-{header} sent for an absent value"
                continue
            want = ("true" if value else "false") if isinstance(value, bool) else str(value)
            if _decoded(sent) != want:
                return f"Mcp-Param-{header}"
        return None


class Unreachable(httpx.AsyncBaseTransport):
    """A planted server that cannot be reached: every request is a refused
    connection, as a stopped container or a wrong port would be."""

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(
            "connection refused (a fixture declared unreachable)", request=request
        )


def transport(server: FakeServer) -> httpx.AsyncBaseTransport:
    return httpx.ASGITransport(app=server)


def _annotated(schema: Any, path: tuple = ()) -> Iterator[tuple[tuple, str]]:
    props = schema.get("properties") if isinstance(schema, dict) else None
    for key, prop in (props or {}).items():
        if isinstance(prop, dict):
            if isinstance(prop.get("x-mcp-header"), str):
                yield path + (key,), prop["x-mcp-header"]
            yield from _annotated(prop, path + (key,))


def _decoded(value: str | None) -> str | None:
    if value and value.startswith("=?base64?") and value.endswith("?="):
        return base64.b64decode(value[len("=?base64?") : -2]).decode("utf-8")
    return value


def _dump(obj: Any) -> bytes:
    return json.dumps(obj).encode("utf-8")


def _error(rid: Any, code: int, message: str, data: Any = None) -> bytes:
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return _dump({"jsonrpc": "2.0", "id": rid, "error": error})
