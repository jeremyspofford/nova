"""Mechanical patch grading — capability-acquisition phase 6b.

Jeremy chose a **mechanical grader over eyeballing diffs** (2026-07-29), and
this is where that decision becomes code. `propose_patch` (6a) produces a
unified diff; `patches.review()` in the backend checks the things a read-only
view supports — well-formed diff, named files exist, small enough to review —
and says plainly that it has NOT checked whether the patch applies, compiles
or passes tests, because the backend mounts only `/app/backend` and
`/app/data` and has neither `git` nor `patch`.

This container has all of it: git, python, pytest, ruff, and a private clone
per job. So the three questions the backend could not answer get answered
here, against a real checkout of the real repository.

THE ONE RULE THIS MODULE IS BUILT AROUND: a partial pass reads as a pass. That
sentence is the plan's own reason for not building the grader early, and it is
the failure this design has to make impossible. So every stage is TRI-STATE —
`pass`, `fail`, or `skip` — and `skip` never counts as success. A patch that
touches only frontend TypeScript gets `compile: skip` with a stated reason,
not `compile: pass`, because nothing compiled it. `verdict` is `pass` only if
at least one stage passed and none failed and nothing was skipped that the
patch actually needed.

WHAT IT DOES NOT DO: judge whether the patch does what was ASKED. That is the
fourth criterion in the plan and it needs a model, so it belongs to the caller
and stays clearly separate — a judge's opinion must never be able to overturn
`applies: fail`.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import uuid

from acp import AcpSession

log = logging.getLogger("coder.grade")

WORKSPACES = os.environ.get("CODER_WORKSPACES", "/workspaces")

#: Stage outcome that is explicitly NOT success.
SKIP = "skip"


def _run(cmd: list[str], cwd: str, timeout: int = 300) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                           timeout=timeout)
        return r.returncode, (r.stdout + r.stderr)[-4000:]
    except subprocess.TimeoutExpired:
        return 124, f"timed out after {timeout}s"
    except FileNotFoundError as e:
        return 127, str(e)


def grade(repo: str, patch: str, test_cmd: str = "") -> dict:
    """Clone, apply, compile, test. Every stage reports its own outcome."""
    job = os.path.join(WORKSPACES, f"grade-{uuid.uuid4()}")
    stages: dict[str, dict] = {}
    try:
        rc, out = _run(["git", "clone", "--no-hardlinks", "--depth", "50",
                        repo, job], cwd=WORKSPACES, timeout=600)
        if rc != 0:
            return {"verdict": "error", "detail": f"clone failed: {out[-300:]}",
                    "stages": {}}

        # -- applies cleanly ------------------------------------------------
        # `--check` is asked FIRST and separately from applying. "It applied"
        # and "it would apply" are different facts, and the operator's question
        # is the second one.
        with tempfile.NamedTemporaryFile("w", suffix=".patch", delete=False,
                                         dir=job) as f:
            f.write(patch if patch.endswith("\n") else patch + "\n")
            pf = f.name
        rc, out = _run(["git", "apply", "--check", "-v", pf], cwd=job)
        stages["applies"] = {"result": "pass" if rc == 0 else "fail",
                             "detail": "" if rc == 0 else out[-800:]}
        if rc != 0:
            # Nothing downstream is meaningful against an unpatched tree, and
            # reporting compile/test results from it would be reporting on
            # code the patch never produced.
            for s in ("compile", "tests"):
                stages[s] = {"result": SKIP,
                             "detail": "the patch did not apply, so this was "
                                       "never run"}
            return _verdict(stages, changed=[])

        _run(["git", "apply", pf], cwd=job)
        os.unlink(pf)
        # `git add -A` FIRST, then read the staged list. `git diff --name-only`
        # alone reports modified tracked files and silently omits files the
        # patch CREATED — so a patch whose only Python is a new module scored
        # `compile: skip, no Python in this patch`, which is the exact
        # silently-ignored-file failure this module exists to prevent. Caught
        # by noticing a new test_calc.py missing from changed_files.
        _run(["git", "add", "-A"], cwd=job)
        changed = [ln for ln in
                   _run(["git", "diff", "--cached", "--name-only"], cwd=job)[1]
                   .splitlines() if ln.strip()]

        # -- compiles -------------------------------------------------------
        # Only Python is compilable here, and that is stated rather than
        # glossed: a patch touching only .ts files gets SKIP with the reason,
        # which is the honest answer and the one the plan warned about.
        py = [p for p in changed if p.endswith(".py")]
        if not py:
            stages["compile"] = {
                "result": SKIP,
                "detail": ("no Python in this patch; nothing here can compile "
                           f"{', '.join(sorted({os.path.splitext(p)[1] or '?' for p in changed})) or 'it'}")}
        else:
            rc, out = _run(["python3", "-m", "compileall", "-q", *py], cwd=job)
            stages["compile"] = {"result": "pass" if rc == 0 else "fail",
                                 "detail": "" if rc == 0 else out[-800:],
                                 "files": len(py)}

        # -- tests ----------------------------------------------------------
        if not test_cmd.strip():
            stages["tests"] = {"result": SKIP,
                               "detail": "no test command was given"}
        else:
            # The SAME allow-list the sessions use. A grader that could run
            # any command would be a way around the session policy, reached by
            # calling the other endpoint.
            ok, why = AcpSession._command_ok(test_cmd)
            if not ok:
                stages["tests"] = {"result": SKIP,
                                   "detail": f"test command refused: {why}"}
            else:
                rc, out = _run(test_cmd.split(), cwd=job, timeout=600)
                stages["tests"] = {"result": "pass" if rc == 0 else "fail",
                                   "detail": out[-1500:]}
        return _verdict(stages, changed)
    finally:
        shutil.rmtree(job, ignore_errors=True)


def _verdict(stages: dict, changed: list) -> dict:
    """One word, and it is never generous.

    `pass` requires that something actually passed and nothing failed. A run
    where everything was skipped is `inconclusive`, not `pass` — that is the
    whole point of the tri-state, and the case the plan called out.
    """
    results = [s["result"] for s in stages.values()]
    if "fail" in results:
        verdict = "fail"
    elif "pass" in results:
        verdict = "pass" if SKIP not in results else "partial"
    else:
        verdict = "inconclusive"
    return {"verdict": verdict, "stages": stages, "changed_files": changed,
            "summary": _summary(verdict, stages)}


def _summary(verdict: str, stages: dict) -> str:
    bits = [f"{k}: {v['result']}" for k, v in stages.items()]
    head = {
        "pass": "Applies, compiles and the tests pass.",
        "partial": "No failures, but not everything could be checked.",
        "fail": "Something failed — see the stages.",
        "inconclusive": "NOTHING was actually verified.",
    }[verdict]
    return f"{head} ({'; '.join(bits)})"
