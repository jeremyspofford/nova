# Trigger fixture correction after the second ordinary CI

PR #284. Ordinary run41565401864 at `d5d397767bec9631462d0e4bea40474972eca504` exited its unit job normally in8m28s, proving the old file/process hang was gone. The completed unit run reported1646 tests:1631 passed,1 failed,14 unchanged skips,0 cancelled; the tripwire never fired. Sole failure: `tests/core/triggers.test.ts:96`, queue versus expected act. The original browser job subsequently passed157/157, zero skips/cancellations/warnings and tripwire never fired; the overall run and required gate125696274508 failed because of that sole unit failure. No final ordinary green result or merge is claimed.

[Actual unit job125685710811](https://github.com/jeremyspofford/nova/actions/runs/41565401864/job/125685710811). Raw log retained privately: 256084 bytes, SHA-256 `42d5f8b610691561baa6dff1364c77b4fc71ae09173df002ddc8bebe52282445`.

Test-only correction `4216de43b4e59b0c48f184c87e801d9a96b02be8` changes one test file. The unchanged original case failed on its first bounded run. Instrumentation proved an earlier independent action remained queued; the hook joined it under the existing batching rule. Real completion synchronization preserves every exact act/drop/dedup assertion; an additional deterministic held-queue case protects batching, duplicate identity and resumed independent work. No production, security, timeout or gate change.

The independent scoped review approved with no findings. A fresh ordinary final-head run remains mandatory after the original browser outcome and final records. No passing local package is substituted for that gate.

## Complete implementer report

# CI trigger fixture correction

Status: RELEASE. Implementation and all verification processes ended. No further writes are pending from this writer. Root may begin independent review.

Workdir: `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build` (used for every command).
Branch: `codex/security-exec-ledger`.
Base: `d5d397767bec9631462d0e4bea40474972eca504`.
Source-only normal commit: `4216de43b4e59b0c48f184c87e801d9a96b02be8` (`test(triggers): await completed work between dedup cases`).
Only committed file: `tests/core/triggers.test.ts`, 50 insertions and 1 deletion. No production edits, dependencies, controller documents, approval/privacy/effect changes, skips, force-exit, sleeps, or timeout increases. No amend/rebase/push/PR/merge/subagents.

## Actual failure and causal evidence

Read the task brief first and inspected the actual raw log `.superpowers/sdd/security-exec-ledger-2026-11-02/ci-unit-job-125685710811.log`, not old task reports. Ordinary CI run `41565401864`, unit job `125685710811`, reports the dedup case failing at original line 96: keyed event `queue` versus exact expected `act`. The bounded, unchanged named case reproduced that exact assertion on its first run (exit 1), not an isolated pass or a rerun-until-green result.

Retained logs are under `.superpowers/sdd/security-exec-ledger-2026-11-02/ci-trigger-fix-logs/`:

- `original-red.log`: original unchanged test, 1 failure, actual `queue`, expected `act`, original line 96.
- `diagnostic.log`: temporary state-only instrumentation, still RED. Before the keyed hook, first task `062fd2f2-f56a-478a-aafa-7506a0d3b526` was `done`, but other task `4e53710f-740d-4032-9123-2b2b724bc78e` was `queued`. Keyed triage returned `queue`, reason `Added to "Note the event".`, and exactly that other task ID. Calling `await ledger.idle()` afterward yielded both tasks `done`. The queued task was not permanently stuck. Instrumentation was removed before the correction.
- `queued-boundary.log`: deterministic boundary characterization, 1 pass before correcting the original test.
- `original-green.log`: original named behavioral case after explicit completion synchronization, 1 pass.

Causal path: `Triggers.fire()` runs dedup first; for a different event key it subsequently calls `#openTask`, whose SQL explicitly batches tasks in `queued` or `waiting` within the window. That branch produces the exact observed reason and same task ID. `Ledger.create()` returns before its asynchronous pump and physical inflight cleanup finish; awaiting a hook is not awaiting ledger completion. The test asserted a new independent `act` without observing the preceding task complete. This is a fixture synchronization assumption, not evidence of a broken runtime wakeup or wrong dedup decision. No claim about an exact required microtask count is needed.

The original case now waits for `ledger.idle()` and asserts each prior task is actually `done` before the independent action or clock-window transition. Every original exact `act`, `drop`, duplicate reason and payload dedup-key identity assertion remains. The keyed duplicate still arrives before the keyed task completion wait. The case also drains and checks final tasks complete.

The new test holds the real ledger with `halt()` to deterministically preserve a queued task. A different event must queue onto the same task with a different dedup key, while an identical event must drop with the first trigger identity and no task ID. Exactly one task remains. A `finally` resumes and drains the ledger; that task must become `done`. A subsequent distinct event must independently `act`, create a different task, and complete. This characterizes existing behavior; it is not a new production feature requiring a fabricated production RED. The existing waiting-for-approval batching test is unchanged and passes. Root approved this test-only scope after receiving the causal evidence.

## Commands and results

All tests used Node 26.3.1 from the exact instructed path. Flags preceded test file paths. Each `sh scripts/test.sh` invocation armed the Kubernetes tripwire and ended with `never fired`. All bounded invocations ended normally; no timeout fired and no force-exit was used. Logs below are relative to the retained directory above. Each test command used `> LOG 2>&1`, then printed that log and returned the captured exit code.

Original RED and temporary diagnostic (same command, before and during instrumentation):

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH timeout 90s sh scripts/test.sh --test-name-pattern='^dedup: the same event within the window is dropped as the same as the earlier one$' --test-timeout=60000 tests/core/triggers.test.ts
```

Exit 1 both times. Initial logs `/tmp/nova-trigger-original-red.log` and `/tmp/nova-trigger-diagnostic.log` were copied to retained `original-red.log` and `diagnostic.log`. Diagnostic instrumentation only added ledger destructuring, logs of fake task IDs/states and keyed triage, then `await ledger.idle()` after the already returned keyed result; the original exact `act` assertion still failed. Original source was restored before adding the permanent tests.

Controlled queued boundary before original-case synchronization:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH timeout 90s sh scripts/test.sh --test-name-pattern='^dedup: a new event joins queued work while an identical event is dropped$' --test-timeout=60000 tests/core/triggers.test.ts
```

Exit 0, 1 pass, 0 failures/cancellations/skips; initial `/tmp/nova-trigger-queued-boundary.log` copied to `queued-boundary.log`.

Original named GREEN used the exact RED command above after the correction, logging directly to retained `original-green.log`: exit 0, 1 pass, 0 failures/cancellations/skips.

Final full affected-file verification on the final source:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH timeout 90s sh scripts/test.sh --test-timeout=60000 tests/core/triggers.test.ts
```

`final-triggers.log`: exit 0; 19/19 pass, 0 failures/cancellations/skips. Covers webhook tokens, dedup, controlled queued behavior, approval-waiting batching, cooldown, heartbeat claims, local-only triage, unsure task approval, quiet-hour proactive delivery, approval-required proactive messages, and withdrawal after rule/policy changes.

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH timeout 90s sh scripts/test.sh --test-timeout=60000 tests/acceptance/m2-triggers.test.ts
```

`final-m2-acceptance.log`: exit 0; 1/1 pass, no skips. Real private server, fake home, loopback and egress tripwire; verified event and heartbeat ledger tasks, proactive trace, local-only refusal, empty remote egress log.

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH timeout 90s sh scripts/test.sh --test-name-pattern='webhooks are the one route|the guard exemption is explicit|the trigger registry over the API' --test-timeout=60000 tests/core/api.test.ts
```

`final-api-trigger-proactive.log`: exit 0; 3/3 pass, 0 failures/cancellations/skips. Exercises webhook authentication, explicit X-Nova guard exemption, registry, proactive trace and reactive task linkage over the API. Remaining unrelated API tests were not selected; this is not a full API-file claim.

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH timeout 90s npm run typecheck
```

`final-typecheck.log`: exit 0; TypeScript completed without errors.

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH timeout 90s sh scripts/test.sh --test-timeout=60000 tests/core/decision-service-boundary.test.ts
```

`final-module-boundary.log`: exit 0; 4/4 pass, no skips, including planted violation negative controls.

```sh
git diff --check
git diff --cached --check
git diff --cached --name-only
git commit -m 'test(triggers): await completed work between dedup cases'
git diff HEAD^ HEAD --check
git status --short
```

All exit 0. Initial `git diff --check` output is retained as empty `final-diff-check.log`; staged filenames contained only `tests/core/triggers.test.ts`. Final tracked worktree status is clean. The new report/logs remain ignored controller artifacts, not staged. Post-commit `git show --stat --oneline HEAD` confirms only that test file.

`final-process-audit.log`: scoped `/proc` audit found `Node processes in this task workdir: []`. All four asynchronous tool process sessions (22496, 51452, 49803, 23460) completed with exit 0; the boundary process completed synchronously. No test server or worker was left alive.

## Scope and limits

This verifies the affected trigger fixture and directly relevant acceptance/proactive/API/boundary behavior. It does not claim a fresh blanket unit suite, browser suite, ordinary exact-head CI, independent review, merge, preview, or owner validation. Those remain root-controlled later gates. The original UI job `125685710828` was left running independently; no UI run was started or stopped and no CI push was made. No actual owner homes, keys/keychain, providers/accounts, cloud, devices, Kubernetes, image pulls, protected preview/Serve/shim, or other-worktree operations were performed.

RELEASE — all implementation/verification processes ended; all report writes complete upon this file write. Source hash `4216de43b4e59b0c48f184c87e801d9a96b02be8` is ready for root's independent review.


## Complete independent review

Spec Compliance: PASS. Task quality: APPROVED.
Severity counts: Critical 0; Important 0; Minor 0.

## Spec Compliance

- PASS — The supplied d5d397767bec9631462d0e4bea40474972eca504..4216de43b4e59b0c48f184c87e801d9a96b02be8 review package changes only tests/core/triggers.test.ts (50 additions, 1 deletion). There are no production, dependency, approval/privacy/effect-gate, skip, sleep, force-exit, timeout, or inherited-environment changes in this diff.
- PASS — /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/triggers.test.ts:87 adds an exact initial act assertion; :88, :98, and :104 observe real ledger idle and done state before independent cases or the clock transition. The existing exact act/drop decisions, duplicate reason, payload-key identity, explicit-key override, and post-window act assertion remain at :92, :93, :94, :96, :102, :103, and :107. The final drain and all-done assertion at :108 verify completion.
- PASS — /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/triggers.test.ts:116 deterministically halts the real ledger. Assertions at :120, :122, :125, :126, :127, :128, :129, and :130 require an initial act, queued state, different-event queue, exact batching reason, same task ID, different dedup key, and exactly one queued task. Assertions at :133 through :137 require identical-event drop, first-trigger identity, matching key, null task ID, and no second task.
- PASS — /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/triggers.test.ts:138 resumes and drains in finally. The done assertion at :142 and subsequent act/different-task/done assertions at :145 through :148 verify recovery and an independent action after completion. These are behavioral checks against ledger/trigger results, not source-text mirrors or broadened acceptable outcomes.

## Strengths

- The original failed expectation is preserved rather than relaxed. /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/.superpowers/sdd/security-exec-ledger-2026-11-02/ci-trigger-fix-logs/original-red.log:18 records queue versus act at the original :96. The diagnostic at /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/.superpowers/sdd/security-exec-ledger-2026-11-02/ci-trigger-fix-logs/diagnostic.log:3 shows the other task queued; :12 and :15 identify the exact batching reason and same queued task ID; :21 shows it completes after idle. This directly supports the fixture synchronization diagnosis.
- Named unchanged-code risk checked once: whether queued/waiting batching and dedup order actually justify this correction. /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/src/core/triggers.ts:326 performs duplicate detection before action handling at :374; :377 returns the observed batching reason; :526 documents batching and :531 explicitly selects queued/waiting tasks within the window. The new queued test protects this behavior while the original test isolates independent actions.
- The runner boundary at /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/tests/core/triggers.test.ts:116 avoids microtask-count assumptions; finally at :138 releases held work even if a queued/drop assertion fails. No abstraction or production change is needed.

## Issues

Critical: None.
Important: None.
Minor: None.

## Verification and Limits

- Retained evidence read in full: original-red.log reports 1 failure; diagnostic.log reports the same failure with matching queued-task evidence; queued-boundary.log and original-green.log each report 1 pass. These are the intended RED/characterization/GREEN results, not warnings being ignored.
- /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/.superpowers/sdd/security-exec-ledger-2026-11-02/ci-trigger-fix-logs/final-triggers.log:21 reports 19 tests, 19 pass, 0 fail/cancelled/skipped. The unchanged waiting-task batching case also passes at :7.
- /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/.superpowers/sdd/security-exec-ledger-2026-11-02/ci-trigger-fix-logs/final-m2-acceptance.log:3 reports 1/1 pass; final-api-trigger-proactive.log:5 reports 3/3 pass; final-module-boundary.log:6 reports 4/4 pass including negative controls at :3. Every retained test log reports the no-Kubernetes tripwire armed and never fired. No unexpected warnings or test-output noise were observed. final-typecheck.log:1 contains only normal npm/tsc invocation notices, without errors; final-diff-check.log is empty.
- /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/.superpowers/sdd/security-exec-ledger-2026-11-02/ci-trigger-fix-logs/final-process-audit.log:1 records no Node processes in this workdir. Exit statuses, Node version, final-source timing, commit/staging cleanliness, and earlier process-session completion are reported by the implementer at ci-trigger-fix-report.md:30, :91, and :93; plain retained logs do not independently prove each historical shell exit/status or environment. No git command or test was rerun during review.
- Cannot independently verify from this diff: the precise Ledger.create pump/inflight implementation, full historical S1/S2 correctness, the original ordinary CI totals, current original UI job outcome, full exact-head CI, merge readiness, preview, or owner validation. Those require the controller's existing evidence or later gates. The focused source check plus diagnostic and deterministic test support the specific queued-task causal claim without a wider ledger crawl. The supplied brief reports original CI 1646 total / 1631 pass / 1 fail / 14 existing skips and original UI still running; this review makes no final full-CI or merge claim.
- Scope/safety: no fresh probes were warranted after the retained evidence answered the concrete doubt. No owner data, credentials, providers, cloud, devices, Kubernetes, model/image pulls, protected preview, other worktrees, or external actions were accessed. No source, index, HEAD, branch, or existing artifact was changed. The review file below is the sole persistent write.

## Commands Executed

All exec_command calls used workdir /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build. Read-only command list, in execution groups:

1. cat .superpowers/sdd/security-exec-ledger-2026-11-02/review-d5d39776..4216de43.diff (diff read first and once).
2. cat /mnt/c/Users/jerem/.codex/plugins/cache/claude-plugins-official/superpowers/7.0.0/skills/subagent-driven-development/task-reviewer-prompt.md
3. cat .superpowers/sdd/security-exec-ledger-2026-11-02/ci-trigger-fix-brief.md .superpowers/sdd/security-exec-ledger-2026-11-02/ci-trigger-fix-report.md
4. rg --files .superpowers/sdd/security-exec-ledger-2026-11-02/ci-trigger-fix-logs (exit 1, ignored directory omitted; corrected in command 5).
5. rg --files --hidden --no-ignore .superpowers/sdd/security-exec-ledger-2026-11-02/ci-trigger-fix-logs
6. rg -n -C 12 '#openTask|Same as trigger|dedup_key' src/core/triggers.ts (single named-risk check).
7. nl -ba .superpowers/sdd/security-exec-ledger-2026-11-02/ci-trigger-fix-report.md
8. python3 heredoc: sorted the retained ci-trigger-fix-logs/*.log paths and printed each full file with byte size and numbered lines.
9. python3 heredoc: Path.write_text of this review file only.

No changed-file reread, git command, test command, dependency operation, or subagent dispatch occurred. All read commands except initial ignored-directory discovery exited 0; the report write is the final command.

## Assessment

specPass: true
qualityApproved: true
Reasoning: Real completion synchronization restores the original independent-action assumptions while exact dedup assertions remain intact. The additional deterministic queued-work case protects the batching behavior implicated by the reproduced failure and reliably resumes the ledger.

RELEASE — All review commands and writes end with the successful write of /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build/.superpowers/sdd/security-exec-ledger-2026-11-02/ci-trigger-fix-review.md. No reviewer process, background task, or pending write remains; root retains HEAD ownership.


## Additional rulings

23. Ruling: continue with an additional narrowly evidenced CI correction for the later dedup failure rather than treat a review-wave count as permission to leave a red required gate unresolved. Why: the owner explicitly requires green merges and continuous execution, and the original timed-out run never reached this later test. Cost if wrong: another small reviewed test correction and fresh ordinary CI take time; no assertion, security rule or gate is relaxed.

24. Ruling: isolate the dedup-window test from an unfinished independent prior action by observing real Ledger completion, while separately asserting intended busy/new-event batching. Why: actual RED/instrumentation shows the queued decision is the documented #openTask behavior, not duplicate loss or a production defect. Cost if wrong: separating the scenarios could miss a batching expectation; preserve every exact act/drop/dedup assertion and add the controlled occupied-lane case for independent review.


## Completed original browser outcome

[UI job125685710828](https://github.com/jeremyspofford/nova/actions/runs/41565401864/job/125685710828) passed, including the unchanged profile-removal test, accessibility advisory and artifact upload. Full UI157/157, zero fail/cancel/skip/warnings, tripwire never fired. Raw output retained privately: 233284 bytes, SHA-256 `158e4f90712cac8d280602a5e3c8997807e795764c8779b9dc6982f72d577c85`. This passing run does not establish the original intermittent failure’s causal trace.

[Exact retained trigger RED/diagnostic/characterization/GREEN/final output](security-exec-ledger-ci-output-2026-11-03.md#second-ci-trigger-fixture-output) is appended to the safe output record. Independent source review is complete; another full ordinary exact-head CI must pass after this test-only correction before merge.


## Later ordinary-CI result

The next ordinary CI passed this dedup fixture but exposed a different intermittent repository-hash assertion. Its [controlled Git maintenance lifetime proof and minimal reviewed helper correction](security-exec-ledger-coding-fixture-2026-11-03.md) preserve the full protected-tree oracle; UI157/157 passed again. No later failed gate is hidden by this scoped approval.
