# M10j R1-only independent validation

Date: 2026-11-02. Original independent reviewer: `m10j_checkpoint_final_review`.

## Verdict

**R1: ADDRESSED. New findings: 0 Critical / 0 Important / 0 Minor.** The R1 source correction is accepted: `specPass: true`, `qualityApproved: true` within this scoped uncredentialed review.

The previously identified review findings are now closed through their recorded individual reviews: original I1/I2/M1 in the prior scoped review, and introduced R1 here. This is **source-review acceptance for the uncredentialed draft checkpoint**, conditional on the controller's complete exact-head ordinary CI and evidence/publication gate. This report does not claim those remaining checks have already passed.

**Full M10j phase remains NOT PASSED.** Actual P1a/P1b/P1c, #275 findings B and positive broker/launcher credential proof are still missing. No M10j production phase merge, deployment, preview change, real cluster authority or M10k acceptance follows from closing R1.

## Exact range and review scope

- Checkout: `/home/jeremy/.codex/worktrees/nova-m10i-topology/nova-build`.
- Base: `7a8f5bf5aa854e3d65d8af7cc77d488345c07f56`, the previously rejected scoped-review head.
- Reviewed HEAD: `8916fed0d726345ca7a9accb79012d75d87aa799`.
- Source fix: `72199e0af4dd0f1ea4033faa1e362d9802f4b57a`, changing only `src/core/services/k3s/operations.ts` and its actual-Core/API tests; records follow in `8916fed0`.
- Read the R1 requirement and complete corrective append in the implementation report. Inspected the complete two-file source/test diff and publication changes. No whole-branch recrawl, reopening of I1/I2/M1 or capacity ruling, or unrelated review expansion.
- The supplied package's diff body exactly matches `git diff --unified=10 BASE HEAD`. All 30 current source-manifest hashes and all 28 public-log hashes match. The original 18270-byte implementation-report prefix is preserved exactly; complete appended report and rejected scoped review are byte-exact public copies. All 51 current app-shipping columns are unchanged. `git diff --check BASE HEAD` passes.
- HEAD remained fixed and the tracked worktree/index clean. No source, index, branch, PR or external state was mutated by this review.

## Why R1 is closed

**Relevant anchors:** `operations.ts:275–284`; permanent tests begin at `tests/core/k3s-operations.test.ts:1001` and `:1066`.

The previous code replaced the measured-health observation with readiness for the current no-live candidate. The corrected code instead:

1. Preserves the existing binding to the current assignment, only when the snapshot has no live selector and the readiness receipt belongs to that assignment.
2. Selects the current live resource or that already-bound candidate as the measured resource (`current ?? candidate`). It does not borrow an unrelated historical/preview resource.
3. Emits actual measured health as the primary observation, retaining its own `checked_at` timestamp.
4. Adds readiness as a separate observation, retaining its independent `ready_at` timestamp.
5. Continues excluding successful stopped-resource measurements from availability claims while preserving actual measured failures. Independent node and control-plane observations are unchanged.

Consequently, the existing topology normalization and worst-source aggregation sees both pieces of evidence. The exact reviewer reproduction—candidate still `ready:true`, no live version, fresh actual `health.ok:false`—now exposes the measured failure and produces failed/Failed instead of healthy/Verified. Unknown, stale or future measured health cannot borrow the readiness time. New measured health also cannot refresh expired readiness. The live/history isolation introduced by the earlier I1 correction remains intact because candidate selection is disabled whenever a live selector exists.

The new permanent tests check the original equal-timestamp failure using actual committed simulator children and the real Core/API/WorkLedger setup. They also check a later failure with different source ages, unknown health, recovery, readiness expiry, zero replicas, and absence of read-triggered effects/timers. The second test deliberately controls independent source timestamps at the existing trusted fixture port after actual child collection; it is accurately disclosed as an age-boundary fixture, not physical cluster evidence.

No unanswered new Critical/Important risk remained that justified another live probe. The existing permanent regression directly incorporates the reviewer's demonstrated failure, and code inspection confirms the corrected observation path. No passed package or previous reviewer probe was rerun merely for confirmation.

## Evidence assessment

Retained actual logs and test assertions support the source change:

| Evidence | Result and scope |
|---|---|
| Permanent R1 tests before correction | 2 tests, 0 pass / 2 fail: false healthy despite measured failure, and false healthy despite stale measured health. Genuine behavioral REDs. |
| Focused R1 plus I1/provenance cases | 5/5 pass, no skips/cancellations. Includes corrected candidate evidence and preservation of existing live/history behavior. |
| Complete final operations suite | 47/47 pass, no skips/cancellations. Covers final operations source, not an earlier snapshot. |
| Unchanged module boundary and source guard | 2/2 pass, no skips/cancellations. No scanner/allowlist/tripwire change. |
| Typecheck and diff checks | Recorded exit 0, no compiler warnings/errors; independent range diff check also passes. |
| Runtime tripwire | Armed and never fired in all four recorded test runs. |

