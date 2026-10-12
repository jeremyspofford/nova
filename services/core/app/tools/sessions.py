"""Her side of the sidebar's session list: sessions, session_rename,
session_archive, session_make_main, session_delete (2026-10-12).

The owner renamed his main session and deleted six others by hand, then
learned she could not have done it for him — no tool touched a chat
session, so "rename this one and clear out the rest" had nothing behind it
but a sentence. That gap IS the task (CLAUDE.md).

ONE CODE PATH. Every tool here calls the route handler the sidebar calls
(app/conversations.py: list_sessions, update_session, make_main,
delete_session) with her person, so what she does and what he does are the
same write with the same checks: someone else's session is a 404, a side
room or one of her own logs is not a session (400), a session with a turn
running cannot be deleted (409). The handler's refusal becomes her stated
`Error:` — a CANNOT, never a MAY NOT.

NOTHING HERE IS AN APPROVAL (owner ruling 2026-09-03, test_no_approvals).
Asked to delete a session, she deletes it; the result says plainly that it
cannot be undone and what went with it, read back from core.

A session is named by its id, an id prefix of at least 8 characters (as the
listing prints it), or its exact title/label, case-insensitively. An
ambiguous name is refused with the candidates — a guessed delete is the
worst way to be wrong.
"""

from __future__ import annotations

import uuid

from fastapi import HTTPException

from app import db
from app.tools.base import RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure

SHORT_ID_CHARS = 8


def _routes():
    """app.conversations, imported at call time like every tool module here:
    it pulls in chat and identity, and a module-time import would close a
    cycle through app.tools."""
    from app import conversations

    return conversations


def _refused(exc: HTTPException) -> ToolFailure:
    return ToolFailure(str(exc.detail))


async def _all_sessions(ctx: ToolContext) -> list[dict]:
    routes = _routes()
    live = await routes.list_sessions(archived=False, person=ctx.person)
    archived = await routes.list_sessions(archived=True, person=ctx.person)
    return live["sessions"] + archived["sessions"]


async def _resolve(ctx: ToolContext, given: str) -> dict:
    """One of HIS sessions, by id, id prefix or exact label — or a refusal
    that names why and, when it is ambiguous, the candidates."""
    given = " ".join(str(given or "").split())
    if not given:
        raise ToolFailure(
            "name the session: its id (as the sessions tool prints it) or its exact title."
        )
    sessions = await _all_sessions(ctx)
    low = given.lower()
    by_id = [s for s in sessions if s["id"] == low]
    if not by_id and len(low) >= SHORT_ID_CHARS:
        by_id = [s for s in sessions if s["id"].startswith(low)]
    matches = by_id or [
        s for s in sessions if s["label"].lower() == low or (s["title"] or "").lower() == low
    ]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise ToolFailure(
            f"no session of his is called or numbered {given!r}. "
            "List them with the sessions tool and use the id it prints."
        )
    names = "; ".join(f"{s['id'][:SHORT_ID_CHARS]} {s['label']}" for s in matches)
    raise ToolFailure(f"{len(matches)} sessions match {given!r} ({names}) — name one by its id.")


async def _here(ctx: ToolContext) -> str | None:
    """The chat session this turn answers in. A side room hangs off a message
    in a session, and from inside the room THAT session is the one she is in:
    deleting it would take the room her reply is being written into."""
    if ctx.conversation_id is None:
        return None
    pool = await db.get_pool()
    parent = await pool.fetchval(
        "SELECT m.conversation_id FROM conversations c "
        "JOIN messages m ON m.id = c.parent_message_id WHERE c.id = $1",
        ctx.conversation_id,
    )
    return str(parent or ctx.conversation_id)


def _line(s: dict, here: str | None) -> str:
    marks = []
    if s["main"]:
        marks.append("main — digests and reminders land here")
    if here is not None and s["id"] == here:
        marks.append("this one")
    if s["archived_at"]:
        marks.append("archived")
    if s["busy"]:
        marks.append("a turn is running")
    tail = f" [{'; '.join(marks)}]" if marks else ""
    return f"{s['id'][:SHORT_ID_CHARS]}  {s['label']} — {s['message_count']} message(s){tail}"


async def sessions_list(args: dict, ctx: ToolContext) -> str:
    routes = _routes()
    archived = bool(args.get("archived"))
    try:
        rows = (await routes.list_sessions(archived=archived, person=ctx.person))["sessions"]
    except HTTPException as exc:
        raise _refused(exc) from None
    here = await _here(ctx)
    if not rows:
        return "No archived sessions." if archived else "No sessions."
    kind = "archived session(s)" if archived else "session(s)"
    return "\n".join([f"{len(rows)} {kind}, most recent first:", *(_line(s, here) for s in rows)])


async def session_rename(args: dict, ctx: ToolContext) -> str:
    routes = _routes()
    target = await _resolve(ctx, args.get("session", ""))
    title = args.get("title")
    try:
        row = await routes.update_session(
            uuid.UUID(target["id"]), routes.SessionPatch(title=title), person=ctx.person
        )
    except HTTPException as exc:
        raise _refused(exc) from None
    if row["title"] is None:
        return f"Cleared the title of {target['label']!r}; it now shows as {row['label']!r}."
    return f"Renamed {target['label']!r} to {row['label']!r}."


