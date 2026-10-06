"""The MCP client's legacy era (S37a). Servers that speak 2025-11-25 or older
— Home Assistant's /api/mcp, DeepWiki and the Playwright MCP engine, all
measured — are spoken to through the initialize handshake, never refused for
being old."""

from __future__ import annotations

import contextlib
import json

import httpx
import pytest

from app.mcp import client, fake

URL = "http://old.mcp.invalid/mcp"
ORIGIN = "http://old.mcp.invalid"
ECHO = fake.FakeTool("echo", results=({"text": "hello"},))


@contextlib.contextmanager
def planted(spec: fake.FakeSpec):
    server = fake.FakeServer(spec)
    handle = client.plant({ORIGIN: fake.transport(server)})
    try:
        yield server, client.Endpoint(name="old", url=URL)
    finally:
        client.unplant(handle)


async def test_a_home_assistant_style_server_is_spoken_to_in_the_2025_era():
    spec = fake.FakeSpec(era="legacy", legacy_refusal="200", title="Home Assistant", tools=(ECHO,))
    with planted(spec) as (server, endpoint):
        found = await client.probe(endpoint)
        assert (await client.call(endpoint, "echo", {})).text == "hello"
    assert (found.protocol, found.title) == ("legacy:2025-11-25", "Home Assistant")
    methods = [c["method"] for c in server.calls]
    assert methods[:3] == ["server/discover", "initialize", "notifications/initialized"]
    last = server.calls[-1]
    assert last["headers"]["mcp-session-id"] == fake.SESSION
    assert last["headers"]["mcp-protocol-version"] == "2025-11-25"
    assert "mcp-method" not in last["headers"]


async def test_a_deepwiki_style_refusal_falls_back_to_the_handshake():
    spec = fake.FakeSpec(era="legacy", legacy_refusal="400", respond="sse", tools=(ECHO,))
    with planted(spec) as (_, endpoint):
        assert (await client.probe(endpoint)).protocol == "legacy:2025-11-25"
        listed = await client.list_tools(endpoint)
    assert [t["name"] for t in listed.tools] == ["echo"]
    assert listed.ttl_ms == client.LEGACY_TOOLS_TTL_MS


async def test_a_playwright_style_refusal_falls_back_to_the_handshake():
    """Ruling X3: the real Playwright MCP engine (v0.0.82, measured
    2026-10-01 — S38's own browser engine) answers server/discover with
    HTTP 400 and JSON-RPC -32000 "Bad Request: Server not initialized" — a
    third shape beside Home Assistant's 200 and DeepWiki's 400/-32600,
    folded into the same fallback."""
    spec = fake.FakeSpec(era="legacy", legacy_refusal="playwright", tools=(ECHO,))
    with planted(spec) as (server, endpoint):
        found = await client.probe(endpoint)
    assert found.protocol == "legacy:2025-11-25"
    discover = server.calls[0]
    assert discover["method"] == "server/discover"


async def test_an_expired_session_is_established_again_once():
    with planted(fake.FakeSpec(era="legacy", tools=(ECHO,))) as (server, endpoint):
        await client.call(endpoint, "echo", {})
        server.expire_session()
        assert (await client.call(endpoint, "echo", {})).text == "hello"
    assert [c["method"] for c in server.calls].count("initialize") == 2


async def test_a_server_that_answers_neither_era_is_refused_in_words():
    async def teapot(scope, receive, send):
        await receive()
        await send(
            {
                "type": "http.response.start",
                "status": 418,
                "headers": [(b"content-type", b"text/plain")],
            }
        )
        await send({"type": "http.response.body", "body": b"I am a teapot"})

    handle = client.plant({ORIGIN: httpx.ASGITransport(app=teapot)})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.probe(client.Endpoint(name="pot", url=URL))
    finally:
        client.unplant(handle)
    assert "is not an MCP server this client can speak to" in caught.value.reason
    assert "418" in caught.value.reason and "teapot" in caught.value.reason


async def test_an_unsupported_version_error_listing_older_versions_is_followed():
    """A -32022 whose supported list has no 2026-07-28: speak the newest
    version it lists, through the handshake."""
    legacy = fake.FakeServer(fake.FakeSpec(era="legacy", tools=(ECHO,)))

    async def app(scope, receive, send):
        body = b""
        while True:
            event = await receive()
            body += event.get("body", b"")
            if not event.get("more_body"):
                break
        if json.loads(body).get("method") == "server/discover":
            error = {
                "jsonrpc": "2.0",
                "id": 1,
                "error": {
                    "code": -32022,
                    "message": "Unsupported protocol version",
                    "data": {"supported": ["2025-06-18"]},
                },
            }
            await send(
                {
                    "type": "http.response.start",
                    "status": 400,
                    "headers": [(b"content-type", b"application/json")],
                }
            )
            await send({"type": "http.response.body", "body": json.dumps(error).encode()})
            return
        sent = False

        async def replay():
            nonlocal sent
            if sent:
                return {"type": "http.disconnect"}
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        await legacy(scope, replay, send)

    handle = client.plant({ORIGIN: httpx.ASGITransport(app=app)})
    try:
        found = await client.probe(client.Endpoint(name="old", url=URL))
    finally:
        client.unplant(handle)
    assert found.protocol == "legacy:2025-06-18"
    assert legacy.calls[0]["params"]["protocolVersion"] == "2025-06-18"


