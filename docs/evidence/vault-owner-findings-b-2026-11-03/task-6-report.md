# Task 6 implementation report — implementation complete, Task7 review pending

Base: `6185726bd5066fe1896251eb34d08f4e8598b8ad`.
Unblocked prefix checkpoint: `87705ac84e0ce920267a8c16fce4bc278318e28c`; additional interrupted-keychain regression `03493076`; missing-device-record guard `51167f1a31e9ff1639fea760492164dc217c1961`; early foreign-home guard `e4f6051de503154dea780fe9766cef17af17903a`; independent Core/bootstrap/seal checkpoint **`3e0cfd08b45171136004aaecd969fd0cf485f5d3`**.
Status: **Task6 fix round1 implemented; scoped re-review pending**, clean `44a8deb563324ac2847c02dc82dfc6e3aec32d85`. Initial Task6 review requested changes for I1/I2; this consolidated fix responds to both. Current proof: affected77/77, final controls9/9, compiler60exit0, broker2896/3000. Historical119/119 belongs to2827 and is not a full gate of this fix. Task7/full publication and P1b/P1c remain outstanding. See final fix appendix; earlier checkpoint statuses are historical.

## Safety and interfaces

- `Supervisor` starts the fixed broker source from `codeRoot()/src/broker` before its Core child. Only the core role token and socket travel over the existing private Node parent-child IPC handshake. State retains status/PID only. Old release fixtures without broker report unsupported and receive no context.
- `startBroker` has trusted `source`/`reset` options; `Started.stopped` resolves only on clean process close. `stopBroker` sends TERM and awaits that evidence without assuming a timeout proves cleanup. No public verb was added.
- Shutdown awaits both service cleanup and Core/broker cleanup using allSettled; failures hold safe mode, retain broker/run evidence, release control resources, and propagate failure. Recovery cannot skip an unconfirmed stop. Restart requests are serialized.
- `supervisorResetPending` verifies the existing fixed-home authenticated marker. The supervisor runs a broker-owned reset-only child, which removes exact device/sign accounts without reading or recreating keys. `finishReset` revalidates the marker and requires the same seal before deleting owned broker data. Standalone Core with owned broker data refuses. A populated broker directory lacking device.json is retained for operator recovery; no account IDs are guessed. Existing foreign/home-mark/tier3/interrupted reset rules remain.
- Windows removal uses the documented metadata snapshot from [PasswordVault.RetrieveAll](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.passwordvault.retrieveall), filters exact Resource/UserName and never calls RetrievePassword. Any nonzero result refuses instead of mapping arbitrary exceptions to missing. macOS/Linux documented missing-entry results remain idempotent. Only private fake CLI/stores were exercised; no physical Windows/macOS keychain claim.
- Broker boundary count at prefix: **2894/3000**, 106 remaining; no budget change, compaction, dependency or privileged-code relocation.

## Attempts retained

Every execution used the saved launcher, cached image with `--pull=never`, no network, private HOME, read-only workspace and Node26 mount. The launcher records exact argv/env/cwd/time/exit code contemporaneously. Tests use the no-Kubernetes tripwire. The two prefix compiler commands (check-06 and check-23) were direct invocations and did not use the tripwire; both exited 0, with no output. Compiler output is retained without warning suppression. Independent compiler check37/check39 used the tripwire; check39 passed after test-only typing corrections. The final compiler check after combined source will also use the tripwire. The launcher records host environment and explicit container overrides; the container also inherits baked image ENV (including LC_ALL/PLAYWRIGHT_BROWSERS_PATH), not claimed as a full forensic child-environment inventory. No owner home, keychain, credentials, cloud, device, model, preview or other checkout was touched.

