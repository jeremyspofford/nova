"""The credit-wall probe (epic wall-probe, T3): wall_probe.probe_wall.

Pins: ONE non-stream 1-token completion ("hi") on the walled provider's
model, that model being the one of the provider's LATEST refusal on the
ledger; the probe is itself a ledger row (purpose wall_probe); it says
served only when the provider verifiably served — status 200 AND a JSON
body with a non-empty `choices` and no `error`, never "the status was ok";
a refusal or a failure is not served and says why; with no refused model
on record it makes no call at all and states that it cannot probe.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

import httpx
import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from app import backends, engines, providers, routing, wall_probe
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FailingTransport, FakeOllama, FakeOpenAICompat

pytestmark = requires_db

BASE = "http://openrouter.test"
CREDITS = "This request requires more credits, or fewer max_tokens. Insufficient credits"


@pytest.fixture(autouse=True)
async def hub(pool, monkeypatch, mount_backend):
    """The hub's own ollama: adding a cloud provider checks its name against
    the hub's model tags, so the hub must answer."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    mount_backend("http://ollama.test", FakeOllama(tags=("qwen3:8b",)).app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    engines.clear_cache()


async def _openrouter(client, mount_backend, fake: FakeOpenAICompat) -> FakeOpenAICompat:
    """OpenRouter as a cloud provider row over `fake`; whatever adding it
    asked of the fake is forgotten, so `fake.seen` counts the probe only."""
    mount_backend(BASE, fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "openrouter",
            "adapter": "openai-chat",
            "base_url": f"{BASE}/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    assert resp.status_code == 200, resp.text
    fake.seen.clear()
    return fake


async def _ledger(pool, provider, model, *, ago_s, kind="refusal", status=402, purpose="chat"):
    """A usage_events row `ago_s` seconds old, the way a real call leaves one."""
    await pool.execute(
        "INSERT INTO usage_events (at, provider, model, served_by, kind, purpose, duration_ms, "
        "local, status) VALUES (now() - make_interval(secs => $1), $2, $3, $4, $5, $6, 10, "
        "false, $7)",
        float(ago_s),
        provider,
        model,
        f"{provider}:{model}",
        kind,
        purpose,
        status,
    )


async def _credit_wall(pool, model="remote-model") -> dict:
    """OpenRouter walled for credits, as walls() hands the wall back, with the
    402 that set it on the ledger."""
    row = await providers.get_row(pool, "openrouter")
    await routing.record_refusal(pool, row, 402, CREDITS, model=model)
    await _ledger(pool, "openrouter", model, ago_s=60)
    return (await routing.walls(pool))[("openrouter", routing.WHOLE_PROVIDER)]


def _completion_posts(fake: FakeOpenAICompat) -> list[dict | None]:
    return [body for path, body in fake.seen if path.endswith("/chat/completions")]


async def _probe_rows(pool) -> list:
    return await pool.fetch(
        "SELECT provider, model, kind, status FROM usage_events WHERE purpose = 'wall_probe' "
        "ORDER BY id"
    )


# ── c1: one call, the cheapest one ─────────────────────────────────────────


async def test_the_probe_is_one_non_stream_one_token_completion_on_the_refused_model(
    client, pool, mount_backend
):
    fake = await _openrouter(client, mount_backend, FakeOpenAICompat(accepts_key="sk-1"))
    wall = await _credit_wall(pool)

    await wall_probe.probe_wall(app, pool, wall)

    posts = _completion_posts(fake)
    assert len(posts) == 1, fake.seen
    body = posts[0]
    assert body["model"] == "remote-model"
    assert body["max_tokens"] == 1
    assert not body.get("stream")
    assert body["messages"] == [{"role": "user", "content": "hi"}]
    # Nothing else was asked of the provider: no listing, no second try.
    assert len(fake.seen) == 1, fake.seen


# ── c2: the model is the one the provider last refused ──────────────────────


async def test_the_probed_model_is_the_one_of_the_providers_latest_refusal(
    client, pool, mount_backend
):
    fake = await _openrouter(client, mount_backend, FakeOpenAICompat(accepts_key="sk-1"))
    wall = await _credit_wall(pool, model="remote-model")  # its refusal: 60 s ago
    # Older refusal on another model, newer rows that are not this provider's
    # refusals: none of them is the model to probe.
    await _ledger(pool, "openrouter", "old-model", ago_s=7200)
    await _ledger(pool, "openrouter", "served-model", ago_s=5, kind="completion", status=200)
    await _ledger(pool, "anthropic", "claude-model", ago_s=1)

    result = await wall_probe.probe_wall(app, pool, wall)

    assert [body["model"] for body in _completion_posts(fake)] == ["remote-model"]
    assert result.model == "remote-model"


# ── c3: a probe the provider served lifts nothing yet, but says served ──────


async def test_a_probe_the_provider_served_is_served_and_on_the_ledger(client, pool, mount_backend):
    # Topped up enough for one token: the probe is served (a full turn's
    # max_tokens may still be refused — T7 says so; not this task's).
    fake = await _openrouter(client, mount_backend, FakeOpenAICompat(accepts_key="sk-1"))
    wall = await _credit_wall(pool)
    fake.affords_tokens = 1

    result = await wall_probe.probe_wall(app, pool, wall)

    assert result.served is True
    assert result.status == 200
    assert result.model == "remote-model"
    rows = await _probe_rows(pool)
    assert [(r["provider"], r["model"], r["kind"], r["status"]) for r in rows] == [
        ("openrouter", "remote-model", "probe", 200)
    ]


# ── c4: a refused probe is not served, says why, and is on the ledger ───────


async def test_a_refused_probe_is_not_served_states_the_refusal_and_is_on_the_ledger(
    client, pool, mount_backend
):
    fake = await _openrouter(client, mount_backend, FakeOpenAICompat(accepts_key="sk-1"))
    wall = await _credit_wall(pool)
    fake.affords_tokens = 0  # still out of credit: even one token is refused

    result = await wall_probe.probe_wall(app, pool, wall)

    assert result.served is False
    assert result.status == 402
    assert result.reason and "402" in result.reason
    assert len(_completion_posts(fake)) == 1
    rows = await _probe_rows(pool)
    assert [(r["provider"], r["model"], r["kind"], r["status"]) for r in rows] == [
        ("openrouter", "remote-model", "refusal", 402)
    ]


# ── c5: verify-served — a 200 that is not a completion is not served ────────


def _answers_200(payload: bytes | dict, calls: list) -> Starlette:
    """A provider whose completion route answers 200 with `payload`, which is
    not a completion — an empty choices list, an error object, a proxy's HTML."""

    async def _completions(request):
        calls.append(await request.body())
        if isinstance(payload, dict):
            return JSONResponse(payload)
        return Response(payload, media_type="text/html")

    return Starlette(routes=[Route("/v1/chat/completions", _completions, methods=["POST"])])


@pytest.mark.parametrize(
    "payload",
    [
        {"choices": []},
        {"error": {"message": "Insufficient credits", "code": 402}},
        {"choices": [{"message": {"content": "ok"}}], "error": {"message": "partial"}},
        b"<html><body>502 Bad Gateway</body></html>",
    ],
    ids=["empty-choices", "error-object", "choices-and-error", "not-json"],
)
async def test_a_200_that_is_not_a_completion_is_not_served(client, pool, mount_backend, payload):
    await _openrouter(client, mount_backend, FakeOpenAICompat(accepts_key="sk-1"))
    wall = await _credit_wall(pool)
    calls: list = []
    mount_backend(BASE, _answers_200(payload, calls))

    result = await wall_probe.probe_wall(app, pool, wall)

    assert result.served is False
    assert result.reason  # says why it was not a completion
    assert len(calls) == 1
    assert len(await _probe_rows(pool)) == 1


async def test_a_completion_body_under_a_status_other_than_200_is_not_served(
    client, pool, mount_backend
):
    # Served means status 200 AND a completion: a completion-shaped body
    # under any other status (here a 203) is not served.
    await _openrouter(client, mount_backend, FakeOpenAICompat(accepts_key="sk-1"))
    wall = await _credit_wall(pool)
    calls: list = []

    async def _completions(request):
        calls.append(await request.body())
        return JSONResponse({"choices": [{"message": {"content": "ok"}}]}, status_code=203)

    mount_backend(
        BASE, Starlette(routes=[Route("/v1/chat/completions", _completions, methods=["POST"])])
    )

    result = await wall_probe.probe_wall(app, pool, wall)

    assert result.served is False
    assert result.status == 203
    assert result.reason and "203" in result.reason
    assert len(calls) == 1
    assert len(await _probe_rows(pool)) == 1


async def test_a_probe_that_never_reached_the_provider_is_not_served_and_says_why(
    client, pool, mount_backend, mount_transport
):
    await _openrouter(client, mount_backend, FakeOpenAICompat(accepts_key="sk-1"))
    wall = await _credit_wall(pool)
    dead = FailingTransport(httpx.ConnectError)
    mount_transport(BASE, dead)

    result = await wall_probe.probe_wall(app, pool, wall)

    assert result.served is False
    assert result.reason
    assert len(dead.requests) == 1
    rows = await _probe_rows(pool)
    assert [r["kind"] for r in rows] == ["refusal"]


# ── c6: no refused model on record — no call, a stated reason ──────────────


async def test_with_no_refused_model_on_record_it_makes_no_call_and_says_it_cannot_probe(
    client, pool, mount_backend
):
    fake = await _openrouter(client, mount_backend, FakeOpenAICompat(accepts_key="sk-1"))
    row = await providers.get_row(pool, "openrouter")
    await routing.record_refusal(pool, row, 402, CREDITS)
    wall = (await routing.walls(pool))[("openrouter", routing.WHOLE_PROVIDER)]
    # The ledger holds this provider's completions and another's refusals,
    # never a refusal of this provider: there is no model to probe.
    await _ledger(pool, "openrouter", "served-model", ago_s=30, kind="completion", status=200)
    await _ledger(pool, "anthropic", "claude-model", ago_s=10)

    result = await wall_probe.probe_wall(app, pool, wall)

    assert result.served is False
    assert result.reason == "cannot probe: no refused model on record"
    assert result.model is None
    assert result.status is None
    assert _completion_posts(fake) == []
    assert await _probe_rows(pool) == []


# ══ T4: which walls are due a probe ════════════════════════════════════════


async def _provider_row(pool, name):
    """A cloud provider row for a wall to hang off (provider_walls' FK)."""
    await pool.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key) VALUES "
        "($1, 'openai-chat', 'https://' || $1 || '.test/v1', 'static-bearer', 'sk-1') "
        "ON CONFLICT (name) DO NOTHING",
        name,
    )


