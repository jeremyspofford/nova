"""
Provider registry — maps model names to ModelProvider instances.
All providers are auto-detected from credentials on disk or env vars at startup.

ROUTING STRATEGIES (configurable at runtime via platform_config)
─────────────────────────────────────────────────────────────────────────────
  local-only    Ollama models → _ollama only. Fail if offline.
  local-first   Ollama models → try Ollama, fall back to cloud. (default)
  cloud-only    Ollama models → skip Ollama, use cloud fallback model.
  cloud-first   Ollama models → try cloud first, Ollama as backup.

SUBSCRIPTION AUTH (no API billing — uses your existing subscription quota)
─────────────────────────────────────────────────────────────────────────────
  ChatGPT Plus/Pro  Run `codex login`, then auto-read from ~/.codex/auth.json
                    OR set CHATGPT_ACCESS_TOKEN manually
                    → Models: chatgpt/gpt-4o, chatgpt/o3, etc.

FREE TIER API KEYS (no credit card required)
─────────────────────────────────────────────────────────────────────────────
  Ollama            Local, unlimited — always active
  Groq              14,400 req/day — set GROQ_API_KEY (console.groq.com)
  Gemini            250 req/day — set GEMINI_API_KEY (aistudio.google.com)
                    OR gcloud auth application-default login + GEMINI_USE_ADC=true
  Cerebras          1M tokens/day — set CEREBRAS_API_KEY (cloud.cerebras.ai)
  OpenRouter        50+ req/day — set OPENROUTER_API_KEY (openrouter.ai)
  GitHub Models     50-150 req/day — set GITHUB_TOKEN (github.com PAT)

PAID API KEYS
─────────────────────────────────────────────────────────────────────────────
  Anthropic API     set ANTHROPIC_API_KEY (console.anthropic.com)
  OpenAI API        set OPENAI_API_KEY (platform.openai.com)
"""
from __future__ import annotations

import json
import logging
import os
import time

import redis.asyncio as aioredis
from app.config import settings
from app.providers import (
    ChatGPTSubscriptionProvider,
    FallbackProvider,
    GeminiADCProvider,
    LiteLLMProvider,
    LMStudioProvider,
    LocalInferenceProvider,
    ModelProvider,
    OllamaCloudFallback,
    OllamaProvider,
    VLLMProvider,
    discover_chatgpt_token,
)
from app.providers.credential_guard import credential_invalid

log = logging.getLogger(__name__)

DEFAULT_MODEL_KEY = "__default__"

VALID_STRATEGIES = {"local-only", "local-first", "cloud-only", "cloud-first"}


def _inject_litellm_env_keys() -> None:
    """Inject configured API keys into environment for LiteLLM auto-detection.

    Resolution order (last write wins): settings/.env → platform_secrets store
    (SEC-006a). When the orchestrator is unreachable at boot, the
    platform_secrets pass returns empty and only .env values apply — gateway
    still starts cleanly.
    """
    # Layer 1 — settings/.env (preserves behavior for installs that haven't
    # migrated to platform_secrets yet).
    if settings.anthropic_api_key:
        os.environ["ANTHROPIC_API_KEY"] = settings.anthropic_api_key
    if settings.openai_api_key:
        os.environ["OPENAI_API_KEY"] = settings.openai_api_key
    if settings.groq_api_key:
        os.environ["GROQ_API_KEY"] = settings.groq_api_key
    if settings.gemini_api_key:
        os.environ["GEMINI_API_KEY"] = settings.gemini_api_key
    if settings.cerebras_api_key:
        os.environ["CEREBRAS_API_KEY"] = settings.cerebras_api_key
    if settings.openrouter_api_key:
        os.environ["OPENROUTER_API_KEY"] = settings.openrouter_api_key
    if settings.github_token:
        os.environ["GITHUB_TOKEN"] = settings.github_token
    if settings.chatgpt_access_token:
        os.environ["CHATGPT_ACCESS_TOKEN"] = settings.chatgpt_access_token

    # Layer 2 — platform_secrets (overrides .env when the orchestrator has
    # an entry). Sync because providers below construct at module load.
    from nova_worker_common.platform_secrets import fetch_platform_secrets_sync
    resolved = fetch_platform_secrets_sync(
        orchestrator_url=settings.orchestrator_url,
        admin_secret=settings.nova_admin_secret,
        keys=[
            "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY",
            "GEMINI_API_KEY", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY",
            "GITHUB_TOKEN", "CHATGPT_ACCESS_TOKEN",
        ],
    )
    for k, v in resolved.items():
        os.environ[k] = v
    if resolved:
        log.info("platform_secrets: applied %d key(s) at startup: %s",
                 len(resolved), sorted(resolved.keys()))


