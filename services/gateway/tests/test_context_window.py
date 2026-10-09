"""local-context T1: a completion ollama served says the window it was served with.

`X-Nova-Context-Window` is the answering model's `context_length` as ITS
ollama's /api/ps states it, read after the answer (the model is resident by
then) — the window it is actually served with, never /api/show's model max
and never a table of sizes. It is stated for the hub engine, for another
machine's engine, and for an openai-chat row (the Dell) whose origin
(base_url minus /v1) answers /api/ps listing the model. Anything not
readable — /api/ps fails, does not list the model, states no usable number,
the origin is a cloud with no /api/ps, the read stalls — omits the header
and logs why. The reply is never the cost.
"""

from __future__ import annotations

import asyncio
import logging

import httpx
import pytest
from starlette.responses import JSONResponse, Response

from app import backends, data_plane
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat, StreamingASGITransport

pytestmark = requires_db

CHAT = {"messages": [{"role": "user", "content": "hi"}], "stream": True}
WINDOW = "x-nova-context-window"


def _resident(model: str = "qwen3:8b", context_length: object = 32768) -> list[dict]:
    """One /api/ps entry in ollama 0.40's live shape (context_length is top-level)."""
    return [
        {
            "name": model,
            "model": model,
            "size": 6_400_000_000,
            "size_vram": 6_400_000_000,
            "context_length": context_length,
        }
    ]


@pytest.fixture
async def hub(pool, monkeypatch, mount_backend, hub_machine):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(ps_models=_resident())
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    return fake


async def _dell_row(pool, base_url: str = "http://dell.test/v1") -> None:
    """The live Dell's shape: an openai-chat row on another machine's ollama
    /v1 — NOT an engine."""
    await pool.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key, local) "
        "VALUES ('dell', 'openai-chat', $1, 'static-bearer', 'tok', false)",
        base_url,
    )


# ── C1: the hub engine (and another machine's engine) state the window ─────


async def test_a_hub_completion_states_the_window_ps_reports(client, pool, hub):
    resp = await client.post("/v1/chat/completions", json=CHAT)

    assert resp.status_code == 200
    assert resp.headers[WINDOW] == "32768"
    paths = [path for path, _ in hub.seen]
    assert paths.index("/api/ps") > paths.index("/v1/chat/completions"), (
        "read after the engine answered — the model is resident by then"
    )


async def test_the_window_follows_ps_not_a_table(client, pool, hub):
    """Derived, never hardcoded: whatever /api/ps says this time is the window."""
    for served in (8192, 40960, 4096):
        hub.ps_models = _resident(context_length=served)
        resp = await client.post("/v1/chat/completions", json=CHAT)
        assert resp.status_code == 200
        assert resp.headers[WINDOW] == str(served)


async def test_a_bare_pull_listed_as_latest_states_its_window(client, pool, hub):
    await backends.save_config(pool, {"kind": "ollama", "model": "gemma3"})
    hub.ps_models = _resident(model="gemma3:latest", context_length=8192)
    resp = await client.post("/v1/chat/completions", json=CHAT)
    assert resp.status_code == 200
    assert resp.headers[WINDOW] == "8192"


async def test_another_machines_engine_states_its_own_window(client, pool, hub, mount_backend):
    """Its devices are its own agent's to report (never stamped here), but
    the window its own /api/ps states is a fact about the model it served."""
    dell = FakeOllama(ps_models=_resident(context_length=16384))
    mount_backend("http://dell.test", dell.app)
    await pool.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key, local) "
        "VALUES ('dell', 'ollama', 'http://dell.test', 'static-bearer', 'tok', true)"
    )
    await pool.execute("INSERT INTO engines (provider) VALUES ('dell')")

    resp = await client.post("/v1/chat/completions", json={**CHAT, "model": "dell:qwen3:8b"})

    assert resp.status_code == 200
    assert resp.headers[WINDOW] == "16384"
    assert "x-nova-served-on" not in resp.headers


# ── C2: an openai-chat row whose origin answers /api/ps ───────────────────


async def test_an_openai_chat_row_on_an_ollama_origin_states_its_window(
    client, pool, hub, mount_backend
):
    dell = FakeOllama(ps_models=_resident(context_length=32768))
    mount_backend("http://dell.test", dell.app)
    await _dell_row(pool)

    resp = await client.post("/v1/chat/completions", json={**CHAT, "model": "dell:qwen3:8b"})

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "dell:qwen3:8b"
    assert resp.headers[WINDOW] == "32768"
    paths = [path for path, _ in dell.seen]
    assert paths.count("/api/ps") == 1, "one read at the origin, base_url minus /v1"
    assert paths.index("/api/ps") > paths.index("/v1/chat/completions")
    assert not [p for p, _ in hub.seen if p == "/api/ps"], "never the hub's /api/ps"


