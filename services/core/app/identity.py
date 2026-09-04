"""Who is asking: a session cookie, or the service bearer.

Task 1's `app/auth.py` is the vendored per-link bearer check, byte-identical
in all three services — it is not edited here, only delegated to. Core is
the one service a browser talks to, so it layers session cookies on top: a
request carrying a live cookie IS that person, whatever the bearer link is
configured to; anything else falls through to the bearer, which still
refuses every request when SERVICE_TOKEN is unset.

There is no separate operator-role gate anywhere in this service: every
authenticated person sees every route (Person.role is carried, never
branched on). That is named here rather than silently assumed, so a route
that wants a narrower audience knows there is nothing to lean on yet.
"""
from __future__ import annotations

import hashlib
import logging
import secrets
import uuid
from dataclasses import dataclass

import asyncpg
from fastapi import HTTPException, Request
from starlette.responses import Response

from app import db
from app.auth import bearer_auth_middleware

COOKIE_NAME = "nova_session"
SESSION_TTL_DAYS = 30
SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60

# The four routes that cannot require an identity: the wizard reads state and
# mints one, and a daemon on a machine that has never talked to this instance
# enrolls with a pairing code as its only credential (minted by an
# authenticated operator, shown once, stored hashed, single-use, ten-minute
# TTL — and rate-limited in devices_api). Everything else under /api/v1 needs a
# cookie or a bearer.
PUBLIC_PATHS = frozenset(
    {
        "/api/v1/auth/state",
        "/api/v1/auth/register",
        "/api/v1/auth/login",
        "/api/v1/devices/enroll",
    }
)

logger = logging.getLogger("core")


@dataclass(frozen=True)
class Person:
    id: uuid.UUID
    name: str
    role: str

    def as_json(self) -> dict:
        return {"id": str(self.id), "name": self.name, "role": self.role}


def hash_token(token: str) -> str:
    """Sessions store this, never the cookie value itself."""
    return hashlib.sha256(token.encode()).hexdigest()


async def create_session(pool: asyncpg.Pool, person_id: uuid.UUID) -> str:
    """Mint a session and return the opaque cookie value (stored hashed)."""
    token = secrets.token_urlsafe(32)
    await pool.execute(
        "INSERT INTO sessions (person_id, token_hash, expires_at) "
        "VALUES ($1, $2, now() + make_interval(days => $3))",
        person_id,
        hash_token(token),
        SESSION_TTL_DAYS,
    )
    return token


async def delete_session(pool: asyncpg.Pool, token: str) -> bool:
    """True only when a row actually went away."""
    result = await pool.execute("DELETE FROM sessions WHERE token_hash = $1", hash_token(token))
    return result != "DELETE 0"


def request_is_https(request: Request) -> bool:
    """Did the browser reach us over TLS? Read from the ONE hop that knows.

    Core never terminates TLS and uvicorn is started bare (no --proxy-headers),
    so `request.url.scheme` is always `http` here and says nothing about the
    browser's connection. The web origin's nginx forwards `X-Forwarded-Proto`
    as the scheme the TLS-terminating hop reported (`tailscale serve` or
    cloudflared send `https`; nginx's own `$scheme`, `http`, otherwise — see
    apps/web/nginx.conf.template, "The forwarded scheme"), so that header is
    the single honest source and is read explicitly rather than via a proxy-
    headers middleware that would also rewrite the client address.

    Trusting it is safe in both directions: a client can only influence its
    OWN request's copy (the proxies overwrite it for real visitors; browsers
    never send it), and the only thing a forged `https` buys is a Secure
    cookie on plain http that the liar's own browser then drops. A forged
    `http` cannot strip Secure on a TLS path, because that hop sets `https`.
    """
    return request.headers.get("x-forwarded-proto", "").strip().lower() == "https"


def set_session_cookie(response: Response, token: str, *, secure: bool) -> None:
    """The single place a session cookie is minted; `secure` is derived from
    the request by `request_is_https`, never assumed. Plain http on localhost
    gets no Secure flag (the browser would drop the cookie); a TLS origin gets
    it, so the cookie is never sent in the clear."""
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=secure,
        path="/",
    )


def clear_session_cookie(response: Response, *, secure: bool) -> None:
    """Same attributes as the cookie being cleared: a delete that does not
    match the original's flags is a second cookie, not a removal."""
    response.delete_cookie(COOKIE_NAME, path="/", secure=secure, httponly=True, samesite="lax")


async def person_for_token(pool: asyncpg.Pool, token: str) -> Person | None:
    """Expiry is part of the lookup, so a stale row can never be an identity."""
    row = await pool.fetchrow(
        "SELECT p.id, p.name, p.role FROM sessions s "
        "JOIN people p ON p.id = s.person_id "
        "WHERE s.token_hash = $1 AND s.expires_at > now()",
        hash_token(token),
    )
    return _person(row)


async def owner(pool: asyncpg.Pool) -> Person | None:
    row = await pool.fetchrow(
        "SELECT id, name, role FROM people WHERE role = 'owner' ORDER BY created_at LIMIT 1"
    )
    return _person(row)


def _person(row: asyncpg.Record | None) -> Person | None:
    if row is None:
        return None
    return Person(id=row["id"], name=row["name"], role=row["role"])


async def _cookie_identity(token: str) -> Person | None:
    try:
        return await person_for_token(await db.get_pool(), token)
    except Exception:
        # A database core cannot reach is not an identity — say so and let
        # the bearer path refuse in its own words.
        logger.exception("session lookup failed")
        return None


async def identity_middleware(request: Request, call_next):
    if request.url.path == "/health/live":
        return await call_next(request)

    token = request.cookies.get(COOKIE_NAME)
    if token:
        person = await _cookie_identity(token)
        if person is not None:
            request.state.person = person
            request.state.auth_kind = "session"
            return await call_next(request)

    if request.url.path in PUBLIC_PATHS:
        request.state.auth_kind = "public"
        return await call_next(request)

    # No usable cookie: Task 1's bearer check decides, unchanged — including
    # refuse-all-when-unset.
    request.state.auth_kind = "bearer"
    return await bearer_auth_middleware(request, call_next)


async def require_person(request: Request) -> Person:
    """The person this request acts as; service-bearer calls act as the owner."""
    person = getattr(request.state, "person", None)
    if person is not None:
        return person

    if getattr(request.state, "auth_kind", None) == "bearer":
        person = await owner(await db.get_pool())
        if person is not None:
            request.state.person = person
            return person
        raise HTTPException(
            status_code=401, detail="no owner account exists yet — register one first"
        )

    raise HTTPException(
        status_code=401, detail="no identity — send a session cookie or the service bearer"
    )
