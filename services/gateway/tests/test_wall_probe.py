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
