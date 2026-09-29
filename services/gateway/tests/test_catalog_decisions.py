"""Decision models in the catalogue (decision-role spec §3).

Pins: OpenRouter's decision models are fetched with ?output_modalities=
decisions — its default listing omits them — and only from a provider whose
listing speaks the modality vocabulary; each is declared a `decisions` model
with no chat suitability and NO action (never `use`, which writes chat.model);
a failed decision listing is a note on the source while the chat models still
list; a local decision server's models are local and installed, not cloud."""

from __future__ import annotations

import pytest

from app.adapters import openai_chat
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat, QueryFailingTransport

pytestmark = requires_db

CHAT_ROW = {
    "id": "openai/gpt-6-astra",
    "name": "OpenAI: GPT-6 Astra",
    "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
    "pricing": {"prompt": "0.00001", "completion": "0.00005"},
    "supported_parameters": ["tools"],
}
# OpenRouter's own row for Jev (GET /models?output_modalities=decisions, 2026-09-28).
JEV_ROW = {
    "id": "~typesafe/jev-latest",
    "name": "TypeSafe: Jev Latest",
    "context_length": 32000,
    "architecture": {
        "modality": "text->decisions",
        "input_modalities": ["text"],
        "output_modalities": ["decisions"],
    },
    "pricing": {"prompt": "0.000000042", "completion": "0"},
    "supported_parameters": [],
}


@pytest.fixture
def local(monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama()
    mount_backend("http://ollama.test", fake.app)
    return fake


async def _provider(client, mount_backend, name: str, **fake_over) -> FakeOpenAICompat:
    fake = FakeOpenAICompat(accepts_key="sk-1", **fake_over)
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


def _rows(body: dict) -> dict[str, dict]:
    return {row["id"]: row for row in body["rows"]}


async def test_openrouters_decision_models_list_beside_its_chat_models_and_are_never_chat(
    client, local, mount_backend
):
    fake = await _provider(
        client,
        mount_backend,
        "openrouter",
        models_body={"object": "list", "data": [CHAT_ROW]},
        decisions_models_body={"object": "list", "data": [JEV_ROW]},
    )

    rows = _rows((await client.get("/admin/catalog")).json())

    jev = rows["openrouter:~typesafe/jev-latest"]
    assert jev["kind"] == "cloud"
    assert jev["actions"] == [], "a decision model is never offered as the chat model"
    assert jev["suitability"]["decisions"]["basis"] == "declared"
    assert "chat" not in jev["suitability"]
    assert rows["openrouter:openai/gpt-6-astra"]["actions"] == ["use"]
    assert ("/v1/models", {"output_modalities": "decisions"}) in fake.seen


async def test_a_listing_that_states_no_modalities_is_never_asked_for_decision_models(
    client, local, mount_backend
):
    fake = await _provider(
        client, mount_backend, "plain", models_body={"object": "list", "data": [{"id": "gpt-x"}]}
    )

    await client.get("/admin/catalog")

    queries = [query for path, query in fake.seen if path == "/v1/models"]
    assert queries, "the listing was read"
    assert all(query is None for query in queries), "never asked for a modality it never states"


async def test_a_decision_listing_that_fails_is_said_and_the_chat_models_still_list(
    client, local, mount_backend
):
    await _provider(
        client,
        mount_backend,
        "openrouter",
        models_body={"object": "list", "data": [CHAT_ROW]},
        decisions_models_body={"error": {"message": "upstream hiccup"}},
        decisions_models_status=500,
    )

    body = (await client.get("/admin/catalog")).json()

    source = {s["key"]: s for s in body["sources"]}["openrouter"]
    assert source["ok"] is True
    assert source["note"] == "its decision models could not be listed (500: upstream hiccup)"
    assert "openrouter:openai/gpt-6-astra" in _rows(body)
    assert "openrouter:~typesafe/jev-latest" not in _rows(body)


async def test_a_decision_listing_transport_failure_is_said_and_the_chat_models_still_list(
    client, local, mount_transport
):
    """The OTHER way a fetch can fail: never a response at all (a dead
    connection), not a non-200 one. `_decision_models`'s own words for it,
    never `fetch_listing`'s "could not reach" phrasing."""
    fake = FakeOpenAICompat(accepts_key="sk-1", models_body={"object": "list", "data": [CHAT_ROW]})
    mount_transport(
        "http://openrouter.test",
        QueryFailingTransport(fake.app, query={"output_modalities": "decisions"}),
    )

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

    body = (await client.get("/admin/catalog")).json()

    source = {s["key"]: s for s in body["sources"]}["openrouter"]
    assert source["ok"] is True
    assert source["note"].startswith("its decision models could not be listed — ConnectError")
    assert "openrouter:openai/gpt-6-astra" in _rows(body)
    assert "openrouter:~typesafe/jev-latest" not in _rows(body)


async def test_an_unreadable_decision_listing_is_said_and_the_chat_models_still_list(
    client, local, mount_backend
):
    """The THIRD way `_decision_models` can fail: a 200 that is not JSON —
    a proxy's error page in front of the real server, say."""
    await _provider(
        client,
        mount_backend,
        "openrouter",
        models_body={"object": "list", "data": [CHAT_ROW]},
        decisions_models_raw=b"not json at all",
    )

    body = (await client.get("/admin/catalog")).json()

    source = {s["key"]: s for s in body["sources"]}["openrouter"]
    assert source["ok"] is True
    assert source["note"].startswith("its decision-model listing was unreadable — ")
    assert "openrouter:openai/gpt-6-astra" in _rows(body)
    assert "openrouter:~typesafe/jev-latest" not in _rows(body)


async def test_a_local_decision_server_lists_as_installed_on_the_owners_machine(
    client, local, mount_backend
):
    kev = FakeOpenAICompat(models_body={"models": [{"name": "kev-latest"}]})
    mount_backend("http://kev.test", kev.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "dell-kev",
            "adapter": "systemone",
            "base_url": "http://kev.test/v1",
            "auth_shape": "none",
            "local": True,
        },
    )
    assert resp.status_code == 200, resp.text

    row = _rows((await client.get("/admin/catalog")).json())["dell-kev:kev-latest"]

    assert (row["kind"], row["installed"], row["actions"]) == ("local", True, [])
    assert row["suitability"]["decisions"]["value"] is True


