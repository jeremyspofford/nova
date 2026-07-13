"""Chain-facing wrapper that routes over the backend pool.

Phase 1 of the models/inference unified plan: "local" is no longer one
active backend but a pool of named entries (``app.pool``). This provider
keeps the fallback-chain contract (one ``ModelProvider`` named "local", so
routing strategies keep their meaning) while routing each request to the
pool entry whose discovered catalog serves the requested model — falling
back to the primary (first enabled) entry with model substitution, so
local-first still always answers.
"""
from __future__ import annotations

import logging
import time
from typing import AsyncIterator, Set

import httpx
from app.config import settings

# Re-exported: callers historically import the conventional per-engine
# default URLs from this module. app.pool has no import-time dependency on
# app.providers, so this does not cycle.
from app.pool import DEFAULT_ENGINE_URLS as DEFAULT_URLS  # noqa: F401
from nova_contracts.llm import (
    CompleteRequest,
    CompleteResponse,
    EmbedRequest,
    EmbedResponse,
    ModelCapability,
    StreamChunk,
)

from .base import ModelProvider
from .utils import is_cloud_model_name

logger = logging.getLogger(__name__)

_CATALOG_TTL = 30.0

# Pool-wide acceptance gate — recovery writes inference.state during bundled
# container lifecycle ("starting" while compose pulls/boots, "draining" on
# stop). Transitional: becomes per-entry state when container entries carry
# their own lifecycle in a later slice.
READY_STATES = {"ready"}


class LocalInferenceProvider(ModelProvider):
    """Routes chain traffic to the right pool backend.

    The pool (``app.pool.pool``) owns entries, delegates, and catalogs;
    this class owns request routing and catalog freshness.
    """

    def __init__(self):
        self._catalog_probed_at: dict[str, float] = {}  # backend id → monotonic
        # Legacy catalog feeder (sync_vllm_models / sync_lmstudio_models push
        # here before pool probes run). Merged into resolution as a fallback.
        self._local_models: Set[str] = set()
        self._state: str = "ready"

    @property
    def name(self) -> str:
        return "local"

    @property
    def capabilities(self) -> set[ModelCapability]:
        rt = self._pool().primary()
        return rt.delegate.capabilities if rt else set()

    @property
    def is_available(self) -> bool:
        return (
            self._state in READY_STATES
            and any(rt.available for rt in self._pool().enabled_runtimes())
        )

    @property
    def is_local(self) -> bool:
        return True

    def _pool(self):
        from app.pool import pool
        return pool

    # ── Catalog interface (registry + discovery) ─────────────────────────

    def is_local_model(self, model: str) -> bool:
        """Whether any enabled pool backend serves this model."""
        if self._pool().resolve_model(model) is not None:
            return True
        return model in self._local_models

    def update_local_models(self, models: Set[str]) -> None:
        """Legacy feeder — external syncs push discovered models here."""
        self._local_models = set(models)

    async def refresh_config(self) -> None:
        """Refresh pool entries, acceptance state, and stale model catalogs."""
        pool = self._pool()
        await pool.refresh()
        try:
            from app.registry import _get_redis_config
            self._state = await _get_redis_config("inference.state", "ready")
        except Exception:
            pass  # keep last-known state
        now = time.monotonic()
        for rt in pool.enabled_runtimes():
            if (now - self._catalog_probed_at.get(rt.entry.id, 0.0)) < _CATALOG_TTL:
                continue
            self._catalog_probed_at[rt.entry.id] = now
            await self._probe_catalog(rt)

    async def _probe_catalog(self, rt) -> None:
        """Fetch one backend's model list (engine-aware). Never raises."""
        entry = rt.entry
        headers = {"Authorization": entry.auth_header} if entry.auth_header else {}
        try:
            async with httpx.AsyncClient(timeout=5.0, headers=headers) as client:
                if entry.engine == "ollama":
                    resp = await client.get(f"{entry.url}/api/tags")
                    resp.raise_for_status()
                    models = {m["name"] for m in resp.json().get("models", [])}
                else:
                    resp = await client.get(f"{entry.url}/v1/models")
                    resp.raise_for_status()
                    models = {
                        m.get("id", "") for m in resp.json().get("data", [])
                    } - {""}
            rt.models = models
            if hasattr(rt.delegate, "check_health"):
                await rt.delegate.check_health()
            logger.debug("Backend '%s': %d model(s) discovered", entry.id, len(models))
        except Exception as e:
            # Unreachable backend keeps its last-known catalog; health flag
            # on the delegate governs availability.
            logger.debug("Backend '%s' catalog probe failed: %s", entry.id, e)
            if hasattr(rt.delegate, "check_health"):
                try:
                    await rt.delegate.check_health()
                except Exception:
                    pass

    # ── Request routing ───────────────────────────────────────────────────

    def _route(self, model: str):
        """(runtime, resolved_model) for a request — catalog owner if any,
        else the primary backend with model substitution."""
        pool = self._pool()
        rt = pool.resolve_model(model)
        if rt is not None and rt.available:
            return rt, model
        primary = pool.primary()
        if primary is None:
            return None, model
        return primary, self._substitute(primary, model)

    def _substitute(self, rt, requested: str) -> str:
        """Map an unservable model onto one the target backend has.

        The local provider sits first in the local-first chain, so it often
        receives cloud model names. Rather than 404 and fail the whole
        chain, serve the configured default (when pulled) or the backend's
        first available model.
        """
        default = settings.default_ollama_model
        if not requested:
            return default
        if rt.models:
            if requested in rt.models:
                return requested
            if ":" not in requested and f"{requested}:latest" in rt.models:
                return f"{requested}:latest"
            return default if default in rt.models else sorted(rt.models)[0]
        # No catalog yet: only override an obvious cloud model so a valid
        # local name we haven't indexed still passes through.
        if is_cloud_model_name(requested):
            return default
        return requested

    def _prepare(self, request: CompleteRequest):
        if self._state not in READY_STATES:
            raise RuntimeError(
                f"Local inference is not accepting requests (state="
                f"{self._state!r})."
            )
        rt, model = self._route(request.model)
        if rt is None:
            raise RuntimeError(
                "No local inference backend is enabled (the backend pool is "
                "empty or every entry is disabled/unreachable)."
            )
        if model != request.model:
            logger.info(
                "Backend '%s' can't serve '%s'; using '%s'",
                rt.entry.id, request.model, model,
            )
            request = request.model_copy(update={"model": model})
        return rt, request

    async def complete(self, request: CompleteRequest) -> CompleteResponse:
        await self.refresh_config()
        rt, request = self._prepare(request)
        return await rt.delegate.complete(request)

    async def stream(self, request: CompleteRequest) -> AsyncIterator[StreamChunk]:
        await self.refresh_config()
        rt, request = self._prepare(request)
        async for chunk in rt.delegate.stream(request):
            yield chunk

    async def embed(self, request: EmbedRequest) -> EmbedResponse:
        await self.refresh_config()
        pool = self._pool()
        rt = pool.resolve_model(getattr(request, "model", "") or "")
        if rt is None or not rt.available:
            rt = pool.primary()
        if rt is None:
            raise RuntimeError("No local inference backend is enabled for embeddings.")
        return await rt.delegate.embed(request)
