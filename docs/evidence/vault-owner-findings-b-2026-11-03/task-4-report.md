# Task 4 — owned launched-program lifetime and trusted keychain context

Status: DONE_WITH_CONCERNS (bounded POSIX guarantee and physical-platform limits below; final targeted checks pass; independent review pending).

Actual clean implementation BASE: `196ed6e42096754e20e70ddb1a33a693c87f179c`. Work performed only in `/home/jeremy/.codex/worktrees/nova-vault-integration/nova-build`, branch `codex/vault-integration-takeover`. Commit: `8e58b51ba57a2d52c244745340dee923a9051a06`. No push, PR, preview, other worktree, worker, or reviewer was created by this worker. Source ownership is released after this report.

## Implementation and interfaces

- `src/broker/broker.ts`: broker-created unique 0700 homes under `run/programs`; detached POSIX launcher process groups; held four-lane accounting and an in-memory ownership map; TERM followed by KILL at five seconds; exactly-once settlement and cleared timeout/escalation timers. Launcher close alone never releases the lane: it also requires successful owned-group KILL delivery (or ESRCH) and directory cleanup. Normal exits also kill inherited descendants, including descendants that closed stdout/stderr. Value buffers are zeroed on synchronous setup failures. Spawn errors are handled, including actual asynchronous ENOENT and synchronous invalid executable failures.
- A signal error immediately blocks new credentialed uses. If escalation cannot establish successful ownership cleanup, the use and shutdown reject while retaining the lane and directory. Directory cleanup failures do the same. This is failure reporting, not timeout-based successful cleanup. Unknown directories in the dedicated run directory, and old-format entries beside `broker.sock`, refuse new use. No PID marker is read or signalled; no stale-PID or command-pattern kills exist.
- `stopPrograms(): Promise<void>` is an internal broker lifecycle method, callable by its owning main process and later supervisor/reset work, never a socket verb. It stops admission and awaits owned cleanup promises. `src/broker/main.ts` uses it during SIGTERM/SIGINT shutdown, returning exit 1 on cleanup uncertainty. Concurrent repeated shutdown signals do not initiate duplicate teardown.
- `src/broker/launch.ts`: receives the broker-owned home through the existing private fd 3 payload; writes the 0600 credential there; never removes the home itself. The file survives a delayed target open. Existing binary hashing, environment restrictions, stdin, streaming scrubbers, and output truncation are preserved. No new public grant/ticket/value API exists.
- `src/broker/keystore.ts` exports the finite internal context helper used by both `startBroker` in `spawn.ts` and the existing migration stage/finish launcher in `broker.ts`: fixed UTC plus HOME, PATH and DBUS_SESSION_BUS_ADDRESS when keychain context is enabled; Windows adds only SystemRoot, USERPROFILE and LOCALAPPDATA. File-mode broker launches retain TZ-only behavior. This does not widen PROGRAM_ENV. Keychain CLIs receive the same finite environment; POSIX env(1) strips Node's automatically added permission NODE_OPTIONS before executing a CLI. Parent proxies, provider keys, arbitrary tokens, parent NODE_OPTIONS and a planted canary are absent.
- Explicit key mode is propagated as the broker-owned NOVA_VAULT_KEY setting. Root authorized the narrow additional `src/broker/oldvault.ts` correction: explicit keychain mode tries only its selected keychain store, never a valid disk key as a fallback. Auto/file behavior and authenticated pending recovery are unchanged. Task 3 discovery, source metadata epochs, private migration values, source-bound approval and Gmail ENOENT-only inspection remain unchanged.
- `tests/core/broker-owner-findings-b-launch.test.ts`: 16 behavioral tests covering real process-group timeout/descendants, delayed reads and modes, unrelated control, four lanes during escalation, internal stop, normal-exit descendants, bad cwd, synchronous/asynchronous launcher spawn failure, normal/timeout boundary races, output scrubbing/truncation, old leftovers, real main graceful shutdown, unclean broker SIGKILL/restart refusal, actual cleanup failure, injected OS signal denial, Windows branch refusal, actual startBroker → migration stage/finish → fake secret-tool chain, and explicit-keychain missing/wrong/unavailable controls.

## Guarantee and limits

