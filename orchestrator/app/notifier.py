"""Push notifications to the human via the bundled self-hosted ntfy server.

This is the delivery plane for autonomy: approvals, checkpoints, failures,
and finished goal work reach the operator's phone (ntfy app / web app
subscribed to the topic) instead of rotting in a dashboard tab.

Config (platform_config → UI-editable, read here with a 30s cache):
  notify.enabled     "true"/"false"           default true
  notify.ntfy_url    in-network server URL    default http://ntfy
  notify.ntfy_topic  seeded nova-<hex> at first boot — the topic name is the
                     only subscription secret; treat it like a password.

Design contract: nothing in this module ever raises — a push failure must
never break consent, the pipeline, or a request path. `notify()` returns
False and logs a WARNING instead.
"""
from __future__ import annotations

import logging
import time

import httpx

from .db import get_pool

logger = logging.getLogger(__name__)

# Events worth a phone buzz, with ntfy priority (1 min … 5 max) and tag emoji.
EVENT_PRIORITY: dict[str, int] = {
    "approval_requested": 4,
    "checkpoint_requested": 4,
    "task_failed": 4,
    "pending_human_review": 4,
    "clarification_needed": 4,
    "goal_stuck": 4,
    "task_complete": 3,
    "agent_push": 3,
    "test": 3,
}
EVENT_TAGS: dict[str, str] = {
    "approval_requested": "raised_hand",
    "checkpoint_requested": "raised_hand",
    "task_failed": "rotating_light",
    "pending_human_review": "eyes",
    "clarification_needed": "question",
    "goal_stuck": "warning",
    "task_complete": "white_check_mark",
    "agent_push": "speech_balloon",
    "test": "wave",
}

_conf_cache: dict | None = None
_conf_fetched_at: float = 0.0
_CONF_TTL_SECONDS = 30.0


def _invalidate_conf_cache() -> None:
    """Test/config-change hook."""
    global _conf_cache
    _conf_cache = None


async def get_notify_config() -> dict:
    """Read notify.* from platform_config with a short in-process cache."""
    global _conf_cache, _conf_fetched_at
    now = time.monotonic()
    if _conf_cache is not None and now - _conf_fetched_at < _CONF_TTL_SECONDS:
        return _conf_cache

    conf = {
        "enabled": True, "url": "http://ntfy", "topic": "",
        # Lockscreen decide buttons (milestone C): base URL the phone can
        # reach the dashboard/API on, and the server-side HMAC key that
        # signs each button's one-shot decide link.
        "action_base_url": "", "action_key": "",
    }
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT key, value #>> '{}' AS val FROM platform_config "
                "WHERE key = ANY($1::text[])",
                ["notify.enabled", "notify.ntfy_url", "notify.ntfy_topic",
                 "notify.action_base_url", "notify.action_key"],
            )
        for r in rows:
            val = (r["val"] or "").strip()
            if r["key"] == "notify.enabled" and val:
                conf["enabled"] = val.lower() != "false"
            elif r["key"] == "notify.ntfy_url" and val:
                conf["url"] = val.rstrip("/")
            elif r["key"] == "notify.ntfy_topic" and val:
                conf["topic"] = val
            elif r["key"] == "notify.action_base_url" and val:
                conf["action_base_url"] = val.rstrip("/")
            elif r["key"] == "notify.action_key" and val:
                conf["action_key"] = val
    except Exception as e:
        logger.warning("notify: config read failed (using defaults): %s", e)

    _conf_cache = conf
    _conf_fetched_at = now
    return conf


async def _record_delivery(
    event: str, title: str, ok: bool, detail: str, message: str = "",
    approval_id: str | None = None, task_id: str | None = None,
) -> None:
    """Write one delivery receipt + the message body (best-effort, never raises).

    `ok` means the ntfy server ACCEPTED the publish — actual delivery still
    depends on a device being subscribed. Rows double as the operator's
    in-dashboard Inbox (the message is readable in Nova regardless of
    whether any push client is set up), so record on every attempt,
    including suppressed ones. `approval_id`/`task_id` link the row to the
    item it's about so the Inbox can show live status and a jump link.
    """
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO notify_log (event, title, ok, detail, message, approval_id, task_id) "
                "VALUES ($1, $2, $3, $4, $5, $6::uuid, $7::uuid)",
                event, title[:200], ok, detail[:300], message[:4000],
                approval_id, task_id,
            )
            # Retention: receipts are operational breadcrumbs, not history.
            await conn.execute(
                "DELETE FROM notify_log WHERE created_at < now() - interval '30 days'"
            )
    except Exception as e:
        logger.debug("notify: receipt write failed (non-fatal): %s", e)


