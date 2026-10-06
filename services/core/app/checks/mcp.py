"""The MCP servers family (S37a): changes to her connections, as notices.

One check: what changed in the last seven days that the owner did not do
himself — a server's tools changed, and a server he had added that she
replaced or removed. Each change is a row in the governance ledger, written
by app/mcp/servers.py in the transaction that made it.

The store files the notice the moment the change happens, whether or not the
watch beat is on (proactive.enabled ships off). This check derives the SAME
finding, with the same facts, from the ledger every hour — so the beat folds
onto that notice instead of raising a second one, and clears it once the
change is a week old. Non-urgent: nothing here wakes anyone.

KEY AND FACTS ARE SCOPED TO (kind, server), NEVER TO THE EVENT (ruling F17).
The governance event's own id never reaches the fingerprint — not in `key`,
not in `facts` — so two DIFFERENT events that leave a server in the same
shape (the same tools added, the same old and new origin) are the SAME news
and fold onto one notice, bumping `repeats`, rather than each minting a row
of its own. `facts` for a tool-list change is exactly spec §8's shape —
`{server, added, removed, changed}` — and the analogous four-or-fewer-field
shape for the other two kinds; nothing else rides along in it.
"""

from __future__ import annotations

from typing import Any

from app.checks import Check, Finding

CHANGES = "mcp_server_changes"
WINDOW_DAYS = 7
CONNECTED = "mcp.server_connected"
REMOVED = "mcp.server_removed"
TOOLS_CHANGED = "mcp.tools_changed"

_SQL = """
SELECT id, kind, meta FROM governance_events
 WHERE kind = ANY($1::text[]) AND created_at > now() - make_interval(days => $2)
 ORDER BY created_at, id
"""


def finding_for(event_id: Any, kind: str, meta: dict) -> Finding | None:
    """The notice a ledger event deserves, or None when the owner made the
    change himself. `event_id` names which event this reading came from, for
    a caller that wants to say so — it never reaches `key` or `facts`
    (ruling F17): two separate events that left the same server in the same
    shape are the same news, and must fold rather than each mint a new row
    every time the hourly check re-derives them from the ledger."""
    server = str(meta.get("name", "?"))
    if kind == TOOLS_CHANGED:
        added, removed, changed = (
            list(meta.get(key) or []) for key in ("added", "removed", "changed")
        )
        return Finding(
            key=f"mcp_change:{kind}:{server}",
            title=(
                f"{server}'s tools changed — {len(added)} added, {len(removed)} removed, "
                f"{len(changed)} changed; she uses the new list already"
            ),
            facts={"server": server, "added": added, "removed": removed, "changed": changed},
        )
    replaced = meta.get("replaced") if isinstance(meta.get("replaced"), dict) else None
    if (
        kind == CONNECTED
        and replaced
        and replaced.get("added_by") == "owner"
        and meta.get("added_by") == "nova"
    ):
        return Finding(
            key=f"mcp_change:{kind}:{server}",
            title=(
                f"Nova re-pointed {server}, which you had added: it was {replaced.get('origin')} "
                f"and is now {meta.get('origin')}"
            ),
            facts={"server": server, "from": replaced.get("origin"), "to": meta.get("origin")},
        )
    if kind == REMOVED and meta.get("previous_added_by") == "owner" and meta.get("by") == "nova":
        return Finding(
            key=f"mcp_change:{kind}:{server}",
            title=f"Nova removed {server}, which you had added ({meta.get('origin')})",
            facts={"server": server, "origin": meta.get("origin")},
        )
    return None


async def changes(app, pool) -> list[Finding]:
    rows = await pool.fetch(_SQL, [TOOLS_CHANGED, CONNECTED, REMOVED], WINDOW_DAYS)
    found = (finding_for(row["id"], row["kind"], row["meta"] or {}) for row in rows)
    return [finding for finding in found if finding is not None]


CHECKS: tuple[Check, ...] = (
    Check(
        name=CHANGES,
        describe=(
            "Changes to the MCP servers she is connected to that you did not make: a server's "
            "tools changing, and a server you added that she replaced or removed."
        ),
        urgent=False,
        run=changes,
    ),
)

NAMES: tuple[str, ...] = tuple(check.name for check in CHECKS)
