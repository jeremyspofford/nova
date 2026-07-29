"""What is actually configured, and what has actually been failing.

On 2026-07-28 the operator asked why push notifications had stopped. Nova
answered "tell me what you're seeing and I can investigate" — and could not.
Every step the investigation actually took was read-only: list the notify
settings, count the push subscriptions, look at which relay the endpoints
point to, read the last errors. She held none of it. She could SEND a
notification and had no way to see whether it worked, what was configured, or
what had failed.

The cause turned out to be one unset value — Apple's push relay rejects a
non-routable VAPID contact with a bare 403, and the default was
mailto:nova@localhost. A model cannot deduce that. It is not reasoning, it is
LOOKING, and looking is what she had no tool for.

So this is the lookup, and it is deliberately narrow:

* READ-ONLY. No setting is changed, no message is sent, nothing is probed
  that costs money. That keeps it a READER under the containment fence
  (tools/registry.py), so it needs no new trust to be useful.
* DERIVED. The areas are the `section` values already declared in
  SETTING_DEFS, so a new settings section is diagnosable the day it lands
  with no edit here. Errors come from the turn ledger that already records
  them.
* SCRUBBED. Settings carry API keys and tokens. Everything goes through
  redact before it reaches a model, because the whole point is to hand her
  configuration and configuration is where the secrets are.
* HONEST ABOUT ABSENCE. An area with no recorded errors says so rather than
  returning an empty object that reads like "fine".
"""

from __future__ import annotations

import logging
from typing import Optional

from app import db, redact

log = logging.getLogger(__name__)

_ERROR_LIMIT = 8
_ERROR_HOURS = 72


def areas() -> list[str]:
    """The diagnosable areas — the setting sections, derived not listed."""
    from app.settings_store import SETTING_DEFS
    seen: list[str] = []
    for d in SETTING_DEFS:
        section = d.get("section")
        if section and section not in seen:
            seen.append(section)
    return seen


def _match(area: Optional[str]) -> Optional[str]:
    """Resolve a caller's area name case-insensitively, or None for all."""
    if not area:
        return None
    wanted = area.strip().lower()
    for known in areas():
        if known.lower() == wanted or wanted in known.lower():
            return known
    return None


async def _settings_for(section: Optional[str]) -> dict:
    """Current values in a section, scrubbed.

    Scrubbing is not optional here. This exists to hand configuration to a
    model, and configuration is exactly where the API keys are — the same
    reason redact.py exists at all.
    """
    from app import settings_store
    out: dict = {}
    for d in settings_store.SETTING_DEFS:
        if section and d.get("section") != section:
            continue
        key = d["key"]
        try:
            out[key] = _safe(settings_store.get(key))
        except Exception:  # noqa: BLE001 — one bad key never hides the rest
            out[key] = "<unreadable>"
    return out


def _safe(value):
    """Scrub a setting value, including URLs whose secret is the PATH.

    `redact.scrub_value` catches secret-shaped values, and a webhook URL is
    not secret-shaped — the token IS the path. A Slack or Discord hook is
    https://host/services/T0/B0/<token>, so returning it whole hands the
    credential straight to the model. Caught by this module's own test.

    The host survives, because the diagnostic question is "is it set and
    where does it point", never "what is the token".
    """
    scrubbed = redact.scrub_value(value)
    if not isinstance(scrubbed, str) or "://" not in scrubbed:
        return scrubbed
    host = redact.host_of(scrubbed)
    tail = scrubbed.split("://", 1)[1]
    path = tail[tail.find("/"):] if "/" in tail else ""
    if len(path.strip("/")) < 2:
        return scrubbed                   # no path worth hiding
    return f"{host}/… ({len(path.strip('/').split('/'))} path segments hidden)"


async def _recent_errors(section: Optional[str]) -> list[dict]:
    """What has actually been failing, from the ledger that already records it.

    Matched on the section name appearing in the span's name or error text.
    Crude on purpose: an over-broad match shows the operator a real failure
    they can dismiss, while a clever one that misses the failure they are
    asking about is the reason this tool exists.
    """
    sql = ("SELECT started_at, kind, name, left(detail->>'error', 300) AS error "
           "  FROM turn_spans "
           " WHERE detail->>'error' IS NOT NULL "
           "   AND started_at > now() - ($1 || ' hours')::interval ")
    args: list = [str(_ERROR_HOURS)]
    if section:
        sql += "   AND (name ILIKE $2 OR detail->>'error' ILIKE $2) "
        args.append(f"%{section.rstrip('s')}%")
    sql += " ORDER BY started_at DESC LIMIT " + str(_ERROR_LIMIT)
    try:
        async with db.acquire() as conn:
            rows = await conn.fetch(sql, *args)
    except Exception:  # noqa: BLE001
        log.debug("error lookup failed", exc_info=True)
        return []
    return [{"at": str(r["started_at"])[:19], "kind": r["kind"],
             "name": r["name"], "error": redact.scrub_text(r["error"] or "")}
            for r in rows]


async def report(area: Optional[str] = None) -> dict:
    """Configuration, failures and reachability for one area, or a summary."""
    section = _match(area)
    if area and not section:
        return {"error": f"no such area {area!r}", "areas": areas()}

    out: dict = {"area": section or "all", "areas": areas()}
    out["settings"] = await _settings_for(section)

    errors = await _recent_errors(section)
    out["recent_errors"] = errors
    # An empty list reads as "fine". Say which it is.
    out["errors_note"] = (
        f"{len(errors)} error(s) recorded in the last {_ERROR_HOURS}h"
        if errors else
        f"No errors recorded in the last {_ERROR_HOURS}h. That means none "
        f"were LOGGED — a feature can be misconfigured and fail silently "
        f"without ever raising, which is how the push-notification outage "
        f"went unnoticed.")

    try:
        from app import sysmon
        out["services"] = await sysmon._reaches()
    except Exception:  # noqa: BLE001 — reachability is a bonus, never a blocker
        log.debug("reachability probe failed", exc_info=True)
    return out