async def _stored_wall(
    pool, provider, status, *, refused_ago_s, probed_ago_s=None, left_s=4 * 3600, model=""
):
    """A provider_walls row as record_refusal leaves one, its refusal
    `refused_ago_s` old (updated_at) and `left_s` still to run; probed
    `probed_ago_s` ago when given, never probed otherwise."""
    await _provider_row(pool, provider)
    await pool.execute(
        "INSERT INTO provider_walls (provider, model, walled_until, reason, status, strikes, "
        "updated_at) VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5, 2, "
        "now() - make_interval(secs => $6))",
        provider,
        model,
        float(left_s),
        f"{provider} refused ({status}): out of something",
        status,
        float(refused_ago_s),
    )
    if probed_ago_s is not None:
        await pool.execute(
            "UPDATE provider_walls SET probed_at = now() - make_interval(secs => $3) "
            "WHERE provider = $1 AND model = $2",
            provider,
            model,
            float(probed_ago_s),
        )


async def _due(pool) -> set[tuple[str, str]]:
    return {(w["provider"], w["model"]) for w in await wall_probe.due_walls(pool)}


# ── c2: a credit wall an hour old, never probed, is due — as a wall ────────


async def test_a_credit_wall_refused_over_an_hour_ago_and_never_probed_is_due(pool):
    await _stored_wall(pool, "openrouter", 402, refused_ago_s=2 * 3600)

    due = await wall_probe.due_walls(pool)

    assert len(due) == 1, due
    wall = due[0]
    assert (wall["provider"], wall["model"]) == ("openrouter", routing.WHOLE_PROVIDER)
    assert wall["status"] == 402
    assert wall["reason"] == "openrouter refused (402): out of something"
    assert wall["probed_at"] is None
    # The same wall walls() hands back: its stored refusal time and end.
    stored = (await routing.walls(pool))[("openrouter", routing.WHOLE_PROVIDER)]
    assert wall["refused_at"] == stored["refused_at"]
    assert wall["walled_until"] == stored["walled_until"]


