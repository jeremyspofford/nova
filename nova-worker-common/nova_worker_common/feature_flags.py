"""Feature-flag SDK for Nova services.

Flags are declared in code via register_flag(). The SDK supports
optional resolver injection for cache misses; without a resolver, only
in-code defaults apply (useful for unit tests).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Literal, Sequence

logger = logging.getLogger(__name__)

FlagType = Literal["bool", "enum"]

_NO_OVERRIDE = object()  # sentinel: no override exists


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
        """Evaluate the flag, falling back to in-code default."""
        return self.default


_registry: dict[str, FlagDef] = {}


def _registry_clear():
    """Test helper. NOT for production use."""
    _registry.clear()


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
