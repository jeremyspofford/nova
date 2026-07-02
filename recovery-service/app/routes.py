"""Recovery service API routes."""

import hmac
import logging
import time
from typing import Any

import jwt as pyjwt
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel

from .backup import (
    create_backup,
    delete_backup,
    list_backups,
    list_checkpoints,
    restore_backup,
)
from .compose_client import start_profiled_service, stop_profiled_service
from .config import settings
from .docker_client import (
    check_container_status,
    get_container_logs,
    list_all_service_status,
    list_service_status,
    restart_all_services,
    restart_service,
)
from .env_manager import (
    add_compose_profile,
    patch_env,
    read_env,
    remove_compose_profile,
)
from .factory_reset import factory_reset, get_categories
from .redis_client import read_config

logger = logging.getLogger("nova.recovery")

router = APIRouter()


# ── Auth ───────────────────────────────────────────────────────────────────────

_jwt_secret: str | None = None
_jwt_secret_fetched_at: float = 0
_JWT_SECRET_TTL = 300  # re-fetch from DB every 5 minutes


# Admin secret cache — reads nova:config:auth.admin_secret from Redis db 1
# (where orchestrator writes it after rotation). Falls back to the env value.
# Escape hatch: `redis-cli -n 1 DEL nova:config:auth.admin_secret` reverts to env.
_ADMIN_SECRET_CACHE_TTL = 30  # seconds
_admin_secret_cache: dict[str, Any] = {"value": None, "ts": 0.0}


async def _get_admin_secret() -> str:
    """Current admin secret — Redis-backed, env fallback, 30s cache."""
    now = time.monotonic()
    if (
        now - _admin_secret_cache["ts"] < _ADMIN_SECRET_CACHE_TTL
        and _admin_secret_cache["value"] is not None
    ):
        return _admin_secret_cache["value"]

    value: str = ""
    try:
        raw = await read_config("auth.admin_secret", default="")
        if raw:
            value = raw
    except Exception:
        logger.debug("Failed to read admin secret from Redis, using env fallback")

    if not value:
        value = settings.admin_secret

    _admin_secret_cache["value"] = value
    _admin_secret_cache["ts"] = now
    return value


async def _get_jwt_secret() -> str | None:
    """Fetch JWT secret from platform_config, cached with 5-minute TTL."""
    global _jwt_secret, _jwt_secret_fetched_at
    if _jwt_secret is not None and (time.monotonic() - _jwt_secret_fetched_at) < _JWT_SECRET_TTL:
        return _jwt_secret
    try:
        from .db import get_pool
        pool = get_pool()
        async with pool.acquire() as conn:
            value = await conn.fetchval(
                "SELECT value #>> '{}' FROM platform_config WHERE key = 'auth.jwt_secret'"
            )
            if value and value.strip('"'):
                _jwt_secret = value.strip('"')
                _jwt_secret_fetched_at = time.monotonic()
                return _jwt_secret
    except Exception:
        logger.debug("Could not fetch JWT secret from platform_config")
    return None


def _verify_admin_jwt(token: str, secret: str) -> bool:
    """Decode JWT and check it belongs to an admin user."""
    try:
        payload = pyjwt.decode(token, secret, algorithms=["HS256"])
        if payload.get("type") != "access":
            return False
        return bool(payload.get("is_admin"))
    except pyjwt.PyJWTError:
        return False


async def _check_admin(
    request: Request,
    authorization: str = Header(default=""),
    x_admin_secret: str = Header(default=""),
):
    """Validate admin access. Accepts trusted network, JWT Bearer, or X-Admin-Secret.

    The trusted-network bypass is symmetric with the orchestrator and the other
    internal services (memory, cortex, llm-gateway). It's required so that
    dashboard sessions opened via the orchestrator's trusted-network bypass —
    which never mint a JWT — can still reach recovery's admin endpoints from
    loopback / Docker bridge / LAN / Tailscale.
    """
    # Trusted network bypass — set by TrustedNetworkMiddleware in main.py
    if getattr(request.state, "is_trusted_network", False):
        return

    # Admin secret (Redis-backed for runtime rotation, env fallback).
    # Constant-time comparison defeats timing attacks on the secret.
    if x_admin_secret:
        expected = await _get_admin_secret()
        if expected and hmac.compare_digest(x_admin_secret, expected):
            return

    # JWT Bearer token (issued by orchestrator on real login)
    if authorization and authorization.startswith("Bearer "):
        secret = await _get_jwt_secret()
        if secret and _verify_admin_jwt(authorization[7:], secret):
            return

    raise HTTPException(401, "Admin authentication required")


