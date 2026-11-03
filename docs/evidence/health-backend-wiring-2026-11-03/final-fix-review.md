# Scoped final fix-wave re-review

**Verdict: CHANGES REQUESTED for one introduced test regression.** Original findings **I1 ADDRESSED / M1 ADDRESSED**. New findings: **0 Critical / 1 Important / 0 Minor**. No new production security defect was found in the reviewed fix. Root must adjudicate the residual below; this report does not start another implementation loop.

Review scope is FIX_BASE `f9ffbb0c2b241b60ba5161cc55bbdb8c3462b819` through HEAD `4e7278d1b662a376ea3c6d2fe2e543830e2b55a8`, using the complete immutable `review-f9ffbb0c..4e7278d1.diff` (six files, one commit). Read the full final-fix brief, both verbatim original finding sections, full Global Constraints, progress rulings 3/4, and complete 121-line final-fix report. This is the requested scoped fix review, not a second whole-branch review. No regenerated git diff, broad test run, source/index/HEAD/branch mutation or subagent.

## Per-finding verdict

### I1 — ADDRESSED

The required known-secret scan now either completes or throws the internal `SecretScanUnavailable` with a fixed literal message. Vault listing exceptions, exceptions/missing values on any enumerated entry, standby-key read failures, non-ENOENT file-key read failures and unreadable/invalid/incomplete mesh secret identity cannot become an empty/partial successful scan. A populated vault without a key is rejected. A genuinely empty vault and absent optional file-held key remain valid.

`src/core/diagnostics/index.ts:90`–130 contains the bounded source scan/error translation. `buildDiagnostics()` at line175 invokes it before reading included model/config/log metadata. The endpoint catches only this internal error at lines232–237, returns `Reply` status503 with an error-only body and no attachment, and lets other exceptions retain the existing API handling. The internal error discards raw source causes. It does not enter shared unexpected-error logging. The established default person access and no-store response logic are unchanged; refusal is inside the already-authorized handler.

The required mesh source is justified by the existing `loadIdentity()`/`importDeviceKeys()` writer/reader contract: production Core creates or imports both private key fields. This is not a new requirement to read optional nonsensitive metadata. Strict refusal reduces diagnostics availability when a required secret source cannot be checked, as explicitly ruled by root.

The real HTTP regression faithfully reproduces the original report: empty/readable controls, actual stored opaque credential in encoded included log text, close, move only the private fixture key, restart and reject the download. Additional bounded source faults cover list, second get throw/null, standby key, actual chmod-based unreadable key/identity, malformed identity and incomplete identity. The tests assert fixed error-only503/no-store/no attachment, no credential/path/error detail, no included model metadata read, no new persisted file and no raw source error in service logs. Existing successful known-secret encodings and excluded-store assertions remain intact.

The scan's form/shape/key matching prefix is independently byte-equal to FIX_BASE; no matching relaxation, raw getter, extra store, dependency, API bypass or retained bundle was added. Documentation now accurately states failure refusal and the unknown-free-text limit. No rerun was needed to re-establish the already-green I1 cases.

### M1 — ADDRESSED

`src/core/caps/index.ts:282` removes only the phantom Health destination. Tasks approval, available-day-budget and midnight-reset language remain. The matching acceptance assertion removes the wrong Health requirement and explicitly checks the retained resume/day-reset sentence; stop reasons, zero model/tool calls on the second task, waiting resume and earlier tier-2 approved-resume controls remain unchanged.

`src/core/README.md:70` now describes active person-access backend APIs and Core-owned Caps, while Health controls/approval/crawl remain pending #285. No Caps enforcement/accounting logic or UI implementation changed. The original M1 is closed.

## New breakage introduced by this fix

### Important — R1: Align the existing stable-name-token test fixture with the stricter secret-scan contract

**Introduced at:** `src/core/diagnostics/index.ts:121`–129. **Affected existing caller:** `tests/acceptance/m10g-review2.test.ts:258` (test starts line254).

The existing test “minor: the name token never reaches the agent and is a secret to diagnostics; epochs are never made past the ceiling” directly calls `knownSecrets()` using a stub empty vault and `home: '/nonexistent'`, then asserts that `NOVA_MESH_NAME_TOKEN` enters the secret set. The new mandatory mesh identity read throws before the environment-token assertion. This also prevents the later epoch-ceiling assertions in the same test from executing. `package.json:15` includes this acceptance test in ordinary `npm test`; the green 28-test selection did not include it.

A narrow actual run of that one existing test confirms the regression: **exit1, tests1/pass0/fail1/skipped0**, with the fixed scan error thrown from `knownSecrets` line129 and the stack pointing to the unchanged caller at line258. This is not an unrelated flaky failure, a missing dependency or the intentionally failing original I1 RED case. It follows directly from the new source precondition. The word “minor” in the historical test name is not this finding's severity.

