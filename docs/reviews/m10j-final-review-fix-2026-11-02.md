# M10j final checkpoint: consolidated final-review fix report

Date: 2026-11-02. Sole source writer: `m10j_checkpoint_final_fix`. No subagents.

## Identity and scope

- Checkout: `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build`.
- Branch: `codex/m10j-k3s`.
- Starting reviewed HEAD: `5cf2597db585b669e58474a890fe5fa2a3a1c4fd` (tracked index/worktree clean).
- Final source/test commit: `e6e7732515c48149d8e2240639c15aacf8254f75` (`fix(services): address K3s checkpoint review findings`).
- Applied receiving-code-review, systematic-debugging, test-driven-development (including writing-good-tests), and verification-before-completion skills. Read constraints, checkpoint brief, full final review and actual failed probes/logs. The existing task authorization covers this one delegated fix wave; no new plan or owner-policy decision was introduced.
- Assigned findings I1, I2 and M1 are addressed individually below. Source/test changes only; this report and raw logs remain ignored controller evidence. No push, PR, merge, rebase, amend, dependency, scanner, waiver, baseline, approval-policy or tripwire change.

## I1 — Serving health versus version readiness

Root cause: `collect()` emitted every observed version's readiness as a service-level workload observation. Topology takes the worst source health, so a 120000 ms old readiness receipt made a freshly measured live service Waiting, and a failed preview made a healthy serving service Failed.

Fix: retain original per-version status and readiness receipt timestamp in `versions[].observed_at`; driver status still retains its independent per-version readiness. Aggregate serving health comes from the current live resource's actual measured health. Candidate readiness is a fallback only when the snapshot has no live selector, for the current non-stopped assignment, with a receipt at or after that assignment. It retains its actual age. Historical, kept, removed and failed preview readiness cannot override serving health. Independent node failures and control-plane uncertainty still participate normally.

A stopped live resource with a fresh measured failure retains that failure and its actual timestamp, while its topology `live` is null because it has no serving replica. A past successful measurement with zero replicas does not invent serving availability. No timestamps are refreshed by projection and collection remains read-only.

Permanent actual-Core/API coverage in `tests/core/k3s-operations.test.ts` asserts healthy/Verified immediately after the full 120-second canary; healthy/Verified with a failed preview and kept/removed history; unchanged original readiness timestamp; genuine live failure, stopped live failure and node failure overriding healthy local evidence; zero replicas with past healthy evidence remaining unknown/Waiting; current candidate fallback, 120000 ms stale readiness becoming unknown/Waiting, and fresh unrelated historical readiness failing to stand in for the current assignment. The existing control-plane provenance test now checks aggregate health/status and version timestamps instead of requiring obsolete readiness to corrupt aggregate observations.

Actual RED: initial topology/current-candidate assertions returned unknown instead of healthy. The valid stopped-live probe returned unknown instead of failed; the complementary stopped-healthy probe returned healthy instead of unknown. See the complete run inventory below, including the initial invalid stopped fixture and its correction. Final focused and complete operations runs cover the corrected fixtures.

## I2 — Bounded admission without discarding lifecycle evidence

Root cause: the simulator retains retired rows indefinitely but a driver snapshot accepts at most 64 rows; prepare previously committed a 65th row and then neither its response nor later status could be accepted.

Chosen review-permitted alternative: a strict **64 retained-version lifetime cap per simulated service**, including resource rows and historical/tombstone rows. There is no compaction or pruning in this checkpoint. This intentionally sacrifices further release admission once the cap is reached rather than dropping replay, immutable-version, live/previous/assignment or task-reconciliation evidence. Root explicitly accepted this alternative and will carry its cost into public checkpoint documentation. This is a checkpoint capability limit, not a claim of general production history management.

The driver checks capacity under its existing serialized state read, before persisting a new definition, network authorization, Helm or workload effects. Preview also refuses before any network target snapshot/proposal. Existing-version replay and immutability checks remain intact. Snapshot acceptance still has the same closed 64-row bound.

