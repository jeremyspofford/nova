# M10j single-wave scoped rereview

Date: 2026-11-02. Original independent reviewer: `m10j_checkpoint_final_review`. Scope is the one corrective wave and its new regressions, not another whole-branch review.

## Verdict

**Checkpoint NOT ACCEPTED.** Original I1, I2 and M1 are **ADDRESSED** in their demonstrated original cases, but the I1 corrective hunk introduces **one new Important correctness regression (R1)**: it can report the currently assigned candidate healthy/Verified while that same candidate has a fresh measured health failure.

New finding count: **0 Critical / 1 Important / 0 Minor**. `specPass: false`; `qualityApproved: false` for the corrected uncredentialed checkpoint. Passing ordinary CI does not close this demonstrated missing case.

**Full M10j phase remains NOT PASSED independently:** actual P1a/P1b/P1c, #275 findings B, and positive broker/launcher credential isolation, binding, containment and cleanup proof remain absent. No production phase merge, deployment, preview, real cluster or M10k acceptance is conferred.

## Scope and identity

- Exact checkout: `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build`.
- Base: `5cf2597db585b669e58474a890fe5fa2a3a1c4fd`.
- Reviewed HEAD: `7a8f5bf5aa854e3d65d8af7cc77d488345c07f56`; source fix `e6e7732515c48149d8e2240639c15aacf8254f75`, followed by records-only commit `7a8f5bf5`.
- Read the complete fix report, fix brief and constraints. Inspected all nine changed source/test files and relevant publication deltas. The supplied package's diff body exactly matches `git diff --unified=10 BASE HEAD`; its additional heading, commit list and stat explain why the whole package is not a byte-identical default-format git diff.
- All 30 corrected source-manifest hashes and all 22 public-log hashes match. Original whole review and full fix report are byte-exact public copies. All 51 current app-shipping table columns remain unchanged. `git diff --check BASE HEAD` passes.
- Source, index, branch and HEAD were read-only. Tracked worktree was clean on entry and remained unchanged. Only owned ignored rereview probe/log/report files were written.

## Individual dispositions

| Finding | Disposition | Code and evidence assessment |
|---|---|---|
| I1: historical/failed-preview readiness corrupts healthy live status | **ADDRESSED for the original finding; new R1 blocks acceptance** | `operations.ts:270–283` now takes actual measured health from the current live resource and retains version readiness as `versions[].observed_at`, rather than aggregating obsolete/candidate history into live health. The permanent API tests assert healthy/Verified after the full canary and with failed/kept/removed history; true live/node failure and stopped-resource cases remain checked. The new fallback when no version is live has the separate R1 regression below. |
| I2: committed 65th row makes later snapshots unobservable | **ADDRESSED** | `driver.ts` checks the unchanged 64-row capacity after serialized read/expected-state validation and before new definition persistence or network authorization. Preview checks before network proposal work. The fake independently checks the union of existing and incoming identities under its transaction/CAS before changing resource rows. A precise known-pre-effect refusal does not mark the control plane unavailable; generic failures remain uncertain. Repeated refusal, active/retired capacity, preserved rollback/history and the valid 63-to-64 boundary have permanent coverage. |
| M1: native Windows/macOS artifact grants container eligibility | **ADDRESSED** | K3s passes an image-only artifact view into the generic resolver while validating/rendering the original definition. Generic/native planning is unchanged. Tests cover pinned Windows/macOS pre-tool refusal and mixed preferred/floating selection choosing Linux over a larger native host, retaining the pinned image. |

## Important new finding

### R1 — Candidate readiness fallback suppresses that candidate's fresh measured failure

**Tight source anchor:** `src/core/services/k3s/operations.ts:280–282` (candidate selection begins at line 278).

When `s.live === null`, the new code selects the current assigned candidate and builds a readiness-only observation from `candidate.ready`, `candidate.status` and `candidate.ready_at`. It uses that observation in place of measured health and emits no measured-health observation for the candidate. In particular, `candidate.health.ok === false` is never considered.

Readiness is a historical validation receipt, not continuously measured health. The existing fake correctly leaves `ready` true after a successfully validated candidate later becomes unhealthy; subsequent status collection updates its actual health to false. The new fallback therefore manufactures a healthy/Verified aggregate from the old readiness receipt despite fresh contradictory evidence for the exact same candidate.

**Actual Core/API reproduction:**

