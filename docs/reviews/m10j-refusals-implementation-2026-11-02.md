> Safe Step1 acceptance: independent spec PASS / quality APPROVED, zero C/I/M, source `542dc064e0e3f39535a9c5f19a8fffb598b95812`. The historical implementation handoff below precedes that review. Full Task4 and the M10j phase remain NOT PASSED: actual P1a/P1b/P1c and #275 findings B are absent.

# Task4 Step1 — safe Core adapter/refusal proof

Status: **STEP1 DONE, pending controller independent review. Task4 overall remains DEPENDENCY BLOCKED.** Actual P1a/P1b/P1c broker/launcher foundation is absent and #275 findings B remain missing. The owner's parked decision is retained. This source does not implement a runner or credentialed capability, and does not satisfy the full M10j production gate.

Source commit: `542dc064e0e3f39535a9c5f19a8fffb598b95812`, parent/dispatch BASE `ec703e7dec07b396605f9de80da3cf4469367177`, branch `codex/m10j-k3s`. Preserved Task3 source `815960362fb40ad3e38ee0200fcbf7f595dea5b9`; no Task1/2/3 source or review was redone. Source-only commit contains exactly `tests/core/k3s-operations.test.ts` (85 insertions, 17 deletions). This report and `task-4-*.log` evidence remain local ignored artifacts for the controller, excluded from the source commit.

## Concrete change and proof

Expanded the existing actual-Core network/deploy refusal test into a four-case table. It reuses the existing `setup`, actual `createCore` through public index, real console API, Work Ledger, M10d target and owned simulator fixtures. The only setup extension is an optional synchronous `beforeCore` hook so private ambient inputs exist before Core initialization; a hook failure closes the simulator. No duplicate harness or test-file import was introduced.

Each case sends valid fixed `network`, `deploy`, `promote` and `rollback` requests: **16 API requests** in four tests. Rollback names its explicit previous version, and deploy supplies the syntactically valid existing network-change shape, so malformed input does not substitute for capability checks.

| Case | Programmed authority | Required API result |
| --- | --- | --- |
| missing | Core options omit `tools` entirely | All four refuse 409 with broker/capability diagnostic |
| explicit-unavailable | Explicit test provider delegates availability and execute to actual `unavailableClusterTools`; execute is counted | All four refuse 409 before execute |
| wrong-api-cluster | Explicit available existing simulation provider for the registered `simulation` cluster; requests name `other-cluster` | All four refuse 404, not registered, before execute |
| hostile-ambient | Core options omit `tools`, despite actual ambient HOME/PATH/KUBECONFIG/NOVA_SIM_STATE | All four refuse 409 with broker/capability diagnostic |

The wrong API cluster proof is strictly the requested identity/registration boundary. It is **not** broker-side wrong endpoint, grant or per-cluster credential isolation proof.

Each refusal checks zero **all** adapter execute calls, including status; zero private ambient spawn marker; zero `vault.get` or `vault.resolve` value lookups; zero owned target HTTP reads/writes; empty committed fake call list and child transcript; unchanged simulation state and target bytes; no new ledger task and no network change. Responses, ledger rows, simulator child transcript and Core log contain no synthetic canary. The hostile ambient kubeconfig remains byte-for-byte unchanged. These are assertions on actual API behavior and observable effects, not source-text checks.

Private PATH contains disposable marker executables for kubectl, helm, flux, k3s and the kubeconfig exec plugin. Their own Node shebang and builtin filesystem calls do not invoke host cluster programs. Before Core exists, the test intentionally executes the private kubectl marker once, confirms exit97, the recorded hit and synthetic canary stdout/stderr, then removes that planted marker. The zero-spawn observation starts before Core construction after this self-check. The outer tripwire remains armed; only these K3s-owned tests use their private PATH. Every case uses a disposable HOME, and all changed environment variables restore in finally.

