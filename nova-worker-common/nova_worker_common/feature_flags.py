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
