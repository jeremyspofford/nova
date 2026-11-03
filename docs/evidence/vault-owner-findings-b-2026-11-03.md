# Vault findings B — staged evidence

Unmerged P1a work. Owner B received; all fixes/integration/live adversarial/fullCI/merge not yet complete. Earlier A/S4/S6 source and limits preserved. Main merged without rebase d425; plan/spec2c; first B1/B4 source939.

## Task1 full implementer report

# Task 1 — B1/B4 holder identity and adoption startup

Status: implemented, self-reviewed, verified; source released after the commit recorded below. Sole source writer `/root/vault_b_identity_startup`. No worker/reviewer agents, push, PR change, merge, rebase, preview, owner service, real credential, keychain, provider, model, or image pull.

Worktree `/home/jeremy/.codex/worktrees/nova-vault-integration/nova-build`; branch `codex/vault-integration-takeover`; source base `2c9868780224345a6eea8cdadd71a37d2b60463d`, immediately above existing merge `d425cc2f`. Main merge was preserved.

## Changes

- `Broker.state()` supplies one new public metadata key, `device_key_fingerprint`: full lowercase 64-hex SHA256 of the decoded raw X25519 public-key bytes. Enrollment computes the same fingerprint from the actual proposed key and places it in the existing card's `approving` text, with explicit comparison instructions. Existing `what`/`target` presentation and approval action/public-key binding remain intact.
- `Broker.start()` indexes stores that adoption already unlocked. Auto-mode first adoption and later signed generations list the same actual ref metadata as the hub, without an unlock request.
- `Store.adopt()` retains the opened root only in auto mode. Ask mode replaces any existing root with null and zeroes its temporary root in `finally`. Failure paths after opening also zero that temporary buffer. Signed header, pinned hub, vault id, strictly newer generation, blob authentication, and factor re-sealing checks retain their ordering and assertions.
- New real Broker regression tests cover visible proposed-key comparison and substitution in both core and software-passkey modes; retained rejection of a changed key after approval in both modes; declining proposals without creating an outbox/enrolling a holder; no device private key or factor in answers; real signed outbox/inbox startup for auto and ask, first/later generations; ask device-unlock refusal followed by successful sealed person-factor unlock and identical ref metadata; tampered signed header/unpinned holder rejection; and an actual captured older signed header **with its matching old blobs** unable to roll back a newer held generation.

Committed scope is only `src/broker/broker.ts`, `src/broker/store.ts`, `src/broker/protocol.ts`, and `tests/core/broker-owner-findings-b-identity.test.ts`. No Core/app/supervisor change, new visible pattern, public verb, dependency, permission, or store.

## Exact execution evidence

Evidence directory: `.superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-1/`. `launcher.py` records enumerated clean host launcher environment, full Docker argv (including container environment overrides and actual command), cwd, UTC start/end timestamps, and exit status before/after execution. Each listed run retains complete `.json`, `.stdout`, and `.stderr` contemporaneously. No output or failed attempt was erased.

All runs used cached image `mcr.microsoft.com/playwright:v1.56.1-noble`, inspected image id `sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a`, `--pull=never --network=none --user=1000:1000 --read-only`, private tmpfs `/tmp`, private HOME, read-only own worktree, and Node 26.3.1 mounted read-only at `/opt/node`. Only those two binds were mounted. No desktop socket or owner credential/home mount. No `ui-test.sh`, global `NOVA_UI_SHOTS`, warning suppression, or npm invocation. All test flags precede file paths. The no-Kubernetes tripwire was armed and never fired on every run, including typecheck.

| Evidence label | Exact command after launcher | Result |
| --- | --- | --- |
| `red` | `sh scripts/tripwire.sh node --test --test-concurrency=1 tests/core/broker-owner-findings-b-identity.test.ts` | exit 1; 7 tests, 3 pass, 4 fail. Missing state fingerprint in both approval modes; auto startup `refs=[]` instead of actual hub refs; ask startup `locked=false` instead of true. Retained key-after-approval and pin/signature controls passed before the fix. |
| `red-card` | `sh scripts/tripwire.sh node --test --test-concurrency=1 '--test-name-pattern=holder fingerprints' tests/core/broker-owner-findings-b-identity.test.ts` | exit 1; 2 tests, 0 pass, 2 fail. Assertions were reordered to expose the independently missing full fingerprint in the real visible card before implementation. |
| `green-new` | `sh scripts/tripwire.sh node --test --test-concurrency=1 tests/core/broker-owner-findings-b-identity.test.ts` | exit 0; 7/7 pass after minimal production fix. |
| `green-focused` | `sh scripts/tripwire.sh node --test --test-concurrency=1 tests/core/broker-owner-findings-b-identity.test.ts tests/core/broker-store.test.ts tests/core/broker-verbs.test.ts tests/core/broker-ipc.test.ts tests/core/broker-boundary.test.ts` | exit 0; 39/39 pass after adoption block indentation cleanup. |
| `typecheck` | `sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json` | exit 0; no compiler diagnostics. |
| `green-final-new` | `sh scripts/tripwire.sh node --test --test-concurrency=1 tests/core/broker-owner-findings-b-identity.test.ts` | exit 0; 7/7 pass after tightening card assertions to the actual `what`/`target`/`approving` fields and adding the old-generation guard assertion. |
| `typecheck-final` | `sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json` | exit 0; no compiler diagnostics after those test edits. |
| `green-replay-snapshot` | `sh scripts/tripwire.sh node --test --test-concurrency=1 '--test-name-pattern=Broker.start indexes auto adoption' tests/core/broker-owner-findings-b-identity.test.ts` | exit 0; 1/1 pass after improving replay fixture to restore the captured old blobs as well as header. This prevents mismatched blob generations from accidentally masking a missing generation guard. |

