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
    return ("ready",
            (f"sandbox green, reviewed by {rev.get('model')}; ready to land on "
             f"nova/{doc.branch} off {st.get('branch')} ({st.get('head')}): "
             f"{summary}"), None)


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


async def _step_build(doc, rec, ctx) -> dict:
    """Write, check, and try again — bounded on both axes.

    Each pass hands the next attempt the tree it produced AND every failure so
    far, because a retry that starts over is a second roll of the dice. The
    sandbox's failing stage and its summary are the most useful thing anyone
    could tell a coding agent, and they are facts rather than an opinion about
    the code.
    """
    import time
    from app import coder

    started = time.monotonic()
    deadline = started + _LOOP_BUDGET_S
    history: list[str] = []
    #: The last session that actually produced a commit. The next attempt
    #: clones ITS directory, so the code under discussion is really there.
    #: Unchanged by an attempt that produced nothing — there is no work in a
    #: session that wrote no file, and resuming from it would only reset the
    #: base to the trunk without saying so.
    resume_from: str | None = None

    for attempt in range(1, doc.attempts + 1):
        if time.monotonic() > deadline:
            return {"status": "error",
                    "detail": (f"stopped after {attempt - 1} attempt(s): the "
                               f"{int(_LOOP_BUDGET_S / 60)}-minute budget for "
                               f"this build is spent. What was tried: "
                               + " | ".join(history))}

        started_r = await coder.start(
            doc.workspace, retry_task(doc.task, history, resume_from),
            requested_by="code_change.build", continue_from=resume_from)
        if started_r.get("status") == "error":
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

        await ctx.record(f"attempt-{attempt}", "ok",
                         f"committed {str(r.get('commit'))[:10]}; checking it")
        gate = await coder.sandbox_check(sid)
        if gate.get("status") == "ok":
            ctx.scratch["session_id"] = sid
            return {"status": "ok", "session_id": sid,
                    "commit": r.get("commit"), "attempts": attempt,
                    "detail": (f"green on attempt {attempt}: built, booted and "
                               f"the suite passed. Session {sid} is ready to "
                               f"land — that is a separate decision.")}

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


BUILD_STEPS = [("build", _step_build)]


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
    st = await coder.repo_status()
    if st.get("error"):
        return ("blocked",
                f"the landing sidecar is unreachable ({st['error']}) — the "
                f"sandbox check stages its work through it, so nothing could "
                f"be verified", None)
    return ("ready",
            (f"ready: up to {doc.attempts} attempts against {doc.workspace} "
             f"at {st.get('head')}, each verified by the boot gate"), None)
