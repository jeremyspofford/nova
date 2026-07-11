"""Unit tests for validated model discovery + assignment checking.

Covers the model-reliability work: provider key verdicts from real API
responses (401 → invalid_key, not "no models"), auto-resolve skipping dead
providers, and the orchestrator's assignment cross-check. No services needed.

Run:
    cd tests && uv run --with-requirements requirements.txt pytest test_model_validation.py -v
"""
from __future__ import annotations

import asyncio

import httpx
import pytest
from _service_app import service_app


@pytest.fixture
def disc():
    with service_app("llm-gateway") as import_module:
        yield import_module("app.discovery")


def _http_error(code: int, body: str = "") -> httpx.HTTPStatusError:
    req = httpx.Request("GET", "https://api.example.com/v1/models")
    resp = httpx.Response(code, request=req, text=body)
    return httpx.HTTPStatusError(f"HTTP {code}", request=req, response=resp)


# ── Error classification ──────────────────────────────────────────────────────

def test_classify_401_as_invalid_key(disc):
    status, detail = disc._classify_discovery_error(_http_error(401, '{"error":"User not found"}'))
    assert status == "invalid_key"
    assert "401" in detail and "User not found" in detail


def test_classify_403_as_invalid_key(disc):
    status, _ = disc._classify_discovery_error(_http_error(403))
    assert status == "invalid_key"


def test_classify_5xx_and_timeout_as_error(disc):
    assert disc._classify_discovery_error(_http_error(503))[0] == "error"
    assert disc._classify_discovery_error(asyncio.TimeoutError())[0] == "error"
    assert disc._classify_discovery_error(RuntimeError("dns fail"))[0] == "error"


# ── _discover_provider verdicts ───────────────────────────────────────────────

@pytest.fixture
def no_cache(disc, monkeypatch):
    """Disable the Redis cache (reads and writes are already best-effort)."""
    async def broken_redis():
        raise RuntimeError("no redis in unit tests")
    monkeypatch.setattr(disc, "_get_redis", broken_redis)


def test_rejected_key_reports_invalid(disc, no_cache, monkeypatch):
    async def configured(slug):
        return True
    async def probe():
        raise _http_error(401, "User not found")
    monkeypatch.setattr(disc, "_is_provider_configured", configured)
    monkeypatch.setitem(disc._DISCOVERY_FNS, "openrouter", probe)

    result = asyncio.run(disc._discover_provider("openrouter"))
    assert result.key_status == "invalid_key"
    assert result.models == []


def test_missing_key_reports_not_configured(disc, no_cache, monkeypatch):
    async def configured(slug):
        return False
    monkeypatch.setattr(disc, "_is_provider_configured", configured)

    result = asyncio.run(disc._discover_provider("groq"))
    assert result.key_status == "not_configured"


def test_working_provider_reports_ok_with_models(disc, no_cache, monkeypatch):
    async def configured(slug):
        return True
    async def probe():
        return [disc.DiscoveredModel(id="groq/llama-3.3-70b-versatile", registered=True)]
    monkeypatch.setattr(disc, "_is_provider_configured", configured)
    monkeypatch.setitem(disc._DISCOVERY_FNS, "groq", probe)

    result = asyncio.run(disc._discover_provider("groq"))
    assert result.key_status == "ok"
    assert [m.id for m in result.models] == ["groq/llama-3.3-70b-versatile"]


# ── resolve_auto_model uses validity, not key presence ────────────────────────

def test_auto_resolve_skips_dead_and_stale_providers(disc, monkeypatch):
    async def statuses():
        return {
            # Key present but rejected — the old code would have picked this.
            "anthropic": disc.ProviderDiscovery(key_status="invalid_key"),
            "openai": disc.ProviderDiscovery(key_status="not_configured"),
            "chatgpt": disc.ProviderDiscovery(key_status="not_configured"),
            "gemini": disc.ProviderDiscovery(key_status="error", detail="timeout"),
            # Working provider whose list contains the preference model.
            "groq": disc.ProviderDiscovery(
                key_status="ok",
                models=[disc.DiscoveredModel(id="groq/llama-3.3-70b-versatile")],
            ),
            # Working but the preference-list model was retired — must skip.
            "cerebras": disc.ProviderDiscovery(
                key_status="ok",
                models=[disc.DiscoveredModel(id="cerebras/qwen-3-32b")],
            ),
        }
    monkeypatch.setattr(disc, "provider_key_statuses", statuses)

    assert asyncio.run(disc.resolve_auto_model()) == "groq/llama-3.3-70b-versatile"


# ── Orchestrator assignment cross-check ──────────────────────────────────────

@pytest.fixture
def assign():
    with service_app("orchestrator") as import_module:
        yield import_module("app.model_assignments")


_CATALOG = [
    {"slug": "groq", "name": "Groq", "type": "free", "available": True,
     "key_status": "ok", "detail": "",
     "models": [{"id": "groq/llama-3.3-70b-versatile"}]},
    {"slug": "cerebras", "name": "Cerebras", "type": "free", "available": False,
     "key_status": "invalid_key", "detail": "provider rejected the credential",
     "models": []},
    {"slug": "ollama", "name": "Ollama", "type": "local", "available": True,
     "key_status": "ok", "detail": "",
     "models": [{"id": "qwen2.5:7b"}, {"id": "openbmb/minicpm5:latest"}]},
]


def test_assignment_checks(assign):
    check = assign._check_assignment
    assert check("auto", _CATALOG)[0] == "auto"
    assert check("", _CATALOG)[0] == "auto"
    assert check("tier:cheap", _CATALOG)[0] == "auto"
    assert check("groq/llama-3.3-70b-versatile", _CATALOG)[0] == "ok"
    # Cloud model the provider doesn't list → unknown_model
    assert check("groq/retired-model", _CATALOG)[0] == "unknown_model"
    # Provider whose key is rejected → provider_unavailable, with the verdict in the note
    status, note = check("cerebras/llama3.1-8b", _CATALOG)
    assert status == "provider_unavailable"
    assert "invalid_key" in note
    # Local models: pulled → ok; not pulled → unknown_model
    assert check("qwen2.5:7b", _CATALOG)[0] == "ok"
    assert check("openbmb/minicpm5:latest", _CATALOG)[0] == "ok"
    assert check("phi4", _CATALOG)[0] == "unknown_model"


def test_assignment_no_local_backend(assign):
    catalog = [p for p in _CATALOG if p["slug"] != "ollama"]
    status, note = assign._check_assignment("qwen2.5:7b", catalog)
    assert status == "provider_unavailable"
