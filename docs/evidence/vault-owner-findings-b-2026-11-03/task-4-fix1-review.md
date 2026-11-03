# Task 4 fix round 1 — independent scoped review

FIX_BASE `8e58b51ba57a2d52c244745340dee923a9051a06` → HEAD `fde6fdefdace1735b32d671ea5400ffa50f4949e`.
Workspace: `/home/jeremy/.codex/worktrees/nova-vault-integration/nova-build`.

**I1: ADDRESSED.**

**Spec verdict: PASS for the scoped I1 correction.** All captured owned cleanup promises settle before shutdown propagates a failure. Failed ownership remains failed and retained.

**Quality verdict: APPROVE for this fix diff.** No new actionable breakage found. Outstanding counts in this fix review: **Critical 0 / Important 0 / Minor 0**. Original Task 4 I1 is closed by this correction. This is not whole-branch or P1 completion approval.

## Why the correction closes I1

At `src/broker/broker.ts:471`, `Promise.allSettled` replaces the first-rejection aggregation. The first rejected result is propagated only after all captured promises have settled (`:472–473`); the existing program-failure guard remains. Admission stops before ownership is captured, and every captured stop callback still runs. Already-rejected promises therefore cannot bypass pending escalation/close/cleanup of another owned group.

The unchanged successful cleanup path (`broker.ts:423–430`) signals KILL, removes the directory, deletes the owned map entry and decrements the lane before resolving its cleanup promise. The normal spawned-child settlement remains attached to launcher close (`:456`). Failure paths retain the owned entry and do not decrement its lane. The fix does not alter these orderings or convert rejection to success.

The unchanged `src/broker/main.ts:26–27` consumer can still exit immediately when stopPrograms settles, but its catch can no longer run merely because one group's promise rejected while another captured group's promise remains pending. No main change is needed for I1. A cleanup that never settles keeps shutdown pending; this is consistent with the stated refusal to invent timeout-only successful cleanup and with the existing uninterruptible/escaped-process limits.

## Regression quality and the intermediate fixture failure

The two added cases at `tests/core/broker-owner-findings-b-launch.test.ts:336` use separate real broker-owned process groups with TERM-resistant target/descendant executables. They deny only the first captured negative PGID and pass the other group's signals through to the OS. One case has concurrent cleanup failure; the other waits for the first use to fail while the second remains active before requesting shutdown. Both uses begin before admission is blocked, so the test does not bypass the production admission rule.

Immediately after stopPrograms rejects, before awaiting the ordinary use response, the final source requires:

- Successful KILL delivery to the recoverable group (`:364`). The log entry is recorded only after process.kill returns successfully.
- Non-running launcher and both target/descendant executable PIDs (`:365–366`).
- Recoverable owned directory absent (`:367`), which for this spawned program follows its launcher-close settlement path.

It then separately checks the ordinary use result, failed-group credential/evidence retention, exactly one remaining run directory and refusal of another use (`:370–374`). Finally cleanup restores process.kill and signals only these captured test groups. No new production /proc authority is present.

The retained RED snapshot initially asserted that an outer use callback had already run at shutdown rejection. That is not the physical-cleanup promise: internal finish() occurs before the answer's handle/audit/caller promise chain has completed. `green-02-affected` passed the KILL assertion and failed precisely this outer callback ordering assertion in both variants. Removing that assertion is justified; it is not a waiver of cleanup. Final direct checks of launcher/executable state and directory absence run before awaiting the outer answer, and the final strengthened targeted run passes both. The original failing raw outputs remain retained.

## Inspected evidence

Read the original I1 Important section in full, the implementation report including its full fix-round appendix, and the immutable `review-8e58b51b..fde6fdef.diff` once. Reviewed the final added tests, retained RED test addition, and narrow unchanged cleanup/main consumer context needed to establish promise ownership and exit ordering. The prior Task 4 brief, Global Constraints and explicit zombie-only/strict-keychain clarifications remain the governing scope from the initial review.

Read all seven `evidence/task-4-fix1/*.json` attempt records, all seven complete stdout/stderr pairs, the launcher and final manifest. Results match the report:

| Attempt | Actual status | Review interpretation |
|---|---|---|
| red-01-multi-cleanup | Exit 1; 0 pass / 2 fail | Both real-process variants fail on missing recoverable-group KILL before shutdown rejection, before production correction. |
| green-02-affected | Exit 1; 26 pass / 2 fail | Historical green label is not success. Six boundary, four IPC and sixteen unchanged ownership/context cases pass on final production. New cases fail only the outer callback ordering assertion after passing KILL delivery. |
| green-03-typecheck | Exit 0 | Initial corrected production/new-test source; no diagnostics. |
| green-04-ownership | Exit 0; 18 pass / 0 fail | Corrected direct cleanup assertions; full amended ownership/context file passes. |
| green-05-typecheck | Exit 0 | No diagnostics. |
| green-06-immediate-state | Exit 0; 2 pass / 0 fail | Final stronger immediate target/descendant state assertions pass in both I1 cases, before awaiting the outer use answer. |
| green-07-typecheck | Exit 0 | Final source; no diagnostics. |

All seven records show natural completed statuses and final no-Kubernetes tripwire “never fired”; no test skips/cancellations or manual terminations. Stderr files are empty. Captured stdout preserves nine Node permission SecurityWarnings in green-02 and five in green-04; other attempts contain none. These warnings remain known security limitations, not waived or reclassified as newly introduced fix defects.

The launcher records exact cwd, clean enumerated environment, argv, start/end timestamps and actual status, refuses duplicate labels, and writes the initial record before invocation. It uses the cached image with --pull=never, --network=none, UID/GID1000, readonly checkout/root and Node26 mount, private executable tmpfs/HOME, and tripwire. No owner credentials, desktop socket, actual keychain, new OS account, model/cloud/device service or image pull is part of these tests.

Verified current HEAD equals `fde6fdefdace1735b32d671ea5400ffa50f4949e`; both final source/test SHA-256 values match the manifest. Recomputed broker size is **2822/3000 lines**, 178 remaining. The immutable diff contains only the stopPrograms production correction and two new test variants. No public protocol, environment, permission grants, keychain selection, dependency or credential access behavior changes.

No runtime suite or probe was rerun for this review: the retained evidence and narrow source inspection resolve the original concrete doubt. No source/index/HEAD/branch changes, child agents, publishing or services were used. Only this review report was written.

## Scope, limits and nonblocking carry-forward

The added denial cases are in-process broker tests with real owned OS programs and synthetic EPERM. They do not directly inject EPERM into an independently spawned main process. Their immediate observations combined with the unchanged main consumer establish the original failure's correction; the existing successful real-main shutdown case also passes in green-04.

Linux /proc observations are test-only. The accepted production contract remains group KILL delivery/ESRCH, launcher close and owned-directory cleanup, not zombie disappearance, malicious process escape prevention, copied-credential revocation or uninterruptible-kernel containment. Physical macOS/Windows/owner-keychain behavior cannot be verified by these records. No new claim is made about them.

Broader original Task 4 evidence and its historical limitations remain as recorded in `task-4-review.md` and the implementation report; only its I1 blocker is now closed. This review does not claim new canary/heap/egress or whole-branch coverage beyond the recorded scoped runs. Prior Task2 M1 CoreVault per-name I/O/keychain cost and existing permission warnings remain for final triage. Task5 policy/TTL, Task6 supervisor/reset integration and P1 product cutover remain separate work. No additional out-of-scope observation is proposed as a new blocker.

**RELEASE:** scoped review complete; I1 ADDRESSED, no new fix-diff findings. Released to root.
