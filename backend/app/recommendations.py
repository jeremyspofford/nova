"""Recommendations — Nova's proactive output channel.

An agent or automation RAISES a recommendation via the raise_recommendation
builtin; the operator SEES it as a card in chat and DECIDES (approve / later /
dismiss) through the authenticated operator API. Agents never decide — the
decide path is operator-only, the same boundary that protects settings.

Dedupe: a stable dedupe_key (e.g. "mcp:github") means a weekly automation
re-raising the same finding refreshes the one live row instead of stacking
duplicates — and never resurrects one the operator already dismissed
(docs/plans/recommendation-surface.md).
"""

import asyncio
import json
import logging
import uuid as uuid_mod
from typing import Optional

from app import db

log = logging.getLogger(__name__)

CREATE_LIMIT_PER_HOUR = 12   # card-spam / operator-fatigue guard, per source
_ACTIONABLE = ("new", "seen", "later")
_CHOICE = {"approve": "approved", "later": "later",
           "dismiss": "dismissed", "done": "done"}

_FIELDS = ("id", "kind", "title", "body", "source", "status", "action",
           "priority", "dedupe_key", "created_at", "decided_at", "decided_by")


def _row(r) -> dict:
    d = {k: r[k] for k in _FIELDS}
    d["id"] = str(d["id"])
    d["action"] = json.loads(d["action"]) if isinstance(d["action"], str) else d["action"]
    for k in ("created_at", "decided_at"):
        d[k] = str(d[k]) if d[k] else None
    return d


async def create(kind: str, title: str, body: str, *, source: str,
                 action: Optional[dict] = None, priority: int = 0,
                 dedupe_key: Optional[str] = None) -> dict:
    dedupe_key = (dedupe_key or "").strip() or None
    action_json = json.dumps(action) if action is not None else None
    async with db.acquire() as conn:
        # fatigue guard: an agent hammering out cards is broken or being steered
        recent = await conn.fetchval(
            "SELECT count(*) FROM recommendations WHERE source = $1 "
            "AND created_at > now() - interval '1 hour'", source)
        if recent >= CREATE_LIMIT_PER_HOUR:
            raise ValueError(
                f"recommendation rate limit: {source} already raised {recent} "
                f"this hour — stop and tell the operator directly")
        if dedupe_key is None:
            r = await conn.fetchrow(
                "INSERT INTO recommendations (kind, title, body, source, action, "
                "priority) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
                kind, title, body, source, action_json, priority)
        else:
            # refresh the live row; never resurrect a decided/dismissed one
            r = await conn.fetchrow(
                "INSERT INTO recommendations (kind, title, body, source, action, "
                "priority, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7) "
                "ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL "
                "DO UPDATE SET title=EXCLUDED.title, body=EXCLUDED.body, "
                "  source=EXCLUDED.source, action=EXCLUDED.action, "
                "  priority=EXCLUDED.priority, status='new', created_at=now() "
                "WHERE recommendations.status = ANY($8) RETURNING *",
                kind, title, body, source, action_json, priority, dedupe_key,
                list(_ACTIONABLE))
            if r is None:   # conflict on an already-decided row → leave it be
                r = await conn.fetchrow(
                    "SELECT * FROM recommendations WHERE dedupe_key = $1", dedupe_key)
    log.info("Recommendation raised: %s %r by %s", kind, title, source)
    row = _row(r)
    # reach the operator's devices too — the card is the durable surface,
    # the push is the nudge. Fire-and-forget; a decided dedupe row (create
    # left it untouched) must not re-ping.
    if row["status"] == "new":
        async def _ping():
            from app import notify
            await notify.send(body[:140], title=f"Nova recommends: {title}"[:90],
                              tags=["bulb"], click="/chat?inbox=open")
        asyncio.get_running_loop().create_task(_ping())
    return row


async def list_all(status: str = "new") -> list[dict]:
    """`new` = the banner queue: undecided AND unsnoozed — 'later' means the
    operator asked the banner to stop showing it, so only the inbox lists it
    until a dedupe re-raise resets it to 'new'. `all` = the inbox view:
    everything actionable (snoozed included) plus the last 30 days of
    decided rows."""
    async with db.acquire() as conn:
        if status == "all":
            rows = await conn.fetch(
                "SELECT * FROM recommendations "
                "WHERE status IN ('new','seen','later') "
                "   OR decided_at > now() - interval '30 days' "
                "ORDER BY (status IN ('new','seen','later')) DESC, "
                "         priority DESC, coalesce(decided_at, created_at) DESC")
        else:
            rows = await conn.fetch(
                "SELECT * FROM recommendations WHERE status IN ('new','seen') "
                "ORDER BY priority DESC, created_at DESC")
    return [_row(r) for r in rows]


async def decide(rec_id: str, choice: str) -> Optional[dict]:
    new_status = _CHOICE.get(choice)
    if not new_status:
        raise ValueError(f"choice must be one of {list(_CHOICE)}")
    try:
        rid = uuid_mod.UUID(str(rec_id))
    except ValueError:
        return None
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            "UPDATE recommendations SET status=$2, decided_at=now(), "
            "decided_by='operator' WHERE id=$1 RETURNING *", rid, new_status)
    return _row(r) if r else None


async def count_new() -> int:
    async with db.acquire() as conn:
        return await conn.fetchval(
            "SELECT count(*) FROM recommendations WHERE status = 'new'") or 0
