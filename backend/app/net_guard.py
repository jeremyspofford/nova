"""Outbound-target guard: may the backend open a connection to this URL?

Lifted out of `tools/web_fetch.py`, where it grew up guarding the fetch_url
tool alone. It is its own module now because it has four callers and only
one of them is fetch_url:

    tools/web_fetch.py      the original — every hop of every fetch
    media_client.py         was already reaching in for `_validate_target`
                            by private cross-module import
    actions/__init__.py     preflighting a URL a model put on a card
    mcp_client.py           dialling any server a model proposed, i.e.
                            mcp_servers.created_by <> 'operator'

Three of those four needed the same allow-list; two of them would have
copied it. Migration 037 exists in this repo because a copied rule drifted
from its original, so: one copy, one audit, one place to fix.

ALLOW-LIST, NOT DENY-LIST. Only globally routable addresses pass. The
deny-list this replaced (private/loopback/link-local/reserved/multicast/
unspecified) silently missed CGNAT — 100.64.0.0/10, which is exactly
Tailscale's range — because CPython's `ipaddress` classifies it as none of
those, only as `not is_global`. With the tailscale profile up that left
every peer on the tailnet fetchable by the model.

RESIDUAL RISK, documented deliberately: we resolve, then connect, and httpx
resolves again. A hostile resolver flipping records between the two calls
(DNS rebinding) defeats this. Accepted at this trust level; a pinned-IP
transport is the only thing that closes it.
"""

import asyncio
import ipaddress
import logging
import socket
from urllib.parse import urlparse

log = logging.getLogger(__name__)


async def validate_target(url: str) -> str | None:
    """Return an error string if the URL must not be dialled, else None.

    Never raises: an unresolvable host is a refusal with a reason, not an
    exception for four call sites to each handle their own way.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return f"scheme '{parsed.scheme}' is not allowed (http/https only)"
    host = parsed.hostname
    if not host:
        return "URL has no hostname"

    try:
        loop = asyncio.get_running_loop()
        infos = await loop.run_in_executor(
            None, lambda: socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP))
    except socket.gaierror as e:
        return f"cannot resolve host '{host}': {e}"

    for info in infos:
        if not is_public_address(info[4][0]):
            log.warning("SSRF guard refused %s (resolves to %s)", url, info[4][0])
            return (f"host '{host}' resolves to a non-public address "
                    f"({info[4][0]}) — connecting to internal/private targets "
                    f"is not allowed")
    return None


def is_public_address(raw_ip: str) -> bool:
    """Only globally routable addresses pass.

    Two wrinkles `is_global` does not cover on its own: some multicast is
    is_global, and an IPv4-mapped/NAT64 v6 address reports on the v6 wrapper
    rather than the v4 target it actually reaches, so both are unwrapped
    first.
    """
    ip = ipaddress.ip_address(raw_ip)
    if getattr(ip, "ipv4_mapped", None):
        ip = ip.ipv4_mapped
    elif ip.version == 6 and ip in ipaddress.ip_network("64:ff9b::/96"):
        # NAT64: the low 32 bits are the real IPv4 destination
        ip = ipaddress.ip_address(int(ip) & 0xFFFFFFFF)
    return ip.is_global and not ip.is_multicast
