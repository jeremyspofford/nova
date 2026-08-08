"""Approve puts her code on a branch in his repo. Never on main.

Phase 4 of the autonomy lane, and the reason it exists is a sentence Jeremy
said on 2026-08-05, looking at a Settings panel I had written by hand:

    "That's something else she's supposed to do, not you."

He was right, and the reason I had written it was this: `delegate_coding_task`
produces a branch and a diff inside a private volume, and nothing could bring
them back. Her code had nowhere to go, so a human retyped it against the real
repo — which is the capability gap papered over by a person, exactly the
failure he had named an hour earlier.

THE CHAIN, AND WHERE EACH LINK REFUSES

    delegate_coding_task   writes code in a private clone; no host mount,
                           no docker socket, no database, one credential
    coder.patch()          the broker hands out `git format-patch` TEXT
    this executor          fetches it at execute time, never from the card
    git-landing            the only container with repo write access:
                           refuses `main`, refuses a branch that is not
                           `nova/<slug>`, refuses a dirty worktree, cannot
                           push, and aborts a conflicting patch to nothing

The card the operator approves names a SESSION, not a diff. That ordering is
deliberate: a document carrying patch text could be approved for one change
and executed with another, and the whole point of `actions/schemas.py` is
that the dangerous shape is unrepresentable rather than validated.

WHAT THIS DELIBERATELY DOES NOT DO

Merge. The work lands on `nova/<slug>` and his working copy is returned to
the branch it was on. There is no field in `CodeChangeLand` that could ask
for a merge and no code here that could perform one — a loop that could merge
its own code into `main` has no point at which a person disagrees with it.
"""

from __future__ import annotations

import logging

from app import capability_events as ce
from app.actions.schemas import CodeChangeLand

log = logging.getLogger(__name__)


def describe(doc: CodeChangeLand) -> str:
    return "\n".join([
        "Land a coding session's work on a branch",
        f"    Session     {doc.session_id}",
        f"    Branch      nova/{doc.branch}  (created off your current HEAD)",
        f"    Why         {doc.why}",
        "    Merging     NOT done — your working copy stays where it is. "
        "Review with `git diff <your branch>..nova/" + doc.branch + "` and "
        "merge if you want it.",
        "    Refused     if the repository has uncommitted changes, or if the "
        "patch does not apply cleanly (it aborts and leaves nothing behind).",
    ])


async def preflight(doc: CodeChangeLand, *, operator: bool = False
                    ) -> tuple[str, str, None]:
    """Is there something to land, and can it land right now?

    Both halves are things a model can be confidently wrong about: whether the
    session actually produced a commit, and whether the operator's repo is in
    a state that accepts one. Answering the second BEFORE he approves is the
    difference between a card that works and a card that fails on click.
    """
    from app import coder

    got = await coder.patch(doc.session_id)
    if got.get("status") != "ok":
        return ("blocked", str(got.get("detail") or "no patch available"), None)

    st = await coder.repo_status()
    if st.get("error"):
        return ("blocked", f"cannot read the repository: {st['error']}", None)
    if st.get("dirty"):
        return ("blocked",
                ("your repository has uncommitted changes — landing on top of "
                 "them would mix this change with yours. Commit or stash "
                 "first, then re-check this card."), None)
    if f"nova/{doc.branch}" in (st.get("nova_branches") or []):
        return ("blocked",
                f"branch nova/{doc.branch} already exists — give this one a "
                f"different name, or delete that branch first", None)

    # ONLY A GREEN SANDBOX MAY LAND. `docs/plans/sandbox-instance.md` phase 3,
    # and the clause the whole document exists for: it turns "she wrote some
    # code" into "she wrote code that demonstrably boots".
    #
    # The gate existed for several commits and enforced nothing — a card could
    # be raised, approved and executed for a branch that had never been built,
    # never booted and never run a test. That is the shape of every control
    # this codebase has had to replace: a good capability that nothing
    # required anyone to use.
    #
    # NEVER-CHECKED IS TREATED EXACTLY LIKE FAILED. The alternative — letting
    # an unchecked branch through because there is no bad news about it — is
    # how a gate becomes a formality.
    verdict = await coder.sandbox_verdict(doc.session_id)
    state = verdict.get("state")
    if state != "ok":
        why = {
            "never": ("this work has not been through the sandbox yet. Run "
                      "the boot gate on it first — it builds the branch, "
                      "starts it against its own database, and runs the "
                      "suite."),
            "stale": (f"the sandbox verdict is out of date — "
                      f"{verdict.get('detail')}. The session has been re-run "
                      f"since it passed, so what was verified is not what "
                      f"would land."),
            "failed": f"the sandbox check failed — {verdict.get('detail')}",
        }.get(state, f"no usable sandbox verdict ({state})")
        return ("blocked", why, None)

    # ...AND A SECOND MODEL HAS READ IT. Step 11. The sandbox answers "does
    # it work"; nothing before this answered "does it do what was asked", and
    # a change can be green on every gate while implementing the wrong thing.
    #
    # NEVER-REVIEWED IS TREATED LIKE CONCERNS, for the reason never-checked is
    # treated like failed: letting an unread change through because there is
    # no bad news about it is how a gate becomes a formality.
    rev = await coder.review_verdict(doc.session_id)
    r_state = rev.get("state")
    if r_state != "pass":
        why = {
            "never": ("no second model has read this yet. Run the review — it "
                      "is given the task and the diff and asked whether one "
                      "implements the other."),
            "stale": (f"the review is out of date — {rev.get('detail')}. What "
                      f"was read is not what would land."),
            "concerns": (f"the reviewer raised concerns "
                         f"({rev.get('model')}):\n{rev.get('detail')}"),
        }.get(r_state, f"no usable review ({r_state})")
        return ("blocked", why, None)

    stat = (got.get("diffstat") or "").strip().splitlines()
    summary = stat[-1].strip() if stat else "changes"

    # WHAT THIS CHANGE TOUCHES, computed from the diff rather than described
    # by whoever wrote it (ROADMAP #47 rail 1, `app/tripwire.py`).
    #
    # It does NOT block here, and the distinction is the whole point: this
    # card exists because Jeremy is about to read it, and a change he has
    # read may touch anything. The tripwire is what will stand in for that
    # reading when the autonomous lane lands, so the same function that will
    # refuse then is the one annotating now — one definition, exercised on
    # every landing long before it is load-bearing.
    from app import tripwire
    note = ""
    try:
        hits = tripwire.protected_hits(got.get("patch") or "")
        if hits:
            note = ("\n\nHeads up — this touches code that enforces the "
                    "boundaries: " + ", ".join(hits[:6])
                    + (f" (+{len(hits) - 6} more)" if len(hits) > 6 else "")
                    + ". Worth reading closely; the autonomous lane will not "
                      "land changes like this without you.")
    except tripwire.UnreadablePatch as e:
        # Say so rather than staying quiet: a patch whose paths cannot be
        # read is not a patch with no notable paths.
        note = (f"\n\nNote: the changed-file list could not be read from this "
                f"patch ({e}), so it has not been checked against the "
                f"protected paths.")

    # AND WHETHER IT GOT WORSE AT BEING NOVA (ROADMAP #47 rail 2). Reported,
    # not enforced, on the same reasoning as the tripwire note above: this
    # card exists because he is about to read the change, and an environmental
    # `unmeasured` must not block work he has judged. The autonomous lane
    # refuses on anything but `ok`, which is where never-checked has to be
    # treated like failed — there, nobody is reading.
    evd = await coder.eval_verdict(doc.session_id)
    if evd.get("state") == "below":
        note += (f"\n\nThe eval floor did NOT hold: {evd.get('detail')}. This "
                 f"change is measurably worse on a suite that had a floor — "
                 f"worth understanding before you land it.")
    elif evd.get("state") != "ok":
        note += (f"\n\nEval floor: {evd.get('state')} — "
                 f"{str(evd.get('detail') or '')[:300]}")

    return ("ready",
            (f"sandbox green, reviewed by {rev.get('model')}; ready to land on "
             f"nova/{doc.branch} off {st.get('branch')} ({st.get('head')}): "
             f"{summary}{note}"), None)


