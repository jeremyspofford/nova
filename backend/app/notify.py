"""Push notifications to the operator — the only way Nova reaches you when the
app is closed (roadmap #21).

MODULAR BY DESIGN. A *provider* is any backend that can deliver a message to the
operator; each one is self-contained (declares its own settings, implements
`send`). The rest of Nova — the `notify_operator` tool, the scheduler's
failure alert — calls `notify.send(...)` and never learns which provider is
active. Adding a backend (a cloud pub/sub bridge, Pushover, Telegram, email) is:

    1. write a Provider subclass implementing `configured()` + `send()`
    2. register it in `_PROVIDERS`
    3. add its settings as `notify.<key>.*` in settings_store.py
    4. add its key to the `notify.provider` enum options

No caller changes. Provider settings are namespaced `notify.<provider>.*` so the
Settings UI shows only the active provider's fields.

Two providers ship today:
  - **ntfy** — keyless, self-hostable, reaches a phone; the batteries-included
    default (product principles: privacy-first, no API keys).
  - **webhook** — POST the notification as JSON to any URL: the universal escape
    hatch that bridges to Slack/Discord/Zapier/IFTTT and to cloud pub/sub behind
    an HTTP ingest, without Nova taking on a cloud SDK/credentials.

HONEST RECEIPTS (the operator-visible-outcomes lesson: "accepted by transport"
!= "received"): a successful send means the provider/server ACCEPTED the
message — never that it reached the operator's device. `send()` reports
acceptance (with an id when the backend returns one) and never claims delivery;
every caller must relay it the same way.

IT LANDS IN THE CONVERSATION FIRST (migration 125). Jeremy, 2026-08-07:
"Notifications should be in chat, not just the notifications bell." So
`send()` RECORDS before it delivers — `notifications.record` writes the one
row the push is generated from and the transcript pointer that renders it —
and the delivery outcome is written back onto that same row. Three
consequences, all deliberate:

  * a notification whose transport is disabled, unconfigured or broken is
    still in the conversation, saying so. That is the whole point: the
    channel that failed is the one that used to be the only record.
  * the push's click URL is the deep link to that row, so the tap carries
    which notification was tapped instead of dumping the operator on /chat.
  * two callers raising the same news inside `DEDUPE_WINDOW_S` produce ONE
    notification (the heartbeat raises an inbox card, whose ping and whose
    own push are the same sentence). The duplicate is counted on the
    original, not dropped on the floor.
"""

import logging
from typing import Optional

import httpx

from app import redact, settings_store

log = logging.getLogger(__name__)

# ntfy's X-Priority header takes 1..5; expose the friendly names operators know
# from the app. Other providers reinterpret or pass these through as they see fit.
_PRIORITY = {"min": 1, "low": 2, "default": 3, "high": 4, "max": 5}


class Provider:
    """A notification backend. Subclass, implement `configured` + `send`,
    register in `_PROVIDERS`. `send` must NEVER raise — return {ok, id?, error?}
    so callers can relay the outcome verbatim."""

    key: str = ""
    label: str = ""

    def configured(self) -> bool:
        raise NotImplementedError

    async def send(self, message: str, *, title: Optional[str], priority: str,
                   tags: Optional[list[str]], click: Optional[str]) -> dict:
        raise NotImplementedError


class NtfyProvider(Provider):
    key = "ntfy"
    label = "ntfy"

    def _server(self) -> str:
        """Resolve the publish URL from the server_mode selector: the public
        ntfy.sh, Nova's bundled server, or a custom URL."""
        mode = settings_store.get("notify.ntfy.server_mode")
        if mode == "builtin":
            from app.config import settings
            return settings.ntfy_builtin_url
        if mode == "custom":
            return (settings_store.get("notify.ntfy.custom_url") or "").strip()
        return "https://ntfy.sh"

    def configured(self) -> bool:
        return bool(self._server().strip()
                    and (settings_store.get("notify.ntfy.topic") or "").strip())

    async def send(self, message, *, title, priority, tags, click) -> dict:
        server = self._server().strip().rstrip("/")
        topic = (settings_store.get("notify.ntfy.topic") or "").strip()
        headers: dict[str, str] = {"Priority": str(_PRIORITY.get(priority, 3))}
        if title:
            headers["Title"] = title
        if tags:
            headers["Tags"] = ",".join(tags)
        if click:
            headers["Click"] = click
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(f"{server}/{topic}",
                                         content=message.encode("utf-8"), headers=headers)
                resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            return {"ok": False, "error": f"ntfy rejected the message: "
                    f"{e.response.status_code} "
                    f"{redact.scrub_text(e.response.text, 200)}"}
        except httpx.HTTPError as e:
            # a custom ntfy server URL can carry basic-auth userinfo, and the
            # exception text repeats the full request URL
            return {"ok": False,
                    "error": f"could not reach ntfy at {redact.host_of(server)}: "
                             f"{type(e).__name__}"}
        try:
            msg_id = resp.json().get("id")
        except ValueError:
            msg_id = None
        log.info("notification accepted by ntfy (%s/%s) id=%s", server, topic, msg_id)
        return {"ok": True, "id": msg_id}


