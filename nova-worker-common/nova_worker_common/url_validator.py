"""SSRF prevention -- validate URLs before fetching.

The critical check is `_resolve_and_check`: a hostname string can be perfectly
innocent-looking yet resolve to a loopback/private/metadata address
(`127.0.0.1.nip.io`, `localtest.me`, or any attacker domain with an internal
A record). String-matching the hostname alone is not enough — we resolve it
and reject if *any* returned address is internal.
"""
import ipaddress
import socket
from urllib.parse import urlparse

# All Nova service hostnames + infrastructure + metadata endpoints
BLOCKED_HOSTS: set[str] = {
    # Nova services
    "orchestrator",
    "llm-gateway",
    "memory-service",
    "chat-api",
    "dashboard",
    "intel-worker",
    "knowledge-worker",
    "cortex",
    "recovery",
    # Infrastructure
    "postgres",
    "redis",
    # Loopback aliases
    "localhost",
    "0.0.0.0",
    # Cloud metadata / Docker internals
    "metadata.google.internal",
    "host.docker.internal",
}

# Wildcard-DNS services that map an arbitrary label to a caller-chosen IP
# (e.g. `127.0.0.1.nip.io` -> `127.0.0.1`). The resolve-and-check below is the
# real defense; blocking these by suffix is belt-and-suspenders.
BLOCKED_SUFFIXES: tuple[str, ...] = (
    ".nip.io", ".sslip.io", ".xip.io", ".localtest.me",
)


def _is_internal(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Any address an external fetch has no business reaching."""
    return (
        ip.is_private or ip.is_loopback or ip.is_link_local
        or ip.is_reserved or ip.is_multicast or ip.is_unspecified
    )


def validate_url(
    url: str,
    extra_blocked_hosts: set[str] | None = None,
) -> str | None:
    """Return an error message if *url* is unsafe, ``None`` if OK.

    Blocks non-http(s) schemes, internal Nova service hostnames, wildcard-DNS
    services, and any hostname that is — or *resolves to* — a private,
    loopback, link-local, reserved, multicast, or unspecified address.
    Fails closed: an unresolvable host is rejected.
    """
    parsed = urlparse(url)

    if parsed.scheme not in ("http", "https"):
        return f"Scheme '{parsed.scheme}' not allowed"

    hostname = (parsed.hostname or "").lower()
    if not hostname:
        return "URL has no host"

    blocked = BLOCKED_HOSTS
    if extra_blocked_hosts:
        blocked = BLOCKED_HOSTS | extra_blocked_hosts
    if hostname in blocked:
        return f"Host '{hostname}' is blocked"
    if hostname.endswith(BLOCKED_SUFFIXES):
        return f"Host '{hostname}' uses a blocked wildcard-DNS service"

    # IP literal — check directly, no resolution needed.
    try:
        ip = ipaddress.ip_address(hostname)
        if _is_internal(ip):
            return f"Internal IP '{ip}' not allowed"
        return None
    except ValueError:
        pass  # a domain name — resolve and check every address it maps to

    try:
        infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError, OSError):
        return f"Host '{hostname}' could not be resolved"

    for info in infos:
        addr = info[4][0].split("%", 1)[0]  # drop any IPv6 scope id
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if _is_internal(ip):
            return f"Host '{hostname}' resolves to internal IP '{ip}'"

    return None
