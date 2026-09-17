"""Her side of the Inbox: notices, notice_mute, notice_seen.

She writes the daily digest into his conversation and then, until this
module existed, could not answer a single question about it. "What was that
timer thing you mentioned?" had no tool behind it — the facts were in a
table she could not read, so the honest answer was that she did not know and
the dishonest one was to reconstruct it from the sentence she had written
earlier. That gap IS the task (CLAUDE.md): the answer is a capability, not
another button on a page.

NOTHING HERE IS AN APPROVAL, and that is load-bearing rather than incidental
(owner ruling 2026-09-03, tests/test_no_approvals.py). `notice_seen` writes
a read receipt. `notice_mute` is a NOISE preference — stop telling me about
this condition until it clears. Neither permits or forbids anything, neither
waits on him, and neither is a thing he has to come and click before she can
continue. A refusal from this module is always a CANNOT (no such row, no
such view, an ambiguous id), never a MAY NOT.

TWO THINGS THE SPEC ASKED FOR BY NAME (S25.2.3):

* **A mute records WHO made it.** `muted_by` is his person id when he clicks
  it in the Inbox and NULL when she calls this tool, and the page says which.
  A silence he did not ask for must not be indistinguishable from one he
  did — that is how a v3-style nag becomes a v3-style blackout instead.
* **Muting is not handling.** Silencing a card does not touch the condition,
  and she must not say she dealt with it because she muted it. That is the
  capability guard's territory rather than this module's, but the words here
  are chosen not to help: every sentence this module returns about a mute
  says "you will not be told", never "fixed", "handled" or "resolved".

`notices` declares RESULT_KIND_LISTING so the presented-listing guard learns
of it from the registry rather than from a name someone typed twice.
"""

from __future__ import annotations

import uuid

import asyncpg

from app import db
from app.tools.base import RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure

# How many rows one call reads, and the ceiling a bigger ask is trimmed to.
# A page of forty notices is not something she can say out loud anyway, and
# the count below tells her how many there were, so a trimmed list never
# reads as a complete one.
DEFAULT_LIMIT = 20
MAX_LIMIT = 100
# The id prefix the listing prints, and the shortest thing an id argument may
# be. Long enough that a collision is a real accident rather than a typo.
SHORT_ID_CHARS = 8


def _store():
    """app.notices, imported at call time — the idiom every tool module in
    this package uses, because `app.notices` pulls in `app.checks`, which
    pulls in half the service, and a module-time import here would close a
    cycle through `app.tools`."""
    from app import notices

    return notices


def _fail(exc: Exception) -> ToolFailure:
    """The store's own sentence, as the tool's stated reason. Never a
    reworded one: the store says exactly what could not be done and why, and
    a second wording is a second thing to keep true."""
    return ToolFailure(str(exc))


async def _one(pool: asyncpg.Pool, given: str) -> uuid.UUID:
    """The notice a string names — a full id, or the short form the listing
    prints.

    An id that matches nothing, and an id that matches more than one row, are
    both stated refusals naming what was found. A prefix search that silently
    took the first match would act on a row she did not mean, and the row she
    did not mean is somebody's only notice about something being broken.
    """
    text = (given or "").strip()
    if not text:
        raise ToolFailure("no notice id was given — ids come from the notices tool's listing.")
    try:
        return uuid.UUID(text)
    except ValueError:
        pass
    if len(text) < SHORT_ID_CHARS:
        raise ToolFailure(
            f"{text!r} is too short to name a notice — use the id as the listing prints it "
            f"(at least {SHORT_ID_CHARS} characters)."
        )
    rows = await pool.fetch(
        "SELECT id, title FROM notices WHERE id::text LIKE $1 || '%' LIMIT 5", text.lower()
    )
    if not rows:
        raise ToolFailure(f"no notice starts with {text!r} — nothing was written.")
    if len(rows) > 1:
        names = "; ".join(f"{r['id']} ({r['title']})" for r in rows)
        raise ToolFailure(f"{text!r} names more than one notice — say which: {names}")
    return rows[0]["id"]


def _line(notice) -> str:
    """One notice, as a line she can read out. The facts are core's, in
    core's words: the title the CHECK composed (never a model's sentence
    about it), the state, and whether the condition is still true.

    `cleared` is said as "the condition stopped" rather than as "fixed" or
    "handled" — a check stopped finding it, and nobody here knows why.
    """
    notices = _store()
    if notice.cleared_at is not None:
        standing = "the condition stopped"
    else:
        standing = "still true"
    told = {
        notices.RAISED: "you have not been told",
        notices.DELIVERED: "told",
        notices.FAILED: f"NOT delivered ({notice.failed_reason})",
        notices.MUTED: "muted",
    }.get(notice.state, notice.state)
    read = "read" if notice.seen_at is not None else "unread"
    repeats = "" if notice.repeats == 1 else f", seen {notice.repeats}x"
    return (
        f"{str(notice.id)[:SHORT_ID_CHARS]}  {notice.title} "
        f"[{notice.check_name}; {standing}; {told}; {read}{repeats}]"
    )


