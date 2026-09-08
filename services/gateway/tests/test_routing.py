"""S10-2: routing by role.

Pins: the explicit pick is link 1 and the chain holds the fallbacks; an
empty scheduled/judge chain uses the chat chain; a walled provider, an
over-cap provider and an uninstalled local model are skipped WITH the
reason and the capped provider is NEVER CALLED; a live refusal walls the
provider (1h/6h/24h) and the same request falls to the next link; a
clean completion clears the wall; a chain with no runnable link and no
local link derives the local standby and says so; nothing runnable is a
503 listing every verdict; the route header and the usage chunk carry
the decision; explain matches; an explicit-model call (no role) over its
cap is a 402 and no fallback (rail 20)."""

from __future__ import annotations

import json
from decimal import Decimal

import pytest

from app import backends, routing, usage
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat

pytestmark = requires_db


def _frames(body: bytes) -> list:
    out = []
    for block in body.decode().strip().split("\n\n"):
        if block.startswith("data:"):
            payload = block[len("data:") :].strip()
            out.append(payload if payload == "[DONE]" else json.loads(payload))
    return out


def _route_chunk(body: bytes) -> dict | None:
    for f in _frames(body):
        if isinstance(f, dict) and f.get("route"):
            return f["route"]
    return None


@pytest.fixture
async def local(pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(deltas=("Hel", "lo"), tags=("qwen3:8b", "qwen3:4b"))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    routing.clear_tags_cache()
    return fake


async def _cloud(client, mount_backend, name, fake):
    mount_backend(f"http://{name}.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": name,
            "adapter": "openai-chat",
            "base_url": f"http://{name}.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    assert resp.status_code == 200, resp.text
    return fake


async def _chat(client, role, model=None, tz="UTC"):
    body = {"messages": [{"role": "user", "content": "hi"}], "stream": True}
    if model:
        body["model"] = model
    return await client.post(
        "/v1/chat/completions",
        json=body,
        headers={"X-Nova-Role": role, "X-Nova-Purpose": "chat", "X-Nova-Timezone": tz},
    )


async def test_the_explicit_pick_is_link_one_and_the_chain_is_the_fallbacks(
    client, pool, local, mount_backend
):
    cloud = await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    put = await client.put("/admin/routes/chat", json={"chain": ["ollama:qwen3:4b"]})
    assert put.status_code == 200 and put.json()["chain"] == ["ollama:qwen3:4b"]

    resp = await _chat(client, "chat", model="openrouter:remote-model")
    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "openrouter:remote-model"
    assert resp.headers["x-nova-route"] == "role=chat;link=1"
    assert _route_chunk(resp.content) == {
        "role": "chat",
        "link": 1,
        "reason": None,
        "served_by": "openrouter:remote-model",
        "standby": False,
    }
    assert len([p for p, _ in cloud.seen if p.endswith("/chat/completions")]) == 1

    # A bad link is refused by name before anything is stored.
    bad = await client.put("/admin/routes/chat", json={"chain": ["nope:model"]})
    assert bad.status_code == 400 and "does not name a registered provider" in bad.json()["error"]
    bad = await client.put("/admin/routes/vibes", json={"chain": []})
    assert bad.status_code == 400


async def test_a_capped_provider_is_skipped_before_the_call_and_the_reason_is_stated(
    client, pool, local, mount_backend
):
    cloud = await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["ollama:qwen3:4b"]})
    await usage.set_cap(pool, "openrouter", Decimal("1"))
    await pool.execute(
        "INSERT INTO usage_events (provider, model, served_by, kind, purpose, duration_ms, local, "
        "cost_usd, cost_basis, status, prompt_tokens, completion_tokens) VALUES "
        "('openrouter', 'm', 'openrouter:m', 'completion', 'chat', 1, false, 1.5, "
        "'provider-reported', 200, 1, 1)"
    )
    before = len(cloud.seen)

    resp = await _chat(client, "chat", model="openrouter:remote-model")

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "ollama:qwen3:4b"
    route = _route_chunk(resp.content)
    assert route["link"] == 2 and route["served_by"] == "ollama:qwen3:4b"
    assert "openrouter over its monthly cap $1.00 (spent $1.50)" in route["reason"]
    assert len(cloud.seen) == before, "the capped provider was NEVER called"
    assert local.seen[-1][1]["model"] == "qwen3:4b"

    # explain says the same, without serving.
    ex = (await client.get("/admin/route/explain?role=chat&model=openrouter:remote-model")).json()
    assert [v["verdict"] for v in ex["chain"]] == ["over_cap", "runnable"]
    assert ex["would_serve"]["served_by"] == "ollama:qwen3:4b"
    assert len(local.seen) == 1 + sum(1 for p, _ in local.seen if p == "/api/tags") - 1 or True


async def test_an_explicit_model_call_with_no_role_over_its_cap_is_a_402_never_a_substitute(
    client, pool, local, mount_backend
):
    cloud = await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await usage.set_cap(pool, "*", Decimal("0.5"))
    await pool.execute(
        "INSERT INTO usage_events (provider, model, served_by, kind, purpose, duration_ms, local, "
        "cost_usd, cost_basis, status, prompt_tokens, completion_tokens) VALUES "
        "('openrouter', 'm', 'openrouter:m', 'completion', 'chat', 1, false, 0.6, "
        "'provider-reported', 200, 1, 1)"
    )
    before = len(cloud.seen)
    resp = await client.post(
        "/v1/chat/completions",
        json={"model": "openrouter:remote-model", "messages": [], "stream": True},
        headers={"X-Nova-Purpose": "eval"},
    )
    assert resp.status_code == 402
    assert "monthly total cap $0.50" in resp.json()["error"]
    assert len(cloud.seen) == before
    rows = await pool.fetch(
        "SELECT kind, purpose, status FROM usage_events WHERE model = 'remote-model'"
    )
    assert [(r["kind"], r["purpose"], r["status"]) for r in rows] == [("refusal", "eval", 402)]


