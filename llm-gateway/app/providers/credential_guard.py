"""Credential-rejection guard — classify auth failures and sideline the
offending provider for a cooldown window.

Why: one provider with a dead API key must not take down requests that other
healthy providers could serve (2026-07-05: an invalid Groq key surfaced as raw
500s from /complete and cascaded into pipeline-task failures even though a
healthy local backend was available under local-first routing).

Stdlib-only leaf module: imported by providers, registry, and routers alike
without creating import cycles.
"""
from __future__ import annotations

import logging
import time

log = logging.getLogger(__name__)

# provider.name → monotonic deadline until which the provider is sidelined.
_invalid_until: dict[str, float] = {}

# Long enough to stop a dead key from being re-tried on every request. A key
# rotated via Settings never waits on this: the FU-009 hot-reload path calls
# clear() for the affected provider the moment the new key applies.
CREDENTIAL_COOLDOWN_SECONDS = 600.0

_AUTH_ERROR_CLASSES = ("AuthenticationError", "PermissionDeniedError")
_AUTH_ERROR_MARKERS = (
    "invalid api key",
    "invalid_api_key",
    "incorrect api key",
    "authentication_error",
    "invalid x-api-key",
    "unauthorized",
    "error code: 401",
    "error code: 403",
    "status 401",
    "status 403",
)


def is_credential_error(exc: BaseException) -> bool:
    """True when the exception smells like a rejected/expired credential.

    litellm maps some provider 401s to BadRequestError (Groq does this), so
    class name alone is not enough — fall back to message markers.
    """
    for klass in type(exc).__mro__:
        if klass.__name__ in _AUTH_ERROR_CLASSES:
            return True
    text = str(exc).lower()
    return any(marker in text for marker in _AUTH_ERROR_MARKERS)


def mark_credential_invalid(provider_name: str) -> None:
    """Sideline a provider after its credentials were rejected."""
    _invalid_until[provider_name] = time.monotonic() + CREDENTIAL_COOLDOWN_SECONDS
    log.warning(
        "Provider %s: credentials rejected — sidelined for %ds "
        "(rotate the key in Settings → AI & Models → Provider Status)",
        provider_name,
        int(CREDENTIAL_COOLDOWN_SECONDS),
    )


def credential_invalid(provider_name: str) -> bool:
    """True while the provider is inside its rejection cooldown."""
    deadline = _invalid_until.get(provider_name)
    if deadline is None:
        return False
    if time.monotonic() >= deadline:
        _invalid_until.pop(provider_name, None)
        return False
    return True


def clear(provider_name: str | None = None) -> None:
    """Drop cooldown state (all providers when name is None). Called by the
    FU-009 secret hot-reload for each changed key; also a test helper."""
    if provider_name is None:
        _invalid_until.clear()
    else:
        _invalid_until.pop(provider_name, None)
