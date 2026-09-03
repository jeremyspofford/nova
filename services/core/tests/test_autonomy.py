"""Earned autonomy (ruling S3-R5): app/autonomy.py's counter, promotion,
demotion and revoke — the DATA the kernel reads, never a second decision path.

Every test seeds its own action_class row with an explicit UPSERT rather than
relying on the migration seed or another test's leftover state:
action_classes is deliberately NOT truncated between tests (conftest.py's
_TABLES comment — it carries the migration seed like schema), so a test that
mutates a row (promoting/demoting it) must not assume anything about what an
earlier test in this session left behind, and must not leave behind anything
a later test could be surprised by either. A dedicated, test-only
action_class name per scenario keeps this file's mutations from ever being
read by test_policy.py/test_policy_funnel.py's fetch_url-based tests.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

from app import autonomy, consents, governance, policy
from app.identity import Person
from app.tools.base import ToolContext
from tests.conftest import requires_db

pytestmark = requires_db


async def _seed(
    pool,
    action_class: str,
    *,
    disposition: str = "consent",
    earned: bool = False,
    consecutive_successes: int = 0,
) -> None:
    """Force `action_class` to an exact known row, regardless of what any
    earlier test in this session left it at."""
    await pool.execute(
        "INSERT INTO action_classes (action_class, risk_tier, disposition, earned, "
        "consecutive_successes) VALUES ($1, 'test', $2, $3, $4) "
        "ON CONFLICT (action_class) DO UPDATE SET "
        "disposition = EXCLUDED.disposition, earned = EXCLUDED.earned, "
        "consecutive_successes = EXCLUDED.consecutive_successes, updated_at = now()",
        action_class,
        disposition,
        earned,
        consecutive_successes,
    )


async def _row(pool, action_class: str):
    return await pool.fetchrow(
        "SELECT disposition, earned, consecutive_successes FROM action_classes "
        "WHERE action_class = $1",
        action_class,
    )


async def _of_kind(pool, kind: str, action_class: str) -> list:
    events = await governance.recent_events(pool, action_class=action_class)
    return [e for e in events if e["kind"] == kind]


async def _operator(pool) -> uuid.UUID:
    """A real people row — raising/deciding a consent binds to one (FK)."""
    return await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('op', 'owner') RETURNING id"
    )


async def _raise_and_decide(pool, action_class: str, *, approve: bool, operator: uuid.UUID):
    """Raise a real consent card for `action_class` and decide it — the exact
    path the operator API drives, so the deny reset is exercised through
    consents.decide, not a shortcut."""
    card = await consents.raise_consent(
        pool,
        action_class=action_class,
        args={"url": "https://example.com/x"},
        summary="s",
        person_id=operator,
        agent="chat",
        conversation_id=None,
    )
    return await consents.decide(
        pool,
        consent_id=uuid.UUID(card["consent_id"]),
        approve=approve,
        decided_by=operator,
    )


# -- graduation_runs setting -------------------------------------------------


async def test_graduation_runs_defaults_to_five(pool):
    assert await autonomy.graduation_runs(pool) == 5


async def test_graduation_runs_reads_the_setting_when_written(pool, owner_client):
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "autonomy.graduation_runs", "value": 3}
    )
    assert resp.status_code == 200
    assert await autonomy.graduation_runs(pool) == 3


# -- promotion ---------------------------------------------------------------


async def test_a_successful_run_increments_the_real_counter(pool):
    await _seed(pool, "earn_incr", consecutive_successes=1)
    await autonomy.record_outcome(pool, action_class="earn_incr", succeeded=True)
    row = await _row(pool, "earn_incr")
    assert row["consecutive_successes"] == 2
    assert row["disposition"] == "consent"  # not yet at the (default) threshold of 5


async def test_the_nth_success_promotes_to_auto_and_resets_the_counter(pool):
    await _seed(pool, "earn_grad", consecutive_successes=4)  # one short of default N=5
    await autonomy.record_outcome(pool, action_class="earn_grad", succeeded=True)
    row = await _row(pool, "earn_grad")
    assert row["disposition"] == "auto"
    assert row["earned"] is True
    assert row["consecutive_successes"] == 0


async def test_promotion_writes_a_governance_event(pool):
    await _seed(pool, "earn_event", consecutive_successes=4)
    await autonomy.record_outcome(pool, action_class="earn_event", succeeded=True)
    promoted = await _of_kind(pool, governance.AUTONOMY_PROMOTED, "earn_event")
    assert len(promoted) == 1
    assert promoted[0]["meta"]["graduation_runs"] == 5


async def test_a_lower_graduation_runs_setting_promotes_sooner(pool):
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('autonomy.graduation_runs', '2'::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    )
    await _seed(pool, "earn_low_n", consecutive_successes=1)
    await autonomy.record_outcome(pool, action_class="earn_low_n", succeeded=True)
    row = await _row(pool, "earn_low_n")
    assert row["disposition"] == "auto"


async def test_an_already_auto_class_succeeding_again_does_not_re_promote_or_re_event(pool):
    await _seed(pool, "earn_already_auto", disposition="auto", earned=True)
    await autonomy.record_outcome(pool, action_class="earn_already_auto", succeeded=True)
    row = await _row(pool, "earn_already_auto")
    assert row["disposition"] == "auto"
    assert row["consecutive_successes"] == 0
    assert await _of_kind(pool, governance.AUTONOMY_PROMOTED, "earn_already_auto") == []


# -- concurrency: FOR UPDATE serializes same-class outcomes -------------------


async def test_two_concurrent_successes_promote_exactly_once(pool):
    """Two burned-and-succeeded outcomes for the SAME class, fired concurrently
    over TWO separate pool connections (asyncio.gather, each record_outcome
    acquires its own conn), must promote it exactly once. record_outcome's
    SELECT ... FOR UPDATE takes a row lock, so the two transactions serialize:
    whichever wins the lock promotes (consent -> auto, counter -> 0); the other
    then reads the already-auto row and hits the no-op branch — never a second
    promotion, never a double-counted event. The sequential promotion tests
    above pass even if the FOR UPDATE is dropped; only real contention pins it,
    mirroring test_consents.py's concurrent-burn test."""
    n = await autonomy.graduation_runs(pool)
    await _seed(pool, "grad_race", consecutive_successes=n - 1)  # one run short of auto

    await asyncio.gather(
        autonomy.record_outcome(pool, action_class="grad_race", succeeded=True),
        autonomy.record_outcome(pool, action_class="grad_race", succeeded=True),
    )

    row = await _row(pool, "grad_race")
    assert row["disposition"] == "auto"
    assert row["earned"] is True
    assert row["consecutive_successes"] == 0
    promoted = await _of_kind(pool, governance.AUTONOMY_PROMOTED, "grad_race")
    assert len(promoted) == 1  # exactly one promotion event, not two


