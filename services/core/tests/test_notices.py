"""The notices store: recorded before anyone is told, folded on the FACTS,
and never a state without the evidence for it.

Two of these tests are the v3 incidents written as code. The fold tests are
the fourteen-pushes-in-eight-hours failure (a fingerprint over the model's
own words, so a re-worded finding was "new"): here the same facts fold and
CHANGED facts are a new row, and nothing in between can move that. The mute
tests are the other one (mutes that did not survive, so a nag re-armed
forever): a muted row keeps its fingerprint, so the same facts stay quiet
and only different facts speak again.

The clear/reconcile tests are the hole the S11 review found in both of those
answers: a notice folded while its condition was still true, and NOTHING said
when a condition had finished — so a fixed thing that broke again folded onto
a week-old row and he was never told a second time. A check that RAN and no
longer finds a fingerprint clears it; a check that could not run clears
nothing; a mute is never cleared.
"""

from __future__ import annotations

import asyncio
import uuid
from decimal import Decimal

import asyncpg
import pytest

from app import checks, notices
from tests.conftest import requires_db

pytestmark = requires_db

# Stand-ins for the real families, so this suite tests the STORE and not
# whatever checks/ happens to register today. QUIET is an ordinary check;
# LOUD is one that declares urgency in code, the way the stack family does.
QUIET = "probe_quiet"
LOUD = "probe_urgent"


async def _never_runs(app, pool):
    """The store never runs a check — it is handed findings. If this is ever
    called, something in notices.py started probing the world."""
    raise AssertionError("the notices store must never run a check")


@pytest.fixture(autouse=True)
def registered(monkeypatch):
    """Put both stand-ins in the live registry. record() reads the registry
    at write time (the check name on a notice is derived from it, never free
    text), so a notice cannot be written for a name nobody registered."""
    for name, urgent in ((QUIET, False), (LOUD, True)):
        monkeypatch.setitem(
            checks.REGISTRY,
            name,
            checks.Check(
                name=name,
                describe=f"a stand-in check for the notices suite ({name})",
                urgent=urgent,
                run=_never_runs,
            ),
        )


def _finding(key: str = "timer_failing:one", **overrides) -> checks.Finding:
    kwargs = dict(
        key=key,
        title="the nightly backup timer has failed 4 times running",
        facts={"failures": 4, "timer": "backup"},
        urgent=False,
    )
    kwargs.update(overrides)
    return checks.Finding(**kwargs)


async def _turn(pool) -> uuid.UUID:
    return await pool.fetchval("INSERT INTO turns (kind) VALUES ('beat') RETURNING id")


async def _firing(pool) -> uuid.UUID:
    """A beat timer and one firing of it — the provenance a notice carries."""
    person = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id"
    )
    timer = await pool.fetchval(
        "INSERT INTO timers (person_id, kind, title, payload, schedule, timezone, created_via) "
        "VALUES ($1, 'beat', 'watch', '{}'::jsonb, '{\"kind\": \"hour\"}'::jsonb, 'UTC', "
        "'system') RETURNING id",
        person,
    )
    return await pool.fetchval(
        "INSERT INTO timer_firings (timer_id, scheduled_for, status) "
        "VALUES ($1, now(), 'running') RETURNING id",
        timer,
    )


async def _count(pool) -> int:
    return await pool.fetchval("SELECT count(*) FROM notices")


# -- writing one down -----------------------------------------------------------


async def test_record_writes_the_row_before_anything_is_delivered(pool):
    """The row exists, in state raised, with no delivery claimed — that order
    is the point: a channel that is broken later leaves a record, not
    silence."""
    turn, firing = await _turn(pool), await _firing(pool)
    finding = _finding()

    notice, is_new = await notices.record(
        pool, finding, check_name=QUIET, turn_id=turn, firing_id=firing
    )

    assert is_new is True
    assert (notice.state, notice.repeats, notice.urgent) == (notices.RAISED, 1, False)
    assert (notice.check_name, notice.finding_key) == (QUIET, "timer_failing:one")
    assert notice.title == finding.title
    # jsonb round-trips as a dict, both ways, like every other jsonb column.
    assert notice.facts == {"failures": 4, "timer": "backup"}
    assert notice.delivery == {}
    assert (notice.delivered_at, notice.seen_at, notice.muted_at) == (None, None, None)
    # Live: its condition is true as of this beat, which is what the partial
    # unique index folds on.
    assert notice.cleared_at is None
    assert (notice.turn_id, notice.firing_id) == (turn, firing)
    assert (notice.acted, notice.acted_turn_id, notice.acted_note) == (False, None, None)


