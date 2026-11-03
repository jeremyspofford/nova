# Task 2 — B6 legacy Vault reads and serialized recovery

Status: implemented, self-reviewed, verified. Source commit recorded below. Sole implementation writer `/root/vault_b_legacy_reads`; no subagents/reviewers, push, PR modification, merge, preview, owner credential/keychain/model access, device/cloud access or image pull.

Worktree `/home/jeremy/.codex/worktrees/nova-vault-integration/nova-build`, branch `codex/vault-integration-takeover`, base `bcda07c832cb1864ee418b36b1642f68c0e08bcf`. Only `src/core/vault.ts` and new `tests/core/vault-owner-findings-b.test.ts` are source deliverables. Public Vault API, ciphertext file format, broker tree, card/app/supervisor and B2 migration epoch work are unchanged.

## Decisions and behavior

- `#open` observes committed ciphertext and the currently available key without acquiring the writer lock. Valid current data is returned under an existing/stale lock; ordinary reads leave pending files alone even when no lock exists. `get`, `has`, `list`, `status` and existing `resolve`/standby callers use this boundary.
- The decrypted-map cache is valid only for identical committed serialized bytes and identical currently available key bytes. Changed ciphertext is authenticated; another cooperating writer's saves/deletions/clear are observed. Missing keys and keychain waiting states are checked again. Cache hits avoid decryption, plaintext JSON parsing/map construction and per-value redaction registration. Each read still reads/parses the encrypted envelope and probes key storage; no constant-time or real OS-keychain latency claim is made.
- `#findKey` only probes. After authentication, optional file-to-keychain promotion or duplicate-file removal enters `#withWrite(refresh=true)` and reopens/revalidates current data before mutation. If lock acquisition is unavailable, the already authenticated read succeeds using existing storage and leaves the key file intact. Successful promotion writes, verifies exact key-byte readback, then removes the file. An existing immediate-promotion test remains unchanged and passes.
- A candidate interrupted rekey is only a readonly probe: same vault id, supported envelope, key match and successful GCM authentication. Pending values are never returned directly. Necessary recovery requires the exclusive lock, reopens/revalidates current and pending state, renames only authenticated pending ciphertext, then opens the committed file. A stale lock refuses recovery and preserves all bytes. The fingerprint alone never authorizes a rename.
- All existing mutator wrappers retain serialization; put/delete/deletePrefix retain refresh=true. The lock never gets stolen. `#withWrite` invalidates the map/serialized cache after every mutation attempt, including failures, preventing an unsuccessful deletion from becoming a permanently cached change. Lost/waiting/reset/standby behavior remains covered by existing tests.
- Three additional behavior defects were reproduced before code: failed deletion cached an uncommitted map; a warm reader ignored ciphertext tampering; key promotion removed the file before ciphertext authentication. The same boundary refactor addresses them without changing any prior assertion.

## Regression proof

22 new real Vault tests use isolated temporary homes, synthetic values/ciphertext and injected in-memory key stores only:

- Cold/warm get/has/list/status under a stale lock, valid current ciphertext plus an independently authenticated unrelated pending vault, unchanged committed/key/pending/lock-owner bytes.
- Pending preservation without a lock; fresh observation after another writer's save/add/delete/clear and no resurrected deleted entry after a subsequent mutation.
- Every public mutator refuses an existing lock, preserving bytes and the lock.
- Successful interrupted-rekey recovery; stale-lock refusal without returning pending data; malformed/tampered/authenticated different-vault pending refusal; pending authentication checked again under the acquired lock.
- Deferred key-file promotion and duplicate removal under a stale lock, successful promotion afterwards with the writer lock held and real file removal, ordinary keychain reads without lock acquisition, and no promotion before ciphertext authentication.
- Failed deletion reads back the committed value; warm-reader tampering/lost-key refusal and restoration observation.

## Exact commands, attempts and evidence

Evidence directory: `.superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-2/`. Its own `launcher.py` was created before any test run from the approved Task 1 launcher pattern. It refuses to overwrite a run label. Every attempt retained complete `<label>.json`, `<label>.stdout`, `<label>.stderr`; JSON records enumerated clean host environment, full Docker argv/container environment, cwd, UTC start/end and exact exit code contemporaneously. No failed attempts were erased.

Every table command was invoked from the task worktree as:

`python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-2/launcher.py <label> <command>`

