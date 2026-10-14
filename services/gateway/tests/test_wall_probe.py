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