async def _check_admin_strict(
    request: Request,
    authorization: str = Header(default=""),
    x_admin_secret: str = Header(default=""),
):
    """Admin check for destructive endpoints (factory reset, restore, backup
    delete). Deliberately does NOT honor the trusted-network bypass: being on
    localhost/LAN must not be enough to wipe the database. Anything running on
    the host (scripts, test suites, other containers) reaches recovery over a
    trusted network, and a data wipe is not a recoverable mistake — explicit
    admin credentials are required every time.
    """
    if x_admin_secret:
        expected = await _get_admin_secret()
        if expected and hmac.compare_digest(x_admin_secret, expected):
            return

    if authorization and authorization.startswith("Bearer "):
        secret = await _get_jwt_secret()
        if secret and _verify_admin_jwt(authorization[7:], secret):
            return

    raise HTTPException(
        401,
        "Explicit admin credentials required for destructive operations "
        "(trusted-network access is not sufficient)",
    )


# ── Health ─────────────────────────────────────────────────────────────────────

@router.get("/health/live")
async def health_live():
    return {"status": "ok", "service": "recovery"}


@router.get("/health/ready")
async def health_ready():
    from .db import get_pool
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return {"status": "ok", "db": "connected"}
    except Exception as e:
        return {"status": "degraded", "db": str(e)}


# ── Overview / Dashboard ───────────────────────────────────────────────────────

@router.get("/api/v1/recovery/status")
async def get_overview():
    """Rich status overview: service health, DB stats, backup info."""
    from .db import get_pool

    services = list_service_status()
    backups = list_backups()

    up = sum(1 for s in services if s["status"] == "running" and s["health"] in ("healthy", "none"))
    down = sum(1 for s in services if s["status"] != "running" or s["health"] not in ("healthy", "none", "unknown"))
    total = len(services)

    # DB stats
    db_info: dict = {}
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            db_size = await conn.fetchval(
                "SELECT pg_size_pretty(pg_database_size(current_database()))"
            )
            table_count = await conn.fetchval(
                "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"
            )
            db_info = {"connected": True, "size": db_size, "table_count": table_count}
    except Exception as e:
        db_info = {"connected": False, "error": str(e)}

    return {
        "services": {
            "up": up,
            "down": down,
            "total": total,
            "details": services,
        },
        "database": db_info,
        "backups": {
            "count": len(backups),
            "latest": backups[0] if backups else None,
            "total_size_bytes": sum(b["size_bytes"] for b in backups),
        },
    }


# ── Service Status ─────────────────────────────────────────────────────────────

@router.get("/api/v1/recovery/services")
async def get_services():
    """List all Nova service containers and their status."""
    return list_service_status()


@router.get("/api/v1/recovery/services/all")
async def get_all_services():
    """All core + optional services with ports and profile info."""
    return list_all_service_status()


@router.post("/api/v1/recovery/services/{service_name}/restart")
async def restart_service_endpoint(
    service_name: str,
    _: None = Depends(_check_admin),
):
    result = restart_service(service_name)
    if not result["ok"]:
        raise HTTPException(400, result.get("error", "Restart failed"))
    return result


@router.post("/api/v1/recovery/services/restart-all")
async def restart_all_endpoint(_: None = Depends(_check_admin)):
    return restart_all_services()


# ── Backups ────────────────────────────────────────────────────────────────────

@router.get("/api/v1/recovery/backups")
async def get_backups():
    """List available backups."""
    return list_backups()


@router.post("/api/v1/recovery/backups")
async def create_backup_endpoint(_: None = Depends(_check_admin)):
    """Create a new backup."""
    try:
        return await create_backup()
    except RuntimeError as e:
        raise HTTPException(500, str(e))


@router.post("/api/v1/recovery/backups/{filename}/restore")
async def restore_backup_endpoint(
    filename: str,
    _: None = Depends(_check_admin_strict),
):
    """Restore from a specific backup."""
    try:
        return await restore_backup(filename)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))


@router.delete("/api/v1/recovery/backups/{filename}")
async def delete_backup_endpoint(
    filename: str,
    _: None = Depends(_check_admin_strict),
):
    """Delete a specific backup."""
    try:
        return delete_backup(filename)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(400, str(e))


# ── Factory Reset ──────────────────────────────────────────────────────────────

@router.get("/api/v1/recovery/factory-reset/categories")
async def get_reset_categories():
    """List data categories available for factory reset."""
    return get_categories()


# ── Env Management ────────────────────────────────────────────────────────────

@router.get("/api/v1/recovery/env")
async def get_env_vars(_: None = Depends(_check_admin)):
    """Read whitelisted env vars (secrets masked)."""
    return read_env()


class EnvPatchRequest(BaseModel):
    updates: dict[str, str]


@router.patch("/api/v1/recovery/env")
async def patch_env_vars(
    req: EnvPatchRequest,
    _: None = Depends(_check_admin),
):
    """Update .env keys (whitelist enforced)."""
    try:
        return patch_env(req.updates)
    except ValueError as e:
        raise HTTPException(400, str(e))


# ── Compose Profiles ─────────────────────────────────────────────────────────

