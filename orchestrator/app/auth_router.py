"""Auth + conversation endpoints for user authentication and chat persistence."""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time as _time
from uuid import UUID

import bcrypt
from app.auth import UserDep
from app.config import settings
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter(tags=["auth"])


# ── Request/Response models ──────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: str
    password: str
    display_name: str | None = None
    invite_code: str | None = None

class LoginRequest(BaseModel):
    email: str
    password: str

class RefreshRequest(BaseModel):
    refresh_token: str

class LogoutRequest(BaseModel):
    refresh_token: str

class UpdateProfileRequest(BaseModel):
    display_name: str | None = None
    avatar_url: str | None = None

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class AuthResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int = 900  # 15 min
    user: dict

class ConversationCreate(BaseModel):
    title: str | None = None

class ConversationUpdate(BaseModel):
    title: str | None = None
    is_archived: bool | None = None

class MessageImport(BaseModel):
    messages: list[dict]

class InviteCreate(BaseModel):
    email: str | None = None
    # None/0 = the link never expires. The UI always sends this explicitly —
    # a silent 72h default here turned the "Never" option into 3 days.
    expires_in_hours: int | None = None
    role: str = "member"
    account_expires_in_hours: int | None = None

# Load-bearing identities, not accounts — see app.users.SYSTEM_USER_EMAILS
# (excluded from counts/listings there; PATCH/DELETE refused here).
from app.users import SYSTEM_USER_EMAILS


class AdminUpdateUser(BaseModel):
    role: str | None = None
    status: str | None = None  # 'active' | 'deactivated'
    expires_at: str | None = None  # ISO datetime; "" clears (never expires)
    display_name: str | None = None
    email: str | None = None


# ── Helpers ──────────────────────────────────────────────────────────────────

def _hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

def _verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


# Constant bcrypt hash of an unguessable value, compared against on the
# user-not-found path so login timing is identical whether or not the email
# exists — otherwise the fast path is an email-enumeration oracle.
_TIMING_EQUALIZER_HASH = bcrypt.hashpw(secrets.token_bytes(32), bcrypt.gensalt()).decode()

# Login brute-force throttle: sliding window per client IP and per target
# email (an attacker rotating emails burns the IP budget; one rotating IPs
# burns the account budget). Same window mechanics as the admin-secret
# throttle in app.auth. Failures only — successful logins never count.
_LOGIN_FAIL_WINDOW_SECONDS = 300
_LOGIN_FAIL_THRESHOLD = 10


async def _login_throttled(ip: str, email: str) -> bool:
    from app.store import get_redis
    window = int(_time.time() / _LOGIN_FAIL_WINDOW_SECONDS)
    try:
        redis = get_redis()
        counts = await asyncio.gather(
            redis.get(f"nova:login-fail:ip:{ip}:{window}"),
            redis.get(f"nova:login-fail:email:{email}:{window}"),
        )
        return any(int(c or 0) >= _LOGIN_FAIL_THRESHOLD for c in counts)
    except Exception:
        return False  # Redis down — never lock out logins on infra failure


async def _record_login_failure(ip: str, email: str) -> None:
    from app.store import get_redis
    window = int(_time.time() / _LOGIN_FAIL_WINDOW_SECONDS)
    try:
        redis = get_redis()
        for key in (f"nova:login-fail:ip:{ip}:{window}", f"nova:login-fail:email:{email}:{window}"):
            count = await redis.incr(key)
            if count == 1:
                await redis.expire(key, _LOGIN_FAIL_WINDOW_SECONDS * 2)
    except Exception:
        pass

def _safe_user(user: dict) -> dict:
    """Strip sensitive fields from user dict before returning to client."""
    return {k: v for k, v in user.items() if k not in ("password_hash",)}


# ── Auth config (public) ────────────────────────────────────────────────────

@router.get("/api/v1/auth/providers")
async def get_auth_providers(request: Request):
    """Public: what auth options are available."""
    from app.oauth import google_enabled
    from app.users import count_users
    user_count = await count_users()
    return {
        "google": google_enabled(),
        "registration_mode": settings.registration_mode,
        "has_users": user_count > 0,
        "trusted_network": getattr(request.state, "is_trusted_network", False),
    }


