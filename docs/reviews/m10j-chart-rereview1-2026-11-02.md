# M10j Task 1 fix1 scoped re-review

Reviewed 2026-11-02: `f31ccb0a986f7df8e17fbd660baff62ef8994250` → `683f54d762866a6d7700484c1d45a271a85cc8e7`, branch `codex/m10j-k3s`.

**Spec: Pass for the authorized pure-chart Task 1 checkpoint. Quality: Approved.** I1, I2 and M1 are addressed. No new Critical, Important or Minor findings in this fix. This closes the prior review findings, not the later process/schema/credential or real-cluster gates.

Scope: read the fix brief, exact prior findings, appended fix report, then all 485 lines of the supplied 32,221-byte package once in bounded chunks. Checked current line locations and saved verification outputs. Reviewed only I1/I2/M1 and breakage introduced by their fixes. No broad re-review, recomputed diff, test rerun, probe, source/index edit, branch/HEAD mutation, subagent, credential access or real Kubernetes/Helm/Flux action. Wrote only this file.

## Per-finding disposition

| Finding | Status | Evidence |
| --- | --- | --- |
| I1: consecutive hyphens accepted in named ports | **ADDRESSED** | `src/core/services/k3s/values.ts:48` uses the positive pattern `^[a-z]([a-z0-9]|-[a-z0-9])*$`; `:95` enforces length <=15. Both schema positions have the same pattern and length constraint (`charts/nova-service/values.schema.json:95`, `:239`). No lookahead is used. |
| I2: stateless none defaults to surging rollout | **ADDRESSED** | Required typed strategy at `src/core/services/k3s/values.ts:23`; builder selects Recreate for none/stateful at `:135`; template consumes it directly at `charts/nova-service/templates/workloads.yaml:55`. Closed schema requires the strategy object and restricts its type. |
| M1: evaluator silently ignores future schema keywords | **ADDRESSED** | Explicit supported constraint and annotation sets at `tests/core/k3s-chart.test.ts:146`; `schemaVocabulary` at `:148` rejects unknown keywords, traverses schema values beneath properties/definitions without treating map keys as keywords, and confines references to local definitions. |

I1 regression evidence: `tests/core/k3s-chart.test.ts:316` establishes that the generic validator still accepts the synthetic adjacent-hyphen definition while the K3s builder refuses it, and checks valid one-character, hyphenated and 15-character names. Independent service-list/container-list mutations at `:323` and the probe mutation at `:331` each fail schema conformance. Generic/native validation source is outside the patch and unchanged.

I2 regression evidence: `tests/core/k3s-chart.test.ts:338` builds a live stateless-none version using two successful preferred resolutions. It checks the same Deployment identity, changed required placement input, one replica, null state and Recreate in both results, plus direct template consumption. The full-mode control expects explicit RollingUpdate; the updated literal values and schema tests cover the added contract field. The context interface is unchanged.

The controller-authorized singleton extension is also addressed: `src/core/services/k3s/values.ts:146` rejects aggregate desired instances above one whenever an active none version exists. It sums all retained versions after existing override/kept/candidate handling, without clamping. Tests at `tests/core/k3s-chart.test.ts:354` cover floating count two, override two and overlapping full candidate refusals; zero-replica candidate and stopped previous-none positive controls remain accepted. This supplements the existing claim-writer limit.

M1 regression evidence: `tests/core/k3s-chart.test.ts:366` requires an unsupported semantic `not` keyword to throw. The control at `:371` permits property name `not`, definition name `if`, the supported inert string annotations, and a local reference while still enforcing the referenced constraint. Evaluation recursion is separated from the vocabulary walk. This is appropriately a limited test evaluator, not a full draft-07 implementation.

## Saved verification evidence inspected

These are fresh fix-wave logs, not fabricated historical evidence or reviewer reruns. Their named assertions correspond to the amended code.

| Log under `.superpowers/sdd/M10j/` | Observed result |
| --- | --- |
| `task-1-fix1-red.log` | First new-wave chart run: 24 tests, 18 pass, 6 fail; assertion failures identify the missing behaviors. |
| `task-1-fix1-red-confirmed.log` | `sh scripts/test.sh --test-name-pattern=fix1 tests/core/k3s-chart.test.ts`: 8 tests, 1 pass, 7 fail, exit 1. Separate service/container/probe failures, missing port refusal/strategy/overlap refusal, and ignored unsupported keyword. |
| `task-1-fix1-green-focused.log` | `sh scripts/test.sh tests/core/k3s-chart.test.ts tests/core/services-definition.test.ts tests/core/services-placement.test.ts`: 43 tests, 43 pass, 0 fail/skipped, exit 0. All eight fix1 cases appear by name. |
| `task-1-fix1-green-boundary.log` | Actual module-boundary test selected in `tests/core/api.test.ts`: 1 pass, exit 0. |
| `task-1-fix1-green-typecheck.log` | `npm run typecheck`, `tsc -p tsconfig.json`, exit 0. |
| `task-1-fix1-green-diff.log` | Saved `git diff --check`: no diagnostics, exit 0. |
| `task-1-fix1-green-staged-diff.log` | Saved `git diff --cached --check`: no diagnostics, exit 0. |

The inspected Node test logs show the existing tripwire armed and never fired. The initial implementation's unsaved 35-test/boundary/typecheck stdout remains report-only, as explicitly disclosed; this review does not reconstruct or upgrade that historical evidence.

Current schema SHA256 independently matched the fix report: `729fae00f61f823f5b5a7191668d97843609804aefb4205f8eb8e6424565e67a`. HEAD and branch match the requested review target. The only tracked worktree modification observed is controller-owned `docs/plans/M10j.md`; it remains excluded and untouched.

## Exclusions and retained limits

- No Helm rendering/process gate or Kubernetes API/runtime validation was performed. Task 2's meaningful committed fake-Helm schema/lint process gate remains pending. Schema/shape tests alone do not satisfy it.
- Recreate and aggregate desired counts prevent the reviewed desired-configuration mistakes; they do not prove runtime singleton/writer exclusion. The later driver must observe **all old instances stopped**, including stateless none, before replacement. Separate Deployments, pod deletion/restart, failures, reconciliation, actual scheduling, readiness, resource enforcement, storage permissions/provisioning and network enforcement remain unproven.
- NetworkPolicy artifacts remain inert. Application still requires M10d tier 3/dead-man authority; this approval grants no network mutation authority.
- Credentialed production paths remain absent/fail-closed; no broker/launcher fallback is introduced, and #275 remains parked. Credential/process isolation and cluster authority remain later gates.
- Resolver provenance/health, observation ordering, transaction serialization, expected-state binding, cancellation/replay/unknown completion, M10i behavior, backend switching/GitOps ownership, UI/preview and milestone completion were not reopened. Their exclusions from the original review remain in force.

Controller may accept Task 1 at this pure-chart checkpoint and proceed with the authorized simulated-driver work. No further Task 1 fix is requested by this scoped re-review.
