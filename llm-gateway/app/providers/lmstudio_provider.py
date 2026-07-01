"""LM Studio inference provider — OpenAI-compatible desktop server.

LM Studio is a desktop GUI app (macOS/Windows/Linux) that exposes an
OpenAI-compatible local server on port 1234 by default. Unlike the
container-managed backends (Ollama/vLLM/SGLang), Nova does NOT manage the
LM Studio process — the user starts it themselves and loads models via its
GUI. The gateway simply talks to its HTTP API.

The default URL uses ``host.docker.internal`` so a host-colocated LM Studio
(e.g. running on Windows while Nova runs in WSL/Docker) is reachable from
inside the gateway container. The llm-gateway service has
``extra_hosts: host.docker.internal:host-gateway`` for exactly this.

LM Studio is multi-model and user-managed (like Ollama), NOT single-model
switchable like vLLM/SGLang — Nova discovers loaded models via ``/v1/models``
and never tries to swap them.
"""
from __future__ import annotations

import logging
from typing import Optional, Set

from nova_contracts.llm import ModelCapability

from .openai_compatible_provider import OpenAICompatibleProvider

logger = logging.getLogger(__name__)

DEFAULT_LMSTUDIO_URL = "http://host.docker.internal:1234"


class LMStudioProvider(OpenAICompatibleProvider):
    """Provider for an LM Studio OpenAI-compatible local server.

    A single shared instance is kept in the registry (``_lmstudio``); its
    ``base_url`` / auth headers are refreshed from Redis runtime config
    (``inference.lmstudio_url`` / ``inference.lmstudio_api_key``) before use,
    so changing the URL in the dashboard takes effect without a restart.
    """

    def __init__(self, base_url: str = DEFAULT_LMSTUDIO_URL, extra_headers: Optional[dict] = None):
        super().__init__(
            base_url=base_url,
            provider_name="lmstudio",
            capabilities={
                ModelCapability.chat,
                ModelCapability.streaming,
                ModelCapability.embeddings,
                ModelCapability.function_calling,
                ModelCapability.structured_output,
            },
            extra_headers=extra_headers,
        )

    async def check_health(self) -> bool:
        """Health check via ``/v1/models``.

        LM Studio's OpenAI-compatible server reliably exposes ``/v1/models``
        (returning the currently-loaded models). ``/health`` is not guaranteed
        across LM Studio versions, so we probe the models endpoint instead —
        a 200 means the server is up and serving.
        """
        import time
        import httpx

        now = time.monotonic()
        if (now - self._last_health_check) < self._health_check_interval:
            return self._healthy

        async with self._health_lock:
            now = time.monotonic()
            if (now - self._last_health_check) < self._health_check_interval:
                return self._healthy

            try:
                async with httpx.AsyncClient(timeout=3.0, headers=self._extra_headers) as client:
                    r = await client.get(f"{self._base_url}/v1/models")
                    self._healthy = r.status_code == 200
            except httpx.HTTPError:
                self._healthy = False

            self._last_health_check = now
            return self._healthy