# -- controller carry 2: legacy progress carries a token too ------------------


async def test_legacy_sse_progress_reaches_the_callback():
    lines: list[str] = []
    spec = fake.FakeSpec(era="legacy", respond="sse", progress=True, tools=(ECHO,))
    with planted(spec) as (_, endpoint):
        assert (await client.call(endpoint, "echo", {}, progress=lines.append)).text == "hello"
    assert lines == ["1 of 2 — halfway"]


async def test_a_legacy_progress_callback_makes_the_client_declare_a_token():
    """The legacy branch of `_framed` used to send no `_meta` at all, so a
    legacy call's progress callback was never driven — the fake's legacy
    progress is gated on the same token the modern branch sends."""
    spec = fake.FakeSpec(era="legacy", respond="sse", progress=True, tools=(ECHO,))
    with planted(spec) as (server, endpoint):
        await client.call(endpoint, "echo", {})
        assert "progressToken" not in (server.calls[-1]["params"].get("_meta") or {})
        await client.call(endpoint, "echo", {}, progress=lambda _l: None)
    # Exact equality, not just containment: the legacy fake does not check
    # _meta, so sending the modern io.modelcontextprotocol/* keys too would
    # still pass a weaker assertion (fix round 1, item 4).
    assert server.calls[-1]["params"]["_meta"] == {"progressToken": str(server.calls[-1]["id"])}


# -- fix round 1, item 1: true handshake failure reasons ----------------------


async def test_a_proxy_502_during_the_handshake_is_stated_without_a_false_claim():
    """A proxy's 502 used to read "is not an MCP server this client can
    speak to" — a false claim for a common homelab shape (a reverse proxy
    in front of a real server that is merely down or restarting)."""

    async def bad_gateway(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            502,
            headers={"content-type": "text/html"},
            content=b"<html><body>502 Bad Gateway</body></html>",
        )

    handle = client.plant({ORIGIN: httpx.MockTransport(bad_gateway)})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.probe(client.Endpoint(name="ha", url=URL))
    finally:
        client.unplant(handle)
    assert "is not an MCP server" not in caught.value.reason
    assert "502" in caught.value.reason and "Bad Gateway" in caught.value.reason
    assert caught.value.reachable is True


async def test_initialize_timing_out_says_so_not_http_none():
    async def discover_then_hang(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body.get("method") == "server/discover":
            payload = {
                "jsonrpc": "2.0",
                "id": body.get("id"),
                "error": {"code": -32601, "message": "Method not found"},
            }
            return httpx.Response(200, headers={"content-type": "application/json"}, json=payload)
        raise httpx.ReadTimeout("fixture")

    handle = client.plant({ORIGIN: httpx.MockTransport(discover_then_hang)})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.probe(client.Endpoint(name="old", url=URL))
    finally:
        client.unplant(handle)
    assert "HTTP None" not in caught.value.reason
    assert "did not answer the" in caught.value.reason and "handshake" in caught.value.reason
    assert caught.value.reachable is True


async def test_an_initialize_json_rpc_refusal_carries_the_servers_words():
    """A TS-SDK-style server answering `initialize` with its own JSON-RPC
    error ("Server already initialized") must not be swallowed into the
    generic "not an MCP server" sentence — her Error: text and the row's
    last_error both read this."""

    async def rpc_refusal(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body.get("method") == "server/discover":
            payload = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32000,
                    "message": "Bad Request: Mcp-Session-Id header is required",
                },
            }
            return httpx.Response(400, headers={"content-type": "application/json"}, json=payload)
        payload = {
            "jsonrpc": "2.0",
            "id": None,
            "error": {"code": -32600, "message": "Invalid Request: Server already initialized"},
        }
        return httpx.Response(400, headers={"content-type": "application/json"}, json=payload)

    handle = client.plant({ORIGIN: httpx.MockTransport(rpc_refusal)})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.probe(client.Endpoint(name="old", url=URL))
    finally:
        client.unplant(handle)
    assert "Server already initialized" in caught.value.reason
    assert "-32600" in caught.value.reason
    assert caught.value.reachable is True


