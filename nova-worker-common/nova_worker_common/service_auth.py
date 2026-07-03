"""Shared auth middleware + dep for internal Nova services.

Goal: close the audit's SEC-003/SEC-004 finding that llm-gateway, memory-service,
and cortex expose all endpoints unauthenticated. Orchestrator already has a full
auth stack (JWT, API keys, RBAC, account expiry); the other services don't need
that — they only need to answer "is this caller allowed?".

Two concerns:

1. `TrustedNetworkMiddleware` stamps `request.state.is_trusted_network` based on
   a static CIDR list (env-driven). Unlike the orchestrator's DB-backed version,
   this one doesn't need a database — it's meant for services that can't/won't
   query Postgres on every request. Default CIDRs cover loopback, Docker bridge
   ranges, Tailscale, and RFC1918 private space.

2. `create_admin_auth_dep(resolver)` returns a FastAPI dependency that accepts
   a request if EITHER of:
     - `request.state.is_trusted_network` is True (set by middleware above)
     - `X-Admin-Secret` header matches the resolver's rotated secret
   Otherwise raises 403.

Why not API keys? That requires DB access on the hot path for key lookup.
Short-term, admin-secret + trusted-network covers the daily-driver threat
model (Tailnet + LAN abuse of paid tokens + unauthenticated memory exfil).
API key support is a reasonable future extension — pass a `lookup_api_key`
callback to `create_admin_auth_dep`.
"""
from __future__ import annotations

import hmac
import logging
import os
from ipaddress import IPv4Network, IPv6Network, ip_address, ip_network
from typing import Awaitable, Callable

from fastapi import Header, HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from .admin_secret import AdminSecretResolver

log = logging.getLogger(__name__)

NetworkType = IPv4Network | IPv6Network

# Default CIDRs — loopback, Docker default bridge ranges, Tailscale CGNAT,
# RFC1918 private networks. Operators override via env var per service.
DEFAULT_TRUSTED_CIDRS = (
    "127.0.0.0/8",
    "::1/128",
    "172.16.0.0/12",   # Docker default bridge range
    "10.0.0.0/8",      # RFC1918 A
    "192.168.0.0/16",  # RFC1918 C
    "100.64.0.0/10",   # Tailscale CGNAT
)


def parse_cidrs(raw: str) -> list[NetworkType]:
    """Parse a comma-separated CIDR string into network objects. Invalid entries are skipped."""
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
            log.warning("Ignoring invalid CIDR: %r", part)
    return nets


def load_trusted_cidrs_from_env(env_var: str = "TRUSTED_NETWORK_CIDRS") -> list[NetworkType]:
    """Read the CIDR list from env; fall back to DEFAULT_TRUSTED_CIDRS if unset."""
    raw = os.environ.get(env_var, "").strip()
    if not raw:
        raw = ",".join(DEFAULT_TRUSTED_CIDRS)
    nets = parse_cidrs(raw)
    log.info("Service trusted networks: %d CIDRs loaded", len(nets))
    return nets


class TrustedNetworkMiddleware(BaseHTTPMiddleware):
    """Stamp `request.state.is_trusted_network` based on static CIDR list."""

    def __init__(self, app, trusted_cidrs: list[NetworkType]):
        super().__init__(app)
        self._cidrs = list(trusted_cidrs)

    def _is_trusted(self, ip_str: str) -> bool:
        if not self._cidrs:
            return False
        try:
            addr = ip_address(ip_str)
        except ValueError:
            return False
        return any(addr in net for net in self._cidrs)

    async def dispatch(self, request: Request, call_next) -> Response:
        direct_ip = request.client.host if request.client else "127.0.0.1"
        request.state.is_trusted_network = self._is_trusted(direct_ip)
        request.state.client_ip = direct_ip
        return await call_next(request)


def create_admin_auth_dep(
    resolver: AdminSecretResolver,
    *,
    lookup_api_key: Callable[[str], Awaitable[dict | None]] | None = None,
):
    """Build a FastAPI dependency that authenticates requests to an internal service.

    Accepts any of:
      1. Trusted network (request.state.is_trusted_network set by middleware above)
      2. X-Admin-Secret matching the resolver's current value
      3. X-API-Key — only if `lookup_api_key` callback is provided; callback returns
         the DB row on hit or None on miss

    Raises 403 otherwise. Import the returned dep object directly into route handlers:

        auth = create_admin_auth_dep(resolver)
        @router.post("/endpoint")
        async def handler(request: Request, _: None = Depends(auth)):
            ...
    """
    async def _check(
        request: Request,
        x_admin_secret: str | None = Header(None, alias="X-Admin-Secret"),
        x_api_key: str | None = Header(None, alias="X-API-Key"),
    ) -> None:
        # 1. Trusted network bypass (middleware must be installed)
        if getattr(request.state, "is_trusted_network", False):
            return

        # 2. Admin secret (rotatable via orchestrator endpoint)
        if x_admin_secret:
            current = await resolver.get()
            if current and hmac.compare_digest(x_admin_secret, current):
                return

        # 3. Optional API key lookup (service provides callback if it has DB access)
        if x_api_key and lookup_api_key is not None:
            try:
                row = await lookup_api_key(x_api_key)
                if row is not None:
                    return
            except Exception:
                log.exception("API key lookup failed; treating as unauthenticated")

        raise HTTPException(status_code=403, detail="Authentication required")

    return _check
