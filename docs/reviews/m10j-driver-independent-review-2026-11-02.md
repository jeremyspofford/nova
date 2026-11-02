# Task 2 independent review

Spec compliance: issues found. `specPass=false`. Task quality: Needs fixes. `qualityApproved=false`.

Reviewed base `5f53dee7a6f7bab98354c4052f937cc46c084cf4` through initial head `e72d920e193dff7e12376de7eea75e30ead4d828`, plus the small follow-up to final head `aa78db6721462132f4348093f2923e98f6cd55b9`. This is the Task 2 gate, not a whole-branch or merge review.

## Strengths

- `src/core/services/k3s/tools.ts:37` and `src/core/services/k3s/driver.ts:60`: default availability and queued operations fail closed without executable discovery or credential access. Unsupported state/non-full alongside modes, missing network authority and secret references are explicitly refused in plan/apply.
- `tests/support/k3s.ts:44` and `scripts/stand-ins/k3s-simulation.js:36`: actual child programs use fixture-only PATH/HOME and bounded argv/stdin/output. The fake independently checks namespace/cluster/schema and excludes arbitrary manifest routes; it does not call the production renderer.
- `scripts/stand-ins/k3s-simulation.js:54` and `src/core/services/k3s/driver.ts:100`: cross-process lock ownership, atomic revision/semantic-state comparison, and shared per-service serialization cover distinct concurrency boundaries. Queued expected-state and changed previous-target tests exercise real mutations.
- `src/core/services/k3s/driver.ts:113`: HTTP probes use an injected loopback origin, confined paths, response/deadline bounds, and no redirect following. Canary/readiness constants and injected-clock tests preserve 120000/5000/three-success behavior.
- `src/core/services/k3s/registry.ts:19`: immutable version registration uses exclusive creation and detects concurrent conflicting definitions. Unknown prepare completion is not replayed; cancellation clears owned timers without claiming a successful interrupted canary.
- `scripts/stand-ins/k3s-simulation.js:95` in the final delta: rollback restores the observed retained replica count rather than assuming one. The corresponding two-replica regression and actual RED/GREEN evidence support this fix.
- `tests/supervisor/services-review.test.ts:541` and `tests/core/k3s-tools.test.ts:62`: exclusions are exact known modules; the positive literal and executable tripwire checks remain present.

## Issues

### Critical

None found.

### Important

1. **Stale measured health authorizes automatic effects.** `src/core/services/k3s/driver.ts:199` and `:200`. `#accept` (`:84`) checks snapshot freshness and health timestamp non-regression, but intentionally permits an older independent health measurement. `refresh()` then tests only `live.health.ok`: stale true can delete the only kept rollback target after soak expiry; stale false can trigger rollback despite no current failure measurement. A fresh control-plane observation does not establish fresh workload health. Preserve the old health and its timestamp for display, but require timely independently measured health before either automatic effect; stale or unknown measurements must retain the previous version and avoid automatic routing changes. Add focused regression cases for stale true and stale false, followed by fresh measurements proving the normal effects still occur. Existing `tests/core/k3s-review.test.ts:87` covers unknown/healthy/unhealthy but does not separate snapshot age from measurement age.

   Confirmed with one read-only injected-port probe: clock `2026-11-02T12:10:00.000Z`, snapshot observed_at equal to clock, live health `{ok:true, checked_at:"2026-11-02T12:00:00.000Z"}`, previous `1`, live `2`, soak_until `12:05`. The actual output was:

   ```json
   {"result":{"ok":true,"said":"Collected actual cluster observations."},"calls":["status","remove"],"health":{"ok":true,"checked_at":"2026-11-02T12:00:00.000Z","said":null},"previous":null}
   ```

   Probe exit status was 0. It used the injected port only, wrote no files, performed no network/child/resource action, and did not rerun a suite. The stale-false path follows the same missing freshness predicate at line 199; no second probe was necessary.

### Minor

None recorded.

## Evidence checked

- Read the brief, binding constraints, reviewer template, and implementer report; treated claims as unverified until matched to diff/evidence.
- Read all 16 initial changed-file hunks and the two-file follow-up delta. The first combined tool output was truncated; only omitted sections were recovered in bounded reads. No changed source file was separately opened. A line-location pass derived references from the package; no git command, broad crawl, or suite rerun was performed.
- Named focused unchanged-source check: malformed semantic-state risk at the observation boundary. Read only `src/core/services/expected.ts` to verify the exact `serviceExpected`, `validServiceExpected`, and comparison behavior consumed by the driver.
- Saved `task-2-final-focused.log`: 47 passed, exit 0; `task-2-green-replicas.log`: 12 passed, exit 0 after retained-preview fix. These represent 48 distinct focused tests, not a single 48-test run.
- Saved `task-2-affected.log`: 71 passed, exit 0; `task-2-boundary.log`: 1 passed, exit 0; `task-2-final-typecheck.log`: exit 0. Recorded outer tripwires never fired.
- Saved RED logs show six missing-driver failures, two lock/malformed-boundary failures, two observation-provenance failures, and retained-preview resurrection rejection failure. They contain actual assertion failures and exit 1, not reconstructed historical evidence.
- `task-2-fake-processes.log` contains actual Helm/Flux/kubectl argv, stdout and exit statuses, including rejected invalid namespace with child exit 1. Fake Flux records watched services only.
- Final follow-up `task-2-red-floating.log` records actual 1-versus-2 failure; `task-2-green-floating.log` records 3 passing targeted tests and exit 0, including shared contract/canary and floating rollback. `task-2-floating-typecheck.log` exits 0. Final combined coverage is 49 distinct focused tests across separate runs; no single 49-test run is claimed.
- Final evidence inspected has no unexplained warnings. npm notices are ordinary command reporting; the expected invalid-input child stderr and deliberately planted tripwire failure are asserted negative-test evidence.

## Cannot verify / declined scope

- Real broker-backed launching, credentials, M10d approval/snapshot/dead-man integration, actual K3s/Helm/Flux behavior, storage/singleton capability, and production health are absent by accepted scope. They remain future work; no production/real-resource proof is claimed and #275 stays parked.
- Interrupted-canary completion is explicitly unverified. Selector state, elapsed time, and a healthy refresh do not prove completion. Task 3 must reconcile through its existing WorkLedger/Waiting handling without replay; this review does not request a new recovery authority.
- Task 1 chart semantics were already reviewed. This review checked the consumed type/helper/export changes and schema-evaluator extraction, not a new Task 1 audit.
- Only the reviewer report was written. Source, index, HEAD, branches, other worktrees and other agents’ processes were untouched.

## Assessment

Task quality: Needs fixes. The simulation boundaries, independent child validation, CAS and confinement are well covered, but fresh snapshot time currently substitutes for fresh health when authorizing automatic cleanup or rollback. Resolve Important finding 1 before accepting Task 2.