| Attempt / raw output | Exit | Result | Exact context |
|---|---:|---|---|
| [red-01](evidence/task-6/red-01.stdout) | 1 | ℹ tests 2, ℹ pass 0, ℹ fail 2, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-01.json) |
| [red-02](evidence/task-6/red-02.stdout) | 1 | ℹ tests 3, ℹ pass 0, ℹ fail 3, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-02.json) |
| [red-03-keys](evidence/task-6/red-03-keys.stdout) | 1 | ℹ tests 2, ℹ pass 0, ℹ fail 2, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-03-keys.json) |
| [green-04](evidence/task-6/green-04.stdout) | 0 | ℹ tests 12, ℹ pass 12, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/green-04.json) |
| [red-05-home](evidence/task-6/red-05-home.stdout) | 1 | ℹ tests 5, ℹ pass 4, ℹ fail 1, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-05-home.json) |
| [check-06-compiler](evidence/task-6/check-06-compiler.stdout) | 0 | successful compiler invocation; no tripwire | [launcher record](evidence/task-6/check-06-compiler.json) |
| [red-07-windows](evidence/task-6/red-07-windows.stdout) | 1 | ℹ tests 4, ℹ pass 3, ℹ fail 1, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-07-windows.json) |
| [red-08-binding](evidence/task-6/red-08-binding.stdout) | 1 | ℹ tests 2, ℹ pass 1, ℹ fail 1, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-08-binding.json) |
| [green-09-prefix](evidence/task-6/green-09-prefix.stdout) | 0 | ℹ tests 43, ℹ pass 43, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/green-09-prefix.json) |
| [check-10-real-release-stop](evidence/task-6/check-10-real-release-stop.stdout) | 0 | ℹ tests 6, ℹ pass 6, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/check-10-real-release-stop.json) |
| [red-11-symlink](evidence/task-6/red-11-symlink.stdout) | 1 | ℹ tests 5, ℹ pass 4, ℹ fail 1, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-11-symlink.json) |
| [green-12-guards-exclusions](evidence/task-6/green-12-guards-exclusions.stdout) | 0 | ℹ tests 12, ℹ pass 12, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/green-12-guards-exclusions.json) |
| [red-13-stop-failure](evidence/task-6/red-13-stop-failure.stdout) | 137 | incomplete; exact owned-container termination | [launcher record](evidence/task-6/red-13-stop-failure.json) |
| [red-14-stop-failure](evidence/task-6/red-14-stop-failure.stdout) | 1 | ℹ tests 1, ℹ pass 0, ℹ fail 1, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-14-stop-failure.json) |
| [green-15-stop-failure](evidence/task-6/green-15-stop-failure.stdout) | 0 | ℹ tests 1, ℹ pass 1, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/green-15-stop-failure.json) |
| [red-16-legacy-reset](evidence/task-6/red-16-legacy-reset.stdout) | 1 | ℹ tests 1, ℹ pass 0, ℹ fail 1, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-16-legacy-reset.json) |
| [red-17-all-cleanups](evidence/task-6/red-17-all-cleanups.stdout) | 1 | ℹ tests 1, ℹ pass 0, ℹ fail 1, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-17-all-cleanups.json) |
| [green-18-prefix](evidence/task-6/green-18-prefix.stdout) | 0 | ℹ tests 23, ℹ pass 23, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/green-18-prefix.json) |
| [red-19-concurrent](evidence/task-6/red-19-concurrent.stdout) | 1 | ℹ tests 1, ℹ pass 0, ℹ fail 1, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-19-concurrent.json) |
| [green-20-concurrent](evidence/task-6/green-20-concurrent.stdout) | 0 | ℹ tests 1, ℹ pass 1, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/green-20-concurrent.json) |
| [red-21-recover](evidence/task-6/red-21-recover.stdout) | 1 | ℹ tests 1, ℹ pass 0, ℹ fail 1, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-21-recover.json) |
| [green-22-recover](evidence/task-6/green-22-recover.stdout) | 0 | ℹ tests 1, ℹ pass 1, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/green-22-recover.json) |
| [check-23-prefix-compiler](evidence/task-6/check-23-prefix-compiler.stdout) | 0 | successful compiler invocation; no tripwire | [launcher record](evidence/task-6/check-23-prefix-compiler.json) |
| [check-24-interrupted-keychain](evidence/task-6/check-24-interrupted-keychain.stdout) | 0 | ℹ tests 1, ℹ pass 1, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/check-24-interrupted-keychain.json) |
| [red-25-missing-record](evidence/task-6/red-25-missing-record.stdout) | 1 | ℹ tests 1, ℹ pass 0, ℹ fail 1, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-25-missing-record.json) |
| [green-26-missing-record](evidence/task-6/green-26-missing-record.stdout) | 0 | ℹ tests 12, ℹ pass 12, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/green-26-missing-record.json) |
| [red-27-foreign-home](evidence/task-6/red-27-foreign-home.stdout) | 1 | ℹ tests 1, ℹ pass 0, ℹ fail 1, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-27-foreign-home.json) |
| [green-28-foreign-home](evidence/task-6/green-28-foreign-home.stdout) | 0 | ℹ tests 3, ℹ pass 3, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/green-28-foreign-home.json) |
| [red-29-bootstrap](evidence/task-6/red-29-bootstrap.stdout) | 137 | incomplete; exact owned-container termination | [launcher record](evidence/task-6/red-29-bootstrap.json) |
| [red-30-bootstrap](evidence/task-6/red-30-bootstrap.stdout) | 1 | ℹ tests 2, ℹ pass 0, ℹ fail 2, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-30-bootstrap.json) |
| [red-31-client-close](evidence/task-6/red-31-client-close.stdout) | 1 | ℹ tests 1, ℹ pass 0, ℹ fail 1, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-31-client-close.json) |
| [green-32-bootstrap](evidence/task-6/green-32-bootstrap.stdout) | 0 | ℹ tests 13, ℹ pass 13, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/green-32-bootstrap.json) |
| [red-33-client-close-settled](evidence/task-6/red-33-client-close-settled.stdout) | 1 | ℹ tests 1, ℹ pass 0, ℹ fail 1, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-33-client-close-settled.json) |
| [red-34-seal-module](evidence/task-6/red-34-seal-module.stdout) | 1 | ℹ tests 1, ℹ pass 0, ℹ fail 1, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/red-34-seal-module.json) |
| [green-35-independent](evidence/task-6/green-35-independent.stdout) | 0 | ℹ tests 10, ℹ pass 10, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/green-35-independent.json) |
| [check-36-actual-bootstrap](evidence/task-6/check-36-actual-bootstrap.stdout) | 0 | ℹ tests 3, ℹ pass 3, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/check-36-actual-bootstrap.json) |
| [check-37-independent-compiler](evidence/task-6/check-37-independent-compiler.stdout) | 1 | failed compiler invocation; tripwire | [launcher record](evidence/task-6/check-37-independent-compiler.json) |
| [green-38-bootstrap-final](evidence/task-6/green-38-bootstrap-final.stdout) | 0 | ℹ tests 4, ℹ pass 4, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/green-38-bootstrap-final.json) |
| [check-39-independent-compiler](evidence/task-6/check-39-independent-compiler.stdout) | 0 | successful compiler invocation; tripwire | [launcher record](evidence/task-6/check-39-independent-compiler.json) |
| [green-40-served-browser](evidence/task-6/green-40-served-browser.stdout) | 0 | ℹ tests 1, ℹ pass 1, ℹ fail 0, ℹ cancelled 0, ℹ skipped 0 | [launcher record](evidence/task-6/green-40-served-browser.json) |

RED01 additionally exposed an incorrect test import (`consoleDefinition`); RED02 corrected that fixture and demonstrated actual missing lifecycle behavior. RED13 failed its state assertion and hung because the control socket remained open. Only its exact owned container `ed19cc8a4e3dfc0a9d84e2d6fafd96bccaccee1bafd5f0c353667088e5b9722d` was stopped after command plus workspace-mount verification; final exit137. [Owned termination record](evidence/task-6/red-13-owned-container-stop.json). RED14 force-exit was diagnostic only; GREEN15 and GREEN18 prove natural exit. RED17/RED19 force-exit were diagnostic for deliberately broken cleanup/concurrent lifecycle cases; GREEN18/GREEN20 exit naturally. No failed attempt was erased.