_inject_litellm_env_keys()


# ── Provider instances (stateless, created once at startup) ───────────────────
# Each provider reads its default model from settings so users can override via
# DEFAULT_GROQ_MODEL, DEFAULT_CEREBRAS_MODEL, etc. in their .env file.

_ollama = OllamaProvider(
    base_url=settings.ollama_base_url,
    default_model=settings.default_ollama_model,
)
_litellm = LiteLLMProvider()  # generic last-resort adapter — model comes from request
# Paid APIs get their own labeled instances so a credential rejection for one
# never sidelines the other (the guard cooldown keys on provider.name).
_anthropic = LiteLLMProvider(default_model="claude-sonnet-4-6", label="anthropic")
_openai = LiteLLMProvider(default_model="gpt-4o", label="openai")
_groq = LiteLLMProvider(default_model=settings.default_groq_model, label="groq")
_cerebras = LiteLLMProvider(default_model=settings.default_cerebras_model, label="cerebras")
_openrouter = LiteLLMProvider(default_model=settings.default_openrouter_model, label="openrouter")
_github = LiteLLMProvider(default_model=settings.default_github_model, label="github")
# Read GEMINI_API_KEY from os.environ — it's authoritative after _inject_litellm_env_keys
# applied platform_secrets overrides on top of settings/.env values.
_gemini = GeminiADCProvider(
    api_key=os.environ.get("GEMINI_API_KEY", ""),
    use_adc=settings.gemini_use_adc,
)

# ── Subscription providers — auto-detect credentials at startup ────────────────

_chatgpt_token = discover_chatgpt_token()
_chatgpt_subscription = ChatGPTSubscriptionProvider(
    access_token=_chatgpt_token,
    default_model=settings.default_chatgpt_model,
)

# Log what was found
if _chatgpt_subscription.is_available:
    log.info("✓ ChatGPT Plus/Pro subscription active → models: chatgpt/*")
else:
    log.info("  ChatGPT subscription not detected  (run `codex login`)")

# ── Local inference backends (external, user-run — never managed by Nova) ─────

_vllm = VLLMProvider()

# LM Studio is a host-side desktop app, NOT a managed container — Nova never
# starts/stops it. The single shared instance's base_url/headers are refreshed
# from Redis runtime config before use (see _refresh_lmstudio_runtime_url).
_lmstudio = LMStudioProvider()

# ── Local inference wrapper (delegates to active backend: Ollama, vLLM, etc.) ─
_local = LocalInferenceProvider()


# ── Cloud fallback chain (without Ollama) ────────────────────────────────────

def _build_cloud_fallback() -> FallbackProvider:
    """Build a fallback chain of all cloud providers (no Ollama)."""
    chain: list[ModelProvider] = []

    if settings.groq_api_key:
        chain.append(_groq)
    if settings.gemini_api_key or settings.gemini_use_adc:
        chain.append(_gemini)
    if settings.cerebras_api_key:
        chain.append(_cerebras)
    if settings.openrouter_api_key:
        chain.append(_openrouter)
    if settings.github_token:
        chain.append(_github)

    # Subscription providers come before paid API to prefer zero-cost
    if _chatgpt_subscription.is_available:
        chain.append(_chatgpt_subscription)

    if settings.anthropic_api_key:
        chain.append(_anthropic)
    if settings.openai_api_key:
        chain.append(_openai)

    if not chain:
        # No cloud providers at all — use LiteLLM as a last resort (it'll error with no keys)
        chain.append(_litellm)

    log.info("Cloud fallback chain: %d provider(s)", len(chain))
    return FallbackProvider(providers=chain)