# -- deny resets the graduation streak (an operator's strongest distrust) ------


async def test_a_deny_resets_the_streak_but_never_demotes(pool):
    """An operator DENY is the strongest distrust signal there is — stronger
    than a failure (a failure is Nova's fault; a deny is 'no, not this action')
    — so it zeroes the graduation counter of the still-consent class it denied,
    in the SAME transaction as the deny + its consent.decided event. It does
    NOT demote: disposition/earned belong to the failure/revoke path, not a
    deny. And after the reset a fresh burned-and-succeeded run resumes at 1,
    nowhere near the threshold the deny wiped — so the class cannot auto-graduate
    on its very next approval."""
    n = await autonomy.graduation_runs(pool)
    await _seed(pool, "deny_reset", consecutive_successes=n - 1)  # one run short of auto
    operator = await _operator(pool)

    decided = await _raise_and_decide(pool, "deny_reset", approve=False, operator=operator)
    assert decided["status"] == "denied"

    row = await _row(pool, "deny_reset")
    assert row["consecutive_successes"] == 0  # streak broken
    assert row["disposition"] == "consent"  # NOT demoted — a deny only breaks the streak
    assert row["earned"] is False

    # One later burned-and-succeeded run resumes at 1, not at the threshold.
    await autonomy.record_outcome(pool, action_class="deny_reset", succeeded=True)
    row = await _row(pool, "deny_reset")
    assert row["consecutive_successes"] == 1
    assert row["disposition"] == "consent"