All used cached `mcr.microsoft.com/playwright:v1.56.1-noble --pull=never --network=none --user=1000:1000 --read-only`, private tmpfs `/tmp`, private HOME, only the own worktree and Node 26.3.1 read-only binds, `/workspace` cwd. Node source path `/home/jeremy/.local/share/mise/installs/node/26.3.1` mounted at `/opt/node`. Host launcher env explicitly enumerated PATH `/usr/bin:/bin`, private HOME and LANG `C.UTF-8`; container overrides HOME `/tmp/nova-task2-private-home`, PATH `/opt/node/bin:/usr/bin:/bin`, TZ UTC and LANG `C.UTF-8`. No owner desktop sockets or credentials were mounted. All Node test flags precede file paths. No npm invocation, notifier change or warning suppression. No global NOVA_UI_SHOTS. The no-Kubernetes tripwire was armed and never fired on every run, including typechecks.

| Label | Command | Exact result |
| --- | --- | --- |
| `red` | `sh scripts/tripwire.sh node --test --test-concurrency=1 tests/core/vault-owner-findings-b.test.ts` | Exit 1: 18 tests, 5 pass, 13 fail. Expected real failures: eight stale-lock reads; pending file removed on unlocked read; stale warm observation; deferred promotion/duplicate removal reads blocked; ordinary keychain read acquired a lock. Mutator/recovery/authentication controls passed. |
| `red-cache-auth` | `sh scripts/tripwire.sh node --test --test-concurrency=1 '--test-name-pattern=failed deletion\|warm reader authenticates\|promotion waits until\|recovery revalidates' tests/core/vault-owner-findings-b.test.ts` | Exit 1: 4 tests, 1 pass, 3 fail. Failed deletion returned null from cached map; changed ciphertext did not throw; invalid ciphertext caused key-file removal. Under-lock recovery authentication control passed. |
| `green-new` | `sh scripts/tripwire.sh node --test --test-concurrency=1 tests/core/vault-owner-findings-b.test.ts` | Exit 0: 22/22 pass after implementation. |
| `green-focused` | `sh scripts/tripwire.sh node --test --test-concurrency=1 tests/core/vault-owner-findings-b.test.ts tests/core/vault.test.ts tests/core/broker-owner-findings.test.ts tests/core/broker-migration-recovery.test.ts tests/core/provider-vault.test.ts tests/core/broker-boundary.test.ts` | Exit 0: 69 tests, 68 pass, 1 skipped, 0 fail. Run after moving redaction registration to cache misses. Skip is the real secret-tool test because no desktop session/keychain is available, as intended. Existing SEC01–05 cases including concurrent old-vault writer and cached migration rekey passed, as did provider redaction, migration recovery and boundary tests. |
| `typecheck` | `sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json` | Exit 1: TS2322 in new test fixture at line 166. `readFileSync` inferred `NonSharedBuffer`, while KeyStore.write takes `Buffer<ArrayBufferLike>`. No production diagnostic. Fixed with explicit `let key: Buffer` annotation. |
| `standby` | `sh scripts/tripwire.sh node --test --test-concurrency=1 tests/acceptance/m5b-vault-standby.test.ts` | Exit 0: 1/1 pass, two real isolated Nova processes plus synthetic Home Assistant, sealed replication and failover verified. |
| `typecheck-fixed` | `sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json` | Exit 0: no diagnostics, after the test-only type annotation correction. |

The type correction is erased at runtime; no unrelated green suite was repeated after it. All seven captured stderr files are empty; stdout preserves the full intentional RED diagnostics and the initial TypeScript failure. Focused command and initial typecheck ran independently in parallel, each in its own isolated container; standby also had a separate isolated container. No other test/launcher attempts occurred. `git diff --check` passed during self-review and immediately before committing.

## Self-review and limits

No existing assertion was weakened or removed; no security/old-housekeeping requirement conflict required escalation. Serialized promotion still occurs when available, but unavailable housekeeping no longer prevents a valid read. An unauthenticated pending file cannot enter the committed cache; writes refresh under the unchanged migration lock. Recovery guards and lost/waiting behavior were checked against the actual existing tests.

The broker boundary suite passed unchanged. Broker source stayed at Task 1's 2,688 counted lines, below the unchanged 3,000 limit. No new dependency, protocol verb, listener or raw-value broker client API.

Readonly observations are snapshots: a cooperating writer can complete immediately after a read's observations. This change provides fresh observations on the next call, not a multi-file transactional read or a new migration epoch. Keychain discovery still runs on reads to avoid concealing key loss/rekey/availability changes; no actual owner OS-keychain performance benchmark was run. Cache-hit crypto/plaintext parsing work is eliminated, but file I/O and encrypted-envelope parsing remain proportional to vault file size.