The release criterion is owned-group SIGKILL delivery or confirmed ESRCH, launcher close, and removal of the owned directory. Linux tests inspect the synthetic owned executable PIDs through /proc in the test process and require no executable remains running. The production broker gains no /proc read authority. Zombie-only entries can remain until container PID1 reaps them; group disappearance is not claimed. Uninterruptible kernel states, deliberate setsid/process-group escape, a malicious program copying credentials, same-OS-account tampering, and the existing hash-then-exec path race are not universal revocation/containment guarantees. A directory left by broker death is operator-recovery evidence; the restarted broker refuses use rather than guessing ownership. Task 6 must honor cleanup rejection before deleting state.

Windows credentialed process use is fail-closed before value access/injection; the test exercises the branch by replacing process.platform in a private test, not a physical Windows job-control proof. No physical Windows/macOS/keychain/device/owner-account test was run. HTTP support remains verified by the affected egress/IPC tests. The keychain is an executable private Python fake with private file keys and a deliberately nonexistent synthetic DBus address, never a real secret service. Python adds LC_CTYPE during locale coercion; the test permits that interpreter-created variable and otherwise requires the exact four-name POSIX CLI environment.

No full product cutover or phase completion is claimed. Full branch gates and fresh independent review remain root-owned.

## Behavioral RED and all intermediate attempts

1. `red-01`: original implementation, 1 pass / 4 fail. TERM-resistant owned executables survive timeout; stopPrograms is missing; unknown leftover directories allow use; actual keychain broker startup fails because HOME is omitted. Delayed-open/spawn-error/output control already passes. Original test snapshot is `evidence/task-4/red-01.test.ts`.
2. `red-02-keymode`: 0 pass / 3 fail. Missing, wrong and unavailable explicit keychain stores all silently open a valid disk key; each test expects refusal and unchanged sources. Tests precede the oldvault source change.
3. `green-03-focused` (historical label, actually FAILED): 7 pass / 1 fail. Actual permission broker refuses before target launch. `probe-04-permission` isolates the concrete response: `A previous program run needs operator recovery.` The first leftover scanner mistakenly counted the live broker socket. The fix separates `run/programs` and explicitly permits the broker socket while rejecting unknown legacy run entries; no grant expansion.
4. `red-05-syncspawn` (historical label, actually PASSED): new synchronous-spawn control passes on its first run, so it is a control, not evidence of a reproduced defect. Self-review moved ownership registration before the synchronous executor so a synchronous settlement cannot leave a stale map entry.
5. `green-06-ownership`: 14/14 pass, including actual graceful/unclean lifecycle and finite context. This is intermediate evidence, not substituted for the final run.
6. `red-07-signal`: the first signal-denial harness times out after 12 seconds; its second use was itself long-running, and the failed test left handles alive. The owned isolated container was explicitly identified and terminated (details below), exit 137. No successful final tripwire result is claimed for this interrupted attempt.
7. `red-08-signal`: corrected harness races the second use against a short bound, tracks both synthetic PID sets and cleans them. 0 pass / 1 fail: expected immediate `failed`, actual no response. This establishes that signal ambiguity admitted another credentialed process. `--test-force-exit` was used only for this failing diagnostic run. The correction immediately sets admission failure on non-ESRCH signal errors and rejects cleanup/use after failed escalation without releasing ownership.
8. `green-09-signal`: final signal behavior passes without --test-force-exit and naturally exits. The denied-signal error is deliberately injected at process.kill because obtaining real EPERM against owned same-UID processes would require another account or extra OS authority; actual children, directories, admission, and shutdown behavior remain real.
9. `mutation-10-second-hop`: restoring only the old migration launcher environment while leaving the fixed first hop enabled makes actual stage fail (`The old vault couldn’t be read; nothing was staged.`), 0 pass / 1 fail. Saved patch documents the mutation and source was restored in a finally block. This is an after-implementation mutation control for the second hop, not a retroactively claimed pre-implementation RED. The positive final chain proves both stage and finish contact the fake keychain. The outer diagnostic Python wrapper exited 0 while the retained actual launcher record correctly reports test exit 1.
10. `final-11-affected`: 59/59 pass, no failures/skips/cancellations. Includes final production source, owner launch tests, IPC (including binary hash refusal and program env isolation), egress, canary/heap/migration crash resume, authenticated recovery, all Task 3 uncertain-source inspection cases, boundary and size budget.
11. `final-12-typecheck`: FAILED with one test-only `TS18046: 'stage.outcome' is of type 'unknown'` at line 157. Fixed by using the existing test answer type; no production change.
12. `final-13-ownership`: 16/16 pass on final test source, including added near-timeout exit race and asynchronous ENOENT spawn coverage. This rerun also changes the new actual broker fixtures from unconsumed pipe:true output to inherited output so the final run preserves their startup warnings. Earlier new-fixture runs did not consume those child diagnostic pipes; they are not proof of warning-free broker startup. Existing production warning flags were unchanged.
13. `final-14-typecheck`: exit 0, no compiler diagnostics.

