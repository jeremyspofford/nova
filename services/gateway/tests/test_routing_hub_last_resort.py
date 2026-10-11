"""The hub last resort (epic hub-last-resort, T1): an opt-in, default-OFF
fallback to the hub engine's own derived chat model when every link of a
chat-protocol chain AND the cross-tier standby fail.

The shape is turn de0baf27 (2026-10-10): both Dell links unreachable (the
Dell asleep) and OpenRouter walled on a 402. The Dell links are local, so
the cross-tier standby never runs and the turn 503s. Core states the owner's
switch per call in `X-Nova-Hub-Last-Resort: 1` (anything else is off); the
gateway reads none of core's settings.

Pins: OFF (absent, '0', 'true') is today's 503 byte for byte and the hub is
never asked to chat; ON serves the hub's derived chat model, marked
`last_resort` on the route header and the route chunk; ON with the hub
switched off or unreachable is the 503 stating that the hub could not help;
ON with a chain that serves never touches the hub; a hub link the chain
already refused is never dialled again; systemone ignores the flag; the
existing standby still wins when the chain has no local link; explain takes
`?hub_last_resort=1`."""

from __future__ import annotations

import json
from decimal import Decimal

import httpx
import pytest

from app import backends, engines, routing, usage
from tests.conftest import requires_db
from tests.fakes import FailingTransport, FakeOllama, FakeOpenAICompat

pytestmark = requires_db

