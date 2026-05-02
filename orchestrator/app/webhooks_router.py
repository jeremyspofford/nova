"""GitHub webhook receiver and management endpoints."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
from typing import List
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from app.auth import AdminDep
from app.db import get_pool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/webhooks", tags=["webhooks"])


# ── Admin management endpoints ────────────────────────────────────────────────

class WebhookRegisterRequest(BaseModel):
    repo: str
    target_url: str
    credential_id: UUID
    events: List[str] = ["workflow_run"]
    api_base: str | None = None  # admin-only test seam — points at fake-github in tests


class WebhookUnregisterRequest(BaseModel):
    repo: str
    api_base: str | None = None  # admin-only test seam


@router.post("/github/register", status_code=201)
async def register_webhook(
    body: WebhookRegisterRequest,
    _admin: AdminDep,
):
    """Create a webhook on GitHub and persist the row. Admin-only.

    api_base override is for tests pointing at fake-github.
    Production callers should omit api_base.
    """
    from app.capabilities import credentials as cred_db
    from app.config import settings

    pool = get_pool()
    secret = await cred_db.get_secret(
        pool,
        tenant_id=UUID("00000000-0000-0000-0000-000000000001"),
        cred_id=body.credential_id,
        actor="admin",
    )
    if not secret:
        raise HTTPException(status_code=422, detail="credential not found or has no secret")

    from app.tools.github_external_tools import _register_webhook

    api_base = body.api_base or settings.github_api_base_url
    result = await _register_webhook(
        {
            "repo": body.repo,
            "target_url": body.target_url,
            "credential_id": str(body.credential_id),
            "events": body.events,
        },
        secret=secret,
        api_base=api_base,
    )
    return result


@router.delete("/github/{hook_id}", status_code=200)
async def unregister_webhook(
    hook_id: int,
    body: WebhookUnregisterRequest,
    _admin: AdminDep,
):
    """Delete a webhook from GitHub and mark the DB row revoked. Admin-only."""
    from app.capabilities import credentials as cred_db
    from app.config import settings

    pool = get_pool()
    # Look up credential_id from the hook row
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT credential_id FROM github_webhooks WHERE hook_id=$1", hook_id
        )
    if not row:
        raise HTTPException(status_code=404, detail="webhook not found")

    secret = await cred_db.get_secret(
        pool,
        tenant_id=UUID("00000000-0000-0000-0000-000000000001"),
        cred_id=row["credential_id"],
        actor="admin",
    )

    from app.tools.github_external_tools import _unregister_webhook

    api_base = body.api_base or settings.github_api_base_url
    result = await _unregister_webhook(
        {"repo": body.repo, "hook_id": hook_id},
        secret=secret or "",
        api_base=api_base,
    )
    return result


@router.post("/github")
async def github_webhook(
    request: Request,
    x_github_event: str = Header(...),
    x_hub_signature_256: str = Header(...),
):
    """Receive a GitHub webhook event. Validates HMAC and dispatches.

    For v1: handles 'ping' (verify hook) and 'workflow_run' (failure → cortex stimulus stub).
    Revoked hooks are explicitly rejected to prevent replay attacks against deprovisioned rows.
    """
    body = await request.body()
    pool = get_pool()

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, encrypted_secret, repo, tenant_id, credential_id, status "
            "FROM github_webhooks WHERE status IN ('active','verified','pending')"
        )

    if not rows:
        raise HTTPException(status_code=401, detail="no registered webhooks matched")

    from app.capabilities import credentials as cred_db

    matching_hook = None
    for row in rows:
        try:
            decrypted = cred_db._decrypt(row["credential_id"], bytes(row["encrypted_secret"]))
        except Exception as exc:
            logger.warning("failed to decrypt webhook secret for hook %s: %s", row["id"], exc)
            continue

        expected_sig = "sha256=" + hmac.new(
            decrypted.encode(), body, hashlib.sha256
        ).hexdigest()

        if hmac.compare_digest(expected_sig, x_hub_signature_256):
            matching_hook = row
            break

    if not matching_hook:
        raise HTTPException(status_code=401, detail="signature did not match any registered webhook")

    if x_github_event == "ping":
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE github_webhooks SET status='verified', last_event_at=now() WHERE id=$1",
                matching_hook["id"],
            )
        logger.info("webhook ping verified for repo=%s hook_id=%s", matching_hook["repo"], matching_hook["id"])
        return {"ok": True, "status": "verified"}

    if x_github_event == "workflow_run":
        payload = json.loads(body)
        wfr = payload.get("workflow_run", {})
        conclusion = wfr.get("conclusion")
        if conclusion == "failure":
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE github_webhooks SET last_event_at=now() WHERE id=$1",
                    matching_hook["id"],
                )
            from app.stimulus import CI_WORKFLOW_RUN_FAILURE, emit_stimulus
            await emit_stimulus(
                CI_WORKFLOW_RUN_FAILURE,
                payload={
                    "tenant_id": str(matching_hook["tenant_id"]),
                    "credential_id": str(matching_hook["credential_id"]),
                    "repo": matching_hook["repo"],
                    "run_id": wfr.get("id"),
                    "head_sha": wfr.get("head_sha"),
                    "head_branch": wfr.get("head_branch"),
                    "workflow_name": wfr.get("name"),
                    "html_url": wfr.get("html_url"),
                },
            )
            logger.info(
                "workflow_run.failure on repo=%s run_id=%s — cortex stimulus pushed",
                matching_hook["repo"], wfr.get("id"),
            )
        return {"ok": True}

    return {"ok": True, "ignored": x_github_event}
