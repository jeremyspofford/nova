"""A money wall re-checks the balance (T2): routing.recheck_money_walls.

A provider-wide 402 wall on a provider whose adapter can read the key's
balance (T1) asks for it — at most once per provider per RECHECK_S, bounded by
BALANCE_DEADLINE_S — and lifts itself when the balance shows money. A read
that shows nothing, fails, or is too slow keeps the wall exactly as it was;
every other wall is never re-checked. No test here reaches openrouter.ai:
every peer is a counted fake mounted on app.state.peer_transports.
"""

from __future__ import annotations

import asyncio
import logging
import time

import httpx
import pytest

from app import routing
from app.adapters import openai_chat
from app.main import app
from tests.fakes import FailingTransport
from tests.test_money_wall_balance import ROW, Peer, key_body

OTHER_BASE = "https://api.example.com/v1"
OTHER = {**ROW, "name": "other", "base_url": OTHER_BASE, "api_key": "sk-other"}
OLLAMA = {
    "name": "box",
    "adapter": "ollama",
    "base_url": "https://openrouter.ai/api/v1",
    "local": True,
    "builtin": False,
}
MONEY = {"/api/v1/key": (200, key_body(100, 94.7))}
SECOND = {**ROW, "name": "openrouter-b", "api_key": "sk-or-b"}
THIRD = {**OTHER, "name": "third"}


@pytest.fixture(autouse=True)
async def seeded(pool):
    """Every provider these tests wall exists (provider_walls references
    providers)."""
    for row in (ROW, SECOND, OTHER, THIRD, OLLAMA):
        await pool.execute(
            "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key, local) "
            "VALUES ($1, $2, $3, 'static-bearer', 'tok', $4)",
            row["name"],
            row["adapter"],
            row["base_url"],
            row["local"],
        )


@pytest.fixture(autouse=True)
def fresh_cadence():
    routing._rechecked.clear()
    yield
    routing._rechecked.clear()


class Clock:
    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def mount(mount_transport):
    def _mount(base: str, routes=None, transport=None):
        peer = transport or Peer(routes)
        mount_transport(base, peer)
        return peer

    return _mount


async def _rows(pool, provider: str) -> list[dict]:
    rows = await pool.fetch(
        "SELECT provider, model, walled_until, reason, status, strikes, connect_failed "
        "FROM provider_walls WHERE provider = $1 ORDER BY model",
        provider,
    )
    return [dict(r) for r in rows]


def _by_name(*rows: dict) -> dict[str, dict]:
    return {r["name"]: r for r in rows}


# C1 -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "routes, says",
    [
        (MONEY, "94.7"),
        ({"/api/v1/key": (200, key_body(100, 0.01))}, "0.01"),
        (
            {
                "/api/v1/key": (200, key_body(None, None)),
                "/api/v1/credits": (200, {"data": {"total_credits": 50, "total_usage": 49.5}}),
            },
            "0.5",
        ),
    ],
)
async def test_money_lifts_a_402_wall_and_its_model_walls(pool, mount, caplog, routes, says):
    peer = mount("https://openrouter.ai", routes)
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    await routing.record_refusal(pool, ROW, 503, "loading", model="some/model")
    walled = await routing.walls(pool)
    assert ("openrouter", routing.WHOLE_PROVIDER) in walled

    with caplog.at_level(logging.INFO, logger="gateway"):
        got = await routing.recheck_money_walls(app, pool, _by_name(ROW), walled, clock=Clock())

    assert peer.requests, "the balance was never read"
    assert await _rows(pool, "openrouter") == [], "the wall outlived the money"
    assert not [k for k in got if k[0] == "openrouter"], got
    assert f"wall lifted: openrouter balance {says}" in caplog.text


async def test_a_lifted_wall_no_longer_stops_the_link(pool, mount):
    mount("https://openrouter.ai", MONEY)
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    walled = await routing.walls(pool)

    got = await routing.recheck_money_walls(app, pool, _by_name(ROW), walled, clock=Clock())

    assert routing.wall_for(got, "openrouter", "some/model") is None
    assert routing.wall_for(await routing.walls(pool), "openrouter", "some/model") is None


