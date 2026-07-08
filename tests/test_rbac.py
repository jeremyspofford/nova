"""Integration tests for RBAC (role-based access control) and invite system."""
import httpx
import pytest

ORCH = "http://localhost:8000"


@pytest.fixture
async def client():
    """Standalone async client for RBAC tests."""
    async with httpx.AsyncClient(base_url=ORCH, timeout=10) as c:
        yield c


@pytest.fixture
def headers():
    """Admin headers using admin secret."""
    import os
    secret = os.environ.get("NOVA_ADMIN_SECRET", "nova-admin-secret-change-me")
    return {"X-Admin-Secret": secret}


class TestUserListing:
    """Test GET /api/v1/admin/users."""

    @pytest.mark.asyncio
    async def test_list_users_as_admin(self, client, headers):
        resp = await client.get("/api/v1/admin/users", headers=headers)
        assert resp.status_code == 200
        users = resp.json()
        assert isinstance(users, list)
        # Should have at least one user or be empty
        for u in users:
            assert "role" in u
            assert "status" in u
            assert "password_hash" not in u  # sensitive field stripped

    @pytest.mark.asyncio
    async def test_list_users_without_auth(self, client):
        from conftest import REQUIRE_AUTH
        if not REQUIRE_AUTH:
            pytest.skip("REQUIRE_AUTH=false — auth enforcement not active")
        resp = await client.get("/api/v1/admin/users")
        assert resp.status_code in (401, 403)


class TestInviteWithRole:
    """Test invite creation with role assignment."""

    @pytest.mark.asyncio
    async def test_create_invite_with_member_role(self, client, headers):
        from conftest import REQUIRE_AUTH
        if not REQUIRE_AUTH:
            pytest.skip("REQUIRE_AUTH=false — invite FK requires real user")
        resp = await client.post(
            "/api/v1/auth/invites",
            json={"role": "member", "expires_in_hours": 1},
            headers=headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["role"] == "member"
        assert "code" in data
        # Cleanup
        await client.delete(f"/api/v1/auth/invites/{data['id']}", headers=headers)

    @pytest.mark.asyncio
    async def test_create_invite_with_guest_role_and_expiry(self, client, headers):
        from conftest import REQUIRE_AUTH
        if not REQUIRE_AUTH:
            pytest.skip("REQUIRE_AUTH=false — invite FK requires real user")
        resp = await client.post(
            "/api/v1/auth/invites",
            json={"role": "guest", "expires_in_hours": 1, "account_expires_in_hours": 24},
            headers=headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["role"] == "guest"
        assert data["account_expires_in_hours"] == 24
        # Cleanup
        await client.delete(f"/api/v1/auth/invites/{data['id']}", headers=headers)

    @pytest.mark.asyncio
    async def test_create_invite_invalid_role(self, client, headers):
        resp = await client.post(
            "/api/v1/auth/invites",
            json={"role": "superadmin"},
            headers=headers,
        )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_list_invites_includes_role(self, client, headers):
        from conftest import REQUIRE_AUTH
        if not REQUIRE_AUTH:
            pytest.skip("REQUIRE_AUTH=false — invite FK requires real user")
        # Create an invite first
        create_resp = await client.post(
            "/api/v1/auth/invites",
            json={"role": "viewer", "expires_in_hours": 1},
            headers=headers,
        )
        invite_id = create_resp.json()["id"]

        resp = await client.get("/api/v1/auth/invites", headers=headers)
        assert resp.status_code == 200
        invites = resp.json()
        assert any(i.get("role") == "viewer" for i in invites)

        # Cleanup
        await client.delete(f"/api/v1/auth/invites/{invite_id}", headers=headers)


class TestAuthMeRole:
    """Test that /auth/me returns role."""

    @pytest.mark.asyncio
    async def test_me_returns_role(self, client, headers):
        resp = await client.get("/api/v1/auth/me", headers=headers)
        if resp.status_code == 200:
            data = resp.json()
            assert "role" in data
            assert data["role"] in ("owner", "admin", "member", "viewer", "guest")


class TestGuestAllowedModels:
    """Test guest_allowed_models config."""

    @pytest.mark.asyncio
    async def test_set_guest_models(self, client, headers):
        """Verify guest_allowed_models can be read from config."""
        resp = await client.get("/api/v1/config", headers=headers)
        if resp.status_code == 200:
            config = resp.json()
            # Find guest_allowed_models in config entries
            guest_config = [c for c in config if c.get("key") == "guest_allowed_models"]
            assert len(guest_config) == 1


class TestUserLifecycle:
    """Deactivate (PATCH status) / reactivate / hard delete (DELETE)."""

    @pytest.fixture
    async def temp_user(self, client, headers):
        """Create a throwaway member; hard-delete it on teardown if it survives."""
        resp = await client.post(
            "/api/v1/admin/users",
            json={"email": "nova-test-lifecycle@test.local", "role": "member"},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        user = resp.json()
        yield user
        await client.delete(f"/api/v1/admin/users/{user['id']}", headers=headers)

    @pytest.mark.asyncio
    async def test_deactivate_reactivate_roundtrip(self, client, headers, temp_user):
        resp = await client.patch(
            f"/api/v1/admin/users/{temp_user['id']}",
            json={"status": "deactivated"}, headers=headers,
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "deactivated"

        resp = await client.patch(
            f"/api/v1/admin/users/{temp_user['id']}",
            json={"status": "active"}, headers=headers,
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "active"

    @pytest.mark.asyncio
    async def test_hard_delete_removes_user(self, client, headers, temp_user):
        resp = await client.delete(f"/api/v1/admin/users/{temp_user['id']}", headers=headers)
        assert resp.status_code == 200
        assert resp.json() == {"status": "deleted"}

        # Gone from the list — not a soft-delete
        resp = await client.get("/api/v1/admin/users", headers=headers)
        assert temp_user["id"] not in [u["id"] for u in resp.json()]

        # Email is reusable, proving the row (not just the status) is gone
        resp = await client.post(
            "/api/v1/admin/users",
            json={"email": "nova-test-lifecycle@test.local", "role": "member"},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        recreated = resp.json()
        assert recreated["id"] != temp_user["id"]
        await client.delete(f"/api/v1/admin/users/{recreated['id']}", headers=headers)

    @pytest.mark.asyncio
    async def test_delete_owner_forbidden(self, client, headers):
        resp = await client.get("/api/v1/admin/users", headers=headers)
        owners = [u for u in resp.json() if u["role"] == "owner"]
        if not owners:
            pytest.skip("no owner account on this instance")
        resp = await client.delete(f"/api/v1/admin/users/{owners[0]['id']}", headers=headers)
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_delete_unknown_user_404(self, client, headers):
        resp = await client.delete(
            "/api/v1/admin/users/00000000-0000-0000-0000-00000000dead", headers=headers,
        )
        assert resp.status_code == 404