## Exact commands

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-01 sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=30000 tests/supervisor/broker-lifecycle.test.ts tests/core/broker-reset-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-02 sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=30000 tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-03-keys sh scripts/tripwire.sh node --test --test-concurrency=1 tests/core/broker-reset-keys.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-04 sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=30000 tests/supervisor/broker-lifecycle.test.ts tests/core/broker-reset-lifecycle.test.ts tests/core/broker-reset-keys.test.ts tests/core/broker-boundary.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-05-home sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=30000 tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py check-06-compiler node node_modules/typescript/bin/tsc -p tsconfig.json
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-07-windows sh scripts/tripwire.sh node --test --test-concurrency=1 tests/core/broker-reset-keys.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-08-binding sh scripts/tripwire.sh node --test --test-concurrency=1 tests/core/broker-reset-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-09-prefix sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=60000 tests/supervisor/broker-lifecycle.test.ts tests/core/broker-reset-lifecycle.test.ts tests/core/broker-reset-keys.test.ts tests/supervisor/guards.test.ts tests/core/reset.test.ts tests/core/broker-boundary.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py check-10-real-release-stop sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=60000 tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-11-symlink sh scripts/tripwire.sh node --test --test-concurrency=1 tests/core/broker-reset-keys.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-12-guards-exclusions sh scripts/tripwire.sh node --test --test-concurrency=1 tests/core/broker-reset-keys.test.ts tests/core/broker-exclusions.test.ts tests/core/broker-boundary.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-13-stop-failure sh scripts/tripwire.sh node --test '--test-name-pattern=failed broker owned' --test-concurrency=1 --test-timeout=10000 tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-14-stop-failure sh scripts/tripwire.sh node --test --test-force-exit '--test-name-pattern=failed broker owned' --test-concurrency=1 --test-timeout=10000 tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-15-stop-failure sh scripts/tripwire.sh node --test '--test-name-pattern=failed broker owned' --test-concurrency=1 --test-timeout=10000 tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-16-legacy-reset sh scripts/tripwire.sh node --test '--test-name-pattern=previously staged legacy' --test-concurrency=1 --test-timeout=10000 tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-17-all-cleanups sh scripts/tripwire.sh node --test --test-force-exit '--test-name-pattern=service cleanup rejection' --test-concurrency=1 --test-timeout=10000 tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-18-prefix sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=60000 tests/supervisor/broker-lifecycle.test.ts tests/core/broker-reset-lifecycle.test.ts tests/core/broker-reset-keys.test.ts tests/core/broker-exclusions.test.ts tests/core/broker-boundary.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-19-concurrent sh scripts/tripwire.sh node --test --test-force-exit '--test-name-pattern=concurrent restarts' --test-concurrency=1 --test-timeout=15000 tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-20-concurrent sh scripts/tripwire.sh node --test '--test-name-pattern=concurrent restarts' --test-concurrency=1 --test-timeout=15000 tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-21-recover sh scripts/tripwire.sh node --test '--test-name-pattern=failed broker owned' --test-concurrency=1 --test-timeout=10000 tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-22-recover sh scripts/tripwire.sh node --test '--test-name-pattern=failed broker owned' --test-concurrency=1 --test-timeout=10000 tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py check-23-prefix-compiler node node_modules/typescript/bin/tsc -p tsconfig.json
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py check-24-interrupted-keychain sh scripts/tripwire.sh node --test '--test-name-pattern=supervised keychain reset' --test-concurrency=1 --test-timeout=30000 tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-25-missing-record sh scripts/tripwire.sh node --test '--test-name-pattern=missing device record' tests/core/broker-reset-keys.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-26-missing-record sh scripts/tripwire.sh node --test tests/core/broker-reset-keys.test.ts tests/core/broker-boundary.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-27-foreign-home sh scripts/tripwire.sh node --test '--test-name-pattern=refuses a foreign home' tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-28-foreign-home sh scripts/tripwire.sh node --test '--test-name-pattern=refuses a foreign home|base.*runs|folder must' tests/supervisor/broker-lifecycle.test.ts tests/supervisor/guards.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-29-bootstrap sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=15000 tests/core/broker-bootstrap.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-30-bootstrap sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=15000 tests/core/broker-bootstrap.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-31-client-close sh scripts/tripwire.sh node --test '--test-name-pattern=deliberately closed' --test-timeout=15000 tests/core/broker-bootstrap.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-32-bootstrap sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=15000 tests/core/broker-bootstrap.test.ts tests/core/broker-ipc.test.ts tests/core/broker-boundary.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-33-client-close-settled sh scripts/tripwire.sh node --test '--test-name-pattern=deliberately closed' --test-timeout=15000 tests/core/broker-bootstrap.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-34-seal-module sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=30000 tests/core/broker-seal-module.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-35-independent sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=30000 tests/core/broker-bootstrap.test.ts tests/core/broker-seal-module.test.ts tests/core/broker-boundary.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py check-36-actual-bootstrap sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=90000 '--test-name-pattern=actual supervisor starts|restore under the supervisor|closing during' tests/supervisor/broker-lifecycle.test.ts tests/supervisor/checkpoints.test.ts tests/core/broker-bootstrap.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py check-37-independent-compiler sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-38-bootstrap-final sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=15000 tests/core/broker-bootstrap.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py check-39-independent-compiler sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-40-served-browser sh scripts/tripwire.sh node --test --test-timeout=30000 tests/core/broker-seal-module.test.ts
```


## Independent Core/bootstrap/seal work and actual limits

- `ipcBroker` waits for the fixed private parent handoff, validates exact context shape, rejects malformed role delivery, disconnect or missing reply, and removes handshake listeners. `server.js` awaits it before createNova/Core and constructs only the existing BrokerClient. Core owns/ closes this metadata-only client; standalone Core explicitly has null. Deliberate close destroys the connection, clears the token and permanently refuses reuse, including close during initial handshake. No public broker relay or value getter was added.
- `server.js` reads only the fixed release's `src/broker/seal.ts` as public text and uses Node26 stripTypeScriptTypes; it neither imports nor executes broker runtime code. Core registers exactly `/api/v1/broker/seal.js`, person access, JavaScript/no-store/nosniff through Raw. URL/query cannot select another file. The actual server + Chromium + separate permission-model broker test seals a private canary in browser WebCrypto; a bound synthetic program returns MATCH only when the broker injects that value. Anonymous mesh is401, another broker source path is404. This is module-only synthetic proof; existing app plaintext forms/consumers are unchanged and P1b remains required.
- Final independent proof: bootstrap4/4 (green38); served browser1/1 (green40); actual shared-IPC release fixture, real CLI/Core two restore/restart cycles and initial-handshake closure3/3 (check36). Existing IPC4 and boundary6 passed in green32; boundary6 also passed with served module in green35. These overlapping runs are not summed as unique tests. Compiler39 exited0 through tripwire. Full actual combined-source verification remains pending.
- RED29 correctly hit missing bootstrap/Core integration but its test cleanup scope skipped broker-stop after the first failed assertion, hanging the fixture. Corrected test-only outer finally; stopped only exact owned container `e9c9123d2e69b4cb10bc3c0768e72034ed334751fe2d8d0191c1acfbd32da062` after command/image/workspace-mount verification. [Termination record](evidence/task-6/red-29-owned-container-stop.json); final137. RED30 then produced both intended missing-feature failures and exited naturally before implementation.
- RED31's immediate close test exposed a transient socket-race error, insufficient to prove permanent closure. Strengthened it to allow old socket close to settle, then replayed only the client against exact e4 baseline: RED33 **Missing expected rejection** proved it reconnects. Current source restored in finally; [baseline/restored source hashes](evidence/task-6/red-33-source-context.json). GREEN35/38 preserve strengthened assertion.
- RED34 actual module endpoint returned404 before implementation. A fixture injection-field typo was corrected by source inspection before it was reached (`env`, not `name`). Compiler37 then reported test-only TS2307 (browser URL literal treated as local module) and TS2345 (widened target kind). Fixed with runtime module-path variable and literal target kind, no suppression; compiler39 and actual browser40 pass.
- Warnings: green32 retains four existing Node permission-model SecurityWarnings; green35/40 each retain Node26's stripTypeScriptTypes ExperimentalWarning. No new opt-in skips or hidden warnings. RED29 and RED13 are the only targeted owned-container terminations; no broad process/container cleanup.

## Historical resume boundary at 3e0cfd08 (resolved below)

No qualified-main merge has occurred. Do not claim Task6 complete. Root must send exact qualified main SHA; merge into this branch without rebase, preserving Backend286 required-secret-scan failure503/noattachment and R1 fixture alignment. Then add failing behavior tests and implement metadata-only diagnostics projection; preserve legacy required-secret scanning/scrubbing without broker value reads or matcher exceptions. Finish same-PR plain LEDGER/ROADMAP/inventory partial-scope NOTES and final combined focused regressions/boundary/compiler through tripwire, then update this report. Full branch gate/review remains Task7/root-owned.

Current committed source refuses foreign/unsafe homes before startup; missing device.json with any non-runtime entry, including empty items/, is ambiguous and retained. No broad keychain deletion or stale-PID cleanup. The supervised fake-keychain interruption test proves partial deletion→safe hold→retry with unrelated-account preservation. No independent review or final combined-source qualification has yet occurred.


## Checkpoint 3e0cfd08 release addendum

Commit `3e0cfd08b45171136004aaecd969fd0cf485f5d3` changes exactly: `src/core/broker/client.ts`, `src/core/index.ts`, `src/core/resilience/link.ts`, `src/server.js`, `tests/core/broker-bootstrap.test.ts`, `tests/core/broker-seal-module.test.ts`, and `tests/supervisor/broker-lifecycle.test.ts`. The preceding four checkpoint commits remain listed above; attempts29–40 append to the preserved attempts01–28 and exact-command inventory. Diagnostics and public NOTES files are unchanged. Clean index/worktree verified at release; no additional test runs for this report.

Actual abbreviated excerpts (full output and launcher records linked in the attempt table):

```text
red-30-bootstrap (exit1, natural exit before source implementation):
  + 'undefined'
  - 'function'
  ℹ tests 2 / ℹ pass 0 / ℹ fail 2