No unexpected failed test/launcher/typecheck attempts. The two failed runs are intentional pre-implementation behavior REDs. Final focused run emitted four existing Node SecurityWarnings for `--allow-child-process` in IPC fixtures; warnings were preserved verbatim in stdout, not hidden. All other captured stderr files are empty. No full-suite, canary/heap, origin/rate/privacy/approval/SEC01–07 suite rerun was performed beyond the named focused suites, per dispatch's explicit scope and prohibition on unnecessary prior-green reruns.

## Self-review and limits

- `git diff --check` passed. Broker budget computed by the boundary test's own counting method is 2,688 lines, below the unchanged 3,000 maximum (base 2,681). Boundary suite passed, including standard-library-only imports, fixed verbs/refusals, no inet listener, type-only Core imports, and no raw-value client getter.
- Existing approval digest continues to bind the full original public key. The new visible fingerprint is an out-of-band owner comparison, **not cryptographic protection for core-relayed approvals against a compromised Core**. No stronger identity claim is made.
- Ask-mode discard is established by actual locked state, refused Store value access/device unlock, and required sealed person factor; direct byte zeroing was also inspected in the `finally` implementation. No heap scan or physical memory-erasure claim is made.
- Startup tests deliver actual signed outboxes and encrypted item blobs but use only synthetic canary homes and file keys. No live sync transport, browser relay, physical passkey, OS keychain, Windows/macOS behavior, P1a integration, P1b consumer switch, or P1c full gate is claimed. Core still uses legacy credentials until the actual consumer cutover.
- No structural uncertainties or remaining Task 1 failures found. Other owner findings, false same-value crash fixture repair, supervisor/reset/diagnostics/module-serving work, and named takeover NOTES remain later tasks.

Commit: `93987af2` (`fix(vault): show holder fingerprints and honor adoption unlock mode`). Source ownership RELEASED. This local report/evidence intentionally remains outside the source commit.

## Task1 full independent review

### Spec Compliance

- Spec compliant for Task 1 B1/B4. Reviewed immutable package `review-2c986878..93987af2.diff` once, base `2c9868780224345a6eea8cdadd71a37d2b60463d`, head `93987af27f4baa8a87203fe263fa62b4c1e95f9c`. Scope is the four requested task files; existing store/verbs/IPC/boundary suites were exercised rather than unnecessarily edited.
- `src/broker/broker.ts:147` computes the full lowercase SHA256 hex fingerprint from the decoded device public key; `src/broker/broker.ts:614` computes the same fingerprint from the proposed enrollment key and `src/broker/broker.ts:616` presents it in existing card fields while retaining the full public key in the approved action. `src/broker/protocol.ts:66` adds exactly the public metadata answer key. No new verb, dependency, permission, listener, or execution bridge appears in the diff.
- `src/broker/broker.ts:94` reindexes after adoption has already unlocked the store. `src/broker/store.ts:488` retains that root only for auto mode; `src/broker/store.ts:489` zeroes the temporary root on ask-mode success and failure paths without disturbing an unrelated preexisting root.
- `tests/core/broker-owner-findings-b-identity.test.ts:40` verifies the actual holder state, actual visible card fields, same-id/name substituted keys, and declined enrollment with no outbox in both core and software-passkey approval modes. `:70` verifies post-approval key substitution remains refused and the original approved key remains usable. `:64` checks answers against synthetic device-private-key and factor canaries.
- `tests/core/broker-owner-findings-b-identity.test.ts:19` builds actual signed outboxes, encrypted blobs, and pinned holders; `:87` and `:108` boot fresh Brokers for auto/ask first and incoming generations and compare complete ref metadata. Ask mode refuses store-value access and device unlock until a sealed person factor (`:121`). Signed-header and hub-pin controls remain tested at `:133`; the generation replay restores a captured old inbox including matching old blobs (`:93`, `:101`), so mismatched ciphertext cannot accidentally supply the refusal.
- Cannot verify whole-phase/P1a/P1b/P1c completion, live transport/browser relay, physical passkeys, keychain/Windows/macOS behavior, physical memory erasure, or unchanged broad SEC01–07/canary/heap gates from this task package. These are not claims made by this task; later gates remain the controller's responsibility. The unrelated same-value crash-fixture repair and takeover NOTES remain later tasks, as stated in `task-1-report.md` under Self-review and limits. This review approves no merge or consumer cutover.

