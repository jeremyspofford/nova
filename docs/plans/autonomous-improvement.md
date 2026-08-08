# Autonomous improvement — she improves herself, continuously, unapproved

**Status:** spec'd 2026-08-07, building. Supersedes the operator-merge lock in
five places (listed below, with the sentence that lifted it).

## What Jeremy asked for

> "she needs to autonomously improve herself and know how to do it. ie: learn
> about something through online searches or youtube, grade out what that
> would be as an improvement for herself, if it scores high enough, then start
> implementing it — maybe in a k8's pod or that isolated mirror sandbox and
> then test that instance out thuroughly. And that needs to be a continuous
> ongoing process that I don't even think about or approve. She just needs to
> do it, score improvements, and if it's degrading, roll it back and try
> something else."

Two things in that sentence are new, and only two. The pipeline already
exists. What is new is **the trigger** (no click) and **the reversal**
(degradation rolls itself back).

## The locks this lifts, and why it is his to lift

Five documents say some version of "operator merge is the gate indefinitely":

| Where | The sentence |
|---|---|
| `self-improvement.md` | containment invariant 1 — "Nova never merges nova's own main" (2026-07-24) |
| `coding-team-pipeline.md` | the identical LOCK |
| `capability-acquisition.md` | phase 5 — "operator merge is the gate indefinitely" |
| `self-improvement-loop.md` | "What stays his" — "not a limitation to remove later" |
| `action_worker.claim_next` | `AND rec.decided_by = 'operator'`, enforced in SQL |

Every one of those was written by me, recording a decision of his. The
sentence above is him reversing it, in his own words, unprompted. That is
sufficient — but it is written down here because a lock lifted in chat and
not recorded is a lock that gets silently re-imposed by the next session
reading the old doc. **Those five documents are now amended, not ignored.**

What the reversal does NOT touch, and these stay verbatim:

- the sandbox shares nothing live with production;
- the four credential tables never enter the sandbox
  (`secrets`, `llm_providers`, `push_subscriptions`, `user_profiles`);
- automations and notify stay OFF inside the sandbox;
- research taints the turn — a turn holding fetched text cannot reach an
  ACTOR tool;
- `git-landing` holds no push credential;
- one sandbox at a time.

## The rails that replace the click

Removing an approval does not remove a control; it moves the control from a
human to a line of code. Six, and the ordering is the build order because
each is useful alone:

### 1. Protected-paths tripwire — the one that makes the rest survivable

The backend computes the **diff's path list** and refuses autonomous landing
of anything touching the code that enforces the boundaries:

```
backend/app/consents.py        backend/app/goals.py
backend/app/tools/registry.py  backend/app/tools/scopes.py
backend/app/rules.py           backend/app/migrations/*
docker-compose*.yml            coder/*
inference-control/*            git-landing/*
backend/app/actions/*          backend/app/tripwire.py   <- itself
```

Diff-derived, never model-reported. A change touching these is not refused —
it becomes a card and waits for Jeremy. Everything else flows.

**The tripwire's own source is in its own list.** A loop that can edit its
brakes has no brakes, and "roll it back" stops being a thing the system can
do. This is the single line that keeps his instruction executable rather
than merely obeyed.

### 2. Eval floor — "green" must include "did not get worse"

The sandbox today builds, boots, imports prod data, and runs the unit + e2e
suites. It never runs the eval suites, so a candidate can pass every test and
still be measurably worse at being Nova. Add `python -m app.evals` as a fifth
sandbox stage with a ratcheting floor file, exactly like `coverage_floor.json`
— floors only move UP.

### 3. Spend meter — the ceiling that refuses to start

Each pass is a coding agent + an image build + a production-sized import +
three suites. Today only wall-clock (`_LOOP_BUDGET_S`, 90 min) and per-goal
action counts bound it; nothing counts money or tokens. The ACP broker
already receives usage frames carrying token counts and nothing consumes
them. A per-day ledger with a ceiling column, and a pass that would exceed it
does not start.

### 4. The standing-goal trigger — the second claim lane

`action_worker.claim_next` requires `rec.decided_by = 'operator'`. **Do not
delete that check.** Add a second lane beside it: a run whose recommendation
was auto-created under a live goal carrying a new `improve_self` verb,
budgeted by the goal's existing `max_actions` / `expires_at` / atomic
`FOR UPDATE SKIP LOCKED` spend machinery. The heartbeat tick creates the run.

The difference matters: an operator-approved card and a goal-authorised card
are distinguishable forever in the audit trail, and revoking the goal stops
the loop without touching the code that runs approved work.

### 5. Research → score → enter the lane

Idea sourcing needs `web_search`/`fetch_url`, which `ideator` does not hold.
Grant them — to a researcher role, in a **separate turn** from anything that
triggers a build. This is not ceremony: the untrusted-context fence means a
turn holding fetched text cannot reach an ACTOR tool, and that is the only
thing standing between "learn from YouTube" and "execute what the video
said". The handoff from research to build passes through **a goal row**,
never through prose an agent wrote.

Scoring cannot be the model marking its own homework. Mechanical inputs
first — failure-census hits, heartbeat findings, measured eval deltas,
recurring errors in her own traces — with a different-model judge on top.
Same argument that produced the different-model review gate.

### 6. Auto-merge and auto-rollback — last, and only on top of 1–5

A new fixed `merge` verb on `git-landing`, gated on **all** of: green sandbox
keyed to this exact commit, review passed by a different model, eval floor
held, clean tree, empty tripwire, and a fresh verified backup
(`backup_service.freshness` already computes that). Then a SHA-recorded
redeploy with a post-deploy watcher.

**The watcher lives in `inference-control`, not the backend.** Redeploying
the backend kills the process reporting on it — a rollback watcher inside the
backend dies with the bad deploy it was supposed to catch. The sidecar
already holds a verdict across a detached redeploy (`_last_detached`); this
is that pattern with a health window on the end.

Rollback trigger is mechanical: health check, failure census, and eval score
over a window after deploy. Degradation reverts to the previous SHA and
records why. Then the loop tries something else — which is exactly what he
asked for.

## What this does not fix

Step 10 of the twelve — real QA — is still thin. The 70+ suites are
unit/module level; almost none drive a real turn or the UI. The sandbox does
run the e2e browser suite, which is the honest part of the answer. A loop
shipping unattended deserves better integration coverage than this, and that
remains its own lane.

Thirteen of fifteen live coding sessions have never been sandbox-checked. The
gate works but it is young, and continuous operation multiplies its load.
Expect flakiness to surface as silent no-deploys before it surfaces as
anything worse.
