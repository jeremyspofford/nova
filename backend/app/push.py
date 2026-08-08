"""Web Push — VAPID identity, per-device subscriptions, encrypted fan-out.

The delivery half of the `webpush` notification provider (notify.py): the
installed PWA subscribes a device here, and `send_all` pushes an encrypted
payload to every subscription through the browser vendors' push services.
Payloads are aes128gcm end-to-end encrypted by pywebpush; the relays see
only that a push happened.

Fleet-shape: subscriptions and the VAPID keypair live in the shared DB, so
any instance can deliver and keys stay stable across machines.
"""

import asyncio
import base64
import json
import logging
import uuid as uuid_mod
from typing import Optional

from app import db

log = logging.getLogger(__name__)

# VAPID `sub` claim — a contact for push services to reach the operator of
# this application server. Only ever sent to the push relays.
#
# The DEFAULT, not the setting: `_vapid_sub()` below reads
# notify.webpush.contact and falls back to this, and `_explain` compares
# against it to recognise an unconfigured instance behind Apple's bare 403.
# It is a placeholder on purpose — it was once the maintainer's personal
# address, which every deployment of this project then handed to
# Google/Apple/Mozilla as its own contact.
#
# Not an env var any more, and the os.environ read that used to be here said
# otherwise for months: NOVA_VAPID_SUB was never declared in
# docker-compose.yml, so setting it in .env changed nothing at all. Set a
# real address in Settings -> Notifications -> Web Push contact address.
_VAPID_SUB = "mailto:nova@localhost"

# Web Push Urgency header from our friendly priority names
_URGENCY = {"min": "very-low", "low": "low", "default": "normal",
            "high": "high", "max": "high"}

# last known subscription count — lets notify's sync `configured()` answer
# without a DB round-trip. None = not primed yet (treated as "maybe").
_count: Optional[int] = None


def cached_count() -> Optional[int]:
    return _count


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _generate_vapid() -> tuple[str, str]:
    """(public applicationServerKey, private raw scalar), both base64url —
    the exact formats PushManager.subscribe and pywebpush expect."""
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import (
        Encoding, PublicFormat)
    key = ec.generate_private_key(ec.SECP256R1())
    priv = key.private_numbers().private_value.to_bytes(32, "big")
    pub = key.public_key().public_bytes(Encoding.X962,
                                        PublicFormat.UncompressedPoint)
    return _b64u(pub), _b64u(priv)


async def ensure_vapid() -> tuple[str, str]:
    """The fleet's keypair, generated once. INSERT ... ON CONFLICT DO NOTHING
    then re-read makes concurrent first calls race-safe across instances."""
    async with db.acquire() as conn:
        row = await conn.fetchrow("SELECT public_key, private_key FROM push_vapid")
        if row is None:
            pub, priv = _generate_vapid()
            await conn.execute(
                """INSERT INTO push_vapid (public_key, private_key)
                   VALUES ($1, $2) ON CONFLICT (id) DO NOTHING""", pub, priv)
            row = await conn.fetchrow(
                "SELECT public_key, private_key FROM push_vapid")
            log.info("VAPID keypair generated")
    return row["public_key"], row["private_key"]


async def subscribe(subscription: dict, label: Optional[str]) -> dict:
    """Upsert by endpoint — re-subscribing a device refreshes its keys and
    clears its failure count."""
    global _count
    endpoint = subscription["endpoint"]
    keys = subscription.get("keys") or {}
    async with db.acquire() as conn:
        await conn.execute(
            """INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (endpoint) DO UPDATE
                   SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                       label = EXCLUDED.label, failures = 0""",
            uuid_mod.uuid4(), endpoint, keys.get("p256dh", ""),
            keys.get("auth", ""), (label or "").strip() or None)
        _count = await conn.fetchval("SELECT count(*) FROM push_subscriptions")
    log.info("push subscription upserted (%s devices): %s",
             _count, (label or endpoint[-24:]))
    return {"ok": True, "devices": _count}


async def unsubscribe(endpoint: str) -> bool:
    global _count
    async with db.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM push_subscriptions WHERE endpoint = $1", endpoint)
        _count = await conn.fetchval("SELECT count(*) FROM push_subscriptions")
    return result.endswith("1")