async def test_the_fingerprint_is_the_checks_hash_of_the_facts(pool):
    """Not a hash of the title. Two findings whose sentences differ but whose
    facts are identical are ONE notice — that is the whole v3 fix."""
    first, is_new = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    assert is_new is True
    assert first.fingerprint == checks.fingerprint(_finding())

    reworded = _finding(title="backups are still failing — four nights now")
    second, is_new = await notices.record(
        pool, reworded, check_name=QUIET, turn_id=None, firing_id=None
    )
    assert is_new is False
    assert second.id == first.id
    assert await _count(pool) == 1
    # The stored sentence is the one the first row was written with: a fold
    # is "these facts are still true", not a re-write.
    assert second.title == first.title


async def test_the_same_facts_fold_onto_one_row(pool):
    """The second sighting increments repeats and moves last_seen_at, and
    leaves first_seen_at alone — suppression is countable, never silent."""
    first, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    second, is_new = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )

    assert (is_new, second.id, second.repeats) == (False, first.id, 2)
    assert second.first_seen_at == first.first_seen_at
    assert second.last_seen_at >= first.last_seen_at
    assert await _count(pool) == 1


async def test_a_fold_keeps_the_first_sighting_provenance(pool):
    """A notice says where it CAME FROM. The second beat's turn does not
    overwrite the turn that actually found it — that turn's trace is the
    evidence for the row."""
    first_turn, second_turn = await _turn(pool), await _turn(pool)
    first, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=first_turn, firing_id=None
    )
    folded, is_new = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=second_turn, firing_id=None
    )

    assert is_new is False
    assert folded.turn_id == first.turn_id == first_turn


async def test_changed_facts_are_a_second_notice(pool):
    """The fingerprint moved because the world moved, so she may speak again.
    Same key, same check, different facts — a NEW row, its own repeats."""
    first, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    worse = _finding(facts={"failures": 5, "timer": "backup"})

    second, is_new = await notices.record(
        pool, worse, check_name=QUIET, turn_id=None, firing_id=None
    )

    assert is_new is True
    assert second.id != first.id
    assert second.fingerprint != first.fingerprint
    assert (second.repeats, second.state) == (1, notices.RAISED)
    assert await _count(pool) == 2


async def test_two_beats_racing_cannot_double_raise_one_finding(pool):
    """The hourly beat and a "Run now" click land on the same fact at the
    same moment. One statement with ON CONFLICT means postgres serialises
    them on the unique index: one row, one is_new, repeats 2. A read-then-
    write would raise it twice."""
    results = await asyncio.gather(
        notices.record(pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None),
        notices.record(pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None),
    )

    assert sorted(is_new for _, is_new in results) == [False, True]
    assert len({notice.id for notice, _ in results}) == 1
    assert await _count(pool) == 1
    assert await pool.fetchval("SELECT repeats FROM notices") == 2


# -- what may be urgent, and who says so ----------------------------------------


async def test_a_check_that_does_not_declare_urgency_cannot_raise_an_urgent_notice(pool):
    """Urgency is a property of the CHECK, declared in code. A finding that
    claims it from a family that did not declare it is refused with words —
    not quietly downgraded, which would hide the bug."""
    with pytest.raises(notices.NoticeError, match="does not declare urgency"):
        await notices.record(
            pool, _finding(urgent=True), check_name=QUIET, turn_id=None, firing_id=None
        )
    assert await _count(pool) == 0


async def test_a_check_that_declares_urgency_stores_it(pool):
    notice, _ = await notices.record(
        pool,
        _finding(key="stack_down:gateway", urgent=True),
        check_name=LOUD,
        turn_id=None,
        firing_id=None,
    )
    assert notice.urgent is True


async def test_a_notice_cannot_name_a_check_nobody_registered(pool):
    """The check name is derived from the registry at write time. An invented
    one means a notice whose source cannot be opened — refused, and the words
    say which names exist."""
    with pytest.raises(notices.NoticeError, match="is registered"):
        await notices.record(
            pool, _finding(), check_name="i_made_this_up", turn_id=None, firing_id=None
        )
    assert await _count(pool) == 0