_cloud_fallback = _build_cloud_fallback()


# ── Default fallback chain (Ollama + cloud) ──────────────────────────────────

def _build_default_fallback() -> FallbackProvider:
    chain: list[ModelProvider] = [_local]  # always local-first

    if settings.groq_api_key:
        chain.append(_groq)
    if settings.gemini_api_key or settings.gemini_use_adc:
        chain.append(_gemini)
    if settings.cerebras_api_key:
        chain.append(_cerebras)
    if settings.openrouter_api_key:
        chain.append(_openrouter)
    if settings.github_token:
        chain.append(_github)

    # Subscription providers come before paid API to prefer zero-cost
    if _chatgpt_subscription.is_available:
        chain.append(_chatgpt_subscription)

    if settings.anthropic_api_key:
        chain.append(_anthropic)
    if settings.openai_api_key:
        chain.append(_openai)

    log.info("Default fallback chain: %d provider(s)", len(chain))
    return FallbackProvider(providers=chain)


_default_fallback = _build_default_fallback()


# ── Routing strategy from Redis ──────────────────────────────────────────────

_strategy_redis: aioredis.Redis | None = None
_cached_strategy: str = settings.llm_routing_strategy
_strategy_fetched_at: float = 0.0
_STRATEGY_CACHE_TTL = 5.0  # seconds


async def _get_strategy_redis() -> aioredis.Redis:
    global _strategy_redis
    if _strategy_redis is None:
        _strategy_redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _strategy_redis


async def close_strategy_redis() -> None:
    """Close the strategy/config Redis singleton. Call at shutdown."""
    global _strategy_redis
    if _strategy_redis is not None:
        await _strategy_redis.aclose()
        _strategy_redis = None


async def get_routing_strategy() -> str:
    """Read llm.routing_strategy from Redis (synced from platform_config). Cached for 5s."""
    global _cached_strategy, _strategy_fetched_at

    now = time.monotonic()
    if (now - _strategy_fetched_at) < _STRATEGY_CACHE_TTL:
        return _cached_strategy

    try:
        r = await _get_strategy_redis()
        val = await r.get("nova:config:llm.routing_strategy")
        if val is not None:
            # Value is JSON-encoded string, e.g. '"local-first"'
            try:
                parsed = json.loads(val)
                if isinstance(parsed, str):
                    val = parsed
            except (json.JSONDecodeError, TypeError):
                pass
            if val in VALID_STRATEGIES:
                _cached_strategy = val
    except Exception as e:
        log.debug("Failed to read routing strategy from Redis: %s", e)

    _strategy_fetched_at = now
    return _cached_strategy


# ── Dynamic config from Redis (synced from platform_config) ──────────────────

_config_cache: dict[str, tuple[str, float]] = {}  # key -> (value, fetched_at)
_CONFIG_CACHE_TTL = 5.0


async def _get_redis_config(key: str, default: str) -> str:
    """Read a nova:config:{key} value from Redis with 5s cache, falling back to default."""
    now = time.monotonic()
    cached = _config_cache.get(key)
    if cached and (now - cached[1]) < _CONFIG_CACHE_TTL:
        return cached[0]

    try:
        r = await _get_strategy_redis()
        val = await r.get(f"nova:config:{key}")
        if val is not None:
            try:
                parsed = json.loads(val)
                if isinstance(parsed, str) and parsed:
                    # JSON-encoded string — unwrap it
                    _config_cache[key] = (parsed, now)
                    return parsed
                if isinstance(parsed, bool):
                    # JSON boolean (true/false) — convert to lowercase string
                    str_val = str(parsed).lower()
                    _config_cache[key] = (str_val, now)
                    return str_val
                # Non-string JSON (dict, list, int) — return the raw value string
                # so callers can re-parse it themselves (e.g. tier_preferences dict)
            except (json.JSONDecodeError, TypeError):
                pass
            # Return raw Redis string for non-string JSON or parse failures
            if val and val != "null":
                _config_cache[key] = (val, now)
                return val
    except Exception as e:
        log.debug("Failed to read %s from Redis: %s", key, e)

    _config_cache[key] = (default, now)
    return default


