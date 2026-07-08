"""Capability credential vault — DB layer.

Encryption uses BuiltinCredentialProvider (AES-256-GCM + HKDF tenant subkey)
from nova_worker_common.  The master key is read from ``settings.credential_master_key``
(env var ``CREDENTIAL_MASTER_KEY``).  The key must be a 64-character hex string
(32 bytes); generate with::

    python -c "import os; print(os.urandom(32).hex())"

If the env var is unset, ``ensure_credential_master_key()`` (called from the
orchestrator startup lifespan) generates one and persists it to
``platform_config`` so the key survives container restarts. The env var still
takes precedence when set — DB bootstrap is the day-1 fallback only.

Callers of ``get_secret`` MUST NOT log the return value.
"""
from __future__ import annotations

import logging
import os
from uuid import UUID, uuid4

import asyncpg
from app.capabilities.audit import write_audit_event
from app.capabilities.models import (
    AuthMethod,
    Credential,
    CredentialBackend,
    CredentialCreate,
    CredentialHealth,
)
from app.config import settings
from fastapi import HTTPException
from nova_worker_common.credentials.builtin import BuiltinCredentialProvider

logger = logging.getLogger(__name__)

# Module-level singleton — instantiated once on first use; restart picks up key changes.
_credential_provider: BuiltinCredentialProvider | None = None


async def ensure_credential_master_key() -> None:
    """Auto-generate and persist CREDENTIAL_MASTER_KEY if not set.

    Called at orchestrator startup. Mirrors ``jwt_auth.ensure_jwt_secret``.

    Order of precedence:

      1. ``settings.credential_master_key`` already loaded from env — return.
         The env var wins; DB row is left untouched.
      2. ``platform_config`` has a non-empty value — copy it into settings.
      3. Otherwise generate ``os.urandom(32).hex()``, write it to
         platform_config, set settings, log INFO.

    Fails fast (RuntimeError) if the platform_config table is unreachable —
    the existing init_db retry loop should make this impossible in practice.
    """
    from app.db import get_pool

    if settings.credential_master_key:
        return

    pool = get_pool()
    try:
        async with pool.acquire() as conn:
            existing = await conn.fetchval(
                "SELECT value #>> '{}' FROM platform_config "
                "WHERE key = 'capability.credential_master_key'"
            )
            if existing and existing.strip('"'):
                settings.credential_master_key = existing.strip('"')
                return

            generated = os.urandom(32).hex()
            await conn.execute(
                """
                INSERT INTO platform_config (key, value, description, is_secret, updated_at)
                VALUES (
                    'capability.credential_master_key',
                    $1::jsonb,
                    'Auto-generated master key for capability credential vault (AES-256-GCM).',
                    TRUE,
                    NOW()
                )
                ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()
                """,
                f'"{generated}"',
            )
            settings.credential_master_key = generated
            logger.info("Generated and stored CREDENTIAL_MASTER_KEY in platform_config")
    except asyncpg.PostgresError as exc:
        raise RuntimeError(
            f"Failed to bootstrap CREDENTIAL_MASTER_KEY from platform_config: {exc}"
        ) from exc


def _provider() -> BuiltinCredentialProvider:
    """Return the cached BuiltinCredentialProvider, creating it on first call.

    Assumes ``ensure_credential_master_key()`` has already populated
    ``settings.credential_master_key`` at startup. The HTTPException branch
    only fires if the startup hook was bypassed (e.g. a service that
    instantiated this module without going through the orchestrator lifespan).
    """
    global _credential_provider
    if _credential_provider is None:
        if not settings.credential_master_key:
            raise HTTPException(
                status_code=500,
                detail="CREDENTIAL_MASTER_KEY not configured — cannot encrypt credentials",
            )
        _credential_provider = BuiltinCredentialProvider(settings.credential_master_key)
    return _credential_provider


def _encrypt(tenant_id: UUID, plaintext: str) -> bytes:
    return _provider().encrypt(str(tenant_id), plaintext)


def _decrypt(tenant_id: UUID, ciphertext: bytes) -> str:
    return _provider().decrypt(str(tenant_id), ciphertext)