# -- the transitions, each with its evidence ------------------------------------


async def test_delivered_records_the_channels_own_receipt(pool):
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )

    delivered = await notices.mark_delivered(
        pool, notice.id, delivery={"chat": {"ok": True}, "devices": []}
    )

    assert delivered.state == notices.DELIVERED
    assert delivered.delivered_at is not None
    assert delivered.delivery == {"chat": {"ok": True}, "devices": []}
    # Read back from the table, not from the value the helper returned.
    row = await pool.fetchrow(
        "SELECT state, delivered_at, delivery FROM notices WHERE id = $1", notice.id
    )
    assert (row["state"], row["delivery"]) == (notices.DELIVERED, delivered.delivery)
    assert row["delivered_at"] is not None


async def test_an_empty_receipt_is_not_a_delivery(pool):
    """A notice counts as delivered only when a named channel said so. An
    empty receipt would satisfy the column and prove nothing."""
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )

    with pytest.raises(notices.NoticeError, match="cannot be empty"):
        await notices.mark_delivered(pool, notice.id, delivery={})

    assert await pool.fetchval("SELECT state FROM notices WHERE id = $1", notice.id) == "raised"


async def test_failed_says_why_and_a_blank_reason_is_refused(pool):
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )

    failed = await notices.mark_failed(pool, notice.id, "no paired device was connected")
    assert (failed.state, failed.failed_reason) == (
        notices.FAILED,
        "no paired device was connected",
    )

    with pytest.raises(notices.NoticeError, match="say why"):
        await notices.mark_failed(pool, notice.id, "   ")


async def test_seen_keeps_the_first_read_and_is_idempotent(pool):
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )

    first = await notices.mark_seen(pool, notice.id)
    again = await notices.mark_seen(pool, notice.id)

    assert (first.state, again.state) == (notices.SEEN, notices.SEEN)
    assert first.seen_at is not None
    assert again.seen_at == first.seen_at


async def test_acting_names_its_turn_and_says_what_was_done(pool):
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    turn = await _turn(pool)

    acted = await notices.mark_acted(pool, notice.id, turn_id=turn, note="resumed the paused timer")

    assert (acted.acted, acted.acted_turn_id) == (True, turn)
    assert acted.acted_note == "resumed the paused timer"
    # Acting is not a delivery: he still has not been told.
    assert acted.state == notices.RAISED


async def test_acting_with_nothing_to_show_is_refused(pool):
    """A flag with no note and no turn is a success claim nobody can check."""
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    turn = await _turn(pool)

    with pytest.raises(notices.NoticeError, match="what was done"):
        await notices.mark_acted(pool, notice.id, turn_id=turn, note="  ")
    with pytest.raises(notices.NoticeError, match="name the turn"):
        await notices.mark_acted(pool, notice.id, turn_id=None, note="fixed it")

    assert await pool.fetchval("SELECT acted FROM notices WHERE id = $1", notice.id) is False


async def test_a_transition_on_a_notice_that_is_not_there_is_loud(pool):
    """Not a quiet no-op: a caller that reports "delivered" must not be able
    to report it against a row that does not exist."""
    missing = uuid.uuid4()
    for call in (
        notices.mark_seen(pool, missing),
        notices.mark_failed(pool, missing, "nothing to deliver to"),
        notices.set_muted(pool, missing, True),
        notices.clear(pool, missing),
    ):
        with pytest.raises(notices.NoticeError, match="no notice with id"):
            await call


# -- the constraints themselves refuse a hand-written bad row -------------------


async def _insert_raw(pool, columns: str, values: str) -> None:
    await pool.execute(
        f"INSERT INTO notices (check_name, finding_key, fingerprint, title{columns}) "
        f"VALUES ('{QUIET}', 'k', 'fp-{uuid.uuid4()}', 't'{values})"
    )