@router.get("/api/v1/auth/network-status")
async def get_network_status(request: Request):
    """Public: show the client's IP and whether it's on a trusted network."""
    return {
        "client_ip": getattr(request.state, "client_ip", request.client.host if request.client else "unknown"),
        "trusted": getattr(request.state, "is_trusted_network", False),
    }


# ── Registration ─────────────────────────────────────────────────────────────

@router.post("/api/v1/auth/register", response_model=AuthResponse)
async def register(req: RegisterRequest, request: Request):
    from app.jwt_auth import create_access_token, create_refresh_token
    from app.users import count_users, create_user, get_user_by_email

    # First-boot exemption: the FIRST account is the instance owner creating
    # their own instance — there is nobody to invite them and no admin to ask.
    # Without this, an invite-mode instance can never create its first account
    # through the UI (bootstrap paradox). All later registrations go through
    # the configured mode as usual.
    is_first_user = (await count_users()) == 0

    # Check registration mode
    if settings.registration_mode == "admin" and not is_first_user:
        raise HTTPException(status_code=403, detail="Registration is disabled. Ask an admin to create your account.")

    invite = None
    if settings.registration_mode == "invite" and not is_first_user:
        if not req.invite_code:
            raise HTTPException(status_code=400, detail="Invite code required")
        # Validate invite code
        from app.db import get_pool
        pool = get_pool()
        async with pool.acquire() as conn:
            invite = await conn.fetchrow(
                "SELECT id, email, used_by, role, account_expires_in_hours, tenant_id FROM invite_codes "
                "WHERE code = $1 AND used_by IS NULL AND (expires_at IS NULL OR expires_at > NOW())",
                req.invite_code,
            )
        if not invite:
            raise HTTPException(status_code=400, detail="Invalid or expired invite code")
        if invite["email"] and invite["email"].lower() != req.email.lower():
            raise HTTPException(status_code=400, detail="This invite is for a different email address")

    # Check if email is taken
    existing = await get_user_by_email(req.email.lower())
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    if not req.password or len(req.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    # Determine role and expiry from invite
    invite_role = "member"
    invite_tenant_id = "00000000-0000-0000-0000-000000000001"
    account_expires_at = None
    if settings.registration_mode == "invite" and invite:
        invite_role = invite.get("role", "member")
        invite_tenant_id = str(invite.get("tenant_id", "00000000-0000-0000-0000-000000000001"))
        if invite.get("account_expires_in_hours"):
            from datetime import datetime, timedelta, timezone
            account_expires_at = datetime.now(timezone.utc) + timedelta(hours=invite["account_expires_in_hours"])

    # First user is always owner
    if is_first_user:
        invite_role = "owner"
        is_admin = True
    else:
        is_admin = invite_role in ("owner", "admin")

    password_hash = _hash_password(req.password)
    user = await create_user(
        email=req.email.lower(),
        password_hash=password_hash,
        display_name=req.display_name or req.email.split("@")[0],
        is_admin=is_admin,
        role=invite_role,
        tenant_id=invite_tenant_id,
        expires_at=account_expires_at,
    )

    # Mark invite as used
    if settings.registration_mode == "invite" and req.invite_code:
        from app.db import get_pool
        pool = get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE invite_codes SET used_by = $1, used_at = NOW() WHERE code = $2",
                UUID(user["id"]), req.invite_code,
            )
        # Audit invite acceptance
        from app.audit import audit_rbac
        ip = request.client.host if request.client else None
        asyncio.create_task(audit_rbac(
            pool, user["id"], "invite_accepted",
            target_id=str(invite["id"]) if invite else None,
            details={"invite_id": str(invite["id"]) if invite else None, "role": invite_role},
            ip=ip, tenant_id=invite_tenant_id,
        ))

    access = create_access_token(
        user["id"], user["email"], user["is_admin"],
        role=user.get("role", "member"),
        tenant_id=user.get("tenant_id", "00000000-0000-0000-0000-000000000001"),
    )
    refresh = await create_refresh_token(user["id"])

    return AuthResponse(
        access_token=access,
        refresh_token=refresh,
        user=_safe_user(user),
    )


