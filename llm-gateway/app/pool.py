"""Backend pool — Phase 1 of the models/inference unified plan.

Turns the single active local backend (scalar ``inference.backend`` +
``inference.url``) into a **list of named backend instances** stored as JSON
under ``nova:config:inference.backends``. Multiple containers and multiple
user-named remotes (``remote-vllm-a``, ``remote-vllm-b``) coexist; each entry
carries its own delegate provider and discovered model catalog.

The ``LocalInferenceProvider`` singleton (``registry._local``) remains the
member of the fallback chains — but it routes over this pool instead of
wrapping one delegate, so routing strategies (local-first, …) keep their
meaning while "local" becomes plural underneath.

Entry shape (stored verbatim in Redis):
    {"id": "bundled-ollama", "kind": "container", "engine": "ollama",
     "url": "http://ollama:11434", "enabled": true, "auth_header": ""}

- ``id``     unique, user-visible name; also the stable handle for CRUD.
- ``kind``   "container" (Nova-managed compose service) | "remote" (user-run).
- ``engine`` picks the delegate class: ollama | vllm | sglang | llamacpp |
             lmstudio | openai (generic OpenAI-compatible endpoint).
- ``auth_header`` optional full Authorization header value.

Writers: recovery-service (container start/stop upserts), the dashboard
Models page (remote CRUD via /v1/backends). A one-time seed at gateway
startup migrates the legacy scalar keys so live instances converge without
manual steps.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

from app.config import settings

if TYPE_CHECKING:
    from app.providers.base import ModelProvider

log = logging.getLogger(__name__)

POOL_KEY = "inference.backends"
_POOL_REDIS_KEY = f"nova:config:{POOL_KEY}"

VALID_KINDS = {"container", "remote"}
VALID_ENGINES = {"ollama", "vllm", "sglang", "llamacpp", "lmstudio", "openai"}

# Conventional host-side default ports per engine (external, user-run servers).
DEFAULT_ENGINE_URLS = {
    "ollama": "http://host.docker.internal:11434",
    "vllm": "http://host.docker.internal:8000",
    "sglang": "http://host.docker.internal:30000",
    "llamacpp": "http://host.docker.internal:8080",
    "lmstudio": "http://host.docker.internal:1234",
}

_CACHE_TTL = 5.0


@dataclass
class BackendEntry:
    id: str
    kind: str            # container | remote
    engine: str          # ollama | vllm | sglang | llamacpp | lmstudio | openai
    url: str
    enabled: bool = True
    auth_header: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id, "kind": self.kind, "engine": self.engine,
            "url": self.url, "enabled": self.enabled,
            "auth_header": self.auth_header,
        }

    @classmethod
    def from_dict(cls, raw: dict) -> "BackendEntry":
        entry = cls(
            id=str(raw.get("id", "")).strip(),
            kind=str(raw.get("kind", "remote")),
            engine=str(raw.get("engine", "")),
            url=str(raw.get("url", "")).rstrip("/"),
            enabled=bool(raw.get("enabled", True)),
            auth_header=str(raw.get("auth_header", "") or ""),
        )
        entry.validate()
        return entry

    def validate(self) -> None:
        if not self.id:
            raise ValueError("backend entry needs a non-empty id")
        if self.kind not in VALID_KINDS:
            raise ValueError(f"backend '{self.id}': kind must be one of {sorted(VALID_KINDS)}")
        if self.engine not in VALID_ENGINES:
            raise ValueError(f"backend '{self.id}': engine must be one of {sorted(VALID_ENGINES)}")
        if not self.url:
            raise ValueError(f"backend '{self.id}': url is required")


@dataclass
class BackendRuntime:
    """A pool entry plus its live state: delegate provider + model catalog."""
    entry: BackendEntry
    delegate: "ModelProvider"
    models: set[str] = field(default_factory=set)

    @property
    def available(self) -> bool:
        return self.entry.enabled and self.delegate.is_available


def _build_delegate(entry: BackendEntry) -> "ModelProvider":
    """Instantiate the engine-specific provider for one pool entry.

    Mirrors the old LocalInferenceProvider._create_delegate, but per entry —
    two remotes of the same engine get independent instances.
    """
    headers = {"Authorization": entry.auth_header} if entry.auth_header else None

    if entry.engine == "ollama":
        from app.providers.ollama_provider import OllamaProvider
        return OllamaProvider(base_url=entry.url)
    if entry.engine == "vllm":
        from app.providers.vllm_provider import VLLMProvider
        return VLLMProvider(base_url=entry.url)
    if entry.engine == "sglang":
        from app.providers.sglang_provider import SGLangProvider
        return SGLangProvider(base_url=entry.url)
    if entry.engine == "llamacpp":
        from app.providers.llamacpp_provider import LlamaCppProvider
        return LlamaCppProvider(base_url=entry.url)
    if entry.engine == "lmstudio":
        from app.providers.lmstudio_provider import LMStudioProvider
        return LMStudioProvider(base_url=entry.url, extra_headers=headers)
    # "openai" — any OpenAI-compatible endpoint (replaces the old "custom" backend)
    from app.providers.remote_provider import RemoteInferenceProvider
    return RemoteInferenceProvider(url=entry.url, auth_header=entry.auth_header or None)


class BackendPool:
    """Redis-backed pool of named local-inference backends.

    Reads ``inference.backends`` with a short TTL cache and keeps one
    BackendRuntime per entry, rebuilding delegates only for entries whose
    config actually changed (URL/engine/auth), so catalogs and health
    survive unrelated edits.
    """

    def __init__(self) -> None:
        self._runtimes: dict[str, BackendRuntime] = {}
        self._raw_json: str = ""          # last-applied serialized entries
        self._fetched_at: float = 0.0
        self._lock = asyncio.Lock()

    # ── Entry storage ─────────────────────────────────────────────────────

    async def _read_raw(self) -> str:
        from app.registry import _get_strategy_redis
        r = await _get_strategy_redis()
        return await r.get(_POOL_REDIS_KEY) or ""

    async def _write_entries(self, entries: list[BackendEntry]) -> None:
        from app.registry import _get_strategy_redis
        r = await _get_strategy_redis()
        payload = json.dumps([e.to_dict() for e in entries])
        await r.set(_POOL_REDIS_KEY, payload)
        # Apply immediately — don't wait out the TTL after our own write.
        async with self._lock:
            self._apply(payload)
            self._fetched_at = time.monotonic()

    def _apply(self, raw_json: str) -> None:
        """Rebuild runtimes from a serialized entry list (idempotent)."""
        if raw_json == self._raw_json:
            return
        entries: list[BackendEntry] = []
        try:
            parsed = json.loads(raw_json) if raw_json else []
            if not isinstance(parsed, list):
                raise ValueError("inference.backends must be a JSON list")
            for item in parsed:
                entries.append(BackendEntry.from_dict(item))
        except Exception as e:
            log.warning("Ignoring invalid %s: %s", POOL_KEY, e)
            return

        next_runtimes: dict[str, BackendRuntime] = {}
        for entry in entries:
            current = self._runtimes.get(entry.id)
            if (
                current is not None
                and current.entry.engine == entry.engine
                and current.entry.url == entry.url
                and current.entry.auth_header == entry.auth_header
            ):
                # Same wiring — keep delegate + discovered catalog, take new flags.
                current.entry = entry
                next_runtimes[entry.id] = current
            else:
                next_runtimes[entry.id] = BackendRuntime(
                    entry=entry, delegate=_build_delegate(entry),
                )
        self._runtimes = next_runtimes
        self._raw_json = raw_json
        log.info(
            "Backend pool applied: %d entr%s (%s)",
            len(entries), "y" if len(entries) == 1 else "ies",
            ", ".join(f"{e.id}[{'on' if e.enabled else 'off'}]" for e in entries) or "empty",
        )

    async def refresh(self, force: bool = False) -> None:
        """Re-read entries from Redis (TTL-cached)."""
        now = time.monotonic()
        if not force and (now - self._fetched_at) < _CACHE_TTL:
            return
        async with self._lock:
            now = time.monotonic()
            if not force and (now - self._fetched_at) < _CACHE_TTL:
                return
            self._fetched_at = now
            try:
                raw = await self._read_raw()
            except Exception as e:
                log.debug("Pool refresh failed (keeping current entries): %s", e)
                return
            self._apply(raw)

    # ── Queries ───────────────────────────────────────────────────────────

    def runtimes(self) -> list[BackendRuntime]:
        """All runtimes in configured order (enabled and disabled)."""
        return list(self._runtimes.values())

    def enabled_runtimes(self) -> list[BackendRuntime]:
        return [rt for rt in self._runtimes.values() if rt.entry.enabled]

    def get(self, backend_id: str) -> Optional[BackendRuntime]:
        return self._runtimes.get(backend_id)

    def resolve_model(self, model: str) -> Optional[BackendRuntime]:
        """First enabled backend whose discovered catalog serves ``model``.

        ``name`` and ``name:latest`` are the same Ollama model — accept either
        spelling so pins and pulls line up (same aliasing as the orchestrator's
        pin guard).
        """
        if not model:
            return None
        candidates = {model}
        if ":" not in model:
            candidates.add(f"{model}:latest")
        elif model.endswith(":latest"):
            candidates.add(model.rsplit(":", 1)[0])
        for rt in self.enabled_runtimes():
            if rt.models & candidates:
                return rt
        return None

    def all_models(self) -> set[str]:
        """Union of every enabled backend's discovered models."""
        out: set[str] = set()
        for rt in self.enabled_runtimes():
            out |= rt.models
        return out

    def primary(self) -> Optional[BackendRuntime]:
        """First enabled entry — the default target when a requested model
        isn't in any catalog (the pool-level analogue of the old single
        active backend)."""
        enabled = self.enabled_runtimes()
        return enabled[0] if enabled else None

    def merge_models(self, engine: str, models: set[str]) -> None:
        """Merge externally-discovered models into the first enabled entry
        of ``engine``. Bridge for the legacy sync_* helpers (they discover
        via their own probes); the router's own catalog probe refreshes the
        authoritative set on its TTL."""
        for rt in self.enabled_runtimes():
            if rt.entry.engine == engine:
                rt.models |= models
                return

    # ── Mutations (used by /v1/backends CRUD and recovery upserts) ────────

    async def list_entries(self) -> list[BackendEntry]:
        await self.refresh(force=True)
        return [rt.entry for rt in self._runtimes.values()]

    async def upsert(self, entry: BackendEntry) -> None:
        entry.validate()
        entries = await self.list_entries()
        by_id = {e.id: e for e in entries}
        by_id[entry.id] = entry
        # Preserve configured order; append new entries at the end.
        ordered = [by_id[e.id] for e in entries if e.id in by_id]
        if entry.id not in {e.id for e in entries}:
            ordered.append(entry)
        await self._write_entries(ordered)

    async def remove(self, backend_id: str) -> bool:
        entries = await self.list_entries()
        remaining = [e for e in entries if e.id != backend_id]
        if len(remaining) == len(entries):
            return False
        await self._write_entries(remaining)
        return True

    async def set_enabled(self, backend_id: str, enabled: bool) -> bool:
        entries = await self.list_entries()
        found = False
        for e in entries:
            if e.id == backend_id:
                e.enabled = enabled
                found = True
        if found:
            await self._write_entries(entries)
        return found

    # ── One-time migration from the scalar keys ───────────────────────────

    async def seed_from_scalar(self) -> bool:
        """Synthesize pool entries from the legacy scalar config, once.

        Runs at gateway startup. If ``inference.backends`` already exists
        (even as an empty list — an operator may deliberately empty the
        pool), nothing happens. Otherwise the scalar ``inference.backend`` /
        ``inference.url`` / ``inference.lmstudio_url`` / ``inference.custom_url``
        state is converted so a live instance keeps routing exactly as
        before the upgrade. Returns True when a seed was written.
        """
        try:
            raw = await self._read_raw()
        except Exception as e:
            log.warning("Pool seed skipped — Redis unreachable: %s", e)
            return False
        if raw:
            await self.refresh(force=True)
            return False

        from app.registry import _get_redis_config

        backend = await _get_redis_config("inference.backend", "ollama")
        url_override = await _get_redis_config("inference.url", "")

        entries: list[BackendEntry] = []

        def _add(id_: str, engine: str, url: str, kind: str = "remote", *,
                 enabled: bool = True, auth_header: str = "") -> None:
            entries.append(BackendEntry(
                id=id_, kind=kind, engine=engine,
                url=(url or DEFAULT_ENGINE_URLS.get(engine, "")).rstrip("/"),
                enabled=enabled, auth_header=auth_header,
            ))

        if backend == "none":
            pass  # deliberate no-local-inference setup → empty pool
        elif backend == "custom":
            custom_url = await _get_redis_config("inference.custom_url", "")
            custom_auth = await _get_redis_config("inference.custom_auth_header", "")
            if custom_url:
                _add("custom", "openai", custom_url, auth_header=custom_auth)
        elif backend == "lmstudio":
            lm_url = await _get_redis_config("inference.lmstudio_url", "")
            lm_key = await _get_redis_config("inference.lmstudio_api_key", "")
            _add("lmstudio", "lmstudio", lm_url,
                 auth_header=f"Bearer {lm_key}" if lm_key else "")
        else:
            # ollama / vllm / sglang / llamacpp. A bundled container writes an
            # in-network URL (http://ollama:11434) into inference.url — carry
            # kind=container so the Models page keeps its start/stop wiring.
            is_container = bool(url_override) and "host.docker.internal" not in url_override
            _add(
                f"bundled-{backend}" if is_container else backend,
                backend,
                url_override or (settings.ollama_base_url if backend == "ollama" else ""),
                kind="container" if is_container else "remote",
            )

        await self._write_entries(entries)
        log.info(
            "Seeded %s from scalar config (backend=%s): %s",
            POOL_KEY, backend, [e.id for e in entries] or "empty pool",
        )
        return True


# Module singleton — mirrors the codebase's provider-singleton pattern.
pool = BackendPool()
