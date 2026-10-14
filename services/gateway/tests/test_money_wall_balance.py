"""A money wall re-checks the balance (T1): the adapter that can read a key's
balance reads it; every other one says it cannot.

OpenRouter states what is left on a key at GET {base}/key (`limit_remaining`
when the key has a limit) and, for a key with no limit, at GET {base}/credits
(`total_credits - total_usage`). A read that does not yield a finite number is
an UNKNOWN balance with the reason in words — never a number, so a failed
read can never pass for "the money is there". No test here reaches
openrouter.ai: every peer is a counted MockTransport mounted on
app.state.peer_transports.
"""

from __future__ import annotations

import httpx
import pytest

from app.adapters import _BY_NAME, anthropic_messages, ollama, openai_chat, systemone
from app.adapters.base import Balance
from app.main import app
from tests.fakes import FailingTransport

OPENROUTER_BASE = "https://openrouter.ai/api/v1"
ROW = {
    "name": "openrouter",
    "adapter": "openai-chat",
    "base_url": OPENROUTER_BASE,
    "auth_shape": "static-bearer",
    "api_key": "sk-or-test",
    "builtin": False,
    "local": False,
}


class Peer(httpx.AsyncBaseTransport):
    """A counted fake: `routes` maps a path to (status, body bytes or JSON)."""

    def __init__(self, routes: dict[str, tuple[int, object]] | None = None) -> None:
        self.routes = routes or {}
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        status, body = self.routes.get(request.url.path, (404, {"error": "no such route"}))
        if isinstance(body, bytes):
            return httpx.Response(status, content=body, request=request)
        return httpx.Response(status, json=body, request=request)

    @property
    def paths(self) -> list[str]:
        return [r.url.path for r in self.requests]


def key_body(limit, remaining) -> dict:
    return {"data": {"label": "sk-or-v1-abc", "limit": limit, "limit_remaining": remaining}}


@pytest.fixture
def openrouter(mount_transport):
    def _mount(routes: dict[str, tuple[int, object]] | None = None, transport=None):
        peer = transport or Peer(routes)
        mount_transport("https://openrouter.ai", peer)
        return peer

    return _mount


# C1 -------------------------------------------------------------------------


async def test_a_limited_key_reads_limit_remaining_from_key(openrouter):
    peer = openrouter({"/api/v1/key": (200, key_body(100, 94.7))})

    got = await openai_chat.ADAPTER.balance(app, ROW)

    assert isinstance(got, Balance)
    assert got.remaining == pytest.approx(94.7)
    assert peer.paths == ["/api/v1/key"], "a key with a limit never asks /credits"
    assert peer.requests[0].method == "GET"
    assert peer.requests[0].headers["authorization"] == "Bearer sk-or-test"


async def test_an_integer_limit_remaining_reads_as_the_number(openrouter):
    openrouter({"/api/v1/key": (200, key_body(10, 0))})

    got = await openai_chat.ADAPTER.balance(app, ROW)

    assert got.remaining == 0


# C2 -------------------------------------------------------------------------


async def test_a_key_with_no_limit_reads_credits_minus_usage(openrouter):
    peer = openrouter(
        {
            "/api/v1/key": (200, key_body(None, None)),
            "/api/v1/credits": (200, {"data": {"total_credits": 50, "total_usage": 49.5}}),
        }
    )

    got = await openai_chat.ADAPTER.balance(app, ROW)

    assert got.remaining == pytest.approx(0.5)
    assert peer.paths == ["/api/v1/key", "/api/v1/credits"]
    assert peer.requests[1].headers["authorization"] == "Bearer sk-or-test"


async def test_credits_used_up_reads_as_zero_not_unknown(openrouter):
    openrouter(
        {
            "/api/v1/key": (200, key_body(None, None)),
            "/api/v1/credits": (200, {"data": {"total_credits": 20, "total_usage": 20}}),
        }
    )

    got = await openai_chat.ADAPTER.balance(app, ROW)

    assert got.remaining == 0


