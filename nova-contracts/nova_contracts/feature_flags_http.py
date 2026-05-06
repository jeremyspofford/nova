"""HTTP-based bulk pre-warm for the feature-flag SDK.

This module is the only part of the SDK that talks to orchestrator over the
network. It runs ONCE at FastAPI lifespan startup per service: fetches all
declared flags + their current values from `GET /api/v1/feature-flags/`,
populates the in-process cache via `populate_cache()`, and persists the
result to the per-service cache file (when configured via init_cache_file).

After warm completes, FlagDef.value() reads from the cache synchronously
with no further network calls. Pubsub-driven invalidation (B-Task 4) is
the other path that mutates the cache.

Failures during warm are logged at WARNING and never raise — services
must start even when the orchestrator is unreachable. They fall back
to the cache-file (B3d), then in-code defaults.
"""
from __future__ import annotations

import logging
import os

import httpx

from nova_contracts.feature_flags import populate_cache

logger = logging.getLogger(__name__)

WARM_PATH = "/api/v1/feature-flags/"
DEFAULT_TIMEOUT = 5.0


async def warm_cache_from_http(
    client: httpx.AsyncClient,
    base_url: str,
    *,
    timeout: float = DEFAULT_TIMEOUT,
) -> None:
    """Fetch all flag values from the orchestrator and populate the SDK cache.

    Call once at service startup. Errors are non-fatal: connection failures,
    non-2xx responses, and malformed JSON all log a structured WARNING
    ("flag_cache_warm_failed") and return cleanly. The service then runs
    on the cache file (if any) or in-code defaults.

    Includes the X-Admin-Secret header from `NOVA_ADMIN_SECRET` when set
    so the call succeeds against a REQUIRE_AUTH=true orchestrator.
    """
    url = base_url.rstrip("/") + WARM_PATH
    headers: dict[str, str] = {}
    admin_secret = os.environ.get("NOVA_ADMIN_SECRET")
    if admin_secret:
        headers["X-Admin-Secret"] = admin_secret

    try:
        response = await client.get(url, headers=headers, timeout=timeout)
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout,
            httpx.NetworkError) as exc:
        logger.warning(
            "flag_cache_warm_failed url=%s reason=connect_error detail=%s",
            url, exc,
        )
        return

    if response.status_code >= 500:
        logger.warning(
            "flag_cache_warm_failed url=%s reason=server_error status=%d body=%s",
            url, response.status_code, response.text[:200],
        )
        return
    if response.status_code >= 400:
        logger.warning(
            "flag_cache_warm_failed url=%s reason=client_error status=%d body=%s",
            url, response.status_code, response.text[:200],
        )
        return

    try:
        rows = response.json()
    except (ValueError, httpx.DecodingError) as exc:
        logger.warning(
            "flag_cache_warm_failed url=%s reason=invalid_json detail=%s",
            url, exc,
        )
        return

    if not isinstance(rows, list):
        logger.warning(
            "flag_cache_warm_failed url=%s reason=unexpected_shape "
            "expected=list got=%s",
            url, type(rows).__name__,
        )
        return

    values: dict[str, object] = {}
    for row in rows:
        if not isinstance(row, dict) or "key" not in row or "current_value" not in row:
            logger.warning(
                "flag_cache_warm_skipped_row url=%s row=%r reason=missing_fields",
                url, row,
            )
            continue
        values[row["key"]] = row["current_value"]

    populate_cache(values)
    logger.info(
        "flag_cache_warm_complete url=%s flags_loaded=%d",
        url, len(values),
    )