async def notices_list(args: dict, ctx: ToolContext) -> str:
    """The rows behind the Inbox — and behind the digest she wrote.

    The count is stated separately from the lines, so a list trimmed to the
    limit can never read as the whole of it. "There are 3" and "here are 3 of
    31" are different answers and she must be able to give the second one.
    """
    notices = _store()
    view = str(args.get("state") or "unread").strip().lower()
    check = args.get("check")
    check_name = str(check).strip() if check else None
    try:
        limit = min(int(args.get("limit") or DEFAULT_LIMIT), MAX_LIMIT)
    except (TypeError, ValueError):
        raise ToolFailure("limit must be a number of rows.") from None
    pool = await db.get_pool()
    try:
        rows = await notices.listing(pool, view=view, check_name=check_name, limit=limit)
    except Exception as exc:  # noqa: BLE001 - the store's reason is the answer
        raise _fail(exc) from exc
    where = f" from {check_name}" if check_name else ""
    if not rows:
        return f"No {view} notices{where}."
    head = f"{len(rows)} {view} notice(s){where}"
    if len(rows) == limit:
        head += f" — the newest {limit}; there may be older ones"
    return "\n".join([f"{head}:", *(_line(row) for row in rows)])


async def notice_mute(args: dict, ctx: ToolContext) -> str:
    """Silence a condition, or lift a silence.

    The sentence it answers with says what a mute DOES and what it does not:
    he stops being told, the condition is untouched, and the silence ends
    when the condition clears. Nothing here says "handled".

    `muted` is never defaulted — "notice_mute(id)" with no verb is as likely
    to mean unmute as mute, and guessing silences something nobody asked to
    silence. There is no check for it HERE, though: it is declared required
    and boolean in the parameters below, and dispatch refuses a missing or
    wrongly-typed argument by name before this function runs. A second
    check in here would be a weaker copy of that, kept true by hand.
    """
    notices = _store()
    muted = bool(args["muted"])
    pool = await db.get_pool()
    notice_id = await _one(pool, str(args.get("id") or ""))
    try:
        # `muted_by` stays NULL: SHE muted this, and the Inbox says so. A
        # silence he did not ask for must not look like one he did.
        row = await notices.set_muted(pool, notice_id, muted, muted_by=None)
    except Exception as exc:  # noqa: BLE001 - the store's reason is the answer
        raise _fail(exc) from exc
    if muted:
        return (
            f"Muted: {row.title}. He will not be told about this again unless it clears and "
            "comes back. Nothing about the condition itself changed."
        )
    return f"Unmuted: {row.title}. The next digest may carry it again."


async def notice_seen(args: dict, ctx: ToolContext) -> str:
    """Record that it has been read. A receipt and nothing else — it stops no
    digest and silences nothing, which is exactly what went wrong when one
    click meant both (S25.1.3)."""
    notices = _store()
    pool = await db.get_pool()
    notice_id = await _one(pool, str(args.get("id") or ""))
    try:
        row = await notices.mark_seen(pool, notice_id)
    except Exception as exc:  # noqa: BLE001 - the store's reason is the answer
        raise _fail(exc) from exc
    return (
        f"Marked read: {row.title}. That is a receipt only — it is still owed to him if it is "
        "still true and nobody was told."
    )


def _obj(properties: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": properties, "required": required}


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="notices",
        description=(
            "Read the Inbox — what the checks found, in the words the check wrote, with "
            "whether he was told and whether the condition is still true. This is what the "
            "daily digest was composed from, so it is how to answer a question about one. "
            "state: 'unread' (default) what he has not read, 'muted' what has been silenced, "
            "'cleared' conditions that stopped, 'all'."
        ),
        parameters=_obj(
            {
                "state": {
                    "type": "string",
                    "enum": ["unread", "muted", "cleared", "all"],
                    "description": "Which view. Defaults to unread.",
                },
                "check": {
                    "type": "string",
                    "description": (
                        "Only notices from this check (its registered name, as the listing "
                        "shows it). Omit for every check."
                    ),
                },
                "limit": {
                    "type": "integer",
                    "description": (
                        f"How many rows, up to {MAX_LIMIT}. Defaults to {DEFAULT_LIMIT}."
                    ),
                },
            },
            [],
        ),
        executor=notices_list,
        reads_only=True,
        result_kind=RESULT_KIND_LISTING,
    ),
    Tool(
        name="notice_mute",
        description=(
            "Stop telling him about a condition until it clears, or lift that silence "
            "(muted=false). A NOISE preference and nothing else: it permits nothing, it "
            "fixes nothing, and the condition goes on being true. The silence ends by itself "
            "when the condition stops."
        ),
        parameters=_obj(
            {
                "id": {
                    "type": "string",
                    "description": "The notice's id, as the notices tool prints it.",
                },
                "muted": {
                    "type": "boolean",
                    "description": "true to silence it, false to let it speak again.",
                },
            },
            ["id", "muted"],
        ),
        executor=notice_mute,
    ),
    Tool(
        name="notice_seen",
        description=(
            "Record that a notice has been read. A read receipt and nothing else — it does "
            "not silence it and does not stop the digest carrying it while it is still true "
            "and undelivered. To stop hearing about something, use notice_mute."
        ),
        parameters=_obj(
            {
                "id": {
                    "type": "string",
                    "description": "The notice's id, as the notices tool prints it.",
                }
            },
            ["id"],
        ),
        executor=notice_seen,
    ),
)