async def test_a_fresh_credit_wall_is_never_probed_and_not_due(pool):
    await _provider_row(pool, "openrouter")
    await routing.record_refusal(pool, {"name": "openrouter"}, 402, CREDITS, model="remote-model")

    stamped = await pool.fetchval("SELECT probed_at FROM provider_walls")

    assert stamped is None
    assert await _due(pool) == set()


# ── c3: the hour is WALL_PROBE_EVERY_S, counted from the refusal ───────────


async def test_a_credit_wall_refused_under_an_hour_ago_is_not_due_yet(pool):
    assert wall_probe.WALL_PROBE_EVERY_S == 3600
    await _stored_wall(pool, "early", 402, refused_ago_s=3590)
    await _stored_wall(pool, "late", 402, refused_ago_s=3610)

    assert await _due(pool) == {("late", routing.WHOLE_PROVIDER)}


# ── c4: the hour counts from the LATER of the refusal and the last probe ───


async def test_the_hour_counts_from_the_later_of_the_refusal_and_the_last_probe(pool):
    # Refused long ago, probed recently: the probe restarts the hour.
    await _stored_wall(pool, "probed-recently", 402, refused_ago_s=3 * 3600, probed_ago_s=600)
    # Refused long ago, last probed over an hour ago: due again.
    await _stored_wall(pool, "probed-long-ago", 402, refused_ago_s=3 * 3600, probed_ago_s=3660)
    # Probed 2 h ago, then refused again 10 min ago (a real turn): not due.
    await _stored_wall(pool, "refused-since", 402, refused_ago_s=600, probed_ago_s=2 * 3600)

    assert await _due(pool) == {("probed-long-ago", routing.WHOLE_PROVIDER)}


# ── c5: only a stored credit status is ever due — read off the row ─────────


async def test_only_a_wall_whose_stored_status_is_a_credit_status_is_ever_due(pool):
    assert wall_probe.CREDIT_STATUSES == frozenset({402})
    for status in (401, 403, 429, 500, 502, 503):
        await _stored_wall(pool, f"p{status}", status, refused_ago_s=3 * 3600)
    await _stored_wall(pool, "p502", 502, refused_ago_s=3 * 3600, model="some-model")
    # The name decides nothing: openrouter rate-limited is not due, and any
    # provider out of credit is.
    await _stored_wall(pool, "openrouter", 429, refused_ago_s=3 * 3600)
    await _stored_wall(pool, "anthropic", 402, refused_ago_s=3 * 3600)

    assert await _due(pool) == {("anthropic", routing.WHOLE_PROVIDER)}