async def execute(doc: CodeChangeLand, rec: dict, *, step) -> dict:
    """Fetch the patch and hand it to the sidecar. One shot, no steps.

    Genuinely a single call, unlike the Home Assistant deploy — there is
    nothing to wait for and nothing to ask. `git-landing` either applies the
    whole patch or leaves the repository exactly as it found it, so there is
    no partial state a cursor could resume from.
    """
    from app import coder

    # RE-CHECKED AT EXECUTE TIME, not trusted from the preflight. The
    # operator's approval is a standing precondition the worker re-reads at
    # claim time (see `action_worker.claim_next`), and the sandbox verdict is
    # the same kind of fact: a session re-run between the card being read and
    # the run being claimed would otherwise land code nothing had checked.
    verdict = await coder.sandbox_verdict(doc.session_id)
    if verdict.get("state") != "ok":
        detail = (f"refused: the sandbox verdict is "
                  f"{verdict.get('state')} — {verdict.get('detail')}")
        await step("sandbox", "error", detail[:300])
        return {"status": "error", "detail": detail}
    await step("sandbox", "ok", str(verdict.get("detail"))[:200])

    rev = await coder.review_verdict(doc.session_id)
    if rev.get("state") != "pass":
        detail = (f"refused: the review is {rev.get('state')} — "
                  f"{str(rev.get('detail'))[:400]}")
        await step("review", "error", detail[:300])
        return {"status": "error", "detail": detail}
    await step("review", "ok", f"passed by {rev.get('model')}")

    got = await coder.patch(doc.session_id)
    if got.get("status") != "ok":
        await step("fetch", "error", str(got.get("detail"))[:200])
        return {"status": "error", "detail": str(got.get("detail"))}
    await step("fetch", "ok",
               f"{len(got['patch'])} bytes from session {doc.session_id[:8]}")

    branch = f"nova/{doc.branch}"
    out = await coder.land(got["patch"], branch)
    if out.get("status") != "ok":
        await step("land", "error", str(out.get("detail"))[:300])
        return {"status": "error", "detail": str(out.get("detail"))}

    files = out.get("files") or []
    await step("land", "ok",
               f"{out.get('commit')} on {branch} — {len(files)} file(s)")
    ce.record(ce.WORKLOAD, branch, "code_landed", actor="agent",
              detail={"session": doc.session_id, "files": files[:20],
                      "recommendation": str(rec.get("id") or "")})
    return {"status": "ok", "branch": branch, "commit": out.get("commit"),
            "files": files,
            "detail": (f"Landed on {branch} ({out.get('commit')}). Your "
                       f"working copy is still on {out.get('returned_to')} — "
                       f"review with `git diff {out.get('returned_to')}.."
                       f"{branch}` and merge if you want it.")}


