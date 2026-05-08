"""Admin API for feature flags.

Mounted at `/api/v1/feature-flags`. All endpoints require admin auth via
`require_admin` (which itself accepts X-Admin-Secret, JWT-with-is_admin,
or trusted-network bypass — see app/auth.py).

Per security blocker S3: PATCH on a hardcoded set of catastrophic flag
keys requires a `confirm: <flag-key>` field in the body matching the URL
key. The dashboard surfaces this as a second-modal confirmation; here
we enforce it server-side so a CLI user can't bypass the modal.

Per security blocker S1: every successful PATCH / DELETE captures
actor_ip, actor_user_agent, and request_id from the FastAPI Request
into the feature_flag_audit row.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

# Force-import flag-registering modules at startup so their register_flag()
# calls fire and the GET /registry endpoint reflects the full orchestrator
# slice of declared flags. Lazy imports (e.g. pipeline agents only loaded
# when a task hits that stage) wouldn't otherwise appear in the registry
# until the first task ran. Tool modules under app.tools are imported by
# the tool registry, so their flags already register; the pipeline agents
# need this explicit nudge.
import app.pipeline.agents.guardrail  # noqa: F401  — registers pipeline.guardrail_strict_mode
import app.tools.web_tools  # noqa: F401  — registers pipeline.web_fetch_strict_sanitize
from app.auth import AdminDep
from app.db import get_pool
from app.feature_flags_store import (
    delete_override,
    get_override,
    list_audit,
    list_overrides,
    upsert_override,
)
from fastapi import APIRouter, HTTPException, Request
from nova_contracts.feature_flags import declared_flags, register_flag
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/feature-flags", tags=["feature-flags"])


# ---------------------------------------------------------------------------
# Critical-flag confirm gate (security blocker S3)
#
# A subset of flags would be catastrophic if flipped accidentally — kill
# switches that disable memory ingestion, the cortex thinking loop, the
# pipeline guardrail, etc. PATCHing one of these requires the request
# body to include `confirm: <key>` matching the URL key. Phase 2 RBAC
# replaces this with proper criticality + role-gated writes.
# ---------------------------------------------------------------------------

CRITICAL_FLAGS: frozenset[str] = frozenset({
    "kill.engram.ingestion",
    "kill.consolidation.cycle",
    "kill.cortex.thinking_loop",
    "pipeline.guardrail_strict_mode",
    "pipeline.web_fetch_strict_sanitize",
})


# ---------------------------------------------------------------------------
# Public flags allowlist
#
# Flags safe to expose to unauthenticated browser clients. Fail-closed:
# anything not in this set is invisible to the public endpoint regardless
# of override state. Kept tiny on purpose — adding here is a security
# decision, not a feature decision.
# ---------------------------------------------------------------------------

PUBLIC_FLAGS: frozenset[str] = frozenset({
    "ui.surface_preset",
})


# ---------------------------------------------------------------------------
# UI surface preset (capability gate, not a kill-switch)
#
# The dashboard reads this via GET /public to decide which nav items to show.
# Default chat_only collapses Nova to a chat-first product surface; admins
# can flip to standard or advanced from Settings → System → Feature Flags.
# ---------------------------------------------------------------------------

UI_SURFACE_PRESET = register_flag(
    key="ui.surface_preset",
    type="enum",
    variants=("chat_only", "standard", "advanced"),
    default="chat_only",
    description=(
        "Coarse-grained dashboard surface visibility. chat_only shows just "
        "the chat-first surface; standard adds knowledge and tasks; advanced "
        "exposes everything including admin internals (Pods, AI Quality, "
        "Audit Log)."
    ),
)


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class PatchFlagBody(BaseModel):
    """PATCH body: the new override value plus optional metadata.

    `confirm` is required for keys in CRITICAL_FLAGS; ignored otherwise.
    """

    value: Any
    notes: str | None = None
    confirm: str | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _request_metadata(request: Request) -> dict[str, Any]:
    """Extract IP, User-Agent, and request_id from the FastAPI Request for
    audit-row attribution (S1)."""
    client_ip = request.client.host if request.client else None
    user_agent = request.headers.get("user-agent")
    # Honor an inbound X-Request-ID if present (e.g. from upstream proxy);
    # otherwise mint a UUID4 so the audit row has a unique identifier even
    # for same-IP same-instant requests.
    inbound = request.headers.get("x-request-id")
    if inbound:
        try:
            request_id = str(uuid.UUID(inbound))
        except ValueError:
            request_id = str(uuid.uuid4())
    else:
        request_id = str(uuid.uuid4())
    return {"ip": client_ip, "user_agent": user_agent, "request_id": request_id}


def _serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    """Convert datetime / UUID / IP types in a DB row to JSON-serializable shapes."""
    out: dict[str, Any] = {}
    for k, v in row.items():
        if v is None:
            out[k] = None
        elif hasattr(v, "isoformat"):  # datetime
            out[k] = v.isoformat()
        elif isinstance(v, uuid.UUID):
            out[k] = str(v)
        else:
            out[k] = v if not hasattr(v, "compressed") else str(v)  # IPv4Address etc.
    return out


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/registry")
async def get_registry(_: AdminDep) -> list[dict[str, Any]]:
    """Return every flag declared by `register_flag()` in the orchestrator
    process. Note: this is the orchestrator's slice only; other services'
    registries reach the admin via `POST /registry/announce` (B-Task 6
    follow-up)."""
    return [
        {
            "key": f.key,
            "type": f.type,
            "variants": list(f.variants) if f.variants else None,
            "default": f.default,
            "description": f.description,
        }
        for f in declared_flags()
    ]


@router.get("/")
async def list_flags(_: AdminDep) -> list[dict[str, Any]]:
    """Joined view: every declared flag plus its current override (if any).

    Returns one row per declared flag with `current_value` set to the
    override if one exists, else the in-code default. Plus `is_override`
    so the UI can render a "Default" vs "Overridden" badge."""
    pool = get_pool()
    overrides = await list_overrides(pool)
    by_key = {o["key"]: o for o in overrides}
    out: list[dict[str, Any]] = []
    for flag in declared_flags():
        override = by_key.get(flag.key)
        if override is not None:
            out.append({
                "key": flag.key,
                "type": flag.type,
                "variants": list(flag.variants) if flag.variants else None,
                "default": flag.default,
                "current_value": override["value"],
                "is_override": True,
                "set_by": override["set_by"],
                "set_at": override["set_at"].isoformat() if override["set_at"] else None,
                "notes": override["notes"],
            })
        else:
            out.append({
                "key": flag.key,
                "type": flag.type,
                "variants": list(flag.variants) if flag.variants else None,
                "default": flag.default,
                "current_value": flag.default,
                "is_override": False,
                "set_by": None,
                "set_at": None,
                "notes": None,
            })
    # Include orphan overrides (rows in DB whose flag isn't currently
    # declared in the orchestrator's process — e.g. a flag declared in
    # memory-service whose registry hasn't been announced yet). The UI
    # will mark these as "unknown declaration" so operators can clean up
    # stale rows.
    declared_keys = {f.key for f in declared_flags()}
    for override in overrides:
        if override["key"] not in declared_keys:
            out.append({
                "key": override["key"],
                "type": None,
                "variants": None,
                "default": None,
                "current_value": override["value"],
                "is_override": True,
                "is_orphan": True,
                "set_by": override["set_by"],
                "set_at": override["set_at"].isoformat() if override["set_at"] else None,
                "notes": override["notes"],
            })
    return out


@router.get("/audit")
async def get_audit_recent(
    _: AdminDep,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Recent audit entries across all flags. Newest first."""
    pool = get_pool()
    rows = await list_audit(pool, limit=min(max(limit, 1), 500))
    return [_serialize_row(r) for r in rows]