async def test_an_approve_does_not_reset_the_graduation_counter(pool):
    """Approve is a STEP toward graduation, not a distrust signal — it must
    leave the counter untouched. Only the burned+succeeded run that follows an
    approval (via record_outcome) moves it."""
    await _seed(pool, "approve_no_reset", consecutive_successes=2)
    operator = await _operator(pool)

    decided = await _raise_and_decide(pool, "approve_no_reset", approve=True, operator=operator)
    assert decided["status"] == "approved"

    row = await _row(pool, "approve_no_reset")
    assert row["consecutive_successes"] == 2  # untouched by the approve


async def test_a_double_decide_deny_writes_no_second_reset_or_event(pool):
    """A card decided once returns None on a second decide (consents.decide's
    no-op), so the deny-reset must not fire again: no second counter write, no
    second consent.decided event."""
    await _seed(pool, "double_decide", consecutive_successes=3)
    operator = await _operator(pool)
    card = await consents.raise_consent(
        pool,
        action_class="double_decide",
        args={"url": "https://example.com/x"},
        summary="s",
        person_id=operator,
        agent="chat",
        conversation_id=None,
    )
    cid = uuid.UUID(card["consent_id"])

    # First deny: resets the counter to 0 and records one consent.decided event.
    assert (
        await consents.decide(pool, consent_id=cid, approve=False, decided_by=operator)
        is not None
    )
    # Bump the counter so a spurious second reset would be plainly visible.
    await pool.execute(
        "UPDATE action_classes SET consecutive_successes = 4 WHERE action_class = $1",
        "double_decide",
    )
    # Second deny of the same card is a no-op (decide returns None) — no reset.
    assert (
        await consents.decide(pool, consent_id=cid, approve=False, decided_by=operator) is None
    )

    row = await _row(pool, "double_decide")
    assert row["consecutive_successes"] == 4  # the no-op did NOT re-zero it
    decided_events = await _of_kind(pool, governance.CONSENT_DECIDED, "double_decide")
    assert len(decided_events) == 1  # only the first decide recorded an event


# -- failure: reset, and demote only when earned -----------------------------


async def test_a_failure_of_a_consent_tier_class_resets_the_counter_without_demoting(pool):
    await _seed(pool, "earn_fail_consent", consecutive_successes=3)
    await autonomy.record_outcome(pool, action_class="earn_fail_consent", succeeded=False)
    row = await _row(pool, "earn_fail_consent")
    assert row["disposition"] == "consent"  # nothing to demote — it never graduated
    assert row["consecutive_successes"] == 0
    assert await _of_kind(pool, governance.AUTONOMY_DEMOTED, "earn_fail_consent") == []


async def test_a_failure_of_an_earned_auto_class_demotes_it_and_resets(pool):
    await _seed(pool, "earn_fail_auto", disposition="auto", earned=True)
    await autonomy.record_outcome(pool, action_class="earn_fail_auto", succeeded=False)
    row = await _row(pool, "earn_fail_auto")
    assert row["disposition"] == "consent"
    assert row["earned"] is False
    assert row["consecutive_successes"] == 0


async def test_demotion_on_failure_writes_a_governance_event(pool):
    await _seed(pool, "earn_fail_event", disposition="auto", earned=True)
    await autonomy.record_outcome(pool, action_class="earn_fail_event", succeeded=False)
    demoted = await _of_kind(pool, governance.AUTONOMY_DEMOTED, "earn_fail_event")
    assert len(demoted) == 1


