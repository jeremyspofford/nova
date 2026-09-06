"""Wire-protocol adapters. One per PROTOCOL, never per vendor.

`for_row(row)` hands back the adapter a provider row names. Every adapter
exposes the same five things (see base.py): the headers it authenticates
with, a live model listing, a verify-before-save check, and chat
completions in the OpenAI shape core speaks — streamed or not.
"""
from __future__ import annotations

from app.adapters import anthropic_messages, ollama, openai_chat
from app.adapters.base import (
    Adapter,
    Listing,
    ListingUnavailable,
    ProviderRefused,
    http_client,
    reason,
)

_BY_NAME: dict[str, Adapter] = {
    "ollama": ollama.ADAPTER,
    "openai-chat": openai_chat.ADAPTER,
    "anthropic-messages": anthropic_messages.ADAPTER,
}


def for_row(row: dict) -> Adapter:
    try:
        return _BY_NAME[row["adapter"]]
    except KeyError as exc:
        raise ValueError(f"no adapter named {row.get('adapter')!r}") from exc


__all__ = [
    "Adapter",
    "Listing",
    "ListingUnavailable",
    "ProviderRefused",
    "for_row",
    "http_client",
    "reason",
]