class WebhookProvider(Provider):
    key = "webhook"
    label = "Webhook (JSON POST)"

    def configured(self) -> bool:
        return bool((settings_store.get("notify.webhook.url") or "").strip())

    async def send(self, message, *, title, priority, tags, click) -> dict:
        url = (settings_store.get("notify.webhook.url") or "").strip()
        payload = {"message": message, "title": title, "priority": priority,
                   "tags": tags or [], "click": click, "source": "nova"}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(url, json=payload)
                resp.raise_for_status()
        except httpx.HTTPError as e:
            # HOST ONLY, and never str(e). A Slack/Discord/Zapier webhook
            # carries its secret in the PATH, and httpx puts the full request
            # URL inside its exception text — so both halves of the obvious
            # message leak the credential. This string is the notify_operator
            # tool's RESULT: it goes into the model's context, back out to the
            # LLM provider on the next round, and into a messages row for 30
            # days. The status code and failure kind are what an operator
            # actually needs; the URL they already know.
            detail = (f"HTTP {e.response.status_code}"
                      if isinstance(e, httpx.HTTPStatusError) else type(e).__name__)
            return {"ok": False,
                    "error": f"webhook POST to {redact.host_of(url)} failed: {detail}"}
        log.info("notification accepted by webhook (%s) status=%s",
                 redact.host_of(url), resp.status_code)
        return {"ok": True, "id": None}


class WebPushProvider(Provider):
    """Native Web Push to the installed PWA — devices subscribe from
    Settings -> Notifications; delivery + subscription hygiene live in
    app/push.py. No second app, notifications wear Nova's icon."""

    key = "webpush"
    label = "Web Push (this app)"

    def configured(self) -> bool:
        # sync by contract — answer from push.py's cached count. Unprimed
        # (None) counts as configured: send() then reports the real state.
        from app import push
        n = push.cached_count()
        return n is None or n > 0

    async def send(self, message, *, title, priority, tags, click) -> dict:
        from app import push
        res = await push.send_all(message, title=title, tags=tags,
                                  url=click, priority=priority)
        if res["total"] == 0:
            return {"ok": False, "error": "no devices are subscribed — open "
                    "Settings -> Notifications on a device and enable push"}
        if res["sent"] == 0:
            return {"ok": False, "error": "no device accepted the push: "
                    + "; ".join(res["errors"] or ["unknown"])}
        log.info("web push accepted for %d/%d devices", res["sent"], res["total"])
        return {"ok": True, "id": f"{res['sent']}/{res['total']} devices"}


# The registry. Order here is the order the Settings enum should list them.
_PROVIDERS: dict[str, Provider] = {
    p.key: p for p in (NtfyProvider(), WebPushProvider(), WebhookProvider())
}


def provider_keys() -> list[str]:
    """Enum options for the notify.provider setting — kept in sync with the
    registry so a new provider only has to register once."""
    return list(_PROVIDERS)


def active_provider() -> Optional[Provider]:
    return _PROVIDERS.get(settings_store.get("notify.provider"))


async def _deliver(message: str, *, title: Optional[str], priority: Optional[str],
                   tags: Optional[list[str]], click: Optional[str]) -> dict:
    """The transport half, unchanged: pick the provider and hand it the text.

    Split out of `send` so the record half below reads as what it is — every
    return here is an outcome that gets written onto the notification row,
    including the three refusals that never touch a network.
    """
    if not settings_store.get("notify.enabled"):
        return {"ok": False, "error": "notifications are disabled "
                "(Settings -> Notifications)"}
    provider = active_provider()
    if provider is None:
        return {"ok": False, "error": "no notification provider selected "
                "(Settings -> Notifications)"}
    if not provider.configured():
        return {"ok": False, "provider": provider.key,
                "error": f"{provider.label} is not configured "
                "(Settings -> Notifications)"}
    prio = priority or settings_store.get("notify.default_priority") or "default"
    result = await provider.send(message, title=title, priority=prio,
                                 tags=tags, click=click)
    result["provider"] = provider.key
    return result


