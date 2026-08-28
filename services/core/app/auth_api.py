"""/api/v1/auth — register the owner, log in, log out, say who you are."""
from __future__ import annotations

import logging
import time

from argon2 import PasswordHasher
from argon2.exceptions import Argon2Error, InvalidHashError
from argon2.low_level import Type
from asyncpg import UniqueViolationError
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app import db, identity
from app.identity import Person

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])
logger = logging.getLogger("core")

MAX_LOGIN_FAILURES = 5
LOGIN_WINDOW_SECONDS = 15 * 60

_hasher = PasswordHasher(type=Type.ID)  # argon2id
# Per-name failure timestamps. In-memory is deliberate for S1: one process,
# one household; a restart clearing the window is acceptable.
_LOGIN_FAILURES: dict[str, list[float]] = {}


class Credentials(BaseModel):
    name: str = Field(min_length=1)
    password: str = Field(min_length=1)


def _recent_failures(name: str) -> list[float]:
    cutoff = time.monotonic() - LOGIN_WINDOW_SECONDS
    recent = [t for t in _LOGIN_FAILURES.get(name, []) if t > cutoff]
    if recent:
        _LOGIN_FAILURES[name] = recent
    else:
        _LOGIN_FAILURES.pop(name, None)
    return recent


def _record_failure(name: str) -> None:
    _LOGIN_FAILURES.setdefault(name, []).append(time.monotonic())


def _password_matches(stored_hash: str | None, password: str) -> bool:
    if not stored_hash:
        return False
    try:
        return _hasher.verify(stored_hash, password)
    except (Argon2Error, InvalidHashError):
        # Mismatch, or a hash this build cannot read — either way, not a login.
        return False


async def _sign_in(person: Person, body: dict) -> JSONResponse:
    token = await identity.create_session(await db.get_pool(), person.id)
    response = JSONResponse(body)
    identity.set_session_cookie(response, token)
    return response


@router.get("/state")
async def auth_state() -> dict:
    """Unauthenticated on purpose — the wizard asks before anyone exists."""
    pool = await db.get_pool()
    return {"has_users": bool(await pool.fetchval("SELECT EXISTS (SELECT 1 FROM people)"))}


@router.post("/register")
async def register(body: Credentials) -> JSONResponse:
    pool = await db.get_pool()
    closed = HTTPException(
        status_code=403, detail="registration is closed — this instance already has an owner"
    )
    if await pool.fetchval("SELECT EXISTS (SELECT 1 FROM people)"):
        raise closed
    try:
        row = await pool.fetchrow(
            "INSERT INTO people (name, role, password_hash) VALUES ($1, 'owner', $2) "
            "RETURNING id, name, role",
            body.name,
            _hasher.hash(body.password),
        )
    except UniqueViolationError as exc:
        # Two registrations raced; the one-owner index picked the winner.
        raise closed from exc
    person = Person(id=row["id"], name=row["name"], role=row["role"])
    logger.info("owner account created: %s", person.name)
    return await _sign_in(person, {"person": person.as_json()})


@router.post("/login")
async def login(body: Credentials) -> JSONResponse:
    if len(_recent_failures(body.name)) >= MAX_LOGIN_FAILURES:
        raise HTTPException(
            status_code=429,
            detail="too many failed logins for that name — try again in 15 minutes",
        )

    pool = await db.get_pool()
    row = await pool.fetchrow(
        "SELECT id, name, role, password_hash FROM people WHERE name = $1", body.name
    )
    if row is None or not _password_matches(row["password_hash"], body.password):
        _record_failure(body.name)
        # One message for both cases: a wrong name and a wrong password are
        # indistinguishable from outside.
        raise HTTPException(status_code=401, detail="wrong name or password")

    _LOGIN_FAILURES.pop(body.name, None)
    person = Person(id=row["id"], name=row["name"], role=row["role"])
    return await _sign_in(person, {"person": person.as_json()})


@router.post("/logout")
async def logout(request: Request) -> JSONResponse:
    token = request.cookies.get(identity.COOKIE_NAME)
    deleted = await identity.delete_session(await db.get_pool(), token) if token else False
    response = JSONResponse({"logged_out": deleted})
    identity.clear_session_cookie(response)
    return response


@router.get("/me")
async def me(person: Person = Depends(identity.require_person)) -> dict:
    return {"person": person.as_json()}