# ── step 5: write it, check it, try again ────────────────────────────────────
#
# Jeremy's flow, step 5: "loop 3 & 4 until completed the task". Until now
# `delegate_coding_task` ran ONCE — no iteration, and no stopping condition
# either, which is the more dangerous half. A loop with neither is a loop that
# runs all night.
#
# WHAT MAKES A PASS SUCCEED is the sandbox boot gate, not the coding agent's
# own account of itself. The agent reporting "done" means it stopped, which is
# the same silent no-op that made an earlier session finish with no commit and
# look exactly like success. Green means built, booted and suite-passed.

#: Wall clock for the WHOLE loop, not per attempt. Three attempts of a coding
#: agent plus three sandbox runs is the shape being bounded, and bounding each
#: piece separately lets the total drift past anything anyone intended.
_LOOP_BUDGET_S = 5400.0
#: How long one coding session may run before the loop stops waiting on it.
_SESSION_WAIT_S = 1800.0
_POLL_S = 15.0


async def _await_session(session_id: str, ctx, deadline: float) -> dict:
    """Poll one coding session to a terminal state, or give up honestly."""
    import asyncio
    import time
    from app import coder
    while time.monotonic() < deadline:
        r = await coder.refresh(session_id)
        if r.get("state") in ("done", "failed", "killed"):
            return r
        await asyncio.sleep(_POLL_S)
    return {"state": "timeout",
            "error": f"still running after {int(_SESSION_WAIT_S)}s"}


#: How much of one failure's text reaches the next attempt. Twelve lines of
#: pytest output name the failing tests, which is the actionable part.
_FAILURE_CHARS = 1200


def retry_task(task: str, history: list[str], resume_from: str | None) -> str:
    """The instruction attempt N+1 is given. A pure function so it is testable.

    THREE THINGS THE FIRST VERSION GOT WRONG, all of which made the retry
    weaker than the first try rather than stronger:

    1. It described a checkout the agent was not in. Every attempt clones the
       trunk fresh, so "a previous attempt was rejected, fix this" arrived with
       a quoted test failure the agent could not reproduce — the failing change
       was not in its tree. A false premise is worse than a repetition. The
       fix is `continue_from` in the broker; this text now states which of the
       two situations the agent is actually in, and never guesses.
    2. It kept only the LAST failure, because it rebuilt from `doc.task` each
       pass. Attempt 3 could therefore undo attempt 1's fix and rediscover
       attempt 1's failure, forever.
    3. The no-commit path replaced the text entirely, throwing away any sandbox
       failure an earlier attempt had found.

    All three are the same mistake: treating a retry as a re-roll rather than
    as the next step of one piece of work.
    """
    if not history:
        return task
    log = "\n".join(f"  attempt {i}: {t}" for i, t in enumerate(history, 1))
    if resume_from:
        where = (
            "YOUR CHECKOUT ALREADY CONTAINS THE PREVIOUS ATTEMPT'S WORK. It is "
            "committed on this branch — this is a continuation, not a fresh "
            "start. Reproduce the failure yourself first (run the check that "
            "failed), then fix it. Do not rewrite from scratch, and do not "
            "assume the previous attempt was wrong about everything.")
    else:
        where = (
            "NO PREVIOUS ATTEMPT LEFT ANY CODE — you are starting from a clean "
            "checkout of the trunk. Confirm the files you intend to change "
            "actually exist here before editing, and if the task looks "
            "already-done, say so explicitly rather than exiting silently.")
    return (f"{task}\n\n"
            f"--- THIS IS ATTEMPT {len(history) + 1} ---\n"
            f"What has already been tried, and how each pass ended:\n{log}\n\n"
            f"{where}")


# ── a billing wall is not a flaky failure ────────────────────────────────────
#
# MEASURED 2026-08-07. Four unattended passes, twelve coding sessions, four
# goal actions and four `action_runs`, every one of them ending in the same
# reply from the provider:
#
#   {"code": -32603, "message": "Internal error: API Error: 402 This request
#    requires more credits, or fewer max_tokens. You requested up to 32000
#    tokens, but can only afford 15846."}
#
# The loop treated it exactly as it treats a failing test: hand the failure to
# the next attempt and try again. But a failing test is a fact about the code
# and a 402 is a fact about the account — the second one cannot be argued with
# by writing better code, and every retry was the same call with a later
# timestamp. Jeremy saw "the self improvement pass failed" and nothing else.
#
# WHAT REFUSES NOW, in order:
#   1. `provider_errors.classify` reads the status out of the JSON-RPC
#      envelope and says whether a retry is capable of succeeding.
#   2. A terminal fault ABORTS the pass at that attempt — no second, no third.
#   3. The goal action is given back and no build entry is written, because
#      nothing ran; `spend.KIND_REFUSED` records the wall instead, which is
#      what stops the NEXT pass from walking into it an hour later.
#   4. The one adaptation the provider licensed — it stated the affordable
#      budget — is taken at most once, and only if the sidecar can actually
#      apply it.


