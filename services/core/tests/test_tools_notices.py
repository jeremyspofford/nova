"""S25.2.3 — her side of the Inbox, through dispatch, against a real database.

She writes the digest and then has to be able to answer a question about it.
So the tests that matter most here are not "does the query work": they are
the ones about what she can and cannot SAY afterwards.

  * a trimmed list never reads as the whole of it;
  * an empty view is stated as an empty view, never as "there is nothing";
  * a view or a check that does not exist is a stated CANNOT, because [] is
    the quietest possible wrong answer and she would repeat it to him as a
    fact;
  * a mute says he will not be TOLD and never that anything was handled;
  * a mute SHE made is recorded as hers.
"""

from __future__ import annotations

import uuid

import pytest

from app import notices, tools
from app.checks import Finding
from app.identity import Person
from app.main import app
from app.tools.base import ToolContext
from tests.conftest import requires_db

pytestmark = requires_db

# A real registered check, so the rows these tests write are rows the store
# would actually accept — `record` refuses a name nobody registered.
CHECK = "work_paused_timers"


async def _person(pool, name: str = "jeremy") -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, 'owner') RETURNING id", name
    )
    return Person(id=pid, name=name, role="owner")


def _ctx(person: Person, tmp_path) -> ToolContext:
    return ToolContext(app=app, person=person, workspace_root=tmp_path)


async def _raise(pool, key: str, title: str = "the 7am backup is paused"):
    row, _is_new = await notices.record(
        pool,
        Finding(key=key, title=title, facts={"timer_id": key}),
        check_name=CHECK,
        turn_id=None,
        firing_id=None,
    )
    return row


async def _call(name: str, args: dict, person: Person, tmp_path) -> tuple[str, bool]:
    return await tools.dispatch(name, args, _ctx(person, tmp_path))


# -- reading ---------------------------------------------------------------------


async def test_she_can_read_the_rows_the_digest_was_composed_from(pool, tmp_path):
    person = await _person(pool)
    row = await _raise(pool, "timer:1", "the 7am backup is paused — the disk is full")

    result, ok = await _call("notices", {}, person, tmp_path)

    assert ok is True
    # The CHECK's sentence, verbatim. Not a model's paraphrase of it, and not
    # this module's own words about it.
    assert "the 7am backup is paused — the disk is full" in result
    assert str(row.id)[:8] in result
    assert CHECK in result
    assert "still true" in result and "you have not been told" in result


async def test_an_empty_view_says_it_is_empty_rather_than_nothing_exists(pool, tmp_path):
    """ "No muted notices" and "there is nothing wrong" are different answers,
    and only one of them is true when the Inbox is full of unread rows."""
    person = await _person(pool)
    await _raise(pool, "timer:1")

    muted, ok = await _call("notices", {"state": "muted"}, person, tmp_path)

    assert ok is True
    assert muted == "No muted notices."


async def test_a_trimmed_list_says_there_may_be_more(pool, tmp_path):
    """The failure this prevents: she reads three of thirty and tells him
    that is all of them. The count is stated apart from the rows so a page
    cannot be mistaken for the whole."""
    person = await _person(pool)
    for n in range(4):
        await _raise(pool, f"timer:{n}", f"timer {n} is paused")

    result, ok = await _call("notices", {"limit": 2}, person, tmp_path)

    assert ok is True
    assert "the newest 2; there may be older ones" in result
    # One heading and two rows — the limit was honoured, and the heading is
    # what stops the two rows reading as "there are two".
    assert len(result.splitlines()) == 3


async def test_a_view_nobody_defined_is_refused_in_the_stores_words(pool, tmp_path):
    person = await _person(pool)

    result, ok = await _call("notices", {"state": "handled"}, person, tmp_path)

    assert ok is False
    # Named, with what the views ARE — a refusal she can act on rather than
    # one she has to guess past.
    assert "no view called 'handled'" in result
    for view in ("unread", "muted", "cleared", "all"):
        assert view in result


async def test_a_check_nobody_registered_is_refused_rather_than_answered_empty(pool, tmp_path):
    """[] here would read as "that check has found nothing", which is a
    clean bill of health for a check that does not exist."""
    person = await _person(pool)

    result, ok = await _call("notices", {"check": "work_disk_space"}, person, tmp_path)

    assert ok is False
    assert "work_disk_space" in result and "is registered" in result


async def test_filtering_by_check_is_the_registrys_name(pool, tmp_path):
    person = await _person(pool)
    await _raise(pool, "timer:1", "the 7am backup is paused")

    result, ok = await _call("notices", {"check": CHECK}, person, tmp_path)

    assert ok is True
    assert "the 7am backup is paused" in result and f"from {CHECK}" in result


# -- the two writes, and what they are not ---------------------------------------


async def test_a_mute_she_makes_is_recorded_as_HERS(pool, tmp_path):
    """S25 Q2. A silence he did not ask for must not be indistinguishable
    from one he did — `muted_by` is null for hers, his person id for his."""
    person = await _person(pool)
    row = await _raise(pool, "timer:1")

    result, ok = await _call(
        "notice_mute", {"id": str(row.id)[:8], "muted": True}, person, tmp_path
    )

    assert ok is True
    muted_by = await pool.fetchval(
        "SELECT muted_by FROM notice_mutes WHERE check_name = $1 AND finding_key = $2",
        CHECK,
        "timer:1",
    )
    assert muted_by is None, "a mute she made was recorded as his"
    # And it actually took, read back from the store rather than from the
    # sentence the tool returned.
    assert [n.finding_key for n in await notices.listing(pool, view="muted")] == ["timer:1"]
    assert "Muted" in result


