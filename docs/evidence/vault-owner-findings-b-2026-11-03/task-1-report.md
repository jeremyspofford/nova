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
