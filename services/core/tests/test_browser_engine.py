"""The one way core calls the engine (S38): the pinned engine's era, its
refusals passed on as answers, a call it could not make stated, and one
tool's calls never split by another's."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app.browser import engine
from app.mcp import client, fake
from tests.browser_engine import ORIGIN, engine_tool, fake_engine


class _TimesOutOnToolCall(httpx.AsyncBaseTransport):
    """Wraps a real engine transport for every request except tools/call,
    which never answers. app/mcp/fake.py offers no direct way to drive a
    request that never answers within a short timeout_s, so this is the
    narrowest substitute (fix round 1, G31, item 1): the handshake and era
    detection still run exactly as the strict fake would do them, and only
    the tool call itself hangs -- simulated as an immediate ReadTimeout
    rather than an actual wait, the same way test_mcp_client_legacy.py's
    own `discover_then_hang` does it, for a fast, deterministic test."""

    def __init__(self, inner: httpx.AsyncBaseTransport) -> None:
        self._inner = inner

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body.get("method") == "tools/call":
            raise httpx.ReadTimeout("fixture: the engine never answers this call")
        return await self._inner.handle_async_request(request)


async def test_the_engine_is_spoken_to_in_its_own_era_and_its_answer_is_read():
    with fake_engine(engine_tool("browser_navigate", "navigate-index")) as server:
        async with engine.session():
            answer = await engine.call("browser_navigate", {"url": "http://site:8000/index.html"})
    assert (answer.url, answer.title, answer.error) == (
        "http://site:8000/index.html",
        "Capture index",
        None,
    )
    methods = [call["method"] for call in server.calls]
    assert "initialize" in methods and methods[-1] == "tools/call"


async def test_the_engines_own_refusal_is_the_answers_error():
    with fake_engine(engine_tool("browser_click", "click-stale-ref")):
        async with engine.session():
            answer = await engine.call("browser_click", {"target": "e9999"})
    assert answer.error == (
        "Ref e9999 not found in the current page snapshot. Try capturing new snapshot."
    )


async def test_an_error_with_no_error_section_still_says_what_it_was():
    tool = fake.FakeTool("browser_click", results=({"text": "boom: it broke", "is_error": True},))
    with fake_engine(tool):
        async with engine.session():
            answer = await engine.call("browser_click", {"target": "e1"})
    assert answer.error == "boom: it broke"


async def test_an_unreachable_engine_is_a_stated_failure():
    handle = client.plant({ORIGIN: fake.Unreachable()})
    try:
        with pytest.raises(engine.EngineError) as caught:
            async with engine.session():
                await engine.call("browser_navigate", {"url": "https://example.com"})
    finally:
        client.unplant(handle)
    # G31: the client's own reason, with no claim of engine.py's own added
    # on top -- so the origin appears exactly once (it used to appear
    # twice: once in engine.py's own composed prefix, once inside the
    # client's reason), and reachable is read as a fact, never out of
    # prose.
    assert caught.value.reachable is False
    assert caught.value.reason == ("could not reach browser at http://browser:8931 — ConnectError")
    assert caught.value.reason.count("http://browser:8931") == 1


async def test_the_engines_rpc_error_is_reachable_true():
    # G31, reachable=True path 1: a JSON-RPC error answer. The server HAD
    # the request and said so in its own words; engine.py adds no claim
    # that it "answered, but not usefully" on top of that.
    tool = fake.FakeTool("browser_click", results=({"error": {"code": -32000, "message": "boom"}},))
    with fake_engine(tool):
        async with engine.session():
            with pytest.raises(engine.EngineError) as caught:
                await engine.call("browser_click", {"target": "e1"})
    assert caught.value.reachable is True
    assert caught.value.reason == "browser answered with an error: boom (-32000)"
    assert "but not usefully" not in caught.value.reason


async def test_a_call_that_never_answers_within_its_timeout_is_reachable_true():
    # G31, reachable=True path 2: no answer at all within timeout_s -- the
    # client's own "may or may not have run" wording, passed through
    # unchanged. This is the reviewer's own reproduced defect: the old code
    # wrapped this exact reason as "answered, but not usefully: browser did
    # not answer at all...", which is self-contradictory.
    server = fake.FakeServer(
        fake.FakeSpec(
            title="Playwright",
            era="legacy",
            legacy_refusal="playwright",
            respond="sse",
            tools=(engine_tool("browser_navigate", "navigate-index"),),
        )
    )
    handle = client.plant({ORIGIN: _TimesOutOnToolCall(fake.transport(server))})
    try:
        async with engine.session():
            with pytest.raises(engine.EngineError) as caught:
                await engine.call(
                    "browser_navigate", {"url": "http://site:8000/index.html"}, timeout_s=1.0
                )
    finally:
        client.unplant(handle)
    assert caught.value.reachable is True
    assert caught.value.reason == "browser did not answer at all; the call may or may not have run"
    assert "answered" not in caught.value.reason


async def test_a_stream_that_ends_before_the_answer_is_reachable_true():
    # G31, reachable=True path 3: an SSE stream that closes before the
    # answer event -- app/mcp/fake.py offers this directly
    # (FakeServer.drop_next_answer). The first call establishes (and
    # caches) the era, so the broken stream below is the tool call's own,
    # never the handshake's.
    with fake_engine(engine_tool("browser_navigate", "navigate-index")) as server:
        async with engine.session():
            await engine.call("browser_navigate", {"url": "http://site:8000/index.html"})
            server.drop_next_answer = True
            with pytest.raises(engine.EngineError) as caught:
                await engine.call("browser_navigate", {"url": "http://site:8000/index.html"})
    assert caught.value.reachable is True
    assert caught.value.reason == (
        "the stream from browser ended before the answer; the call may or may not have run"
    )


async def test_a_call_inside_a_session_runs():
    # Item 2's other half: the mechanical check must never refuse a call
    # that IS inside session() -- every other test in this file already
    # shows this incidentally, but the brief asks for it pinned directly.
    with fake_engine(engine_tool("browser_navigate", "navigate-index")):
        async with engine.session():
            answer = await engine.call("browser_navigate", {"url": "http://site:8000/index.html"})
    assert answer.title == "Capture index"


async def test_a_call_outside_a_session_is_refused_mechanically():
    # Item 2: "callers hold session()" was a comment, not a control -- a
    # Task 5 tool that forgot the `async with` would interleave its calls
    # silently. RuntimeError, never EngineError: a programming error, not
    # shown to her as a browser failure.
    with fake_engine(engine_tool("browser_navigate", "navigate-index")):
        with pytest.raises(RuntimeError, match="session"):
            await engine.call("browser_navigate", {"url": "http://site:8000/index.html"})


async def test_the_address_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv(engine.ENDPOINT_ENV, "http://elsewhere:9999/mcp")
    assert engine.endpoint().origin == "http://elsewhere:9999"
    monkeypatch.delenv(engine.ENDPOINT_ENV)
    assert engine.endpoint().url == engine.DEFAULT_URL


async def test_two_opens_at_once_never_interleave_their_calls():
    navigate = engine_tool("browser_navigate", "navigate-index")
    snapshot = engine_tool("browser_snapshot", "snapshot-index")

    async def open_and_read(url: str) -> None:
        async with engine.session():
            await engine.call("browser_navigate", {"url": url})
            await asyncio.sleep(0)  # give the other task every chance to cut in
            await engine.call("browser_snapshot", {})

    with fake_engine(navigate, snapshot) as server:
        await asyncio.gather(open_and_read("http://a.example/"), open_and_read("http://b.example/"))
    names = [call["params"]["name"] for call in server.calls if call["method"] == "tools/call"]
    assert names == ["browser_navigate", "browser_snapshot"] * 2
