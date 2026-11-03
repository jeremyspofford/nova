# Task 4 independent spec and quality review

Reviewed BASE `196ed6e42096754e20e70ddb1a33a693c87f179c` → HEAD `8e58b51ba57a2d52c244745340dee923a9051a06` in `/home/jeremy/.codex/worktrees/nova-vault-integration/nova-build`.

**Spec verdict: REQUEST CHANGES.** The trusted keychain context and explicit-keychain selection satisfy the reviewed contract. The owned-program shutdown contract is incomplete when one of multiple owned cleanups fails: shutdown can return before other groups receive escalation.

**Quality verdict: REQUEST CHANGES.** Counts: **Critical 0 / Important 1 / Minor 0**. No additional Task 4 findings are asserted. This is a Task 4 gate, not whole-branch approval or P1 completion.

## Important I1 — await all owned cleanup settlements before propagating shutdown failure

**Location:** `src/broker/broker.ts:471`; concrete consumer `src/broker/main.ts:27`.

`stopPrograms()` calls every stop callback, but `Promise.all(programs.map(p => p.done))` rejects on the first failed cleanup. `main.ts` immediately calls `process.exit(1)` on that rejection. With two TERM-resistant owned groups and signal denial for the first group, its five-second escalation rejects before the second group's escalation callback runs. The broker then exits, cancelling that second timer. The second group is otherwise killable but has received only TERM; its credential-bearing executables and directory remain. A previously rejected cleanup can make this happen immediately when shutdown begins as well. Retained evidence and refusal on restart are useful, but do not satisfy the requirement to complete cleanup of other groups the broker still owns and can stop.

**Reproduction:** Added only a focused review fixture under the evidence directory, using the existing private in-process broker/synthetic Python helpers. Two real inherited groups ignore TERM; process.kill denies only the first owned negative PGID. The probe awaits stopPrograms rejection and observes both OS state and delivered signals. `review-16-signal-delivery.stdout` reports:

```text
{"otherKillDeliveredAtShutdownReturn":false,"delivered":[{"pid":-85,"sig":"SIGTERM"}]}
{"secondRunningAtShutdownReturn":true}
{"secondRunningAfterOtherEscalation":false}
```

The final false occurs 200ms later only because the test keeps the broker process alive. The probe does not execute actual main shutdown under injected denial; the immediate-exit consequence follows directly from the reviewed main.ts catch. The key assertion checks lack of KILL delivery, not merely the brief scheduling interval between successful delivery and death, so this finding applies even under the bounded signal-delivery clarification.

**Fix:** Wait for every captured cleanup promise to settle before rejecting shutdown, then propagate failure while preserving failed entries/lanes and evidence. An all-settled aggregation is suitable. Add a regression with at least two owned groups where one cleanup rejects and another requires escalation; before shutdown rejects, require successful owned-group KILL/ESRCH, launcher close and directory removal for the recoverable group, while the failed group's evidence/admission block remain. Also cover an already-rejected cleanup alongside an active group if practical.

**Evidence:** `evidence/task-4/review-two-group-shutdown.test.ts`, preserved first fixture `review-two-group-shutdown-v1.test.ts`, `review-15-two-group-shutdown.{json,stdout,stderr}`, `review-16-signal-delivery.{json,stdout,stderr}`. Both runs exited 1 with 0 pass / 1 fail, no skips/cancellations, empty stderr and final tripwire “never fired.” The first probe established the timing problem; the amended second probe specifically distinguished missing signal delivery from merely not-yet-completed physical death. No green suite was rerun.

## Named contract checks

