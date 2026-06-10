import pytest
from app.main import app
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
def admin_headers():
    return {"X-Admin-Secret": "test-secret"}


@pytest.mark.asyncio
async def test_list_schedules_empty(client, admin_headers):
    resp = await client.get("/api/v1/schedules", headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_create_and_get_schedule(client, admin_headers):
    body = {
        "name": "daily check",
        "prompt": "check open tasks",
        "trigger": {"type": "interval", "every_seconds": 86400},
    }
    create_resp = await client.post("/api/v1/schedules", json=body, headers=admin_headers)
    assert create_resp.status_code == 201
    created = create_resp.json()
    assert created["name"] == "daily check"
    assert "id" in created

    get_resp = await client.get(f"/api/v1/schedules/{created['id']}", headers=admin_headers)
    assert get_resp.status_code == 200
    assert get_resp.json()["id"] == created["id"]


@pytest.mark.asyncio
async def test_delete_schedule(client, admin_headers):
    create_resp = await client.post(
        "/api/v1/schedules",
        json={"name": "to-delete", "prompt": "x", "trigger": {"type": "interval", "every_seconds": 60}},
        headers=admin_headers,
    )
    sched_id = create_resp.json()["id"]
    del_resp = await client.delete(f"/api/v1/schedules/{sched_id}", headers=admin_headers)
    assert del_resp.status_code == 204


@pytest.mark.asyncio
async def test_webhook_unknown_schedule_returns_401(client):
    resp = await client.post(
        "/api/v1/webhooks/00000000-0000-0000-0000-000000000001",
        headers={"Authorization": "Bearer wrong"},
        json={},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_webhook_missing_auth_returns_401(client):
    resp = await client.post("/api/v1/webhooks/00000000-0000-0000-0000-000000000002")
    assert resp.status_code == 401
