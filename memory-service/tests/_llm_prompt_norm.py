"""Prompt-hash normalization for fake_llm fixture.

Strips variable content (timestamps, UUIDs, session IDs) so that
the same logical prompt produces a stable hash across runs.

Test files extend via `extra_normalizers` parameter when their
prompts contain other variable content (model versions, file paths).
"""

from __future__ import annotations

import hashlib
import re
from typing import Callable, Iterable

# ISO 8601: 2026-05-05T17:30:21(.123456)?(Z|+00:00)?
_ISO8601 = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?"
)

# UUID v1-5 hex form
_UUID = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)

# Normalize session_id=value patterns, but only the value part after it's already had UUIDs replaced
_SESSION_ID_PLAIN = re.compile(r"session_id=([a-zA-Z0-9_-]+)")


def _builtin_normalize(prompt: str) -> str:
    s = _ISO8601.sub("<ISO8601>", prompt)
    s = _UUID.sub("<UUID>", s)
    s = _SESSION_ID_PLAIN.sub("session_id=<SID>", s)
    return s


def normalize_prompt(
    prompt: str,
    *,
    extra_normalizers: Iterable[Callable[[str], str]] = (),
) -> str:
    """Apply built-in + per-fixture normalizers in order."""
    out = _builtin_normalize(prompt)
    for fn in extra_normalizers:
        out = fn(out)
    return out


def hash_prompt(
    prompt: str,
    *,
    extra_normalizers: Iterable[Callable[[str], str]] = (),
) -> str:
    """SHA-256 of normalized prompt; first 16 hex chars (enough for fixture keying)."""
    norm = normalize_prompt(prompt, extra_normalizers=extra_normalizers)
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()[:16]
