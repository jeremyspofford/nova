"""The MCP client's 2026-07-28 era (S37a): what it sends, what it reads, and
what it refuses to do twice. The legacy era is test_mcp_client_legacy.py.

Plants are context managers used INSIDE each test, never fixtures: a
ContextVar token must be reset in the context that set it, and a fixture's
teardown does not run in the test's task."""

from __future__ import annotations

import asyncio
import contextlib
import json
import time

import httpx
import pytest

from app.mcp import client, fake

URL = "http://srv.mcp.invalid/mcp"
ORIGIN = "http://srv.mcp.invalid"

ECHO = fake.FakeTool(
    "echo",
    "says it back",
    {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
    ({"text": "hello"},),
)
REGION = fake.FakeTool(
    "region",
    input_schema={
        "type": "object",
        "properties": {"region": {"type": "string", "x-mcp-header": "Region"}},
    },
    results=({"text": "ok"},),
)


@contextlib.contextmanager
def planted(spec: fake.FakeSpec, *, token: str | None = None):
    """A FakeServer for one spec at URL's origin, for the body of a `with`."""
    server = fake.FakeServer(spec)
    handle = client.plant({ORIGIN: fake.transport(server)})
    try:
        yield server, client.Endpoint(name="srv", url=URL, token=token)
    finally:
        client.unplant(handle)


class _GenStream(httpx.AsyncByteStream):
    """Wraps a plain async generator of bytes so it satisfies httpx's own
    AsyncByteStream type — a bare async generator has __aiter__ but httpx
    checks isinstance(), which a generator object never satisfies."""

    def __init__(self, chunks) -> None:
        self._chunks = chunks

    async def __aiter__(self):
        async for chunk in self._chunks:
            yield chunk


class _Scripted(httpx.AsyncBaseTransport):
    """A real (empty-tools) FakeServer for every method except `method`,
    which is answered by `respond(sent) -> httpx.Response` instead — for
    tests that need exact control of the bytes on the wire for one request
    (a mid-stream break, a raw SSE body, a spec-invalid result) while era
    detection still succeeds normally. `calls` logs every request's
    (id, method), including the ones `respond` handled."""

    def __init__(self, method: str, respond) -> None:
        self._method = method
        self._respond = respond
        self._inner = fake.transport(fake.FakeServer(fake.FakeSpec()))
        self.calls: list[dict] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        self.calls.append({"id": sent.get("id"), "method": sent.get("method")})
        if sent.get("method") == self._method:
            return await self._respond(sent)
        return await self._inner.handle_async_request(request)


class _FailsBeforeStatus(httpx.AsyncBaseTransport):
    """Discover (and any other method) answers normally through a real
    FakeServer; a request for `method` instead sleeps `delay` seconds (if
    given, long enough to blow a short timeout_s) and then raises `exc` (if
    given) — never returning a response at all, simulating a read/protocol
    failure or the deadline before any status comes back."""

    def __init__(self, method: str, exc: Exception | None = None, *, delay: float = 0.0) -> None:
        self._method = method
        self._exc = exc
        self._delay = delay
        self._inner = fake.transport(fake.FakeServer(fake.FakeSpec()))
        self.calls: list[dict] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        self.calls.append({"id": sent.get("id"), "method": sent.get("method")})
        if sent.get("method") == self._method:
            if self._delay:
                await asyncio.sleep(self._delay)
            if self._exc is not None:
                raise self._exc
        return await self._inner.handle_async_request(request)


async def test_probe_finds_a_modern_server_and_its_title():
    with planted(fake.FakeSpec(title="GitHub")) as (_, endpoint):
        found = await client.probe(endpoint)
    assert (found.protocol, found.title) == ("2026-07-28", "GitHub")


async def test_a_call_sends_what_the_spec_requires():
    with planted(fake.FakeSpec(tools=(ECHO,))) as (server, endpoint):
        result = await client.call(endpoint, "echo", {"text": "hi"})
    assert (result.text, result.is_error) == ("hello", False)
    sent = server.calls[-1]
    assert sent["method"] == "tools/call"
    assert sent["headers"]["mcp-method"] == "tools/call"
    assert sent["headers"]["mcp-name"] == "echo"
    assert sent["headers"]["mcp-protocol-version"] == "2026-07-28"
    assert sent["params"]["_meta"]["io.modelcontextprotocol/clientCapabilities"] == {}
    assert sent["params"]["arguments"] == {"text": "hi"}


async def test_a_name_that_is_not_header_safe_travels_base64():
    with planted(fake.FakeSpec(tools=(fake.FakeTool("café"),))) as (server, endpoint):
        assert (await client.call(endpoint, "café", {})).text == "ok"
    assert server.calls[-1]["headers"]["mcp-name"].startswith("=?base64?")


def test_header_value_encodes_what_a_header_cannot_carry():
    assert client.header_value("us-west1") == "us-west1"
    assert client.header_value(" padded ") == "=?base64?IHBhZGRlZCA=?="
    assert client.header_value("=?base64?literal?=") == "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="


async def test_tools_list_follows_every_page():
    tools = tuple(fake.FakeTool(f"t{i}") for i in range(5))
    with planted(fake.FakeSpec(page_size=2, tools=tools)) as (_, endpoint):
        listed = await client.list_tools(endpoint)
    assert [t["name"] for t in listed.tools] == ["t0", "t1", "t2", "t3", "t4"]
    assert listed.ttl_ms == 60_000
    assert set(listed.tools[0]) == {"name", "description", "inputSchema", "annotations"}


async def test_an_invalid_x_mcp_header_drops_only_that_tool():
    bad = fake.FakeTool(
        "bad",
        input_schema={
            "type": "object",
            "properties": {"n": {"type": "number", "x-mcp-header": "N"}},
        },
    )
    with planted(fake.FakeSpec(tools=(fake.FakeTool("good"), bad))) as (_, endpoint):
        listed = await client.list_tools(endpoint)
    assert [t["name"] for t in listed.tools] == ["good"]
    assert listed.rejected[0][0] == "bad" and "number" in listed.rejected[0][1]


async def test_a_mirrored_parameter_goes_into_its_header():
    with planted(fake.FakeSpec(tools=(REGION,))) as (server, endpoint):
        await client.list_tools(endpoint)
        assert (await client.call(endpoint, "region", {"region": "us-west1"})).text == "ok"
    assert server.calls[-1]["headers"]["mcp-param-region"] == "us-west1"


async def test_a_header_mismatch_reads_the_list_again_and_retries_once():
    """No schema cached yet, so the first call omits the header; the server's
    -32020 is the spec's cue to read tools/list and retry."""
    with planted(fake.FakeSpec(tools=(REGION,))) as (server, endpoint):
        assert (await client.call(endpoint, "region", {"region": "eu"})).text == "ok"
    methods = [c["method"] for c in server.calls]
    assert methods.count("tools/call") == 2 and "tools/list" in methods


async def test_is_error_is_a_failed_result_not_an_exception():
    boom = fake.FakeTool("boom", results=({"text": "no such run", "is_error": True},))
    with planted(fake.FakeSpec(tools=(boom,))) as (_, endpoint):
        result = await client.call(endpoint, "boom", {})
    assert (result.is_error, result.text) == (True, "no such run")


async def test_a_json_rpc_error_raises_with_the_servers_words():
    with planted(fake.FakeSpec(tools=(ECHO,))) as (_, endpoint):
        with pytest.raises(client.RpcError) as caught:
            await client.call(endpoint, "nope", {})
    assert caught.value.code == -32602
    assert "Unknown tool" in caught.value.reason and caught.value.reachable


async def test_sse_progress_reaches_the_callback():
    lines: list[str] = []
    with planted(fake.FakeSpec(respond="sse", progress=True, tools=(ECHO,))) as (_, endpoint):
        assert (
            await client.call(endpoint, "echo", {"text": "x"}, progress=lines.append)
        ).text == "hello"
    assert lines == ["1 of 2 — halfway"]


async def test_a_broken_stream_is_not_resent_for_a_call():
    with planted(fake.FakeSpec(respond="sse", tools=(ECHO,))) as (server, endpoint):
        await client.list_tools(endpoint)
        server.drop_next_answer = True
        with pytest.raises(client.ClientError) as caught:
            await client.call(endpoint, "echo", {"text": "x"})
    assert "may or may not have run" in caught.value.reason
    assert [c["method"] for c in server.calls].count("tools/call") == 1


async def test_a_broken_stream_is_resent_once_for_a_listing():
    with planted(fake.FakeSpec(respond="sse", tools=(ECHO,))) as (server, endpoint):
        await client.probe(endpoint)
        server.drop_next_answer = True
        listed = await client.list_tools(endpoint, refresh=True)
    assert [t["name"] for t in listed.tools] == ["echo"]
    ids = [c["id"] for c in server.calls if c["method"] == "tools/list"]
    assert len(ids) == 2 and ids[0] != ids[1]


async def test_request_state_is_echoed_and_input_requests_are_refused():
    stateful = fake.FakeTool("s", results=({"request_state": "abc", "text": "after"},))
    asking = fake.FakeTool(
        "ask",
        results=({"input_requests": {"login": {"method": "elicitation/create", "params": {}}}},),
    )
    with planted(fake.FakeSpec(tools=(stateful, asking))) as (server, endpoint):
        assert (await client.call(endpoint, "s", {})).text == "after"
        assert server.calls[-1]["params"]["requestState"] == "abc"
        with pytest.raises(client.ClientError) as caught:
            await client.call(endpoint, "ask", {})
    assert "cannot give" in caught.value.reason


async def test_a_refused_credential_is_stated_with_its_status():
    with planted(fake.FakeSpec(token="right"), token="wrong") as (_, endpoint):
        with pytest.raises(client.ClientError) as caught:
            await client.probe(endpoint)
    assert "refused the credentials" in caught.value.reason and "401" in caught.value.reason
    assert caught.value.reachable


async def test_a_bearer_token_is_sent():
    with planted(fake.FakeSpec(token="right", tools=(ECHO,)), token="right") as (_, endpoint):
        assert (await client.call(endpoint, "echo", {"text": "x"})).text == "hello"


async def test_an_unreachable_server_is_stated_and_marked_unreachable():
    handle = client.plant({ORIGIN: fake.Unreachable()})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.probe(client.Endpoint(name="srv", url=URL))
    finally:
        client.unplant(handle)
    assert "could not reach srv" in caught.value.reason
    assert caught.value.reachable is False


async def test_images_are_stated_and_structured_content_is_shown():
    picture = fake.FakeTool("pic", results=({"image": "image/png", "bytes": 3000},))
    data = fake.FakeTool("data", results=({"structured": {"runs": 2}},))
    with planted(fake.FakeSpec(tools=(picture, data))) as (_, endpoint):
        shown = await client.call(endpoint, "pic", {})
        structured = await client.call(endpoint, "data", {})
    assert shown.text == "" and "image/png" in shown.notes[0] and "not read" in shown.notes[0]
    assert '"runs": 2' in structured.text


async def test_caches_belong_to_one_plant():
    """A fake planted at an address, then removed: the next plant at the same
    address — or the network — is never answered from the first one's cached
    era or tool list."""
    endpoint = client.Endpoint(name="srv", url=URL)
    with planted(fake.FakeSpec(tools=(fake.FakeTool("a"),))):
        assert [t["name"] for t in (await client.list_tools(endpoint)).tools] == ["a"]
    with planted(fake.FakeSpec(tools=(fake.FakeTool("b"),))):
        assert [t["name"] for t in (await client.list_tools(endpoint)).tools] == ["b"]


# -- fix round 1 (R2-1..7) -----------------------------------------------------


def test_an_endpoint_repr_never_carries_credentials():
    endpoint = client.Endpoint(
        name="srv",
        url="http://h.mcp.invalid/secret-path?k=tok-SECRET",
        token="tok-SECRET",
        headers={"X-Extra": "header-SECRET"},
    )
    text = f"{endpoint!r} {endpoint}"
    assert "tok-SECRET" not in text
    assert "header-SECRET" not in text
    assert "secret-path" not in text
    assert "srv" in text and "h.mcp.invalid" in text


async def test_a_token_with_a_control_character_is_refused_before_sending():
    handle = client.plant({ORIGIN: fake.Unreachable()})
    try:
        endpoint = client.Endpoint(name="srv", url=URL, token="tok-SECRET\n")
        with pytest.raises(client.ClientError) as caught:
            await client.probe(endpoint)
    finally:
        client.unplant(handle)
    assert "tok-SECRET" not in caught.value.reason
    assert caught.value.reachable is False
    assert "nothing was sent" in caught.value.reason


def test_origin_never_carries_userinfo_or_path():
    endpoint = client.Endpoint(name="srv", url="https://user:pw-SECRET@h.mcp.invalid/mcp")
    assert endpoint.origin == "https://h.mcp.invalid"


async def test_a_plant_matches_regardless_of_origin_case():
    server = fake.FakeServer(fake.FakeSpec(title="X"))
    handle = client.plant({"http://Case.MCP.invalid": fake.transport(server)})
    try:
        found = await client.probe(client.Endpoint(name="srv", url="http://case.mcp.invalid/mcp"))
    finally:
        client.unplant(handle)
    assert found.protocol == "2026-07-28"


async def test_a_mid_stream_transport_failure_is_not_resent_for_a_call():
    async def respond(sent):
        async def body():
            yield b": keep-alive\n\n"
            raise httpx.RemoteProtocolError("connection dropped mid-stream (fixture)")

        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_GenStream(body())
        )

    transport = _Scripted("tools/call", respond)
    handle = client.plant({ORIGIN: transport})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.call(client.Endpoint(name="srv", url=URL), "echo", {"text": "hi"})
    finally:
        client.unplant(handle)
    assert "may or may not have run" in caught.value.reason
    assert caught.value.reachable is True
    assert [c["method"] for c in transport.calls].count("tools/call") == 1