async def test_a_seeded_auto_class_failing_is_never_touched_by_this_module(pool):
    """workspace_write_file/memory_save/reads are auto by DESIGN (ruling
    S3-R1), never earned — record_outcome must never be invoked for them in
    practice (policy.py sets track_outcome=False), but even a direct,
    mistaken call must not demote a class this loop never promoted."""
    await _seed(pool, "earn_seeded_auto", disposition="auto", earned=False)
    await autonomy.record_outcome(pool, action_class="earn_seeded_auto", succeeded=False)
    row = await _row(pool, "earn_seeded_auto")
    assert row["disposition"] == "auto"
    assert row["consecutive_successes"] == 0  # reset, but not demoted


async def test_an_unknown_action_class_is_a_silent_no_op(pool):
    # No row at all — nothing to record against, and nothing must throw.
    await autonomy.record_outcome(pool, action_class="does_not_exist", succeeded=True)
    await autonomy.record_outcome(pool, action_class="does_not_exist", succeeded=False)


# -- revoke -------------------------------------------------------------------


async def test_revoke_demotes_an_earned_auto_class_and_records_it(pool):
    await _seed(pool, "earn_revoke", disposition="auto", earned=True)
    ok = await autonomy.revoke(pool, action_class="earn_revoke", actor="operator-1")
    assert ok is True
    row = await _row(pool, "earn_revoke")
    assert row["disposition"] == "consent"
    assert row["earned"] is False
    assert row["consecutive_successes"] == 0
    revoked = await _of_kind(pool, governance.AUTONOMY_REVOKED, "earn_revoke")
    assert len(revoked) == 1
    assert revoked[0]["actor"] == "operator-1"


async def test_revoke_is_a_no_op_on_a_class_that_never_graduated(pool):
    await _seed(pool, "earn_revoke_never", disposition="consent")
    ok = await autonomy.revoke(pool, action_class="earn_revoke_never", actor="operator-1")
    assert ok is False
    assert await _of_kind(pool, governance.AUTONOMY_REVOKED, "earn_revoke_never") == []


async def test_revoke_is_a_no_op_on_a_seeded_auto_class(pool):
    """A baseline-auto class (never earned) is not this button's business —
    it was never gated, so there is nothing this loop granted to take back."""
    await _seed(pool, "earn_revoke_seeded", disposition="auto", earned=False)
    ok = await autonomy.revoke(pool, action_class="earn_revoke_seeded", actor="operator-1")
    assert ok is False
    row = await _row(pool, "earn_revoke_seeded")
    assert row["disposition"] == "auto"  # untouched


async def test_revoke_is_a_no_op_on_an_unknown_class(pool):
    assert await autonomy.revoke(pool, action_class="does_not_exist", actor="x") is False


# -- state (Settings -> Autonomy's read) --------------------------------------


async def test_state_reports_the_real_stored_counters_and_the_current_threshold(pool):
    await _seed(pool, "earn_state", disposition="consent", consecutive_successes=3)
    rows = await autonomy.state(pool)
    entry = next(r for r in rows if r["action_class"] == "earn_state")
    assert entry["disposition"] == "consent"
    assert entry["consecutive_successes"] == 3
    assert entry["graduation_runs"] == await autonomy.graduation_runs(pool)
    assert entry["earned"] is False


async def test_state_includes_every_seeded_class(pool):
    classes = {r["action_class"] for r in await autonomy.state(pool)}
    assert "fetch_url" in classes
    assert "workspace_write_file" in classes
    assert "get_time" in classes


# -- set_disposition: the owner's own control over a class ---------------------
#
# Not a second authorizer: it edits the DATA the kernel reads (the same
# action_classes.disposition row revoke edits) and records that edit. The
# kernel's next authorize() call sees it by reading the row, as ever.


