"""Wrapper provider that delegates to whichever local backend is active."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import AsyncIterator, Optional, Set

from app.config import settings
from nova_contracts.llm import (
    CompleteRequest,
    CompleteResponse,
    EmbedRequest,
    EmbedResponse,
    ModelCapability,
    StreamChunk,
)

from .base import ModelProvider
from .ollama_provider import OllamaProvider
from .vllm_provider import VLLMProvider

logger = logging.getLogger(__name__)

# All backends are reached over HTTP. Defaults point at the host on each
# server's conventional port for user-run external servers; when Nova's
# bundled containers are started (recovery service), it writes the in-network
# URL (http://ollama:11434, http://vllm:8000, …) to inference.url, which wins.
# LM Studio is a desktop app and stays external-only (inference.lmstudio_url).
DEFAULT_URLS = {
    "ollama": settings.ollama_base_url,  # resolved host URL (auto/host expanded)
    "vllm": "http://host.docker.internal:8000",
    "sglang": "http://host.docker.internal:30000",
    "llamacpp": "http://host.docker.internal:8080",
    "lmstudio": "http://host.docker.internal:1234",  # desktop app on the host (WSL/Mac/Win)
}

READY_STATES = {"ready"}

# Cloud provider prefixes. A request for one of these is never a local model, so
# when the local provider is used as a fallback for it we substitute the local
# default rather than 404 — otherwise a broken/misconfigured cloud model takes
# the whole local-first chain down with it.
_CLOUD_PREFIXES = frozenset({
    "gemini", "gemini-adc", "cerebras", "openrouter", "openai", "anthropic",
    "groq", "nvidia", "github", "chatgpt",
})


class LocalInferenceProvider(ModelProvider):
    """
    Wrapper that reads active backend config from Redis and delegates.

    Config keys (in Redis nova:config:*):
    - inference.backend: "ollama" | "vllm" | "sglang" | "llamacpp" | "lmstudio" | "custom" | "none"
    - inference.state: "ready" | "draining" | "starting" | "error"
    - inference.url: override URL (empty = default for backend)
    - inference.custom_url: URL for the custom backend
    - inference.custom_auth_header: Authorization header for the custom backend
    """

    def __init__(self):
        self._current_backend: Optional[str] = None
        self._current_url: str = ""
        self._delegate: Optional[ModelProvider] = None
        self._local_models: Set[str] = set()
        self._state: str = "ready"
        self._config_cache_time = 0.0
        self._config_ttl = 5.0
        self._refresh_lock = asyncio.Lock()

    @property
    def name(self) -> str:
        return "local"

    @property
    def capabilities(self) -> set[ModelCapability]:
        if self._delegate:
            return self._delegate.capabilities
        return set()

    @property
    def is_available(self) -> bool:
        return (self._state in READY_STATES and
                self._delegate is not None and
                self._delegate.is_available)

    @property
    def is_local(self) -> bool:
        return True

    def is_local_model(self, model: str) -> bool:
        """Check if a model name belongs to the active local backend."""
        return model in self._local_models

    def update_local_models(self, models: Set[str]) -> None:
        """Update the set of known local models (called by discovery)."""
        self._local_models = models

    async def refresh_config(self) -> None:
        """Read backend config from Redis and swap delegate if changed."""
        now = time.monotonic()
        if (now - self._config_cache_time) < self._config_ttl:
            return

        async with self._refresh_lock:
            # Re-check after acquiring lock (another coroutine may have updated)
            now = time.monotonic()
            if (now - self._config_cache_time) < self._config_ttl:
                return

            self._config_cache_time = now

            try:
                from app.registry import _get_redis_config
                backend = await _get_redis_config("inference.backend", "ollama")
                state = await _get_redis_config("inference.state", "ready")
                url_override = await _get_redis_config("inference.url", "")
                custom_url = ""
                custom_auth = ""
                if backend == "custom":
                    custom_url = await _get_redis_config("inference.custom_url", "")
                    custom_auth = await _get_redis_config("inference.custom_auth_header", "")
                lmstudio_url = ""
                lmstudio_api_key = ""
                if backend == "lmstudio":
                    lmstudio_url = await _get_redis_config("inference.lmstudio_url", "")
                    lmstudio_api_key = await _get_redis_config("inference.lmstudio_api_key", "")
            except Exception:
                logger.debug("Failed to read inference config from Redis, keeping current state")
                return

            self._state = state

            # Effective URL drives delegate swap detection. LM Studio uses its
            # dedicated inference.lmstudio_url (not the shared inference.url
            # override, which is for Ollama/vLLM/SGLang external pointing).
            effective_url = lmstudio_url if backend == "lmstudio" else url_override

            if backend != self._current_backend or effective_url != self._current_url:
                self._current_backend = backend
                self._current_url = effective_url
                self._delegate = self._create_delegate(
                    backend, url_override,
                    custom_url=custom_url, custom_auth=custom_auth,
                    lmstudio_url=lmstudio_url, lmstudio_api_key=lmstudio_api_key,
                )
                self._local_models.clear()
                # Probe the new delegate so it's available immediately
                if self._delegate and hasattr(self._delegate, 'check_health'):
                    await self._delegate.check_health()
                logger.info("Local inference backend changed to: %s", backend)

    def _create_delegate(self, backend: str, url_override: str,
                         custom_url: str = "", custom_auth: str = "",
                         lmstudio_url: str = "", lmstudio_api_key: str = "") -> Optional[ModelProvider]:
        """Create a new provider instance for the given backend."""
        if backend == "none":
            return None

        url = url_override or DEFAULT_URLS.get(backend, "")

        if backend == "ollama":
            return OllamaProvider(base_url=url or DEFAULT_URLS["ollama"])
        elif backend == "vllm":
            return VLLMProvider(base_url=url or DEFAULT_URLS["vllm"])
        elif backend == "sglang":
            from .sglang_provider import SGLangProvider
            return SGLangProvider(base_url=url or DEFAULT_URLS["sglang"])
        elif backend == "llamacpp":
            from .llamacpp_provider import LlamaCppProvider
            return LlamaCppProvider(base_url=url or DEFAULT_URLS["llamacpp"])
        elif backend == "custom":
            if not custom_url:
                logger.warning("Custom backend selected but no URL configured")
                return None
            from .remote_provider import RemoteInferenceProvider
            return RemoteInferenceProvider(url=custom_url, auth_header=custom_auth or None)
        elif backend == "lmstudio":
            # LM Studio uses a dedicated URL/key; the shared inference.url override
            # does NOT apply (it's for Ollama/vLLM/SGLang external pointing).
            from .lmstudio_provider import LMStudioProvider
            lm_url = lmstudio_url or DEFAULT_URLS["lmstudio"]
            headers: dict[str, str] = {}
            if lmstudio_api_key:
                headers["Authorization"] = f"Bearer {lmstudio_api_key}"
            return LMStudioProvider(base_url=lm_url, extra_headers=headers or None)
        else:
            logger.warning("Unknown backend: %s", backend)
            return None

    def _resolve_local_model(self, requested: str) -> str:
        """Map a requested model to one the active local backend can actually serve.

        The local provider sits first in the local-first fallback chain, so it
        receives whatever model the caller asked for — often a cloud model
        (e.g. 'cerebras/llama-3.3-70b') that isn't pulled locally. Rather than
        404 and force the whole chain to fail, serve the configured local default
        so local-first always returns an answer.
        """
        default = settings.default_ollama_model
        if not requested:
            return default
        if self._local_models:
            if requested in self._local_models:
                return requested
            # Discovery knows the local models and this isn't one → substitute.
            return default if default in self._local_models else sorted(self._local_models)[0]
        # No discovery data yet: only override an obvious cloud model, so a valid
        # local name we simply haven't indexed still passes through.
        if requested.split("/", 1)[0] in _CLOUD_PREFIXES:
            return default
        return requested

    def _localize(self, request: CompleteRequest) -> CompleteRequest:
        model = self._resolve_local_model(request.model)
        if model != request.model:
            logger.info(
                "Local backend can't serve '%s'; using local default '%s'",
                request.model, model,
            )
            return request.model_copy(update={"model": model})
        return request

    async def complete(self, request: CompleteRequest) -> CompleteResponse:
        await self.refresh_config()
        self._assert_available()
        return await self._delegate.complete(self._localize(request))

    async def stream(self, request: CompleteRequest) -> AsyncIterator[StreamChunk]:
        await self.refresh_config()
        self._assert_available()
        async for chunk in self._delegate.stream(self._localize(request)):
            yield chunk

    async def embed(self, request: EmbedRequest) -> EmbedResponse:
        await self.refresh_config()
        self._assert_available()
        return await self._delegate.embed(request)