No full-suite, real OS keychain, physical passkey, heap, browser relay, live provider/cloud/device or P1c claim. Per explicit dispatch, focused tests and relevant standby acceptance only were run. Existing assertions outside those suites were not edited. Core still reads legacy credentials until actual P1b cutover; this is not whole-phase completion. B2 migration epoch/false same-value crash fixture work and named takeover NOTES remain outside this task.

Commit: `15d5cf68417333cbbff49833c2a63a1cbfb5e612` (`fix(vault): separate committed reads from serialized recovery`). Source ownership RELEASED. This local report/evidence remains outside the source commit for root review and evidence packaging.


# Task 2 fix round 1 — I1 outbound scan failures

Fix base: `15d5cf68417333cbbff49833c2a63a1cbfb5e612`. Read the complete `task-2-review.md` and the original brief/report before implementation. Independent review classified the initial Task 2 patch Needs fixes (0 Critical / 1 Important / 1 Minor). This section supersedes the initial self-review's implication that the affected consumer integration was complete; the initial evidence and report above remain intact.

Root explicitly extended this round to the exact Core secret collector, Screen outbound error contract and real Core integration tests. Root additionally approved the adjacent configured memory/standing callback failure paths when tainted, with untainted secrets-only policy unchanged. Sole writer `/root/vault_b_legacy_reads`, same worktree/branch, no subagents/reviewers, push/PR/merge/preview, owner services, external network/provider/model/keychain, or image pulls.

## Implemented correction and scope

- `src/core/index.ts`: the actual collector passed to `wireIngest` no longer catches enumeration errors and returns an empty array. It also rejects a listed entry returning null/non-string during collection rather than silently filtering that entry out. Errors reach the outbound guard; no new callback/API or raw-value getter was added.
- `src/core/ingest/screen.ts`: source failures return the existing `OutboundResult` shape with `ok:false`, one `secret` or `memory` refusal and a fixed plain reason identifying only the source category. Exceptions, payloads, credentials and filesystem paths are never interpolated in that reason or its log. The method catches failures across the scan/check, so merely propagating from Core cannot encounter another catch-to-empty fallback.
- Memory and standing files remain lazy: they are read only when the existing tainted policy calls for a memory comparison. Required source failures refuse the check; untainted requests do not read those sources. This adjacent catch-empty issue was pre-existing, not introduced by warm Vault revalidation. It was separately reproduced RED and fixed within root's bounded approval.
- `src/core/vault.ts` is unchanged in this round. Fresh committed reads and key-loss observation remain intact, as do serialized recovery/promotion, writer locks and cache rules. No stale plaintext workaround, snapshot API, migration epoch, broker, runner, app, supervisor or privacy policy redesign.
- The existing runner consumes non-ok outbound results as its approval guard; this patch does not redesign the person's explicit-approval semantics or claim an unoverrideable network prohibition. It closes the silent allowed result identified in I1 and returns a safe reason through the existing contract.

## New behavior tests

`tests/ingest/vault-unavailable.test.ts` contains 10 tests. Eight invoke the actual `createCore().ingest.outbound` path through real `wireIngest` and the production collector, with real encrypted Vault files and injected KeyStores. Core is constructed in sandbox mode to avoid background discovery/model refresh; the new tests create no listener and call no model. Private temporary homes are removed after Core closes.

Each Vault failure case runs both tainted and untainted: warm keychain loss after a successful guard/read; unavailable cold scan; a key-store exception on B after list and A succeeded; and a listed entry disappearing when another real cooperating Vault clears the file during enumeration. Both a credential payload and benign payload must be refused for each incomplete scan. The partial-read fixture asserts exactly three successful/failed lookup attempts to prove the failure follows the earlier entry, without replacing `Vault.get` or copying the collector. Restoration permits benign output while saved secrets remain blocked, including encoded warm-read controls. Actual Vault reads still throw during key loss.

The remaining two tests exercise the production Screen with failing configured memory/standing callbacks: tainted output refuses, untainted output neither requires nor calls that source, and restoration permits benign output. Refusals and Core logs are checked for absence of the saved-secret canaries, a private diagnostic canary and a synthetic private key-file path. No exception detail is needed to produce the reason.

## Exact fix-round validation evidence

Directory: `.superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-2-fix1/`. A dedicated `launcher.py` was written before the first run, reusing Task 2's approved isolation and no-overwrite behavior. Every attempt below retains complete `<label>.json`, `<label>.stdout`, `<label>.stderr`. The JSON contemporaneously records full Docker argv, clean enumerated host environment, cwd, command, UTC start/end and exit status. All prior Task 2 attempts remain untouched.

Every command in the table was invoked from the authorized worktree with:

`python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-2-fix1/launcher.py <label> <command>`