# ── c6: a wall that has run out is not a wall ─────────────────────────────


async def test_a_wall_past_its_walled_until_is_never_due(pool):
    await _stored_wall(pool, "expired", 402, refused_ago_s=3 * 3600, left_s=-60)
    await _stored_wall(pool, "standing", 402, refused_ago_s=3 * 3600)

    assert await _due(pool) == {("standing", routing.WHOLE_PROVIDER)}


# ══ T5: the tick probes the due walls; the loop ticks; lifespan runs it ════


async def _cloud(client, mount_backend, name: str, base: str, fake: FakeOpenAICompat):
    """A cloud provider row `name` over `fake` at `base`; fake.seen cleared."""
    mount_backend(base, fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": name,
            "adapter": "openai-chat",
            "base_url": f"{base}/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    assert resp.status_code == 200, resp.text
    fake.seen.clear()
    return fake


async def _walled_for_credits(pool, provider: str, *, refused_ago_s: float, model="remote-model"):
    """`provider` walled by a real 402 refusal (record_refusal) whose refusal
    is `refused_ago_s` old, with that 402 on the ledger."""
    row = await providers.get_row(pool, provider)
    await routing.record_refusal(pool, row, 402, CREDITS, model=model)
    await _ledger(pool, provider, model, ago_s=refused_ago_s)
    await pool.execute(
        "UPDATE provider_walls SET updated_at = now() - make_interval(secs => $2) "
        "WHERE provider = $1",
        provider,
        float(refused_ago_s),
    )


async def _three_providers(client, pool, mount_backend):
    """Two credit walls due a probe (refused 2 h ago) and one not (refused
    10 min ago); every provider still out of credit, so every wall stands."""
    fakes = {}
    for name in ("openrouter", "deepinfra", "freshly"):
        fakes[name] = await _cloud(
            client,
            mount_backend,
            name,
            f"http://{name}.test",
            FakeOpenAICompat(accepts_key="sk-1", affords_tokens=0),
        )
    await _walled_for_credits(pool, "openrouter", refused_ago_s=2 * 3600)
    await _walled_for_credits(pool, "deepinfra", refused_ago_s=2 * 3600)
    await _walled_for_credits(pool, "freshly", refused_ago_s=600)
    return fakes


async def _probed_at(pool) -> dict:
    return {
        r["provider"]: r["probed_at"]
        for r in await pool.fetch("SELECT provider, probed_at FROM provider_walls")
    }


# ── c1: a tick probes every due wall exactly once, and only the due ones ──


async def test_a_tick_probes_every_due_wall_once_and_no_wall_that_is_not_due(
    client, pool, mount_backend
):
    fakes = await _three_providers(client, pool, mount_backend)

    await wall_probe.tick(app, pool)

    assert len(_completion_posts(fakes["openrouter"])) == 1
    assert len(_completion_posts(fakes["deepinfra"])) == 1
    assert _completion_posts(fakes["freshly"]) == []
    # Each through probe_wall: one wall_probe ledger row per due wall.
    rows = await _probe_rows(pool)
    assert sorted(r["provider"] for r in rows) == ["deepinfra", "openrouter"]


# ── c2: a tick stamps probed_at on what it probed; the next tick is quiet ──


async def test_a_tick_stamps_probed_at_on_each_wall_it_probed_and_no_other(
    client, pool, mount_backend
):
    await _three_providers(client, pool, mount_backend)
    before = await pool.fetchval("SELECT now()")

    await wall_probe.tick(app, pool)

    stamped = await _probed_at(pool)
    after = await pool.fetchval("SELECT now()")
    for provider in ("openrouter", "deepinfra"):
        assert stamped[provider] is not None, stamped
        assert before <= stamped[provider] <= after
    assert stamped["freshly"] is None


async def test_a_second_tick_straight_after_probes_nothing(client, pool, mount_backend):
    fakes = await _three_providers(client, pool, mount_backend)

    await wall_probe.tick(app, pool)
    await wall_probe.tick(app, pool)

    assert len(_completion_posts(fakes["openrouter"])) == 1
    assert len(_completion_posts(fakes["deepinfra"])) == 1
    assert _completion_posts(fakes["freshly"]) == []
    assert len(await _probe_rows(pool)) == 2


async def test_a_probe_that_raises_is_logged_and_the_tick_probes_the_next_wall(
    client, pool, mount_backend, monkeypatch, caplog
):
    """COVERAGE (c1/c4): one provider's probe raising never starves the
    other due walls in the same tick; it is logged with its traceback and
    left unstamped, so it is due again next tick."""
    fakes = await _three_providers(client, pool, mount_backend)
    real = wall_probe.probe_wall

    async def deepinfra_breaks(app_, pool_, wall):
        if wall["provider"] == "deepinfra":
            raise RuntimeError("boom: deepinfra probe broke")
        return await real(app_, pool_, wall)

    monkeypatch.setattr(wall_probe, "probe_wall", deepinfra_breaks)
    caplog.set_level(logging.INFO)

    await wall_probe.tick(app, pool)

    assert len(_completion_posts(fakes["openrouter"])) == 1
    stamped = await _probed_at(pool)
    assert stamped["openrouter"] is not None
    assert stamped["deepinfra"] is None
    assert any(
        r.levelno >= logging.ERROR and r.exc_info and "boom" in str(r.exc_info[1])
        for r in caplog.records
    ), [(r.levelname, r.getMessage()) for r in caplog.records]


# ── c3: the loop ticks once per interval, PROBE_TICK_S by default ──────────

# Every loop test runs the loop under asyncio.wait_for(..., LOOP_BOUND_S),
# and every fake tick/sleep yields to the event loop, so a loop that never
# sleeps or never ends FAILS with TimeoutError instead of hanging the run
# (the gateway has no per-test timeout).
LOOP_BOUND_S = 5


def _recording(events: list, *, stop_after_sleeps: int):
    """A tick and a sleep that log into `events`; the sleep cancels the loop
    after `stop_after_sleeps` sleeps, the way a shutdown does. Both yield."""

    async def fake_tick(app_, pool_):
        await asyncio.sleep(0)
        events.append(("tick", app_, pool_))

    async def fake_sleep(seconds):
        await asyncio.sleep(0)
        events.append(("sleep", seconds))
        if sum(1 for e in events if e[0] == "sleep") >= stop_after_sleeps:
            raise asyncio.CancelledError

    return fake_tick, fake_sleep


def _no_two_ticks_without_a_sleep(events: list) -> bool:
    kinds = [e[0] for e in events]
    return all(not (a == b == "tick") for a, b in zip(kinds, kinds[1:]))


async def test_the_loop_ticks_once_every_probe_tick_s_by_default(pool, monkeypatch):
    assert wall_probe.PROBE_TICK_S == 300
    events: list = []
    fake_tick, fake_sleep = _recording(events, stop_after_sleeps=3)
    monkeypatch.setattr(wall_probe, "tick", fake_tick)

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(wall_probe.loop(app, pool, sleep=fake_sleep), LOOP_BOUND_S)

    sleeps = [e[1] for e in events if e[0] == "sleep"]
    ticks = [e for e in events if e[0] == "tick"]
    assert sleeps == [300, 300, 300]
    assert len(ticks) >= 2, events
    assert all(t[1] is app and t[2] is pool for t in ticks)
    assert _no_two_ticks_without_a_sleep(events), events


async def test_the_loop_ticks_at_the_interval_it_is_given(pool, monkeypatch):
    events: list = []
    fake_tick, fake_sleep = _recording(events, stop_after_sleeps=2)
    monkeypatch.setattr(wall_probe, "tick", fake_tick)

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(wall_probe.loop(app, pool, every=7, sleep=fake_sleep), LOOP_BOUND_S)

    assert [e[1] for e in events if e[0] == "sleep"] == [7, 7]
    assert sum(1 for e in events if e[0] == "tick") >= 1


# ── c4: a tick that raises is logged and the loop lives on; cancel ends it ─


async def test_a_tick_that_raises_is_logged_and_the_loop_ticks_again(pool, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    calls: list = []

    async def failing_once(app_, pool_):
        await asyncio.sleep(0)
        calls.append(len(calls))
        if len(calls) == 1:
            raise RuntimeError("boom: the ledger was unreachable")

    sleeps: list = []

    async def fake_sleep(seconds):
        await asyncio.sleep(0)
        sleeps.append(seconds)
        if len(sleeps) >= 3:
            raise asyncio.CancelledError

    monkeypatch.setattr(wall_probe, "tick", failing_once)

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(wall_probe.loop(app, pool, every=1, sleep=fake_sleep), LOOP_BOUND_S)

    assert len(calls) >= 2, calls  # it ticked again after the failure
    logged = [
        r
        for r in caplog.records
        if r.levelno >= logging.ERROR
        and r.exc_info
        and isinstance(r.exc_info[1], RuntimeError)
        and "boom" in str(r.exc_info[1])
    ]
    assert logged, [(r.levelname, r.getMessage()) for r in caplog.records]


async def test_a_cancelled_tick_ends_the_loop_and_is_not_swallowed(pool, monkeypatch):
    calls: list = []

    async def cancelled(app_, pool_):
        await asyncio.sleep(0)
        calls.append(1)
        raise asyncio.CancelledError

    async def fake_sleep(seconds):
        # A loop that sleeps after a cancelled tick swallowed the cancel.
        # Failing HERE (outside the loop's try) ends even a loop that catches
        # BaseException, so the mutant fails instead of spinning: a wait_for
        # timeout lands in the tick as often as in the sleep, and a swallowed
        # timeout-cancel would hang wait_for itself.
        await asyncio.sleep(0)
        raise AssertionError("the loop slept after a cancelled tick: the cancel was swallowed")

    monkeypatch.setattr(wall_probe, "tick", cancelled)

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(wall_probe.loop(app, pool, every=1, sleep=fake_sleep), LOOP_BOUND_S)

    assert calls == [1]


# ── c5: lifespan starts the loop once the pool is up, cancels it on exit ───


async def test_lifespan_runs_the_probe_loop_on_its_pool_and_cancels_it_before_closing_it(
    pool, monkeypatch
):
    from app import main

    async def no_migrations(dsn, directory):
        return None

    monkeypatch.setattr(main, "run_migrations", no_migrations)
    started = asyncio.Event()
    seen: dict = {}

    async def fake_loop(app_, pool_, **kwargs):
        seen["app"], seen["pool"] = app_, pool_
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            seen["pool_closing_at_cancel"] = pool_.is_closing()
            raise

    monkeypatch.setattr(wall_probe, "loop", fake_loop)

    async def start_and_shut_down():
        async with main.lifespan(app):
            await asyncio.wait_for(started.wait(), 2)
            assert seen["app"] is app
            assert seen["pool"] is pool  # the pool lifespan brought up
            assert "pool_closing_at_cancel" not in seen  # running, not cancelled

    # Bounded WITHOUT cancelling: a timeout-cancel of a shutdown stuck on
    # `await probing` would cancel the loop itself and let a lifespan that
    # never cancels it pass. So wait, and a shutdown still running after the
    # bound FAILS (then is cancelled, which frees the stuck task).
    lifecycle = asyncio.create_task(start_and_shut_down())
    done, _ = await asyncio.wait({lifecycle}, timeout=LOOP_BOUND_S)
    if not done:
        lifecycle.cancel()
        await asyncio.wait({lifecycle}, timeout=LOOP_BOUND_S)
        pytest.fail("lifespan shutdown never finished: the probe loop was not cancelled")
    await lifecycle  # re-raise an assertion from inside the lifespan

    # Shutdown cancelled the loop and waited for it, before the pool closed.
    assert seen.get("pool_closing_at_cancel") is False


# ══ T6: what a probe's outcome does to the wall ═══════════════════════════

KEY = ("openrouter", routing.WHOLE_PROVIDER)


async def _walled_openrouter(client, pool, mount_backend, *, refused_ago_s=2 * 3600):
    """OpenRouter still out of credit, walled by a 402 refused
    `refused_ago_s` ago (strike 1), so the wall is due a probe."""
    fake = await _cloud(
        client,
        mount_backend,
        "openrouter",
        BASE,
        FakeOpenAICompat(accepts_key="sk-1", affords_tokens=0),
    )
    await _walled_for_credits(pool, "openrouter", refused_ago_s=refused_ago_s)
    return fake


async def _wall_row(pool, provider="openrouter", model=routing.WHOLE_PROVIDER):
    return await pool.fetchrow(
        "SELECT status, strikes, reason, walled_until, updated_at, probed_at "
        "FROM provider_walls WHERE provider = $1 AND model = $2",
        provider,
        model,
    )


async def _wall_keys(pool) -> set[tuple[str, str]]:
    return {
        (r["provider"], r["model"])
        for r in await pool.fetch("SELECT provider, model FROM provider_walls")
    }


# ── c1: served -> the wall lifts (note_success), and the log says so ──────


async def test_a_probe_the_provider_served_lifts_the_wall_and_says_so(
    client, pool, mount_backend, caplog
):
    fake = await _walled_openrouter(client, pool, mount_backend)
    # Outage walls on the probed model and on a sibling: a served probe is
    # evidence about the provider and the model it served, not the sibling.
    await _stored_wall(pool, "openrouter", 502, refused_ago_s=60, model="remote-model")
    await _stored_wall(pool, "openrouter", 502, refused_ago_s=60, model="sibling-model")
    fake.affords_tokens = 1  # topped up: one token is served
    caplog.set_level(logging.INFO)

    await wall_probe.tick(app, pool)

    assert len(_completion_posts(fake)) == 1
    assert await _wall_keys(pool) == {("openrouter", "sibling-model")}
    assert KEY not in await routing.walls(pool)
    lifted = [
        r
        for r in caplog.records
        if r.levelno == logging.INFO
        and "wall lifted by probe" in r.getMessage()
        and "openrouter" in r.getMessage()
    ]
    assert lifted, [(r.levelname, r.getMessage()) for r in caplog.records]


# ── c2: refused with a wall status -> a refusal: strike, longer wall, new time


async def test_a_probe_refused_for_credits_records_a_refusal_on_the_wall(
    client, pool, mount_backend
):
    await _walled_openrouter(client, pool, mount_backend)
    old = await _wall_row(pool)
    assert old["strikes"] == 1
    before = await pool.fetchval("SELECT now()")

    await wall_probe.tick(app, pool)

    after = await pool.fetchval("SELECT now()")
    new = await _wall_row(pool)
    assert new["status"] == 402
    assert new["strikes"] == 2
    assert new["reason"].startswith("openrouter refused (402): "), new["reason"]
    # The refusal time is the probe's: the wall no longer reads 2 h old.
    assert before <= new["updated_at"] <= after, (before, new["updated_at"], after)
    # Strike 2 of the ladder (6 h), counted from the probe's refusal.
    assert abs((new["walled_until"] - new["updated_at"]).total_seconds() - 6 * 3600) < 5
    words = routing.walled_words((await routing.walls(pool))[KEY])
    at = new["updated_at"].astimezone(UTC).strftime("%m-%d %H:%M")
    assert f"refused at {at} UTC; not retried since — walled for another " in words, words
    assert "last probed" not in words, words


# ── c3: any other failure -> the wall stands untouched, probed_at says when


def _connect_fails(mount_backend, mount_transport, fake):
    mount_transport(BASE, FailingTransport(httpx.ConnectError))


def _answers_500(mount_backend, mount_transport, fake):
    fake.completions_status = 500


def _answers_200_not_a_completion(mount_backend, mount_transport, fake):
    mount_backend(BASE, _answers_200({"choices": []}, []))


@pytest.mark.parametrize(
    "failure",
    [_connect_fails, _answers_500, _answers_200_not_a_completion],
    ids=["connect-failure", "5xx", "200-not-a-completion"],
)
async def test_a_probe_that_failed_otherwise_leaves_the_wall_and_says_when_it_probed(
    client, pool, mount_backend, mount_transport, failure
):
    fake = await _walled_openrouter(client, pool, mount_backend)
    old = await _wall_row(pool)
    failure(mount_backend, mount_transport, fake)

    await wall_probe.tick(app, pool)

    new = await _wall_row(pool)
    for field in ("status", "strikes", "reason", "walled_until", "updated_at"):
        assert new[field] == old[field], (field, old[field], new[field])
    assert await _wall_keys(pool) == {KEY}  # no outage wall was added either
    assert new["probed_at"] is not None
    words = routing.walled_words((await routing.walls(pool))[KEY])
    refused = old["updated_at"].astimezone(UTC).strftime("%m-%d %H:%M")
    probed = new["probed_at"].astimezone(UTC).strftime("%m-%d %H:%M")
    assert (
        f"refused at {refused} UTC; last probed at {probed} UTC, not served — walled for another "
        in words
    ), words
    assert "not retried since" not in words, words


# ── c4: walls() carries probed_at; the words say "last probed" only when the
#        probe came after the latest refusal ─────────────────────────────────


async def test_walls_carry_each_walls_last_probe_time(pool):
    await _stored_wall(pool, "openrouter", 402, refused_ago_s=3 * 3600, probed_ago_s=600)
    await _stored_wall(pool, "never", 402, refused_ago_s=3 * 3600)
    stored = await pool.fetchval(
        "SELECT probed_at FROM provider_walls WHERE provider = 'openrouter'"
    )

    got = await routing.walls(pool)

    assert "probed_at" in got[KEY], sorted(got[KEY])
    assert got[KEY]["probed_at"] == stored
    assert got[("never", routing.WHOLE_PROVIDER)]["probed_at"] is None


def test_the_walled_words_say_when_it_was_last_probed_after_the_refusal():
    now = datetime(2026, 10, 14, 9, 30, tzinfo=UTC)
    wall = {
        "reason": "openrouter refused (402): Insufficient credits",
        "refused_at": datetime(2026, 10, 13, 17, 59, 24, tzinfo=UTC),
        "probed_at": datetime(2026, 10, 14, 9, 12, 59, tzinfo=UTC),
        "walled_until": datetime(2026, 10, 14, 17, 59, 24, tzinfo=UTC),
    }

    assert routing.walled_words(wall, now=now) == (
        "openrouter refused (402): Insufficient credits — refused at 10-13 17:59 UTC; "
        "last probed at 10-14 09:12 UTC, not served — walled for another 510 min"
    )
    # A probe BEFORE the latest refusal (a real turn refused since) is not
    # the latest word: the refusal is, and nothing has retried since.
    earlier = {**wall, "probed_at": datetime(2026, 10, 13, 16, 0, tzinfo=UTC)}
    assert "; not retried since — " in routing.walled_words(earlier, now=now)
    never = {**wall, "probed_at": None}
    assert "; not retried since — " in routing.walled_words(never, now=now)


# ── c5: a probe that made no call never stamps probed_at ──────────────────


async def test_a_probe_that_made_no_call_leaves_the_wall_never_probed(client, pool, mount_backend):
    fake = await _cloud(
        client, mount_backend, "openrouter", BASE, FakeOpenAICompat(accepts_key="sk-1")
    )
    row = await providers.get_row(pool, "openrouter")
    await routing.record_refusal(pool, row, 402, CREDITS)  # no refusal on the ledger
    await pool.execute(
        "UPDATE provider_walls SET updated_at = now() - make_interval(secs => 7200.0)"
    )

    await wall_probe.tick(app, pool)

    assert _completion_posts(fake) == []
    assert (await _wall_row(pool))["probed_at"] is None
    words = routing.walled_words((await routing.walls(pool))[KEY])
    assert "; not retried since — " in words, words


# ── c2 (COVERAGE): the refusal's wall reason quotes the probe's own sentence


async def test_a_refused_probe_walls_with_the_providers_own_refusal_sentence(
    client, pool, mount_backend
):
    await _walled_openrouter(client, pool, mount_backend)

    await wall_probe.tick(app, pool)

    reason = (await _wall_row(pool))["reason"]
    # The body's error message, as a turn's refusal is quoted — not empty,
    # not the raw "HTTP 402: {...}" JSON head.
    assert reason.startswith(
        "openrouter refused (402): This request requires more credits, or fewer max_tokens. "
        "You requested up to 1 tokens, but can only afford 0."
    ), reason


# ══ T9: an engine's wall is never probed ═══════════════════════════════════
#
# Same rule as data_plane's note_success: a completion never lifts an
# engine's wall (it lapses on its own ladder), so the probe — whose served
# outcome IS note_success — never probes one. Which rows are engines is
# engines.is_engine(row), read off the row; the engine below is a second
# machine (not builtin, not named "hub"), so no name decides it.

ENGINE = "dell"
ENGINE_BASE = "http://dell.test"
ENGINE_MODEL = "qwen3:8b"


async def _engine_row(pool, name=ENGINE):
    """Another machine's engine: an ollama-adapter provider row (a linked
    engine carries its link token, providers_engine_link_has_token)."""
    await pool.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key) "
        "VALUES ($1, 'ollama', $2, 'static-bearer', 'link-1') ON CONFLICT (name) DO NOTHING",
        name,
        ENGINE_BASE,
    )
    row = await providers.get_row(pool, name)
    assert engines.is_engine(row) and not row["builtin"]
    return row