async def get_ollama_base_url() -> str:
    """Get the current Ollama base URL (runtime-configurable via dashboard).

    Reads `nova:config:inference.url` (canonical, written by the dashboard's
    LocalInferenceSection); falls through to settings.ollama_base_url (env-
    derived default, typically http://host.docker.internal:11434) when no override is set.

    The legacy `llm.ollama_url` key is retired — main.py runs a one-time
    migration on startup that copies any legacy value into inference.url.
    """
    override = await _get_redis_config("inference.url", "")
    return override if override else settings.ollama_base_url


async def get_wol_mac() -> str:
    """Get the current WoL MAC address (runtime-configurable via dashboard)."""
    return await _get_redis_config("llm.wol_mac", settings.wol_mac_address)


async def get_wol_broadcast() -> str:
    """Get the current WoL broadcast IP (runtime-configurable via dashboard)."""
    return await _get_redis_config("llm.wol_broadcast", settings.wol_broadcast_ip)


async def get_prefer_subscription() -> bool:
    """Check if subscription providers should be tried first (runtime-configurable)."""
    val = await _get_redis_config("llm.prefer_subscription", str(settings.prefer_subscription).lower())
    return val.lower() in ("true", "1", "yes")


async def get_ollama_keep_alive() -> str:
    """Return the keep_alive duration to pass on Ollama requests.

    Reads `nova:config:inference.keep_alive` (UI-configurable). Empty string
    means "use Ollama default" (server reads OLLAMA_KEEP_ALIVE env, default 5m).
    Accepted formats: duration string ("30m", "1h"), seconds ("1800"), "-1"
    for forever, "0" to unload immediately. Validation is left to Ollama —
    any string that fails to parse is rejected by the server with a 400.
    """
    return await _get_redis_config("inference.keep_alive", "")


# ── Ollama model names (models that route to Ollama by default) ──────────────

_OLLAMA_MODELS = {
    "llama3.2", "llama3.2:3b", "llama3.1", "mistral", "qwen2.5",
    "qwen2.5:7b", "qwen2.5:1.5b",
    "phi4", "deepseek-r1", "gemma3", "nomic-embed-text",
}


def _is_ollama_model(model: str) -> bool:
    """Check if a model is an Ollama-local model (no provider prefix)."""
    return model in _OLLAMA_MODELS


def _is_local_model(model: str) -> bool:
    """Check if a model belongs to the active local inference backend."""
    return model in _OLLAMA_MODELS or _local.is_local_model(model)


async def sync_ollama_models() -> int:
    """Discover pulled Ollama models and register any that aren't in MODEL_REGISTRY.
    Called at startup and after each successful pull. Returns count of newly registered models."""
    import httpx
    ollama_url = await get_ollama_base_url()
    try:
        async with httpx.AsyncClient(base_url=ollama_url, timeout=5.0) as client:
            resp = await client.get("/api/tags")
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        log.debug("sync_ollama_models: Ollama unreachable: %s", e)
        return 0

    added = 0
    for m in data.get("models", []):
        name = m["name"]
        if name not in MODEL_REGISTRY and name != DEFAULT_MODEL_KEY:
            MODEL_REGISTRY[name] = _ollama
            _OLLAMA_MODELS.add(name)
            added += 1
            log.info("Auto-registered Ollama model: %s", name)

    if added:
        log.info("sync_ollama_models: registered %d new model(s)", added)
    return added


async def sync_vllm_models() -> int:
    """Probe vLLM, run a health check, and register any served models.
    Called at startup. Returns count of newly registered models."""
    import httpx
    # Trigger health check to flip _healthy flag
    await _vllm.check_health()
    if not _vllm.is_available:
        return 0

    try:
        vllm_url = await _get_redis_config("inference.url", "") or "http://host.docker.internal:8000"
        async with httpx.AsyncClient(base_url=vllm_url, timeout=5.0) as client:
            resp = await client.get("/v1/models")
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        log.debug("sync_vllm_models: vLLM unreachable: %s", e)
        return 0

    added = 0
    for m in data.get("data", []):
        model_id = m["id"]
        if model_id not in MODEL_REGISTRY and model_id != DEFAULT_MODEL_KEY:
            MODEL_REGISTRY[model_id] = _vllm
            _local.update_local_models(_local._local_models | {model_id})
            added += 1
            log.info("Auto-registered vLLM model: %s", model_id)
    return added


