"""Runs approved recommendation actions. Durable, leader-gated, one at a time.

Mirrors `ingest_worker` / `ingest_jobs` deliberately — rows survive a restart,
`FOR UPDATE SKIP LOCKED` means two backends never claim one run, and orphans
left 'running' by a dead process are recovered at boot.

The one thing this adds over that pattern is the JOIN in `claim_next()`:

    WHERE r.status = 'queued'
      AND rec.status = 'approved' AND rec.decided_by = 'operator'

The operator's approval is a STANDING PRECONDITION of every claim, re-checked
against the live row at the moment work starts, rather than a fact trusted
once when the run was enqueued. Dismiss a card while its run is still queued
and the run never starts. The only writer of those two columns is
`recommendations.decide()`, which sits behind the authenticated operator API
and is not reachable by any agent.
"""

import asyncio
import json
import logging
from typing import Optional

from app import db, instances

log = logging.getLogger(__name__)

POLL_S = 3.0
MAX_ORPHANS = 2


async def claim_next() -> Optional[dict]:
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE action_runs
                 SET status = 'running', started_at = now(),
                     attempts = attempts + 1, updated_at = now()
               WHERE id = (
                   SELECT r0.id FROM action_runs r0
                     JOIN recommendations rec ON rec.id = r0.recommendation_id
                    WHERE (r0.status = 'queued'
                           -- ...or it asked him something and he answered.
                           -- Resumed by the SAME claim, so a blocked run
                           -- needs no second worker and no loop of its own,
                           -- and inherits the approval re-check below for
                           -- free: dismiss the card while it waits and it
                           -- never starts again.
                           OR (r0.status = 'blocked' AND r0.answer IS NOT NULL))
                      AND rec.status = 'approved'
                      AND rec.decided_by = 'operator'
                    ORDER BY r0.created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1)
               RETURNING *""")
    return dict(row) if row else None


async def append_step(run_id, name: str, status: str, detail: str = "") -> None:
    """Append to the run's receipt log. The card reads this live, so a step
    that lands here is a step the operator can see happening."""
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE action_runs SET steps = steps || $2::jsonb, "
            "updated_at = now() WHERE id = $1", run_id,
            json.dumps([{"step": name, "status": status, "detail": detail[:400]}]))


async def _finish(run_id, status: str, *, result: Optional[dict] = None,
                  error: str = "") -> None:
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE action_runs SET status = $2, result = $3, error = $4, "
            "finished_at = now(), updated_at = now() WHERE id = $1",
            run_id, status, json.dumps(result) if result else None,
            (error or "")[:2000] or None)


async def _block(run_id, conversation_id, key: str, text: str) -> None:
    """Park the run on a question and put that question in front of him.

    IN CHAT, by his instruction ("Questions, if any, that need clarification
    from me for nova, should be asked via chat"). Written as an assistant
    message in the conversation the card came from, so it arrives where he is
    already looking and the answer is a reply rather than a form.

    The row is written FIRST and the message second: a question he can see and
    cannot answer is recoverable, a run parked on a question nobody was ever
    shown is not.
    """
    from app import conversations, task_steps
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE action_runs SET status = 'blocked', question = $2::jsonb, "
            "answer = NULL, answered_at = NULL, updated_at = now() "
            "WHERE id = $1", run_id,
            json.dumps(task_steps.question_for(key, text)))
    log.info("Action run %s blocked on %r", run_id, key)
    if not conversation_id:
        return
    try:
        await conversations.append_message(
            str(conversation_id), "assistant", text, None,
            metadata={"action_run": str(run_id), "question_key": key})
    except Exception:
        log.exception("could not post the question for run %s", run_id)


def refusal(result) -> Optional[str]:
    """Why this result is a failure, or None if it is not one.

    One predicate, used by both executor shapes, because "did that work" must
    not be answered differently depending on whether the action declared
    `execute` or `steps`.
    """
    if isinstance(result, dict) and result.get("status") == "error":
        return str(result.get("detail") or "the executor reported an error")
    return None


def _receipt(detail) -> str:
    """The one line the operator reads for a step. A dict's `detail` field, not
    its repr — a receipt reading `{'status': 'error', 'session_id': ...}` is a
    debug dump, and he is the audience."""
    if isinstance(detail, dict):
        return str(detail.get("detail") or detail.get("status") or "")
    return str(detail or "")


async def _run_steps(spec, doc, rec_dict, run, step) -> dict:
    """Drive a step-based executor from its cursor. Returns the final result.

    Raises `NeedAnswer` outward — `_process` turns that into a blocked run,
    because only it knows the row and the conversation.
    """
    from app import db as _db
    from app.task_steps import StepContext

    run_id = run["id"]
    ctx = StepContext(answer=run.get("answer"), record=step, run_id=run_id,
                      conversation_id=(str(run["conversation_id"])
                                       if run.get("conversation_id") else None))
    q = run.get("question")
    q = json.loads(q) if isinstance(q, str) else q
    if q:
        ctx.scratch["answer_key"] = q.get("key")

    start = int(run.get("step_index") or 0)
    result: dict = {"status": "ok"}
    for i in range(start, len(spec.steps)):
        name, fn = spec.steps[i]
        detail = await fn(doc, rec_dict, ctx)
        # A STEP THAT SAYS IT FAILED IS A FAILURE. This line used to record
        # every step as "ok" whatever it returned, and `_process` then called
        # the whole run "succeeded" and notified him "installed" — so a build
        # loop that burned all three attempts without going green, and a
        # landing refused for a red sandbox verdict, both reached him as
        # success. It is the defect this repo keeps finding in itself: a
        # fallback that reads as success is worse than a crash.
        #
        # Returned dicts are the contract for a step's result, so the status
        # inside one is the step's own verdict and is believed over the mere
        # fact that it returned.
        failed = refusal(detail)
        await step(name, "error" if failed else "ok", _receipt(detail))
        if failed:
            # Cursor deliberately NOT advanced: a failed step is where this run
            # stopped, and a later reader deserves to see that rather than a
            # run that looks like it completed every step.
            return detail
        # Cursor AFTER the side effect, so a crash mid-step repeats that step
        # rather than skipping it. Steps are written to tolerate that; skipping
        # one silently is the failure that cannot be recovered from.
        async with _db.acquire() as conn:
            await conn.execute(
                "UPDATE action_runs SET step_index = $2, answer = NULL, "
                "question = NULL, updated_at = now() WHERE id = $1",
                run_id, i + 1)
        ctx.answer = None                 # spent; never satisfies a later ask
        ctx.scratch.pop("answer_key", None)
        if isinstance(detail, dict):
            result = detail
    return result


async def _process(run: dict) -> None:
    from app import actions, notify, recommendations, settings_store
    from app.task_steps import NeedAnswer

    run_id = run["id"]
    rec_id = run["recommendation_id"]
    raw = run["action"]
    raw = json.loads(raw) if isinstance(raw, str) else raw

    async def step(name, status, detail=""):
        await append_step(run_id, name, status, detail)

    try:
        # parsed AGAIN here, not trusted from enqueue time. The frozen copy in
        # action_runs.action is what the operator approved, and it still has
        # to typecheck before an executor is looked up.
        doc = actions.parse(raw)
        spec = actions._TYPES[doc.type]
        if spec.execute is None and not spec.steps:
            raise RuntimeError(f"no executor for {doc.type}")

        async with db.acquire() as conn:
            rec = await conn.fetchrow(
                "SELECT id, action_tools FROM recommendations WHERE id = $1", rec_id)
        tools = rec["action_tools"] if rec else None
        rec_dict = {"id": str(rec_id),
                    "action_tools": json.loads(tools) if isinstance(tools, str) else tools}

        # PER-ACTION where it declares one, because a single number cannot
        # be right for both "register an MCP server" (seconds) and "pull
        # 1.5GB, boot it, and run a suite" (tens of minutes). The operator's
        # setting still governs everything that does not declare.
        timeout = float(spec.timeout_s
                        or settings_store.get("actions.timeout_s")
                        or actions.DEFAULT_EXECUTE_TIMEOUT_S)
        if spec.steps:
            result = await asyncio.wait_for(
                _run_steps(spec, doc, rec_dict, run, step), timeout)
        else:
            result = await asyncio.wait_for(
                spec.execute(doc, rec_dict, step=step), timeout)
        # THE LAST PLACE A REFUSAL CAN BE TURNED INTO SUCCESS, and for a while
        # it was. Every other executor raises on failure; `code_change` returns
        # `{"status": "error"}`, which reached `_finish("succeeded")` and told
        # him "installed" for a landing the sandbox gate had just refused.
        #
        # Checked HERE rather than fixed only in that executor, because the
        # next one written will make the same choice and nothing would catch
        # it: the control has to live where the verdict is recorded.
        refused = refusal(result)
        if refused:
            raise RuntimeError(refused)
        await _finish(run_id, "succeeded", result=result)
        log.info("Action run %s succeeded: %s", run_id, doc.type)
        summary = "installed"
    except NeedAnswer as q:
        # NOT a failure and NOT the end. The run keeps its cursor and its
        # recommendation; it is waiting on a person, which is a state this
        # table did not have before phase 3.
        await step("asked", "ok", q.text[:400])
        await _block(run_id, run.get("conversation_id"), q.key, q.text)
        return                      # no receipt: nothing has finished yet
    except asyncio.TimeoutError:
        await step("timeout", "error", "the executor did not finish in time")
        await _finish(run_id, "failed", error="timed out")
        log.warning("Action run %s timed out", run_id)
        summary = "timed out"
    except Exception as e:                            # noqa: BLE001
        detail = str(e)
        await step("failed", "error", detail)
        await _finish(run_id, "failed", error=detail)
        log.warning("Action run %s failed: %s", run_id, detail)
        summary = f"failed — {detail}"

    # A failure the operator never learns about is the silent no-op this whole
    # lane exists to remove, so BOTH outcomes reach him and both reach her.
    try:
        async with db.acquire() as conn:
            title = await conn.fetchval(
                "SELECT title FROM recommendations WHERE id = $1", rec_id) or "a recommendation"
        await notify.send(f"{title}: {summary}"[:200],
                          title="Nova acted on your approval"[:90],
                          tags=["gear"], click="/chat?inbox=open")
        await recommendations.record_run_outcome(str(rec_id), summary)
    except Exception:
        log.exception("receipt for action run %s failed", run_id)


async def reset_orphans() -> dict:
    """Recover runs left 'running' when the process died.

    Requeued up to MAX_ORPHANS times, then parked as 'failed' and still
    operator-retryable. Unlike an ingest job these are NOT idempotent — a
    half-run that already created a server would hit the unique-name
    constraint on retry and fail cleanly, which is the safe direction: it
    refuses rather than registering a second copy.
    """
    async with db.acquire() as conn:
        async with conn.transaction():
            parked = await conn.execute(
                """UPDATE action_runs
                     SET status = 'failed',
                         error = 'interrupted ' || orphans::text ||
                                 '× by a restart before finishing — press Run again',
                         finished_at = now(), updated_at = now()
                   WHERE status = 'running' AND orphans >= $1""", MAX_ORPHANS)
            requeued = await conn.execute(
                """UPDATE action_runs
                     SET status = 'queued', started_at = NULL,
                         orphans = orphans + 1, updated_at = now()
                   WHERE status = 'running'""")
    out = {"requeued": _rowcount(requeued), "parked": _rowcount(parked)}
    if out["requeued"] or out["parked"]:
        log.info("action runs recovered at boot: %s", out)
    return out


def _rowcount(tag: str) -> int:
    try:
        return int(str(tag).rsplit(" ", 1)[-1])
    except ValueError:
        return 0


async def loop() -> None:
    """Leader-gated poll. Followers idle so an approval is executed once."""
    from app import settings_store
    while True:
        try:
            if instances.is_leader() and settings_store.get("actions.enabled") is not False:
                run = await claim_next()
                if run is not None:
                    await _process(run)
                    continue                     # drain rather than sleep
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("action worker tick failed")
        await asyncio.sleep(POLL_S)