async def list_subscriptions() -> list[dict]:
    """Device list for Settings. Endpoints are capability URLs — return only
    enough to recognize a row, never the full secret path."""
    global _count
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT endpoint, label, created_at, last_used_at, failures
               FROM push_subscriptions ORDER BY created_at""")
    _count = len(rows)
    return [{
        "endpoint_tail": r["endpoint"][-16:],
        "endpoint": r["endpoint"],   # operator-only API; needed for remove
        "label": r["label"],
        "created_at": r["created_at"].timestamp(),
        "last_used_at": r["last_used_at"].timestamp() if r["last_used_at"] else None,
        "failures": r["failures"],
    } for r in rows]


def _vapid_sub() -> str:
    """The VAPID contact claim, operator-editable.

    Was a module-level os.environ read, which broke twice over on
    2026-07-28: the variable was never declared in docker-compose.yml so it
    could not reach the container, and settings_store's own rule says
    behavioural config belongs to the app rather than the deployment. A
    setting is visible in the UI, editable without a compose edit, and
    applies on the next call instead of the next rebuild.
    """
    from app import settings_store
    configured = str(settings_store.get("notify.webpush.contact") or "").strip()
    return configured or _VAPID_SUB


def _explain(result: str) -> str:
    """Turn a relay's bare status into something an operator can act on.

    "failed: 403" is what every push to an iPhone returned while the VAPID
    contact was mailto:nova@localhost — with correct keys, live
    subscriptions and nothing else wrong. Apple rejects an unroutable
    contact and says nothing about why, so the operator sees a dead feature
    and no cause.
    """
    if "403" not in result:
        return result
    contact = _vapid_sub()
    if contact == _VAPID_SUB or contact.endswith("@localhost"):
        return (f"{result} — the push relay refused the request. Apple "
                f"rejects a non-routable VAPID contact, and this one is "
                f"still the {contact!r} default. Set a real address in "
                f"Settings -> Notifications -> Web Push contact address.")
    return f"{result} — the relay refused the VAPID claim for {contact!r}."


def _push_one(sub_info: dict, payload: str, priv: str, urgency: str):
    """One blocking pywebpush delivery — runs in a thread. Returns
    'ok' | 'gone' | 'failed:<detail>'."""
    from pywebpush import WebPushException, webpush
    try:
        webpush(subscription_info=sub_info, data=payload,
                vapid_private_key=priv,
                # pywebpush mutates the claims dict (aud/exp) — fresh per call
                vapid_claims={"sub": _vapid_sub()},
                ttl=86400, timeout=10, headers={"Urgency": urgency})
        return "ok"
    except WebPushException as e:
        code = e.response.status_code if e.response is not None else None
        if code in (404, 410):
            return "gone"
        return _explain(f"failed: {code or e}")
    except Exception as e:  # DNS, TLS, anything — never let one device raise
        return f"failed: {e}"


def notification_id_from(url: Optional[str]) -> Optional[str]:
    """The notification id a click URL carries, or None.

    READ FROM THE URL rather than passed as its own argument, and that is
    deliberate. The URL is the one channel that survives every path into the
    app — a cold start, a `WindowClient.navigate`, a pasted link, an iOS
    standalone PWA with no navigate at all — so it has to carry the id
    regardless. A second parameter alongside it would be a copy that can
    disagree with the link, and the whole defect being fixed here is an id
    getting lost between the push and the client.

    Tolerant by design: a caller with its own destination (/observability)
    simply has no id, and that is not an error.
    """
    if not url or "notification=" not in url:
        return None
    from urllib.parse import parse_qs, urlparse
    try:
        values = parse_qs(urlparse(url).query).get("notification") or []
    except ValueError:
        return None
    return values[0] if values and values[0] else None


async def send_all(message: str, *, title: Optional[str], tags: Optional[list[str]],
                   url: Optional[str], priority: str) -> dict:
    """Fan the payload out to every subscribed device. Expired subscriptions
    (404/410 from the push service) are deleted; other failures increment
    the row's failure count. Never raises."""
    global _count
    async with db.acquire() as conn:
        subs = await conn.fetch(
            "SELECT endpoint, p256dh, auth FROM push_subscriptions")
    _count = len(subs)
    if not subs:
        return {"total": 0, "sent": 0, "gone": 0, "failed": 0, "errors": []}

    _, priv = await ensure_vapid()
    # `notification_id` and `tag` ride beside the URL for push-sw.js:
    #   - the id so `notificationclick` can tell the app WHICH one was tapped
    #     even on engines with no WindowClient.navigate (iOS standalone PWAs),
    #     where focusing the existing window used to lose it entirely;
    #   - the tag so a re-push of the same notification REPLACES the banner
    #     instead of stacking a second copy on the lock screen.
    nid = notification_id_from(url)
    payload = json.dumps({"title": title or "Nova", "body": message,
                          "tags": tags or [], "url": url or "/",
                          "notification_id": nid,
                          "tag": f"nova-{nid}" if nid else None})
    urgency = _URGENCY.get(priority, "normal")
    results = await asyncio.gather(*(
        asyncio.to_thread(
            _push_one,
            {"endpoint": s["endpoint"],
             "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}},
            payload, priv, urgency)
        for s in subs))

    ok_eps = [s["endpoint"] for s, r in zip(subs, results) if r == "ok"]
    gone_eps = [s["endpoint"] for s, r in zip(subs, results) if r == "gone"]
    failed = [(s["endpoint"], r) for s, r in zip(subs, results)
              if r not in ("ok", "gone")]
    async with db.acquire() as conn:
        if ok_eps:
            await conn.execute(
                """UPDATE push_subscriptions SET last_used_at = now(),
                       failures = 0 WHERE endpoint = ANY($1)""", ok_eps)
        if gone_eps:
            await conn.execute(
                "DELETE FROM push_subscriptions WHERE endpoint = ANY($1)",
                gone_eps)
            log.info("pruned %d expired push subscriptions", len(gone_eps))
        for ep, _r in failed:
            await conn.execute(
                "UPDATE push_subscriptions SET failures = failures + 1 "
                "WHERE endpoint = $1", ep)
        _count = await conn.fetchval("SELECT count(*) FROM push_subscriptions")

    if failed:
        log.warning("web push: %d/%d deliveries failed: %s",
                    len(failed), len(subs), failed[0][1])
    return {"total": len(subs), "sent": len(ok_eps), "gone": len(gone_eps),
            "failed": len(failed), "errors": [r for _, r in failed[:3]]}
