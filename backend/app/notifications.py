"""The record a notification IS — and the transcript row that renders it.

Jeremy, 2026-08-07: "I get push notifications from the PWA but when I click
on it, it brings me to chat but doesn't show me what the push notification
was. Notifications should be in chat, not just the notifications bell."

Before this module a notification was an httpx POST and a log line. Nothing
in the database said one had ever been raised, so there was nothing the chat
window could have shown him even in principle, and the tap carried no
identity for the app to resolve.

THE SHAPE
---------
One `notifications` row per piece of news. `record()` writes it together with
a `role='notification'` message in the operator's conversation — and that
message row stores NO TEXT. Migration 125 refuses one that does:

    CHECK (role <> 'notification'
           OR (content IS NULL AND metadata ? 'notification_id'))

so the transcript renders the notification row itself and the two physically
cannot drift. That is the "same record, derived one from the other" property
made mechanical rather than intended.

HONEST DELIVERY
---------------
The operator-visible-outcomes rule, which this repo has had to relearn
repeatedly: "accepted by transport" is not "received". So there is no
'delivered' state, no `delivered` boolean, and no code path from a provider
response to `state='opened'`:

    mark_accepted()  writes the literal 'accepted' — a relay took the bytes
    mark_failed()    writes 'failed', and the DB refuses it with no reason
    mark_opened()    writes 'opened', and is called by exactly one thing:
                     the authenticated endpoint the chat panel hits AFTER it
                     has put the item on screen

`confirmed()` below is the only function that answers "did this reach a
human", and it answers True for one state.

ANTI-NAG
--------
`fingerprint()` derives a key from the news itself (kind is packaging, the
body is the news), so the same alert arriving twice inside
`DEDUPE_WINDOW_S` refreshes one record instead of buzzing twice. Derived
from content, never a maintained list — the failures.py pattern. A repeat of
something that FAILED is not suppressed: there is nothing to be quiet about
when the first attempt never landed.
"""

import hashlib
import json
import logging
import re
import sys
import uuid as uuid_mod
from pathlib import Path
from typing import Optional

from app import db

log = logging.getLogger(__name__)

#: Where this repo's test suites live, derived from THIS file's own location.
#: Nobody maintains a list of suite names — see `test_context`.
_TESTS_DIR = Path(__file__).resolve().parent.parent / "tests"


def _live_database() -> bool:
    """Is this process pointed at the SAME database as the running backend?

    Answered by comparison, never by naming a database "live": the backend is
    the container's PID 1, and its DATABASE_URL — read from /proc/1/environ —
    is the one record of the operator's database that a test process cannot
    repoint. A suite that made itself a throwaway database
    (test_notification_in_chat) rewrote the env BEFORE app.config imported,
    so its settings disagree with PID 1's and it stays free to exercise the
    real write path against its own scratch schema.

    Unreadable or absent answers True — fail closed. Refusing a write to a
    scratch database costs one test a workaround; allowing one to the
    operator's conversation is the defect this exists for.
    """
    from app.config import settings
    try:
        environ = Path("/proc/1/environ").read_bytes()
    except OSError:
        return True
    for chunk in environ.split(b"\0"):
        if chunk.startswith(b"DATABASE_URL="):
            try:
                url = chunk.split(b"=", 1)[1].decode()
            except UnicodeDecodeError:
                return True
            return url == settings.database_url
    return True


def test_context() -> Optional[str]:
    """Why live notification writes must be refused for this caller — or None.

    The goal gate already refuses to raise operator cards when
    `fixtures.active()` (tools/registry.py), because a graded run must not
    leave artifacts in front of the operator. This asks the same question for
    every notification write, plus its sibling the suites keep hitting: a
    test script in this repo runs against the live Postgres, so its
    notifications landed in Jeremy's REAL conversation — 139 junk rows
    ('Nova recommends: t', eval announcements for suites that do not exist)
    between 2026-08-07 and 2026-08-08.

    Both signals are derived, never a maintained list of suite names:

      * `fixtures.active()` is the eval harness's own contextvar, live for
        exactly the duration of a graded call;
      * the process's entry point living under backend/tests, while its
        settings still point at the backend's own database (see
        `_live_database`), is what a suite run IS.
    """
    from app.tools import fixtures
    if fixtures.active() is not None:
        return "a graded eval run's fixtures are active in this context"
    main_file = getattr(sys.modules.get("__main__"), "__file__", None)
    if main_file:
        try:
            path = Path(main_file).resolve()
        except OSError:
            return None
        if path.is_relative_to(_TESTS_DIR) and _live_database():
            return (f"this process is the test suite ({path.name}) running "
                    f"against the live database")
    return None