### Strengths

- Minimal production delta with useful behavior tests: identity display uses existing crypto/card/schema mechanisms (`src/broker/broker.ts:147`, `:615`; `src/broker/protocol.ts:66`), and the root-lifetime fix uses a straightforward `try/finally` (`src/broker/store.ts:468`). No privileged logic is moved outside the counted broker tree. The diff adds seven net broker lines, consistent with the stated 2,681 to 2,688 budget change; the unchanged 3,000-line boundary check passed (`evidence/task-1/green-focused.stdout:4`).
- Approval-action key binding remains explicit (`src/broker/broker.ts:616`); visible comparison is accurately an out-of-band owner check, without any claim that compromised Core cannot forge its own relayed display/approval.
- Startup proofs exercise `Broker.start()` through the real shared helper (`tests/support/broker-support.ts:31`) and authenticated store adoption rather than mocking an unlocked flag (`tests/core/broker-owner-findings-b-identity.test.ts:88`, `:117`).

### Issues

#### Critical (Must Fix)

- None. Count: 0.

#### Important (Should Fix)

- None. Count: 0.

#### Minor (Nice to Have)

- Existing fixture warning baseline, count: 1. `evidence/task-1/green-focused.stdout:8`, `:11`, `:14`, and `:17` contain four preserved Node SecurityWarnings for `--allow-child-process`. The warning describes a real security limitation: child processes can invalidate Node permission isolation. The unchanged spawn helper explicitly documents that Node permissions do not follow children and are defense in depth, not a security wall against broker code execution (`src/broker/spawn.ts:7`), and intentionally grants children for bound launcher/keychain work (`:23`). IPC assertions still verify narrow filesystem grants, a minimal environment, socket modes, and no listener (`tests/core/broker-ipc.test.ts:57`). This is preexisting warning noise/known security scope, not a new Task 1 vulnerability or a reason to remove the necessary grant. Retain the evidence and the documented limitation; no warning suppression or unrelated spawn redesign is requested in this task.

### Named Focused Checks

- Startup corrupt-item isolation: the package cuts off `#reindex()`, so I read its complete body (`src/broker/broker.ts:105`) and the specific `Store.metas()`/`value()` callees (`src/broker/store.ts:253`, `:282`), plus the existing static tamper test (`tests/core/broker-store.test.ts:56`). `metas()` authenticates metadata, item keys, and current/pending values inside a per-item catch before adding an entry to the map (`src/broker/store.ts:260`). Thus ordinary corrupt ciphertext is excluded and reported before `#reindex()` performs reuse hashing; the new uncaught already-unlocked branch does not turn one preexisting corrupt item into startup failure. Concurrent external filesystem modification between those synchronous reads is not newly introduced or proven here. No unanswered concern justified a duplicate test run.
- Actual X25519 byte identity: checked device public-key source (`src/broker/store.ts:123`, `:135`) and the raw public-key encoding (`src/broker/crypto.ts:73`). The device key is the raw 32-byte X25519 public key encoded as base64, so decoding before SHA256 fingerprints the specified key bytes rather than a DER wrapper or the base64 text. Enrollment still uses that same supplied key (`src/broker/store.ts:421`). An initial targeted search also named a nonexistent `src/broker/device.ts`; the device implementation was located in Store. No code or tests were changed.
- Startup process impact: checked the direct main call (`src/broker/main.ts:18`) and real-test helper (`tests/support/broker-support.ts:33`) for the changed `start()` contract. `main` would report a true startup exception, but the static corrupt-item concern is handled as above; there is no swallowed newly introduced adoption/reindex error established by this review.
- Node warning merits: inspected only the unchanged spawn permission contract and IPC assertions cited above. No broadened security audit or warnings suppression was performed.

### Verification Evidence Inspected

