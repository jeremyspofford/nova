# Spec compliance: Compliant for Task 2 fix round 1

**Task quality: Approved for this scoped fix. I1: ADDRESSED.** New findings: **0 Critical / 0 Important / 0 Minor**. Original **M1 remains open, nonblocking for this fix, for root's final triage**; it is not resolved or discarded.

Reviewed immutable package `review-15d5cf68..95f96c4a.diff` once, base `15d5cf68417333cbbff49833c2a63a1cbfb5e612`, head `95f96c4aad9571f6cd337e0c9b9150a3d20f18af`. Re-read `task-2-brief.md`, the entire original Important section headed “Newly revalidated warm reads can silently disable outbound secret screening,” and the complete fix-round appendix of `task-2-report.md`. This review covers I1 and new breakage in the authorized fix, including configured memory/standing callback failures when tainted. It is not a broader branch or phase approval.

## Original finding disposition

**I1 — ADDRESSED**, at `src/core/index.ts:501–508` and `src/core/ingest/screen.ts:305–324`.

The actual Core collector no longer converts a failed enumeration into an empty secret list. It propagates read errors and explicitly rejects a listed entry returning a non-string/null instead of silently discarding it. The production Screen catches that failure and returns the existing `OutboundResult` with `ok:false` and a fixed safe reason; it no longer performs a second catch-to-empty conversion. This closes the exact silent-success behavior in the original finding, including a failure after an earlier credential was successfully read.

The implementation preserves fresh Vault/key-loss behavior: this fix has no `src/core/vault.ts` delta and adds neither a stale plaintext workaround nor a new snapshot/raw-value API. The eight actual Core regression cases at `tests/ingest/vault-unavailable.test.ts:53–112` invoke `createCore().ingest.outbound` through production wiring, with real ciphertext and injected key stores rather than a copied collector. Both tainted and untainted scans refuse credential and benign payloads on warm loss, cold unavailability, a later lookup exception, and an entry disappearing during enumeration. At `:59` the warm test separately asserts that Vault itself still refuses a fresh read while the keychain is unavailable.

Restored availability permits benign output and continues to reject saved secrets; encoded controls remain at `tests/ingest/vault-unavailable.test.ts:63–66`. The partial failure test proves list and the first entry completed before the third lookup fails (`:79–97`). The disappearing-entry test uses another real Vault to clear committed state and then restores the synthetic ciphertext for success controls (`:99–112`). These assertions prevent an unconditional-block implementation from masquerading as the fix.

## Strengths and named risk checks

- **Both failure-swallowing layers:** `src/core/index.ts:503–507` propagates exceptions and rejects missing listed values; `src/core/ingest/screen.ts:307–324` catches the whole synchronous scan/check and produces a refusal. The report correctly notes that removing only the first catch would not have addressed I1.
- **No diagnostic/credential disclosure through the new refusal:** `src/core/ingest/screen.ts:306,312,314,321–323` uses only the fixed source labels “the vault,” “memory,” and “the standing files.” It neither interpolates the caught exception nor logs the payload. `tests/ingest/vault-unavailable.test.ts:46–50,67–68,95–96,123` checks saved-secret, private diagnostic and synthetic private-path canaries in results and applicable Core logs.
- **Authorized adjacent source failures remain conditional:** the memory/standing callbacks remain inside the lazy `mine` closure (`src/core/ingest/screen.ts:311–316`), preserving the existing outbound policy rather than eagerly requiring them for every request. `tests/ingest/vault-unavailable.test.ts:115–131` verifies tainted refusal, no memory/standing call for untainted output, and recovery after the source becomes available. The optional callbacks retain their prior absent-source behavior. No unrelated policy redesign is present.
- **Scope and maintainability:** the package changes the collector, one bounded Screen method, and one 131-line behavior-test file. The error boundary is short and local; there is no new abstraction, dependency, API/file-format change, migration-epoch work, or broker/runner modification. The fixtures use private temporary homes, real Vault operations and injected stores (`tests/ingest/vault-unavailable.test.ts:18–43`); Core closes before fixture removal.
- **Freshness/recovery contract preservation:** the original Vault implementation is untouched in this package, and all 22 B6 tests appear as passing in `evidence/task-2-fix1/green-focused.stdout:8–29`. This supports the absence of an intentional stale-cache shortcut; no broad re-review of unchanged recovery code was necessary.
- **Downstream contract limits:** the fix returns a non-ok guard result through the existing contract. It does not alter the runner's existing explicit-approval semantics or promise an unoverrideable network prohibition. The new Core integration tests end at the guard result, as the report states. No unsupported end-to-end transmission claim is needed to close I1.

