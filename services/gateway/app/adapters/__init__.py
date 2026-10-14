"""Wire-protocol adapters. One per PROTOCOL, never per vendor.

`for_row(row)` hands back the adapter a provider row names. Every adapter
exposes the same five things (see base.py): the headers it authenticates
with, a live model listing, a verify-before-save check, and chat
completions in the OpenAI shape core speaks — streamed or not.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import httpx

from app.adapters import anthropic_messages, ollama, openai_chat, systemone
from app.adapters.base import (
    Adapter,
    Listing,
    ListingUnavailable,
    ProviderRefused,
    ProviderUnreachable,
    http_client,
    reason,
)

_BY_NAME: dict[str, Adapter] = {
    "ollama": ollama.ADAPTER,
    "openai-chat": openai_chat.ADAPTER,
    "anthropic-messages": anthropic_messages.ADAPTER,
    # A decision-model server (decision-role spec §1): typed questions only.
    "systemone": systemone.ADAPTER,
}


def for_row(row: dict) -> Adapter:
    try:
        return _BY_NAME[row["adapter"]]
    except KeyError as exc:
        raise ValueError(f"no adapter named {row.get('adapter')!r}") from exc


@dataclass(frozen=True)
class ProbeCall:
    """What one 1-token probe call answered. `status` is the HTTP status the
    provider answered, None when it never answered (a stated refusal before
    any answer, or no connection); `error` says why the call was not a
    completion, None when the adapter saw nothing wrong. `started` is the
    monotonic start, for the ledger row's duration."""

    status: int | None
    content: bytes
    error: str | None
    started: float
    latency_ms: int

    @property
    def ledger_status(self) -> int:
        """The status the ledger row carries: a call that never answered is
        recorded as a 502."""
        return self.status if self.status is not None else 502


async def probe_call(request, row: dict, model: str) -> ProbeCall:
    """ONE non-stream 1-token completion ("hi") on `model` through the SAME
    adapter a chat turn would use, so "the probe passed" means the chat path
    works. `request` is anything with `.app`: the adapters read nothing else
    off it. Never raises for a provider's refusal or a failed connection —
    those come back as `error`; recording the call is the caller's."""
    body = {
        "model": model,
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
        "stream": False,
    }
    started = time.monotonic()
    status: int | None = None
    content = b""
    error: str | None = None
    try:
        response = await for_row(row).completions(request, row, model, body)
        read = b""
        iterator = getattr(response, "body_iterator", None)
        if iterator is not None:
            async for chunk in iterator:
                read += chunk if isinstance(chunk, bytes) else str(chunk).encode()
        else:
            read = response.body
        content, status = read, response.status_code
        if status != 200:
            error = f"HTTP {status}: {content.decode(errors='replace')[:400]}"
        elif content.lstrip().startswith(b"data:") and b'"error"' in content:
            # A stream that carried an OpenAI-shaped error chunk answered,
            # but not with a completion.
            error = content.decode(errors="replace")[:400]
    except ProviderRefused as exc:
        error = exc.detail
    except httpx.HTTPError as exc:
        error = reason(exc)
    return ProbeCall(
        status=status,
        content=content,
        error=error,
        started=started,
        latency_ms=int((time.monotonic() - started) * 1000),
    )


__all__ = [
    "Adapter",
    "Listing",
    "ListingUnavailable",
    "ProbeCall",
    "ProviderRefused",
    "ProviderUnreachable",
    "for_row",
    "http_client",
    "probe_call",
    "reason",
]