# ── Login ────────────────────────────────────────────────────────────────────

@router.post("/api/v1/auth/login", response_model=AuthResponse)
async def login(req: LoginRequest, request: Request):
    from app.audit import audit_rbac
    from app.db import get_pool
    from app.jwt_auth import create_access_token, create_refresh_token
    from app.users import get_user_by_email

    pool = get_pool()
    ip = request.client.host if request.client else "unknown"
    email = req.email.lower()

    # Brute-force brake runs BEFORE any credential work.
    if await _login_throttled(ip, email):
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed sign-in attempts. Retry in {_LOGIN_FAIL_WINDOW_SECONDS // 60} minutes.",
        )

    user = await get_user_by_email(email)
    if not user or not user.get("password_hash"):
        # Burn the same bcrypt time as a real check — identical timing
        # whether the email exists or not.
        _verify_password(req.password, _TIMING_EQUALIZER_HASH)
        await _record_login_failure(ip, email)
        asyncio.create_task(audit_rbac(
            pool, None, "login_failed",
            details={"email": email, "reason": "invalid_email"},
            ip=ip,
        ))
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not _verify_password(req.password, user["password_hash"]):
        await _record_login_failure(ip, email)
        asyncio.create_task(audit_rbac(
            pool, user["id"], "login_failed",
            details={"email": email, "reason": "bad_password"},
            ip=ip, tenant_id=user.get("tenant_id"),
        ))
        raise HTTPException(status_code=401, detail="Invalid email or password")

    access = create_access_token(
        user["id"], user["email"], user["is_admin"],
        role=user.get("role", "member"),
        tenant_id=str(user.get("tenant_id", "00000000-0000-0000-0000-000000000001")),
    )
    refresh = await create_refresh_token(user["id"])

    asyncio.create_task(audit_rbac(
        pool, user["id"], "login_success",
        details={"email": user["email"], "provider": "local"},
        ip=ip, tenant_id=user.get("tenant_id"),
    ))

    return AuthResponse(
        access_token=access,
        refresh_token=refresh,
        user=_safe_user(user),
    )


# ── Token refresh ────────────────────────────────────────────────────────────

@router.post("/api/v1/auth/refresh", response_model=AuthResponse)
async def refresh_tokens(req: RefreshRequest):
    from app.jwt_auth import rotate_refresh_token

    result = await rotate_refresh_token(req.refresh_token)
    if not result:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    access, refresh, user = result
    return AuthResponse(
        access_token=access,
        refresh_token=refresh,
        user=_safe_user(user),
    )


# ── Logout ───────────────────────────────────────────────────────────────────

@router.post("/api/v1/auth/logout", status_code=204)
async def logout(req: LogoutRequest, request: Request, user: UserDep):
    from app.audit import audit_rbac
    from app.db import get_pool
    from app.jwt_auth import revoke_refresh_token

    await revoke_refresh_token(req.refresh_token)

    pool = get_pool()
    ip = request.client.host if request.client else None
    asyncio.create_task(audit_rbac(
        pool, user.id, "logout", ip=ip, tenant_id=user.tenant_id,
    ))


# ── Profile ──────────────────────────────────────────────────────────────────

@router.get("/api/v1/auth/me")
async def get_me(user: UserDep):
    from app.users import get_user_by_id
    full_user = await get_user_by_id(user.id)
    if not full_user:
        raise HTTPException(status_code=404, detail="User not found")
    return _safe_user(full_user)


@router.patch("/api/v1/auth/me")
async def update_me(req: UpdateProfileRequest, user: UserDep):
    from app.users import update_user
    updated = await update_user(user.id, display_name=req.display_name, avatar_url=req.avatar_url)
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")
    return _safe_user(updated)


