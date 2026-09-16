"""S25.1 — a mute has to survive the facts changing.

THE DEFECT, written as a test before it is fixed.

`checks.fingerprint(finding)` is sha256 over {key, facts}, and the mute
holds the fingerprint: "a muted row still occupies its fingerprint, which IS
the mute" (notices.py). That is exactly right when the facts are stable and
completely wrong when they are not.

`work_failing_timers` puts `consecutive_failures` in its facts. Mute it at
two failures; at three the facts differ, so the fingerprint differs, so it
is a fresh UNMUTED row — and the muted row is never cleared or pruned, so it
holds a fingerprint that will never recur again.

The condition has not changed. The count has.
"""

from __future__ import annotations

import asyncpg
import pytest

from app import notices
from app.checks import Finding
from tests.conftest import requires_db

pytestmark = requires_db


def _finding(failures: int) -> Finding:
    """The same condition, read twice. `key` says WHICH timer; `facts` say
    what it currently reads — and one of those numbers moves."""
    return Finding(
        key="timer:0b39fae3",
        title=f"the 7am backup has failed {failures} times running",
        facts={"timer_id": "0b39fae3", "consecutive_failures": failures},
    )


async def _raise(pool, finding: Finding):
    row, _is_new = await notices.record(
        pool, finding, check_name="work_failing_timers", turn_id=None, firing_id=None
    )
    return row


async def test_a_mute_survives_a_number_going_up(owner_client, pool):
    """The whole slice in one test. Mute at two failures, fail a third
    time, and he must still hear nothing."""
    first = await _raise(pool, _finding(2))
    await notices.set_muted(pool, first.id, True)

    again = await _raise(pool, _finding(3))

    assert again.state == notices.MUTED, (
        "a third failure of the SAME timer arrived as a fresh unmuted card, "
        "because consecutive_failures changed and the fingerprint is a hash "
        "of the facts"
    )


async def test_a_muted_condition_is_not_owed_to_him(owner_client, pool):
    """And the digest agrees — silence in the Inbox that the daily message
    then breaks is not silence."""
    first = await _raise(pool, _finding(2))
    await notices.set_muted(pool, first.id, True)
    await _raise(pool, _finding(3))

    owed = [n.check_name for n in await notices.deliverable(pool)]
    assert "work_failing_timers" not in owed


async def test_a_different_condition_is_still_news(owner_client, pool):
    """The mute is on THIS timer, not on the check. A different timer
    failing is a different condition and he is told."""
    first = await _raise(pool, _finding(2))
    await notices.set_muted(pool, first.id, True)

    other = await _raise(
        pool,
        Finding(
            key="timer:99999999",
            title="the nightly sync has failed 2 times running",
            facts={"timer_id": "99999999", "consecutive_failures": 2},
        ),
    )
    assert other.state == notices.RAISED


async def test_clearing_the_condition_lifts_the_silence(owner_client, pool):
    """Owner ruling 2026-09-16 (Q3), and the thing that makes muting an
    URGENT condition safe (Q5): the mute is about a live condition, so a
    condition that comes back months later is news again."""
    first = await _raise(pool, _finding(2))
    await notices.set_muted(pool, first.id, True)
    await notices.reconcile(pool, check_name="work_failing_timers", live_fingerprints=set())

    returned = await _raise(pool, _finding(2))
    assert returned.state == notices.RAISED


# ---------------------------------------------------------------------------
# S25.1.2 — the thing he silenced sorts first
#
# Two separate causes, one symptom. `recent()` orders by `last_seen_at`, which
# a fold bumps, so the noisiest row floats to the top of the Inbox — including
# a row he muted precisely BECAUSE it was noisy. Silencing something made it
# the first thing he saw.
# ---------------------------------------------------------------------------


def _other(key: str) -> Finding:
    """A different condition entirely — a second row to sort against."""
    return Finding(key=key, title=f"something else went wrong ({key})", facts={"what": key})


async def test_the_inbox_orders_by_when_he_was_TOLD_not_by_check_activity(pool):
    """A fold is the CHECK seeing it again, not him. Ordering the page by
    `last_seen_at` meant a finding that recurs every five minutes outranked
    one he was told about an hour ago and has not read — the list was sorted
    by how noisy a condition is.

    It sorts by when he was told instead: `delivered_at` where a delivery
    landed, `first_seen_at` where it has not yet.
    """
    old = await _raise(pool, _other("disk"))
    await notices.mark_delivered(pool, old.id, delivery="chat", message_id=None)
    newer = await _raise(pool, _other("cert"))

    # The old one recurs, loudly. That is the check talking, not him.
    await _raise(pool, _other("disk"))

    page = await notices.recent(pool)
    assert [n.id for n in page][:2] == [newer.id, old.id], (
        "the recurring row floated to the top of the Inbox because a fold "
        "bumped last_seen_at — the page was sorted by noisiness"
    )


