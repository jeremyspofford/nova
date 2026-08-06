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

    stat = (got.get("diffstat") or "").strip().splitlines()
    summary = stat[-1].strip() if stat else "changes"
    return ("ready",
            (f"sandbox green ({verdict.get('detail')}); ready to land on "
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
