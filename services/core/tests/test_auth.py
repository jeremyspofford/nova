"""Owner registration, sessions, and the two ways to be somebody here:
a session cookie (the browser) or the service bearer (ops/service calls).
"""

from __future__ import annotations

from httpx import ASGITransport, AsyncClient

from app import auth_api, identity
from app.main import app
from tests.conftest import BASE_URL, OWNER, SERVICE_TOKEN, requires_db

pytestmark = requires_db


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


async def test_expired_failures_fall_out_of_the_window(client):
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
    resp = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {SERVICE_TOKEN}"})
    assert resp.status_code == 200
    assert resp.json()["person"]["role"] == "owner"


async def test_the_service_bearer_has_no_identity_before_the_owner_exists(client):
    resp = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {SERVICE_TOKEN}"})
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


# ── renaming yourself (2026-09-16) ───────────────────────────────────────
#
# The account card said "Name and role are read-only in S1: core has no
# route that changes either, and a field that silently does nothing is worse
# than no field." This is that route, and it exists for a reason the UI ran
# into: `people.name` is whatever was typed at registration, and on the
# owner's instance that is an email. The sidebar can derive "Jeremy" from
# `jeremy.spofford@…` and can derive NOTHING from `jeremyspofford@…`, so the
# only honest way to show somebody their own first name is to let them say
# what it is.


async def test_a_person_can_say_what_they_are_called(owner_client, pool):
    resp = await owner_client.patch("/api/v1/auth/me", json={"name": "Jeremy"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["person"]["name"] == "Jeremy"

    # Read back, because a route that returns a name it did not write is the
    # defect this repo keeps finding.
    again = await owner_client.get("/api/v1/auth/me")
    assert again.json()["person"]["name"] == "Jeremy"
    assert await pool.fetchval("SELECT name FROM people WHERE name = 'Jeremy'") == "Jeremy"


async def test_the_role_is_not_renamable_by_the_same_route(owner_client):
    """A person promoting themselves is a different question entirely, and
    this route must not be a way to ask it."""
    before = (await owner_client.get("/api/v1/auth/me")).json()["person"]["role"]
    await owner_client.patch("/api/v1/auth/me", json={"name": "Jeremy", "role": "owner"})
    after = (await owner_client.get("/api/v1/auth/me")).json()["person"]["role"]
    assert after == before


async def test_an_empty_name_is_refused_with_a_reason(owner_client):
    # An account with a blank name cannot be logged into: the name IS the
    # login identifier.
    assert (await owner_client.patch("/api/v1/auth/me", json={"name": "   "})).status_code == 400
    assert (await owner_client.patch("/api/v1/auth/me", json={"name": ""})).status_code == 422


async def test_a_name_somebody_else_holds_is_a_stated_conflict(owner_client, pool):
    """The name is the login identifier, so it stays unique — and the index
    is what refuses, reported as a conflict rather than a 500."""
    await pool.execute("INSERT INTO people (name, role) VALUES ('taken', 'guest')")
    resp = await owner_client.patch("/api/v1/auth/me", json={"name": "taken"})
    assert resp.status_code == 409
    # Every refusal in this service has the same shape — {"error": reason},
    # not FastAPI's default {"detail": …}. See main.stated_error.
    assert "taken" in resp.json()["error"]


async def test_a_signed_out_browser_cannot_rename_anybody(client):
    assert (await client.patch("/api/v1/auth/me", json={"name": "whoever"})).status_code == 401