async def test_set_disposition_auto_pins_a_consent_class_open_and_records_it(pool):
    """The walk's friction 5: device_run is seeded consent, so every distinct
    command needs approve(+go ahead) until 5 successes graduate it. The owner
    wants none of that for actions he already instructed — so he sets the
    class auto himself. Operator-set auto is earned=false, exactly like a
    seeded auto: it never self-demotes on a failure (policy tracks only
    earned autos)."""
    await _seed(pool, "disp_auto", disposition="consent", consecutive_successes=3)
    entry = await autonomy.set_disposition(
        pool, action_class="disp_auto", disposition="auto", actor="person-1"
    )
    assert entry["action_class"] == "disp_auto"
    assert entry["disposition"] == "auto"
    assert entry["earned"] is False
    assert entry["consecutive_successes"] == 0
    assert entry["graduation_runs"] == await autonomy.graduation_runs(pool)
    row = await _row(pool, "disp_auto")
    assert (row["disposition"], row["earned"], row["consecutive_successes"]) == ("auto", False, 0)

    events = await _of_kind(pool, governance.AUTONOMY_DISPOSITION_SET, "disp_auto")
    assert len(events) == 1
    assert events[0]["actor"] == "person-1"
    assert events[0]["meta"] == {"before": "consent", "after": "auto", "action_class": "disp_auto"}


async def test_operator_set_auto_never_self_demotes_on_a_failure(pool):
    await _seed(pool, "disp_auto_stays", disposition="consent")
    await autonomy.set_disposition(
        pool, action_class="disp_auto_stays", disposition="auto", actor="p"
    )
    await autonomy.record_outcome(pool, action_class="disp_auto_stays", succeeded=False)
    row = await _row(pool, "disp_auto_stays")
    assert row["disposition"] == "auto"  # a seeded/operator auto is not this loop's to demote
    assert await _of_kind(pool, governance.AUTONOMY_DEMOTED, "disp_auto_stays") == []


async def test_set_disposition_consent_over_an_earned_auto_clears_earned(pool):
    await _seed(pool, "disp_consent", disposition="auto", earned=True)
    entry = await autonomy.set_disposition(
        pool, action_class="disp_consent", disposition="consent", actor="p"
    )
    assert (entry["disposition"], entry["earned"], entry["consecutive_successes"]) == (
        "consent",
        False,
        0,
    )
    events = await _of_kind(pool, governance.AUTONOMY_DISPOSITION_SET, "disp_consent")
    assert events[0]["meta"]["before"] == "auto" and events[0]["meta"]["after"] == "consent"


async def test_set_disposition_auto_over_an_earned_auto_makes_it_operator_set(pool):
    """Pinning auto onto a class that EARNED auto flips earned off: from now on
    it is the owner's decision, not a streak a failure can undo."""
    await _seed(pool, "disp_pin", disposition="auto", earned=True)
    entry = await autonomy.set_disposition(
        pool, action_class="disp_pin", disposition="auto", actor="p"
    )
    assert entry["disposition"] == "auto" and entry["earned"] is False
    # Revoke (earned-only) now has nothing to take back — the owner set it.
    assert await autonomy.revoke(pool, action_class="disp_pin", actor="p") is False
    assert (await _row(pool, "disp_pin"))["disposition"] == "auto"


async def test_set_disposition_deny_refuses_the_class_by_name_at_the_kernel(pool):
    """The kernel reads the row: after the owner sets deny, authorize() DENIES
    with the class named; after auto, it ALLOWS untracked (operator-set auto
    is not an earned auto). No code in autonomy.py decided either — the row did."""
    await _seed(pool, "disp_kernel", disposition="consent")
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('kern', 'owner') RETURNING id"
    )
    ctx = ToolContext(
        app=None,
        person=Person(id=pid, name="kern", role="owner"),
        workspace_root=None,
        conversation_id=None,
    )

    await autonomy.set_disposition(pool, action_class="disp_kernel", disposition="deny", actor="p")
    decision = await policy.authorize(ctx, "disp_kernel", {})
    assert decision.outcome == policy.DENY
    assert "disp_kernel" in decision.reason

    await autonomy.set_disposition(pool, action_class="disp_kernel", disposition="auto", actor="p")
    decision = await policy.authorize(ctx, "disp_kernel", {})
    assert decision.outcome == policy.ALLOW
    assert decision.track_outcome is False

    await autonomy.set_disposition(
        pool, action_class="disp_kernel", disposition="consent", actor="p"
    )
    decision = await policy.authorize(ctx, "disp_kernel", {})
    assert decision.outcome == policy.REQUIRE_CONSENT