The hostile case writes a private kubeconfig with a loopback server, synthetic token and executable plugin path, and sets the real test-only `NOVA_SIM_STATE` to an existing private simulator state file containing another synthetic credential field. No arbitrary fake production flag or pretend positive broker adapter was added. Core remains unavailable without its explicitly programmed provider. Fixtures create their existing dummy M10d token before the refusal boundary; subsequent API value lookups are intercepted and must stay zero. No owner secret/value is read by these interceptors.

The fixed operation table covers the four actionable proposal/network routes. General replicas already always refuses as unsupported, and existing retry/revocation tests remain authoritative for previously created work. This dispatch does not invent a positive runner contract to exercise those paths.

## Actual verification

All commands ran in the explicit original checkout `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build`, using existing Node `v26.3.1`. Logs contain actual output and appended `EXIT_STATUS`.

- `task-4-focused-initial.log`: `sh scripts/test.sh --test-name-pattern='Step1' tests/core/k3s-operations.test.ts` — **4/4 pass**, zero skips, exit0, outer tripwire never fired. Existing safe behavior was GREEN immediately. No RED was manufactured and no production fix was required. This initial run preceded the additional marker self-check and private-HOME-for-all tightening.
- `task-4-typecheck-initial.log`: `npm run typecheck` — exit0.
- `task-4-focused-final.log`: `sh scripts/test.sh --test-force-exit --test-name-pattern='Step1|read-only callers|bound cluster targets|replacing the provider stops|provider removal during awaited|the OpenAPI document|changes need|module boundary' tests/core/k3s-operations.test.ts tests/core/api.test.ts` — **11/11 pass**, zero skipped/cancelled/todo, exit0, outer tripwire never fired. This covers the final four new matrix cases, existing actual read-only/unknown-cluster/forged-task API checks, persisted bound-target no-legacy-fallback, warm-provider revocation/restoration, provider removal during awaited network preflight, OpenAPI, X-Nova/unknown-method refusal and public module boundary.
- `task-4-typecheck-final.log`: `npm run typecheck` — exit0 against final source.
- `task-4-diff-check.log`: `git diff --check` — exit0.
- `task-4-commit.log`: source-only commit succeeded, exit0. Staged paths were checked to equal only the assigned test file and staged diff-check passed before commit.
- `task-4-final-state.log`: final source SHA, source-only commit paths, clean tracked worktree, diff-check, evidence exit-status/canary-output inspection and task-process check.

No 195/65 whole-suite rerun, browser rerun, app/UI change, install, network target outside owned loopback fixtures, image pull, real tool invocation, credentials, owner keychain, preview, push, PR, merge, controller-record edit or other checkout write. Final test/typecheck output contains no warnings; npm's routine run notices are retained. Historical Task3 host-browser skips were neither rerun nor represented as new browser proof.

## Explicit blocked proof and concerns

**UNPROVEN until actual broker foundation and Step2:** wrong broker endpoint/namespace/grant; changed bound program/digest; one-use ticket/replay; per-cluster secret separation; kubeconfig/plugin/external-file/proxy authority containment for kubectl AND Helm AND Flux; secret handoff only to the bound program; 0700/0600 credential file lifetimes; cleanup on exit/error/abort/cancellation; tier3 setup/consent; and source-pinned adversarial broker live-probe review. These remain required and were not faked.

The refusal canary check is limited to the actual refused API outputs, ledger rows, Core log and test child transcript; it does not prove the future positive credential path keeps secrets absent from every file, repository, ledger event, simulation state or transcript. The hostile simulator state intentionally contains a planted synthetic canary as an input. The private marker detects only its owned named tools/plugin, and adapter counters plus target hits detect the exercised capability boundaries; this is not OS-level arbitrary-process containment proof. The explicit test provider is trusted test composition, not live credential/registration authority.

No source fix was needed. Parent independent task review is still required before accepting Step1. The later whole-branch adversarial/CI checkpoint and any future broker gate remain separate, incomplete work.

At the final handoff, all implementation/report writes and self-checks have ended. No task tool/test process is left running. Ownership is explicitly **RELEASED** to the controller for independent Task4 Step1 review; no further writes or checks will occur without a new dispatch. This release does not mark Task4 or M10j complete.