1. Use the existing K3s-owned disposable fixture and actual Core network/WorkLedger setup.
2. Deploy version 1 and finish its normal validation, without promoting it. It is the current assigned candidate and no version is live.
3. Mark version 1 unhealthy in the simulator, then GET `/services/topology`. The actual child-process status observes `health.ok:false`; this is not an injected malformed output.
4. The API reports `live:null`, `health:"healthy"`, `status:"Verified"`. Its only workload observation is healthy readiness. The actual resource still has `ready:true` and a fresh measured failure.

Exact diagnostic output:

```json
{"live":null,"health":"healthy","status":"Verified","observations":[{"source":"workload","at":"2026-11-02T12:00:10.000Z","age_ms":0,"stale":false,"health":"healthy","reason":"Observed readiness of 1."}],"actualReady":true,"actualHealth":{"ok":false,"checked_at":"2026-11-02T12:00:10.000Z","said":null}}
```

The deterministic clock does not advance between validation and this later failure observation, so both timestamps are equal and fresh. The operation sequence and status measurement are distinct; the problem is suppression of an actual current failure, not clock staleness. No need to wait for readiness expiry or forge timestamps to reproduce it.

**Impact:** the newly supported candidate fallback claims Verified for unhealthy work and erases its independent measured-failure evidence. Promotion still has its own fresh probe, so this is not a demonstrated promotion bypass. It is nevertheless an Important truthfulness regression in the map/status capability, contradicting the requirement to preserve actual measured health separately from readiness and avoid invented healthy states. The original implementation returned unknown in this no-live case; the false-positive healthy result is introduced by this fix.

**Required correction:** preserve the current assigned candidate's actual measured-health evidence and its own age when considering readiness fallback. A fresh measured failure of that candidate cannot be replaced by an older/same-time readiness success. Do not restore the original bug by aggregating unrelated failed previews or historical versions into an actually healthy live service. Add a permanent actual-Core/API regression for ready candidate followed by fresh measured failure before promotion; retain the existing live/history, source-aging and assignment-binding cases.

**Proof:** `.superpowers/sdd/M10j/task-5-rereview-candidate.test.ts` and `.superpowers/sdd/M10j/task-5-rereview-candidate.log`. Exactly one new focused test ran: **1 total, 0 pass, 1 fail, 0 cancelled, 0 skipped, exit 1**. The assertion rejects the false healthy result. Runtime tripwire was armed and never fired.

## Capacity ruling and technical judgment

The eighth public ruling explicitly accepts a **64-retained-version lifetime admission limit per simulated service**, including tombstones. This is the pre-effect-refusal alternative permitted by original I2; it is not compaction, unlimited lifecycle support or recovery of already-corrupt state.

Technically the alternative closes the original defect: the known boundary is checked before new definition persistence, external network authorization and prepare; the independent fake transaction prevents an observer from bypassing admission by using current CAS directly. Existing live/previous/current-assignment rows and reconciliation/history are preserved, and existing-version rollback remains possible at the cap. Call-audit recording by the fake is not a workload mutation; refusal keeps the whole resource snapshot unchanged.

The capacity cost is prominent in the gate, pending LEDGER and inventory, rather than hidden. Further releases at capacity require separately reviewed history management. Rejecting already-over-limit snapshots remains fail-closed; no repair/migration is claimed. I accept that constrained alternative for this uncredentialed checkpoint. It does not excuse R1 or qualify a full production implementation.

## New-fix behaviors considered and declined as separate findings

