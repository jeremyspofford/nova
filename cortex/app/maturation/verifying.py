"""Verifying phase — multi-signal: commands + Quartet code-review + structured criteria.

Spec: docs/superpowers/specs/2026-04-28-cortex-goal-decomposition-design.md
"""
from __future__ import annotations

import asyncio
import json
import logging

from ..clients import get_orchestrator
from ..config import settings
from ..db import get_pool
from ..journal import emit_journal, emit_notification
from ..reflections import check_approach_blocked, record_reflection
from ..stimulus import GOAL_COMPLETED, SUBGOAL_TERMINATED, emit
from .aggregator import aggregate
from .commands import run_commands
from .criteria import evaluate_criteria

log = logging.getLogger(__name__)


async def run_verifying(goal_id: str) -> str:
    """Multi-signal verification. Returns a one-line outcome description."""
    goal = await _load_goal(goal_id)
    if not goal:
        return f"Verifying: goal {goal_id} not found"

    cmd_specs = _decode(goal["verification_commands"]) or []
    criteria = _decode(goal["success_criteria_structured"]) or []

    cmd_results = await run_commands(cmd_specs)
    quartet_review = await _quartet_verify(goal)
    criteria_eval = await evaluate_criteria(criteria, cmd_results, quartet_review)
    outcome = aggregate(cmd_results, quartet_review, criteria_eval)

    attempt = await _record_attempt(goal_id, cmd_results, quartet_review, criteria_eval, outcome)

    if outcome == "pass":
        await _mark_complete(goal_id)
        await emit_journal(goal_id, "verify.pass", {"attempt": attempt})
        await emit(GOAL_COMPLETED, "cortex", payload={"goal_id": goal_id})
        if goal["parent_goal_id"]:
            await _wake_parent(goal["parent_goal_id"])
            await emit(SUBGOAL_TERMINATED, "cortex",
                payload={"goal_id": goal_id,
                         "parent_goal_id": str(goal["parent_goal_id"]),
                         "outcome": "completed"})
        return f"Verification passed → completed (attempt {attempt})"

    if outcome == "fail":
        return await _on_verify_fail(goal_id, goal, attempt,
                                     cmd_results, quartet_review, criteria_eval)

    # human-review
    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE goals SET maturation_status = 'review', updated_at = NOW() WHERE id = $1::uuid",
            goal_id,
        )
        await conn.execute(
            """INSERT INTO comments (entity_type, entity_id, author_type, author_name, body)
               VALUES ('goal', $1::uuid, 'nova', 'cortex',
                       'Verification mixed — needs human review. See goal_verifications.')""",
            goal_id,
        )
    await emit_journal(goal_id, "verify.human_review", {"attempt": attempt})
    return f"Verification mixed → review queue (attempt {attempt})"


# ── Helpers ────────────────────────────────────────────────────────────────
async def _load_goal(goal_id: str):
    pool = get_pool()
    async with pool.acquire() as conn:
        return await conn.fetchrow(
            """SELECT id, title, description, spec, verification_commands,
                      success_criteria_structured, success_criteria,
                      retry_count, max_retries, review_policy, parent_goal_id,
                      cost_so_far_usd
               FROM goals WHERE id = $1::uuid""",
            goal_id,
        )


def _decode(raw):
    if raw is None:
        return None
    if isinstance(raw, (list, dict)):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None
    return None


def _first_failure_mode(cmd_results, quartet_review, criteria_eval) -> str | None:
    """Pick a short failure label for reflections.failure_mode (truncated to 200 chars by record_reflection)."""
    for r in cmd_results or []:
        if int(r.get("exit_code") or 0) != 0:
            return f"cmd_fail: {r.get('cmd', '')[:120]} exit={r.get('exit_code')}"
    qv = (quartet_review or {}).get("verdict")
    if qv and qv != "complete":
        return f"quartet_verdict: {qv}"
    for c in criteria_eval or []:
        if not c.get("pass"):
            return f"criterion_fail: {(c.get('statement') or '')[:120]}"
    return None


