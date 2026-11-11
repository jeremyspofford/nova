# Self-investigation and auto-fix (design, owner queue item 2, 2026-11-11)

**Sources:** the owner's batch of 2026-11-11, item 2, marked [DESIGN FIRST]
(`docs/builder-packet/INPUT-2026-11-11-OWNER-BATCH.md:44-50`), quoted here in full:

> Nova opens an incident on itself: detect (health, failed tasks, red checks) → gather evidence →
> diagnose → fix inside approval tiers → verify → journal. Capability- and invariant-based ("a
> scheduled task failed", "a check went red"), never per-known-bug scripts. Every auto-fix ships with
> a regression test and a rollback or it doesn't ship. Owner's D5 semantics apply: a failed task is
> "Needs you" amber only after the fix attempt fails or hits a tier boundary.

Its reconciliation with the ledger: `docs/builder-packet/nova-owner-batch-reconciliation-2026-11-11.md`,
item 2 (`:110-137`), conflict C5 (`:34`, `:126-129`) and rulings R10, R11, R19 and R21 (`:383-384`,
`:392`, `:394`). The batch's item 3 invariant, "the implementer never verifies its own work"
(`INPUT-2026-11-11-OWNER-BATCH.md:60-61`). ADR-7 and ADR-9
(`docs/builder-packet/ARCHITECTURE-AND-DECISIONS.md:17`, `:23`). NOVA-SPEC §6 tiers and §8 reliability
(`docs/builder-packet/NOVA-SPEC.md:47-53`, `:63-68`). The tier ruling, decision 8
(`docs/builder-packet/INPUT-2026-11-09-TIER-RULING.md`). WORK-LEDGER-AND-VERIFICATION (verification
layer and decision journal, `:14-22`). The ledger entry for ruling D5,
`docs/ledger/2026-11-10-status-truth.md`. The standing constraint on paid calls
(`docs/plans/owner-priority-queue-2026-11-02.md:14`). Format follows
`docs/plans/mcp-host-adr-2026-11-09.md` and `docs/plans/knowledge-graph-adr-2026-11-10.md`.

**Status:** PROPOSED, 2026-11-11. Docs only: nothing in Nova changes in this step. The owner marked
the item [DESIGN FIRST], so nothing here is built until he rules on the list at the end (S2-R1 to
S2-R13, with R10, R11 and R19 carried over from the reconciliation). Where this record states a
builder's recommendation it says so; it decides nothing in the owner's place.

**Conflicts are flagged, not resolved.** C5 (the batch's amber timing against D5 as built) is
presented as options in section 8 and stays open under R10. The tension between "never per-known-bug
scripts" and today's per-kind playbooks stays open under R11.

**Hard limits kept by this design and by any build of it until the owner lifts them:** no paid model
call; no account, key or plugin touched; no change to the gates in `src/core/changes/gates.ts`; no
networking, vault, security, permission or deletion change ever applied by the loop itself; nothing
of the parked items (section 11). Every claim about today's code was read at `e79dd8bbb` (main after
PR #504) and carries a `file:line`.

## What exists today

Most of the loop's parts exist. What is missing is the envelope that ties one failure to its evidence,
its diagnosis, its fix, an independent verification and a durable account.

| Piece | Where | What it does now |
|---|---|---|
| Problems | `src/core/migrations/0001_core.sql:62-72`; `src/core/log.ts:11-23`, `problem()` `:119` | One row per thing that went wrong and matters to the person: source, message, detail, task, resolved. `stops` (migration 0021) makes it red; otherwise amber. Every module raises its failures here (NOVA-SPEC §8: "never only in a log file") |
| Repair playbooks | `src/core/resilience/playbooks.ts:27-163`; table `0012_resilience.sql:6-13` | 22 problem kinds, each with steps for the person and, "where one is safe", a repair Nova makes itself. "Safe" means it "can't lose or change the person's data" (`:3-6`). A classifier attaches a playbook to any problem whose words fit (`:196-207`); one open per playbook and subject (`:218-223`) |
| Safe repairs | `src/core/resilience/repairs.ts:61-123`, `src/core/resilience/index.ts:80-84` | `recheck-worker`, `recheck-models`, `reconnect`, `resync`, `restart-runtime`, `retry-backup`, `free-scratch`, `clock`. Nova's own attempts: three, a minute apart (`playbooks.ts:175-176`, `:286-291`); restarting the hub is never Nova's own repair (`:181`); every attempt is recorded with the problem (`:302-304`); closed only "when the repair could tell the cause is gone" (`:305`) |
| A failed task | `src/core/ledger.ts:661-668` | The task moves to failed, `user_visibility = 'attention'`, and "A task failed: …" is raised without `stops` (D5): amber at once. `recheck-worker` puts back only *waiting* work; "A failed task is yours to retry or cancel" (`repairs.ts:78-79`) |
| The rerun rule | `src/core/ledger.ts:636-654` | Whether a task got as far as its outside effect (`rerun_decision`); work that may already have happened is held for the person, never run again |
| Scheduled work | `src/core/triggers.ts:1-4`, `:426-451` | Every scheduled run is a rule in a visible registry and a trigger record; runs missed within 6 hours catch up once, older ones are recorded as dropped. A heartbeat that can't check schedules raises a problem (`src/core/index.ts:1744`) |
| Health checks | `src/core/index.ts:1108-1140` | `GET /health`: 19 checks (database, workers, connectors, vault, capture, backups, changes, ingest, computer, passkeys …). Only a dead database `stops` (`:1109-1116`) |
| The heartbeat | `src/core/index.ts:1740-1751` | Schedules, the repair sweep (`playbooks.sweep`, `playbooks.ts:321-329`), the budget and dead-man's-switch sweeps. The hub only: "A standby runs neither" (`:1752`) |
| The supervisor | `src/supervisor/releases.ts:1-9`, `src/supervisor/main.ts:7-14`, `src/supervisor/services.ts:3-20`; M7 plan §2 (`docs/plans/M7.md:70-88`) | Restarts with backoff, safe mode, code releases as tagged slots with sandbox, smoke probes, canary and automatic rollback; a rollback across a migration refuses when anything was written since. Deploy is tier 3 and a command-line verb today |
| The change pipeline (ADR-9) | `src/core/changes/pipeline.ts:1-11`, `gates.ts:8-36` | Extensions, design systems, settings, decision templates and trigger-rule packs: sandbox → tests → health → release → approval → canary → promote, or automatic rollback to the exact previous version. The gates are frozen constants; a change that names one or targets the pipeline is refused. **Code is not a kind** (`gates.ts:8`) |
| The foundry | `src/core/changes/foundry.ts:1-8` | Nova authors packages for a stated need; anything it proposes is tier 3, "confirmed every time" |
| Coding runs | `src/core/coding/*`; CAPABILITY-INVENTORY:61 | Write (tier 1) → check: Nova's own test run at the exact commit (tier 2) → merge (tier 3, never pushes). Not wired to a release or a deploy |
| Verification layer | `src/core/verify.ts:1-3`; WORK-LEDGER-AND-VERIFICATION:14-19 | Evidence checked against the brief before a task is done; "Nova checks the target itself rather than trusting the worker's claim"; a kind it can't check fails |
| Cost ceilings | `src/core/caps/index.ts:1-13` | Per task and per day, iterations, tokens and priced dollars; a loop detector; unpriced tokens held by token ceilings |
| Diagnostics and redaction | `src/core/diagnostics/index.ts:1-17`, `RULE` `:26` | "Counts and states, never content; names of secrets at most, never their values", three layers (allow-list, secret keys, known secret values in every encoding plus secret shapes) |
| Log scrubbing | `src/core/log.ts:28-33` | Secret-named keys and the vault's values never reach the log |
| Egress | `src/core/workers.ts:57`; `src/core/receipts.ts:1-2`; `src/core/ingest/outbound.ts:1-9` | `permits(mode, egress)`: local-only refuses remote; a receipt for every model call; the outbound guard checks what leaves for secrets, memory text and encoded blobs |
| Status and amber | `ui/js/status.js:105-112`, `:154`, `:164`; `docs/plans/orb-states.md:19-70` | `severity()`: stopped (red) only for a `stops` problem; any other open problem, an OK waiting, or a failed task is "Needs you" amber |
| The decision journal | WORK-LEDGER-AND-VERIFICATION:21-22; CAPABILITY-INVENTORY:18 | Specified, **not built** ("confirmed absent in both eras") |

### What is missing

1. **No incident.** A problem, its playbook attempts and the failed task are three records with no
   shared identity, no evidence bundle, no diagnosis and no verification step distinct from the repair.
2. **Unclassified problems get nothing.** A problem no classifier recognises (`repairs.ts:56`,
   `return null`) has no repair and no investigation: it waits for the person.
3. **No proof gate for fixes.** The change pipeline proves a change passes its own tests; nothing
   proves that a fix carries a test that *fails on the broken state*, and nothing proves a rollback
   works before the fix is applied.
4. **No path from a code fix to running code.** A coding run stops at a merged branch; a release is a
   tag deployed from the command line. Nothing joins them.
5. **No independent verifier for repairs.** A playbook repair reports its own outcome and may close
   its own problem (`playbooks.ts:305`): the implementer verifies itself.
6. **No signal for repository CI.** Nova reads no CI provider; the only connectors are mail and Home
   Assistant (`src/connectors/`, `src/core/connectors/`).

## Decision (proposed)

Add **incidents**: one record per broken invariant and subject that carries a failure from detection
to a verified close or to the person. Incidents **generalise** the playbooks rather than replace them
(builder's recommendation; the choice is R11): a playbook becomes the catalogue's known safe fix for a
problem kind, chosen by the incident's deterministic diagnosis, and every fix outside that catalogue
goes through the pipelines that already exist (the change pipeline for settings, templates, rules and
extensions; coding runs and the supervisor for code). The loop adds three things the system lacks:
an evidence bundle under the diagnostics rule, a frozen proof gate ("test and rollback or it doesn't
ship"), and a verifier that is never the fixer.

```
 problem raised ─▶ detected ─▶ gathering ─▶ diagnosing ─▶ fixing ─▶ verifying ─▶ resolved
     (any source)                                   │          │           │
                                                    │          │           └▶ (fails) ─▶ needs_you
                                                    │          └▶ tier boundary ─────▶ needs_you
                                                    └▶ no fix in the catalogue ──────▶ needs_you
 kill switch off ─▶ nothing past "detected"; loop limits hit ─▶ needs_you
```

## 1. Detectors are invariants

The loop never matches known bugs. It reads **invariants**: statements that hold when Nova is well,
each read from a signal that exists today. Every one of them already ends in a `problem` row, so the
incident opener has **one** entry point, the log's `problem` event (the one playbooks already listen
to, `playbooks.ts:197`), plus two derived sweeps.

| # | Invariant | Signal it reads today | Source of truth |
|---|---|---|---|
| I1 | A task the person or a rule started ends done, not failed | The ledger's failure problem with `task_id` | `src/core/ledger.ts:661-668` |
| I2 | A scheduled rule runs when due | Trigger records: a run dropped as missed, or a run whose task failed; "couldn't check the schedules" | `src/core/triggers.ts:426-451`, `src/core/index.ts:1744` |
| I3 | Every health check reads ok | `GET /health` checks with `ok: false` | `src/core/index.ts:1108-1140` |
| I4 | Nova and its supervised services are running | Supervisor problems: `server-crashed`, `server-unresponsive`, `safe-mode`, `service-*` | `playbooks.ts:29-83`, `src/core/resilience/index.ts:94-98` |
| I5 | A change or release that went live stays healthy | Change states `stopped`, `rolled_back`, `broken`; releases `release-stopped`, `release-rolled-back`, `rollback-refused` | `src/core/changes/pipeline.ts:34`, `:191-195`; `playbooks.ts:48-62` |
| I6 | Workers, the local model and connections answer | `provider-failed`, `local-model-down`, `connector-down`, `name-lookup` | `repairs.ts:36-57`, `:129-148` |
| I7 | Backups complete and the restore drill passes | `backup-*`, `disk-full`, `drill-failed`, `forget-owed` | `src/core/resilience/index.ts:86-93`, `playbooks.ts:85-120` |
| I8 | The standby keeps up and the hub answers | `standby-behind`, `hub-failover`, `device-safe-mode` | `playbooks.ts:143-156` |
| I9 | Every open problem has a known repair or an owner | Derived: an open problem with no playbook (`Playbooks.view` returns null) | `playbooks.ts:262-267` |
| I10 | A failure does not repeat | Derived: the same invariant and subject failing again within a window after a verified close | the incident record (section 2) |

**"A check went red"** reads as I3 and I5 (Nova's own health checks and canary probes). Repository CI
is not a signal Nova has; adding it needs a CI connector that does not exist. That scope is S2-R13.

**Out of the loop on purpose:** the red sources that are security decisions (a security refusal, a
dead-man’s switch that fired, a failed rollback; `docs/plans/orb-states.md:19-54`). A builder's recommendation:
they open incidents for evidence only, never a fix. The choice is S2-R11.

## 2. The incident record

**Where it lives:** the core database, beside `problem` and `problem_playbook`, as one new table in a
later migration (not this PR), replicated to the standby with the same sync triggers as `problem`
(migration 0021's pattern). The work an incident does runs as internal ledger tasks of a
`self-repair` worker, the way a coding run is a chain of internal tasks, so tiers, the privacy gate,
recovery after a restart and the "Nova is handling" surface come from the ledger, not new code.

**Schema (proposed):**

| Field | Meaning |
|---|---|
| `id` | Incident id |
| `invariant` | One of I1 to I10 (a closed list in core) |
| `subject` | What it is about (a task, rule, worker, connector, service, change id), or null |
| `fingerprint` | `invariant + subject`: one open incident per fingerprint, as `openFor` does today |
| `problem_ids`, `task_ids` | The problems and tasks it covers (references only) |
| `parent_id` | The incident whose own fix caused this one, or null (section 9) |
| `state` | `detected`, `gathering`, `diagnosing`, `fixing`, `waiting`, `verifying`, `resolved`, `needs_you`, `observed` (kill switch at observe), `closed_by_person` |
| `evidence` | A list of references and hashes (section 3), never copied content |
| `diagnosis` | `{ by: 'rules' or model role, playbook?, hypothesis?, fix_class, confidence, receipt_id? }` |
| `fix` | `{ class (F0 to F5), tier, ref (repair name, change id, coding run, release), test_ref, test_proof, rollback_ref, rollback_proof }` |
| `verification` | `{ by, at, invariant_reads: [...], ok }`: `by` is never the fixer's identity |
| `attempts` | Fix attempts, each with its outcome (the playbook's `repairs` list moves here) |
| `opened_at`, `closed_at`, `outcome` | Lifecycle times and the one-line account |

**Lifecycle rules:**
- Only forward transitions, each a ledger event with its evidence; a restart resumes from the last
  recorded state (`ledger.recover()` already does this for tasks).
- `resolved` only from `verifying`, and only on the verifier's record (section 7).
- `needs_you` is reachable from every working state, and is where the person sees the steps, the
  evidence and any prepared fix waiting for their tier.
- A person may close an incident at any state (`closed_by_person`), as they may mark a problem dealt
  with today.

**Retention:** an open incident is kept until it closes. A closed incident keeps its one-line account,
fix references and verification for good (they are the journal, section 7); its evidence references
are pruned after a window the owner sets (S2-R8). Forgetting stays absolute: evidence holds pointers
and hashes, so a forgotten memory, conversation or capture event leaves nothing behind in an incident.

## 3. Evidence gathering

Collectors are **per invariant class**, never per bug, and deterministic (no model):

| Collector | What it records | Bound |
|---|---|---|
| The problem | Its row, with `detail` as the log already scrubbed it | the row |
| The task | State, events, `rerun_decision`, worker, tier, privacy mode: **ids and states, not the title or brief** | last 50 events |
| The rule | The trigger records of its last runs (hashes, decisions, outcomes) | last 10 |
| Health | The `GET /health` snapshot at detection and now | 2 reads |
| The module's log | Log lines from the problem's `source`, through the diagnostics redaction | 500 lines (`LOG_LINES`), 2,000 characters per detail (`DETAIL_MAX`) |
| What changed | Changes and releases that went live since the invariant last held (ids, versions, hashes) | since last good |
| Repair history | The playbook's attempts for this subject | all |

**Privacy rule for evidence (proposed, binding on the build):** the diagnostics rule applies
unchanged, "counts and states, never content" (`src/core/diagnostics/index.ts:26`): the same
allow-list, key redaction and known-secret redaction. No memory text, conversation, capture text,
task title or brief, or the person's name or address is read into an incident. An evidence bundle
is capped at 32 KB; what does not fit is dropped oldest first and the drop is recorded.

## 4. Diagnosis

**Rules first.** The playbook classifiers (`repairs.ts:36-57`, `resilience/index.ts:86-93`) are the
first diagnosis: if a playbook fits and its repair has not failed three times, the diagnosis is that
playbook, with no model call. Most of today's failures end here.

**A model only for what rules can't place** (I9, or a playbook whose repair failed), and only from
slice 3 on:
- **What it sees:** the redacted evidence bundle and the closed list of fix classes, nothing else. The
  evidence is treated as outside content: a failed task's detail may quote a web page or a mail, so the
  run counts as tainted and guarded steps ask (`src/runner.js:37`, `GUARDED`; tier ruling's first
  constraint).
- **What it returns:** typed JSON: the invariant it believes broken, a hypothesis in plain words, one
  fix class from the closed list, a confidence. Out-of-schema or low-confidence output escalates to
  `needs_you` (ADR-7: a model never acts alone on a consequential decision; deterministic policy picks
  the tier).
- **Which model:** the local `reasoner` role through `models.infer`, inside the privacy mode
  (`workers.ts:57`), with a receipt. **No paid call by default** (standing constraint,
  `owner-priority-queue-2026-11-02.md:14`); under local-only it is local or nothing. Whether a cloud
  model may ever be used is S2-R5.
- **Bounded cost per incident (proposed):** at most 2 model calls (diagnose, then propose), at most
  8,000 tokens in and 1,000 out per call, metered by `src/core/caps` against the task and day
  ceilings. Over the bound: `needs_you`, with what was found so far.

## 5. The fix stage, strictly inside approval tiers

Fixes come from a **closed catalogue of fix classes**. The class sets the tier floor; deterministic
policy (not the model) sets the tier.

| Class | What | Path | Tier | May auto-apply? |
|---|---|---|---|---|
| F0 | Watch: the cause went away (a connection listening again) | `playbooks.settle` | 0 | yes |
| F1 | A catalogue repair (`recheck-worker`, `reconnect`, `resync`, `retry-backup`, `free-scratch`, `recheck-models`, `restart-runtime`, `clock`) | `playbooks.attempt` as today | 0 to 1 | yes, as today, within S2-R2 |
| F2 | Run a failed task again, once, only when the ledger's rerun rule says nothing outside happened | `ledger.retry` | the task's own tier | **new behaviour**, S2-R4 |
| F3 | A setting, decision template, trigger-rule pack or extension | the change pipeline, unchanged | 3 (proposed by Nova, as the foundry's are, `foundry.ts:6-8`) | no: stops at the tier boundary |
| F4 | A change to Nova's code | a coding run on Nova's repository → merge (tier 3) → release → supervisor deploy (tier 3) | 3 | no: proposal only (S2-R6) |
| F5 | Networking, vault, security, permissions, deletion | none | 3 | never by the loop; steps for the person only (M10 networking rule, `docs/plans/M10.md:105-110`) |

**Which tiers may auto-apply** is the owner's (S2-R2). The tier ruling's direction ("most or all
without asking, or at least have settings to allow that", decision 8) makes it a setting; this design
proposes the default ceiling at tier 1 (act and report) and keeps the three floors that ruling lists.

**At a tier boundary** the incident stops, records the prepared fix with its test proof, rollback
proof and evidence, and moves to `needs_you`. The person sees one sheet: what broke, what Nova found,
the fix, its test, its rollback, and the tier's own approval (a change's "Ship it", a coding run's
merge sheet, the supervisor's deploy confirm). Nova never raises a fix's tier by itself to get past a
boundary, and never lowers one.

**Code changes** go through the existing pieces only: the coding run's write, Nova's own test run at
the exact commit, the tier-3 merge, then a tagged release through the supervisor's sandbox, smoke
probes, canary and automatic rollback (M7 plan §2). The missing joint (a merged commit becoming a
release offered for deploy) is not designed here; it needs its own ADR (S2-R6, and R11's second half).

## 6. "Test and rollback or it doesn't ship", made mechanical

A frozen gate in core, `shippable(fix)`, alongside `gates.ts`, under the same protection (a change
that names it or targets it is refused, `gates.ts:33-36`). It runs before any fix is applied or
offered, and records its proofs on the incident. Missing proof: the fix is refused with the reason,
and the incident goes to `needs_you`. It is never waived by a setting.

**The regression test exists and catches the failure (red, then green):**
1. The fix names a test (`test_ref`) that is part of what ships: in the change's package for F3, in
   the commit for F4.
2. In a sandbox on a snapshot of the current state (the pipeline's `VACUUM INTO` sandbox; the coding
   run's checkout at the base commit), the test **fails**. A test that passes on the broken state
   proves nothing and refuses the fix.
3. With the fix applied in the same sandbox, the test **passes**, and so does the rest of the suite or
   the change's existing tests.
4. Empty or skipped-only runs are failures (the false-pass guard the batch's item 3 names).
5. The test stays: for F4 it is in the repository; for F3 it is in the change's release; a later change
   that removes it is refused while the incident is within its watch window.

**The rollback exists and works:**
1. The fix names its rollback (`rollback_ref`): the pipeline's `previous` snapshot for F3, the
   previous release slot for F4, "no state changed" for F0 and F1.
2. In the sandbox: apply, then roll back, then compare a digest of the touched state with the digest
   before apply. Unequal refuses the fix.
3. A fix whose rollback cannot be proved (a migration on a code fix, where the supervisor would refuse
   to roll back once anything is written, `src/supervisor/releases.ts:5-9`) is not shippable by the
   loop: it goes to the person.

**F1 repairs have no artifact to test.** They change no data by construction (`playbooks.ts:3-6`).
Whether that satisfies the batch's rule, or each catalogue repair must carry a permanent test in the
suite that a registry test enforces by name, is S2-R3.

## 7. Verify and journal

**Verify.** The verifier is never the fixer (the batch's item 3 invariant; ADR-8's "Nova checks the
work itself"). Mechanically:
- The verifier is the **detector**: it re-reads the invariant that broke (the next scheduled run ends
  done, the health check reads ok, the connection is listening, the drill passes), at least three
  times or across one full run of the failing thing, the way a canary needs `MIN_PROBE_RUNS`
  (`gates.ts:25`).
- For F3 and F4 the pipeline's canary probes are also required; the incident adds its invariant to the
  canary's own probe.
- The identity recorded in `verification.by` must differ from `fix.ref`'s actor; the build tests this.
- A repair's own "ok" is an attempt outcome, not a verification. Today a repair may close its own
  problem (`playbooks.ts:305`); under incidents the problem closes when the incident is verified.
- Which seat or model is the verifier where a person or a second model is needed is R19.

**Journal.** Every state change is a ledger event, and the closed incident (what broke, evidence
references, diagnosis, fix, test proof, rollback proof, verification, outcome) is the account. The
decision journal is specified but not built (CAPABILITY-INVENTORY:18). Whether incidents are the
journal for now, or the decision journal is built first and incidents write into it, is S2-R7. In no
case is the journal built on the handoffs mailbox (F-049, parked).

## 8. D5 amber timing and conflict C5 (options, not decided)

**The batch:** "a failed task is "Needs you" amber only after the fix attempt fails or hits a tier
boundary." **The ledger** (`2026-11-10-status-truth.md`): "Per D5 a failed task's problem is raised
without `stops` (ledger.ts) and migration 0028 makes the ones already open amber." The code raises it
at once (`ledger.ts:667`) and the UI maps a failed task to needs-you (`ui/js/status.js:154`, `:164`).
No fix attempt precedes amber. This is R10; the options it carries:

- **A. Keep D5 as built.** Amber at once; the incident runs beside it and a verified fix clears it. No
  change to `ledger.ts`, migration 0028, `severity()` or the status-truth tests. The person sees amber
  for failures Nova then fixes by itself.
- **B. The batch's reading.** While an incident is working on a failed task, the problem shows as
  "Nova is fixing this" (not amber; a working state such as the orb's existing `working`); it turns
  amber when the fix fails, reaches a tier boundary, the catalogue has no fix, a loop limit stops it,
  or the kill switch is off or at observe. Changes: `ledger.ts:661-668`, `severity()`
  (`ui/js/status.js:105-112`), the failed-task mapping (`:154`, `:164`), `orb-states.md`, and the
  status-truth browser tests, amended in the open.
- **C. B with a deadline.** As B, and amber anyway if the incident has not resolved within a fixed
  time (for example 10 minutes), so a slow or stuck attempt never hides a failure.

Either way, the red sources stay red, and a failed task's own row still says "Failed". This record
recommends nothing on A to C; it notes only that B and C need a visible "being fixed" state so the
status never claims "nothing needs you" while work is failing.

## 9. Loop safety

- **One incident per fingerprint**, as `openFor` (`playbooks.ts:238-248`): the same thing failing
  again adds to the open one.
- **Attempts:** at most 3 fix attempts per incident, at least a minute apart (today's
  `AUTO_TRIES`/`AUTO_SPACING_MS`, `playbooks.ts:175-176`).
- **Rates (proposed, S2-R9):** at most 10 incidents opened per hour and 3 fixes applied per day across
  Nova; past either, new incidents go straight to `needs_you` with "Nova has done as much fixing as it
  may today."
- **No fix of a fix.** An incident whose problem comes from an incident's own work (a task of the
  `self-repair` worker, a change or coding run it proposed, a release it shipped) records `parent_id`
  and is never fixed by the loop: the parent fix is rolled back if it is still in its watch window,
  and both go to the person. Depth for automatic work is zero.
- **Flapping.** An invariant that breaks again within the watch window after a verified fix reopens
  that incident (I10); a second time, it goes to the person and the fix class is not tried again for
  that fingerprint until the person closes it.
- **Kill switch (S2-R1):** one core setting, `self_repair`: `off` (problems and playbooks exactly as
  today), `observe` (incidents with evidence and diagnosis, no fix of any class beyond today's F0/F1),
  `repair` (fixes within the auto-apply ceiling). Turning it down is open to any paired device;
  turning it up is a loosening (S2-R10). The setting and the loop's limits are core, outside the
  change pipeline's reach (a change naming them is refused, as for gates).
- **The implementer never verifies** (section 7).
- **The hub only.** The loop runs in the hub's heartbeat; a standby runs none of it
  (`src/core/index.ts:1752`).
- **The loop never touches** the gates, tiers, playbook catalogue, its own limits or the kill switch.

## 10. Security

- Evidence is redacted by the diagnostics rule before it is stored or shown to a model (section 3).
- A model call obeys the privacy mode, leaves a receipt and passes the outbound guard; local-only is
  absolute.
- Evidence that may hold outside content taints the incident's run, so guarded steps ask.
- Model output picks from a closed list; it names no command, file or URL that runs.
- F5 classes never apply automatically; security refusals open evidence-only incidents (S2-R11).
- Every fix the loop applies is reversible by construction (section 6), recorded as act-and-report,
  and undoable by the person.

## 11. What this does not touch

- **F-012** (conversation deletion), **F-049** (handoffs workflow; no part of the loop or its journal
  uses `.github/workflows/handoffs.yml` or `handoffs/inbox/`), **Jarvis promotion**, **D8
  Interstitial Part 3** (no Interstitial eval runs, `features.interstitial` untouched; the diagnosis
  step is not the Research skill), **slice 1b of ADR #481**, and **PR #207**.
- D5 as built: no code of section 8 changes until R10 is answered.
- The known pipeline issues listed in the reconciliation (`:66-69`): an incident is never raised from
  repository CI in any case (S2-R13).

## 12. Acceptance criteria for a later build

Each becomes at least one test that fails on the code before it.

1. A failed task, a dropped scheduled run, a failing health check and a rolled-back change each open
   exactly one incident with the right invariant; the same failure again adds to it.
2. An unclassified problem opens an incident (I9) and, with the switch at `observe`, ends `observed`
   with an evidence bundle and no action.
3. The evidence bundle of a task whose title, brief and detail carry a planted secret and a planted
   memory sentence contains neither; it never exceeds 32 KB.
4. Under local-only, a diagnosis calls no remote endpoint (the cloud stand-in receives zero requests);
   with no local model it ends `needs_you` without a call.
5. A diagnosis over its call or token bound stops at the bound and goes to `needs_you`.
6. `shippable` refuses a fix with no test, a test that passes on the broken state, an empty or
   skipped-only run, no rollback, or a rollback whose digest differs; each refusal is recorded.
7. A fix above the auto-apply ceiling is never applied; the incident waits at `needs_you` with the
   prepared fix and its proofs.
8. `verification.by` never equals the fixer; an incident cannot reach `resolved` from a repair's own
   "ok".
9. A problem caused by an incident's own fix is not fixed by the loop; the parent is rolled back in its
   window.
10. Past 3 attempts, 10 incidents an hour or 3 fixes a day, nothing more is applied.
11. `self_repair: off` reproduces today's behaviour exactly (the existing playbook and status tests pass
    unchanged).
12. A change naming `self_repair`, the loop's limits or `shippable` is refused before the sandbox.
13. Whatever R10 decides is asserted in the browser across the mark, the Health badge, Home and Health,
    as the status-truth tests do.
14. A closed incident's account survives a restart and a failover to the standby.

## 13. Slices (smallest useful first)

1. **Incidents, observe only.** The table, the opener on the `problem` event, the invariant list,
   the deterministic collectors with the diagnostics redaction, the playbook attempts recorded on the
   incident, the kill switch (`off` and `observe`), and an "What Nova looked at" section on a problem
   in Health. No model, no new fix, no change to amber (independent of R10). Value: every failure
   gets one evidence-backed record, and every unclassified problem stops being invisible to Nova.
   Criteria 1 to 3, 11, 12, 14.
2. **Deterministic fixes and independent verification.** F0 and F1 move under incidents with the
   detector as verifier; F2 if S2-R4 allows; the R10 option applied here; loop limits. Criteria 7 to
   10, 13.
3. **Local diagnosis.** The bounded local-model diagnosis for I9 and failed repairs, output shown,
   no new action. Criteria 4, 5.
4. **F3 through the change pipeline** with `shippable`. Criterion 6.
5. **F4 code fixes as proposals**, then, after its own ADR, the merge-to-release joint.

**Proposed first slice:** slice 1. It changes nothing the person relies on, needs none of the open
rulings except S2-R1's switch default and S2-R8's retention, and every later slice builds on its record.

## Rejected alternatives

- **One script per known failure.** The batch forbids it, and the playbook catalogue already shows the
  limit: anything its words don't match gets nothing.
- **Replace the playbooks outright.** Loses tested, safe repairs and their wording for no gain; the
  incident can carry them (the choice remains R11).
- **Let the model apply fixes.** ADR-7: a model never acts alone on a consequential decision.
- **A new pipeline for self-fixes.** ADR-9 already names the path; a second one would be a way around
  the gates.

## Consequences

- One more table and worker; the problem stays the person-facing unit, the incident the working one.
- Verification moves out of the repairs: a repair can no longer close its own problem once incidents
  own it, which slows some closes by one verification read.
- Under R10's options B or C, "Needs you" means "Nova could not fix it", which changes what the status
  tests assert.

## Ruling list for the owner

Carried over from the reconciliation, not duplicated: **R10** (C5: D5 timing; this record adds the
options in section 8, including C, a deadline), **R11** (generalise or replace the playbooks, and
whether code fixes go through ADR-9 with tier 3 for core; this record recommends generalising), and
**R19** (which seat or model is the Verifier where one is needed beyond the detector).

- **S2-R1:** the kill switch's default at first build: `off`, `observe`, or `repair`?
- **S2-R2:** which tiers may a fix auto-apply at: tier 0 only, tiers 0 and 1 (act and report), or a per-fix-class setting under the tier ruling's decision 8?
- **S2-R3:** do catalogue repairs that change no data (restart, reconnect, resync) satisfy "test and rollback" as they are, or must each carry a permanent test enforced by name?
- **S2-R4:** may Nova run a failed task again once by itself when the ledger's rerun rule says nothing outside happened, or does a failed task stay yours to retry (`repairs.ts:78`)?
- **S2-R5:** diagnosis model: none until slice 3, the local model only, or a cloud model inside the privacy mode once you lift the no-paid-calls order?
- **S2-R6:** code fixes to Nova: proposal only (a branch with a red-then-green test, stopping at the tier-3 merge), or also a merge-to-release-to-deploy path under its own ADR?
- **S2-R7:** the journal: closed incidents plus ledger events for now, or build the decision journal first and write incidents into it?
- **S2-R8:** how long closed incidents keep their evidence references: 30 days, 90 days, or as long as the problem rows (no pruning today)?
- **S2-R9:** the loop's rates: accept 3 attempts per incident, 10 incidents an hour and 3 applied fixes a day, or set others?
- **S2-R10:** who may turn the switch up: tier 3 with a passkey on Nova's own screen, or any paired device as for Home Assistant settings (tier ruling decision 6)?
- **S2-R11:** the red sources (security refusals, a fired dead-man's switch, a failed rollback): evidence-only incidents, full incidents, or no incidents at all?
- **S2-R12:** start with slice 1 (observe-only incidents), or begin at slice 2 (deterministic fixes) once R10 is answered?
- **S2-R13:** does "a check went red" mean Nova's own health checks and canary probes only, or also the repository's CI through a new connector?
