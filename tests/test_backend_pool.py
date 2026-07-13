"""Backend pool (Phase 1, models/inference unified plan) — llm-gateway.

The single active local backend becomes a pool of named entries under
``inference.backends``; the LocalInferenceProvider chain member routes over
it. These tests exercise entry parsing, runtime rebuild semantics, model
resolution, the scalar-key seed migration, and request routing — no Redis,
no network (storage seams are monkeypatched).

llm-gateway's `app.*` is imported in isolation (see tests/_service_app.py).
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from _service_app import service_app


@pytest.fixture
def gw():
    with service_app("llm-gateway") as import_module:
        pool_mod = import_module("app.pool")
        yield SimpleNamespace(
            pool_mod=pool_mod,
            BackendEntry=pool_mod.BackendEntry,
            BackendPool=pool_mod.BackendPool,
        )


def _entries_json(*entries: dict) -> str:
    import json
    return json.dumps(list(entries))


OLLAMA = {"id": "bundled-ollama", "kind": "container", "engine": "ollama",
          "url": "http://ollama:11434", "enabled": True}
VLLM_A = {"id": "remote-vllm-a", "kind": "remote", "engine": "vllm",
          "url": "http://10.0.0.5:8000", "enabled": True}
VLLM_B = {"id": "remote-vllm-b", "kind": "remote", "engine": "vllm",
          "url": "http://10.0.0.6:8000", "enabled": False}


class TestEntryValidation:
    def test_valid_entry_roundtrips(self, gw):
        e = gw.BackendEntry.from_dict(OLLAMA)
        assert e.to_dict()["id"] == "bundled-ollama"

    @pytest.mark.parametrize("patch", [
        {"id": ""}, {"kind": "cloud9"}, {"engine": "gguf"}, {"url": ""},
    ])
    def test_invalid_entries_rejected(self, gw, patch):
        with pytest.raises(ValueError):
            gw.BackendEntry.from_dict({**OLLAMA, **patch})


class TestApplySemantics:
    def test_builds_runtimes_per_entry(self, gw):
        pool = gw.BackendPool()
        pool._apply(_entries_json(OLLAMA, VLLM_A, VLLM_B))
        assert {rt.entry.id for rt in pool.runtimes()} == {
            "bundled-ollama", "remote-vllm-a", "remote-vllm-b",
        }
        # Two remotes of the same engine get independent delegates
        a = pool.get("remote-vllm-a").delegate
        b = pool.get("remote-vllm-b").delegate
        assert a is not b

    def test_flag_change_preserves_catalog(self, gw):
        pool = gw.BackendPool()
        pool._apply(_entries_json(OLLAMA))
        pool.get("bundled-ollama").models = {"qwen3:4b"}
        pool._apply(_entries_json({**OLLAMA, "enabled": False}))
        rt = pool.get("bundled-ollama")
        assert rt.models == {"qwen3:4b"}          # catalog survived
        assert rt.entry.enabled is False           # new flag took effect

    def test_url_change_rebuilds_delegate_and_catalog(self, gw):
        pool = gw.BackendPool()
        pool._apply(_entries_json(OLLAMA))
        pool.get("bundled-ollama").models = {"qwen3:4b"}
        old_delegate = pool.get("bundled-ollama").delegate
        pool._apply(_entries_json({**OLLAMA, "url": "http://elsewhere:11434"}))
        rt = pool.get("bundled-ollama")
        assert rt.delegate is not old_delegate
        assert rt.models == set()

    def test_invalid_json_keeps_previous_state(self, gw):
        pool = gw.BackendPool()
        pool._apply(_entries_json(OLLAMA))
        pool._apply("{not json")
        assert pool.get("bundled-ollama") is not None


class TestResolution:
    def _pool(self, gw):
        pool = gw.BackendPool()
        pool._apply(_entries_json(OLLAMA, VLLM_A, VLLM_B))
        pool.get("bundled-ollama").models = {"qwen3:4b", "nomic-embed-text:latest"}
        pool.get("remote-vllm-a").models = {"meta-llama/Llama-3.1-8B"}
        pool.get("remote-vllm-b").models = {"secret-model"}
        return pool

    def test_resolves_to_owning_backend(self, gw):
        pool = self._pool(gw)
        assert pool.resolve_model("qwen3:4b").entry.id == "bundled-ollama"
        assert pool.resolve_model("meta-llama/Llama-3.1-8B").entry.id == "remote-vllm-a"

    def test_latest_aliasing_both_directions(self, gw):
        pool = self._pool(gw)
        # bare name matches a stored ":latest" tag …
        assert pool.resolve_model("nomic-embed-text").entry.id == "bundled-ollama"
        # … and an explicit ":latest" suffix matches the stored bare name.
        pool.get("bundled-ollama").models = {"qwen3:4b"}
        assert pool.resolve_model("qwen3:4b:latest").entry.id == "bundled-ollama"
        assert pool.resolve_model("missing-model") is None

    def test_disabled_backend_never_resolves(self, gw):
        pool = self._pool(gw)
        assert pool.resolve_model("secret-model") is None

    def test_primary_is_first_enabled(self, gw):
        pool = self._pool(gw)
        assert pool.primary().entry.id == "bundled-ollama"
        pool._apply(_entries_json({**OLLAMA, "enabled": False}, VLLM_A, VLLM_B))
        assert pool.primary().entry.id == "remote-vllm-a"

    def test_all_models_unions_enabled_only(self, gw):
        pool = self._pool(gw)
        assert "secret-model" not in pool.all_models()
        assert {"qwen3:4b", "meta-llama/Llama-3.1-8B"} <= pool.all_models()

    def test_merge_models_targets_first_enabled_of_engine(self, gw):
        pool = self._pool(gw)
        pool.merge_models("vllm", {"new-model"})
        assert "new-model" in pool.get("remote-vllm-a").models
        assert "new-model" not in pool.get("remote-vllm-b").models


class TestSeedMigration:
    @pytest.fixture
    def seedable(self, gw, monkeypatch):
        """A pool whose storage seams are in-memory, plus a scalar-config map."""
        pool = gw.BackendPool()
        store = {"raw": "", "scalars": {}}

        async def read_raw():
            return store["raw"]

        async def write_entries(entries):
            import json
            store["raw"] = json.dumps([e.to_dict() for e in entries])
            pool._apply(store["raw"])

        async def get_redis_config(key, default=""):
            return store["scalars"].get(key, default)

        monkeypatch.setattr(pool, "_read_raw", read_raw)
        monkeypatch.setattr(pool, "_write_entries", write_entries)
        import app.registry as registry
        monkeypatch.setattr(registry, "_get_redis_config", get_redis_config)
        return pool, store

    async def test_bundled_container_scalar_seeds_container_entry(self, seedable):
        pool, store = seedable
        store["scalars"] = {
            "inference.backend": "ollama",
            "inference.url": "http://ollama:11434",
        }
        assert await pool.seed_from_scalar() is True
        rt = pool.get("bundled-ollama")
        assert rt is not None
        assert rt.entry.kind == "container"
        assert rt.entry.url == "http://ollama:11434"

    async def test_external_scalar_seeds_remote_entry(self, seedable):
        pool, store = seedable
        store["scalars"] = {"inference.backend": "ollama", "inference.url": ""}
        await pool.seed_from_scalar()
        rt = pool.get("ollama")
        assert rt is not None and rt.entry.kind == "remote"

    async def test_none_backend_seeds_empty_pool(self, seedable):
        pool, store = seedable
        store["scalars"] = {"inference.backend": "none"}
        assert await pool.seed_from_scalar() is True
        assert pool.runtimes() == []

    async def test_existing_pool_is_never_overwritten(self, seedable):
        pool, store = seedable
        store["raw"] = _entries_json(VLLM_A)
        store["scalars"] = {"inference.backend": "ollama"}
        assert await pool.seed_from_scalar() is False
        assert pool.get("remote-vllm-a") is not None
        assert pool.get("ollama") is None

    async def test_custom_backend_becomes_openai_engine(self, seedable):
        pool, store = seedable
        store["scalars"] = {
            "inference.backend": "custom",
            "inference.custom_url": "http://gpu-box:9000",
            "inference.custom_auth_header": "Bearer tok",
        }
        await pool.seed_from_scalar()
        rt = pool.get("custom")
        assert rt.entry.engine == "openai"
        assert rt.entry.auth_header == "Bearer tok"


class TestRouterProvider:
    """LocalInferenceProvider routes over the pool (no network)."""

    @pytest.fixture
    def routed(self, gw, monkeypatch):
        import app.pool as pool_mod
        from app.providers.local_inference_provider import LocalInferenceProvider

        pool = gw.BackendPool()
        pool._apply(_entries_json(OLLAMA, VLLM_A))
        pool.get("bundled-ollama").models = {"qwen3:4b"}
        pool.get("remote-vllm-a").models = {"meta-llama/Llama-3.1-8B"}
        # Delegates report healthy so `available` is True without probes.
        for rt in pool.runtimes():
            monkeypatch.setattr(type(rt.delegate), "is_available",
                                property(lambda self: True), raising=False)
        monkeypatch.setattr(pool_mod, "pool", pool)
        return LocalInferenceProvider(), pool

    def test_routes_to_catalog_owner(self, routed):
        provider, _ = routed
        rt, model = provider._route("meta-llama/Llama-3.1-8B")
        assert rt.entry.id == "remote-vllm-a"
        assert model == "meta-llama/Llama-3.1-8B"

    def test_unknown_cloud_model_substitutes_on_primary(self, routed):
        provider, _ = routed
        rt, model = provider._route("groq/llama-3.3-70b-versatile")
        assert rt.entry.id == "bundled-ollama"
        assert model == "qwen3:4b"

    def test_is_local_model_consults_pool(self, routed):
        provider, _ = routed
        assert provider.is_local_model("qwen3:4b")
        assert provider.is_local_model("meta-llama/Llama-3.1-8B")
        assert not provider.is_local_model("claude-sonnet-4-6")

    def test_not_ready_state_refuses(self, routed, gw):
        from nova_contracts.llm import CompleteRequest, Message
        provider, _ = routed
        provider._state = "draining"
        with pytest.raises(RuntimeError, match="not accepting"):
            provider._prepare(CompleteRequest(
                model="qwen3:4b",
                messages=[Message(role="user", content="hi")],
            ))