async def test_set_disposition_records_one_event_per_call_even_when_unchanged(pool):
    """Setting consent on a consent class still resets the streak (a real
    change to the row) and is still the owner's act — it is recorded."""
    await _seed(pool, "disp_same", disposition="consent", consecutive_successes=4)
    entry = await autonomy.set_disposition(
        pool, action_class="disp_same", disposition="consent", actor="p"
    )
    assert entry["consecutive_successes"] == 0
    events = await _of_kind(pool, governance.AUTONOMY_DISPOSITION_SET, "disp_same")
    assert len(events) == 1
    assert events[0]["meta"]["before"] == "consent" and events[0]["meta"]["after"] == "consent"


async def test_set_disposition_refuses_an_unknown_disposition_and_writes_nothing(pool):
    await _seed(pool, "disp_bad", disposition="consent", consecutive_successes=2)
    with pytest.raises(ValueError) as excinfo:
        await autonomy.set_disposition(
            pool, action_class="disp_bad", disposition="always", actor="p"
        )
    assert "always" in str(excinfo.value)
    row = await _row(pool, "disp_bad")
    assert (row["disposition"], row["consecutive_successes"]) == ("consent", 2)
    assert await _of_kind(pool, governance.AUTONOMY_DISPOSITION_SET, "disp_bad") == []


async def test_set_disposition_refuses_an_unknown_class_and_writes_nothing(pool):
    with pytest.raises(LookupError) as excinfo:
        await autonomy.set_disposition(
            pool, action_class="no_such_class", disposition="auto", actor="p"
        )
    assert "no_such_class" in str(excinfo.value)
    assert await _row(pool, "no_such_class") is None  # never inserted
    assert await _of_kind(pool, governance.AUTONOMY_DISPOSITION_SET, "no_such_class") == []


# -- set_all_dispositions: the master control ----------------------------------
#
# Every class to one value in ONE transaction, touching only the classes that
# were not already there. Same row, same column, same event kind as
# set_disposition — one event per changed class, sharing meta.batch.
#
# A bulk write reaches every row in action_classes — the migration seed the
# kernel reads and every other test's leftovers included — and action_classes
# is never truncated (conftest._TABLES). So each test here snapshots the whole
# table first and puts it back afterwards, row for row; without that, one
# set_all('auto') would silently rewrite device_run/fetch_url for every suite
# that runs after this file.


@pytest.fixture
async def restored_action_classes(pool):
    before = await pool.fetch(
        "SELECT action_class, risk_tier, disposition, earned, consecutive_successes "
        "FROM action_classes"
    )
    yield
    for row in before:
        await pool.execute(
            "INSERT INTO action_classes (action_class, risk_tier, disposition, earned, "
            "consecutive_successes) VALUES ($1, $2, $3, $4, $5) "
            "ON CONFLICT (action_class) DO UPDATE SET risk_tier = EXCLUDED.risk_tier, "
            "disposition = EXCLUDED.disposition, earned = EXCLUDED.earned, "
            "consecutive_successes = EXCLUDED.consecutive_successes, updated_at = now()",
            row["action_class"],
            row["risk_tier"],
            row["disposition"],
            row["earned"],
            row["consecutive_successes"],
        )
    await pool.execute(
        "DELETE FROM action_classes WHERE action_class <> ALL($1::text[])",
        [row["action_class"] for row in before],
    )


async def _set_events(pool) -> list:
    """Every disposition_set event in the (per-test truncated) ledger."""
    events = await governance.recent_events(pool, limit=1000)
    return [e for e in events if e["kind"] == governance.AUTONOMY_DISPOSITION_SET]