These are implementation executions reviewed against the exact code and hash-verified artifacts, not newly rerun tests by this reviewer. No prior 162-test/full-unit/browser package is relabeled as R1 evidence. The separate exact-head ordinary CI remains a controller gate; this review did not poll, restart, cancel or claim its outcome.

## R1-fix behaviors considered and declined as findings

| Behavior / concern | Judgment and reason |
|---|---|
| Equal-time readiness success and measured failure | Correctly separated. Fresh actual failure participates in aggregation even when both timestamps are identical under the injected clock. Permanent test reproduces the original case exactly. |
| Later measured failure with older readiness | Actual health timestamp advances independently; readiness keeps its old timestamp. Failure cannot be replaced by the receipt. Covered by the later-time assertions. |
| Unknown candidate health with successful readiness | Remains unknown/Waiting through the independent primary observation. This is conservative and prevents the same false-healthy family as R1. |
| Stale or future measured health with fresh readiness | Existing topology age rules normalize that measurement to unknown. The controlled fixture tests the 120000 ms old and permitted 1 ms future observations; no new freshness allowance is introduced. |
| Fresh healthy measurement with stale readiness | Remains unknown for the unpromoted candidate until relevant readiness is current. This preserves the existing reviewed candidate-readiness-age rule instead of manufacturing a new validation receipt from health. It is not applied to an already live service. |
| Both candidate sources healthy and current | Healthy/Verified remains possible; the fix does not blanket-disable the fallback. Recovery assertions cover this. |
| No matching assignment, stopped assignment, or readiness preceding assignment | Existing candidate binding is unchanged. Those inputs cannot borrow another version's readiness/measurement. No new authority or fallback path. |
| Candidate has no usable readiness receipt | The new code does not invent one or make an unvalidated candidate healthy. Unknown is conservative; the R1 scope does not introduce a new pre-validation health-selection policy. |
| Candidate has zero replicas | Positive measured health cannot establish availability; the primary observation becomes unknown. Actual negative measurement can still be shown with its own age. Existing snapshot validation also prevents ready=true/replicas=0 from being accepted. |
| Live resource exists but has zero replicas | `current` remains the measured source, positive health is not used to claim serving, and real measured failure is preserved. No candidate substitution occurs while the live selector exists. |
| Unrelated failed preview, kept or removed history beside healthy live work | Excluded from the measured source and candidate observations. The changed selection remains `current` for live work; earlier I1 outcome tests are retained and included in focused coverage. |
| Fresh candidate health but an actual failed readiness/contract receipt | Independent failed readiness can still make the unpromoted candidate fail. That is truthful evidence of a failed validation, not unrelated historical contamination. |
| Measured-health/readiness null timestamps | Source values remain unmodified; existing snapshot/projection validation determines unknown/freshness. No fallback assigns the capture time to missing evidence. |
| Node, heartbeat and control-plane provenance | Not changed by this patch. Existing observations still aggregate independently, preserving real node failure and control-plane uncertainty. Final full operations coverage remains relevant. |
| Read-only collection accidentally arming mutation work | Only in-memory source selection/observation assembly changes; no driver calls, timers or network mutations are added. New regression checks no additional effects/timers. |
| Trusted-port timestamp fixture masquerading as physical proof | Report accurately distinguishes the controlled timestamp model from actual child collection and real cluster validation. No physical-health or credential proof is inferred. |
| New credential, process, network, capacity or approval authority | None added: source diff is only collection/projection logic; driver/tool/schema/network/approval paths are untouched. Their accepted scoped judgments and remaining gates are not reopened. |
| Ninth process ruling | Transparently records the additional corrective follow-up under the owner's standing authorization, with extra review/CI cost. It neither changes product policy nor waives a gate. This review judges the R1 source result, not a claim that the original one-wave cap was never exceeded. |
| Historical rejected review and earlier failed runs | Preserved verbatim with source identities. The new report closes R1 prospectively; it does not relabel the rejected head as accepted. |
| Publication and app-shipping status | Records retain uncredentialed/pending/full-phase distinctions and unchanged app-shipping columns. Any final checkpoint qualification must still attach complete exact-head ordinary CI. |

## Release and remaining gate

No reviewer test or subprocess remains running. No new behavioral probe was needed or launched. All commands were read-only checks except this owned ignored report. All source/index/HEAD/branch/PR state remains unchanged at `8916fed0d726345ca7a9accb79012d75d87aa799`.

**Ownership RELEASED to root.** R1 is closed with zero introduced findings. Root may use this report for the uncredentialed checkpoint's independent-review requirement, then finish its exact-head ordinary CI/publication gate. The absent credential foundation/proof continues to prohibit full-phase acceptance, merge/deployment/preview or M10k claims.