red-34-seal-module (exit1, before module implementation):
  404 !== 200
check-37-independent-compiler (exit1, genuine compilation failure):
  error TS2307: Cannot find module '/api/v1/broker/seal.js' or its corresponding type declarations.
  error TS2345: Argument of type '{ kind: string; path: string; sha256: string; }' is not assignable to parameter of type 'Target'.
green-38-bootstrap-final (exit0):
  ℹ tests 4 / ℹ pass 4 / ℹ fail 0
check-39-independent-compiler (exit0):
  no-Kubernetes tripwire: never fired
green-40-served-browser (exit0):
  ✔ person-only served seal module loads in a browser and its envelope is consumed by the real broker
  ℹ tests 1 / ℹ pass 1 / ℹ fail 0
  no-Kubernetes tripwire: never fired
```

Compiler37 is a failed compiler attempt, not an instrumentation problem. Compiler39 is the corrected independent-source check; final merged-source qualification is still outstanding. RELEASE is checkpoint-only, pending root's qualified main SHA; Task6 remains incomplete.


## Qualified-main integration and NOTES mapping

Merged exact qualified main `702ddc4d5ce3ec097f4a4dda7427fb8bc277de25` into `3e0cfd08` with merge commit `c3bc7c49caa682e5dbff50a207ec4c7825529e7f`, never rebased. Its parents are those exact commits. One conflict in `src/core/index.ts` combined the returned broker client with main's Caps on its named `core` object. Main's diagnostics registration, required-secret-scan503/noattachment/no-store and R1 fixture stayed intact. Server/docs auto-merged. No unmerged source was copied. Root supplied CI/merge qualification; this report claims only the local combined checks below.

New diagnostics interface: `brokerMetadata(core)` calls the existing `listRefs()` once and emits only `available`, `exists`, `locked`, `visible_items`, `unlock_mode` (`auto`/`ask`/null), `device_store` (`file`/`keychain`/null), and boolean `problem`. Locked count is null, not a false zero; standalone is unavailable without a problem. Refused/malformed/disconnected responses become unavailable/problem flags, never raw errors. No ref names, IDs, fingerprints, entry key, boot value, role token, arbitrary metadata field or broker value is included. The required legacy scan still finishes before this optional metadata read, and the whole bundle still passes the unchanged matcher. Existing log/problem/config privacy limitations remain; this is not universal privacy proof.

Mapping to `docs/plans/vault-broker-phase1.md` NOTES (the takeover explicitly pulls safety/lifecycle pieces into P1a):

| NOTE | Applied or explicitly conditional |
|---|---|
| 1: supervisor | Applied: trusted fixed release source, before-Core boot, private role context, shared crash/backoff/three-crash safe mode, owned shutdown/reset/release lifecycle. Tokens remain private; no editable/K3s broker service. Rich app Health/credential workflows remain P1b. |
| 2: Core wiring | Private bootstrap/client lifecycle applied. Audit records into Work Ledger/sequence-gap Health, pre-Vault migration approval flow, all consumer replacement and removal of credential fallback/value scrubbing are conditional on actual P1b. Legacy Vault still exists. |
| 3: reset | Applied: authenticated fixed-home predicate, stop/drain, reset-only broker child removes exact device/sign accounts, bound call-scoped attestation, revalidation before deletion; standalone/unknown leftovers refuse. No persistent receipt, caller boolean, key recreation or stale-PID kill. |
| 4: diagnostics | Applied separate broker counts/state projection. Replacing the legacy vault section/removing credential scans is conditional on actual P1b; today required legacy scan and failure503 remain. |
| 5: sealed entry | Applied fixed person-only JS module and real Chromium WebCrypto→separate broker→bound synthetic program proof. Form sealing, envelope-only public mutation routes and plaintext rejection remain P1b. |
| 6: package | No dependency or package changes. |
| 7: schema | No migration/schema or broker DB rows added. |
| 8–10: plain docs | LEDGER, ROADMAP and Secrets inventory updated with branch-only P1a implementation, legacy read path, P1b/P1c/full review/CI pending; no shipped/whole-phase/J claim. |
| 11: old checkpoints | Existing broker exclusions tested. Pre-migration legacy credential copies still retain data (S4); cleanup tied to actual migration stays P1b, not silently marked done. |
| 12: fixed client API | Existing seven verbs and hello/unlock/lock unchanged. No launch ticket, raw getter, migration folder or new public cleanup verb. Boundary tests enforce the methods/imports. |

Additional takeover NOTE: `SECRET_DIRS` and actual git/journal/backup/checkpoint selections tested, with backup carrying broker/items ciphertext only; reset retains foreign entries. Broker size remains2894/3000 (106 remaining), unchanged by independent Core/diagnostics work. Full branch gate/adversarial review remains Task7/root-owned.

Combined45 naturally completed117/119 with two genuine recorded failures: Core API boundary caught two Supervisor deep imports (fixed by reexporting through existing Core index, no exemption); diagnostics-composition expected a build SHA but its worktree gitdir was outside the container mount (null build). The production assertion remains unchanged; isolated Git metadata support is being corrected. All119 cases, including the actual served-browser proof and required-scan failures, remain in raw output; no green aggregate is claimed for45. Combined44 compiler passed; R1 named fixture46 passed1/1; focused corrected import boundaries47 passed2/2. Complete final results follow below.


## Final combined-source verification and release

Final source/NOTES commit **`2827e53ba94c1f6589ddb7bed95ab2e849f1ccd4`**. Full Task6 review range: `6185726bd5066fe1896251eb34d08f4e8598b8ad..2827e53ba94c1f6589ddb7bed95ab2e849f1ccd4`, not HEAD~1; includes qualified Backend286 merge. Final49 passes119/119, fail0/cancel0/skip0 and natural exit; compiler50exit0 through tripwire. R1 named fixture46 passes1/1 with existing token/epoch assertions unchanged. No remaining implementation dependency or failing check; independent review/full branch gate still belongs to Task7.

| New attempt / raw output | Exit | Actual result | Context |
|---|---:|---|---|
| [red-41-broker-diagnostics](evidence/task-6/red-41-broker-diagnostics.stdout) | 137 | incomplete fixture; exact owned-container termination | [launcher](evidence/task-6/red-41-broker-diagnostics.json) |
| [red-42-broker-diagnostics](evidence/task-6/red-42-broker-diagnostics.stdout) | 1 | tests 1, pass 0, fail 1, cancelled 0, skipped 0 | [launcher](evidence/task-6/red-42-broker-diagnostics.json) |
| [green-43-broker-diagnostics](evidence/task-6/green-43-broker-diagnostics.stdout) | 0 | tests 1, pass 1, fail 0, cancelled 0, skipped 0 | [launcher](evidence/task-6/green-43-broker-diagnostics.json) |
| [check-44-combined-compiler](evidence/task-6/check-44-combined-compiler.stdout) | 0 | successful compiler, non-test invocation; tripwire | [launcher](evidence/task-6/check-44-combined-compiler.json) |
| [green-45-combined-focused](evidence/task-6/green-45-combined-focused.stdout) | 1 | tests 119, pass 117, fail 2, cancelled 0, skipped 0 | [launcher](evidence/task-6/green-45-combined-focused.json) |
| [check-46-combined-r1-fixture](evidence/task-6/check-46-combined-r1-fixture.stdout) | 0 | tests 1, pass 1, fail 0, cancelled 0, skipped 0 | [launcher](evidence/task-6/check-46-combined-r1-fixture.json) |
| [check-47-index-boundary](evidence/task-6/check-47-index-boundary.stdout) | 0 | tests 2, pass 2, fail 0, cancelled 0, skipped 0 | [launcher](evidence/task-6/check-47-index-boundary.json) |
| [check-48-diagnostics-git-identity](evidence/task-6/check-48-diagnostics-git-identity.stdout) | 0 | tests 12, pass 12, fail 0, cancelled 0, skipped 0 | [launcher](evidence/task-6/check-48-diagnostics-git-identity.json) |
| [green-49-final-combined](evidence/task-6/green-49-final-combined.stdout) | 0 | tests 119, pass 119, fail 0, cancelled 0, skipped 0 | [launcher](evidence/task-6/green-49-final-combined.json) |
| [check-50-final-compiler](evidence/task-6/check-50-final-compiler.stdout) | 0 | successful compiler, non-test invocation; tripwire | [launcher](evidence/task-6/check-50-final-compiler.json) |

RED41 created broker storage before the fixture marked its home and outside the cleanup try; startup failed and left that owned child. No production code changed for that fixture correction. Only exact container `dee9827eacccde10572ef65181ab45ae471cd0857c088cb77f8400e492be04cd` was stopped after command/image/readonly-workspace-mount verification; final137 ([termination record](evidence/task-6/red-41-owned-container-stop.json)). Docker emitted `Flag --time has been deprecated, use --timeout instead`; retained here. RED42 corrected the fixture and failed the intended missing projection naturally before production implementation; GREEN43 passes. This was the third exact owned-container termination, after RED13/29; no other container/process cleanup.

Combined45 has a green launcher label but **failed117/119**, and remains a failed attempt. Its actual Supervisor import-boundary regression was fixed via existing Core index exports; no exemption was added. Corrected boundaries47 pass2/2. The other failure was missing Git identity in the isolated environment (null build); harness48 fixes only metadata, and diagnostics-composition passes12/12 with the unchanged build assertion and required-scan guards. Final49 reruns the meaningful combined scope after the source correction, not solely for green logs.

Launcher amendment (root Ruling26): [original launcher](evidence/task-6/launcher-before-git-identity.py), [amended launcher](evidence/task-6/launcher.py). Own HEAD's actual commit object is SHA-validated, reconstructed in a private Git directory with empty refs/minimal safe config, validated again by hash-object/rev-parse, and mounted read-only at the worktree pointer target. No shared common-dir/config/history/tree, owner HOME or credentials mounted. Self.build needs rev-parse HEAD only. For48–50, host HEAD and visible identity were historical merge `c3bc7c49`, with exact amended source/test/docs SHA256s recorded contemporaneously in every launcher JSON. **Not final-source commit claims:** [final receipt](evidence/task-6/final-commit-verification.json) confirms each amended file equals the final committed tree. [Earlier manifest](evidence/task-6/combined-source-context.json) describes pre-boundary-correction45 source, not final49. This harness proves identity lookup, not complete checkout/history operations.

Actual abbreviated excerpts:

```text
RED42 (exit1, natural, before implementation):
  + undefined
  - { available: true, device_store: 'file', exists: false, locked: true, problem: false, unlock_mode: null, visible_items: null }
