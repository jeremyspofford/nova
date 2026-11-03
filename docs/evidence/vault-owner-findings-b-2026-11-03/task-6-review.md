# Task 6 independent spec and quality review

Status: **REQUEST CHANGES — 0 Critical, 2 Important, 0 Minor findings.**

Spec verdict: **not complete**. The lifecycle NOTE requires every path to retain unconfirmed ownership and await actual cleanup. Rollback bypasses that hold, and shutdown does not join an in-flight broker start. Code-quality verdict: **request changes** for those two lifecycle defects. The reset, IPC, fixed module, diagnostics projection and documentation changes otherwise meet the inspected Task6 scope. This is the Task6 review, not Task7's whole-branch/live-adversarial gate.

Reviewed immutable range: `6185726bd5066fe1896251eb34d08f4e8598b8ad..2827e53ba94c1f6589ddb7bed95ab2e849f1ccd4`. All six Task6 commits and qualified-main integration `c3bc7c49` are included; this is not a last-commit review.

## Important I1 — Rollback restarts after unconfirmed broker cleanup

**Location:** `src/supervisor/supervisor.ts:794–808`, especially **801**, with retained failure at `#stopServer` and unguarded ownership replacement at **247–250**.

`rollback()` catches the rejection from `await this.#stopServer()` at line738 and unconditionally calls `#start()` when Core is absent. That is exactly the state after an owned-broker shutdown failure: Core has stopped, the failed broker handle is deliberately retained, and safe mode has been set. `#startPair()` does not refuse that retained handle and overwrites it with a new broker. Its Core ready handler then reports running. Thus rollback defeats the protection that the new restart/recover tests establish.

**Executed reproduction:** one fresh private test reuses the immutable lifecycle fixture and its existing injected `broker.stopPrograms()` rejection. It starts the tagged synthetic release `v1.1.0`, then asks the actual Supervisor to roll back to `base`. The response correctly says `ok:false`, but the observed state is wrong:

```json
{"result":{"ok":false,"said":"Going back stopped (Broker owned cleanup was not confirmed; operator recovery may be needed.); Nova kept v1.1.0 running."},"mode":"running","oldPid":53,"broker":{"status":"running","pid":68},"coreRestarted":true}
```

The assertion that Core must remain absent fails. This is not a coverage-only concern: the supervisor admits replacement work after explicitly failing to establish that the previous credentialed work was cleaned up. The probe injects the same real failure contract as the existing restart test; it does not claim that a real escaped process was demonstrated.

Fix the rollback fallback and enforce the retained-cleanup hold at the shared admission boundary, so another recovery path cannot bypass it. Preserve failure evidence and safe mode, and add the failing rollback case to the production regression suite before changing implementation. A failed release startup that actually cleaned up may still recover; an unconfirmed cleanup must not.

Evidence: [probe](evidence/task-6/review-rollback-cleanup.test.ts), [probe hash/provenance](evidence/task-6/review-rollback-provenance.json), [exact launcher record](evidence/task-6/review-51-rollback-cleanup.json), [full failing output](evidence/task-6/review-51-rollback-cleanup.stdout), [stderr](evidence/task-6/review-51-rollback-cleanup.stderr). Exit1; tests1/pass0/fail1/cancel0/skip0; natural exit. No green suite was rerun.

## Important I2 — Shutdown cannot await a broker that is still starting

**Location:** `src/supervisor/supervisor.ts:247–249`, together with **204–220**; reset-only child at **240–241** has the same missing ownership join.

The actual child exists while `await startBroker(...)` is pending, but `#broker` is assigned only after readiness. During that interval `close()` sees no broker (and, during replacement startup, no Core), completes its allSettled calls, removes `supervisor.pid`, saves stopped state, and resolves. The later `#closed` check at line248 does attempt to stop the late broker, but that cleanup promise belongs to the pending start, not to the already-resolved close. A failure there is also swallowed by `#start()` calling `#crashed()`, which immediately returns when closed. A reset-only child is likewise only a local variable, invisible to close.

