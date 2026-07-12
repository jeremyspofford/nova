"""
Dynamic model discovery — queries provider APIs to find actually-available models.

Results are cached in Redis (5-min TTL) and returned as a per-provider catalog
with auth method metadata so the dashboard can guide unconfigured users.

Endpoints:
    GET  /models/discover       — full provider catalog with discovered models
    GET  /models/resolve        — resolve "auto" to best available model
    GET  /models/ollama/pulled  — Ollama pulled models with size/details
    POST /models/ollama/pull    — pull a model into Ollama
    DELETE /models/ollama/{name} — delete a pulled Ollama model
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING, Any

import httpx
import redis.asyncio as aioredis
from app.config import settings
from app.secrets_runtime import effective_key

if TYPE_CHECKING:
    from app.providers.base import ModelProvider
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger(__name__)

discovery_router = APIRouter(prefix="/models", tags=["discovery"])

_CACHE_TTL = 300  # 5 minutes for successful discoveries
_FAILURE_CACHE_TTL = 30  # 30 seconds for timeouts/errors — faster recovery
_DISCOVERY_TIMEOUT = 5.0  # per-provider timeout (was 10.0)
_PULL_TIMEOUT = 600.0  # 10 minutes for model pulls

_redis: aioredis.Redis | None = None


async def _get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


async def close_redis() -> None:
    """Close the module-level Redis connection. Call at shutdown."""
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None


# ── Auth method metadata per provider ─────────────────────────────────────────

AUTH_METHODS: dict[str, list[str]] = {
    "ollama": ["Always available (local)"],
    "vllm": ["Available when vLLM is the active inference backend"],
    "lmstudio": [
        "Start LM Studio \u2192 Developer \u2192 Start Server (port 1234)",
        "Set inference.lmstudio_url if LM Studio is not on the host",
        "Optional: inference.lmstudio_api_key if you enabled server auth",
    ],
    "chatgpt": [
        "CHATGPT_ACCESS_TOKEN env var",
        "~/.codex/auth.json (auto-detected after `codex login`)",
    ],
    "groq": ["GROQ_API_KEY env var — get free at console.groq.com"],
    "gemini": [
        "GEMINI_API_KEY env var — get free at aistudio.google.com",
        "gcloud ADC (~/.config/gcloud) — set GEMINI_USE_ADC=true",
    ],
    "cerebras": ["CEREBRAS_API_KEY env var — get free at cloud.cerebras.ai"],
    "openrouter": ["OPENROUTER_API_KEY env var — get free at openrouter.ai"],
    "github": ["GITHUB_TOKEN env var — any GitHub PAT with Models permission"],
    "anthropic": ["ANTHROPIC_API_KEY env var — console.anthropic.com"],
    "openai": ["OPENAI_API_KEY env var — platform.openai.com"],
}


# ── Response models ───────────────────────────────────────────────────────────

class DiscoveredModel(BaseModel):
    id: str
    registered: bool = False


# Key/reachability verdict per provider, from a REAL API call (not key presence):
#   ok             — the provider answered an authenticated request
#   not_configured — no credential (or inactive local backend); nothing probed
#   invalid_key    — provider rejected the credential (401/403)
#   error          — configured but unreachable/failed (timeout, 5xx, DNS)
KeyStatus = str  # "ok" | "not_configured" | "invalid_key" | "error" | "unknown"


class ProviderDiscovery(BaseModel):
    """Cached per-provider discovery result — models plus key validity."""
    models: list[DiscoveredModel] = []
    key_status: KeyStatus = "unknown"
    detail: str = ""  # short human-readable failure/context note


class ProviderModelList(BaseModel):
    slug: str
    name: str
    type: str  # local | subscription | free | paid
    available: bool  # key_status == "ok" — the provider actually answered
    key_status: KeyStatus = "unknown"
    detail: str = ""
    auth_methods: list[str]
    models: list[DiscoveredModel]


class OllamaPulledModel(BaseModel):
    name: str
    size: int  # bytes
    parameter_size: str
    quantization_level: str
    digest: str
    modified_at: str
    loaded: bool = False  # currently resident in memory (from /api/ps)


class PullRequest(BaseModel):
    name: str


# ── LM Studio downloaded-model library (native v1 REST API) ─────────────────────
#
# LM Studio exposes two model-listing concepts:
#   • GET /v1/models          (OpenAI-compatible) → currently LOADED models only
#   • GET /api/v1/models       (native v1, LM Studio 0.4.0+) → all DOWNLOADED
#     models with rich metadata (quant, size, context, capabilities, variants)
#     and a `loaded_instances` array showing which are live right now.
#
# The downloaded list powers the "models library" UI: users see everything
# they have in LM Studio (loaded or not) and can load/unload on demand via
# POST /api/v1/models/load and /unload. We gracefully fall back to the
# OpenAI-compatible endpoint on older LM Studio builds that predate the v1
# native API — those entries come back as loaded-only with minimal metadata.

class LMStudioDownloadedModel(BaseModel):
    key: str  # unique model identifier (used for load)
    type: str  # "llm" | "embedding"
    publisher: str
    display_name: str
    architecture: str | None = None
    quantization: str | None = None
    bits_per_weight: float | None = None
    size_bytes: int = 0
    params_string: str | None = None
    loaded: bool = False
    loaded_instances: list[str] = []  # instance_ids of live loads
    max_context_length: int | None = None
    format: str | None = None  # "gguf" | "mlx" | null
    supports_vision: bool = False
    supports_tools: bool = False
    variants: list[str] = []
    selected_variant: str | None = None


class LMStudioLoadRequest(BaseModel):
    model: str  # the model key to load
    context_length: int | None = None
    flash_attention: bool | None = None
    eval_batch_size: int | None = None
    num_experts: int | None = None
    offload_kv_cache_to_gpu: bool | None = None


class LMStudioUnloadRequest(BaseModel):
    instance_id: str


# ── Auto-registration helper ──────────────────────────────────────────────────

def _ensure_registered(model_id: str, provider: "ModelProvider") -> None:
    """Register a discovered model in MODEL_REGISTRY if not already present.

    This ensures that dynamically discovered models (from provider APIs) are
    routable, not just visible.  The provider's own auth gating guarantees we
    only register models the user actually has access to.
    """
    from app.registry import DEFAULT_MODEL_KEY, MODEL_REGISTRY
    if model_id not in MODEL_REGISTRY and model_id != DEFAULT_MODEL_KEY:
        MODEL_REGISTRY[model_id] = provider
        log.debug("Auto-registered discovered model: %s", model_id)


# ── Per-provider discovery coroutines ─────────────────────────────────────────

async def _discover_ollama() -> list[DiscoveredModel]:
    """List pulled Ollama models via /api/tags."""
    from app.registry import get_ollama_base_url
    ollama_url = await get_ollama_base_url()
    async with httpx.AsyncClient(base_url=ollama_url, timeout=_DISCOVERY_TIMEOUT) as client:
        resp = await client.get("/api/tags")
        resp.raise_for_status()
        data = resp.json()
        return [
            DiscoveredModel(id=m["name"], registered=True)
            for m in data.get("models", [])
        ]


async def _discover_vllm() -> list[DiscoveredModel]:
    """Discover models from a running vLLM server."""
    from app.registry import _get_redis_config
    url = await _get_redis_config("inference.url", "") or "http://host.docker.internal:8000"

    models: list[DiscoveredModel] = []
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.get(f"{url}/v1/models")
        r.raise_for_status()
        data = r.json()
        from app.registry import _vllm
        for m in data.get("data", []):
            model_id = m.get("id", "")
            if model_id:
                _ensure_registered(model_id, _vllm)
                models.append(DiscoveredModel(id=model_id, registered=True))
    return models


async def _discover_lmstudio() -> list[DiscoveredModel]:
    """Discover loaded models from a running LM Studio server.

    Unlike vLLM, LM Studio is always probed regardless of the active chat
    backend \u2014 it may serve embeddings (llm.embed_provider=lmstudio) while
    another backend handles chat. Reaches the host via host.docker.internal.
    """
    from app.registry import _lmstudio, _refresh_lmstudio_runtime_url
    url = await _refresh_lmstudio_runtime_url()
    await _lmstudio.check_health()
    if not _lmstudio.is_available:
        raise RuntimeError(f"LM Studio server unreachable at {url}")
    async with httpx.AsyncClient(timeout=_DISCOVERY_TIMEOUT, headers=_lmstudio._extra_headers) as client:
        r = await client.get(f"{url}/v1/models")
        r.raise_for_status()
        data = r.json()
    models: list[DiscoveredModel] = []
    for m in data.get("data", []):
        model_id = m.get("id", "")
        if model_id:
            _ensure_registered(model_id, _lmstudio)
            models.append(DiscoveredModel(id=model_id, registered=True))
    return models


# Cloud discovery fns below intentionally do NOT catch errors — a 401/403 must
# reach _discover_provider so it classifies the key as invalid instead of the
# old behavior (swallow to [] at DEBUG, indistinguishable from "no models").

async def _discover_groq() -> list[DiscoveredModel]:
    """List available Groq models via OpenAI-compatible /models endpoint."""
    async with httpx.AsyncClient(timeout=_DISCOVERY_TIMEOUT) as client:
        resp = await client.get(
            "https://api.groq.com/openai/v1/models",
            headers={"Authorization": f"Bearer {effective_key('GROQ_API_KEY')}"},
        )
        resp.raise_for_status()
        data = resp.json()
        from app.registry import _groq
        models = []
        for m in data.get("data", []):
            if not m.get("active", True):
                continue
            model_id = f"groq/{m['id']}"
            _ensure_registered(model_id, _groq)
            models.append(DiscoveredModel(id=model_id, registered=True))
        return models


async def _discover_anthropic() -> list[DiscoveredModel]:
    """List available Anthropic models."""
    async with httpx.AsyncClient(timeout=_DISCOVERY_TIMEOUT) as client:
        resp = await client.get(
            "https://api.anthropic.com/v1/models",
            headers={
                "x-api-key": effective_key("ANTHROPIC_API_KEY"),
                "anthropic-version": "2023-06-01",
            },
        )
        resp.raise_for_status()
        data = resp.json()
        from app.registry import _litellm
        models = []
        for m in data.get("data", []):
            model_id = m["id"]
            _ensure_registered(model_id, _litellm)
            models.append(DiscoveredModel(id=model_id, registered=True))
        return models


async def _discover_openai() -> list[DiscoveredModel]:
    """List available OpenAI models."""
    async with httpx.AsyncClient(timeout=_DISCOVERY_TIMEOUT) as client:
        resp = await client.get(
            "https://api.openai.com/v1/models",
            headers={"Authorization": f"Bearer {effective_key('OPENAI_API_KEY')}"},
        )
        resp.raise_for_status()
        data = resp.json()
        from app.registry import _litellm
        # Filter to chat models only (skip embeddings, tts, etc.)
        chat_prefixes = ("gpt-", "o1", "o3", "o4", "chatgpt-")
        models = []
        for m in data.get("data", []):
            if not any(m["id"].startswith(p) for p in chat_prefixes):
                continue
            model_id = m["id"]
            _ensure_registered(model_id, _litellm)
            models.append(DiscoveredModel(id=model_id, registered=True))
        return models


async def _discover_openrouter() -> list[DiscoveredModel]:
    """Validate the OpenRouter key, then list free models.

    The /models list is public and can't validate anything, so we first hit
    GET /api/v1/key — it 401s on a bad key (the audit's key showed
    "User not found" yet the provider displayed as available).
    """
    async with httpx.AsyncClient(timeout=_DISCOVERY_TIMEOUT) as client:
        key_resp = await client.get(
            "https://openrouter.ai/api/v1/key",
            headers={"Authorization": f"Bearer {effective_key('OPENROUTER_API_KEY')}"},
        )
        key_resp.raise_for_status()

        resp = await client.get("https://openrouter.ai/api/v1/models")
        resp.raise_for_status()
        data = resp.json()
        from app.registry import _openrouter
        # Only show free models to keep the list manageable
        free_models = [
            m for m in data.get("data", [])
            if ":free" in m.get("id", "")
        ][:30]  # cap at 30
        models = []
        for m in free_models:
            model_id = f"openrouter/{m['id']}"
            _ensure_registered(model_id, _openrouter)
            models.append(DiscoveredModel(id=model_id, registered=True))
        return models


async def _discover_gemini() -> list[DiscoveredModel]:
    """List available Gemini models."""
    if not effective_key("GEMINI_API_KEY"):
        # ADC-only config: no REST key to validate the model list with.
        raise RuntimeError("ADC-configured — model list not available via REST")
    async with httpx.AsyncClient(timeout=_DISCOVERY_TIMEOUT) as client:
        resp = await client.get(
            f"https://generativelanguage.googleapis.com/v1beta/models?key={effective_key('GEMINI_API_KEY')}",
        )
        resp.raise_for_status()
        data = resp.json()
        from app.registry import _gemini
        models = []
        for m in data.get("models", []):
            if "generateContent" not in m.get("supportedGenerationMethods", []):
                continue
            model_id = f"gemini/{m['name'].removeprefix('models/')}"
            _ensure_registered(model_id, _gemini)
            models.append(DiscoveredModel(id=model_id, registered=True))
        return models


async def _discover_github() -> list[DiscoveredModel]:
    """List available GitHub Models."""
    async with httpx.AsyncClient(timeout=_DISCOVERY_TIMEOUT) as client:
        resp = await client.get(
            "https://models.github.com/v1/models",
            headers={"Authorization": f"Bearer {effective_key('GITHUB_TOKEN')}"},
        )
        resp.raise_for_status()
        data = resp.json()
        from app.registry import _github
        models = []
        for m in data.get("data", data):
            if not isinstance(m, dict):
                continue
            model_id = f"github/{m['id']}"
            _ensure_registered(model_id, _github)
            models.append(DiscoveredModel(id=model_id, registered=True))
        return models


async def _discover_cerebras() -> list[DiscoveredModel]:
    """List available Cerebras models via the OpenAI-compatible /models endpoint.

    Replaces the hardcoded map, which named a retired model (llama-3.3-70b) and
    couldn't reflect what a given account actually has access to.
    """
    async with httpx.AsyncClient(timeout=_DISCOVERY_TIMEOUT) as client:
        resp = await client.get(
            "https://api.cerebras.ai/v1/models",
            headers={"Authorization": f"Bearer {effective_key('CEREBRAS_API_KEY')}"},
        )
        resp.raise_for_status()
        data = resp.json()
        from app.registry import _cerebras
        models = []
        for m in data.get("data", []):
            model_id = f"cerebras/{m['id']}"
            _ensure_registered(model_id, _cerebras)
            models.append(DiscoveredModel(id=model_id, registered=True))
        return models


async def _discover_nvidia() -> list[DiscoveredModel]:
    """List available NVIDIA NIM models via the OpenAI-compatible /models endpoint."""
    async with httpx.AsyncClient(timeout=_DISCOVERY_TIMEOUT) as client:
        resp = await client.get(
            "https://integrate.api.nvidia.com/v1/models",
            headers={"Authorization": f"Bearer {effective_key('NVIDIA_NIM_API_KEY')}"},
        )
        resp.raise_for_status()
        data = resp.json()
        from app.registry import _nvidia
        models = []
        for m in data.get("data", []):
            model_id = f"nvidia_nim/{m['id']}"
            _ensure_registered(model_id, _nvidia)
            models.append(DiscoveredModel(id=model_id, registered=True))
        return models


async def _discover_from_model_map(slug: str) -> list[DiscoveredModel]:
    """For providers without listing APIs (ChatGPT, Cerebras),
    return models from the provider's own _MODEL_MAP or registry entries."""
    if slug == "chatgpt":
        from app.providers.chatgpt_subscription_provider import _MODEL_MAP
        from app.registry import _chatgpt_subscription
        models = []
        for k in _MODEL_MAP:
            if k.startswith("chatgpt/"):
                _ensure_registered(k, _chatgpt_subscription)
                models.append(DiscoveredModel(id=k, registered=True))
        return models
    elif slug == "cerebras":
        from app.registry import MODEL_REGISTRY
        return [
            DiscoveredModel(id=k, registered=True)
            for k in MODEL_REGISTRY
            if k.startswith("cerebras/")
        ]
    return []