async def test_the_database_refuses_a_state_with_no_evidence(pool):
    """The helpers set state and evidence in one UPDATE, but the guarantee is
    not that they are careful — it is that postgres refuses the row. Written
    by hand, each bad state raises its own named constraint."""
    for columns, values, constraint in (
        (", state", ", 'delivered'", "notices_delivered_says_when"),
        (", state", ", 'failed'", "notices_failed_says_why"),
        (", state", ", 'seen'", "notices_seen_says_when"),
        (", state", ", 'muted'", "notices_muted_says_when"),
        (", acted", ", true", "notices_acted_names_its_turn"),
    ):
        with pytest.raises(asyncpg.CheckViolationError) as caught:
            await _insert_raw(pool, columns, values)
        assert caught.value.constraint_name == constraint

    assert await _count(pool) == 0


# -- muting: a noise preference that survives ------------------------------------


async def test_a_muted_row_still_occupies_its_fingerprint(pool):
    """That IS the mute: stop telling me until the facts change. The same
    finding folds onto the muted row and delivers nothing new."""
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    muted = await notices.set_muted(pool, notice.id, True)
    assert (muted.state, muted.muted_at is not None) == (notices.MUTED, True)

    folded, is_new = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )

    assert (is_new, folded.id, folded.state, folded.repeats) == (
        False,
        notice.id,
        notices.MUTED,
        2,
    )
    assert await _count(pool) == 1
    assert await notices.deliverable(pool) == []


async def test_changed_facts_speak_again_even_when_the_old_row_is_muted(pool):
    """Muting the old facts must not mute the world. A different fingerprint
    is a different row, and it starts raised and unmuted."""
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    await notices.set_muted(pool, notice.id, True)

    fresh, is_new = await notices.record(
        pool,
        _finding(facts={"failures": 5, "timer": "backup"}),
        check_name=QUIET,
        turn_id=None,
        firing_id=None,
    )

    assert is_new is True
    assert (fresh.state, fresh.muted_at) == (notices.RAISED, None)
    assert [n.id for n in await notices.deliverable(pool)] == [fresh.id]


async def test_reading_a_muted_notice_leaves_the_mute_standing(pool):
    """A mute is a preference he set; opening the row is not a request to
    hear about it again. v3 lost mutes and re-armed a nag forever."""
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    await notices.set_muted(pool, notice.id, True)

    seen = await notices.mark_seen(pool, notice.id)

    assert seen.state == notices.MUTED
    assert seen.seen_at is not None


async def test_unmuting_derives_the_state_from_the_evidence_on_the_row(pool):
    """Not a remembered previous state — the timestamps already on the row
    say what happened, so a notice nobody was told about comes back
    deliverable and one he had read comes back read."""
    raised, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    delivered, _ = await notices.record(
        pool, _finding(key="k2", facts={"a": 1}), check_name=QUIET, turn_id=None, firing_id=None
    )
    read, _ = await notices.record(
        pool, _finding(key="k3", facts={"a": 2}), check_name=QUIET, turn_id=None, firing_id=None
    )
    await notices.mark_delivered(pool, delivered.id, delivery={"chat": {"ok": True}})
    await notices.mark_delivered(pool, read.id, delivery={"chat": {"ok": True}})
    await notices.mark_seen(pool, read.id)

    for notice, expected in (
        (raised, notices.RAISED),
        (delivered, notices.DELIVERED),
        (read, notices.SEEN),
    ):
        await notices.set_muted(pool, notice.id, True)
        back = await notices.set_muted(pool, notice.id, False)
        assert (back.state, back.muted_at) == (expected, None)


# -- reading them ----------------------------------------------------------------


async def test_deliverable_is_everything_still_true_nobody_was_told_oldest_first(pool):
    older, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    newer, _ = await notices.record(
        pool, _finding(key="k2", facts={"a": 1}), check_name=QUIET, turn_id=None, firing_id=None
    )
    told, _ = await notices.record(
        pool, _finding(key="k3", facts={"a": 2}), check_name=QUIET, turn_id=None, firing_id=None
    )
    await notices.mark_delivered(pool, told.id, delivery={"chat": {"ok": True}})

    assert [n.id for n in await notices.deliverable(pool)] == [older.id, newer.id]


async def test_recent_is_the_newest_sighting_first_and_honours_its_limit(pool):
    first, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    second, _ = await notices.record(
        pool, _finding(key="k2", facts={"a": 1}), check_name=QUIET, turn_id=None, firing_id=None
    )
    # The older row is seen again by a later beat, so it is the fresher news.
    await notices.record(pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None)

    assert [n.id for n in await notices.recent(pool)] == [first.id, second.id]
    assert [n.id for n in await notices.recent(pool, limit=1)] == [first.id]