All completed runtime runs reported no-Kubernetes tripwire **never fired**; the interrupted red-07 only records it armed. Runtime stderr files are empty. SecurityWarnings retained in test stdout: 16 in final-11, 5 in final-13. Warning text: `The flag --allow-child-process must be used with extreme caution. It could invalidate the permission model.` There are no skips in any completed attempt. The optional live-keychain skip from previous tasks was not rerun or represented as physical coverage.

## Isolated runtime and interrupted-attempt provenance

Dedicated `evidence/task-4/launcher.py` copies the prior approved launcher pattern. Each JSON record was written before invocation and completed with actual status/timestamps; labels refuse overwrite. It records explicit integration cwd, argv and enumerated clean host launcher env (PATH=/usr/bin:/bin, private ephemeral HOME, LANG=C.UTF-8). Docker uses cached `mcr.microsoft.com/playwright:v1.56.1-noble`, --pull=never, --network=none, UID/GID 1000, read-only checkout/root, private executable tmpfs, Node 26.3.1 mounted read-only. The image also supplies LC_ALL=C.UTF-8 and PLAYWRIGHT_BROWSERS_PATH=/ms-playwright, observed during owned-container inspection; these are not forwarded to broker/CLI environments. No owner credentials, desktop sockets, image pulls, global NOVA_UI_SHOTS, Kubernetes, cloud/model/device service or OS account was used.

For hung `red-07-signal`, `/usr/bin/docker ps --format '{{.ID}} {{.Command}}'` identified candidate `a7a33111b414`; no other listed container was touched. Ownership was then verified with this exact read-only command:

```sh
/usr/bin/docker inspect --format '{{json .Config.Cmd}} {{json .Config.Env}}' a7a33111b414
```

Its exact output was:

```text
["sh","-c","mkdir -m 700 \"$HOME\" && exec \"$@\"","task4","sh","scripts/tripwire.sh","node","--test","--test-concurrency=1","--test-timeout=30000","--test-name-pattern=denied owned-group","tests/core/broker-owner-findings-b-launch.test.ts"] ["HOME=/tmp/nova-task4-private-home","PATH=/opt/node/bin:/usr/bin:/bin","TZ=UTC","LANG=C.UTF-8","LC_ALL=C.UTF-8","PLAYWRIGHT_BROWSERS_PATH=/ms-playwright"]
```

Only after matching the Task4 entrypoint, exact test filter/file and private HOME to the active launcher was `/usr/bin/docker kill a7a33111b414` executed; it returned `a7a33111b414`. The launcher retained exit 137 and end time. This report transcribes those tool outputs; it does not invent a retrospective contemporaneous launch record for the diagnostic inspect/kill calls. No global container/PID pattern kill was used. Test cleanup otherwise signals only PIDs created and captured by that test's synthetic program.

## Exact commands, timestamps and raw output

All commands below used the explicit integration workdir. JSON links contain complete actual Docker argv/env/cwd/timestamps/status; stdout/stderr links preserve unabridged outputs, stacks, failures, warnings and tripwire results.

### red-01

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4/launcher.py red-01 sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=30000 tests/core/broker-owner-findings-b-launch.test.ts
```

Exit 1; start `2026-11-03T06:49:52.188818+00:00`; end `2026-11-03T06:50:08.661323+00:00`. [Record](evidence/task-4/red-01.json), [stdout](evidence/task-4/red-01.stdout), [stderr](evidence/task-4/red-01.stderr).

### red-02-keymode

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4/launcher.py red-02-keymode sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=30000 '--test-name-pattern=explicit keychain' tests/core/broker-owner-findings-b-launch.test.ts
```

Exit 1; start `2026-11-03T06:50:39.778401+00:00`; end `2026-11-03T06:50:40.756885+00:00`. [Record](evidence/task-4/red-02-keymode.json), [stdout](evidence/task-4/red-02-keymode.stdout), [stderr](evidence/task-4/red-02-keymode.stderr).

