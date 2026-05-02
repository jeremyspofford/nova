"""Insert-time redaction. Masks secret-shaped values before audit storage."""
from __future__ import annotations

import re
from typing import Any

# Token patterns (high-confidence)
_TOKEN_PATTERNS = [
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"gho_[A-Za-z0-9]{20,}"),
    re.compile(r"ghu_[A-Za-z0-9]{20,}"),
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"AKIA[A-Z0-9]{16}"),
    re.compile(r"xoxb-[A-Za-z0-9\-]+"),
    re.compile(r"Bearer\s+[A-Za-z0-9._\-+/]+"),
]

# Field-name patterns: keys that should always be masked regardless of value
_SENSITIVE_KEY = re.compile(
    r"(token|secret|password|api[_\-]?key|credential|auth|bearer)",
    re.IGNORECASE,
)


def _short_mask(value: str) -> str:
    """Return a short mask: first 8 chars + ellipsis + last 4 chars. If too short, return ***."""
    if len(value) <= 12:
        return "***"
    return f"{value[:8]}…{value[-4:]}"


def redact_value(value: str) -> str:
    """Mask matched token patterns within a string."""
    if not isinstance(value, str):
        return value
    out = value
    for pat in _TOKEN_PATTERNS:
        def repl(m):
            return _short_mask(m.group(0))
        out = pat.sub(repl, out)
    return out


def redact_dict(obj: Any) -> Any:
    """Walk a JSON-like structure; mask sensitive keys and apply pattern redaction to strings."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if _SENSITIVE_KEY.search(k):
                out[k] = "***"
            else:
                out[k] = redact_dict(v)
        return out
    if isinstance(obj, list):
        return [redact_dict(x) for x in obj]
    if isinstance(obj, str):
        return redact_value(obj)
    return obj