**Concrete code-traced interleaving, not an executed second probe:** start normally; begin a restart; hold the replacement broker immediately before its ready message; after its process has spawned, call `close()`. The previous pair has already stopped, `#broker` is null and `#startPair` is awaiting the new child. Current close can resolve while that exact owned child is still alive. Releasing the ready barrier triggers cleanup only afterward. This path is reachable during ordinary running operation, when `src/supervisor/main.ts:136–141` has installed signal handlers that await only `sup.close()`.

For an initial `run()/close()` overlap, `run()` additionally continues to install its health timer and call `services.resume()` at lines198–200 after the awaited start returns, without a closed-state check. The primary security defect is the missing physical-lifetime join; no claim is made here that an existing service was dynamically demonstrated to revive.

Track the startup/reset-cleaner operation as owned work before awaiting readiness, and have close await its cleanup outcome, including failure, before dropping lifecycle evidence. Ensure the run continuation cannot resume work after close. Add a deterministic readiness-barrier regression; a timeout or a later best-effort stop is not evidence that close itself awaited cleanup.

## Scope and contract checks

- Fixed broker source comes from the selected release's `src/broker`; only the trusted Supervisor imports `spawn.ts`. `nova-broker` is reserved against editable service definitions. Core receives only socket/core-role token over private parent-child IPC; state projects status/PID. The bootstrap validates exact message/context shape, strips listeners, handles disconnect/missing delivery, and does not add an HTTP bridge. Deliberate client close clears its token, destroys the opening/active socket and permanently refuses reuse. Existing verbs and auth schema remain unchanged.
- Normal broker/Core shutdown and restart now await broker close evidence and service/pair cleanup uses allSettled. Failure retention on restart/recover is covered, but I1/I2 prevent approval of the universal lifecycle claim. Three-crash backoff/safe mode, release selection, old-release unsupported behavior and real TERM-resistant process cleanup have targeted tests. No stale-PID kill was added to the broker lifecycle.
- Reset verifies the fixed-home authenticated marker before cleanup; the supervisor passes the same seal to `finishReset`, which revalidates before removal. Unknown run entries, non-directory broker storage, invalid/missing device records with non-runtime entries, and foreign homes refuse conservatively. Exact device/sign accounts are removed without key reads or recreation. Linux/macOS item-not-found handling is narrow; Windows removal uses RetrieveAll metadata with exact Resource/UserName filtering and no RetrievePassword or catch-all missing interpretation. Fake-keychain partial device-deleted/sign-rejected retry preserves unrelated accounts. The existing test only plants a file for missing-device-record refusal; the implementation also rejects an empty `items/` directory by its top-level name check.
- Existing SECRET_DIRS behavior is exercised through actual git ignore, journal, backup and checkpoint selectors: only broker/items ciphertext is included in backup; broker keys/headers/runtime are excluded. Reset retains foreign home entries. No production selection exception was added here.
- Diagnostics keeps required legacy Vault/key/identity scanning before included metadata. Fixed503/no attachment/no-store and person authorization remain; optional broker failures project boolean availability/problem only. The explicit broker allow-list returns typed states/counts, never names/refs/entry keys/raw errors or values, and the unchanged whole-bundle scrubber still applies. No raw broker getter or matcher exception was introduced. Qualified-main Caps ownership, request-time Era2 counts and the R1 private-Core fixture retain their contracts.
- The seal endpoint reads only the fixed public source and uses type erasure, without executing/importing privileged broker runtime. Its route is explicitly person access through Raw; actual browser→separate broker→bound synthetic program proof covers the module, unknown-source404, anonymous401 and query non-selection. Existing Raw security behavior is not altered. This does not switch app forms or prove removal of legacy plaintext consumers.
- The broker boundary budget remains <=3000 with no exemption, dependency or privileged relocation. Final combined evidence passes the boundary check; implementation reports2894/3000. This review did not independently recount the whole pre-reviewed broker tree. Plain LEDGER/ROADMAP/Secrets inventory say branch-only lifecycle integration, keep P1b/P1c and full review/CI pending, and retain C18/C19 app/UI limits and historical navigation claims. No unsupported credentialed J/K or whole-product read-isolation claim was accepted.

