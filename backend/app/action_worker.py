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

TWO LANES, NOT ONE WIDENED ONE (ROADMAP #47 rail 4, migration 116). Jeremy
removed the approval click from the self-improvement loop on 2026-08-07. The
check above is NOT deleted; a second lane was added beside it, keyed on
`action_runs.lane`:

    lane='operator'  rec.decided_by = 'operator'      — a person read it
    lane='goal'      rec.decided_by = 'goal' AND the goal named by
                     `action_runs.goal_id` is STILL active and still carries
                     `improve_self`

Three things follow, and each is why it is two lanes rather than a looser
predicate. The operator's lane cannot be reached by anything the loop does.
The two are distinguishable in the audit trail forever, so "who authorised
this run" is a column rather than an inference. And revoking the goal —
closing it, pausing it, letting it expire — stops the loop at the next claim
without touching the code that runs approved work.

The goal is re-read at claim time for exactly the reason the operator's
approval is: an authority that was true when the run was enqueued is not
evidence that it is true now.
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
    from app import goals

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
                      AND (
                          -- LANE 1, unchanged and not widened: a person read
                          -- the card and pressed approve.
                          (r0.lane = 'operator'
                           AND rec.decided_by = 'operator')
                          -- LANE 2: a standing goal authorised it, and that
                          -- goal is still live RIGHT NOW. Closing, pausing or
                          -- letting it expire stops the loop here — the run
                          -- simply stops being claimable, which is why
                          -- revocation needs no code path of its own.
                          --
                          -- Deliberately NOT re-checking `actions_used <
                          -- max_actions`: the action was charged atomically
                          -- when the run was enqueued, so requiring headroom
                          -- again would strand the last action of every goal.
                          OR (r0.lane = 'goal'
                              AND rec.decided_by = 'goal'
                              AND EXISTS (
                                  SELECT 1 FROM goals g
                                   WHERE g.id = r0.goal_id
                                     AND g.status = 'active'
                                     AND $1 = ANY(g.approved_verbs)
                                     AND (g.expires_at IS NULL
                                          OR g.expires_at > now())))
                      )
                    ORDER BY r0.created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1)
               RETURNING *""", goals.IMPROVE_SELF)
    return dict(row) if row else None


def pass_dedupe_key(goal: dict, refunds: int) -> str:
    """The one dedupe key a charge's card may wear. Pure, so the arithmetic
    that stopped the collision is pinned by tests without a database.

    `actions_used + refunds` is the number of charges the goal has EVER made:
    spending increments the first term and a refund moves one unit from the
    first to the second, so the sum never repeats and never goes down. Keyed
    on `actions_used` alone it DID repeat — a pass that died on a provider
    wall handed its action back, the next tick's charge re-used the same
    number, and the key collided with the previous pass's already-decided
    card. See the comment at the call site for what that cost.
    """
    return (f"improve:{goal['id']}:"
            f"{int(goal.get('actions_used') or 0) + int(refunds or 0)}")


async def enqueue_goal_run(goal: dict, action: dict, *, title: str, body: str,
                           source: str) -> dict:
    """Create the card AND the run for one goal-authorised pass.

    THE ORDER IS THE CONTROL. The card is written first as an ordinary,
    undecided recommendation and its plan is preflighted exactly as the
    operator's would be. Only a plan that comes back `ready` is flipped to
    `approved by 'goal'` and given a run; anything else stays a NEW CARD and
    the operator finds it in his inbox. So the autonomous lane can only ever
    execute plans that passed the same check his do, and its failure mode is
    "he has something to look at", never "nothing happened".

    The caller must ALREADY have charged the goal (`goals.spend_standing`) and
    already have been cleared by `spend.may_start`. Both are deliberately not
    done here: this function's job is to be the only writer of a `lane='goal'`
    row, and a function that both authorises and enqueues is one an argument
    can talk into doing the second without the first.

    Returns `{"status": ..., "recommendation": id, "run": id|None, "detail"}`.
    """
    from app import actions, goals as _goals, recommendations

    # The door in, before anything is written: a plan that does not typecheck
    # must not become a card at all. `recommendations.create` calls this too;
    # doing it here as well means a malformed plan raises to the caller with
    # the field name rather than turning into a card that says "invalid".
    doc = actions.parse(action)

    # KEYED ON THE CHARGE, not on the plan and not on `actions_used` alone.
    # Three readings were wrong in turn: no key at all means the heartbeat
    # stacks a card every thirty minutes; a key derived from the action means
    # the SECOND pass under a goal collides with the first; and `actions_used`
    # alone stops being the pass number the moment a refund exists — a pass
    # that died on a provider wall handed its action back, the next tick's
    # charge re-used the same number, `create` returned the previous pass's
    # already-decided card, the status flip below found nothing 'new', and the
    # action charged moments earlier was burnt with nothing to show and no
    # refund (there is no run to make one idempotent). MEASURED 2026-08-08:
    # eight of the goal's twenty actions went that way in one night.
    #
    # `actions_used + refunds` counts charges EVER made, which never repeats —
    # see `pass_dedupe_key`. The heartbeat still cannot stack cards for one
    # pass: only a tick that charged reaches this function, and its busy check
    # refuses a second pass while one is in flight.
    async with db.acquire() as conn:
        refunds = await conn.fetchval(
            "SELECT count(*) FROM goal_action_refunds WHERE goal_id = $1::uuid",
            str(goal["id"]))
    rec = await recommendations.create(
        "code_change", title, body, source=source, action=action,
        dedupe_key=pass_dedupe_key(goal, refunds))
    rec_id = rec["id"]

    # PREFLIGHT SYNCHRONOUSLY AND WAIT FOR IT. `create` already spawned one in
    # the background; this second call is not redundant, it is the one whose
    # answer this function is allowed to read. Reading the row instead would
    # be racing a background task, and the losing side of that race is a run
    # enqueued against an unchecked plan.
    checked = await actions.preflight(rec_id)
    state = (checked or {}).get("action_state")
    detail = (checked or {}).get("action_detail") or ""
    if state != "ready":
        return {"status": "card", "recommendation": rec_id, "run": None,
                "detail": (f"the plan did not preflight ready ({state}) — it "
                           f"is in the inbox for you instead: {detail}"[:600])}

    async with db.acquire() as conn:
        async with conn.transaction():
            # THE GOAL, RE-ASSERTED IN THE SAME STATEMENT THAT APPROVES. The
            # caller charged it a moment ago; between then and now the
            # operator may have closed it, and a run enqueued under a revoked
            # goal would sit claimable-looking in his inbox forever.
            live = await conn.fetchval(
                "SELECT 1 FROM goals WHERE id = $1::uuid AND status = 'active' "
                "  AND $2 = ANY(approved_verbs) "
                "  AND (expires_at IS NULL OR expires_at > now())",
                str(goal["id"]), _goals.IMPROVE_SELF)
            if not live:
                return {"status": "card", "recommendation": rec_id, "run": None,
                        "detail": ("the goal stopped being live between "
                                   "charging it and enqueueing — the plan is "
                                   "an ordinary card in your inbox")}
            r = await conn.fetchrow(
                "UPDATE recommendations SET status = 'approved', "
                "  decided_at = now(), decided_by = 'goal' "
                " WHERE id = $1::uuid AND status = 'new' RETURNING id", rec_id)
            if r is None:
                # He got there first (approved, dismissed or snoozed it). His
                # decision wins; this lane does not overwrite one.
                return {"status": "card", "recommendation": rec_id,
                        "run": None,
                        "detail": "the card was already decided — left alone"}
            run = await conn.fetchrow(
                "INSERT INTO action_runs (recommendation_id, action, "
                "  action_type, lane, goal_id) "
                "VALUES ($1::uuid, $2::jsonb, $3, 'goal', $4::uuid) "
                "ON CONFLICT DO NOTHING RETURNING id",
                rec_id, json.dumps(action), doc.type, str(goal["id"]))
    if run is None:
        # The partial unique indexes refused it: either this card already has
        # a live run, or another improvement run is still in flight. Both are
        # the database saying "one at a time", which is what it is for.
        return {"status": "busy", "recommendation": rec_id, "run": None,
                "detail": ("another improvement run is already queued or "
                           "running — this pass was not started")}
    log.info("Goal-lane run %s enqueued for goal %s (%s)",
             run["id"], goal["id"], doc.type)
    return {"status": "queued", "recommendation": rec_id,
            "run": str(run["id"]), "detail": detail[:400]}


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
        # WHICH AUTHORITY STARTED THIS, handed to the executor. `code_change`
        # needs it and nothing else can supply it honestly: the tripwire
        # REFUSES an autonomous landing that touches the files enforcing the
        # boundaries, and lets an operator-approved one through because he
        # read the diff. Read off the claimed ROW rather than passed in by a
        # caller, so there is no argument an executor can be given that makes
        # a goal-lane run look like an operator-approved one.
        rec_dict = {"id": str(rec_id),
                    "lane": run.get("lane") or "operator",
                    "goal_id": (str(run["goal_id"])
                                if run.get("goal_id") else None),
                    "run_id": str(run_id),
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
        # "installed" was the only word this ever said, and it stopped being
        # true the moment a run could succeed by DECLINING to act — an
        # autonomous change held back for the operator finished cleanly and
        # told him it was installed. An executor that knows better says so in
        # `summary`; everything else keeps the old word.
        summary = str((result or {}).get("summary") or "installed") \
            if isinstance(result, dict) else "installed"
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
