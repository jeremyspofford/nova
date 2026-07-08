"""Trusted networks integration tests — network status, auth bypass, config seeding."""
from __future__ import annotations

import httpx


class TestNetworkStatus:
    """GET /api/v1/auth/network-status — public endpoint."""

    async def test_returns_client_ip_and_trust(self, orchestrator: httpx.AsyncClient):
        resp = await orchestrator.get("/api/v1/auth/network-status")
        assert resp.status_code == 200
        data = resp.json()
        assert "client_ip" in data
        assert "trusted" in data
        assert isinstance(data["trusted"], bool)
        # From localhost/Docker bridge, we should be trusted by default
        assert data["trusted"] is True

    async def test_ip_is_valid(self, orchestrator: httpx.AsyncClient):
        resp = await orchestrator.get("/api/v1/auth/network-status")
        ip = resp.json()["client_ip"]
        # Should be a valid IPv4 or IPv6 address (not empty or "unknown")
        assert ip and ip != "unknown"


class TestAuthProvidersTrustedField:
    """GET /api/v1/auth/providers — includes trusted_network field."""

    async def test_providers_includes_trusted_network(self, orchestrator: httpx.AsyncClient):
        resp = await orchestrator.get("/api/v1/auth/providers")
        assert resp.status_code == 200
        data = resp.json()
        assert "trusted_network" in data
        assert isinstance(data["trusted_network"], bool)
        # From localhost/Docker bridge, should be trusted
        assert data["trusted_network"] is True


class TestTrustedNetworkAuthPosture:
    """Trust by network is capped at the USER surface. Admin/management always
    requires credentials (SEC2 for require_admin; TD-10 for role-gated
    management endpoints)."""

    async def test_admin_config_requires_credentials(self, orchestrator: httpx.AsyncClient, admin_headers):
        """require_admin refuses network position — 401 without creds, 200 with."""
        resp = await orchestrator.get("/api/v1/config")
        assert resp.status_code == 401
        resp = await orchestrator.get("/api/v1/config", headers=admin_headers)
        assert resp.status_code == 200
        assert isinstance(resp.json(), (list, dict))

    async def test_user_management_requires_admin(self, orchestrator: httpx.AsyncClient, admin_headers):
        """TD-10: role-gated management (list users) rejects the trusted-network
        member identity, but works with real admin credentials."""
        resp = await orchestrator.get("/api/v1/admin/users")
        assert resp.status_code in (401, 403)
        resp = await orchestrator.get("/api/v1/admin/users", headers=admin_headers)
        assert resp.status_code == 200

    async def test_user_surface_accepts_trusted_network(self, orchestrator: httpx.AsyncClient):
        """The user surface (conversations) still accepts a trusted-network
        request — it resolves to a synthetic member identity."""
        resp = await orchestrator.get("/api/v1/conversations")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)


class TestTrustedNetworkConfigSeeded:
    """platform_config seeds trusted-network keys (read with admin creds)."""

    async def test_trusted_networks_key_exists(self, orchestrator: httpx.AsyncClient, admin_headers):
        resp = await orchestrator.get("/api/v1/config", headers=admin_headers)
        assert resp.status_code == 200
        keys = {entry["key"] for entry in resp.json()}
        assert "trusted_networks" in keys

    async def test_trusted_proxy_header_key_exists(self, orchestrator: httpx.AsyncClient, admin_headers):
        resp = await orchestrator.get("/api/v1/config", headers=admin_headers)
        assert resp.status_code == 200
        keys = {entry["key"] for entry in resp.json()}
        assert "trusted_proxy_header" in keys