async def _record_wall(budget: str, doc, fault, *, attempt: int, run_id,
                       session_id=None, usage=None, model="") -> bool:
    """Write the refusal to the ledger — as a refusal, never as a build.

    `spend.KIND_REFUSED` is deliberately not `KIND_BUILD`: the pass and
    attempt counts the operator's ceiling is written in both filter on builds,
    so a wall cannot spend a day's budget. The row still exists, because
    `spend.may_start` reads it to stop the NEXT pass from walking into the
    same wall an hour later — which is precisely what happened four times.

    `usage` carries whatever the session reported BEFORE the wall stopped it.
    A refusal spends no pass, but a session that worked for ten minutes and
    then hit a 402 spent real tokens, and the day's token/dollar totals must
    include them — this is the only ledger row that pass gets.

    Returns whether the row was actually written. THAT RETURN IS LOAD-BEARING:
    the cooldown that stops the next pass is this row and nothing else, so a
    swallowed insert failure would silently re-arm the exact four-passes-into
    -a-wall loop this function exists to end. `spend.record` catches its own
    errors and returns `{"error": ...}`; ignoring that is the "a step that
    cannot verify its own result must FAIL and say why" rule, so the caller is
    told and says so to the operator.
    """
    from app import spend
    result = await spend.record(
        budget, spend.KIND_REFUSED, usage=usage,
        usd=(usage or {}).get("usd"), model=model,
        session_id=session_id, run_id=run_id,
        goal_id=str(doc.goal_id) if doc.goal_id else None,
        # The wall KIND is what lets `spend.active_wall` count consecutive
        # hits of the SAME problem and double the wait, instead of the flat
        # hour that expired before every ~90-minute tick.
        detail={"wall": spend.WALL_PROVIDER,
                "attempt": attempt, "reason": fault.reason,
                "status": fault.status,
                "operator_note": fault.operator_note()})
    persisted = bool(result.get("id"))
    if not persisted:
        log.error("the provider-wall cooldown did NOT arm — the refusal row "
                  "could not be written (%s); the next pass is not protected "
                  "from this wall", result.get("error"))
    return persisted


async def _stop_on_wall(doc, rec, ctx, fault, attempt: int, history: list,
                        *, lane: str, run_id, work_done: bool,
                        extra: str = "", cooldown_armed: bool = True) -> dict:
    """End the pass on a provider wall, and hand the budget back.

    The refund is NARROW and stated rather than assumed: it happens only when
    no attempt in this pass produced a commit, because a pass that did real
    work before the key ran out has spent its action on work. Its outcome is
    reported either way — a refund nobody can see is the same as no refund.

    `cooldown_armed` is False when the refusal row could not be written, which
    is the ONLY thing stopping the next heartbeat tick from walking into the
    same wall five minutes from now. That is exactly what the operator must be
    told, because the system cannot protect him from it — a silent failure of
    the guard would reproduce the measured four-passes-into-a-wall loop with
    nothing on screen explaining why.
    """
    from app import goals

    note = fault.operator_note()
    unguarded = ("" if cooldown_armed else
                 " NOTE: I could not record this refusal, so the cooldown that "
                 "normally stops the next pass did not arm — it may retry this "
                 "same wall until you fix the key.")
    refund = ""
    if lane == "goal" and doc.goal_id and not work_done:
        got = await goals.refund_action(
            str(doc.goal_id), run_id=run_id,
            reason=f"provider {fault.reason} refusal: {fault.detail}"[:500])
        refund = (" Your goal got the action back — nothing was built with it."
                  if got.get("refunded")
                  else f" The goal action could NOT be given back: "
                       f"{got.get('detail')}.")
    elif lane == "goal" and work_done:
        refund = (" The goal action stands: earlier attempts in this pass did "
                  "produce work.")

    tried = (" What was tried first: " + " | ".join(history)) if history else ""
    await ctx.record("provider-wall", "error", (note + unguarded)[:400])
    return {"status": "error",
            "detail": (f"stopped on attempt {attempt} — {note}{extra}{refund}"
                       f"{unguarded}{tried}")}


def _lane(rec) -> str:
    """Which authority started this run: 'operator' or 'goal'.

    Read from the claimed `action_runs` row by `action_worker._process` and
    handed down. Defaults to `operator` when absent — the safe direction, and
    the one every caller that predates the lane column gets.
    """
    return str((rec or {}).get("lane") or "operator")


def _run_id(rec, ctx) -> str | None:
    """Which `action_runs` row this is — the ledger's idea of one PASS.

    Read off the claimed row (`action_worker._process` puts it there), with
    the step context as the fallback for the same value. Never invented: a
    pass id an executor made up would group nothing, and `spend.today` counts
    an entry with no run as a pass of its own rather than folding it into
    somebody else's.
    """
    got = (rec or {}).get("run_id") or getattr(ctx, "run_id", None)
    return str(got) if got else None


