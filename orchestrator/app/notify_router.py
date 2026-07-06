"""Notify API — config readout + test-send for the push channel (ntfy).

Values are edited through the generic platform-config endpoints; this router
only aggregates what the Settings UI needs and provides the test button.
"""
from __future__ import annotations

import logging

from app.auth import AdminDep
from app.notifier import _invalidate_conf_cache, get_notify_config, notify
from fastapi import APIRouter

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
    }


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
