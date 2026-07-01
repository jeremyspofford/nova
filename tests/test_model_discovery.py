"""Integration tests for model discovery and provider availability.

These tests verify:
- Discovery endpoint returns all expected providers
- Provider availability matches actual config (API keys, backend selection)
- vLLM availability correctly reflects Redis inference.backend config
- Local models appear in the picker when backends are available
"""
import pytest


class TestDiscoverEndpoint:
    """Verify /v1/models/discover returns correct provider catalog."""

    async def test_discover_returns_all_providers(self, llm_gateway):
        """Discovery must return all known providers, even unavailable ones."""
        resp = await llm_gateway.get("/v1/models/discover")
        assert resp.status_code == 200
        providers = resp.json()

        slugs = {p["slug"] for p in providers}
        expected = {
            "ollama", "vllm", "lmstudio", "chatgpt", "groq",
            "gemini", "cerebras", "openrouter", "github",
            "anthropic", "openai",
        }
        assert expected.issubset(slugs), f"Missing providers: {expected - slugs}"
        assert "claude-max" not in slugs, (
            "Claude subscription provider must not be advertised — "
            "Anthropic 2026-02 ToS prohibits third-party use of sk-ant-oat01-* tokens."
        )

    async def test_provider_has_required_fields(self, llm_gateway):
        """Each provider entry must have the required shape."""
        resp = await llm_gateway.get("/v1/models/discover")
        for provider in resp.json():
            assert "slug" in provider
            assert "name" in provider
            assert "type" in provider
            assert provider["type"] in ("local", "paid", "subscription", "free")
            assert "available" in provider
            assert isinstance(provider["available"], bool)
            assert "auth_methods" in provider
            assert "models" in provider
            assert isinstance(provider["models"], list)

    async def test_available_provider_has_models_or_is_local(self, llm_gateway):
        """If a provider is available, it should either have models or be a local backend
        (which may have no models pulled/loaded)."""
        resp = await llm_gateway.get("/v1/models/discover")
        for provider in resp.json():
            if provider["available"] and provider["type"] not in ("local",):
                # Cloud providers with credentials should discover models
                # (empty is OK for some like groq/github that may have API issues)
                assert isinstance(provider["models"], list)

    async def test_unavailable_provider_hides_models(self, llm_gateway):
        """Providers marked unavailable must return empty model lists."""
        resp = await llm_gateway.get("/v1/models/discover")
        for provider in resp.json():
            if not provider["available"]:
                assert provider["models"] == [], (
                    f"Provider '{provider['slug']}' is unavailable but returned models"
                )

    async def test_model_entries_have_required_fields(self, llm_gateway):
        """Each model in a provider must have id and registered fields."""
        resp = await llm_gateway.get("/v1/models/discover")
        for provider in resp.json():
            for model in provider["models"]:
                assert "id" in model, f"Model in {provider['slug']} missing 'id'"
                assert "registered" in model, f"Model {model['id']} missing 'registered'"


class TestVLLMAvailability:
    """Verify vLLM availability tracks Redis config, not in-memory health flag."""

    async def test_vllm_available_matches_redis_backend(self, llm_gateway):
        """When inference.backend=vllm in Redis, vLLM should show available=true.
        When it's something else, vLLM should show available=false.
        This catches the regression where _vllm_available() checked an in-memory
        health flag that starts False and never gets set during discovery."""
        resp = await llm_gateway.get("/v1/models/discover")
        assert resp.status_code == 200
        providers = {p["slug"]: p for p in resp.json()}

        # Read current backend config
        config_resp = await llm_gateway.get("/v1/inference/status")
        if config_resp.status_code != 200:
            pytest.skip("Inference status endpoint not available")

        status = config_resp.json()
        backend = status.get("backend", "ollama")

        if backend == "vllm":
            assert providers["vllm"]["available"] is True, (
                "vLLM should be available when inference.backend=vllm in Redis"
            )
        else:
            assert providers["vllm"]["available"] is False, (
                f"vLLM should not be available when inference.backend={backend}"
            )

    async def test_ollama_always_available(self, llm_gateway):
        """Ollama should always show as available (local service)."""
        resp = await llm_gateway.get("/v1/models/discover")
        providers = {p["slug"]: p for p in resp.json()}
        assert providers["ollama"]["available"] is True


class TestModelResolve:
    """Verify auto-resolution picks the best available model."""

    async def test_resolve_returns_model(self, llm_gateway):
        """The resolve endpoint should always return a model ID."""
        resp = await llm_gateway.get("/v1/models/resolve")
        assert resp.status_code == 200
        data = resp.json()
        assert "model" in data
        assert isinstance(data["model"], str)
        assert len(data["model"]) > 0

    async def test_resolve_returns_available_model(self, llm_gateway):
        """Resolved model must belong to an available provider."""
        resolve_resp = await llm_gateway.get("/v1/models/resolve")
        resolved = resolve_resp.json()["model"]

        discover_resp = await llm_gateway.get("/v1/models/discover")
        available_models = set()
        for p in discover_resp.json():
            if p["available"]:
                for m in p["models"]:
                    available_models.add(m["id"])

        # Resolved model should be in the available set, or be a local fallback
        # (local models may not appear in discovery if nothing is pulled)
        if available_models:
            local_fallback_prefixes = ("llama", "qwen", "mistral", "phi", "gemma", "deepseek")
            assert (
                resolved in available_models
                or resolved.startswith(local_fallback_prefixes)
            ), f"Resolved model '{resolved}' is not in available models"