async def connected_subscribers() -> int | None:
    """Live subscriber count from ntfy's Prometheus metrics, or None.

    Counts persistent connections (Android app, open web app). iOS clients
    poll instead of holding a connection, so 0 does not strictly prove
    nothing will ever arrive — but on a single-user box it's the honest
    'is anyone actually listening' signal.
    """
    try:
        conf = await get_notify_config()
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{conf['url']}/metrics")
        if resp.status_code != 200:
            return None
        for line in resp.text.splitlines():
            if line.startswith("ntfy_subscribers"):
                return int(float(line.rsplit(None, 1)[-1]))
        return None
    except Exception:
        return None


async def notify(
    event: str,
    title: str,
    message: str = "",
    *,
    priority: int | None = None,
    tags: str | None = None,
    click: str | None = None,
    actions: list[dict] | None = None,
    approval_id: str | None = None,
    task_id: str | None = None,
) -> bool:
    """Publish one push notification. Never raises; False on any failure.

    Uses ntfy's JSON publish endpoint (POST to the server root) — handles
    UTF-8 titles/bodies cleanly where raw PUT headers would not.
    `approval_id`/`task_id` are recorded on the Inbox row (not sent to ntfy)
    so the message stays connected to the item it's about.
    """
    try:
        conf = await get_notify_config()
        if not conf["enabled"] or not conf["topic"]:
            await _record_delivery(
                event, title, False,
                "suppressed: notifications disabled" if not conf["enabled"]
                else "suppressed: no topic seeded",
                message=message or title,
                approval_id=approval_id, task_id=task_id,
            )
            return False

        payload: dict = {
            "topic": conf["topic"],
            "title": title[:200],
            "message": (message or title)[:1500],
            "priority": priority or EVENT_PRIORITY.get(event, 3),
        }
        tag = tags or EVENT_TAGS.get(event)
        if tag:
            payload["tags"] = tag.split(",")
        if click:
            payload["click"] = click
        if actions:
            payload["actions"] = actions

        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(conf["url"], json=payload)
        if resp.status_code == 200:
            await _record_delivery(
                event, title, True, "accepted by ntfy", message=payload["message"],
                approval_id=approval_id, task_id=task_id,
            )
            return True
        logger.warning(
            "notify: ntfy rejected %s event: HTTP %d %s",
            event, resp.status_code, resp.text[:200],
        )
        await _record_delivery(
            event, title, False, f"ntfy rejected: HTTP {resp.status_code}",
            message=payload["message"],
            approval_id=approval_id, task_id=task_id,
        )
        return False
    except Exception as e:
        logger.warning("notify: push failed for %s (non-fatal): %s", event, e)
        await _record_delivery(
            event, title, False, f"publish error: {e}", message=message or title,
            approval_id=approval_id, task_id=task_id,
        )
        return False


async def notify_task_event(
    notification_type: str, task_id: str, title: str, body: str = "",
    actions: list[dict] | None = None, approval_id: str | None = None,
) -> bool:
    """Bridge from the pipeline's SSE notifications to phone push.

    Filters noise: failures / review / clarification always push;
    completions push only for autonomous work (goal-linked or cortex-sourced)
    — interactive chat tasks are already on the user's screen.
    """
    try:
        if notification_type not in EVENT_PRIORITY:
            return False

        if notification_type == "task_complete":
            pool = get_pool()
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT goal_id, metadata->>'source' AS source "
                    "FROM tasks WHERE id = $1::uuid",
                    task_id,
                )
            if row is None or (row["goal_id"] is None and row["source"] != "cortex"):
                return False

        return await notify(
            notification_type,
            title=title,
            message=f"{body}\n\nTask {task_id[:8]}" if body else f"Task {task_id[:8]}",
            actions=actions,
            approval_id=approval_id,
            task_id=task_id,
        )
    except Exception as e:
        logger.warning("notify: task-event push failed (non-fatal): %s", e)
        return False