async def _quartet_verify(goal) -> dict:
    """Spawn a Quartet pipeline task whose Code Review agent verdicts the goal."""
    orch = get_orchestrator()
    prompt = (
        f"[Verification task — read the goal, then assess whether it appears completed.]\n"
        f"Goal: {goal['title']}\n"
        f"Description: {goal['description'] or '(none)'}\n"
        f"Spec excerpt: {(goal['spec'] or '')[:1500]}\n\n"
        f"Inspect the codebase. Render a verdict on whether this goal is complete. "
        f"Reply ONLY with JSON: "
        f'{{"verdict": "complete|partial|incomplete", "confidence": 0.0-1.0, "summary": "<one sentence>"}}'
    )
    try:
        r = await orch.post(
            "/api/v1/pipeline/tasks",
            json={"user_input": prompt, "goal_id": str(goal["id"]),
                  "metadata": {"source": "cortex.verifying", "kind": "verification"}},
            headers={"Authorization": f"Bearer {settings.cortex_api_key}"},
            timeout=300.0,
        )
        r.raise_for_status()
        task_id = r.json().get("task_id")
        # Poll for completion (verification task should be fast)
        for _ in range(90):  # up to 3 min
            await asyncio.sleep(2)
            tr = await orch.get(f"/api/v1/pipeline/tasks/{task_id}",
                                headers={"Authorization": f"Bearer {settings.cortex_api_key}"})
            if tr.status_code != 200:
                continue
            td = tr.json()
            if td.get("status") in ("complete", "failed", "cancelled"):
                result_text = td.get("result") or td.get("output") or "{}"
                try:
                    parsed = json.loads(result_text) if isinstance(result_text, str) else result_text
                except json.JSONDecodeError:
                    parsed = {"verdict": "incomplete", "confidence": 0.0, "summary": "non-JSON output"}
                parsed["task_id"] = task_id
                return parsed
        return {"verdict": "incomplete", "confidence": 0.0, "summary": "verification task timeout", "task_id": task_id}
    except Exception as e:
        log.warning("Quartet verify failed for goal %s: %s", goal["id"], e)
        return {"verdict": "incomplete", "confidence": 0.0, "summary": f"error: {e}"}


async def _record_attempt(goal_id, cmd_results, quartet_review, criteria_eval, outcome) -> int:
    pool = get_pool()
    async with pool.acquire() as conn:
        attempt_row = await conn.fetchrow(
            "SELECT COALESCE(MAX(attempt), 0) + 1 AS next FROM goal_verifications WHERE goal_id = $1::uuid",
            goal_id,
        )
        attempt = attempt_row["next"]
        await conn.execute(
            """INSERT INTO goal_verifications
                  (goal_id, attempt, cmd_results, quartet_review, criteria_eval, aggregate)
               VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6)""",
            goal_id, attempt,
            json.dumps(cmd_results), json.dumps(quartet_review), json.dumps(criteria_eval),
            outcome,
        )
    return attempt


async def _mark_complete(goal_id):
    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """UPDATE goals SET status = 'completed',
                                  maturation_status = NULL,
                                  progress = 1.0,
                                  updated_at = NOW()
               WHERE id = $1::uuid""",
            goal_id,
        )


async def _wake_parent(parent_goal_id) -> None:
    """Null parent's last_checked_at so the next cycle's stale-goal query picks it up
    immediately for re-check (e.g. _all_children_terminated for waiting parents)."""
    if not parent_goal_id:
        return
    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE goals SET last_checked_at = NULL WHERE id = $1::uuid",
            str(parent_goal_id),
        )