- Read the complete behavior RED outputs: `evidence/task-1/red.stdout:9` records 7 tests, 3 pass/4 fail for missing fingerprints, auto empty index, and ask unlocked state; `red-card.stdout:4` records 2 tests/2 fail for missing fingerprints in actual visible card fields. Their JSON manifests record exit 1. These are deliberate pre-fix failures, not unexplained launch failures.
- Read the complete affected-suite output: `evidence/task-1/green-focused.stdout:49` records 39 tests/39 pass/0 fail, including store, verbs, IPC, boundary, and the new file. `green-new.stdout:9` and `green-final-new.stdout:9` each record 7/7; `green-replay-snapshot.stdout:3` records the final captured-header-and-matching-blobs replay test 1/1. Corresponding JSON manifests record exit 0. The full 39-test run precedes the final test-only strengthening; those strengthened tests have their own 7-test and final 1-test results.
- Both `typecheck.json` and `typecheck-final.json` record exit 0 for `node node_modules/typescript/bin/tsc -p tsconfig.json`; stdout contains only tripwire status, stderr is empty. All eight captured stderr files are empty; the four warnings are in the focused test stdout and are accounted for above.
- Inspected all eight enumerated launcher manifests plus `evidence/task-1/launcher.py:13`. They record contemporaneous UTC start/end, explicit workdir, exact commands, private host HOME with only PATH/HOME/LANG, cached Playwright `--pull=never`, `--network=none`, user 1000, read-only container/worktree/Node mounts, private tmpfs/HOME, and only the two specified binds. Test flags precede paths; no owner-home, desktop socket, Kubernetes access, or warning suppression is in these launcher commands. Each stdout records tripwire armed and never fired. Image content/daemon provenance and command-time filesystem snapshots cannot be independently reconstructed from these manifests; the record supports the stated bounded launcher configuration, not an attestation of all historical host activity.
- No suite, probe, compiler, git command, or source mutation was run for this review. Only the requested local review artifact is written. Review remains scoped to this immutable task package even if the next writer changes legacy Core files.

### Assessment

**Task quality:** Approved.

**Reasoning:** Task 1 meets B1/B4 with real public-key/card behavior, real signed startup adoption, and correctly bounded root retention. No task-blocking issue was found; the one Minor is the existing, preserved Node child-permission warning baseline and its documented security limitation.

**Counts:** Critical 0; Important 0; Minor 1 (existing baseline warning finding). Spec compliant; quality Approved. Source/index/branch/HEAD remain untouched. RELEASE.

## Rulings I made (with costs)

Ruling: owner's explicit test-first fixes, integration NOTES and continuous execution authorize implementation without another plan approval round. Cost if wrong: visible implementation rework; actual new rendered-surface/ADR owner gates still apply.

Ruling: merge current main into our owned vault branch never rebase, preserving both Ledger histories and main51row mapping plus branch Secrets status. Cost if wrong: documentation chronology may need cleanup; source has exact two-parent merge d425 for review, no runtime conflict edits.

Ruling: use existing authenticated random AES-GCM nonce as encrypted-source write epoch, with independent non-content source metadata and v2 stored revision prefix, never plaintext hash. Cost if wrong: a whole-file epoch conservatively retains unrelated entries after any write; unsupported/uncertain old or Gmail writers require quiescence/refusal, not guessing.

Ruling: repair the false crash fixture with captured original encrypted file+key instead of same-value Vault.put, which creates a newer epoch. Cost if wrong: exact resume counts reflect all restored names; preserve actual no-duplicate/moved/removal/newer-value assertions and independent review.

Ruling: holder comparison uses full SHA256 of decoded X25519 public bytes, not truncated base64-text fingerprints. Cost if wrong: longer human comparison; no new identity protocol and no claim that core-relayed approval defeats compromised core.

Ruling: ask-mode adoption zeroes its temporary root and stays locked, including on incoming generations, as ownerB specifies. Cost if wrong: a holder may need its factor after adopting a new generation; no silent unlock bypass.

Ruling: own POSIX group and credential directory through actual cleanup; unsupported Windows process credential use fails closed before injection. Cost if wrong: that unproven process feature stays unavailable; deliberate escaped/copied target credentials remain stated same-user/target limits.

Ruling: task grants use existing five-minute APPROVAL_MS, not replay-cache lifetime or indefinite task-id reuse. Cost if wrong: long work may request approval again; bounded authorization is preferred.

Ruling: bind normalized process inputs/full HTTP query to tier2 action/grant while showing safe caller-input metadata/fingerprints and keeping raw payloads out of audit. Cost if wrong: more granular reapproval; generic answer schema is not widened for arbitrary caller data, HTTP header/body limits remain explicit.

Ruling: apply the takeover brief's named P1a safety NOTES before275merge, with only exact trusted supervisor bootstrap broker import exception; actual consumer/browser cutover/fullgate remain separate P1b/P1c. Cost if wrong: more integration work/delay, no early credentialedJ or full-confidentiality claim.

Ruling: backend tests use cached network-isolated container with own code/Node26/privatehomes and fake keychain/targets. Cost if wrong: physicalWindows/mac/keychain behavior remains unproven; no real owner service is contacted for convenience.

