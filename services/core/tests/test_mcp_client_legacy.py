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
    assert server.calls[-1]["params"]["_meta"]["progressToken"] == str(server.calls[-1]["id"])