#: The only state that means a person's device actually rendered this.
OPENED = "opened"

#: How long two identical pieces of news count as one. Short on purpose: this
#: exists to stop one event fanning out through two callers (the heartbeat
#: raises an inbox card AND pushes the same text), not to swallow a genuine
#: repeat an hour later.
DEDUPE_WINDOW_S = 300

#: How much of the body identifies the news. STRICTLY INSIDE the tightest
#: truncation any caller applies — recommendations.create pushes `body[:140]`
#: while the raiser pushes the whole text — because a window at exactly 140
#: would compare 140 collapsed characters of the long form against however
#: many 140 raw characters collapse to in the short one, and the same event
#: would fingerprint two ways. Below the truncation, the short form's
#: normalised text is a prefix of the long form's and the two agree.
FP_CHARS = 100

_FIELDS = ("id", "conversation_id", "message_id", "kind", "source", "title",
           "body", "click_url", "tags", "priority", "recommendation_id",
           "fingerprint", "repeats", "last_repeat_at", "state", "provider",
           "transport_id", "accepted_at", "error", "opened_at", "opened_via",
           "created_at")


def fingerprint(body: str, *, kind: str = "") -> str:
    """A stable key for "this exact piece of news".

    Whitespace-normalised and cut to FP_CHARS, so the same alert delivered by
    two callers — one of which truncates — collapses to one key. The kind
    rides along only when a caller supplies one it wants kept distinct.
    """
    text = re.sub(r"\s+", " ", (body or "")).strip().lower()[:FP_CHARS]
    return hashlib.sha256(f"{kind}\x00{text}".encode()).hexdigest()[:32]


def confirmed(row) -> bool:
    """Did this reach a person? The ONE function allowed to answer that.

    Not `state == 'accepted'`, which is what a relay said about bytes it
    took, and not the absence of an error. A notification is confirmed when
    a client that put it on screen said so.
    """
    return bool(row["state"] == OPENED and row["opened_at"] is not None)


def delivery_label(row) -> str:
    """One line an operator can act on, derived from the row's own state.

    Every branch except `opened` says out loud that receipt is unproven. A
    checkmark for 'accepted' is exactly the false success this whole file
    exists to prevent.
    """
    state = row["state"]
    # DERIVED FROM `confirmed`, not from the state string, so the one sentence
    # that claims receipt and the one function that decides receipt cannot
    # disagree. A row wearing state='opened' with no `opened_at` is impossible
    # through the database (migration 125 refuses it) — but "impossible
    # upstream" is how false receipts get written, so it is refused here too
    # and falls through to the honest branches below.
    if confirmed(row):
        return "opened on your device"
    if state == OPENED:
        return ("recorded as opened with no time — treat receipt as "
                "unproven")
    if state == "accepted":
        via = f" by {row['provider']}" if row["provider"] else ""
        return f"accepted{via} — not confirmed received"
    if state == "failed":
        return f"not delivered — {row['error'] or 'no reason recorded'}"
    return "not sent yet"


def _row(r) -> dict:
    d = {k: r[k] for k in _FIELDS if k in r}
    for k in ("id", "conversation_id", "message_id", "recommendation_id"):
        d[k] = str(d[k]) if d.get(k) else None
    for k in ("last_repeat_at", "accepted_at", "opened_at", "created_at"):
        d[k] = str(d[k]) if d.get(k) else None
    d["tags"] = list(d.get("tags") or [])
    # DERIVED on every read, never stored. A stored copy of "did this land"
    # is a second source of truth about the one thing here that must not be
    # wrong.
    d["confirmed"] = confirmed(r)
    d["delivery_label"] = delivery_label(r)
    return d


def deep_link(notification_id: str) -> str:
    """Where a tap on this notification must land.

    The id travels in the URL because that is the only channel that survives
    every path into the app: a cold start, a service worker `navigate`, a
    pasted link. The postMessage channel in push-sw.js is the fallback for
    engines with no `WindowClient.navigate` — losing the id on that path is
    the bug being fixed.
    """
    return f"/chat?notification={notification_id}"