Independently, the actual simulator transaction checks expected revision and expected state, validates values and checks union admission before changing any resource, selector, assignment, revision, history or last-mutation evidence. It returns a dedicated pre-effect capacity refusal (exit 73 plus its exact fixed marker). The existing K3s-owned fake fixture translates only that verified refusal into `ClusterCapacityError`; the driver surfaces a specific capacity failure without marking collection unavailable. Every other tool failure remains unknown completion and is not retried. Test audit call records may still be appended; refused resource snapshots remain unchanged.

Permanent coverage in `tests/core/k3s-review.test.ts` uses actual promoted live/previous resources plus retired history or an irreducible active-resource boundary. Three further distinct apply attempts beyond 64 refuse specifically, create no definitions/effects, preserve all retained rows, live/previous/assignment/last-mutation evidence, and leave status and rollback working. Direct simulator tests bypass the driver preflight for both prepare operations, prove stale CAS refusal, then prove independent capacity refusal leaves the entire resource snapshot unchanged. A 63-to-64 boundary test prepares, promotes, observes and rolls back the legitimate 64th row without deleting history. Core/API coverage proves network proposals refuse before target I/O and approved deployment waits with the capacity reason without crossing a commit point or mutating workload state.

Actual RED: driver returned generic unknown completion after overflow; direct simulator requests unexpectedly succeeded; the network API accepted an over-limit proposal (200 instead of 409); refused admission initially persisted a new definition. Each has a retained RED and subsequent GREEN. No cap was raised, no successful completion was invented, and no active row was discarded.

## M1 — Image-only Linux placement

Root cause: generic placement intentionally considers matching Windows/macOS native programs eligible; the K3s driver passed the full dual artifact even though it renders only the pinned image.

Fix: K3s passes an image-only artifact view to the existing placement resolver. The original definition still undergoes validation and pinned-image chart construction. Generic/native placement and native program commands are unchanged.

Permanent tests in `tests/core/k3s-driver.test.ts` prove native-capable Windows and macOS pinned targets remain eligible to generic placement but refuse K3s planning and apply before any tool call. Preferred and floating dual-artifact cases choose eligible Linux over a larger native-capable Mac, retain the pinned image and perform only status reads during preview. The existing literal image-plus-program native supervisor plan assertion passed in the covering chart suite. No actual Windows/macOS program, container or OS execution was performed or claimed.

Actual RED: after correcting the fixture to construct a driver from the changed cluster (the driver deliberately clones cluster metadata), both pinned plans returned true and mixed placement chose native instead of Linux. The initial mixed test also had an incorrect expected image shape; corrected to the existing literal repository/digest structure before implementation. The corrected M1 RED run is 0 pass / 3 fail.

## Commands and actual evidence

Every shell command ran with explicit workdir `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build`. All test commands used Node 26.3.1 via:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH
```

The prefix was applied per command, not globally. Every test used `sh scripts/test.sh`; default runtime tripwire remained armed, KUBECONFIG was unset by that wrapper, and each completed test log ends `no-Kubernetes tripwire: never fired`. Only the pre-existing K3s-owned fixture put committed fakes on its private child PATH. No actual tool, image, credentials, owner data, cloud, account, spending, preview, Serve, shim, cluster or other worktree was used.

The repeated focused command, used for `red`, `green`, `green-final`, `green-verified`, and `green-complete` logs below, was:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH sh scripts/test.sh --test-name-pattern='final I1|final I2|final M1|trusted topology preserves' tests/core/k3s-operations.test.ts tests/core/k3s-driver.test.ts tests/core/k3s-review.test.ts
```

The source/test change between each run was concrete and recorded below; no blind retry was used. The test count grew from 10 to 12 as API admission and the successful 64th-version edge were added. All logs are at `.superpowers/sdd/M10j/task-5-final-fix-<suffix>.log`, retained in full. Every test run has zero cancelled/skipped/todo; a test-name filter does not constitute a full package run.