GREEN43 (exit0):
  production diagnostics projects fresh broker counts and states without refs, key material or raw failures
  tests1 / pass1 / fail0
Combined45 (exit1, natural):
  src/supervisor/supervisor.ts → ../core/resilience/home-mark.ts
  src/supervisor/supervisor.ts → ../core/resilience/reset.ts
  The "string" argument must be of type string. Received type object (null)
  tests119 / pass117 / fail2
Final49 (exit0, natural):
  tests119 / pass119 / fail0 / cancelled0 / skipped0
  no-Kubernetes tripwire: never fired
Final50 compiler (exit0):
  no-Kubernetes tripwire: never fired
```

Warnings/limits: final49 retains four existing `--allow-child-process` SecurityWarnings and one `stripTypeScriptTypes` ExperimentalWarning (also in45); compiler50 has none. No warning suppression, new skips or force-exit in combined/successful proofs. All50 attempt records remain. A report-generation script initially selected the termination-provenance JSON as a test record and raised FileNotFoundError for its nonexistent stdout; no report/source/evidence was lost. The formatter now selects actual completed launcher records. This was documentation generation, not a test/instrumentation failure.

Physical Windows/macOS keychain behavior, universal OS containment, escaped descendants and zombie disappearance remain unproven; cleanup means the existing owned-group signal/probe, launcher close and directory cleanup contract. Failed/unknown cleanup retains evidence and holds admission. Core legacy credential plaintext paths remain until P1b; synthetic module canary proof is not whole-product cutover, owner key access, a new app visual pattern or credentialed M10j/M10k proof. Metadata still passes normal matcher rules and may be redacted. Task7 owns full review/gate/publication; this worker did no GitHub write/push/PR/merge, owner preview or other-checkout work.

Exact new commands (attempts01–40 remain above):

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-41-broker-diagnostics sh scripts/tripwire.sh node --test --test-timeout=30000 tests/core/broker-diagnostics.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-42-broker-diagnostics sh scripts/tripwire.sh node --test --test-timeout=30000 tests/core/broker-diagnostics.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-43-broker-diagnostics sh scripts/tripwire.sh node --test --test-timeout=30000 tests/core/broker-diagnostics.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py check-44-combined-compiler sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-45-combined-focused sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 tests/supervisor/broker-lifecycle.test.ts tests/supervisor/guards.test.ts tests/supervisor/releases.test.ts tests/supervisor/checkpoints.test.ts tests/supervisor/rollback-mark.test.ts tests/supervisor/services-contract.test.ts tests/core/broker-bootstrap.test.ts tests/core/broker-reset-lifecycle.test.ts tests/core/broker-reset-keys.test.ts tests/core/broker-exclusions.test.ts tests/core/broker-diagnostics.test.ts tests/core/broker-seal-module.test.ts tests/core/broker-ipc.test.ts tests/core/broker-boundary.test.ts tests/core/reset.test.ts tests/core/reset-export.test.ts tests/core/reset-mesh.test.ts tests/core/diagnostics.test.ts tests/core/diagnostics-composition.test.ts tests/core/caps-composition.test.ts tests/core/api.test.ts tests/core/roles-bound-work.test.ts tests/core/topology-api.test.ts tests/core/topology-actions.test.ts tests/core/resilience-trust.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py check-46-combined-r1-fixture sh scripts/tripwire.sh node --test '--test-name-pattern=minor: the name token' --test-timeout=30000 tests/acceptance/m10g-review2.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py check-47-index-boundary sh scripts/tripwire.sh node --test '--test-name-pattern=module boundary|core reaches' tests/core/api.test.ts tests/core/broker-boundary.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py check-48-diagnostics-git-identity sh scripts/tripwire.sh node --test --test-timeout=30000 tests/core/diagnostics-composition.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-49-final-combined sh scripts/tripwire.sh node --test --test-concurrency=1 --test-timeout=120000 tests/supervisor/broker-lifecycle.test.ts tests/supervisor/guards.test.ts tests/supervisor/releases.test.ts tests/supervisor/checkpoints.test.ts tests/supervisor/rollback-mark.test.ts tests/supervisor/services-contract.test.ts tests/core/broker-bootstrap.test.ts tests/core/broker-reset-lifecycle.test.ts tests/core/broker-reset-keys.test.ts tests/core/broker-exclusions.test.ts tests/core/broker-diagnostics.test.ts tests/core/broker-seal-module.test.ts tests/core/broker-ipc.test.ts tests/core/broker-boundary.test.ts tests/core/reset.test.ts tests/core/reset-export.test.ts tests/core/reset-mesh.test.ts tests/core/diagnostics.test.ts tests/core/diagnostics-composition.test.ts tests/core/caps-composition.test.ts tests/core/api.test.ts tests/core/roles-bound-work.test.ts tests/core/topology-api.test.ts tests/core/topology-actions.test.ts tests/core/resilience-trust.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py check-50-final-compiler sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json
```

