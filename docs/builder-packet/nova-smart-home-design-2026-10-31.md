Status: OWNER INPUT, approved by Jeremy 2026-10-31, with one owner change the same day: camera streams/clips MAY go through the cloud (local-only mode excepted). Asks for an ADR + phasing proposal (milestone placement after the M10 chain is the builder's to propose; nothing displaces in-flight work). Builds on the shipped M5 Home Assistant connector. See accompanying prompt + correction.

# Smart Home surface + cameras — design note (2026-10-31)

Status: Muse design for Jeremy's approval. Owner's ask: a Smart
Home page in Nova that shows and controls the home's devices —
cameras included — the way Apple Home / Nest / Google Home /
SmartThings / Home Assistant / Reolink apps do.

## What already exists (verified in repo, 2026-10-31)

- M5 built a Home Assistant CONNECTOR v1: entity states (tier 0),
  service calls as ledger tasks (tier 2; tier 3 for locks/alarms),
  verified by Nova's own read-back, HA `state_changed` events over
  WebSocket feeding the trigger engine, token in the vault. Tested
  against a fake HA only — a real HA is still the owner's manual
  check. Apple Home and Scrypted bridges: not built.
- The DESIGN-SYSTEM already reserves a Smart Home card in the phone
  Ambient Home layout.
So the plumbing (states, control, tiers, triggers) exists. Missing:
the PAGE, camera streaming, and camera-first bridges.

## The surface

A Smart Home page in the console (desktop + phone; the phone layout
is the primary design target — checking cameras is the phone use
case):
- **Home view**: rooms/areas with device tiles, favorites row,
  active scenes. Tiles follow the design system: minimum that
  matters, detail one layer down.
- **Device tiles by capability**, not by vendor: light, switch,
  dimmer, climate, lock, sensor (motion/contact/temperature/etc.),
  cover, media player, camera. One normalized capability model;
  adapters map vendor entities onto it.
- **Cameras**: live tiles (snapshot-refreshing grid; live stream on
  open/tap), full-screen view, event list (motion/person/clips from
  the bridge), clip playback. PTZ and two-way talk only where the
  bridge supports them, labelled honestly when absent.
- **Control** rides the existing tiered service-call path unchanged:
  lights/switches tier 2, locks/alarms tier 3, everything verified
  by read-back and written to the ledger. Scenes = named groups of
  calls via the trigger/action engine.
- **State** rides the existing connector state plumbing; the page is
  a view over the device model, never a second source of truth.

## Backends (adapters, in build order)

1. **Home Assistant (extend the M5 connector).** Import areas +
   entities into the device model; camera entities ride HA's own
   stream proxy (HA already solves RTSP→WebRTC/HLS for its cameras).
   This makes most ecosystems (Nest/Google, SmartThings, Ring, most
   Reolink-via-HA setups) reachable through one adapter — the same
   reason Nova treats HA as a swappable adapter, never a requirement.
2. **Scrypted (new connector, camera-first).** The owner's actual
   stack (Reolink → Scrypted → Apple Home) and the best camera
   bridge available: streams, snapshots, and rich events (person/
   vehicle/animal where its plugins provide them). A Scrypted
   connector makes cameras first-class instead of HA's lowest
   common denominator.
3. **Direct vendor/local + vendor clouds (by demand):** Reolink
   local API/ONVIF for users with neither bridge; vendor clouds
   (Google SDM for Nest, Reolink Cloud, Ring, etc.) as connectors
   where the user opts in. Per the owner's 2026-10-31 change,
   camera streams and clips MAY travel cloud paths (below) — the
   exception is local-only mode, where cloud camera routes stay off
   like everything else in that mode.
4. **Matter controller (long-term, own ADR).** The native end-state
   for local device control, and a milestone-scale effort
   (commissioning, fabrics, Thread border routing). Not v1; the
   bridge path ships years sooner and Matter devices usually reach
   HA/Scrypted anyway.

## Cameras as data (ties into settled designs)

- Stream paths follow the backend (owner change, 2026-10-31 —
  cameras may go through the cloud): bridge-fed cameras (HA/
  Scrypted/local) stream over LAN/mesh through the hub; vendor-cloud
  cameras stream via their clouds by nature; remote viewing may use
  a cloud path where the backend provides one, not only the tailnet.
  What does NOT change: local-only mode keeps cameras local like
  everything else in that mode; Nova's own relays, where used, are
  the user's infrastructure; and any cloud clip STORAGE is an
  archive target under the capture design's encryption rules.
- Recordings and event clips are CAPTURE-CLASS data: they inherit
  the capture data path's rules — provenance (which camera/device),
  retention policy, archive targets (the NAS case from the capture
  design is literally this), forget/tombstone deletion.
- Event intelligence via the Decision Service: snapshot frames →
  Box/Noul battery (person? package? vehicle? animal?) → events in
  the trigger engine with probabilities attached, so automations can
  threshold ("person at the front door after dark") instead of
  reacting to raw motion. Raw motion stays available as its own
  signal.
- Viewing your own home's cameras in your own console is ordinary
  use — no approval friction for live view. Exporting/sharing a
  clip outside the home is the tiered action.

## Discovery

Onboarding and Settings scan the LAN (the launch-research pattern):
a found Home Assistant or Scrypted instance is offered as a connect
card with what it would expose (device count by room) before any
token is requested. Reolink cameras found via ONVIF/WS-Discovery
are listed as "found, not connected" until a backend or direct
connector claims them.

## Phasing proposal

- S1: device model + Smart Home page + HA connector extension
  (areas/entities import, camera streams) + Scrypted connector
  (cameras + events + streams). Includes the owner's real-HA manual
  check the M5 connector still owes, extended to a real Scrypted.
- S2: camera event intelligence (Decision Service batteries),
  recordings/clips into the capture archive with retention,
  scenes/automations polish in the page.
- S3: Matter controller ADR + pilot; direct-vendor connectors by
  demand.
Milestone placement is the builder's to propose in the ADR (likely
a new milestone after the M10 chain); nothing here displaces
in-flight work.