Ruling: add internal owned-program shutdown awaitability for supervisor/reset, retaining owned run directories through broker cleanup; ambiguous leftovers after unclean broker death refuse new process uses instead of killing stale/unrelated PID markers. Cost if wrong: intentional operator recovery may be needed after an unclean stop; no universal containment/credential revocation after deliberate target escape or OS compromise is claimed. No new public verb, store or process registry.

Ruling: B5 keychain context must cover both process hops; source audit shows startBroker currently omits HOME too, despite owner review assuming it forwarded it. Cost if wrong: slightly broader explicitly named trusted OS context, never model command env or parent spread; file mode stays narrow, fake keychain tests only.


## Task2 complete implementer report and fix round1

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


## Task2 initial independent review (Important finding retained)

# Spec compliance: Issues found

The explicit B6 read/recovery mechanics are implemented. The new warm-read failure behavior is not safely integrated with the existing outbound secret guard (I1). This is a task-scoped review of immutable package `review-bcda07c8..15d5cf68.diff`, base `bcda07c832cb1864ee418b36b1642f68c0e08bcf`, head `15d5cf68417333cbbff49833c2a63a1cbfb5e612`; it is not whole-branch or whole-phase approval.

## Strengths

- `src/core/vault.ts:461–520`: ordinary committed reads authenticate without acquiring the writer lock or removing pending ciphertext. Cache reuse requires exact serialized committed bytes and exact key bytes. `tests/core/vault-owner-findings-b.test.ts:37–77` checks all four verbs cold/warm under a stale lock, unchanged bytes, unrelated pending state, external saves/deletes/clear, and no resurrection on a later mutation.
- `src/core/vault.ts:487–493,522–537`: pending state is probed, then reopened and authenticated again under the exclusive lock before rename. The pending map is not returned as committed data. `tests/core/vault-owner-findings-b.test.ts:92–124,202–214` covers stale-lock refusal, successful same-vault repair, malformed/tampered/different-vault refusal and authentication after acquisition.
- `src/core/vault.ts:512–518,554–586`: key-file promotion and duplicate removal happen only after authentication and inside serialization; unavailable serialization leaves the valid read usable and key file intact. Exact key readback precedes successful file removal. `tests/core/vault-owner-findings-b.test.ts:126–159,191–200` covers deferred housekeeping, ordinary keychain reads and authentication before promotion.
- `src/core/vault.ts:440–447`: unconditional map/serialized-cache invalidation after a mutation attempt closes the failed-deletion cache defect. `tests/core/vault-owner-findings-b.test.ts:161–189` checks failure, committed readback, changed ciphertext, key loss and restoration.
- The patch changes only the legacy Vault and a new 214-line regression file. It adds no dependency, broker protocol/API, file format or public raw-value method. Existing tests and security assertions have no edits in this package.

## Issues

### Critical: 0

None found in this task-scoped review.

### Important: 1

**I1 — Newly revalidated warm reads can silently disable outbound secret screening.** Changed site: `src/core/vault.ts:486` (key lookup now precedes the cache hit at line 496). Existing integration: `src/core/index.ts:501`; `src/core/ingest/screen.ts:305–310`; `src/core/ingest/outbound.ts:69–76`.

Core collects values using `vault.list().map(n => vault.get(n))`, catches any exception, and returns `[]`. The outbound guard accepts that as a successful scan with no known secrets. Before this patch, a successfully warmed Vault used its cached map without probing the keychain again. Now a temporarily unavailable keychain makes that same warmed Vault throw, the collector silently empties the secret set, and a payload containing the already-known credential is allowed. A failure on any individual get also discards the entire scan. Key disappearance must not be hidden by stale credential reads, but a scan failure must not mean there are no secrets to protect.

A narrow synthetic probe reproduced exactly this transition using the real Vault, the verbatim Core collector, and the real `outbound` function: before keychain unavailability `{ok:false,matched:[{kind:'secret',...}]}`; afterwards `{ok:true,matched:[]}`. It does not claim the pre-existing cold-start fail-open collector was introduced here; the regression is its new reachability after an already-warmed successful read. The probe does not start the full Core or prove an end-to-end network transmission.

Fix the consumer error contract so unavailable/failed credential enumeration refuses the outbound operation, and add a behavior test for warm-keychain disappearance and partial scan failure. Merely removing the Core catch is insufficient because `IngestScreen.outbound` also catches and substitutes an empty list. Preserve the required fresh-read semantics; do not solve this by retaining a stale public plaintext cache, weakening canary checks, or adding a broker raw-value API. Root should explicitly scope any necessary consumer changes before implementation.

### Minor: 1

**M1 — The warm cache preserves crypto work but loses low per-name access cost.** `src/core/vault.ts:475–486,496,555–560`; callers `src/core/index.ts:501`, `src/core/browser/worker.ts:1041`, `src/core/diagnostics/index.ts:100`.