async def test_muting_never_says_anything_was_handled(pool, tmp_path):
    """Muting is not handling (S25.2.3). The guard that catches her CLAIMING
    she fixed something lives elsewhere; this is the smaller, earlier thing —
    the tool's own words must not hand her the sentence."""
    person = await _person(pool)
    row = await _raise(pool, "timer:1")

    result, _ok = await _call("notice_mute", {"id": str(row.id), "muted": True}, person, tmp_path)

    assert "Nothing about the condition itself changed" in result
    for word in ("handled", "fixed", "resolved", "dealt with", "sorted"):
        assert word not in result.lower()


async def test_a_read_receipt_is_only_that(pool, tmp_path):
    """S25.1.3 from her side: marking something read must not silence it.
    The row stays owed while it is still true and nobody was told."""
    person = await _person(pool)
    row = await _raise(pool, "timer:1")

    result, ok = await _call("notice_seen", {"id": str(row.id)}, person, tmp_path)

    assert ok is True
    assert "receipt only" in result
    assert [n.id for n in await notices.deliverable(pool)] == [row.id]
    assert await pool.fetchval("SELECT seen_at FROM notices WHERE id = $1", row.id) is not None


async def test_muted_must_be_said_explicitly(pool, tmp_path):
    """Not defaulted. "notice_mute(id)" with no verb is as likely to mean
    unmute as mute, and guessing silences something nobody asked to silence.

    Dispatch is what refuses, off the tool's DECLARED parameters — `muted`
    is required and boolean there — so both the missing argument and the
    well-formed value of the wrong kind are named before the executor runs.
    That is the whole reason the executor has no check of its own: a second
    one would be a weaker copy of this, kept true by hand.
    """
    person = await _person(pool)
    row = await _raise(pool, "timer:1")

    missing, ok = await _call("notice_mute", {"id": str(row.id)}, person, tmp_path)
    assert ok is False
    assert "missing required argument 'muted'" in missing

    wrong, ok = await _call("notice_mute", {"id": str(row.id), "muted": "yes"}, person, tmp_path)
    assert ok is False
    assert "argument 'muted' must be a boolean, got string" in wrong

    # Neither attempt silenced anything.
    assert await notices.listing(pool, view="muted") == []


# -- naming one row -------------------------------------------------------------


async def test_an_ambiguous_short_id_is_refused_with_the_candidates(pool, tmp_path):
    """Taking the first match would act on a row she did not mean, and the
    row she did not mean is somebody's only notice that something is broken."""
    person = await _person(pool)
    first = await _raise(pool, "timer:1", "the first one")
    prefix = str(first.id)[:8]
    # A second row whose id starts the same way. Written directly, because
    # uuid4 will not oblige on request.
    twin = uuid.UUID(prefix + str(uuid.uuid4())[8:])
    await pool.execute(
        "INSERT INTO notices (id, check_name, finding_key, fingerprint, title, facts) "
        "VALUES ($1, $2, 'timer:2', $3, 'the second one', '{}'::jsonb)",
        twin,
        CHECK,
        "f" * 64,
    )

    result, ok = await _call("notice_seen", {"id": prefix}, person, tmp_path)

    assert ok is False
    assert "names more than one notice" in result
    assert "the first one" in result and "the second one" in result


async def test_an_id_that_names_nothing_says_nothing_was_written(pool, tmp_path):
    person = await _person(pool)

    result, ok = await _call("notice_seen", {"id": "deadbeef"}, person, tmp_path)

    assert ok is False
    assert "no notice starts with 'deadbeef'" in result and "nothing was written" in result


async def test_an_id_too_short_to_name_anything_is_refused_before_the_query(pool, tmp_path):
    person = await _person(pool)
    await _raise(pool, "timer:1")

    result, ok = await _call("notice_seen", {"id": "de"}, person, tmp_path)

    assert ok is False
    assert "too short to name a notice" in result


@pytest.mark.parametrize("name", ["notices", "notice_mute", "notice_seen"])
def test_none_of_these_tools_waits_on_him(name):
    """The rule test_no_approvals guards, asserted here too because this is
    the module most likely to grow one: an Inbox is where an approval queue
    would look natural. Nothing in these descriptions offers to ask him."""
    tool = tools.REGISTRY[name]
    words = f"{tool.description} {tool.name}".lower()
    for word in ("approve", "approval", "permission", "allow", "deny", "confirm with", "waiting"):
        assert word not in words


async def test_unread_is_what_is_STILL_TRUE_and_unread(pool, tmp_path):
    """FOUND BY THE WALK, 2026-09-16, and the worst kind of defect: it made
    her say false things with a real tool call behind her.

    `VIEWS["unread"]` was `seen_at IS NULL AND NOT silenced` — no liveness
    term. So every condition that had ever cleared and never been opened
    came back as unread, and the owner asking "what is in my inbox?" was
    told about a memory problem and an agent that had both stopped being
    true weeks earlier. The trace showed `notices` ran and returned 20 rows,
    so nothing downstream had any reason to doubt it.

    "Unread" means news he has not read. A condition that has stopped is not
    news — the fact that it cleared is the record, and `state="cleared"` is
    where he goes to read it.
    """
    stale = await _raise(pool, "timer:gone", "something that stopped being true")
    live = await _raise(pool, "timer:here", "something that is still true")
    await notices.clear(pool, stale.id)

    person = await _person(pool)
    result, ok = await _call("notices", {}, person, tmp_path)

    assert ok is True
    assert "something that is still true" in result
    assert "something that stopped being true" not in result, (
        "a condition that has stopped was reported as unread news"
    )
    # And it is still FINDABLE, in the view whose whole subject it is.
    cleared, _ok = await _call("notices", {"state": "cleared"}, person, tmp_path)
    assert "something that stopped being true" in cleared
    assert str(live.id)[:8] not in cleared
