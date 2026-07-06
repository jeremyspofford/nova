"""Signed decide-links for ntfy action buttons (task #8 milestone C).

A push notification can carry Approve/Deny buttons that POST straight from
the phone's lockscreen to `/api/v1/notify/actions/decide` — no dashboard, no
admin secret on the phone. Authentication is a per-approval HMAC token:

    sig = HMAC_SHA256(action_key, "{approval_id}:{decision}:{exp}")

The key (`notify.action_key`) is random, seeded at first boot like the ntfy
topic, and never leaves the server; each token authorizes exactly one
decision on exactly one approval and expires with it. Buttons are only
attached when `notify.action_base_url` is configured — the operator must
tell Nova what URL their phone can reach the dashboard on (LAN IP or
tailnet name).
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import time

logger = logging.getLogger(__name__)

# Token lifetime — matches the approval row's own 24h expiry.
_TOKEN_TTL_SECONDS = 24 * 3600


def mint_sig(action_key: str, approval_id: str, decision: str, exp: int) -> str:
    """HMAC signature over one (approval, decision, expiry) triple."""
    msg = f"{approval_id}:{decision}:{exp}".encode()
    return hmac.new(action_key.encode(), msg, hashlib.sha256).hexdigest()


def verify_sig(action_key: str, approval_id: str, decision: str, exp: int, sig: str) -> bool:
    """Constant-time verification. False on any mismatch or expiry."""
    if not action_key or not sig:
        return False
    if exp < int(time.time()):
        return False
    expected = mint_sig(action_key, approval_id, decision, exp)
    return hmac.compare_digest(expected, sig)


async def build_decide_actions(approval_id: str, *, kind: str = "consent") -> list[dict] | None:
    """ntfy action buttons for an approval push, or None if not configured.

    kind='consent'    → Approve / Deny
    kind='checkpoint' → Continue / Decline (+ the view button is where the
                        operator goes when they need to type a reply instead)
    """
    from app.notifier import get_notify_config

    try:
        conf = await get_notify_config()
        base = (conf.get("action_base_url") or "").rstrip("/")
        key = conf.get("action_key") or ""
        if not base or not key:
            return None

        exp = int(time.time()) + _TOKEN_TTL_SECONDS
        labels = ("Continue", "Decline") if kind == "checkpoint" else ("Approve", "Deny")

        def _url(decision: str) -> str:
            sig = mint_sig(key, approval_id, decision, exp)
            return (
                f"{base}/api/v1/notify/actions/decide"
                f"?approval_id={approval_id}&decision={decision}&exp={exp}&sig={sig}"
            )

        return [
            {"action": "http", "label": labels[0], "url": _url("approve"),
             "method": "POST", "clear": True},
            {"action": "http", "label": labels[1], "url": _url("reject"),
             "method": "POST", "clear": True},
            {"action": "view", "label": "Open", "url": base},
        ]
    except Exception as e:
        logger.warning("notify actions: could not build decide buttons: %s", e)
        return None