### green-03-focused

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4/launcher.py green-03-focused sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=30000 tests/core/broker-owner-findings-b-launch.test.ts
```

Exit 1; start `2026-11-03T06:51:20.118370+00:00`; end `2026-11-03T06:51:36.691903+00:00`. [Record](evidence/task-4/green-03-focused.json), [stdout](evidence/task-4/green-03-focused.stdout), [stderr](evidence/task-4/green-03-focused.stderr).

### probe-04-permission

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4/launcher.py probe-04-permission sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=30000 '--test-name-pattern=timeout kills' tests/core/broker-owner-findings-b-launch.test.ts
```

Exit 1; start `2026-11-03T06:51:52.908555+00:00`; end `2026-11-03T06:51:59.279912+00:00`. [Record](evidence/task-4/probe-04-permission.json), [stdout](evidence/task-4/probe-04-permission.stdout), [stderr](evidence/task-4/probe-04-permission.stderr).

### red-05-syncspawn

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4/launcher.py red-05-syncspawn sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=30000 '--test-name-pattern=synchronous launcher' tests/core/broker-owner-findings-b-launch.test.ts
```

Exit 0; start `2026-11-03T06:52:16.043007+00:00`; end `2026-11-03T06:52:17.140158+00:00`. [Record](evidence/task-4/red-05-syncspawn.json), [stdout](evidence/task-4/red-05-syncspawn.stdout), [stderr](evidence/task-4/red-05-syncspawn.stderr).

### green-06-ownership

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4/launcher.py green-06-ownership sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=30000 tests/core/broker-owner-findings-b-launch.test.ts
```

Exit 0; start `2026-11-03T06:52:57.359860+00:00`; end `2026-11-03T06:53:25.936498+00:00`. [Record](evidence/task-4/green-06-ownership.json), [stdout](evidence/task-4/green-06-ownership.stdout), [stderr](evidence/task-4/green-06-ownership.stderr).

### red-07-signal

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4/launcher.py red-07-signal sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=30000 '--test-name-pattern=denied owned-group' tests/core/broker-owner-findings-b-launch.test.ts
```

Exit 137; start `2026-11-03T06:53:46.506569+00:00`; end `2026-11-03T06:54:22.256281+00:00`. [Record](evidence/task-4/red-07-signal.json), [stdout](evidence/task-4/red-07-signal.stdout), [stderr](evidence/task-4/red-07-signal.stderr).

### red-08-signal

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4/launcher.py red-08-signal sh scripts/tripwire.sh node --test --test-concurrency=1 --test-force-exit --test-timeout=30000 '--test-name-pattern=denied owned-group' tests/core/broker-owner-findings-b-launch.test.ts
```

Exit 1; start `2026-11-03T06:54:30.359833+00:00`; end `2026-11-03T06:54:33.167145+00:00`. [Record](evidence/task-4/red-08-signal.json), [stdout](evidence/task-4/red-08-signal.stdout), [stderr](evidence/task-4/red-08-signal.stderr).

### green-09-signal

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4/launcher.py green-09-signal sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=30000 '--test-name-pattern=denied owned-group' tests/core/broker-owner-findings-b-launch.test.ts
```

Exit 0; start `2026-11-03T06:54:50.057380+00:00`; end `2026-11-03T06:54:57.075813+00:00`. [Record](evidence/task-4/green-09-signal.json), [stdout](evidence/task-4/green-09-signal.stdout), [stderr](evidence/task-4/green-09-signal.stderr).

### mutation-10-second-hop

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4/launcher.py mutation-10-second-hop sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=30000 '--test-name-pattern=actual broker and migration' tests/core/broker-owner-findings-b-launch.test.ts
```

Exit 1; start `2026-11-03T06:55:09.526071+00:00`; end `2026-11-03T06:55:12.031122+00:00`. [Record](evidence/task-4/mutation-10-second-hop.json), [stdout](evidence/task-4/mutation-10-second-hop.stdout), [stderr](evidence/task-4/mutation-10-second-hop.stderr).

### final-12-typecheck

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4/launcher.py final-12-typecheck sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json
```

Exit 1; start `2026-11-03T06:55:49.666266+00:00`; end `2026-11-03T06:55:51.539314+00:00`. [Record](evidence/task-4/final-12-typecheck.json), [stdout](evidence/task-4/final-12-typecheck.stdout), [stderr](evidence/task-4/final-12-typecheck.stderr).

### final-11-affected

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4/launcher.py final-11-affected sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 tests/core/broker-owner-findings-b-launch.test.ts tests/core/broker-ipc.test.ts tests/core/broker-egress.test.ts tests/core/broker-canary.test.ts tests/core/broker-migration-recovery.test.ts tests/core/broker-migration-source-inspection.test.ts tests/core/broker-boundary.test.ts
```