HEADER = "X-Nova-Hub-Last-Resort"
OPENROUTER = "openrouter:google/gemini-3.8-flash"
DE0BAF27_CHAIN = ["dell:qwen3.8:27b", OPENROUTER]
HUB_CANNOT = "the hub last resort is on but the hub has no chat model to serve"


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
async def hub(pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(deltas=("Hel", "lo"), tags=("qwen3:8b", "qwen3:4b"))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    engines.clear_cache()
    return fake


@pytest.fixture
async def de0baf27(client, pool, hub, mount_backend, mount_transport):
    """The Dell asleep (its engine never answers) and OpenRouter walled on a
    402; chat.model is dell:qwen3:8b, the chain the 27B then OpenRouter."""
    asleep = FailingTransport(httpx.ConnectTimeout)
    mount_transport("http://dell.test", asleep)
    await pool.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key, builtin, local, "
        "is_default) VALUES ('dell', 'ollama', 'http://dell.test', 'static-bearer', "
        "'dell-token', false, true, false)"
    )
    await pool.execute("INSERT INTO engines (provider) VALUES ('dell') ON CONFLICT DO NOTHING")
    mount_backend("http://openrouter.test", FakeOpenAICompat(accepts_key="sk-1").app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "openrouter",
            "adapter": "openai-chat",
            "base_url": "http://openrouter.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    assert resp.status_code == 200, resp.text
    put = await client.put("/admin/routes/chat", json={"chain": DE0BAF27_CHAIN})
    assert put.status_code == 200, put.text
    await routing.record_refusal(
        pool, {"name": "openrouter"}, 402, "out of credits", model="google/gemini-3.8-flash"
    )
    engines.clear_cache()
    return asleep


async def _chat(client, *, flag: str | None = None, role: str = "chat", model="dell:qwen3:8b"):
    headers = {"X-Nova-Role": role, "X-Nova-Purpose": "chat", "X-Nova-Timezone": "UTC"}
    if flag is not None:
        headers[HEADER] = flag
    body = {"messages": [{"role": "user", "content": "hi"}], "stream": True}
    if model:
        body["model"] = model
    return await client.post("/v1/chat/completions", json=body, headers=headers)


def _hub_chats(fake) -> list[str]:
    return [b["model"] for p, b in fake.seen if p == "/v1/chat/completions"]


async def _resolve(pool, role, requested, **kw):
    from app import admin
    from app.main import app

    return await routing.resolve(
        app,
        pool,
        role=role,
        requested=requested,
        timezone="UTC",
        fit_context=admin._fit_context,
        latest_probes=admin._latest_probes,
        **kw,
    )


# ── OFF is today ───────────────────────────────────────────────────────────


async def test_off_is_todays_503_byte_for_byte_and_the_hub_never_chats(client, pool, hub, de0baf27):
    with pytest.raises(routing.NothingRunnable) as caught:
        await _resolve(pool, "chat", "dell:qwen3:8b")
    today = (
        str(caught.value)
        + " — "
        + "; ".join(f"{v['id']}: {v['reason']}" for v in caught.value.verdicts)
    )
    assert today.startswith("no model in the 'chat' chain can serve right now — dell:qwen3:8b: ")
    assert HUB_CANNOT not in today and "last resort" not in today

    for flag in (None, "0", "true", "yes", ""):
        resp = await _chat(client, flag=flag)
        assert resp.status_code == 503, (flag, resp.text)
        assert resp.json()["error"] == today, flag
    assert _hub_chats(hub) == []


async def test_resolve_defaults_the_flag_off(client, pool, hub, de0baf27):
    with pytest.raises(routing.NothingRunnable) as off:
        await _resolve(pool, "chat", "dell:qwen3:8b", hub_last_resort=False)
    with pytest.raises(routing.NothingRunnable) as absent:
        await _resolve(pool, "chat", "dell:qwen3:8b")
    assert str(off.value) == str(absent.value)
    assert off.value.verdicts == absent.value.verdicts
    assert [v["id"] for v in off.value.verdicts] == ["dell:qwen3:8b", *DE0BAF27_CHAIN]


# ── ON serves the hub, stated ──────────────────────────────────────────────


async def test_on_serves_the_hubs_derived_chat_model_marked_last_resort(
    client, pool, hub, de0baf27
):
    resp = await _chat(client, flag="1")

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:8b"
    route_header = resp.headers["x-nova-route"]
    assert "role=chat" in route_header and "link=4" in route_header
    assert "last_resort=1" in route_header.split(";")
    route = _route_chunk(resp.content)
    assert route["served_by"] == "hub:qwen3:8b"
    assert route["last_resort"] is True and route["standby"] is True
    assert route["link"] == 4
    assert route["reason"].startswith(
        "fell back to the hub's own model hub:qwen3:8b (hub's default model qwen3:8b; "
        "last resort, CPU-only, slower) — "
    )
    assert "dell:qwen3:8b: " in route["reason"] and "out of credits" in route["reason"]
    assert _hub_chats(hub) == ["qwen3:8b"]


async def test_on_decision_carries_a_last_resort_verdict(client, pool, hub, de0baf27):
    decision = await _resolve(pool, "chat", "dell:qwen3:8b", hub_last_resort=True)

    assert decision.last_resort is True and decision.standby is True
    assert (decision.row["name"], decision.model, decision.link) == ("hub", "qwen3:8b", 4)
    last = decision.verdicts[-1]
    assert last["id"] == "hub:qwen3:8b" and last["verdict"] == "runnable"
    assert last["last_resort"] is True and last["link"] == 4
    assert decision.as_route()["last_resort"] is True
    assert "last_resort=1" in decision.header().split(";")


async def test_the_model_is_derived_never_hardcoded(client, pool, hub, de0baf27):
    """The hub's model is read off the hub engine's own config at call time —
    the standby's derivation, never a name kept here: change the hub's
    default and the last resort follows it."""
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:4b"})
    engines.clear_cache()

    decision = await _resolve(pool, "chat", "dell:qwen3:8b", hub_last_resort=True)

    assert decision.model == "qwen3:4b"
    assert "(hub's default model qwen3:4b; last resort" in decision.reason


# ── ON but the hub cannot help ─────────────────────────────────────────────


async def test_on_with_the_hub_switched_off_is_the_503_stating_the_hub_could_not_help(
    client, pool, hub, de0baf27
):
    await engines.set_serving(pool, "hub", False)

    resp = await _chat(client, flag="1")

    assert resp.status_code == 503
    error = resp.json()["error"]
    assert error.startswith(f"no model in the 'chat' chain can serve right now — {HUB_CANNOT} (")
    assert "switched off" in error
    assert "out of credits" in error
    assert _hub_chats(hub) == []


async def test_on_with_the_hub_engine_down_is_the_503_naming_the_hub(
    client, pool, hub, de0baf27, mount_transport
):
    mount_transport("http://ollama.test", FailingTransport(httpx.ConnectError))
    engines.clear_cache()

    resp = await _chat(client, flag="1")

    assert resp.status_code == 503
    error = resp.json()["error"]
    assert f"{HUB_CANNOT} (" in error
    assert "hub" in error.split(HUB_CANNOT, 1)[1]


async def test_on_with_a_hub_that_refuses_is_tried_once_and_the_503_says_why(
    client, pool, hub, de0baf27, mount_transport
):
    refused = FailingTransport(httpx.ConnectError)
    mount_transport("http://ollama.test/v1", refused)

    resp = await _chat(client, flag="1")

    assert resp.status_code == 503
    error = resp.json()["error"]
    assert "hub:qwen3:8b: last resort: could not reach hub" in error
    assert refused.requests == [("POST", "/v1/chat/completions")]


# ── ON never changes a walk that serves ────────────────────────────────────


async def test_on_with_a_chain_that_serves_never_touches_the_hub(client, pool, hub, mount_backend):
    mount_backend("http://openrouter.test", FakeOpenAICompat(accepts_key="sk-1").app)
    await client.post(
        "/admin/providers",
        json={
            "name": "openrouter",
            "adapter": "openai-chat",
            "base_url": "http://openrouter.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    await client.put("/admin/routes/chat", json={"chain": [OPENROUTER]})

    off = await _chat(client, flag=None, model=None)
    assert off.status_code == 200
    seen_off = list(hub.seen)
    hub.seen.clear()
    resp = await _chat(client, flag="1", model=None)

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == OPENROUTER
    assert resp.headers["x-nova-route"] == "role=chat;link=1"
    assert _route_chunk(resp.content)["last_resort"] is False
    # Nothing the hub is asked with the switch on that it was not asked with
    # it off (its listing, once) — and it is never asked to show or to chat.
    assert set(hub.seen) <= set(seen_off)
    assert not [p for p, _ in hub.seen if p in ("/api/show", "/v1/chat/completions")]


async def test_a_hub_link_the_chain_already_refused_is_not_served_again(client, pool, hub):
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:8b"]})

    with pytest.raises(routing.NothingRunnable) as caught:
        await _resolve(pool, "chat", None, hub_last_resort=True, skip={"hub:qwen3:8b"})

    verdicts = caught.value.verdicts
    assert verdicts[0]["id"] == "hub:qwen3:8b" and verdicts[0]["verdict"] == "refused"
    last = verdicts[-1]
    assert last["id"] == "hub:qwen3:8b" and last["verdict"] == "refused"
    assert last["reason"] == "last resort: hub:qwen3:8b refused this request"
    assert last.get("last_resort") is True


async def test_the_existing_standby_still_wins_when_the_chain_has_no_local_link(
    client, pool, hub, mount_backend
):
    mount_backend("http://openrouter.test", FakeOpenAICompat(accepts_key="sk-1").app)
    await client.post(
        "/admin/providers",
        json={
            "name": "openrouter",
            "adapter": "openai-chat",
            "base_url": "http://openrouter.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    await client.put("/admin/routes/chat", json={"chain": [OPENROUTER]})
    await usage.set_cap(pool, "openrouter", Decimal("0"))

    decision = await _resolve(pool, "chat", None, hub_last_resort=True)

    assert decision.standby is True and decision.last_resort is False
    assert decision.reason.startswith("fell back to local standby hub:qwen3:8b")
    assert not any(v.get("last_resort") for v in decision.verdicts)


async def test_systemone_ignores_the_flag(client, pool, hub):
    await pool.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, local) "
        "VALUES ('dell-kev', 'systemone', 'http://kev.test/v1', 'none', true)"
    )
    await client.put("/admin/routes/decisions", json={"chain": ["dell-kev:kev-latest"]})
    await routing.record_refusal(pool, {"name": "dell-kev"}, 402, "nope", model="kev-latest")

    with pytest.raises(routing.NothingRunnable) as on:
        await _resolve(pool, "decisions", None, hub_last_resort=True)
    with pytest.raises(routing.NothingRunnable) as off:
        await _resolve(pool, "decisions", None)
    assert str(on.value) == str(off.value) and on.value.verdicts == off.value.verdicts


# ── explain ────────────────────────────────────────────────────────────────


async def test_explain_takes_the_flag_as_a_query_parameter(client, pool, hub, de0baf27):
    off = await client.get(
        "/admin/route/explain", params={"role": "chat", "model": "dell:qwen3:8b"}
    )
    assert off.status_code == 200 and off.json()["would_serve"] is None
    for flag in ("0", "true"):
        same = await client.get(
            "/admin/route/explain",
            params={"role": "chat", "model": "dell:qwen3:8b", "hub_last_resort": flag},
        )
        assert same.json()["would_serve"] is None, flag

    on = await client.get(
        "/admin/route/explain",
        params={"role": "chat", "model": "dell:qwen3:8b", "hub_last_resort": "1"},
    )
    assert on.status_code == 200
    body = on.json()
    assert body["would_serve"]["served_by"] == "hub:qwen3:8b"
    assert body["would_serve"]["last_resort"] is True
    assert "last resort, CPU-only, slower" in body["reason"]
    assert _hub_chats(hub) == []


# ── a hub this request already ruled out is never dialled again ────────────


async def test_a_walled_hub_model_is_judged_walled_and_never_dialled(client, pool, hub, de0baf27):
    """The hub's derived model under an outage wall (a 503 on it): the last
    resort states the wall and does not ask the hub to chat."""
    await routing.record_refusal(
        pool, {"name": "hub"}, 503, "hub engine fell over", model="qwen3:8b"
    )

    with pytest.raises(routing.NothingRunnable) as caught:
        await _resolve(pool, "chat", "dell:qwen3:8b", hub_last_resort=True)
    last = caught.value.verdicts[-1]
    assert (last["id"], last["verdict"]) == ("hub:qwen3:8b", "walled")
    assert last["last_resort"] is True
    assert last["reason"].startswith("last resort: ")

    resp = await _chat(client, flag="1")
    assert resp.status_code == 503, resp.text
    assert "hub:qwen3:8b: last resort: " in resp.json()["error"]
    assert _hub_chats(hub) == []


async def test_a_hub_model_passed_over_this_request_is_not_dialled_again(
    client, pool, hub, de0baf27
):
    with pytest.raises(routing.NothingRunnable) as caught:
        await _resolve(
            pool,
            "chat",
            "dell:qwen3:8b",
            hub_last_resort=True,
            passed_over={"hub:qwen3:8b": "too slow for this turn"},
        )
    last = caught.value.verdicts[-1]
    assert (last["id"], last["verdict"]) == ("hub:qwen3:8b", "passed_over")
    assert last["reason"] == "last resort: passed over: too slow for this turn"
    assert last["last_resort"] is True


async def test_a_hub_the_standby_already_tried_is_not_judged_again(
    client, pool, hub, mount_backend
):
    """No local link: the cross-tier standby picks the hub; it refused this
    request, so its verdict stands and the last resort adds none of its own."""
    mount_backend("http://openrouter.test", FakeOpenAICompat(accepts_key="sk-1").app)
    await client.post(
        "/admin/providers",
        json={
            "name": "openrouter",
            "adapter": "openai-chat",
            "base_url": "http://openrouter.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    await client.put("/admin/routes/chat", json={"chain": [OPENROUTER]})
    await usage.set_cap(pool, "openrouter", Decimal("0"))

    with pytest.raises(routing.NothingRunnable) as on:
        await _resolve(pool, "chat", None, hub_last_resort=True, skip={"hub:qwen3:8b"})
    with pytest.raises(routing.NothingRunnable) as off:
        await _resolve(pool, "chat", None, skip={"hub:qwen3:8b"})

    hub_verdicts = [v for v in on.value.verdicts if v["id"] == "hub:qwen3:8b"]
    assert len(hub_verdicts) == 1
    assert hub_verdicts[0]["reason"] == "standby: hub:qwen3:8b refused this request"
    assert not any(v.get("last_resort") for v in on.value.verdicts)
    assert on.value.verdicts == off.value.verdicts
    assert str(on.value) == str(off.value)