async def test_unseen_count_counts_what_he_has_not_read(pool):
    """raised and delivered are unread news; seen is read and muted is a
    preference — neither belongs in the badge."""
    assert await notices.unseen_count(pool) == 0

    raised, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    delivered, _ = await notices.record(
        pool, _finding(key="k2", facts={"a": 1}), check_name=QUIET, turn_id=None, firing_id=None
    )
    read, _ = await notices.record(
        pool, _finding(key="k3", facts={"a": 2}), check_name=QUIET, turn_id=None, firing_id=None
    )
    hushed, _ = await notices.record(
        pool, _finding(key="k4", facts={"a": 3}), check_name=QUIET, turn_id=None, firing_id=None
    )
    await notices.mark_delivered(pool, delivered.id, delivery={"chat": {"ok": True}})
    await notices.mark_seen(pool, read.id)
    await notices.set_muted(pool, hushed.id, True)

    assert await notices.unseen_count(pool) == 2
    assert {n.id for n in await notices.deliverable(pool)} == {raised.id}


# -- facts the column can actually hold -----------------------------------------


async def test_facts_the_jsonb_column_cannot_store_are_refused_in_words(pool):
    """`checks.fingerprint` takes NaN happily (json.dumps writes it) and jsonb
    refuses it. Before this, such a check hashed fine, blew up on the INSERT,
    and went on failing EVERY HOUR with no row written and nobody told — a
    silent failure of the thing whose whole job is not being silent."""
    bad = _finding(facts={"headroom_ratio": float("nan")})
    # The hash side is perfectly happy, which is exactly the disagreement.
    assert checks.fingerprint(bad)

    with pytest.raises(notices.NoticeError, match="cannot be stored as jsonb"):
        await notices.record(pool, bad, check_name=QUIET, turn_id=None, firing_id=None)

    assert await _count(pool) == 0


async def test_facts_are_stored_by_the_same_rules_the_fingerprint_hashes_them(pool):
    """A money check sums a Decimal and a timer check reads a timestamp. The
    fingerprint serialises those with default=str; the pool's jsonb codec has
    no default and would raise, losing the row. Same rules on both sides now:
    the row is written, holding the values that were hashed."""
    measured = _finding(
        key="agent_over_cap:coder", facts={"spent": Decimal("12.50"), "cap": Decimal("10")}
    )

    notice, is_new = await notices.record(
        pool, measured, check_name=QUIET, turn_id=None, firing_id=None
    )

    assert is_new is True
    assert notice.facts == {"spent": "12.50", "cap": "10"}
    assert notice.fingerprint == checks.fingerprint(measured)
    # And the stored form did not change what counts as the same news.
    folded, is_new = await notices.record(
        pool, measured, check_name=QUIET, turn_id=None, firing_id=None
    )
    assert (is_new, folded.repeats) == (False, 2)


# -- a failed delivery is not a finished notice ----------------------------------


def test_the_deliverable_and_unseen_sets_are_derived_from_one_another():
    """FAILED is deliverable — a repeat of something that never landed is not
    a repeat — and the badge is the deliverable set plus what landed and is
    waiting to be opened, so the digest and the badge cannot drift apart."""
    assert notices.DELIVERABLE_STATES == (notices.RAISED, notices.FAILED)
    assert set(notices.UNSEEN_STATES) == set(notices.DELIVERABLE_STATES) | {notices.DELIVERED}
    assert notices.MUTED not in notices.UNSEEN_STATES
    assert notices.SEEN not in notices.UNSEEN_STATES


async def test_a_failed_delivery_stays_deliverable_and_unread_through_folds(pool):
    """The CRITICAL: reading only `raised` meant ONE failed push suppressed a
    still-true finding forever. The fold never moves a row back off `failed`,
    so every later sighting landed on a row the digest had stopped reading and
    nobody was ever told."""
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    failed = await notices.mark_failed(pool, notice.id, "no paired device was connected")
    assert failed.state == notices.FAILED

    for expected in (2, 3):
        folded, is_new = await notices.record(
            pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
        )
        assert (is_new, folded.id, folded.repeats, folded.state) == (
            False,
            notice.id,
            expected,
            notices.FAILED,
        )

    assert [n.id for n in await notices.deliverable(pool)] == [notice.id]
    assert await notices.unseen_count(pool) == 1