async def send(message: str, *, title: Optional[str] = None,
               priority: Optional[str] = None, tags: Optional[list[str]] = None,
               click: Optional[str] = None,
               kind: str = "alert", source: Optional[str] = None,
               recommendation_id: Optional[str] = None,
               dedupe_key: Optional[str] = None,
               record: bool = True) -> dict:
    """Record the notification, then publish it through the active provider.

    Returns {ok, id?, error?, provider?, notification_id?, in_chat?, deduped,
    state?, delivery_label?, confirmed?} — never raises. `ok` still means the
    provider ACCEPTED the message and nothing more; `notifications.confirmed()`
    is the only thing in this codebase that answers whether it reached a person.

    `deduped` IS ALWAYS PRESENT AND EVERY CALLER MUST READ IT. When it is
    True the provider was never asked — this call published nothing — and
    `ok`/`state`/`delivery_label` describe the EARLIER notification this one
    was folded onto. A caller that checks only `ok` will report a send that
    did not happen, which is exactly the false success this module's
    docstring spends four paragraphs on.

    RECORD FIRST, DELIVER SECOND. The order is the feature. Every refusal
    above — disabled, no provider, misconfigured — used to return a dict to a
    caller that mostly logged it, and the operator learned nothing. Now the
    news is already in his conversation with the reason attached before the
    transport is even asked.

    `record=False` is for notifications that would be absurd in the
    transcript: the "Nova replied" nudge, whose whole content is that the
    reply directly above it exists.
    """
    from app import notifications

    if not record:
        # `deduped` is stated even here, so the key is genuinely always
        # present and a caller reading it never has to know which branch it
        # came from. Nothing is recorded, so nothing can be a repeat.
        return {**await _deliver(message, title=title, priority=priority,
                                 tags=tags, click=click), "deduped": False}

    # ANTI-NAG, before anything is written. Derived from the news itself.
    fp = (dedupe_key or "").strip() or notifications.fingerprint(message)
    try:
        prior = await notifications.find_repeat(fp)
    except Exception:                                        # noqa: BLE001
        log.exception("the notification dedupe lookup failed")
        prior = None
    if prior is not None:
        await notifications.note_repeat(prior["id"])
        log.info("notification deduped onto %s (%s repeats)",
                 prior["id"], prior["repeats"] + 1)
        # NOTHING WAS PUBLISHED BY THIS CALL, and the dict has to say so out
        # loud. `deduped` used to be the only sign, and no caller read it —
        # so a suppressed notification came back with ok:True and every
        # caller relayed it as a send that happened. That is the
        # "never report success you did not check" failure, one layer down:
        # `ok` here is a fact about an EARLIER push. The state and the label
        # ride along so a caller can say which one, and how it went.
        return {"ok": prior["state"] in ("accepted", "opened"),
                "deduped": True, "notification_id": prior["id"],
                # explicitly None: there is no transport id for a call that
                # never reached a transport, and an absent key reads the same
                # as a provider that returned nothing.
                "id": None,
                "in_chat": bool(prior["message_id"]),
                "provider": prior["provider"],
                "state": prior["state"],
                "delivery_label": prior["delivery_label"],
                "confirmed": prior["confirmed"],
                "repeats": prior["repeats"] + 1,
                "first_raised_at": prior["created_at"],
                "error": None if prior["state"] in ("accepted", "opened")
                else f"already raised and {prior['delivery_label']}"}

    try:
        rec = await notifications.record(
            message, title=title, kind=kind, source=source, click_url=click,
            tags=tags, priority=priority, recommendation_id=recommendation_id,
            dedupe_key=dedupe_key)
    except Exception as e:                                   # noqa: BLE001
        # The record is what makes this visible at all, so a failure here is
        # reported rather than swallowed — but the push still goes out,
        # because the operator being told beats bookkeeping. The returned
        # dict says the conversation half did not happen.
        log.exception("the notification could not be recorded")
        out = await _deliver(message, title=title, priority=priority,
                             tags=tags, click=click)
        out["in_chat"] = False
        out["record_error"] = f"not recorded in the conversation: {e}"
        return out

    note = rec["notification"]
    nid = note["id"]
    # The tap carries WHICH notification. This is the reported bug: the click
    # URL was a bare page, so the app opened chat and the thing he tapped was
    # nowhere. The caller's own destination is kept on the row and offered as
    # a secondary link on the chat item.
    result = await _deliver(message, title=title, priority=priority,
                            tags=tags, click=notifications.deep_link(nid))
    try:
        if result.get("ok"):
            row = await notifications.mark_accepted(
                nid, provider=result.get("provider"), transport_id=result.get("id"))
        else:
            row = await notifications.mark_failed(
                nid, provider=result.get("provider"),
                error=str(result.get("error") or "the provider gave no reason"))
        # READ BACK, never assume. The two marks only move a row out of
        # 'pending', so a row something else already touched returns None —
        # and a caller told "accepted" by a dict while the row says otherwise
        # is the drift this module exists to prevent. The row is the fact.
        row = row or await notifications.get(nid)
        if row:
            result["state"] = row["state"]
            result["delivery_label"] = row["delivery_label"]
            result["confirmed"] = row["confirmed"]
    except Exception:                                        # noqa: BLE001
        log.exception("the notification outcome could not be written to %s", nid)
        result["record_error"] = ("the delivery outcome was not written to the "
                                  "notification row")
    result["notification_id"] = nid
    result["deduped"] = False
    result["in_chat"] = rec["in_chat"]
    if not rec["in_chat"] and rec.get("why"):
        result["chat_error"] = rec["why"]
    return result
