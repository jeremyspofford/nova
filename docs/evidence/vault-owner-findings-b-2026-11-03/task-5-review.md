# Task 5 independent spec and quality review

Reviewed 2026-11-03 by `vault_b_policy_review`.

**Spec verdict: PASS. Quality verdict: APPROVE. Task 5 gate: RELEASE.**

New findings: **Critical 0 / Important 0 / Minor 0.** No actionable defect found within this task's change. This releases the Task 5 review gate only; it is not approval of Task 6, P1b/P1c, final branch integration, PR, merge, deployment, or owner credential use.

## Scope and method

Read the complete Task 5 brief and Global Constraints first. Reviewed immutable package `review-a4a27f70..401c1140.diff` (53,622 bytes), implementation report, all final added tests, and changed production logic. Read the narrow unchanged approval, canonicalization, audit, request normalization, launcher, revocation, protocol, boundary, and existing policy/verb test paths needed to establish behavior. Used the engineering code-review skill's security, correctness, performance and maintainability lens.

BASE: `a4a27f70232e40a09975877985aefc8c3243a589`.
HEAD independently confirmed: `401c11404f4b1af54acc2690804264b552e554e4`.
Workspace: `/home/jeremy/.codex/worktrees/nova-vault-integration/nova-build`.

The change is confined to `src/broker/broker.ts`, `src/broker/policy.ts`, `tests/core/broker-owner-findings-b-policy.test.ts`, and the three authorized coverage/limitation paragraphs in `docs/plans/vault-broker-phase1.md`. Source, index, HEAD and branch were not modified by this review. No new test executions or probes were needed; no already-green suites were rerun. No subagent, service, account, owner key, preview, image pull, push, PR or merge action was performed. This review file is the sole intentional write.

## Named spec checks

### T5-PROCESS — normalized producer and execution identity: PASS

`src/broker/broker.ts:332` validates/defaults argv, and `:334` calls the existing `programRequest` normalizer (`:825`). The approval action at `:339` includes argv plus normalized cwd, allow-listed env, stdin and timeout. The grant key at `:341` uses the same action and task digest as `#approve` (`:213`, `:525`). It does not independently rebuild a weaker request identity.

The actual execution consumes the same `argv` and `run` objects at `:365`. The existing launcher handoff sends those cwd/env/stdin values at `:470`, and the timer consumes `r.timeout` at `:468`. `src/broker/launch.ts:50`, `:60` and `:63` preserve broker-owned PATH/HOME, bound executable/argv, cwd fallback and stdin delivery. Omitted cwd means the broker's fresh private run home; it does not mean a caller-selectable unbound directory. The allow-list and child environment isolation are unchanged.

The real synthetic target tests at `tests/core/broker-owner-findings-b-policy.test.ts:42` and `:60` independently vary all five fields, reject mismatched approval and old task grants before marker writes, and allow a matching approval. The normalized-default test at `:230` confirms omitted defaults and their explicit equivalents share identity. These are public approval/action/effect tests, not assertions against private grant-map contents.

### T5-CARDS — honest breadth and caller-input metadata: PASS

`src/broker/broker.ts:46`, `:649` and `:845` disclose standing process consent breadth across argv, cwd, allow-listed env, stdin and timeout, including bind, create and retained migration proposal cards. The obsolete process `requests inside RUN /` approval wording is removed.

Tier-2 cards at `:344` use fixed `flags` strings and existing argv/approving fields. `callerInput` at `:848` computes byte counts and domain-labelled identities from normalized caller inputs alone. It never fetches or hashes a stored credential. Different caller input classes are identifiable without raw env/stdin/query disclosure. Tests at `:71` and `:89` check changed identities, credential canary/hash absence and actual standing-consent behavior. These hashes identify input; they are not encryption or secrecy guarantees.

### T5-HTTP — full path identity with bare scope/audit: PASS

`src/broker/broker.ts:327` receives both validated full path and bare path from `src/broker/origin.ts:56`. Scope and `scope_item` continue to use bare path, while the action uses full path at `broker.ts:340`; the same full path is sent at `:380`. Method is included through `scope_item`. Query changes therefore invalidate both challenge reuse and grant reuse.

Cards explicitly say headers/body are not bound (`:348`, `:358`); caller header/body validation and limits remain at `:375` and `:855`. VERIFY retains its explicitly documented body/signature-pair behavior. Tests at `tests/core/broker-owner-findings-b-policy.test.ts:129`, `:149` and `:243` verify no target call for substitutions, separately acquired grants, raw-query privacy, bare audit path and out-of-scope refusal. Documentation at `docs/plans/vault-broker-phase1.md:133`, `:134` and `:149` matches these limits.

### T5-GRANTS — bounded lifetime and revocation: PASS

`src/broker/policy.ts:17` retains `APPROVAL_MS = 300000`. The Map at `broker.ts:72` stores an expiry set only after successful approval (`:360`). The sweep at `:343` deletes at `expires <= now`; successful reuse does not refresh the timestamp. This lifetime is independent of the approval/replay bookkeeping retention.

Lock clears grants at `:203`. The ref-prefixed digest key remains compatible with `#forgetGrants` at `:665`. Removal, metadata policy changes, value updates, rotation phases, binding changes and multi-item migration policy changes still reach the existing invalidation paths (`:537`, `:554`, `:565`, `:578`, `:581`, `:639`, `:654`, `:816`). Thus version and policy changes do not retain old task grants.

The frozen-time test at `tests/core/broker-owner-findings-b-policy.test.ts:107` exercises repeated use, success at 299,999 ms, refusal at 300,000 ms, new approval and lock/unlock revocation. Existing `broker-policy-proposals.test.ts:17` and `:69` exercise single/multi-ref policy revocation and real target refusal; existing verb tests retain sensitive, per-use, passkey and task separation controls. Timing intentionally follows the broker's existing wall clock; this task does not introduce a monotonic clock policy.