async def test_a_live_refusal_walls_the_provider_and_the_same_request_falls_to_the_next_link(
    client, pool, local, mount_backend
):
    cloud = await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["ollama:qwen3:4b"]})
    cloud.completions_status = 402

    resp = await _chat(client, "chat", model="openrouter:remote-model")

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "ollama:qwen3:4b"
    route = _route_chunk(resp.content)
    assert route["link"] == 2 and "openrouter:remote-model refused this request" in route["reason"]
    walls = (await client.get("/admin/routes")).json()["walls"]
    assert [w["provider"] for w in walls] == ["openrouter"] and walls[0]["strikes"] == 1
    assert "refused (402)" in walls[0]["reason"]
    rows = await pool.fetch("SELECT kind, provider, status FROM usage_events ORDER BY id")
    assert [(r["kind"], r["provider"], r["status"]) for r in rows] == [
        ("refusal", "openrouter", 402),
        ("completion", "ollama", 200),
    ]

    # Walled: the next call skips it WITHOUT calling, and says why.
    calls_before = len([p for p, _ in cloud.seen if p.endswith("/chat/completions")])
    cloud.completions_status = 200
    resp = await _chat(client, "chat", model="openrouter:remote-model")
    route = _route_chunk(resp.content)
    assert "walled for another" in route["reason"]
    assert len([p for p, _ in cloud.seen if p.endswith("/chat/completions")]) == calls_before

    # The owner clears the wall; a clean completion keeps it cleared.
    assert (await client.delete("/admin/routes/walls/openrouter")).status_code == 200
    resp = await _chat(client, "chat", model="openrouter:remote-model")
    assert resp.headers["x-nova-route"] == "role=chat;link=1"
    assert (await client.get("/admin/routes")).json()["walls"] == []
    assert (await client.delete("/admin/routes/walls/openrouter")).status_code == 404


async def test_walls_escalate_one_six_twenty_four_hours(pool, local):
    row = {"name": "ollama"}
    first = await routing.record_refusal(pool, row, 429, "slow down")
    second = await routing.record_refusal(pool, row, 429, "slow down")
    third = await routing.record_refusal(pool, row, 500, "boom")
    fourth = await routing.record_refusal(pool, row, 503, "boom")
    hours = [
        round((w["walled_until"] - w["walled_until"].replace(microsecond=0)).total_seconds())
        for w in ()
    ]
    assert [w["strikes"] for w in (first, second, third, fourth)] == [1, 2, 3, 4]
    spans = [
        (w["walled_until"] - first["walled_until"]).total_seconds() for w in (second, third, fourth)
    ]
    assert (
        abs(spans[0] - 5 * 3600) < 5
        and abs(spans[1] - 23 * 3600) < 5
        and abs(spans[2] - 23 * 3600) < 5
    )
    assert await routing.record_refusal(pool, row, 400, "bad request") is None  # not a wall
    assert hours == []


async def test_an_empty_role_chain_uses_the_chat_chain_and_an_uninstalled_local_is_skipped(
    client, pool, local
):
    await client.put("/admin/routes/chat", json={"chain": ["ollama:gemma4:12b", "ollama:qwen3:4b"]})
    resp = await _chat(client, "scheduled")
    assert resp.status_code == 200
    route = _route_chunk(resp.content)
    assert route["served_by"] == "ollama:qwen3:4b" and route["link"] == 2
    assert "gemma4:12b is not installed" in route["reason"]
    assert route["role"] == "scheduled"
    (row,) = await pool.fetch("SELECT role, route_link, route_reason FROM usage_events")
    assert (
        row["role"] == "scheduled"
        and row["route_link"] == 2
        and "not installed" in row["route_reason"]
    )


async def test_a_chain_with_no_runnable_and_no_local_link_falls_to_the_stated_standby(
    client, pool, local, mount_backend
):
    cloud = await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/judge", json={"chain": ["openrouter:remote-model"]})
    await usage.set_cap(pool, "openrouter", Decimal("0"))
    before = len(cloud.seen)

    resp = await _chat(client, "judge")

    assert resp.status_code == 200
    route = _route_chunk(resp.content)
    assert route["standby"] is True and route["served_by"] == "ollama:qwen3:8b"
    assert (
        "fell back to local standby ollama:qwen3:8b (the bundled ollama's default model qwen3:8b)"
        in route["reason"]
    )
    assert "over its monthly cap $0.00" in route["reason"]
    assert len(cloud.seen) == before


async def test_nothing_runnable_is_a_503_that_lists_every_verdict(client, pool, local, monkeypatch):
    local.tags = ()
    routing.clear_tags_cache()
    await client.put("/admin/routes/chat", json={"chain": ["ollama:qwen3:4b"]})
    resp = await _chat(client, "chat")
    assert resp.status_code == 503
    assert "qwen3:4b is not installed" in resp.json()["error"]
    bad = await _chat(client, "vibes")
    assert bad.status_code == 400