async def _engine_walled_for_credits(pool, mount_backend) -> FakeOllama:
    """The engine walled by a real stored 402 refused 2 h ago, with that 402
    on the ledger — by status, age and ledger alone the wall would be due and
    probe_wall would call it (FakeOllama serves a 1-token completion)."""
    fake = FakeOllama(tags=(ENGINE_MODEL,))
    mount_backend(ENGINE_BASE, fake.app)
    row = await _engine_row(pool)
    await routing.record_refusal(pool, row, 402, CREDITS, model=ENGINE_MODEL)
    await _ledger(pool, ENGINE, ENGINE_MODEL, ago_s=2 * 3600)
    await pool.execute(
        "UPDATE provider_walls SET updated_at = now() - make_interval(secs => 7200) "
        "WHERE provider = $1",
        ENGINE,
    )
    fake.seen.clear()
    return fake


# ── c1: an engine's credit wall is never due; a cloud one still is ────────


async def test_an_engines_credit_wall_is_never_due_and_a_cloud_ones_still_is(pool):
    await _engine_row(pool)
    await _stored_wall(pool, ENGINE, 402, refused_ago_s=2 * 3600)
    await _stored_wall(pool, "openrouter", 402, refused_ago_s=2 * 3600)

    assert await _due(pool) == {("openrouter", routing.WHOLE_PROVIDER)}