| Log suffix | Actual tests / pass / fail | Exit | Purpose / result |
|---|---:|---:|---|
| `red` | 10 / 2 / 8 | 1 | Initial permanent regressions before source changes. I1/I2 failed as reviewed. Two pinned M1 fixtures accidentally exercised missing cloned devices; mixed M1 also had an incorrect image-shape assertion. These M1 results were not credited. |
| `platform-red` | 3 / 0 / 3 | 1 | Corrected cloned-cluster M1 fixtures: both plans incorrectly true, mixed placement selected native. Genuine 3-case M1 RED. |
| `green` | 10 / 9 / 1 | 1 | First implementation. Nine pass; active-boundary fixture incorrectly compared pre-read health timestamps. Baseline moved after actual observe; no production health check weakened. |
| `network-red` | 1 / 0 / 1 | 1 | Preview admission guard removed while testing its new regression: over-capacity network proposal returned 200 instead of 409. Guard restored after RED. |
| `stopped-live-red` | 1 / 0 / 1 | 1 | Initial stopped-resource fixture invalid (ready=true with replicas=0); cached live remained. Fixture failure, not credited as behavioral RED. |
| `green-final` | 12 / 11 / 1 | 1 | Eleven pass; the same invalid stopped fixture failed. Corrected ready=false before the intended health assertion. |
| `stopped-live-proven-red` | 1 / 0 / 1 | 1 | Valid stopped resource with the running-only health selection returned unknown instead of its actual measured failed state. Selection fixed after RED. |
| `capacity-registry-red` | 1 / 0 / 1 | 1 | Refused new admission still persisted beyond0 definition. Admission check moved before registry persistence after RED. |
| `green-verified` | 12 / 12 / 0 | 0 | 12/12 pass before complementary stopped-healthy edge. |
| `stopped-healthy-red` | 1 / 0 / 1 | 1 | Stopped resource with past healthy evidence incorrectly returned healthy rather than unknown. Limited stopped-resource carryover to measured failure after RED. |
| `green-complete` | 12 / 12 / 0 | 0 | Final source/test focused regressions, including stronger fresh unrelated-candidate binding and both stopped-resource edges. |
| `covering` | 162 / 162 / 0 | 0 | Focused complete suites, 162 pass; operations-only final delta subsequently fully rerun below. |
| `operations-final` | 45 / 45 / 0 | 0 | Final full operations suite, 45 pass, after last operations source/test change. |
| `source-guard` | 1 / 1 / 0 | 0 | Unchanged supervisor source guard, 1 pass. |
| `boundaries-final` | 2 / 2 / 0 | 0 | Fresh final source guard and module boundary, 2 pass. |

Other actual RED commands, all with the Node PATH prefix above:

```sh
sh scripts/test.sh --test-name-pattern='final M1' tests/core/k3s-driver.test.ts
sh scripts/test.sh --test-name-pattern='final I2: capacity blocks' tests/core/k3s-operations.test.ts
sh scripts/test.sh --test-name-pattern='final I1: failed previews' tests/core/k3s-operations.test.ts
sh scripts/test.sh --test-name-pattern='final I2: retired history' tests/core/k3s-review.test.ts
```

The `final I1: failed previews` command was used for stopped-live-red, stopped-live-proven-red, and stopped-healthy-red as those assertions were added/corrected. The first stopped fixture had replicas=0 while ready=true, which was rightly rejected as malformed and retained cached live evidence; it is preserved as a fixture failure, not credited as a behavioral RED. The corrected fixture explicitly sets ready=false, then fails the intended measured-failure assertion before its fix. The active-boundary fixture was corrected to baseline after a legitimate read-only observation refresh, so real health timestamps are not mistaken for effects.