async def test_reading_a_failed_notice_does_not_erase_that_nobody_was_told(pool):
    """`failed` is the only record that the push never landed, and him finding
    the row himself in the Inbox does not make it have landed. The read is
    recorded as seen_at — that is what the badge counts — and the notice stays
    owed."""
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    await notices.mark_failed(pool, notice.id, "the gateway refused the push")

    seen = await notices.mark_seen(pool, notice.id)

    assert (seen.state, seen.failed_reason) == (notices.FAILED, "the gateway refused the push")
    assert seen.seen_at is not None
    assert await notices.unseen_count(pool) == 0
    assert [n.id for n in await notices.deliverable(pool)] == [notice.id]


async def test_muting_and_unmuting_is_not_a_laundering_path_for_failed(pool):
    """Unmuting derives the state from the evidence, so that derivation has to
    keep the same precedence the transitions do: a read receipt does not turn
    "nobody was told" into "he read it"."""
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    await notices.mark_failed(pool, notice.id, "no paired device was connected")
    await notices.mark_seen(pool, notice.id)
    await notices.set_muted(pool, notice.id, True)

    back = await notices.set_muted(pool, notice.id, False)

    assert (back.state, back.muted_at) == (notices.FAILED, None)


# -- a delivery may not lift a mute ----------------------------------------------


async def test_delivering_a_muted_notice_keeps_the_mute_and_writes_the_receipt(pool):
    """mark_seen preserved the mute and these two did not, so any delivery
    attempt un-muted the row and the nag came back — the v3 failure by a
    different door. The receipt is still written: the mute is about what he
    wants to hear, not about what is on the record."""
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    await notices.set_muted(pool, notice.id, True)

    delivered = await notices.mark_delivered(pool, notice.id, delivery={"chat": {"ok": True}})

    assert (delivered.state, delivered.delivery) == (notices.MUTED, {"chat": {"ok": True}})
    assert delivered.delivered_at is not None and delivered.muted_at is not None
    # Read back from the table, not from what the helper returned.
    row = await pool.fetchrow("SELECT state, muted_at FROM notices WHERE id = $1", notice.id)
    assert (row["state"], row["muted_at"] is not None) == (notices.MUTED, True)
    assert await notices.unseen_count(pool) == 0
    assert await notices.deliverable(pool) == []


async def test_a_failed_delivery_on_a_muted_notice_keeps_the_mute(pool):
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    await notices.set_muted(pool, notice.id, True)

    failed = await notices.mark_failed(pool, notice.id, "no paired device was connected")

    assert (failed.state, failed.failed_reason) == (
        notices.MUTED,
        "no paired device was connected",
    )
    assert await notices.deliverable(pool) == []
    assert await notices.unseen_count(pool) == 0


# -- the condition finishing, and being news again -------------------------------


async def test_clearing_frees_the_fingerprint_so_the_same_fault_is_news_again(pool):
    """The hole the review found: without a way to say a condition FINISHED,
    "one live row per fingerprint" means "tell him once, ever" — the thing
    that broke again folded onto the row from last week and he never heard.
    Clearing keeps the old row's story and leaves the fingerprint free."""
    first, is_new = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    assert is_new is True
    await notices.mark_delivered(pool, first.id, delivery={"chat": {"ok": True}})
    await notices.mark_seen(pool, first.id)

    cleared = await notices.clear(pool, first.id)

    assert cleared.cleared_at is not None
    # What he was TOLD is untouched: state is about the news, cleared_at is
    # about the condition.
    assert cleared.state == notices.SEEN

    again, is_new = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )

    assert is_new is True
    assert again.id != first.id
    assert (again.repeats, again.state, again.cleared_at) == (1, notices.RAISED, None)
    assert again.fingerprint == first.fingerprint
    assert await _count(pool) == 2
    assert [n.id for n in await notices.deliverable(pool)] == [again.id]


async def test_a_cleared_notice_is_no_longer_a_standing_debt(pool):
    """It was never delivered, and then it stopped being true. The digest does
    not still owe him a report of a condition that has finished — that it
    cleared is the reconcile's return value, said once."""
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    assert [n.id for n in await notices.deliverable(pool)] == [notice.id]

    await notices.clear(pool, notice.id)

    assert await notices.deliverable(pool) == []
    # Still in the Inbox and still unread: he was never told it happened.
    assert [n.id for n in await notices.recent(pool)] == [notice.id]
    assert await notices.unseen_count(pool) == 1


