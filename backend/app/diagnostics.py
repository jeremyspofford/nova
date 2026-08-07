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

from app import db, failures, redact

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
            out[key] = _safe(settings_store.get(key), secret=bool(d.get("secret")))
        except Exception:  # noqa: BLE001 — one bad key never hides the rest
            out[key] = "<unreadable>"
    return out


def _safe(value, *, secret: bool = False):
    """Scrub a setting value, including URLs whose secret is the PATH.

    `redact.scrub_value` catches secret-shaped values, and a webhook URL is
    not secret-shaped — the token IS the path. A Slack or Discord hook is
    https://host/services/T0/B0/<token>, so returning it whole hands the
    credential straight to the model. Caught by this module's own test.

    The host survives, because the diagnostic question is "is it set and
    where does it point", never "what is the token".
    """
    if secret and isinstance(value, str) and value:
        # A def can declare its value secret outright — `"secret": True` in
        # SETTING_DEFS — for the case no rule here can see: the ntfy topic is
        # a plain word, and on a shared server that word IS the credential.
        # First chars + length answer "is it set and does it look right".
        # Empty falls through, because "unset" is itself the diagnostic fact.
        return f"{value[:4]}{redact.MASK} ({len(value)} chars)"
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


def _match_store(area: Optional[str], stores: list[str]) -> Optional[str]:
    """Resolve a caller's word to a failure store: 'ingestion' -> ingest_jobs.

    Derived from the store names themselves, so a queue that lands next month
    is addressable by its own name with no edit here. Matched on TOKENS
    because the operator says "ingestion" and the table says "ingest_jobs" —
    the word he uses is never the identifier.
    """
    if not area:
        return None
    wanted = "".join(ch for ch in area.strip().lower() if ch.isalnum())
    if not wanted:
        return None
    for table in stores:
        flat = table.replace("_", "")
        if wanted == flat or wanted in flat or flat.startswith(wanted):
            return table
        # 'ingest' (a token of ingest_jobs) is a prefix of 'ingestion'
        for token in table.split("_"):
            if len(token) > 2 and wanted.startswith(token):
                return table
    return None


async def _error_count(section: Optional[str]) -> Optional[int]:
    """How many ledger errors there ACTUALLY are, sharing _recent_errors' filter.

    `len(recent_errors)` is capped at _ERROR_LIMIT, so reporting it as the
    count turns "at least 8" into a flat "8" — and on this install the real
    72h number was 53. Returns None when the count could not be taken, which
    is what stops `note` from saying "no errors in the ledger" on the strength
    of a query that failed.
    """
    sql = ("SELECT count(*) FROM turn_spans "
           " WHERE detail->>'error' IS NOT NULL "
           "   AND started_at > now() - ($1 || ' hours')::interval ")
    args: list = [str(_ERROR_HOURS)]
    if section:
        sql += "   AND (name ILIKE $2 OR detail->>'error' ILIKE $2) "
        args.append(f"%{section.rstrip('s')}%")
    try:
        async with db.acquire() as conn:
            return int(await conn.fetchval(sql, *args) or 0)
    except Exception:  # noqa: BLE001
        log.debug("error count failed", exc_info=True)
        return None


async def _backup_health() -> dict:
    """Whether backups are still happening, or why that could not be read.

    Never returns an empty dict on failure. An unreadable backup history that
    came back as {} would be indistinguishable from a healthy one in the
    payload — the same silent-zero this module's fourth rule refuses for
    errors.
    """
    try:
        from app import backup_service
        return await backup_service.freshness()
    except Exception:  # noqa: BLE001 — never blank the whole report over this
        log.debug("backup freshness failed", exc_info=True)
        return {"note": "Backup health could not be read at all. That says "
                        "nothing about whether backups are running — do not "
                        "report them as fine on the strength of it."}


