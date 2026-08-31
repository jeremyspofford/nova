"""The evals harness: replay a real case through the REAL turn path against a
chosen model, and score the TRACE it leaves against a mechanical contract.

This package is the measurement heart of Slice 4. Its rails, each enforced by
code in one of the modules here rather than by intention:

  * cases.py     — a case is DATA (a fixture, versioned in git): a setup, a
                   message, and a CONTRACT of mechanical predicate specs. The
                   contract is subset-matched against the FRESH response's
                   trace, NEVER "equals the recorded reply" (a different model
                   answers differently — brittle equality is the anti-pattern).
  * predicates.py — pure, deterministic checks over (spans, reply): the FACTS a
                   real turn leaves. A case passes iff ALL its predicates pass.
  * runner.py    — run_case drives the case's message through chat._run_turn
                   (the actual chat funnel) with the chosen model, under a
                   SCRATCH person + conversation so an eval never reads or writes
                   the owner's memory/conversation/ledger (rail 17). A turn that
                   errored is UNGRADEABLE — recorded as such, never scored 0.
                   eval_runs is written here and read by no decision path.

The model is never told it is being evaluated: the turn built by _run_turn is
byte-identical to a normal chat turn (no "eval mode" string ever reaches the
prompt — pinned by a test). The only eval-ness is the turn's kind='eval' tag on
the turns row (which the Activity list filters out) and the scratch person id —
neither of which is in the prompt.
"""
