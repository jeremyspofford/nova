"""Nova built-in tools: secret management for autonomous workflows."""
import logging
from ..registry import tool, Tier
from ..context import ToolContext
from ...config import settings
from ...secrets import store as secrets_store

logger = logging.getLogger(__name__)


@tool(tier=Tier.MUTATE, cap_scope="nova.secrets:write:{name}", timeout_s=10, name="nova.secrets.write")
async def secrets_write(name: str, value: str, purpose: str = "", *, ctx: ToolContext) -> dict:
    """Save a credential, password, or token by name so it can be retrieved later.

    Use this whenever you create an account or generate a password —
    store it immediately so you can log back in later.
    name must be lowercase letters, digits, and underscores (e.g. reddit_password).
    """
    if not settings.credential_master_key:
        return {"error": "CREDENTIAL_MASTER_KEY not configured — secrets unavailable"}
    try:
        await secrets_store.set_secret(
            ctx.pool, name, value, purpose or None, settings.credential_master_key
        )
        return {"ok": True, "name": name}
    except ValueError as exc:
        return {"error": str(exc)}
    except Exception as exc:
        logger.warning("nova.secrets.write failed name=%s: %s", name, exc)
        return {"error": str(exc)}


@tool(tier=Tier.READ, cap_scope="nova.secrets:read:{name}", timeout_s=10, name="nova.secrets.read")
async def secrets_read(name: str, *, ctx: ToolContext) -> dict:
    """Retrieve a previously stored credential by name."""
    if not settings.credential_master_key:
        return {"error": "CREDENTIAL_MASTER_KEY not configured — secrets unavailable"}
    try:
        value = await secrets_store.get_secret(
            ctx.pool, name, settings.credential_master_key
        )
    except Exception as exc:
        logger.warning("nova.secrets.read failed name=%s: %s", name, exc)
        return {"error": str(exc)}
    if value is None:
        return {"error": f"Secret '{name}' not found"}
    return {"name": name, "value": value}
