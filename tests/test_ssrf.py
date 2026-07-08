"""SSRF validator unit tests — deterministic (DNS mocked), no services needed.

Covers TD-01: string-based hostname checks are not enough; a hostname must be
resolved and every returned address checked against internal ranges.
"""
import os
import socket
import sys
from unittest.mock import patch

# Import the pure-Python validator straight from the shared package source.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "nova-worker-common"))
from nova_worker_common.url_validator import validate_url  # noqa: E402


def _gai(ip: str):
    """A getaddrinfo stub returning a single address."""
    fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
    return [(fam, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 0))]


def test_allows_public():
    with patch("socket.getaddrinfo", return_value=_gai("93.184.216.34")):
        assert validate_url("https://example.com/page") is None


def test_blocks_ip_literals():
    for ip in ("127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254",
               "0.0.0.0", "::1", "fd00::1"):
        assert validate_url(f"http://{ip}/") is not None, ip


def test_blocks_service_and_infra_hosts():
    for host in ("orchestrator", "postgres", "redis", "localhost",
                 "host.docker.internal", "metadata.google.internal"):
        assert validate_url(f"http://{host}/") is not None, host


def test_blocks_wildcard_dns_by_suffix():
    # These are blocked by suffix without any DNS lookup.
    for host in ("127.0.0.1.nip.io", "10.0.0.1.sslip.io", "foo.localtest.me"):
        assert validate_url(f"http://{host}/") is not None, host


def test_blocks_domain_that_resolves_internal():
    # The core TD-01 fix: innocent hostname, internal A record.
    with patch("socket.getaddrinfo", return_value=_gai("127.0.0.1")):
        assert validate_url("http://evil.example.com/") is not None
    with patch("socket.getaddrinfo", return_value=_gai("169.254.169.254")):
        assert "internal" in validate_url("http://rebind.example.com/").lower()


def test_blocks_non_http_schemes():
    for url in ("file:///etc/passwd", "gopher://x/", "ftp://x/", "data:text/html,x"):
        assert validate_url(url) is not None, url


def test_fails_closed_on_unresolvable():
    with patch("socket.getaddrinfo", side_effect=socket.gaierror("nope")):
        assert validate_url("http://does-not-resolve.invalid/") is not None