# ── c2: a tick makes no call and no ledger row for an engine's wall ───────


async def test_a_tick_never_calls_an_engine_and_leaves_its_wall_as_it_stands(
    client, pool, mount_backend
):
    engine = await _engine_walled_for_credits(pool, mount_backend)
    cloud = await _walled_openrouter(client, pool, mount_backend)
    before = await _wall_row(pool, provider=ENGINE)

    await wall_probe.tick(app, pool)

    assert _completion_posts(engine) == []
    assert engine.seen == []
    # The cloud's credit wall is still probed, in the same tick.
    assert len(_completion_posts(cloud)) == 1
    assert [r["provider"] for r in await _probe_rows(pool)] == ["openrouter"]
    # The engine's wall stands untouched: not lifted, not stamped.
    assert await _wall_row(pool, provider=ENGINE) == before
    assert before["probed_at"] is None
    assert (ENGINE, routing.WHOLE_PROVIDER) in await routing.walls(pool)


# ── c3: the rule is engines.is_engine(row), read at call time ─────────────


async def test_which_wall_is_an_engines_is_decided_by_engines_is_engine(pool, monkeypatch):
    await _engine_row(pool)
    await _stored_wall(pool, ENGINE, 402, refused_ago_s=2 * 3600)
    await _stored_wall(pool, "openrouter", 402, refused_ago_s=2 * 3600)

    monkeypatch.setattr(engines, "is_engine", lambda row: False)
    assert await _due(pool) == {
        (ENGINE, routing.WHOLE_PROVIDER),
        ("openrouter", routing.WHOLE_PROVIDER),
    }

    monkeypatch.setattr(engines, "is_engine", lambda row: row["name"] == "openrouter")
    assert await _due(pool) == {(ENGINE, routing.WHOLE_PROVIDER)}
