"""Her side of the sidebar's session list (2026-10-12): sessions,
session_rename, session_archive, session_make_main, session_delete — through
dispatch, against a real database.

The owner renamed his main session and deleted six others by hand, and then
learned she could not have done it for him: no tool touched a chat session.
That gap is the task (CLAUDE.md). Each tool calls the SAME route handler the
sidebar calls, so what she does and what he does are one code path, and a
refusal (someone else's session, a turn still running) is a stated CANNOT.

What the tests pin is what she can SAY afterwards: the listing names which
session is main and which one she is in; a rename and a delete report what
changed, read back; an ambiguous name is refused rather than guessed.
Nothing here asks him first — owner ruling 2026-09-03 (test_no_approvals).
"""

from __future__ import annotations

import uuid

import pytest

from app import tools
from app.identity import Person
from app.main import app
from app.tools.base import ToolContext
from tests.conftest import requires_db

pytestmark = requires_db


async def _person(pool, name: str = "jeremy", role: str = "owner") -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, $2) RETURNING id", name, role
    )
    return Person(id=pid, name=name, role=role)


async def _session(pool, person: Person, title: str | None, *, main: bool = False) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO conversations (person_id, active, chat_session, title) "
        "VALUES ($1, $2, true, $3) RETURNING id",
        person.id,
        main,
        title,
    )


async def _call(name: str, args: dict, person: Person, tmp_path, here: uuid.UUID | None = None):
    ctx = ToolContext(app=app, person=person, workspace_root=tmp_path, conversation_id=here)
    return await tools.dispatch(name, args, ctx)


async def test_the_five_tools_are_hers(pool):
    for name in (
        "sessions",
        "session_rename",
        "session_archive",
        "session_make_main",
        "session_delete",
    ):
        assert name in tools.REGISTRY, name


async def test_lists_her_sessions_naming_main_and_the_one_she_is_in(pool, tmp_path):
    me = await _person(pool)
    main = await _session(pool, me, "PRIMARY", main=True)
    trip = await _session(pool, me, "trip planning")
    text, ok = await _call("sessions", {}, me, tmp_path, here=trip)
    assert ok, text
    assert "2 session(s)" in text
    main_line = next(line for line in text.splitlines() if "PRIMARY" in line)
    trip_line = next(line for line in text.splitlines() if "trip planning" in line)
    assert str(main)[:8] in main_line and "main" in main_line
    assert str(trip)[:8] in trip_line and "this one" in trip_line


async def test_an_empty_archive_is_stated_as_empty(pool, tmp_path):
    me = await _person(pool)
    await _session(pool, me, "PRIMARY", main=True)
    text, ok = await _call("sessions", {"archived": True}, me, tmp_path)
    assert ok, text
    assert "No archived sessions" in text


async def test_rename_by_id_prefix_is_read_back(pool, tmp_path):
    me = await _person(pool)
    await _session(pool, me, "PRIMARY", main=True)
    sid = await _session(pool, me, None)
    text, ok = await _call(
        "session_rename", {"session": str(sid)[:8], "title": "  Dell   setup "}, me, tmp_path
    )
    assert ok, text
    assert await pool.fetchval("SELECT title FROM conversations WHERE id = $1", sid) == "Dell setup"
    assert "Dell setup" in text


async def test_rename_by_exact_title(pool, tmp_path):
    me = await _person(pool)
    sid = await _session(pool, me, "PRIMARY", main=True)
    text, ok = await _call("session_rename", {"session": "primary", "title": "Home"}, me, tmp_path)
    assert ok, text
    assert await pool.fetchval("SELECT title FROM conversations WHERE id = $1", sid) == "Home"


async def test_an_ambiguous_or_unknown_name_is_refused_not_guessed(pool, tmp_path):
    me = await _person(pool)
    await _session(pool, me, "notes", main=True)
    await _session(pool, me, "notes")
    text, ok = await _call("session_rename", {"session": "notes", "title": "x"}, me, tmp_path)
    assert not ok and text.startswith("Error:")
    assert "2 sessions" in text
    text, ok = await _call("session_delete", {"session": "nothing like it"}, me, tmp_path)
    assert not ok and text.startswith("Error:")
    assert await pool.fetchval("SELECT count(*) FROM conversations") == 2