async def _refresh_lmstudio_runtime_url() -> str:
    """Refresh the shared _lmstudio instance's base_url + auth headers from
    Redis runtime config (inference.lmstudio_url / inference.lmstudio_api_key).

    The instance is created once at module load with the default host URL; this
    keeps it in sync with dashboard edits without a restart. Returns the
    resolved URL (also used by discovery / sync probes).
    """
    url = await _get_redis_config("inference.lmstudio_url", "") or "http://host.docker.internal:1234"
    api_key = await _get_redis_config("inference.lmstudio_api_key", "")
    _lmstudio._base_url = url.rstrip("/")
    _lmstudio._extra_headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    # Reset health cache so the next check_health re-probes the new URL.
    _lmstudio._last_health_check = 0.0
    return _lmstudio._base_url


async def sync_lmstudio_models() -> int:
    """Probe a running LM Studio server and register any loaded models.

    LM Studio is multi-model and user-managed (models are loaded in its GUI),
    so unlike vLLM/SGLang there is no model-switch path — we just discover
    whatever is currently loaded via ``/v1/models`` and register each. Safe to
    call at startup and whenever the user refreshes the model catalog.
    Returns the count of newly registered models.
    """
    import httpx
    url = await _refresh_lmstudio_runtime_url()
    # Flip the provider's health flag from the probe so the catalog reflects
    # reachability (available = is_available).
    await _lmstudio.check_health()
    if not _lmstudio.is_available:
        return 0
    try:
        async with httpx.AsyncClient(timeout=5.0, headers=_lmstudio._extra_headers) as client:
            resp = await client.get(f"{url}/v1/models")
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        log.debug("sync_lmstudio_models: LM Studio unreachable at %s: %s", url, e)
        return 0

    added = 0
    loaded: set[str] = set()
    for m in data.get("data", []):
        model_id = m.get("id", "")
        if not model_id:
            continue
        loaded.add(model_id)
        if model_id not in MODEL_REGISTRY and model_id != DEFAULT_MODEL_KEY:
            MODEL_REGISTRY[model_id] = _lmstudio
            added += 1
            log.info("Auto-registered LM Studio model: %s", model_id)
    if loaded:
        _local.update_local_models(_local._local_models | loaded)
        log.info("sync_lmstudio_models: %d model(s) loaded (%d new)", len(loaded), added)
    return added


# ── Model → provider routing table ────────────────────────────────────────────
#
# Naming convention:
#   chatgpt/*      → ChatGPT subscription (no billing)
#   groq/*         → Groq free tier
#   gemini/*       → Gemini free tier
#   cerebras/*     → Cerebras free tier
#   openrouter/*   → OpenRouter (free models available)
#   github/*       → GitHub Models free tier
#   bare names     → Ollama (local)
#   claude-*/gpt-* without prefix → API key required (paid)