# ── Provider catalog builder ─────────────────────────────────────────────────

_PROVIDER_META = [
    {"slug": "ollama",      "name": "Ollama",           "type": "local"},
    {"slug": "vllm",        "name": "vLLM",             "type": "local"},
    {"slug": "lmstudio",    "name": "LM Studio",       "type": "local"},
    {"slug": "anthropic",   "name": "Anthropic API",    "type": "paid"},
    {"slug": "openai",      "name": "OpenAI API",       "type": "paid"},
    {"slug": "chatgpt",     "name": "ChatGPT Plus/Pro", "type": "subscription"},
    {"slug": "groq",        "name": "Groq",             "type": "free"},
    {"slug": "gemini",      "name": "Gemini",           "type": "free"},
    {"slug": "cerebras",    "name": "Cerebras",         "type": "free"},
    {"slug": "nvidia",      "name": "NVIDIA NIM",       "type": "free"},
    {"slug": "openrouter",  "name": "OpenRouter",       "type": "free"},
    {"slug": "github",      "name": "GitHub Models",    "type": "free"},
]

# Maps slug → discovery coroutine
_DISCOVERY_FNS: dict[str, Any] = {
    "ollama": _discover_ollama,
    "vllm": _discover_vllm,
    "lmstudio": _discover_lmstudio,
    "groq": _discover_groq,
    "anthropic": _discover_anthropic,
    "openai": _discover_openai,
    "openrouter": _discover_openrouter,
    "gemini": _discover_gemini,
    "github": _discover_github,
    "cerebras": _discover_cerebras,
    "nvidia": _discover_nvidia,
    # ChatGPT subscription has no models API — use the static map
    "chatgpt": lambda: _discover_from_model_map("chatgpt"),
}