# C2 -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "routes, transport",
    [
        ({"/api/v1/key": (200, key_body(100, 0))}, None),
        ({"/api/v1/key": (200, key_body(100, -1.5))}, None),
        (
            {
                "/api/v1/key": (200, key_body(None, None)),
                "/api/v1/credits": (200, {"data": {"total_credits": 10, "total_usage": 10}}),
            },
            None,
        ),
        ({"/api/v1/key": (401, {"error": {"message": "No auth credentials found"}})}, None),
        ({"/api/v1/key": (500, {"error": "boom"})}, None),
        ({"/api/v1/key": (200, {})}, None),
        ({"/api/v1/key": (200, key_body(100, "x"))}, None),
        (None, FailingTransport(httpx.ConnectError)),
    ],
    ids=["zero", "negative", "credits-used-up", "401", "500", "empty", "not-a-number", "down"],
)
async def test_no_money_or_no_read_keeps_the_wall_as_it_was(pool, mount, caplog, routes, transport):
    peer = mount("https://openrouter.ai", routes, transport)
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    before = await _rows(pool, "openrouter")
    walled = await routing.walls(pool)

    with caplog.at_level(logging.INFO, logger="gateway"):
        got = await routing.recheck_money_walls(app, pool, _by_name(ROW), walled, clock=Clock())

    assert peer.requests, "the balance was never read"
    assert await _rows(pool, "openrouter") == before, "a read without money moved the wall"
    assert before[0]["strikes"] == 2
    assert got[("openrouter", routing.WHOLE_PROVIDER)] == walled[("openrouter", "")]
    assert "wall lifted" not in caplog.text
    kept = [r.getMessage() for r in caplog.records if "wall kept: openrouter" in r.getMessage()]
    assert kept, caplog.text
    assert "openrouter.ai/api/v1/" in kept[0], "the kept line does not carry the read's words"


# C3 -------------------------------------------------------------------------


async def test_one_read_per_provider_per_recheck_window(pool, mount):
    peer = mount("https://openrouter.ai", {"/api/v1/key": (200, key_body(100, 0))})
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    walled = await routing.walls(pool)
    clock = Clock()

    await routing.recheck_money_walls(app, pool, _by_name(ROW), walled, clock=clock)
    assert len(peer.requests) == 1

    clock.now += routing.RECHECK_S - 1
    got = await routing.recheck_money_walls(app, pool, _by_name(ROW), walled, clock=clock)
    assert len(peer.requests) == 1, "read again inside RECHECK_S"
    assert ("openrouter", routing.WHOLE_PROVIDER) in got

    clock.now += 2
    await routing.recheck_money_walls(app, pool, _by_name(ROW), walled, clock=clock)
    assert len(peer.requests) == 2, "never read again after RECHECK_S"


async def test_a_wall_inside_its_window_does_not_lift_even_with_money(pool, mount):
    peer = mount("https://openrouter.ai", {"/api/v1/key": (200, key_body(100, 0))})
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    walled = await routing.walls(pool)
    clock = Clock()
    await routing.recheck_money_walls(app, pool, _by_name(ROW), walled, clock=clock)

    peer.routes["/api/v1/key"] = (200, key_body(100, 50))
    clock.now += 10
    got = await routing.recheck_money_walls(app, pool, _by_name(ROW), walled, clock=clock)
    assert ("openrouter", routing.WHOLE_PROVIDER) in got
    assert len(peer.requests) == 1

    clock.now += routing.RECHECK_S
    got = await routing.recheck_money_walls(app, pool, _by_name(ROW), walled, clock=clock)
    assert ("openrouter", routing.WHOLE_PROVIDER) not in got
    assert await _rows(pool, "openrouter") == []


async def test_the_window_is_per_provider(pool, mount):
    peer = mount("https://openrouter.ai", {"/api/v1/key": (200, key_body(100, 0))})
    second = SECOND
    clock = Clock()
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    await routing.recheck_money_walls(
        app, pool, _by_name(ROW, second), await routing.walls(pool), clock=clock
    )
    assert len(peer.requests) == 1

    clock.now += 10
    await routing.record_refusal(pool, second, 402, "Insufficient credits")
    await routing.recheck_money_walls(
        app, pool, _by_name(ROW, second), await routing.walls(pool), clock=clock
    )
    assert len(peer.requests) == 2, "one provider's read held back another's"
    assert peer.requests[1].headers["authorization"] == "Bearer sk-or-b"


# C4 -------------------------------------------------------------------------


async def test_a_model_scoped_402_is_not_a_money_wall(pool, mount):
    """Only the provider-wide 402 is about the account's money."""
    peer = mount("https://openrouter.ai", MONEY)
    await pool.execute(
        "INSERT INTO provider_walls (provider, model, walled_until, reason, status, strikes) "
        "VALUES ('openrouter', 'some/model', now() + interval '1 hour', 'r', 402, 1)"
    )
    walled = await routing.walls(pool)

    got = await routing.recheck_money_walls(app, pool, _by_name(ROW), walled, clock=Clock())

    assert peer.requests == []
    assert got == walled
    assert len(await _rows(pool, "openrouter")) == 1


async def test_concurrent_turns_read_a_provider_once(pool, mount):
    """The window is stamped before the read: two turns meeting the wall at
    once share one read."""
    peer = mount("https://openrouter.ai", {"/api/v1/key": (200, key_body(100, 0))})
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    walled = await routing.walls(pool)
    clock = Clock()

    await asyncio.gather(
        *(
            routing.recheck_money_walls(app, pool, _by_name(ROW), walled, clock=clock)
            for _ in range(3)
        )
    )

    assert len(peer.requests) == 1


