"""SEC-006a — platform secrets resolver for non-orchestrator services.

Worker services (llm-gateway, chat-bridge) call this helper to fetch a platform
secret with a 30s cache and a transparent ``os.environ`` fallback. The
fallback keeps existing deploys working with their ``.env`` values until the
user moves them into ``platform_secrets`` via Settings → Secrets.

Pattern mirrors :class:`nova_worker_common.admin_secret.AdminSecretResolver`
(lazy connection, 30s cache, env fallback). Differences:

* Transport is HTTP to the orchestrator, not Redis.
* Each key is cached independently — ``get()`` is per-key.
* On env-fallback hit, a one-shot WARN nudges the user to migrate.

Callers MUST NOT log the return value. Callers SHOULD instantiate one resolver
per service (typically at startup) and call ``aclose()`` in lifespan shutdown.
The orchestrator itself does NOT use this — it imports
``orchestrator.app.secrets_store`` directly to avoid self-HTTP loops.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Optional

import httpx

log = logging.getLogger(__name__)

_DEFAULT_CACHE_TTL_SECONDS = 30
_DEFAULT_REQUEST_TIMEOUT_SECONDS = 5.0


class PlatformSecretsResolver:
    """Per-service resolver for platform secrets with env fallback.

    Resolution order on cache miss:

    1. ``POST {orchestrator_url}/api/v1/admin/secrets/resolve`` with the
       ``X-Admin-Secret`` header.
    2. On miss (or on HTTP error), fall back to ``os.environ``.
    3. Return ``None`` if neither source has the value.

    The resolved value (or "miss" marker) is cached for ``cache_ttl_seconds``.
    Rotation is therefore eventually-consistent within that window. Hot
    reload on rotation is FU-009 — out of scope for SEC-006a.
    """

    def __init__(
        self,
        *,
        orchestrator_url: str,
        admin_secret: str,
        cache_ttl_seconds: int = _DEFAULT_CACHE_TTL_SECONDS,
        request_timeout: float = _DEFAULT_REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        self._url = orchestrator_url.rstrip("/")
        self._admin_secret = admin_secret
        self._ttl = cache_ttl_seconds
        self._timeout = request_timeout
        # key -> (value_or_None, ts_monotonic)
        self._cache: dict[str, tuple[Optional[str], float]] = {}
        self._warned: set[str] = set()
        self._client: Optional[httpx.AsyncClient] = None

    async def get(self, key: str) -> Optional[str]:
        """Resolve ``key`` from platform_secrets, falling back to ``os.environ``.

        Returns the plaintext value or ``None`` if neither source has it.
        Logs exactly one WARN per key on env fallback.
        """
        now = time.monotonic()
        cached = self._cache.get(key)
        if cached is not None and (now - cached[1]) < self._ttl:
            return cached[0]

        value = await self._resolve_remote(key)
        if value is None:
            env_value = os.getenv(key)
            if env_value:
                value = env_value
                if key not in self._warned:
                    log.warning(
                        "platform_secrets fallback: %s served from .env. "
                        "Set it via Settings → Secrets to harden.",
                        key,
                    )
                    self._warned.add(key)

        self._cache[key] = (value, now)
        return value

    async def _resolve_remote(self, key: str) -> Optional[str]:
        try:
            client = await self._ensure_client()
            r = await client.post(
                f"{self._url}/api/v1/admin/secrets/resolve",
                headers={"X-Admin-Secret": self._admin_secret},
                json={"keys": [key]},
            )
            r.raise_for_status()
            return r.json().get("values", {}).get(key)
        except Exception as e:
            log.debug(
                "platform_secrets resolve(%s) failed (%s) — falling through to env",
                key,
                e,
            )
            return None

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            try:
                await self._client.aclose()
            finally:
                self._client = None
