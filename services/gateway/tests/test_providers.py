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


@pytest.fixture(autouse=True)
def local_tags(monkeypatch, mount_backend):
    """Creating a provider checks its name against the tags the bundled
    ollama lists (a name that is a tag's prefix would hijack the tag), so
    every test here has an ollama that answers. Returned so a test can put
    a specific tag in it."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(tags=("qwen3:8b", "qwen3.8:27b"))
    mount_backend("http://ollama.test", fake.app)
    return fake


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
        # A listing that NEEDS the key — the public-listing case (the real
        # OpenRouter) has its own tests below.
        accepts_key=key,
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
    # A prefix with nothing after it names the provider and no model — handed
    # back as such so resolve() refuses it instead of routing elsewhere.
    assert providers.split_model_id("openrouter:", names) == ("openrouter", "")


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
    # verify-before-save sent the real key to the provider once, then a key
    # that is certainly wrong to learn whether the listing is public — and
    # this fake's listing is not, so no completion probe followed.
    assert fake.seen_auth == [f"Bearer {SECRET}", "Bearer nova-verify-this-key-is-wrong"]
    assert not any(path == "/v1/chat/completions" for path, _ in fake.seen)

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
    client, pool, mount_backend, local_tags
):
    ollama = local_tags
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
    client, pool, mount_backend, local_tags
):
    """Rail 20: no silent substitution. A cloud provider that refuses is
    relayed as its refusal — the request is never re-sent to ollama."""
    ollama = local_tags
    ollama.seen.clear()
    fake, _ = await _add_openrouter(client, mount_backend)
    fake.completions_status = 402

    resp = await client.post(
        "/v1/chat/completions",
        json={"model": "openrouter:anthropic/claude-sonnet-5", "messages": [], "stream": True},
    )

    assert resp.status_code == 402
    assert resp.headers["x-nova-served-by"] == "openrouter:anthropic/claude-sonnet-5"
    # ollama saw the name check's /api/tags read at create time and nothing
    # else — never this turn's completion.
    assert [path for path, _ in ollama.seen if path != "/api/tags"] == []


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
    # Re-verified with the stored key (once at create, once now).
    assert fake.seen_auth.count(f"Bearer {SECRET}") == 2

    # An EMPTY update is the page's Re-verify: nothing changes but the
    # verdict, which is re-proven and re-stored.
    empty = await client.put("/admin/providers/openrouter", json={})
    assert empty.status_code == 200, empty.text
    assert empty.json()["key_proven"] is True
    assert "accepted the key" in empty.json()["verify_note"]
    assert fake.seen_auth.count(f"Bearer {SECRET}") == 3


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
    assert back.status_code == 200, back.text
    names = {r["name"]: r["is_default"] for r in await providers.list_rows(pool)}
    assert names == {"ollama": True, "my-cloud": False}


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


# ── the key must be PROVEN, not just the listing reached ─────────────────


async def test_a_public_listing_does_not_prove_the_key_so_a_completion_does(
    client, pool, mount_backend
):
    """OpenRouter's /models is public: a wrong key still lists 431 models.
    A save that read that as "verified" would land a row whose first turn
    401s (rail 5). The proof is a 1-token completion on the cheapest PRICED
    model in the listing (first listed when nothing is priced), through the
    same adapter a turn uses — and the verdict is a structured key_proven,
    never prose a page has to parse."""
    fake = FakeOpenAICompat(
        models_body={
            "object": "list",
            "data": [
                # OpenRouter's router rows publish -1 ("varies"): not a price,
                # and the auto-router is the one place a probe must not go.
                {"id": "openrouter/auto", "pricing": {"prompt": "-1", "completion": "-1"}},
                # A free variant at 0 is not a price to rank by either.
                {"id": "free/model:free", "pricing": {"prompt": "0", "completion": "0"}},
                {
                    "id": "openai/gpt-flagship",
                    "pricing": {"prompt": "0.00001", "completion": "0.00005"},
                },
                # Cheapest prompt, dearest completion — sum is NOT the minimum.
                {
                    "id": "cheap-prompt/model",
                    "pricing": {"prompt": "0.00000005", "completion": "0.00002"},
                },
                {
                    "id": "openai/gpt-x",
                    "pricing": {"prompt": "0.0000001", "completion": "0.0000004"},
                },
                # Cheapest completion, but no prompt price: not fully priced.
                {"id": "half/priced", "pricing": {"completion": "0.0000001"}},
                {"id": "unpriced/model"},
            ],
        },
        models_public=True,
        accepts_key="sk-or-right",
    )
    mount_backend("http://public.test", fake.app)
    body = {
        "name": "public",
        "adapter": "openai-chat",
        "base_url": "http://public.test/v1",
        "auth_shape": "static-bearer",
        "api_key": "sk-or-WRONG",
    }

    wrong = await client.post("/admin/providers", json=body)

    assert wrong.status_code == 502
    assert "refused on a test completion" in wrong.json()["error"]
    assert "User not found" in wrong.json()["error"]
    assert [r["name"] for r in await providers.list_rows(pool)] == ["ollama"]

    right = await client.post("/admin/providers", json={**body, "api_key": "sk-or-right"})

    assert right.status_code == 200, right.text
    # The probe spends its token on the CHEAPEST fully-priced model by
    # prompt+completion — not the first listed, not the -1 router, not the
    # free row, not the cheapest-by-one-field row.
    body = right.json()
    assert body["key_proven"] is True
    assert "proven with a 1-token completion on openai/gpt-x" in body["verify_note"]
    probe = [b for path, b in fake.seen if path == "/v1/chat/completions"][-1]
    assert probe["max_tokens"] == 1 and probe["model"] == "openai/gpt-x"


async def test_a_public_listing_with_an_unproven_key_says_so_on_the_row(
    client, pool, mount_backend
):
    fake = FakeOpenAICompat(
        models_body={"object": "list", "data": [{"id": "m"}]},
        models_public=True,
        completions_status=402,
    )
    mount_backend("http://broke.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "broke",
            "adapter": "openai-chat",
            "base_url": "http://broke.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-x",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["key_proven"] is False
    assert "NOT proven" in resp.json()["verify_note"]
    assert "402" in resp.json()["verify_note"]


async def test_a_listing_that_needs_the_key_proves_it_without_a_completion(
    client, pool, mount_backend
):
    fake = FakeOpenAICompat(
        models_body={"object": "list", "data": [{"id": "m"}]}, accepts_key="sk-strict"
    )
    mount_backend("http://strict.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "strict",
            "adapter": "openai-chat",
            "base_url": "http://strict.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-strict",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["key_proven"] is True
    assert "the listing accepted the key" in resp.json()["verify_note"]
    assert not any(path == "/v1/chat/completions" for path, _ in fake.seen)


# ── names, prefixes, and what a bare id means ────────────────────────────


async def test_a_name_that_is_a_local_tags_prefix_is_refused(
    client, pool, mount_backend, local_tags
):
    local_tags.tags = ("mistral:7b", "qwen3:8b")
    fake = FakeOpenAICompat()
    mount_backend("http://mistral.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "mistral",
            "adapter": "openai-chat",
            "base_url": "http://mistral.test/v1",
            "auth_shape": "none",
        },
    )
    assert resp.status_code == 409
    assert "mistral:7b" in resp.json()["error"]
    # Refused BEFORE any verify round-trip reached the provider.
    assert fake.seen == []


async def test_an_unreadable_local_listing_refuses_the_name_check_loudly(
    client, pool, mount_backend, local_tags, monkeypatch
):
    monkeypatch.setenv("OLLAMA_URL", "http://127.0.0.1:1")
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "x",
            "adapter": "openai-chat",
            "base_url": "http://x.test/v1",
            "auth_shape": "none",
        },
    )
    assert resp.status_code == 502
    assert "cannot check 'x' against the local model tags" in resp.json()["error"]


async def test_a_provider_prefix_with_no_model_is_a_400_never_another_provider(
    client, pool, mount_backend, local_tags
):
    await _add_openrouter(client, mount_backend)
    resp = await client.post(
        "/v1/chat/completions", json={"model": "openrouter:", "messages": [], "stream": True}
    )
    assert resp.status_code == 400
    assert "openrouter:<model>" in resp.json()["error"]
    assert [path for path, _ in local_tags.seen if path != "/api/tags"] == []


async def test_a_refused_listing_is_recorded_on_the_row(client, pool, mount_backend):
    fake, _ = await _add_openrouter(client, mount_backend)
    fake.models_status = 401
    fake.models_body = {"error": {"message": "key revoked"}}

    resp = await client.get("/admin/providers/openrouter/models")

    assert resp.status_code == 401
    row = await providers.get_row(pool, "openrouter")
    assert row["listing"] == "unknown"
    assert "key revoked" in row["listing_note"]
    # The save's verdict is a DIFFERENT fact and survives every listing
    # fetch — the page paints "Verified" from these, never from listing_note.
    assert row["key_proven"] is True
    assert "the listing accepted the key" in row["verify_note"]
    assert row["verified_at"] is not None


# ── the verdict is its own state ─────────────────────────────────────────


async def test_a_models_fetch_never_rewrites_the_saves_verdict(client, pool, mount_backend):
    """The review's critical: the page's auto-open fetches the list right
    after a save, and that fetch rewrites listing_note — so an unproven key
    read as "3 models listed" a second later. key_proven / verify_note are
    written by the save only."""
    fake = FakeOpenAICompat(
        models_body={"object": "list", "data": [{"id": "m"}]},
        models_public=True,
        completions_status=402,
    )
    mount_backend("http://broke2.test", fake.app)
    saved = await client.post(
        "/admin/providers",
        json={
            "name": "broke2",
            "adapter": "openai-chat",
            "base_url": "http://broke2.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-x",
        },
    )
    assert saved.status_code == 200 and saved.json()["key_proven"] is False

    listed = await client.get("/admin/providers/broke2/models")

    assert listed.status_code == 200
    row = (await client.get("/admin/providers/broke2")).json()
    assert row["listing_note"] == "1 models listed"
    assert row["key_proven"] is False
    assert "NOT proven" in row["verify_note"]


async def test_no_listing_means_the_key_was_not_tested_and_the_row_says_so(
    client, pool, mount_backend
):
    fake = FakeOpenAICompat(models_status=404, models_body={"detail": "Not Found"})
    mount_backend("http://manual2.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "manual2",
            "adapter": "openai-chat",
            "base_url": "http://manual2.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-x",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["key_proven"] is None
    assert "the key was not tested" in resp.json()["verify_note"]


async def test_a_200_that_is_an_error_frame_does_not_prove_the_key(client, pool, mount_backend):
    """The relay answers 200 and then writes an error frame when the
    provider compresses despite being asked not to; a status alone would
    read that as a completion."""
    fake = FakeOpenAICompat(
        models_body={"object": "list", "data": [{"id": "m"}]},
        models_public=True,
        completions_body={"error": {"message": "model overloaded"}},
    )
    mount_backend("http://flaky.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "flaky",
            "adapter": "openai-chat",
            "base_url": "http://flaky.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-x",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["key_proven"] is False
    assert "model overloaded" in resp.json()["verify_note"]


async def test_the_wizard_path_records_the_same_verdict(client, pool, mount_backend):
    fake = FakeOpenAICompat(accepts_key="sk-cloud1111")
    mount_backend("http://cloudw.test", fake.app)
    resp = await client.put(
        "/admin/backend",
        json={
            "kind": "cloud",
            "url": "http://cloudw.test",
            "provider": "wizard",
            "api_key": "sk-cloud1111",
            "model": "m",
        },
    )
    assert resp.status_code == 200, resp.text
    row = await providers.get_row(pool, "wizard")
    assert row["key_proven"] is True
    assert "the listing accepted the key" in row["verify_note"]


def test_cheapest_model_ranks_only_real_prices():
    from app.adapters.openai_chat import cheapest_model

    assert cheapest_model([{"id": "a"}, {"id": "b"}]) == "a"
    assert (
        cheapest_model(
            [
                {"id": "router", "pricing": {"prompt": -1, "completion": -1}},
                {"id": "free", "pricing": {"prompt": 0, "completion": 0}},
                {"id": "paid", "pricing": {"prompt": 1e-6, "completion": 2e-6}},
            ]
        )
        == "paid"
    )
    # Nothing fully priced: the first listed, not the router.
    assert (
        cheapest_model(
            [
                {"id": "router", "pricing": {"prompt": -1, "completion": -1}},
                {"id": "half", "pricing": {"completion": 1e-9}},
            ]
        )
        == "router"
    )


# ── the review's second pass: a wrong-key check that decides nothing must not paint green ──


async def test_a_rate_limited_wrong_key_check_never_proves_the_key(client, pool, mount_backend):
    fake = FakeOpenAICompat(
        models_body={"object": "list", "data": [{"id": "m"}]},
        accepts_key="sk-real",
        models_wrong_key_status=429,
    )
    mount_backend("http://ratelimited.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "ratelimited",
            "adapter": "openai-chat",
            "base_url": "http://ratelimited.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-real",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["key_proven"] is None
    assert "could not be determined" in resp.json()["verify_note"]
    assert "429" in resp.json()["verify_note"]
    assert not any(path == "/v1/chat/completions" for path, _ in fake.seen)


async def test_anthropic_proves_the_key_only_when_its_listing_required_it(
    client, pool, mount_backend
):
    fake = FakeAnthropic(accepts_key="sk-ant-real")
    mount_backend("http://anthropic.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "anthropic",
            "adapter": "anthropic-messages",
            "base_url": "http://anthropic.test/v1",
            "auth_shape": "api-key-header",
            "api_key": "sk-ant-real",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["key_proven"] is True
    assert "the listing accepted the key" in resp.json()["verify_note"]
    assert not any(path == "/v1/messages" for path, _ in fake.seen)


async def test_an_anthropic_shaped_proxy_with_a_public_listing_gets_a_message_probe(
    client, pool, mount_backend
):
    """A proxy whose /models is public proves nothing about the key; a
    1-token message does. A wrong key is refused at save; a right one is
    proven by the message, never by the vendor's name."""
    fake = FakeAnthropic(accepts_key="sk-ant-real", models_public=True, blocks=("hi",))
    mount_backend("http://anthproxy.test", fake.app)
    body = {
        "name": "anthproxy",
        "adapter": "anthropic-messages",
        "base_url": "http://anthproxy.test/v1",
        "auth_shape": "api-key-header",
        "api_key": "sk-ant-WRONG",
    }
    wrong = await client.post("/admin/providers", json=body)
    assert wrong.status_code == 502
    assert "refused on a test message" in wrong.json()["error"]
    assert [r["name"] for r in await providers.list_rows(pool)] == ["ollama"]

    right = await client.post("/admin/providers", json={**body, "api_key": "sk-ant-real"})
    assert right.status_code == 200, right.text
    assert right.json()["key_proven"] is True
    assert "proven with a 1-token message" in right.json()["verify_note"]
    probe = [b for path, b in fake.seen if path == "/v1/messages"][-1]
    assert probe["max_tokens"] == 1


