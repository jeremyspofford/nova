# ADR: Smart Home and cameras

**Sources:**
- **The owner's design input**, approved 2026-10-31, with one owner change the same day: `docs/builder-packet/nova-smart-home-design-2026-10-31.md` (copied unchanged; sha256 `5c28dd8d…`). Cited below as "the input".
- **The owner's instruction that came with it**, 2026-10-31, binding. Cited below as "the instruction". It requires:
  1. the device and capability model, the page, and control through the existing tiered service-call path with read-back;
  2. the backend order;
  3. cameras as capture-class data;
  4. discovery with a connect card;
  5. the S1 gate, including the owner-assisted real checks.
- **The owner's correction**, 2026-10-31, binding. Cited below as "the correction". Cameras may go through the cloud:
  - Bridge-fed cameras (Home Assistant, Scrypted, local) still stream over LAN or mesh through the hub.
  - Vendor-cloud cameras (Nest, Reolink Cloud, Ring and so on) may stream through their clouds.
  - Remote viewing may use a cloud path where the backend provides one, not only the tailnet.
  - Cloud clip storage is an archive target under the capture design's encryption rules.
  - **The one exception is local-only mode:** cameras stay local there, like everything else.

  Where the instruction's point 3 said "LAN/mesh only, no cloud relay in any mode", the correction governs.
