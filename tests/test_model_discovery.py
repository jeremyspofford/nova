"""Integration tests for model discovery — requires llm-gateway running at localhost:8001."""
import httpx
import pytest

BASE = "http://localhost:8001"
VALID_BACKENDS = {"ollama-host", "ollama", "llamacpp", "vllm", "sglang", "lmstudio", "none"}
VALID_PROVIDER_TYPES = {"local", "paid", "free"}
CLOUD_SLUGS = {"anthropic", "openai", "gemini", "groq"}


def _discover() -> list[dict]:
    r = httpx.get(f"{BASE}/models/discover", timeout=10.0)
    assert r.status_code == 200
    return r.json()


def test_discover_endpoint_returns_list():
    providers = _discover()
    assert isinstance(providers, list)
    assert len(providers) > 0


def test_each_provider_has_required_fields():
    for provider in _discover():
        assert "slug" in provider, f"Provider missing 'slug': {provider}"
        assert "name" in provider
        assert "type" in provider
        assert provider["type"] in VALID_PROVIDER_TYPES, (
            f"Provider '{provider['slug']}' has unexpected type '{provider['type']}'"
        )
        assert "available" in provider
        assert isinstance(provider["available"], bool)
        assert "auth_methods" in provider
        assert isinstance(provider["auth_methods"], list)
        assert "models" in provider
        assert isinstance(provider["models"], list)


def test_unavailable_provider_has_no_models():
    for provider in _discover():
        if not provider["available"]:
            assert provider["models"] == [], (
                f"Provider '{provider['slug']}' is unavailable but returned models"
            )


def test_model_entries_have_required_fields():
    for provider in _discover():
        for model in provider["models"]:
            assert "id" in model, f"Model in {provider['slug']} missing 'id'"
            assert "registered" in model, f"Model {model.get('id')} missing 'registered'"
            assert isinstance(model["registered"], bool)


def test_known_cloud_providers_are_present():
    """All four cloud providers must appear in discovery (may be unavailable)."""
    slugs = {p["slug"] for p in _discover()}
    assert CLOUD_SLUGS.issubset(slugs), f"Missing cloud providers: {CLOUD_SLUGS - slugs}"


def test_active_local_backend_is_present():
    """The configured local backend must appear as a local-type provider."""
    providers = {p["slug"]: p for p in _discover()}
    local_providers = [p for p in providers.values() if p["type"] == "local"]
    assert len(local_providers) > 0, "No local provider found in discovery"
    local_slugs = {p["slug"] for p in local_providers}
    assert local_slugs.issubset(VALID_BACKENDS | {"none"}), (
        f"Unknown local provider slugs: {local_slugs - VALID_BACKENDS}"
    )


def test_local_provider_available_when_models_discovered():
    """A local provider marked available must have at least one model."""
    for p in _discover():
        if p["type"] == "local" and p["available"]:
            assert len(p["models"]) > 0, (
                f"Local provider '{p['slug']}' is available but has no models"
            )


def test_discover_refresh_param_accepted():
    """?refresh=true must still return 200 (bypasses cache)."""
    r = httpx.get(f"{BASE}/models/discover?refresh=true", timeout=10.0)
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_resolve_returns_model():
    r = httpx.get(f"{BASE}/models/resolve", timeout=10.0)
    if r.status_code == 503:
        pytest.skip("No models available — skip resolve test")
    assert r.status_code == 200
    data = r.json()
    assert "model" in data
    assert isinstance(data["model"], str)
    assert len(data["model"]) > 0
    assert "source" in data
    assert data["source"] in ("local", "cloud")


def test_resolve_returns_model_from_available_provider():
    """Resolved model must be discoverable via the discover endpoint."""
    resolve_r = httpx.get(f"{BASE}/models/resolve", timeout=10.0)
    if resolve_r.status_code == 503:
        pytest.skip("No models available — skip resolve test")

    resolved = resolve_r.json()["model"]
    available_ids = {
        m["id"]
        for p in _discover()
        if p["available"]
        for m in p["models"]
    }
    if not available_ids:
        pytest.skip("No available models discovered — skip correlation check")

    assert resolved in available_ids, (
        f"Resolved model '{resolved}' not found in available model IDs: {available_ids}"
    )
