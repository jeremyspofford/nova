"""fetch_url — read a public web page, and nothing else.

The whole point of this tool is that it takes a URL from the model, so
the URL is untrusted input and the address behind it is the thing that
matters. Every hop (the first request and every redirect) is resolved and
each resolved address checked before a connection is opened: loopback,
RFC1918, link-local, CGNAT, unique-local v6, multicast and reserved space
are all refused by name. GET only, http/https only, three redirects, ten
seconds, half a megabyte.

Known limit, stated rather than papered over: the check resolves the host
and then lets httpx resolve it again to connect, so a DNS entry that
changes between the two answers (a rebinding attack) is not caught here.
Pinning the connection to the address we validated needs a custom
transport; that is a deliberate later step, and this note exists so
nobody reads the guard as more than it is.
"""
from __future__ import annotations

import asyncio
import html
import ipaddress
import re
import socket
from urllib.parse import urljoin, urlsplit

import httpx

from app.tools.base import Tool, ToolContext, ToolFailure

MAX_REDIRECTS = 3
TOTAL_TIMEOUT_SECONDS = 10.0
MAX_BYTES = 500 * 1024
ALLOWED_SCHEMES = ("http", "https")
USER_AGENT = "Nova/0.0.1 (self-hosted assistant)"

_SCRIPT_OR_STYLE = re.compile(r"<(script|style)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_TAG = re.compile(r"<[^>]+>")
_INLINE_SPACE = re.compile(r"[ \t\r\f\v]+")
_BLANK_LINES = re.compile(r"\n\s*\n\s*")


def refusal_for_address(raw: str) -> str | None:
    """None when this address is fair game, else why it is refused.

    Every predicate is named explicitly rather than leaning on `is_global`
    alone: which ranges that property covers has moved between python
    versions, and a containment check that changes meaning when the base
    image is bumped is not a check.
    """
    try:
        ip = ipaddress.ip_address(raw)
    except ValueError:
        return f"{raw!r} is not an IP address"

    # ::ffff:127.0.0.1 is loopback wearing a v6 hat — judge the v4 address.
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped

    if ip.is_unspecified:
        return "the unspecified address"
    if ip.is_loopback:
        return "a loopback address"
    if ip.is_link_local:
        return "a link-local address"
    if ip.is_multicast:
        return "a multicast address"
    if ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10"):
        return "a carrier-grade NAT address"
    if ip.is_private:
        return "a private address"
    if ip.is_reserved:
        return "a reserved address"
    if not ip.is_global:
        return "not a globally routable address"
    return None


async def resolve_addresses(host: str) -> list[str]:
    """Every address this host answers with — all of them are checked, not
    just the first, because a host with one public and one private answer
    is exactly the shape an attack takes."""
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ToolFailure(f"could not resolve {host!r} — {exc}") from exc
    # An IPv6 sockaddr may carry a %scope suffix; the address is the part
    # before it.
    return sorted({str(info[4][0]).split("%")[0] for info in infos})


async def _guard(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme.lower() not in ALLOWED_SCHEMES:
        raise ToolFailure(
            f"refusing {url!r}: only http and https URLs can be fetched, not "
            f"{parts.scheme or 'a scheme-less URL'!r}"
        )
    host = parts.hostname
    if not host:
        raise ToolFailure(f"refusing {url!r}: it names no host")

    addresses = await resolve_addresses(host)
    if not addresses:
        raise ToolFailure(f"could not resolve {host!r} to any address")
    for address in addresses:
        reason = refusal_for_address(address)
        if reason is not None:
            raise ToolFailure(
                f"refusing to fetch {url!r}: {host} resolves to {address}, which is {reason} — "
                "this tool only reads the public internet"
            )
    return f"{parts.scheme}://{parts.netloc}"


def _transport_for(app, origin: str):
    """Tests mount local ASGI stand-ins by origin on app.state.peer_transports
    — the same by-URL map core's peer client reads — so the guard, the
    redirect walk, the caps and the extraction are all exercised with no
    socket and no real network. A deployment has no entry for an outside
    origin, so this is None in production."""
    transports = getattr(getattr(app, "state", None), "peer_transports", None) or {}
    return transports.get(origin)


def strip_tags(text: str) -> str:
    """A crude HTML-to-text pass: no parser, no dependency.

    Script and style bodies go first (their contents are not prose),
    then comments, then the tags themselves; entities are unescaped last
    so an escaped `&lt;b&gt;` in the page text is not mistaken for markup
    and eaten.
    """
    text = _SCRIPT_OR_STYLE.sub(" ", text)
    text = _COMMENT.sub(" ", text)
    text = _TAG.sub(" ", text)
    text = html.unescape(text)
    text = _INLINE_SPACE.sub(" ", text)
    text = _BLANK_LINES.sub("\n\n", text)
    return text.strip()


def _charset(content_type: str) -> str:
    for part in content_type.split(";")[1:]:
        key, _, value = part.strip().partition("=")
        if key.strip().lower() == "charset" and value.strip():
            return value.strip().strip('"')
    return "utf-8"


def _readable_kind(media_type: str) -> bool:
    return (
        media_type.startswith("text/")
        or media_type == "application/json"
        or media_type.endswith("+json")
    )


async def _fetch(url: str, ctx: ToolContext) -> str:
    current = url
    for _hop in range(MAX_REDIRECTS + 1):
        origin = await _guard(current)
        async with httpx.AsyncClient(
            follow_redirects=False,  # every hop is guarded by hand, above
            timeout=httpx.Timeout(TOTAL_TIMEOUT_SECONDS),
            transport=_transport_for(ctx.app, origin),
            # Ask for plain bytes so the byte cap below bounds what actually
            # comes off the network, not what it decompresses to.
            headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"},
        ) as client:
            try:
                async with client.stream("GET", current) as response:
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            raise ToolFailure(
                                f"{current} answered {response.status_code} with no Location "
                                "header to follow"
                            )
                        current = urljoin(current, location)
                        continue
                    if response.status_code >= 400:
                        raise ToolFailure(
                            f"{current} answered {response.status_code} "
                            f"{response.reason_phrase}".strip()
                        )
                    content_type = response.headers.get("content-type", "")
                    media_type = content_type.split(";")[0].strip().lower()
                    if not _readable_kind(media_type):
                        raise ToolFailure(
                            f"{current} is {media_type or 'of an unstated type'}, and this tool "
                            "only reads text and JSON"
                        )

                    body = bytearray()
                    truncated = False
                    async for chunk in response.aiter_bytes():
                        body += chunk
                        if len(body) > MAX_BYTES:
                            del body[MAX_BYTES:]
                            truncated = True
                            break
            except httpx.HTTPError as exc:
                raise ToolFailure(
                    f"could not fetch {current} — {type(exc).__name__}: {exc}"
                ) from exc

        text = bytes(body).decode(_charset(content_type), errors="replace")
        if media_type == "text/html":
            text = strip_tags(text)
        header = f"Fetched {current} ({media_type}, {len(body)} bytes read)"
        if truncated:
            header += f" [truncated at the {MAX_BYTES}-byte limit]"
        return f"{header}:\n\n{text}"

    raise ToolFailure(
        f"refusing {url!r}: more than {MAX_REDIRECTS} redirects, last was {current}"
    )


async def fetch_url(args: dict, ctx: ToolContext) -> str:
    url = args["url"]
    try:
        async with asyncio.timeout(TOTAL_TIMEOUT_SECONDS):
            return await _fetch(url, ctx)
    except TimeoutError as exc:
        raise ToolFailure(
            f"fetching {url!r} took longer than {TOTAL_TIMEOUT_SECONDS:g} seconds"
        ) from exc


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="fetch_url",
        description=(
            "Fetch a public web page or JSON document over http/https and return its text. "
            "Read-only: it cannot post, and it cannot reach anything on this machine or "
            "this network."
        ),
        parameters={
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The full http/https URL to read."}
            },
            "required": ["url"],
            "additionalProperties": False,
        },
        executor=fetch_url,
        reads_only=True,
        # A web page is a live read that goes stale: the turn is not ingested
        # into memory, so "what's the latest?" always re-fetches instead of
        # recalling a cached snapshot and serving it as current.
        ephemeral=True,
    ),
)