async def test_set_all_flips_only_the_differing_classes_and_records_each_under_one_batch(
    pool, restored_action_classes
):
    """Four seeded rows, one per situation: a consent class mid-streak, a
    denied class, an operator-set auto, an EARNED auto. set_all('auto') writes
    exactly the first two — the ledger gets one event each, sharing a batch id
    — and leaves both autos untouched: no event, and the earned one is STILL
    earned (a bulk auto is not a reason to turn a streak the class earned into
    a pin; set_disposition on that one class does that, deliberately)."""
    await _seed(pool, "all_consent", disposition="consent", consecutive_successes=3)
    await _seed(pool, "all_deny", disposition="deny")
    await _seed(pool, "all_auto_set", disposition="auto", earned=False)
    await _seed(pool, "all_auto_earned", disposition="auto", earned=True)
    before = await autonomy.state(pool)

    state, changed = await autonomy.set_all_dispositions(pool, disposition="auto", actor="p-1")

    # Only what differed changed — and everything that differed changed, in
    # action_class order (as the locking SELECT walks them).
    assert changed == sorted(e["action_class"] for e in before if e["disposition"] != "auto")
    assert "all_consent" in changed and "all_deny" in changed
    assert "all_auto_set" not in changed and "all_auto_earned" not in changed
    assert all(entry["disposition"] == "auto" for entry in state)
    assert state == await autonomy.state(pool)  # the returned state is the committed state

    rows = {
        n: await _row(pool, n)
        for n in ("all_consent", "all_deny", "all_auto_set", "all_auto_earned")
    }
    assert (
        rows["all_consent"]["disposition"],
        rows["all_consent"]["earned"],
        rows["all_consent"]["consecutive_successes"],
    ) == ("auto", False, 0)
    assert (rows["all_deny"]["disposition"], rows["all_deny"]["earned"]) == ("auto", False)
    assert rows["all_auto_earned"]["earned"] is True  # untouched: still earned
    assert rows["all_auto_set"]["earned"] is False

    # One event per changed class, each in its OWN action_class column (so the
    # per-class audit filter finds it), all sharing one batch id.
    events = await _set_events(pool)
    assert sorted(e["action_class"] for e in events) == sorted(changed)
    assert len(events) == len(changed)
    batches = {e["meta"]["batch"] for e in events}
    assert len(batches) == 1
    uuid.UUID(batches.pop())  # a real uuid4 string, not a placeholder
    by_class = {e["action_class"]: e for e in events}
    assert by_class["all_consent"]["meta"] == {
        "before": "consent",
        "after": "auto",
        "action_class": "all_consent",
        "batch": events[0]["meta"]["batch"],
    }
    assert by_class["all_deny"]["meta"]["before"] == "deny"
    assert all(e["actor"] == "p-1" for e in events)
    # The untouched autos have no event at all — the ledger names what changed.
    assert await _of_kind(pool, governance.AUTONOMY_DISPOSITION_SET, "all_auto_earned") == []
    assert await _of_kind(pool, governance.AUTONOMY_DISPOSITION_SET, "all_auto_set") == []


