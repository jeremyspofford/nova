"""S10a: the catalogue — every source in ONE row shape, every fact labelled.

Pins: the row-shape tripwire; installed rows from ollama's own /api/show;
the vetted layer never overwriting a declared number; a refusing provider
as a stated source, not a broken page; fit equal to /admin/suggest's; the
Hub search and repo routes; a typed ref resolved live."""

from __future__ import annotations

import pytest

from app import catalog, hf_hub, ollama_registry
from app import curated as curated_mod
from tests.conftest import requires_db
from tests.fakes import FakeHFHub, FakeOllama, FakeOllamaRegistry, FakeOpenAICompat
from tests.test_hf_hub import SIBLINGS
from tests.test_ollama_registry import CONFIG, CONFIG_DIGEST, MANIFEST, TOTAL

pytestmark = requires_db

OPENROUTER_ROW = {
    "id": "openai/gpt-6-astra",
    "name": "OpenAI: GPT-6 Astra",
    "context_length": 1050000,
    "architecture": {"input_modalities": ["file", "image", "text"], "output_modalities": ["text"]},
    "pricing": {"prompt": "0.00001", "completion": "0.00005"},
    "top_provider": {"context_length": 1050000, "max_completion_tokens": 128000},
    "supported_parameters": ["tools", "tool_choice", "reasoning"],
    "reasoning": {"mandatory": True, "supported_efforts": ["low", "high"]},
    "benchmarks": {"artificial_analysis": {"coding_index": 76.9, "agentic_index": 51.6}},
}

HUB_ENTRY = {
    "id": "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
    "likes": 964,
    "downloads": 12639566,
    "tags": ["gguf", "qwen3", "text-generation", "license:apache-2.0", "conversational"],
    "pipeline_tag": "text-generation",
    "lastModified": "2026-08-30T00:00:00.000Z",
    "gated": False,
    "gguf": {
        "total": 30532122624,
        "architecture": "qwen3moe",
        "context_length": 262144,
        "chat_template": "{% for m in messages %}{% if tools %}...{% endif %}{% endfor %}",
    },
}


@pytest.fixture
def local(monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama()
    mount_backend("http://ollama.test", fake.app)
    return fake


async def _add_provider(client, mount_backend, name, *, models_body, status=200, key="sk-1"):
    fake = FakeOpenAICompat(models_body=models_body, models_status=status, accepts_key=key)
    mount_backend(f"http://{name}.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": name,
            "adapter": "openai-chat",
            "base_url": f"http://{name}.test/v1",
            "auth_shape": "static-bearer",
            "api_key": key,
        },
    )
    return fake, resp


def _rows_by_id(body: dict) -> dict[str, dict]:
    return {row["id"]: row for row in body["rows"]}


async def test_installed_rows_carry_ollamas_own_facts_and_the_vetted_layer(client, local):
    resp = await client.get("/admin/catalog")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    rows = _rows_by_id(body)
    row = rows["ollama:qwen3:8b"]
    assert row["kind"] == "local" and row["installed"] is True
    assert set(row) == catalog.ROW_KEYS
    for name, fact in row["facts"].items():
        assert fact["basis"] in catalog.BASES, name
        assert fact["source"] in {s["key"] for s in row["sources"]}, name
    # ollama declares; curated vets; declared wins for numbers.
    assert row["facts"]["size_bytes"]["basis"] == "declared"
    assert row["facts"]["params_b"] == {
        **row["facts"]["params_b"],
        "basis": "declared",
        "source": "ollama-show",
    }
    assert row["facts"]["context_length"]["value"] == 40960
    assert row["capabilities"]["tools"] == {
        "value": True,
        "basis": "declared",
        "source": "ollama-show",
    }
    assert "vision" not in row["capabilities"]  # unlisted is absent, never a denial
    assert row["suitability"]["chat"]["basis"] == "declared"
    assert row["suitability"]["reasoning"]["note"] == "capabilities: thinking"
    # The curated pick's use_cases are the vetted layer, dated.
    vetted = [k for k, f in row["suitability"].items() if f["basis"] == "vetted"]
    assert vetted and all(row["suitability"][k]["at"] for k in vetted)
    assert row["label"] == "Qwen3 8B"
    assert row["actions"] == ["use", "probe"]
    assert row["fit"]["verdict"] in {"comfortable", "tight", "wont_fit", "unknown"}
    sources = {s["key"]: s for s in body["sources"]}
    assert sources["ollama"]["ok"] is True and sources["ollama"]["rows"] == 2