async def _is_provider_configured(slug: str) -> bool:
    """Whether the provider has a credential / is an active local backend.

    Configured ≠ working: this only gates whether discovery probes at all.
    Key VALIDITY comes from the probe result (see _discover_provider).
    """
    from app.providers.chatgpt_subscription_provider import discover_chatgpt_token

    if slug == "vllm":
        # Must check Redis directly — the in-memory health flag starts False
        # and only flips after actual inference requests.
        from app.registry import _get_redis_config
        backend = await _get_redis_config("inference.backend", "ollama")
        return backend == "vllm"

    if slug == "lmstudio":
        # Configured when it's the active chat backend, OR when the server is
        # reachable (it may serve embeddings while another backend handles chat).
        from app.registry import _get_redis_config, _lmstudio
        backend = await _get_redis_config("inference.backend", "ollama")
        if backend == "lmstudio":
            return True
        return _lmstudio.is_available

    checks = {
        "ollama": lambda: True,
        "chatgpt": lambda: bool(discover_chatgpt_token()),
        "groq": lambda: bool(effective_key("GROQ_API_KEY")),
        "gemini": lambda: bool(effective_key("GEMINI_API_KEY") or settings.gemini_use_adc),
        "cerebras": lambda: bool(effective_key("CEREBRAS_API_KEY")),
        "nvidia": lambda: bool(effective_key("NVIDIA_NIM_API_KEY")),
        "openrouter": lambda: bool(effective_key("OPENROUTER_API_KEY")),
        "github": lambda: bool(effective_key("GITHUB_TOKEN")),
        "anthropic": lambda: bool(effective_key("ANTHROPIC_API_KEY")),
        "openai": lambda: bool(effective_key("OPENAI_API_KEY")),
    }
    try:
        return checks.get(slug, lambda: False)()
    except Exception:
        return False


