"""
Regression tests: /api/v1/llm/models must return ALL available models per provider,
not just the single configured default.

Covers the bug where discoverModels() called /providers (one model per provider)
instead of /models/discover (full Ollama catalog).
"""
import os
import pathlib

import httpx
import pytest

AGENT_BASE = "http://localhost:8000"
GATEWAY_BASE = "http://localhost:8001"


def _get_secret() -> str:
    env_val = os.environ.get("NOVA_ADMIN_SECRET")
    if env_val:
        return env_val
    env_file = pathlib.Path(__file__).parent.parent / ".env"
    try:
        for line in env_file.read_text().splitlines():
            if line.startswith("NOVA_ADMIN_SECRET="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


HEADERS = {"X-Admin-Secret": _get_secret()}


def _models() -> list[dict]:
    r = httpx.get(f"{AGENT_BASE}/api/v1/llm/models", headers=HEADERS, timeout=10.0)
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
    return r.json()


def _providers_legacy() -> dict:
    r = httpx.get(f"{AGENT_BASE}/api/v1/llm/providers", headers=HEADERS, timeout=5.0)
    assert r.status_code == 200
    return r.json()


# ── Shape tests ──────────────────────────────────────────────────────────────

def test_models_endpoint_returns_list():
    data = _models()
    assert isinstance(data, list), f"Expected list, got {type(data)}"
    assert len(data) > 0, "No providers returned"


def test_each_provider_has_required_fields():
    for p in _models():
        assert "slug" in p, f"Missing 'slug': {p}"
        assert "name" in p
        assert "available" in p
        assert isinstance(p["available"], bool)
        assert "models" in p
        assert isinstance(p["models"], list)


def test_each_model_has_id_and_registered():
    for p in _models():
        for m in p["models"]:
            assert "id" in m, f"Model missing 'id' in provider {p.get('slug')}"
            assert isinstance(m["id"], str) and m["id"], "Model id must be non-empty string"
            assert "registered" in m


# ── Core regression: must return MORE than one model when Ollama has many ────

def test_local_provider_returns_all_ollama_models():
    """
    Regression: the old /providers endpoint returned exactly ONE model per provider.
    /api/v1/llm/models must return all models discovered from Ollama, not just
    the configured default.
    """
    providers = {p["slug"]: p for p in _models()}

    local = providers.get("ollama-host") or providers.get("ollama")
    if local is None:
        pytest.skip("No Ollama provider in discovery output")
    if not local["available"]:
        pytest.skip("Ollama not reachable — skipping model count check")

    model_ids = [m["id"] for m in local["models"]]
    assert len(model_ids) > 1, (
        f"Expected multiple Ollama models but got {len(model_ids)}: {model_ids}. "
        "Regression: /providers returns one model, /models/discover should return all."
    )


def test_models_endpoint_returns_more_than_providers_endpoint():
    """
    Total model count from /api/v1/llm/models must exceed the legacy
    /api/v1/llm/providers count (which returns exactly one per provider).
    """
    catalog = _models()
    legacy = _providers_legacy()

    catalog_total = sum(len(p["models"]) for p in catalog)
    legacy_total = len(legacy.get("providers", []))

    assert catalog_total > legacy_total, (
        f"Model catalog ({catalog_total} models) should exceed "
        f"legacy providers count ({legacy_total}). "
        "If they're equal, discovery is returning only one model per provider."
    )


def test_models_endpoint_requires_auth():
    """Unauthenticated request must be rejected."""
    r = httpx.get(f"{AGENT_BASE}/api/v1/llm/models", timeout=5.0)
    assert r.status_code in (401, 403), (
        f"Unauthenticated request should be rejected, got {r.status_code}"
    )


def test_refresh_param_accepted():
    r = httpx.get(
        f"{AGENT_BASE}/api/v1/llm/models?refresh=true",
        headers=HEADERS,
        timeout=15.0,
    )
    assert r.status_code == 200
    assert isinstance(r.json(), list)


# ── Resolve endpoint ──────────────────────────────────────────────────────────

def test_resolve_returns_a_model():
    r = httpx.get(f"{AGENT_BASE}/api/v1/llm/resolve", headers=HEADERS, timeout=5.0)
    if r.status_code == 503:
        pytest.skip("No models available")
    assert r.status_code == 200
    data = r.json()
    assert "model" in data and data["model"]
    assert "source" in data


def test_resolved_model_exists_in_catalog():
    """Resolved model must appear in the full catalog — not a phantom default."""
    resolve_r = httpx.get(f"{AGENT_BASE}/api/v1/llm/resolve", headers=HEADERS, timeout=5.0)
    if resolve_r.status_code == 503:
        pytest.skip("No models available")

    resolved = resolve_r.json()["model"]
    available_ids = {
        m["id"]
        for p in _models()
        if p["available"]
        for m in p["models"]
    }
    assert resolved in available_ids, (
        f"Resolved model '{resolved}' not in catalog: {sorted(available_ids)}"
    )


# ── Proxy parity: agent-core must not transform the gateway response ──────────

def test_agent_core_proxy_matches_gateway_directly():
    """
    /api/v1/llm/models must return the same provider+model data as
    the llm-gateway /models/discover endpoint directly.
    """
    via_proxy = _models()
    direct_r = httpx.get(f"{GATEWAY_BASE}/models/discover", timeout=10.0)
    assert direct_r.status_code == 200
    direct = direct_r.json()

    proxy_slugs = {p["slug"] for p in via_proxy}
    direct_slugs = {p["slug"] for p in direct}
    assert proxy_slugs == direct_slugs, (
        f"Provider slugs differ: proxy={proxy_slugs}, direct={direct_slugs}"
    )

    for slug in proxy_slugs:
        p_proxy = next(p for p in via_proxy if p["slug"] == slug)
        p_direct = next(p for p in direct if p["slug"] == slug)
        proxy_ids = {m["id"] for m in p_proxy["models"]}
        direct_ids = {m["id"] for m in p_direct["models"]}
        assert proxy_ids == direct_ids, (
            f"Model list differs for '{slug}': proxy={proxy_ids}, direct={direct_ids}"
        )
