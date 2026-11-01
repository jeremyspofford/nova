# Independent capture final re-review

Final pinned combined implementation: **`54be3d7c1c467ceb180e66eea65a96b1d349513c`**.
Fresh detached review worktree: `/tmp/nova-m10h-capture-final-54be3d7c`.

**No remaining actionable findings in the reviewed capture fix diff.** The original capture review's three defects and the independent re-review's additional per-batch privacy defect now have passing live reproductions on this exact snapshot. Implementation files were not changed; review artifacts are untracked and task-owned.

## Source review

Inspected the capture production diff from original `acbda56b7f4ff83f4d5e54218b98e55d58523258`, including `src/core/capture/sync.ts`, `src/device/carrier.ts`, `src/core/mesh/sync.ts`, and `src/core/migrations/0023_native_workloads.sql`, then inspected follow-up carrier changes through the final combined commit. Reviewed the relevant capture consent and replica/checkpoint cleanup integration.

Verified final capture sources match implementer commit `4aef4b2d4b63541aa0cba1514e820dd904518439` with an empty path-scoped diff. Verified workload production sources still match independently reviewed `1505ab9631e14ef1dcb90e0b5d24d46113a6e112` with an empty diff; their prior independent53/53 regression result remains applicable to unchanged sources.

## Independent live proofs

All four commands below exited0 under Linux Node26.3.1, using synthetic enrolled keys/captures, disposable homes and loopback only:

```sh
cd /tmp/nova-m10h-capture-final-54be3d7c
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node capture-independent-probe.ts
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node carrier-independent-probe.ts
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node capture-plan-failure-probe.ts
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node capture-batch-policy-probe.ts
```

`capture-independent-probe.ts` adapts the original reviewer's real hub/replica/checkpoint reproduction to assert corrected behavior:

- Home→cloud after a pending raw request: plan `raw_allowed=false`, pending list empty, correctly signed upload409, no stored raw bytes. Returning home allows the positive-control upload.
- Real SyncLog batches replicate one `capture_raw_fetch` mapping. Replica checkpoint contains raw before the forget. Forget at the hub and apply its replication: live replica raw absent, checkpoint raw absent, retained raw bytes absent.

Output: `/tmp/nova-m10h-capture-final-independent.log`.

`carrier-independent-probe.ts` adapts the original carrier reproduction:

- Transient deletion503 for an off-kind item records a deletion error. Retry succeeds; store item gone, queue empty and error cleared after reconstruction.
- Tombstone DELETE failure and lost acknowledgement remain retriable; final `pendingTombstone=false`, `ackCalls=2`, store empty.

Output: `/tmp/nova-m10h-carrier-final-independent.log`.

`capture-plan-failure-probe.ts` independently exercises six raw-policy boundaries:

- Before raw read and before raw upload, inject each of a503 plan response, thrown network failure, and explicit loss of raw consent.
- All six send zero raw uploads. Before-read failures perform zero frame reads; before-upload failures read one synthetic frame and withhold it.

Output: `/tmp/nova-m10h-capture-final-plan-failure.log`.

`capture-batch-policy-probe.ts` independently exercises the additional defect caught in re-review:

- Queue101 real event files. First batch acknowledges100 then either denies the next plan or makes the next plan unavailable.
- Both cases stop at `posted=1`, `queued=1`; paused status is nonempty and reported to the hub.
- Restore permission: remaining item sends once, queue becomes0, exactly101 unique event IDs were sent in two total batch POSTs, without duplication.

Output: `/tmp/nova-m10h-capture-final-batch-policy.log`.

The corresponding RED reproduction, which sent both batches under stale permission, remains at `/tmp/nova-m10h-capture-rereview-b7feb7eb/capture-batch-policy-probe.ts`, captured in `/tmp/nova-m10h-capture-batch-policy.log`. It is historical evidence for the resolved finding, not a remaining blocker.

## Focused regression suite

**39 passed,0 failed,0 skipped**,33.28 seconds, on the final exact pin:

```sh
PATH=/home/jeremy/.local/share/mise/installs/node/26.3.1/bin:$PATH node --test --test-concurrency=1 --test-timeout=120000 tests/core/capture-privacy-regressions.test.ts tests/core/capture-sync.test.ts tests/core/capture-carrier.test.ts tests/core/mesh-sync.test.ts tests/core/backups.test.ts
```

Output: `/tmp/nova-m10h-capture-final-tests.log`.

This includes current pause/disable consent, cloud local-only/local-preferred transitions, raw delivery, deletion retries across inactive/off reconstruction, replica recovery-copy deletion, derived sync failures between batches, ordinary capture queue behavior, mesh replication/failover and backup forgetting.

## Limits

This is a scoped review and Linux stand-in proof. No real Screenpipe or device, publisher signature, OS capture permissions, real macOS/Windows semantics, cloud archive, preview, external target or full suite was exercised. There is no claim of real Screenpipe API compatibility. Policy checks occur at network operation boundaries; data already sent before a policy change cannot be recalled from the wire. No merge, push or implementation mutation was performed by this reviewer.
