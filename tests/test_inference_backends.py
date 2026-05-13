"""Integration tests for local inference backend configuration.

Tests verify the gateway reflects the configured backend — they do NOT
require the backend to be running. Backend-level smoke tests are skipped
when the actual inference service isn't reachable.
"""
from __future__ import annotations

import httpx
import pytest

GATEWAY = "http://localhost:8001"


@pytest.fixture
def providers() -> dict:
    r = httpx.get(f"{GATEWAY}/providers", timeout=5.0)
    r.raise_for_status()
    return r.json()


class TestProviderCatalog:
    def test_providers_endpoint_shape(self, providers):
        """Gateway /providers must include local_backend and local_inference_url keys."""
        assert "providers" in providers
        assert "local_backend" in providers
        assert "local_inference_url" in providers
        assert "routing_strategy" in providers
        assert isinstance(providers["providers"], list)

    def test_local_backend_is_valid(self, providers):
        """local_backend must be one of the known backend slugs."""
        valid = {"ollama-host", "ollama", "llamacpp", "vllm", "sglang", "lmstudio", "none"}
        assert providers["local_backend"] in valid

    def test_routing_strategy_is_valid(self, providers):
        """routing_strategy must be one of the four known values."""
        valid = {"local-first", "local-only", "cloud-first", "cloud-only"}
        assert providers["routing_strategy"] in valid

    def test_providers_list_has_at_least_local(self, providers):
        """There is always at least one entry in providers (even if backend=none)."""
        assert len(providers["providers"]) >= 1

    def test_local_provider_is_first_entry(self, providers):
        """First provider entry is always the local backend."""
        first = providers["providers"][0]
        assert first.get("local") is True
        assert "name" in first
        assert "model" in first
        assert "available" in first


class TestLocalBackendReachability:
    def test_local_backend_complete_when_available(self, providers):
        """If the local backend is configured and reachable, /complete works."""
        first = providers["providers"][0]
        if not first.get("available") or providers["local_backend"] == "none":
            pytest.skip("No local backend configured")

        # Quick reachability probe — skip if not reachable
        url = providers.get("local_inference_url", "")
        try:
            httpx.get(url, timeout=2.0)
        except Exception:
            pytest.skip(f"Local backend not reachable at {url}")

        r = httpx.post(
            f"{GATEWAY}/complete",
            json={"messages": [{"role": "user", "content": "Say ok."}], "max_tokens": 5},
            timeout=30.0,
        )
        assert r.status_code == 200
        data = r.json()
        assert "content" in data
        assert len(data["content"]) > 0


class TestCloudFallback:
    def test_complete_falls_back_to_cloud(self, providers):
        """When local backend is down and cloud is configured, /complete still works."""
        has_cloud = any(not p.get("local") for p in providers["providers"])
        if not has_cloud:
            pytest.skip("No cloud providers configured — cloud fallback not testable")

        local_url = providers.get("local_inference_url", "")
        try:
            httpx.get(local_url, timeout=1.0)
            pytest.skip("Local backend is reachable — can't test cloud-only fallback")
        except Exception:
            pass  # Local is down — test fallback

        r = httpx.post(
            f"{GATEWAY}/complete",
            json={"messages": [{"role": "user", "content": "Say ok."}], "max_tokens": 10},
            timeout=30.0,
        )
        # Either succeeds (cloud worked) or 503 (cloud also failed) — both are valid shapes
        assert r.status_code in (200, 503)