async def report(area: Optional[str] = None) -> dict:
    """Configuration, failures and reachability for one area, or a summary."""
    # UNCONDITIONAL, and deliberately not filtered by `area`. The failure that
    # started this could be reached by no spelling of `area` at all, so no
    # invocation of diagnose — with an area, without one, or with a wrong one
    # — may return without the live failure census. diagnose('Notifications')
    # must not be able to imply health while ingestion is broken.
    census = await failures.census()
    # Unconditional for the same reason, and needed as its own reader: the
    # census counts rows, and backups fail by NOT HAPPENING. An interval of 0,
    # an unmounted bundle store or a scheduler that has stopped ticking each
    # leave `backup_attempts` empty, and count(*) reads an empty history
    # exactly like a healthy one. Asked in the only way that can answer — the
    # newest attempt against the interval.
    backups = await _backup_health()
    stores = census.get("scanned", [])
    known = areas() + stores

    section = _match(area)
    store = _match_store(area, stores) if (area and not section) else None
    if area and not section and not store:
        # Still carries the census: an unrecognised word must not be a way to
        # get an answer with no failures in it.
        return {"error": f"no such area {area!r}", "areas": known,
                "background_failures": census, "backups": backups,
                "errors_note": failures.note(census, backups=backups)}

    out: dict = {"area": section or store or "all", "areas": known}
    out["settings"] = await _settings_for(section)

    errors = await _recent_errors(section)
    total_errors = await _error_count(section)
    out["recent_errors"] = errors
    if total_errors is not None and total_errors > len(errors):
        out["recent_errors_note"] = (
            f"showing the {len(errors)} most recent of {total_errors}")
    out["background_failures"] = census
    # The one sentence a model is most likely to quote back. Computed from the
    # census AND the backup verdict, so the reassuring wording is unreachable
    # while anything is failing, anything failed to be read, or backups have
    # stopped happening. The verdict goes in here as well as into `backups`
    # below because a separate key is something she has to choose to read,
    # and the census can never count a backup that was never attempted. See
    # failures.note.
    out["errors_note"] = failures.note(census, total_errors, _ERROR_HOURS,
                                       backups=backups)
    out["backups"] = backups

    # `services` used to be `sysmon._reaches()` — postgres and the memory
    # directory, two entries. Asked whether searxng was healthy, she read that
    # list, correctly observed searxng was not in it, and reported the service
    # as unreachable while it was serving 200s. A list that names two of
    # fifteen services is read as the set of services, so the honest fix is to
    # name all of them rather than to hope the reader infers the scope.
    try:
        from app import service_health
        out["services"] = await service_health.status()
    except Exception:  # noqa: BLE001 — never let this blank the whole report
        log.debug("service health failed", exc_info=True)
        out["services"] = {
            "container_view": "UNAVAILABLE",
            "note": "Service health could not be read at all. This says "
                    "nothing about whether the services are up — do not "
                    "report them as down on the strength of it."}
    # Grants that resolve to nothing. Same rule as services above: the row
    # saying an agent CAN call something is not evidence that it can, and the
    # gap between the two was invisible everywhere until now.
    try:
        from app.agents import registry as agent_registry
        from app.tools import registry as tool_registry
        broken = {}
        for a in await agent_registry.list_agents(enabled_only=False):
            gone = await tool_registry.degraded_grants(a)
            if gone:
                broken[a["name"]] = gone
        out["degraded_grants"] = broken
        out["degraded_grants_note"] = (
            "Granted tools that cannot be called right now — whatever provides "
            "them (an MCP server, a DB tool row) is down or gone. The agent "
            "still holds the grant, so this is a service problem, not a "
            "permissions one."
            if broken else
            "Every granted tool on every agent resolves to something callable.")
    except Exception:  # noqa: BLE001 — never blank the report over this
        log.debug("degraded-grant scan failed", exc_info=True)

    try:
        from app import sysmon
        out["shared_backends"] = await sysmon._reaches()
    except Exception:  # noqa: BLE001 — reachability is a bonus, never a blocker
        log.debug("reachability probe failed", exc_info=True)
    return out