@router.patch("/api/v1/auth/password", status_code=204)
async def change_password(req: ChangePasswordRequest, user: UserDep, request: Request):
    """Change the authenticated user's password."""
    from app.audit import audit_rbac
    from app.auth import deny_user_token
    from app.db import get_pool
    from app.users import get_user_by_id

    full_user = await get_user_by_id(user.id)
    if not full_user or not full_user.get("password_hash"):
        raise HTTPException(status_code=400, detail="Cannot change password for OAuth-only accounts")

    if not _verify_password(req.current_password, full_user["password_hash"]):
        raise HTTPException(status_code=401, detail="Current password is incorrect")

    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")

    new_hash = _hash_password(req.new_password)
    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
            new_hash, UUID(user.id),
        )

    # Deny current tokens so all sessions must re-authenticate
    await deny_user_token(user.id, reason="password_changed")

    ip = request.client.host if request.client else None
    asyncio.create_task(audit_rbac(
        pool, user.id, "password_changed", ip=ip, tenant_id=user.tenant_id,
    ))


# ── Google OAuth ─────────────────────────────────────────────────────────────

@router.get("/api/v1/auth/google")
async def google_auth(request: Request):
    """Generate a fresh OAuth state token, store it in Redis with the
    server-computed redirect_uri, and return both to the client. State
    must round-trip through the OAuth flow back to /callback so we can
    validate it (CSRF protection)."""
    import secrets

    from app.oauth import get_google_auth_url, google_enabled
    from app.store import get_redis
    if not google_enabled():
        raise HTTPException(status_code=404, detail="Google OAuth not configured")

    state = secrets.token_urlsafe(32)
    redirect_uri = str(request.url_for("google_callback"))

    # Store state -> redirect_uri with a 10-minute TTL. The callback validates
    # the state via GETDEL (single-use) and uses the *stored* redirect_uri,
    # not whatever the client sends back. This closes both the CSRF and
    # redirect_uri-tampering vectors simultaneously.
    redis = get_redis()
    await redis.set(f"nova:oauth:state:{state}", redirect_uri, ex=600)

    return {"url": get_google_auth_url(redirect_uri, state), "state": state}


@router.post("/api/v1/auth/google/callback", name="google_callback")
async def google_callback(request: Request):
    from app.jwt_auth import create_access_token, create_refresh_token
    from app.oauth import exchange_google_code, google_enabled
    from app.store import get_redis
    from app.users import (
        count_users,
        create_user,
        get_user_by_email,
        get_user_by_provider,
    )

    if not google_enabled():
        raise HTTPException(status_code=404, detail="Google OAuth not configured")

    body = await request.json()
    code = body.get("code")
    if not code:
        raise HTTPException(status_code=400, detail="Missing authorization code")

    # FC-003: validate state (CSRF protection) and use the server-stored
    # redirect_uri. We never trust a client-supplied redirect_uri because that
    # would let an attacker tamper with the OAuth grant target.
    state = body.get("state")
    if not state:
        raise HTTPException(status_code=400, detail="Missing state parameter")
    redis = get_redis()
    stored = await redis.getdel(f"nova:oauth:state:{state}")
    if not stored:
        raise HTTPException(status_code=400, detail="Invalid or expired state token")
    redirect_uri = stored.decode() if isinstance(stored, bytes) else stored

    google_user = await exchange_google_code(code, redirect_uri)

    email = google_user.get("email", "").lower()
    sub = google_user.get("sub")
    if not email or not sub:
        raise HTTPException(status_code=400, detail="Could not retrieve email from Google")

    # Check if user exists by provider ID or email
    user = await get_user_by_provider("google", sub)
    if not user:
        user = await get_user_by_email(email)

    if not user:
        # New user registration via Google
        if settings.registration_mode == "admin":
            raise HTTPException(status_code=403, detail="Registration is disabled")

        user_count = await count_users()
        is_admin = user_count == 0

        user = await create_user(
            email=email,
            display_name=google_user.get("name", email.split("@")[0]),
            provider="google",
            provider_id=sub,
            is_admin=is_admin,
        )

    access = create_access_token(
        user["id"], user["email"], user["is_admin"],
        role=user.get("role", "member"),
        tenant_id=str(user.get("tenant_id", "00000000-0000-0000-0000-000000000001")),
    )
    refresh = await create_refresh_token(user["id"])

    return AuthResponse(
        access_token=access,
        refresh_token=refresh,
        user=_safe_user(user),
    )