Exit 0; start `2026-11-03T06:55:49.666271+00:00`; end `2026-11-03T06:56:53.787830+00:00`. [Record](evidence/task-4/final-11-affected.json), [stdout](evidence/task-4/final-11-affected.stdout), [stderr](evidence/task-4/final-11-affected.stderr).

### final-13-ownership

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4/launcher.py final-13-ownership sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 tests/core/broker-owner-findings-b-launch.test.ts
```

Exit 0; start `2026-11-03T06:57:06.356627+00:00`; end `2026-11-03T06:57:44.630032+00:00`. [Record](evidence/task-4/final-13-ownership.json), [stdout](evidence/task-4/final-13-ownership.stdout), [stderr](evidence/task-4/final-13-ownership.stderr).

### final-14-typecheck

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4/launcher.py final-14-typecheck sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json
```

Exit 0; start `2026-11-03T06:57:06.359370+00:00`; end `2026-11-03T06:57:08.197009+00:00`. [Record](evidence/task-4/final-14-typecheck.json), [stdout](evidence/task-4/final-14-typecheck.stdout), [stderr](evidence/task-4/final-14-typecheck.stderr).

## Self-review, budget and release

Read the complete source diff and full test file; git diff --check passed. Commit contains only the six task source files and one test file. Final source accounting using the boundary test's newline rule is **2820/3000**, +84 from actual base, **180 lines remaining**. No limit was raised, privileged code moved, code golf, dependency or public protocol change introduced. No assertions in prior suites were weakened. The existing source grants for migration remain byte-for-byte unchanged; the run launcher only receives its bound executable read plus its particular owned-home write grant. No /proc production authority was added.

No known unresolved Task4 correctness finding remains within the stated OS/process-group contract. Concerns/limits: physical platform proof is Linux only; malicious escape/copy/uninterruptible-kernel cases remain outside containment guarantees; signal/cleanup ambiguity deliberately requires operator recovery; full branch gate and fresh independent review remain pending. Source and test hashes are saved in `evidence/task-4/final-manifest.json`.

RELEASE: implementation writer released to root. No further source mutations planned.


# Task 4 fix round 1/5 — Important I1: wait for all owned cleanup settlements

Status: DONE_WITH_CONCERNS (I1 correction implemented and checked; original bounded POSIX/platform limits and fresh independent review remain).

Read the full `task-4-review.md` before editing. Actual clean FIX_BASE was `8e58b51ba57a2d52c244745340dee923a9051a06`. Work remained solely in `/home/jeremy/.codex/worktrees/nova-vault-integration/nova-build`, branch `codex/vault-integration-takeover`. Fix commit: `fde6fdefdace1735b32d671ea5400ffa50f4949e` — `fix(vault): await every owned cleanup before shutdown failure`.

## Finding and correction

Review Important I1 is valid. Promise.all rejected on the first cleanup error while another owned group's escalation timer had not run. The unchanged main.ts error consumer could then exit immediately, preventing recoverable owned-group cleanup. An already-rejected cleanup makes this especially clear: shutdown could reject immediately after merely scheduling the active group's escalation.

The only production change is `src/broker/broker.ts`, inside `stopPrograms()`: capture and stop the same owned entries as before, await **Promise.allSettled** for every captured cleanup, and only then rethrow the first rejection. The existing program-failure guard remains. No main.ts change is needed because its catch now runs only after all captured ownership promises settle. This preserves failed map entries, held lanes, evidence directories and blocked admission; no failure is converted into a successful cleanup result. No public API, environment, permission, process signalling, credential access, fallback, OS authority, or source budget limit changed.

The amended `tests/core/broker-owner-findings-b-launch.test.ts` adds two real-process regressions. Both start two separate broker-owned POSIX groups whose synthetic targets and inherited descendants ignore TERM. The first group's negative PGID alone receives an injected EPERM; the second group receives real OS signals. One case starts shutdown while both are active. The other lets the first use timeout and reject before calling shutdown, while the second use remains active. Both were started before admission was blocked; no bypass is introduced to start a new process after failure.