async def _step_build(doc, rec, ctx) -> dict:
    """Write, check, and try again — bounded on both axes.

    Each pass hands the next attempt the tree it produced AND every failure so
    far, because a retry that starts over is a second roll of the dice. The
    sandbox's failing stage and its summary are the most useful thing anyone
    could tell a coding agent, and they are facts rather than an opinion about
    the code.
    """
    import time
    from app import coder, provider_errors, spend

    lane = _lane(rec)
    #: Which budget this run's costs are charged to. The improvement ceiling
    #: must not be spent by a build the OPERATOR asked for — a loop he can
    #: starve by pressing a button is a control measuring the wrong thing.
    budget = spend.LANE_IMPROVE if lane == "goal" else "operator"
    #: WHICH PASS THIS IS, for the ledger. One `action_runs` row is one pass;
    #: the loop below writes a ledger entry per ATTEMPT, so without this every
    #: retry looked like a separate pass and a three-attempt pass spent three
    #: of the operator's four.
    run_id = _run_id(rec, ctx)

    started = time.monotonic()
    deadline = started + _LOOP_BUDGET_S
    history: list[str] = []
    #: The last session that actually produced a commit. The next attempt
    #: clones ITS directory, so the code under discussion is really there.
    #: Unchanged by an attempt that produced nothing — there is no work in a
    #: session that wrote no file, and resuming from it would only reset the
    #: base to the trunk without saying so.
    resume_from: str | None = None
    #: Did ANY attempt in this pass produce a commit? The refund below turns on
    #: it: an action spent on work stays spent.
    work_done = False
    #: A completion budget the PROVIDER stated, in its own 402. Zero until it
    #: does, and never a guess — see `provider_errors.token_budget`.
    capped_tokens = 0
    #: …and taken at most once. One adaptation licensed by the provider's own
    #: number is not "retrying a wall"; two of them is a loop.
    adapted = False

    for attempt in range(1, doc.attempts + 1):
        if time.monotonic() > deadline:
            return {"status": "error",
                    "detail": (f"stopped after {attempt - 1} attempt(s): the "
                               f"{int(_LOOP_BUDGET_S / 60)}-minute budget for "
                               f"this build is spent. What was tried: "
                               + " | ".join(history))}

        # THE MONEY CEILING, RE-CHECKED PER ATTEMPT (rail 3). The trigger
        # cleared one pass; an attempt is another coding agent, another image
        # build and another prod-sized import, so a three-attempt pass can
        # cross a ceiling that was fine when it started. Checked here rather
        # than only at the trigger because this is where the cost is incurred.
        #
        # Only for the goal lane: the operator asking for a build is the
        # operator deciding to spend, and this ceiling exists to bound what
        # happens while he is not looking.
        #
        # `exclude_run` leaves THIS pass out of the pass count and nothing
        # else: the pass ceiling already cleared it once at the trigger, and
        # counting it against itself would make the fourth pass of the day
        # refuse its own second attempt. Its tokens and dollars still count.
        if lane == "goal":
            allowed, why = await spend.may_start(budget, exclude_run=run_id)
            if not allowed:
                return {"status": "error",
                        "detail": (f"stopped after {attempt - 1} attempt(s) — "
                                   f"{why}")}

        started_r = await coder.start(
            doc.workspace, retry_task(doc.task, history, resume_from),
            requested_by="code_change.build", continue_from=resume_from,
            goal_id=str(doc.goal_id) if doc.goal_id else None,
            max_tokens=capped_tokens)
        if started_r.get("status") == "error":
            # A refusal can also arrive here — the sidecar answers 402 itself
            # when the key is dead before a session is ever created. Same
            # question, same answer: nothing ran, so nothing is charged.
            fault = provider_errors.classify(started_r.get("detail"))
            if fault.terminal:
                armed = await _record_wall(budget, doc, fault, attempt=attempt,
                                           run_id=run_id)
                return await _stop_on_wall(doc, rec, ctx, fault, attempt,
                                           history, lane=lane, run_id=run_id,
                                           work_done=work_done,
                                           cooldown_armed=armed)
            return {"status": "error",
                    "detail": f"attempt {attempt} could not start: "
                              f"{started_r.get('detail')}"}
        sid = started_r["session_id"]
        await ctx.record(
            f"attempt-{attempt}", "ok",
            f"session {sid[:8]} started"
            + (f", resuming {resume_from[:8]}" if resume_from else ""))

        r = await _await_session(sid, ctx, min(deadline,
                                               time.monotonic() + _SESSION_WAIT_S))
        # IS THIS A WALL OR IS IT WEATHER? Asked BEFORE the ledger entry,
        # because the two answers are charged differently: a coding session
        # that ran and failed cost tokens and is a build; a provider refusing
        # the credential ran nothing and must not spend a pass.
        fault = provider_errors.classify(r.get("error"))
        if fault.terminal:
            armed = await _record_wall(budget, doc, fault, attempt=attempt,
                                       run_id=run_id, session_id=sid,
                                       usage=r.get("usage"),
                                       model=str(r.get("model") or ""))
            await ctx.record(f"attempt-{attempt}", "error",
                             fault.operator_note()[:400])

            # THE ONE ADAPTATION THE PROVIDER ITSELF LICENSED. This 402 states
            # the budget the key can afford; retrying at THAT number is not
            # retrying the wall, it is doing what the provider asked. It is
            # refused unless the sidecar can really apply the cap — a cap it
            # ignores would produce the identical failed call while reporting
            # that something was adjusted.
            if fault.adaptable and not adapted:
                supported = await coder.broker_supports("max_tokens")
                if supported is True:
                    adapted = True
                    capped_tokens = fault.affordable_tokens
                    note = (f"the provider refused {fault.requested_tokens:,} "
                            f"tokens and stated {capped_tokens:,} affordable; "
                            f"retrying once at that budget")
                    history.append(note)
                    await ctx.record(f"attempt-{attempt}", "ok", note)
                    continue
                why = ("its schema could not be read"
                       if supported is None else
                       "its /session schema has no max_tokens field")
                extra = (
                    f" It said {fault.affordable_tokens:,} tokens are "
                    f"affordable, but the coder sidecar cannot be told a token "
                    f"cap ({why}), so retrying smaller was refused rather than "
                    f"guessed at.")
            else:
                extra = ""
            return await _stop_on_wall(doc, rec, ctx, fault, attempt, history,
                                       lane=lane, run_id=run_id,
                                       work_done=work_done, extra=extra,
                                       cooldown_armed=armed)

        # ONE LEDGER ENTRY PER ATTEMPT, whatever the attempt did. A failed
        # attempt cost the same tokens as a successful one, and a meter that
        # only counts successes measures the wrong thing.
        #
        # `run_id` is what makes those entries a PASS rather than three of
        # them. It is written here, not derived later: nothing downstream can
        # reconstruct which run a ledger row belonged to.
        #
        # `usage` is what `coder.refresh` persisted off the broker snapshot
        # (migration 130) — the sidecar aggregates its ACP usage frames now,
        # and `coder.snapshot_usage` digs them out of the tail for a sidecar
        # built before the aggregation. The `usage_from_updates` fallback
        # covers a refresh that could not persist. When all three come back
        # empty the entry is written UNMETERED with NULL counts rather than
        # zeros; see spend.py for why that distinction is the whole point.
        usage = r.get("usage") or spend.usage_from_updates(r.get("tail"))
        await spend.record(
            budget, spend.KIND_BUILD, usage=usage,
            usd=(usage or {}).get("usd"),
            model=str(r.get("model") or ""), session_id=sid,
            run_id=run_id,
            goal_id=str(doc.goal_id) if doc.goal_id else None,
            detail={"attempt": attempt, "state": r.get("state"),
                    "source": "session row" if r.get("usage")
                              else "acp tail" if usage else "not reported"})
        if r.get("state") != "done":
            note = f"session {r.get('state')} — {r.get('error')}"
            history.append(note)
            await ctx.record(f"attempt-{attempt}", "error", note[:300])
            continue
        if not r.get("commit"):
            # THE SILENT NO-OP. An agent that changes nothing reports `done`
            # and is indistinguishable from one that judged the work already
            # complete — it happened for real when the clone did not contain
            # the file being edited. A failed attempt, and `resume_from` stays
            # where it was: this session added nothing to resume from.
            note = "finished without changing anything"
            history.append(note)
            await ctx.record(f"attempt-{attempt}", "error", note)
            continue

        work_done = True
        await ctx.record(f"attempt-{attempt}", "ok",
                         f"committed {str(r.get('commit'))[:10]}; checking it")
        gate = await coder.sandbox_check(sid, lane=budget)
        if gate.get("status") == "ok":
            ctx.scratch["session_id"] = sid
            ev = (gate.get("eval") or {}).get("state") or "unmeasured"
            return {"status": "ok", "session_id": sid,
                    "commit": r.get("commit"), "attempts": attempt,
                    "eval": ev,
                    "detail": (f"green on attempt {attempt}: built, booted and "
                               f"the suite passed; eval floor {ev}. Session "
                               f"{sid} is ready to land — that is a separate "
                               f"decision.")}

        note = str(gate.get("detail") or gate.get("status"))[:_FAILURE_CHARS]
        history.append(note)
        await ctx.record(f"attempt-{attempt}", "error", note[:400])
        # HAND THE TREE AND THE FAILURE FORWARD. Both halves matter: the text
        # says what went wrong, and the tree is what makes that statement true
        # of the checkout the next agent opens.
        resume_from = sid

    return {"status": "error",
            "detail": (f"stopped after {doc.attempts} attempts, none green. "
                       f"What was tried: " + " | ".join(history))}