async def record(body: str, *, title: Optional[str] = None,
                 kind: str = "alert", source: Optional[str] = None,
                 click_url: Optional[str] = None,
                 tags: Optional[list[str]] = None,
                 priority: Optional[str] = None,
                 recommendation_id: Optional[str] = None,
                 dedupe_key: Optional[str] = None) -> dict:
    """Write the notification and its transcript row, in one transaction.

    Returns {notification, in_chat, why} — `in_chat` False always carries a
    reason. A notification that could not be placed in the conversation is
    still recorded, because the delivery state has to live somewhere even
    when the transcript half failed; what it must never do is claim it was
    placed.

    `dedupe_key` overrides the content fingerprint for callers that already
    have a stable identity for the news (the heartbeat's text digest).

    REFUSES test traffic, loudly. A suite run or a graded eval reaching this
    function would put its row in the operator's real conversation — which is
    not a hypothetical, it is 139 measured rows — so the write fails with the
    reason rather than succeeding quietly or, worse, skipping quietly.
    `notify.send` catches this and reports it as `record_error`, so the
    caller is told the conversation half did not happen.
    """
    from app import conversations

    refused = test_context()
    if refused:
        raise RuntimeError(
            f"refused: {refused} — a test's notification must not land in "
            f"the operator's conversation. Nothing was recorded.")

    fp = dedupe_key.strip() if (dedupe_key or "").strip() else fingerprint(body, kind="")
    nid = uuid_mod.uuid4()
    mid = uuid_mod.uuid4()

    # Which conversation. Explicitly the OPERATOR's: migration 118 gave
    # guests their own conversation rows, and `get_or_create_active_
    # conversation` takes the newest row of any kind — so trusting it would
    # eventually post Nova's private alerts into a stranger's chat window.
    cid: Optional[str]
    why = ""
    try:
        cid = await conversations.operator_conversation_id()
    except Exception as e:                                    # noqa: BLE001
        log.exception("could not resolve the operator conversation")
        cid, why = None, f"could not resolve the conversation: {e}"

    async with db.acquire() as conn:
        async with conn.transaction():
            if cid:
                try:
                    await conn.execute(
                        """INSERT INTO messages (id, conversation_id, role,
                                                 content, metadata)
                           VALUES ($1, $2, 'notification', NULL, $3::jsonb)""",
                        mid, uuid_mod.UUID(cid),
                        json.dumps({"notification_id": str(nid)}))
                except Exception as e:                        # noqa: BLE001
                    # Re-raised: the transcript row and the notification are
                    # one unit. A half-write leaves a push with nothing to
                    # deep-link to, which is the failure being fixed.
                    raise RuntimeError(
                        f"the transcript row could not be written: {e}") from e
            r = await conn.fetchrow(
                """INSERT INTO notifications
                       (id, conversation_id, message_id, kind, source, title,
                        body, click_url, tags, priority, recommendation_id,
                        fingerprint)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                   RETURNING *""",
                nid, uuid_mod.UUID(cid) if cid else None,
                mid if cid else None, kind, source, title, body, click_url,
                list(tags or []), priority,
                uuid_mod.UUID(str(recommendation_id)) if recommendation_id else None,
                fp)
    out = _row(r)
    if not cid and not why:
        why = "no operator conversation exists yet"
    return {"notification": out, "in_chat": bool(cid), "why": why}


async def find_repeat(fp: str, window_s: int = DEDUPE_WINDOW_S) -> Optional[dict]:
    """The live notification this news already has, if any.

    'failed' is NOT a repeat to suppress. The first attempt never reached
    anybody, so being quiet about the second would turn a broken transport
    into silence — the exact shape of a fallback that reads as success.
    """
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            """SELECT * FROM notifications
                WHERE fingerprint = $1
                  AND state <> 'failed'
                  AND created_at > now() - make_interval(secs => $2::float)
                ORDER BY created_at DESC LIMIT 1""", fp, float(window_s))
    return _row(r) if r else None


async def note_repeat(notification_id: str) -> None:
    """Count a suppressed duplicate. Silence with a number beside it is a
    decision; silence alone is a disappearance.

    Except a TEST'S duplicate, which is not news arriving twice — it is a
    suite fingerprint-colliding with a live row. One pending junk row on this
    install wore repeats=21 from exactly that, each bump written by a suite
    run onto a real notification. Skipped with a log line, never raised:
    `notify.send` calls this outside any try, so a raise here would escape
    its never-raises contract.
    """
    refused = test_context()
    if refused:
        log.info("note_repeat skipped — %s", refused)
        return
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE notifications SET repeats = repeats + 1, "
            "last_repeat_at = now() WHERE id = $1",
            uuid_mod.UUID(str(notification_id)))


