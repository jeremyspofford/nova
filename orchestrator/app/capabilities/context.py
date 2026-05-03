"""Auth context for capability endpoints — resolves tenant_id and user_id.

Replaces the legacy DEFAULT_TENANT/DEFAULT_USER hardcodes in router.py. Every
capability endpoint accepts ``ctx: CapabilityContext = Depends(get_capability_context)``
which routes to one of three sources:

  1. Trusted network (LAN, Tailscale, localhost) → admin-equivalent on the
     seeded tenant. Required for the install flow + dashboard before login.
  2. ``X-Admin-Secret`` header → admin-equivalent on the seeded tenant.
     Maintains compatibility with the dashboard's pre-JWT admin-secret flow.
  3. ``Authorization: Bearer <jwt>`` → reads ``tenant_id`` and ``sub``
     (user_id) from the JWT claims issued by ``app.jwt_auth.create_access_token``.

If none match, raises HTTPException(401). Test users created via direct DB
seed receive real tenant_ids in their JWTs and so route through path 3.
"""
from __future__ import annotations

import hmac
import logging
from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from app.auth import get_admin_secret
from fastapi import Depends, Header, HTTPException, Request

log = logging.getLogger(__name__)

# Seeded tenant (migration 068 / users.tenant_id default). Used for admin-secret
# and trusted-network callers — these are operationally tenant-scoped to the
# seeded tenant in v1, with multi-tenant admin tooling deferred.
DEFAULT_TENANT = UUID("00000000-0000-0000-0000-000000000001")
DEFAULT_USER = UUID("00000000-0000-0000-0000-000000000001")


@dataclass(frozen=True)
class CapabilityContext:
    """Authenticated context for a capability-router request.

    tenant_id and user_id are always populated. is_admin signals whether the
    caller has cross-user admin privileges within their tenant — admin-secret
    callers are always admin; JWT callers inherit ``is_admin`` from their user
    record.
    """
    tenant_id: UUID
    user_id: UUID
    is_admin: bool


async def get_capability_context(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_admin_secret: Annotated[str | None, Header(alias="X-Admin-Secret")] = None,
) -> CapabilityContext:
    """Resolve the auth context for a capability-router request.

    Order of precedence:

      1. Valid JWT bearer token → tenant_id + user_id from claims, is_admin
         from claims. JWT wins over admin-secret and trusted-network so two
         logged-in users on the same trusted network see only their own data.
      2. Valid X-Admin-Secret → DEFAULT_TENANT/DEFAULT_USER + admin
      3. Trusted network (LAN, Tailscale, localhost) with NO credentials
         presented → DEFAULT_TENANT/DEFAULT_USER + admin. Lets dashboard
         and install flows work before login on closed networks.
      4. Otherwise 401

    The JWT-first ordering is the data-isolation guarantee: if a request
    carries User A's bearer token, it MUST be treated as User A even when
    it originates from inside the trusted perimeter.
    """
    # 1. JWT bearer token — first because it's the strongest identity claim
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
        try:
            from app.jwt_auth import verify_access_token
            payload = verify_access_token(token)
        except Exception:
            raise HTTPException(status_code=401, detail="Invalid or expired token")

        sub = payload.get("sub")
        tenant_claim = payload.get("tenant_id")
        if not sub:
            # Tokens without a subject claim (shouldn't happen for access tokens)
            # are treated as malformed rather than silently falling back.
            raise HTTPException(status_code=401, detail="Token missing subject claim")
        try:
            user_uuid = UUID(sub)
        except (ValueError, TypeError):
            raise HTTPException(status_code=401, detail="Token subject is not a valid UUID")

        # tenant_id may be missing on legacy tokens issued before the claim was
        # added; fall back to the seeded tenant so the dashboard's pre-rotation
        # tokens keep working until they expire.
        if tenant_claim:
            try:
                tenant_uuid = UUID(tenant_claim)
            except (ValueError, TypeError):
                raise HTTPException(status_code=401, detail="Token tenant_id is not a valid UUID")
        else:
            tenant_uuid = DEFAULT_TENANT

        return CapabilityContext(
            tenant_id=tenant_uuid,
            user_id=user_uuid,
            is_admin=bool(payload.get("is_admin", False)),
        )

    # 2. Admin secret
    if x_admin_secret:
        expected = await get_admin_secret()
        if expected and hmac.compare_digest(x_admin_secret, expected):
            return CapabilityContext(
                tenant_id=DEFAULT_TENANT,
                user_id=DEFAULT_USER,
                is_admin=True,
            )

    # 3. Trusted network bypass — only when no credentials were presented
    if getattr(request.state, "is_trusted_network", False):
        return CapabilityContext(
            tenant_id=DEFAULT_TENANT,
            user_id=DEFAULT_USER,
            is_admin=True,
        )

    raise HTTPException(status_code=401, detail="Authentication required")


CapabilityCtxDep = Annotated[CapabilityContext, Depends(get_capability_context)]
