# M10i scoped final-fix re-review

**Verdict: PASS. I1 and I2 are ADDRESSED; no new Critical, Important or Minor findings.** Final exact-head CI remains a separate gate, so this is code-review clearance rather than a claim that the branch has completed all merge gates.

Reviewed `ff36c17501972ab71b9d311c14843c449d4ebc46` → verified HEAD `fb940ce13cc1c85dd25a3c552e9406d666615c07`. Read the final-fix brief and report, then the complete 464-line supplied fix package once in bounded chunks. Scope is the two findings in `final-review.md`, the explicitly authorized Serving-label integration, and breakage introduced by this fix. Inspected surrounding provenance/merge code and actual recorded logs; no suite rerun or probe was necessary. Only this report was written. Source, index, HEAD and branch state were not changed; existing coordinator documentation changes were left alone.

## Strengths

- The correction models measured health and current stopped-state evidence separately, using the existing observation merge and expiry machinery instead of changing its severity rules.
- The native failure rule binds to the actual live assignment, report status and hub receipt time. It does not turn a failed candidate into failed serving work.
- Safe fixed reasons retain the normalized hold occurrence time without copying supervisor/device output, paths or arbitrary failure strings.
- The UI correction changes only the current-serving claim. Driver identities, approval expected state and mutation authority remain intact.

## Original findings

### I1 — ADDRESSED

**Code:** `src/core/services/topology.ts:170`, `:173`, `:185`, `:205`, `:206`.

Measured health keeps `health.checked_at`. A held latch adds a separate Failed observation timed by `state.observed_at`; the normalized `held.at` is retained as the occurrence time in its safe reason. Consequently both a new hold and an old hold freshly attested by the supervisor remain Failed even when measured health is old or absent. Stopped-console evidence uses the same independent current-state provenance.

The shared normalizer at `src/core/services/topology.ts:55` independently expires those observations. A missing state attestation reaches it as null and therefore unknown; it cannot borrow a fresh health check. An old attestation similarly cannot become current through a newer health measurement. Removing the hold/stop does not revive old measured health. No global timestamp replacement was introduced, and version readiness continues to use its own report when present.

**Evidence:** `tests/core/topology.test.ts:141`, `:161`, `:174` cover hold occurrence versus observation time, old/fresh/missing measured health, expiry and recovery; `tests/core/topology-api.test.ts:215` covers the API projection, hold occurrence privacy, stopped/recovery transitions and unchanged `rollback.expected.live`. Missing state attestation is verified by the explicit null path and common normalizer, not claimed as a newly executed dedicated regression. Existing stale-live and old-ready tests remain green in the inspected 19-test log.

### I2 — ADDRESSED

**Code:** `src/core/services/topology.ts:178`, `:180`, `:182`; `src/core/services/workloads.ts:220`.

A native Failed observation now requires all of: no observed live version, current assignment wanting live, that assigned version reported failed, and a valid matching receipt at or after assignment time. Its age is the matching hub receipt, independently of device heartbeat, measured health and other versions' readiness. The adapter no longer supplies an arbitrary newest report as measured-health provenance.

The real enrollment/deploy/ready/promote/failed API scenario now reports Failed without inventing a serving version. Its failure becomes unknown at the 120,000 ms boundary despite a new heartbeat, and a fresh healthy live report recovers to Verified. A failed unrelated alongside candidate does not override healthy serving work; an assigned failed target also does not replace an independently observed live version's unknown health. A kept version alone is not treated as serving. Reports predating the assignment are excluded.

**Evidence:** `tests/core/topology-api.test.ts:146` covers the real hub path, receipt age, expiry, recovery, unrelated candidate, surviving live version and null-health/kept transitions. `tests/core/topology.test.ts:189` covers assignment intent, identity, stale and pre-assignment receipts, observed live and preservation of old readiness age. These tests appear in the inspected GREEN log.

### Authorized Serving-label integration — ADDRESSED

**Code:** `ui/js/topology.js:46`, `:52`, `:54`; regression `tests/ui/m10i-topology.test.ts:511`.

“Serving on this machine” requires the version to match the driver's live identity, current merged healthy evidence and no stale service context. Held, stopped, expired and fresh null-health observations use “Last reported live; current serving is unverified.” The healthy control retains Serving. The change does not rewrite `live`, `previous`, assignment, expected-state guards, tiers or request payloads.

The focused browser RED log shows the prior incorrect Failed-plus-Serving output; the GREEN log records the new regression passing alongside existing independent-expiry and replacement-sheet coverage. Inspected `/tmp/m10i-final-fix-stale-service-desktop.png`: the retained stale-state layout remains legible; its lower version-copy area is clipped by the screenshot viewport, so the exact changed copy is substantiated by the DOM regression rather than a claim of full screenshot visibility.

## New issues

### Critical

None found.

### Important

None found.

### Minor

None found.

## Validation reviewed

Inspected actual `/tmp/m10i-final-fix-*.log` outputs and matched relevant named tests to the read source:

- `red`: 18 tests, 14 pass, 4 fail, 0 skipped; failures expose Waiting where current held/stopped/native failure should be Failed.
- `ui-red`: the Serving regression fails on held output containing “Serving on this machine.”
- `green`: 19 tests, 19 pass, 0 fail, 0 skipped; includes the prior stale-live/readiness regressions and both new API scenarios.
- `nearby`: 77 tests, 77 pass, 0 fail, 0 skipped; includes execution-time expected-state guards, actual HTTP→IPC delay/queue coverage, native atomic state binding and actual workload/supervisor behavior. As disclosed in the implementation report, this run precedes only the final safe held-reason wording; the final 19-test run covers that wording.
- `ui-green`: 7 tests, 7 pass, 0 fail, 0 skipped; includes independent failed/degraded expiry, merged evidence/export, late replacement-sheet behavior and Serving claims.
- `boundary`: 1 pass, 0 fail, 0 skipped. `typecheck`: TypeScript invocation with no diagnostic errors.

The test logs report the no-Kubernetes tripwire never fired. No broad suite was rerun or historical failure reclassified. No new source dependencies, migration or external-resource operations appear in this six-file change.

## Recommendations

Proceed to the separately required exact-head final CI gate. No further fix wave is requested by this scoped review.

## Declined to judge / out-of-scope observations

- A new whole-branch review of unchanged behavior: explicitly excluded from this scoped re-review; the prior whole-branch review and its retained limitations remain the baseline.
- Real-device, Kubernetes, platform capture and deployment behavior: no such resources were exercised; this patch changes projections and UI copy rather than those authorities.
- New visual approval or a full cross-browser/mobile audit: not authorized or necessary for the minimal existing-row copy change; inspected the supplied screenshot and focused DOM evidence only.
- Final exact-head CI and merge readiness beyond code review: separate pending controller gate; the inspected scoped logs do not substitute for it.
- Coordinator documentation outside the fix package: deliberately excluded from this code verdict and left unchanged.

## Assessment

**Ready to merge? Yes from this scoped code review, subject to the separate final CI gate.** Both original failure-projection defects are corrected with independent provenance, and the Serving copy now respects that evidence without altering guard identities. No new actionable defect was found in the supplied correction.
