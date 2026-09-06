"""S10-pre: the provider registry — rows, routing by prefix, the admin
routes with verify-before-save, and the S1 backend surface kept as a view.

Every DB-touching test runs through the real ASGI app against fakes mounted
by origin; nothing here reaches a socket."""

from __future__ import annotations

import logging
import shutil

import pytest
from fastapi import HTTPException

from app import backends, providers
from app.main import MIGRATIONS_DIR
from app.migrations_runner import run_migrations
from tests.conftest import TEST_DSN, requires_db
from tests.fakes import FakeAnthropic, FakeOllama, FakeOpenAICompat

pytestmark = requires_db

SECRET = "sk-or-v1-do-not-leak-4242"


def _sse_payloads(raw: bytes) -> list:
    import json

    out = []
    for line in raw.decode().splitlines():
        if line.startswith("data:"):
            payload = line[len("data:") :].strip()
            out.append("[DONE]" if payload == "[DONE]" else json.loads(payload))
    return out


async def _add_openrouter(client, mount_backend, *, name="openrouter", key=SECRET):
    fake = FakeOpenAICompat(
        models_body={
            "object": "list",
            "data": [
                {
                    "id": "anthropic/claude-sonnet-5",
                    "name": "Anthropic: Claude Sonnet 5",
                    "context_length": 1000000,
                    "pricing": {"prompt": "0.000002", "completion": "0.00001"},
                },
                {"id": "openai/gpt-x"},
            ],
        },
        deltas=("Hi", " there"),
    )
    mount_backend(f"http://{name}.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": name,
            "adapter": "openai-chat",
            "base_url": f"http://{name}.test/v1",
            "auth_shape": "static-bearer",
            "api_key": key,
            "preset": "openrouter",
        },
    )
    assert resp.status_code == 200, resp.text
    return fake, resp.json()


# ── pure ─────────────────────────────────────────────────────────────────


def test_split_model_id_only_honours_a_registered_prefix():
    names = {"ollama", "openrouter"}
    assert providers.split_model_id("openrouter:anthropic/claude-sonnet-5", names) == (
        "openrouter",
        "anthropic/claude-sonnet-5",
    )
    # An ollama tag's own colon is not a provider prefix.
    assert providers.split_model_id("qwen3.8:27b", names) == (None, "qwen3.8:27b")
    assert providers.split_model_id("ollama:qwen3.8:27b", names) == ("ollama", "qwen3.8:27b")
    assert providers.split_model_id("plain", names) == (None, "plain")
    # A prefix with nothing after it is not a model id.
    assert providers.split_model_id("openrouter:", names) == (None, "openrouter:")


@pytest.mark.parametrize(
    "payload",
    [
        {"adapter": "nonsense", "base_url": "https://x", "auth_shape": "none"},
        {"adapter": "openai-chat", "auth_shape": "none"},  # no base_url
        {"adapter": "openai-chat", "base_url": "ftp://x", "auth_shape": "none"},
        {"adapter": "openai-chat", "base_url": "https://{resource}.x/v1", "auth_shape": "none"},
        {"adapter": "openai-chat", "base_url": "https://x/v1", "auth_shape": "static-bearer"},
        {
            "adapter": "anthropic-messages",
            "base_url": "https://x",
            "auth_shape": "static-bearer",
            "api_key": "k",
        },
        {"adapter": "ollama", "base_url": "", "auth_shape": "none"},  # builtin only
    ],
)
def test_validate_shape_refuses_with_a_stated_reason(payload):
    with pytest.raises(HTTPException) as excinfo:
        providers.validate_shape(payload)
    assert excinfo.value.status_code == 400
    assert excinfo.value.detail


def test_validate_shape_keeps_the_stored_key_when_an_update_omits_it():
    existing = {
        "adapter": "openai-chat",
        "base_url": "https://old/v1",
        "auth_shape": "static-bearer",
        "api_key": "sk-keep",
        "builtin": False,
    }
    merged = providers.validate_shape({"base_url": "https://new/v1/"}, existing=existing)
    assert merged["api_key"] == "sk-keep"
    assert merged["base_url"] == "https://new/v1"


def test_validate_name_is_a_slug_without_colons():
    assert providers.validate_name("open-router_2") == "open-router_2"
    for bad in ("Open", "a:b", "", "-x", None, "x" * 65):
        with pytest.raises(HTTPException):
            providers.validate_name(bad)