def _classify_discovery_error(e: BaseException) -> tuple[str, str]:
    """Map a discovery exception to (key_status, detail)."""
    if isinstance(e, httpx.HTTPStatusError):
        code = e.response.status_code
        body = ""
        try:
            body = e.response.text[:120]
        except Exception:
            pass
        if code in (401, 403):
            return "invalid_key", f"provider rejected the credential (HTTP {code}): {body}"
        return "error", f"provider returned HTTP {code}: {body}"
    if isinstance(e, asyncio.TimeoutError):
        return "error", "discovery timed out"
    return "error", str(e)[:200]


async def _discover_provider(slug: str) -> ProviderDiscovery:
    """Run discovery for a single provider, with Redis caching.

    The cached value carries key_status so every consumer (catalog, resolve,
    provider status) shares ONE verdict from a real API call.
    """
    cache_key = f"nova:model_catalog:v2:{slug}"

    # Try cache first
    try:
        r = await _get_redis()
        cached = await r.get(cache_key)
        if cached:
            return ProviderDiscovery(**json.loads(cached))
    except Exception:
        pass

    fn = _DISCOVERY_FNS.get(slug)
    if not fn:
        return ProviderDiscovery(key_status="error", detail=f"unknown provider '{slug}'")

    if not await _is_provider_configured(slug):
        result = ProviderDiscovery(key_status="not_configured")
    else:
        try:
            models = await asyncio.wait_for(fn(), timeout=_DISCOVERY_TIMEOUT)
            result = ProviderDiscovery(models=models, key_status="ok")
            if slug == "chatgpt":
                result.detail = "subscription token present (not validated by a live call)"
        except Exception as e:
            status, detail = _classify_discovery_error(e)
            result = ProviderDiscovery(key_status=status, detail=detail)
            level = logging.WARNING if status == "invalid_key" else logging.INFO
            log.log(level, "Discovery for %s: %s — %s", slug, status, detail)

    # Cache result — shorter TTL for failures so a fixed key / recovered
    # provider is picked up quickly, without paying the probe timeout on
    # every request while it's down.
    try:
        r = await _get_redis()
        ttl = _CACHE_TTL if result.key_status in ("ok", "not_configured") else _FAILURE_CACHE_TTL
        await r.set(cache_key, result.model_dump_json(), ex=ttl)
    except Exception:
        pass

    return result


