"""Rate-limit retry hints — extract a provider's suggested retry delay.

Free-tier providers (Gemini especially) return 429s carrying an explicit
"retry in Ns" hint. Ignoring it turns one burst from a parallel agent group
into a cascade of hard failures; honoring it costs a few seconds and the
request succeeds. Formats seen in the wild:

  google.api_core: ``retry_delay {\n  seconds: 6\n}``
  Gemini REST via litellm: ``"retryDelay": "6s"``
  OpenAI-style: ``Please try again in 6.2s`` / ``Retry-After: 7``
  litellm exceptions sometimes expose a ``retry_after`` attribute.
"""
from __future__ import annotations

import re

# Never sleep longer than this on a hint — a daily-quota hint ("retry in
# 40000s") means the provider is done for the day; fail over instead.
MAX_RETRY_HINT_SECONDS = 15.0

_RATE_MARKERS = (
    "429", "rate limit", "rate_limit", "ratelimit", "quota",
    "resource_exhausted", "resource exhausted", "too many requests",
)

_DELAY_PATTERNS = (
    # retry_delay { seconds: 6 }  /  "retryDelay": "6s"
    re.compile(
        r"retry[_-]?delay['\"]?\s*[:{]\s*['\"]?(?:seconds['\"]?\s*[:=]\s*)?(\d+(?:\.\d+)?)",
        re.IGNORECASE,
    ),
    # Retry-After: 7  /  retry after 7s
    re.compile(r"retry[- ]?after['\"]?\s*[:=]?\s*(\d+(?:\.\d+)?)", re.IGNORECASE),
    # Please try again in 6.2s  /  retry in 6s
    re.compile(r"(?:try again|retry) in\s*(\d+(?:\.\d+)?)\s*s", re.IGNORECASE),
)


def rate_limit_retry_delay(exc: BaseException) -> float | None:
    """Return the provider-suggested retry delay in seconds, or None.

    None means "not a rate-limit error" or "no usable hint" — the caller
    should fail over immediately. A returned value may exceed
    MAX_RETRY_HINT_SECONDS; the caller decides whether waiting is worth it.
    """
    retry_after = getattr(exc, "retry_after", None)
    if isinstance(retry_after, (int, float)) and retry_after > 0:
        return float(retry_after)

    text = str(exc)
    lowered = text.lower()
    if not any(marker in lowered for marker in _RATE_MARKERS):
        return None

    for pattern in _DELAY_PATTERNS:
        m = pattern.search(text)
        if m:
            try:
                delay = float(m.group(1))
            except ValueError:
                continue
            if delay > 0:
                return delay
    return None