async def mark_accepted(notification_id: str, *, provider: Optional[str],
                        transport_id: Optional[str] = None) -> Optional[dict]:
    """A relay took the bytes. THAT IS ALL THIS MEANS.

    Writes the literal 'accepted'. There is no argument, flag or provider
    response that can make this function write 'opened' — the two callers
    that would want to (a 202 from ntfy, a 201 from a push service) are
    telling us about a queue, not about a person.
    """
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            """UPDATE notifications
                  SET state = 'accepted', accepted_at = now(),
                      provider = $2, transport_id = $3
                WHERE id = $1 AND state = 'pending' RETURNING *""",
            uuid_mod.UUID(str(notification_id)), provider,
            str(transport_id) if transport_id is not None else None)
    return _row(r) if r else None


async def mark_failed(notification_id: str, *, provider: Optional[str],
                      error: str) -> Optional[dict]:
    """The transport refused it, and says why.

    The reason is not optional and not allowed to be empty: migration 125's
    `notifications_failed_has_reason` rejects the row, so a caller that
    swallowed its exception cannot record a blank failure.
    """
    reason = (error or "").strip() or "the provider gave no reason"
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            """UPDATE notifications
                  SET state = 'failed', provider = $2, error = $3
                WHERE id = $1 AND state = 'pending' RETURNING *""",
            uuid_mod.UUID(str(notification_id)), provider, reason[:2000])
    return _row(r) if r else None


async def mark_opened(notification_id: str, *, via: str = "chat") -> Optional[dict]:
    """A client put this in front of a person and says so.

    The only writer of the one state that means receipt, and it is reachable
    only from the authenticated open endpoint. `opened_at IS NULL` in the
    WHERE keeps the first confirmation — a second tap does not restamp it.

    Also retires the linked inbox card from the bell: news that has been read
    in the conversation must not keep demanding attention somewhere else.
    Only 'new' -> 'seen', so an operator decision is never overwritten and a
    card he has not acted on stays in the inbox.
    """
    try:
        nid = uuid_mod.UUID(str(notification_id))
    except (ValueError, AttributeError, TypeError):
        return None
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            """UPDATE notifications
                  SET state = 'opened', opened_at = now(), opened_via = $2
                WHERE id = $1 AND opened_at IS NULL RETURNING *""", nid, via[:40])
        if r is None:                       # already open, or no such row
            r = await conn.fetchrow("SELECT * FROM notifications WHERE id = $1", nid)
            if r is None:
                return None
        if r["recommendation_id"]:
            await conn.execute(
                "UPDATE recommendations SET status = 'seen' "
                "WHERE id = $1 AND status = 'new'", r["recommendation_id"])
    return _row(r)


async def link_recommendation(notification_id: str,
                              recommendation_id: str) -> bool:
    """Attach an inbox card to a notification that was raised before it.

    The heartbeat pushes first (so the run history gets a real, unraced
    delivery outcome) and raises its card second. Without this the two halves
    of one finding would stay strangers, and opening the notification in chat
    would leave the card badging the bell about news already read.

    Only fills an EMPTY link: re-pointing a notification at a different card
    would silently change which card gets retired.
    """
    try:
        nid = uuid_mod.UUID(str(notification_id))
        rid = uuid_mod.UUID(str(recommendation_id))
    except (ValueError, AttributeError, TypeError):
        return False
    async with db.acquire() as conn:
        result = await conn.execute(
            "UPDATE notifications SET recommendation_id = $2 "
            "WHERE id = $1 AND recommendation_id IS NULL", nid, rid)
    return result.endswith("1")


async def get(notification_id: str) -> Optional[dict]:
    try:
        nid = uuid_mod.UUID(str(notification_id))
    except (ValueError, AttributeError, TypeError):
        return None
    async with db.acquire() as conn:
        r = await conn.fetchrow("SELECT * FROM notifications WHERE id = $1", nid)
    return _row(r) if r else None


async def by_ids(ids: list[str]) -> dict[str, dict]:
    """Hydration for the transcript: notification id -> row.

    The transcript stores only the id, so this is where a chat item gets its
    text. One query for the page.
    """
    wanted = []
    for i in ids:
        try:
            wanted.append(uuid_mod.UUID(str(i)))
        except (ValueError, AttributeError, TypeError):
            continue
    if not wanted:
        return {}
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM notifications WHERE id = ANY($1::uuid[])", wanted)
    return {str(r["id"]): _row(r) for r in rows}


async def recent(limit: int = 50) -> list[dict]:
    limit = max(1, min(200, limit))
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM notifications ORDER BY created_at DESC LIMIT $1", limit)
    return [_row(r) for r in rows]