Task6 own commits and exact changed files (qualified-main merge described separately):

| Commit | Files |
|---|---|
| `87705ac84e0ce920267a8c16fce4bc278318e28c` | `src/broker/keystore.ts`, `src/broker/main.ts`, `src/broker/spawn.ts`, `src/core/resilience/reset.ts`, `src/core/services/definition.ts`, `src/supervisor/supervisor.ts`, `tests/core/broker-boundary.test.ts`, `tests/core/broker-exclusions.test.ts`, `tests/core/broker-reset-keys.test.ts`, `tests/core/broker-reset-lifecycle.test.ts`, `tests/supervisor/broker-lifecycle.test.ts` |
| `034930766dd0ad02f29d6c3bc0194b4ddfeb14e0` | `tests/supervisor/broker-lifecycle.test.ts` |
| `51167f1a31e9ff1639fea760492164dc217c1961` | `src/broker/keystore.ts`, `tests/core/broker-reset-keys.test.ts` |
| `e4f6051de503154dea780fe9766cef17af17903a` | `src/supervisor/supervisor.ts`, `tests/supervisor/broker-lifecycle.test.ts` |
| `3e0cfd08b45171136004aaecd969fd0cf485f5d3` | `src/core/broker/client.ts`, `src/core/index.ts`, `src/core/resilience/link.ts`, `src/server.js`, `tests/core/broker-bootstrap.test.ts`, `tests/core/broker-seal-module.test.ts`, `tests/supervisor/broker-lifecycle.test.ts` |
| `2827e53ba94c1f6589ddb7bed95ab2e849f1ccd4` | `docs/LEDGER.md`, `docs/builder-packet/CAPABILITY-INVENTORY.md`, `docs/builder-packet/ROADMAP-AND-GATES.md`, `src/core/diagnostics/index.ts`, `src/core/index.ts`, `src/supervisor/supervisor.ts`, `tests/core/broker-diagnostics.test.ts` |