async def _on_verify_fail(goal_id, goal, attempt, cmd_results, quartet_review, criteria_eval):
    """Re-spec or escalate. Returns one-line outcome."""
    # Reflection.
    # record_reflection signature (cortex/app/reflections.py:31):
    #   (goal_id, cycle_number, approach, outcome, outcome_score,
    #    task_id=None, drive='serve', maturation_phase=None,
    #    lesson=None, failure_mode=None, context_snapshot=None)
    try:
        await record_reflection(
            goal_id=goal_id,
            cycle_number=0,  # 0 signals a verify-time reflection (not from a cortex cycle)
            approach=goal["spec"] or "(no spec)",
            outcome="verify_failed",
            outcome_score=0.2,
            maturation_phase="verifying",
            failure_mode=_first_failure_mode(cmd_results, quartet_review, criteria_eval),
            context_snapshot={
                "cmd_failures": [r for r in cmd_results if int(r.get("exit_code") or 0) != 0],
                "quartet": quartet_review,
                "criteria_failures": [c for c in criteria_eval if not c.get("pass")],
            },
        )
    except Exception as e:
        log.warning("record_reflection failed for goal %s: %s", goal_id, e)

    # Retry budget exhausted?
    if goal["retry_count"] >= goal["max_retries"]:
        return await _escalate(goal_id, goal, attempt, reason="retries_exhausted")

    # Approach blocked (already failed N times before)?
    try:
        is_blocked, _ = await check_approach_blocked(goal_id, goal["spec"] or "", "best")
        if is_blocked:
            return await _escalate(goal_id, goal, attempt, reason="approach_blocked")
    except Exception as e:
        log.debug("check_approach_blocked failed: %s", e)

    # Re-spec: bump retry_count, transition back to scoping
    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """UPDATE goals SET retry_count = retry_count + 1,
                                  maturation_status = 'scoping',
                                  updated_at = NOW()
               WHERE id = $1::uuid""",
            goal_id,
        )
    await emit_journal(goal_id, "verify.retry",
        {"attempt": attempt, "next_retry": goal["retry_count"] + 1})
    return f"Verification failed → re-spec (retry {goal['retry_count'] + 1}/{goal['max_retries']})"


async def _escalate(goal_id, goal, attempt, reason: str) -> str:
    """Escalate per goal.review_policy. Three branches: human / propagate / terminal."""
    policy = goal["review_policy"]
    pool = get_pool()

    if policy in ("all", "scopes-sensitive", "cost-above-2", "cost-above-5"):
        async with pool.acquire() as conn:
            await conn.execute(
                """UPDATE goals SET maturation_status = 'review', updated_at = NOW()
                   WHERE id = $1::uuid""",
                goal_id,
            )
            await conn.execute(
                """INSERT INTO comments (entity_type, entity_id, author_type, author_name, body)
                   VALUES ('goal', $1::uuid, 'nova', 'cortex',
                           'Goal stuck after ' || $2 || ' retries (' || $3 || '). '
                           || 'See goal_verifications. Approve a re-spec, edit spec, or abort.')""",
                goal_id, goal["max_retries"], reason,
            )
        await emit_notification(goal_id, "goal_stuck",
            title=f"Goal '{goal['title']}' stuck — needs review")
        await emit_journal(goal_id, "verify.escalate.human", {"reason": reason, "attempt": attempt})
        return f"Verification exhausted → escalated to human ({reason})"

    # policy = 'top-only' AND not top → propagate
    if goal["parent_goal_id"]:
        async with pool.acquire() as conn:
            await conn.execute(
                """UPDATE goals SET retry_count = retry_count + 1,
                                      maturation_status = 'scoping',
                                      updated_at = NOW()
                   WHERE id = $1::uuid""",
                goal["parent_goal_id"],
            )
            await conn.execute(
                """UPDATE goals SET status = 'failed', updated_at = NOW()
                   WHERE id = $1::uuid""",
                goal_id,
            )
        await _wake_parent(goal["parent_goal_id"])
        await emit(SUBGOAL_TERMINATED, "cortex",
            payload={"goal_id": goal_id,
                     "parent_goal_id": str(goal["parent_goal_id"]),
                     "outcome": "failed"})
        await emit_journal(goal_id, "verify.escalate.parent",
            {"reason": reason, "parent_goal_id": str(goal["parent_goal_id"])})
        return f"Verification exhausted → propagated to parent ({reason})"

    # Top-level + top-only + retries exhausted → terminal failure
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE goals SET status = 'failed', updated_at = NOW() WHERE id = $1::uuid",
            goal_id,
        )
    await emit_journal(goal_id, "verify.fail.terminal", {"reason": reason})
    return "Verification exhausted → goal failed (autonomous policy)"
