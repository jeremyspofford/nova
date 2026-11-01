# Independent native workload review

Pinned source: `acbda56b7f4ff83f4d5e54218b98e55d58523258`, compared with base `31846fac`.
Worktree: `/tmp/nova-m10h-workloads-review-acbda56`.
Binding material read: `docs/plans/M10-orchestration.md`, especially Point 6 / Decisions 1 and 4, and `docs/builder-packet/INPUT-2026-10-31-ORCHESTRATION-DECISIONS.md`.
No implementation changed. No PR claims, historical review or gate evidence used. All probes use disposable homes, synthetic signed Node programs and loopback listeners. Probe-created processes are stopped explicitly using their own known process IDs/groups.

## Findings

### P1: A crashed workload's descendants survive stop, role removal and shutdown

Location: `src/device/workloads.ts:370` (new workload watchdog integration), `src/device/workloads.ts:496`; underlying watchdog behavior `src/device/watchdog.ts:76`.

The workload wrapper signals a process group only when `ChildLike.kill()` is called. The watchdog clears `child` as soon as its leader exits. It neither terminates that leader's remaining process group nor retains the group for later termination. A subsequent stop sees no child and returns without signaling anything.

Reproduction: a signed program starts one non-detached Node descendant, records both IDs and exits. After the leader exits during watchdog backoff, remove the required role and call `recheck()`. Observed: `stopped=["stand-in 1.0.0"]`, reported `running=[]`, but the descendant is still alive. It also survives `close()`. A real native capture or worker descendant could continue capturing or holding the stable port after Nova reports it stopped; watchdog restarts can accumulate such descendants. Expected: all processes in the workload's group end before restart and on every stop/revocation/shutdown.

Exact reproduction, from the pinned worktree:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node review-workloads-probes.ts
```

Artifact: `review-workloads-probes.ts`, first half. Captured output: `/tmp/nova-m10h-workloads-probes.log`.

### P2: Health probes follow redirects beyond the assigned workload origin

Location: `src/device/workloads.ts:425`.

The health verb uses `fetch()` with the default redirect policy. A signed workload returning HTTP 302 to another service causes the boot agent to fetch that target and accept its HTTP 200 as the workload's own successful health check. This also permits a redirect outside loopback; the probe intentionally uses a second loopback listener only.

Observed: unrelated loopback listener receives `/unrelated`; the workload health verb returns `ok=true`. Expected: the fixed health verb remains confined to its signed workload's exact loopback origin and refuses redirected health rather than using another service as proof.

Exact reproduction is the same command above; second half of `review-workloads-probes.ts`. Captured output: `/tmp/nova-m10h-workloads-probes.log` (`probe="health-redirect"`, `redirected=1`).

### P2: Device deployment discards declared contract tests and still permits promotion

Location: `src/core/services/workloads.ts:217` (signed manifest construction), `src/device/rollout.ts:153` (readiness).

The native driver accepts a definition containing `contract_tests`, but does not put those tests in the manifest, expose a verb to run them, or reject them. The device marks the version ready using only health. The manager then accepts readiness as proof that tests passed.

Reproduction uses real hub deploy/heartbeat/promote routes and an in-process real Workloads/Rollout pair. The signed stand-in returns `/health` 200 and `/contract-fails` 500. Its definition declares `contract_tests=["http:/contract-fails"]`, `alongside="full"`. Observed: manifest has no contracts; device reports `ready`, health true; typed promotion returns HTTP 200, tier 2, despite demonstrated contract HTTP 500. Expected: failing declared contracts block readiness/promotion, or unsupported contracts are explicitly rejected before deployment.

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node review-contract-probe.ts
```

Artifact: `review-contract-probe.ts`. Output: `/tmp/nova-m10h-contract-probe.log`.

### P2: Installing a version deletes an existing live version whose name matches its staging directory

Location: `src/device/workloads.ts:314`–`317`.

Valid version names include `1` and `1.next`. Installing `1` chooses `v/1.next` as staging and recursively removes it before downloading, even if `1.next` is live or kept for rollback.

Reproduction installs and switches live `1.next`, then installs `1`. Observed: install succeeds, state still says live `1.next`, but installed versions contain only `1` and live slot `v/1.next/manifest.json` is gone. Stopping then starting the live version is refused as not installed. Expected: staging paths cannot alias any valid version slot, and an unrelated install preserves live and rollback slots.

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node review-slot-probe.ts
```

Artifact: `review-slot-probe.ts`. Output: `/tmp/nova-m10h-slot-probe.log`.

### P2: An unchanged live assignment automatically resets workload safe mode

Location: `src/device/rollout.ts:186`–`188`; `src/device/workloads.ts:338`–`339` and `370`.

After three crashes, the workload's watchdog reports safe mode through `Instance.failed`. The next runtime pass regards that failed live instance as simply not running, calls `start`, destroys the failed instance and creates a fresh watchdog with empty crash history. The unchanged live assignment repeats this indefinitely; there is no recovery action or new assignment.

Reproduction starts a signed immediate-crash program and waits for exactly three starts plus safe mode, then gives Rollout one unchanged live assignment with no previous version. Observed: six starts and safe mode again. Expected: the failed version remains held after exhausting its crash budget until recovery or a new authorized assignment; periodic reconciliation must not silently clear safe mode. Initial promotion failure/rollback is a separate path; this affects previously live programs.

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node review-safe-mode-probe.ts
```

Artifact: `review-safe-mode-probe.ts`. Output: `/tmp/nova-m10h-safe-mode-probe.log`.

## Passing coverage and limits

Focused existing tests: 46 passed, 0 failed, 0 skipped. Exact command:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node --test --test-concurrency=1 --test-timeout=120000 tests/core/workloads-device.test.ts tests/core/workloads-hub.test.ts tests/core/workloads-rollout.test.ts tests/core/device-sandbox.test.ts tests/core/services-manager.test.ts tests/core/services-definition.test.ts tests/core/services-placement.test.ts
```

Output: `/tmp/nova-m10h-workloads-existing-tests.log` (12.27 seconds).

Covered normal signed install/start/switch/stop, health, alongside/shadow, offline rollback, typed approval, role checks, tampering/wrong signature/wrong hash, extra IPC fields, unassigned versions, cross-device artifact access, native placement constraints and runtime filesystem/network/process restrictions.

This was a Linux Node 26.3.1 review, using stand-ins; no real OS capture permissions, publisher signatures, macOS/Windows process semantics, real devices or workloads, external services, preview, full suite, or cloud/network resources were exercised. No independent finding from trust/placement/manager beyond the integration defects above. Broader capture data/channel review belongs to the sibling reviewer.
