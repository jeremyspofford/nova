# Independent capture path review

Snapshot: `acbda56b7f4ff83f4d5e54218b98e55d58523258`; base `31846fac2fa44b34dca4a2d29575394369e14274`.

Isolated native worktree: `/tmp/nova-m10h-capture-review-acbda56`.

Scope: capture carrier, hub ingestion/raw lifecycle, migration 0023, replication, capture deletion and recovery cleanup. Binding requirements read from the capture data path design and M10 orchestration ADR. No PR claims, historical reviews or evidence were used. No implementation files were changed. All data, enrolled identities, device keys, homes and HTTP listeners in probes are synthetic and task-owned; listeners use dynamically assigned loopback ports.

## Findings

### [P1] Recheck cloud policy when serving and accepting pending raw requests

Location: `src/core/capture/sync.ts:256-275`; related `src/device/carrier.ts:343-360`.

`requestRaw()` checks `site()` only at request creation (`sync.ts:239`). If a pending request survives a change to cloud placement, `rawFor()` still exposes it and `rawUpload()` still writes its bytes without checking current cloud policy or privacy. The carrier's raw stage also ignores the current plan's `sync.allowed` value. The approved design requires per-device raw opt-in for a cloud hub; this build refuses new requests there because that opt-in does not exist.

Live scenario: enroll a synthetic capture source; enable screen; ingest a signed event; request its raw while site is home and privacy is local-only; set the supplied live site callback to cloud; fetch the plan and pending raw list; upload the correctly signed synthetic raw item.

Expected: pending raw is withheld/refused after the change, with no raw bytes stored at the cloud hub.

Observed: plan says `sync.allowed=false`, `raw=1`; raw list still contains the request; upload returns HTTP 200; original bytes are returned by `/capture/raw/{id}`.

Validation: `capture-review-probe.ts`, first JSON output line (`pending-raw-home-to-cloud`).

### [P1] Replicate the raw-to-event mapping needed for recovery-copy deletion

Location: `src/core/mesh/sync.ts:29-31`; `src/core/migrations/0023_native_workloads.sql:96-112`; cleanup dependency `src/core/backups.ts:91-96`.

`capture/raw/<fetchId>` is included in ordinary home file replication, but `capture_raw_fetch` is excluded from replicated tables/triggers. A replica can therefore back up/checkpoint the raw bytes without the mapping that `cleanDbFile()` requires to identify those bytes when their event is forgotten. Its live file eventually receives `file_delete`, but its recovery copies retain the forgotten original. The same missing row also prevents reading the fetched original after replica promotion despite its file being present.

Live scenario: complete one synthetic raw fetch; apply the real source `SyncLog.batch()` to a second fresh core using the real `SyncLog.apply()`; take a named checkpoint on that replica; forget the event at the hub; replicate the deletes.

Expected: recovery copies on the replica delete the event's fetched original along with its event.

Observed: replica has zero `capture_raw_fetch` rows while its checkpoint contains the raw file; after forgetting, the live replica file is gone but the checkpoint file remains byte-for-byte identical to the forgotten original.

Validation: `capture-review-probe.ts`, second JSON output line (`replica-recovery-forgotten-raw`): `replicaRawRowsBeforeForget=0`, `liveReplicaFileAfterForget=false`, `checkpointFileAfterForget=true`, `checkpointBytesRemain=true`.

### [P1] Retry a failed deletion of data captured while its source was off

Location: `src/device/carrier.ts:207-209,227-228`.

The carrier marks off-kind/pre-consent items as seen before attempting their deletion, persists the seen set, and ignores `#delete()` returning false. A transient local deletion failure permanently suppresses later deletion attempts while the item remains in the workload's derived/raw store. This is especially relevant when screen is enabled and the workload also reports audio while audio consent remains off.

Live scenario: a synthetic loopback capture API reports one audio item, while only screen is enabled. Its first `POST /__delete` returns 503; it becomes healthy for the next tick. Tick twice, then reconstruct the carrier from the same synthetic home and tick again.

Expected: deletion is retried after recovery/restart, or a persistent pending deletion/error is reported.

Observed: total delete calls remains 1; item remains in the capture store; queue is empty; `last_error` is null. The persisted seen ID prevents retries both before and after reconstruction.

Validation: `carrier-review-probe.ts`, first JSON line (`off-kind-discard-failure-and-restart`).

## Exact reproduction commands

```sh
cd /tmp/nova-m10h-capture-review-acbda56
/home/jeremy/.local/share/mise/installs/node/26.3.1/bin/node capture-review-probe.ts
/home/jeremy/.local/share/mise/installs/node/26.3.1/bin/node carrier-review-probe.ts
```

Both commands exited 0 after asserting setup and controls. The scripts print the specific homes/checkpoint names needed to inspect retained synthetic artifacts. The scripts are untracked review artifacts, and do not alter implementation files.

## Positive control and limits

The carrier probe also verifies that an explicit hub tombstone does retry a failed local DELETE, and that a lost tombstone acknowledgement is retried after reconstructing the carrier from disk. It ends with `pendingTombstone=false`, `ackCalls=2`, and `storeItemsRemaining=0`.

This was a scoped adversarial review, not an exhaustive proof. Signed-batch identity, checksum validation, consent ingestion, backup/reset integration and migration/replication code were traced. The probes use real core HTTP/API/database/replication/checkpoint paths, but do not run a real Screenpipe or device, test real OS permissions or cloud targets, or claim real Screenpipe API compatibility. The home-to-cloud transition uses the supported live site callback to exercise the exact pending-request policy boundary; it does not migrate any real hub. No merge/push or external target was attempted.