Covering command (162/162 pass; exit 0):

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH sh scripts/test.sh tests/core/k3s-chart.test.ts tests/core/k3s-driver.test.ts tests/core/k3s-operations.test.ts tests/core/k3s-review.test.ts tests/core/k3s-tools.test.ts tests/core/topology.test.ts tests/core/topology-api.test.ts tests/core/topology-actions.test.ts tests/core/topology-expected.test.ts tests/core/services-manager.test.ts tests/core/services-placement.test.ts tests/core/api.test.ts tests/supervisor/services-contract.test.ts
```

This covering command began before the last operations-only stopped-health edge was added. Its K3s driver/retention/chart/tools, topology/API, placement/manager, native-plan, module-boundary and shared-contract evidence applies to the final corresponding implementation. Final changed operations source/tests were separately fully rerun after that edge and covered by the final 12 focused regressions. This is disclosed rather than labeling an earlier source snapshot exact-final-head evidence.

Final complete operations command:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH sh scripts/test.sh tests/core/k3s-operations.test.ts
```

Actual output (`operations-final.log`): tests 45, pass 45, fail 0, cancelled 0, skipped 0, todo 0, duration_ms 67149.865346; exit 0; tripwire never fired.

Unchanged supervisor source guard command (1/1 pass, exit 0; `source-guard.log`):

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH sh scripts/test.sh --test-name-pattern='no code in Nova or its scripts names a Kubernetes tool to run' tests/supervisor/services-review.test.ts
```

The source guard retains its original exact exceptions and planted positive assertion. Module boundary passed in the full API suite. Neither test nor tripwire/allowlist was edited.

A fresh final boundary command also passed 2/2 with no skips/cancellations and the tripwire never fired (`boundaries-final.log`):

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH sh scripts/test.sh --test-name-pattern='module boundary|no code in Nova or its scripts names a Kubernetes tool to run' tests/core/api.test.ts tests/supervisor/services-review.test.ts
```

Typecheck ran three times as source/tests changed, with exit 0 each (`typecheck.log`, `typecheck-final.log`, `typecheck-complete.log`); the final command was:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH npm run typecheck
```

Actual output: `npm notice run nova@0.1.0 typecheck` and `npm notice run tsc -p tsconfig.json`; no compiler errors or warnings. Test logs have no new runtime warnings. `git diff --check` passed throughout and immediately before commit. Final verification/commit details follow below.

## Limits and handoff

- Full M10j gate remains **NOT PASSED**. Actual P1a/P1b/P1c and #275 findings B are missing. Production credential paths still fail closed; no legacy vault fallback or fake positive broker proof was added.
- The 64-retained-version lifetime cap is intentional. No general history migration/compaction solution or recovery of already-corrupt >64 persisted state is claimed. Tests preserve the observation bound and demonstrate prevention of new overflow, observation/rollback at capacity and lack of destructive pruning.
- Stand-ins establish Nova-side behavior only. Real Helm/Kubernetes validation, real scheduling, node/storage/network enforcement, real credentials/OS execution and physical canary behavior remain unproven.
- No full 1718-test rerun or browser/baseline update was performed. Historical full-run failure remains historical evidence; this scoped work does not replace root's exact corrected-head ordinary CI or independent rereview.
- Source ownership will be explicitly released after every owned command/write has ended. Root owns the single scoped rereview and any combined ordinary CI/draft PR 283 evidence updates. No review or publication was requested by this implementer.

Final commit command:

```sh
git commit -m "fix(services): address K3s checkpoint review findings"
```

Actual output: `[codex/m10j-k3s e6e77325] fix(services): address K3s checkpoint review findings`, `9 files changed, 301 insertions(+), 14 deletions(-)`. `git rev-parse HEAD` returns `e6e7732515c48149d8e2240639c15aacf8254f75`; `git status --short` is empty; `git diff HEAD^ HEAD --check` exits 0 with no output. The commit contains exactly the assigned nine source/test files, without controller docs, logs, plans, dependencies or policy changes.

All owned test processes/commands have finished, disposable fixture homes were closed by the existing fixtures/wrappers, and this report is the final owned write. **RELEASE source ownership to root** for the single scoped rereview and controller handoff. No further source commands/writes or review/publication actions will be performed by this implementer.
