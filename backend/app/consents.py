"""Operator consents — the mechanical half of guarded destructive actions.

A consent row is created ONLY by an agent calling
request_operator_confirmation, and decided ONLY through the authenticated
operator API. Tool executors call validate_and_use() to check-and-burn an
approving consent before a destructive action runs — no LLM judgment is
involved anywhere (roadmap #29, docs/plans/guarded-actions-consent.md).

Consents are per-operation (kind + subject), single-use, and short-lived:
the operator has DECIDE_TTL_MIN to click, and an approval must be consumed
within USE_TTL_MIN of the click.
"""

import logging
import uuid as uuid_mod
from typing import Optional

from app import db

log = logging.getLogger(__name__)

DECIDE_TTL_MIN = 10
USE_TTL_MIN = 3          # the follow-up fires immediately; keep the window tight
CREATE_LIMIT_PER_HOUR = 6  # card-spam / operator-fatigue guard

_FIELDS = ("id", "kind", "subject", "question", "requested_by",
           "conversation_id", "status", "chosen", "created_at",
           "decided_at", "used_at")


def _row(r) -> dict:
    d = {k: r[k] for k in _FIELDS}
    d["id"] = str(d["id"])
    d["conversation_id"] = str(d["conversation_id"]) if d["conversation_id"] else None
    for k in ("created_at", "decided_at", "used_at"):
        d[k] = str(d[k]) if d[k] else None
    return d


async def create(kind: str, subject: str, question: str, *,
                 requested_by: str, conversation_id: Optional[str] = None) -> dict:
    conv = None
    if conversation_id:
        try:
            conv = uuid_mod.UUID(str(conversation_id))
        except ValueError:
            conv = None
    async with db.acquire() as conn:
        # operator-fatigue guard: an agent hammering out cards is either
        # broken or being steered — cut it off, loudly
        recent = await conn.fetchval(
            "SELECT count(*) FROM consents WHERE requested_by = $1 "
            "AND created_at > now() - interval '1 hour'", requested_by)
        if recent >= CREATE_LIMIT_PER_HOUR:
            raise ValueError(
                f"consent rate limit: {requested_by} already raised {recent} "
                f"requests this hour — stop and tell the operator directly")
        # one live question per operation — a re-ask supersedes the old card
        await conn.execute(
            "UPDATE consents SET status = 'expired' "
            "WHERE status = 'pending' AND kind = $1 AND subject = $2",
            kind, subject)
        r = await conn.fetchrow(
            "INSERT INTO consents (kind, subject, question, requested_by, "
            "conversation_id) VALUES ($1, $2, $3, $4, $5) RETURNING *",
            kind, subject, question, requested_by, conv)
    log.info("Consent requested: %s %s by %s", kind, subject, requested_by)
    return _row(r)


async def list_pending(conversation_id: Optional[str] = None) -> list[dict]:
    """Fresh pending consents (stale ones are lazily expired first)."""
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE consents SET status = 'expired' WHERE status = 'pending' "
            f"AND created_at <= now() - interval '{DECIDE_TTL_MIN} minutes'")
        if conversation_id:
            rows = await conn.fetch(
                "SELECT * FROM consents WHERE status = 'pending' "
                "AND conversation_id = $1 ORDER BY created_at",
                uuid_mod.UUID(conversation_id))
        else:
            rows = await conn.fetch(
                "SELECT * FROM consents WHERE status = 'pending' ORDER BY created_at")
    return [_row(r) for r in rows]


async def decide(consent_id: str, chosen: str) -> Optional[dict]:
    """Record the operator's click. Returns the row, or None if the consent
    is not pending anymore (decided already, expired, or unknown)."""
    try:
        cid = uuid_mod.UUID(consent_id)
    except ValueError:
        return None
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            "UPDATE consents SET status = 'decided', chosen = $2, decided_at = now() "
            "WHERE id = $1 AND status = 'pending' "
            f"AND created_at > now() - interval '{DECIDE_TTL_MIN} minutes' "
            "RETURNING *", cid, chosen)
        if not r:  # stale pending row → expire it so the UI stops showing it
            await conn.execute(
                "UPDATE consents SET status = 'expired' "
                "WHERE id = $1 AND status = 'pending'", cid)
    if r:
        log.info("Consent %s: %s %s -> %s", consent_id, r["kind"], r["subject"], chosen)
    return _row(r) if r else None


async def validate_and_use(kind: str, subject: str,
                           consent_id: Optional[str] = None,
                           agent_name: Optional[str] = None) -> Optional[dict]:
    """Check-and-burn an approving consent for (kind, subject). If consent_id
    is provided it must match; otherwise the newest fresh approval for the
    operation is used (robust against small models garbling uuids). The
    consent is bound to the agent that requested it — a different agent
    cannot spend it. Returns the burned row, or None if no valid approval
    exists."""
    cid = None
    if consent_id:
        try:
            cid = uuid_mod.UUID(str(consent_id))
        except ValueError:
            cid = None  # fall back to kind+subject lookup
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            "UPDATE consents SET used_at = now() WHERE id = ("
            "  SELECT id FROM consents"
            "   WHERE kind = $1 AND subject = $2 AND status = 'decided'"
            "     AND chosen = 'approve' AND used_at IS NULL"
            f"    AND decided_at > now() - interval '{USE_TTL_MIN} minutes'"
            "     AND ($3::uuid IS NULL OR id = $3)"
            "     AND ($4::text IS NULL OR requested_by = $4)"
            "   ORDER BY decided_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED) "
            "RETURNING *", kind, subject, cid, agent_name)
    if r:
        log.info("Consent burned: %s %s (%s) by %s", kind, subject, r["id"], agent_name)
    return _row(r) if r else None
