"""Feature-flag SDK for Nova services.

Flags are declared in code via register_flag(). The SDK supports
optional resolver injection for cache misses; without a resolver, only
in-code defaults apply (useful for unit tests).
"""
from __future__ import annotations

import contextlib
import contextvars
import logging
import os
from dataclasses import dataclass
from typing import Any, Iterator, Literal, Protocol, Sequence, runtime_checkable

logger = logging.getLogger(__name__)

FlagType = Literal["bool", "enum"]

_NO_OVERRIDE = object()  # sentinel: no override exists

_overrides: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "feature_flag_overrides", default=None
)

_cache: dict[str, Any] = {}

_BOOL_TRUE = frozenset({"true", "1", "yes", "y", "on"})
_BOOL_FALSE = frozenset({"false", "0", "no", "n", "off"})


def _envvar_name(flag_key: str) -> str:
    """Translate a flag key to its NOVA_FLAG_* environment variable name.

    'kill.intel_worker.poll' -> 'NOVA_FLAG_KILL_INTEL_WORKER_POLL'
    """
    return "NOVA_FLAG_" + flag_key.replace(".", "_").upper()


def _coerce_envvar(raw: str, flag_type: FlagType, variants: Sequence[Any] | None) -> Any:
    """Coerce a raw env-var string to the flag's typed value.

    Raises ValueError on any malformed input — caller decides whether to
    fall through to the next resolution layer.
    """
    if flag_type == "bool":
        lowered = raw.strip().lower()
        if lowered in _BOOL_TRUE:
            return True
        if lowered in _BOOL_FALSE:
            return False
        raise ValueError(f"not a recognized bool literal: {raw!r}")
    if flag_type == "enum":
        if variants is None or raw not in variants:
            raise ValueError(
                f"value {raw!r} not in declared variants {list(variants or [])}"
            )
        return raw
    raise ValueError(f"unknown flag type {flag_type!r}")


@dataclass(frozen=True)
class FlagDef:
    """A registered feature flag. Created via register_flag()."""

    key: str
    type: FlagType
    variants: Sequence[Any] | None
    default: Any
    description: str

    def value(self, *, tenant_id: str | None = None,
                       user_id: str | None = None) -> Any:
        """Evaluate the flag.

        Resolution order (Phase A + B3a + B3b):
          1. flag_override(...) context manager (process-local, contextvars)
          2. NOVA_FLAG_<KEY> environment variable (boot-time only;
             changing it requires container restart — NOT a hot kill-switch)
          3. registered FlagResolver (DefaultResolver reads from in-process
             cache; HttpFlagResolver lands in B3c; future Flagsmith adapter
             swaps in here)
          4. in-code default

        Layer 3.5 (last-seen cache file) lands in B3d.
        """
        overrides = _overrides.get()
        if overrides is not None and self.key in overrides:
            return overrides[self.key]

        env_raw = os.environ.get(_envvar_name(self.key))
        if env_raw is not None:
            try:
                coerced = _coerce_envvar(env_raw, self.type, self.variants)
            except ValueError as exc:
                logger.warning(
                    "flag_envvar_invalid key=%s envvar=%s value=%r reason=%s "
                    "fallthrough_to=cache_or_default",
                    self.key, _envvar_name(self.key), env_raw, exc,
                )
            else:
                # Per security blocker S2: env-var override bypasses the
                # audit table; emit a WARN every read so log aggregation
                # can alert on it.
                logger.warning(
                    "flag_envvar_override_used key=%s envvar=%s value=%r",
                    self.key, _envvar_name(self.key), coerced,
                )
                return coerced

        if self.type == "bool":
            return _resolver.resolve_bool(
                self.key, self.default,
                tenant_id=tenant_id, user_id=user_id,
            )
        return _resolver.resolve_string(
            self.key, self.default,
            tenant_id=tenant_id, user_id=user_id,
        )


def populate_cache(values: dict[str, Any]) -> None:
    """Set or update cache entries. Used by the bulk-warm-at-startup
    path (B3c) and by pubsub-driven invalidate-and-refresh (B-Task 4).

    Per SR1: emit a structured INFO log on every actual value change so
    operators can correlate flag flips with downstream behavior. No log
    fires when a key is set to the same value it already had.
    """
    for key, new_value in values.items():
        old_value = _cache.get(key, _NO_OVERRIDE)
        if old_value is _NO_OVERRIDE or old_value != new_value:
            _cache[key] = new_value
            logger.info(
                "flag_value_changed key=%s old=%r new=%r source=cache_populate",
                key, None if old_value is _NO_OVERRIDE else old_value, new_value,
            )