async def test_a_mid_stream_transport_failure_is_resent_once_for_a_listing():
    broken = {"done": False}

    async def respond(sent):
        if not broken["done"]:
            broken["done"] = True

            async def body():
                yield b": keep-alive\n\n"
                raise httpx.RemoteProtocolError("connection dropped mid-stream (fixture)")

            return httpx.Response(
                200, headers={"content-type": "text/event-stream"}, stream=_GenStream(body())
            )
        payload = {
            "jsonrpc": "2.0",
            "id": sent.get("id"),
            "result": {"resultType": "complete", "tools": [fake.FakeTool("echo").listed()]},
        }
        return httpx.Response(200, headers={"content-type": "application/json"}, json=payload)

    transport = _Scripted("tools/list", respond)
    handle = client.plant({ORIGIN: transport})
    try:
        listed = await client.list_tools(client.Endpoint(name="srv", url=URL))
    finally:
        client.unplant(handle)
    assert [t["name"] for t in listed.tools] == ["echo"]
    ids = [c["id"] for c in transport.calls if c["method"] == "tools/list"]
    assert len(ids) == 2 and ids[0] != ids[1]


async def test_sse_survives_unicode_line_separators_inside_a_string():
    text = "a b c\u0085d"

    async def respond(sent):
        payload = {
            "jsonrpc": "2.0",
            "id": sent.get("id"),
            "result": {
                "resultType": "complete",
                "isError": False,
                "content": [{"type": "text", "text": text}],
            },
        }
        body = f"event: message\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=body.encode("utf-8")
        )

    transport = _Scripted("tools/call", respond)
    handle = client.plant({ORIGIN: transport})
    try:
        got = await client.call(client.Endpoint(name="srv", url=URL), "echo", {})
    finally:
        client.unplant(handle)
    assert got.text == text