async def create_credential(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    user_id: UUID | None,
    payload: CredentialCreate,
    actor: str,
) -> Credential:
    """Encrypt (if builtin) and persist a new credential with audit event."""
    encrypted: bytes | None = None
    if payload.backend == CredentialBackend.BUILTIN:
        encrypted = _encrypt(tenant_id, payload.secret)

    cred_id = uuid4()

    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                INSERT INTO capability_credentials (
                    id, tenant_id, user_id, provider_kind, auth_method, label,
                    backend, encrypted_data, external_ref, scopes
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING *
                """,
                cred_id,
                tenant_id,
                user_id,
                payload.provider_kind,
                payload.auth_method.value,
                payload.label,
                payload.backend.value,
                encrypted,
                payload.external_ref,
                payload.scopes,
            )
            await conn.execute(
                """
                INSERT INTO capability_credential_audit
                  (credential_id, tenant_id, action, actor)
                VALUES ($1, $2, 'store', $3)
                """,
                cred_id,
                tenant_id,
                actor,
            )
    # ── After commit, write the broader audit (best-effort) ──
    try:
        await write_audit_event(
            pool,
            tenant_id=tenant_id,
            user_id=user_id,
            actor_kind="human",
            actor_id=actor,
            event_type="credential_use",
            credential_id=cred_id,
            args_redacted={"action": "store", "provider_kind": payload.provider_kind},
            response_status="success",
        )
    except Exception as e:
        logger.warning("capability_audit write failed for cred %s: %s", cred_id, e)
    return _row_to_model(row)


async def get_credential(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    cred_id: UUID,
    actor: str,
) -> Credential | None:
    """Fetch credential metadata (no secret) and record a 'retrieve' audit event."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM capability_credentials WHERE id=$1 AND tenant_id=$2",
            cred_id,
            tenant_id,
        )
        if not row:
            return None
        await conn.execute(
            """
            INSERT INTO capability_credential_audit
              (credential_id, tenant_id, action, actor)
            VALUES ($1, $2, 'retrieve', $3)
            """,
            cred_id,
            tenant_id,
            actor,
        )
    # ── After commit, write the broader audit (best-effort) ──
    try:
        provider_kind = row.get("provider_kind") if row else None
        await write_audit_event(
            pool,
            tenant_id=tenant_id,
            actor_kind="human",
            actor_id=actor,
            event_type="credential_use",
            credential_id=cred_id,
            args_redacted={"action": "retrieve"},
            response_status="success",
            provider_kind=provider_kind,
        )
    except Exception as e:
        logger.warning("capability_audit write failed for cred %s: %s", cred_id, e)
    return _row_to_model(row)


