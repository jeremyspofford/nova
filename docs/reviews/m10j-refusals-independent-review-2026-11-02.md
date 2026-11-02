# Task 4 independent review — safe Step1 only

Spec compliance: **PASS for the controller's safe Step1 scope.** Task quality: **APPROVED.** Critical: **0**; Important: **0**; Minor: **0**. This approves the test-only refusal coverage, not Task4 completion or the full production phase gate.

Reviewed BASE `ec703e7dec07b396605f9de80da3cf4469367177` to HEAD `542dc064e0e3f39535a9c5f19a8fffb598b95812`, using `review-ec703e7d..542dc064.diff`. Its scope is one test file, 85 insertions and 17 deletions. The implementer's report was treated as claims and compared with the diff and saved command output. No production, broker, runner, runtime dependency, or application UI change is present.

## Strengths and spec checks

1. **Actual API refusal matrix:** `tests/core/k3s-operations.test.ts:158` defines missing, explicit-unavailable, wrong-api-cluster and hostile-ambient cases; `:210` submits all four fixed network/deploy/promote/rollback operations through the existing actual-Core console fixture. `:212` supplies rollback's previous version and `:213` supplies deploy's required network-change shape. `:216` and `:217` distinguish unavailable capability from unknown registration, rather than accepting any failure response. Unchanged request validation in `src/core/services/k3s/operations.ts:175` and registration lookup at `:76` support this interpretation.
2. **Refusal before effects:** `tests/core/k3s-operations.test.ts:195` counts every execute call, including status; `:203` and `:204` replace both legacy value lookup methods with counted failures. Each request checks zero execute calls, private spawn marker, value reads, target HTTP hits, fake calls and child transcript at `:218`; unchanged ledger tasks, network changes, target text and simulator state are checked at `:224`. These exercise observable behavior, not source text.
3. **Ambient inputs precede Core initialization:** the minimal synchronous hook at `tests/core/k3s-operations.test.ts:15` runs before the existing hub/Core construction. Private HOME/PATH are installed at `:183`; the hostile case adds an owned kubeconfig containing a synthetic token/exec plugin and the real test-only simulator state path at `:185`. Missing/hostile cases omit the tools option; explicit-unavailable delegates to the real unavailable provider at `:198`. No fake production mode or positive broker adapter is introduced.
4. **Marker positive control and cleanup:** `tests/core/k3s-operations.test.ts:173` creates only private Node marker programs. `:177` executes the private marker, verifies exit97, its hit and both canary output streams, then `:182` removes the planted hit before Core construction. `:231` checks refused API output, ledger rows, child transcript and Core log for the canary; `:232` preserves the hostile kubeconfig. `:234` stops the fixture and `:235` restores all changed environment values even when stop fails. A hook failure closes the simulator at `:16`.

## Findings

- **Critical (C):** None.
- **Important (I):** None.
- **Minor (M):** None.

## Verification evidence

1. `.superpowers/sdd/M10j/task-4-focused-final.log:6` through `:12` records the final four matrix cases and the selected existing API/security/revocation checks. `:13` through `:19` records **11 tests, 11 passes, zero failures/cancellations/skips/todo**; `:21` records **outer tripwire never fired**, and `:23` records **EXIT_STATUS=0**.
2. `.superpowers/sdd/M10j/task-4-typecheck-final.log:1` records the typecheck command and `:4` records **EXIT_STATUS=0**. Its npm run notices are routine command notices, not warnings.
3. `.superpowers/sdd/M10j/task-4-diff-check.log:2` records **EXIT_STATUS=0**. `.superpowers/sdd/M10j/task-4-final-state.log:1` records the reviewed HEAD, `:2` records the sole source path, `:3` records a clean tracked worktree, and `:6` records no remaining task tool/test processes. These are saved evidence, not fresh reviewer state checks.
4. `.superpowers/sdd/M10j/task-4-focused-initial.log:6` through `:16` retains the earlier **4/4 immediate GREEN**, zero skips, no outer tripwire hit, exit0. That run preceded the final private marker positive control and private-HOME tightening; it is not substituted for the final 11/11 evidence. No manufactured RED or production fix is claimed.
5. Reviewer checks were read-only apart from this requested ignored review report. The supplied diff was read once. Its setup hunk ended mid-function, so the existing continuation was inspected at `tests/core/k3s-operations.test.ts:27` through `:77`; no changed lines were reread. Named unchanged-code risk checks: (a) whether initialization/fake executions could escape the counters or cleanup — inspected `tests/support/k3s.ts:25` through `:86`, including persistent calls/transcript and disposable-home removal; (b) whether malformed requests could masquerade as capability refusals — inspected the focused validation/registration/operation guards in `src/core/services/k3s/operations.ts:76`, `:148`, `:175`, and `:189`. An initial guessed `src/core/k3s-operations.ts` path was absent; the actual module was located with bounded searches. No suite, focused probe, browser, real executable, external service, or credential was invoked by this review. Tasks1/2/3 were not re-reviewed.

## Explicit limits and remaining gate

1. **Task4 overall remains DEPENDENCY BLOCKED.** Actual P1a/P1b/P1c broker/launcher foundation is absent, #275 findings B are missing, and the owner's parked decision remains in force. The source-pinned adversarial broker review and full phase gate have not passed. Whole-branch adversarial review and CI remain the controller's later checkpoint.
2. Wrong requested API cluster is registration refusal only. It does not prove broker endpoint/namespace/grant binding, per-cluster credential separation, ticket replay prevention, program digest binding, or positive credential handoff.
3. The hostile simulator state intentionally contains a planted synthetic canary input. Refused-output checks do not establish positive-path privacy across every file, ledger event, repository, transcript or simulation state. The marker covers only the owned named tools/plugin; it is not arbitrary-process containment proof. The private marker positive control is not an invocation of an actual Kubernetes tool.
4. Still unproven until the real foundation/Step2: bound-tool-only secret access; 0700/0600 credential file lifetimes; cleanup on exit/error/abort/cancellation; tier3 setup/consent; and kubectl, Helm and Flux containment of ambient config/home/proxy/plugins, executable kubeconfigs, substituted endpoints and external files. No credentialed capability should be enabled on this review's authority.

Assessment: **Step1 spec PASS / quality APPROVED**, with no C/I/M findings. The change adds direct, measurable refusal coverage while preserving the explicit blocked broker gate.
