"""Capability credential vault — DB layer.

Encryption uses BuiltinCredentialProvider (AES-256-GCM + HKDF tenant subkey)
from nova_worker_common.  The master key is read from ``settings.credential_master_key``
(env var ``CREDENTIAL_MASTER_KEY``).  The key must be a 64-character hex string
(32 bytes); generate with::

    python -c "import os; print(os.urandom(32).hex())"

Callers of ``get_secret`` MUST NOT log the return value.
"""
from __future__ import annotations

import logging
from uuid import UUID, uuid4

import asyncpg
from fastapi import HTTPException
from nova_worker_common.credentials.builtin import BuiltinCredentialProvider

from app.capabilities.audit import write_audit_event
from app.capabilities.models import (
    AuthMethod,
    Credential,
    CredentialBackend,
    CredentialCreate,
    CredentialHealth,
)
from app.config import settings

logger = logging.getLogger(__name__)

# Module-level singleton — instantiated once on first use; restart picks up key changes.
_credential_provider: BuiltinCredentialProvider | None = None


def _provider() -> BuiltinCredentialProvider:
    """Return the cached BuiltinCredentialProvider, creating it on first call."""
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
                "WHERE tenant_id=$1 AND provider_kind=$2 ORDER BY created_at DESC",
                tenant_id,
                provider_kind,
            )
        else:
            rows = await conn.fetch(
                "SELECT * FROM capability_credentials "
                "WHERE tenant_id=$1 ORDER BY created_at DESC",
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
    """
    cred = await get_credential(pool, tenant_id=tenant_id, cred_id=cred_id, actor=actor)
    if not cred:
        return CredentialHealth.UNKNOWN
    secret = await get_secret(pool, tenant_id=tenant_id, cred_id=cred_id, actor=actor)
    if not secret:
        health = CredentialHealth.INVALID
    elif cred.provider_kind == "github":
        base = api_base or settings.github_api_base_url
        health = await _validate_github(base, secret)
    else:
        health = CredentialHealth.UNKNOWN

    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE capability_credentials SET health=$1, last_validated_at=now() WHERE id=$2",
            health.value,
            cred_id,
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


async def _validate_github(base: str, token: str) -> CredentialHealth:
    """Call GET /user on the GitHub API (or fake); map status code to CredentialHealth."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{base}/user", headers={"Authorization": f"Bearer {token}"}
            )
        if resp.status_code == 200:
            return CredentialHealth.HEALTHY
        if resp.status_code == 401:
            return CredentialHealth.REVOKED
        if resp.status_code == 403:
            return CredentialHealth.INVALID
        return CredentialHealth.UNKNOWN
    except httpx.HTTPError as exc:
        logger.warning("github validate failed: %s", exc)
        return CredentialHealth.UNKNOWN


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