async def test_reconcile_clears_what_this_check_no_longer_finds_and_nothing_else(pool):
    """Every live notice of a check that RAN whose fingerprint is absent from
    this beat's findings has cleared. Scoped by check name, because one check's
    findings say nothing about another's subject."""
    still_true, _ = await notices.record(
        pool, _finding(key="a", facts={"a": 1}), check_name=QUIET, turn_id=None, firing_id=None
    )
    older_gone, _ = await notices.record(
        pool, _finding(key="b", facts={"b": 2}), check_name=QUIET, turn_id=None, firing_id=None
    )
    newer_gone, _ = await notices.record(
        pool, _finding(key="c", facts={"c": 3}), check_name=QUIET, turn_id=None, firing_id=None
    )
    other_family, _ = await notices.record(
        pool, _finding(key="d", facts={"d": 4}), check_name=LOUD, turn_id=None, firing_id=None
    )

    cleared = await notices.reconcile(
        pool, check_name=QUIET, live_fingerprints={still_true.fingerprint}
    )

    # Oldest first, so the digest reads them in the order they were raised.
    assert [n.id for n in cleared] == [older_gone.id, newer_gone.id]
    assert all(n.cleared_at is not None for n in cleared)
    assert [n.id for n in await notices.deliverable(pool)] == [still_true.id, other_family.id]


async def test_a_check_that_ran_and_found_nothing_clears_everything_it_had_raised(pool):
    """The ordinary all-clear: the probe was made and the world is fine."""
    first, _ = await notices.record(
        pool, _finding(key="a", facts={"a": 1}), check_name=QUIET, turn_id=None, firing_id=None
    )
    second, _ = await notices.record(
        pool, _finding(key="b", facts={"b": 2}), check_name=QUIET, turn_id=None, firing_id=None
    )

    cleared = await notices.reconcile(pool, check_name=QUIET, live_fingerprints=set())

    assert {n.id for n in cleared} == {first.id, second.id}
    assert await notices.deliverable(pool) == []


async def test_reconcile_never_clears_a_muted_notice(pool):
    """A mute means stop telling me about THIS until the facts change, and
    identical facts are the same fingerprint whether or not the condition
    blinked off and on in between. So the muted row holds its fingerprint: the
    same fault returning folds onto it, silently, as he asked."""
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    await notices.set_muted(pool, notice.id, True)

    assert await notices.reconcile(pool, check_name=QUIET, live_fingerprints=set()) == []
    row = await pool.fetchrow("SELECT state, cleared_at FROM notices WHERE id = $1", notice.id)
    assert (row["state"], row["cleared_at"]) == (notices.MUTED, None)

    folded, is_new = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    assert (is_new, folded.id, folded.state, folded.repeats) == (
        False,
        notice.id,
        notices.MUTED,
        2,
    )
    assert await _count(pool) == 1


async def test_clearing_a_muted_notice_is_refused_in_words(pool):
    """The same rule at the other writer of cleared_at, said out loud rather
    than silently skipped: a caller must not report a clear that did not
    happen."""
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    await notices.set_muted(pool, notice.id, True)

    with pytest.raises(notices.NoticeError, match="never cleared"):
        await notices.clear(pool, notice.id)

    assert await pool.fetchval("SELECT cleared_at FROM notices WHERE id = $1", notice.id) is None


async def test_clearing_a_row_that_already_cleared_is_loud(pool):
    """Not a quiet second no-op: a caller working from a stale read is told,
    with the time the row actually cleared."""
    notice, _ = await notices.record(
        pool, _finding(), check_name=QUIET, turn_id=None, firing_id=None
    )
    await notices.clear(pool, notice.id)

    with pytest.raises(notices.NoticeError, match="already cleared"):
        await notices.clear(pool, notice.id)


async def test_reconcile_refuses_a_check_nobody_registered(pool):
    """An invented name would clear nothing and return [], which reads as
    "nothing had cleared" — the quietest possible false all-clear."""
    with pytest.raises(notices.NoticeError, match="is registered"):
        await notices.reconcile(pool, check_name="i_made_this_up", live_fingerprints=set())
