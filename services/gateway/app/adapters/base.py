"""What every adapter provides, and the one outbound HTTP client they share."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol

import httpx
from fastapi import Request
from starlette.responses import Response

# No read timeout on completions: a model thinking is not a failure.
# Connect/write stay bounded so a truly dead backend is reported quickly.
COMPLETIONS_TIMEOUT = httpx.Timeout(connect=5.0, read=300.0, write=10.0, pool=5.0)
MODELS_TIMEOUT = httpx.Timeout(10.0)
VERIFY_TIMEOUT = httpx.Timeout(10.0)


class ProviderRefused(RuntimeError):
    """The provider answered, and the answer was a refusal — its status and
    its own words. Never rephrased into a guess about why."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class ListingUnavailable(RuntimeError):
    """The provider has no model listing at this base URL (a 404/405 on
    /models) — a FACT about the provider, not a failure: the owner types
    model ids for it."""


@dataclass
class Listing:
    """A live model list, always labelled with where and when it came from —
    never an unlabelled number (S10a's rail, adopted here)."""

    source: str
    models: list[dict]
    fetched_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def as_dict(self) -> dict:
        return {"source": self.source, "fetched_at": self.fetched_at, "models": self.models}


@dataclass
class VerifyResult:
    """What a verify-before-save proved.

    `listing` is what was learned about GET /models (available /
    unavailable). `key_proven` is the verdict on the KEY, structured so no
    caller has to read prose: True when the provider accepted it (the
    listing required it, or a 1-token completion came back as a
    completion), False when a completion was attempted and refused for a
    reason other than auth, None when nothing could test it (no auth, no
    listing, an empty listing). `note` says how, in words, for the owner.
    """

    listing: str
    note: str | None = None
    key_proven: bool | None = None
    # The listing's rows when verify fetched one (S10 records their prices
    # at save time without a second call).
    models: list[dict] | None = None


class Adapter(Protocol):
    name: str

    def headers(self, row: dict) -> dict[str, str]: ...

    async def verify(self, app, row: dict) -> VerifyResult: ...

    async def list_models(self, app, row: dict) -> Listing: ...

    async def completions(
        self, request: Request, row: dict, model: str, body: dict
    ) -> Response: ...


def positive_int(value: object) -> int | None:
    """`value` when it is a real positive int, else None. bool is an int
    subclass, so a provider's `true` must not read as a count of 1."""
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    return None


def reason(exc: Exception) -> str:
    """A short, honest description of why an outbound call failed."""
    text = str(exc).strip()
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


def _merge_headers_case_insensitively(
    default: dict[str, str], override: dict[str, str] | None
) -> dict[str, str]:
    """`override` replaces `default` by header NAME, ignoring case — a plain
    dict spread is case-sensitive, so a caller header spelled with different
    casing than a default would ride alongside it as a second header."""
    merged = dict(default)
    for key, value in (override or {}).items():
        for existing in [k for k in merged if k.lower() == key.lower()]:
            del merged[existing]
        merged[key] = value
    return merged


def _mounted_transport(app, base_url: str):
    """The test fake mounted for `base_url`, if any.

    Tests mount fakes by ORIGIN (or any prefix): a provider whose base URL
    is `http://cloud.test/v1` reaches the fake mounted at
    `http://cloud.test`. Nothing mounted means a real network transport.
    """
    transports = getattr(app.state, "peer_transports", {})
    if base_url in transports:
        return transports[base_url]
    for key, transport in transports.items():
        if base_url.startswith(key.rstrip("/") + "/"):
            return transport
    return None


def http_client(
    app, timeout: httpx.Timeout, *, base_url: str, headers: dict[str, str] | None = None
) -> httpx.AsyncClient:
    """An httpx client for `base_url`.

    Every call declares Accept-Encoding: identity, overriding httpx's own
    default. The passthrough adapters relay every byte a provider sends back
    as-is (aiter_raw()) and drop the Content-Encoding header on the branches
    where they cannot promise it travels with the bytes intact — both are
    only true at once if the provider is never asked to compress in the
    first place. Without this, a compressing provider's reply relays as
    still-compressed bytes with no header saying so: core reads it
    line-by-line expecting SSE text, finds none, and a real turn silently
    persists an empty reply.
    """
    merged_headers = _merge_headers_case_insensitively({"Accept-Encoding": "identity"}, headers)
    return httpx.AsyncClient(
        base_url=base_url,
        timeout=timeout,
        transport=_mounted_transport(app, base_url),
        headers=merged_headers,
    )


def bearer_or_header(row: dict, *, header_name: str) -> dict[str, str]:
    """The auth header a row's `auth_shape` asks for. `header_name` is what
    `api-key-header` means for THIS protocol (`api-key` for Azure-shaped
    OpenAI endpoints, `x-api-key` for Anthropic)."""
    key = row.get("api_key")
    shape = row.get("auth_shape")
    if not key or shape == "none":
        return {}
    if shape == "static-bearer":
        return {"Authorization": f"Bearer {key}"}
    if shape == "api-key-header":
        return {header_name: key}
    return {}


def refusal_detail(resp: httpx.Response) -> str:
    """The provider's own words for a non-2xx, bounded — never a made-up
    reason and never a full page of HTML."""
    text = resp.text.strip()
    try:
        body = resp.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])[:400]
        if isinstance(err, str):
            return err[:400]
        if body.get("message"):
            return str(body["message"])[:400]
    return text[:400] or resp.reason_phrase or f"HTTP {resp.status_code}"