async def session_archive(args: dict, ctx: ToolContext) -> str:
    routes = _routes()
    target = await _resolve(ctx, args.get("session", ""))
    archived = bool(args["archived"])
    try:
        row = await routes.update_session(
            uuid.UUID(target["id"]), routes.SessionPatch(archived=archived), person=ctx.person
        )
    except HTTPException as exc:
        raise _refused(exc) from None
    if archived:
        if row["archived_at"] is None:
            raise ToolFailure(f"{row['label']!r} was not archived — core read it back as live.")
        return (
            f"Archived {row['label']!r}. It is out of the list and can be brought back "
            "with archived=false."
        )
    if row["archived_at"] is not None:
        raise ToolFailure(f"{row['label']!r} is still archived — core read it back that way.")
    return f"Unarchived {row['label']!r}; it is back in his session list."


async def session_make_main(args: dict, ctx: ToolContext) -> str:
    routes = _routes()
    target = await _resolve(ctx, args.get("session", ""))
    if target["main"]:
        return f"{target['label']!r} is already the main session. Nothing changed."
    try:
        row = await routes.make_main(uuid.UUID(target["id"]), person=ctx.person)
    except HTTPException as exc:
        raise _refused(exc) from None
    return (
        f"{row['label']!r} is now the main session: digests and reminders set outside a chat "
        "land there from now on."
    )


async def session_delete(args: dict, ctx: ToolContext) -> str:
    routes = _routes()
    target = await _resolve(ctx, args.get("session", ""))
    if target["id"] == await _here(ctx):
        # The handler would refuse too (this turn is running in it), but its
        # words are about "a turn" — say which one, and what he can do.
        raise ToolFailure(
            f"{target['label']!r} is this conversation — it cannot be deleted while this reply is "
            "being written. He can delete it from the sidebar, or ask in another session."
        )
    try:
        gone = await routes.delete_session(uuid.UUID(target["id"]), person=ctx.person)
    except HTTPException as exc:
        raise _refused(exc) from None
    if not gone.get("deleted"):
        raise ToolFailure(f"core did not confirm deleting {target['label']!r}.")
    parts = [
        f"Deleted {target['label']!r} and its {gone['messages']} message(s); it cannot be undone."
    ]
    if gone.get("timers_unlinked"):
        parts.append(
            f"{gone['timers_unlinked']} reminder(s) set there will still fire, "
            "with no chat to land in."
        )
    if target["main"]:
        parts.append(
            "It was the main session; digests now land in whichever session core makes main next."
        )
    return " ".join(parts)


def _session_arg() -> dict:
    return {
        "type": "string",
        "description": (
            "Which session: its id or the 8-character id prefix the sessions tool prints, "
            "or its exact title."
        ),
    }


def _obj(properties: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": properties, "required": required}


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="sessions",
        description=(
            "List his chat sessions (the sidebar's list): each one's id, title, message "
            "count, which is main (where digests and reminders land) and which one this "
            "conversation is. archived=true lists the archive instead."
        ),
        parameters=_obj(
            {
                "archived": {
                    "type": "boolean",
                    "description": "true for the archive. Defaults to false.",
                }
            },
            [],
        ),
        executor=sessions_list,
        reads_only=True,
        result_kind=RESULT_KIND_LISTING,
    ),
    Tool(
        name="session_rename",
        description=(
            "Rename one of his chat sessions, as the sidebar's Rename does. An empty title "
            "clears it back to the label taken from its first message."
        ),
        parameters=_obj(
            {
                "session": _session_arg(),
                "title": {"type": "string", "description": "The new title (up to 200 characters)."},
            },
            ["session", "title"],
        ),
        executor=session_rename,
    ),
    Tool(
        name="session_archive",
        description=(
            "Archive one of his chat sessions (out of the list, kept) or bring one back "
            "(archived=false), as the sidebar's Archive does."
        ),
        parameters=_obj(
            {
                "session": _session_arg(),
                "archived": {
                    "type": "boolean",
                    "description": "true to archive, false to bring it back.",
                },
            },
            ["session", "archived"],
        ),
        executor=session_archive,
    ),
    Tool(
        name="session_make_main",
        description=(
            "Make one of his chat sessions the main one — where digests and reminders set "
            "outside a chat land. Unarchives it if it was archived."
        ),
        parameters=_obj({"session": _session_arg()}, ["session"]),
        executor=session_make_main,
    ),
    Tool(
        name="session_delete",
        description=(
            "Delete one of his chat sessions: its messages, side rooms and attachments, for "
            "good, as the sidebar's Delete does. What she did stays in Activity. The session "
            "this conversation is in cannot be deleted from inside it."
        ),
        parameters=_obj({"session": _session_arg()}, ["session"]),
        executor=session_delete,
    ),
)
