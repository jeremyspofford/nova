"""Provider registry — resolves configured provider names to implementations.

Reads provider selection and API keys from Redis config (nova:config:voice.*)
at request time for live runtime configuration. Falls back to env vars / Settings
if Redis is unavailable or keys aren't set.

Providers are cached per provider+key combo to reuse HTTP connection pools.
Cache is invalidated when the key changes (e.g., user saves a new key in Settings).
"""
from __future__ import annotations

import json
import logging

from app.config import settings

from .base import STTProvider, TTSProvider

log = logging.getLogger(__name__)

_stt_cache: dict[str, STTProvider] = {}
_tts_cache: dict[str, TTSProvider] = {}


def _get_redis_config(key: str) -> str | None:
    """Read a config value from Redis synchronously via a fresh connection.

    Uses a blocking Redis call since provider resolution happens at request time
    and needs to be fast. Returns None if Redis is unavailable or key not set.
    """
    try:
        import redis
        r = redis.from_url(settings.redis_url.replace("/9", "/1"), decode_responses=True)
        val = r.get(f"nova:config:{key}")
        r.close()
        if val is not None:
            # Config values are JSON-encoded in Redis
            try:
                return json.loads(val)
            except (json.JSONDecodeError, TypeError):
                return val
        return None
    except Exception:
        return None


def _resolve_api_key(provider: str) -> str:
    """Resolve API key: Redis config → env var → empty string."""
    # Check Redis for dashboard-saved key
    redis_key = _get_redis_config(f"voice.{provider}_api_key")
    if redis_key:
        return redis_key

    # Check for provider-specific key saved via Provider Status section
    # (these are saved as env var names like OPENAI_API_KEY)
    if provider == "openai":
        redis_key = _get_redis_config("openai_api_key")
        if redis_key:
            return redis_key

    # Fall back to env var from Settings
    if provider == "openai":
        return settings.openai_api_key
    return ""


def _resolve_setting(key: str, default: str) -> str:
    """Resolve a voice setting: Redis config → env var default."""
    val = _get_redis_config(f"voice.{key}")
    if val is not None:
        return str(val)
    return default


def get_stt_provider() -> STTProvider:
    """Resolve the configured STT provider. Reads config from Redis for live updates."""
    provider = _resolve_setting("stt_provider", settings.stt_provider)
    api_key = _resolve_api_key(provider)

    cache_key = f"{provider}:{api_key[:8] if api_key else ''}"
    if cache_key not in _stt_cache:
        if provider == "openai":
            from .openai_stt import OpenAISTT
            _stt_cache[cache_key] = OpenAISTT(api_key=api_key)
        else:
            raise ValueError(f"Unknown STT provider: {provider}")
    return _stt_cache[cache_key]


def get_tts_provider() -> TTSProvider:
    """Resolve the configured TTS provider. Reads config from Redis for live updates."""
    provider = _resolve_setting("tts_provider", settings.tts_provider)
    api_key = _resolve_api_key(provider)

    cache_key = f"{provider}:{api_key[:8] if api_key else ''}"
    if cache_key not in _tts_cache:
        if provider == "openai":
            from .openai_tts import OpenAITTS
            _tts_cache[cache_key] = OpenAITTS(api_key=api_key)
        else:
            raise ValueError(f"Unknown TTS provider: {provider}")
    return _tts_cache[cache_key]
