# agent-core/app/secrets/store.py
import re
from typing import Any

import asyncpg

from .crypto import decrypt, encrypt

SECRET_RE = re.compile(r"^\$\{secret:(?P<name>[a-z][a-z0-9_]*)\}$")


def _validate_name(name: str) -> None:
    if not re.fullmatch(r"[a-z][a-z0-9_]*", name):
        raise ValueError(
            f"Invalid secret name '{name}': must be lowercase letters/digits/underscore, "
            "start with a letter"
        )


async def get_secret(pool: asyncpg.Pool, name: str, master_key_hex: str) -> str | None:
    """Fetch, decrypt, and return a secret value. Updates last_used + used_count."""
    row = await pool.fetchrow(
        "SELECT ciphertext, nonce FROM secrets WHERE name = $1", name
    )
    if not row:
        return None
    await pool.execute(
        "UPDATE secrets SET last_used = now(), used_count = used_count + 1 WHERE name = $1",
        name,
    )
    return decrypt(bytes(row["ciphertext"]), bytes(row["nonce"]), name, master_key_hex)


async def secret_exists(pool: asyncpg.Pool, name: str) -> bool:
    """Check if a secret exists by name (no decryption)."""
    row = await pool.fetchrow("SELECT 1 FROM secrets WHERE name = $1", name)
    return row is not None


async def set_secret(
    pool: asyncpg.Pool,
    name: str,
    value: str,
    purpose: str | None,
    master_key_hex: str,
) -> None:
    """Create or replace a secret (upsert by name)."""
    _validate_name(name)
    ciphertext, nonce = encrypt(value, name, master_key_hex)
    await pool.execute(
        """
        INSERT INTO secrets (name, ciphertext, nonce, purpose)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (name) DO UPDATE
            SET ciphertext = EXCLUDED.ciphertext,
                nonce      = EXCLUDED.nonce,
                purpose    = COALESCE(EXCLUDED.purpose, secrets.purpose),
                updated_at = now()
        """,
        name,
        ciphertext,
        nonce,
        purpose,
    )


async def update_purpose(pool: asyncpg.Pool, name: str, purpose: str) -> bool:
    """Update only the purpose field. Returns False if secret not found."""
    result = await pool.execute(
        "UPDATE secrets SET purpose = $1, updated_at = now() WHERE name = $2",
        purpose,
        name,
    )
    return result != "UPDATE 0"


async def delete_secret(pool: asyncpg.Pool, name: str) -> bool:
    """Delete a secret. Returns True if it existed."""
    result = await pool.execute("DELETE FROM secrets WHERE name = $1", name)
    return result != "DELETE 0"


async def list_secrets(pool: asyncpg.Pool) -> list[dict]:
    """List all secrets without values."""
    rows = await pool.fetch(
        """
        SELECT name, purpose, created_at, updated_at, last_used, used_count
        FROM secrets
        ORDER BY name
        """
    )
    return [dict(row) for row in rows]


async def resolve_refs(
    pool: asyncpg.Pool,
    config: Any,
    master_key_hex: str,
) -> Any:
    """Walk a config structure, resolving ${secret:name} strings to plaintext."""
    if isinstance(config, dict):
        return {k: await resolve_refs(pool, v, master_key_hex) for k, v in config.items()}
    if isinstance(config, list):
        return [await resolve_refs(pool, v, master_key_hex) for v in config]
    if isinstance(config, str) and (m := SECRET_RE.match(config)):
        name = m.group("name")
        value = await get_secret(pool, name, master_key_hex)
        if value is None:
            raise RuntimeError(
                f"Cannot resolve ${{secret:{name}}} — secret not found. "
                f"Add it via Dashboard -> Settings -> Secrets."
            )
        return value
    return config