| Behavior / potential concern | Decision and reason |
|---|---|
| Historical readiness removed from aggregate live observations | Correct for I1. Actual timestamp/status remain per version and in driver readiness; preserving provenance does not require giving obsolete history veto power over fresh serving health. |
| Current live resource with replicas 0 and fresh measured failure | Changed code retains the measured failure, while reporting no serving version. Permanent tests exercise this; not suppressed by the historical-readiness fix. |
| Replicas 0 with an old successful measurement | Correctly unknown rather than claimed serving. No new false-live finding. |
| Current candidate must match assignment and have receipt at/after it | Correct binding improvement. Missing/unrelated/stopped assignments cannot borrow an old candidate's readiness. That binding alone does not solve R1's contradictory health measurement. |
| Candidate readiness expires at 120000 ms | Uses existing topology age rules and does not refresh receipts. Tested; no new gate-shortening setting. |
| Fresh real node failure and control-plane uncertainty after I1 | Independent machine and failure observations still participate in aggregation; updated tests check those outcomes. No change to heartbeat source or freshness rules. |
| Candidate fallback omits newer health when it is true or unknown | Same evidence-selection family as R1, not a second finding. A correction should preserve independent actual evidence without blindly freshening readiness. The reproducible blocker is the false-healthy case above. |
| Capacity error bypasses generic unknown-completion failure marking | Appropriate only for verified pre-effect refusal. The sole concrete translation is in the trusted K3s-owned fixture and requires the dedicated exit code plus exact marker; deterministic fake code emits it before effects. No public untrusted route gained the error capability. |
| Future adapter lies by throwing `ClusterCapacityError` after effects | Trusted adapter contract explicitly forbids this. No production runner exists and no concrete new violation was found. Future broker adapter must prove this separately; not credited now. |
| Capacity union and stale CAS ordering | The independent fake validates CAS before union admission/effects; permanent direct-fake tests bypass driver preflight and verify both refusals leave resource state unchanged. |
| Capacity counter races between driver preflight and server write | Server transaction/CAS remains the independent protection. The driver's earlier check improves refusal timing but is not treated as server authority. |
| At-capacity refusal blocks future versions forever | Explicit accepted checkpoint limit/eighth ruling, with publicly stated lifetime cost. It closes the commit-then-unobservable failure through pre-effect refusal. No silent tombstone deletion or cap inflation. |
| Already-corrupt >64 persisted state cannot recover | Explicitly outside this prevention fix; remains rejected. No production credentialed deployment or migration is claimed, so no new recovery promise to enforce in this scoped wave. |
| Existing-version replay and definition immutability at capacity | Existing-version paths still reach their original registry/replay checks. New-version capacity check occurs before registry write. Regression tests preserve refusal and rollback evidence. |
| Read-only observation changes fresh health/sequence at capacity | Legitimate newly measured status, not mutation of workloads or authority. Test baselines correctly distinguish observation timestamps from resource revisions/effects. |
| Image-only view strips native program fields during placement | Intended K3s-specific eligibility correction; original definition still feeds validation/chart construction. No change to generic/native resolver or command execution. |
| Native-only definition or unknown platform metadata | Existing pinned-image builder refusal and Linux chart confinement remain. This small change is not proof of real node attestation or physical platform execution; no new capability inferred. |
| Fake marker text versus executable escape | Fixed marker and error type add no subprocess entrypoint or environment authority. Existing private fixture is still the sole launcher; no scanner/tripwire/allowlist dependency changes. |
| Changed test assertions remove the old readiness-in-observations requirement | Justified: old assertion encoded the I1 bug. Replacement asserts aggregate health/status and unchanged version timestamps. R1 is missing new coverage, not a reason to keep that old assertion. |
| Corrected source manifest and archived logs | Identity checks pass; they do not imply behavior beyond the exact recorded test cases. Existing final 12 and 45 passes miss R1. |
| Covering 162 run precedes final operations-only edge | Correctly disclosed, with final full operations45 and focused12 afterward. No misleading exact-final-whole-suite claim found. |
| Full ordinary CI, draft publication and app shipping | Separate controller gates. This review did not poll/restart CI or mutate the PR. App-shipping classifications remain unchanged; pending draft cannot be called accepted with R1 open. |
| Prior whole-branch exclusions and credential/full-phase dependencies | Not reopened or re-probed. Unchanged limitations from the original full review continue to apply; scoped fixes do not supply missing broker/real-cluster/production evidence. |

## Validation and ownership release

No passed existing package was rerun. The only new behavioral execution was the named unanswered candidate-failure risk above, using the actual existing Core/API/fake setup in a disposable home. No real Kubernetes tool, external account, credential, image pull, cloud, owner data, preview or other checkout was touched. No subagents/helpers were delegated.

Exact probe command from the reviewed worktree:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH sh scripts/test.sh .superpowers/sdd/M10j/task-5-rereview-candidate.test.ts > .superpowers/sdd/M10j/task-5-rereview-candidate.log 2>&1
```

The retained writer evidence was checked against code and artifact hashes: final focused12/12, full final operations45/45, source guard/module boundary2/2, earlier covering162/162 with disclosed later operations delta, typecheck/diff success. These passes remain valid scoped evidence; they do not cancel the new 0/1 regression probe.

All owned processes have ended, fixture cleanup completed, and all source/index/HEAD/branch operations were read-only. **Ownership RELEASED to root** after this final report. No additional fix wave or review is initiated by this reviewer. The workflow decision belongs to root; the evidence requires keeping checkpoint acceptance false while R1 remains open.