async def test_uncurated_installed_models_still_list_with_an_honest_fit(client, local):
    local.tags = ("muse-glimmer:latest",)
    resp = await client.get("/admin/catalog")
    row = _rows_by_id(resp.json())["ollama:muse-glimmer:latest"]
    assert row["installed"] is True
    assert row["fit"]["verdict"] == "unknown"
    assert "never probed" in row["fit"]["reason"]
    assert not any(s["key"] == "curated" for s in row["sources"])


async def test_curated_picks_not_installed_are_library_rows(client, local):
    resp = await client.get("/admin/catalog")
    rows = _rows_by_id(resp.json())
    library = [r for r in rows.values() if r["kind"] == "local" and r["installed"] is False]
    assert library, "the curated picks not installed must be listed as pullable"
    row = library[0]
    assert row["actions"] == ["pull"]
    assert row["facts"]["params_b"]["basis"] == "vetted"
    assert row["capabilities"] == {}  # nothing declared until it is pulled


async def test_fit_agrees_with_admin_suggest_for_the_same_slug(client, local):
    suggest = (await client.get("/admin/suggest")).json()
    cat = _rows_by_id((await client.get("/admin/catalog")).json())
    for model in suggest["models"]:
        assert cat[f"ollama:{model['slug']}"]["fit"] == model["fit"], model["slug"]


async def test_a_probe_surfaces_as_a_measured_fact(client, local, pool):
    await pool.execute(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, error) "
        "VALUES ('qwen3:8b', 'ollama', true, 812, 9318, NULL)"
    )
    row = _rows_by_id((await client.get("/admin/catalog")).json())["ollama:qwen3:8b"]
    assert row["probe"]["latency_ms"] == 812 and row["probe"]["vram_mb"] == 9318
    assert row["facts"]["vram_gb"] == {**row["facts"]["vram_gb"], "value": 9.1, "basis": "measured"}
    assert row["fit"]["source"] == "verified"


async def test_provider_rows_carry_declared_capabilities_and_third_party_benchmarks(
    client, local, mount_backend
):
    fake, created = await _add_provider(
        client,
        mount_backend,
        "openrouter",
        models_body={"object": "list", "data": [OPENROUTER_ROW]},
    )
    assert created.status_code == 200, created.text

    body = (await client.get("/admin/catalog")).json()
    row = _rows_by_id(body)["openrouter:openai/gpt-6-astra"]

    assert row["kind"] == "cloud" and row["installed"] is None
    assert row["facts"]["context_length"]["value"] == 1050000
    assert row["facts"]["price_prompt"]["value"] == 1e-05
    assert row["facts"]["max_output_tokens"]["value"] == 128000
    assert row["capabilities"]["tools"]["basis"] == "declared"
    assert row["capabilities"]["vision"]["basis"] == "declared"
    assert row["capabilities"]["thinking"]["basis"] == "declared"
    assert row["suitability"]["coding"]["value"] == 76.9
    assert "third-party" in row["suitability"]["coding"]["note"]
    assert row["actions"] == ["use"]
    assert {s["key"]: s["rows"] for s in body["sources"]}["openrouter"] == 1


