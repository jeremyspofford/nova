"""Her side of events (S37c T10): events_recent and event_sender_add.

docs/plans/rebuild/s37c/spec.md §2.9: "did the CI failure get looked at?" must
be a fact she can READ — the event row, its state, the turn that read it and
the notice it became — not a memory of a sentence she wrote. §2.1: a sender is
configuration she can make, and its key goes only to the owner's screen.

TWO THINGS ARE LOAD-BEARING HERE:

* **The payload never reaches her through this tool.** It is a program's data
  and may quote a stranger (a PR title, an issue body). It reaches her once,
  inside the code-written frame of the turn that read it (events.frame). Here
  she gets its size and the turn id that leads to it.
* **The key never reaches her.** event_sender_add calls the one add path,
  events.create_sender, with reveal_once=True: the token is kept for ONE read
  by the owner's Settings > Events page and this module never puts it into a
  result, a log line or anything a span could copy. `Created.token` is not
  read here at all.

Nothing here is an approval (owner ruling 2026-09-03, tests/test_no_approvals.py):
a refusal is a CANNOT — a malformed or built-in name, a name taken, a gateway
that did not take the role — never a MAY NOT.
"""

from __future__ import annotations

from app import db
from app.tools.base import RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure

DEFAULT_LIMIT = 20
MAX_LIMIT = 50
SHORT_ID_CHARS = 8
# Where the owner finds a key she made, in the page's own words.
KEY_PLACE = "Settings > Events"
_TIME_FORMAT = "%Y-%m-%d %H:%M UTC"

# The event_outcomes notice for each event: T4 keys it by the turn that read
# the event, or by the event's own id when no turn ever opened for it. The
# newest such notice is the one the Inbox shows.
_RECENT_SQL = """
SELECT e.id, e.sender, e.received_at, e.state, e.reason, e.turn_id, e.urgent,
       octet_length(e.payload) AS size,
       n.id AS notice_id, n.state AS notice_state, n.failed_reason AS notice_failed
  FROM events e
  LEFT JOIN LATERAL (
        SELECT id, state, failed_reason
          FROM notices
         WHERE check_name = $3
           AND finding_key IN ('event_turn:' || e.turn_id::text, 'event:' || e.id::text)
         ORDER BY first_seen_at DESC
         LIMIT 1
  ) n ON true
 WHERE ($1::text IS NULL OR e.sender = $1)
 ORDER BY e.received_at DESC, e.id DESC
 LIMIT $2
"""


def _events():
    """app.events, imported at call time (it reaches chat, which imports this
    package — the idiom every tool module here uses)."""
    from app import events

    return events


def _told(row) -> str:
    """Whether he was told, in the notices tool's own words."""
    from app import notices

    if row["notice_id"] is None:
        return "no notice yet"
    told = {
        notices.RAISED: "you have not been told",
        notices.DELIVERED: "told",
        notices.FAILED: f"NOT delivered ({row['notice_failed']})",
        notices.MUTED: "muted",
    }.get(row["notice_state"], row["notice_state"])
    return f"notice {str(row['notice_id'])[:SHORT_ID_CHARS]}: {told}"


def _line(row) -> str:
    parts = [
        f"{str(row['id'])[:SHORT_ID_CHARS]}  from {row['sender']}",
        f"received {row['received_at'].strftime(_TIME_FORMAT)}",
        row["state"] + (f" ({row['reason']})" if row["reason"] else ""),
        f"turn {row['turn_id']}" if row["turn_id"] is not None else "no turn",
        _told(row),
        f"payload {row['size']} bytes" if row["size"] is not None else "no payload kept",
    ]
    if row["urgent"]:
        parts.append("urgent")
    return " · ".join(parts)


