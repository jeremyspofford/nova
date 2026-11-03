# Task6 fix1 scoped re-review

**APPROVE for this scoped repair. I1 addressed; I2 addressed. New findings: 0 Critical, 0 Important, 0 Minor.** Spec and code-quality verdicts both pass within the I1/I2/new-breakage scope. No remaining blocker from the original Task6 review. Task7 and ordinary full-branch qualification remain required.

Reviewed `2827e53ba94c1f6589ddb7bed95ab2e849f1ccd4..44a8deb563324ac2847c02dc82dfc6e3aec32d85`, exactly three files: broker spawn helper, Supervisor and lifecycle regressions. Read the complete immutable37624-byte diff once in two bounded nonoverlapping chunks; independently verified SHA256 `1ec5698ae6061607397bad9875c13f20d74e145ff8eee67f59ef1d2c63adc879`. Read the new report appendix260–EOF and updated status5, fix/re-review briefs and original I1/I2. Did not repeat the earlier broad Task6 package review.

## I1 — addressed

`src/supervisor/supervisor.ts:264` now refuses startup with retained broker/Core ownership or an in-progress stop. This shared admission check applies to rollback's fallback as well as ordinary replacement. `#start` at249 tracks one startup operation; restart/recover/deploy/rollback reject concurrent startup. The original rollback error path can no longer overwrite the failed broker handle. Its attempted fallback enters the shared guard, failed cleanup stays retained, and the supervisor remains in safe mode rather than reporting running.

The regression at `tests/supervisor/broker-lifecycle.test.ts:274` promotes the actual reviewer failure into the suite, checks safe mode/no Core/no false running response, and also checks repeated restart/recover/rollback refusal and retained device evidence. The positive control at372 verifies that a failed new-release Core startup with **confirmed** broker cleanup can still return to the previous release. This separates failed release availability from unconfirmed process ownership; the fix does not disable legitimate rollback.

## I2 — addressed

`src/supervisor/supervisor.ts:172,216,249,400` separately tracks run/start/stop and shares one close promise. Close stops service admission, joins the pending run/start (including reset cleaner), then joins pair cleanup before removing lifecycle evidence. All close callers observe the same completion or failure. The late broker handle is retained for that joined cleanup; failure after close begins is rethrown into the tracked operation rather than swallowed by the closed crash callback. The run continuation checks closure before timers/service resume, reset checks before directory deletion, and late ready/crash continuations cannot restart work or overwrite the stopped state.

The stop promise also joins a stop that already took the Core handle before close arrived. Startup and stop operations do not await close, so the new join structure introduces no cycle in the inspected paths. Preflight run refusal is joined without inventing a child-cleanup failure; actual child startup remains separately tracked.

`src/broker/spawn.ts:60` delays readiness rejection until the actual child close event. Its stopped promise is now based on close, including spawn-error cases. Failure/timeout is not treated as physical completion. This intentionally allows an uncooperative child to keep the operation pending.

Tests beginning at `tests/supervisor/broker-lifecycle.test.ts:318` use actual copied-release children and controlled readiness barriers for replacement, initial run, reset and late cleanup failure. They check two close callers stay pending with PID evidence while the exact child is alive, then verify physical exit, shared late failure, retained evidence on failure, no Core/service/timer revival and no reset continuation. Tests at387 and412 cover failed readiness while alive and close racing an already-started Core stop. The foreign-home preflight control remains intact. Barriers are confined to disposable copied source; no production test hooks were added.

## Verification and provenance

No reviewer test was needed or run: code inspection and existing deterministic proofs answered the scoped concerns. Read raw final outcome/warning lines and launcher statuses:

| Existing attempt | Actual result |
| --- | --- |
| 58 affected checks | 77/77, fail0/cancel0/skip0; egress/Kubernetes guards never fired |
| 60 final compiler | Exit0; Kubernetes guard never fired |
| 61 final controls | 9/9, fail0/cancel0/skip0; egress/Kubernetes guards never fired |

Counts overlap and are not summed. Independently compared all three final committed blob SHA256s to the contemporaneous60/61 launcher maps and verified the exact changed path set. Both maps match44a8. Attempt58's two production blobs also match44a8; its test differs only by the reported final result-type annotation. The records correctly identify historical host/visible HEAD2827 during dirty-source validation; they do not falsely identify those runs as executions of an already-created44a8 commit. The [source receipt](evidence/task-6/fix1-final-source-context.json) agrees with these independent comparisons.

Read the full fix chronology:52 intended5/5 RED before production edits;53 five GREEN;54 exact-baseline spawn-helper RED after the initial fix with restore hashes (not initial preimplementation evidence);55 two controls pass and introduced preflight-close regression fails;56 close-during-stop RED;57 nine GREEN;58 affected77 GREEN;59 genuine TS2339 test compilation error; one explicit annotation;60 compiler and61 nine final controls pass. Failed attempts remain retained; no force-exit, timeout increase or container termination was introduced. Four existing permission-model SecurityWarnings are present in58 stdout;60/61 have no warnings. No warning suppression or new skip.

## Scope and limits

The fix changes lifecycle ownership, not protocol/auth, keychain policy, metadata projection, fixed seal serving, imports, dependencies or the broker budget. Reported broker count is2896/3000; affected boundary checks pass. No new runtime bridge, raw-value getter, privileged-code relocation or production fixture hook appears in the three-file diff. Earlier diagnostics/Caps/module proof remains historical2827 evidence; no new broad-suite or whole-product claim is inferred from these lifecycle checks.

This scoped review does not establish physical Windows/macOS keychain behavior, universal containment, escaped-descendant/zombie disappearance, P1b/P1c cutover, final CI or Task7 approval. A nonsettling owned startup/cleanup can keep shutdown pending by design. The original Task6 scope/limits remain in [task-6-review.md](task-6-review.md), with its two findings closed by this report.

HEAD verified44a8deb563324ac2847c02dc82dfc6e3aec32d85 and tracked diff empty. Reviewer wrote only this private report; no source/index/HEAD mutation, delegation, owner data/keychain access, GitHub/preview, cloud/model/device action or image pull.

**RELEASE — I1/I2 closed; no new scoped findings. Proceed to the separate Task7 gate.**