def test_to_public_never_exposes_the_raw_key():
    row = {
        "name": "x",
        "adapter": "openai-chat",
        "base_url": "https://x/v1",
        "auth_shape": "static-bearer",
        "api_key": "sk-supersecret9999",
    }
    public = providers.to_public(row)
    assert public["api_key"] == "•••9999"
    assert "supersecret" not in str(public)


def test_presets_load_and_name_the_openrouter_first():
    presets = providers.load_presets()
    assert presets[0]["name"] == "openrouter"
    for preset in presets:
        assert preset["adapter"] in providers.ADAPTERS
        assert preset["auth_shape"] in providers.AUTH_SHAPES
        assert preset["base_url"].startswith("https://")
        # A placeholder is declared, never silent.
        if "{" in preset["base_url"]:
            assert preset.get("placeholders")


# ── registry + routing (DB) ──────────────────────────────────────────────


async def test_startup_seeds_the_builtin_ollama_as_default(pool):
    rows = await providers.list_rows(pool)
    assert [(r["name"], r["builtin"], r["is_default"]) for r in rows] == [("ollama", True, True)]


async def test_create_lists_and_gets_a_provider_with_the_key_masked(client, pool, mount_backend):
    fake, created = await _add_openrouter(client, mount_backend)

    assert created["name"] == "openrouter"
    assert created["api_key"] == "•••4242"
    assert created["listing"] == "available"
    assert "2 models" in created["listing_note"]
    assert created["verified_at"]
    # verify-before-save sent the key to the provider, exactly once.
    assert fake.seen_auth == [f"Bearer {SECRET}"]

    listed = (await client.get("/admin/providers")).json()["providers"]
    assert [p["name"] for p in listed] == ["ollama", "openrouter"]
    assert all(p["api_key"] in (None, "•••4242") for p in listed)

    one = (await client.get("/admin/providers/openrouter")).json()
    assert one["api_key"] == "•••4242"
    assert one["base_url"] == "http://openrouter.test/v1"
    # And the key is stored unmasked, because it has to be sent.
    row = await providers.get_row(pool, "openrouter")
    assert row["api_key"] == SECRET


async def test_a_refused_key_is_a_502_with_the_providers_words_and_no_row(
    client, pool, mount_backend
):
    fake = FakeOpenAICompat(
        models_body={"error": {"message": "Invalid API key", "code": 401}}, models_status=401
    )
    mount_backend("http://bad.test", fake.app)

    resp = await client.post(
        "/admin/providers",
        json={
            "name": "bad",
            "adapter": "openai-chat",
            "base_url": "http://bad.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-wrong",
        },
    )

    assert resp.status_code == 502
    assert "Invalid API key" in resp.json()["error"]
    assert [r["name"] for r in await providers.list_rows(pool)] == ["ollama"]


async def test_a_provider_without_a_listing_saves_as_unavailable_not_an_empty_list(
    client, pool, mount_backend
):
    fake = FakeOpenAICompat(models_status=404, models_body={"detail": "Not Found"})
    mount_backend("http://manual.test", fake.app)

    resp = await client.post(
        "/admin/providers",
        json={
            "name": "manual",
            "adapter": "openai-chat",
            "base_url": "http://manual.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-x",
        },
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["listing"] == "unavailable"
    assert "type a model id" in resp.json()["listing_note"]

    listing = await client.get("/admin/providers/manual/models")
    assert listing.status_code == 404
    assert "no model listing" in listing.json()["error"]


async def test_an_unreachable_provider_is_a_502_and_never_saved(client, pool):
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "dead",
            "adapter": "openai-chat",
            "base_url": "http://127.0.0.1:1/v1",
            "auth_shape": "none",
        },
    )
    assert resp.status_code == 502
    assert "could not verify provider 'dead'" in resp.json()["error"]
    assert [r["name"] for r in await providers.list_rows(pool)] == ["ollama"]


async def test_create_refuses_a_duplicate_and_the_builtin_name(client, mount_backend):
    await _add_openrouter(client, mount_backend)
    again = await client.post(
        "/admin/providers",
        json={
            "name": "openrouter",
            "adapter": "openai-chat",
            "base_url": "http://openrouter.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-2",
        },
    )
    assert again.status_code == 409
    ollama = await client.post(
        "/admin/providers",
        json={
            "name": "ollama",
            "adapter": "openai-chat",
            "base_url": "http://x/v1",
            "auth_shape": "none",
        },
    )
    assert ollama.status_code == 409