async def provider_key_statuses() -> dict[str, ProviderDiscovery]:
    """Per-provider discovery verdicts (cached). Shared by /discover,
    /health/providers, and auto-resolve."""
    slugs = [meta["slug"] for meta in _PROVIDER_META]
    results = await asyncio.gather(
        *(_discover_provider(s) for s in slugs), return_exceptions=True,
    )
    out: dict[str, ProviderDiscovery] = {}
    for slug, res in zip(slugs, results):
        if isinstance(res, ProviderDiscovery):
            out[slug] = res
        else:
            out[slug] = ProviderDiscovery(key_status="error", detail=str(res)[:200])
    return out


async def discover_all() -> list[ProviderModelList]:
    """Run all provider discoveries concurrently and return the full catalog."""
    statuses = await provider_key_statuses()

    catalog = []
    for meta in _PROVIDER_META:
        slug = meta["slug"]
        disc = statuses.get(slug) or ProviderDiscovery(key_status="error", detail="no result")

        catalog.append(ProviderModelList(
            slug=slug,
            name=meta["name"],
            type=meta["type"],
            available=disc.key_status == "ok",
            key_status=disc.key_status,
            detail=disc.detail,
            auth_methods=AUTH_METHODS.get(slug, []),
            models=disc.models if disc.key_status == "ok" else [],
        ))

    return catalog


# ── Auto-resolve: pick best available model ───────────────────────────────────

# Quality-ranked preference list for general-purpose chat.
# Each entry: (model_id, provider_slug, requires_ollama_check)
_AUTO_PREFERENCE: list[tuple[str, str, bool]] = [
    ("claude-sonnet-4-6",              "anthropic",   False),
    ("gpt-4o",                         "openai",      False),
    ("chatgpt/gpt-4o",                 "chatgpt",     False),
    ("gemini/gemini-2.5-flash",        "gemini",      False),
    ("groq/llama-3.3-70b-versatile",   "groq",        False),
    ("claude-haiku-4-5-20251001",      "anthropic",   False),
    ("chatgpt/gpt-4o-mini",           "chatgpt",     False),
    ("github/gpt-4o-mini",            "github",      False),
    ("cerebras/llama3.1-8b",           "cerebras",    False),
]

_FALLBACK_MODEL = "qwen2.5:7b"

# Module-level cache for resolve result — lock prevents thundering herd on TTL expiry
_resolve_cache: dict[str, tuple[str, str, float]] = {}  # "resolve" -> (model, source, timestamp)
_RESOLVE_CACHE_TTL = 30.0  # seconds
_resolve_lock = asyncio.Lock()


def _best_ollama_model() -> str | None:
    """Return the best pulled Ollama model by parameter count (sync-safe, uses cached catalog)."""
    import re

    # Try to read from the cached discovery result
    try:
        import asyncio
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None

    # We can't do async here easily, so check the Redis cache synchronously
    # Instead, use the in-memory catalog approach — check _OLLAMA_MODELS from registry
    from app.registry import _OLLAMA_MODELS

    if not _OLLAMA_MODELS:
        return None

    # Parse parameter sizes from known model names for ranking
    def _param_score(name: str) -> float:
        """Rough parameter count from model name for ranking."""
        # Match patterns like "70b", "8b", "3b", "1.5b"
        m = re.search(r'(\d+\.?\d*)b', name.lower())
        if m:
            return float(m.group(1))
        # Known sizes for common models without size in name
        known = {"deepseek-r1": 7, "mistral": 7, "phi4": 14, "gemma3": 12}
        for prefix, size in known.items():
            if name.startswith(prefix):
                return size
        return 3  # default assumption

    # Filter out embedding models and pick the largest
    candidates = [m for m in _OLLAMA_MODELS if "embed" not in m.lower()]
    if not candidates:
        return None

    # Sort by param count (desc), then alphabetically for deterministic tiebreak
    candidates.sort(key=lambda m: (-_param_score(m), m))
    return candidates[0]


async def resolve_auto_model() -> str:
    """Return the first preference-list model whose provider key actually
    WORKS (validated discovery, cached) — not merely whose key exists. A dead
    Anthropic key no longer wins "auto" only to bounce off a 401 at request
    time. Falls back to preferred local model, best Ollama model, then
    qwen2.5:7b."""
    statuses = await provider_key_statuses()
    for model_id, slug, _ in _AUTO_PREFERENCE:
        disc = statuses.get(slug)
        if disc is None or disc.key_status != "ok":
            continue
        # Prefer a model the provider actually lists; preference entries can
        # go stale (retired models) — skip to the next provider if so.
        if disc.models and not any(m.id == model_id for m in disc.models):
            continue
        return model_id

    # Check if user has a preferred local model configured
    try:
        from app.registry import _OLLAMA_MODELS, _get_redis_config
        preferred = await _get_redis_config("llm.preferred_local_model", "")
        if preferred and preferred in _OLLAMA_MODELS:
            return preferred
    except Exception:
        pass

    # Fall back to largest pulled Ollama model
    best_local = _best_ollama_model()
    if best_local:
        return best_local

    return _FALLBACK_MODEL