### T5-POLICY — validation, exact digest and future use: PASS

`src/broker/policy.ts:130` requires an object, typed integer length 16–128, a printable non-space ASCII alphabet of at most 256 characters and at least 16 distinct symbols. Omitted fields retain defaults; coercion is rejected. `policyCard` at `:138` reports validated length, exact alphabet, distinct count and the conservative entropy floor. At minimum, 16 characters selected uniformly from 16 distinct symbols give 64 bits.

Create validates before approval, includes the same policy in metadata/action/card, and generates only after approval (`broker.ts:503`, `:508`–`:514`). Sealed creation also binds and stores that policy for future generated replacements. Generated update and rotate-begin include/show the stored policy (`:559`–`:561`, `:580`–`:583`). Fixed responses return refs/version, not generated bytes.

The generator's deduplication and rejection-sampling loop at `policy.ts:143` is preserved. Independent length and same-size/reordered-alphabet substitution cases cover both generated and sealed creates (`tests/core/broker-owner-findings-b-policy.test.ts:164`); future update/rotation tests survive lock/unlock and inspect synthetic stored output (`:182`); validation and boundary controls are at `:202`. The deterministic entropy test at `:219` rejects byte 255 for 17 symbols and confirms duplicate removal. This directly checks the rejection branch; it is not presented as a statistical randomness certification.

### T5-BOUNDARY — schema, budget and earlier work: PASS

`src/broker/protocol.ts` is unchanged. Metadata remains within existing card flags/approving/items keys; no arbitrary caller object response container or public verb is introduced. The fixed recursive answer-key check, seven verbs/three messages, client raw-value boundary and standard-library/own-file import checks remain intact in the recorded boundary run.

Independently recounted broker `.ts`/`.js` files using the unchanged boundary rule (`read_text().split('\n')`): **2850 / 3000 lines, 150 remaining**. No dependency, limit increase, code relocation or cosmetic budget evasion was introduced. Task 4 owned process lifecycle/internal environment code and Task 3 source epochs/cleanup were not changed by this commit. No claim is made that core has already stopped using legacy credentials.

## Evidence reconciliation

Independently verified all four final source hashes and all 28 evidence-file hashes against `evidence/task-5/final-manifest.json`; no mismatch. The report hash also matches. Programmatically compared every raw appendix JSON/stdout/stderr block for all eight recorded invocations with the retained evidence files; every block matches exactly. Initial reviewed git status was empty and HEAD matched the designated commit.

Recorded results:

| Invocation | Exit | Tests | Passed | Failed | Interpretation |
|---|---:|---:|---:|---:|---|
| red-01 | 1 | 15 | 0 | 15 | Retained initial failures, including the acknowledged Python newline fixture defect |
| red-02 | 1 | 20 | 2 | 18 | Corrected fixture; both existing argv controls pass, intended uncovered behaviors fail |
| green-03 | 0 | 20 | 20 | 0 | Initial implementation |
| red-04-card-honesty | 1 | 3 | 1 | 2 | Deliberately filtered card checks fail; sampling control passes |
| green-05-affected | 0 | 70 | 70 | 0 | Final production source across policy, proposals, card, owner, verbs, canary/heap and boundary |
| green-06-typecheck | 0 | — | — | — | Compiler after final production changes |
| green-07-strengthened | 0 | 25 | 25 | 0 | Final amended/new policy tests |
| green-08-typecheck | 0 | — | — | — | Final compiler |

All test records show zero cancellations, skips and todos. The filtered RED invocation did not run the other cases; it is not full-suite evidence. Unique exercised cases total 25 policy plus 49 existing affected tests, not one 74-test run. No claim that red-01 proves an argv product defect is accepted: the corrected red-02 controls establish that distinction.

The retained launcher and records show cached Playwright with `--pull=never`, `--network=none`, user 1000, read-only repository and Node 26.3.1 mounts, private temporary homes, finite launcher environment and no owner/desktop credential mounts. Every invocation reports the no-Kubernetes tripwire armed and never fired. Compiler stderr is empty. Existing security assertions were not removed or weakened in the immutable change.

## Findings and carry-forward triage

- Critical: none introduced/found in Task 5.
- Important: none introduced/found in Task 5.
- Minor: none introduced/found in Task 5.

The prior **M1 CoreVault per-name cost** concern remains in final branch triage. It was not re-investigated, waived or closed by this scoped review.

The existing Node **`--allow-child-process` SecurityWarning** remains retained in `evidence/task-5/green-05-affected.stdout` (node:340, with trace-warnings hint). It is not a new Task 5 warning, not a compiler failure, and not silently waived. Existing launcher warning flags at `src/broker/broker.ts:462` are unchanged. Root still owns final warning and permission-model triage.

## Cannot verify / scope limits

This review verifies source relationships and retained test evidence; it did not independently rerun tests or observe the historical runs live. Recorded isolation and chronology are supported by contemporaneous records, retained snapshots and hashes, not a tamper-proof external attestation. No test was needed to settle an unresolved source question.

This task does not prove public-host TLS behavior, Windows lifecycle behavior, owner keychain behavior, UI rendering of final integrated cards, immutable project files, elimination of the documented executable path race, HTTP header/body binding, or a secret-free legacy core. It does not supersede Task 6 supervisor/reset/diagnostics/SECRET_DIRS integration, P1b actual consumer/browser relay cutover, P1c/full aggregate tests, or the final most-capable whole-branch adversarial review.

**RELEASE — Task 5 spec and quality gate only.**
