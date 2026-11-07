# Wake-on-LAN inference nodes (ADR, model-fit step 4, 2026-11-06)

**Sources:** the owner's direction, `docs/builder-packet/nova-device-model-fit-and-roles-2026-11-04.md`
("Wake-on-LAN inference nodes", "Hardware inventory", build order step 4; binding). The model-fit
ADR, `docs/plans/model-fit-adr-2026-11-04.md` (the inventory rows `wake.capable`,
`wake.latency_ms`, `wake.on_demand`, `wake.sleep_after_min` and `state`, and step 4). The model
manager: `src/core/models/` (`wake.ts`, `hardware.ts`, `index.ts`). The device agent:
`src/device/boot.ts`, `runtime.ts`, `workloads.ts`, and Decision 1 (the boot agent's five verbs) in
`docs/plans/M10h.md` §1 and `docs/plans/M10-orchestration.md`. Heartbeats: `src/core/mesh/spokes.ts`.
Replication: `src/core/mesh/sync.ts`. Who may call what: `src/core/mesh/access.ts`. Waiting text:
`ui/js/wait.js` (DESIGN-SYSTEM §1, binding). The services track: `src/core/services/placement.ts`.

**Status:** APPROVED by the owner, 2026-11-06, with all eight recommended defaults below accepted as the build's answers. This is the design; Nothing in Nova changes in this step. The
styleguide shows the proposed states (`/styleguide?entry=models-screen`, the states from "Asleep,
wakeable" on); screenshots are in `docs/screenshots/wol-design-2026-11-06/`. The build starts from
this document once it is approved; each golden case below is written to become one test.

**Hard exclusion, kept:** the private-address and egress classifiers (`hardware.ts privateAddress`,
the decision service's egress rules, `#spokeAddress`) are not changed by this design or its build.
The wake path only reads their answers.

## What exists today

Most of the wake path is built (M6b). The design builds on it rather than beside it.

| Piece | Where | What it does now |
|---|---|---|
| The magic packet | `wake.ts magicPacket` | Six `0xFF` bytes, then the MAC 16 times: 102 bytes. A malformed MAC throws |
| Sending | `wake.ts sendMagic` | One UDP datagram to `host:port` (port 9 by default) from an unbound socket with broadcast on |
| The network cards | `hardware.ts nics()` on the device, `checkHardware` at the hub | The device agent reports each IPv4 card's name, MAC, address and netmask in its heartbeat. The hub keeps a card only if its MAC is well formed and `privateAddress(address)` holds, and it computes the broadcast address itself (`broadcastOf`); a reported broadcast is never used |
| Storage | `device_hardware` (JSON), `device_wake` (migration 0010) | The last hardware per device, kept while it sleeps; every wake with when it was sent, when the models answered, the wait and the outcome (`not_sent`, `waiting`, `awake`, `no_answer`). Neither table replicates |
| Waking | `Models.wake()` / `#wake()` | Only a trusted, non-hub device. The runtime's address must be one of the device's own and private (`#spokeAddress`). The target is the card's broadcast address on port 9, or the person's override (`PUT /models/wake`, private only), else `255.255.255.255:9`. One wake per device at a time (`#waking`). It polls Ollama's `/api/version` every second |
| The wait | `#wake()` | As long as the last answered wake took, half again, plus 2 s; never measured, `wait_s` (120 s by default), said to be a guess |
| Routing | `Models.#local()` | When the assigned spoke's Ollama doesn't answer: a small job runs on the hub's model instead (with a note); otherwise Nova wakes it once. If it doesn't come up, the task waits ("Nova won’t keep waking it") under local-only, or follows the privacy mode's fallback |
| Who may wake | `POST /models/devices/{id}/wake` | The `person` scope: the console, or a person's paired browser or phone. A paired computer, a standby or a public caller can't |
| On screen | `models.js`, `device-models.js` | "Online" or "Asleep or away", "Last seen …; what shows is what it last reported", and wake words ("Wakes in about 38 s (measured)", "Can be woken; how long it takes isn’t measured yet", "Can’t be woken: no network card reported") |
| Planning while asleep | model-fit step 3 | The per-device Models screen plans against the last-seen inventory, stamped with its age (styleguide state "Asleep") |
| Tests | `tests/core/models.test.ts` | The packet bytes, read back by a loopback stand-in (`startFakeWol`); wake latency measured and reused; no wake for a small job |

What is missing, and what this ADR adds:

1. **No "same network" test.** The hub sends from whatever interface the OS picks, to any private
   target. `privateAddress` is true for the mesh's shared range (100.64.0.0/10), so a device that
   reports only its tailnet address can be "woken" at a broadcast address that never reaches it,
   and a broad netmask gives a broad broadcast.
2. **No sleep policy and no "wake on demand" choice.** Nothing puts a device to sleep, and every
   device with a network card counts as wakeable.
3. **No rate limit** beyond one wake at a time, and wakes are recorded only in the hub's own
   `device_wake`, not in the Work Ledger. After a failover the new hub has no hardware for a
   sleeping device, so it can't wake it.
4. **Only the hub sends,** so a device on a network without the hub can't be woken.
5. **Failures are one sentence.** "No sender", "sent but no wake" and "woke but unhealthy" are not
   told apart, and the screen has no Waking or Couldn't wake state.

## Decision

1. **A compute device is "wake on demand" only when the person says so and Nova can actually do it.**
   It needs: the `compute` role; the person's choice "When work needs it: Nova wakes it"; a recorded
   network card that passed the hub's checks; and a sender on that card's own network (point 3).
   Then, while it sleeps, it shows as **Asleep, wakeable**. Otherwise it stays "Asleep or away",
   with the reason.
2. **Its sleep policy is the person's: never sleep, or sleep after N idle minutes.** The hub keeps
   the policy. The device's own agent enforces it (point 6).
3. **The wake goes only onto the device's own network, from an always-on sender on that network.**
   In this build the sender is the hub. A boot agent on another network sending wakes is designed
   here but deferred (open question 2).
4. **Only Nova's routing and the person may wake a device,** rate-limited, and every wake (sent or
   refused) is written to the Work Ledger.
5. **A failed wake never sends work to the cloud silently.** Nova tries another awake device of
   yours where the model fits, then follows the task's privacy mode, and under local-first it asks.
6. **The device agent sleeps and holds the machine through one new boot-agent verb, `power`,**
   with three fixed arguments (`hold`, `release`, `sleep`) and no others. This amends Decision 1's
   fixed set from five verbs to six, and needs the owner's yes (open question 1).

## The model

### Device wake states

A device's wake state is derived at the hub from what it already knows. It is never reported by the
device itself.

| State | When | Pill and words (Models screen, device list) |
|---|---|---|
| `awake` | Heard from within the Online window (2 minutes, as today) | "Online" |
| `asleep-wakeable` | Not heard from; wake on demand is on; a card passed the checks; a sender is on its network; not paused (below) | "Asleep, wakeable", with the last-seen age and "Waking took 38 s last time" or "how long it takes isn’t measured yet" |
| `asleep` | Not heard from, and any of those is missing | "Asleep or away", with the reason in words (for example "Nova doesn’t wake it: you chose to wait until it’s turned on", or "none of your always-on devices is on its network") |
| `waking` | A wake is in flight | "Waking", with the task's waiting line |
| `woke-loading` | Its models answered after a wake, and the model is loading | "Awake", "Loading ⟨model⟩" |
| `wake-failed` | The last wake failed, and it hasn't been heard from since | "Couldn’t wake", the reason, and what Nova does instead |

While a device is in any asleep state, its last-seen inventory and catalog stay on screen, stamped
with their age, exactly as model-fit step 3 built it ("Last seen 2 h ago. What shows here is what it
last reported: its hardware 2 h ago, its models 2 h ago."). The plan, the budget bar and the picks
are all still there, so planning works against a sleeping device.

**Paused:** after a failed wake, automatic wakes of that device stop until it is heard from again
or the person presses "Try waking it again". This is today's per-task "won't keep waking it" rule,
applied to the whole device, so a dead machine doesn't get a wake for every queued task.

### The sleep policy

Per device, on the hub, in the profile's `models` section as `power.<device_id>`:

```
{ on_demand: boolean,                       // "When work needs it": Nova wakes it | Wait until it’s turned on
  sleep_after_min: null | 15 | 30 | 60 | 120 // "When it’s idle": Never sleep | Sleep after N minutes
}
```

- Default for a device that isn't set: `{ on_demand: false, sleep_after_min: null }`. That is today's
  behaviour: Nova never sleeps a device, and it wakes one only when the person turns this on. (Today
  Nova will wake any device with a card; this design makes waking opt-in. See open question 5.)
- The choices are a fixed list, not a free number, so the control is one `select` that fits a
  phone, and so the device agent can't be handed an odd value.
- Set with `PUT /models/devices/{id}/power` (the `person` scope; tier 1, since it is reversible and
  nothing leaves the devices), or from the Models screen's "Sleep and wake" section. The profile is
  replicated, so a hub that takes over keeps every policy without a migration.

**Who enforces it: the device agent.** The hub doesn't know whether someone is using the machine;
the device doesn't know whether Nova has work queued for it. So each tells the other:

1. The hub's heartbeat answer carries `power: { sleep_after_min, hold }`. `hold` is true while Nova
   has work running or queued for this device, or a model it loaded is still within its keep-alive
   (5 minutes, as `#local` sets it).
2. The runtime agent counts the idle time: `hold` false in every answer, and the OS reports no input
   from a person, both for `sleep_after_min` minutes. The OS idle time is read by the boot agent
   (logind's `IdleSinceHint` on Linux, `GetLastInputInfo` on Windows, `HIDIdleTime` on macOS).
3. Then the runtime asks the boot agent for `power sleep` over IPC. The boot agent checks again: not
   in safe mode, no workload `install`, `switch` or `start` in progress, and `hold` still false in
   its latest answer. It sends one last heartbeat with `going_to_sleep: true`, so the hub shows the
   device as asleep at once rather than two minutes later. Then it asks the OS to suspend
   (`systemctl suspend`, `SetSuspendState`, `pmset sleepnow`).
4. While `hold` is true, the boot agent holds an OS sleep inhibitor (`systemd-inhibit`,
   `SetThreadExecutionState`, `caffeinate`), so the OS's own power plan can't put it to sleep in the
   middle of a reply. It releases the inhibitor when `hold` goes false.

"Never sleep" means Nova never asks the device to sleep, and holds it awake while work runs. The
OS's own power settings still apply outside that. Nova can wake a device that the OS put to sleep,
as long as wake on demand is on.

## The wake path

```
task routed to role → placement device D
  D awake?                                   → run (today)
  small job and the hub has a model?         → hub model, with a note (today)
  D asleep-wakeable?                         → wake (below)
  else                                       → fallback (below)

wake(D, origin):
  1. checks: trusted · compute · on_demand · not paused · rate limit · card checks ·
             sender S on D's network (the same-network test)          → else refused, with the reason
  2. ledger: a `wake` event on the task (or a tier-1 task "Wake D" when the person asked)
  3. S sends 3 magic packets, 1 s apart, to D's broadcast address :9, from S's own card on that network
  4. wait for (a) D's heartbeat and (b) D's Ollama /api/version, polling every second,
     up to the wake limit                                              → else "sent, no wake"
  5. (a) without (b) for 60 s                                          → "woke, unhealthy"
  6. re-run the fit engine with the fresh inventory from that heartbeat → won't fit now: fallback
  7. load and run; the task's line is "Loading ⟨model⟩" until the first token
```

### Timeouts and retries

| Step | Limit | Basis |
|---|---|---|
| Sending | 3 packets, 1 s apart | UDP can be dropped; three is common practice. They count as one wake, and the device ignores the extra ones |
| Wake limit | the last answered wake × 1.5 + 2 s; never measured, `wait_s` (120 s by default); at most 300 s | Unchanged from today. The 300 s cap is new, so a mistyped `wait_s` can't hold a task for an hour |
| Woke, then healthy | 60 s from the first heartbeat to Ollama answering | The agent and Ollama start together at boot; a minute is generous |
| Loading | the last measured `load_duration` for this device and model (Ollama reports it on every call) × 1.5 + 5 s; never measured, 180 s | The same measured-or-guess rule as the wake |
| Retries | none automatic for the same task, and the device is paused | Today's rule, kept. The person can try again (rate-limited) |

### What the task shows

The task's waiting line follows `wait.js` (DESIGN-SYSTEM §1). Nothing shows under 1 s. From 1 s
there is a spinner and what is waited for: "Waking Dell desktop for “Summarize the lease”". After
10 s it adds the time so far ("23 s so far"). The basis for an estimate is the measured wake, said
as a fact ("Waking took 38 s last time"), never as a countdown and never as a percentage. The hub
gives the measured latency to the page, and the page passes it to `wait.js` as the `usual` words,
so no new timing code is needed. Then "Loading qwen3:14b" (the same bands), then the reply. The
task's status stays Working throughout. On a failure it becomes Waiting, with the reason in the
task's own words, as `ModelsWaiting` does today.

### Failure states

| Failure | How Nova knows | What the person reads (Models screen and the task) |
|---|---|---|
| **No sender** | The same-network test finds no always-on sender with a card on D's network | "None of your always-on devices is on its network, so nothing can send the wake signal. Nova doesn’t send wake signals across networks or over your mesh." No packet is sent |
| **Sent, no wake** | The wake limit passes with neither a heartbeat nor Ollama | "Mini PC (the hub) sent the wake signal at 14:02 and waited 59 s, half again what waking took last time (38 s). Dell desktop didn’t answer." The device is paused |
| **Woke, unhealthy** | A heartbeat, but no Ollama within 60 s; or the load fails | "Dell desktop woke after 40 s and its device agent checked in, but Ollama didn’t answer in the minute after." Nova opens a problem with its playbook (as M7b does for a local fault). The device isn't paused, since it is awake; the task waits for Ollama |
| **Woke, no longer fits** | The fresh inventory's fit verdict is Won't fit (for example a game now holds the GPU) | "Dell desktop woke, but 18.2 GB of its video memory is in use by other programs now, so qwen3:14b at Q8_0 with 16k context doesn’t fit." Then the fallback |
| **Refused** | A check in step 1 fails | Its reason: not trusted, not a compute device, wake on demand off, paused, the rate limit ("Nova has woken it 4 times this hour; it can try again at 15:10"), or the card checks |

### Fallback rules

In order, and the task always says which one happened:

1. **Another awake device of yours where it fits.** A trusted, awake compute device with an installed
   model for the same role, whose fit verdict at the context asked is Fits or Tight. It runs there,
   and the task and receipt say so: "Dell desktop didn’t wake, so qwen3:8b on Small tower answered."
   This stays on the person's devices, so it is allowed in every privacy mode, like today's
   small-job rule.
2. **Otherwise, the task's privacy mode decides:**
   - **local-only:** the task waits on the person's devices and runs once the device checks in. It
     never goes to the cloud. "Try waking it again" is offered.
   - **local-preferred:** Nova asks first: "Use the cloud model this once", or wait. This is
     stricter than today, where local-preferred goes to the cloud with a note on the receipt
     (open question 3).
   - **cloud-allowed:** the cloud model was already first, so a wake happens only when the cloud
     can't serve. A failed wake then waits, with the reason.
3. **Never silently to the cloud.** Whatever the mode, a wake failure never ends in a cloud call that
   the task doesn't name.

### With the fit engine and the Models screen

- **Planning:** unchanged from step 3. A sleeping device plans with its last inventory, and the
  verdicts carry the inventory's age.
- **Routing:** an awake device where the model fits beats waking one. Waking is chosen when the
  placement names the sleeping device, or it is the only one where the model fits, and the job isn't
  small. After the wake, the fit engine runs again on the fresh inventory (step 6) before anything
  loads, so a stale verdict never loads a model that won't fit.
- **The services track:** `placement.ts` already treats an unhealthy device as down. A
  wake-on-demand device is "down, wakeable" there. Inference routing may wake it; native workload
  placement doesn't (a service isn't moved onto a machine that sleeps by design). A service that is
  pinned to such a device keeps it held awake (`hold`) while it is placed there.
- **The Models screen:** the device's header shows its wake state (the styleguide states). A
  "Sleep and wake" section, the screen's last, has the two choices and says who sleeps the machine
  and who wakes it. The Settings › Models overview names it in each route: "Coding → Dell desktop
  (asleep, wakeable; waking took 38 s)".

## Security

Wake-on-LAN has no authentication. Anyone on a network segment can wake any machine on it, and the
packet carries nothing but the MAC. So the controls are about who makes Nova send, where it sends,
and how often.

**Who may trigger a wake.**

- **Nova's routing,** for a task routed to the device's role, after the checks above.
- **The person,** through `POST /models/devices/{id}/wake` and "Try waking it again". This is the
  `person` scope that exists today (the console, or a person's paired browser or phone). It is
  tier 1: it is recorded as its own ledger task and doesn't ask first. Waking is reversible and
  sends nothing of the person's anywhere.
- **Not:** a paired computer (the `device` scope), a standby, a public caller, the chat agent (there
  is no wake tool, and this design adds none), an extension, or a browser task's page (its requests
  carry `x-nova-browser-task` and get no person rights).

**Where a wake may go: the same-network test.** A wake is sent only when there is a sender card `s`
(the hub's own, read from the hub's `networkInterfaces`, never reported) and a recorded card `d` on
the device, such that:

1. `privateAddress(s.address)` and `privateAddress(d.address)` both hold (the existing classifier,
   unchanged);
2. neither address is one of the mesh's own (`meshHost`, as `index.ts` already builds it), so a
   tailnet address is never a wake network;
3. both netmasks are contiguous, with a prefix from /16 to /30, and they are equal. A /10 (how
   Windows shows a tailnet adapter), a /8 or a 0.0.0.0 mask is refused;
4. the two addresses are on the same subnet, `s & mask == d & mask`;
5. the target is `broadcastOf(s.address, s.netmask)`, computed by the hub from its own card, port 9.

The socket is bound to `s.address`, so the packet leaves on that card. `255.255.255.255` is no longer
used as a fallback: no broadcast address means no wake, with the reason. The person's
`PUT /models/wake` target, if set, must pass the same test for each device it is used for. Nova
never relays a wake over the mesh or to another network.

**Validation at the hub boundary** (`checkHardware`, which already drops cards with a malformed MAC
or a non-private address). It also drops:

- multicast or broadcast MACs (the low bit of the first byte set, or `ff:ff:ff:ff:ff:ff`) and the
  all-zero MAC;
- a `wol` field outside `magic | off | unknown`.

A card with a non-contiguous or out-of-range netmask is kept for addressing, but marked as not usable
for wakes. A MAC that two trusted devices both report disables waking for both until one changes, and
Nova opens a problem. A MAC that changes on a device is noted in its activity.

**Rate limits,** counted from `device_wake` (durable, and replicated after this build, so a restart
or a failover doesn't reset them):

- one wake in flight per device (today's `#waking`);
- at most 4 wakes per device per hour, from any origin;
- at most 12 wakes per hour across the hub;
- one automatic wake per task, and none while the device is paused.

A refused wake is recorded with its reason and sends nothing.

**The Work Ledger.** Every wake attempt, sent or refused, is a `wake` event on the task it served,
with the device, the origin (routing, or the person), the sender, the target, the outcome and the
time waited. A wake the person asked for is a tier-1 task "Wake ⟨device⟩" with the same event.
`task_event` is replicated, so the history survives a failover. `device_wake` stays the timing table
and gains `origin`, `sender` and `reason`.

**What a compromised spoke could and couldn't do.** A spoke is a paired computer whose agent is
hostile.

| It could | It couldn't |
|---|---|
| Report another machine's MAC on its own network, so a wake meant for it wakes that machine instead. That is a nuisance, limited by the rate limits and recorded in the ledger. A MAC that two devices claim disables both | Make the hub send to any address outside a network the hub itself is on. The target is computed from the hub's own card |
| Report a false private address, so its wakes go to the broadcast of one of the hub's networks: a network where Nova already sends wakes | Use the mesh or a broad netmask to reach a wider network. Mesh addresses are refused, and the prefix must be /16 to /30 |
| Stop heartbeating, so that work routed to it triggers wakes, up to 4 an hour and one per task | Trigger a wake itself. Computers have no wake route, and routing to it needs the person's placement |
| Fail on purpose after waking, which holds its tasks under local-only (as it can today by being off) | Change what the packet says (fixed bytes, built at the hub), send it to the internet, or get data back (a wake is one-way) |
| Refuse to sleep, or sleep when it shouldn't (only its own machine) | Make another device sleep. `power` acts only on the agent's own machine, and the hub's answer only carries that device's policy |

A compromised hub is out of scope here, as it is everywhere: it already holds every key.

## Inventory additions

| Field | Where it comes from | Validation | Storage | Older agents |
|---|---|---|---|---|
| `network[].mac` | Exists | Exists, plus the MAC rules above | `device_hardware` JSON (exists) | Exists |
| `network[].broadcast` | Exists, computed by the hub | Not used for the target any more; the sender's own broadcast is | — | — |
| `network[].wol` | New, from the device agent: Linux `/sys/class/net/<if>/device/power/wakeup` and `ethtool` when present (`Wake-on: g`); macOS `pmset -g` (`womp 1`); Windows: a wired card `powercfg /devicequery wake_armed` doesn't list is `off`, an armed one is `magic` when `Get-NetAdapterPowerManagement` (often admin-only) says so, else `unknown`. Wi-Fi cards report `unknown` | `magic \| off \| unknown`; anything else becomes `unknown` | `device_hardware` JSON | Missing means `unknown`. `off` blocks waking, with the words "its network card has Wake-on-LAN turned off" |
| `wake.capable` | Derived (exists): now on demand, a card that passes the checks, `wol` not `off`, and a sender on its network | — | — | Unchanged derivation, plus the new checks |
| `wake.on_demand`, `wake.sleep_after_min` | The person's policy | The fixed lists above | The profile, `models.power.<id>` (replicated) | The hub keeps it; see below |
| `power` support | The agent's `version` in its heartbeat | — | `device_heartbeat` (exists) | An agent without the `power` verb ignores the `power` field (the runtime reads only the fields it knows). The control then says "Its device agent can’t put it to sleep yet; the OS’s own power settings decide", and Nova can still wake it |

**Migration:** one, `00NN_wake.sql` (the next free number at build time):

- adds `origin`, `sender` and `reason` to `device_wake`;
- adds the sync triggers for `device_hardware` and `device_wake`, as 0025 did for `device_overhead`;
- lists both tables in `REPLICATED` (and the new columns in `ADDED_COLUMNS`).

Then a hub that takes over has the sleeping device's cards and wake history, and can wake it. The
policy needs no migration (the profile already replicates).

## Test plan

No real packets in CI. `sendMagic` gains an injectable sender. The new golden cases use a recorder
that keeps each packet's bytes, target, port and bound address, and opens no socket at all. The
existing loopback test (`startFakeWol`) stays as the one check that the real socket code sends what
`magicPacket` builds, on 127.0.0.1 only. The iso container has no network, which is the backstop. The
OS suspend and inhibitor calls are stand-ins as well: a test never sleeps a machine.

### Golden cases

The reference is the owner's Dell, a compute node woken by the always-on mini-PC hub. The addresses
are examples. The Dell's GPU in the styleguide is the 3090 sample, since the Dell's real hardware
isn't in the repository.

| # | Case | Given | Expect |
|---|---|---|---|
| 1 | **The Dell, woken by the hub** | Hub card `eth0` 192.168.1.10/24. Dell card 192.168.1.42/24, MAC `02:00:5e:10:00:42`, `wol: magic`; compute; on demand; last wake 38 s; a local-only task for the reasoner role | 3 packets, each 102 bytes: `ff`×6 then the MAC×16; to 192.168.1.255:9, bound to 192.168.1.10. Waits up to 59 s. On the stand-in's heartbeat and then Ollama: re-fit, load, run. A `wake` event on the task with outcome `awake`; `device_wake` origin `routing`, sender `hub` |
| 2 | No sender | The Dell at 192.168.20.42/24, the hub on 192.168.1.0/24 | Refused, `no_sender`, the words in the failure table; 0 packets; the task follows the fallback |
| 3 | Mesh only | The Dell reports only 100.101.102.103 with mask 255.192.0.0 | Not wakeable: the mesh address and the /10 prefix; 0 packets |
| 4 | A broad netmask | The Dell reports 192.168.1.42 with 255.0.0.0, or 0.0.0.0 | The card is kept for addressing, not for waking; 0 packets |
| 5 | Bad MACs | `ff:ff:ff:ff:ff:ff`, `01:00:5e:00:00:01`, `00:00:00:00:00:00` | Dropped by `checkHardware`; the device can't be woken, and says so |
| 6 | Sent, no wake | Case 1, but the stand-in never answers | `no_answer` after 59 s (on a fake clock); the task waits (local-only); no second packet for that task; the device paused; a new task makes no wake until the device is heard from |
| 7 | Woke, unhealthy | A heartbeat at 40 s, no Ollama | `unhealthy` 60 s later; a problem opened; no second wake |
| 8 | Woke, no longer fits | The fresh heartbeat shows 18 GB of video memory in use | Won't fit, by the fit engine; nothing loaded; the fallback |
| 9 | Fallback to another device | Case 6, and Small tower is awake with `qwen3:8b` installed, which fits | The task runs on Small tower; the task and receipt name it; the cloud stand-in gets 0 requests |
| 10 | Local-first asks | Case 6 under local-preferred, nothing else fits | The task waits with "Use the cloud model this once"; the cloud stand-in gets 0 requests until the person says yes |
| 11 | Rate limit | 4 wakes of the Dell in the last hour | The 5th is refused with when it may try again; 0 packets; the refusal recorded |
| 12 | Who may wake | `POST /models/devices/{dell}/wake` as the console; as a paired computer; as a public caller | The console's makes a tier-1 task and sends; the computer's gets 403 and the public one 401, with 0 packets |
| 13 | The person's target override | `PUT /models/wake` with 192.168.5.255:9 while the Dell is on 192.168.1.0/24 | The Dell's wake is refused (not its network); 0 packets |
| 14 | An older agent | A heartbeat without `wol` and an agent version without `power` | `wol: unknown`; still wakeable if on demand; the policy control says the OS decides; the hub's `power` field is ignored without an error |
| 15 | The sleep policy | A fake clock; `sleep_after_min: 30` | `hold` false and the OS idle both for 30 minutes: one `power sleep` request and a `going_to_sleep` heartbeat. `hold` true: never, and the inhibitor is held. A person's input at 29 minutes: the count restarts. "Never sleep": never asks |
| 16 | Failover | A standby takes over while the Dell sleeps | The new hub has the Dell's cards and last wake, and case 1 passes from it (when it is on the same network) |

### The styleguide

`tests/ui/models-screen-styleguide.test.ts` covers the seven proposed states across the owner's 13
sizes in Chromium and WebKit, as it does the step-3 states. It checks overflow, clipped text, 44 px
targets (`shortTargets`), labelled controls, axe, and no requests. Each state's words are measured in
one `page.evaluate`, including the wait-text rules: the Waking line is past 10 s with the time so far,
and the Loading line is in the 1–10 s band with no extra words. There is no countdown or percentage.
The catalog and plan are kept while asleep, and the sleep policy is the screen's last section with its
two labelled choices.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Any always-on device relays a wake for any other, over the mesh | It is a way to send broadcast traffic into networks Nova isn't on, and a compromised spoke would become a wake relay. A sender must be on the target's own network, and in this build that is the hub |
| Trust the broadcast address the device reports | A spoke could aim the hub's packets anywhere. The hub computes the target from its own card |
| Leave sleeping to the OS's power plan only | Nova couldn't keep a machine awake through a long reply, and "sleep after N idle minutes" would mean idle by the OS's measure, not Nova's. The OS plan still applies under "Never sleep" |
| The hub decides when a device sleeps, and tells it to | The hub can't see whether a person is at the machine. Putting someone's computer to sleep while they use it is worse than an idle GPU |
| Retry the wake until the device answers | A machine that is unplugged or has WoL off gets a wake for every task. One wake, then a pause until it is heard from |
| A free-number idle timeout | A list of five fits one `select` on a phone, and the device agent is never handed an odd value |
| Wake on demand by default for every device with a card | It is today's behaviour. It wakes machines the person never chose to have woken. See open question 5 |

## Consequences

- Waking becomes opt-in per device. A device the person never set doesn't get a wake (today it
  can), so an upgrade with a role on a sleeping spoke needs one choice, said once on the Models
  screen.
- Decision 1 grows from five verbs to six if the owner says yes. `power` takes only `hold`,
  `release` or `sleep`, about its own machine. It is not an execution verb: it starts nothing, and it
  takes nothing from the hub but the policy.
- `device_hardware` and `device_wake` begin to replicate. Both are small, and a hub that takes over
  can then wake a sleeping device.
- Under local-preferred, a failed wake asks before the cloud, if the owner agrees (question 3). That
  is a narrow exception to how local-preferred falls back today.
- A device off the hub's network can't be woken until a LAN relay is designed and approved
  (question 2). The screen says so in words, rather than pretending.

## Open questions for the owner

Each has the default this design recommends. **Answered 2026-11-06: the owner approved the design with every recommended default, so the build follows each one.**

1. **Amend Decision 1 for a `power` verb (`hold`, `release`, `sleep`)?**
   *Recommended: yes.* Without it, "sleep after N minutes" can only be the OS's own setting, and
   Nova can't hold a machine awake through a reply.
2. **Should a boot agent on another network relay wakes?** For example, a second always-on box at
   another site.
   *Recommended: not now.* Only the hub sends. A relay would be a seventh verb with its own design: a
   hub-signed instruction naming one device, checked against the relay's own cards by the same
   network test.
3. **Under local-preferred, should a failed wake ask before using the cloud?** Today local-preferred
   goes to the cloud with a note on the receipt.
   *Recommended: ask*, for wake failures only. The person chose local first, and a wake failure is
   usually brief.
4. **May the person's wake skip asking (tier 1)?**
   *Recommended: yes.* It is reversible, sends nothing of theirs, and is rate-limited and recorded.
   The chat agent gets no wake tool.
5. **Make waking opt-in per device?** Today any device with a card can be woken.
   *Recommended: opt-in, with the Dell set on during the build's first run.* The Models screen asks
   once for each compute device that has a role.
6. **The rate limits: 4 per device per hour and 12 across the hub?**
   *Recommended: yes.* That is enough for a normal day of bursty work, and small enough that a fault
   can't wake a machine all night.
7. **The idle choices: Never, 15, 30, 60 or 120 minutes, with 30 as the suggestion when the person
   turns sleep on?**
   *Recommended: yes.* Below 15 minutes, a 40 s wake costs more than it saves.
8. **Should "Woke, no longer fits" fall back automatically (rule 1), or ask?**
   *Recommended: automatically to another device of the person's,* with the note. It never leaves
   their devices, the same as today's small-job rule.