| Check | Assessment and evidence |
|---|---|
| Group ownership and TERM/KILL | Detached launcher establishes its own POSIX group; only its captured negative PID is signalled. Normal settle performs KILL before directory removal/decrement. Timeout/exit begins TERM and five-second escalation. Final ownership suite proves real inherited executable cessation; I1 applies to multiple-group failed shutdown. |
| Launcher close and lane release | Close handler is the normal completion path, including async spawn error. Cleanup precedes map deletion and decrement. Synchronous no-child failure settles directly. No use of timeout alone as successful cleanup. |
| Normal inherited descendants, closed pipes | Final test explicitly forks a TERM-resistant descendant, closes its output pipes and confirms it stops after normal parent completion. No detached/malicious escape guarantee is inferred. |
| Delayed credential read and modes | File is created 0600 in broker-created 0700 unique home; launcher no longer removes home. Real delayed target read, scrubbed output and final empty run/programs are asserted. |
| Synchronous/asynchronous spawn failures | Final test alters process.execPath to invalid empty value and then nonexistent executable for repeated uses, restores it, verifies successful subsequent use and stop. Bad cwd target spawn errors also covered. Error listener avoids unhandled child error; close remains release point. |
| Timers and exactly-once settlement | settled guard, timeout clearing, escalation clearing, map registration before synchronous execution and decrement only on cleanup reviewed. Boundary race test allows relevant exit statuses. Multi-group rejection timing is the specific unresolved error, not a double-decrement claim. |
| Four lanes | Four real uses remain held during escalation and fifth is refused. Successful cleanup releases ownership; failure leaves ownership and prevents further use. |
| Signal/cleanup ambiguity | Signal errors immediately set admission failure. Single-group signal denial rejects stop/use and keeps evidence. Real filesystem permission failure retains directory and rejects stop. Cross-group failure interaction is I1. |
| Leftovers and restart | Dedicated run/programs scanning and legacy entries beside broker.sock refuse unknown ownership. Actual SIGKILL/restart test preserves credential file and refuses reuse. No recovered marker PID or command-pattern kill. |
| Windows fail closed | Platform check precedes value access, run directory and spawning; branch fixture confirms refusal. Physical Windows job control is not tested. HTTP behavior remains covered by affected IPC/egress runs. |
| Both trusted environment hops | startBroker and migration #launch use the same finite internalEnv policy. Actual permission broker → migration stage/finish → synthetic secret-tool fixture validates HOME/PATH/DBUS/TZ, fake broker keychain access and old-vault finish access. |
| Parent secrets/flags excluded | CLI exact key set excludes NODE_OPTIONS/proxy/provider secret/parent canary. Python-created LC_CTYPE is explicitly tolerated. POSIX env removes Node's automatically added permission NODE_OPTIONS. No parent spread or PROGRAM_ENV broadening. Windows finite context adds only SystemRoot/USERPROFILE/LOCALAPPDATA; no physical platform claim. |
| Explicit keychain selection | oldvault.ts:58 tries only selected store in keychain mode; missing/wrong/unavailable synthetic stores refuse despite valid disk key. Existing auto/file candidate behavior remains unchanged. Pending authenticated recovery loop remains intact and affected recovery suite passed. |
| Protocol/dependencies/authority | No public verb/raw getter/socket ticket/dependency added, no production /proc access or whole-home grant. Migration read/write grant construction unchanged. Private lifecycle method is callable internally, not exposed through protocol. |
| Budget | Recomputed 2820 broker lines by split-newline rule, under 3000 with 180 remaining. Seven final source/test hashes match manifest and HEAD matches pinned commit. |

## Evidence inspected and provenance

Read the full task brief first, including Global Constraints and the zombie-only/strict-keychain clarifications; read the complete implementation report. Read the immutable review package and all seven changed files' relevant complete changes/context (source views recovered tool-output truncation). Read the full new final test, original retained red-01 fixture, mutation patch, launcher implementation, manifest, all fourteen original JSON launcher records and all fourteen raw stdout files; all corresponding stderr files are zero length. Narrow unchanged context was limited to needed broker admission/environment, launch, old-vault recovery and spawn consumers. No repeated git diff, broad crawl, owner account access, source/index/HEAD/branch writes, child agents, or external publishing occurred.

Original attempt inventory, including unsuccessful and diagnostic work:

