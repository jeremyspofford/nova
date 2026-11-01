# Independent workload fix re-review

Final pinned SHA: `1505ab9631e14ef1dcb90e0b5d24d46113a6e112`.
Detached review worktree: `/tmp/nova-m10h-workloads-rereview-1505ab96`.
Inspected production diff from original reviewed `acbda56b7f4ff83f4d5e54218b98e55d58523258`, specifically `src/device/workloads.ts`, `src/device/rollout.ts`, `src/core/services/workloads.ts`. Implementation untouched; only task-owned untracked probes/report added.

No additional actionable findings in this workload diff. All five original reproductions now assert the intended corrected behavior and pass:

1. Signed leader spawns an ordinary child, then exits. Descendant is terminated after leader exit and remains stopped through role removal and close. Process liveness excludes Linux zombie status, since a killed orphan can remain unreaped by container PID1.
2. Signed workload redirects its health endpoint to an unrelated loopback listener. Probe fails with HTTP302, unrelated listener receives zero requests.
3. Real hub deploy route rejects definition with a nonempty contract test list, HTTP409 with explicit unsupported-contract explanation; heartbeat assignment list stays empty. This is the safe refusal alternative, not remote contract execution.
4. Install/switch live version `1.next`, then install `1`. Both slots remain, the live manifest still exists, and `1.next` can stop/start again.
5. Immediate-crash signed program reaches three starts and safe mode. An unchanged live assignment leaves it at three starts and reports health false with safe-mode reason.

Exact independent probe commands (cwd the detached review worktree):

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node review-workloads-probes.ts
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node review-contract-probe.ts
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node review-slot-probe.ts
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node review-safe-mode-probe.ts
```

Captured output:

- `/tmp/nova-m10h-rereview-process-health.log`
- `/tmp/nova-m10h-rereview-contract.log`
- `/tmp/nova-m10h-rereview-slot.log`
- `/tmp/nova-m10h-rereview-safe-mode.log`

Expanded existing/regression suite: **53 passed, 0 failed, 0 skipped**, 15.70 seconds. Exact command:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node --test --test-concurrency=1 --test-timeout=120000 tests/core/workloads-review.test.ts tests/core/workloads-device.test.ts tests/core/workloads-hub.test.ts tests/core/workloads-rollout.test.ts tests/core/device-sandbox.test.ts tests/core/services-manager.test.ts tests/core/services-definition.test.ts tests/core/services-placement.test.ts
```

Output: `/tmp/nova-m10h-rereview-tests.log`.

The implemented safe-mode recovery requires an explicit stop/start; same-version `assigned_at` changes alone preserve the hold. Existing regression test also exercises repeated direct start/switch without bypassing the hold. New-version workloads retain independent watchdog budgets. Process-group cleanup runs before the watchdog exit handler and therefore before restart scheduling. Staging lives in unique `.install-*` siblings outside valid version slots and is cleaned in `finally`.

Limits: Linux Node26.3.1, synthetic signed workloads, disposable homes and loopback only. No real devices/Screenpipe, publisher-code signatures, OS capture permissions, real macOS/Windows process behavior, external services, preview, cloud/network resources or full test suite. Capture fixes require their own independent re-review.
