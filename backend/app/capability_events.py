"""Nova notices when what she can do changes.

The platform-state block answers "what exists now". This answers "what
changed", which is a different question and the one she needs to manage
anything: you cannot fix a misconfiguration you never noticed, and you
cannot explain a capability you did not know you lost.

Recording is FIRE AND FORGET and never raises. A capability change that
fails to log is a missing line in a note; a capability change that fails
BECAUSE of logging is a broken feature. The former is always the better
trade, so every call site is wrapped.

Deliberately not recorded: system prompts and tool schemas. They are long,
and this text is read back into a prompt — putting prompt text inside a
block that becomes prompt text is how you get a hall of mirrors.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from app import bg, db

log = logging.getLogger(__name__)

# Kinds, so a typo does not silently create a category nobody reads.
AGENT = "agent"
TOOL = "tool"
SKILL = "skill"
MCP_SERVER = "mcp_server"
# Who Nova recognises. A person carries a ROLE, and a role narrows tools
# (voice.family_tools), so creating or learning about one changes what the
# system will do — which is the definition this log exists for.
PERSON = "person"
# The operator's answer to something she proposed. Not a capability change in
# itself, and here anyway: this is the one channel by which a decision of his
# reaches her at all. Before it existed, "approve" was a status column nobody
# read — he clicked, the card left the banner, and she never found out.
RECOMMENDATION = "recommendation"

# How much history the prompt block may spend. Small on purpose: this is a
# nudge, not an archive — `list_capability_changes` is there for the rest.
PROMPT_LIMIT = 8
PROMPT_WINDOW_HOURS = 72


async def _write(kind: str, subject: str, action: str, actor: str, detail: dict) -> None:
    async with db.acquire() as conn:
        await conn.execute(
            "INSERT INTO capability_events (kind, subject, action, actor, detail) "
            "VALUES ($1, $2, $3, $4, $5::jsonb)",
            kind, subject, action, actor or "operator", json.dumps(detail or {}))


def record(kind: str, subject: str, action: str, *,
           actor: str = "operator", detail: Optional[dict] = None) -> None:
    """Log a capability change. Never raises, never blocks the caller."""
    async def _go():
        try:
            await _write(kind, subject, action, actor, detail or {})
        except Exception:
            log.exception("capability event not recorded: %s %s %s",
                          kind, subject, action)
    bg.spawn(_go(), name="capability-event")


def diff_grants(before: Any, after: Any) -> dict:
    """{granted: [...], revoked: [...]} for an allowed_tools change.

    The whole point of the log: `updated_at` moving tells you nothing, and
    "allowed_tools changed" tells you almost nothing. Which grants appeared
    and which vanished is the fact worth keeping.
    """
    if before is None and after is None:
        return {}
    b, a = set(before or []), set(after or [])
    out = {}
    if a - b:
        out["granted"] = sorted(a - b)
    if b - a:
        out["revoked"] = sorted(b - a)
    return out


async def recent(limit: int = 50, hours: Optional[int] = None) -> list[dict]:
    """Newest first."""
    where, params = "", [limit]
    if hours:
        where = "WHERE at > now() - ($2 || ' hours')::interval"
        params.append(str(hours))
    async with db.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT at, kind, subject, action, actor, detail "
            f"FROM capability_events {where} ORDER BY at DESC LIMIT $1", *params)
    return [{"at": str(r["at"]), "kind": r["kind"], "subject": r["subject"],
             "action": r["action"], "actor": r["actor"],
             "detail": json.loads(r["detail"]) if isinstance(r["detail"], str)
                       else (r["detail"] or {})}
            for r in rows]


def _phrase(e: dict) -> str:
    """One line, in the order a person would say it."""
    d = e.get("detail") or {}
    bits = f"{e['kind']} {e['subject']} {e['action']}"
    if d.get("granted"):
        bits += f" (+{', '.join(d['granted'])})"
    if d.get("revoked"):
        bits += f" (-{', '.join(d['revoked'])})"
    if d.get("model"):
        bits += f" (model {d['model']})"
    by = e.get("actor") or "operator"
    return f"- {bits} — by {by}"


async def prompt_block() -> str:
    """The block Nova sees. Empty string when nothing changed, so a quiet
    week costs no tokens."""
    try:
        events = await recent(limit=PROMPT_LIMIT, hours=PROMPT_WINDOW_HOURS)
    except Exception:
        log.exception("capability changes unavailable; continuing without them")
        return ""
    if not events:
        return ""
    lines = "\n".join(_phrase(e) for e in events)
    return ("## What changed about you recently\n"
            f"{lines}\n"
            "These are changes to your OWN capabilities, newest first. If one "
            "explains something you can no longer do, say so plainly rather "
            "than trying anyway. Use list_capability_changes to look further "
            "back.")