async def test_a_huge_sse_line_is_refused_before_it_is_fully_buffered():
    sent_bytes = {"n": 0}

    async def respond(sent):
        async def body():
            yield b"event: message\ndata: "
            left = 5 * 1024 * 1024
            chunk = 256 * 1024
            while left > 0:
                piece = b"x" * min(chunk, left)
                sent_bytes["n"] += len(piece)
                yield piece
                left -= len(piece)

        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_GenStream(body())
        )

    transport = _Scripted("tools/call", respond)
    handle = client.plant({ORIGIN: transport})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.call(client.Endpoint(name="srv", url=URL), "echo", {})
    finally:
        client.unplant(handle)
    assert "stopped reading" in caught.value.reason
    assert sent_bytes["n"] < 4.5 * 1024 * 1024


async def test_a_progress_callback_makes_the_client_declare_a_token():
    with planted(fake.FakeSpec(respond="sse", progress=True, tools=(ECHO,))) as (server, endpoint):
        await client.call(endpoint, "echo", {"text": "a"})
        assert "progressToken" not in (server.calls[-1]["params"].get("_meta") or {})
        await client.call(endpoint, "echo", {"text": "b"}, progress=lambda _l: None)
    assert server.calls[-1]["params"]["_meta"]["progressToken"] == str(server.calls[-1]["id"])


