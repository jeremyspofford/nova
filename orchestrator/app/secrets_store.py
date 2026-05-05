"""SEC-006a — platform_secrets DB layer.

Encrypts long-lived instance-level secrets (LLM provider keys, chat-bridge
tokens, OAuth secrets, self-mod GitHub PAT) at rest using the same
BuiltinCredentialProvider + master key that capability credentials use.

Tenant id is the fixed string ``"platform"`` — these are instance-level, not
per-user. Per-user/per-tenant credentials continue to live in
``capability_credentials`` via ``app.capabilities.credentials``.

Callers of ``get_secret`` MUST NOT log the return value.
"""
from __future__ import annotations

import logging

import asyncpg
from fastapi import HTTPException
from nova_worker_common.credentials.builtin import BuiltinCredentialProvider

from app.config import settings

logger = logging.getLogger(__name__)

# Fixed tenant id for HKDF subkey derivation. Platform secrets are instance-wide.
_PLATFORM_TENANT = "platform"

_provider_singleton: BuiltinCredentialProvider | None = None


def _provider() -> BuiltinCredentialProvider:
    """Return the cached BuiltinCredentialProvider, creating it on first call.

    Assumes ``ensure_credential_master_key()`` has populated
    ``settings.credential_master_key`` at startup.
    """
    global _provider_singleton
    if _provider_singleton is None:
        if not settings.credential_master_key:
            raise HTTPException(
                status_code=500,
                detail="CREDENTIAL_MASTER_KEY not configured — cannot encrypt secrets",
            )
        _provider_singleton = BuiltinCredentialProvider(settings.credential_master_key)
    return _provider_singleton


async def set_secret(pool: asyncpg.Pool, key: str, plaintext: str) -> None:
    """Encrypt and upsert a platform secret."""
    ciphertext = _provider().encrypt(_PLATFORM_TENANT, plaintext)
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO platform_secrets (key, ciphertext, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (key) DO UPDATE SET ciphertext = $2, updated_at = NOW()
            """,
            key,
            ciphertext,
        )


async def get_secret(pool: asyncpg.Pool, key: str) -> str | None:
    """Decrypt and return the plaintext secret, or None if not set."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT ciphertext FROM platform_secrets WHERE key = $1",
            key,
        )
    if row is None:
        return None
    return _provider().decrypt(_PLATFORM_TENANT, bytes(row["ciphertext"]))


async def delete_secret(pool: asyncpg.Pool, key: str) -> bool:
    """Delete a platform secret. Returns True if a row was removed."""
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM platform_secrets WHERE key = $1",
            key,
        )
    return result.endswith(" 1")


async def list_secrets(pool: asyncpg.Pool) -> list[dict]:
    """List configured secrets (no values). Returns key + updated_at."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT key, updated_at FROM platform_secrets ORDER BY key"
        )
    return [{"key": r["key"], "updated_at": r["updated_at"].isoformat()} for r in rows]