# C3 -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("routes", "says"),
    [
        ({"/api/v1/key": (401, {"error": {"message": "No auth credentials found"}})}, "401"),
        ({"/api/v1/key": (401, {"error": {"message": "No auth credentials found"}})}, "No auth"),
        ({"/api/v1/key": (500, {"error": {"message": "upstream exploded"}})}, "500"),
        ({"/api/v1/key": (500, {"error": {"message": "upstream exploded"}})}, "upstream exploded"),
        ({"/api/v1/key": (200, b"<html>not json</html>")}, "JSON"),
        ({"/api/v1/key": (200, {})}, "data"),
        ({"/api/v1/key": (200, {"data": {"limit_remaining": 5}})}, "limit"),
        ({"/api/v1/key": (200, key_body(100, "x"))}, "limit_remaining"),
        ({"/api/v1/key": (200, key_body(100, True))}, "limit_remaining"),
        ({"/api/v1/key": (200, {"data": {"limit": 100}})}, "limit_remaining"),
        (
            {"/api/v1/key": (200, b'{"data":{"limit":100,"limit_remaining":NaN}}')},
            "limit_remaining",
        ),
        ({"/api/v1/key": (200, key_body("lots", 5))}, "limit"),
        (
            {
                "/api/v1/key": (200, key_body(None, None)),
                "/api/v1/credits": (403, {"error": {"message": "management key required"}}),
            },
            "403",
        ),
        (
            {
                "/api/v1/key": (200, key_body(None, None)),
                "/api/v1/credits": (403, {"error": {"message": "management key required"}}),
            },
            "management key required",
        ),
        (
            {
                "/api/v1/key": (200, key_body(None, None)),
                "/api/v1/credits": (200, {"data": {"total_credits": 50}}),
            },
            "total_usage",
        ),
        (
            {
                "/api/v1/key": (200, key_body(None, None)),
                "/api/v1/credits": (200, {"data": {"total_credits": "50", "total_usage": 1}}),
            },
            "total_credits",
        ),
        (
            {
                "/api/v1/key": (200, key_body(None, None)),
                "/api/v1/credits": (200, b"nope"),
            },
            "JSON",
        ),
    ],
)
async def test_a_read_without_a_number_is_unknown_with_its_reason(openrouter, routes, says):
    openrouter(routes)

    got = await openai_chat.ADAPTER.balance(app, ROW)

    assert isinstance(got, Balance)
    assert got.remaining is None, "a failed read is never a number"
    assert says in got.words


@pytest.mark.parametrize("failure", [httpx.ConnectError, httpx.ReadTimeout])
async def test_a_transport_failure_is_unknown_with_its_reason(openrouter, failure):
    peer = openrouter(transport=FailingTransport(failure))

    got = await openai_chat.ADAPTER.balance(app, ROW)

    assert got.remaining is None
    assert failure.__name__ in got.words
    assert peer.requests == [("GET", "/api/v1/key")]


async def test_a_credits_transport_failure_is_unknown(openrouter):
    class KeyThenFail(Peer):
        async def handle_async_request(self, request):
            if request.url.path.endswith("/credits"):
                self.requests.append(request)
                raise httpx.ConnectError("simulated: no answer", request=request)
            return await super().handle_async_request(request)

    openrouter(transport=KeyThenFail({"/api/v1/key": (200, key_body(None, None))}))

    got = await openai_chat.ADAPTER.balance(app, ROW)

    assert got.remaining is None
    assert "ConnectError" in got.words


# C4 / C5 ----------------------------------------------------------------------


async def test_a_non_openrouter_openai_chat_row_has_no_balance_reader(mount_transport):
    peer = Peer({"/v1/key": (200, key_body(100, 50))})
    mount_transport("http://cloud.test", peer)
    row = dict(ROW, name="cloud", base_url="http://cloud.test/v1")

    assert await openai_chat.ADAPTER.balance(app, row) is None
    assert peer.requests == []


async def test_a_row_with_no_base_url_has_no_balance_reader():
    assert await openai_chat.ADAPTER.balance(app, dict(ROW, base_url="")) is None


def test_every_adapter_offers_balance():
    for name, adapter in _BY_NAME.items():
        assert callable(getattr(adapter, "balance", None)), name


@pytest.mark.parametrize(
    ("adapter", "row"),
    [
        (
            anthropic_messages.ADAPTER,
            dict(ROW, adapter="anthropic-messages", auth_shape="api-key-header"),
        ),
        (systemone.ADAPTER, dict(ROW, adapter="systemone")),
        (ollama.ADAPTER, dict(ROW, adapter="ollama")),
        (ollama.ADAPTER, dict(ROW, adapter="ollama", builtin=True)),
    ],
)
async def test_other_adapters_have_no_balance_reader(openrouter, monkeypatch, adapter, row):
    # Even pointed at OpenRouter's own host, only the protocol whose
    # provider states a balance reads one.
    monkeypatch.setenv("OLLAMA_URL", OPENROUTER_BASE)
    peer = openrouter({"/api/v1/key": (200, key_body(100, 50))})

    assert await adapter.balance(app, row) is None
    assert peer.requests == []


# C6 -------------------------------------------------------------------------


async def test_a_good_read_says_the_number_and_where_it_came_from(openrouter):
    openrouter({"/api/v1/key": (200, key_body(100, 94.7))})

    got = await openai_chat.ADAPTER.balance(app, ROW)

    assert "94.7" in got.words
    assert "/key" in got.words


async def test_a_good_credits_read_says_where_it_came_from(openrouter):
    openrouter(
        {
            "/api/v1/key": (200, key_body(None, None)),
            "/api/v1/credits": (200, {"data": {"total_credits": 50, "total_usage": 49.5}}),
        }
    )

    got = await openai_chat.ADAPTER.balance(app, ROW)

    assert "0.5" in got.words
    assert "/credits" in got.words