MODEL_REGISTRY: dict[str, ModelProvider] = {

    # ── ChatGPT Plus/Pro subscription ─────────────────────────────────────────
    "chatgpt/gpt-4o":                     _chatgpt_subscription,
    "chatgpt/gpt-4o-mini":                _chatgpt_subscription,
    "chatgpt/o3":                         _chatgpt_subscription,
    "chatgpt/o4-mini":                    _chatgpt_subscription,
    "chatgpt/gpt-5.2-codex":             _chatgpt_subscription,
    "chatgpt/gpt-5.3-codex":             _chatgpt_subscription,

    # ── Local (Ollama) — will be overridden per-request by routing strategy ───
    "qwen2.5:1.5b":                       _ollama,
    "qwen2.5:7b":                         _ollama,
    "llama3.2":                           _ollama,
    "llama3.2:3b":                        _ollama,
    "llama3.1":                           _ollama,
    "mistral":                            _ollama,
    "qwen2.5":                            _ollama,
    "phi4":                               _ollama,
    "deepseek-r1":                        _ollama,
    "gemma3":                             _ollama,

    # ── Groq — 14,400 req/day free ────────────────────────────────────────────
    "groq/llama-3.3-70b-versatile":       _groq,
    "groq/llama-3.1-8b-instant":          _groq,
    "groq/mixtral-8x7b-32768":            _groq,
    "groq/llama-3.2-3b-preview":          _groq,

    # ── Gemini — 250 req/day free ─────────────────────────────────────────────
    "gemini/gemini-2.5-flash":            _gemini,
    "gemini/gemini-2.5-pro":              _gemini,
    "gemini-2.5-flash":                   _gemini,

    # ── Cerebras — 1M tokens/day free ─────────────────────────────────────────
    # As of 2026, only llama3.1-8b is confirmed active on free tier.
    # llama3.3-70b and llama3.1-70b have been retired from Cerebras Cloud.
    # Cerebras Cloud and LiteLLM both use the no-dash form (`llama3.1-8b`).
    "cerebras/llama3.1-8b":              _cerebras,

    # ── OpenRouter — free models available ────────────────────────────────────
    "openrouter/meta-llama/llama-3.1-8b-instruct:free": _openrouter,
    "openrouter/google/gemma-2-9b-it:free":             _openrouter,
    "openrouter/mistralai/mistral-7b-instruct:free":    _openrouter,

    # ── GitHub Models — 50-150 req/day free ───────────────────────────────────
    "github/gpt-4o-mini":                 _github,
    "github/meta-llama-3.1-70b-instruct": _github,

    # ── Paid Anthropic API (bare model names route here via ANTHROPIC_API_KEY) ──
    "claude-sonnet-4-6":                  _anthropic,
    "claude-opus-4-6":                    _anthropic,
    "claude-haiku-4-5-20251001":          _anthropic,

    # ── Paid OpenAI API ────────────────────────────────────────────────────────
    # Use chatgpt/* prefix to route to subscription instead.
    "gpt-4o":                             _openai,
    "gpt-4o-mini":                        _openai,

    # ── Embedding models ──────────────────────────────────────────────────────
    "nomic-embed-text":                   _ollama,     # local, free, 768-dim
    "gemini-embedding-001":               _gemini,     # Gemini free tier
    "text-embedding-3-small":             _openai,     # OpenAI paid

    # ── Catch-all: smart fallback across all configured providers ──────────────
    DEFAULT_MODEL_KEY:                    _default_fallback,
}


# ── Per-model specs (context window, max output) ────────────────────────────
# Only models with non-default values need entries here.
# Default fallback: context_window=128000, max_output_tokens=8096.

_DEFAULT_CONTEXT_WINDOW = 128_000
_DEFAULT_MAX_OUTPUT_TOKENS = 8_096

MODEL_SPECS: dict[str, dict[str, int]] = {
    "claude-sonnet-4-6":                 {"context_window": 200_000, "max_output_tokens": 16_000},
    "claude-opus-4-6":                   {"context_window": 200_000, "max_output_tokens": 32_000},
    "claude-haiku-4-5-20251001":         {"context_window": 200_000, "max_output_tokens": 8_192},
    "chatgpt/gpt-4o":                    {"context_window": 128_000, "max_output_tokens": 16_384},
    "chatgpt/gpt-4o-mini":               {"context_window": 128_000, "max_output_tokens": 16_384},
    "chatgpt/o3":                        {"context_window": 200_000, "max_output_tokens": 100_000},
    "chatgpt/o4-mini":                   {"context_window": 200_000, "max_output_tokens": 100_000},
    "groq/llama-3.3-70b-versatile":      {"context_window": 128_000, "max_output_tokens": 32_768},
    "groq/llama-3.1-8b-instant":         {"context_window": 128_000, "max_output_tokens": 8_192},
    "groq/mixtral-8x7b-32768":           {"context_window": 32_768,  "max_output_tokens": 4_096},
    "gemini/gemini-2.5-flash":           {"context_window": 1_048_576, "max_output_tokens": 65_536},
    "gemini/gemini-2.5-pro":             {"context_window": 1_048_576, "max_output_tokens": 65_536},
}