## Package and verification accounting

Read `task-6-review-brief.md`, `task-6-brief.md` and the **full** `task-6-report.md`, including all historical/final sections and attempts01–50. Applied engineering:code-review. The primary diff was read in bounded chunks through EOF; initial tool-output truncation was recovered explicitly. No changed source was reread wholesale. The narrowly expanded source context was the rollback try/catch omitted by diff hunks, exact line references for startup/close, and the main shutdown caller. Fixture/helper/launcher/egress-guard reads supported the one named reproduction.

Independently verified package hashes:

| Package | Bytes | SHA256 |
| --- | ---: | --- |
| Primary focused diff | 332945 | `b6232f5499454e7a3a887d836035e82e5584935b89ee3edde4296b0a0a5f80d6` |
| Complete master | 647697 | `f06a9231fd871d81e158349ec46a640d25e3f0cabe0370aaa16e2d3f761fc7fa` |

122 changed paths total; primary includes all34 runtime/test/task-document paths. The88 omitted paths are historical evidence under `docs/evidence/health-backend-wiring-2026-11-03/` only. Independently checked every mapped blob against both final2827 and qualified-main702dd: **88 exact matches, 0 mismatches**. Relied on their prior qualification; did not reread those records or the master content. No production/test omission or gate waiver.

Read final49 raw outcome: **119/119**, fail0/cancel0/skip0, natural exit, tripwire never fired. Final50 compiler exit0/tripwire never fired. These are existing implementer checks, not reviewer reruns. Earlier overlapping test counts are not summed. The full report preserves genuine failures and corrections: incomplete owned-container terminations13/29/41; corrected natural bootstrapRED30; insufficient socket-raceRED31 versus exact-baseline permanent-closeRED33; genuine compiler37 errors corrected39; actual browser40; diagnosticsRED42/GREEN43; combined45 **117/119, failed despite its green label**, real Supervisor boundary fix and private Git identity correction; R1 fixture46 1/1, boundary47 2/2, diagnostics48 12/12, final49 and50. Direct prefix compilers06/23 lacked the tripwire, as disclosed.

Warnings retained: final49 stdout contains four existing `--allow-child-process` SecurityWarnings and one `stripTypeScriptTypes` ExperimentalWarning; compiler50 has none. The type-erasure warning is a new API limitation, not a hidden test failure. Earlier Docker deprecated `--time` notice, historical npm notice and test/report-generation failures remain in the implementer report. The reviewer probe's stderr is empty; no suppression was introduced. Two reviewer metadata-inspection commands had harmless Python TypeError/KeyError from assuming the provenance JSON shape; corrected read-only inspection verified the counts/blob map. They were not runtime tests and changed nothing.

Reviewer51 used the existing recorded launcher: cached Playwright image with `--pull=never`, networknone, uid1000, read-only own code/Node26.3.1, private HOME/tmp, finite launcher environment and safe private Git identity. Added the existing egress guard; egress and Kubernetes tripwires never fired. Exact argv/env/cwd/timestamps/status and probe hash were saved. The synthetic release alone substitutes the existing failure injection; tracked production/test source is unchanged. No real owner data/keychain, cloud/model/device, image pull, GitHub/preview operation, broad process kill or other checkout mutation occurred.

## Limits and handoff

I1 is dynamically reproduced; I2 is a direct asynchronous ownership trace and proposed deterministic reproduction, not a claimed second executed test. No physical Windows/macOS keychain proof, universal OS containment, escaped-descendant/zombie proof, whole-app cutover, broad full-suite validation or final publication qualification is supplied. Prior Task2 per-name keychain/IO cost remains a carryforward, not a duplicate finding. Task7 still requires its distinct whole-branch/live-adversarial review after Task6 repair.

Final checked HEAD remains2827e53ba94c1f6589ddb7bed95ab2e849f1ccd4 with empty tracked diff. Only this ignored review report and private probe/evidence were created. No source fix, commit, index/HEAD mutation or delegation.

**RELEASE — review complete; return I1/I2 to the original implementer for a single scoped test-first fix wave.**