class ResolveResponse(BaseModel):
    model: str
    source: str  # "auto" or "explicit"


@discovery_router.get("/resolve")
async def resolve_model() -> ResolveResponse:
    """Resolve the default chat model. If set to 'auto', picks the best available model."""
    import time as _time

    # Check cache (fast path, no lock)
    cached = _resolve_cache.get("resolve")
    if cached:
        model, source, ts = cached
        if (_time.monotonic() - ts) < _RESOLVE_CACHE_TTL:
            return ResolveResponse(model=model, source=source)

    # Lock prevents thundering herd — concurrent requests wait for the first resolver
    async with _resolve_lock:
        # Re-check after acquiring lock (another request may have filled it)
        cached = _resolve_cache.get("resolve")
        if cached:
            model, source, ts = cached
            if (_time.monotonic() - ts) < _RESOLVE_CACHE_TTL:
                return ResolveResponse(model=model, source=source)

        from app.registry import _get_redis_config
        configured = await _get_redis_config("llm.default_chat_model", "auto")

        if configured == "auto":
            model = await resolve_auto_model()
            source = "auto"
        else:
            model = configured
            source = "explicit"

        _resolve_cache["resolve"] = (model, source, _time.monotonic())
        return ResolveResponse(model=model, source=source)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@discovery_router.get("/tiers")
async def tier_health() -> dict:
    """Tier-system health: each tier's preference list with per-candidate
    verdicts from validated discovery (ok / provider_unavailable /
    unknown_model / unregistered / no_quota) and the model the tier would
    resolve to right now — null when nothing on the list is usable."""
    from app.tier_resolver import explain_tiers
    return await explain_tiers()


@discovery_router.get("/discover")
async def discover_models(refresh: bool = False) -> list[ProviderModelList]:
    """Discover all available models across all providers."""
    if refresh:
        # Invalidate cache
        try:
            r = await _get_redis()
            keys = [f"nova:model_catalog:v2:{m['slug']}" for m in _PROVIDER_META]
            await r.delete(*keys)
        except Exception:
            pass

    return await discover_all()


@discovery_router.get("/ollama/pulled")
async def get_ollama_pulled() -> list[OllamaPulledModel]:
    """List all models pulled into Ollama with size and quantization details."""
    from app.registry import get_ollama_base_url
    try:
        ollama_url = await get_ollama_base_url()
        async with httpx.AsyncClient(base_url=ollama_url, timeout=_DISCOVERY_TIMEOUT) as client:
            resp = await client.get("/api/tags")
            resp.raise_for_status()
            data = resp.json()
            # Which models are resident in memory right now (best-effort).
            loaded_names: set[str] = set()
            try:
                ps = await client.get("/api/ps")
                if ps.status_code == 200:
                    loaded_names = {m.get("name", "") for m in ps.json().get("models", [])}
            except Exception:
                pass
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ollama unreachable: {e}")

    models = []
    for m in data.get("models", []):
        details = m.get("details", {})
        models.append(OllamaPulledModel(
            name=m["name"],
            size=m.get("size", 0),
            parameter_size=details.get("parameter_size", ""),
            quantization_level=details.get("quantization_level", ""),
            digest=m.get("digest", "")[:12],
            modified_at=m.get("modified_at", ""),
            loaded=m["name"] in loaded_names,
        ))

    return models


@discovery_router.post("/ollama/load")
async def load_ollama_model(req: PullRequest):
    """Warm a pulled model into memory (empty generate honors keep_alive)."""
    from app.registry import get_ollama_base_url, get_ollama_keep_alive
    try:
        ollama_url = await get_ollama_base_url()
        keep_alive = await get_ollama_keep_alive()
        body: dict = {"model": req.name}
        if keep_alive:
            body["keep_alive"] = keep_alive
        async with httpx.AsyncClient(base_url=ollama_url, timeout=_PULL_TIMEOUT) as client:
            resp = await client.post("/api/generate", json=body)
            resp.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ollama load failed: {e}")
    return {"status": "ok", "model": req.name, "loaded": True}


@discovery_router.post("/ollama/unload")
async def unload_ollama_model(req: PullRequest):
    """Evict a model from memory now (keep_alive=0 frees it immediately)."""
    from app.registry import get_ollama_base_url
    try:
        ollama_url = await get_ollama_base_url()
        async with httpx.AsyncClient(base_url=ollama_url, timeout=30.0) as client:
            resp = await client.post("/api/generate", json={"model": req.name, "keep_alive": 0})
            resp.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ollama unload failed: {e}")
    return {"status": "ok", "model": req.name, "loaded": False}