PROFILE_MAP = {
    "cloudflare-tunnel": "cloudflared",
    "tailscale": "tailscale",
    "editor-vscode": "editor-vscode",
    "editor-neovim": "editor-neovim",
    # No inference profiles — local inference is external/user-run, not a
    # bundled compose service the dashboard can start/stop.
}


class ComposeProfileRequest(BaseModel):
    profile: str
    action: str  # "start" or "stop"


@router.post("/api/v1/recovery/compose-profiles")
async def manage_compose_profile(
    req: ComposeProfileRequest,
    _: None = Depends(_check_admin),
):
    """Add/remove a compose profile and start/stop its service."""
    if req.profile not in PROFILE_MAP:
        raise HTTPException(400, f"Unknown profile: {req.profile}. Valid: {list(PROFILE_MAP.keys())}")

    service = PROFILE_MAP[req.profile]
    if req.action == "start":
        add_compose_profile(req.profile)
        result = await start_profiled_service(req.profile, service)
    elif req.action == "stop":
        result = await stop_profiled_service(req.profile, service)
        remove_compose_profile(req.profile)
    else:
        raise HTTPException(400, "action must be 'start' or 'stop'")

    if not result["ok"]:
        raise HTTPException(500, result.get("error", "Compose operation failed"))
    return {"profile": req.profile, "service": service, "action": req.action, **result}


# ── Remote Access Status ─────────────────────────────────────────────────────

@router.get("/api/v1/recovery/remote-access/status")
async def get_remote_access_status(_: None = Depends(_check_admin)):
    """Container + config status for Cloudflare Tunnel and Tailscale."""
    env = read_env()
    cf_status = check_container_status("cloudflared")
    ts_status = check_container_status("tailscale")

    return {
        "cloudflare": {
            "configured": bool(env.get("CLOUDFLARE_TUNNEL_TOKEN")),
            "container": cf_status,
        },
        "tailscale": {
            "configured": bool(env.get("TAILSCALE_AUTHKEY")),
            "container": ts_status,
        },
    }


# ── Diagnostics ────────────────────────────────────────────────────────────────

@router.get("/api/v1/recovery/diagnostics")
async def get_diagnostics(_: None = Depends(_check_admin)):
    """Aggregated diagnostics for AI troubleshooting: service health, logs, DB status."""
    import re

    from .db import get_pool

    services = list_service_status()
    checkpoints = list_checkpoints()

    # Collect logs from unhealthy/down services
    service_logs: dict[str, str] = {}
    for svc in services:
        if svc["status"] != "running" or svc["health"] not in ("healthy", "none"):
            service_logs[svc["service"]] = get_container_logs(svc["service"], tail=50)

    # DB connectivity
    db_info: dict = {}
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            db_size = await conn.fetchval(
                "SELECT pg_size_pretty(pg_database_size(current_database()))"
            )
            db_info = {"connected": True, "size": db_size}
    except Exception as e:
        db_info = {"connected": False, "error": str(e)}

    # Extract error patterns from logs
    error_patterns: list[str] = []
    for svc_name, logs in service_logs.items():
        for line in logs.splitlines()[-50:]:
            if re.search(r"(?i)(error|exception|traceback|fatal|panic|crash)", line):
                error_patterns.append(f"[{svc_name}] {line.strip()[-200:]}")

    return {
        "services": services,
        "service_logs": service_logs,
        "database": db_info,
        "checkpoints": {
            "count": len(checkpoints),
            "latest": checkpoints[0] if checkpoints else None,
        },
        "error_patterns": error_patterns[:30],
    }


# ── Troubleshoot ──────────────────────────────────────────────────────────────

from .troubleshoot import TroubleshootRequest, troubleshoot_chat


@router.post("/api/v1/recovery/troubleshoot/chat")
async def troubleshoot_endpoint(
    req: TroubleshootRequest,
    _: None = Depends(_check_admin),
):
    """AI-powered troubleshooting chat — calls an external LLM directly."""
    return await troubleshoot_chat(req)


# ── Factory Reset ──────────────────────────────────────────────────────────────

class FactoryResetRequest(BaseModel):
    keep: list[str] = []
    confirm: str  # Must be "RESET" to proceed


@router.post("/api/v1/recovery/factory-reset")
async def factory_reset_endpoint(
    req: FactoryResetRequest,
    _: None = Depends(_check_admin_strict),
):
    """Factory reset — wipe data categories not in the 'keep' list.

    Always takes a safety backup first; the reset aborts if the backup fails.
    """
    if req.confirm != "RESET":
        raise HTTPException(400, "Confirmation required: set confirm to 'RESET'")
    try:
        safety_backup = await create_backup()
    except Exception as e:
        raise HTTPException(
            500, f"Aborted: safety backup before reset failed: {e}"
        )
    result = await factory_reset(keep=set(req.keep))
    result["safety_backup"] = safety_backup
    return result