- **Settled designs this must agree with:**
  - The capture data path: `docs/builder-packet/nova-capture-data-path-design-2026-10-31.md`, and its resolution in `docs/plans/M10-orchestration.md` (Resolved: the capture data path).
  - The Decision Service ADR: `docs/plans/decision-service.md` (PR #250, open), including owner decision 4 on Box.
  - The Vault and Credential Broker ADR: `docs/plans/vault-broker.md` (PR #251, open).
- **The packet:**
  - NOVA-SPEC §4 (triggers) and §6 (tiers);
  - CONTRACTS §1, §3, §4 and §6;
  - CONTEXT-AND-CAPTURE;
  - DESIGN-SYSTEM §1, §5, §6 and §7, with the Smart Home card in the Ambient Home (`nova-ui-d-ambient.png`);
  - AMENDMENT-2026-10-31-A (the QA harness) and -B Part 2 (discovery in onboarding; empty states);
  - OPERATING-RULES; ROADMAP-AND-GATES; CAPABILITY-INVENTORY (Smart-home bridges row).

**Status:** this is the design. Nothing here is built.
- Each phase under Phases lands as its own PR, with its own gate.
- Nothing here displaces in-flight work, the M10e–M10k order, or QA Stage 2 (see Placement).

**Tier numbers** follow NOVA-SPEC §6: 0 act silently, 1 act and report with undo, 2 ask first, 3 explicit confirmation every time.

## Owner decisions (2026-10-31)

The owner decided this ADR's open questions the same day. These govern wherever the text below proposed otherwise.
1. **Who acts decides the approval: direct versus Nova-initiated.**
   - **A tap on a tile is the person acting directly,** not Nova acting for them. Direct control at tiers 0–2 gets no approval sheet: a light switch that asks first is broken.
   - **A direct tap on a tier-3 action** (unlock, opening a garage door or gate, turning a camera or its recording off) gets ONE lightweight confirm on the tile itself (a confirm state, or a long press), not a full sheet.
   - **Nova-initiated actions** (chat, automations, schedules) follow the tier table: tier 2 asks first, and tier 3 confirms every time.
   - **The ledger records which it was:** "you, directly" or Nova with its approval.
2. **The approval table, with three refinements:**
   - **Locks:** locking is **tier 1** (done and logged), because it's the safe direction. Unlocking stays tier 3.
   - **Garage doors and gates:** opening is tier 3; closing is tier 2 (risk of hitting something); the direct-tap confirm applies to opening.
   - **Heating:** starting heating **within** the comfort range is tier 2. Tier 3 is for a target **above** the range, and for turning heating **off** entirely (risk of freezing). The comfort range is a setting; its default is setpoints of **60–75 °F**.
   - **The rest stands as proposed:**
     - lights and media: tier 2 when Nova starts them;
     - live viewing of your own cameras: tier 0;
     - clip download: tier 1;
     - clip sharing: tier 2;
     - camera or recording off: tier 3.
3. **The connect flow, adopted.** In order:
   1. the card, with no credential asked;
   2. sign-in;
   3. a read-only preview with counts by room, before any import.

   Cancelling at the preview revokes the token. The input doc assumed counts could be shown before sign-in; that was wrong, because Home Assistant and Scrypted reveal nothing without a credential.
4. **Plain `http` to Home Assistant, approved.**
   - Only to an address confirmed to be on the person's network or tailnet, with a plain notice.
   - The exception is scoped to that connector and recorded in Settings.
   - The vault broker's `https` rule stands for everything else.
5. **Box in local-only mode: never to a cloud provider.**
   - "Cameras stay local" wins, and the rule is "no cloud in local-only", not "no Box in local-only".
   - In local-only mode, frames may go to a **local** decision provider (Tev1-class) with the Box opt-in on.
   - The Decision Service ADR keeps "opt-in, every mode", with this seat restriction stated. Today no local seat reads images, so in local-only mode Box is unavailable until one does.
6. **The camera view log, yes.** Who viewed which camera, and when, is recorded in the Work Ledger, kept local like all ledger data.
7. **Face recognition is ruled out, a non-goal.** Detection is by class only: person, vehicle, animal, package. No face identification and no named-person recognition, in any mode, in this milestone.
8. **The milestone is M11 — Home,** with phases S1–S3. The sequence stands: after the M10 chain and the QA harness milestone.
9. **Still open, and proceeding on its proposed default:** the class of a home token. It is standard class, so reads run at standing consent and every command asks at its own tier.

## Decision

Nova gets a **Smart Home** surface built on one **device model**.
- **The model:** home devices described by capability (light, switch with optional dimmer, climate, lock, sensor, cover, media, camera), never by vendor.
- **Adapters** map each backend onto that model. They come in this order:
  1. Home Assistant, by extending the M5 connector;
  2. Scrypted, camera-first;
  3. direct vendor and local connectors, by demand.

  Vendor clouds are the person's opt-in only, and never in local-only mode. Matter is out of scope: it gets its own ADR later.
- **The page** is a view over the model and never a second source of truth: rooms, favourites, scenes and cameras, designed for the phone first.
- **Control** goes through the existing tiered service-call path, unchanged in kind:
  - each command is a Work Ledger task at its tier;
  - Nova reads the device back from the backend itself before calling it done.
- **Cameras are capture-class data:**
  - live view is ordinary use, with no tier friction;
  - clips Nova keeps follow the capture data path's provenance, retention, archive and tombstone rules;
  - exporting or sharing a clip is tiered;
  - event classification goes through the Decision Service registry once it lands.
- **Discovery** finds Home Assistant, Scrypted and ONVIF cameras. A connect card says what would be exposed before any credential is asked for.
- **Credentials** go through the Credential Broker.

**It is built from what exists, not beside it:**

| Need | Built on | New |
|---|---|---|
| Talking to Home Assistant | `src/core/connectors/home-assistant.ts`: REST states (tier 0), service calls as ledger tasks (tier 2; tier 3 for `lock` and `alarm_control_panel`, `DEFAULT_TIER3`), read-back as evidence (`confirm`), `state_changed` over the WebSocket into event triggers, local-only egress checks (`addressEgress`, `resolved_local`), token revoked at Home Assistant on disconnect | Area, device and entity registry import; camera snapshots and streams through Home Assistant's own stream proxy; read-back that waits for a settled state |
| Connectors in general | `src/core/connectors/index.ts`: the connector kind, `ctx.secrets`, `ctx.emit`, `ctx.delegate`, `ctx.permits`, removal that signs out | A `HomeAdapter` interface that a connector implements to feed the device model |
| Approvals | The ledger's gate (`ledger.ts approve`: tier 2 waits for an OK, tier 3 needs `confirm`); `approvalSheet` in `ui/js/components.js` | A per-capability tier map, which can only raise a connector's tier |
| Events | `src/core/triggers.ts`: rules by connector and topic, dedup, cooldown, triage, CONTRACTS §6 records | Device-model topics; probabilities on camera events; rule conditions on them (S2) |
| The console | `ui/js/nav.js` (destinations, phone tabs, rail of at most six), `ui/js/surfaces.js` (Home cards), `ui/js/components.js` (`card`, `emptyState`, `deviceRow`, `approvalSheet`) | A Smart Home destination, its page, and the Smart Home card on Home |
| Stand-ins | `scripts/fake-home-assistant.js` (REST, WebSocket, six sample entities) | Areas, registries, cameras with synthetic frames; a fake Scrypted; a fake ONVIF responder |
| Captured data | `src/core/capture/` (consent per source and device, kinds, retention); the capture data path design | A camera clip source; kind `camera` |
| Judgments | The Decision Service (PR #250): templates, seats, decision log | The `camera-event` template (S2) |
| Credentials | `vault.ts` today; the Credential Broker (PR #251) | Home Assistant and Scrypted refs with `http`/`ws` bindings |

## 1. The device and capability model

### Types

```ts
// One record per (backend instance, backend id). Built from the backend on import, refreshed
// from its events. Nothing in it is the truth about a device: the backend is.
interface HomeDevice {
  id: string;                        // stable: `<adapter instance>:<backend id>`
  adapter: string;                   // 'home-assistant' | 'scrypted' | 'onvif' | …
  instance: string;                  // which Home Assistant or Scrypted, by its connection id
  backend_ref: string;               // the entity id, Scrypted id, ONVIF address…
  name: string;                      // the backend's name
  room: string | null;               // the backend's area id; null when it has none
  capabilities: Capability[];        // one device may have several (a camera with a motion sensor and a light)
  available: boolean;                // the backend says it can reach the device
  read_at: string;                   // when Nova last read it from the backend
  provenance: { adapter: string; instance: string; via_device: string };   // which Nova device holds the connection
}

interface Room { id: string; name: string; adapter: string; instance: string }

type Capability =
  | { kind: 'light'; on: boolean; brightness?: number; color_temp_k?: number; color?: [number, number, number] }
  | { kind: 'switch'; on: boolean; level?: number }                       // level: a dimmer, 0–100
  | { kind: 'climate'; mode: 'off' | 'heat' | 'cool' | 'heat_cool' | 'auto' | 'fan_only' | 'dry';
      current?: number; target?: number; target_low?: number; target_high?: number;
      unit: 'C' | 'F'; action?: 'heating' | 'cooling' | 'idle' | 'off'; humidity?: number }
  | { kind: 'lock'; state: 'locked' | 'unlocked' | 'locking' | 'unlocking' | 'jammed' | 'unknown' }
  | { kind: 'sensor'; type: SensorType; value: number | boolean | string | null; unit?: string }
  | { kind: 'cover'; state: 'open' | 'closed' | 'opening' | 'closing' | 'stopped' | 'unknown';
      position?: number; class: 'blind' | 'curtain' | 'shade' | 'garage' | 'gate' | 'door' | 'window' | 'other' }
  | { kind: 'media'; state: 'playing' | 'paused' | 'idle' | 'off' | 'unknown'; volume?: number; muted?: boolean; title?: string; source?: string }
  | { kind: 'camera'; live: boolean; snapshot_at?: string; motion?: boolean;
      supports: { stream: ('webrtc' | 'hls' | 'mjpeg')[]; snapshot: boolean; events: boolean; clips: boolean; ptz: boolean; talk: boolean };
      path: 'local' | 'vendor-cloud' }
  | { kind: 'other'; domain: string; state: string };                     // shown read-only

type SensorType = 'motion' | 'contact' | 'occupancy' | 'temperature' | 'humidity' | 'illuminance'
  | 'power' | 'energy' | 'battery' | 'smoke' | 'leak' | 'co' | 'other';
```

- **Units are the backend's.** Nova converts only for display, and shows the backend's unit in the detail view.
- **`other`:** a backend device the model doesn't cover yet, such as an alarm panel, fan, vacuum or valve. It appears read-only on the page with its state. It stays reachable through the M5 connector's raw service calls at their existing tiers (alarm panels at tier 3).
- **Scenes** aren't devices:

  ```ts
  interface Scene {
    id: string;
    name: string;
    kind: 'backend' | 'nova';
    backend_ref?: string;        // a Home Assistant scene, run as scene.turn_on
    commands?: Command[];        // a Nova scene: a list of device commands
  }
  ```

### Commands and tiers per capability

The tier of a command is the **highest** of three things:
1. the connector's own tier (Home Assistant: `tierOf`, by domain and every entity named; today tier 2, or tier 3 for `lock` and `alarm_control_panel`);
2. the capability tier in this table;
3. the person's own mark on a device. Any device can be raised to tier 3, for example a switch that powers a heater.

The model can only **raise** a tier, never lower one, as `run` already enforces ("a call can't lower its own gate").

| Capability | Reading (tier 0) | Command | Tier |
|---|---|---|---|
| light | on, brightness, colour | `turn_on`, `turn_off`, `set_brightness`, `set_color` | 2 |
| switch | on, level | `turn_on`, `turn_off`, `set_level` | 2 |
| climate | mode, current, target, action, humidity | `set_target` lower, or within the comfort range; start heating with a target within the range; `set_mode` to `cool`, `fan_only` or `dry` | 2 |
| climate | | `set_target` above the comfort range's top; `set_mode` to `off` while heating (turning heating off entirely) | **3** (owner decision 2) |
| lock | state | `unlock` | **3** |
| lock | | `lock` | **1**: done and logged, the safe direction (owner decision 2) |
| sensor | value | none | — |
| cover (blind, curtain, shade, window, other) | state, position | `open`, `close`, `set_position` | 2 |
| cover (garage, gate, door) | | `open` | **3** (the Decision Service ADR's "unlock, disarm, open" rule) |
| cover (garage, gate, door) | | `close` | 2 |
| cover (any) | | `stop` | 2 (see Conflicts row 1) |
| media | state, volume, title | `play`, `pause`, `stop`, `next`, `previous`, `set_volume`, `mute`, `select_source`, `turn_on`, `turn_off` | 2 |
| camera | live view, snapshot, event list, clip playback | (viewing) | **0**: ordinary use |
| camera | | `ptz` (pan, tilt, zoom, presets), where supported | 2 |
| camera | | `talk` (two-way audio), where supported | 2 |
| camera | | turn the camera, its detection or its recording off at the backend | **3**: it weakens the home's security |

**Direct taps versus Nova-initiated actions (owner decision 1):** the tiers above apply to what Nova starts. A direct tap on a tile by the person needs no approval at tiers 0–2, and one on-tile confirm at tier 3.
| camera | | Section 5's clip actions | per Section 5 |
| scene | | run | the highest tier among its commands. A backend scene whose members Nova can't read is tier 2, or 3 if any member it can read is tier 3 |

- **The comfort range** is a setting: a low and a high setpoint. Its default is setpoints of 60–75 °F (owner decision 2), shown at setup. Widening it is tier 3, and narrowing it is immediate.
- **The tiers are profile settings** (NOVA-SPEC §6: the mechanism is core, the settings are the person's), as `tier3_domains` already is. Loosening any of them needs `confirm`, as `PUT /settings` does today.

### The adapter interface

```ts
interface HomeAdapter {
  kind: string;                                        // 'home-assistant', 'scrypted', 'onvif'
  instance(): { id: string; name: string; address: string; egress: Egress; path: 'local' | 'vendor-cloud' };
  import(): Promise<{ rooms: Room[]; devices: HomeDevice[]; scenes: Scene[] }>;   // read-only
  read(ids?: string[]): Promise<HomeDevice[]>;         // from the backend, every time
  subscribe(on: (change: DeviceChange | DeviceEvent) => void): () => void;
  // Turns a model command into the connector's own ledger task. Never called outside the ledger worker.
  plan(device: HomeDevice, command: Command): { title: string; goal: string; inputs: unknown; tier: Tier; expect: Expect };
  // Reads the device back from the backend until it settles on `expect` or the window ends.
  readBack(device: HomeDevice, expect: Expect, windowMs: number): Promise<ReadBack>;
  camera?: {
    snapshot(id: string): Promise<{ bytes: Uint8Array; type: 'image/jpeg' | 'image/png'; at: string }>;
    stream(id: string, prefer: ('webrtc' | 'hls' | 'mjpeg')[]): Promise<StreamSession>;   // Section 5
    events(id: string, since: string): Promise<CameraEvent[]>;
    clips?(id: string, range: { from: string; to: string }): Promise<ClipRef[]>;
    clip?(ref: ClipRef): Promise<ReadableStream<Uint8Array>>;
    ptz?(id: string, move: PtzMove): Promise<void>;
  };
}
```

- **One connector, one adapter.** The Home Assistant connector keeps its manifest, worker, routes and tests, and gains `HomeAdapter`. It doesn't get a second code path for control: `plan` produces exactly the inputs its existing `POST /services/{domain}/{service}` route produces.
- **Identity across bridges.** The same camera can reach Nova through Scrypted and through Home Assistant.
  - Each stays its own record.
  - Where both backends report a shared identifier (a MAC address, serial or ONVIF endpoint), the page asks once: "the same camera through two bridges?". The person picks the one that serves it, with Scrypted suggested for cameras.
  - Nova never merges two records silently.
- **What Nova stores:**
  - **Kept:** the person's overlay, as profile settings keyed by device id: favourites and their order, hidden devices, a room for a device whose backend has none, scenes, comfort band, and tier marks. Plus the last reading for display.
  - **Never kept as truth:** state. The page shows the last reading with its age when the backend is out of reach. A command never starts from the cached state: `plan` and `readBack` both go to the backend.
  - **Rooms** come from the backend's areas. An overlay room is used only where the backend has none, and the page says which is which.

### Read-back

The verifier rule stays: only a reading Nova took itself counts as proof (`confirm` in `home-assistant.ts`). Two things are new:
- **Settling:** today `run` reads the entity once, straight after the call. A cover or lock passes through `opening` or `locking`, so `readBack` instead waits, by events and then one REST read, until the state settles. The window is per capability (proposed: 10 s for lights, switches and media, 60 s for covers and locks, 120 s for climate's `action`). A transitional state at the end of the window is reported as such ("still opening after 60 s"), never as done.
- **Attributes:** `EXPECT` today checks only the state string. The model's `Expect` also covers attributes (a brightness within 1%, a target temperature exact, a cover position within 2%), as each backend reports them.

## 2. The backends, in order

### (a) Home Assistant: extending the M5 connector

- **Import:** the area, device and entity registries over the WebSocket API that the connector already opens (`config/area_registry/list`, `config/device_registry/list`, `config/entity_registry/list`). Each entity maps to a capability by its domain and device class. An entity's area wins over its device's. Hidden and disabled entities are left out.
- **States and events:** the existing `/api/states` reads and `state_changed` subscription. The subscription feeds the device model as well as the trigger engine: today `changed` emits only for topics a rule listens to, and the model needs every change for the page.
- **Commands:** the existing service-call worker, unchanged in kind (Section 4).
- **Cameras: Home Assistant's own stream proxy.** Nova builds no media server in v1.
  - Snapshots through `/api/camera_proxy/<entity>`.
  - Live through the stream Home Assistant offers for that camera: WebRTC where it has one; otherwise its HLS stream (the WebSocket `camera/stream` command); otherwise MJPEG (`/api/camera_proxy_stream/<entity>`).
  - Events come from the camera's related entities, such as motion and doorbell binary sensors.
  - Home Assistant has no general clip API. Its clips stay where they are in S1.
- **These API names are Home Assistant's public ones as the builder knows them, and are not yet checked against a real instance.** The fake implements them. S1 re-reads Home Assistant's current docs, and the owner's real check confirms them (Section 8).
- **What it reaches:** most ecosystems that Home Assistant already bridges (Nest, SmartThings, Ring, Reolink through Home Assistant), through one adapter. Home Assistant stays a swappable adapter, never a requirement.

### (b) Scrypted: a new connector, camera-first

- **Why:** it is the better camera bridge. It has streams, snapshots, and rich events (person, vehicle, animal or package, where its detection plugins provide them), so cameras are first-class rather than Home Assistant's lowest common denominator.
- **What Nova uses**, in Scrypted's own interface names from its published SDK (also not yet checked against a real instance):
  - `VideoCamera` (stream options and streams), `Camera` (snapshots);
  - `MotionSensor`, `ObjectDetector` (detections with Scrypted's own scores);
  - `VideoClips` (the clips Scrypted NVR keeps);
  - `PanTiltZoom`, `Intercom`;
  - lights, switches and locks that Scrypted exposes map to the same capabilities.
- **Detections from Scrypted are a signal of their own.** They arrive as camera events labelled `source: scrypted`, with Scrypted's score shown as the bridge's score. They are never presented as a calibrated Decision Service judgment (Section 5). In local-only mode, they are the local classification path.
- **How Nova talks to it:** Scrypted's client protocol, spoken directly by the connector, or its HTTP endpoints, whichever S1's plan finds sufficient. Nova has no runtime dependencies (LEDGER), so pulling in Scrypted's client library would be a new one (Conflicts row 10).
- **Commands, read-back, tiers and the ledger:** as for Home Assistant. A Scrypted connector gets a worker of its own, with the same `effects: 'external'` rule: after a failure the ledger asks again rather than calling twice.

### (c) Direct vendor and local, by demand

- **Local first:** the Reolink local API and ONVIF (Profile S for streams, Profile T where present, and events), for people with neither bridge. Built when someone needs it, each with a short plan.
- **Vendor clouds** (Google SDM for Nest, Reolink Cloud, Ring and others) are connectors the person opts into, one per vendor:
  - **Off by default.** The connect card says plainly what leaves the home: the vendor's cloud sees each command and serves each stream.
  - **Never in local-only mode.** In local-only they aren't offered, and an existing one pauses, as `ctx.permits` already pauses a remote Home Assistant.
  - **Streams and clips** from these cameras travel the vendor's cloud by nature (the correction). The page marks such a camera with its path (`vendor-cloud`).
  - **Sign-in** is OAuth through the broker (Section 7). Vendor accounts, keys and any spend are the owner's call (Section 10).

### (d) Matter

Out of scope. A Matter controller (commissioning, fabrics, Thread border routing) is a separate future ADR. Matter devices usually reach Home Assistant or Scrypted in the meantime.

## 3. The page

**Where it lives:**
- **A destination,** `smart-home`, at `/smart-home`, labelled "Smart Home". It isn't called "Home": that is the Ambient Home.
- **On a phone:**
  - The bottom tabs stay as DESIGN-SYSTEM §5 fixes them (Home, Chat, Tasks, Memory, More).
  - The way in is the **Smart Home card** on the Ambient Home, which the design system already reserves. Smart Home is also under More.
- **On a tablet or desktop:** under More. Once a backend is connected, it moves into the rail's primary set. That keeps the rail at orb plus five, within the limit of six.
- **The Smart Home card on Home:** a headline count ("3 on"), and at most two tiles: the first favourites, with a camera preferred if there is one. This follows the reference image.
  - With no backend connected, the card isn't shown on Home.
  - If discovery found a hub, the card offers it instead ("Found Home Assistant on this network", with one action: "Connect").
  - Density stays capped.

**The page, phone first** (one column; the same structure on wider screens, in more columns, within `layout/content-max`):
1. **A status line:** a one-sentence summary of what matters, for example "Everything is locked. 3 lights on. 2 cameras live." Any device needing attention comes first ("The back door lock is jammed").
2. **Favourites:** a row of tiles, chosen by the person.
3. **Cameras:** a grid of snapshot tiles, two across on a phone, refreshing every few seconds while the page is visible and stopping when it isn't. Tapping a tile opens live view.
4. **Scenes:** a row of scene buttons.
5. **Rooms:** one card per room. Each card shows the room's name, one summary line, and up to four tiles, with "n more" opening the room.

**Tiles:**
- A tile is the capability's minimum: name, state, and one primary control (toggle, slider or open).
- Detail is one layer down, in a sheet: every attribute, history from the backend where it has one, the backend and room, the tier marks, and the device's recent ledger entries.
- **Cameras:**
  - Full-screen live view, with the event list and clips below it.
  - PTZ and talk appear only where the backend supports them. Where one doesn't, the view says so plainly ("Pan and tilt aren't available for this camera through Home Assistant").
  - A vendor-cloud camera's tile says "via <vendor>'s cloud".
- **Devices the model doesn't cover** show as read-only `other` tiles in their room.

**Empty states** follow Amendment B: orient, state the value, offer exactly one action. "Nothing needs you" stays a valid, designed state.

| Situation | Says | One action |
|---|---|---|
| No backend connected | "Smart Home shows your lights, locks and cameras in one place. Nova asks before changing anything." | "Find my home hub" (starts discovery) |
| Discovery found nothing | "Nova didn't find Home Assistant or Scrypted on this network." | "Enter an address" |
| Connected, no favourites | "Pin the devices you use most, and they'll be here and on Home." | "Choose favourites" |
| No scenes | "A scene sets several devices at once, like 'Good night'." | "Make a scene" |
| A room with no devices the model covers | "Nothing here Nova can show yet." | "See what's in this room" (opens the `other` tiles) |
| Local-only, with a vendor-cloud camera | "This camera works through <vendor>'s cloud, and Nova is set to local-only." | "What local-only means" |
| A backend unreachable | "Last known at 14:32. Nova can't reach Home Assistant right now." | "Check Home Assistant" (opens its Health row) |

- **No skeleton is shown that isn't true:** before the first reading, the page uses `showWaiting` like Home does, shaped like the page.
- **Two starter packages, one layout:** both Orb Teal and Companion Light render the page identically in structure, using tokens only (`lint:tokens`).

## 4. Control

**The path, unchanged in kind:**
1. A command is a model command on a device (from a tile, chat, a scene or an automation).
2. The adapter's `plan` turns it into the connector's existing ledger task: the same inputs, title and plain-words goal as `POST /services/{domain}/{service}`, with `approval_tier` set to the model's tier (Section 1).
3. The ledger gate holds it: tier 2 waits for an OK, and tier 3 needs an explicit confirmation (`ledger.ts approve`). The worker refuses a brief whose tier is below what the domain needs, as it does now.
4. The worker calls the backend. `readBack` reads the device back from the backend itself until it settles.
5. The verifier checks that reading against the expectation. The task closes as Verified, with the reading as its evidence, or as Failed, with what Nova actually read.

**The page while a command is pending,** under DESIGN-SYSTEM §1's progress rules:
- **At once (within 0.1 s):** the tile marks the request and names it: "Turning on…". The tile never shows the target state as if it were real.
- **Waiting for the person (Nova-initiated commands only):** at tier 2 and 3, the tile says "Waiting for your OK" and the approval sheet opens. A direct tap skips this at tiers 0–2, and asks one on-tile confirm at tier 3 (owner decision 1). The sheet names the device, the room and the exact change, with the tier's standing-out primary action. Until the owner decides Conflicts row 1, a tier-2 tap opens the sheet: nothing is loosened by this ADR.
- **Running:**
  - Under 1 s: no indicator.
  - 2–10 s: a spinner in the tile only.
  - Over 10 s (a garage door): the real phase and elapsed time ("Opening, 14 s"), and the backend's position when it reports one. No percentage without real units.
- **Verified:** the tile shows the new state, read back, with the Verified affordance (tap for evidence: the ledger entry and the reading).
- **Failed:** the tile shows what Nova actually read, in plain words, with one action:
  - "The back door is still locked. The lock says it's jammed." Action: "Open the task".
  - "Home Assistant didn't answer." Action: "Try again". A retry of an external call asks again (`retry`, `asks_again`).
- **Changed elsewhere meanwhile:** the tile follows the backend's events. If the device reaches a different state from someone else's action, the tile shows that state, and the task reports what it read.
- **Many at once:** a scene is one parent task with one child per command (the ledger's `parent_id`). It needs one approval at the scene's tier, and the sheet lists every command. The page shows each device's own result, and the scene's outcome counts verified results ("4 of 5 done; the blind didn't move").

**Through chat and automations:** the same path. A command Nova starts by itself (proactive, or from a rule) always asks at its tier, whatever the person decides for direct taps on the page. Camera events never lower a tier (Section 5).

## 5. Cameras

### Live view: ordinary use

- **Viewing your own cameras in your own console is tier 0.** That covers the snapshot grid, live view, the event list and clip playback. Nothing goes in the ledger for a view.
- **A view log** keeps who watched which camera and when, from which device, in Activity. It is not a task, and it is kept for the same time as Activity (Open question 6).
- **Viewing isn't capture.** Live frames pass through to the viewer and aren't stored by Nova. Storing is Section 5's clips, under capture consent.

**Stream paths, as corrected by the owner:**

| Camera | Path, in local-first and cloud modes | In local-only mode |
|---|---|---|
| Bridge-fed (Home Assistant, Scrypted, ONVIF or the Reolink local API) | Over the LAN or mesh, through the hub (below) | The same |
| Vendor-cloud (Nest through SDM, Reolink Cloud, Ring…) | Through the vendor's cloud, with the person's opt-in | **Off.** Not offered; an existing one pauses |
| Remote viewing of a bridge-fed camera | The tailnet by default. A backend's own cloud path (for example a Home Assistant or Scrypted remote-access service) only with the person's opt-in for that backend, off by default, with a plain notice of what passes through it | Tailnet only |
| Through Nova's own relay | The hub, or another device the person runs. If the active hub is a cloud site, that is the person's own infrastructure off the home's machines, and it follows the capture data path's cloud-hub rule | Refused when the active hub is a cloud site: the view says why |

**"Through the hub", read concretely (proposed):**
- **The hub owns every view session.** The console asks the hub. The hub holds the backend credential and returns a short-lived, single-viewer ticket bound to the person's console session. The console never holds a backend token.
- **Formats, in order:**
  1. WebRTC, which every target browser plays with no library;
  2. HLS where the browser plays it natively;
  3. MJPEG or snapshot refresh, which always works.

  Nova adds no third-party player script, in keeping with the no-runtime-dependency rule and "`ui/` loads no third-party script".
- **Who carries the media:**
  - WebRTC: the hub carries the signalling, and the media goes over the LAN or tailnet between the viewer and the bridge.
  - HLS and MJPEG: when the viewer can't reach the bridge directly, the hub relays the bytes, unchanged.
  - Nova never transcodes or records in v1, and runs no media server. Relaying WebRTC media through the hub is not in v1.
- **No public STUN or TURN server** is used in any mode by default. A public STUN request would tell a third party where the viewer is.

### Export and share: tiered

| Action | Tier | Notes |
|---|---|---|
| Play a clip the backend holds | 0 | Viewing |
| Save a clip or snapshot to this device (download) | 1 | Done and reported in the ledger. The file carries its provenance (camera, time, backend) |
| Share a clip outside the home (a link, a message, an upload to a service) | 2 | Sharing data externally, NOVA-SPEC §6. The sheet shows who receives it and where it goes. In local-only mode, a cloud destination is refused |
| Turn on "keep clips in Nova" for a camera | 3 | It is a capture consent (below), and changing permissions is tier 3 |
| Delete a clip Nova keeps | 3 | Data deletion |
| Delete a clip at the backend | 3 | A separate action, offered only where the backend supports it, and reported separately |

### Clips: capture-class data

- **Clips the backend holds** (Scrypted NVR, a vendor cloud) stay there under the backend's retention. Nova lists and plays them on demand and doesn't copy them. The page says where each clip lives.
- **Clips Nova keeps** are capture, under CONTEXT-AND-CAPTURE and the capture data path:
  - **Consent:** "keep clips in Nova" is per camera, off by default. A camera becomes a capture source (adapter `camera`, kind `camera`; a packet edit, see NOTES). It has the visible indicator while it is on, and it is pausable and excludable by time window. Clip audio is off by default and has a consent of its own, with a plain notice that recording people who haven't agreed can be restricted where the person lives.
  - **Provenance:** every clip carries the camera's device id and name, the adapter and backend instance, the backend's event id, the capture time (the camera's clock as the backend reports it, and the hub's receipt time), and checksums.
    - A camera is not an enrolled Nova device and has no mesh key. So the **Nova device that fetched it** (the hub, or the spoke holding the connection) signs the transfer manifest with its own mesh key, and the camera and bridge are recorded as the capture source.
    - The hub refuses a manifest from an unknown or revoked device, as the capture design requires.
  - **Retention:** a person-set policy per camera (proposed default: 30 days), applied like any capture retention.
  - **Archive:** clips go to the hub-configured archive target behind the storage adapter: hub disk, storage server, NAS (the capture design's NAS case is exactly this), or cloud object storage.
    - Cloud targets are encrypted on the hub before upload, with keys under the vault rules (the correction: cloud clip storage is an archive target under these rules).
    - Local-only mode forbids cloud targets.
    - Cold tiering and the single-copy warning apply as designed.
  - **Tombstones:** forgetting or deleting a clip removes Nova's copies everywhere: the spoke window, the hub index, the archive and the cold tier. The report is per holder, and "deleted everywhere" appears only when all have acknowledged. The backend's own copy is not Nova's, and the report says so ("Nova's copies are gone. Scrypted still keeps its own until its retention ends").
  - **A raw fetch** of a kept clip from a spoke or the cold tier is a ledger entry naming the item and the reason, as the capture design requires.

### Event classification

Through the Decision Service registry once it lands (DS1), never by an ad hoc call (its §7).

- **The template:** `camera-event`, as the Decision Service ADR's §5 sketches it:
  - Nouls: "is there a person in `frame`?", and likewise for a package, a vehicle and an animal;
  - a Box for each, with its companion Noul;
  - a Choice over the camera's named zones.

  Code turns the boxes into zone overlap. The template carries a pre-registered eval. Until that eval passes on the exact model version, its answers read **low** and the template ships advisory, said so in Health.
- **The frame:** the backend's snapshot at the event's time. It is a declared state field within the API's image limits. The decision log keeps the frame's hash and the coordinates, never the image.
- **Seats:**
  - Box needs images, and only the cloud Jev seat takes them.
  - Under the owner's decision 4 on the Decision Service ADR, Box on camera frames is a **per-feature opt-in, off by default**, with a plain notice of what leaves the machine. It is labelled preview while TypeSafe labels it so.
  - **In local-only mode, camera frames don't go to Box even with that opt-in on** (proposed; owner to confirm, Conflicts row 2). There, the local signals stand: raw motion, and the bridge's own detections.
- **Events carry probabilities.** A camera event entering the trigger engine has:
  - `source`: `motion`, `bridge-detection` or `nova-judgment`;
  - for a judgment: the template id and version, the seat and the pinned model that answered, the decision record's id, every probability, the bands, and `trusted`;
  - for a bridge detection: the bridge's class and score, labelled as the bridge's.
- **Automations can threshold** on these values ("a person at the front door after dark, with a probability of 0.7 or more"). This needs rule conditions on payload fields, which `triggers.ts` doesn't have today (rules match connector and topic only). It is S2's work. Raw motion stays available as its own signal.
- **A camera event proposes; it never acts above its tier.** An automation's action keeps its own tier whatever the confidence. Unlock, disarm and open keep tier 3, and a Box never justifies acting above tier 1 (the Decision Service ADR, §5).
- **Classes are things, never people.** Nova doesn't identify who someone is from a camera (no face recognition) in this design (Open question 7).

## 6. Discovery and the connect card

**Discovery runs when the person asks:** in onboarding (Amendment B Part 2's discovery step in M10f), in Settings › Connections, or from the page's empty state. It is tier 1: done and reported, with nothing connected and nothing stored beyond the list of what was found.
- **How it looks:**
  - Home Assistant: its mDNS (zeroconf) advertisement.
  - Scrypted: its mDNS advertisement if it makes one; S1 checks. If it doesn't, the card for Scrypted offers the address field.
  - ONVIF cameras: one WS-Discovery probe.
- **What it never does:** port scans, login attempts, default passwords, or anything that changes a device. A background rescan is off by default.
- **In the build:** discovery takes an injected transport. Tests run fake responders on loopback, and no test sends multicast on the host's network (Section 10).

**The connect card states what would be exposed before any credential is asked for:**
- **What was found:** the kind, its name and version (from the advertisement), and its address, with "on this network" or "over your mesh".
- **What Nova would be able to do:**
  - see every device this account sees, and hear when they change;
  - show camera live views;
  - change devices only after asking, at each device's tier, with unlocks and opening garage doors confirmed every time.
- **What it never does:** change anything without the person's OK; send anything off the network (the egress shown is `local`).
- **What it needs next:** a token, with how to make one. A dedicated Home Assistant user for Nova is recommended.

**Counts by room:** Home Assistant and Scrypted answer nothing about their devices without signing in, so counts by room can't be shown before a credential (Conflicts row 5). The proposed flow is therefore two steps, and nothing is imported or switched on until the second:
1. The card above, with no credential. The person gives the token, which goes straight into the broker (Section 7).
2. **A preview,** read-only: the device count by room and by capability, cameras listed, and anything that would be tier 3 named ("2 locks and 1 garage door will always need your confirmation"). The person confirms the import, or picks rooms to leave out.

   **Cancelling here** deletes the credential and revokes the token at the backend, as Disconnect already does (`disconnect`, `auth/delete_refresh_token`).
- **ONVIF cameras** answer a probe without credentials: their count, maker and model show before anything is asked. They are listed as "found, not connected" until a backend or a direct connector claims them, matched by address.

## 7. Credentials: through the broker

Once the broker's Phase 1 lands, every home credential is a broker ref and never a value in core (`docs/plans/vault-broker.md` §9 row 6):

| Credential | Ref (placeholder) | Bindings | Consent |
|---|---|---|---|
| Home Assistant token | `secret://home/<instance>/token` | `http` to the instance's origin, scoped to the paths Nova calls; `ws` to `/api/websocket` | Standing consent (tier 1) for state and registry reads, event subscription, snapshots and stream set-up. Service calls sit outside it, so each goes through the ledger at its tier (2 or 3), which matches the connector's rule today |
| Scrypted credential | `secret://home/<instance>/scrypted` | `http` and `ws` to the instance's origin, with a **pinned certificate** (Scrypted serves its own certificate on the LAN) | As above |
| Vendor cloud (S3) | `secret://home/<vendor>/oauth` | `http` to the vendor's API origin; OAuth with the broker's PKCE verifier | Standing consent for reads only. Never bound in local-only |

- **Stream tickets are derived session material.** A backend's live stream often comes back as a short-lived URL with a token the backend minted (for example a Home Assistant HLS path). It isn't the stored credential, and the broker's scrubbing doesn't know it. So:
  - the stream relay in the hub holds it only for that session;
  - it is never logged, never in a model's context, and never sent to the console (the console gets Nova's own ticket);
  - it expires with the backend's own expiry.

  This is a stated limit, next to the broker's own (its §9 Limits).
- **Class:** standard by default, so reads run at standing consent and every command still asks at its own tier. Whether a token that can unlock doors should be "sensitive" is Open question 3.
- **Before the broker lands,** Home Assistant's token stays in `vault.ts` as today, and the broker migrates it (its row 6). The Scrypted connector is a **new** kind of credential, so it is born on the broker, as the broker ADR's §13 asks for new kinds (Placement).
- **Never:** a credential in the repository, a fixture, a log, a receipt, a decision record or a model's context. Tests use canary tokens, and a canary must never appear in any of those (the broker's gate pattern).

## 8. Phases

Each phase is its own PR or set of PRs, with its own gate, an independent review (adversarial for S1b's stream relay and credentials, and for S2's clip archive and egress), CI, and a merge. The preview is restarted after each. Gate evidence goes in `docs/evidence/s<n>-gate.md`.

### S1: the model, the page, Home Assistant and Scrypted

**S1a: the device model and the page, over Home Assistant.**
- The device model, `HomeAdapter`, the tier map, and the comfort band setting.
- The Home Assistant import (areas and registries), states, events, read-back with settling, and cameras through its stream proxy (snapshots, live, motion and doorbell events).
- The page (rooms, favourites, scenes, cameras), the Smart Home card on Home, and the destination.
- Discovery (Home Assistant and ONVIF) and the two-step connect card.

**S1b: Scrypted.**
- The connector: cameras, snapshots, streams, motion and detection events, clips listed from Scrypted NVR, PTZ where supported.
- The stream relay with tickets, the identity question across bridges, and Scrypted in discovery.

**S1 gate, on stand-ins:**
- **The model:**
  - import from the fake Home Assistant with areas, devices and entities. Every capability maps, hidden and disabled entities are left out, and an entity's area wins;
  - an `other` tile for an unmapped domain.
- **Tiers:**
  - every row of the capability table is enumerated in a test, including that the model never lowers the connector's tier;
  - the comfort band: a heat request above it asks at tier 3, and widening the band needs `confirm`;
  - a tier-3 mark on a switch holds.
- **Control:**
  - a light from the page goes through the ledger's gate and closes Verified from a reading Nova took itself;
  - a cover reaches `open` through `opening` within its window;
  - a lock that ends `jammed` closes Failed, with that reading shown;
  - the backend changing state mid-task shows the backend's state;
  - a scene is one approval, and the page shows a result per device.
- **The page:**
  - browser tests at phone and desktop widths, in both starter packages;
  - every empty state in the table shows its one action;
  - the pending, waiting, verified and failed tile states;
  - the timing bands (no indicator under 1 s; a spinner from 2 s);
  - the rail stays at six or fewer;
  - M9's budgets hold;
  - `lint:tokens` passes;
  - `ui/` loads no third-party script, and `package.json` gains no runtime dependency.
- **Truth:** with the fake stopped, the page shows "last known at …", and no control sends from the cached state.
- **Cameras:**
  - snapshots and live view from synthetic frames, with WebRTC signalling against the fakes, and HLS or MJPEG through the hub;
  - a stream ticket refused for another session and after its expiry;
  - no backend token reaches the console (the network log is scanned) or any log;
  - viewing creates no ledger task and stores no frame;
  - **local-only:** a vendor-cloud camera stand-in is off with its notice, and a cloud remote path isn't offered.
- **Discovery:**
  - fake mDNS and WS-Discovery responders on loopback;
  - the card shows no credential field until the person continues;
  - the preview shows counts by room before import, and cancelling there revokes the token at the fake;
  - a test fails if discovery opens a socket on a non-loopback interface.
- **Credentials:** canary tokens never appear in a transcript, log, receipt, ledger entry or the console's network log. Scrypted's binding needs its pinned certificate.
- **Scrypted (S1b):** the fake Scrypted's cameras, events and clips map. Its detections arrive labelled as the bridge's and never as a judgment.
- **The fresh-user test** passes. With the QA harness (Stage 2) in place, the page's flows are added to its catalogue, asserted from this ADR rather than from the code.

**S1 gate, owner-assisted (the owner's step, per standing rules):**
- **A real Home Assistant.** This is the check the M5 connector still owes, since it has only met the fake, extended to S1:
  1. connect;
  2. the preview's counts match Home Assistant's own;
  3. a light on and off, verified;
  4. a lock at tier 3, if there is one;
  5. a camera's snapshot and live view on a phone;
  6. disconnect revokes the token.
- **A real Scrypted:** the same, camera-first. Live view on a phone over the tailnet; one person detection arriving with its source labelled; a clip listed and played.
- **How they are recorded:** the build ships a written checklist in the gate evidence and stops there. Nova runs nothing against the owner's network or devices without the owner's OK (Section 10). Until the owner runs them, the gate evidence lists them as owed. Docs and onboarding say Home Assistant and Scrypted support is "tested against stand-ins", under Amendment B's closing rule. Their results are recorded when the owner has run them.

### S2: intelligence, clips, scenes and automations

- **Camera event classification:** the `camera-event` template, its pre-registered eval, the Box opt-in, and probabilities on events. **Needs:** DS1 merged; the owner's account route for Jev (the Decision Service ADR's open question 2) before any live call.
- **Rule conditions on event fields** in `triggers.ts`, for thresholds.
- **"Keep clips in Nova":**
  - consent, retention, and the capture kind `camera`;
  - clips into the archive with signed provenance;
  - tombstones;
  - export and share at their tiers.

  **Needs:** the archive and storage adapter from the capture data path's build (M10h). If M10h doesn't build the archive, S2's clip part waits for it, and that is reported.
- **Scenes and automations polish:** scenes as automation actions, and scenes made from the current state.
- **Two-way talk** where the backend supports it.
- **Gate:**
  - the template's eval passes its bounds on the seat it's relied on for, or it ships advisory, said so in Health;
  - every truth-table row is enumerated;
  - **in local-only, no frame reaches the Jev stand-in, even with the opt-in on;**
  - a rule thresholds on a probability, and a below-band answer doesn't fire;
  - a camera event's automation never runs above its tier;
  - the capture data path's M10h list, applied to clips: sync and dedupe, offline resume, a tombstone's acknowledgement, a ledgered raw fetch, and local-only with a cloud target refusing;
  - a manifest from an unknown device is refused;
  - a share at tier 2 shows its destination, and is refused toward a cloud destination in local-only.

### S3: by demand

- **Direct local connectors** (the Reolink local API, ONVIF), each with a short plan and the same gate shape as S1b.
- **Vendor-cloud connectors** (Google SDM first, if asked for), opt-in, never in local-only. Each needs the owner's OK for any account, key or spend.
- **Matter** isn't a phase of this milestone. It gets its own ADR.

## 9. Placement

**The order today:**
- In flight: M10d (PR #241) and M10e (PR #247).
- Then M10f to M10k.
- Then **QA Stage 2**, the milestone after M10k on the critical path (Amendment A, as placed in the LEDGER), followed by Amendment B Part 7.
- Side tracks: Tev1 (#248), the eval harness (#249), the Decision Service (#250) and the Credential Broker (#251).

**Proposed:**
1. **This ADR** lands now, as a docs PR. Nothing in it is built until its phase comes.
2. **M11 — Home (S1–S3) comes after QA Stage 2 on the critical path,** and after Amendment B Part 7, which already follows Stage 2.
   - It displaces nothing.
   - The page is a large new surface, and the QA harness's change-aware flows then cover it from its first PR.
   - It is a new milestone, which the owner's input asks for ("likely a new milestone after the M10 chain"). The owner named it **M11 — Home**, with phases S1–S3 as the input names them (owner decision 8). The page itself is labelled "Smart Home".
3. **What it needs first:**

   | Phase | Needs | If not ready |
   |---|---|---|
   | S1a | M10f's discovery step (Amendment B Part 2), which S1a extends | S1a builds discovery as Settings › Connections only, and joins onboarding when M10f is there |
   | S1b | The broker's Phase 1, because Scrypted's credential is a new kind | S1b waits. S1a doesn't: Home Assistant's token is migrated by the broker's own row 6 |
   | S2 (classification) | DS1 merged; the owner's Jev route before any live call | Built against the Jev stand-in; the template ships advisory |
   | S2 (clips) | The archive and storage adapter from M10h | Waits, and says so |

4. **Earlier work isn't pulled forward.** The M5 real-Home-Assistant check stays where the LEDGER has it, as the owner's to run at any time. S1's owner-assisted check extends it when S1 arrives.

## 10. Hard limits during the build

These follow M10.md's and M10-orchestration.md's, and the build never crosses them:
- **Stand-ins only:**
  - the extended `scripts/fake-home-assistant.js`;
  - a new `scripts/fake-scrypted.js`;
  - a fake ONVIF and mDNS responder;
  - a loopback Jev stand-in (from DS1).
- **Camera fixtures are synthetic:** generated test patterns and shapes. No real footage, and no image of a real person.
- **No real devices:** no real Home Assistant, Scrypted, camera, lock or other device is contacted by the build. The real checks are the owner's (Section 8).
- **No LAN scans of the owner's network without their OK:** no multicast, broadcast, mDNS query, WS-Discovery probe or port probe on any non-loopback interface. Discovery tests use an injected transport, and a test fails if a socket binds elsewhere.
- **No vendor-cloud calls:** no Google SDM, Reolink Cloud, Ring or other vendor API, and no account. Vendor connectors in S3 are built against stand-ins.
- **No TypeSafe or OpenRouter calls,** as the Decision Service ADR says, and no frame leaves the machine.
- **No real credentials:** canaries only. No token on the owner's machine is read, including the preview's vault.
- **No new runtime dependency** (no Scrypted client library, no video player script) without a recorded owner decision. No media binaries installed.
- **The preview** serves only what is built. Nothing on the running preview is changed live.

**What would need the owner's OK to go real:**
- connecting the build to a real Home Assistant or Scrypted, and running the S1 checklist;
- a discovery scan on the owner's network;
- any vendor-cloud account, key or spend;
- a live Jev call with a camera frame;
- a real camera clip stored in an archive;
- any new runtime dependency.

## 11. Conflicts and open questions

Each place where the inputs pull against each other or the packet, with its resolution. None is resolved silently.

| # | The pull | Resolution proposed | Status |
|---|---|---|---|
| 1 | The input keeps lights and switches at **tier 2**, on the unchanged path, and NOVA-SPEC §6 puts "changing devices/home state" at tier 2 ("ask first"). But a tap on a tile, or the reference image's slider on the Home card, is itself the person asking for that exact change, and an OK sheet after every light tap is a second ask | **Proposed:** a tap on the page by the person, on a tile that names the exact change, is both the request and the tier-2 approval for that one command. The ledger records "approved by your tap". Commands Nova starts itself (chat proposals, automations, scenes it suggests) still ask. Tier 3 always confirms. **Until decided, the build keeps today's rule** (a tier-2 tap opens the sheet), so nothing is loosened by this ADR | **Needs owner decision** |
| 2 | The Decision Service decision lets single camera frames go to cloud Jev for Box as an opt-in **in every mode, including local-only**. The correction says **cameras stay local in local-only mode** | **Proposed:** in local-only mode, camera frames don't go to Box even with the opt-in on, because the camera rule is the more specific one. Local signals stand there: motion and the bridge's own detections. In local-first and cloud modes, the opt-in works as decided. Screen frames under decision 4 are untouched | **Owner to confirm** |
| 3 | Vendor clouds | Opt-in only, and never in local-only mode, as the instruction says. In local-only mode they aren't offered, and an existing one pauses | No decision needed |
| 4 | The Decision Service ADR's §5 says Box frames go "only in cloud mode"; its owner decision 4 says "in every mode" | The owner's decision governs, narrowed for cameras by row 2. The Decision Service ADR's §5 wording should follow its decision (NOTES) | No decision needed |
| 5 | The instruction asks for "what would be exposed (device counts by room) before any credential". Home Assistant and Scrypted reveal nothing about their devices without signing in | The two-step card (Section 6): what kind of access, before any credential; then a read-only preview with counts by room **before anything is imported or switched on**. Cancelling there revokes the token. ONVIF cameras show counts before any credential | **Needs owner decision** (whether the two steps meet the intent) |
| 6 | The broker ADR's §5 allows a LAN device by IP or private name **only with a pinned certificate**, and `https` only. A typical Home Assistant serves plain `http` on the LAN (the connector's own placeholder is `http://homeassistant.local:8123`), and today's connector accepts it | **Proposed:** keep the broker's rule as the default and recommend TLS. Allow plain `http` only to an address that resolved local at connect (`resolved_local`), or to a tailnet host (which WireGuard encrypts), with a plain notice that the LAN path isn't encrypted. A pinned certificate where Home Assistant has TLS | **Needs owner decision** (an exception to the broker's rule) |
| 7 | "Bridge-fed cameras stream through the hub", while WebRTC media normally flows directly between the viewer and the bridge | **Proposed reading:** the hub owns every session (tickets, signalling, credentials). The media flows over the LAN or tailnet, direct for WebRTC, or relayed byte-for-byte by the hub for HLS and MJPEG. No transcoding, no media server, and no public STUN or TURN | No decision needed unless the owner reads "through" as "every byte" |
| 8 | Camera clips are capture-class, and the capture design signs manifests with the **originating device's** mesh key. A camera isn't an enrolled device | The Nova device that fetched the clip signs, and the camera and bridge are recorded as the capture source. The capture kinds gain `camera` (a CONTEXT-AND-CAPTURE edit, NOTES) | No decision needed |
| 9 | The instruction: "heating is higher" | Starting heating, or a target above the comfort band, is tier 3. Changes within the band are tier 2. The band has a neutral default and is set at setup | **Owner to confirm** (the band rule and its default) |
| 10 | Scrypted's own client library would be Nova's first runtime dependency (LEDGER: runtime, none) | S1b speaks Scrypted's protocol or HTTP endpoints itself. A library comes in only by owner decision, with its justification | No decision needed now; one is needed if S1b finds the protocol impractical |
| 11 | Scrypted (and similar bridges) produce their **own detections and scores**; the instruction routes classification through the Decision Service | Both exist and are labelled: bridge detections as `bridge-detection` with the bridge's score, and calibrated judgments as `nova-judgment`. Only the latter carries Decision Service probabilities and a trust verdict | No decision needed |
| 12 | Live view is "ordinary use, no friction", and CONTEXT-AND-CAPTURE puts capture off by default, with an indicator | Viewing isn't capture: nothing is stored. Keeping clips is capture, off by default per camera, with its indicator and tier-3 consent | No decision needed |
| 13 | DESIGN-SYSTEM's "Devices" card means Nova's own mesh devices | Smart-home things are "home devices" in code and are shown only in Smart Home. The Devices card is unchanged | No decision needed |
| 14 | The phone is the primary design target, and the phone's bottom tabs are fixed | The Smart Home card on Home is the phone's way in, one tap away. The tabs don't change | No decision needed |

**Open questions for the owner.** Decided on 2026-10-31 (see Owner decisions at the top); only question 3, the class of a home token, stays open, on its proposed default. The proposals are kept below for the record.
1. **A tap is the approval** (Conflicts row 1). *Proposed:* yes for tier 2 on the page, never for tier 3 or for anything Nova starts itself. *Default until decided:* today's ask-first sheet.
2. **Camera frames to Box in local-only** (row 2). *Proposed:* no; the camera rule wins.
3. **The class of a home token.** A Home Assistant token can unlock doors. *Proposed:* standard class, so reads run at standing consent and every command asks at its own tier. *Alternative:* sensitive, so every use asks first, including reads, which would make the page unusable.
4. **Locking a lock.** Today the whole `lock` domain is tier 3, so locking is too. *Proposed:* keep it, because the domain rule is unchanged. *Alternative:* `lock` at tier 2, since it makes the home safer, and `unlock` stays 3.
5. **The two-step connect card** (row 5), and **plain `http` to a LAN Home Assistant** (row 6).
6. **The camera view log.** *Proposed:* kept in Activity (who, which camera, when, from which device) for Activity's retention. *Alternative:* no log of views.
7. **No face recognition.** *Proposed:* Nova classifies things (person, package, vehicle, animal), never identities, in this milestone. Any identity feature would need its own design and consent.
8. **The milestone's name.** *Proposed:* "Smart Home", phases S1–S3, placed after QA Stage 2. Calling it M11 is the owner's choice.
9. **The heating rule and comfort band** (row 9).

## NOTES for Track 1

Shared files this ADR doesn't edit. The exact text is proposed for Track 1 to apply.

**`docs/LEDGER.md`, under `## Decisions`:**

> **2026-10-31 (owner input: Smart Home and cameras; the ADR).** Branch `docs/smart-home-adr`. The owner-approved design `nova-smart-home-design-2026-10-31.md` was added to the packet exactly as given, including the owner's same-day change that cameras may go through the cloud outside local-only mode (sha256 `5c28dd8d…`).
> - **The design:** ADR `docs/plans/smart-home.md`.
>   - A device model by capability (light, switch with optional dimmer, climate, lock, sensor, cover, media, camera), fed by connector adapters.
>   - A phone-first Smart Home page (rooms, favourites, scenes, cameras) that is a view over the model, never a second source of truth.
>   - Control through the existing tiered service-call path, with read-back that waits for a settled state.
> - **Backends, in order:** Home Assistant (the M5 connector extended; cameras through Home Assistant's stream proxy, no media server in v1); Scrypted, camera-first; direct vendor and local connectors by demand. Vendor clouds are opt-in and never in local-only mode. Matter is out of scope.
> - **Cameras:**
>   - Live view is tier 0. Bridge-fed streams go over the LAN or mesh through the hub. Vendor-cloud streams and opt-in remote cloud paths are allowed outside local-only.
>   - Kept clips are capture-class: per-camera consent, provenance, retention, the archive, tombstones. Export is tier 1 and sharing tier 2.
>   - Classification goes through the Decision Service in S2, with probabilities on trigger events.
> - **Discovery:** Home Assistant, Scrypted and ONVIF, started by the person. A connect card comes before any credential, and a read-only preview with counts by room comes before import. Credentials go through the Credential Broker.
> - **Placement:** a new milestone, "Smart Home" (S1–S3), after QA Stage 2 and Amendment B Part 7. It displaces nothing.
> - **S1's gate** includes the owner-assisted real Home Assistant check (still owed from M5) and a real Scrypted check, both the owner's step.
> - **Open for the owner:**
>   - whether a tap on the page approves a tier-2 command;
>   - camera frames to Box in local-only (proposed: no);
>   - the two-step connect card;
>   - plain `http` to a LAN Home Assistant under the broker;
>   - the heating rule;
>   - the home token's class;
>   - the lock tier;
>   - the view log;
>   - no face recognition;
>   - the milestone's name.

**`docs/LEDGER.md`, a plain-language "What changed" entry for the owner:**

> **2026-10-31 · PR #<n> · Smart Home and cameras: the design**
> - **What changed:** the plan for a Smart Home page is written and waiting for your review. It shows your lights, locks, climate and cameras by room, and Nova controls them only through the same ask-first steps as today, checking each change afterwards.
> - **What you can now do:** nothing in the app changed: paperwork only.
> - **Still unfinished:** nothing is built. It comes after the QA harness milestone. Nine questions are waiting for you, the main ones being whether tapping a light on the page counts as your OK, and whether camera frames may go to Jev in local-only mode (proposed: no). The real Home Assistant and Scrypted checks will be yours to run when S1 arrives.

**`docs/builder-packet/ROADMAP-AND-GATES.md`: a new section, after "QA harness — Amendment 2026-10-31-A":**

> ## Smart Home and cameras (owner input 2026-10-31)
> Spec: `nova-smart-home-design-2026-10-31.md`, with the owner's same-day change on camera stream paths. Designed in `docs/plans/smart-home.md`. A new milestone after QA Stage 2 and Amendment B Part 7. It displaces nothing in M10e–M10k or Stage 2.
> - **S1:** the device model and the page over Home Assistant (areas and entities, cameras through its stream proxy), the Smart Home card, discovery and the connect card (S1a); the Scrypted connector, camera-first, born on the Credential Broker (S1b).
>   - **Gate:** the ADR's stand-in list, plus the owner-assisted real Home Assistant and real Scrypted checks, flagged as the owner's step.
> - **S2:** camera event classification through the Decision Service (after DS1), with probabilities on events; kept clips into the capture archive (after M10h's archive); scenes and automations; two-way talk.
> - **S3:** direct local and vendor-cloud connectors, by demand. Vendor clouds are opt-in and never in local-only. Matter gets its own ADR.

**`docs/builder-packet/CAPABILITY-INVENTORY.md`, the "Smart-home bridges" row, appended to its status:**

> **Designed (2026-10-31):** the device model, the Smart Home page, Scrypted and cameras (`docs/plans/smart-home.md`); not built yet.

**`docs/builder-packet/CONTEXT-AND-CAPTURE.md`, "The Capture API":** the kinds list `screen, audio, meeting, browser, app-activity, sensor` gains `camera`, for clips Nova keeps under per-camera consent (`docs/plans/smart-home.md` §5). Applied with S2, not with this ADR. The code's `KINDS` in `src/core/capture/rules.ts` follows in the same PR.

**Cross-links:**
- **`docs/plans/decision-service.md`** (PR #250):
  - §5's "Smart home" and "Camera event" rows gain: "Designed in `docs/plans/smart-home.md` §5 (S2)."
  - §5's "only in cloud mode" should read as its owner decision 4 does, with: "camera frames excepted in local-only mode (proposed in `docs/plans/smart-home.md`, owner to confirm)."
- **`docs/plans/vault-broker.md`** (PR #251), §9 row 6: "Scrypted and vendor-cloud credentials follow the same pattern (`docs/plans/smart-home.md` §7). Plain `http` to a LAN Home Assistant is an open question there (its Conflicts row 6)."
- **`docs/plans/M10-orchestration.md`**, "Resolved: the capture data path": "Camera clips Nova keeps use the same path (`docs/plans/smart-home.md` §5)."

**Found in passing, for Track 1:** `docs/LEDGER.md` on `main` still carries two leftover merge-conflict markers, at lines 59–60, right after the "CI: change-aware" decision:
- `||||||| parent of df775f41 …`
- `||||||| parent of 911bde48 …`

They should be removed in Track 1's next LEDGER edit.