Each warm get reads and JSON-parses the entire encrypted envelope, then probes key storage before reusing the map. The existing N-entry Core collector therefore performs N+1 whole-file reads/parses and, with an answering platform keychain, 2(N+1) synchronous CLI calls: `available()` and `read()` each invoke a command (`src/core/vault.ts:103–110,131–136,160–165`). Those commands block the event loop, with a 10-second timeout each (`src/core/vault.ts:49–50`). The old warm path did not perform these keychain calls. For an N-entry file whose size grows with N, the collection also repeats proportional file work N+1 times.

The freshness requirement explains why key changes cannot be ignored, and this report does not invent an OS-keychain latency measurement or relax it. Nevertheless this is a concrete cost regression in an existing outbound guard, not a constant-time cache. Treat as a follow-up design constraint when fixing I1: avoid repeated envelope parsing where safe and evaluate a bounded internal scan/snapshot that preserves the public Vault API and fresh-read contract. An injected-store invocation-count test can make the cost explicit without a real keychain benchmark. Classified Minor because no quantitative latency threshold was specified and the new probes enforce required key-loss observation; the retained report candidly describes the limitation (`task-2-report.md:55`).

## Named risk checks and scope

1. **Read/recovery/promotion ordering and authentication:** reviewed the diff plus unchanged `#save` tail (`src/core/vault.ts:591–620`, the diff cuts this function off), `parseFile/decrypt` (`633–650`), and public mutation/read wrappers (`256–414`) to check lock entry, synchronous change events and standby key access. Every existing mutation wrapper remains serialized; put/delete/deletePrefix still refresh. Recovery re-enters `#open` after lock acquisition and after rename. A valid current file ignores unrelated pending state. No fingerprint-only recovery or lost/waiting reset regression found.
2. **Optional housekeeping under a stale lock:** `src/core/vault.ts:420–429,512–518` supplies the already authenticated map on failed lock acquisition; it does not steal/remove another lock. `tests/core/vault-owner-findings-b.test.ts:126–159` verifies key-file preservation/deferred promotion. Existing immediate promotion contract remains in `tests/core/vault.test.ts:177–181`, unchanged and passing in retained evidence. No conflicting housekeeping assertion was silently removed.
3. **Cache after failed mutation/external changes:** checked the key+serialized comparison and finally invalidation in the diff against public get/has/list/status and mutation call sites. Real external writer, failed deletion and tampering tests are at `tests/core/vault-owner-findings-b.test.ts:65–77,161–189`. No permanently cached unsaved mutation found.
4. **Existing SEC05 and recovery contract:** inspected `tests/core/broker-owner-findings.test.ts:108–203` and `tests/core/broker-migration-recovery.test.ts:54–121` only for the cross-cutting lock/rekey contract. Newer values, concurrent acknowledged writes, reload after migration, authenticated same-vault repair and stale-lock refusal remain asserted. No B2 implementation or fixture change is part of this patch; future B2 work is not approved by this review.
5. **Standby contract:** inspected `tests/acceptance/m5b-vault-standby.test.ts:33–75` for the affected change-event/read boundary: replication uses actual nodes and fake Home Assistant, checks 0600 ciphertext/key, no plaintext token in either home, no key in sync logs, then checks failover behavior. Retained run passed; no rerun performed.
6. **Per-read cost and warm-read error propagation:** focused call-site check found the existing Core collector and its outbound consumer, then platform key-store implementations for operation counts. This check yielded I1/M1. No unrelated codebase crawl, real keychain access, timing benchmark or broad test run was performed.

## Retained evidence inspection

- Read all seven JSON launch records, the complete green-new/green-focused/standby/typecheck/typecheck-fixed/red-cache-auth stdout, the RED failure entries/summaries, and launcher source. Confirmed all seven stderr files are zero bytes.
- `evidence/task-2/launcher.py:13–30` and each JSON record enumerate clean host env, exact argv/cwd, private HOME, cached image with `--pull=never`, `--network=none`, user 1000, read-only filesystem/worktree/Node binds, start/end timestamps and exit status. No warning suppression is present. No Kubernetes tripwire fired.
- `evidence/task-2/red.stdout:2–27`: 18 tests, 5 pass, 13 intentional failures. `red-cache-auth.stdout:2–12`: 4 tests, 1 pass, 3 intentional failures; these are real behavioral defects, not an import/configuration failure.
- `evidence/task-2/green-new.stdout`: 22/22 pass. `green-focused.stdout:71–79`: 69 tests, 68 pass, 1 skip, 0 fail. SEC01–05, migration recovery, provider redaction and boundary tests are named in the retained output. The skip is the existing real secret-tool case (`tests/core/vault.test.ts:219–231`), which conditionally requires secret-tool and a desktop session; it is not evidence of real OS-keychain validation. This permitted environment-dependent skip is a stated limitation, not an unexplained warning or new skipped regression.
- `evidence/task-2/typecheck.stdout:2–4` retains TS2322 in the new fixture; the final diff contains the explicit `Buffer` annotation at `tests/core/vault-owner-findings-b.test.ts:163`. `typecheck-fixed.json` has exit 0; corresponding stdout has only tripwire notices. The initial compiler failure is resolved evidence, not an outstanding finding.
- `evidence/task-2/standby.stdout:2–11`: 1/1 acceptance pass, 0 skip/fail. Green output has no compiler/test warnings; deliberate tripwire notices are expected instrumentation. No green suite was rerun by this reviewer.