async def test_the_notification_timing_out_says_so_not_http_none():
    """Same treatment as `initialize` itself: no answer to
    notifications/initialized is "did not answer", never "(HTTP None)"."""

    async def initialize_then_hang(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        method = body.get("method")
        if method == "server/discover":
            payload = {
                "jsonrpc": "2.0",
                "id": body.get("id"),
                "error": {"code": -32601, "message": "Method not found"},
            }
            return httpx.Response(200, headers={"content-type": "application/json"}, json=payload)
        if method == "initialize":
            payload = {
                "jsonrpc": "2.0",
                "id": body.get("id"),
                "result": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "serverInfo": {"name": "x"},
                },
            }
            return httpx.Response(
                200,
                headers={"content-type": "application/json", "mcp-session-id": "s-1"},
                json=payload,
            )
        raise httpx.ReadTimeout("fixture")

    handle = client.plant({ORIGIN: httpx.MockTransport(initialize_then_hang)})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.probe(client.Endpoint(name="old", url=URL))
    finally:
        client.unplant(handle)
    assert "HTTP None" not in caught.value.reason
    assert "did not answer the" in caught.value.reason and "handshake" in caught.value.reason
    assert caught.value.reachable is True


# -- fix round 1, item 2: only known legacy versions, visible-ASCII session --


def _initialize_answers(method: str, body: dict, *, version, session="s-1"):
    if method == "server/discover":
        payload = {
            "jsonrpc": "2.0",
            "id": body.get("id"),
            "error": {"code": -32601, "message": "Method not found"},
        }
        return httpx.Response(200, headers={"content-type": "application/json"}, json=payload)
    if method == "initialize":
        payload = {
            "jsonrpc": "2.0",
            "id": body.get("id"),
            "result": {"protocolVersion": version, "capabilities": {}, "serverInfo": {"name": "x"}},
        }
        return httpx.Response(
            200,
            headers={"content-type": "application/json", "mcp-session-id": session},
            json=payload,
        )
    return httpx.Response(202)


async def test_a_non_ascii_protocol_version_is_a_stated_refusal_not_a_crash():
    """Probe B: a server-supplied protocolVersion using U+2011 (non-breaking
    hyphen) instead of ASCII '-' used to escape probe() as a raw
    UnicodeEncodeError once that string was sent back as a header."""

    async def answers(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return _initialize_answers(body.get("method"), body, version="2025‑11‑25")

    handle = client.plant({ORIGIN: httpx.MockTransport(answers)})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.probe(client.Endpoint(name="old", url=URL))
    finally:
        client.unplant(handle)
    assert "unsupported protocol version" in caught.value.reason
    assert caught.value.reachable is True


async def test_an_unknown_protocol_version_is_a_stated_refusal_not_accepted():
    """Probe J: any string used to be accepted verbatim ("1.0" ->
    legacy:1.0) and then sent back as MCP-Protocol-Version on every later
    request. Only a KNOWN_LEGACY version is accepted now."""

    async def answers(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return _initialize_answers(body.get("method"), body, version="1.0")

    handle = client.plant({ORIGIN: httpx.MockTransport(answers)})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.probe(client.Endpoint(name="old", url=URL))
    finally:
        client.unplant(handle)
    assert "unsupported protocol version" in caught.value.reason and "1.0" in caught.value.reason
    assert caught.value.reachable is True


async def test_a_version_with_crlf_is_a_stated_refusal_reachable_true():
    """A version with CR/LF used to read "nothing was sent", reachable
    False, for a server that just answered — the same unsupported-version
    rejection as above, not a transport-level classification."""

    async def answers(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return _initialize_answers(body.get("method"), body, version="2025-11-25\r\nX-Injected: 1")

    handle = client.plant({ORIGIN: httpx.MockTransport(answers)})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.probe(client.Endpoint(name="old", url=URL))
    finally:
        client.unplant(handle)
    assert "unsupported protocol version" in caught.value.reason
    assert caught.value.reachable is True


async def test_a_session_id_with_characters_a_header_cannot_carry_is_refused():
    """The 2025 spec requires a visible-ASCII Mcp-Session-Id; a padded or
    control-bearing one used to be echoed verbatim on every later request."""

    async def answers(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return _initialize_answers(
            body.get("method"), body, version="2025-11-25", session=" padded-session "
        )

    handle = client.plant({ORIGIN: httpx.MockTransport(answers)})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.probe(client.Endpoint(name="old", url=URL))
    finally:
        client.unplant(handle)
    assert "session id" in caught.value.reason
    assert caught.value.reachable is True


# -- fix round 1, item 3: Playwright fidelity, client-level regression pin ----


async def test_a_playwright_style_forgotten_session_is_a_plain_text_404():
    """The real engine's cached bundle answers a forgotten session with a
    PLAIN-TEXT 404 "Session not found", never JSON-RPC's -32001 (see
    test_mcp_fake.py for the wire-shape pin). The client's re-establish-once
    logic reads only the status code, so this stays green either way — a
    regression pin against a future change that starts reading the body."""
    spec = fake.FakeSpec(era="legacy", legacy_refusal="playwright", tools=(ECHO,))
    with planted(spec) as (server, endpoint):
        await client.call(endpoint, "echo", {})
        server.expire_session()
        assert (await client.call(endpoint, "echo", {})).text == "hello"
    assert [c["method"] for c in server.calls].count("initialize") == 2
