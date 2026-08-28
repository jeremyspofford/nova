"""Bearer-auth and health/status contract — identical shape across all
three services."""
from __future__ import annotations

from httpx import ASGITransport, AsyncClient

from app.main import SERVICE_NAME, app

BASE_URL = "http://test"


def _client() -> AsyncClient:
    # Plain ASGITransport does not run the app's lifespan, so these tests
    # never trigger the startup migration run — matches "/health/live
    # touches NOTHING".
    return AsyncClient(transport=ASGITransport(app=app), base_url=BASE_URL)


async def test_health_live_ok_with_no_token_and_no_db(monkeypatch):
    monkeypatch.delenv("SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    async with _client() as client:
        resp = await client.get("/health/live")
    assert resp.status_code == 200
    assert resp.json() == {"status": "live"}


async def test_other_route_refuses_all_when_token_unset(monkeypatch):
    monkeypatch.delenv("SERVICE_TOKEN", raising=False)
    async with _client() as client:
        resp = await client.get("/status")
    assert resp.status_code == 503
    assert resp.json() == {"error": "service token unset — refusing all requests"}


async def test_wrong_bearer_rejected(monkeypatch):
    monkeypatch.setenv("SERVICE_TOKEN", "correct-token")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    async with _client() as client:
        resp = await client.get("/status", headers={"Authorization": "Bearer wrong-token"})
    assert resp.status_code == 401


async def test_right_bearer_reaches_status(monkeypatch):
    monkeypatch.setenv("SERVICE_TOKEN", "correct-token")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    async with _client() as client:
        resp = await client.get("/status", headers={"Authorization": "Bearer correct-token"})
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"service": SERVICE_NAME, "version": "0.0.1", "db_reachable": False}


async def test_status_db_unreachable_returns_false_never_raises(monkeypatch):
    monkeypatch.setenv("SERVICE_TOKEN", "correct-token")
    # Port 1 is privileged/closed — connection refused fast, no 1s wait.
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/db")
    async with _client() as client:
        resp = await client.get("/status", headers={"Authorization": "Bearer correct-token"})
    assert resp.status_code == 200
    assert resp.json()["db_reachable"] is False
