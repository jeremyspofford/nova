"""The session cookie's Secure flag is derived from the forwarded scheme.

Core never terminates TLS: the web origin's nginx does not either, and the hop
that does (`tailscale serve`, cloudflared) tells nginx the browser's scheme in
X-Forwarded-Proto, which nginx forwards as-is (apps/web/nginx.conf.template,
"The forwarded scheme"). `identity.request_is_https` reads that one header —
never `request.url.scheme`, which is always `http` on a bare uvicorn — and
the single cookie choke point (`set_session_cookie`, one caller in auth_api)
sets Secure from it. A Secure cookie on plain-http localhost would be dropped
by the browser; a non-Secure cookie on a TLS origin would be sent in the
clear. Both directions are asserted here, through the real routes.

The nginx half (that the header actually reaches core as the TLS hop sent
it, and that a bare `$scheme` never overwrites `https`) is pinned by
apps/web/gate_test.sh against a real upstream stub.
"""
from __future__ import annotations

from app import identity
from tests.conftest import OWNER, requires_db

pytestmark = requires_db

LOGIN = "/api/v1/auth/login"
REGISTER = "/api/v1/auth/register"
LOGOUT = "/api/v1/auth/logout"


async def _register(client) -> None:
    resp = await client.post(REGISTER, json=OWNER)
    assert resp.status_code == 200, resp.text


def _flags(resp) -> str:
    raw = resp.headers["set-cookie"]
    assert raw.startswith(f"{identity.COOKIE_NAME}="), raw
    return raw.lower()


async def test_login_behind_tls_mints_a_secure_cookie(client):
    await _register(client)
    client.cookies.clear()

    resp = await client.post(LOGIN, json=OWNER, headers={"X-Forwarded-Proto": "https"})
    assert resp.status_code == 200, resp.text
    flags = _flags(resp)
    assert "secure" in flags
    # The hardening that does not depend on the scheme is unchanged.
    assert "httponly" in flags
    assert "samesite=lax" in flags


async def test_login_with_no_forwarded_scheme_is_not_secure(client):
    """Plain http on localhost: no proxy hop said https, so no Secure — the
    browser would refuse to store it otherwise."""
    await _register(client)
    client.cookies.clear()

    resp = await client.post(LOGIN, json=OWNER)
    assert resp.status_code == 200, resp.text
    assert "secure" not in _flags(resp)


async def test_login_with_forwarded_http_is_not_secure(client):
    await _register(client)
    client.cookies.clear()

    resp = await client.post(LOGIN, json=OWNER, headers={"X-Forwarded-Proto": "http"})
    assert resp.status_code == 200, resp.text
    assert "secure" not in _flags(resp)


async def test_forwarded_scheme_is_matched_case_insensitively_and_trimmed(client):
    """Derived from the header's meaning, not its spelling: a proxy that
    sends `HTTPS` or a padded value still described a TLS connection."""
    await _register(client)
    client.cookies.clear()

    resp = await client.post(LOGIN, json=OWNER, headers={"X-Forwarded-Proto": " HTTPS "})
    assert resp.status_code == 200, resp.text
    assert "secure" in _flags(resp)


async def test_register_is_the_other_caller_and_derives_the_same_way(client):
    """Registration signs the new owner in through the same choke point."""
    resp = await client.post(REGISTER, json=OWNER, headers={"X-Forwarded-Proto": "https"})
    assert resp.status_code == 200, resp.text
    assert "secure" in _flags(resp)


async def test_logout_clears_with_the_same_flag_it_was_set_with(owner_client):
    """A delete-cookie that lacks the original's Secure flag is a different
    cookie in the browser's eyes; the clear must carry the same attributes."""
    resp = await owner_client.post(LOGOUT, headers={"X-Forwarded-Proto": "https"})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"logged_out": True}
    flags = _flags(resp)
    assert "secure" in flags
    assert "httponly" in flags
    assert "max-age=0" in flags or "expires=" in flags


async def test_logout_on_plain_http_clears_without_secure(owner_client):
    resp = await owner_client.post(LOGOUT)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"logged_out": True}
    assert "secure" not in _flags(resp)


def test_request_is_https_reads_only_the_forwarded_header():
    """Unit pin on the derivation itself: the header decides, the URL scheme
    (always http on a bare uvicorn) is never consulted."""
    from starlette.requests import Request

    def req(headers: dict[str, str], scheme: str = "http") -> Request:
        raw = [(k.lower().encode(), v.encode()) for k, v in headers.items()]
        return Request({"type": "http", "method": "GET", "path": "/", "headers": raw,
                        "scheme": scheme, "query_string": b""})

    assert identity.request_is_https(req({"X-Forwarded-Proto": "https"})) is True
    assert identity.request_is_https(req({"X-Forwarded-Proto": "http"})) is False
    assert identity.request_is_https(req({})) is False
    # A TLS url scheme with no forwarded header is NOT believed — there is no
    # TLS here, so a scheme that says otherwise is a misconfiguration, not a
    # fact about the browser.
    assert identity.request_is_https(req({}, scheme="https")) is False
    # A comma list from a stacked proxy is not `https` — nginx overwrites the
    # header rather than appending, so this shape never reaches core; if it
    # ever did, refusing Secure is the conservative side.
    assert identity.request_is_https(req({"X-Forwarded-Proto": "https, http"})) is False