# ── the autonomous half: what stands in for him reading the diff ─────────────
#
# ROADMAP #47 rail 4 plus rail 1's teeth. Everything below runs ONLY for a run
# claimed through the goal lane. The operator's lane reaches this step and
# returns immediately, unchanged: his build produces a verified session and
# putting it in his repository stays the separate card it has always been.
#
# The asymmetry is the whole design. When he approves a landing he has read the
# diff, so it may touch anything. When nobody has read it, four mechanical
# facts stand in for that reading — a green sandbox on THIS commit, a different
# model's pass, the eval floor holding, and an empty tripwire — and any one of
# them missing turns the change into a card and stops.


async def _session_for(doc, ctx) -> str:
    """The session this run built, surviving a restart.

    `ctx.scratch` is per-process: a run that resumes at this step after a
    backend restart has an empty one, and reading a session id out of it would
    give None — landing nothing, silently, and reporting success. So the
    scratch is the fast path and the GOAL'S OWN SESSION LIST is the durable
    one, joined on `coding_sessions.goal_id` (migration 111) rather than
    inferred from timestamps.
    """
    sid = ctx.scratch.get("session_id")
    if sid:
        return str(sid)
    if not doc.goal_id:
        return ""
    from app import goals as _goals
    for s in await _goals.sessions_for(str(doc.goal_id)):
        if s.get("commit") and s.get("sandbox") == "ok":
            return s["session_id"]
    return ""