**Required resolution:** update that test to use a disposable valid identity/home (for example its existing private Core fixture) while retaining the environment-token inclusion, agent environment exclusion and epoch-ceiling assertions. Do not restore fail-open handling for a missing required production identity, remove/skip the test, or weaken the assertions. The needed correction is fixture compatibility with the new contract; no broader production redesign is indicated.

**Exact probe:**

```sh
python3 .superpowers/sdd/health-backend-wiring-2026-11-03/evidence/final-fix/launcher.py rereview-name-token sh scripts/test.sh --import ./tests/acceptance/egress-guard.ts --test-concurrency=1 '--test-name-pattern=minor: the name token never reaches' tests/acceptance/m10g-review2.test.ts
```

Retained `evidence/final-fix/rereview-name-token.json`, `.stdout`, `.stderr`. Started `2026-11-03T08:21:11.454648+00:00`, ended `08:21:12.706072+00:00`; tripwire **never fired**. The exception occurs before that test starts its paired Core scenario. No source fixture was edited and no successful suite was repeated. The launcher records clean host HEAD4e7278d1 and empty changed_blobs. Its readonly Git-identity overlay remains the explicitly documented actual FIX_BASE; this probe exercises the exact committed source file and does not make an about.build/final-head-CI claim.

## Evidence and provenance checks

Read the complete retained I1 and M1 RED stdout, final focused stdout/stderr, compiler stderr and runtime-identity stdout; inspected contemporaneous invocation records, launcher, source hashes and seals.

- I1 RED: exit1, 0/10 (two top-level tests plus eight children), with real-key-loss/list/partial-get exposures and remaining key/identity200-versus503 failures. Healthy controls passed internally before the real-key-loss refusal assertion. M1 RED: exit1, 0/1, from the still-present Health destination after the existing daily-stop checks passed. Both records show only the two test files changed before production fixes.
- Final selected run: **28/28, exit0**, zero skips/cancellations/todo, with original encoding/excluded-store tests and actual Caps composition/API/auth/validation/restart/stop/resume/conversation checks. Compiler **exit0**; ordinary npm invocation notices preserved. Runtime/identity **exit0**, Node **v26.3.1** and real FIX_BASE identity. These remain valid passing results despite the newly found omitted-caller regression.
- Independently verified all **79 original task1 sealed entries unchanged** and all **27 final-fix sealed entries unchanged**, including the complete final-fix report. Reviewer probe artifacts are additive and do not rewrite either original seal.
- Final green/compiler invocation source hashes match each other and each of the **six committed changed blobs**. All original11 equality claims are now historical: five originally picked files intentionally differ, six remain equal, and diagnostics builder is the additional sixth changed path. The documented mapping is consistent with the immutable six-file package.
- Independently decompressed/hashed the synthetic single-commit identity and compared its bytes with the actual Git commit object: exact FIX_BASE `f9ffbb0c...`, not fabricated identity. Source tests were run on this base plus recorded uncommitted changes, subsequently proven identical to commit4e7278d1. This is not exact-final-head hosted CI.
- The saved launcher has finite host/container env, private tmpfs HOME/file vault, cached Playwright image with `--pull=never --network=none`, uid1000, readonly own code/Node26 and explicit readonly matching dependency bind. No owner/shared Git directory or credentials are mounted. The reviewer used that unchanged launcher once for the concrete unanswered caller concern, with the existing egress guard/tripwire. No network/image pulls, installs, owner keys/keychain/home/services/model/provider/cloud/device/account actions, or preview.

## Controller publication correction and scope limits

The implementer correctly flagged the current evidence prose for root's already-assigned publication step. `docs/evidence/health-backend-wiring-2026-11-03.md:27`–29 still says all eleven files “have exactly the same Git blobs” and no source adjustment was needed. Scope that wording explicitly to the initial pinned integration and add the reviewed fix deviations/results before publishing it as current evidence; similarly qualify the earlier unchanged-source/check statements. This is a known controller-owned publication obligation, not an additional unexpected source finding or a request for another whole-branch review. Preserve historical statements and failures at their proper pins.

No other out-of-scope issue is added to the finding list. Unknown personal free text, supported metadata, provider-report/other-node accounting and owner-gated UI limits remain the previously stated constraints, not new requirements. Health approval, rendered controls/browser interactions, Home phone/rail crawl and W1/W2 completion remain in #285. Root retains ordinary exact-head CI, final evidence publication, PR/push/merge, matching-tree and authorized preview gates. This scoped approval of I1/M1 does not satisfy those gates.

**Spec verdict:** I1/M1 and required-source rulings implemented as requested. **Quality verdict:** changes requested solely for introduced regression R1. **Current counts:** 0 Critical / 1 Important / 0 Minor. **Original finding status:** I1 ADDRESSED, M1 ADDRESSED.

**RELEASE:** Scoped re-review complete; no further review/source writes or test runs planned. Findings set final. Return ownership to root for residual adjudication under the single-wave process; do not start a reflex new fix loop or waive the failing existing test.
