# Nova proposes her own tests

Asked 2026-08-03, after the Run button shipped. Jeremy: *"there's no
indication in the ui of what the tests are at all, or how to make more or
remove more. would be nice if we could have AI suggest creating, editing, or
removing of tests."*

The first half is done — Library → Models now lists every task in a suite with
its prompt, what its contract grades, and the `intent` prose explaining the
incident it came from. This is the second half.

---

## The blocker to know about first

`recommendations.decide()` flips a status column and writes receipts. **No code
path turns an accepted recommendation into an applied one** — that is item 5 of
`nova-actually-working.md`, still open. So a test proposed as a recommendation
card would be approved by the operator and then simply not exist.

Any design here either fixes that path or does not use it.

---

## What a bad test costs

This is the reason the design is stricter than it looks like it needs to be.

A test that grades nothing reads exactly like a test that passes. Measured
today, twice:

- Ten of `main`'s tools had no fixture and were not in `replay_only_tools`, so
  any model reaching for one produced an unserved call. `glm-5.2` scored 0
  calls / FAILED; after the fix both models passed 3/3. **The model difference
  was entirely an artifact of the suite.**
- Two regexes I wrote myself were wrong in ways that would have graded the
  opposite of their intent. `validate.py`'s probe pairs caught both.

A model authoring tests unsupervised would produce these faster than anyone
reads them. So the rule is the one this codebase keeps landing on: **the model
may draft a test; a draft becomes a test only by passing a check it cannot
talk its way around.**

---

## Design

### The gate is `validate.py`, and it already exists

Every proposal is run through the existing validator before a human sees it:

- every tool named in `must_call` / `must_not_call` is one the agent is
  actually granted, checked against `granted.json`
- every contract key is in the known vocabulary
- **the probe pair must hold** — the golden sample passes the contract and the
  bad sample fails it. This is the check that catches a regex which greps for
  the wrong thing, and it caught two of mine.

A proposal that fails validation is never surfaced as a suggestion. It is
returned to the author with the validator's own errors, which are specific
enough to fix.

### Three phases

**Phase 1 — propose, validate, preview.**
`POST /api/v1/evals/tasks/propose` takes a task JSON, runs the validator, and
returns either the errors or a rendered preview (title, prompt, what it would
grade, both probe samples). Writes nothing. A "Suggest a test" button in the
panel dispatches to an agent and shows the result. The operator reads a
validated draft or a list of reasons it is not one.

**Phase 2 — apply as a reviewable change.**
Accepting writes `tasks/<suite>/<id>.json`, registers it in `suite.json`,
**bumps `suite_version`**, and re-runs the validator over the whole suite. The
version bump is not decoration: `eval_runs` records it, and `model_fitness`
already tells the operator when a stored score was graded against a version
that has since moved. Adding a test silently invalidates every prior score;
this is what makes that visible rather than quiet.

**Phase 3 — propose from failures, not from prompts.**
The weekly `self-review` agent (item 4) reads failed turns, alerts and ingest
failures, and proposes a test for anything recurring that no suite covers.
This is where the feature earns its keep: every task in the suite today came
from an incident someone noticed by hand.

### What NOT to build

**No live edit or delete in the UI.** Tasks are code. They are reviewed in a
diff, versioned with `suite_version`, and guarded by `test_eval_grants.py`
precisely because eval definitions drifting out of sync grades nothing
silently. A UI that rewrites them in place bypasses all of that, and the
failure mode is the one thing worse than a missing test: a changed test whose
score is compared against runs of the old one.

Removal is the sharper case. A test is removed because the behaviour it
defends is no longer wanted — that is a decision with a reason, and the reason
belongs in a commit message, not in a click. The panel says where the files
live and stops there.

---

## Open questions for Jeremy

1. **On demand, or unprompted?** A "Suggest a test" button costs tokens when
   pressed. The self-review automation costs them weekly and catches things
   nobody thought to ask about. Phase 1 is the button; phase 3 is the
   automation, and it depends on item 4 existing.
2. **Which agent authors?** `tool-creator` and `agent-creator` are the closest
   existing shapes. A test is closer to a rule than a tool, and authoring one
   requires reading the incident record — so this may want its own agent with
   read-only grants plus the propose verb, rather than reusing either.
3. **Does apply need a goal?** Writing a task file changes what the system
   measures itself by, which is arguably a capability change and therefore
   goal-scoped. The conservative answer is yes; the case against is that a
   test grants nothing and the operator approves each one anyway.