async def test_unreadable_content_is_a_stated_error_not_an_empty_success():
    async def respond(sent):
        payload = {"jsonrpc": "2.0", "id": sent.get("id"), "result": {"content": "the real answer"}}
        return httpx.Response(200, headers={"content-type": "application/json"}, json=payload)

    transport = _Scripted("tools/call", respond)
    handle = client.plant({ORIGIN: transport})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.call(client.Endpoint(name="srv", url=URL), "echo", {})
    finally:
        client.unplant(handle)
    assert "no readable content" in caught.value.reason


# -- fix round 2 (R3-A..D) -----------------------------------------------------


async def test_a_call_after_a_read_timeout_may_or_may_not_have_run():
    transport = _FailsBeforeStatus("tools/call", httpx.ReadTimeout("fixture"))
    handle = client.plant({ORIGIN: transport})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.call(client.Endpoint(name="srv", url=URL), "echo", {})
    finally:
        client.unplant(handle)
    assert "may or may not have run" in caught.value.reason
    assert caught.value.reachable is True
    assert "could not reach" not in caught.value.reason


async def test_a_call_after_a_remote_protocol_error_may_or_may_not_have_run():
    transport = _FailsBeforeStatus(
        "tools/call",
        httpx.RemoteProtocolError("Server disconnected without sending a response."),
    )
    handle = client.plant({ORIGIN: transport})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.call(client.Endpoint(name="srv", url=URL), "echo", {})
    finally:
        client.unplant(handle)
    assert "may or may not have run" in caught.value.reason
    assert caught.value.reachable is True
    assert "could not reach" not in caught.value.reason