At the moment stopPrograms rejects, the final assertions require successful real KILL delivery to the recoverable group, its actual launcher and both executable PIDs non-running, and its unique run directory absent. These checks happen before awaiting the ordinary use answer. The answer is then checked separately, along with retained failed-group credential/directory, exactly one remaining ownership directory, failed use result and refusal of new credentialed use. Directory removal for a spawned group occurs only in its launcher-close settlement path. Test-only /proc inspection establishes real owned group IDs and process states; production gains no /proc access. Finally blocks restore process.kill and clean only captured test-owned groups. No global container/PID kill or account change was needed.

## Complete attempt ledger, including fixture correction

1. `red-01-multi-cleanup`: original fix-base production, **0 pass / 2 fail**, exit 1. Both concurrent and already-rejected variants fail at `recoverable group receives KILL before shutdown rejects` (actual false). This is behavioral RED before source changes, not a simulated Promise.all test. Exact pre-fix test source is preserved as `evidence/task-4-fix1/red-01.test.ts`. Existing reviewer probes `review-15` and `review-16` and both reviewer fixture versions remain untouched.
2. `green-02-affected` is a historical label, **not a green result**: **26 pass / 2 fail**, exit 1. Final production correction passed all unchanged ownership tests, all four IPC tests and all six boundary tests. Both new regressions passed the immediate KILL-delivery assertion, then failed my overstrict assertion that the outer `use()` response callback had already run. Internal cleanup resolves before the outer handle/audit/call promise chain completes; callback scheduling is not launcher lifetime. This was a fixture assertion error after the production fix, not an additional production regression. The raw failures are retained.
3. `green-03-typecheck`: exit 0, no diagnostics, on the initial corrected production/new-test source.
4. The test correction removes only that invalid outer-callback ordering assertion. It keeps the active-before-shutdown control and asserts actual launcher state and directory removal immediately on shutdown rejection; the ordinary use result is awaited separately. `green-04-ownership`: **18/18 pass**, exit 0, no skips/cancellations. This runs the full amended launch/ownership/context file. `green-05-typecheck`: exit 0, no diagnostics.
5. Root confirmed the callback distinction and reiterated immediate executable-state proof. The final fixture tightens the target/descendant check from a bounded post-answer wait to an immediate non-running assertion beside the KILL/launcher/directory checks. `green-06-immediate-state`: **2/2 pass**, exit 0, verifying both amended I1 cases. `green-07-typecheck`: exit 0, no diagnostics. Only the newly strengthened cases were rerun; unchanged green ownership, IPC and boundary suites were not repeated again.

Together the final source is covered by 18 passing ownership/context cases (with the final stronger two cases additionally passing), four passing existing IPC cases and six passing boundary cases. The only production source change was already final during green-02; subsequent edits corrected/strengthened the two new test assertions. Canary/heap, egress and other broad unamended suites were deliberately not rerun under root's scoped instruction. Their historical evidence is unchanged, not represented as new coverage.

All seven attempts naturally completed, with **no-Kubernetes tripwire never fired**, no skipped or cancelled tests, and empty stderr files. Existing Node `SecurityWarning: The flag --allow-child-process must be used with extreme caution. It could invalidate the permission model.` remains in captured stdout: **9** occurrences in green-02 and **5** in green-04. Other attempts have no warnings. Compiler runs have no diagnostics. No warning flags or assertions in prior tests were suppressed or weakened.

## Launcher provenance and exact commands/output

`evidence/task-4-fix1/launcher.py` is the prior approved pattern copied into a dedicated directory with its own private HOME/entrypoint names. Each unique JSON record is written before execution and completed with actual timestamps/status; overwrite is refused. Exact clean launcher env/argv/cwd are recorded contemporaneously. Cached Playwright image uses --pull=never, --network=none, UID/GID1000, read-only checkout/root and Node26.3.1 mount, private executable tmpfs/HOME, and the no-Kubernetes tripwire. No owner keys/keychain, real DBus socket, cloud/device/model service, external network, preview, image pull, new account, subagent or reviewer was used. No runtime attempt needed manual termination.

### Fix1 green-02-affected

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4-fix1/launcher.py green-02-affected sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 tests/core/broker-owner-findings-b-launch.test.ts tests/core/broker-ipc.test.ts tests/core/broker-boundary.test.ts
```

Exit 1; start `2026-11-03T07:08:18.559446+00:00`; end `2026-11-03T07:09:17.357534+00:00`. [Record](evidence/task-4-fix1/green-02-affected.json), [complete stdout](evidence/task-4-fix1/green-02-affected.stdout), [stderr](evidence/task-4-fix1/green-02-affected.stderr).

### Fix1 green-03-typecheck

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4-fix1/launcher.py green-03-typecheck sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json
```