async def _card_instead(doc, session_id: str, why: str, ctx) -> dict:
    """Stop, and put the change in front of him as an ordinary landing card.

    NOT a failure. The change was built and verified; what is missing is a
    person's judgment, and the spec's line is exact: "A change touching these
    is not refused — it becomes a card and waits for Jeremy."

    The card carries a `code_change.land` plan naming the SESSION, so
    approving it runs the same operator-lane executor every other landing
    goes through. Nothing here writes a shortcut around his click.
    """
    from app import recommendations

    branch = f"improve-{session_id[:8]}"
    try:
        rec = await recommendations.create(
            "code_change",
            "A self-improvement change is waiting for you",
            f"{why}\n\nIt built, booted and passed the suite in the sandbox. "
            f"Approving lands it on nova/{branch}; nothing merges.",
            source="improvement",
            action={"type": "code_change.land", "session_id": session_id,
                    "branch": branch,
                    "why": why[:280]},
            dedupe_key=f"improve-land:{session_id}")
        await ctx.record("held", "ok", f"card {rec['id']}: {why}"[:400])
        return {"status": "ok", "session_id": session_id, "landed": False,
                "summary": "held for you — it needs your eyes",
                "detail": (f"held for you rather than landed — {why} "
                           f"The change is in your inbox as a landing card.")}
    except Exception as e:                                   # noqa: BLE001
        # THE CARD IS THE WHOLE POINT OF STOPPING. If it could not be raised,
        # the change is verified, unlanded and invisible — which is the silent
        # no-op this lane exists to remove. So this is an ERROR, and the run
        # says so.
        log.exception("could not raise the hold-for-operator card")
        return {"status": "error",
                "detail": (f"refused to land ({why}) and then could not raise "
                           f"the card that would have told you: {e}. Session "
                           f"{session_id} is verified and unlanded.")}


async def _step_verify_and_land(doc, rec, ctx) -> dict:
    """The goal lane's ending: prove it four ways, then land it on a branch."""
    from app import coder, spend, tripwire

    if _lane(rec) != "goal":
        # The operator's lane, verbatim as before: a build produces a session
        # and landing is a card he approves. This step must never grow a
        # behaviour here — that would be the autonomous path leaking into his.
        return {"status": "ok", "landed": False,
                "summary": "built and verified — landing is your next card",
                "detail": ("landing is a separate card you approve — nothing "
                           "was placed in your repository")}

    session_id = await _session_for(doc, ctx)
    if not session_id:
        return {"status": "error",
                "detail": ("this run cannot tell which coding session it "
                           "built — refusing to land anything rather than "
                           "guessing at one")}

    # 1. THE SANDBOX, re-read from the row rather than trusted from the step
    #    before it. Same reasoning as `execute`: a session re-run between the
    #    build finishing and this step starting would otherwise land code
    #    nothing had checked.
    sv = await coder.sandbox_verdict(session_id)
    if sv.get("state") != "ok":
        return {"status": "error",
                "detail": (f"refused: the sandbox verdict is "
                           f"{sv.get('state')} — {sv.get('detail')}")}
    await ctx.record("sandbox", "ok", str(sv.get("detail"))[:200])

    # 2. A DIFFERENT MODEL READS IT, and it happens BEFORE the eval check on
    #    purpose. Every refusal below hands the change to the operator as a
    #    `code_change.land` card, and that card's own preflight refuses an
    #    unreviewed session — so checking the floor first would produce a card
    #    he could look at and not approve. A gate whose refusal path builds a
    #    dead button is a gate that gets switched off.
    #
    #    Run here rather than waited for: nothing in the autonomous lane would
    #    ever ask for a review, so requiring a recorded one and never
    #    producing one would make this rail dead code.
    #
    #    `actions/` forbids an LLM client at any depth and that rule holds —
    #    the model runs inside `coder.review`, not here — and the rule's own
    #    reason ("approving a card must not run a model") is about the
    #    operator's CLICK. There is no click on this path.
    rv = await coder.review_verdict(session_id)
    if rv.get("state") != "pass":
        got = await coder.review(session_id)
        await spend.record(spend.LANE_IMPROVE, spend.KIND_REVIEW,
                           session_id=session_id, model=str(got.get("model") or ""),
                           run_id=_run_id(rec, ctx),
                           goal_id=str(doc.goal_id) if doc.goal_id else None,
                           detail={"status": got.get("status")})
        rv = await coder.review_verdict(session_id)
    if rv.get("state") != "pass":
        return await _card_instead(
            doc, session_id,
            (f"the reviewer did not pass it ({rv.get('state')}): "
             f"{str(rv.get('detail'))[:400]}"), ctx)
    await ctx.record("review", "ok", f"passed by {rv.get('model')}")

    # 3. THE EVAL FLOOR (rail 2). `unmeasured` is not a pass here, and this is
    #    the one place in the codebase where that distinction has teeth: the
    #    operator's landing card shows it as a note because he is reading the
    #    diff, and this lane refuses on it because nobody is.
    evd = await coder.eval_verdict(session_id)
    if evd.get("state") != "ok":
        return await _card_instead(
            doc, session_id,
            (f"the eval floor did not clear it (state {evd.get('state')}): "
             f"{evd.get('detail')}"), ctx)
    await ctx.record("eval-floor", "ok", str(evd.get("detail"))[:200])


    # 4. THE TRIPWIRE, AS A GATE RATHER THAN A NOTE (rail 1). Computed from
    #    the diff itself, never from what the coding agent said it changed —
    #    a model that has been argued into editing `consents.py` is exactly
    #    the model whose summary will not mention it. An unreadable patch is
    #    refused for the same reason: "no protected paths" and "I could not
    #    tell" must not reach this line as the same value.
    got = await coder.patch(session_id)
    if got.get("status") != "ok":
        return {"status": "error",
                "detail": f"cannot read the patch to land: {got.get('detail')}"}
    may, why = tripwire.may_land_unattended(got.get("patch") or "")
    if not may:
        return await _card_instead(doc, session_id, why, ctx)
    await ctx.record("tripwire", "ok", "no protected paths touched")

    branch = f"nova/improve-{session_id[:8]}"
    out = await coder.land(got["patch"], branch)
    if out.get("status") != "ok":
        await ctx.record("land", "error", str(out.get("detail"))[:300])
        return {"status": "error", "detail": str(out.get("detail"))}
    files = out.get("files") or []
    await ctx.record("land", "ok",
                     f"{out.get('commit')} on {branch} — {len(files)} file(s)")
    ce.record(ce.WORKLOAD, branch, "code_landed", actor="agent",
              detail={"session": session_id, "files": files[:20],
                      "goal": str(doc.goal_id or ""), "lane": "goal"})
    return {"status": "ok", "session_id": session_id, "landed": True,
            "summary": f"landed on {branch}",
            "branch": branch, "commit": out.get("commit"), "files": files,
            "detail": (f"Landed on {branch} ({out.get('commit')}) with nobody "
                       f"reading it: sandbox green, eval floor held, "
                       f"{rv.get('model')} reviewed it, no protected path "
                       f"touched. Nothing merged — review with `git diff "
                       f"{out.get('returned_to')}..{branch}`.")}