async def test_a_call_past_the_deadline_while_the_server_still_runs_it():
    """The common real case: a plain application/json server sends its
    status only once the tool finishes, so a slow tool that outlives
    timeout_s must not be stamped unreachable."""
    transport = _FailsBeforeStatus("tools/call", delay=1.0)
    handle = client.plant({ORIGIN: transport})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.call(client.Endpoint(name="srv", url=URL), "echo", {}, timeout_s=0.2)
    finally:
        client.unplant(handle)
    assert "may or may not have run" in caught.value.reason
    assert caught.value.reachable is True
    assert "could not reach" not in caught.value.reason


async def test_a_listing_after_a_read_error_is_resent_once():
    transport = _FailsBeforeStatus("tools/list", httpx.ReadError("fixture"))
    handle = client.plant({ORIGIN: transport})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.list_tools(client.Endpoint(name="srv", url=URL))
    finally:
        client.unplant(handle)
    ids = [c["id"] for c in transport.calls if c["method"] == "tools/list"]
    assert len(ids) == 2 and ids[0] != ids[1]
    assert caught.value.reachable is True


async def test_a_content_list_of_non_object_blocks_is_a_stated_error():
    """{"content": ["the real answer"]}: a note about a skipped block is
    not content (ruling R3-B) — it still refuses, exactly like a result
    with no content block at all."""

    async def respond(sent):
        payload = {
            "jsonrpc": "2.0",
            "id": sent.get("id"),
            "result": {"content": ["the real answer"]},
        }
        return httpx.Response(200, headers={"content-type": "application/json"}, json=payload)

    transport = _Scripted("tools/call", respond)
    handle = client.plant({ORIGIN: transport})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.call(client.Endpoint(name="srv", url=URL), "echo", {})
    finally:
        client.unplant(handle)
    assert "no readable content" in caught.value.reason