@router.get("/public")
async def get_public_flags() -> dict[str, Any]:
    """Return the current values of allowlisted flags. No auth.

    Used by the dashboard to decide UI surface visibility. The browser
    cannot pass admin credentials safely, so this endpoint exposes a
    deliberately tiny, audited subset.
    """
    pool = get_pool()
    overrides = await list_overrides(pool)
    by_key = {o["key"]: o["value"] for o in overrides}
    out: dict[str, Any] = {}
    for flag in declared_flags():
        if flag.key not in PUBLIC_FLAGS:
            continue
        out[flag.key] = by_key.get(flag.key, flag.default)
    return out


@router.get("/{key}")
async def get_flag_detail(
    key: str,
    _: AdminDep,
) -> dict[str, Any]:
    """Single-flag detail: in-process declaration + DB override (if any)."""
    declared = next((f for f in declared_flags() if f.key == key), None)
    pool = get_pool()
    override = await get_override(pool, key)
    if declared is None and override is None:
        raise HTTPException(status_code=404, detail=f"flag {key!r} not found")
    return {
        "key": key,
        "type": declared.type if declared else None,
        "variants": list(declared.variants) if declared and declared.variants else None,
        "default": declared.default if declared else None,
        "description": declared.description if declared else None,
        "is_override": override is not None,
        "current_value": override["value"] if override else (declared.default if declared else None),
        "set_by": override["set_by"] if override else None,
        "set_at": override["set_at"].isoformat() if override and override["set_at"] else None,
        "notes": override["notes"] if override else None,
    }


