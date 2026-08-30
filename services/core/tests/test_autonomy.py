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

from app import autonomy, governance
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