async def test_a_save_without_a_verdict_has_no_verified_at(pool):
    """The legacy save path with no verify run records NO verdict and NO
    verified_at — the page then shows no status line, not a 'Checked'
    that checked nothing."""
    await backends.save_config(
        pool, {"kind": "cloud", "url": "http://x.test", "api_key": "sk-x", "model": "m"}
    )
    row = await providers.get_row(pool, "cloud")
    assert row["verified_at"] is None
    assert row["key_proven"] is None and row["verify_note"] is None


# ── S10a T1: what a listing DECLARES about a model ───────────────────────

# Longer than the 500-character cap the row keeps.
OPENROUTER_DESCRIPTION = (
    "Qwen3-Coder-480B-A35B-Instruct is a Mixture-of-Experts code generation model "
    "optimised for agentic coding tasks such as function calling, tool use and "
    "long-context reasoning over repositories. "
) * 4

# One OpenRouter GET /api/v1/models row with the live keys verified
# 2026-09-06: pricing as strings in USD per token, `architecture.
# input_modalities`, `supported_parameters` (carrying `tools` when function
# calling is supported), a `reasoning` object only on models that reason,
# `benchmarks.artificial_analysis` (third-party), `top_provider.
# max_completion_tokens`, `hugging_face_id`, `description`, `expiration_date`.
OPENROUTER_LIVE_ROW = {
    "id": "qwen/qwen3-coder",
    "canonical_slug": "qwen/qwen3-coder-480b-a35b-07-25",
    "hugging_face_id": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    "name": "Qwen: Qwen3 Coder",
    "created": 1753230546,
    "description": OPENROUTER_DESCRIPTION,
    "context_length": 262144,
    "architecture": {
        "modality": "text+image->text",
        "input_modalities": ["text", "image"],
        "output_modalities": ["text"],
        "tokenizer": "Qwen",
        "instruct_type": None,
    },
    "pricing": {
        "prompt": "0.00000022",
        "completion": "0.00000095",
        "request": "0",
        "image": "0",
        "web_search": "0",
        "internal_reasoning": "0",
    },
    "top_provider": {
        "context_length": 262144,
        "max_completion_tokens": 66536,
        "is_moderated": False,
    },
    "per_request_limits": None,
    "supported_parameters": [
        "max_tokens",
        "temperature",
        "tools",
        "tool_choice",
        "reasoning",
        "include_reasoning",
    ],
    "reasoning": {
        "mandatory": False,
        "default_enabled": False,
        "supported_efforts": ["low", "medium", "high"],
        "default_effort": "medium",
    },
    "benchmarks": {
        "artificial_analysis": {
            "intelligence_index": 42.0,
            "coding_index": 46.0,
            "agentic_index": 33.5,
        }
    },
    "expiration_date": "2027-01-01",
}

