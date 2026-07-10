"""FU-009 — runtime platform-secrets overlay for the gateway.

``os.environ`` is the single effective credential store at runtime: boot and
every hot-reload recompute it as the ``.env`` layer (frozen in ``settings``)
with the platform_secrets layer (dashboard-managed, encrypted) applied on top.
LiteLLM adapters read credentials from the environment at request time, so a
recompute applies live — no provider reconstruction or restart needed for any
provider that doesn't capture its key at __init__ (registry re-keys those two:
Gemini, ChatGPT subscription).

Leaf module: imported by registry and discovery; imports only config.
"""
from __future__ import annotations

import logging
import os

from app.config import settings

log = logging.getLogger(__name__)

# env var → Settings attribute holding the .env-layer value. Adding a provider
# key here is what makes it hot-reloadable (keep in sync with the dashboard's
# PROVIDER_SECRET_KEY map and the orchestrator's BOOTSTRAP_KEYS).
SECRET_ENV_KEYS: dict[str, str] = {
    "ANTHROPIC_API_KEY": "anthropic_api_key",
    "OPENAI_API_KEY": "openai_api_key",
    "GROQ_API_KEY": "groq_api_key",
    "GEMINI_API_KEY": "gemini_api_key",
    "CEREBRAS_API_KEY": "cerebras_api_key",
    "OPENROUTER_API_KEY": "openrouter_api_key",
    "GITHUB_TOKEN": "github_token",
    "NVIDIA_NIM_API_KEY": "nvidia_api_key",
    "CHATGPT_ACCESS_TOKEN": "chatgpt_access_token",
}


def effective_key(env_key: str) -> str:
    """Current effective credential for a managed key.

    Post-overlay ``os.environ`` is authoritative — never read key material
    from ``settings``, which is frozen at import and goes stale on rotation.
    """
    return os.environ.get(env_key, "")


def apply_env_overlay(resolved: dict[str, str]) -> list[str]:
    """Recompute ``os.environ`` for every managed key: ``.env`` layer, then
    the platform_secrets layer (``resolved``) on top. A key present in neither
    is removed — that's how a dashboard "Remove" revokes a credential live.

    Idempotent; returns the env keys whose effective value changed.
    """
    changed: list[str] = []
    for env_key, attr in SECRET_ENV_KEYS.items():
        effective = resolved.get(env_key) or getattr(settings, attr, None) or ""
        if effective != os.environ.get(env_key, ""):
            changed.append(env_key)
        if effective:
            os.environ[env_key] = effective
        else:
            os.environ.pop(env_key, None)
    return changed
