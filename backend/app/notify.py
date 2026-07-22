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
"""

import logging
from typing import Optional

import httpx

from app import settings_store

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
                    f"{e.response.status_code} {e.response.text[:200]}"}
        except httpx.HTTPError as e:
            return {"ok": False, "error": f"could not reach ntfy at {server}: {e}"}
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
            return {"ok": False, "error": f"webhook POST to {url} failed: {e}"}
        log.info("notification accepted by webhook (%s) status=%s", url, resp.status_code)
        return {"ok": True, "id": None}


# The registry. Order here is the order the Settings enum should list them.
_PROVIDERS: dict[str, Provider] = {
    p.key: p for p in (NtfyProvider(), WebhookProvider())
}


def provider_keys() -> list[str]:
    """Enum options for the notify.provider setting — kept in sync with the
    registry so a new provider only has to register once."""
    return list(_PROVIDERS)


def active_provider() -> Optional[Provider]:
    return _PROVIDERS.get(settings_store.get("notify.provider"))


async def send(message: str, *, title: Optional[str] = None,
               priority: Optional[str] = None, tags: Optional[list[str]] = None,
               click: Optional[str] = None) -> dict:
    """Publish a notification through the active provider. Returns
    {ok, id?, error?, provider?} — never raises. Reports provider/server
    ACCEPTANCE, not device delivery."""
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