def get_model_spec(model_id: str) -> tuple[int, int]:
    """Return (context_window, max_output_tokens) for a model, with sensible defaults."""
    spec = MODEL_SPECS.get(model_id, {})
    return (
        spec.get("context_window", _DEFAULT_CONTEXT_WINDOW),
        spec.get("max_output_tokens", _DEFAULT_MAX_OUTPUT_TOKENS),
    )


def get_provider_catalog() -> list[dict]:
    """Return a summary of each provider: slug, name, type, availability, model count, default model."""
    _PROVIDER_META: list[dict] = [
        {"slug": "ollama",      "name": "Ollama",              "type": "local",        "instance": _ollama,
         "available": True,     "default_model": settings.default_ollama_model},
        {"slug": "chatgpt",     "name": "ChatGPT Plus/Pro",    "type": "subscription", "instance": _chatgpt_subscription,
         "available": _chatgpt_subscription.is_available, "default_model": settings.default_chatgpt_model},
        {"slug": "groq",        "name": "Groq",                "type": "free",         "instance": _groq,
         "available": bool(settings.groq_api_key),        "default_model": settings.default_groq_model},
        {"slug": "gemini",      "name": "Gemini",              "type": "free",         "instance": _gemini,
         "available": bool(settings.gemini_api_key or settings.gemini_use_adc), "default_model": settings.default_gemini_model},
        {"slug": "cerebras",    "name": "Cerebras",            "type": "free",         "instance": _cerebras,
         "available": bool(settings.cerebras_api_key),    "default_model": settings.default_cerebras_model},
        {"slug": "openrouter",  "name": "OpenRouter",          "type": "free",         "instance": _openrouter,
         "available": bool(settings.openrouter_api_key),  "default_model": settings.default_openrouter_model},
        {"slug": "github",      "name": "GitHub Models",       "type": "free",         "instance": _github,
         "available": bool(settings.github_token),        "default_model": settings.default_github_model},
        {"slug": "anthropic",   "name": "Anthropic API",       "type": "paid",         "instance": _anthropic,
         "available": bool(settings.anthropic_api_key),   "default_model": "claude-sonnet-4-6"},
        {"slug": "openai",      "name": "OpenAI API",          "type": "paid",         "instance": _openai,
         "available": bool(settings.openai_api_key),      "default_model": "gpt-4o"},
        {"slug": "vllm",        "name": "vLLM",                "type": "local",        "instance": _vllm,
         "default_model": None},
        {"slug": "lmstudio",    "name": "LM Studio",           "type": "local",        "instance": _lmstudio,
         "default_model": None},
    ]

    # Count models per provider
    result = []
    for meta in _PROVIDER_META:
        instance = meta["instance"]
        slug = meta["slug"]

        # Resolve availability: use explicit value if set, otherwise check the instance
        if "available" in meta:
            available = meta["available"]
        else:
            available = getattr(instance, "is_available", False)

        count = sum(1 for k, v in MODEL_REGISTRY.items()
                    if v is instance and k != DEFAULT_MODEL_KEY)

        result.append({
            "slug": slug,
            "name": meta["name"],
            "type": meta["type"],
            "available": available,
            "model_count": count,
            "default_model": meta["default_model"],
            # True while the provider is sidelined after a credential
            # rejection (dashboard Provider Status surfaces this).
            "credential_invalid": credential_invalid(getattr(instance, "name", slug)),
        })

    return result


