"""Force a verification failure; assert goal handles it (re-spec or escalation).

These tests exercise the smart-retry-then-escalate logic in
``cortex/app/maturation/verifying.py``.

Verification outcome depends on three signals — exec'd commands, the Quartet
LLM Code-Review verdict, and structured success criteria — combined by
``aggregator.aggregate``. With ``cmd: "false"`` the command exits non-zero,
which the aggregator maps to one of:

  * ``fail``         when Quartet confidence ≥ 0.7 → triggers retry / escalate
  * ``human-review`` when Quartet confidence < 0.7 → straight to ``review``

Both branches are valid handlings of a verification failure. The tests
assert the *outcome* (system reacted; goal moved off ``verifying``) rather
than locking in one branch — keeps them robust whether or not the underlying
Quartet path returns a high-confidence verdict in the test env.

Test reliability note
---------------------
These tests rely on cortex's ``serve`` drive picking up the verifying-state
goal during its round-robin pass through stale active goals. On a busy Nova
instance (many active goals, slow active-cycle interval) this can take 10+
minutes before our seeded goal is selected — and the default 5-min poll may
time out. In CI / a quiet instance the goal is picked promptly. If you're
seeing flakes, check ``docker compose logs cortex`` for cycle frequency and
``SELECT COUNT(*) FROM goals WHERE status='active'`` for queue length.
"""
import asyncio
import os

import httpx
import pytest

ORCH = os.getenv("NOVA_ORCH_URL", "http://localhost:8000")
ADMIN = os.getenv("NOVA_ADMIN_SECRET", "")
HEADERS = {"X-Admin-Secret": ADMIN}


async def _wait_for(client: httpx.AsyncClient, gid: str, predicate, *, timeout_iters: int = 360):
    """Poll the goal until ``predicate(goal_dict)`` is true or timeout. Returns last seen goal.

    Default 360 * 2s = 12 minutes — generous enough for cortex's round-robin
    to cycle through ~10 other stale goals at ~1-2 min/cycle and land on ours.
    On a quiet instance this returns in <1 min.
    """
    g = None
    for _ in range(timeout_iters):
        await asyncio.sleep(2)
        resp = await client.get(f"{ORCH}/api/v1/goals/{gid}", headers=HEADERS)
        resp.raise_for_status()
        g = resp.json()
        if predicate(g):
            return g
    return g


@pytest.mark.slow
@pytest.mark.asyncio
async def test_verify_failure_triggers_recovery():
    """First failure → cortex reacts: either re-specs (retry_count=1, scoping)
    OR escalates immediately to ``review`` (human-review path when Quartet
    confidence is low). Either way the goal must leave ``verifying`` —
    that's the contract under test.
    """
    async with httpx.AsyncClient(timeout=30.0) as c:
        r = await c.post(f"{ORCH}/api/v1/goals", headers=HEADERS, json={
            "title": "nova-test-failure-respec",
            "description": "force verify failure to test recovery",
            "max_cost_usd": 10.0,
        })
        r.raise_for_status()
        gid = r.json()["id"]

        try:
            # Seed goal directly in 'verifying' with a guaranteed-failing command
            await c.patch(f"{ORCH}/api/v1/goals/{gid}", headers=HEADERS, json={
                "complexity": "simple",
                "spec": "test spec",
                "verification_commands": [{"cmd": "false", "timeout_s": 5}],
                "success_criteria_structured": [
                    {"statement": "false exits 0", "check": "command", "check_arg": "false"},
                ],
                "maturation_status": "verifying",
            })

            def reacted(g: dict) -> bool:
                # Either path is acceptable:
                #   (a) re-spec: retry_count bumped + back to scoping
                #   (b) human-review: maturation_status='review' (LLM-unavailable path)
                if g.get("retry_count", 0) >= 1 and g.get("maturation_status") == "scoping":
                    return True
                if g.get("maturation_status") == "review":
                    return True
                return False

            g = await _wait_for(c, gid, reacted)

            assert g is not None, "goal should be retrievable"
            ms = g.get("maturation_status")
            rc = g.get("retry_count", 0)
            assert ms != "verifying", (
                f"cortex should have moved goal off 'verifying' after a failure; "
                f"maturation_status={ms} retry_count={rc} goal={g}"
            )
            # If re-spec branch, retry_count must have been bumped.
            if ms == "scoping":
                assert rc >= 1, (
                    f"re-spec path requires retry_count >= 1; got rc={rc} goal={g}"
                )
            else:
                # human-review branch: 'review' is the only other valid landing.
                assert ms == "review", (
                    f"failure handler should land on 'scoping' (re-spec) or "
                    f"'review' (human-review/escalation); got {ms} goal={g}"
                )
        finally:
            await c.delete(f"{ORCH}/api/v1/goals/{gid}?cascade=true", headers=HEADERS)


@pytest.mark.slow
@pytest.mark.asyncio
async def test_retry_exhaustion_escalates():
    """Goal at max_retries with another failure → MUST escalate (no more retries
    available). With ``review_policy='cost-above-2'`` the escalation lands the
    goal in ``review``. This holds regardless of Quartet confidence — both the
    'fail' (retries-exhausted) and 'human-review' branches converge on
    ``maturation_status='review'``.
    """
    async with httpx.AsyncClient(timeout=30.0) as c:
        r = await c.post(f"{ORCH}/api/v1/goals", headers=HEADERS, json={
            "title": "nova-test-failure-escalate",
            "description": "force failure with retries already exhausted",
            "max_cost_usd": 10.0,
        })
        r.raise_for_status()
        gid = r.json()["id"]

        try:
            # Start at retry_count = max_retries so the next failure escalates
            await c.patch(f"{ORCH}/api/v1/goals/{gid}", headers=HEADERS, json={
                "complexity": "simple",
                "spec": "test spec",
                "verification_commands": [{"cmd": "false", "timeout_s": 5}],
                "success_criteria_structured": [
                    {"statement": "false exits 0", "check": "command", "check_arg": "false"},
                ],
                "max_retries": 2,
                "retry_count": 2,
                "review_policy": "cost-above-2",
                "maturation_status": "verifying",
            })

            g = await _wait_for(
                c, gid,
                lambda goal: goal.get("maturation_status") == "review",
            )

            assert g is not None
            assert g["maturation_status"] == "review", (
                f"after failure with retries exhausted, must land in 'review' "
                f"(escalated); got: maturation_status={g.get('maturation_status')} "
                f"retry_count={g.get('retry_count')} goal={g}"
            )
            # Sanity: retry_count should NOT have advanced past max_retries (no more retries)
            rc = g.get("retry_count", 0)
            mr = g.get("max_retries", 0)
            assert rc <= mr, (
                f"retry_count {rc} should not exceed max_retries {mr} "
                f"after escalation; goal={g}"
            )
        finally:
            await c.delete(f"{ORCH}/api/v1/goals/{gid}?cascade=true", headers=HEADERS)
