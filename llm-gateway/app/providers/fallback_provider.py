"""
FallbackProvider — wraps multiple providers, tries them in order on failure.
If Anthropic is rate-limited, falls back to OpenAI; if that fails, tries Ollama.

Two per-member behaviors make the chain actually survivable:

**Model substitution.** A local model name ("llama3.2",
"openbmb/minicpm5:latest") means nothing to a cloud provider — forwarding it
raw guarantees every cloud member 404s and the whole chain dies (the exact
outage behind the 2026-07-10 curation audit). When a non-local member receives
a non-cloud model name, it runs the operator-configured
``llm.cloud_fallback_model`` if that model belongs to this member, otherwise
its own default model. The local member is left alone — LocalInferenceProvider
does the mirror-image substitution itself (cloud name → local default).

**Retry hints.** Free-tier 429s carry an explicit "retry in Ns" hint (Gemini's
is ~6s). When the hint is short we sleep and retry the same member once before
failing over — one burst from a parallel agent group no longer kills the whole
group. Hints longer than MAX_RETRY_HINT_SECONDS mean "quota exhausted";
those fail over immediately.
"""
from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator

from app.config import settings
from app.providers.base import ModelProvider
from app.providers.credential_guard import (
    credential_invalid,
    is_credential_error,
    mark_credential_invalid,
)
from app.providers.retry_hints import MAX_RETRY_HINT_SECONDS, rate_limit_retry_delay
from app.providers.utils import is_cloud_model_name
from nova_contracts import (
    CompleteRequest,
    CompleteResponse,
    EmbedRequest,
    EmbedResponse,
    ModelCapability,
    StreamChunk,
)

log = logging.getLogger(__name__)


async def _configured_cloud_fallback_model() -> str:
    """The operator-configured cloud substitute for local model names.

    Runtime value (``llm.cloud_fallback_model`` in Redis, editable from
    Settings → LLM Routing) with the boot-time setting as default. Imported
    lazily to keep this module free of the registry's import-time side
    effects (tests monkeypatch this function directly).
    """
    try:
        from app.registry import _get_redis_config
        return await _get_redis_config(
            "llm.cloud_fallback_model", settings.ollama_cloud_fallback_model
        )
    except Exception:
        return settings.ollama_cloud_fallback_model


def _provider_serves(provider: ModelProvider, model: str) -> bool:
    """Best-effort check that *model*'s provider prefix matches this member."""
    if "/" in model:
        prefix = model.split("/", 1)[0]
    elif model.startswith("claude"):
        prefix = "anthropic"
    elif model.startswith("gpt-") or model.startswith(("o1-", "o3-", "o4-")):
        prefix = "openai"
    elif model.startswith("gemini"):
        prefix = "gemini"
    else:
        return False
    label = getattr(provider, "_label", None) or provider.name
    label = label.removeprefix("litellm-")
    # gemini-adc → gemini, chatgpt-subscription → chatgpt, nvidia_nim → nvidia
    return label.split("-")[0] == prefix.split("_")[0]