@router.get("/{key}/audit")
async def get_flag_audit(
    key: str,
    _: AdminDep,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Audit history for one flag. Newest first."""
    pool = get_pool()
    rows = await list_audit(pool, key=key, limit=min(max(limit, 1), 500))
    return [_serialize_row(r) for r in rows]


@router.patch("/{key}")
async def patch_flag(
    key: str,
    body: PatchFlagBody,
    request: Request,
    _: AdminDep,
) -> dict[str, Any]:
    """Set or update a flag override.

    Validation order:
      1. Critical-flag confirm gate (S3): if `key` is in CRITICAL_FLAGS,
         body.confirm MUST equal key.
      2. Variant validation: if the flag is declared and is enum-typed,
         body.value MUST be in declared variants.
      3. Type validation: bool flags accept only bool values.

    On success: writes the override + audit row in a single transaction
    and publishes invalidation. Returns the new row."""
    # S3: critical-flag confirm gate
    if key in CRITICAL_FLAGS and body.confirm != key:
        logger.warning(
            "flag_critical_confirm_missing key=%s actor_ip=%s",
            key, request.client.host if request.client else "unknown",
        )
        raise HTTPException(
            status_code=400,
            detail=(
                f"flag {key!r} is critical; PATCH body must include "
                f"`confirm: {key!r}` to acknowledge"
            ),
        )

    # Variant + type validation against the in-process declaration (if any).
    # An orphan override (DB row whose declaration lives in another service)
    # bypasses this check — the announce-from-other-service path is the
    # source of truth for those.
    declared = next((f for f in declared_flags() if f.key == key), None)
    if declared is not None:
        if declared.type == "bool" and not isinstance(body.value, bool):
            raise HTTPException(
                status_code=400,
                detail=f"flag {key!r} is bool; received {type(body.value).__name__}",
            )
        if declared.type == "enum" and declared.variants is not None:
            if body.value not in declared.variants:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"flag {key!r} value {body.value!r} not in declared "
                        f"variants {list(declared.variants)}"
                    ),
                )

    metadata = _request_metadata(request)
    pool = get_pool()
    row = await upsert_override(
        pool,
        key=key,
        value=body.value,
        actor="admin",  # TODO: replace with authenticated user-id when JWT lands
        notes=body.notes,
        **metadata,
    )
    return _serialize_row(row)


@router.delete("/{key}")
async def delete_flag(
    key: str,
    request: Request,
    _: AdminDep,
) -> dict[str, Any]:
    """Reset a flag to its in-code default by deleting the override row.
    Idempotent — returns `{"deleted": false}` if no override existed."""
    metadata = _request_metadata(request)
    pool = get_pool()
    deleted = await delete_override(
        pool,
        key=key,
        actor="admin",
        **metadata,
    )
    return {"deleted": deleted, "key": key}