## New breakage findings

### Critical: 0

None found in the scoped fix.

### Important: 0

None found in the scoped fix. Original I1 is addressed as above.

### Minor: 0 new

No new minor finding. Original **M1 remains outstanding**: N-entry collection still performs N+1 Vault observations/key-store probes. `src/core/index.ts:503–507` retains the list/get fan-out; this fix deliberately does not modify Vault's read cache. The report's fix-round “Self-review, remaining concern and limits” explicitly preserves M1 for final triage. No real keychain latency measurement or per-name performance improvement is claimed. M1 is nonblocking for this I1-only re-review under root's scope.

## Verification evidence inspected

Evidence directory: `.superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-2-fix1/`.

Read the launcher, all six JSON records, all six stdout files, and verified all six stderr files are empty. The launcher and each recorded argv show cached `mcr.microsoft.com/playwright:v1.56.1-noble`, `--pull=never --network=none --user=1000:1000 --read-only`, private `/tmp`/HOME, only the authorized worktree and Node 26.3.1 read-only mounts, `/workspace` container cwd, and the exact enumerated host/container environments. All records retain start/end timestamps and exit status. The no-Kubernetes tripwire is armed and reports never fired in every output. No warning-suppression flags or unexplained compiler/test warnings were observed.

| Retained label | Command and result verified |
| --- | --- |
| `red` | `sh scripts/tripwire.sh node --test --test-concurrency=1 tests/ingest/vault-unavailable.test.ts`; exit 1, 10 tests, 0 pass/10 fail. All ten are the expected true-versus-false behavioral assertions, not setup/import failures. |
| `green-new` | Same single-file command; exit 0, 10/10 pass, 0 skips. |
| `green-focused` | `sh scripts/tripwire.sh node --test --test-concurrency=1 tests/ingest/vault-unavailable.test.ts tests/core/vault-owner-findings-b.test.ts tests/ingest/guards.test.ts tests/ingest/core.test.ts tests/ingest/taint.test.js tests/ingest/canary.test.js tests/ingest/egress.test.ts tests/ingest/run-mode.test.js tests/core/broker-boundary.test.ts`; exit 0, 66/66 pass, 0 skips/failures. Output names B6, Core ingest, ordinary/encoded secret and memory guards, runner taint/canary, local egress/privacy/run-mode and boundary controls. |
| `typecheck` | `sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json`; exit 0, stdout only expected tripwire notices, no diagnostics. |
| `green-final-new` | Same single-file test command after the reported partial-scan test strengthening; exit 0, 10/10 pass, 0 skips/failures. The final diff contains benign-payload and recovery assertions in both partial cases. |
| `typecheck-final` | Same compiler command after those test changes; exit 0, no diagnostics. |

The evidence retains the intentional RED and all later attempts. The report explains the final rerun by concrete test-body changes rather than repeating an unchanged green suite. Reported independent validation pairs have separate container invocations and overlapping recorded timestamps. The previous Task 2 real-secret-tool skip is not a fix-round skip: all fix-round green tests report zero skips, while real OS-keychain behavior remains untested.

No suite or focused probe was run by this reviewer: the diff and retained runs answer I1 and the scoped adjacent-policy concerns. No additional source inspection outside the immutable fix package was needed for this round; prior review context supplies the unchanged pure outbound function contract. No git diff/status/index/branch commands were run.

## Cannot verify / retained scope limits

- Real OS-keychain behavior/latency, keychain loss injected into an actual runner/network session, full-suite behavior, physical lifetime/heap gates, P1b consumer cutover and P1c completion are not established by these runs. The report explicitly disclaims them. Existing runner canary output is supporting regression coverage, not a substitute for a new keychain-loss end-to-end test.
- The unchanged public broker protocol/budget is covered by the passing boundary tests and absence of a broker delta; unrelated broker source is not re-audited here.
- Broader P1a takeover NOTES and all other phase/global gates remain root-owned. This fix neither completes nor weakens them.
- The original M1 performance observation remains available for root's final triage; approval of this correction must not be represented as its resolution.

## Assessment

**Spec compliance: Compliant for the authorized fix. Task quality: Approved. I1: ADDRESSED.** The change propagates incomplete scans into a safe non-ok result at both required layers, with real Core tests demonstrating failure and recovery. No new scoped breakage was found. Counts: **0 new Critical / 0 open Important / 0 new Minor; 1 carried Minor (M1)**.

**RELEASED.** Only this requested review report was written. Source/index/HEAD/branch state were untouched; no subagents, repeated tests, push, PR, merge, preview, owner services or real keychain access.
