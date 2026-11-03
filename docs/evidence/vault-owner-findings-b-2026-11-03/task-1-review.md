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