@discovery_router.post("/ollama/pull")
async def pull_ollama_model(req: PullRequest):
    """Pull a model into Ollama. Blocking — may take several minutes."""
    from app.registry import get_ollama_base_url
    try:
        ollama_url = await get_ollama_base_url()
        async with httpx.AsyncClient(base_url=ollama_url, timeout=_PULL_TIMEOUT) as client:
            resp = await client.post("/api/pull", json={"name": req.name, "stream": False})
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Pull timed out after {_PULL_TIMEOUT}s")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ollama pull failed: {e}")

    if resp.status_code >= 400:
        # Ollama puts the reason in {"error": "..."} — pass it through instead
        # of a generic 502, and translate the two common registry refusals.
        try:
            err = resp.json().get("error") or resp.text
        except Exception:
            err = resp.text
        if "file does not exist" in err:
            raise HTTPException(
                status_code=404,
                detail=f"'{req.name}' is not in the Ollama registry — check the name at ollama.com/library",
            )
        if "newer version" in err.lower():
            raise HTTPException(
                status_code=409,
                detail=(
                    f"'{req.name}' needs a newer Ollama than the one running. "
                    "Restart Ollama from Settings → Local Inference (the restart pulls the latest image), then retry."
                ),
            )
        raise HTTPException(status_code=502, detail=f"Ollama pull failed: {err}")

    # Auto-register the pulled model
    from app.registry import sync_ollama_models
    await sync_ollama_models()

    # Invalidate Ollama discovery cache
    try:
        r = await _get_redis()
        await r.delete("nova:model_catalog:ollama")
    except Exception:
        pass

    return {"status": "ok", "model": req.name}


async def _assert_model_unreferenced(name: str) -> None:
    """Refuse deletion while any pod, agent, or config knob still points at `name`.

    Nothing may ever point at a model that doesn't exist, so the check is
    fail-closed: if the orchestrator can't confirm zero references, the
    delete is rejected rather than risking a dangling pin.
    """
    from app.config import settings
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{settings.orchestrator_url}/api/v1/models/references",
                params={"model": name},
                headers={"X-Admin-Secret": settings.nova_admin_secret},
            )
            resp.raise_for_status()
            refs = resp.json().get("references", [])
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Couldn't verify that nothing still uses '{name}' "
                f"(orchestrator unreachable: {e}). Retry when Nova is fully up."
            ),
        )
    if refs:
        users = ", ".join(dict.fromkeys(r.get("name", "?") for r in refs))
        raise HTTPException(
            status_code=409,
            detail=(
                f"'{name}' is still assigned to: {users}. "
                "Point them at another model first, then delete."
            ),
        )


@discovery_router.delete("/ollama/{name:path}")
async def delete_ollama_model(name: str):
    """Delete a pulled Ollama model (409 while anything still points at it)."""
    from app.registry import get_ollama_base_url
    await _assert_model_unreferenced(name)
    try:
        ollama_url = await get_ollama_base_url()
        async with httpx.AsyncClient(base_url=ollama_url, timeout=30.0) as client:
            resp = await client.request("DELETE", "/api/delete", json={"name": name})
            if resp.status_code == 404:
                raise HTTPException(status_code=404, detail=f"Model '{name}' not found")
            resp.raise_for_status()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ollama delete failed: {e}")

    # Invalidate cache
    try:
        r = await _get_redis()
        await r.delete("nova:model_catalog:ollama")
    except Exception:
        pass

    return {"status": "ok", "model": name}


# ── LM Studio downloaded-model library ─────────────────────────────────────────

_LMSTUDIO_LOAD_TIMEOUT = 300.0  # model load can take minutes for large GGUFs


def _parse_lmstudio_capabilities(raw: dict | None) -> tuple[bool, bool]:
    """Extract (supports_vision, supports_tools) from an LM Studio model entry.

    The v1 native API nests these under ``capabilities`` (absent for embedding
    models). Older v0/OpenAI-compat responses don't include them.
    """
    if not isinstance(raw, dict):
        return False, False
    return bool(raw.get("vision", False)), bool(raw.get("trained_for_tool_use", False))


@discovery_router.get("/lmstudio/downloaded")
async def get_lmstudio_downloaded() -> list[LMStudioDownloadedModel]:
    """List all downloaded models in the user's LM Studio installation.

    Uses the native v1 REST API (``GET /api/v1/models``) which returns every
    downloaded model with rich metadata plus a ``loaded_instances`` array. On
    older LM Studio builds that predate the v1 API, falls back to the
    OpenAI-compatible ``/v1/models`` endpoint (loaded-only, minimal metadata)
    so the library still renders — load/unload just won't be available there.
    """
    from app.registry import _lmstudio, _refresh_lmstudio_runtime_url
    url = await _refresh_lmstudio_runtime_url()
    await _lmstudio.check_health()
    if not _lmstudio.is_available:
        raise HTTPException(status_code=502, detail="LM Studio server is not reachable")

    headers = _lmstudio._extra_headers
    try:
        async with httpx.AsyncClient(timeout=_DISCOVERY_TIMEOUT, headers=headers) as client:
            # Native v1 first — richer data + includes unloaded models.
            resp = await client.get(f"{url}/api/v1/models")
            if resp.status_code == 404:
                # Older LM Studio (pre-0.4.0): fall back to OpenAI-compat endpoint.
                resp = await client.get(f"{url}/v1/models")
                resp.raise_for_status()
                data = resp.json()
                models: list[LMStudioDownloadedModel] = []
                for m in data.get("data", []):
                    mid = m.get("id", "")
                    if not mid:
                        continue
                    models.append(LMStudioDownloadedModel(
                        key=mid,
                        type="llm",
                        publisher=mid.split("/", 1)[0] if "/" in mid else "local",
                        display_name=mid,
                        loaded=True,
                        loaded_instances=[mid],
                    ))
                return models
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"LM Studio unreachable: {e}")

    out: list[LMStudioDownloadedModel] = []
    for m in data.get("models", []):
        key = m.get("key", "")
        if not key:
            continue
        quant = m.get("quantization") or {}
        caps = m.get("capabilities")
        vision, tools = _parse_lmstudio_capabilities(caps if isinstance(caps, dict) else None)
        instances = [
            i.get("id", "") for i in (m.get("loaded_instances") or []) if i.get("id")
        ]
        out.append(LMStudioDownloadedModel(
            key=key,
            type=m.get("type", "llm"),
            publisher=m.get("publisher", ""),
            display_name=m.get("display_name", key),
            architecture=m.get("architecture"),
            quantization=quant.get("name") if isinstance(quant, dict) else None,
            bits_per_weight=quant.get("bits_per_weight") if isinstance(quant, dict) else None,
            size_bytes=m.get("size_bytes", 0) or 0,
            params_string=m.get("params_string"),
            loaded=bool(instances),
            loaded_instances=instances,
            max_context_length=m.get("max_context_length"),
            format=m.get("format"),
            supports_vision=vision,
            supports_tools=tools,
            variants=m.get("variants") or [],
            selected_variant=m.get("selected_variant"),
        ))
    return out