async def events_recent(args: dict, ctx: ToolContext) -> str:
    """The newest events, newest first, each with what became of it.

    The count is stated apart from the lines, so a list cut at the limit never
    reads as the whole of it, and an unknown sender is a stated CANNOT rather
    than an empty list she would repeat to him as "nothing came in"."""
    events = _events()
    from app.checks import events as event_checks

    given = args.get("sender")
    sender = None
    if given is not None and str(given).strip():
        try:
            sender = events.check_name(str(given).strip())
        except events.SenderError as exc:
            raise ToolFailure(str(exc)) from None
    limit = int(args.get("limit") or DEFAULT_LIMIT)
    pool = await db.get_pool()
    rows = await pool.fetch(_RECENT_SQL, sender, limit, event_checks.OUTCOMES)
    where = f" from {sender}" if sender else ""
    if not rows:
        if sender is not None and sender not in await events.sender_names(pool):
            names = ", ".join(await events.sender_names(pool)) or "none"
            raise ToolFailure(
                f"no event sender is named {sender!r} and no events came from it — "
                f"the senders are: {names}."
            )
        return f"No events{where}."
    head = f"{len(rows)} event(s){where}, newest first"
    if len(rows) == limit:
        head += f" — the newest {limit}; there may be older ones"
    return "\n".join([f"{head}:", *(_line(row) for row in rows)])


async def event_sender_add(args: dict, ctx: ToolContext) -> str:
    """Add a sender another program can call, and make its routing role.

    Only events.create_sender adds one (the gateway's answer read back; a role
    not taken removes the sender again). The key it mints is kept for one
    reveal on the owner's page; this function never reads it."""
    events = _events()
    name = str(args.get("name") or "").strip()
    pool = await db.get_pool()
    try:
        created = await events.create_sender(ctx.app, pool, name, added_by="nova", reveal_once=True)
    except events.SenderError as exc:
        raise ToolFailure(f"the sender was not added: {exc}") from None
    except events.RouteFailed as exc:
        raise ToolFailure(
            f"the sender was not added — its routing role was not made, so it was removed "
            f"again: {exc}"
        ) from None
    sender = created.sender
    return (
        f"Added event sender {sender['name']!r} (role {sender['role']}; until Routing gives "
        f"that role its own chain, its turns use chat's). {created.route.detail}. "
        f"A program starts a turn of mine with POST /api/v1/events/{sender['name']} and its "
        f"key as a Bearer token. The key is waiting on {KEY_PLACE}, where he can show it "
        f"once; I do not hold it and cannot read it back."
    )


def _obj(properties: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": properties, "required": required}


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="events_recent",
        description=(
            "Read the newest events other programs (and her own monitoring and GitHub CI) "
            "sent: per event the sender, when it came, its state (queued, running, done, "
            "failed, refused) and why, the turn that read it, and the Inbox notice it became "
            "and whether he was told. How to answer 'did that CI failure get looked at?'. "
            "The payload itself is not shown — the turn that read it holds it."
        ),
        parameters=_obj(
            {
                "sender": {
                    "type": "string",
                    "description": "Only this sender's events (its name). Omit for every sender.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_LIMIT,
                    "description": (
                        f"How many events, newest first, up to {MAX_LIMIT}. "
                        f"Defaults to {DEFAULT_LIMIT}."
                    ),
                },
            },
            [],
        ),
        executor=events_recent,
        reads_only=True,
        result_kind=RESULT_KIND_LISTING,
    ),
    Tool(
        name="event_sender_add",
        description=(
            "Add an event sender: a name another program (a backup script, a CI job, a "
            "monitor) uses to start a turn of yours with POST /api/v1/events/<name>. Its key "
            f"is shown to him once on {KEY_PLACE} — you never see it. Its turns run under "
            "the routing role event_<name>. A name is a lowercase letter, then lowercase "
            "letters or underscores, up to 26."
        ),
        parameters=_obj(
            {
                "name": {
                    "type": "string",
                    "description": "The sender's name, e.g. backups.",
                }
            },
            ["name"],
        ),
        executor=event_sender_add,
    ),
)