RELEASE — Task6 implementation complete; clean final source and private evidence handed to root for independent review.


## Task6 fix round1 — I1/I2 consolidated response

Fix base `2827e53ba94c1f6589ddb7bed95ab2e849f1ccd4` → **`44a8deb563324ac2847c02dc82dfc6e3aec32d85`**; clean commit `Join supervisor startup and shutdown ownership across rollback`. Requested re-review scope is this range, I1/I2 and new breakage only. Original full Task6 review remains618..2827. No fresh broad review, worker, GitHub operation, preview, owner data/keychain, cloud/model/device, image pull, broad PID/container kill or other-checkout mutation.


**Review response and implementation.** Read the full fix brief/review and executed review51 probe/output. I1 was dynamically reproduced by reviewer51; I2 was static review only until this worker's RED52. Promoted rollback's actual cleanup-rejection probe into the regression suite before source changes. Shared startup admission now refuses retained broker/Core ownership or an in-progress stop, and replacement entry points refuse concurrent startup. The rollback fallback consequently stays held instead of overwriting a failed broker and reporting running. A positive control verifies that failed release Core startup with confirmed broker cleanup still rolls back to the previous release.

For I2, Supervisor tracks run, start and stop operations, and every close caller shares one physical completion/failure promise. Close immediately stops service admission, joins pending run/start (including reset-only cleaner), then joins pair cleanup before dropping PID/control evidence. Failed late cleanup reaches all close callers, holds safe mode and keeps supervisor.pid; startup cannot silently route the failure through a closed crash callback. A late ready broker is retained for close to drain. Run checks closure after awaited startup and before its timer/service resume, reset checks closure before directory deletion, crash continuation cannot arm a late restart, and late Core ready cannot report running. Startup/stop joins do not await close, avoiding a lifecycle await cycle. An unrelated run preflight refusal is joined but is not misclassified as owned cleanup failure; actual child startup failure remains separately joined. Broker start now rejects failed readiness only after the actual child close event; a timeout is not physical completion. A nonsettling child can therefore keep close pending, as required, rather than yield a false stopped success.

**Deterministic proofs.** Tests instrument only disposable copied releases: actual child writes its PID immediately before ready and waits on a private file barrier. Replacement startup, initial run, reset cleaner and controlled late cleanup failure each prove both close calls remain pending and supervisor.pid remains while that PID is alive. Releasing the barrier proves joined exit, no new Core/service resume/health interval, control socket release, and identical late failure. Reset leaves its authenticated marker rather than continuing deletion/boot after close. A separate actual Core SIGTERM barrier reproduces and fixes close racing an already-running replacement stop. A helper probe sends failed readiness while its actual child remains held alive, proving even the failure path remains joined.

**Failures retained.** RED52 is5/5 intended failures with unchanged2827 production. GREEN53 passes5/5 after the initial fix. RED54 replays only exact2827 spawn.ts against the strengthened failed-readiness probe; it demonstrates early rejection while the child lives. The amended file was restored in finally; [source hashes](evidence/task-6/red-54-source-context.json). This replay was after the first fix, not claimed as initial preimplementation evidence. Check55 passes the clean-fallback/readiness controls but exposes my introduced close propagation of a foreign-home preflight rejection; fixed without changing the original home guard/assertion. RED56 proves the existing close-during-stop ownership hole; the shared stop join fixes it. GREEN57 passes all9 selected controls. Compiler59 has a genuine TS2339 test typing error (`again.error` inferred on a result union); corrected by one explicit optional-error result type, no suppression ([exact one-line diff](evidence/task-6/check-59-typing-correction.diff)). No runtime production edits followed focused58.

| Attempt / raw | Exit | Actual result | Context |
|---|---:|---|---|
| [red-52-review-lifecycle](evidence/task-6/red-52-review-lifecycle.stdout) | 1 | tests 5, pass 0, fail 5, cancelled 0, skipped 0 | [launcher](evidence/task-6/red-52-review-lifecycle.json) |
| [green-53-review-lifecycle](evidence/task-6/green-53-review-lifecycle.stdout) | 0 | tests 5, pass 5, fail 0, cancelled 0, skipped 0 | [launcher](evidence/task-6/green-53-review-lifecycle.json) |
| [red-54-readiness-failure](evidence/task-6/red-54-readiness-failure.stdout) | 1 | tests 1, pass 0, fail 1, cancelled 0, skipped 0 | [launcher](evidence/task-6/red-54-readiness-failure.json) |
| [check-55-lifecycle-controls](evidence/task-6/check-55-lifecycle-controls.stdout) | 1 | tests 3, pass 2, fail 1, cancelled 0, skipped 0 | [launcher](evidence/task-6/check-55-lifecycle-controls.json) |
| [red-56-close-during-stop](evidence/task-6/red-56-close-during-stop.stdout) | 1 | tests 1, pass 0, fail 1, cancelled 0, skipped 0 | [launcher](evidence/task-6/red-56-close-during-stop.json) |
| [green-57-review-controls](evidence/task-6/green-57-review-controls.stdout) | 0 | tests 9, pass 9, fail 0, cancelled 0, skipped 0 | [launcher](evidence/task-6/green-57-review-controls.json) |
| [green-58-fix-focused](evidence/task-6/green-58-fix-focused.stdout) | 0 | tests 77, pass 77, fail 0, cancelled 0, skipped 0 | [launcher](evidence/task-6/green-58-fix-focused.json) |
| [check-59-fix-compiler](evidence/task-6/check-59-fix-compiler.stdout) | 1 | failed compiler TS2339; tripwire | [launcher](evidence/task-6/check-59-fix-compiler.json) |
| [check-60-fix-final-compiler](evidence/task-6/check-60-fix-final-compiler.stdout) | 0 | successful compiler; tripwire | [launcher](evidence/task-6/check-60-fix-final-compiler.json) |
| [green-61-fix-final-controls](evidence/task-6/green-61-fix-final-controls.stdout) | 0 | tests 9, pass 9, fail 0, cancelled 0, skipped 0 | [launcher](evidence/task-6/green-61-fix-final-controls.json) |