@discovery_router.post("/lmstudio/load")
async def load_lmstudio_model(req: LMStudioLoadRequest):
    """Load a downloaded model into LM Studio memory (POST /api/v1/models/load).

    After a successful load, syncs the gateway's model registry so the newly
    loaded model is immediately routable via /v1/chat/completions, and bumps
    the discovery cache so the dashboard reflects the change.
    """
    from app.registry import _lmstudio, _refresh_lmstudio_runtime_url
    url = await _refresh_lmstudio_runtime_url()
    await _lmstudio.check_health()
    if not _lmstudio.is_available:
        raise HTTPException(status_code=502, detail="LM Studio server is not reachable")

    body: dict[str, Any] = {"model": req.model}
    for opt in ("context_length", "flash_attention", "eval_batch_size",
                "num_experts", "offload_kv_cache_to_gpu"):
        v = getattr(req, opt)
        if v is not None:
            body[opt] = v

    try:
        async with httpx.AsyncClient(timeout=_LMSTUDIO_LOAD_TIMEOUT,
                                    headers=_lmstudio._extra_headers) as client:
            resp = await client.post(f"{url}/api/v1/models/load", json=body)
            if resp.status_code >= 400:
                detail = resp.text[:300]
                if resp.status_code == 404:
                    raise HTTPException(
                        status_code=404,
                        detail=f"LM Studio could not find model '{req.model}'. "
                               f"If your LM Studio predates 0.4.0, the native load API is "
                               f"unavailable — load models from the LM Studio GUI instead.",
                    )
                raise HTTPException(status_code=resp.status_code,
                                    detail=f"LM Studio load failed: {detail}")
            result = resp.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Load timed out after {_LMSTUDIO_LOAD_TIMEOUT}s")
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"LM Studio unreachable: {e}")

    # Register the freshly loaded model so it's routable immediately.
    try:
        from app.registry import sync_lmstudio_models
        await sync_lmstudio_models()
    except Exception as e:
        log.warning("sync_lmstudio_models after load failed: %s", e)

    # Invalidate discovery cache so the dashboard's library refreshes.
    try:
        r = await _get_redis()
        await r.delete("nova:model_catalog:lmstudio")
    except Exception:
        pass

    return {
        "status": "ok",
        "instance_id": result.get("instance_id", req.model),
        "load_time_seconds": result.get("load_time_seconds"),
    }


@discovery_router.post("/lmstudio/unload")
async def unload_lmstudio_model(req: LMStudioUnloadRequest):
    """Unload a model instance from LM Studio memory (POST /api/v1/models/unload)."""
    from app.registry import _lmstudio, _refresh_lmstudio_runtime_url
    url = await _refresh_lmstudio_runtime_url()
    await _lmstudio.check_health()
    if not _lmstudio.is_available:
        raise HTTPException(status_code=502, detail="LM Studio server is not reachable")

    try:
        async with httpx.AsyncClient(timeout=30.0, headers=_lmstudio._extra_headers) as client:
            resp = await client.post(f"{url}/api/v1/models/unload",
                                     json={"instance_id": req.instance_id})
            if resp.status_code >= 400:
                detail = resp.text[:300]
                if resp.status_code == 404:
                    raise HTTPException(
                        status_code=404,
                        detail=f"LM Studio instance '{req.instance_id}' not found — "
                               f"it may already be unloaded, or your LM Studio predates 0.4.0 "
                               f"(unload via the GUI instead).",
                    )
                raise HTTPException(status_code=resp.status_code,
                                    detail=f"LM Studio unload failed: {detail}")
            result = resp.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Unload timed out after 30s")
    except HTTPException:
        raise
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"LM Studio unreachable: {e}")

    # Re-sync registry so an unloaded model is no longer (falsely) routable.
    try:
        from app.registry import sync_lmstudio_models
        await sync_lmstudio_models()
    except Exception as e:
        log.warning("sync_lmstudio_models after unload failed: %s", e)

    try:
        r = await _get_redis()
        await r.delete("nova:model_catalog:lmstudio")
    except Exception:
        pass

    return {"status": "ok", "instance_id": result.get("instance_id", req.instance_id)}
