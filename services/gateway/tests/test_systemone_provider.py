"""A decision-model server as a provider (decision-role spec §1): the
`systemone` adapter — a base URL and an optional key, no chat — and a `local`
the owner sets, so a Kev box on his own machine is free and uncapped."""

from __future__ import annotations

import asyncpg
import pytest

from app import providers
from app.adapters import ProviderRefused, systemone
from app.main import MIGRATIONS_DIR
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat
from tests.test_routing import _route_chunk

pytestmark = requires_db

# What a Kev server's GET /v1/models answers (kev/serve.py: one TypeSafe model
# card per name it accepts).
KEV_MODELS = {
    "models": [
        {
            "name": "kev-latest",
            "description": "Kev pointer head on Qwen3.5-4B",
            "release_date": "2026-09-20",
        },
        {"name": "jev-latest", "description": "Kev pointer head on Qwen3.5-4B"},
    ]
}


@pytest.fixture(autouse=True)
def local_tags(monkeypatch, mount_backend):
    """Creating a provider checks its name against the bundled engine's tags,
    so every test here has an ollama that answers (test_providers' fixture)."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(tags=("qwen3:8b",))
    mount_backend("http://ollama.test", fake.app)
    return fake


async def _add_kev(client, mount_backend, *, accepts_key=None, **over):
    fake = FakeOpenAICompat(models_body=KEV_MODELS, accepts_key=accepts_key)
    mount_backend("http://kev.test", fake.app)
    payload = {
        "name": "dell-kev",
        "adapter": "systemone",
        "base_url": "http://kev.test/v1",
        "auth_shape": "none",
        "local": True,
        **over,
    }
    return fake, await client.post("/admin/providers", json=payload)


async def test_a_decision_model_server_is_a_local_provider_listing_decision_models(
    client, pool, mount_backend
):
    _fake, resp = await _add_kev(client, mount_backend)

    assert resp.status_code == 200, resp.text
    row = resp.json()
    assert (row["adapter"], row["local"], row["listing"]) == ("systemone", True, "available")
    assert row["verify_note"] == "2 decision models listed"
    listing = (await client.get("/admin/providers/dell-kev/models")).json()
    assert [m["id"] for m in listing["models"]] == ["kev-latest", "jev-latest"]
    assert all(m["output_modalities"] == ["decisions"] for m in listing["models"])
    assert listing["models"][0]["description"] == "Kev pointer head on Qwen3.5-4B"


async def test_a_decision_model_server_has_no_chat_and_says_so(client, pool, mount_backend):
    fake, _ = await _add_kev(client, mount_backend)

    resp = await client.post(
        "/v1/chat/completions",
        json={
            "model": "dell-kev:kev-latest",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
    )

    assert resp.status_code == 400
    assert resp.json()["error"] == (
        "dell-kev is a decision-model server (systemone): it answers typed questions at "
        "POST /v1/systemone and has no chat"
    )
    assert not [p for p, _ in fake.seen if p.endswith("/chat/completions")]


async def test_a_decision_server_as_the_chat_pick_is_passed_over_with_its_reason(
    client, pool, mount_backend
):
    """Review focus 2, at the gateway. A Kev link written into chat.model (a
    misclick on a model list) must not end every chat turn: the walk passes
    over it, says why, and the next link answers."""
    await _add_kev(client, mount_backend)
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:8b"]})

    resp = await client.post(
        "/v1/chat/completions",
        json={
            "model": "dell-kev:kev-latest",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
        headers={"X-Nova-Role": "chat", "X-Nova-Purpose": "chat"},
    )

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:8b"
    route = _route_chunk(resp.content)
    assert route["link"] == 2
    assert (
        "dell-kev:kev-latest: dell-kev answers typed questions — this role needs chat"
        in route["reason"]
    )


async def test_a_keyed_decision_server_proves_its_key_by_refusing_a_wrong_one(
    client, pool, mount_backend
):
    _fake, resp = await _add_kev(
        client,
        mount_backend,
        accepts_key="kev-secret",
        auth_shape="static-bearer",
        api_key="kev-secret",
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["key_proven"] is True
    assert resp.json()["verify_note"] == "2 decision models listed; the listing accepted the key"


async def test_a_decision_server_authenticates_with_a_bearer_key_or_none(
    client, pool, mount_backend
):
    _fake, resp = await _add_kev(client, mount_backend, auth_shape="api-key-header", api_key="k")

    assert resp.status_code == 400
    assert resp.json()["error"] == (
        "a systemone server authenticates with a bearer key or none — "
        "auth_shape must be static-bearer or none"
    )


async def test_local_is_the_owners_to_set_and_an_engine_is_always_local(
    client, pool, mount_backend
):
    fake = FakeOpenAICompat(models_body={"object": "list", "data": [{"id": "qwen3:8b"}]})
    mount_backend("http://lanbox.test", fake.app)
    created = await client.post(
        "/admin/providers",
        json={
            "name": "lanbox",
            "adapter": "openai-chat",
            "base_url": "http://lanbox.test/v1",
            "auth_shape": "none",
            "local": True,
        },
    )
    assert created.status_code == 200, created.text
    assert created.json()["local"] is True

    off = await client.put("/admin/providers/lanbox", json={"local": False})
    assert off.status_code == 200 and off.json()["local"] is False
    kept = await client.put("/admin/providers/lanbox", json={})
    assert kept.json()["local"] is False, "an update that omits local keeps it"
    bad = await client.put("/admin/providers/lanbox", json={"local": "yes"})
    assert bad.status_code == 400 and bad.json()["error"] == "local must be true or false"
    engine = providers.validate_shape(
        {"adapter": "ollama", "auth_shape": "none", "local": False}, existing={"builtin": True}
    )
    assert engine["local"] is True, "an engine runs on a machine here, whatever is sent"


def test_both_listing_shapes_read_as_decision_models():
    assert systemone.normalize_models(KEV_MODELS, owned_by="dell-kev")[1] == {
        "id": "jev-latest",
        "owned_by": "dell-kev",
        "output_modalities": ["decisions"],
        "description": "Kev pointer head on Qwen3.5-4B",
    }
    assert systemone.normalize_models({"data": [{"id": "kev-4b"}]}, owned_by="x") == [
        {"id": "kev-4b", "owned_by": "x", "output_modalities": ["decisions"]}
    ]
    with pytest.raises(ProviderRefused):
        systemone.normalize_models({"nothing": []}, owned_by="x")


def test_the_kev_preset_is_a_local_decision_server_on_the_owners_host():
    kev = {preset["name"]: preset for preset in providers.load_presets()}["kev"]
    assert (kev["adapter"], kev["auth_shape"], kev["local"]) == ("systemone", "none", True)
    assert kev["base_url"] == "http://{host}:8009/v1"
    assert kev["placeholders"] == ["host"]


async def test_the_adapter_check_admits_systemone_and_still_refuses_the_unknown(pool):
    await pool.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, local) "
        "VALUES ('kevbox', 'systemone', 'http://kev.test/v1', 'none', true)"
    )
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute(
            "INSERT INTO providers (name, adapter, base_url, auth_shape) "
            "VALUES ('bogus', 'bogus', 'http://x.test', 'none')"
        )
    # Idempotent, like every migration beside it (007's rule): it runs over itself.
    await pool.execute((MIGRATIONS_DIR / "010_systemone_adapter.sql").read_text())