async def get_secret(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    cred_id: UUID,
    actor: str,
) -> str | None:
    """Return decrypted secret and record a 'use' audit event.

    IMPORTANT: Caller must never log the return value.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT backend, encrypted_data, external_ref "
            "FROM capability_credentials WHERE id=$1 AND tenant_id=$2",
            cred_id,
            tenant_id,
        )
        if not row:
            return None
        await conn.execute(
            """
            INSERT INTO capability_credential_audit
              (credential_id, tenant_id, action, actor)
            VALUES ($1, $2, 'use', $3)
            """,
            cred_id,
            tenant_id,
            actor,
        )

    # ── After commit, write the broader audit (best-effort) ──
    try:
        await write_audit_event(
            pool,
            tenant_id=tenant_id,
            actor_kind="human",
            actor_id=actor,
            event_type="credential_use",
            credential_id=cred_id,
            args_redacted={"action": "use"},
            response_status="success",
        )
    except Exception as e:
        logger.warning("capability_audit write failed for cred %s: %s", cred_id, e)

    backend = row["backend"]
    if backend == CredentialBackend.BUILTIN.value:
        encrypted = row["encrypted_data"]
        if not encrypted:
            return None
        return _decrypt(tenant_id, encrypted)

    raise NotImplementedError(f"backend {backend} not implemented in v1")


async def list_credentials(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    provider_kind: str | None = None,
) -> list[Credential]:
    """List credentials for a tenant, optionally filtered by provider_kind."""
    async with pool.acquire() as conn:
        if provider_kind:
            rows = await conn.fetch(
                "SELECT * FROM capability_credentials "
                "WHERE tenant_id=$1 AND provider_kind=$2 ORDER BY created_at DESC LIMIT 500",
                tenant_id,
                provider_kind,
            )
        else:
            rows = await conn.fetch(
                "SELECT * FROM capability_credentials "
                "WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 500",
                tenant_id,
            )
    return [_row_to_model(r) for r in rows]


async def delete_credential(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    cred_id: UUID,
    actor: str,
) -> bool:
    """Delete a credential.  Audit event is written BEFORE the DELETE so FK cascade
    doesn't prevent the insert.  Returns True if a row was deleted."""
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO capability_credential_audit
                  (credential_id, tenant_id, action, actor)
                VALUES ($1, $2, 'delete', $3)
                """,
                cred_id,
                tenant_id,
                actor,
            )
            result = await conn.execute(
                "DELETE FROM capability_credentials WHERE id=$1 AND tenant_id=$2",
                cred_id,
                tenant_id,
            )
    # ── After commit, write the broader audit (best-effort) ──
    try:
        await write_audit_event(
            pool,
            tenant_id=tenant_id,
            actor_kind="human",
            actor_id=actor,
            event_type="credential_use",
            credential_id=cred_id,
            args_redacted={"action": "delete"},
            response_status="success",
        )
    except Exception as e:
        logger.warning("capability_audit write failed for cred %s: %s", cred_id, e)
    # asyncpg returns "DELETE N" — "DELETE 1" means a row was removed
    return result.endswith(" 1")


async def validate_credential(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    cred_id: UUID,
    actor: str,
    api_base: str | None = None,
) -> CredentialHealth:
    """Ping the provider's identity endpoint; record health + last_validated_at.

    api_base override is for tests pointing at fake-github. Production uses settings.
    Admin callers only — the api_base override is an admin-gated test seam;
    production callers should not pass api_base.

    Also captures granted scopes (GitHub `X-OAuth-Scopes` header) into
    `credential.scopes.granted` so the dashboard can warn before a tool 403s
    on a missing scope.
    """
    cred = await get_credential(pool, tenant_id=tenant_id, cred_id=cred_id, actor=actor)
    if not cred:
        return CredentialHealth.UNKNOWN
    secret = await get_secret(pool, tenant_id=tenant_id, cred_id=cred_id, actor=actor)
    granted: list[str] = []
    if not secret:
        health = CredentialHealth.INVALID
    elif cred.provider_kind == "github":
        base = api_base or settings.github_api_base_url
        health, granted = await _validate_github(base, secret)
    else:
        health = CredentialHealth.UNKNOWN

    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE capability_credentials SET health=$1, last_validated_at=now() WHERE id=$2",
            health.value,
            cred_id,
        )
        # Merge granted scopes into existing scopes JSONB. Done in a separate
        # statement so a failure here doesn't roll back the health update.
        if cred.provider_kind == "github" and health == CredentialHealth.HEALTHY:
            existing = cred.scopes or {}
            updated = {**existing, "granted": granted}
            await conn.execute(
                "UPDATE capability_credentials SET scopes=$1 WHERE id=$2",
                updated, cred_id,
            )
        await conn.execute(
            """
            INSERT INTO capability_credential_audit (credential_id, tenant_id, action, actor, success)
            VALUES ($1, $2, 'validate', $3, $4)
            """,
            cred_id,
            tenant_id,
            actor,
            health == CredentialHealth.HEALTHY,
        )
    # ── After commit, write the broader audit (best-effort) ──
    try:
        await write_audit_event(
            pool,
            tenant_id=tenant_id,
            actor_kind="human",
            actor_id=actor,
            event_type="credential_use",
            credential_id=cred_id,
            args_redacted={"action": "validate", "health": health.value},
            response_status="success" if health == CredentialHealth.HEALTHY else "error",
            provider_kind=cred.provider_kind if cred else None,
        )
    except Exception as e:
        logger.warning("capability_audit write failed for cred %s: %s", cred_id, e)
    return health


async def _validate_github(base: str, token: str) -> tuple[CredentialHealth, list[str]]:
    """Call GET /user on the GitHub API (or fake); return (health, granted_scopes).

    GitHub returns the token's scopes via the `X-OAuth-Scopes` response header
    as a comma-separated list. On non-200 responses or HTTP errors, scopes is
    an empty list — the caller should treat that as 'no info', not 'no scopes'.
    """
    import httpx

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{base}/user", headers={"Authorization": f"Bearer {token}"}
            )
        if resp.status_code == 200:
            scopes_header = resp.headers.get("X-OAuth-Scopes", "")
            granted = [s.strip() for s in scopes_header.split(",") if s.strip()]
            return CredentialHealth.HEALTHY, granted
        if resp.status_code == 401:
            return CredentialHealth.REVOKED, []
        if resp.status_code == 403:
            return CredentialHealth.INVALID, []
        return CredentialHealth.UNKNOWN, []
    except httpx.HTTPError as exc:
        logger.warning("github validate failed: %s", exc)
        return CredentialHealth.UNKNOWN, []


def _row_to_model(row: asyncpg.Record) -> Credential:
    """Convert a raw asyncpg record to a Credential Pydantic model."""
    scopes = row["scopes"]
    return Credential(
        id=row["id"],
        tenant_id=row["tenant_id"],
        user_id=row["user_id"],
        provider_kind=row["provider_kind"],
        auth_method=AuthMethod(row["auth_method"]),
        label=row["label"],
        backend=CredentialBackend(row["backend"]),
        scopes=scopes,
        expires_at=row["expires_at"],
        last_validated_at=row["last_validated_at"],
        health=CredentialHealth(row["health"]),
        created_at=row["created_at"],
    )
