# Security CI correction and lifecycle review

PR #284. This is evidence of a failed original exact-head CI and the subsequent correction/review loop. It does not claim a final green gate or merge. Original head `a2489af2614cd7f7eb5b2febbef2dec46156f40e`; first correction `fb55871d` + `63334515`. The first independent correction review found one Important/P1 launch/close regression; round1 source `3d713478648e50f18bfa7c1dba54f0fff3fa405b` is implemented and independently approved with no open findings. Fresh full ordinary CI and merge/preview verification remain pending.

## Original ordinary CI result

[Run41557701721](https://github.com/jeremyspofford/nova/actions/runs/41557701721) failed. [Unit job125661183027](https://github.com/jeremyspofford/nova/actions/runs/41557701721/job/125661183027) timed out after30m18s following four change-pipeline/extension-rollback assertion failures. It has no complete unit summary. [UI job125661183037](https://github.com/jeremyspofford/nova/actions/runs/41557701721/job/125661183037) completed156/157, one failure, zero skips/cancellations/warnings, tripwire never fired. Required gate125674392913 failed.

The unit output stops at01:13:35Z then the runner cancels at01:40:18Z. Four locally reproduced assertion failures and cleanup-only causal isolation explain that fixture/process failure. Original UI profile removal remains causally unproven: isolated passes and an adjacent proven close-completion bug are not a reconstruction of the remote Chromium trace.

Raw original logs are retained privately; hashes below identify the exact available job output. The broad local diagnostic process listing is deliberately excluded from public evidence because it included unrelated processes. None of those unrelated processes was signaled.

| Original log | Bytes | SHA-256 |
|---|---:|---|
| `ci-unit-job-125661183027.log` | 73445 | `febb2c01575d7be24613923badd7635f96aea435c30f7cdc3b4baa5a424da90f` |
| `ci-ui-job-125661183037.log` | 238131 | `bd62c23c2bdfb8e5a5a28e89feb3de4a3ec10b626b9d891e460f509442671498` |

## Complete first correction report

# CI regression correction report

## Identity and disposition

Worktree: `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`; branch `codex/security-exec-ledger`. Starting HEAD: `a2489af2614cd7f7eb5b2febbef2dec46156f40e`. S1/S2 implementation and independent reviews were not redone.

Two source-only commits (UI evidence arrived after the unit correction was committed; root explicitly authorized an additional commit without amending):

- `fb55871dfb4d31602ef798bfd51dc28c65e38e64`: `tests/core/changes-guards.test.ts`, `tests/core/changes.test.ts`.
- `633345155ceff2787524eedae643caeb661db5ab`: `src/core/browser/session.ts`, `tests/core/browser-act.test.ts`.

The four original unit failures and their process hang were reproduced and corrected. A separate browser close completion defect was reproduced deterministically and corrected. **The original UI profile-removal failure's cause remains unproven.** Six isolated runs of the original UI test passed before the browser correction; these are diagnostic passes, not evidence that the original CI failure was fixed. Full normal CI still belongs to the controller.

## Actual CI evidence

Root retained complete raw logs alongside this report: `ci-unit-job-125661183027.log` and `ci-ui-job-125661183037.log`, from run 41557701721 at a248. The unit job timed out after 30m18s following four failures in changes-guards. UI had one failure in `declared names still resolve under the resolver rules; the profile names its process and is removed on close`: after `await s.close()`, the profile still existed. The original UI assertion, host/resolver checks, process owner assertion, and all security walls remain unchanged.

## Proven unit cause, isolation, and correction

Both test-local `inCanary` helpers accepted `waiting` immediately after approval because their predicate treated every state other than `canary` as ready. S2 changed dispatch timing (worker invocation via the asynchronous physical-lifetime path), exposing this latent fixture assumption. The test advanced its fake clock and called tick before shipping had applied the canary. Production tick correctly ignores unapplied canaries. This was not evidence of a bad Git identity, unsafe environment filtering, a rollback behavior defect, or invalid authority retention.

The helpers now exclude `waiting`/`checking` and require `canary.applied === true` before tests advance the clock. Terminal error states remain visible to the existing exact state assertions. No sleeps, expanded timeout, acceptance of either state, skipped test, relaxed security gate, or production changes behavior were added. Manual rollback, recorded approval ownership, installed/enabled restoration, untouched binary equality, and overwritten large-file equality assertions remain intact.

Three rollback tests also leaked their started Core when an assertion failed inside `rolledBackExtension` before the helper returned. Caller try/finally could never run. The helper now immediately registers `t.after(() => core.close())` after opening Core and before assertions, so setup failures also close it. A persistent mesh Sync filesystem watcher is a concrete referenced resource of the unclosed Core (`src/core/mesh/sync.ts`); role shutdown closes it through stopJournal. An early tentative heartbeat explanation was corrected: heartbeat/poll intervals inspected here are unref'ed. No production Core.close change was needed.

Causal isolation:

1. Original source: all four original assertions fail; completed test bodies leave the process running until the external 40s diagnostic watchdog terminates it (exit124). Retained original, unforced test evidence in log01.
2. Cleanup-only fixture correction: same four assertions fail, but process exits naturally1 in11.692s (log03). This isolates the process leak from readiness.
3. Readiness correction added: same four original tests pass naturally0 in4.06s (log06).
4. Complete affected changes suites:28/28 pass, no skips/cancellations,18.032s (log07).

The app path already treats approval/ship as asynchronous and records the real applied boundary. These changes repair test synchronization and ownership, not application permission/state transitions. S1 finite environment construction, S2 Ledger physical occupancy and expired authority, and changes pipeline source remain byte-identical throughout this correction wave.

## Proven browser contract defect and limits

`Session.#closeNow` used `mode === 'closed'` to return early, but set that mode before awaiting launched-browser cleanup and refuser shutdown. A transport-triggered close or a reentrant/repeated public close could therefore resolve while the first cleanup still held a profile. This is a production completion-contract defect independently of the original intermittent Chromium observation.

Two deterministic regressions use the real Session and real CDP framing with a fake launched browser and a disposable profile. They hold physical cleanup behind an explicit promise, start closing either by a public caller or lost transport, and also re-enter close from the closed event. Both fail before the fix: repeated/reentrant callers completed while profile cleanup was pending (actual true, expected false). They verify immediate closed mode, pending completion until the gate opens, actual profile removal after awaiting, and exactly one physical cleanup. There are no arbitrary sleeps; one event-loop turn drains the promise callbacks while the gate remains held.

Session now publishes one cleanup promise before any synchronous closed/change listener can re-enter. Interaction is still revoked synchronously, and all close callers await the same browser/refuser cleanup. Existing Browser worker abort starts close and its finally block awaits close: this now waits for cleanup before deleting the session and releasing its profile marker. No public signature change, runtime dependency, additional timer, global kill, process-group policy, or Chromium removal retry policy was introduced.

Liveness cost: later close callers now wait for the physical cleanup already in progress; they no longer get a falsely completed result. Existing launched-browser bounds remain unchanged. Existing best-effort Chromium directory removal, any late-child-write risk, and close-during-open behavior were not broadened or claimed solved. The original CI browser assertion was not reproduced locally and **cannot be causally attributed to this contract defect from available evidence**.

## Exact execution and retained logs

All commands below ran from the worktree above. `ci-fix-logs/` below means `.superpowers/sdd/security-exec-ledger-2026-11-02/ci-fix-logs/`. Every unit Node command had this exact environment prefix:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH
```

Each validation command redirected both stdout/stderr to its named log, captured `$?`, printed the log, and exited with the captured result. All test flags preceded file paths. Tripwire was armed and never fired in every run. No unit force-exit was added.

Original/cleanup-only/final four-case command, logs01/03/06 respectively:

```sh
timeout --signal=TERM --kill-after=5s 40s sh scripts/test.sh --test-reporter=tap --test-timeout=30000 --test-name-pattern='pipeline runs only|rolling back an extension' tests/core/changes-guards.test.ts
```

Results:124 (four actual assertions plus hang),1 (four actual assertions, natural exit),0 (4/4). Log02 preserves the read-only process listing during original RED; log04 verifies its known PIDs no longer existed. The initial listing was broader than necessary and displayed unrelated processes; none were touched or signaled. Only the bounded command's own process group received its watchdog signal.

Complete affected changes (log07, exit0):

```sh
timeout --signal=TERM --kill-after=5s 180s sh scripts/test.sh --test-timeout=120000 tests/core/changes-guards.test.ts tests/core/changes.test.ts tests/acceptance/m7a-changes.test.ts
```

Initial unit verification: `npm run typecheck` (log08,0); `sh scripts/test.sh --test-timeout=30000 --test-name-pattern='module boundary' tests/core/api.test.ts` (log09,1/1,0); `git diff --check` (log10,0). Unit patch/hash/commit evidence: logs11/12/13.

Browser image presence was checked with `docker image inspect mcr.microsoft.com/playwright:v1.56.1-noble` (log14). No pull occurred. All browser invocations used exactly this cached-container prefix:

```sh
docker run --rm --init --ipc=host --pull=never --user 1000:1000 -e HOME=/tmp -e CI=1 -e PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -e CHROMIUM=/ms-playwright/chromium-1194/chrome-linux/chrome -v /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build:/work -w /work -v /home/jeremy/.local/share/mise/installs/node/26.3.1:/opt/node:ro mcr.microsoft.com/playwright:v1.56.1-noble
```

Original isolated test suffix (log15,1/1,exit0):

```sh
sh scripts/tripwire.sh node --test --test-reporter=tap --test-concurrency=1 --test-force-exit --test-timeout=900000 --test-name-pattern='declared names still resolve' tests/ui/m5-browser-hub.test.ts
```

A bounded batch repeated the identical suffix five times in one container, writing `16-ui-original-repeat-1.log` through `16-ui-original-repeat-5.log`, stopping on any nonzero result; all5 passed. Root's cap-to-three message arrived after the already-running five-repeat batch had completed. No additional repetitions were run. Existing UI harness force-exit and timeout were unchanged; the original case has its own60s timeout. No NOVA_UI_SHOTS was set.

Deterministic public-close RED and GREEN, logs17/18 (exit1 with2failed, then exit0 with2passed):

```sh
timeout --signal=TERM --kill-after=5s 40s sh scripts/test.sh --test-reporter=tap --test-timeout=30000 --test-name-pattern='session close waits' tests/core/browser-act.test.ts
```

Complete browser unit coverage on final source (log19,53/53,exit0,2.072s), justified by production Session changes:

```sh
timeout --signal=TERM --kill-after=5s 180s sh scripts/test.sh --test-timeout=120000 'tests/core/browser*.test.ts'
```

Final typecheck `npm run typecheck` (log20,0). Complete affected UI file on final source used the same exact container prefix plus:

```sh
sh scripts/tripwire.sh node --test --test-reporter=tap --test-concurrency=1 --test-force-exit --test-timeout=900000 tests/ui/m5-browser-hub.test.ts
```

Log21:6/6 pass, no skips/cancellations,13.561s,exit0. Final module boundary identical command to log09 (log22,1/1,0). Final `git diff --check` (log23,0). Browser patch/hash/commit evidence logs24/25/26.

No blanket full unit/UI suite, dependency reinstall, redundant S1/S2 validation, or CI rerun was performed. The changes suites passed on the unit correction before the separate Session change; they were not redundantly repeated after unrelated browser changes, per controller instruction.

## Source identity and release

Final source commit: `633345155ceff2787524eedae643caeb661db5ab`. SHA256 manifest in log25 includes all four changed paths plus unchanged Ledger, finite child environment, CLI provider, changes pipeline, Chromium launcher, and original UI test. Postcommit verification is in log27: tracked/index diff checks, source manifest verification, final HEAD, and owned-container query.

Only the four stated source/test paths were staged across the two commits. Reports and logs remain unstaged ignored controller evidence. No push, amend, rebase, merge, PR mutation, external message, real integration, owner credential/data access, image pull, model pull, Kubernetes/device/cloud operation, or protected preview change occurred.

All validation sessions and their owned containers have ended. This report is the final write. Sole-writer ownership is **RELEASED** to root; no background task or writer remains. Independent consolidated review is pending. The unit regression is resolved locally; original UI causal resolution remains an explicit limitation for root to adjudicate.

## Complete independent review of first correction

# Consolidated CI correction: independent scoped review

specPass: false
qualityApproved: false
Task quality: Needs fixes
Scope: a2489af2614cd7f7eb5b2febbef2dec46156f40e..633345155ceff2787524eedae643caeb661db5ab, commits fb55871d and 63334515; four changed paths. This is a scoped post-CI review, not another S1/S2 whole-branch review or a merge verdict.

## Findings under verification

- **Four changes-guards assertion failures — ADDRESSED.** `tests/core/changes-guards.test.ts:39` and `tests/core/changes.test.ts:45` exclude pre-dispatch waiting/checking and require an explicitly applied canary. `src/core/changes/pipeline.ts:265-276` shows approval is not application; `:345-353` excludes unapplied canaries from tick; `:638-666` records the canary before awaiting application. Existing exact approval/state/content assertions remain meaningful (`changes-guards.test.ts:114-121`, `:223-247`). This changes synchronization, not permissible production outcomes.
- **Failed fixture setup leaves Core running — ADDRESSED.** `tests/core/changes-guards.test.ts:203-206` owns cleanup before installation/assertions; all three callers pass their TestContext (`:232-247`). The cleanup-only retained run has the same four assertion failures and a complete natural-exit test summary, separating cleanup from readiness.
- **Repeated/reentrant close resolves before held cleanup — ADDRESSED for an already-open Session.** `src/core/browser/session.ts:446-453` publishes its promise before calling the async body, whose synchronous prefix still closes mode, clears the holder, wakes waiters and emits events before awaiting browser cleanup (`:456-470`). Both caller-started and transport-started deterministic tests demonstrate RED before this correction and GREEN after it (`tests/core/browser-act.test.ts:147-183`, logs17/18).
- **Original remote UI profile-removal failure — CAUSAL RESOLUTION UNPROVEN.** The actual raw UI log identifies `tests/ui/m5-browser-hub.test.ts:170`, actual true versus expected false after awaited close. The original test remains exact (`:164-172`). Six original-source isolated passes cannot identify the original remote cause; final six-test file success does not establish causal resolution. The implementer states this limitation honestly. The brief permits this explicit uncertainty; it is not itself a new spec failure.

## Strengths

The fixture fix preserves the approval ownership, installed-state restoration, binary equality and large-file equality checks. The close fix is small, keeps the public signature and pre-await event order, and uses real Session/CDP behavior with a held cleanup boundary instead of timing sleeps. Source manifests and the supplied diff restrict this correction to the four stated paths; no finite-environment or Ledger change is hidden in this wave.

## New breakage in the fix diff

### Important / P1 — A close completed during launch permanently disables later cleanup

**Changed location:** `src/core/browser/session.ts:447-451` (the persistent cached completion).

**Concrete production path:** `src/core/browser/worker.ts:421-433` registers the abort handler before awaiting `s.open()`. `Session.open()` awaits the asynchronous launcher before assigning `#browser` (`session.ts:190`); the real launcher itself waits for `Browser.getVersion` (`chromium.ts:185-191`). An abort while launch is pending can therefore execute close with no browser assigned. That close shuts down the refuser and resolves its cached promise. Launch can then finish, assign the browser and ultimately set mode back to working (`session.ts:226`). The worker's final `await s.close()` (`worker.ts:511`) now returns the old resolved promise without invoking physical cleanup or revoking that working mode. It then deletes the session and releases profile ownership (`worker.ts:512-513`) while the late browser is still alive.

This is a regression introduced by the new guard: the previous guard checked mode, so after open restored working mode the worker's final close executed cleanup. The earlier close-during-open behavior was imperfect, but treating the whole interleaving as unchanged conceals this newly permanent leak. A browser/profile can remain alive after the owner is released; this violates the task's cleanup and immediate-revocation expectations. The problem also matters for browser shutdown while sessions are starting.

**Actual focused probe:** one Node26 invocation, real public Session.open/close and real Cdp framing, injected gated fake launcher, owned loopback refuser only. Start open, wait until launch is entered, await close, resolve launch, await open, await close again. Observed:

```text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
{"modeAfterFinalClose":"working","physicalCloses":0,"transportClosed":false}
no-Kubernetes tripwire: never fired
```

The diagnostic exited naturally 0 because it asserted the observed defect, not the desired fixed behavior. The fake transport was explicitly closed in finally. No Chromium or profile directory was created by this probe.

**Required correction:** make the published shared completion own resources acquired by an in-progress open, prevent open from restoring working mode after closure, and ensure browser/refuser cleanup has actually completed before that promise resolves. Preserve publication before event reentrancy and synchronous authority revocation. Add a deterministic public-API regression gated at launch; also cover an open failure after resources have been acquired. Merely clearing `#closing` would reopen the duplicate-cleanup race and would not make an already-returned close promise truthful.

### Critical

None identified in this correction.

### Minor

No separate minor finding is needed to explain the blocking defect.

## Named focused reads and temporal judgments

- **Close entry points and ownership:** inspected `browser/worker.ts:345-363`, `:398-435`, `:493-515`, `:1099-1102`; `session.ts:183-228`; `cdp.ts:71-73`, `:105-113`. This found the launch/abort regression above. For already-open sessions, stop's fire-and-forget close and finally's awaited close now share completion as intended. Forget still awaits close before releasing its profile marker.
- **Reentrant events and revocation:** inspected `session.ts:442-573`, relevant action gates (`:659-673`), and worker forwarding/SSE callbacks (`worker.ts:239-249`, `:1066-1096`). Promise publication precedes synchronous event emission. With an already-open session, closed mode and holder removal are synchronous; ordinary takeOver/pause/gate/action checks reject or stop. Existing callback order is preserved. No new await was inserted before revocation.
- **Browser/refuser ordering and errors:** inspected `session.ts:420-470`, `chromium.ts:165-191`, and `cdp.ts:105-113`. Browser cleanup precedes destroying tracked proxy sockets and awaiting server close. The launcher has bounded waits and existing best-effort directory removal. The new promise forwards fulfillment/rejection, rather than converting rejection to fulfillment.
- **Readiness boundary:** narrowly inspected ship/tick/application transitions in `changes/pipeline.ts:265-276`, `:345-353`, `:638-670` against the changed test helpers and exact assertions. No production pipeline edit or approval weakening is present.
- **Original UI assertion:** inspected only `tests/ui/m5-browser-hub.test.ts:146-175`; exact ownership/resolver/profile assertions are retained, including finally cleanup.
- **Read discipline:** the supplied diff was read first and no git diff/log/checkouts were re-derived. The Session hunk ends before its cleanup body, so continuation context was necessary. One initial Session read was broader than required and its output was truncated; subsequent reads were limited to named lifecycle/revocation ranges. The stand-in helper was read because the diff omits it and the deterministic tests rely on its transport semantics. Other changed-file reads were limited to line references or relevant assertion context. Package metadata was read once (Node >=26).

## Retained validation actually inspected

All paths below are within `.superpowers/sdd/security-exec-ledger-2026-11-02/`; logs are in `ci-fix-logs/`.

- Raw original unit log: four failing changes-guards tests at lines584/588-590, then cancellation at601. It does not contain a complete unit-run result. Raw original UI log: 157 total,156 pass,1 fail, profile assertion at lines1374-1387.
- log01: all four original assertions fail, without a normal test summary; watchdog exit124 comes from the implementer's command/report, not an exit-code line embedded in this log.
- log03: same four assertions fail, complete summary,0 cancelled/skipped,11691.586ms; cleanup-only natural exit1 is consistent with the output and reported command.
- log06:4/4 pass,0 cancelled/skipped,4058.498ms.
- log07: complete changes/guards/acceptance coverage28/28,0 cancelled/skipped,18031.638ms. This precedes the unrelated Session edit; no redundant rerun was requested or performed.
- logs08/20: typecheck invocation output, no diagnostics; reported exits0. logs09/22: boundary1/1 pass. logs10/23 are empty diff-check outputs, with reported exits0.
- logs15 and16 repeat1..5: six original-source isolated UI cases, each1/1 pass and tripwire never fired. These are diagnostic passes only. No further repeat was run in this review.
- log17: deterministic close RED2/2, both fail at premature completion (true instead of false). log18: GREEN2/2.
- log19: complete browser unit53/53,0 cancelled/skipped,2071.788ms; log21: original complete real-browser file6/6,0 cancelled/skipped,13561.349ms. No unexpected diagnostic warnings were found in these successful test logs; typecheck output contains only npm invocation notices.
- logs25/27: final source manifest plus retained postcommit verification. Independently ran `sha256sum -c .superpowers/sdd/security-exec-ledger-2026-11-02/ci-fix-logs/25-final-sha256.log`: all ten paths OK, including all four changed files and unchanged Ledger, child-env, CLI provider, pipeline, Chromium launcher, original UI test. HEAD identity is supplied by the review package and retained postcommit record; I did not re-derive git state.
- I did not inspect or copy log02, the unrelated broad process listing. No public evidence depends on it.
- No green package was rerun. The sole new execution is the narrowly justified launch/close probe below.

## Exact new probe

Working directory: `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`.

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH sh scripts/tripwire.sh node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { Session } from './src/core/browser/session.ts';
import { Cdp } from './src/core/browser/cdp.ts';
let data = () => {};
let closed = () => {};
const reply = (m) => setImmediate(() => data(`${JSON.stringify(m)}\0`));
const cdp = new Cdp({
  onData: (fn) => { data = fn; }, onClose: (fn) => { closed = fn; }, close: () => closed('fake close'),
  send: (raw) => {
    const m = JSON.parse(raw);
    reply({ id: m.id, result: {}, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
    if (m.method === 'Target.setAutoAttach' && !m.sessionId) reply({ method: 'Target.attachedToTarget', params: { sessionId: 'P', targetInfo: { targetId: 'T', type: 'page' }, waitingForDebugger: false } });
  },
});
const entered = Promise.withResolvers();
const launching = Promise.withResolvers();
let physicalCloses = 0;
const launched = { cdp, proc: {}, profile: '', stderr: () => '', close: async () => { physicalCloses++; cdp.close(); } };
const s = new Session({ taskId: 'review-close-during-launch', chromium: process.execPath, hosts: [], sandbox: false, launch: async () => { entered.resolve(); return launching.promise; } });
try {
  const opening = s.open();
  await entered.promise;
  await s.close('abort while launching');
  assert.equal(s.mode, 'closed');
  launching.resolve(launched);
  await opening;
  await s.close('worker finally');
  console.log(JSON.stringify({ modeAfterFinalClose: s.mode, physicalCloses, transportClosed: cdp.closed }));
  assert.equal(physicalCloses, 0, 'probe confirms late browser never receives physical cleanup');
  assert.equal(s.mode, 'working', 'probe confirms final close fails to revoke reopened mode');
} finally {
  launching.resolve(launched);
  await launched.close();
  await s.close();
}
NODE
```

## Cannot verify and declined judgments

- **Original UI causal resolution:** unproven, as above. No remote Chromium trace establishes whether repeated close, a lingering writer, best-effort removal failure, or another cause produced that CI assertion. No cause is inferred from isolated passes.
- **Full ordinary exact-head CI, gate, merge and protected preview:** not run or claimed passed here. Root must own later normal CI and integration decisions after the blocker is addressed.
- **S1/S2 complete security and scheduling semantics:** not re-reviewed. Their source files are unchanged in this wave and match the retained manifest; previous independent review remains the evidence for untouched internals. I did not broaden into actual provider, account, credential, device, Kubernetes, model, cloud or owner data behavior.
- **Historical process-hang resource identity:** cleanup-only RED with a complete exit summary is strong isolation evidence; the exact watcher attribution and past process inventory were not independently traced. Log02 was deliberately excluded for privacy. No claim is made to independently replay the original 30m18s timeout.
- **Pre-existing cleanup-on-throw limitation:** synchronous takeover/change/closed listeners execute before resource cleanup, without a finally (`session.ts:462-470`); a thrown callback can prevent cleanup. The new promise retains and forwards the rejection, but the underlying skipped-cleanup path already existed. Worker note callbacks catch Ledger-note errors (`worker.ts:1093-1096`); event forwarding may invoke other subscribers. This is an out-of-scope observation for root to ledger, not a second new-breakage finding or an assertion that every subscriber is safe. No throw-injection probe was run.
- **Chromium process-policy/removal redesign:** unchanged best-effort removal (`chromium.ts:183`) and possible late-child writes were not adjudicated or rewritten; proving the original remote failure would require distinct evidence.
- **Other pre-existing open/close interactions:** the new permanent cleanup bypass was judged because the cached-promise change introduces it. Arbitrary repeated public open calls and wider shutdown redesign were not exhaustively tested. The requested fix should cover the actual in-progress-open resource handoff without expanding into a general redesign.
- **Retained run provenance:** actual logs and source checksums were inspected, but historical exit-code capture and image/source identity at each earlier invocation rely in part on the retained report/records. No history or suite was reconstructed to manufacture stronger claims.

## Verdict and release

The original unit correction and already-open close regression are addressed, but the cached completion introduces a demonstrable launch/abort cleanup regression. One Important/P1 finding remains open. `specPass=false`, `qualityApproved=false`; do not treat the consolidated wave as approved or ready for ordinary final CI/merge bookkeeping yet.

Only this report was persistently written by the reviewer. No source, index, HEAD, branch, external service, image, account or owner data was changed. The single probe exited naturally and closed its fake transport and loopback refuser; no owned process or writer remains. All reviewer commands and writes are complete. RELEASE.

## Controller dispositions

The Important/P1 pending-launch leak is accepted as a new regression and must be fixed; it is not waived as an old limitation. Both original unit-fixture changes are accepted subject to the complete correction review. Original UI causal uncertainty remains explicit. Full ordinary final-head CI and preview are still later gates. Historical exit/probe provenance and exact watcher attribution remain limited to the retained evidence; no original thirty-minute hang or already-green package was rerun to manufacture stronger confidence. The unchanged S1/S2 source is covered by its earlier complete reviews; the browser correction requires its own temporal review.

## Additional rulings

17. Ruling: include the causally reproduced change-pipeline readiness and exception-cleanup fixture correction in the security PR because S2 exposed its premature waiting predicate and resource leak; preserve every actual approval/rollback/byte-integrity assertion. Cost if wrong: the revised wait could conceal a real readiness defect, so the complete affected tests and independent temporal-contract review are required; no runtime security policy or CI limit is relaxed.

18. Ruling: permit a narrowly proven browser close/profile-lifecycle correction in the same consolidated CI fix wave, using controlled RED before code and owned child processes only. Why: original exact-head UI failed a real cleanup assertion and physical-lifetime claims require truthful close completion. Cost if wrong: broader browser shutdown behavior could regress; independent review and complete affected lifecycle/UI coverage must pass before merge. Intermittent isolated PASS is explicitly not proof of cause or resolution.

19. Ruling: distinguish the proven concurrent Session.close completion bug from the original intermittent CI profile-removal failure; fix the controlled public contract but retain original CI cause as unproven. Cost if wrong: another cleanup race may remain and require further evidence; full final affected coverage/ordinary CI must still pass, and no claim of recovered remote trace is made.

20. Ruling: retain the reviewer's pre-existing listener-throw cleanup observation as an explicit separate lifecycle limitation, rather than weaken the new close contract or silently claim all subscribers safe. Why: no new listener-throw regression was established and the present blocking finding is the newly introduced pending-launch bypass. Cost if wrong: a failing synchronous subscriber may still prevent physical cleanup; that path requires its own focused hardening and must not be advertised solved.

21. Ruling: leave unchanged Chromium best-effort profile removal and hypothetical late-child-write policy outside this correction until separate causal evidence exists. Why: six original isolated passes and the controlled shared-close defect do not establish the original remote cause. Cost if wrong: an independent intermittent profile-removal defect may remain; preserve its evidence and assess the fresh ordinary CI honestly, with no claimed recovered trace.

22. Ruling: constrain the requested open/close fix to actual in-progress resource acquisition, failure cleanup and terminal revocation, preserving existing wider Session usage rather than designing a general reusable-open API. Why: the review identified a concrete worker abort/finally leak; arbitrary repeat-open redesign is not necessary to repair it. Cost if wrong: unsupported broader lifecycle patterns may need separate design; the real worker path and all newly changed temporal behavior still require review.


## Complete round1 correction report

# CI correction review round 1

## Result and identity

Addressed the review's single Important/P1 finding: the cached Session.close completion could finish while launch was pending, then permanently bypass cleanup of the late browser and allow open to restore working mode. The desired-behavior regression failed on the exact reviewed source before production edits.

Worktree: `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`.
Branch: `codex/security-exec-ledger`.
Base: `633345155ceff2787524eedae643caeb661db5ab`.
Normal new source commit: `3d713478648e50f18bfa7c1dba54f0fff3fa405b` (`fix(browser): retain close ownership through pending launch`).
Only changed/staged paths: `src/core/browser/session.ts`, `tests/core/browser-act.test.ts`.

Read the complete `ci-fix-review.md` and `ci-fix-brief.md`, then applied the receiving-code-review, debugging, TDD, and verification discipline. No subagents were spawned. S1/S2, accepted changes fixtures, and the earlier already-open close fix were not redone.

## Causal correction

The review was correct: my earlier report's broad close-during-open limitation failed to distinguish the newly permanent leak caused by retaining the resolved close promise. The old mode guard had at least allowed the worker's final close after mode resurrection; the cached promise did not. This round fixes that introduced regression rather than treating it as waived.

Session now records an acquisition handoff synchronously before starting the refuser/launcher. Close still publishes its one shared promise before events and revokes interaction synchronously. Its physical cleanup waits for that acquisition handoff, then closes any acquired browser and destroys/closes the refuser resources. It never clears the shared close promise or starts duplicate cleanup.

Acquisition is settled in a finally around refuser/launcher acquisition, before the public open error path awaits close. Close waits for acquisition, not the public open promise. This separation avoids a circular wait when opening fails or closure interrupts opening. Launch rejection also releases the handoff. Opening checks closure after refuser creation, after browser acquisition, and before entering working mode; page-attachment polling stops when closing. An open attempted after closure acquires nothing. Successful normal open retains the same behavior and public signature.

When opening fails after acquiring the browser, public open now awaits the same cleanup before rejecting with the original initialization error. In the actual worker path, abort already calls close before await open, and finally awaits close before deleting the session/releasing its profile marker. The retained completion now makes that existing ownership sequence truthful; no worker source edit was needed.

## Durable coverage and RED/GREEN

Four new cases in `tests/core/browser-act.test.ts` use real Session/CDP framing, a fake launcher, disposable profiles/homes, and only owned loopback resources:

1. Hold launch; start close; assert synchronous closed mode and still-pending completion; release launch; hold physical cleanup; assert completion remains pending; release cleanup; open rejects, mode remains closed, transport/profile are cleaned, and exactly one physical cleanup occurred. Repeated final close shares completion.
2. Fail initialization through a CDP error after acquiring the browser; open rejects only after physical cleanup, closed mode, profile removal, and refuser release. A later close does not clean twice. This also guards against the open-error/close cycle.
3. Exercise the real Browser worker abort handler while launch is held. After launch returns and cleanup is held, the same session remains in the worker map. After cleanup, the original abort reason is preserved and ownership is released; physical cleanup ran once and mode remains closed.
4. Reject launch after close began. The acquired refuser is released and the original launch error is preserved, proving the acquisition handoff also settles on rejection.

The first two tests ran against unchanged633 production source and both failed naturally (log01,exit1): close had already completed while launch was held (`true !== false`); initialization failure left mode `starting` instead of `closed`. No watchdog fired and no unit force-exit was used. After the source correction, those two plus the accepted caller/transport close regressions passed4/4 (log02). Final complete browser coverage includes all four new cases and the earlier cases:57/57.

Refuser ownership uses an exact owned-port bind oracle. While physical browser cleanup is held, rebinding the refuser's port fails with EADDRINUSE. After awaited close, the same bind succeeds and is immediately closed. This verifies release of the owned listening address without claims about unrelated or proxied listeners.

## Retained unexpected diagnostic

The first new refuser check used TCP connect failure as the oracle and failed2 cases (log03,1pass/2fail,exit1), despite cleanup completing. A single standalone owned-loopback diagnostic (log04) created a server, awaited server.close, observed `listening:false` and `address:null`, then still received a connect event on its former address. This demonstrates that a TCP connect event is unreliable for this check in the local environment. It does not establish why that happened, and no production networking cause or policy change was inferred.

The new tests switched to the owned bind oracle with both controls above; their3-case focused run passed (log05). Original UI assertions were untouched. All failed logs remain retained. A read-only rg lookup for createConnection/connect mocks returned exit1 (no matches) while inspecting this diagnostic; it made no changes and its output is in the task transcript. There were no discarded failed tests or hidden retries.

## Exact commands and outcomes

All commands ran in the worktree above. All host Node commands used:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH
```

Logs are under `.superpowers/sdd/security-exec-ledger-2026-11-02/ci-fix-r1-logs/`. Test commands redirected stdout/stderr to the named log, captured `$?`, printed the log, and returned that exit code. All Node test flags preceded file paths. Tripwire was armed and never fired. Watchdogs below are bounded diagnostic wrappers, not CI/test-limit changes.

- log01 RED, exit1,0/2pass,377.804ms:

```sh
timeout --signal=TERM --kill-after=5s 40s sh scripts/test.sh --test-reporter=tap --test-timeout=10000 --test-name-pattern='close during launch|open failure after' tests/core/browser-act.test.ts
```

- log02 GREEN, exit0,4/4pass,380.578ms:

```sh
timeout --signal=TERM --kill-after=5s 40s sh scripts/test.sh --test-reporter=tap --test-timeout=10000 --test-name-pattern='close during launch|open failure after|session close waits' tests/core/browser-act.test.ts
```

- log03 failed TCP oracle, exit1,1/3pass,375.855ms; log05 corrected ownership oracle, exit0,3/3pass,411.806ms; same exact command:

```sh
timeout --signal=TERM --kill-after=5s 40s sh scripts/test.sh --test-reporter=tap --test-timeout=10000 --test-name-pattern='close during launch|open failure after|worker abort during launch' tests/core/browser-act.test.ts
```

- log04 standalone diagnostic, exit0, exact command (with Node PATH prefix above):

```sh
sh scripts/tripwire.sh node --input-type=module - <<'NODE'
import { createServer, createConnection } from 'node:net';
const server=createServer();
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const address=server.address();
await new Promise(r=>server.close(r));
console.log({address,listening:server.listening,closedAddress:server.address()});
const socket=createConnection({host:'127.0.0.1',port:address.port});
socket.once('connect',()=>{console.log('connected',socket.remoteAddress,socket.remotePort);socket.destroy();});
socket.once('error',error=>console.log('error',error.code));
NODE
```

- log06 final complete browser unit suite, exit0,57/57pass,0cancelled/skipped,2083.002ms:

```sh
timeout --signal=TERM --kill-after=5s 180s sh scripts/test.sh --test-timeout=120000 'tests/core/browser*.test.ts'
```

- log07 final typecheck: `npm run typecheck`,exit0, no diagnostics.
- log08 final original complete affected UI file,exit0,6/6pass,0cancelled/skipped,13861.154ms. Exact cached-image invocation:

```sh
docker run --rm --init --ipc=host --pull=never --user 1000:1000 -e HOME=/tmp -e CI=1 -e PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -e CHROMIUM=/ms-playwright/chromium-1194/chrome-linux/chrome -v /home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build:/work -w /work -v /home/jeremy/.local/share/mise/installs/node/26.3.1:/opt/node:ro mcr.microsoft.com/playwright:v1.56.1-noble sh scripts/tripwire.sh node --test --test-reporter=tap --test-concurrency=1 --test-force-exit --test-timeout=900000 tests/ui/m5-browser-hub.test.ts
```

Existing UI harness force-exit/timeout were unchanged and authorized. No image pull or NOVA_UI_SHOTS.

- log09 boundary: `sh scripts/test.sh --test-timeout=30000 --test-name-pattern='module boundary' tests/core/api.test.ts`,exit0,1/1pass.
- log10: `git diff --check`,exit0.
- log11: exact final source/test patch.
- log12: `sha256sum` manifest of changed Session/test plus unchanged worker, Chromium launcher, original UI test, Ledger, child-env, CLI provider, changes pipeline, and accepted changes test fixtures.
- log13: explicit `git add -- src/core/browser/session.ts tests/core/browser-act.test.ts` then `git commit -m "fix(browser): retain close ownership through pending launch"`,exit0.
- log14: postcommit HEAD, tracked/index diff checks, manifest verification, worktree status, and own-worktree container query.

No previously green unaffected changes28, S1/S2 packages, blanket full unit/UI suite, dependency installs, or CI rerun was performed. All final browser/typecheck/boundary/UI validation ran on the committed source content.

## Costs, limitations, and release

Close during pending acquisition now waits truthfully for the launcher to settle, then for physical cleanup. A deliberately nonsettling custom launcher therefore keeps close pending; this correction adds no timeout or forced release of resource ownership. The real launcher's existing bounds are unchanged. Interaction revocation still precedes every await in close. Event publication order remains unchanged and repeated/reentrant callers still share the same promise.

The named pre-existing cleanup-on-listener-throw limitation remains: synchronous close listeners can throw before cleanup. This round did not broaden into a callback/shutdown redesign. Arbitrary multiple concurrent opens are outside this single-open lifecycle correction. Chromium's existing process cleanup, best-effort removal, and possible late writers remain unchanged. No production network policy was changed.

The original remote CI profile-removal cause remains **UNPROVEN**. This round proves the review's introduced launch/close ownership regression is corrected locally; neither that fact nor6/6UI establishes the original remote cause. The earlier report's broader limitation is superseded by this explicit distinction. Independent scoped re-review and later normal exact-head CI remain root's responsibility.

No provider/account/keychain/owner-data/cloud/device/Kubernetes/model operation, real integration, global kill, protected preview change, image pull, dependency change, push, amend, rebase, merge, or PR mutation occurred. The controller-owned untracked `docs/evidence/security-exec-ledger-ci-correction-2026-11-03.md` was not staged or modified.

All commands, tests, and owned containers have ended; final release verification is retained in log14. No background task/writer remains. Sole source-writer ownership is **RELEASED** to root after this report and final verification record. Source-only commit3d713478 is ready for the requested independent scoped re-review, not represented as approved or merged.


## Complete independent round1 re-review

# CI correction: scoped re-review, fix round 1

**P1 — A close completed during launch permanently disables later cleanup: ADDRESSED.**

specPass: true
qualityApproved: true
Task quality: Approved for this scoped fix round
Open findings: 0 Critical, 0 Important/P1, 0 Minor
New breakage identified: none

Reviewed range: `633345155ceff2787524eedae643caeb661db5ab..3d713478648e50f18bfa7c1dba54f0fff3fa405b`; commit `3d713478` changes only `src/core/browser/session.ts` and `tests/core/browser-act.test.ts`. This verdict closes the single finding in `ci-fix-review.md`; it is not a new S1/S2 whole-branch review or a claim that normal full CI/merge has passed.

## Finding verdict and temporal reasoning

**Pending acquisition is now owned by close.** `src/core/browser/session.ts:185-190` publishes `#acquiring` synchronously before starting resource acquisition. `:197-209` assigns the refuser and any late browser before settling that handoff in finally. `:490-493` makes the existing shared close completion wait for the handoff, physical browser cleanup, socket destruction, and refuser close. The formerly resolved close promise can no longer bypass cleanup of a browser assigned after close began.

**Closed mode cannot be restored to working by this in-progress open.** The checks after refuser acquisition (`session.ts:200`), after launch (`:211`), and immediately before setting working (`:247-248`) observe the persistent `#closing` promise. The final check and assignment have no intervening await. If close occurs while initial page attachment is pending, polling also stops on `#closing` (`:238`, `:244`); the terminal guard prevents successful working-state publication. Opening after closure rejects before resource acquisition (`:186`).

**There is no open-error/close circular wait in the reviewed single-open lifecycle.** The handoff covers acquisition, not the public open promise. Its finally settles before `open()` catches an error and awaits shared close (`session.ts:190-209`). Launch rejection therefore releases the handoff; initialization failure after browser acquisition also reaches close with acquisition already settled. Close never awaits the public open promise that is awaiting it. The original error is rethrown after successful cleanup.

**Worker ownership follows actual cleanup again.** The unchanged worker registers abort before open and waits for Session.close in finally before deleting the session and clearing its profile marker (`src/core/browser/worker.ts:421-433`, `:509-514`, inspected in the prior round and checksum-confirmed unchanged in this round). Because that close promise now owns pending acquisition and the late browser, the worker cannot release these owners at the old premature completion boundary. The new real-worker test checks map ownership while physical cleanup is gated, then checks removal and the original abort reason after cleanup (`tests/core/browser-act.test.ts:307-349`). The private profile marker is not directly asserted by that test; its release shares the same unchanged post-close finally sequence.

**Accepted reentrancy and immediate revocation are preserved.** `session.ts:468-475` still stores the one shared completion before invoking the close body. Closed mode, holder removal, waiter wakeup and event publication still precede every await (`:478-490`). The new acquisition await is after those operations. Reentrant callers receive the published completion; the promise is never cleared to permit duplicate cleanup. Already-open caller/transport regression cases remain in the final passing suite.

## Strengths and test coverage

The implementation separates acquisition completion from public open completion, directly addressing the dependency cycle rather than releasing ownership early. The fix adds no timeout, no launcher/process-policy rewrite, no dependencies and no worker source change. Tests use actual Session/CDP behavior and a real Browser worker with fake launched resources.

The four durable cases cover distinct boundaries:

- `tests/core/browser-act.test.ts:214-271`: launch held, close called, synchronous closed mode, completion still pending both before acquisition and during held physical cleanup; open rejects; final mode remains closed; exactly one physical close; transport/profile/refuser release; repeated final close.
- `:274-305`: CDP initialization failure after browser acquisition, original initialization error, completed cleanup before rejection, closed mode and no duplicate cleanup on later close.
- `:307-359`: actual Browser worker abort while launch is pending; session ownership remains until the late browser's physical close; original abort reason and final ownership release.
- `:362-390`: launch rejection after close, original error preservation and release of the already-acquired refuser.

The refuser oracle (`tests/core/browser-act.test.ts:201-211`) attempts to bind precisely the fixture's owned loopback address. Its positive control expects EADDRINUSE while physical browser cleanup is held (`:253`); successful rebind after completion (`:262`, `:297`, `:383`) verifies release. Each probe server is closed in finally. This does not weaken any original UI assertion or infer anything about unrelated listeners.

## Evidence actually inspected

Evidence directory: `.superpowers/sdd/security-exec-ledger-2026-11-02/ci-fix-r1-logs/`.

- `01-red.log`: the two desired-behavior tests fail on the reviewed base before the source fix. First failure is premature close completion, actual true versus expected false; second is starting mode instead of closed after initialization failure. Complete summary:2 tests,0 pass,2 fail,0 cancelled/skipped,377.804ms. The report records natural exit1; no timeout is present in the output.
- `02-green.log`: those two cases plus the prior caller/transport close regressions pass4/4,0 cancelled/skipped,380.578ms.
- `03-ownership-green.log`: despite its name, this retained run fails2/3 tests because the initial TCP-connect oracle sees a connection after close. The failure is disclosed, not discarded.
- `04-loopback-diagnostic.log`: the standalone diagnostic records a closed server with listening false/address null, followed by a connection event on the former port. This supports rejecting that connect-event oracle in this environment; it does not establish the underlying cause.
- `05-ownership-green.log`: corrected bind-oracle cases and worker ownership test pass3/3,0 cancelled/skipped,411.806ms.
- `06-browser-complete.log`: final browser unit suite57/57,0 cancelled/skipped,2083.002ms. All four new tests and both accepted close tests are present by name.
- `07-typecheck.log`: typecheck invocation and no diagnostics; reported exit0.
- `08-ui-complete.log`: unchanged original real-browser file6/6,0 cancelled/skipped,13861.154ms, including the profile-removal test. This is affected-file coverage, not full UI CI or original-failure causality.
- `09-boundary.log`: module-boundary1/1 pass,0 cancelled/skipped. `10-diff-check.log` is empty; the report records exit0.
- All inspected test logs show the no-Kubernetes tripwire armed and never fired. Successful final test output contains no unexpected warnings/errors; typecheck output has only npm invocation notices.
- `14-release.log`: retained final HEAD `3d713478648e50f18bfa7c1dba54f0fff3fa405b`, source manifest verification and the controller's untracked evidence document. Independently ran `sha256sum -c .superpowers/sdd/security-exec-ledger-2026-11-02/ci-fix-r1-logs/12-final-sha256.log`; all eleven paths match, including changed Session/test and unchanged worker, Chromium launcher, original UI, Ledger, child-env, CLI provider, pipeline and accepted fixtures.

No test or package was rerun by this reviewer. No specific unresolved risk warranted an additional execution probe: the durable gated tests and inspected dependency structure answer the original finding. Historical command exit codes and source/image identities at execution time remain partly dependent on the retained report/records; checksum verification confirms the current reviewed content matches the final manifest, not a reconstructed historical run.

## Scope discipline and focused reads

The supplied diff was read first. The complete round-1 implementer report and retained failed/successful logs were read next; no git diff/history or worktree state was re-derived. Existing skill rubric, original brief and original review findings from the prior review turn remain the review contract.

The diff cuts the close method before its shared-promise wrapper, so only that missing lifecycle context was read (`session.ts:464-493`). One focused unchanged helper read (`session.ts:252-292`, #attached) checked the named risk that late CDP initialization might itself restore mode; it sets page/target state but does not restore working mode. The final working-state transition is guarded in the changed open body. Line searches supplied precise references without another whole-file read. Previously inspected worker and launcher paths were not redundantly rescanned; their checksums match. No unrelated S1/S2, changes fixture or broad codebase review occurred, and package metadata was not reread.

## Cannot verify, declined judgments and carried limits

- **Original remote UI profile-removal causality remains UNPROVEN.** Neither this regression fix nor the final6/6 browser file identifies the cause of the original remote assertion. Earlier original-source isolated passes remain diagnostic only. The round-1 report preserves that distinction honestly.
- **Full normal exact-head unit/UI CI, aggregate gate, final Ledger integration verification, merge and protected preview:** not executed or approved by this scoped review. Root retains those later responsibilities. No local affected-file pass is substituted for them.
- **Pre-existing synchronous-listener throw:** close events precede cleanup without a resource-cleanup finally (`session.ts:484-493`). A throwing listener can still prevent cleanup; this is the previously recorded out-of-scope observation, not newly caused by the acquisition handoff. No claim is made that every subscriber is safe, and no extra throw-injection probe was run.
- **Chromium's existing cleanup bounds, best-effort removal and possible late child writers:** unchanged and outside this fix. No broader process/removal guarantee is established by the fake-browser tests. Original real-browser assertions are preserved.
- **Arbitrary multiple/concurrent open calls or Session reuse:** not exhaustively reviewed. The corrected lifecycle is one open followed by terminal close; overlapping opens were already outside the stated correction. The new post-close guard deliberately rejects before acquiring more resources.
- **Nonsettling custom launchers:** close now remains pending until acquisition settles. This is truthful retained ownership, not a new timeout policy. The real launcher's previously inspected bounds remain unchanged; no new fallback that could release live resources is justified here.
- **Additional interleavings:** tests exercise close during launch and failure after acquisition, not every microtask position during refuser creation or target attachment. Static finally/guard ordering covers these paths for the single-open contract; no exhaustive concurrency claim is made.
- **Unchanged S1/S2 security/scheduler invariants and accepted fixture correction:** not re-reviewed. Manifest identity and prior reviews carry their evidence. No actual credentials, accounts, providers, owner data, devices, Kubernetes, cloud, models, image pulls or protected preview were accessed.
- **Failed TCP-connect diagnostic's underlying network cause:** unknown. I did not infer proxy/firewall behavior or broaden into environmental investigation. The replacement owned-bind oracle has both controls and the production networking code is unchanged.

## Verdict and release

The original Important/P1 finding is ADDRESSED; no new breakage was identified in this fix diff. `specPass=true`, `qualityApproved=true` for round1. This closes the consolidated review's sole blocking code finding, while preserving the explicit original-UI-causality and future-normal-CI limits above.

Only this authorized report was persistently written. No source/index/HEAD/branch change, subagent, test process, container, network probe, publication or external action was started by this reviewer in this round. All reviewer commands and writes are complete; no owned process or writer remains. RELEASE.


## Initial bounded diagnostic (not the eventual cause)

# CI long-run diagnosis — read only

Result: **No concrete cause of the remote CI delay identified.** The requested risk (an original test outside the 77 affected tests directly awaiting idle on a never-settling abort-ignoring fake) was not reproduced. Do not infer that remote CI is green or healthy from this bounded local diagnosis.

Worktree for every command: `/home/jeremy/.codex/worktrees/nova-main-ci-fixtures/nova-build`.
HEAD before and after: `a2489af2614cd7f7eb5b2febbef2dec46156f40e`.
Production source remains the reviewed S2 source `7055737e3d2571df279574847107c83b2acfc6e6`.
No source/test/index/HEAD changes, no subagents, no broad test reruns, no remote CI mutations.

## Inspection

Read `scripts/test.sh`: it invokes Node through `scripts/tripwire.sh`, owns a disposable TMPDIR, and removes it on exit. Retained targeted search outputs are adjacent to this report:

- `ci-hang-search.log`: empty-body Promise constructors across tests, with context.
- `ci-hang-promises.log`: all `new Promise` occurrences in core test files, including the generic `new Promise<never>` form.
- `ci-hang-candidates.log`: hang/never/abort/pending/idle candidates from core and acceptance tests.
- `ci-hang-chaos.log`: worker/idle/hang inspection of chaos and ingest tests.
- `ci-hang-other-promises.log`: Promise/deferred/infinite-loop searches across support, ingest, acceptance, and top-level test files.

Key exact search commands (all read-only):

```sh
rg -n -C 3 'new Promise\((\([^)]*\)|[A-Za-z_][A-Za-z_0-9]*)\s*=>\s*\{\s*\}\)' tests --glob '*.ts' --glob '*.js'
rg -n 'new Promise' tests/core --glob '*.test.ts'
rg -l '\.ledger\.idle\(|ledger\.idle\(' tests --glob '*.ts' --glob '*.js'
rg -n 'new Promise<never>|new Promise[^;]*=> \{\}|new Promise[^;]*=>\{\}' tests scripts --glob '*.ts' --glob '*.js'
rg -n 'new Promise|Promise\.withResolvers|while \(true\)|for \(;;\)|resolve.*=' tests/support tests/ingest tests/acceptance tests/*.test.js --glob '*.ts' --glob '*.js'
```

The explicit never-settling fixtures outside the already covered Ledger/browser suites were:

1. `tests/chat-run.test.js:139`: first `chat-run` worker never finishes, simulating process death. That test closes `first.db` directly at line 148, creates a separate second core, and polls the second Ledger. It does not await the first Ledger's idle. This is not the suspected idle deadlock path.
2. `tests/core/network.test.ts:328`: a target write lands and then returns a never-settling promise, simulating power loss. The test uses `h.stop()` after observing the landed write and resumes in a new core. `tests/core/mesh-support.ts:59` delegates stop to `core.close()`, whose Ledger wait is raced against 2 seconds in `src/core/index.ts:1734`. There is no post-write direct call to `settle()`/idle on the first core. This was the single concrete remaining abort-ignoring fixture selected for a bounded original-test probe.

The initial empty-body regex did not cover generic Promise syntax; the subsequent complete Promise listing and explicit `Promise<never>` search found the network fixture. Inspection included actual callers rather than relying on only that initial regex. No additional explicit unresolved worker fixture directly awaiting idle was identified. Fake CLI/provider tests commonly await idle but have signal/process timeout handling; they were not broadly executed during this diagnosis.

## The one allowed bounded original-test probe

The original network test has a 60-second per-test timeout. The diagnostic run additionally bounded its file/test-run context to 20 seconds and placed a 25-second external watchdog (5-second TERM-to-KILL grace) around the test wrapper. This was sufficient to check the suspected bounded-close path without recreating a long CI wait.

Exact command, in the worktree above:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH timeout --signal=TERM --kill-after=5s 25s sh scripts/test.sh --test-timeout=20000 --test-name-pattern='Nova stopped mid-write still has a switch' tests/core/network.test.ts > .superpowers/sdd/security-exec-ledger-2026-11-02/ci-hang-original-probe.log 2>&1
code=$?
cat .superpowers/sdd/security-exec-ledger-2026-11-02/ci-hang-original-probe.log
exit $code
```

Actual exit: **0**. Original test passed in 2351 ms; process duration 2769 ms. Output retained verbatim in `ci-hang-original-probe.log`:

```text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
✔ M10d: Nova stopped mid-write still has a switch: after the restart, without contact, the change reverts (2351.195714ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2769.081776
no-Kubernetes tripwire: never fired
```

No test failed, timed out, or was interrupted in this diagnosis. No second probe ran. The original script created only a disposable home, fake network target/config file, and loopback fixture endpoints; no real network interface, router, provider, cloud account, images, Kubernetes, or owner data was used. The separate previously reported late-DB-close observation was not re-probed.

## Decision and limits

No remedy is justified by this local evidence. Wait for the actual CI outcome/logs to identify the blocked or failed test before changing code or fixtures. A timeout elsewhere, long production worker interaction, resource contention, or unrelated test could still explain the remote timing; none is established here. Only the original network candidate was executed, not the whole network file or suite.

Final checks: `git diff --exit-code`, `git diff --cached --exit-code`, and `git rev-parse HEAD` exited 0; tracked worktree and index remain unchanged at the recorded HEAD. The probe process and all shell commands completed. This report and diagnostic logs are the only writes.

**RELEASE:** read-only diagnosis ownership released to the controller. All commands/processes/writes ended with report delivery; no background validation remains.


## Current disposition

The full consolidated correction is accepted after the single Important/P1 was fixed and independently closed. The unit fixture cause is established. The public close completion and in-progress acquisition contracts are tested and reviewed. Original intermittent remote Chromium profile-removal causality remains UNPROVEN; a fresh full ordinary CI is mandatory and does not retroactively recover that trace. Known pre-existing listener-throw, best-effort Chromium removal and unsupported arbitrary multiple-open limits remain as explicitly recorded above.

[Exact available safe test and diagnostic output](security-exec-ledger-ci-output-2026-11-03.md) retains RED, cleanup-only RED, GREEN, six diagnostic original-source UI passes and the failed TCP oracle. The overbroad process snapshot and whole original CI logs remain private, not silently published.