# ── Invite codes (admin-only) ───────────────────────────────────────────────

@router.post("/api/v1/auth/invites")
async def create_invite(req: InviteCreate, user: UserDep):
    from app.roles import VALID_ROLES, can_assign_role, has_min_role
    if not has_min_role(user.role, "admin"):
        raise HTTPException(status_code=403, detail="Requires admin role")
    if req.role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of: {', '.join(sorted(VALID_ROLES))}")
    if not can_assign_role(user.role, req.role):
        raise HTTPException(status_code=403, detail=f"Cannot assign role higher than your own ({user.role})")

    from app.db import get_pool
    code = secrets.token_urlsafe(8)
    pool = get_pool()
    async with pool.acquire() as conn:
        from datetime import datetime, timedelta, timezone
        expires = None
        if req.expires_in_hours:
            expires = datetime.now(timezone.utc) + timedelta(hours=req.expires_in_hours)
        row = await conn.fetchrow(
            """INSERT INTO invite_codes (code, created_by, email, expires_at, role, account_expires_in_hours, tenant_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               RETURNING id, code, email, expires_at, role, account_expires_in_hours, created_at""",
            code, UUID(user.id), req.email, expires, req.role, req.account_expires_in_hours, UUID(user.tenant_id),
        )
        await conn.execute(
            """INSERT INTO rbac_audit_log (actor_id, action, target_id, details, tenant_id)
               VALUES ($1, 'invite_created', $2, $3, $4)""",
            UUID(user.id), row["id"],
            json.dumps({"role": req.role, "email": req.email}),
            UUID(user.tenant_id),
        )
    return dict(row)


@router.get("/api/v1/auth/invites")
async def list_invites(user: UserDep):
    from app.roles import has_min_role
    if not has_min_role(user.role, "admin"):
        raise HTTPException(status_code=403, detail="Requires admin role")

    from app.db import get_pool
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, code, email, used_by, used_at, expires_at, role, account_expires_in_hours, created_at "
            "FROM invite_codes WHERE used_by IS NULL AND (expires_at IS NULL OR expires_at > NOW()) "
            "ORDER BY created_at DESC"
        )
    return [dict(r) for r in rows]


