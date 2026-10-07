"""Bearer-auth and health/status contract — identical shape across all
three services."""
from __future__ import annotations

from urllib.parse import unquote

import pytest
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


# Task 32 (L601): /health/live is exempt on the path the ROUTER matches, as
# core's PUBLIC_PATHS are (S42b Task 26 fix round 1, I3) — never on
# request.url.path, which a decoded `?` or `#` cuts short and a decoded tab,
# newline or return vanishes from. Each of these was exempted, then found no
# route (404); none is the canonical path, so the bearer check answers.
async def _raw_status(raw_path: bytes) -> int:
    """One GET straight into the ASGI app with the target as a client sent
    it: the scope's `path` is the percent-decoded target, as uvicorn builds
    it, nothing normalized (httpx would clean the target before it sends)."""
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": unquote(raw_path.decode("ascii")),
        "raw_path": raw_path,
        "root_path": "",
        "query_string": b"",
        "headers": [(b"host", b"test")],
        "client": ("127.0.0.1", 40000),
        "server": ("test", 80),
        "state": {},
    }
    sent: list[dict] = []

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        sent.append(message)

    await app(scope, receive, send)
    return next(m for m in sent if m["type"] == "http.response.start")["status"]


@pytest.mark.parametrize(
    "raw",
    [
        b"/health/live%3Fx",
        b"/health/live%23x",
        b"/health/li%0Ave",
        b"/health/li%09ve",
        b"/health/li%0Dve",
    ],
)
async def test_only_the_canonical_health_path_is_exempt_from_the_bearer(raw, monkeypatch):
    monkeypatch.setenv("SERVICE_TOKEN", "correct-token")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert await _raw_status(raw) == 401, raw
    assert await _raw_status(b"/health/live") == 200
