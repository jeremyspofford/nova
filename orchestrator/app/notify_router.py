"""Notify API — config readout, test-send, and signed lockscreen actions.

Values are edited through the generic platform-config endpoints; this router
aggregates what the Settings UI needs, provides the test button, and hosts
the token-authenticated decide endpoint that ntfy action buttons POST to.
"""
from __future__ import annotations

import logging
from typing import Literal
from uuid import UUID

from app.auth import AdminDep
from app.notifier import _invalidate_conf_cache, get_notify_config, notify
from fastapi import APIRouter, HTTPException, Query

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/notify", tags=["notify"])


@router.get("/config")
async def notify_config(_: AdminDep):
    """Current push-notification config (topic is the subscription secret)."""
    _invalidate_conf_cache()  # settings page should always see fresh values
    conf = await get_notify_config()
    return {
        "enabled": conf["enabled"],
        "server_url": conf["url"],
        "topic": conf["topic"],
        # Host-published ntfy port (compose NTFY_BIND) — what a phone on the
        # same network subscribes to. Shown as guidance in Settings.
        "subscribe_hint": "http://<this-host>:8290/" + (conf["topic"] or "<topic>"),
        # Lockscreen decide buttons: set to the dashboard URL your phone can
        # reach (LAN IP / tailnet). Empty = buttons disabled.
        "action_base_url": conf["action_base_url"],
    }


@router.post("/actions/decide")
async def notify_action_decide(
    approval_id: UUID,
    decision: Literal["approve", "reject"],
    exp: int,
    sig: str = Query(min_length=64, max_length=64),
):
    """Decide an approval from a push-notification action button.

    Deliberately NO admin/API auth: the HMAC `sig` minted by
    notify_actions.build_decide_actions IS the credential — scoped to one
    approval, one decision, and an expiry. The signing key never leaves the
    server, so a valid signature proves the link came from a push we sent.
    """
    from app.capabilities.consent import ApprovalDecision, decide_approval
    from app.db import get_pool
    from app.notify_actions import verify_sig

    conf = await get_notify_config()
    if not verify_sig(conf["action_key"], str(approval_id), decision, exp, sig):
        # Covers bad key, tampered params, AND expired tokens — one opaque
        # answer so probes learn nothing.
        raise HTTPException(status_code=403, detail="invalid or expired action token")

    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT tenant_id, status FROM approval_requests WHERE id=$1",
            approval_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="approval not found")
    if row["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"already {row['status']}")

    ok = await decide_approval(
        pool,
        tenant_id=row["tenant_id"],
        approval_id=approval_id,
        decision=ApprovalDecision(
            decision=decision,
            decided_by="operator",
            decided_via="ntfy",
        ),
    )
    if not ok:
        raise HTTPException(status_code=409, detail="approval no longer pending")

    logger.info("notify action: approval %s %sd via ntfy button", approval_id, decision)
    return {"status": "ok", "decision": decision}


@router.post("/test")
async def notify_test(_: AdminDep):
    """Send a test notification to the configured topic."""
    sent = await notify(
        "test",
        title="Nova test notification",
        message="Push notifications are working. This is where approvals, "
                "checkpoints, and finished goal work will arrive.",
    )
    return {"sent": sent}