async def test_content_missing_entirely_is_a_stated_error():
    async def respond(sent):
        payload = {"jsonrpc": "2.0", "id": sent.get("id"), "result": {}}
        return httpx.Response(200, headers={"content-type": "application/json"}, json=payload)

    transport = _Scripted("tools/call", respond)
    handle = client.plant({ORIGIN: transport})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.call(client.Endpoint(name="srv", url=URL), "echo", {})
    finally:
        client.unplant(handle)
    assert "no readable content" in caught.value.reason


async def test_malformed_content_beside_is_error_is_noted_not_dropped():
    async def respond(sent):
        payload = {
            "jsonrpc": "2.0",
            "id": sent.get("id"),
            "result": {"content": "no such run", "isError": True},
        }
        return httpx.Response(200, headers={"content-type": "application/json"}, json=payload)

    transport = _Scripted("tools/call", respond)
    handle = client.plant({ORIGIN: transport})
    try:
        result = await client.call(client.Endpoint(name="srv", url=URL), "echo", {})
    finally:
        client.unplant(handle)
    assert (result.is_error, result.text) == (True, "")
    assert result.notes and "not a list of blocks" in result.notes[0]


async def test_an_empty_content_list_is_a_legal_empty_success():
    async def respond(sent):
        payload = {
            "jsonrpc": "2.0",
            "id": sent.get("id"),
            "result": {"content": [], "isError": False},
        }
        return httpx.Response(200, headers={"content-type": "application/json"}, json=payload)

    transport = _Scripted("tools/call", respond)
    handle = client.plant({ORIGIN: transport})
    try:
        result = await client.call(client.Endpoint(name="srv", url=URL), "echo", {})
    finally:
        client.unplant(handle)
    assert (result.text, result.is_error) == ("", False)
    assert result.notes and "no content" in result.notes[0]


async def test_a_huge_sse_line_in_small_chunks_is_read_in_linear_time():
    """Regression pin for the quadratic rescan-from-0 in _sse_lines: at
    1460-byte chunks the old O(n^2) rescan measured 32 s for one ~4 MiB
    unterminated line. A linear reader does this in well under a second."""
    size = 4 * 1024 * 1024 - 4096
    chunk_size = 1460

    async def respond(sent):
        prefix = (
            b'data: {"jsonrpc": "2.0", "id": '
            + str(sent.get("id")).encode()
            + b', "result": {"resultType": "complete", "isError": false, '
            + b'"content": [{"type": "text", "text": "'
        )
        suffix = b'"}]}}\n\n'

        async def body():
            yield prefix
            left = size
            while left > 0:
                piece = b"x" * min(chunk_size, left)
                yield piece
                left -= len(piece)
            yield suffix

        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_GenStream(body())
        )

    transport = _Scripted("tools/call", respond)
    handle = client.plant({ORIGIN: transport})
    try:
        start = time.perf_counter()
        got = await client.call(client.Endpoint(name="srv", url=URL), "echo", {})
        elapsed = time.perf_counter() - start
    finally:
        client.unplant(handle)
    assert len(got.text) == size
    assert elapsed < 3.0, f"took {elapsed:.1f}s — _sse_lines may be rescanning from 0 again"


async def test_a_probe_after_a_read_timeout_during_discovery_does_not_crash():
    """_detect does its own numeric status comparisons; _post can now return
    status=None for a non-connect-phase failure, so _detect must handle that
    without a TypeError on `200 <= None` — not named in item A's own fix
    location (_send), but reachable through the same _post change."""
    transport = _FailsBeforeStatus("server/discover", httpx.ReadTimeout("fixture"))
    handle = client.plant({ORIGIN: transport})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.probe(client.Endpoint(name="srv", url=URL))
    finally:
        client.unplant(handle)
    assert caught.value.reachable is True
    ids = [c["id"] for c in transport.calls if c["method"] == "server/discover"]
    assert len(ids) == 2 and ids[0] != ids[1]


# -- Task 3 carries: pre-send classification, content kinds (breaker B) ------