class FallbackProvider(ModelProvider):
    """
    Wraps an ordered list of providers with automatic failover.
    Providers are tried in order; the first successful response wins.
    """

    def __init__(self, providers: list[ModelProvider], timeout_seconds: float = 30.0):
        if not providers:
            raise ValueError("FallbackProvider requires at least one provider")
        self._providers = providers
        self._timeout = timeout_seconds

    def replace_providers(self, providers: list[ModelProvider]) -> None:
        """Swap the failover chain in place (FU-009 secret hot-reload) —
        MODEL_REGISTRY holds references to this instance, so mutate rather
        than rebuild."""
        if not providers:
            raise ValueError("FallbackProvider requires at least one provider")
        self._providers = providers

    @property
    def name(self) -> str:
        return f"fallback({','.join(p.name for p in self._providers)})"

    @property
    def is_local(self) -> bool:
        return any(p.is_local for p in self._providers)

    @property
    def capabilities(self) -> set[ModelCapability]:
        # Union of all provider capabilities
        result: set[ModelCapability] = set()
        for p in self._providers:
            result |= p.capabilities
        return result

    async def _leg_request(
        self, provider: ModelProvider, request: CompleteRequest
    ) -> CompleteRequest:
        """The request this member actually runs.

        Local members and cloud-named requests pass through untouched. A cloud
        member receiving a local-style model name gets a substitute it can
        serve — the configured cloud fallback model when it belongs to this
        member, else the member's own default.
        """
        model = request.model or ""
        if provider.is_local or not model or is_cloud_model_name(model):
            return request

        configured = await _configured_cloud_fallback_model()
        if configured and _provider_serves(provider, configured):
            substitute = configured
        else:
            substitute = getattr(provider, "_default_model", None) or configured
        if not substitute or substitute == model:
            return request
        log.info(
            "Provider %s can't serve local model '%s'; substituting '%s'",
            provider.name, model, substitute,
        )
        return request.model_copy(update={"model": substitute})

    async def complete(self, request: CompleteRequest) -> CompleteResponse:
        last_error: Exception | None = None
        for provider in self._providers:
            if credential_invalid(provider.name):
                log.debug("Skipping %s — credentials in rejection cooldown", provider.name)
                continue
            leg = await self._leg_request(provider, request)
            try:
                log.debug("Attempting completion with provider: %s", provider.name)
                return await provider.complete(leg)
            except Exception as e:
                delay = rate_limit_retry_delay(e)
                if delay is not None and delay <= MAX_RETRY_HINT_SECONDS:
                    log.info(
                        "Provider %s rate-limited (hint %.1fs) — waiting, then retrying once",
                        provider.name, delay,
                    )
                    await asyncio.sleep(delay)
                    try:
                        return await provider.complete(leg)
                    except Exception as e2:
                        e = e2
                if is_credential_error(e):
                    mark_credential_invalid(provider.name)
                log.warning("Provider %s failed: %s — trying next", provider.name, e)
                last_error = e

        raise RuntimeError(f"All providers failed. Last error: {last_error}") from last_error

    async def stream(self, request: CompleteRequest) -> AsyncIterator[StreamChunk]:
        # Streaming fallback: try providers until one succeeds on first chunk
        for provider in self._providers:
            if credential_invalid(provider.name):
                log.debug("Skipping %s — credentials in rejection cooldown", provider.name)
                continue
            leg = await self._leg_request(provider, request)
            yielded = False
            for attempt in (0, 1):
                try:
                    async for chunk in provider.stream(leg):
                        yielded = True
                        yield chunk
                    return
                except Exception as e:
                    if yielded:
                        # Mid-stream failure after output was sent — retrying
                        # any provider would duplicate content for the caller.
                        log.error(
                            "Streaming provider %s failed mid-stream: %s", provider.name, e
                        )
                        raise
                    delay = rate_limit_retry_delay(e)
                    if attempt == 0 and delay is not None and delay <= MAX_RETRY_HINT_SECONDS:
                        log.info(
                            "Provider %s rate-limited (hint %.1fs) — waiting, then retrying once",
                            provider.name, delay,
                        )
                        await asyncio.sleep(delay)
                        continue
                    if is_credential_error(e):
                        mark_credential_invalid(provider.name)
                    log.warning("Streaming provider %s failed: %s — trying next", provider.name, e)
                    break

        raise RuntimeError("All streaming providers failed")

    async def embed(self, request: EmbedRequest) -> EmbedResponse:
        last_error: Exception | None = None
        for provider in self._providers:
            if not provider.supports(ModelCapability.embeddings):
                continue
            if credential_invalid(provider.name):
                log.debug("Skipping %s — credentials in rejection cooldown", provider.name)
                continue
            try:
                return await provider.embed(request)
            except Exception as e:
                if is_credential_error(e):
                    mark_credential_invalid(provider.name)
                log.warning("Embed provider %s failed: %s", provider.name, e)
                last_error = e

        raise RuntimeError(f"All embedding providers failed. Last error: {last_error}") from last_error