# A text-only row that carries the same keys as nulls and empties — the
# shape OpenRouter's plain models have. Nothing new may appear on it.
OPENROUTER_PLAIN_ROW = {
    "id": "x/plain",
    "name": "Plain",
    "context_length": 8192,
    "architecture": {
        "modality": "text->text",
        "input_modalities": ["text"],
        "output_modalities": ["text"],
        "tokenizer": "Other",
    },
    "pricing": {"prompt": "0", "completion": "0"},
    "top_provider": {"context_length": 8192, "max_completion_tokens": None, "is_moderated": False},
    "supported_parameters": ["max_tokens"],
    "description": "",
    "reasoning": None,
    "benchmarks": {"artificial_analysis": {}},
    "hugging_face_id": "",
    "expiration_date": None,
}

LISTED = {"basis": "declared", "source": "provider-listing"}


async def test_a_listing_row_carries_what_openrouter_declared_and_nothing_more(
    client, mount_backend
):
    from app.adapters.openai_chat import listing_capabilities

    fake = FakeOpenAICompat(
        models_body={"object": "list", "data": [OPENROUTER_LIVE_ROW, OPENROUTER_PLAIN_ROW]},
        accepts_key=SECRET,
    )
    mount_backend("http://openrouter.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "openrouter",
            "adapter": "openai-chat",
            "base_url": "http://openrouter.test/v1",
            "auth_shape": "static-bearer",
            "api_key": SECRET,
            "preset": "openrouter",
        },
    )
    assert resp.status_code == 200, resp.text

    body = (await client.get("/admin/providers/openrouter/models")).json()
    rich, plain = body["models"]
    assert rich == {
        "id": "qwen/qwen3-coder",
        "owned_by": "openrouter",
        "name": "Qwen: Qwen3 Coder",
        "context_length": 262144,
        "pricing": {"prompt": 2.2e-07, "completion": 9.5e-07},
        "max_output_tokens": 66536,
        "input_modalities": ["text", "image"],
        "output_modalities": ["text"],
        "supported_parameters": [
            "max_tokens",
            "temperature",
            "tools",
            "tool_choice",
            "reasoning",
            "include_reasoning",
        ],
        "reasoning": True,
        "benchmarks": {"intelligence_index": 42.0, "coding_index": 46.0, "agentic_index": 33.5},
        "hugging_face_id": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        "description": OPENROUTER_DESCRIPTION[:500],
        "expiration_date": "2027-01-01",
    }
    assert len(rich["description"]) == 500
    # Nulls and empties are NOT facts: no output cap, no reasoning flag, no
    # benchmarks, no description, no HF id on the plain row.
    assert plain == {
        "id": "x/plain",
        "owned_by": "openrouter",
        "name": "Plain",
        "context_length": 8192,
        "pricing": {"prompt": 0.0, "completion": 0.0},
        "input_modalities": ["text"],
        "output_modalities": ["text"],
        "supported_parameters": ["max_tokens"],
    }

    assert listing_capabilities(rich) == (
        {
            "tools": {"value": True, **LISTED, "note": "supported_parameters lists tools"},
            "vision": {
                "value": True,
                **LISTED,
                "note": "architecture.input_modalities lists image",
            },
            "thinking": {"value": True, **LISTED, "note": "the listing carries a reasoning object"},
        },
        {
            "chat": {
                "value": True,
                **LISTED,
                "note": "architecture.output_modalities lists text",
            },
            "coding": {
                "value": 46.0,
                **LISTED,
                "note": "OpenRouter benchmarks.artificial_analysis.coding_index (third-party)",
            },
            "agentic": {
                "value": 33.5,
                **LISTED,
                "note": "OpenRouter benchmarks.artificial_analysis.agentic_index (third-party)",
            },
            "intelligence": {
                "value": 42.0,
                **LISTED,
                "note": (
                    "OpenRouter benchmarks.artificial_analysis.intelligence_index (third-party)"
                ),
            },
        },
    )
    # A plain OpenRouter row still states text output — that is its chat claim.
    assert listing_capabilities(plain) == (
        {},
        {
            "chat": {
                "value": True,
                **LISTED,
                "note": "architecture.output_modalities lists text",
            }
        },
    )
    # Audio rides the same modality list; a row that states nothing at all
    # still says chat and nothing else.
    audio, _ = listing_capabilities({"id": "a", "input_modalities": ["text", "audio"]})
    assert set(audio) == {"audio"}
    assert audio["audio"]["note"] == "architecture.input_modalities lists audio"
    assert listing_capabilities({"id": "bare"})[0] == {}


def test_a_bare_models_row_states_nothing_about_chat():
    """OpenAI's /v1/models lists whisper, tts and embedding models beside
    the chat ones with no field telling them apart: a row that states
    neither output modalities nor supported parameters gets NO chat entry
    (absent, never a claim), while stated parameters alone are enough."""
    from app.adapters.openai_chat import listing_capabilities

    bare = {"id": "whisper-1", "owned_by": "openai"}
    assert listing_capabilities(bare) == ({}, {})
    parameters_only = {"id": "x/m", "supported_parameters": ["max_tokens"]}
    _, suitability = listing_capabilities(parameters_only)
    assert suitability["chat"]["value"] is True
    assert suitability["chat"]["note"] == "supported_parameters are stated (a chat model)"
