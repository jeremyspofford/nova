"""The autonomous loop cannot edit its own brakes.

    docker compose exec backend python tests/test_tripwire.py

ROADMAP #47 rail 1. When Jeremy removed the approval click on 2026-08-07, this
became the thing standing between "she improves herself continuously" and "she
improves herself continuously, including the part that decides what she may
do". Every check here is one sentence of that.

The property that matters most is the boring one at the bottom: the tripwire's
own source file is in its own protected list, and a patch touching it does not
land. If that check ever goes red, nothing else in this file means anything —
a pass that edits `tripwire.py` can clear the way for every pass after it.
"""

import sys

sys.path.insert(0, "/app/backend")

from app import tripwire                                 # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def diff(*paths, body=True):
    """A minimal but real `git diff` over the given paths."""
    out = []
    for p in paths:
        out.append(f"diff --git a/{p} b/{p}")
        out.append("index 1111111..2222222 100644")
        out.append(f"--- a/{p}")
        out.append(f"+++ b/{p}")
        if body:
            out.append("@@ -1,3 +1,3 @@")
            out.append(" context")
            out.append("-old line")
            out.append("+new line")
    return "\n".join(out) + "\n"


print("\nreading the paths out of the diff itself")

check("a single-file diff yields that file",
      tripwire.changed_paths(diff("backend/app/summariser.py"))
      == {"backend/app/summariser.py"})

check("a multi-file diff yields all of them",
      tripwire.changed_paths(
          diff("backend/app/a.py", "frontend/src/b.ts"))
      == {"backend/app/a.py", "frontend/src/b.ts"})

_add = ("diff --git a/new.py b/new.py\n"
        "new file mode 100644\n--- /dev/null\n+++ b/new.py\n"
        "@@ -0,0 +1 @@\n+x = 1\n")
check("/dev/null is not treated as a path", "/dev/null"
      not in tripwire.changed_paths(_add))
check("...and the added file still is",
      tripwire.changed_paths(_add) == {"new.py"})

_rename = ("diff --git a/backend/app/consents.py b/backend/app/quiet.py\n"
           "similarity index 100%\nrename from backend/app/consents.py\n"
           "rename to backend/app/quiet.py\n")
check("BOTH sides of a rename are counted",
      tripwire.changed_paths(_rename)
      == {"backend/app/consents.py", "backend/app/quiet.py"})


print("\nan unreadable patch is refused, never read as harmless")

for label, text in [("empty string", ""),
                    ("whitespace only", "   \n\n  "),
                    ("prose that is not a diff",
                     "I changed a few files to fix the bug."),
                    ("a truncated header with no paths", "diff --git\n")]:
    try:
        tripwire.changed_paths(text)
        check(f"{label} raises", False, "returned instead of raising")
    except tripwire.UnreadablePatch:
        check(f"{label} raises UnreadablePatch", True)

ok, why = tripwire.may_land_unattended("not a diff at all")
check("an unreadable patch does NOT land", ok is False)
check("...and says it is waiting for him", "waits for you" in why, why)
check("...and says WHY it could not be judged",
      "cannot be read" in why, why)


print("\nordinary work lands")

for p in ("backend/app/summariser.py",
          "backend/app/memory/index.py",
          "frontend/src/components/library/ModelsTab.tsx",
          "README.md",
          "backend/tests/test_memory.py"):
    ok, why = tripwire.may_land_unattended(diff(p))
    check(f"{p} lands unattended", ok is True, why)


print("\nthe gates do not")

for p in ("backend/app/consents.py",
          "backend/app/goals.py",
          "backend/app/rules.py",
          "backend/app/tools/registry.py",
          "backend/app/tools/scopes.py",
          "backend/app/action_worker.py",
          "backend/app/actions/code_change.py",
          "backend/app/migrations/999_whatever.sql",
          "docker-compose.yml",
          "docker-compose.gpu.yml",
          "inference-control/server.py",
          "git-landing/server.py",
          "coder/broker.py",
          "backend/app/main.py",
          "frontend/nginx.conf",
          "backend/app/secret_store.py",
          "backend/app/net_guard.py",
          "backend/app/capability_claims.py",
          "backend/app/coder.py",
          "backend/app/evals/runner.py",
          "backend/tests/coverage_floor.json",
          "backend/tests/run_all.py",
          "CLAUDE.md",
          "LICENSE",
          ".env",
          ".env.example"):
    ok, why = tripwire.may_land_unattended(diff(p))
    check(f"{p} waits for a person", ok is False, why[:60])


print("\nthe code that RECORDS a verdict is a gate too")

# `inference-control` and `git-landing` produce the verdicts and are
# protected. `coder.py` is the client that asks them and writes the answer
# down: `sandbox_check` sets `sandbox_status`/`eval_status`, and
# `sandbox_verdict`/`eval_verdict`/`review_verdict` are what `code_change`
# reads before it lands anything. A pass that made `eval_verdict` return
# `{"state": "ok"}` unconditionally would disable three of the four
# mechanical facts that stand in for Jeremy reading the diff, and the
# sidecars would never see the change.
ok, why = tripwire.may_land_unattended(diff("backend/app/coder.py"))
check("coder.py — the verdict client — waits for a person", ok is False, why[:60])

# The sandbox's `suite` stage runs the CANDIDATE tree's own
# `tests/run_all.py` (inference-control/server.py). A patch making it skip a
# red suite or exit 0 early produces a green stage and a green verdict.
ok, why = tripwire.may_land_unattended(diff("backend/tests/run_all.py"))
check("the suite RUNNER waits for a person", ok is False, why[:60])

# ...and the distinction that keeps it usable: a test file is not the runner.
ok, _ = tripwire.may_land_unattended(diff("backend/tests/test_memory.py"))
check("...while an individual test file still lands (deliberate: a real "
      "behaviour change has to move its test with it)", ok is True)


print("\none protected file in a large safe change still stops it")

mixed = diff("backend/app/summariser.py",
             "backend/app/memory/index.py",
             "frontend/src/App.tsx",
             "backend/app/consents.py",
             "README.md")
ok, why = tripwire.may_land_unattended(mixed)
check("a mixed patch does not land", ok is False)
check("...and the reason NAMES the offending file",
      "backend/app/consents.py" in why, why)
check("...and does not name the innocent ones",
      "summariser" not in why and "README" not in why, why)


print("\nthe brakes are in their own list")

ok, why = tripwire.may_land_unattended(diff("backend/app/tripwire.py"))
check("a patch to tripwire.py does NOT land unattended", ok is False, why[:80])
check("tripwire.py is explicitly in PROTECTED",
      "backend/app/tripwire.py" in tripwire.PROTECTED)

ok, _ = tripwire.may_land_unattended(diff("backend/tests/test_tripwire.py"))
check("...and so this suite is worth reading when it changes",
      isinstance(ok, bool))

print()
if FAILURES:
    print(f"FAILED: {len(FAILURES)}")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("all checks passed")
