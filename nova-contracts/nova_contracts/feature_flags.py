"""Feature-flag SDK for Nova services.

Flags are declared in code via register_flag(). The SDK supports
optional resolver injection for cache misses; without a resolver, only
in-code defaults apply (useful for unit tests).
"""
from __future__ import annotations

import contextlib
import contextvars
import logging
from dataclasses import dataclass
from typing import Any, Iterator, Literal, Sequence

logger = logging.getLogger(__name__)

FlagType = Literal["bool", "enum"]

_NO_OVERRIDE = object()  # sentinel: no override exists

_overrides: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "feature_flag_overrides", default=None
)


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
        """Evaluate the flag, falling back to in-code default.

        Resolution order (v1):
          1. flag_override(...) context manager (process-local, contextvars-scoped)
          2. in-code default

        Cache + env-var + DB resolution land in subsequent SDK tasks.
        """
        overrides = _overrides.get()
        if overrides is not None and self.key in overrides:
            return overrides[self.key]
        return self.default


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