def cache_clear() -> None:
    """Empty the in-process cache. Used by tests and by the pubsub
    'flush all' path."""
    _cache.clear()


# ---------------------------------------------------------------------------
# B3b: OpenFeature-shaped FlagResolver Protocol
#
# The resolver is the swap-out boundary. Today's DefaultResolver reads from
# the in-process cache (populated by populate_cache from B3a); B3c will add
# an HttpFlagResolver that warms the cache from the orchestrator; a future
# Flagsmith adapter would implement the same Protocol and require no
# flag-consumer rewrites.
# ---------------------------------------------------------------------------


@runtime_checkable
class FlagResolver(Protocol):
    """Per-key value lookup. Implementations choose where the answer comes
    from (cache, file, network) but must return synchronously so
    FlagDef.value() stays sync (B1 acceptance criterion)."""

    def resolve_bool(
        self,
        key: str,
        default: bool,
        *,
        tenant_id: str | None = None,
        user_id: str | None = None,
    ) -> bool: ...

    def resolve_string(
        self,
        key: str,
        default: str,
        *,
        tenant_id: str | None = None,
        user_id: str | None = None,
    ) -> str: ...


class DefaultResolver:
    """Reads from the in-process cache (the hot path). Falls back to the
    caller-provided default on cache miss. Network and file-cache layers
    plug in via cache pre-population, not via Resolver method calls — so
    `.value()` stays synchronous and never blocks the event loop."""

    def resolve_bool(
        self,
        key: str,
        default: bool,
        *,
        tenant_id: str | None = None,
        user_id: str | None = None,
    ) -> bool:
        cached = _cache.get(key, _NO_OVERRIDE)
        if cached is _NO_OVERRIDE:
            return default
        return bool(cached)

    def resolve_string(
        self,
        key: str,
        default: str,
        *,
        tenant_id: str | None = None,
        user_id: str | None = None,
    ) -> str:
        cached = _cache.get(key, _NO_OVERRIDE)
        if cached is _NO_OVERRIDE:
            return default
        return str(cached)


_resolver: FlagResolver = DefaultResolver()


def set_resolver(resolver: FlagResolver) -> None:
    """Replace the process-wide flag resolver. Production services swap
    in HttpFlagResolver during their FastAPI lifespan startup; tests can
    swap in a fake to assert resolver-call patterns; a future Flagsmith
    migration replaces it with a Flagsmith-backed adapter."""
    global _resolver
    _resolver = resolver


def get_resolver() -> FlagResolver:
    """Return the currently registered resolver."""
    return _resolver


@contextlib.contextmanager
def flag_override(key: str, value: Any) -> Iterator[None]:
    """Override a flag's value within the context.

    Process-local and async-safe via contextvars: concurrent asyncio tasks
    each see their own override stack. Restored on exit, including on
    exception.

    Intended for tests only — the highest-priority resolution layer in
    FlagDef.value(). Production code should never call this.
    """
    current = _overrides.get() or {}
    new_overrides = {**current, key: value}
    token = _overrides.set(new_overrides)
    try:
        yield
    finally:
        _overrides.reset(token)


_registry: dict[str, FlagDef] = {}


def register_flag(
    *,
    key: str,
    type: FlagType,
    variants: Sequence[Any] | None = None,
    default: Any,
    description: str,
) -> FlagDef:
    """Register a flag. Idempotent on re-import (returns existing FlagDef).

    Raises ValueError on:
    - schema mismatch with an existing registration
    - bool flag with non-bool default
    - enum flag with default not in variants (or empty variants)
    """
    if type == "bool" and not isinstance(default, bool):
        raise ValueError(f"bool flag {key!r} must have bool default")
    if type == "enum":
        if not variants:
            raise ValueError(f"enum flag {key!r} requires non-empty variants")
        if default not in variants:
            raise ValueError(
                f"enum flag {key!r} default {default!r} not in variants {variants!r}"
            )

    flag = FlagDef(
        key=key,
        type=type,
        variants=tuple(variants) if variants else None,
        default=default,
        description=description,
    )

    existing = _registry.get(key)
    if existing is not None:
        if existing != flag:
            raise ValueError(f"flag {key!r} schema mismatch on re-registration")
        return existing

    _registry[key] = flag
    return flag


def declared_flags() -> list[FlagDef]:
    """Snapshot of every flag currently registered in this process."""
    return list(_registry.values())
