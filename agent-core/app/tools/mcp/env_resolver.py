"""Resolve MCP server env dicts: expand ${secret:name} refs, block sensitive keys."""
import os
import re
import logging

from app.secrets.store import get_secret
from app.config import settings

logger = logging.getLogger(__name__)

_SECRET_PATTERN = re.compile(r"^\$\{secret:([a-z][a-z0-9_]*)\}$")

# Keys that must never be passed through to MCP subprocess environments.
_BLOCKED_KEYS = frozenset({
    "CREDENTIAL_MASTER_KEY",
    "DATABASE_URL",
    "REDIS_URL",
    "NOVA_ADMIN_SECRET",
})


async def resolve_env(raw_env: dict, pool) -> dict:
    """Resolve an MCP server env dict.

    - Drops any key in _BLOCKED_KEYS.
    - Expands values matching ``${secret:name}`` to plaintext via the secrets store.
    - Passes all other values through unchanged.
    """
    resolved: dict[str, str] = {}
    for key, value in raw_env.items():
        if key in _BLOCKED_KEYS:
            logger.warning("env_resolver: blocked key %r stripped from MCP env", key)
            continue
        if isinstance(value, str):
            m = _SECRET_PATTERN.match(value)
            if m:
                secret_name = m.group(1)
                plaintext = await get_secret(pool, secret_name, settings.credential_master_key)
                if plaintext is None:
                    raise RuntimeError(
                        f"Cannot resolve ${{secret:{secret_name}}} — secret not found. "
                        f"Add it via Dashboard -> Settings -> Secrets."
                    )
                resolved[key] = plaintext
                continue
        resolved[key] = value

    # Always inject basic process-level env vars so subprocesses can find
    # executables (PATH), home directory (HOME), and temp storage (TMPDIR/TMP/TEMP).
    _ALWAYS_PASS = ("PATH", "HOME", "TMPDIR", "TMP", "TEMP")
    for var in _ALWAYS_PASS:
        val = os.environ.get(var)
        if val is not None:
            resolved[var] = val

    return resolved