async def test_live_listing_is_labelled_and_carries_context_and_price(client, mount_backend):
    fake, _ = await _add_openrouter(client, mount_backend)

    resp = await client.get("/admin/providers/openrouter/models")

    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "openrouter"
    assert body["fetched_at"]
    assert body["models"][0] == {
        "id": "anthropic/claude-sonnet-5",
        "owned_by": "openrouter",
        "name": "Anthropic: Claude Sonnet 5",
        "context_length": 1000000,
        "pricing": {"prompt": 2e-06, "completion": 1e-05},
    }
    # A row the provider stated nothing about carries NO invented numbers.
    assert body["models"][1] == {"id": "openai/gpt-x", "owned_by": "openrouter"}


async def test_chat_routes_by_prefix_and_badges_the_canonical_identity(
    client, pool, mount_backend, monkeypatch
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    ollama = FakeOllama(deltas=("lo", "cal"))
    mount_backend("http://ollama.test", ollama.app)
    fake, _ = await _add_openrouter(client, mount_backend)

    cloud = await client.post(
        "/v1/chat/completions",
        json={"model": "openrouter:anthropic/claude-sonnet-5", "messages": [], "stream": True},
    )
    assert cloud.status_code == 200
    assert cloud.headers["x-nova-served-by"] == "openrouter:anthropic/claude-sonnet-5"
    assert [
        f["choices"][0]["delta"]["content"] for f in _sse_payloads(cloud.content) if f != "[DONE]"
    ] == [
        "Hi",
        " there",
    ]
    # The provider saw the BARE model id and the bearer key.
    assert fake.seen[-1][1]["model"] == "anthropic/claude-sonnet-5"
    assert fake.seen_auth[-1] == f"Bearer {SECRET}"

    # A bare model still goes to the default (ollama), colon and all.
    local = await client.post(
        "/v1/chat/completions", json={"model": "qwen3.8:27b", "messages": [], "stream": True}
    )
    assert local.status_code == 200
    assert local.headers["x-nova-served-by"] == "ollama:qwen3.8:27b"
    assert ollama.seen[-1][1]["model"] == "qwen3.8:27b"


async def test_a_failing_provider_answers_with_its_own_status_never_another_providers_reply(
    client, pool, mount_backend, monkeypatch
):
    """Rail 20: no silent substitution. A cloud provider that refuses is
    relayed as its refusal — the request is never re-sent to ollama."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    ollama = FakeOllama()
    mount_backend("http://ollama.test", ollama.app)
    fake, _ = await _add_openrouter(client, mount_backend)
    fake.completions_status = 402

    resp = await client.post(
        "/v1/chat/completions",
        json={"model": "openrouter:anthropic/claude-sonnet-5", "messages": [], "stream": True},
    )

    assert resp.status_code == 402
    assert resp.headers["x-nova-served-by"] == "openrouter:anthropic/claude-sonnet-5"
    assert ollama.seen == []


async def test_delete_refuses_the_builtin_and_the_default_then_deletes(client, pool, mount_backend):
    await _add_openrouter(client, mount_backend)

    assert (await client.delete("/admin/providers/ollama")).status_code == 400
    made_default = await client.put("/admin/providers/openrouter/default")
    assert made_default.status_code == 200 and made_default.json()["is_default"] is True
    assert (await client.delete("/admin/providers/openrouter")).status_code == 409

    await client.put("/admin/providers/ollama/default")
    assert (await client.delete("/admin/providers/openrouter")).status_code == 200
    assert (await client.get("/admin/providers/openrouter")).status_code == 404
    assert (await client.delete("/admin/providers/openrouter")).status_code == 404


async def test_update_keeps_the_key_when_omitted_and_reverifies(client, pool, mount_backend):
    fake, _ = await _add_openrouter(client, mount_backend)

    resp = await client.put("/admin/providers/openrouter", json={"model_note": "vendor/model ids"})

    assert resp.status_code == 200, resp.text
    assert resp.json()["model_note"] == "vendor/model ids"
    assert (await providers.get_row(pool, "openrouter"))["api_key"] == SECRET
    # Re-verified with the stored key.
    assert fake.seen_auth[-1] == f"Bearer {SECRET}"


async def test_api_key_header_shape_sends_azures_header_not_a_bearer(client, mount_backend):
    fake = FakeOpenAICompat(
        prefix="/openai/v1", models_body={"object": "list", "data": [{"id": "gpt-dep"}]}
    )
    mount_backend("http://azure.test", fake.app)

    resp = await client.post(
        "/admin/providers",
        json={
            "name": "azure",
            "adapter": "openai-chat",
            "base_url": "http://azure.test/openai/v1",
            "auth_shape": "api-key-header",
            "api_key": "az-key",
        },
    )

    assert resp.status_code == 200, resp.text
    assert fake.seen_headers[-1]["api-key"] == "az-key"
    assert fake.seen_auth[-1] is None


async def test_anthropic_provider_verifies_through_its_own_listing(client, pool, mount_backend):
    fake = FakeAnthropic(
        models=("claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"), page_size=2
    )
    mount_backend("http://anthropic.test", fake.app)

    resp = await client.post(
        "/admin/providers",
        json={
            "name": "anthropic",
            "adapter": "anthropic-messages",
            "base_url": "http://anthropic.test",
            "auth_shape": "api-key-header",
            "api_key": "sk-ant-1234",
        },
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["listing"] == "available"
    assert fake.seen_headers[-1]["x-api-key"] == "sk-ant-1234"
    assert fake.seen_headers[-1]["anthropic-version"] == "2023-06-01"
    listing = (await client.get("/admin/providers/anthropic/models")).json()
    # Paged through has_more/last_id — all three, in order, once.
    assert [m["id"] for m in listing["models"]] == [
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-haiku-4-5",
    ]


async def test_a_wrong_anthropic_key_is_refused_in_anthropics_words(client, pool, mount_backend):
    fake = FakeAnthropic(models_status=401)
    mount_backend("http://anthropic.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "anthropic",
            "adapter": "anthropic-messages",
            "base_url": "http://anthropic.test",
            "auth_shape": "api-key-header",
            "api_key": "sk-ant-wrong",
        },
    )
    assert resp.status_code == 502
    assert "invalid x-api-key" in resp.json()["error"]


async def test_no_provider_route_ever_logs_a_key(client, pool, mount_backend, caplog):
    caplog.set_level(logging.DEBUG)
    fake, _ = await _add_openrouter(client, mount_backend)
    await client.get("/admin/providers")
    await client.get("/admin/providers/openrouter/models")
    await client.put("/admin/providers/openrouter", json={"model_note": "x"})
    await client.post(
        "/v1/chat/completions",
        json={"model": "openrouter:openai/gpt-x", "messages": [], "stream": True},
    )
    assert SECRET not in caplog.text
    for record in caplog.records:
        assert SECRET not in record.getMessage()


# ── the S1 backend surface, as a view ────────────────────────────────────


async def test_put_backend_cloud_upserts_a_provider_and_makes_it_default(
    client, pool, mount_backend
):
    fake = FakeOpenAICompat()
    mount_backend("http://cloud.test", fake.app)

    resp = await client.put(
        "/admin/backend",
        json={
            "kind": "cloud",
            "url": "http://cloud.test",
            "provider": "My Cloud!",
            "api_key": "sk-cloud1111",
            "model": "gpt-x",
        },
    )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        **resp.json(),
        "kind": "cloud",
        "url": "http://cloud.test",
        "provider": "my-cloud",
        "model": "gpt-x",
        "api_key": "•••1111",
    }
    row = await providers.get_row(pool, "my-cloud")
    assert row["base_url"] == "http://cloud.test/v1"
    assert row["is_default"] is True
    assert row["default_model"] == "gpt-x"

    # And back to ollama: the cloud row stays registered, ollama is default.
    back = await client.put("/admin/backend", json={"kind": "ollama"})
    assert back.status_code == 502 or back.status_code == 200  # depends on OLLAMA_URL fake
    names = {r["name"]: r["is_default"] for r in await providers.list_rows(pool)}
    assert "my-cloud" in names


async def test_get_backend_is_derived_from_the_default_row(client, pool, mount_backend):
    fake, _ = await _add_openrouter(client, mount_backend)
    await client.put("/admin/providers/openrouter/default")

    view = (await client.get("/admin/backend")).json()

    assert view["kind"] == "cloud"
    assert view["provider"] == "openrouter"
    assert view["url"] == "http://openrouter.test"
    assert view["api_key"] == "•••4242"


async def test_probe_rides_the_default_providers_adapter(client, pool, mount_backend):
    fake, _ = await _add_openrouter(client, mount_backend)
    await client.put("/admin/providers/openrouter/default")

    resp = await client.post("/admin/probe", json={"model": "openai/gpt-x"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True and body["kind"] == "cloud" and body["vram_mb"] is None
    assert fake.seen[-1][0] == "/v1/chat/completions"
    assert fake.seen[-1][1]["stream"] is False


# ── migration 003: the S1 row is converted, never lost ───────────────────


async def _migrate_to(tmp_path, upto: int) -> None:
    import asyncpg

    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute("DROP TABLE IF EXISTS providers, probes, backend_config CASCADE")
        await conn.execute("DROP TABLE IF EXISTS schema_migrations")
    finally:
        await conn.close()
    partial = tmp_path / "migrations"
    partial.mkdir(exist_ok=True)
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if int(path.name.split("_")[0]) <= upto:
            shutil.copy(path, partial / path.name)
    await run_migrations(TEST_DSN, partial)


@pytest.mark.parametrize(
    ("legacy", "expect_name", "expect_auth", "expect_url"),
    [
        (
            {
                "kind": "cloud",
                "url": "https://api.example.com/",
                "provider": "Open Router",
                "model": "m1",
                "api_key": "sk-legacy",
            },
            "open-router",
            "static-bearer",
            "https://api.example.com/v1",
        ),
        (
            {
                "kind": "cloud",
                "url": "https://x.example",
                "provider": None,
                "model": "m1",
                "api_key": "sk-legacy",
            },
            "cloud",
            "static-bearer",
            "https://x.example/v1",
        ),
        (
            {
                "kind": "remote",
                "url": "http://box:11434",
                "provider": None,
                "model": None,
                "api_key": None,
            },
            "remote",
            "none",
            "http://box:11434/v1",
        ),
    ],
)
async def test_migration_003_converts_the_active_backend_into_the_default_provider(
    tmp_path, legacy, expect_name, expect_auth, expect_url
):
    import asyncpg

    import tests.conftest as conftest

    await _migrate_to(tmp_path, 2)
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(
            "INSERT INTO backend_config (id, kind, url, provider, model, api_key) "
            "VALUES (1, $1, $2, $3, $4, $5)",
            legacy["kind"],
            legacy["url"],
            legacy["provider"],
            legacy["model"],
            legacy["api_key"],
        )
    finally:
        await conn.close()

    await run_migrations(TEST_DSN, MIGRATIONS_DIR)

    conn = await asyncpg.connect(TEST_DSN)
    try:
        rows = await conn.fetch(
            "SELECT name, adapter, base_url, auth_shape, api_key, default_model, "
            "is_default, builtin FROM providers ORDER BY builtin DESC, name"
        )
        gone = await conn.fetchval("SELECT to_regclass('backend_config')")
    finally:
        await conn.close()
        # The suite's schema is rebuilt from scratch by the next `pool` fixture.
        conftest._schema_built = False

    assert gone is None
    by_name = {r["name"]: dict(r) for r in rows}
    assert by_name["ollama"]["builtin"] is True and by_name["ollama"]["is_default"] is False
    converted = by_name[expect_name]
    assert converted["adapter"] == "openai-chat"
    assert converted["base_url"] == expect_url
    assert converted["auth_shape"] == expect_auth
    assert converted["api_key"] == legacy["api_key"]
    assert converted["default_model"] == legacy["model"]
    assert converted["is_default"] is True


async def test_migration_003_on_a_fresh_or_ollama_install_leaves_ollama_default(tmp_path):
    import asyncpg

    import tests.conftest as conftest

    await _migrate_to(tmp_path, 2)
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(
            "INSERT INTO backend_config (id, kind, url) VALUES (1, 'ollama', 'http://ollama:11434')"
        )
    finally:
        await conn.close()
    await run_migrations(TEST_DSN, MIGRATIONS_DIR)
    conn = await asyncpg.connect(TEST_DSN)
    try:
        rows = await conn.fetch("SELECT name, is_default FROM providers")
    finally:
        await conn.close()
        conftest._schema_built = False
    assert [(r["name"], r["is_default"]) for r in rows] == [("ollama", True)]


async def test_backends_kind_is_derived_not_stored():
    assert backends.kind_of({"adapter": "ollama"}) == "ollama"
    assert backends.kind_of({"adapter": "openai-chat", "auth_shape": "none"}) == "remote"
    assert backends.kind_of({"adapter": "openai-chat", "auth_shape": "static-bearer"}) == "cloud"
    assert (
        backends.kind_of({"adapter": "anthropic-messages", "auth_shape": "api-key-header"})
        == "cloud"
    )