async def test_an_unsupported_url_scheme_is_refused_before_sending():
    """httpx raises this from URL-scheme resolution, before any connection
    is attempted — nothing was sent, same bucket as a connect failure, never
    "may or may not have run"."""
    with pytest.raises(client.ClientError) as caught:
        await client.probe(client.Endpoint(name="srv", url="ftp://old.mcp.invalid/mcp"))
    assert "nothing was sent" in caught.value.reason
    assert caught.value.reachable is False


async def test_a_header_the_transport_cannot_encode_is_refused_before_sending():
    """A header NAME with a space is illegal HTTP/1.1 — h11 raises while
    FRAMING the request, before any byte of it reaches the wire, and httpx
    re-raises it as its own LocalProtocolError."""

    class _IllegalHeaderName(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            raise httpx.LocalProtocolError("Illegal header name b'X Bad'")

    handle = client.plant({ORIGIN: _IllegalHeaderName()})
    try:
        endpoint = client.Endpoint(name="srv", url=URL, headers={"X Bad": "v"})
        with pytest.raises(client.ClientError) as caught:
            await client.probe(endpoint)
    finally:
        client.unplant(handle)
    assert "nothing was sent" in caught.value.reason
    assert caught.value.reachable is False


async def test_a_text_like_block_with_no_type_is_unreadable_not_empty():
    """Task 2 breaker ruling B: a dict content block with no `type` key at
    all is a note, never counted as content seen — it used to give an empty
    success just because the block was an object."""

    async def respond(sent):
        payload = {
            "jsonrpc": "2.0",
            "id": sent.get("id"),
            "result": {"content": [{"text": "the real answer"}]},
        }
        return httpx.Response(200, headers={"content-type": "application/json"}, json=payload)

    transport = _Scripted("tools/call", respond)
    handle = client.plant({ORIGIN: transport})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.call(client.Endpoint(name="srv", url=URL), "echo", {})
    finally:
        client.unplant(handle)
    assert "no readable content" in caught.value.reason


async def test_an_empty_block_object_is_unreadable_not_empty_success():
    async def respond(sent):
        payload = {"jsonrpc": "2.0", "id": sent.get("id"), "result": {"content": [{}]}}
        return httpx.Response(200, headers={"content-type": "application/json"}, json=payload)

    transport = _Scripted("tools/call", respond)
    handle = client.plant({ORIGIN: transport})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.call(client.Endpoint(name="srv", url=URL), "echo", {})
    finally:
        client.unplant(handle)
    assert "no readable content" in caught.value.reason


async def test_an_unknown_typed_block_is_read_as_noted_content():
    """An unknown but NAMED kind is content seen, for forward compatibility —
    unlike the typeless objects above: a future block type should not look
    like a server refusing to say anything at all."""

    async def respond(sent):
        payload = {
            "jsonrpc": "2.0",
            "id": sent.get("id"),
            "result": {"content": [{"type": "weird"}]},
        }
        return httpx.Response(200, headers={"content-type": "application/json"}, json=payload)

    transport = _Scripted("tools/call", respond)
    handle = client.plant({ORIGIN: transport})
    try:
        result = await client.call(client.Endpoint(name="srv", url=URL), "echo", {})
    finally:
        client.unplant(handle)
    assert result.notes and "weird" in result.notes[0]


# -- fix round 1: ruling T5-A/T5-B, scrubbing at the client's decode boundary -


def test_credential_candidates_applies_the_8_char_floor_and_the_rest_rule():
    """Ruling T5-B, pinned directly against the function: a short value
    (review Minor 2's "HTTP 401" mangled by a header value of "1") is never
    a candidate; a `<scheme word> <rest>` value also yields `<rest>` alone,
    because a server may echo the credential without the word in front of
    it; sorted longest first."""
    assert client.credential_candidates(None, {}) == ()
    assert client.credential_candidates("short", {}) == ()  # 5 chars
    assert client.credential_candidates(None, {"X-Flag": "1"}) == ()
    candidates = client.credential_candidates(
        "abc123",  # 6 chars: never a candidate on its own
        {"X-Key": "zz-abc123-zz", "Authorization": "Token s3cr3t-value-123"},
    )
    assert "abc123" not in candidates
    assert "zz-abc123-zz" in candidates
    assert "Token s3cr3t-value-123" in candidates
    assert "s3cr3t-value-123" in candidates  # the <rest> of "Token <rest>"
    assert list(candidates) == sorted(candidates, key=len, reverse=True)


def test_scrub_credentials_walks_a_decoded_json_value_iteratively():
    """The dict/list walk (ruling T5-A) touches only STRING VALUES, at any
    depth, in place; keys, numbers, booleans and None pass through."""
    endpoint = client.Endpoint(name="srv", url=URL, token="ghp_ABCDEFGHIJKLMNOP")
    value = {
        "error": {"message": "bad cred: ghp_ABCDEFGHIJKLMNOP", "code": -32001},
        "id": 7,
        "ok": True,
        "nested": [{"deep": {"also": "carries ghp_ABCDEFGHIJKLMNOP here"}}, "plain", None],
        "ghp_ABCDEFGHIJKLMNOP": "a KEY that happens to equal the token stays untouched",
    }
    scrubbed = client.scrub_credentials(value, endpoint)
    assert scrubbed["error"] == {"message": "bad cred: [redacted]", "code": -32001}
    assert scrubbed["id"] == 7 and scrubbed["ok"] is True
    assert scrubbed["nested"][0]["deep"]["also"] == "carries [redacted] here"
    assert scrubbed["nested"][1:] == ["plain", None]
    assert "ghp_ABCDEFGHIJKLMNOP" in scrubbed  # the KEY, never touched
    assert scrubbed is value  # mutated in place, per the docstring


async def test_a_401_body_echoing_the_token_is_scrubbed_before_the_excerpt_is_clipped():
    """Ruling T5-A (review Minor 1): the 200-character excerpt clip used to
    run BEFORE the store's scrub, so a credential straddling the cut left an
    unscrubbed prefix in a connect reason. Scrubbing now happens at the
    client's own decode boundary, before any clip — padding the body past
    200 characters before the token appears is the exact reproduction."""
    token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

    async def respond(sent):
        body = "x" * 180 + f" got Bearer {token}"
        assert len(body) > 200  # the token would straddle the old clip point
        return httpx.Response(401, text=body, headers={"content-type": "text/plain"})

    transport = _Scripted("server/discover", respond)
    handle = client.plant({ORIGIN: transport})
    try:
        with pytest.raises(client.ClientError) as caught:
            await client.probe(client.Endpoint(name="srv", url=URL, token=token))
    finally:
        client.unplant(handle)
    assert token not in caught.value.reason
    # No prefix of the token either — the old bug left one up to 20 chars
    # long (the excerpt's last 200 characters, minus the padding consumed).
    assert not any(token[:n] in caught.value.reason for n in range(4, len(token)))


async def test_an_sse_progress_notification_scrubs_the_servers_own_credential():
    """Ruling T5-A: scrubbing applies to EVERY SSE event, not only the final
    answer — a progress notification's `message` can carry the same echo."""
    token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    seen: list[str] = []

    async def respond(sent):
        meta = sent.get("params", {}).get("_meta", {})
        progress_token = meta.get("progressToken")
        events = [
            {
                "jsonrpc": "2.0",
                "method": "notifications/progress",
                "params": {
                    "progressToken": progress_token,
                    "progress": 1,
                    "total": 2,
                    "message": f"still using {token}",
                },
            },
            {
                "jsonrpc": "2.0",
                "id": sent.get("id"),
                "result": {
                    "resultType": "complete",
                    "isError": False,
                    "content": [{"type": "text", "text": "done"}],
                },
            },
        ]
        stream = "".join(f"event: message\ndata: {json.dumps(e)}\n\n" for e in events)
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=stream.encode("utf-8")
        )

    transport = _Scripted("tools/call", respond)
    handle = client.plant({ORIGIN: transport})
    try:
        result = await client.call(
            client.Endpoint(name="srv", url=URL, token=token),
            "echo",
            {"text": "hi"},
            progress=seen.append,
        )
    finally:
        client.unplant(handle)
    assert result.text == "done"
    assert seen and token not in seen[0] and "[redacted]" in seen[0]