Actual abbreviated RED/GREEN excerpts:

```text
RED52:
  rollback must not start Core after unconfirmed cleanup
  actual: { settled: true, secondSettled: true, pidFile: false }
  expected: { settled: false, secondSettled: false, pidFile: true }
  tests5 / pass0 / fail5
RED54:
  a failed ready message must not detach the child lifetime
  true !== false
RED56:
  close must join the stop that already owns this live Core
  true !== false
Compiler59:
  error TS2339: Property 'error' does not exist on type '{ ok: boolean; } | { ok: boolean; error: Error; }'.
GREEN58:
  tests77 / pass77 / fail0 / cancelled0 / skipped0
  lifecycle egress guard: never fired
  no-Kubernetes tripwire: never fired
Final60 compiler: exit0 / no-Kubernetes tripwire: never fired
Final61: tests9 / pass9 / fail0 / cancelled0 / skipped0
```

Focused58 covers all amended Supervisor lifecycle tests plus guards, release transitions, checkpoints, rollback marks, service contracts, private Core bootstrap, broker reset keys/lifecycle, IPC, boundaries and ordinary reset. Final61 reruns only the9 affected controls after the test-only annotation; compiler60 checks the final source. Counts overlap and are not added. No unchanged Diagnostics/Caps/UI/full119 rerun. Those preserved features still have historical combined49 evidence; this fix changes none of their source/tests. Full branch qualification remains Task7.

Warnings and isolation:58 retains four existing Node `--allow-child-process` SecurityWarnings, no suppression. No new warnings in60/61, no skips, cancellations, force-exit, deadline increases or owned-container terminations in this fix wave. Earlier terminations13/29/41 remain historical. Each new attempt uses the amended cached --pull=never/networknone/uid1000/read-only source+Node26/private HOME/own Git-identity launcher and Kubernetes tripwire; runtime attempts preload the egress guard, and54 onward explicitly assert its log empty. Host HEAD/visible commit were2827 during these dirty-source checks, not the amended final commit; exact changed hashes are in each record. [Final source receipt](evidence/task-6/fix1-final-source-context.json) verifies changed paths exactly equal this commit's3 files, final60/61 hashes match all3, and58 production hashes match. The only58→final test difference is the recorded annotation. Budget2896/3000,104 remaining; no privileged relocation, dependency, protocol, raw-value access, import exception, production test hook or reset/keychain policy change.

Exact fix commands:

```sh
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-52-review-lifecycle sh scripts/tripwire.sh env NOVA_EGRESS_LOG=/tmp/task6-fix-egress.log node --import ./tests/acceptance/egress-guard.ts --test --test-concurrency=1 --test-timeout=30000 '--test-name-pattern=rollback retains|close joins' tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-53-review-lifecycle sh scripts/tripwire.sh env NOVA_EGRESS_LOG=/tmp/task6-fix-egress.log node --import ./tests/acceptance/egress-guard.ts --test --test-concurrency=1 --test-timeout=30000 '--test-name-pattern=rollback retains|close joins' tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-54-readiness-failure sh scripts/tripwire.sh env NOVA_EGRESS_LOG=/tmp/task6-fix-egress.log node --import ./tests/acceptance/egress-guard.ts --test '--test-name-pattern=failed broker readiness' tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py check-55-lifecycle-controls sh scripts/tripwire.sh env NOVA_EGRESS_LOG=/tmp/task6-fix-egress.log node --import ./tests/acceptance/egress-guard.ts --test --test-concurrency=1 --test-timeout=30000 '--test-name-pattern=failed release Core|failed broker readiness|refuses a foreign' tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py red-56-close-during-stop sh scripts/tripwire.sh env NOVA_EGRESS_LOG=/tmp/task6-fix-egress.log node --import ./tests/acceptance/egress-guard.ts --test '--test-name-pattern=close joins a replacement stop' tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-57-review-controls sh scripts/tripwire.sh env NOVA_EGRESS_LOG=/tmp/task6-fix-egress.log node --import ./tests/acceptance/egress-guard.ts --test --test-concurrency=1 --test-timeout=30000 '--test-name-pattern=rollback retains|close joins|failed release Core|failed broker readiness|refuses a foreign' tests/supervisor/broker-lifecycle.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-58-fix-focused sh scripts/tripwire.sh env NOVA_EGRESS_LOG=/tmp/task6-fix-egress.log node --import ./tests/acceptance/egress-guard.ts --test --test-concurrency=1 --test-timeout=120000 tests/supervisor/broker-lifecycle.test.ts tests/supervisor/guards.test.ts tests/supervisor/releases.test.ts tests/supervisor/checkpoints.test.ts tests/supervisor/rollback-mark.test.ts tests/supervisor/services-contract.test.ts tests/core/broker-bootstrap.test.ts tests/core/broker-reset-lifecycle.test.ts tests/core/broker-reset-keys.test.ts tests/core/broker-ipc.test.ts tests/core/broker-boundary.test.ts tests/core/reset.test.ts
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py check-59-fix-compiler sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py check-60-fix-final-compiler sh scripts/tripwire.sh node node_modules/typescript/bin/tsc -p tsconfig.json
python3 .superpowers/sdd/vault-owner-findings-b-2026-11-03/evidence/task-6/launcher.py green-61-fix-final-controls sh scripts/tripwire.sh env NOVA_EGRESS_LOG=/tmp/task6-fix-egress.log node --import ./tests/acceptance/egress-guard.ts --test --test-concurrency=1 --test-timeout=30000 '--test-name-pattern=rollback retains|close joins|failed release Core|failed broker readiness|refuses a foreign' tests/supervisor/broker-lifecycle.test.ts
```

Changed files: `src/broker/spawn.ts`, `src/supervisor/supervisor.ts`, `tests/supervisor/broker-lifecycle.test.ts`.

RELEASE — consolidated fix round1 complete and clean; return to the same reviewer for scoped I1/I2/new-breakage review. No review approval or Task7 completion is claimed.
