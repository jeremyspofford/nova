"""A coding session that died says so, and only after somebody looked.

    docker compose exec backend python tests/test_coder_stall.py

MEASURED 2026-08-07. Session 6d085e4f was started at 18:34:08, ran `ls
/workspaces/`, hit a permission error, and stopped. Twenty-four minutes later
its row still read `state = 'running'`, and Nova — asked how it was going —
reported it as still running, because that is what the row said. Nothing in
the system could tell a session that was thinking from a session that was
dead.

Two properties are defended here, and the second is the one that is easy to
get wrong:

1. The progress clock moves on PROGRESS, not on attention. `updated_at` could
   not answer this: `_update` stamps it on every write and `refresh` writes on
   every poll, so it measures who is watching. Polling a wedged session in a
   loop kept it looking alive; not polling a healthy one made it look dead.

2. `stalled` is only ever written after a live poll. Marking a row stalled
   because nobody refreshed it would convert "we stopped looking" into "it
   died" — an answer that is wrong in the reassuring direction, which is the
   failure mode this repo keeps rediscovering.
"""

import sys

sys.path.insert(0, "/app/backend")

from app import coder, db                                # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


print("\nfingerprint — what counts as progress")

base = {"state": "running", "commit": "", "diffstat": "",
        "commands": ["ls"], "denials": []}

check("identical polls produce an identical fingerprint",
      coder._fingerprint(base) == coder._fingerprint(dict(base)))

check("a new command moves it",
      coder._fingerprint(base)
      != coder._fingerprint({**base, "commands": ["ls", "cat x"]}))

check("a new denial moves it",
      coder._fingerprint(base)
      != coder._fingerprint({**base, "denials": ["write /etc"]}))

check("a commit moves it",
      coder._fingerprint(base)
      != coder._fingerprint({**base, "commit": "abc123"}))

check("a state change moves it",
      coder._fingerprint(base)
      != coder._fingerprint({**base, "state": "done"}))

check("a diffstat change moves it",
      coder._fingerprint(base)
      != coder._fingerprint({**base, "diffstat": "3 files changed"}))

# The broker returns the WHOLE list every poll, so a fingerprint over contents
# would compare a growing prefix against itself. Counts are what actually move.
check("re-reporting the same command list is NOT progress",
      coder._fingerprint({**base, "commands": ["ls"]})
      == coder._fingerprint({**base, "commands": ["ls"]}))

check("an empty body fingerprints without raising",
      isinstance(coder._fingerprint({}), str))


print("\nstall window")

check("the window is minutes, not seconds — a compile is not a death",
      coder._STALL_AFTER_S >= 300,
      f"{coder._STALL_AFTER_S}s")

check("'stalled' is terminal, so refresh stops polling it",
      "stalled" in coder.TERMINAL)

check("the live states are still non-terminal",
      not {"running", "starting"} & coder.TERMINAL)


print("\nreconcile refuses rather than reporting a comfortable zero")


def _run(coro):
    import asyncio
    return asyncio.get_event_loop().run_until_complete(coro)


_run(db.init_pool())

_real_configured = coder.configured
try:
    coder.configured = lambda: False
    ok, summary = _run(coder.reconcile_stalled())
    # With live sessions on the box this must FAIL: rows claiming to be
    # running with no broker to ask are unknown, not fine. With none, there
    # is genuinely nothing to do and failing five times would auto-disable
    # the automation on an install that simply does not use delegation.
    if "no live coding sessions" in summary:
        check("an idle install is a clean run, not a false alarm", ok is True,
              summary)
    else:
        check("live sessions with no broker is a FAILED run, not '0 stalled'",
              ok is False, summary)
        check("...and the summary says their state is UNKNOWN, not fine",
              "unknown" in summary.lower(), summary)
finally:
    coder.configured = _real_configured


print("\nrepo facts are read, not remembered")
facts = _run(coder._repo_facts())
check("names the real migrations directory",
      "backend/app/migrations/" in facts)
check("states plainly that there is no Alembic",
      "alembic" in facts.lower() and "no alembic" in facts.lower())
check("carries a concrete next migration number",
      any(c.isdigit() for c in facts.split("next free number is")[-1][:12]),
      facts.split("next free number is")[-1][:20].strip())
check("lists real tables from the live database",
      "coding_sessions" in facts and "curated_models" in facts)
check("the task text follows the facts",
      facts.rstrip().endswith("## The task"))

print()
if FAILURES:
    print(f"FAILED: {len(FAILURES)}")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("all checks passed")
