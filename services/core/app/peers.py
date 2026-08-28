"""Outbound links to the gateway and the memory service.

Each link is a URL plus its own bearer token (rail 10). A link whose URL or
token is unset raises here, by name — core never calls a peer
unauthenticated and never silently skips the call.

Tests mount local ASGI fakes on `app.state.peer_transports`, keyed by base
URL, so the code path below is the one under test: same client, same
header, same parsing.
"""
from __future__ import annotations

import os

import httpx
from fastapi import FastAPI

GATEWAY = ("GATEWAY_URL", "CORE_GATEWAY_TOKEN")
MEMORY = ("MEMORY_URL", "CORE_MEMORY_TOKEN")

Link = tuple[str, str]


class PeerUnconfigured(RuntimeError):
    """A link is missing its URL or its token."""


def peer_config(link: Link) -> tuple[str, str]:
    url_var, token_var = link
    url = os.environ.get(url_var, "").rstrip("/")
    token = os.environ.get(token_var, "")
    if not url:
        raise PeerUnconfigured(f"{url_var} is unset")
    if not token:
        raise PeerUnconfigured(f"{token_var} is unset")
    return url, token


def client(app: FastAPI, link: Link, timeout: httpx.Timeout) -> httpx.AsyncClient:
    url, token = peer_config(link)
    transports = getattr(app.state, "peer_transports", {})
    return httpx.AsyncClient(
        base_url=url,
        headers={"Authorization": f"Bearer {token}"},
        timeout=timeout,
        transport=transports.get(url),
    )


def reason(exc: Exception) -> str:
    """A short, honest description of why a peer call failed."""
    text = str(exc).strip()
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__