# ── C3: what is not readable is omitted, logged, and never costs the reply ─


@pytest.mark.parametrize(
    "ps_models, ps_status",
    [
        ([], 200),  # does not list the model that answered
        (_resident(model="qwen3:4b"), 200),  # lists another model
        (_resident(context_length=None), 200),  # states no window
        (_resident(context_length="32768"), 200),  # not a number
        (_resident(context_length=True), 200),  # a bool is not a number
        (_resident(context_length=0), 200),  # no window at all
        (_resident(), 500),  # /api/ps cannot be read
    ],
)
async def test_an_unreadable_window_is_omitted_and_logged(
    client, pool, hub, mount_backend, caplog, ps_models, ps_status
):
    caplog.set_level(logging.INFO)
    dell = FakeOllama(ps_models=ps_models, ps_status=ps_status)
    mount_backend("http://dell.test", dell.app)
    await _dell_row(pool)

    resp = await client.post("/v1/chat/completions", json={**CHAT, "model": "dell:qwen3:8b"})

    assert resp.status_code == 200
    assert WINDOW not in resp.headers
    assert "/api/ps" in [p for p, _ in dell.seen], "the window was asked for"
    assert any(
        "context window" in r.getMessage() and "dell:qwen3:8b" in r.getMessage()
        for r in caplog.records
    ), "the reason it is absent is logged, naming the link"


async def test_a_cloud_origin_with_no_ps_states_no_window(client, pool, hub, mount_backend, caplog):
    caplog.set_level(logging.INFO)
    cloud = FakeOpenAICompat()
    mount_backend("http://cloud.test", cloud.app)
    await pool.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key, local) "
        "VALUES ('cloudy', 'openai-chat', 'http://cloud.test/v1', 'static-bearer', 'sk', false)"
    )

    resp = await client.post("/v1/chat/completions", json={**CHAT, "model": "cloudy:remote-model"})

    assert resp.status_code == 200
    assert WINDOW not in resp.headers
    assert any(
        "context window" in r.getMessage() and "cloudy:remote-model" in r.getMessage()
        for r in caplog.records
    )


async def test_a_refusal_states_no_window_and_reads_no_ps(client, pool, hub):
    hub.probe_status = 503
    resp = await client.post("/v1/chat/completions", json={"messages": [], "stream": False})
    assert resp.status_code == 503
    assert WINDOW not in resp.headers
    assert "/api/ps" not in [p for p, _ in hub.seen]


# ── C4: bounded — a stalled origin costs the header, never the reply ──────


class _StalledPs(FakeOllama):
    """An ollama whose /api/ps never answers."""

    def __post_init__(self) -> None:
        self.asked = asyncio.Event()
        super().__post_init__()

    async def _ps(self, request):
        self.asked.set()
        await asyncio.Event().wait()


async def test_a_stalled_origin_costs_the_window_never_the_reply(
    client, pool, hub, mount_backend, monkeypatch
):
    dell = _StalledPs()
    mount_backend("http://dell.test", dell.app)
    await _dell_row(pool)
    monkeypatch.setattr(data_plane, "STAMP_BUDGET_S", 0.05, raising=False)

    resp = await asyncio.wait_for(
        client.post("/v1/chat/completions", json={**CHAT, "model": "dell:qwen3:8b"}), 5.0
    )

    assert dell.asked.is_set(), "the window was asked for"
    assert resp.status_code == 200
    assert WINDOW not in resp.headers


async def test_a_stalled_origin_logs_why_the_window_is_absent(
    client, pool, hub, mount_backend, monkeypatch, caplog
):
    """C3/C4: the stall's reason is logged naming the link, like any other
    unreadable window — absence is never silent."""
    caplog.set_level(logging.INFO)
    dell = _StalledPs()
    mount_backend("http://dell.test", dell.app)
    await _dell_row(pool)
    monkeypatch.setattr(data_plane, "STAMP_BUDGET_S", 0.05, raising=False)

    resp = await asyncio.wait_for(
        client.post("/v1/chat/completions", json={**CHAT, "model": "dell:qwen3:8b"}), 5.0
    )

    assert resp.status_code == 200
    assert WINDOW not in resp.headers
    assert any(
        "context window" in r.getMessage() and "dell:qwen3:8b" in r.getMessage()
        for r in caplog.records
    )