Isolation: cached `mcr.microsoft.com/playwright:v1.56.1-noble`, `--pull=never --network=none --user=1000:1000 --read-only`; private `/tmp` tmpfs; private HOME `/tmp/nova-task2-fix1-private-home`; only own worktree `/workspace` and Node 26.3.1 `/opt/node` read-only mounts. Host environment is exactly PATH `/usr/bin:/bin`, private launcher HOME and LANG `C.UTF-8`; container overrides are HOME, PATH `/opt/node/bin:/usr/bin:/bin`, TZ UTC and LANG `C.UTF-8`. No owner HOME/credentials/desktop socket mounts. Existing integration suites use only synthetic in-process or loopback stand-ins, with no external network. No npm/notifier changes, global NOVA_UI_SHOTS, warning suppression or security assertion edits. All test flags precede paths. No-Kubernetes tripwire was armed and never fired for every run.

| Label | Exact command | Result |
| --- | --- | --- |
| `red` | `sh scripts/tripwire.sh node --test --test-concurrency=1 tests/ingest/vault-unavailable.test.ts` | Exit 1: 10/10 fail because production returned `ok:true` for failed checks. Eight actual Core cases and both adjacent Screen cases reproduced before implementation. No setup/import failures. |
| `green-new` | `sh scripts/tripwire.sh node --test --test-concurrency=1 tests/ingest/vault-unavailable.test.ts` | Exit 0: 10/10 pass after the two production changes. |
| `green-focused` | `sh scripts/tripwire.sh node --test --test-concurrency=1 tests/ingest/vault-unavailable.test.ts tests/core/vault-owner-findings-b.test.ts tests/ingest/guards.test.ts tests/ingest/core.test.ts tests/ingest/taint.test.js tests/ingest/canary.test.js tests/ingest/egress.test.ts tests/ingest/run-mode.test.js tests/core/broker-boundary.test.ts` | Exit 0: 66/66 pass, zero skips/failures. Includes all B6 cases, real Core ingest, saved-secret/encoded/memory guards, real runner taint/canary integration, local egress tripwire/privacy/run-mode controls, and unchanged broker boundary. Run after strengthening diagnostic/private-path assertions and adjacent-source restoration/no-read checks. |
| `typecheck` | `sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json` | Exit 0, no diagnostics. |
| `green-final-new` | `sh scripts/tripwire.sh node --test --test-concurrency=1 tests/ingest/vault-unavailable.test.ts` | Exit 0: 10/10 pass after strengthening both partial-scan cases to refuse benign payloads as well as saved-secret payloads. |
| `typecheck-final` | `sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json` | Exit 0, no diagnostics after those test-body changes. |

All six validation attempts are retained, including the intentional RED. All six stderr files are empty; no compiler/test/security warnings were suppressed. Focused tests/typecheck and final-new/typecheck-final were independent pairs run in separate isolated containers. No unrelated prior-green suites were repeated; the final rerun is restricted to the amended test file plus compiler validation. Read-only exploration had ordinary unmatched-glob/nonexistent guessed-path diagnostics; no validation attempt was lost or concealed. `git diff --check` passed after implementation and before commit.

## Self-review, remaining concern and limits

I1: both failure-swallowing layers are addressed, not just the Core collector. An entry disappearing during a multi-entry scan is also treated as incomplete. The restored success controls ensure this is not an unconditional outbound block. Source-specific error reasons contain only fixed source labels; failure logs omit raw diagnostics. Existing taint, privacy, canary and ordinary allowed behavior assertions are unchanged and pass.

M1 remains explicitly deferred to root's final triage. There is no per-name cost improvement in this fix: collecting N entries still does N+1 observations and key-store probes. The injected-store partial-scan test makes that sequence observable; this is not a latency benchmark. No plaintext snapshot API or weaker freshness rule was introduced. A future bounded internal scan design needs to preserve public API, availability/error semantics and committed-state freshness; it is outside this approved correction.

The new integration proof ends at Core's real outbound guard result. Existing focused runner canary tests independently exercise approval/denial and loopback destinations, but do not inject keychain loss into an actual runner session. No full-suite, real OS-keychain/device/cloud/model, quantitative performance, heap/physical lifetime, P1b cutover or whole-phase claim. Broker source/budget and public protocol remain untouched. Awaiting root's original-reviewer scoped re-review; this implementation report is not that approval.

Fix commit: `95f96c4aad9571f6cd337e0c9b9150a3d20f18af` (`fix(ingest): refuse outbound when protected-data scans fail`). Source ownership RELEASED. Fix report/evidence remains outside the source commit for root packaging/re-review.
