"""Which changes may land without a person, and which must wait for one.

ROADMAP #47, rail 1. `docs/plans/autonomous-improvement.md`.

Jeremy removed the approval click from the self-improvement loop on
2026-08-07: "that needs to be a continuous ongoing process that I don't even
think about or approve." Removing an approval does not remove a control — it
moves the control from a human to a line of code. This is that line.

WHAT IT DOES. Given a patch, it reads the paths the patch actually touches
and answers whether the change may land autonomously. A change touching the
code that ENFORCES the boundaries is not refused; it becomes a card and waits
for Jeremy. Everything else flows.

THE PATH LIST INCLUDES THIS FILE. That is the whole design, not a flourish. A
loop permitted to edit its own brakes has no brakes, and "if it's degrading,
roll it back" stops being something the system can do — the pass that broke
rollback is the pass that removes the ability to notice. Every other
protection here is downstream of that one entry.

DERIVED FROM THE DIFF, NEVER FROM A REPORT. The paths come out of the patch
text itself. Nothing asks the coding agent which files it changed, because a
model that has been argued into touching `consents.py` is exactly the model
whose summary will not mention it. Same reason `scopes.consequences` builds an
approval card from the verb set rather than from the goal's title.

FAIL CLOSED, LOUDLY. A patch that cannot be parsed is not "no protected paths
found" — it is refused, because an unreadable diff and a harmless one are
indistinguishable and only one of them is safe to assume.
"""

from __future__ import annotations

import re
from fnmatch import fnmatch

#: Globs, matched against repo-relative POSIX paths.
#:
#: Each entry answers "if a model changed this file and nobody read the diff,
#: what could stop it next time?" — and every one of them answers "nothing".
PROTECTED: tuple[str, ...] = (
    # This file. First, because everything else depends on it.
    "backend/app/tripwire.py",

    # The gates themselves.
    "backend/app/consents.py",          # the single-use burn
    "backend/app/goals.py",             # what a standing approval authorises
    "backend/app/rules.py",             # the guardrail engine
    "backend/app/tools/registry.py",    # ACTOR_TOOLS, the injection fence
    "backend/app/tools/scopes.py",      # which verbs a goal may pre-authorise
    "backend/app/capability_claims.py",  # the claim verifier
    "backend/app/narration.py",         # the narration detector
    "backend/app/secret_store.py",      # key material
    "backend/app/net_guard.py",         # SSRF / off-stack dialling
    "backend/app/action_worker.py",     # the claim gate this loop runs through
    "backend/app/actions/*",            # the executors it runs
    "backend/app/spend.py",             # the ceiling that refuses to start
    "backend/app/heartbeat.py",         # the clock that starts a pass

    # The client that ASKS the sidecars and RECORDS what they answered.
    # Protecting `inference-control/*` and `git-landing/*` protects the code
    # that produces the verdicts; this is the code that interprets them, and
    # it is the only thing standing between a green row and a landing.
    # `sandbox_check` writes `sandbox_status`/`eval_status`, and
    # `sandbox_verdict`, `eval_verdict` and `review_verdict` are what
    # `code_change.preflight` reads to decide a change may land. A pass that
    # made `eval_verdict` return `{"state": "ok"}` unconditionally would
    # disable three of the four mechanical facts that stand in for Jeremy
    # reading the diff — from a file the sidecars never see.
    "backend/app/coder.py",

    # Schema. A migration is arbitrary SQL against the live database, and the
    # backend runs it at startup without asking anyone.
    "backend/app/migrations/*",

    # Anything that changes what runs, where, with what mounted.
    "docker-compose*.yml",
    "docker-compose*.yaml",
    ".env*",
    "*/Dockerfile",
    "Dockerfile*",

    # The privileged sidecars — the docker socket, the repo write mount, the
    # model key. Each holds a capability the backend deliberately does not.
    "inference-control/*",
    "git-landing/*",
    "coder/*",

    # Authentication and the request boundary.
    "backend/app/main.py",              # auth middleware, host allowlist
    "frontend/nginx.conf",              # the Host allowlist and proxy rules

    # The measurements that decide whether a change was an improvement. A loop
    # that can edit its own scoreboard grades itself.
    "backend/app/evals/*",
    "backend/tests/coverage_floor.json",
    "backend/tests/eval_floor.json",    # the eval ratchet — its own scoreboard
    "backend/tests/eval_floor.py",      # ...and the thing that reads it
    # The runner, NOT the tests. An individual `test_*.py` landing unattended
    # is a deliberate decision — a change that legitimately alters behaviour
    # has to move its test with it, and the sandbox still runs the whole
    # suite. This file is different in kind: it is the script the sandbox's
    # `suite` stage executes (`inference-control/server.py`), inside the
    # CANDIDATE tree, so it is the candidate's own copy that decides what
    # "the suite passed" means. A patch making it skip a red suite or exit 0
    # early produces a green stage, a green sandbox verdict and a landing.
    "backend/tests/run_all.py",

    # Its own governance.
    "CLAUDE.md",
    "LICENSE",
)

