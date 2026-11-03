# Task 2 review

## Spec compliance

**Issues found.** The implementation meets the principal collection, fixed IPC, authorization, policy, and snapshot-export requirements, but can mark stale readiness evidence as freshly Verified. This violates the binding stale-observation/Verified-evidence requirement; see Important finding I1.

Reviewed package: `12f506b26fece73deec7fa656798fe2ca61e9706..e9062236`. The package header supplies the abbreviated head, not its full SHA. No git commands were run.

**Cannot verify from this task diff:** Task 3 retained-snapshot aging, approval presentation and retry behavior, rendered/export correspondence in the application, keyboard/mobile behavior, and M9 interaction budgets remain controller/integration gates. This backend review does not establish whole-branch or final full-suite green.

## Strengths

- `src/core/services/topology.ts:157` projects safe service fields and generic health explanations rather than raw diagnostic output; `src/core/services/topology.ts:173` distinguishes unavailable managed state from an intentionally unsupervised process.
- `src/core/services/workloads.ts:210` keeps assignment intent separate from observed serving state; the native API tests exercise that distinction and revoked-device filtering (`tests/core/topology-api.test.ts:40`).
- Shared manager checks remain authoritative, including execution-time revalidation. Supervisor IPC acknowledges acceptance explicitly and reports eventual refusal through existing problems (`src/supervisor/supervisor.ts:379`, `src/supervisor/supervisor.ts:389`). Real supervisor tests cover ordinary, privileged, capture, and console changes (`tests/core/topology-actions.test.ts:9`, `tests/core/topology-actions.test.ts:62`).
- The literal Mermaid test checks generated identifiers and hostile-name escaping against an exact snapshot (`tests/core/topology.test.ts:37`).

## Issues

### Critical

None found.

### Important

**I1 — A fresh report for another version refreshes stale readiness evidence.** `src/core/services/workloads.ts:210` uses the newest report timestamp whenever `s.live` is null. `src/core/services/topology.ts:158` independently derives healthy service state from any `ready` version, and `src/core/services/topology.ts:160` applies that newest timestamp to the readiness claim. With no live version, an hour-old v1 ready report and a newly failed v2 report produce `health: healthy`, `status: Verified`, `age_ms: 0`, and “A version passed its readiness checks.” The only readiness evidence is stale. This is the no-live counterpart to the old-live-report regression already covered at `tests/core/topology.test.ts:59`.

Bind readiness-derived health to the hub-received timestamp of the version that supplies that evidence, or preserve per-version observations and derive aggregate freshness from those. Add a regression with an old ready version, no live version, and a fresh unrelated failed/installed report. The overall service must not become freshly Verified.

### Minor

**M1 — Full-suite output contains unclassified runtime warnings.** `/tmp/m10i-task2-full.log:834` reports DEP0187 (`fs.existsSync` invalid argument types); `/tmp/m10i-task2-full.log:1339`, `:1604`, and `:1615` report unavailable experimental localStorage. These are not established as introduced by Task 2, and do not independently block its code. The controller should record attribution or follow-up rather than treating the full-run output as pristine.

## Checks and scope

- Read the task brief, binding constraints, implementation report, reviewer template, and supplied diff once in sequential chunks. No source, index, branch, process, network configuration, or protected workspace mutations; only this requested review artifact was written.
- Named outside-diff risk: whether the new policy publication could recurse through driver status or interfere with asynchronous execution. Checked the unchanged `SupervisorDriver.status`, `switch`, `rollback`, and save callback in `src/supervisor/services.ts:274`, `:403`, `:494`, and `:982`; status is a projection and driver execution retains its existing serialization.
- Named context-cutoff risk: whether `s.live`/`health.checked_at` really select a per-version live report, and what reports survive when no version is live. The workload status hunk begins mid-function, so checked its preceding unchanged implementation at `src/core/services/workloads.ts:183`. It confirms the no-live case and persisted version report list used by I1. No other changed-file rereads.
- Ran one focused pure-model probe using Node 26.3.1 and `projectService` plus `buildTopology`: v1 ready at 11:00, v2 failed at 12:00, no live version, capture at 12:00. Observed healthy/Verified with a 12:00 readiness observation despite v1's retained `observed_at` being 11:00. No test suite was rerun.
- Inspected existing RED logs: missing model/read route, missing fixed mutation route, and worse-source service merge failure are present. Existing focused log records 75/75; final boundary-fix log records 24/24; final typecheck log shows the reported tsc command without errors.
- Existing full-run evidence is 1608 tests, 1591 pass, 3 fail, 14 skip. The boundary violation was fixed and targeted checks passed. M6a recovery (`tests/acceptance/m6a-capture.test.ts:69`) and onboarding discovery (`tests/core/onboard.test.ts:101`) remain unresolved observed failures. Their attribution cannot be established from this task diff; no second full suite was run.

## Assessment

**Task quality: Needs fixes.**

The fixed mutation bridge and source projections are appropriately scoped, with substantial real-path verification. Correct I1 before Task 3 relies on the DTO's health/freshness contract; the current snapshot can present stale evidence as freshly Verified.
