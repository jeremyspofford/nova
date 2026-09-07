"""S10a: the catalogue — every source in ONE row shape, every fact labelled.

Pins: the row-shape tripwire; installed rows from ollama's own /api/show;
the vetted layer never overwriting a declared number; a refusing provider
as a stated source, not a broken page; fit equal to /admin/suggest's; the
Hub search and repo routes; a typed ref resolved live."""

from __future__ import annotations

import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from app import admin, catalog, hf_hub, ollama_registry
from app import curated as curated_mod
from tests.conftest import requires_db
from tests.fakes import FakeHFHub, FakeOllama, FakeOllamaRegistry, FakeOpenAICompat
from tests.test_admin_suggest_fit import _write_hardware
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
    # Each tag's facts are ITS OWN /api/show answer, not the first one's.
    assert rows["ollama:qwen3:8b"]["facts"]["params_b"]["value"] == 8.19
    assert rows["ollama:qwen3:4b"]["facts"]["params_b"]["value"] == 4.02
    assert rows["ollama:qwen3:4b"]["facts"]["family"]["value"] == "qwen3"


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


async def test_fit_agrees_with_admin_suggest_for_the_same_slug(
    client, local, pool, monkeypatch, tmp_path
):
    """Not vacuous: a real card, an older probe WITH a VRAM reading and a
    newer OK probe WITHOUT one. Fit must read the reading (suggest's
    query) while the row's probe block reports the newest probe."""
    _write_hardware(monkeypatch, tmp_path, 24576)
    await pool.execute(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, error, created_at) "
        "VALUES ('qwen3:8b', 'ollama', true, 100, 9508, NULL, now() - interval '1 day')"
    )
    await pool.execute(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, error, created_at) "
        "VALUES ('qwen3:8b', 'ollama', true, 500, NULL, NULL, now())"
    )
    suggest = (await client.get("/admin/suggest")).json()
    cat = _rows_by_id((await client.get("/admin/catalog")).json())
    assert suggest["models"], "suggest listed nothing — the comparison would be vacuous"
    by_slug = {m["slug"]: m["fit"] for m in suggest["models"]}
    assert by_slug["qwen3:8b"]["source"] == "verified"
    assert by_slug["qwen3:8b"]["needed_gb"] == 9.3
    for slug, fit in by_slug.items():
        assert cat[f"ollama:{slug}"]["fit"] == fit, slug
    row = cat["ollama:qwen3:8b"]
    assert row["probe"]["latency_ms"] == 500 and row["probe"]["vram_mb"] is None
    assert row["facts"]["vram_gb"]["value"] == 9.3


async def test_another_backends_probe_of_the_same_tag_is_not_this_rows(client, local, pool):
    """A second ollama host registered as a provider probes bare tags too;
    its numbers are not the bundled ollama's."""
    await pool.execute(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, error) "
        "VALUES ('qwen3:8b', 'openai-chat', true, 812, 9318, NULL)"
    )
    row = _rows_by_id((await client.get("/admin/catalog")).json())["ollama:qwen3:8b"]
    assert row["probe"] is None
    assert "vram_gb" not in row["facts"] or row["facts"]["vram_gb"]["basis"] == "vetted"
    assert row["fit"]["source"] != "verified"


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


async def test_a_provider_whose_listing_raises_is_named_in_its_source(
    client, local, mount_backend, monkeypatch
):
    fake, created = await _add_provider(
        client, mount_backend, "flaky", models_body={"object": "list", "data": [{"id": "m"}]}
    )
    assert created.status_code == 200
    real = admin._listing_for

    async def boom(app, pool, row):
        if row["name"] == "flaky":
            raise RuntimeError("a bug in the adapter")
        return await real(app, pool, row)

    monkeypatch.setattr(admin, "_listing_for", boom)

    body = (await client.get("/admin/catalog")).json()

    keys = [s["key"] for s in body["sources"]]
    assert "provider" not in keys, "an anonymous failure hides WHICH provider broke"
    source = {s["key"]: s for s in body["sources"]}["flaky"]
    assert source["ok"] is False and "a bug in the adapter" in source["note"]


async def test_a_tags_body_that_is_not_an_object_is_a_stated_refusal(
    client, monkeypatch, mount_backend
):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")

    async def tags(request):
        return JSONResponse(["qwen3:8b"])

    mount_backend("http://ollama.test", Starlette(routes=[Route("/api/tags", tags)]))

    body = (await client.get("/admin/catalog")).json()

    source = {s["key"]: s for s in body["sources"]}["ollama"]
    assert source["ok"] is False and "not an object" in source["note"]


