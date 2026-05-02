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

from app.capabilities.models import (
    AuthMethod,
    Credential,
    CredentialBackend,
    CredentialCreate,
    CredentialHealth,
)
from app.config import settings

logger = logging.getLogger(__name__)


def _provider() -> BuiltinCredentialProvider:
    """Return a configured BuiltinCredentialProvider or raise 500."""
    key = settings.credential_master_key
    if not key:
        raise HTTPException(
            status_code=500,
            detail="CREDENTIAL_MASTER_KEY not configured — cannot encrypt credentials",
        )
    return BuiltinCredentialProvider(key)


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
    # Serialize scopes as JSON string for asyncpg JSONB binding
    import json
    scopes_json = json.dumps(payload.scopes) if payload.scopes is not None else None

    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                INSERT INTO capability_credentials (
                    id, tenant_id, user_id, provider_kind, auth_method, label,
                    backend, encrypted_data, external_ref, scopes
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
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
                scopes_json,
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

    backend = row["backend"]
    if backend == CredentialBackend.BUILTIN.value:
        encrypted = row["encrypted_data"]
        if not encrypted:
            return None
        return _decrypt(tenant_id, bytes(encrypted))

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
    # asyncpg returns "DELETE N" — "DELETE 1" means a row was removed
    return result.endswith(" 1")


def _row_to_model(row: asyncpg.Record) -> Credential:
    """Convert a raw asyncpg record to a Credential Pydantic model."""
    scopes = row["scopes"]
    # asyncpg returns JSONB as a dict already; None is fine as-is
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