async def test_archive_and_unarchive(pool, tmp_path):
    me = await _person(pool)
    await _session(pool, me, "PRIMARY", main=True)
    sid = await _session(pool, me, "old idea")
    text, ok = await _call(
        "session_archive", {"session": "old idea", "archived": True}, me, tmp_path
    )
    assert ok, text
    assert await pool.fetchval(
        "SELECT archived_at IS NOT NULL FROM conversations WHERE id = $1", sid
    )
    text, ok = await _call(
        "session_archive", {"session": str(sid), "archived": False}, me, tmp_path
    )
    assert ok, text
    assert await pool.fetchval("SELECT archived_at IS NULL FROM conversations WHERE id = $1", sid)


async def test_make_main_moves_where_digests_land(pool, tmp_path):
    me = await _person(pool)
    old = await _session(pool, me, "PRIMARY", main=True)
    new = await _session(pool, me, "home base")
    text, ok = await _call("session_make_main", {"session": "home base"}, me, tmp_path)
    assert ok, text
    assert await pool.fetchval("SELECT active FROM conversations WHERE id = $1", new)
    assert not await pool.fetchval("SELECT active FROM conversations WHERE id = $1", old)
    assert "digests" in text


async def test_delete_states_what_core_removed(pool, tmp_path):
    me = await _person(pool)
    await _session(pool, me, "PRIMARY", main=True)
    sid = await _session(pool, me, "scratch")
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content) "
        "VALUES ($1, 'user', 'hi'), ($1, 'assistant', 'hello')",
        sid,
    )
    text, ok = await _call("session_delete", {"session": "scratch"}, me, tmp_path)
    assert ok, text
    assert await pool.fetchval("SELECT count(*) FROM conversations WHERE id = $1", sid) == 0
    assert "2 message" in text
    assert "cannot be undone" in text.lower() or "can't be undone" in text.lower()


async def test_she_cannot_delete_the_session_she_is_answering_in(pool, tmp_path):
    me = await _person(pool)
    await _session(pool, me, "PRIMARY", main=True)
    here = await _session(pool, me, "this chat")
    text, ok = await _call("session_delete", {"session": "this chat"}, me, tmp_path, here=here)
    assert not ok and text.startswith("Error:")
    assert "this conversation" in text
    assert await pool.fetchval("SELECT count(*) FROM conversations WHERE id = $1", here) == 1


async def test_someone_elses_session_is_not_hers_to_touch(pool, tmp_path):
    me = await _person(pool)
    other = await _person(pool, "guest", role="guest")
    theirs = await _session(pool, other, "their chat", main=True)
    text, ok = await _call("session_delete", {"session": str(theirs)}, me, tmp_path)
    assert not ok and text.startswith("Error:")
    assert await pool.fetchval("SELECT count(*) FROM conversations WHERE id = $1", theirs) == 1


@pytest.mark.parametrize(
    "name", ["session_rename", "session_archive", "session_make_main", "session_delete"]
)
async def test_a_side_room_is_not_a_session(pool, tmp_path, name):
    me = await _person(pool)
    await _session(pool, me, "PRIMARY", main=True)
    room = await pool.fetchval(
        "INSERT INTO conversations (person_id, active, chat_session, title) "
        "VALUES ($1, false, false, 'agent:coder') RETURNING id",
        me.id,
    )
    args = {"session": str(room), "title": "x", "archived": True}
    text, ok = await _call(
        name,
        {k: v for k, v in args.items() if k in tools.REGISTRY[name].parameters["properties"]},
        me,
        tmp_path,
    )
    assert not ok and text.startswith("Error:")


async def test_from_a_side_room_the_session_she_is_in_is_the_rooms_parent(pool, tmp_path):
    """A side room hangs off a message in a session. Answering in the room, the
    session she is in is that parent: listing it marks it, and deleting it —
    which would take the room her reply is being written into — is refused."""
    me = await _person(pool)
    await _session(pool, me, "PRIMARY", main=True)
    parent = await _session(pool, me, "trip")
    msg = await pool.fetchval(
        "INSERT INTO messages (conversation_id, role, content) "
        "VALUES ($1, 'assistant', 'plan') RETURNING id",
        parent,
    )
    room = await pool.fetchval(
        "INSERT INTO conversations (person_id, active, chat_session, parent_message_id) "
        "VALUES ($1, false, false, $2) RETURNING id",
        me.id,
        msg,
    )
    text, ok = await _call("sessions", {}, me, tmp_path, here=room)
    assert ok, text
    assert "this one" in next(line for line in text.splitlines() if "trip" in line)
    text, ok = await _call("session_delete", {"session": "trip"}, me, tmp_path, here=room)
    assert not ok and text.startswith("Error:")
    assert await pool.fetchval("SELECT count(*) FROM conversations WHERE id = $1", parent) == 1