async def test_muted_rows_leave_the_default_view_and_are_findable_under_a_filter(pool):
    """ "Not in the list" and "gone" are different things. A mute he cannot
    find is a mute he cannot lift, so the rows keep existing and move behind
    a filter — the same shape the digest already uses, one query apart.
    """
    quiet = await _raise(pool, _other("chatty"))
    await notices.set_muted(pool, quiet.id, True)
    loud = await _raise(pool, _other("real"))

    assert [n.id for n in await notices.recent(pool)] == [loud.id], (
        "a muted row was still in the default Inbox view"
    )
    assert [n.id for n in await notices.recent(pool, muted=True)] == [quiet.id], (
        "the muted filter did not show the row he silenced — a silence he "
        "cannot find is a silence he cannot lift"
    )


async def test_the_page_is_told_how_many_are_muted(pool):
    """So the filter can announce itself. A tab that reads "Muted" with no
    number is a tab nobody clicks, and the rows behind it stay invisible for
    the life of the box."""
    quiet = await _raise(pool, _other("chatty"))
    await notices.set_muted(pool, quiet.id, True)
    await _raise(pool, _other("real"))

    assert await notices.muted_count(pool) == 1


async def test_the_muted_view_holds_what_is_SILENCED_not_what_once_was(pool):
    """The mute is `notice_mutes`, so the muted view has to read that and not
    the `muted_at` stamp on the row.

    They part company the moment a condition clears: clearing forgets the
    mute (the test above) but leaves `muted_at` standing on the row, because
    that stamp is the record of what happened to it. A view keyed on the
    stamp would therefore keep a cleared row in the muted list forever, and
    count it — an "Unmute" button for a silence that is already over, and a
    number beside the tab that only ever goes up.
    """
    quiet = await _raise(pool, _other("chatty"))
    await notices.set_muted(pool, quiet.id, True)
    assert await notices.muted_count(pool) == 1

    await notices.clear(pool, quiet.id)

    # The stamp is still on the row — it is the history of the row.
    assert await pool.fetchval("SELECT muted_at FROM notices WHERE id = $1", quiet.id)
    # The SILENCE is over, so the view and its count say so.
    assert await notices.muted_count(pool) == 0
    assert await notices.recent(pool, muted=True) == []
    assert [n.id for n in await notices.recent(pool)] == [quiet.id]


async def test_the_database_refuses_a_seen_state_at_all(pool):
    """S25.1.3, as a line of code rather than a habit (migration 033).

    The application stopped writing `seen`, which is most of the fix — but a
    schema that still permits it leaves the old meaning one stray UPDATE
    away, and there is no test that would notice. The CHECK is what makes it
    impossible.

    (The other half of 033 cannot be reached from here: rewriting rows a live
    box has ALREADY marked seen, which is what stops them being invisible to
    every future digest. conftest drops the table and re-runs every migration
    against an empty one, so there is nothing for that UPDATE to find.)
    """
    row = await _raise(pool, _other("anything"))

    with pytest.raises(asyncpg.exceptions.CheckViolationError, match="notices_state_check"):
        await pool.execute("UPDATE notices SET state = 'seen' WHERE id = $1", row.id)

    assert notices.STATES == ("raised", "delivered", "failed", "muted")


async def test_clearing_a_STALE_row_does_not_lift_a_silence_the_live_one_needs(pool):
    """FOUND BY THE WALK, 2026-09-16 — the half of S25.1 the unit tests missed.

    A mute is keyed on the CONDITION, but "clearing forgets the mute" was
    applied per ROW. When the facts change, one beat does both things at
    once: `record` raises a new row for the new facts, and `reconcile`
    clears the old one, whose fingerprint the check no longer returns. The
    clear then deleted the key the NEW row depends on.

    On the live stack that read as: he mutes a timer at four failures, the
    fifth arrives silent (the state was stamped at insert, so he is not
    told) — but `notice_mutes` is empty, so the muted view cannot show it to
    him, the count says nothing is silenced, and the SIXTH failure comes
    back as a fresh unmuted card. The defect this slice exists to fix,
    surviving one change instead of none.

    The rule is the one Q3 actually states: a mute lasts as long as the
    CONDITION does. A live row for that condition means the condition is
    still true, whatever happened to any individual row of it.
    """
    first = await _raise(pool, _finding(4))
    await notices.set_muted(pool, first.id, True)

    # The same beat: the new reading arrives and the old one stops being
    # found. Order matters — record first, because that is the order a beat
    # does it in and the bug needs the new row to already exist.
    fresh = await _raise(pool, _finding(5))
    cleared = await notices.reconcile(
        pool,
        check_name="work_failing_timers",
        live_fingerprints={fresh.fingerprint},
    )

    assert [n.id for n in cleared] == [first.id], "the stale reading should clear"
    assert await notices.muted_keys(pool, "work_failing_timers") == {"timer:0b39fae3"}, (
        "clearing the stale row lifted a silence the live row still needs"
    )
    # And the owner can still FIND it, which is the whole reason the rows
    # stay rather than being deleted.
    assert [n.id for n in await notices.recent(pool, muted=True)] == [fresh.id]
    assert await notices.muted_count(pool) == 1
    assert await notices.deliverable(pool) == []
