# M10h workload review fixes

Local revision reviewed: `acbda56b7f4ff83f4d5e54218b98e55d58523258`.
Fix branch: `codex/m10h-workload-review-fixes`.

All programs and devices here are synthetic stand-ins. Tests use temporary homes and loopback only.
No real Screenpipe, workload, device, cloud resource, or external network is exercised. Linux process
behavior is tested locally; real-device and macOS/Windows behavior remain **UNPROVEN**. Descendants
that deliberately leave the owned process group remain outside this fix's guarantee.

Changes:
- End the owned process group with SIGKILL when its leader exits, before watchdog restart or child
  removal. Intentional stop still sends SIGTERM first; remaining descendants cannot outlive the leader.
- Fetch workload health with redirects disabled, so a 302 cannot use another listener as its health.
- Refuse nonempty remote `contract_tests` explicitly before assignment; remote contract execution is
  unsupported and must not be silently omitted.
- Install through a unique task-owned `.install-*` directory outside `v/`; cleanup removes only that
  staging directory. Installing `1` preserves a valid live `1.next` slot.
- Keep a workload's watchdog safe mode held across repeated start/switch requests. Rollout probes the
  held live instance as failed health, retaining consecutive-check rollback. Explicit authorized
  stop/start recovers; deploying a different version uses that version's own watchdog. Same-version
  reassignment alone does not reset safe mode.

## RED → GREEN

Node: local Node 26.3.1. Dependencies installed from cache with
`npm ci --offline --ignore-scripts --no-audit --no-fund`; no network download.

Before changes, the existing workload suites passed **19/19**:

```sh
sh scripts/test.sh 'tests/core/workloads-device.test.ts' 'tests/core/workloads-hub.test.ts' 'tests/core/workloads-rollout.test.ts'
```

New regressions, before production edits:

```sh
sh scripts/test.sh 'tests/core/workloads-review.test.ts' 'tests/core/workloads-hub.test.ts'
```

Result: **4 passed, 7 failed**, with the expected failures:
- Three owned-group cases (`stop`, role `recheck`, `close`): descendants still alive after leader exit.
- Redirect: workload health incorrectly returned true via an unrelated loopback listener.
- Slot namespace: installing `1` removed live `1.next`'s manifest.
- Contract tests: deployment succeeded instead of refusing unsupported remote tests.
- Crash safe mode: unchanged heartbeat assignment increased starts from 3 to 4.

Same focused command after minimal fixes: **11/11 passed**. The crash test additionally covers
repeated direct start/switch requests and explicit stop/start recovery.

Broader workload/device validation:

```sh
sh scripts/test.sh 'tests/core/workloads-*.test.ts' 'tests/core/device-agent.test.ts' 'tests/core/device-sandbox.test.ts'
npm run typecheck
```

Result: **44/44 passed**; typecheck passed. No-Kubernetes tripwire armed and never fired.