Exit 0; start `2026-11-03T07:08:18.553946+00:00`; end `2026-11-03T07:08:20.375061+00:00`. [Record](evidence/task-4-fix1/green-03-typecheck.json), [complete stdout](evidence/task-4-fix1/green-03-typecheck.stdout), [stderr](evidence/task-4-fix1/green-03-typecheck.stderr).

### Fix1 green-04-ownership

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4-fix1/launcher.py green-04-ownership sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 tests/core/broker-owner-findings-b-launch.test.ts
```

Exit 0; start `2026-11-03T07:10:04.376357+00:00`; end `2026-11-03T07:10:59.035091+00:00`. [Record](evidence/task-4-fix1/green-04-ownership.json), [complete stdout](evidence/task-4-fix1/green-04-ownership.stdout), [stderr](evidence/task-4-fix1/green-04-ownership.stderr).

### Fix1 green-05-typecheck

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4-fix1/launcher.py green-05-typecheck sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json
```

Exit 0; start `2026-11-03T07:10:04.378342+00:00`; end `2026-11-03T07:10:06.235046+00:00`. [Record](evidence/task-4-fix1/green-05-typecheck.json), [complete stdout](evidence/task-4-fix1/green-05-typecheck.stdout), [stderr](evidence/task-4-fix1/green-05-typecheck.stderr).

### Fix1 green-06-immediate-state

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4-fix1/launcher.py green-06-immediate-state sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 '--test-name-pattern=I1 shutdown' tests/core/broker-owner-findings-b-launch.test.ts
```

Exit 0; start `2026-11-03T07:11:18.271686+00:00`; end `2026-11-03T07:11:35.809606+00:00`. [Record](evidence/task-4-fix1/green-06-immediate-state.json), [complete stdout](evidence/task-4-fix1/green-06-immediate-state.stdout), [stderr](evidence/task-4-fix1/green-06-immediate-state.stderr).

### Fix1 green-07-typecheck

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4-fix1/launcher.py green-07-typecheck sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json
```

Exit 0; start `2026-11-03T07:11:18.281697+00:00`; end `2026-11-03T07:11:20.361723+00:00`. [Record](evidence/task-4-fix1/green-07-typecheck.json), [complete stdout](evidence/task-4-fix1/green-07-typecheck.stdout), [stderr](evidence/task-4-fix1/green-07-typecheck.stderr).

### Fix1 red-01-multi-cleanup

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-4-fix1/launcher.py red-01-multi-cleanup sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 '--test-name-pattern=I1 shutdown' tests/core/broker-owner-findings-b-launch.test.ts
```

Exit 1; start `2026-11-03T07:07:39.956921+00:00`; end `2026-11-03T07:07:52.269247+00:00`. [Record](evidence/task-4-fix1/red-01-multi-cleanup.json), [complete stdout](evidence/task-4-fix1/red-01-multi-cleanup.stdout), [stderr](evidence/task-4-fix1/red-01-multi-cleanup.stderr).

## Self-review, budget, limits and release

Read the complete fix diff and both new regression variants; git diff --check passes. Commit contains only `src/broker/broker.ts` and `tests/core/broker-owner-findings-b-launch.test.ts`. Broker accounting is **2822/3000 lines**, +2 from fix base, **178 lines remaining**. No code compaction, privileged-code movement or limit change. Final file hashes, actual base and commit are saved in `evidence/task-4-fix1/final-manifest.json`.

No unresolved I1 implementation defect is known after these checks; scoped independent re-review remains required. The original task's limits remain: Linux physical proof, synthetic signal denial instead of changing OS accounts, no physical Windows/macOS/owner-keychain claim, signal-delivery/launcher-close/directory-cleanup guarantee rather than disappearance of zombies or universal malicious-process containment. A permanently non-settling owned cleanup keeps shutdown pending rather than falsely reporting success; the change does not invent a timeout-only release. Failed ownership remains retained for operator recovery. Task5/Task6 and full-branch acceptance remain root-owned and are not claimed complete.

RELEASE: Task4 fix round1 implementation writer released to root; no further source mutations planned.
