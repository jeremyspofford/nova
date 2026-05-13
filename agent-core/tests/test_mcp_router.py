"""Integration tests for the MCP router (real FastAPI app, no pool mock)."""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from httpx import AsyncClient, ASGITransport
from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
def admin_headers():
    return {"X-Admin-Secret": "test-secret"}


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_servers_empty(client, admin_headers):
    resp = await client.get("/api/v1/mcp/servers", headers=admin_headers)
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.asyncio
async def test_create_and_get_server(client, admin_headers):
    body = {
        "name": "test-mcp-server",
        "command": "node",
        "args": ["server.js"],
        "env": {"PORT": "9000"},
        "transport": "stdio",
    }
    create_resp = await client.post("/api/v1/mcp/servers", json=body, headers=admin_headers)
    assert create_resp.status_code == 201
    created = create_resp.json()
    assert created["name"] == "test-mcp-server"
    assert created["transport"] == "stdio"
    assert "id" in created
    assert "tools" in created  # POST returns tools list (may be empty)

    get_resp = await client.get(f"/api/v1/mcp/servers/{created['id']}", headers=admin_headers)
    assert get_resp.status_code == 200
    data = get_resp.json()
    assert data["id"] == created["id"]
    assert "tools" in data  # GET detail also includes tools


@pytest.mark.asyncio
async def test_create_duplicate_server_409(client, admin_headers):
    body = {"name": "dup-server", "command": "node", "args": []}
    await client.post("/api/v1/mcp/servers", json=body, headers=admin_headers)
    resp = await client.post("/api/v1/mcp/servers", json=body, headers=admin_headers)
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_get_nonexistent_server_404(client, admin_headers):
    resp = await client.get(
        "/api/v1/mcp/servers/00000000-0000-0000-0000-000000000099",
        headers=admin_headers,
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_update_server(client, admin_headers):
    body = {"name": "updatable-server", "command": "python", "args": ["-m", "server"]}
    create_resp = await client.post("/api/v1/mcp/servers", json=body, headers=admin_headers)
    srv_id = create_resp.json()["id"]

    patch_resp = await client.patch(
        f"/api/v1/mcp/servers/{srv_id}",
        json={"command": "python3", "enabled": False},
        headers=admin_headers,
    )
    assert patch_resp.status_code == 200
    updated = patch_resp.json()
    assert updated["command"] == "python3"
    assert updated["enabled"] is False


@pytest.mark.asyncio
async def test_delete_server(client, admin_headers):
    body = {"name": "delete-me-server", "command": "node", "args": []}
    create_resp = await client.post("/api/v1/mcp/servers", json=body, headers=admin_headers)
    srv_id = create_resp.json()["id"]

    del_resp = await client.delete(f"/api/v1/mcp/servers/{srv_id}", headers=admin_headers)
    assert del_resp.status_code == 204

    get_resp = await client.get(f"/api/v1/mcp/servers/{srv_id}", headers=admin_headers)
    assert get_resp.status_code == 404


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_servers_no_auth_401(client):
    resp = await client.get("/api/v1/mcp/servers")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_list_servers_wrong_secret_401(client):
    resp = await client.get(
        "/api/v1/mcp/servers",
        headers={"X-Admin-Secret": "wrong-secret"},
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Tool discovery (patched — no real process)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_server_tools(client, admin_headers):
    body = {"name": "tool-discovery-server", "command": "node", "args": []}
    create_resp = await client.post("/api/v1/mcp/servers", json=body, headers=admin_headers)
    srv_id = create_resp.json()["id"]

    fake_proc = MagicMock()
    fake_tools = [
        {
            "name": "get_user",
            "description": "",
            "input_schema": {},
            "auto_tier": "READ",
            "effective_tier": "READ",
        }
    ]

    with patch("app.mcp_router.mcp_manager.ensure_running", new=AsyncMock(return_value=fake_proc)), \
         patch("app.mcp_router.discover_tools", new=AsyncMock(return_value=fake_tools)):
        resp = await client.get(
            f"/api/v1/mcp/servers/{srv_id}/tools",
            headers=admin_headers,
        )

    assert resp.status_code == 200
    assert resp.json() == fake_tools


# ---------------------------------------------------------------------------
# Tier override — PATCH /servers/{id}/tools/{name}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_set_tier_override(client, admin_headers):
    body = {"name": "tier-override-server", "command": "node", "args": []}
    create_resp = await client.post("/api/v1/mcp/servers", json=body, headers=admin_headers)
    srv_id = create_resp.json()["id"]

    resp = await client.patch(
        f"/api/v1/mcp/servers/{srv_id}/tools/run_command",
        json={"tier_override": "READ"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["tier_override"] == "READ"


@pytest.mark.asyncio
async def test_clear_tier_override(client, admin_headers):
    body = {"name": "tier-clear-server", "command": "node", "args": []}
    create_resp = await client.post("/api/v1/mcp/servers", json=body, headers=admin_headers)
    srv_id = create_resp.json()["id"]

    # Set then clear.
    await client.patch(
        f"/api/v1/mcp/servers/{srv_id}/tools/run_command",
        json={"tier_override": "READ"},
        headers=admin_headers,
    )
    clear_resp = await client.patch(
        f"/api/v1/mcp/servers/{srv_id}/tools/run_command",
        json={"tier_override": None},
        headers=admin_headers,
    )
    assert clear_resp.status_code == 200
    assert clear_resp.json()["tier_override"] is None


@pytest.mark.asyncio
async def test_tier_override_invalid_value_400(client, admin_headers):
    body = {"name": "tier-invalid-server", "command": "node", "args": []}
    create_resp = await client.post("/api/v1/mcp/servers", json=body, headers=admin_headers)
    srv_id = create_resp.json()["id"]

    resp = await client.patch(
        f"/api/v1/mcp/servers/{srv_id}/tools/some_tool",
        json={"tier_override": "INVALID"},
        headers=admin_headers,
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Restart endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_restart_server(client, admin_headers):
    body = {"name": "restart-server", "command": "node", "args": []}
    create_resp = await client.post("/api/v1/mcp/servers", json=body, headers=admin_headers)
    srv_id = create_resp.json()["id"]

    with patch("app.mcp_router.mcp_manager.ensure_running", new=AsyncMock(return_value=MagicMock())):
        resp = await client.post(
            f"/api/v1/mcp/servers/{srv_id}/restart",
            headers=admin_headers,
        )

    assert resp.status_code == 202
    assert resp.json()["started"] is True


@pytest.mark.asyncio
async def test_restart_disabled_server_404(client, admin_headers):
    body = {"name": "disabled-restart-server", "command": "node", "args": [], "enabled": False}
    create_resp = await client.post("/api/v1/mcp/servers", json=body, headers=admin_headers)
    srv_id = create_resp.json()["id"]

    resp = await client.post(
        f"/api/v1/mcp/servers/{srv_id}/restart",
        headers=admin_headers,
    )
    assert resp.status_code == 404
