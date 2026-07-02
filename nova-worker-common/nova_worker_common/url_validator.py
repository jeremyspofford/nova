"""SSRF prevention -- validate URLs before fetching."""
import ipaddress
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


def validate_url(
    url: str,
    extra_blocked_hosts: set[str] | None = None,
) -> str | None:
    """Return an error message if *url* is unsafe, ``None`` if OK.

    Blocks:
    - Non-http(s) schemes
    - Internal Nova service hostnames
    - Private, loopback, and link-local IP addresses
    - Cloud metadata endpoints
    """
    parsed = urlparse(url)

    if parsed.scheme not in ("http", "https"):
        return f"Scheme '{parsed.scheme}' not allowed"

    hostname = (parsed.hostname or "").lower()

    blocked = BLOCKED_HOSTS
    if extra_blocked_hosts:
        blocked = BLOCKED_HOSTS | extra_blocked_hosts

    if hostname in blocked:
        return f"Host '{hostname}' is blocked"

    # Check for private / loopback / link-local IPs
    try:
        ip = ipaddress.ip_address(hostname)
        if ip.is_private or ip.is_loopback or ip.is_link_local:
            return f"Private/loopback/link-local IP '{ip}' not allowed"
    except ValueError:
        pass

    return None