async def test_a_local_openai_chat_providers_chat_rows_stay_cloud(client, local, mount_backend):
    """A provider marked local is not always a decision-only server — an
    openai-chat endpoint on the owner's own network can serve chat AND
    decision models at once (OpenRouter's own shape). Only the DECISION
    row belongs to the local/installed chain; the chat row stays cloud,
    where the chat picker finds it."""
    fake = FakeOpenAICompat(
        accepts_key="sk-1",
        models_body={"object": "list", "data": [CHAT_ROW]},
        decisions_models_body={"object": "list", "data": [JEV_ROW]},
    )
    mount_backend("http://homelab.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "homelab",
            "adapter": "openai-chat",
            "base_url": "http://homelab.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
            "local": True,
        },
    )
    assert resp.status_code == 200, resp.text

    rows = _rows((await client.get("/admin/catalog")).json())
    chat_row = rows["homelab:openai/gpt-6-astra"]
    decision_row = rows["homelab:~typesafe/jev-latest"]

    assert (chat_row["kind"], chat_row["installed"], chat_row["actions"]) == (
        "cloud",
        None,
        ["use"],
    )
    assert (decision_row["kind"], decision_row["installed"], decision_row["actions"]) == (
        "local",
        True,
        [],
    )


async def test_verifys_models_listed_note_says_when_the_decision_listing_failed(
    client, local, mount_backend
):
    """A partial list is never passed off as a whole one on the save path
    either: the provider's verify-before-save note names what could not be
    listed, exactly like the catalogue source it feeds."""
    fake = FakeOpenAICompat(
        models_body={"object": "list", "data": [CHAT_ROW]},
        decisions_models_body={"error": {"message": "upstream hiccup"}},
        decisions_models_status=500,
    )
    mount_backend("http://openrouter.test", fake.app)

    resp = await client.post(
        "/admin/providers",
        json={
            "name": "openrouter",
            "adapter": "openai-chat",
            "base_url": "http://openrouter.test/v1",
            "auth_shape": "none",
        },
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["verify_note"] == (
        "1 models listed; its decision models could not be listed (500: upstream hiccup)"
    )


async def test_the_admin_listing_path_also_says_when_the_decision_listing_failed(
    client, local, mount_backend
):
    """`_listing_for` (GET /admin/providers/{name}/models, and the
    catalogue build behind it) stores the same extended sentence on the
    provider row that `verify` writes at save time — nothing asserted that
    before this test."""
    await _provider(
        client,
        mount_backend,
        "openrouter",
        models_body={"object": "list", "data": [CHAT_ROW]},
        decisions_models_body={"error": {"message": "upstream hiccup"}},
        decisions_models_status=500,
    )

    listing = (await client.get("/admin/providers/openrouter/models")).json()
    assert listing["note"] == "its decision models could not be listed (500: upstream hiccup)"

    providers_list = (await client.get("/admin/providers")).json()["providers"]
    row = next(p for p in providers_list if p["name"] == "openrouter")
    assert row["listing_note"] == (
        "1 models listed; its decision models could not be listed (500: upstream hiccup)"
    )


def test_a_decision_row_is_declared_a_decision_model_and_nothing_else():
    (row,) = openai_chat.normalize_models({"data": [JEV_ROW]}, owned_by="openrouter")
    capabilities, suitability = openai_chat.listing_capabilities(row)
    assert capabilities == {}
    assert suitability == {
        "decisions": {
            "value": True,
            "basis": "declared",
            "source": "provider-listing",
            "note": "the listing says it outputs decisions (a decision model)",
        }
    }
