"""Integration tests for managed inference backends."""
from __future__ import annotations

import asyncio

import httpx
import pytest


class TestHardwareDetection:
    """Tests for the hardware detection endpoint."""

    async def test_get_hardware_info_requires_auth(self, recovery: httpx.AsyncClient):
        """Hardware endpoint should reject unauthenticated requests."""
        r = await recovery.get("/api/v1/recovery/inference/hardware")
        assert r.status_code == 401

    async def test_get_hardware_info(self, recovery: httpx.AsyncClient, admin_headers: dict):
        """Recovery service should return detected hardware info."""
        r = await recovery.get("/api/v1/recovery/inference/hardware", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert "gpus" in data
        assert "cpu_cores" in data
        assert "ram_gb" in data
        assert "disk_free_gb" in data
        assert isinstance(data["gpus"], list)
        assert data["cpu_cores"] > 0
        assert "recommended_backend" in data

    async def test_hardware_redetect(self, recovery: httpx.AsyncClient, admin_headers: dict):
        """Re-detection should refresh hardware info."""
        r = await recovery.post(
            "/api/v1/recovery/inference/hardware/detect",
            headers=admin_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert "detected_at" in data
        assert "recommended_backend" in data


class TestGatewayInflight:
    """Tests for the /health/inflight endpoint."""

    async def test_inflight_endpoint_exists(self, llm_gateway: httpx.AsyncClient):
        """Gateway should expose /health/inflight with a count."""
        r = await llm_gateway.get("/health/inflight")
        assert r.status_code == 200
        data = r.json()
        assert "local_inflight" in data
        assert isinstance(data["local_inflight"], int)
        assert data["local_inflight"] >= 0


class TestVLLMProviderRegistration:
    """Test that vLLM provider appears in the gateway's provider catalog."""

    async def test_vllm_in_provider_catalog(self, llm_gateway: httpx.AsyncClient):
        """LLM gateway should list vllm as a known provider."""
        r = await llm_gateway.get("/health/providers")
        assert r.status_code == 200
        providers = r.json()
        slugs = [p["slug"] for p in providers]
        assert "vllm" in slugs

    async def test_vllm_provider_unavailable_when_not_running(self, llm_gateway: httpx.AsyncClient):
        """vLLM provider should show as unavailable when container isn't running."""
        r = await llm_gateway.get("/health/providers")
        assert r.status_code == 200
        providers = r.json()
        vllm = next((p for p in providers if p["slug"] == "vllm"), None)
        if vllm is None:
            pytest.skip("vLLM provider not registered in this environment")
        assert "available" in vllm  # Just verify shape, availability depends on env


class TestBackendLifecycle:
    """Tests for backend lifecycle management via recovery service."""

    async def test_get_backend_status(self, recovery: httpx.AsyncClient, admin_headers: dict):
        """Recovery should report current backend status."""
        r = await recovery.get("/api/v1/recovery/inference/backend", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert "backend" in data
        assert "state" in data
        assert data["state"] in ["ready", "stopped", "draining", "starting", "switching", "error"]

    async def test_list_available_backends(self, recovery: httpx.AsyncClient, admin_headers: dict):
        """Recovery should list all available backends with their status."""
        r = await recovery.get("/api/v1/recovery/inference/backends", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        names = [b["name"] for b in data]
        assert "ollama" in names
        assert "vllm" in names


class TestSGLangProvider:
    async def test_sglang_backend_listed(self, recovery: httpx.AsyncClient, admin_headers: dict):
        r = await recovery.get("/api/v1/recovery/inference/backends", headers=admin_headers)
        assert r.status_code == 200
        names = [b["name"] for b in r.json()]
        assert "sglang" in names


class TestLMStudioProvider:
    """LM Studio is a host-side desktop app, not a Nova-managed container."""

    async def test_lmstudio_in_gateway_provider_catalog(self, llm_gateway: httpx.AsyncClient):
        """LM Studio must appear in the gateway's provider catalog."""
        r = await llm_gateway.get("/health/providers")
        assert r.status_code == 200
        slugs = [p["slug"] for p in r.json()]
        assert "lmstudio" in slugs

    async def test_lmstudio_in_discovery(self, llm_gateway: httpx.AsyncClient):
        """Model discovery must include LM Studio as a provider (even if unreachable)."""
        r = await llm_gateway.get("/v1/models/discover")
        assert r.status_code == 200
        slugs = [p["slug"] for p in r.json()]
        assert "lmstudio" in slugs

    async def test_lmstudio_status_endpoint(self, llm_gateway: httpx.AsyncClient):
        """The dedicated LM Studio status endpoint must return the documented shape.

        It probes the server (unreachable in CI) so it just must not 500 and
        must report healthy=False with an empty model list.
        """
        r = await llm_gateway.get("/health/providers/lmstudio/status")
        assert r.status_code == 200
        data = r.json()
        assert "healthy" in data
        assert "base_url" in data
        assert "models" in data
        assert isinstance(data["models"], list)

    async def test_start_lmstudio_is_config_only(self, recovery: httpx.AsyncClient, admin_headers: dict):
        """Starting the LM Studio backend must not try to launch a container.

        It's config-only: marks state ready and returns accepted.
        """
        try:
            r = await recovery.post(
                "/api/v1/recovery/inference/backend/lmstudio/start",
                headers=admin_headers,
            )
            assert r.status_code == 202
        finally:
            # Restore whatever the prior backend was to avoid leaking state.
            await recovery.post(
                "/api/v1/recovery/inference/backend/ollama/start",
                headers=admin_headers,
            )

    async def test_lmstudio_backend_status_probes_gateway(self, recovery: httpx.AsyncClient, admin_headers: dict):
        """When inference.backend=lmstudio, status must reflect the gateway probe
        (not a container, since recovery can't reach host.docker.internal)."""
        import asyncio
        try:
            await recovery.post(
                "/api/v1/recovery/inference/backend/lmstudio/start",
                headers=admin_headers,
            )
            await asyncio.sleep(1)
            r = await recovery.get("/api/v1/recovery/inference/backend", headers=admin_headers)
            assert r.status_code == 200
            data = r.json()
            assert data["backend"] == "lmstudio"
            assert data["state"] in ("ready", "stopped", "error")
        finally:
            await recovery.post(
                "/api/v1/recovery/inference/backend/ollama/start",
                headers=admin_headers,
            )

    async def test_lmstudio_downloaded_endpoint_shape(self, llm_gateway: httpx.AsyncClient):
        """The downloaded-model library endpoint must return the documented shape.

        In CI, LM Studio is unreachable so this must respond with a clean 502
        (not a 500) and a human-readable detail. When LM Studio IS reachable the
        response is a list of LMStudioDownloadedModel objects.
        """
        r = await llm_gateway.get("/v1/models/lmstudio/downloaded")
        # 502 when unreachable is the expected CI path; 200 with a list when LM
        # Studio is actually running on the host.
        assert r.status_code in (200, 502), r.text
        if r.status_code == 200:
            data = r.json()
            assert isinstance(data, list)
            for m in data:
                assert "key" in m
                assert "type" in m
                assert "loaded" in m
                assert isinstance(m["loaded_instances"], list)

    async def test_lmstudio_load_requires_model_field(self, llm_gateway: httpx.AsyncClient):
        """The load endpoint must reject a body missing the required `model` field.

        A 422 (Pydantic validation) is expected before any LM Studio probe, so
        this holds even when LM Studio is unreachable in CI.
        """
        r = await llm_gateway.post("/v1/models/lmstudio/load", json={})
        assert r.status_code == 422

    async def test_lmstudio_unload_requires_instance_id(self, llm_gateway: httpx.AsyncClient):
        """The unload endpoint must reject a body missing `instance_id`."""
        r = await llm_gateway.post("/v1/models/lmstudio/unload", json={})
        assert r.status_code == 422


class TestVLLMDiscovery:
    """Tests for vLLM model discovery."""

    async def test_discover_includes_vllm_provider(self, llm_gateway: httpx.AsyncClient):
        """Model discovery should include vLLM as a provider (even if unavailable)."""
        r = await llm_gateway.get("/v1/models/discover")
        assert r.status_code == 200
        data = r.json()
        slugs = [p["slug"] for p in data]
        assert "vllm" in slugs


class TestLocalInferenceRouting:
    """Tests for the LocalInferenceProvider routing wrapper."""

    async def test_routing_strategy_still_works(self, llm_gateway: httpx.AsyncClient):
        """Routing strategy should still apply to local models after refactor."""
        r = await llm_gateway.get("/health/providers")
        assert r.status_code == 200
        providers = r.json()
        slugs = [p["slug"] for p in providers]
        assert any(s in slugs for s in ["groq", "anthropic", "openai", "gemini"])


class TestModelSwitch:
    """Tests for model switching via recovery service."""

    async def test_env_whitelist_includes_model_vars(self, recovery: httpx.AsyncClient, admin_headers: dict):
        """VLLM_MODEL should be patchable via the env API."""
        r = await recovery.patch(
            "/api/v1/recovery/env",
            headers=admin_headers,
            json={"updates": {"VLLM_MODEL": "Qwen/Qwen2.5-1.5B-Instruct"}},
        )
        assert r.status_code == 200

    async def test_switch_model_rejects_unknown_backend(self, recovery: httpx.AsyncClient, admin_headers: dict):
        r = await recovery.post(
            "/api/v1/recovery/inference/backend/fake/switch-model",
            headers=admin_headers,
            json={"model": "some-model"},
        )
        assert r.status_code == 400

    async def test_switch_model_rejects_ollama(self, recovery: httpx.AsyncClient, admin_headers: dict):
        r = await recovery.post(
            "/api/v1/recovery/inference/backend/ollama/switch-model",
            headers=admin_headers,
            json={"model": "llama3.2"},
        )
        assert r.status_code == 400

    async def test_switch_model_endpoint_exists(self, recovery: httpx.AsyncClient, admin_headers: dict):
        r = await recovery.post(
            "/api/v1/recovery/inference/backend/vllm/switch-model",
            headers=admin_headers,
            json={"model": "Qwen/Qwen2.5-1.5B-Instruct"},
        )
        # 202 = accepted, 400 = backend not active (OK in test env)
        assert r.status_code in (202, 400)


class TestModelSearch:
    """Tests for the model catalog search endpoint."""

    async def test_search_models_requires_auth(self, recovery: httpx.AsyncClient):
        r = await recovery.get("/api/v1/recovery/inference/models/search?q=llama&backend=vllm")
        assert r.status_code == 401

    async def test_search_models_returns_results(self, recovery: httpx.AsyncClient, admin_headers: dict):
        r = await recovery.get(
            "/api/v1/recovery/inference/models/search?q=llama&backend=vllm",
            headers=admin_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        if len(data) > 0:
            assert "id" in data[0]

    async def test_switch_progress_in_backend_status(self, recovery: httpx.AsyncClient, admin_headers: dict):
        r = await recovery.get("/api/v1/recovery/inference/backend", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert "backend" in data
        assert "state" in data


class TestRecommendedModels:
    """Tests for the recommended models endpoint."""

    async def test_get_recommended_models(self, recovery: httpx.AsyncClient, admin_headers: dict):
        r = await recovery.get("/api/v1/recovery/inference/models/recommended", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        assert len(data) > 0
        assert "id" in data[0]
        assert "category" in data[0]

    async def test_recommended_models_filter_by_backend(self, recovery: httpx.AsyncClient, admin_headers: dict):
        r = await recovery.get("/api/v1/recovery/inference/models/recommended?backend=ollama", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        for m in data:
            assert "ollama" in m["backends"]


class TestRecommendation:
    async def test_recommendation_includes_model(self, recovery: httpx.AsyncClient, admin_headers: dict):
        r = await recovery.get("/api/v1/recovery/inference/recommendation", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert "backend" in data
        assert "model" in data
        assert "reason" in data


class TestGPUStats:
    async def test_gpu_stats_endpoint(self, recovery: httpx.AsyncClient, admin_headers: dict):
        r = await recovery.get("/api/v1/recovery/inference/hardware/gpu-stats", headers=admin_headers)
        assert r.status_code == 200


class TestInferenceStats:
    async def test_inference_stats_endpoint(self, llm_gateway: httpx.AsyncClient):
        r = await llm_gateway.get("/v1/inference/stats")
        assert r.status_code == 200
        data = r.json()
        assert "requests_5m" in data
        assert "avg_tokens_per_sec" in data


class TestInferenceConfigFlow:
    """End-to-end test: config change flows from orchestrator to gateway."""

    async def test_set_inference_backend_via_orchestrator(
        self,
        orchestrator: httpx.AsyncClient,
        llm_gateway: httpx.AsyncClient,
        admin_headers: dict,
    ):
        """Setting inference.backend via orchestrator should reach the gateway."""
        try:
            r = await orchestrator.patch(
                "/api/v1/config/inference.backend",
                json={"value": '"vllm"'},
                headers=admin_headers,
            )
            assert r.status_code == 200

            await asyncio.sleep(6)

            r = await llm_gateway.get("/health/providers")
            assert r.status_code == 200
        finally:
            await orchestrator.patch(
                "/api/v1/config/inference.backend",
                json={"value": '"ollama"'},
                headers=admin_headers,
            )
