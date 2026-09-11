"""Governance event ledger — the append-only record of who decided what.

Slice 2 (docs/DECISIONS.md D-020, D-030). Three event types are onboarded:
consent.decided, consent.burned, capability.changed. The integrity model is
ATOMIC: for onboarded types, the authoritative state mutation and its event
INSERT run in the caller's transaction and commit together — `record()`
RAISES on failure so the mutation rolls back with it. Post-commit
best-effort writing is deliberately not offered.

What this module is NOT:
  - Not an authorization authority. There is no query API for runtime use;
    nothing may read this table to decide anything. Pinned mechanically by
    tests/test_governance_ledger.py.
  - Not a completeness upgrade for capability events. The precise guarantee
    is: for each successfully completed `capability_events._write()`
    transaction, the legacy capability-event row and its governance mirror
    are committed together or neither is committed. A fire-and-forget
    capability task that is never scheduled, is interrupted, or fails
    before its transaction completes records nothing — that is the
    EXISTING capability-event posture, unchanged by this slice.
  - Not database-enforced immutability. Append-only is an application-level
    contract here (no triggers, no roles); DB hardening is a later slice.

Payloads are TYPED: one constructor per event type, fixed allowlisted
fields, identifiers and enums only — no free text, prompts, tool
arguments/results, secrets, or memory content can arrive because no
parameter accepts them. Validation failures raise with the event type and
key name ONLY — never the offending value. Oversized payloads reject the
write rather than truncating an audit record.

`reconcile()` is a TEST/ADMIN-ONLY diagnostic (defense in depth): it is not
scheduled, not called at startup, not exposed as a tool or route, and must
stay that way in this slice.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Optional

from app import db, trace

log = logging.getLogger(__name__)

SCHEMA_VERSIONS = {
    "consent.decided": 1,
    "consent.burned": 1,
    "capability.changed": 1,
}
PAYLOAD_CAP_BYTES = 8192
_IDENT_MAX = 200
_LIST_MAX = 200

#: The migration whose schema_migrations.applied_at is the no-backfill
#: watermark — completeness claims begin there (DDL-only, no synthetic row).
WATERMARK_MIGRATION = "134_governance_events.sql"


@dataclass(frozen=True)
class Event:
    event_type: str
    subject_kind: str
    subject_id: str
    payload: dict
    actor_kind: Optional[str] = None
    actor_id: Optional[str] = None
    actor_assurance: Optional[str] = "unknown"
    conversation_id: Optional[str] = None
    run_id: Optional[str] = None
    schema_version: int = field(default=1)


def _ident(event_type: str, key: str, value) -> str:
    """An identifier/enum field: non-empty str, bounded. Never echoes the
    value in errors — event type and key name only."""
    if not isinstance(value, str) or not value or len(value) > _IDENT_MAX:
        raise ValueError(f"{event_type}: invalid or oversized value "
                         f"for key {key!r}")
    return value


def _ident_list(event_type: str, key: str, values) -> list[str]:
    if (not isinstance(values, list) or len(values) > _LIST_MAX
            or not all(isinstance(v, str) and 0 < len(v) <= _IDENT_MAX
                       for v in values)):
        raise ValueError(f"{event_type}: invalid or oversized value "
                         f"for key {key!r}")
    return values


def consent_decided(*, consent_id: str, consent_kind: str, chosen: str,
                    conversation_id: Optional[str] = None) -> Event:
    t = "consent.decided"
    if chosen not in ("approve", "deny"):
        raise ValueError(f"{t}: invalid value for key 'chosen'")
    return Event(
        event_type=t, subject_kind="consent",
        subject_id=_ident(t, "consent_id", consent_id),
        payload={"kind": _ident(t, "consent_kind", consent_kind),
                 "chosen": chosen},
        actor_kind="operator", actor_id="operator",
        conversation_id=conversation_id,
        schema_version=SCHEMA_VERSIONS[t])


def consent_burned(*, consent_id: str, consent_kind: str,
                   agent_name: Optional[str] = None,
                   conversation_id: Optional[str] = None) -> Event:
    """agent_name may be None — the as-built binding bypass (D-029) is
    recorded as unknown attribution, never invented."""
    t = "consent.burned"
    return Event(
        event_type=t, subject_kind="consent",
        subject_id=_ident(t, "consent_id", consent_id),
        payload={"kind": _ident(t, "consent_kind", consent_kind)},
        actor_kind="agent" if agent_name else None,
        actor_id=_ident(t, "agent_name", agent_name) if agent_name else None,
        conversation_id=conversation_id,
        schema_version=SCHEMA_VERSIONS[t])


def capability_changed(*, kind: str, subject: str, action: str, actor: str,
                       granted: Optional[list[str]] = None,
                       revoked: Optional[list[str]] = None) -> Event:
    """A typed PROJECTION of a capability event: identifier lists only.
    Full detail stays in capability_events (its readers are unchanged);
    this mirror deliberately carries no other detail content."""
    t = "capability.changed"
    payload: dict = {"kind": _ident(t, "kind", kind),
                     "action": _ident(t, "action", action)}
    if granted is not None:
        payload["granted"] = _ident_list(t, "granted", granted)
    if revoked is not None:
        payload["revoked"] = _ident_list(t, "revoked", revoked)
    return Event(
        event_type=t, subject_kind="capability",
        subject_id=_ident(t, "subject", subject),
        payload=payload,
        actor_kind=None,  # 'operator'/agent-name strings are not inferred
        actor_id=_ident(t, "actor", actor),
        schema_version=SCHEMA_VERSIONS[t])


async def record(conn, event: Event) -> None:
    """Insert one event on the CALLER'S connection, inside the caller's
    transaction. RAISES on any failure — atomicity for onboarded facts
    depends on the mutation rolling back with a failed event write. Never
    call this outside the transaction that commits the fact it records."""
    if event.event_type not in SCHEMA_VERSIONS:
        raise ValueError(f"unknown governance event type {event.event_type!r}")
    body = json.dumps(event.payload)
    if len(body.encode()) > PAYLOAD_CAP_BYTES:
        # Reject, never truncate: a partial audit record is worse than a
        # failed write (the mutation fails closed with it).
        raise ValueError(f"{event.event_type}: payload exceeds "
                         f"{PAYLOAD_CAP_BYTES} bytes")
    turn = trace.current()
    await conn.execute(
        "INSERT INTO governance_events (event_type, schema_version, "
        "actor_kind, actor_id, actor_assurance, subject_kind, subject_id, "
        "trace_id, conversation_id, run_id, payload) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)",
        event.event_type, event.schema_version, event.actor_kind,
        event.actor_id, event.actor_assurance, event.subject_kind,
        event.subject_id, turn.id if turn else None,
        _uuid_or_none(event.conversation_id), event.run_id, body)


def _uuid_or_none(value: Optional[str]):
    import uuid as uuid_mod
    if not value:
        return None
    try:
        return uuid_mod.UUID(str(value))
    except ValueError:
        return None


async def reconcile() -> list[str]:
    """TEST/ADMIN-ONLY diagnostic (defense in depth, D-030): facts after the
    watermark that lack their event. Not scheduled, not called at startup,
    not exposed to any principal or tool — atomic transactions are the
    integrity model; this only detects what should be impossible."""
    gaps: list[str] = []
    async with db.acquire() as conn:
        wm = await conn.fetchval(
            "SELECT applied_at FROM schema_migrations WHERE filename = $1",
            WATERMARK_MIGRATION)
        if wm is None:
            return [f"watermark migration {WATERMARK_MIGRATION} not applied"]
        rows = await conn.fetch(
            "SELECT c.id FROM consents c WHERE c.decided_at > $1 "
            "AND NOT EXISTS (SELECT 1 FROM governance_events e WHERE "
            "e.event_type = 'consent.decided' AND e.subject_id = c.id::text)",
            wm)
        gaps += [f"consent.decided missing for consent {r['id']}" for r in rows]
        rows = await conn.fetch(
            "SELECT c.id FROM consents c WHERE c.used_at > $1 "
            "AND NOT EXISTS (SELECT 1 FROM governance_events e WHERE "
            "e.event_type = 'consent.burned' AND e.subject_id = c.id::text)",
            wm)
        gaps += [f"consent.burned missing for consent {r['id']}" for r in rows]
        legacy = await conn.fetchval(
            "SELECT count(*) FROM capability_events WHERE at > $1", wm)
        mirrored = await conn.fetchval(
            "SELECT count(*) FROM governance_events "
            "WHERE event_type = 'capability.changed' AND occurred_at > $1", wm)
        if legacy != mirrored:
            gaps.append(f"capability pair mismatch after watermark: "
                        f"{legacy} legacy rows vs {mirrored} mirrors")
    return gaps