async def test_set_all_is_one_transaction_a_failed_event_rolls_every_row_back(
    pool, restored_action_classes, monkeypatch
):
    """Two consent classes (plus whatever else differs). If the SECOND event
    write fails, the first class's row write — already executed on the same
    connection — must roll back with it: no row changed, no event kept."""
    await _seed(pool, "all_tx_a", disposition="consent", consecutive_successes=2)
    await _seed(pool, "all_tx_b", disposition="consent", consecutive_successes=4)
    real_record_event = governance.record_event
    calls = 0

    async def flaky_record_event(conn, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("ledger write refused")
        await real_record_event(conn, **kwargs)

    monkeypatch.setattr(governance, "record_event", flaky_record_event)

    with pytest.raises(RuntimeError, match="ledger write refused"):
        await autonomy.set_all_dispositions(pool, disposition="auto", actor="p")

    assert calls == 2  # the second event is where it broke — after a first row write
    a, b = await _row(pool, "all_tx_a"), await _row(pool, "all_tx_b")
    assert (a["disposition"], a["consecutive_successes"]) == ("consent", 2)
    assert (b["disposition"], b["consecutive_successes"]) == ("consent", 4)
    assert await _set_events(pool) == []  # the first event rolled back with the rest
    # Nothing at all moved: the whole table still reads as it was seeded.
    assert not any(
        entry["disposition"] == "auto" and entry["action_class"].startswith("all_tx_")
        for entry in await autonomy.state(pool)
    )


async def test_set_all_with_nothing_to_change_writes_no_event_and_keeps_streaks_and_earned(
    pool, restored_action_classes
):
    """A class already at the target is not touched: its streak survives the
    first bulk write, and a second identical bulk write is an honest
    (state, []) — no event, no reset. Contrast set_disposition, which resets
    the streak and records an event even when the value is unchanged
    (test_set_disposition_records_one_event_per_call_even_when_unchanged)."""
    await _seed(pool, "all_keep_streak", disposition="consent", consecutive_successes=3)

    _, first = await autonomy.set_all_dispositions(pool, disposition="consent", actor="p")
    assert "all_keep_streak" not in first  # already consent — not this call's business
    row = await _row(pool, "all_keep_streak")
    assert row["consecutive_successes"] == 3  # streak kept
    assert await _of_kind(pool, governance.AUTONOMY_DISPOSITION_SET, "all_keep_streak") == []
    events_after_first = len(await _set_events(pool))

    state, second = await autonomy.set_all_dispositions(pool, disposition="consent", actor="p")
    assert second == []
    assert all(entry["disposition"] == "consent" for entry in state)
    assert len(await _set_events(pool)) == events_after_first  # not one more
    row = await _row(pool, "all_keep_streak")
    assert (row["disposition"], row["consecutive_successes"]) == ("consent", 3)


async def test_set_all_refuses_an_unknown_disposition_in_set_dispositions_words_and_writes_nothing(
    pool, restored_action_classes
):
    await _seed(pool, "all_bad", disposition="consent", consecutive_successes=2)
    with pytest.raises(ValueError) as bulk:
        await autonomy.set_all_dispositions(pool, disposition="always", actor="p")
    with pytest.raises(ValueError) as single:
        await autonomy.set_disposition(
            pool, action_class="all_bad", disposition="always", actor="p"
        )
    assert "always" in str(bulk.value)
    assert str(bulk.value) == str(single.value)  # the same refusal, not a second wording
    row = await _row(pool, "all_bad")
    assert (row["disposition"], row["consecutive_successes"]) == ("consent", 2)
    assert await _set_events(pool) == []


async def test_set_all_deny_refuses_every_class_at_the_kernel_and_auto_allows(
    pool, restored_action_classes
):
    """Mirror of the per-class kernel test: the kernel reads the row. After a
    bulk deny, authorize() DENIES a class by name; after a bulk auto it ALLOWS
    untracked; after a bulk consent the card returns. No code here decided —
    the rows did."""
    await _seed(pool, "all_kernel", disposition="consent")
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('kern_all', 'owner') RETURNING id"
    )
    ctx = ToolContext(
        app=None,
        person=Person(id=pid, name="kern_all", role="owner"),
        workspace_root=None,
        conversation_id=None,
    )

    await autonomy.set_all_dispositions(pool, disposition="deny", actor="p")
    decision = await policy.authorize(ctx, "all_kernel", {})
    assert decision.outcome == policy.DENY
    assert "all_kernel" in decision.reason

    await autonomy.set_all_dispositions(pool, disposition="auto", actor="p")
    decision = await policy.authorize(ctx, "all_kernel", {})
    assert decision.outcome == policy.ALLOW
    assert decision.track_outcome is False

    await autonomy.set_all_dispositions(pool, disposition="consent", actor="p")
    decision = await policy.authorize(ctx, "all_kernel", {})
    assert decision.outcome == policy.REQUIRE_CONSENT
