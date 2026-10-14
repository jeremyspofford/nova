"""A money wall re-checks the balance (T3): routing meets the wall.

A turn's resolve and GET /admin/routes (what core's money check reads) pass
the live walls through routing.recheck_money_walls before judging or listing
them, so a 402 wall on a provider whose key now has money is gone the first
time anything looks — and a wall that may not lift stays exactly as today.
No test here reaches openrouter.ai: the provider's chat endpoint and its
/key are one counted fake mounted at https://openrouter.ai.
"""

from __future__ import annotations

import asyncio
import json
import time

import httpx
import pytest

from app import backends, engines, routing
from app.adapters import openai_chat
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat, StreamingASGITransport
from tests.test_money_wall_balance import ROW, Peer, key_body

pytestmark = requires_db

LINK = "openrouter:remote-model"
MONEY = {"/api/v1/key": (200, key_body(100, 94.7))}
BALANCE_PATHS = ("/api/v1/key", "/api/v1/credits")


class Split(httpx.AsyncBaseTransport):
    """OpenRouter as one origin: the balance paths go to `balance` (a counted
    Peer or a misbehaving transport), everything else to the chat fake."""

    def __init__(self, chat: FakeOpenAICompat, balance: httpx.AsyncBaseTransport) -> None:
        self.chat = StreamingASGITransport(chat.app)
        self.balance = balance

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.url.path in BALANCE_PATHS:
            return await self.balance.handle_async_request(request)
        return await self.chat.handle_async_request(request)


class SlowKey(Peer):
    """A /key that takes far longer than any turn may wait."""

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        await asyncio.sleep(30)
        return httpx.Response(200, json=key_body(100, 94.7), request=request)


@pytest.fixture(autouse=True)
def fresh_cadence():
    routing._rechecked.clear()
    yield
    routing._rechecked.clear()


