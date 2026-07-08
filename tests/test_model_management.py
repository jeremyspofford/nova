"""Integration tests for model management: recommendations (local + cloud),
loaded-state reporting, and the local-provider test routing."""
import os

import httpx
import pytest

RECOVERY = os.getenv("NOVA_RECOVERY_URL", "http://localhost:8888")
GATEWAY = os.getenv("NOVA_LLM_GATEWAY_URL", "http://localhost:8001")
ADMIN_SECRET = os.getenv("NOVA_ADMIN_SECRET", "nova-admin-secret-change-me")
_HDRS = {"X-Admin-Secret": ADMIN_SECRET}


@pytest.mark.asyncio
async def test_recommended_curated_local():
    """Curated Ollama recommendations carry pull ids + sizes."""
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(
            f"{RECOVERY}/api/v1/recovery/inference/models/recommended?backend=ollama",
            headers=_HDRS,
        )
        assert r.status_code == 200, r.text
        models = r.json()
        assert isinstance(models, list) and models
        assert all("ollama" in m.get("backends", []) for m in models)
        # the curated starter is present
        assert any(m.get("starter") for m in models)


@pytest.mark.asyncio
async def test_recommended_popular_has_sizes():
    """The live popularity source, when reachable, carries real sizes."""
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(
            f"{RECOVERY}/api/v1/recovery/inference/models/recommended"
            "?backend=ollama&source=popular",
            headers=_HDRS,
        )
        assert r.status_code == 200, r.text
        models = r.json()
        assert isinstance(models, list)
        if not models:
            pytest.skip("live ollama.com catalog unavailable")
        # at least some entries enriched with registry sizes + param variants
        assert any(m.get("size_gb") for m in models)


@pytest.mark.asyncio
async def test_recommended_cloud_pricing():
    """Cloud recommendations expose per-Mtok pricing grouped by job."""
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(
            f"{RECOVERY}/api/v1/recovery/inference/models/recommended-cloud",
            headers=_HDRS,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert "models" in data
        for m in data["models"]:
            assert {"provider", "model", "job"} <= m.keys()
            assert "input_per_mtok" in m and "output_per_mtok" in m


@pytest.mark.asyncio
async def test_inference_loaded_shape():
    """The loaded-state endpoint reports the active backend + a model list."""
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{GATEWAY}/v1/health/inference/loaded")
        assert r.status_code == 200, r.text
        d = r.json()
        assert {"backend", "healthy", "loaded_models"} <= d.keys()
        assert isinstance(d["loaded_models"], list)


@pytest.mark.asyncio
async def test_ollama_pulled_has_loaded_flag():
    """Pulled Ollama models carry an accurate `loaded` boolean (from /api/ps)."""
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(f"{GATEWAY}/v1/models/ollama/pulled")
        if r.status_code == 502:
            pytest.skip("Ollama unreachable")
        assert r.status_code == 200, r.text
        for m in r.json():
            assert isinstance(m.get("loaded"), bool)