## Focused reviewer probe for I1

One command only, using cached `mcr.microsoft.com/playwright:v1.56.1-noble`, `--pull=never --network=none --user=1000:1000 --read-only`, private `/tmp` tmpfs/HOME, read-only own-worktree `/workspace` and Node 26.3.1 `/opt/node` mounts. Host environment was exactly PATH `/usr/bin:/bin`, HOME `/tmp/nova-review-docker-l2f7vln_`, LANG `C.UTF-8`; container overrides HOME `/tmp/nova-review-private-home`, PATH `/opt/node/bin:/usr/bin:/bin`, TZ `UTC`, LANG `C.UTF-8`. Workdir was the authorized worktree on the host and `/workspace` in the container. Wrapper `sh -c 'mkdir -m 700 "$HOME" && exec "$@"' review` executed `sh scripts/tripwire.sh node --input-type=module -e` with this exact program:

```javascript
import { Vault } from './src/core/vault.ts';
import { outbound } from './src/core/ingest/outbound.ts';
import { mkdtempSync } from 'node:fs';
import assert from 'node:assert/strict';
const home = mkdtempSync('/tmp/nova-review-b6-');
const secret = 'synthetic-review-outbound-canary';
let key = null, up = true;
const kc = { kind: 'keychain', name: 'synthetic', available: () => ({ok:up,detail:'synthetic'}), read: () => key, write: k => {key=Buffer.from(k)}, remove: () => {key=null} };
const vault = new Vault({ home, mode:'auto', keychain: () => kc });
vault.put('provider/KEEP', secret);
assert.equal(vault.get('provider/KEEP'), secret);
const secrets = () => { try { return vault.list().map(n => vault.get(n)).filter(v => typeof v === 'string'); } catch { return []; } };
const check = () => outbound(secret,{tainted:false,secrets:secrets(),mine:()=>new Set()});
const before = check();
up=false;
const after = check();
assert.equal(before.ok,false);
assert.equal(after.ok,true);
console.log(JSON.stringify({probe:'warm keychain availability and existing Core callback',before,after}));
```

Observed exit 0, empty stderr, exact stdout:

```text
no-Kubernetes tripwire: armed (kubectl, helm, flux and k3s on PATH record and fail every call; KUBECONFIG unset)
{"probe":"warm keychain availability and existing Core callback","before":{"ok":false,"matched":[{"kind":"secret","words":"looks like a saved password or key"}]},"after":{"ok":true,"matched":[]}}
no-Kubernetes tripwire: never fired
```

## Cannot verify from this task diff

- Full P1a takeover NOTES, P1b consumer switch/browser relay, P1c gates, SEC06–07/heap/physical-lifetime and other unchanged security suites are not demonstrated by this task's selected runs. The patch does not edit those surfaces; root must preserve their separate gates. `task-2-report.md:57` correctly disclaims whole-phase completion.
- Real OS-keychain behavior and latency, physical passkeys, actual owner credentials/devices/cloud, and a full application/network reproduction of I1 were intentionally not exercised. The platform command-count analysis is static, and I1's focused proof is component-level with the exact existing collector.
- The package proves no broker-source delta; boundary output proves the unchanged budget passed, but this review did not independently recount the reported 2,688 lines or inspect unrelated broker internals.
- The retained launch records are inspected evidence, not a reconstruction of unrecorded process history or independent proof of every earlier self-review command.

## Assessment

Task quality: **Needs fixes**. Counts: **0 Critical / 1 Important / 1 Minor**.

The lock-free committed-read and serialized authenticated-recovery implementation is well covered and preserves the requested file/API boundaries. The changed warm-read failure contract exposes an existing fail-open consumer on the active legacy path, so the task should not be approved until I1 is fixed or explicitly ruled by root with the preserved security contract addressed.

Review source ownership: **RELEASED**. Only this requested review report was written; no source, index, HEAD, branch, push or merge changes, and no subagents.


## Task2 scoped fix-round1 independent review

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


## Additional controller rulings with costs