async def test_a_refusing_provider_is_a_stated_source_not_a_broken_page(
    client, local, mount_backend
):
    fake, created = await _add_provider(
        client, mount_backend, "flaky", models_body={"object": "list", "data": [{"id": "m"}]}
    )
    assert created.status_code == 200
    fake.models_status = 401
    fake.models_body = {"error": {"message": "key revoked"}}

    resp = await client.get("/admin/catalog")

    assert resp.status_code == 200
    body = resp.json()
    source = {s["key"]: s for s in body["sources"]}["flaky"]
    assert source["ok"] is False and "key revoked" in source["note"]
    assert "ollama:qwen3:8b" in _rows_by_id(body)
    assert not any(r["provider"] == "flaky" for r in body["rows"])


async def test_hub_search_rows_are_labelled_and_inferred_tags_say_so(client, mount_backend):
    fake = FakeHFHub(pages=([HUB_ENTRY],))
    mount_backend(hf_hub.HF_BASE, fake.app)

    resp = await client.get("/admin/catalog/hf?q=qwen%20coder&sort=downloads&limit=5")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["next_cursor"] is None and body["budget"]["remaining"] >= 0
    row = body["rows"][0]
    assert set(row) <= catalog.ROW_KEYS | {"note"}
    assert row["id"] == "ollama:hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF"
    assert row["kind"] == "hub" and row["installed"] is False
    assert row["facts"]["params_b"]["basis"] == "declared"
    assert row["facts"]["context_length"]["value"] == 262144
    assert row["capabilities"]["tools"]["basis"] == "inferred"
    assert row["suitability"]["coding"]["basis"] == "inferred"
    bad = await client.get("/admin/catalog/hf?q=qwen&sort=bogus")
    assert bad.status_code == 400


async def test_hub_repo_row_lists_its_quants_with_the_default_marked(client, mount_backend):
    fake = FakeHFHub(repos={HUB_ENTRY["id"]: {**HUB_ENTRY, "siblings": SIBLINGS}})
    mount_backend(hf_hub.HF_BASE, fake.app)

    resp = await client.get(f"/admin/catalog/hf/{HUB_ENTRY['id']}")

    assert resp.status_code == 200, resp.text
    row = resp.json()
    quants = row["pull"]["quants"]
    assert row["pull"]["target"] == f"hf.co/{HUB_ENTRY['id']}"
    default = [q for q in quants if q["is_default"]]
    assert [q["tag"] for q in default] == ["Q4_K_M"]
    assert default[0]["size_bytes"] == 18_556_686_336


async def test_resolve_a_typed_tag_against_the_registry(client, mount_backend):
    fake = FakeOllamaRegistry(
        manifests={"library/qwen3/8b": MANIFEST}, blobs={CONFIG_DIGEST: CONFIG}
    )
    mount_backend(ollama_registry.REGISTRY_BASE, fake.app)

    resp = await client.get("/admin/catalog/resolve?model=qwen3:8b")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source"] == "ollama-registry"
    assert body["facts"]["size_bytes"]["value"] == TOTAL
    assert body["facts"]["quant"]["value"] == "Q4_K_M"
    assert body["facts"]["family"]["value"] == "qwen3"
    assert body["facts"]["params_b"]["value"] == 8.2

    missing = await client.get("/admin/catalog/resolve?model=nope:1b")
    assert missing.status_code == 404
    assert "not in the ollama library" in missing.json()["error"]
    malformed = await client.get("/admin/catalog/resolve?model=;rm")
    assert malformed.status_code == 400


async def test_resolve_a_hub_ref_names_a_missing_quant(client, mount_backend):
    fake = FakeHFHub(repos={HUB_ENTRY["id"]: {**HUB_ENTRY, "siblings": SIBLINGS}})
    mount_backend(hf_hub.HF_BASE, fake.app)
    resp = await client.get(f"/admin/catalog/resolve?model=hf.co/{HUB_ENTRY['id']}:Q9_9")
    assert resp.status_code == 200, resp.text
    assert "has no quant 'Q9_9'" in resp.json()["note"]
    assert resp.json()["pull"]["quants"]


def test_curated_use_cases_are_from_the_fixed_taxonomy():
    for entry in curated_mod.load_curated():
        assert entry["use_cases"], entry["slug"]
        assert set(entry["use_cases"]) <= set(curated_mod.USE_CASES), entry["slug"]
