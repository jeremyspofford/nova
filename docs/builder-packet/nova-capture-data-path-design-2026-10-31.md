# Capture data path (spoke → hub) — design for ADR open question 1 (2026-10-31)

Status: v3, revised 2026-10-31 per Jeremy: the design target is
Nova's NATIVE capture service (built by and for Nova, replacing
Screenpipe — Screenpipe is a transitional adapter, not the end
state), and every transfer carries machine provenance. Resolves open
question 1 in docs/plans/M10-orchestration.md (needed by M10h; the
hub's own capture doesn't need it). Grounding: CONTEXT-AND-CAPTURE
(one internal API `capture.stream(device, kind)` → normalized events;
data lands on the user's devices first; consent per source per device;
retention is user policy; deletion is real deletion).

## Principle

**Process at the edge, sync the meaning, archive the raw, clear the
spoke.** What the hub needs continuously is the *derived* record —
text, transcripts, events. Raw media follows behind it on a schedule
to a hub-configured archive, and once the archive copy is verified,
the spoke doesn't need to keep it.

## The archive (owner's model, v2 addition)

- **Storage target is configured on the hub**, behind a storage
  adapter: a local drive on the hub, a storage server, a NAS, or
  cloud object storage (S3-compatible). One target at launch.
- **Scheduled raw transfer:** each capturing spoke transfers its raw
  captures (Screenpipe's store included, read via its local API) to
  the target on a schedule. Schedules are OPPORTUNISTIC windows, not
  clock times: the device must be awake, the hub reachable, and
  (configurable) the connection unmetered. Transfers are resumable
  and watermarked — each run moves everything up to a sequence/time
  mark, never a partial item.
- **Clear-after-VERIFIED-transfer:** the spoke may prune archived raw
  only after the target copy passes verification (checksum match +
  manifest commit + the archive's integrity scrub can read it).
  "Uploaded" is not "archived." EXCEPTION — local window: the spoke
  always keeps the most recent window of raw locally (default 48h,
  configurable): instant local context with no network round-trip,
  and local capture keeps working while the hub is unreachable.
- **The hub serves data requests from wherever the data lives**
  (spoke window, archive hot tier, archive cold tier). A device no
  longer needs its own old captures to answer questions — it asks the
  hub, which is also what makes a replaced/lost device's history
  survive.
- **Lifecycle tiering (cloud targets):** captures not referenced for
  a configurable period (default 90 days) move to a cold tier
  (Glacier-class: roughly 1/20th the per-GB cost of standard object
  storage, at the price of hours-scale, fee-bearing retrieval — exact
  prices are the provider's and change). Cold fetches are background
  tasks with a plain status ("fetching from long-term storage"),
  never a silent hang. A final retention limit may delete from cold
  per user policy. Forget/delete tombstones apply to archive and
  cold objects too — real deletion includes the archive (some
  providers charge early-deletion fees inside a minimum storage
  duration; the delete flow says so when it applies).
- **Encryption and modes:** any target off the hub's own disk gets
  hub-side encryption with the user's keys BEFORE upload (the cloud
  stores ciphertext; keys follow the vault rules and are never in the
  archive). Local-only mode forbids cloud targets outright — LAN/NAS/
  hub-disk targets only, consistent with the mode everywhere else.
- **Single-copy warning:** if the target is one local disk, that disk
  is the only copy of archived raw once spokes prune. Nova says so at
  configuration time and recommends the target be covered by the
  hub's backup or be an inherently replicated store. The archive
  INDEX replicates to the standby with normal hub replication.

## The path, in four parts

1. **On-spoke processing.** The capture workload is Nova's NATIVE
   capture service — a device-native workload under the Service
   Manager (orchestration ADR Point 6), designed to match or exceed
   Screenpipe. It normalizes locally into the capture API's events:
   frames → OCR text (+ a perceptual hash, not the image), audio →
   transcript (on-device model where available), app/browser
   activity → activity events. Raw media stays in the spoke's own
   capture store, under the user's retention policy, managed by the
   device agent. Because the store is Nova's own, the local-window
   and pruning rules below are Nova's design, unconstrained by a
   third-party app. TRANSITION: while Screenpipe still runs anywhere
   (e.g. the current hub install), a Screenpipe adapter reads its
   local API and feeds the same pipeline, so both sources land in one
   record with one provenance scheme; the adapter retires when native
   capture reaches parity per device.
2. **Derived sync (the default and only automatic path).**
   Store-and-forward over the existing authenticated mesh channel:
   derived events trickle to the hub whenever it is reachable; when it
   isn't, they queue on the spoke (ordered by device sequence number,
   not wall clock — spoke clocks lie). Delivery is idempotent (event
   IDs; hub dedupes), checksummed, and hub-acknowledged, so "capture
   lag" per device is a knowable number shown in Health and on the
   topology map ("Mac capture: synced to 14:32 · 212 queued"). A full
   queue pauses sync and SAYS so; it never silently drops.
3. **Raw access.** Before archival, raw lives on the spoke and the
   hub fetches specific items on demand (each fetch a Work Ledger
   entry naming item and reason). After archival, the hub serves raw
   from the archive (see The archive) — spokes are no longer the
   source for old raw, which is what makes their pruning safe.
4. **Deletion propagates both ways.** The hub is the index of record.
   A forget/delete on the hub issues tombstones to every spoke holding
   that data (derived + raw); a delete on a spoke removes the hub's
   copies. Deletion reports honestly: "deleted everywhere" only when
   all spokes have acknowledged — an offline spoke shows as pending,
   the same standard as deletion-in-backups. Revoking a device offers
   export-or-delete of its queued, unsynced data.

## Provenance — every transfer states its machine (owner requirement)

- Every item and every transfer batch carries its ORIGIN: device ID
  and name, capture source (native service / Screenpipe adapter),
  the device's sequence range covered, per-item checksums, and the
  transfer's time. Batches arrive as signed manifests — signed with
  the device's mesh key — so attribution is verifiable, not a
  claim in a header.
- The hub verifies the manifest signature against the enrolled
  device record before accepting data into the index. Data from an
  unknown or revoked device is refused and the refusal is logged.
- Provenance is stored WITH the data and survives every move:
  spoke → hub index → archive → cold tier all keep origin device,
  capture time (device clock + hub receipt time), and transfer
  history. Any item Nova surfaces can answer "which machine captured
  this, when, and how did it get here" — the same provenance
  standard Nova's memory already requires.
- Deletion tombstones are also per-device: a forget reports which
  devices/archive tiers held the item and which have confirmed
  removal.

## Privacy modes

- Mesh transfer is device-to-device (LAN/tailnet) between the user's
  own machines: permitted in every mode when the hub is a home device.
- If the ACTIVE hub is a cloud site, derived sync sends content off
  the user's machines: in local-only mode it is refused and queues
  (the mode wins, as everywhere in Nova); in local-first it follows
  the cloud-hub policy; raw fetch to a cloud hub additionally needs
  the per-device opt-in from (3).
- Consent is unchanged: syncing never enables capture; capture stays
  off by default, per source, per device, with its indicator.

## Costs and limits, stated

- Derived data is small (text/transcripts): continuous sync is cheap
  enough to leave on. Raw is 2–3 orders of magnitude larger — that's
  the entire reason it doesn't move by default.
- Cross-device recall works on derived data even while a spoke is
  offline (up to its lag); raw-dependent questions about an offline
  device answer "the device is offline; here's the derived record."
- The standby receives the hub's synced capture through normal hub
  replication; spokes sync only to the active hub (stable name).

## Alternatives considered and rejected

- **Stream everything raw to the hub:** simplest mental model; worst
  bandwidth, storage, and privacy blast radius; makes the hub a
  single point of total surveillance data. Rejected.
- **Hub pulls everything (generalizing today's Screenpipe pattern):**
  raw-by-default with extra steps. Rejected as the default; pull
  survives as the on-demand mechanism in (3).
- **Fully federated, nothing syncs; hub queries spokes live:** memory
  has holes whenever a device sleeps — which for laptops is most of
  the time — and cross-device search becomes N live queries. Rejected
  as the sole mechanism; the derived index on the hub is what makes
  recall reliable.

## Gate evidence this implies for M10h

With the stand-in capture workload and stand-in devices: derived
events sync and dedupe; offline queueing resumes without loss or
duplication; a tombstone deletes derived + raw on a spoke and the
report waits for its ack; a raw fetch appears in the ledger with its
reason; local-only + cloud hub queues instead of sending.