async def _resolve_embed_override() -> tuple[ModelProvider | None, str]:
    """Read the embedding provider override from Redis.

    Config (written by the dashboard EmbeddingModelPicker):
    - ``llm.embed_provider``: "auto" (default) | "lmstudio" | "ollama" |
      "gemini" | "litellm" | "groq" | "cerebras" | "openrouter" | "github"
    - ``llm.embed_model``: model name string to send to the provider (used
      when the override is active; ignored when "auto").

    Returns ``(provider_or_None, effective_model)``. ``provider`` is None when
    the override is unset/"auto" — the caller falls back to model-name registry
    lookup (``get_embed_provider``), preserving today's behavior.

    Rationale: embeddings bypass chat routing (see get_embed_provider). Without
    this override, a model name can only ever map to ONE provider in the registry
    — so "route embeddings through LM Studio" (even for a cloud model LM Studio
    proxies) was impossible. This lets the user pin embeddings to any provider.
    """
    slug = await _get_redis_config("llm.embed_provider", "auto")
    model = await _get_redis_config("llm.embed_model", "")
    if not slug or slug == "auto":
        return None, ""

    overrides: dict[str, ModelProvider] = {
        "lmstudio": _lmstudio,
        "ollama": _ollama,
        "gemini": _gemini,
        "litellm": _litellm,
        "anthropic": _anthropic,
        "openai": _openai,
        "groq": _groq,
        "cerebras": _cerebras,
        "openrouter": _openrouter,
        "github": _github,
    }
    provider = overrides.get(slug)
    if provider is None:
        log.warning("Unknown llm.embed_provider override '%s', ignoring", slug)
        return None, ""
    # LM Studio's URL/key are runtime-configurable — refresh before use so the
    # instance points at the server the user configured in the dashboard.
    if slug == "lmstudio":
        await _refresh_lmstudio_runtime_url()
    return provider, model


async def get_embed_provider(model: str) -> ModelProvider:
    """
    Resolve provider for embedding requests — bypasses chat routing strategy.

    Embeddings are infrastructure (memory depends on them) and must work regardless
    of local-only/cloud-only routing. Direct MODEL_REGISTRY lookup ensures the
    registered provider is used (e.g. Ollama for nomic-embed-text, Gemini for
    text-embedding-004). If that provider is down, the caller (memory-service)
    handles model-level fallback.
    """
    provider = MODEL_REGISTRY.get(model)
    if provider is not None:
        return provider
    log.warning("Unknown embedding model '%s', using default fallback provider", model)
    return MODEL_REGISTRY[DEFAULT_MODEL_KEY]


async def get_provider(model: str) -> ModelProvider:
    """
    Look up the provider for a model ID, applying the routing strategy.

    When strategy is local-only or cloud-only, the strategy takes precedence
    over any specific model requested — this ensures the routing setting in
    the dashboard actually controls where requests go, even when the model
    classifier or pipeline requests a specific cloud/local model.
    """
    # Refresh local backend config (cached 5s, no-op most calls)
    await _local.refresh_config()

    strategy = await get_routing_strategy()

    # ── Enforce hard strategies regardless of requested model ─────────
    if strategy == "local-only":
        if not _is_local_model(model):
            log.info("Routing strategy is local-only, redirecting '%s' to local backend", model)
        return _local

    if strategy == "cloud-only":
        if _is_local_model(model):
            log.info("Routing strategy is cloud-only, redirecting '%s' to cloud", model)
            return _cloud_fallback
        # Fall through to normal cloud provider lookup below

    # ── Local model — apply strategy ──────────────────────────────────
    if _is_local_model(model):
        if strategy == "local-first":
            return OllamaCloudFallback(ollama=_local, cloud=_cloud_fallback)
        elif strategy == "cloud-first":
            return OllamaCloudFallback(ollama=_cloud_fallback, cloud=_local)
        else:
            return _local

    # ── Non-local model with soft strategy ────────────────────────────
    # Subscription preference — try zero-cost subscription providers first
    if await get_prefer_subscription():
        if _chatgpt_subscription.is_available:
            return _chatgpt_subscription

    # Direct provider lookup
    provider = MODEL_REGISTRY.get(model) or MODEL_REGISTRY[DEFAULT_MODEL_KEY]
    if model not in MODEL_REGISTRY:
        log.warning("Unknown model '%s', using default fallback provider", model)
    return provider


def get_provider_sync(model: str) -> ModelProvider:
    """Synchronous provider lookup (no strategy awareness). Used by health checks."""
    provider = MODEL_REGISTRY.get(model) or MODEL_REGISTRY[DEFAULT_MODEL_KEY]
    return provider


def get_ollama_provider() -> OllamaProvider:
    """Direct access to the Ollama provider instance (for health checks)."""
    return _ollama


def get_local_provider() -> LocalInferenceProvider:
    """Access the local inference wrapper (for catalog and discovery)."""
    return _local
