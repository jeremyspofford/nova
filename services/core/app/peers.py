"""Outbound links to the gateway and the memory service.

Each link is a URL plus its own bearer token (rail 10). A link whose URL or
token is unset raises here, by name — core never calls a peer
unauthenticated and never silently skips the call.

Tests mount local ASGI fakes on `app.state.peer_transports`, keyed by base
URL, so the code path below is the one under test: same client, same
header, same parsing.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from urllib.parse import quote, unquote

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
        # proxies.py's model-pull relay is aiter_raw() too — raw wire bytes
        # handed straight to the browser — so it is only safe to read as
        # text as long as nothing on this hop was ever invited to compress
        # it. Dormant today (nothing between core and the gateway
        # compresses), latent the moment either side adds compression.
        # Mirrors gateway's own Accept-Encoding: identity default (ruling
        # R26).
        headers={"Authorization": f"Bearer {token}", "Accept-Encoding": "identity"},
        timeout=timeout,
        transport=transports.get(url),
    )


#: How much of a gateway refusal a failed call keeps. The 503 for a chain
#: with nothing runnable names every link's verdict, and the old 400-character
#: cut ended in the LAST link — on 2026-09-30 exactly the reason he then asked
#: about ("openrouter refus…": a 402, out of credits).
REFUSAL_WORDS_MAX = 2000


def refusal_words(body: str) -> str:
    """The gateway's own words for a refusal: the JSON body's `error` — a
    string, or an OpenAI-shaped `{"message": ...}` — when it carries one,
    else the body as it came; capped, never cut short of the links it names."""
    try:
        parsed = json.loads(body)
    except ValueError:
        parsed = None
    if isinstance(parsed, dict):
        said = parsed.get("error")
        if isinstance(said, dict):
            said = said.get("message")
        if isinstance(said, str) and said.strip():
            body = said
    return body[:REFUSAL_WORDS_MAX]


def reason(exc: Exception) -> str:
    """A short, honest description of why a peer call failed."""
    text = str(exc).strip()
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


# ── S10: attribution on every gateway completion ───────────────────────────
#
# The gateway meters every call; core says who asked and why. One helper so
# the turn loop, the judge/redirect rounds, a scheduled turn and an eval all
# stamp the same fields — a call with no headers is recorded by the gateway
# as `unattributed`, which the Spend page names.
HEADER_TURN = "X-Nova-Turn-Id"
HEADER_PERSON = "X-Nova-Person"
HEADER_PURPOSE = "X-Nova-Purpose"
HEADER_ROLE = "X-Nova-Role"
HEADER_TIMEZONE = "X-Nova-Timezone"
HEADER_PASS_OVER = "X-Nova-Pass-Over"


def pass_over_header(pass_over: Mapping[str, str]) -> str:
    """X-Nova-Pass-Over's value for {served id: words}.

    The gateway's parse_pass_over reads it back: pairs split on ',', each
    `link=words` split on its first '=', both sides strictly percent-decoded.
    Quoting with safe="" escapes ',', '=', '%' and every non-ASCII byte, so
    any link or words round-trip and the header stays ASCII.
    """
    return ",".join(
        f"{quote(link, safe='')}={quote(words, safe='')}" for link, words in pass_over.items()
    )


def attribution_headers(turn, purpose: str, role: str | None = None) -> dict[str, str]:
    headers = {
        HEADER_TURN: str(turn.id),
        HEADER_PURPOSE: purpose,
        HEADER_TIMEZONE: getattr(turn, "timezone", None) or "UTC",
    }
    person_id = getattr(turn, "person_id", None)
    if person_id is not None:
        headers[HEADER_PERSON] = str(person_id)
    if role:
        headers[HEADER_ROLE] = role
    return headers


# ── X-Nova-Route: which link of a role's chain answered ─────────────────────
#
# The gateway stamps `role=…;link=N;reason=…` on every routed answer (S10-2);
# `reason` is free text that can carry `;` and `=`, so the gateway
# percent-quotes it. One reader, so chat's rounds and the decision role's
# calls (decisions.py) can never decode the header two ways.


def route_fields(header: str | None) -> dict[str, str]:
    """The header's fields by name, `reason` already decoded; {} for none."""
    if not header:
        return {}
    fields = dict(part.split("=", 1) for part in header.split(";") if "=" in part)
    if "reason" in fields:
        fields["reason"] = unquote(fields["reason"])
    return fields
