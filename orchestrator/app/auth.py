"""
FastAPI dependencies for API key authentication and Redis rate limiting.

Three separate auth paths:
  ApiKeyDep  — validates X-API-Key header; applied to all task + agent endpoints
  AdminDep   — validates X-Admin-Secret header; applied to key management endpoints
  UserDep    — validates JWT Bearer token; applied to user-facing endpoints (dashboard)

When REQUIRE_AUTH=false (local dev), ApiKeyDep returns a synthetic bypass key
so all handlers work identically without distributing real keys.

UserDep is JWT-only. Admin secret is no longer accepted as a user-impersonation
token — it authenticates AdminDep endpoints only.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import time as _time
from dataclasses import dataclass
from typing import Annotated, Any
from uuid import UUID

from app.config import settings
from app.db import lookup_api_key, touch_api_key
from app.store import get_redis
from fastapi import Depends, Header, HTTPException, Request

log = logging.getLogger(__name__)

# ── Dynamic require_auth from DB (30s cache) ─────────────────────────────────

_AUTH_CACHE_TTL = 30  # seconds
_auth_cache: dict[str, Any] = {"require_auth": None, "ts": 0.0}

# ── Dynamic admin secret from Redis (30s cache) ──────────────────────────────
#
# The admin secret can be rotated at runtime via the dashboard, which writes a
# new value to `nova:config:auth.admin_secret` in Redis db 1 (the shared config
# db used by all services). Each validator re-reads on a 30s cadence so a
# rotated secret becomes valid across the platform within one cache window.
#
# Escape hatch: if a bad value ever gets stored, operators can clear the Redis
# key with `redis-cli -n 1 DEL nova:config:auth.admin_secret` to fall back to
# the env value (settings.nova_admin_secret). The env value is bootstrap-only
# and is never written back.

_ADMIN_SECRET_CACHE_TTL = 30  # seconds
_admin_secret_cache: dict[str, Any] = {"value": None, "ts": 0.0}

_config_redis = None  # lazy aioredis.Redis connection to db 1


def _config_redis_url() -> str:
    """Redis URL targeting db1 (shared nova:config:* namespace)."""
    return settings.redis_url.rsplit("/", 1)[0] + "/1"


async def get_admin_secret() -> str:
    """Return the current admin secret — Redis-backed, env fallback.

    Reads `nova:config:auth.admin_secret` from Redis db 1 with a 30s cache.
    Falls back to `settings.nova_admin_secret` (from .env) if Redis is down
    or the key is unset. Always returns a non-empty string.
    """
    now = _time.monotonic()
    if (
        now - _admin_secret_cache["ts"] < _ADMIN_SECRET_CACHE_TTL
        and _admin_secret_cache["value"] is not None
    ):
        return _admin_secret_cache["value"]

    value: str | None = None
    try:
        global _config_redis
        if _config_redis is None:
            import redis.asyncio as aioredis
            _config_redis = aioredis.from_url(_config_redis_url(), decode_responses=True)
        raw = await _config_redis.get("nova:config:auth.admin_secret")
        if raw:
            # May be stored as a raw string or as JSON-encoded string
            try:
                parsed = json.loads(raw)
                value = parsed if isinstance(parsed, str) and parsed else raw
            except (json.JSONDecodeError, TypeError):
                value = raw
    except Exception:
        log.debug("Failed to read admin secret from Redis, using .env fallback")

    if not value:
        value = settings.nova_admin_secret

    _admin_secret_cache["value"] = value
    _admin_secret_cache["ts"] = now
    return value


async def _get_require_auth() -> bool:
    """Read auth.require_auth from platform_config with 30s cache.

    Falls back to settings.require_auth if the DB key is missing or on error.
    """
    now = _time.monotonic()
    if now - _auth_cache["ts"] < _AUTH_CACHE_TTL and _auth_cache["require_auth"] is not None:
        return _auth_cache["require_auth"]

    try:
        from app.db import get_pool
        pool = get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT value #>> '{}' AS val FROM platform_config WHERE key = 'auth.require_auth'"
            )
        if row and row["val"] is not None:
            raw = row["val"]
            # Handle JSONB values: could be "true"/"false" or JSON-encoded
            if raw in ("true", "True", "1"):
                val = True
            elif raw in ("false", "False", "0"):
                val = False
            else:
                try:
                    val = bool(json.loads(raw))
                except Exception:
                    val = settings.require_auth
            _auth_cache["require_auth"] = val
            _auth_cache["ts"] = now
            return val
    except Exception:
        log.debug("Failed to read auth.require_auth from DB, using .env fallback")

    _auth_cache["require_auth"] = settings.require_auth
    _auth_cache["ts"] = now
    return settings.require_auth


@dataclass
class AuthenticatedUser:
    """Validated user context injected into handlers via UserDep."""
    id: str
    email: str
    display_name: str
    is_admin: bool
    role: str = "member"
    tenant_id: str = "00000000-0000-0000-0000-000000000001"


class AuthenticatedKey:
    """Validated API key context injected into handlers via ApiKeyDep."""

    def __init__(self, row: dict[str, Any]):
        # id is None for the dev-bypass key to avoid FK violations in usage_events
        self.id: UUID | None = row["id"]
        self.name: str = row["name"]
        self.rate_limit_rpm: int = row["rate_limit_rpm"]
        # FC-001: every authenticated key carries the tenant it operates under.
        # Dev-bypass and trusted-network bypass default to the seeded tenant.
        self.tenant_id: str = str(row.get("tenant_id") or "00000000-0000-0000-0000-000000000001")


async def _apply_rate_limit(api_key_id: UUID, rate_limit_rpm: int) -> None:
    """Redis sliding-window rate limiter at 1-minute granularity.

    On the first request in a window the key is created with a 120s TTL,
    so it auto-expires without a cleanup job. Raises HTTP 429 if the
    counter exceeds rate_limit_rpm for the current minute.
    """
    window = int(_time.time() / 60)
    rkey = f"nova:ratelimit:{api_key_id}:{window}"
    redis = get_redis()
    count = await redis.incr(rkey)
    if count == 1:
        await redis.expire(rkey, 120)  # auto-cleanup after 2 windows
    if count > rate_limit_rpm:
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded ({rate_limit_rpm} rpm). Retry after the next minute.",
        )


# Anti-brute-force on admin auth. Threshold is per-IP and only counts FAILED
# attempts — a successful admin request never increments. Window is 5 minutes;
# 10 fails locks the IP out for the rest of that window. Tunable via env in
# future if real ops experience demands it.
_ADMIN_FAIL_WINDOW_SECONDS = 300
_ADMIN_FAIL_THRESHOLD = 10


async def _admin_failures_key(ip: str) -> str:
    window = int(_time.time() / _ADMIN_FAIL_WINDOW_SECONDS)
    return f"nova:admin-auth-fail:{ip}:{window}"


async def _admin_failure_count(ip: str) -> int:
    """Read current failure count for an IP without incrementing."""
    try:
        redis = get_redis()
        raw = await redis.get(await _admin_failures_key(ip))
        return int(raw) if raw else 0
    except Exception:
        log.debug("Admin failure count read failed for %s", ip)
        return 0


async def _record_admin_failure(ip: str) -> int:
    """Increment failure counter for IP. Returns new count."""
    try:
        redis = get_redis()
        rkey = await _admin_failures_key(ip)
        count = await redis.incr(rkey)
        if count == 1:
            await redis.expire(rkey, _ADMIN_FAIL_WINDOW_SECONDS * 2)
        return count
    except Exception:
        log.debug("Admin failure counter unavailable")
        return 0  # fail-open on counter error so legit admins aren't locked out


async def require_api_key(
    request: Request,
    x_api_key: Annotated[str | None, Header(alias="X-API-Key")] = None,
) -> AuthenticatedKey:
    """Validate X-API-Key and enforce per-key rate limit.

    When REQUIRE_AUTH=false, returns a synthetic bypass key so local dev
    works without distributing keys. Usage events still write with the
    zero UUID so test traffic can be filtered from real traffic in reports.
    """
    # Trusted network bypass (LAN, Tailscale, localhost)
    if getattr(request.state, "is_trusted_network", False):
        return AuthenticatedKey({
            "id": None,
            "name": "trusted-network",
            "rate_limit_rpm": 9999,
        })

    if not await _get_require_auth():
        return AuthenticatedKey({
            "id": None,   # None avoids FK violation in usage_events when no real key exists
            "name": "dev-bypass",
            "rate_limit_rpm": 9999,
        })

    if not x_api_key:
        raise HTTPException(status_code=401, detail="X-API-Key header required")

    row = await lookup_api_key(x_api_key)
    if row is None:
        raise HTTPException(status_code=401, detail="Invalid or inactive API key")

    await _apply_rate_limit(row["id"], row["rate_limit_rpm"])

    # Fire-and-forget last_used_at update — zero latency impact on response
    asyncio.create_task(touch_api_key(row["id"]))

    return AuthenticatedKey(row)


async def require_admin(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_admin_secret: Annotated[str | None, Header(alias="X-Admin-Secret")] = None,
) -> None:
    """Validate admin access for key management and config endpoints.

    Accepts either:
    1. X-Admin-Secret header (original method)
    2. JWT Bearer token from an admin user (dashboard after login)

    SEC2 (2026-07-06): network position deliberately does NOT grant admin.
    The trusted-network bypass here was the class of hole behind the July 1
    factory-reset incident — any LAN/Docker-net device (including everything
    proxied through the dashboard container while trusted_proxy_header is
    unset) reached every admin endpoint credential-free. Trust by network
    remains on the USER surface (dashboard viewing/chat via get_current_user
    and the API-key gate); admin always requires credentials.
    """
    # Brute-force throttle: if this IP already exceeded the failure threshold
    # within the current window, reject up-front with 429. This runs BEFORE the
    # secret/JWT check so an attacker can't even attempt comparisons.
    client_ip = request.client.host if request.client else "unknown"
    fail_count = await _admin_failure_count(client_ip)
    if fail_count >= _ADMIN_FAIL_THRESHOLD:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Too many failed admin auth attempts. "
                f"Retry in {_ADMIN_FAIL_WINDOW_SECONDS // 60} minutes."
            ),
        )

    # Check admin secret first (Redis-backed with env fallback for zero-downtime rotation).
    # Constant-time comparison to defeat timing attacks: an attacker measuring response
    # latency must not be able to learn how many leading bytes of their guess matched.
    if x_admin_secret:
        expected = await get_admin_secret()
        if expected and hmac.compare_digest(x_admin_secret, expected):
            return

    # Check JWT from admin user
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
        try:
            from app.jwt_auth import verify_access_token
            payload = verify_access_token(token)
            if payload.get("is_admin"):
                return
        except Exception:
            pass

    # Brute-force throttle counts only requests that PRESENTED a credential
    # and got it wrong — guessing. Credential-less requests are just an
    # unauthenticated client (a logged-out dashboard polling admin views,
    # a health probe): with SEC2 removing the network bypass they'd
    # otherwise accumulate "failures" and lock the operator's IP out of
    # admin — including subsequent VALID logins — for the whole window.
    if x_admin_secret or (authorization and authorization.startswith("Bearer ")):
        await _record_admin_failure(client_ip)
        raise HTTPException(status_code=403, detail="Invalid admin secret")
    raise HTTPException(status_code=401, detail="Admin credentials required")


_SYNTHETIC_ADMIN = AuthenticatedUser(
    id="00000000-0000-0000-0000-000000000000",
    email="admin@local",
    display_name="Admin",
    is_admin=True,
    role="owner",
    tenant_id="00000000-0000-0000-0000-000000000001",
)


async def require_user(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_admin_secret: Annotated[str | None, Header(alias="X-Admin-Secret")] = None,
) -> AuthenticatedUser:
    """Authenticate dashboard requests. Accepts:
    1. Trusted network (LAN, Tailscale, localhost) — returns synthetic admin
    2. X-Admin-Secret (break-glass) — returns the synthetic owner identity
    3. Bearer JWT token (user auth)
    4. If REQUIRE_AUTH=false, returns synthetic admin user (dev bypass)

    (2) exists because a credential that passes require_admin must also
    confer an identity: without it, a secret-authenticated browser reaches
    every admin endpoint yet /auth/me knows nobody — and role-derived UI
    (invite roles, user management) silently degrades to 'viewer'.
    """
    # Break-glass admin secret → owner identity (constant-time compare).
    if x_admin_secret:
        expected = await get_admin_secret()
        if expected and hmac.compare_digest(x_admin_secret, expected):
            return _SYNTHETIC_ADMIN

    # Trusted network bypass
    if getattr(request.state, "is_trusted_network", False):
        return _SYNTHETIC_ADMIN

    # Dev bypass
    if not await _get_require_auth():
        return _SYNTHETIC_ADMIN

    # Try JWT first
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
        try:
            from app.jwt_auth import verify_access_token
            payload = verify_access_token(token)
            user_id = payload["sub"]
            role = payload.get("role", "admin" if payload.get("is_admin") else "member")
            tenant_id = payload.get("tenant_id", "00000000-0000-0000-0000-000000000001")

            # Check Redis deny-list (immediate token revocation)
            try:
                redis = get_redis()
                denied = await redis.get(f"nova:auth:denied:{user_id}")
                if denied:
                    ip = request.client.host if request.client else "unknown"
                    reason = "unknown"
                    try:
                        reason = json.loads(denied).get("reason", "unknown")
                    except Exception:
                        pass
                    log.warning("Access denied: token on deny-list (user=%s, reason=%s, ip=%s)", user_id, reason, ip)
                    # Fire-and-forget audit
                    try:
                        from app.audit import audit_rbac
                        from app.db import get_pool
                        pool = get_pool()
                        asyncio.create_task(audit_rbac(
                            pool, user_id, "token_denied",
                            details={"reason": reason},
                            ip=ip, tenant_id=tenant_id,
                        ))
                    except Exception:
                        pass
                    raise HTTPException(
                        status_code=403,
                        detail="Your access has been updated. Please log in again.",
                    )
            except HTTPException:
                raise
            except Exception:
                log.warning("Redis deny-list check failed — allowing request through (user=%s)", user_id)

            # Check account expiry
            try:
                from datetime import datetime, timezone

                from app.db import get_pool
                pool = get_pool()
                row = await pool.fetchrow(
                    "SELECT status, expires_at FROM users WHERE id = $1::uuid", user_id
                )
                if row:
                    if row["status"] != "active":
                        log.warning("Access denied: account deactivated (user=%s, status=%s, ip=%s)", user_id, row["status"], request.client.host if request.client else "unknown")
                        raise HTTPException(status_code=403, detail="Account deactivated")
                    if row["expires_at"] and row["expires_at"] < datetime.now(timezone.utc):
                        ip = request.client.host if request.client else "unknown"
                        log.warning("Access denied: account expired (user=%s, expired=%s, ip=%s)", user_id, row["expires_at"].isoformat(), ip)
                        # Audit the expiry
                        try:
                            from app.audit import audit_rbac
                            asyncio.create_task(audit_rbac(
                                pool, user_id, "account_expired",
                                ip=ip, tenant_id=tenant_id,
                            ))
                        except Exception:
                            pass
                        raise HTTPException(status_code=403, detail="Account expired")
            except HTTPException:
                raise
            except Exception:
                log.warning("Account status/expiry check failed — allowing request through (user=%s)", user_id)

            return AuthenticatedUser(
                id=user_id,
                email=payload["email"],
                display_name=payload.get("display_name", ""),
                is_admin=payload.get("is_admin", False),
                role=role,
                tenant_id=tenant_id,
            )
        except HTTPException:
            raise
        except Exception:
            pass  # JWT invalid/expired — fall through to 401

    raise HTTPException(status_code=401, detail="Authentication required")


# Clean type aliases used in handler signatures
ApiKeyDep = Annotated[AuthenticatedKey, Depends(require_api_key)]
AdminDep = Annotated[None, Depends(require_admin)]
UserDep = Annotated[AuthenticatedUser, Depends(require_user)]


# ── Role-based access control deps ──────────────────────────────────────────

def require_role(min_role: str):
    """Factory for role-checking dependencies."""
    async def _check(user: UserDep) -> AuthenticatedUser:
        from app.roles import has_min_role
        if not has_min_role(user.role, min_role):
            raise HTTPException(status_code=403, detail=f"Requires {min_role} role or higher")
        return user
    return _check


async def check_account_active(user: UserDep) -> AuthenticatedUser:
    from datetime import datetime, timezone

    from app.db import get_pool
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT status, expires_at FROM users WHERE id = $1", user.id
    )
    if row:
        if row["status"] != "active":
            raise HTTPException(status_code=403, detail="Account deactivated")
        if row["expires_at"] and row["expires_at"] < datetime.now(timezone.utc):
            raise HTTPException(status_code=403, detail="Account expired")
    return user


ActiveUserDep = Annotated[AuthenticatedUser, Depends(check_account_active)]
OwnerDep = Annotated[AuthenticatedUser, Depends(require_role("owner"))]
AdminRoleDep = Annotated[AuthenticatedUser, Depends(require_role("admin"))]
MemberDep = Annotated[AuthenticatedUser, Depends(require_role("member"))]


# ── Token deny-list helpers ────────────────────────────────────────────────

_DENY_TTL = 900  # 15 min — matches JWT access token lifetime


async def deny_user_token(user_id: str, reason: str = "access_updated") -> None:
    """Add a user to the Redis deny-list, forcing re-authentication.

    Called when an admin changes a user's role, deactivates them, updates
    expiry, or when a user changes their own password.
    """
    try:
        redis = get_redis()
        payload = json.dumps({"reason": reason, "at": _time.time()})
        await redis.set(f"nova:auth:denied:{user_id}", payload, ex=_DENY_TTL)
        log.warning("Token deny-list: added user %s (reason=%s, ttl=%ds)", user_id, reason, _DENY_TTL)
    except Exception:
        log.warning("Failed to set deny-list for user %s", user_id)
