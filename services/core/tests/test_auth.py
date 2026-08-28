"""Owner registration, sessions, and the two ways to be somebody here:
a session cookie (the browser) or the service bearer (ops/service calls).
"""
from __future__ import annotations

from httpx import ASGITransport, AsyncClient

from app import auth_api, identity
from app.main import app
from tests.conftest import BASE_URL, SERVICE_TOKEN, requires_db

pytestmark = requires_db

OWNER = {"name": "jeremy", "password": "correct horse battery staple"}


async def _register(client) -> None:
    resp = await client.post("/api/v1/auth/register", json=OWNER)
    assert resp.status_code == 200, resp.text


async def test_auth_state_is_unauthenticated_and_flips_when_the_owner_exists(client):
    resp = await client.get("/api/v1/auth/state")
    assert resp.status_code == 200
    assert resp.json() == {"has_users": False}

    await _register(client)

    resp = await client.get("/api/v1/auth/state")
    assert resp.json() == {"has_users": True}


async def test_register_creates_the_owner_and_logs_it_in(client, pool):
    resp = await client.post("/api/v1/auth/register", json=OWNER)
    assert resp.status_code == 200
    person = resp.json()["person"]
    assert person["name"] == "jeremy"
    assert person["role"] == "owner"

    # The response set a session cookie, so /me works with no other credential.
    me = await client.get("/api/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["person"]["id"] == person["id"]

    stored = await pool.fetchval("SELECT password_hash FROM people WHERE name = 'jeremy'")
    assert stored.startswith("$argon2id$")
    assert OWNER["password"] not in stored


async def test_register_is_refused_once_a_person_exists(client):
    await _register(client)
    resp = await client.post(
        "/api/v1/auth/register", json={"name": "someone-else", "password": "hunter22222"}
    )
    assert resp.status_code == 403
    assert "error" in resp.json()


async def test_login_sets_a_hardened_session_cookie(client, pool):
    await _register(client)
    client.cookies.clear()

    resp = await client.post("/api/v1/auth/login", json=OWNER)
    assert resp.status_code == 200
    raw = resp.headers["set-cookie"]
    assert raw.startswith("nova_session=")
    assert "httponly" in raw.lower()
    assert "samesite=lax" in raw.lower()
    assert "secure" not in raw.lower()  # localhost is plain HTTP in S1

    # Only the hash is stored — the cookie value never lands in the table.
    cookie_value = client.cookies["nova_session"]
    stored = {row["token_hash"] for row in await pool.fetch("SELECT token_hash FROM sessions")}
    assert cookie_value not in stored
    assert identity.hash_token(cookie_value) in stored


async def test_login_with_a_bad_password_is_401(client):
    await _register(client)
    resp = await client.post(
        "/api/v1/auth/login", json={"name": "jeremy", "password": "not the password"}
    )
    assert resp.status_code == 401


async def test_login_with_an_unknown_name_is_401(client):
    await _register(client)
    resp = await client.post("/api/v1/auth/login", json={"name": "nobody", "password": "whatever"})
    assert resp.status_code == 401


async def test_five_failed_logins_per_name_then_429(client):
    await _register(client)
    bad = {"name": "jeremy", "password": "wrong"}
    for _ in range(5):
        assert (await client.post("/api/v1/auth/login", json=bad)).status_code == 401

    assert (await client.post("/api/v1/auth/login", json=bad)).status_code == 429
    # The lockout is per name, and it holds even for the RIGHT password.
    assert (await client.post("/api/v1/auth/login", json=OWNER)).status_code == 429


async def test_the_rate_limit_window_is_per_name(client):
    await _register(client)
    for _ in range(5):
        await client.post("/api/v1/auth/login", json={"name": "jeremy", "password": "wrong"})
    resp = await client.post("/api/v1/auth/login", json={"name": "other", "password": "wrong"})
    assert resp.status_code == 401


async def test_expired_failures_fall_out_of_the_window(client, monkeypatch):
    await _register(client)
    bad = {"name": "jeremy", "password": "wrong"}
    for _ in range(5):
        await client.post("/api/v1/auth/login", json=bad)

    # Age every recorded failure past the window.
    aged = {
        name: [t - auth_api.LOGIN_WINDOW_SECONDS - 1 for t in times]
        for name, times in auth_api._LOGIN_FAILURES.items()
    }
    auth_api._LOGIN_FAILURES.clear()
    auth_api._LOGIN_FAILURES.update(aged)

    assert (await client.post("/api/v1/auth/login", json=OWNER)).status_code == 200


async def test_logout_invalidates_the_session(client):
    await _register(client)
    stale = client.cookies["nova_session"]

    resp = await client.post("/api/v1/auth/logout")
    assert resp.status_code == 200
    assert resp.json()["logged_out"] is True

    client.cookies.set("nova_session", stale)
    me = await client.get("/api/v1/auth/me")
    assert me.status_code == 401


async def test_an_expired_session_is_not_an_identity(client, pool):
    await _register(client)
    await pool.execute("UPDATE sessions SET expires_at = now() - interval '1 second'")
    me = await client.get("/api/v1/auth/me")
    assert me.status_code == 401


async def test_settings_without_any_credential_is_401(client):
    await _register(client)
    client.cookies.clear()
    resp = await client.get("/api/v1/settings")
    assert resp.status_code == 401


async def test_the_service_bearer_reports_the_owner(client):
    await _register(client)
    client.cookies.clear()
    resp = await client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {SERVICE_TOKEN}"}
    )
    assert resp.status_code == 200
    assert resp.json()["person"]["role"] == "owner"


async def test_the_service_bearer_has_no_identity_before_the_owner_exists(client):
    resp = await client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {SERVICE_TOKEN}"}
    )
    assert resp.status_code == 401


async def test_cookie_auth_works_with_service_token_unset(pool, monkeypatch):
    """The bearer link being unconfigured must not lock out the browser."""
    monkeypatch.setenv("SERVICE_TOKEN", SERVICE_TOKEN)
    auth_api._LOGIN_FAILURES.clear()
    async with AsyncClient(transport=ASGITransport(app=app), base_url=BASE_URL) as client:
        await _register(client)

        monkeypatch.delenv("SERVICE_TOKEN", raising=False)
        me = await client.get("/api/v1/auth/me")
        assert me.status_code == 200
        assert me.json()["person"]["name"] == "jeremy"

        # No cookie and no bearer still refuses, per Task 1's rail.
        client.cookies.clear()
        assert (await client.get("/api/v1/settings")).status_code == 503