@router.get("/api/v1/auth/invites/validate/{code}")
async def validate_invite(code: str):
    """Public endpoint: validate an invite code and return its metadata."""
    from app.db import get_pool
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT ic.id, ic.role, ic.expires_at, ic.account_expires_in_hours,
                      ic.created_at, ic.used_by,
                      u.display_name AS created_by_name
               FROM invite_codes ic
               LEFT JOIN users u ON u.id = ic.created_by
               WHERE ic.code = $1""",
            code,
        )

    if not row or row["used_by"] is not None:
        return {"valid": False}

    # Check expiry
    from datetime import datetime, timezone
    if row["expires_at"] and row["expires_at"] < datetime.now(timezone.utc):
        return {"valid": False}

    return {
        "valid": True,
        "role": row["role"],
        "created_by_name": row["created_by_name"] or "An admin",
        "expires_at": row["expires_at"].isoformat() if row["expires_at"] else None,
        "account_expires_in_hours": row["account_expires_in_hours"],
    }


@router.delete("/api/v1/auth/invites/{invite_id}", status_code=204)
async def revoke_invite(invite_id: UUID, user: UserDep, request: Request):
    from app.roles import has_min_role
    if not has_min_role(user.role, "admin"):
        raise HTTPException(status_code=403, detail="Requires admin role")

    from app.audit import audit_rbac
    from app.db import get_pool
    pool = get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM invite_codes WHERE id = $1 AND used_by IS NULL",
            invite_id,
        )
    if result != "DELETE 1":
        raise HTTPException(status_code=404, detail="Invite not found or already used")

    ip = request.client.host if request.client else None
    asyncio.create_task(audit_rbac(
        pool, user.id, "invite_revoked",
        target_id=invite_id,
        details={"invite_id": str(invite_id)},
        ip=ip, tenant_id=user.tenant_id,
    ))


# ── Admin user management ────────────────────────────────────────────────────

class AdminCreateUser(BaseModel):
    email: str
    display_name: str | None = None
    is_admin: bool = False
    role: str = "member"

@router.post("/api/v1/admin/users")
async def admin_create_user(req: AdminCreateUser, user: UserDep):
    from app.roles import VALID_ROLES, can_assign_role, has_min_role
    if not has_min_role(user.role, "admin"):
        raise HTTPException(status_code=403, detail="Requires admin role")
    if req.role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of: {', '.join(sorted(VALID_ROLES))}")
    if not can_assign_role(user.role, req.role):
        raise HTTPException(status_code=403, detail=f"Cannot assign role higher than your own ({user.role})")

    from app.users import create_user, get_user_by_email

    existing = await get_user_by_email(req.email.lower())
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    temp_password = secrets.token_urlsafe(12)
    password_hash = _hash_password(temp_password)

    new_user = await create_user(
        email=req.email.lower(),
        password_hash=password_hash,
        display_name=req.display_name or req.email.split("@")[0],
        is_admin=req.is_admin or req.role in ("owner", "admin"),
        role=req.role,
        tenant_id=str(user.tenant_id),
    )

    return {**_safe_user(new_user), "temporary_password": temp_password}


@router.get("/api/v1/admin/users")
async def list_all_users(user: UserDep):
    """List all users. Requires admin role."""
    from app.roles import has_min_role
    if not has_min_role(user.role, "admin"):
        raise HTTPException(status_code=403, detail="Requires admin role")
    from app.users import list_users
    users = await list_users(user.tenant_id)
    return [_safe_user(u) for u in users]


@router.patch("/api/v1/admin/users/{user_id}")
async def update_user_admin(user_id: str, body: AdminUpdateUser, user: UserDep):
    """Update user role, status, or expiry. Requires admin role."""
    from app.roles import can_assign_role, has_min_role, parse_role
    if not has_min_role(user.role, "admin"):
        raise HTTPException(status_code=403, detail="Requires admin role")

    from app.users import get_user_by_id, update_user_role
    target = await get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    if target["email"] in SYSTEM_USER_EMAILS:
        raise HTTPException(status_code=403, detail="System identity — managed by Nova, not editable")

    # Can't modify users with equal or higher role (unless self)
    if parse_role(target["role"]) >= parse_role(user.role) and user.id != user_id:
        raise HTTPException(status_code=403, detail="Cannot modify user with equal or higher role")

    from app.db import get_pool
    pool = get_pool()

    if body.display_name is not None:
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE users SET display_name = $1, updated_at = NOW() WHERE id = $2",
                body.display_name.strip() or None, UUID(user_id),
            )

    if body.email is not None:
        new_email = body.email.strip().lower()
        if not new_email or "@" not in new_email:
            raise HTTPException(status_code=400, detail="Invalid email address")
        from app.users import get_user_by_email
        existing = await get_user_by_email(new_email)
        if existing and str(existing["id"]) != user_id:
            raise HTTPException(status_code=409, detail="Email already in use")
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2",
                new_email, UUID(user_id),
            )

    if body.role is not None:
        from app.roles import VALID_ROLES
        if body.role not in VALID_ROLES:
            raise HTTPException(status_code=400, detail=f"Invalid role: {body.role}")
        if not can_assign_role(user.role, body.role):
            raise HTTPException(status_code=403, detail=f"Cannot assign role higher than your own ({user.role})")
        # Owners may change any role including their own — but never below
        # one active owner, or the instance loses its admin identity (the
        # exact lockout class this whole day was about).
        if target["role"] == "owner" and body.role != "owner":
            from app.users import count_active_owners
            if await count_active_owners() <= 1:
                raise HTTPException(
                    status_code=409,
                    detail="This is the only active owner. Make another user an owner first, then change this role.",
                )
        await update_user_role(user_id, body.role, actor_id=user.id)
        # Revoke tokens to force re-auth with new role
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM refresh_tokens WHERE user_id = $1", UUID(user_id))

    if body.status is not None:
        if body.status not in ("active", "deactivated"):
            raise HTTPException(status_code=400, detail="Status must be 'active' or 'deactivated'")
        if body.status == "deactivated":
            from app.users import deactivate_user
            await deactivate_user(user_id, user.id)
        else:
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE users SET status = 'active', updated_at = NOW() WHERE id = $1",
                    UUID(user_id),
                )
            from app.audit import audit_rbac
            await audit_rbac(pool, user.id, "user_reactivated", target_id=user_id)

    if body.expires_at is not None:
        from datetime import datetime
        try:
            expires = datetime.fromisoformat(body.expires_at) if body.expires_at else None
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid datetime format for expires_at")
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE users SET expires_at = $1, updated_at = NOW() WHERE id = $2",
                expires, UUID(user_id),
            )
        from app.auth import deny_user_token
        await deny_user_token(user_id, reason="expiry_updated")

    updated = await get_user_by_id(user_id)
    return _safe_user(updated)


@router.delete("/api/v1/admin/users/{user_id}")
async def delete_user_endpoint(user_id: str, user: UserDep):
    """Permanently delete a user. Requires admin role.

    Hard delete: their conversations and sessions are removed; tasks,
    invites, and audit history are kept without attribution. Reversible
    blocking is PATCH status='deactivated'.
    """
    from app.roles import has_min_role, parse_role
    if not has_min_role(user.role, "admin"):
        raise HTTPException(status_code=403, detail="Requires admin role")

    from app.users import delete_user, get_user_by_id
    target = await get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target["email"] in SYSTEM_USER_EMAILS:
        raise HTTPException(status_code=403, detail="System identity — managed by Nova, not deletable")
    if target["role"] == "owner":
        raise HTTPException(status_code=403, detail="Cannot delete an owner. Change their role first.")
    if parse_role(target["role"]) >= parse_role(user.role):
        raise HTTPException(status_code=403, detail="Cannot delete user with equal or higher role")

    await delete_user(user_id, user.id, target_email=target["email"])
    return {"status": "deleted"}


# ── Conversations ────────────────────────────────────────────────────────────

@router.get("/api/v1/conversations")
async def list_conversations_endpoint(
    user: UserDep,
    archived: bool = Query(default=False),
    limit: int = Query(default=50, le=200),
    offset: int = Query(default=0, ge=0),
):
    from app.conversations import list_conversations
    return await list_conversations(user.id, limit=limit, offset=offset, include_archived=archived)


@router.post("/api/v1/conversations", status_code=201)
async def create_conversation_endpoint(req: ConversationCreate, user: UserDep):
    from app.conversations import create_conversation
    return await create_conversation(user.id, title=req.title)


@router.get("/api/v1/conversations/{conversation_id}")
async def get_conversation_endpoint(conversation_id: str, user: UserDep):
    from app.conversations import get_conversation
    conv = await get_conversation(conversation_id, user.id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@router.patch("/api/v1/conversations/{conversation_id}")
async def update_conversation_endpoint(
    conversation_id: str, req: ConversationUpdate, user: UserDep
):
    from app.conversations import update_conversation
    updates = {}
    if req.title is not None:
        updates["title"] = req.title
    if req.is_archived is not None:
        updates["is_archived"] = req.is_archived
    conv = await update_conversation(conversation_id, user.id, **updates)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@router.delete("/api/v1/conversations/{conversation_id}", status_code=204)
async def delete_conversation_endpoint(conversation_id: str, user: UserDep):
    from app.conversations import delete_conversation
    deleted = await delete_conversation(conversation_id, user.id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Conversation not found")


@router.get("/api/v1/conversations/{conversation_id}/messages")
async def get_messages_endpoint(
    conversation_id: str,
    user: UserDep,
    limit: int = Query(default=100, le=500),
    offset: int = Query(default=0, ge=0),
):
    from app.conversations import get_messages
    return await get_messages(conversation_id, user.id, limit=limit, offset=offset)


@router.post("/api/v1/conversations/{conversation_id}/messages/import")
async def import_messages_endpoint(
    conversation_id: str, req: MessageImport, user: UserDep
):
    from app.conversations import import_messages
    count = await import_messages(conversation_id, user.id, req.messages)
    return {"imported": count}
