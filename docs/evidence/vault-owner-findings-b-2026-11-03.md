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