@pytest.fixture
async def local(pool, monkeypatch, mount_backend):
    """The hub's ollama, the next link after the walled provider."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(deltas=("Hel", "lo"), tags=("qwen3:8b", "qwen3:4b"))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    engines.clear_cache()
    return fake


@pytest.fixture
async def openrouter(client, pool, local, mount_transport):
    """An OpenRouter-host provider whose chain falls back to the hub. Returns
    a mounter: mount(balance) -> (chat fake, balance transport)."""
    await pool.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key, local) "
        "VALUES ($1, $2, $3, 'static-bearer', $4, false)",
        ROW["name"],
        ROW["adapter"],
        ROW["base_url"],
        ROW["api_key"],
    )
    put = await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    assert put.status_code == 200, put.text

    def _mount(balance: httpx.AsyncBaseTransport | dict):
        chat = FakeOpenAICompat(prefix="/api/v1")
        peer = Peer(balance) if isinstance(balance, dict) else balance
        mount_transport("https://openrouter.ai", Split(chat, peer))
        return chat, peer

    return _mount


async def _chat(client):
    return await client.post(
        "/v1/chat/completions",
        json={"model": LINK, "messages": [{"role": "user", "content": "hi"}], "stream": True},
        headers={"X-Nova-Role": "chat", "X-Nova-Purpose": "chat", "X-Nova-Timezone": "UTC"},
    )


def _route_chunk(body: bytes) -> dict | None:
    for block in body.decode().strip().split("\n\n"):
        if block.startswith("data:"):
            payload = block[len("data:") :].strip()
            if payload != "[DONE]":
                frame = json.loads(payload)
                if isinstance(frame, dict) and frame.get("route"):
                    return frame["route"]
    return None


def _chat_calls(chat: FakeOpenAICompat) -> int:
    return len([p for p, _ in chat.seen if p.endswith("/chat/completions")])


def _key_reads(peer: Peer) -> int:
    return len([p for p in peer.paths if p in BALANCE_PATHS])


async def _rows(pool) -> list[dict]:
    rows = await pool.fetch(
        "SELECT provider, model, walled_until, reason, status, strikes, connect_failed "
        "FROM provider_walls WHERE provider = 'openrouter' ORDER BY model"
    )
    return [dict(r) for r in rows]


# C1 -------------------------------------------------------------------------


async def test_money_lifts_the_wall_and_the_turn_is_served_by_the_provider(
    client, pool, openrouter
):
    chat, peer = openrouter(MONEY)
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    assert await _rows(pool), "the wall was never set"

    resp = await _chat(client)

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == LINK
    assert resp.headers["x-nova-route"] == "role=chat;link=1"
    route = _route_chunk(resp.content)
    assert route["link"] == 1 and route["reason"] is None, route
    assert _chat_calls(chat) == 1
    assert _key_reads(peer) == 1, "the balance was never read"
    assert await _rows(pool) == [], "the wall outlived the money"


# C2 -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "balance",
    [
        {"/api/v1/key": (200, key_body(100, 0))},
        {"/api/v1/key": (401, {"error": {"message": "No auth credentials found"}})},
        {"/api/v1/key": (200, key_body(100, "x"))},
    ],
    ids=["zero", "refused", "no-number"],
)
async def test_no_money_keeps_todays_walled_verdict(client, pool, openrouter, balance):
    chat, peer = openrouter(balance)
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    before = await _rows(pool)

    resp = await _chat(client)

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"
    route = _route_chunk(resp.content)
    assert route["link"] == 2 and "walled for another" in route["reason"], route
    assert _chat_calls(chat) == 0, "a walled provider was called"
    assert _key_reads(peer) == 1, "the balance was never read"
    assert await _rows(pool) == before, "a read without money changed the wall"

    ex = (await client.get(f"/admin/route/explain?role=chat&model={LINK}")).json()
    assert ex["chain"][0]["verdict"] == "walled"
    assert ex["would_serve"]["served_by"] == "hub:qwen3:4b"


# C3 -------------------------------------------------------------------------


async def test_get_routes_lists_no_wall_after_a_money_read(client, pool, openrouter):
    _chat_fake, peer = openrouter(MONEY)
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")

    resp = await client.get("/admin/routes")

    assert resp.status_code == 200, resp.text
    assert resp.json()["walls"] == []
    assert _key_reads(peer) == 1, "GET /routes never read the balance"
    assert await _rows(pool) == []


async def test_get_routes_keeps_listing_the_wall_after_a_zero_read(client, pool, openrouter):
    _chat_fake, peer = openrouter({"/api/v1/key": (200, key_body(100, 0))})
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    before = await _rows(pool)

    walls = (await client.get("/admin/routes")).json()["walls"]

    assert [(w["provider"], w["status"], w["strikes"]) for w in walls] == [("openrouter", 402, 1)]
    assert walls[0]["reason"] == before[0]["reason"]
    assert _key_reads(peer) == 1
    assert await _rows(pool) == before


# C4 -------------------------------------------------------------------------


async def test_a_turn_and_get_routes_share_one_read_per_window(client, pool, openrouter):
    _chat_fake, peer = openrouter({"/api/v1/key": (200, key_body(100, 0))})
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")

    await _chat(client)
    walls = (await client.get("/admin/routes")).json()["walls"]

    assert [w["provider"] for w in walls] == ["openrouter"]
    assert _key_reads(peer) == 1, "the window was not shared between a turn and GET /routes"


# C5 -------------------------------------------------------------------------


@pytest.mark.parametrize("status", [401, 429])
async def test_another_wall_is_never_rechecked_through_routing(client, pool, openrouter, status):
    chat, peer = openrouter(MONEY)
    await routing.record_refusal(pool, ROW, status, "refused")
    before = await _rows(pool)
    assert [r["model"] for r in before] == [routing.WHOLE_PROVIDER]

    resp = await _chat(client)
    walls = (await client.get("/admin/routes")).json()["walls"]

    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"
    assert "walled for another" in _route_chunk(resp.content)["reason"]
    assert _chat_calls(chat) == 0
    assert [w["provider"] for w in walls] == ["openrouter"]
    assert peer.requests == [], "a wall that is not about money read the balance"
    assert await _rows(pool) == before


# C6 -------------------------------------------------------------------------


async def test_a_slow_balance_read_never_stalls_the_turn(client, pool, openrouter, monkeypatch):
    monkeypatch.setattr(routing, "BALANCE_DEADLINE_S", 0.3)
    chat, slow = openrouter(SlowKey())
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    before = await _rows(pool)

    started = time.monotonic()
    resp = await _chat(client)
    took = time.monotonic() - started

    assert slow.requests, "the balance was never asked for"
    assert took < 3.0, f"a stalled /key held the turn for {took:.1f}s"
    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"
    assert _chat_calls(chat) == 0
    assert await _rows(pool) == before


# C7 -------------------------------------------------------------------------


async def test_the_suite_guard_catches_an_unmounted_openrouter_read(no_real_openrouter):
    """The conftest guard: a read aimed at openrouter.ai that no test mounted
    is refused (an unknown balance, never a number) and recorded, so the
    guard's teardown fails the test that let it through."""
    got = await openai_chat.ADAPTER.balance(app, ROW)

    assert got is not None and got.remaining is None
    assert no_real_openrouter.reached == ["GET https://openrouter.ai/api/v1/key"]
    no_real_openrouter.reached.clear()  # this test made the read on purpose