@pytest.mark.parametrize("status", [401, 403, 429])
async def test_another_account_wall_is_never_rechecked(pool, mount, status):
    peer = mount("https://openrouter.ai", MONEY)
    await routing.record_refusal(pool, ROW, status, "nope")
    before = await _rows(pool, "openrouter")
    walled = await routing.walls(pool)

    got = await routing.recheck_money_walls(app, pool, _by_name(ROW), walled, clock=Clock())

    assert peer.requests == []
    assert await _rows(pool, "openrouter") == before
    assert got == walled


async def test_an_outage_wall_is_never_rechecked(pool, mount):
    peer = mount("https://openrouter.ai", MONEY)
    await routing.record_refusal(pool, ROW, 503, "loading", model="some/model")
    before = await _rows(pool, "openrouter")
    walled = await routing.walls(pool)

    got = await routing.recheck_money_walls(app, pool, _by_name(ROW), walled, clock=Clock())

    assert peer.requests == []
    assert await _rows(pool, "openrouter") == before
    assert got == walled


@pytest.mark.parametrize("row", [OTHER, OLLAMA], ids=["openai-chat-elsewhere", "ollama"])
async def test_a_402_wall_with_no_balance_reader_keeps_the_ladder(pool, mount, row):
    peer = mount(row["base_url"].rsplit("/api/v1", 1)[0].rsplit("/v1", 1)[0], MONEY)
    await routing.record_refusal(pool, row, 402, "Insufficient credits")
    before = await _rows(pool, row["name"])
    walled = await routing.walls(pool)

    got = await routing.recheck_money_walls(app, pool, _by_name(row), walled, clock=Clock())

    assert peer.requests == []
    assert await _rows(pool, row["name"]) == before
    assert got == walled


async def test_a_402_wall_on_an_unknown_provider_is_kept(pool, mount):
    peer = mount("https://openrouter.ai", MONEY)
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    walled = await routing.walls(pool)

    got = await routing.recheck_money_walls(app, pool, {}, walled, clock=Clock())

    assert peer.requests == []
    assert got == walled
    assert len(await _rows(pool, "openrouter")) == 1


# C5 -------------------------------------------------------------------------


class Slow(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        await asyncio.sleep(30)
        return httpx.Response(200, json=key_body(100, 94.7), request=request)


async def test_a_slow_balance_read_is_abandoned_and_keeps_the_wall(
    pool, mount, monkeypatch, caplog
):
    monkeypatch.setattr(routing, "BALANCE_DEADLINE_S", 0.5)
    slow = mount("https://openrouter.ai", transport=Slow())
    second = SECOND
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    await routing.record_refusal(pool, second, 402, "Insufficient credits")
    walled = await routing.walls(pool)

    started = time.monotonic()
    with caplog.at_level(logging.INFO, logger="gateway"):
        got = await routing.recheck_money_walls(
            app, pool, _by_name(ROW, second), walled, clock=Clock()
        )
    took = time.monotonic() - started

    assert len(slow.requests) == 2
    # Both reads run at once under one deadline: one after the other would be
    # 1.0 s or more.
    assert took < 0.9, f"two slow reads held the turn {took:.2f}s (deadline 0.5s, together)"
    assert got == walled
    assert len(await _rows(pool, "openrouter")) == 1
    assert "wall kept: openrouter" in caplog.text
    assert "timed out after 0.5s" in caplog.text


async def test_a_balance_reader_that_raises_keeps_the_wall(pool, monkeypatch, caplog):
    async def broken(app, row):
        raise RuntimeError("reader bug")

    monkeypatch.setattr(openai_chat.ADAPTER, "balance", broken)
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    walled = await routing.walls(pool)

    with caplog.at_level(logging.INFO, logger="gateway"):
        got = await routing.recheck_money_walls(app, pool, _by_name(ROW), walled, clock=Clock())

    assert got == walled
    assert len(await _rows(pool, "openrouter")) == 1
    assert "reader bug" in caplog.text


# C6 -------------------------------------------------------------------------


async def test_other_walls_are_untouched_and_the_callers_map_is_not_mutated(pool, mount):
    mount("https://openrouter.ai", MONEY)
    third = THIRD
    await routing.record_refusal(pool, ROW, 402, "Insufficient credits")
    await routing.record_refusal(pool, OTHER, 402, "Insufficient credits")
    await routing.record_refusal(pool, third, 429, "slow down")
    await routing.record_refusal(pool, third, 503, "loading", model="m")
    other_before = await _rows(pool, "other")
    third_before = await _rows(pool, "third")
    walled = await routing.walls(pool)
    snapshot = {k: dict(v) for k, v in walled.items()}

    got = await routing.recheck_money_walls(
        app, pool, _by_name(ROW, OTHER, third), walled, clock=Clock()
    )

    assert walled == snapshot, "the caller's map was mutated"
    assert ("openrouter", routing.WHOLE_PROVIDER) in walled
    assert {k for k in got} == {k for k in walled if k[0] != "openrouter"}
    assert await _rows(pool, "other") == other_before
    assert await _rows(pool, "third") == third_before
    assert await _rows(pool, "openrouter") == []