BUILD_STEPS = [("build", _step_build), ("verify-and-land", _step_verify_and_land)]


def describe_build(doc) -> str:
    return "\n".join([
        "Write a change, and keep going until the sandbox says it works",
        f"    Workspace   {doc.workspace}",
        f"    Attempts    up to {doc.attempts} "
        f"(each one is a coding agent, a built image, a booted stack and the "
        f"full suite)",
        f"    Budget      {int(_LOOP_BUDGET_S / 60)} minutes for the whole "
        f"loop, then it stops and reports what it tried",
        f"    Why         {doc.why}",
        # "Which goal is this for" is the first question about a build he did
        # not type himself. The ID here and the TITLE in preflight's detail
        # line, because `describe` is pure — it has the document and no
        # database, so it cannot resolve a name. Preflight can, does, and puts
        # it where he reads it: `for the goal "<title>"`.
        *([f"    Goal        {doc.goal_id}"] if doc.goal_id else []),
        "    Task        " + (doc.task[:300]
                              + ("…" if len(doc.task) > 300 else "")),
        "    Result      a VERIFIED session, not a branch. Putting it in your "
        "repository is a separate card you approve afterwards.",
        "    Green means built, booted and suite-passed — not the coding "
        "agent's own account of itself.",
    ])


async def preflight_build(doc, *, operator: bool = False
                          ) -> tuple[str, str, None]:
    """Can this even start? Cheapest questions first.

    Deliberately does NOT check the repository is clean: this produces a
    session, and nothing touches his repo until a separate landing card is
    approved. Requiring a clean tree here would block honest work for a reason
    that does not apply yet.
    """
    from app import coder

    if not coder.configured():
        return ("blocked",
                ("coding delegation is not configured — NOVA_CODER_TOKEN is "
                 "unset, so the sidecar refuses everything"), None)
    names = [w["name"] for w in await coder.list_workspaces()]
    if doc.workspace not in names:
        return ("blocked",
                f"no enabled workspace named {doc.workspace!r}. "
                f"Available: {', '.join(names) or '(none)'}", None)
    # A GOAL THAT DOES NOT EXIST IS NOT A LABEL, IT IS A FICTION. The id is
    # the model's to supply, so it is the model's to get wrong — and a card
    # saying "for goal <uuid>" that resolves to nothing is worse than a card
    # with no goal at all, because it reads as traceability.
    goal = None
    if doc.goal_id:
        from app import goals as _goals
        goal = await _goals.get(str(doc.goal_id))
        if not goal:
            return ("blocked",
                    f"no goal {doc.goal_id} — this build says it serves one "
                    f"that does not exist. Check Library → Goals.", None)

    st = await coder.repo_status()
    if st.get("error"):
        return ("blocked",
                f"the landing sidecar is unreachable ({st['error']}) — the "
                f"sandbox check stages its work through it, so nothing could "
                f"be verified", None)
    if goal:
        return ("ready",
                (f"ready: up to {doc.attempts} attempts against "
                 f"{doc.workspace} at {st.get('head')}, each verified by the "
                 f"boot gate — for the goal \"{goal['title']}\""), None)
    return ("ready",
            (f"ready: up to {doc.attempts} attempts against {doc.workspace} "
             f"at {st.get('head')}, each verified by the boot gate"), None)
