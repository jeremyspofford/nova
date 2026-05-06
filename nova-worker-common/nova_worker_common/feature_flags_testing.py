"""Test-only helpers for the feature-flag SDK.

Production code MUST NOT import from this module. It exists in a separate
namespace specifically so static analysis (and code review) can flag any
production import as a bug.
"""
from __future__ import annotations

from nova_worker_common.feature_flags import _registry


def registry_clear() -> None:
    """Empty the in-process flag registry. Test fixtures only."""
    _registry.clear()