#: `diff --git a/<path> b/<path>`, plus the `---`/`+++` forms, because a patch
#: may be produced by `git format-patch`, `git diff`, or `diff -u` and all
#: three reach `git apply`.
_DIFF_GIT = re.compile(r"^diff --git a/(?P<a>.+?) b/(?P<b>.+?)\s*$", re.M)
_TRIPLE = re.compile(r"^(?:---|\+\+\+) (?:[ab]/)?(?P<p>[^\t\n]+)", re.M)

#: `/dev/null` is the other side of an add or a delete, not a path.
_NOT_A_PATH = frozenset({"/dev/null", "dev/null"})


class UnreadablePatch(ValueError):
    """The patch could not be parsed into a path list.

    Raised rather than returning an empty set, because "no files" and "I
    could not tell" must not reach the caller as the same value. The caller
    that treats them the same is the caller that lands an unreviewed change.
    """


def changed_paths(patch: str) -> set[str]:
    """Every repo-relative path this patch touches.

    Both sides of every rename are included: a protected file moved out of
    the way is a change to a protected file.
    """
    if not (patch or "").strip():
        raise UnreadablePatch("the patch is empty")

    paths: set[str] = set()
    for m in _DIFF_GIT.finditer(patch):
        paths.update({m.group("a"), m.group("b")})
    for m in _TRIPLE.finditer(patch):
        paths.add(m.group("p"))

    paths = {p.strip() for p in paths}
    paths -= _NOT_A_PATH
    paths = {p for p in paths if p and not p.startswith("/")}

    if not paths:
        raise UnreadablePatch(
            "no file paths could be read out of this patch — refusing to "
            "treat an unparseable diff as a harmless one")
    return paths


def protected_hits(patch: str) -> list[str]:
    """The protected paths this patch touches, sorted. Empty means clear."""
    hits = {p for p in changed_paths(patch)
            if any(fnmatch(p, g) for g in PROTECTED)}
    return sorted(hits)


def may_land_unattended(patch: str) -> tuple[bool, str]:
    """May this change land with nobody reading it? `(verdict, reason)`.

    The reason is written for the operator reading a card, not for a log:
    when the answer is no, it names the files, because "a protected path was
    touched" sends him to the database to find out which.
    """
    try:
        hits = protected_hits(patch)
    except UnreadablePatch as e:
        return False, (f"refused: {e}. A change that cannot be read cannot "
                       f"be judged, so it waits for you.")
    if not hits:
        return True, "no protected paths touched"

    listed = ", ".join(hits[:8]) + (f" (+{len(hits) - 8} more)"
                                    if len(hits) > 8 else "")
    return False, (
        f"this change touches {len(hits)} protected "
        f"{'path' if len(hits) == 1 else 'paths'} — {listed}. These are the "
        f"files that enforce the boundaries the autonomous loop runs inside, "
        f"so it does not land itself; it is waiting for you.")