Ruling: extend Task2 fix scope to exact legacy Core secret collector and IngestScreen outbound error contract because new fresh-read errors make existing catch-empty fail-open reachable after warm reads. Both must refuse unavailable/partial scans; preserve fresh key-loss observation and no new plaintext/broker API. Cost if wrong: outbound work may wait for credential scanning/keychain recovery instead of proceeding unchecked; regression tests cover real Core and recovery.

Ruling: extend Task2 I1 fix narrowly to configured tainted-memory/standing source errors in the same Screen catch-empty contract; required unavailable sources refuse with fixed safe reasons, while untainted secrets-only scans do not read memory. Why: the exact adjacent catch-empty paths have the same concrete fail-open failure. Cost if wrong: tainted outbound may wait for memory recovery; no broader runner/privacy redesign, stale plaintext cache, or new raw API. Test-first and restored-source behavior required.

## Checkpoint status

Task2 B6 approved after one fix round at95f96c4a. I1 closes both fail-open consumer layers; M1 repeated per-name encrypted reads/keychain probes remains deferred for explicit final triage. Existing Task1 child-permission warning Minor also remains. B2/B3/B5/remaining low findings, named takeover NOTES, fresh adversarial review, full exact-head CI, LEDGER/merge/preview still pending. Not a complete phase or consumer cutover claim. Full contemporaneous raw launcher records remain retained privately for final evidence publication; these reports do not turn local focused runs into CI or physical keychain proof.


## Task3 approved checkpoint and complete raw evidence

Task3 metadata-only migration epochs and both per-item/global equality-oracle regressions are approved after one fix round at c38cb860. The initial review found an Important uncertainty-discovery bypass; the correction uses exact ancestor/file lstat and ENOENT-only absence with unchanged permissions. Final focused57/57 plus crash-resume/SEC056/6 and compiler passed; broker2736/3000. Gmail still requires quiescent writers and trustworthy metadata.

[Full Task1–3 reports, reviews and original contemporaneous raw launch evidence](vault-owner-findings-b-2026-11-03/README.md), including all RED/intermediate attempts, [Task3 report and fix](vault-owner-findings-b-2026-11-03/task-3-report.md), [initial Important review](vault-owner-findings-b-2026-11-03/task-3-review.md), [scoped fix approval](vault-owner-findings-b-2026-11-03/task-3-fix1-review.md), and [artifact hash manifest](vault-owner-findings-b-2026-11-03/manifest.json).

## Task3 controller rulings with costs

Ruling: Task3 visible card and approval action bind a v2 digest derived only from source identities/write epochs; raw nonce/stat tuples stay private to launcher/broker transport, no plaintext content/length/equality in digest. Gmail uses stable regular-file dev/ino/mtimeNs/ctimeNs before/after read (no size), under explicit quiescent-writer contract and conservative refusal/retention on uncertainty. Why: visible approval scope must change without exposing a credential verifier; existing plaintext files have no authenticated nonce. Cost if wrong: changed/uncertain sources require reapproval or retained cleanup, and Gmail metadata is not proof against hostile same-user/root metadata/clock manipulation or unquiesced writers; quiet-source successful migration remains mandatory, no new equality-oracle waiver.

Ruling: Task3 refuses staging Gmail sources without a stable regular-file identity/write epoch (including non-regular or uncertain reads), instead of minting a random surrogate epoch that could be confused with source identity. Stable quiet Gmail migration remains required; changed/uncertain finish retains source and refuses cleanup; trustworthy newer epochs keep existing names. Why: source epoch uncertainty cannot authorize an approval or cleanup under the required quiescent-writer contract. Cost if wrong: such sources require quiescing/repair and retry rather than a partial stage; safe plain refusal and actual behavioral RED required, no raw path/value or new registry/store.

Ruling: discard and zero any prior staged migration data before every restage attempt, so a failed current-source stage cannot leave an earlier approval capable of committing stale copies. Why: the concrete regular-to-symlink restage probe produced one stale broker copy under the old approval. Cost if wrong: a failed restage loses the previous attempt and requires a fresh successful stage/approval; no new public verb, registry or surrogate epoch.

Ruling: permit a proven exact fixed connectors-root/subtree read grant, including missing/future root if supported, as the existing intended migration read authority needed to distinguish confirmed absence. Why: real permission IPC shows ENOENT-only correctness exposes denial for genuinely absent connectors. Cost if wrong: that exact intended credential-source root remains readable by the migration launcher as it already is when present; no whole-home/filesystem access, stage connector writes, generic denial catch or new source roots. Actual synthetic permission behavior and no-connectors control required before acceptance.

The conditional exact-root grant allowance above was **not needed or applied**: the runtime probe proved the existing grant already allows inspection of the exact missing connectors root. Production grants remain unchanged. Task4 process/env, Task5 policy, named takeover NOTES, complete final gate/LEDGER/merge/preview remain pending.