async def test_a_stalled_show_fan_out_still_yields_rows_with_a_note(client, local, monkeypatch):
    from app.adapters import ollama

    ollama.SHOW_CACHE.clear()  # content-addressed: an earlier test's hit would skip HTTP
    local.show_delay_s = 5.0
    monkeypatch.setattr(catalog, "SHOW_DEADLINE_S", 0.05)

    body = (await client.get("/admin/catalog")).json()

    source = {s["key"]: s for s in body["sources"]}["ollama"]
    assert source["ok"] is True and "did not answer within 0.05 s" in source["note"]
    row = _rows_by_id(body)["ollama:qwen3:8b"]
    assert row["installed"] is True and row["facts"]["size_bytes"]["basis"] == "declared"
    assert not any(f["source"] == "ollama-show" for f in row["facts"].values()), (
        "show facts are absent, never invented"
    )
    assert row["capabilities"] == {}
    assert row["note"].startswith("/api/show failed — ")


async def test_hub_search_rows_are_labelled_and_inferred_tags_say_so(client, mount_backend):
    fake = FakeHFHub(pages=([HUB_ENTRY],))
    mount_backend(hf_hub.HF_BASE, fake.app)

    resp = await client.get("/admin/catalog/hf?q=qwen%20coder&sort=downloads&limit=5")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["next_cursor"] is None and body["budget"]["remaining"] >= 0
    row = body["rows"][0]
    assert set(row) == catalog.ROW_KEYS, "a hub row carries EVERY key the page dereferences"
    assert row["id"] == "ollama:hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF"
    assert row["kind"] == "hub" and row["actions"] == ["pull"]
    assert row["installed"] is None, "ollama was not reachable here: unstated, not False"
    assert row["facts"]["params_b"]["basis"] == "declared"
    assert row["facts"]["context_length"]["value"] == 262144
    assert row["capabilities"]["tools"]["basis"] == "inferred"
    assert row["suitability"]["coding"]["basis"] == "inferred"
    bad = await client.get("/admin/catalog/hf?q=qwen&sort=bogus")
    assert bad.status_code == 400


async def test_hub_rows_say_installed_from_ollamas_own_tags(client, local, mount_backend):
    """The Hub cannot know what THIS host holds: `installed` comes from
    /api/tags — True naming the quant tag, False when the tags were read
    and the repo is not there."""
    repo = HUB_ENTRY["id"]
    local.tags = ("qwen3:8b", f"hf.co/{repo}:Q4_K_M")
    fake = FakeHFHub(pages=([HUB_ENTRY, {**HUB_ENTRY, "id": "other/Repo-GGUF"}],))
    mount_backend(hf_hub.HF_BASE, fake.app)

    rows = (await client.get("/admin/catalog/hf?q=qwen")).json()["rows"]

    assert rows[0]["installed"] is True
    assert rows[0]["note"] == f"installed as hf.co/{repo}:Q4_K_M"
    assert rows[1]["installed"] is False and rows[1]["note"] is None


async def test_a_hub_rate_limit_is_a_429_whose_body_carries_the_wait(client, mount_backend):
    """Core forwards bodies, not headers: retry_after_s must be IN the body."""
    fake = FakeHFHub(status=429, headers={"Retry-After": "42"})
    mount_backend(hf_hub.HF_BASE, fake.app)

    resp = await client.get("/admin/catalog/hf?q=qwen")

    assert resp.status_code == 429
    assert resp.headers["retry-after"] == "42"
    body = resp.json()
    assert body["retry_after_s"] == 42 and "rate-limited" in body["error"]


async def test_a_hub_detail_without_an_id_still_maps_under_the_asked_ref(client, mount_backend):
    detail = {k: v for k, v in HUB_ENTRY.items() if k != "id"} | {"siblings": SIBLINGS}
    fake = FakeHFHub(repos={HUB_ENTRY["id"]: detail})
    mount_backend(hf_hub.HF_BASE, fake.app)

    resp = await client.get(f"/admin/catalog/hf/{HUB_ENTRY['id']}")

    assert resp.status_code == 200, resp.text
    row = resp.json()
    assert row["id"] == f"ollama:hf.co/{HUB_ENTRY['id']}"
    assert set(row) == catalog.ROW_KEYS


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
