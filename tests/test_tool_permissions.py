"""Tool permissions integration tests — API endpoints, filtering, and audit."""
from __future__ import annotations

import httpx
import pytest


class TestToolPermissionsAPI:
    """Test GET and PATCH /api/v1/tool-permissions."""

    async def test_get_returns_all_groups_enabled(
        self, orchestrator: httpx.AsyncClient, admin_headers: dict
    ):
        resp = await orchestrator.get("/api/v1/tool-permissions", headers=admin_headers)
        assert resp.status_code == 200
        groups = resp.json()
        assert isinstance(groups, list)
        assert len(groups) >= 4  # Platform, Code, Git, Web

        names = {g["name"] for g in groups}
        assert "Platform" in names
        assert "Code" in names
        assert "Git" in names
        assert "Web" in names

        # Default: all enabled
        for g in groups:
            assert g["enabled"] is True
            assert g["tool_count"] > 0
            assert isinstance(g["tools"], list)

    async def test_groups_have_display_names(
        self, orchestrator: httpx.AsyncClient, admin_headers: dict
    ):
        resp = await orchestrator.get("/api/v1/tool-permissions", headers=admin_headers)
        assert resp.status_code == 200
        groups = resp.json()

        display_names = {g["name"]: g["display_name"] for g in groups if not g["is_mcp"]}
        assert display_names["Platform"] == "Agent Management"
        assert display_names["Code"] == "Files & Shell"
        assert display_names["Git"] == "Version Control"
        assert display_names["Web"] == "Internet Access"

    async def test_disable_and_reenable_group(
        self, orchestrator: httpx.AsyncClient, admin_headers: dict
    ):
        # Disable Web
        resp = await orchestrator.patch(
            "/api/v1/tool-permissions",
            json={"groups": {"Web": False}},
            headers=admin_headers,
        )
        assert resp.status_code == 200
        groups = resp.json()
        web = next(g for g in groups if g["name"] == "Web")
        assert web["enabled"] is False

        # Other groups still enabled
        code = next(g for g in groups if g["name"] == "Code")
        assert code["enabled"] is True

        # Re-enable Web
        resp = await orchestrator.patch(
            "/api/v1/tool-permissions",
            json={"groups": {"Web": True}},
            headers=admin_headers,
        )
        assert resp.status_code == 200
        groups = resp.json()
        web = next(g for g in groups if g["name"] == "Web")
        assert web["enabled"] is True

    async def test_disable_multiple_groups(
        self, orchestrator: httpx.AsyncClient, admin_headers: dict
    ):
        resp = await orchestrator.patch(
            "/api/v1/tool-permissions",
            json={"groups": {"Web": False, "Git": False}},
            headers=admin_headers,
        )
        assert resp.status_code == 200
        groups = resp.json()
        statuses = {g["name"]: g["enabled"] for g in groups}
        assert statuses["Web"] is False
        assert statuses["Git"] is False
        assert statuses["Platform"] is True
        assert statuses["Code"] is True

        # Clean up
        await orchestrator.patch(
            "/api/v1/tool-permissions",
            json={"groups": {"Web": True, "Git": True}},
            headers=admin_headers,
        )

    async def test_unknown_group_returns_422(
        self, orchestrator: httpx.AsyncClient, admin_headers: dict
    ):
        resp = await orchestrator.patch(
            "/api/v1/tool-permissions",
            json={"groups": {"NonExistentGroup": False}},
            headers=admin_headers,
        )
        assert resp.status_code == 422
        assert "NonExistentGroup" in resp.text

    async def test_empty_groups_payload_no_change(
        self, orchestrator: httpx.AsyncClient, admin_headers: dict
    ):
        # Get current state
        before = await orchestrator.get("/api/v1/tool-permissions", headers=admin_headers)
        before_statuses = {g["name"]: g["enabled"] for g in before.json()}

        # PATCH with empty groups
        resp = await orchestrator.patch(
            "/api/v1/tool-permissions",
            json={"groups": {}},
            headers=admin_headers,
        )
        assert resp.status_code == 200

        # Verify no change
        after_statuses = {g["name"]: g["enabled"] for g in resp.json()}
        assert before_statuses == after_statuses

    async def test_requires_admin_auth(self, orchestrator: httpx.AsyncClient):
        from conftest import REQUIRE_AUTH
        if not REQUIRE_AUTH:
            pytest.skip("REQUIRE_AUTH=false — auth enforcement not active")
        resp = await orchestrator.get("/api/v1/tool-permissions")
        assert resp.status_code in (401, 403)

        resp = await orchestrator.patch(
            "/api/v1/tool-permissions",
            json={"groups": {"Web": False}},
        )
        assert resp.status_code in (401, 403)

    async def test_group_has_correct_structure(
        self, orchestrator: httpx.AsyncClient, admin_headers: dict
    ):
        resp = await orchestrator.get("/api/v1/tool-permissions", headers=admin_headers)
        assert resp.status_code == 200
        groups = resp.json()

        for g in groups:
            assert "name" in g
            assert "display_name" in g
            assert "description" in g
            assert "tools" in g
            assert "tool_count" in g
            assert "enabled" in g
            assert "is_mcp" in g
            assert g["tool_count"] == len(g["tools"])


class TestSandboxTierRename:
    """Verify sandbox tier rename and backward compat."""

    async def test_sandbox_setting_uses_new_names(
        self, orchestrator: httpx.AsyncClient, admin_headers: dict
    ):
        """Platform config should accept new tier names."""
        # Set to 'home' (new name). Key lives in the path; value is JSON-encoded.
        resp = await orchestrator.patch(
            "/api/v1/config/shell.sandbox",
            json={"value": '"home"'},
            headers=admin_headers,
        )
        assert resp.status_code == 200

        # Read it back
        resp = await orchestrator.get("/api/v1/config", headers=admin_headers)
        entries = {e["key"]: e for e in resp.json()}
        assert entries["shell.sandbox"]["value"] == "home"

    async def test_sandbox_setting_backward_compat(
        self, orchestrator: httpx.AsyncClient, admin_headers: dict
    ):
        """Old tier names ('nova', 'host') should still be accepted."""
        resp = await orchestrator.patch(
            "/api/v1/config/shell.sandbox",
            json={"value": '"nova"'},
            headers=admin_headers,
        )
        assert resp.status_code == 200

    async def test_sandbox_setting_reset_to_workspace(
        self, orchestrator: httpx.AsyncClient, admin_headers: dict
    ):
        """Clean up: reset sandbox to workspace."""
        resp = await orchestrator.patch(
            "/api/v1/config/shell.sandbox",
            json={"value": '"workspace"'},
            headers=admin_headers,
        )
        assert resp.status_code == 200