| Attempt | Actual result | Interpretation |
|---|---|---|
| red-01 | exit 1; 1 pass / 4 fail | Original ownership, stop surface, leftover and missing first-hop HOME failures. Original delayed-open/error/output control passed. |
| red-02-keymode | exit 1; 0 / 3 | Missing/wrong/unavailable explicit keychain improperly used disk fallback. |
| green-03-focused | exit 1; 7 / 1 | Historical green label is not success; socket mistaken for leftover. |
| probe-04-permission | exit 1; 0 / 1 | Response explicitly reports prior-run recovery refusal. |
| red-05-syncspawn | exit 0; 1 / 0 | Control passed first time; not a reproduced pre-code defect. |
| green-06-ownership | exit 0; 14 / 0 | Intermediate success only. |
| red-07-signal | exit 137; interrupted after 12-second test failure | No final tripwire success; only armed line. |
| red-08-signal | exit 1; 0 / 1 | Corrected failing diagnostic; uses test-force-exit. |
| green-09-signal | exit 0; 1 / 0 | Natural termination without test-force-exit. |
| mutation-10-second-hop | exit 1; 0 / 1 | After-code negative mutation: first hop works, old second-hop environment fails stage. Not pre-code RED. |
| final-11-affected | exit 0; 59 / 0 | Affected launch/IPC/egress/canary/recovery/source-inspection/boundary gates. |
| final-12-typecheck | exit 1 | TS18046 test answer unknown, retained honestly. |
| final-13-ownership | exit 0; 16 / 0 | Final test includes async ENOENT and near-timeout race, and inherited diagnostics. |
| final-14-typecheck | exit 0 | No compiler diagnostic. |

The launcher writes enumerated clean env/argv/cwd/start records before running, retains actual statuses/end times and refuses labels already recorded. Docker is cached/no pull, network none, UID1000, readonly checkout and root, executable private tmpfs, readonly Node26 mount. No desktop socket/owner credential mounts. Runtime fake keychain is a private Python file store and nonexistent synthetic DBus address. All completed original attempts report tripwire never fired; all completed test summaries have no skips. Original final-11 contains 16 SecurityWarnings, final-13 contains 5. Earlier new broker fixtures used unconsumed diagnostic pipes; their quiet logs do not prove warning-free startup. Existing warning suppression/options were not introduced by this change and remain a final-triage concern, not waived or counted anew.

For interrupted red-07, the implementation report preserves the exact candidate container ID `a7a33111b414`, inspect command and output containing matching Task4 entrypoint, selected test, private HOME and image environment before the exact-ID kill. This matches the contemporaneous launcher argv, timestamps and exit137. **CannotVerify:** original inspect/kill tool events are report-transcribed rather than separate retained diagnostic records available in this package; I did not recreate or pretend to independently observe those historical calls. There is no claim of a successful interrupted tripwire.

The second-hop mutation is correctly disclosed as post-implementation evidence. The initial end-to-end RED stopped at broker startup, so it did not independently establish a pre-code second-hop RED. Final chain assertions plus the negative mutation support current behavior, while the literal before-code history remains limited. The reported outer diagnostic wrapper exit0 does not override retained actual test/launcher exit1.

The two review probes used the same clean launcher with new unique labels. Exact records retain starts `2026-11-03T07:02:37.818145+00:00` and `2026-11-03T07:03:13.064973+00:00`; both naturally terminate. Synthetic PIDs are captured from only the test's own programs; cleanup signals those captured processes. No global process/container kill was needed.

## Scope and remaining limits

Production promises successful group KILL delivery/ESRCH, launcher close and owned-directory cleanup, not disappearance of zombies or complete OS containment. The tests' Linux /proc reads only establish synthetic executables are no longer running. No /proc production permission is requested. Uninterruptible kernel state, deliberate setsid/group escape, credential copying, same-account tampering and hash-then-exec race remain limits. I1 is within the narrower promise because another owned group receives no KILL before shutdown returns.

CannotVerify physical macOS/Windows/owner keychain operation from Linux synthetic tests. Task 5 policy/TTL and Task 6 supervisor/reset integration are later work; they are not completed by this module review. Task 6 must preserve evidence and honor rejection after all recoverable cleanup has been attempted. P1a still requires takeover integration and branch gates; core legacy credential access remains until actual P1b cutover. Prior Task2 M1 CoreVault per-name I/O/keychain cost and existing Node permission warnings remain for final triage without silent waiver or attribution as new Task4 defects.

**RELEASE:** review complete and released to root. No implementation changes made. Task 4 acceptance is blocked on Important I1; review fixture/output artifacts and this report are the only additions.
