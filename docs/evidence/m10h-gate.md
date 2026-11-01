# M10h gate evidence: native workloads on devices, and the capture pilot

The ADR is `docs/plans/M10-orchestration.md` (Point 6, the M10h row of Order, the tiers table,
"Resolved: the capture data path") with the owner's Decisions 1 and 4
(`docs/builder-packet/INPUT-2026-10-31-ORCHESTRATION-DECISIONS.md`) and the capture data path design
(`docs/builder-packet/nova-capture-data-path-design-2026-10-31.md`, whose M10h gate list is adopted).
The plan is `docs/plans/M10h.md`. Everything here ran on 2026-11-01 (UTC) on this machine (WSL2,
Node 26.3.1), in temp folders made with `mkdtemp(os.tmpdir())`, on 127.0.0.1 only. **No real device
and no real Screenpipe or other binary was installed anywhere:** the only workload program is
`scripts/stand-ins/stand-in-screenpipe.js`, run by Nova's own Node inside temp device homes; the
"Linux", "macOS" and "Windows" devices are device agents on this machine with a stand-in platform
label (`NOVA_DEVICE_PLATFORM`). The no-Kubernetes tripwire was armed for every run and never fired.
No credential goes to a spoke (owner decision Q5; the vault broker isn't merged).

The branch is `m10h/native-workloads`, from main at `6d51c5d1` (M10e, M10f, M10g merged). Migration
**0023** (`src/core/migrations/0023_native_workloads.sql`): replicated `device_workload`,
`capture_batch`, `capture_device_tombstone`; the replicated column `capture_event.provenance`, in
`ADDED_COLUMNS[23]` (`tests/core/sync-skew.test.ts` and `tests/core/mesh-sync.test.ts` pass with it).

## Takeover status (2026-11-01)

**The final gate is not yet passed.** The required independent review was interrupted by
an automated safety filter, and the original head's one CI rerun failed a different
chaos-test startup race. Reproductions, fixes, exact local commands and remaining gates
are recorded in `docs/reviews/m10h-takeover-review-2026-11-01.md`. PR #276 remains unmerged;
the preview is unchanged by this takeover. The results below are historical build evidence,
not a claim that the current head is approved.

## Earlier suite results

CI is the record: PR #276, run `41296243939`, at `2162b62e`.
- **`lint · typecheck · themes · tests`**:
  - First attempt: **1545 tests, 1531 pass, 1 fail, 13 skipped**. The one failure was `tests/acceptance/m10g-review2.test.ts` › R13, an M10g timing test that waits up to 20 s for a captured "unhealthy" answer. It touches no M10h code and passed alone locally.
  - Re-run of the failed jobs: **1545 tests, 1532 pass, 0 fail, 13 skipped**. The tripwire was armed and never fired. Every M10h test passed (the pilot in 10.2 s). The regression evals passed, 30 tasks and 0 failing, as did the fresh-user test (first win 2641 ms, human path estimated at 360 s) and the closing-rule claims test (`tests/core/evals.test.ts`).
- **UI gate:** at `2162b62e` the gate failed three times running on one test,
  `tests/ui/m9-progress.test.ts` › "optimistic UI is honest". That test passed locally, also as root in
  the Playwright image, and main and other branches passed it in CI the same morning.
  - **The cause, found with a diagnostic pushed at `912d971f`:** the test read the edited memory's id
    before the list refreshed. A correction is a new record, so the test routed a 503 for the old id
    while the click went to the new one, and that edit really saved ("Saved…" instead of "Nova is
    restarting"). This is a race in the test, not in Nova. On this branch the list happened to refresh
    later in CI.
  - **The fix:** the test now waits for the list to show the corrected record before it reads the id.
    The diagnostic line stays, so a failure there says what the page showed.
  - The other 113 UI tests passed on every attempt.
  - Locally, `scripts/ui-test.sh` gave 114 of 114 at `3e2fbf26` (Chromium and WebKit, in the Playwright
    image), with the tripwire armed and never firing; the screenshots it rewrote were put back. A later
    full local run gave 113 of 114: `m6a-capture`, "database is locked", where the test opens the
    database with no busy timeout while the server writes. It passed in every CI attempt.
  - At `4d060ccd`, the UI job in run `41306044910` passed. Its overall gate did not;
    see the takeover status above.
- **Locally, every M10h file together** (`tests/core/workloads-*.test.ts`, `capture-sync`, `capture-carrier`, `tests/acceptance/m10h-pilot.test.ts`, with the device-agent, sandbox, spokes, services, sync and capture files they touch) all pass.
- **A full local `npm run check` couldn't be completed on this machine.** Other builders' suites ran alongside it, one of them hung for over six hours. `/tmp` (a 16 GB tmpfs) filled to 100 % during the run, and the tests failed with it. CI, above, is the run of record.

## Who holds the mesh key and carries the sync

**The boot agent**, in a data channel of its own: `src/device/carrier.ts`. The boot agent already held
the device's Ed25519 key (`boot/keys.json`, 0600) and its session with the hub, so no key is made or
moved for this. It signs each batch's manifest (`captureBatchMessage`), each tombstone acknowledgement
and each raw item with that key. The runtime has no part in the capture data path.

Why this fits Decision 1: the five verbs are about execution, and the carrier executes nothing. Its
source imports no `node:child_process` and calls no `spawn`, `exec` or `fork` (a test reads it:
`tests/core/workloads-device.test.ts` › "Decision 1 in the code"). It reaches two places only: the hub
over the boot agent's own session, and the live capture workload's 127.0.0.1 port, taken from that
version's hub-signed manifest (`Workloads.liveCapture`, which never returns a copy running alongside
or as a shadow). **The runtime's no-network rule is kept, not amended:** `RUNTIME_CALLS` is still
exactly heartbeat and inbox (asserted in the same file), and the M4b sandbox test, run again with
`rollout.ts` in the runtime, also refuses the runtime any read or write of `workloads/` and
`capture/` (`tests/core/device-sandbox.test.ts`).

## Gate

| Gate item | Proved by |
|---|---|
| **The five verbs, exactly**, frozen; a request is `{verb, service, version}` and nothing more | `tests/core/workloads-device.test.ts` › "the verb set is exactly five, frozen…" (every other verb name refused; a `command`, `args`, `argv`, `env`, `port`, `url` or `manifest` key refuses the request) |
| Refuses an **unsigned** workload | `workloads-device` › "a manifest is accepted only when…" (no signature; empty signature) and › "install fetches and checks…" (refused, nothing downloaded, no slot) |
| Refuses one **signed by a key it didn't pin**, or **changed after signing** | the same two tests (a stranger's key; a command changed after signing) |
| Refuses an **artifact whose hash doesn't match**, writing nothing | `workloads-device` › "install fetches and checks…" (no slot, no `.next`) |
| Refuses **any command not in the signed manifest** | `workloads-device` › "a manifest is accepted only when…" (`sh -c`, `/bin/sh`, `node -e`, `node --import`, `../`, another interpreter, a file name outside its slot or over its manifest); a request carrying a command (first test); › "start runs the manifest's own command…" (a slot changed after install is refused at the next start, not run) |
| Refuses **another device's or platform's** manifest, a **role it doesn't hold**, **root** | `workloads-device` › "a manifest is accepted only when…", › "never as root…", › "a role taken away stops what it allowed…" |
| The same refusals **through the real agents**: a runtime asking for a verb outside the five, or with a command, port or manifest of its own, is refused, nothing runs, the hub is told | `tests/core/workloads-rollout.test.ts` › "a runtime that asks for anything but the five verbs…" (a real boot agent, the real sandboxed runtime child with a hostile `runtime.ts`, a stand-in hub; `workload_refused` reports) |
| **The runtime still can't start a process** | `tests/core/device-sandbox.test.ts` (M4b's test, run again: `child_process`, `execve`, workers, addons, the network, all refused; now with `rollout.ts` installed and the `workloads/` and `capture/` folders out of reach); `RUNTIME_CALLS` unchanged (`workloads-device` first test); `rollout.ts` has no process or network call (› "Decision 1 in the code") |
| **6(b): fetch, verify, alongside or shadow, health, switch, keep the prior, one-step rollback**, all local | `workloads-rollout` › "in-process: shadow, health, switch…" (a shadow on its own port, told it is one, healthy twice, then switched onto the stable port; `none` started only at the switch; a failing version goes back by itself: `switch 3.0.0`, `switch 2.0.0`, nothing installed or downloaded; a changed slot installed again from the hub and started); › "through the real agents…" (the runtime decides from its heartbeat answer, the boot agent installs, switches and rolls back, the heartbeat reports it; downloads counted); `workloads-device` › "switch keeps the version before…" |
| **Through the same promotion gates**, by an approver | `tests/core/workloads-hub.test.ts` › "capture only onto a capture source…" (a paired phone may not deploy, promote or roll back, whatever it types) and › "promotion only once the device reports it ready, at its tier…" (not offered before `ready`; tier 3 typed for capture; the assignment follows a device that went back by itself, with a problem) and › "capture only onto a capture source…" (deploying a new command asks at tier 3, typed) |
| **Placement:** containers only onto Linux nodes (none without K3s); native onto any enrolled device whose roles allow; never a thin client; capture only onto `capture-source`; no secrets to a spoke | `workloads-hub` › "placement: containers only on Linux…" (image-only refused on the Mac and Windows stand-ins, and on Linux without the K3s driver; a native program sent to the Linux, macOS and Windows stand-ins; a phone refused; secrets refused; `https:` refused) and › "capture only onto a capture source: the validator, the resolver and the device each hold it" |
| **The Screenpipe pilot on a stand-in**, not re-signed | `tests/acceptance/m10h-pilot.test.ts` (Screenpipe's definition, `services/screenpipe.ts`, deployed by a real hub to three real device agents joined by the real pairing flow, labelled `linux-x64`, `darwin-arm64`, `win32-x64`: installed bytes equal the artifact's, each manifest for its platform); `workloads-hub` › "a device gets only its own manifest, signed by the hub, and the program exactly as published" |
| **Deploying capture never turns capture on**; consent per source and per device | the pilot (every source listed and off after deployment; nothing runs on any device; promoted on the Mac it is live but not started until the Mac's screen source is on; audio stays off and never syncs; Linux and Windows never start and sync nothing); `workloads-device` › "never as root; a capture workload starts only while capture is on…"; `capture-carrier` › "a big burst…" (audio captured while audio was off is deleted on the device and never sent); a capture workload is never run twice (`workloads-hub`, `workloads-device`: `shadow` refused at the hub and the device) |
| Capture data path: **sync and dedupe** | `tests/core/capture-sync.test.ts` › "sync and dedupe…" (each item once; a resent batch answered as duplicates; provenance: device, name, source, sequence, batch, both clocks; lag in numbers and words); the pilot (step 4); `tests/core/capture-carrier.test.ts` › "a big burst is read whole…" (6500 items in a minute, more than one read holds: each sent once, in sequence order; an item reported two minutes late still taken) |
| **Offline resume** without loss or duplication | the pilot (step 5: the hub's mesh listener goes away; 12 items captured meanwhile queue on the Mac; the hub returns; each arrives exactly once; the queue empties; "Test Mac capture: synced to HH:MM · 0 queued"); `capture-carrier` › "a full queue pauses and says so…" (a queue of 100 with 250 captured and sync held: paused in words; then every item once) |
| **Tombstone acknowledgement** in the report | `capture-sync` › "a forget reaches the device that holds it…" (pending, then confirmed only with the device's signed ack of every item; a wrong key or a partial ack refused; resent later it doesn't come back); the pilot (step 6: deleted from the Mac's capture store too, then "Deleted on Test Mac too (it confirmed)") |
| **A ledgered raw fetch** with its reason | `capture-sync` › "a raw fetch is a ledger task naming the item and the reason…" (no reason refused; the task's goal names the item and reason; only that device is asked; a wrong key or wrong bytes refused; done only after Nova's own check of the file; forgotten with its event); the pilot (step 7) |
| **Local-only plus a cloud hub queues** | `capture-sync` › "local-only with a cloud hub…" (the plan says it waits and why; a batch is refused and nothing kept; what waits is known as a count; local-preferred takes it; a raw fetch to a cloud hub refused) |
| **Manifest refusal** (unknown, revoked, bad signature), logged | `capture-sync` › "manifest refusal…" (a key that isn't the device's; a device Nova doesn't know; another device's manifest over this session; a changed item; out of sequence; a revoked device: no session, and its manifest refused whoever sends it; nothing kept; a problem logged) |
| **Hard limits** | no binary but the stand-in anywhere (`m10h-pilot` asserts the artifact path); temp homes; 127.0.0.1; the tripwire armed and never fired (see Suite) |
| **Every other gate** | the fresh-user test, the regression evals, the closing-rule claims test (`tests/core/evals.test.ts`): see Suite |

## Reused, and new

| Need | Reused | New |
|---|---|---|
| Who may run what | `trust.ts assignmentAllowed`, `WORKLOAD_ROLES`, `bundleKeys`; M10f's roles in `device.json` from each heartbeat | `verifyWorkload` (the ADR's "binaries need a verifier of their own"), `CAPTURE_PERMISSIONS` (the same list on hub and device, tested) |
| Keeping a program running | `Watchdog` (backoff, three crashes a minute) | one per workload instance, in its own process group; leftovers of a killed agent ended on Linux |
| Signing | the hub's mesh identity, `wire.ts` canonical JSON and Ed25519 | `workloadManifestMessage`, `captureBatchMessage`, `tombstoneAckMessage`, `rawManifestMessage` |
| Asking the boot agent | the runtime's IPC (`call`/`answer`) | `verb`/`verb_answer`; `rollout.ts` in the runtime |
| Stages and tiers | M10e's `ServiceManager` (typed ask for a new command, tier 3 for OS permissions, promote only `ready`, rollback typed) and `ServiceDriver` | a `remote` driver on the manager; `DeviceWorkloads.driver(deviceId)`; a manager per device |
| Where | M10f's `resolvePlacement`, `ineligible`, `devicePlatform`, the validator | the capture-source rule; the device driver's refusals (containers, secrets, `https:`, copy) |
| Capture | `Capture.ingest` (consent, exclusions, Nova's rules, screening), `capture_tombstone`, `forget`, `#remove`, sources offered from heartbeat capabilities | `fromSpoke`, `deviceKinds`, provenance, the `forgotten`/`removed` hooks; `capture/sync.ts` |
| Records | the Work Ledger, the verifier's confirmations, `log.problem` | the `capture-raw` worker and the `nova-capture-raw` confirmation |
| Proof | `FakeNode`, `joinedHome`, `mesh-support` `hub`/`enroll`, the real pairing flow (`joinHub`) | a stand-in Screenpipe workload; `tests/support/workloads.ts` |

## Guards removed, in turn

1. **`ServiceManager.plan` refused any placement away from the hub** ("comes with native workloads").
   It now hands such a placement to its `remote` driver. A manager without one (the supervisor's) still
   refuses, in new words (`tests/core/services-placement.test.ts` updated to them).
2. **`POST /services/placement`'s note** said nothing is deployed to other devices; it now names the
   deploy route.
3. **Narrowing a device's roles "stops nothing"** (the comment, and nothing in `workStopping`): it now
   lists and stops the device's workloads that need a removed role (`tests/core/workloads-hub.test.ts`).
4. **The runtime bundle carried only `runtime.ts` and `queue.ts`**; it now carries `rollout.ts` too
   (`device-agent`, `mesh-spokes` and `device-sandbox` tests updated). Its only real imports are
   `./queue.ts` and `./rollout.ts`; what it names from `workloads.ts` is types, erased (asserted).
5. **The supervisor driver's refusals** pointed at "native workloads" for `https:` and other devices;
   they now say what is true (Nova downloads no program; another device's service is a native
   workload deployed from the hub).

Guards **added**, not removed: the validator refuses a capture permission placed by any role but
`capture-source` (`tests/core/services-manager.test.ts`'s tier-3 case now uses a non-capture
permission, `notifications`, for that reason); capture from a spoke checks the capture-source role at
the hub's intake as the inbox does; a workload with secrets, an `https:` artifact, or `copy` is refused
for a device.

## Counts

- Source, new: `src/device/workloads.ts`, `src/device/rollout.ts`, `src/device/carrier.ts`, `src/core/services/workloads.ts`, `src/core/services/screenpipe.ts` and `src/core/capture/sync.ts`; migration 0023; the stand-in `scripts/stand-ins/stand-in-screenpipe.js`.
- Tests, new: 6 files, 25 tests:
  - `workloads-device` 9;
  - `workloads-rollout` 4;
  - `workloads-hub` 4;
  - `capture-sync` 5;
  - `capture-carrier` 2;
  - `m10h-pilot` 1 (one long test).

  Existing files were extended: device-sandbox, device-agent, mesh-spokes, services-placement, services-manager and capture.
- Suite: 1545 tests in CI (13 skipped need a real model, Claude or Relay).

## Limits

- **Stand-ins only.** No real device, no real Screenpipe, no real OS permission. The three platforms
  are labels on Linux processes; the macOS and Windows programs are the same Node stand-in. Whether
  macOS keeps a screen-recording grant across an update signed by the same publisher is unchecked (the
  ADR's honest limit; it needs a real Mac and the owner's OK).
- **The stand-in's delete call (`/__delete`) is its own.** Real Screenpipe's way to delete an item is
  to be checked before going real; until then a tombstone on a real Screenpipe can't be carried out,
  and its report would stay "waiting", as designed.
- **A workload isn't sandboxed** beyond running as the person's own user (the ADR's rule): a
  hub-signed program can read what that user can, the device agent's folder included. Only a program
  the hub signed, pinned by its hash, runs.
- **Files are served whole** (a checked `file:` artifact, up to 256 MB, one request); no `https:`
  artifact, no streaming, no resumable download. A raw original over about 640 KB isn't sent; audio
  originals aren't fetched.
- **One definition, one device.** Screenpipe on three devices is three deploys (each pinned), each
  with its own registry and promotions; floating copies across devices from one definition aren't
  built. `copy` alongside and contract tests on a device aren't offered (health only).
- **Leftovers of a killed agent** are ended by the next one on Linux only (by pid, checked against
  `/proc/<pid>/cmdline`).
- **Lag is in the API** (`GET /capture/devices`), not yet on Health or the map (M10i).
- **The design's later parts are not built:** the raw archive and its storage adapter, pruning after
  a verified transfer, the 48-hour window, cold tiers, encryption before upload, and a delete made on a
  spoke reaching the hub.
- **After an emergency promotion**, a slot signed by a key the new roster doesn't list is refused at
  its next start and installed again from the new hub; tested for a slot changed on disk, not through
  a real emergency promotion.
- **No credential on a spoke** (owner decision Q5): a workload needing a secret can't go to a device
  until the vault broker exists.

## Where the ADR didn't fit

See `docs/plans/M10h.md` › "Where the ADR didn't fit": the runtime decides 6(b) and the boot agent
executes it; a switch on a device is a restart onto the stable ports (no forwarder), so `full` and
`shadow` are rehearsals before it; the carrier is the part the resolution note asked for and is not a
sixth verb; device workloads have managers in the core while the hub's own services stay with the
supervisor's; the kept version stays until the next promotion rather than for `soak_s`.