# ── T1b: ANY failure reading the window costs the header, never the reply ─


class _PsRaises(httpx.AsyncBaseTransport):
    """The Dell's ollama for its completion, but its /api/ps read raises
    `exc` in the client — the way a garbled address, a refused connection or
    a bug below httpx surfaces, which no ASGI app can produce."""

    def __init__(self, fake: FakeOllama, exc: Exception) -> None:
        self._inner = StreamingASGITransport(fake.app)
        self._exc = exc
        self.ps_asked = False

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/ps":
            self.ps_asked = True
            raise self._exc
        return await self._inner.handle_async_request(request)


class _PsAnswers(FakeOllama):
    """An ollama whose /api/ps answers 200 with whatever `ps_response` is."""

    ps_response: Response | None = None

    async def _ps(self, request):
        self.seen.append((request.url.path, None))
        return self.ps_response


def _assert_absent_and_logged(resp, caplog) -> None:
    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "dell:qwen3:8b"
    assert WINDOW not in resp.headers
    assert any(
        "context window" in r.getMessage() and "dell:qwen3:8b" in r.getMessage()
        for r in caplog.records
    ), "the reason it is absent is logged, naming the link"


@pytest.mark.parametrize(
    "exc",
    [
        httpx.ConnectError("connection refused"),  # an httpx error, not a timeout
        httpx.InvalidURL("garbled origin"),  # httpx, but NOT an httpx.HTTPError
        RuntimeError("something below httpx broke"),  # not httpx at all
    ],
    ids=["connect-error", "invalid-url", "runtime-error"],
)
async def test_a_raising_ps_read_costs_the_window_never_the_reply(
    client, pool, hub, mount_transport, caplog, exc
):
    caplog.set_level(logging.INFO)
    transport = _PsRaises(FakeOllama(), exc)
    mount_transport("http://dell.test", transport)
    await _dell_row(pool)

    resp = await asyncio.wait_for(
        client.post("/v1/chat/completions", json={**CHAT, "model": "dell:qwen3:8b"}), 5.0
    )

    assert transport.ps_asked, "the window was asked for"
    _assert_absent_and_logged(resp, caplog)


@pytest.mark.parametrize(
    "ps_response",
    [
        Response("<html>not ollama</html>", media_type="text/html"),  # not JSON
        Response(b"\xff\xfe{", media_type="application/json"),  # undecodable bytes
        JSONResponse([{"name": "qwen3:8b"}]),  # a list, not an object
        JSONResponse({"models": "qwen3:8b"}),  # models is not a list
        JSONResponse({"models": [None, 7, "qwen3:8b"]}),  # entries are not objects
        JSONResponse({"models": [{"name": ["qwen3:8b"], "size_vram": 1}]}),  # name not a string
        JSONResponse({"models": [{"name": "qwen3:8b", "size_vram": "big"}]}),  # no byte count
        JSONResponse(None),  # null
    ],
    ids=[
        "html",
        "undecodable",
        "list",
        "models-str",
        "entries-not-objects",
        "name-list",
        "size-vram-str",
        "null",
    ],
)
async def test_a_ps_body_of_an_unexpected_shape_costs_the_window_never_the_reply(
    client, pool, hub, mount_backend, caplog, ps_response
):
    caplog.set_level(logging.INFO)
    dell = _PsAnswers()
    dell.ps_response = ps_response
    mount_backend("http://dell.test", dell.app)
    await _dell_row(pool)

    resp = await client.post("/v1/chat/completions", json={**CHAT, "model": "dell:qwen3:8b"})

    assert "/api/ps" in [p for p, _ in dell.seen], "the window was asked for"
    _assert_absent_and_logged(resp, caplog)


async def test_a_raising_hub_ps_read_costs_the_window_never_the_reply(
    client, pool, hub, mount_transport, caplog
):
    """The engine path reads through the same reader: an error there is the
    same stated absence."""
    caplog.set_level(logging.INFO)
    transport = _PsRaises(hub, httpx.InvalidURL("garbled origin"))
    mount_transport("http://ollama.test", transport)

    resp = await client.post("/v1/chat/completions", json=CHAT)

    assert transport.ps_asked
    assert resp.status_code == 200
    assert WINDOW not in resp.headers
    assert any("context window" in r.getMessage() for r in caplog.records)


def test_the_header_is_named_once():
    assert data_plane.CONTEXT_WINDOW_HEADER == "X-Nova-Context-Window"
