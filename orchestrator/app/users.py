"""User CRUD operations — raw asyncpg queries."""
from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from app.db import get_pool

log = logging.getLogger(__name__)


def _user_dict(row) -> dict[str, Any]:
    d = dict(row)
    d["id"] = str(d["id"])
    # Stringify UUID fields so callers (and JSON encoders) get strings.
    # Historically only `id` came back stringified because `tenant_id`
    # wasn't selected. T2-01 added it to the SELECT — keep the contract
    # consistent so JWT encoding (json.dumps) doesn't choke on UUID.
    if d.get("tenant_id") is not None and not isinstance(d["tenant_id"], str):
        d["tenant_id"] = str(d["tenant_id"])
    return d


async def create_user(
    email: str,
    password_hash: str | None = None,
    display_name: str | None = None,
    provider: str = "local",
    provider_id: str | None = None,
    is_admin: bool = False,
    role: str | None = None,
    tenant_id: str = "00000000-0000-0000-0000-000000000001",
    expires_at=None,
) -> dict[str, Any]:
    if role is None:
        role = "admin" if is_admin else "member"
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO users (email, password_hash, display_name, provider, provider_id, is_admin, role, tenant_id, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, email, display_name, avatar_url, provider, provider_id, is_admin, role, tenant_id, expires_at, created_at, updated_at
            """,
            email, password_hash, display_name, provider, provider_id, is_admin, role, UUID(tenant_id), expires_at,
        )
    return _user_dict(row)


# Columns returned by user lookups. Includes tenant_id, role, status, and
# expires_at — these are needed by the auth flow to mint correctly-claimed
# JWTs (T2-01). Do not narrow this without checking auth_router.create_access_token
# and `AuthenticatedUser` field reads.
_USER_COLS = (
    "id, email, display_name, avatar_url, password_hash, provider, provider_id, "
    "is_admin, role, tenant_id, status, expires_at, created_at, updated_at"
)


async def get_user_by_email(email: str) -> dict[str, Any] | None:
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"SELECT {_USER_COLS} FROM users WHERE email = $1",
            email,
        )
    return _user_dict(row) if row else None


async def get_user_by_provider(provider: str, provider_id: str) -> dict[str, Any] | None:
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"SELECT {_USER_COLS} FROM users WHERE provider = $1 AND provider_id = $2",
            provider, provider_id,
        )
    return _user_dict(row) if row else None


async def get_user_by_id(user_id: str | UUID) -> dict[str, Any] | None:
    pool = get_pool()
    uid = UUID(user_id) if isinstance(user_id, str) else user_id
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"SELECT {_USER_COLS} FROM users WHERE id = $1",
            uid,
        )
    return _user_dict(row) if row else None


async def update_user(user_id: str | UUID, **fields) -> dict[str, Any] | None:
    allowed = {"display_name", "avatar_url"}
    updates = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if not updates:
        return await get_user_by_id(user_id)

    uid = UUID(user_id) if isinstance(user_id, str) else user_id
    set_clause = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
    values = [uid] + list(updates.values())

    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE users SET {set_clause}, updated_at = NOW() WHERE id = $1 "
            "RETURNING id, email, display_name, avatar_url, provider, provider_id, is_admin, created_at, updated_at",
            *values,
        )
    return _user_dict(row) if row else None


# Load-bearing identities, not people: admin@local anchors ambient/break-glass
# sessions (fixed zero UUID); cortex@system.nova owns the brain's journal
# conversation. Password-less by construction. They are excluded from user
# counts and listings — counting them broke the first-user registration
# exemption on fresh installs (seeded rows made count_users() start at 2),
# and surfacing them in the Users page invited operators to break them.
SYSTEM_USER_EMAILS = ("admin@local", "cortex@system.nova")


async def count_users() -> int:
    """Human accounts only — system identities don't count as users."""
    pool = get_pool()
    async with pool.acquire() as conn:
        return await conn.fetchval(
            "SELECT COUNT(*) FROM users WHERE email != ALL($1::text[])",
            list(SYSTEM_USER_EMAILS),
        )


async def list_users(tenant_id: str = "00000000-0000-0000-0000-000000000001") -> list[dict[str, Any]]:
    """Human accounts only — system identities are managed by Nova, not listed."""
    pool = get_pool()
    rows = await pool.fetch(
        "SELECT * FROM users WHERE tenant_id = $1 AND email != ALL($2::text[]) ORDER BY created_at",
        UUID(tenant_id), list(SYSTEM_USER_EMAILS),
    )
    return [_user_dict(r) for r in rows]


async def count_active_owners() -> int:
    """Active human owners — the guard against demoting the last one."""
    pool = get_pool()
    async with pool.acquire() as conn:
        return await conn.fetchval(
            "SELECT COUNT(*) FROM users WHERE role = 'owner' AND status = 'active' "
            "AND email != ALL($1::text[])",
            list(SYSTEM_USER_EMAILS),
        )


async def update_user_role(user_id: str, role: str, actor_id: str | None = None) -> dict[str, Any] | None:
    pool = get_pool()
    is_admin = role in ("owner", "admin")
    row = await pool.fetchrow(
        "UPDATE users SET role = $2, is_admin = $3, updated_at = NOW() WHERE id = $1 RETURNING *",
        UUID(user_id), role, is_admin,
    )
    if row and actor_id:
        from app.audit import audit_rbac
        await audit_rbac(
            pool, actor_id, "role_change",
            target_id=user_id,
            details={"new_role": role},
            tenant_id=row["tenant_id"],
        )
        # Deny current tokens so user must re-authenticate with new role
        from app.auth import deny_user_token
        await deny_user_token(user_id, reason="role_changed")
    return _user_dict(row) if row else None


async def deactivate_user(user_id: str, actor_id: str) -> bool:
    pool = get_pool()
    result = await pool.execute(
        "UPDATE users SET status = 'deactivated', updated_at = NOW() WHERE id = $1", UUID(user_id)
    )
    await pool.execute("DELETE FROM refresh_tokens WHERE user_id = $1", UUID(user_id))
    from app.audit import audit_rbac
    await audit_rbac(
        pool, actor_id, "user_deactivated",
        target_id=user_id,
        tenant_id=None,  # will use default
    )
    # Deny current tokens immediately
    from app.auth import deny_user_token
    await deny_user_token(user_id, reason="deactivated")
    return "UPDATE 1" in result
