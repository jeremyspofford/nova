"""Trusted network middleware — stamps request.state with trust info.

Requests from trusted CIDRs (private networks, Tailscale, localhost) bypass
auth and are treated as admin. This lets users run both Tailscale (no login)
and Cloudflare tunnel (login required) simultaneously.

Config is loaded dynamically from platform_config (DB) with a 30s cache,
falling back to static .env values if the DB is unavailable.
"""
from __future__ import annotations

import json
import logging
import time
from ipaddress import IPv4Network, IPv6Network, ip_address, ip_network
from typing import Sequence, Union

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

log = logging.getLogger(__name__)

NetworkType = Union[IPv4Network, IPv6Network]

_CACHE_TTL = 30  # seconds


def parse_cidrs(raw: str) -> list[NetworkType]:
    """Parse comma-separated CIDRs into a list of network objects.

    Silently skips invalid entries and logs a warning.
    Returns an empty list if raw is empty (feature disabled).
    """
    if not raw or not raw.strip():
        return []
    nets: list[NetworkType] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            nets.append(ip_network(part, strict=False))
        except ValueError:
            log.warning("Ignoring invalid CIDR in trusted_networks: %r", part)
    return nets


def _unwrap_jsonb(val: str | None) -> str:
    """Unwrap a JSONB string value (may be JSON-encoded with quotes)."""
    if not val:
        return ""
    if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
        try:
            return json.loads(val)
        except Exception:
            pass
    return val


class TrustedNetworkMiddleware(BaseHTTPMiddleware):
    """Stamp every request with trust status based on client IP.

    Reads trusted_networks and trusted_proxy_header from platform_config
    with a 30s TTL cache. Falls back to static .env values on DB error.
    """

    def __init__(self, app, trusted_cidrs: Sequence[NetworkType], proxy_header: str = ""):
        super().__init__(app)
        # Static fallbacks from .env (used on DB error or before first refresh)
        self._fallback_cidrs = list(trusted_cidrs)
        self._fallback_proxy_header = proxy_header.strip() if proxy_header else ""

        # Dynamic cached values
        self._cached_cidrs: list[NetworkType] = list(trusted_cidrs)
        self._cached_proxy_header: str = self._fallback_proxy_header
        self._cache_ts: float = 0  # force refresh on first request

        if self._fallback_cidrs:
            log.info(
                "Trusted networks enabled: %d CIDRs, proxy_header=%s",
                len(self._fallback_cidrs),
                self._fallback_proxy_header or "(none)",
            )

    async def _refresh_config(self) -> None:
        """Reload trusted network config from DB if cache is stale."""
        now = time.monotonic()
        if now - self._cache_ts < _CACHE_TTL:
            return

        try:
            from app.db import get_pool
            pool = get_pool()
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT key, value #>> '{}' AS val FROM platform_config "
                    "WHERE key IN ('trusted_networks', 'trusted_proxy_header')"
                )
            config = {r["key"]: _unwrap_jsonb(r["val"]) for r in rows}

            cidrs_raw = config.get("trusted_networks", "")
            proxy_header = config.get("trusted_proxy_header", "")

            if cidrs_raw:
                self._cached_cidrs = parse_cidrs(cidrs_raw)
            else:
                self._cached_cidrs = self._fallback_cidrs

            self._cached_proxy_header = proxy_header.strip() if proxy_header else self._fallback_proxy_header
            self._cache_ts = now
        except Exception:
            # DB unavailable — keep using previous cached or fallback values.
            # WARNING, not DEBUG: this is a security-adjacent config (the
            # trusted-network bypass) silently falling back to possibly-more-
            # permissive CIDRs, and CLAUDE.md forbids hiding that at DEBUG.
            self._cache_ts = now  # avoid hammering DB on every request
            log.warning("Failed to refresh trusted network config from DB, using cached/fallback values")

    def _get_client_ip(self, request: Request, proxy_header: str) -> str:
        """Determine the real client IP.

        If a proxy header is configured AND the direct connection comes from
        a trusted proxy IP, use the leftmost (client) value from the header.
        Otherwise fall back to the direct connection IP. This prevents
        untrusted clients from forging the proxy header to spoof their IP.
        """
        direct_ip = request.client.host if request.client else "127.0.0.1"
        if proxy_header:
            # Only trust the header if the direct connection is from a trusted proxy
            if self._is_trusted(direct_ip, self._cached_cidrs or self._fallback_cidrs):
                header_val = request.headers.get(proxy_header, "")
                if header_val:
                    # X-Forwarded-For can be comma-separated; leftmost is the client
                    return header_val.split(",")[0].strip()
        return direct_ip

    def _is_trusted(self, ip_str: str, cidrs: list[NetworkType]) -> bool:
        """Check if an IP falls within any trusted CIDR."""
        if not cidrs:
            return False
        try:
            addr = ip_address(ip_str)
        except ValueError:
            return False
        return any(addr in net for net in cidrs)

    async def dispatch(self, request: Request, call_next) -> Response:
        await self._refresh_config()
        client_ip = self._get_client_ip(request, self._cached_proxy_header)
        is_trusted = self._is_trusted(client_ip, self._cached_cidrs)
        request.state.is_trusted_network = is_trusted
        request.state.client_ip = client_ip
        return await call_next(request)
