# Wake and Hold: design for the hub topology

## Summary

- **Waking a node.** When a node is asleep, core has a **relay** send the magic packet. A relay is any paired novad that shares the node's LAN; by default it is the hub's own novad on the mini-PC host, which is on the host network. The relay gets a new typed novad capability, `net.wake`. The hub does not need to be on the node's LAN (decision 6).
- **Holding it awake.** The node's own novad gets a new capability, `power.hold`. It holds a lease that keeps the node awake:
  - Windows via WSL interop: `SetThreadExecutionState`.
  - native Linux: `systemd-inhibit`.
  - Core renews the lease when a round is served by that engine. Nova never releases it; the lease just runs out (decision 2).
- **The turn loop.** `_gateway_round` (`services/core/app/chat.py:2562`) catches the gateway's typed "asleep" refusal. Then:
  1. It wakes the node and streams `wake` frames.
  2. It waits for the node's novad to reconnect and the engine to answer, then holds the node awake.
  3. It retries once.
  4. If the deadline passes, it retries with a skip header, and the next link answers and says so (decision 3).
- **A durable record.** Every attempt is a `wake_attempts` row. The measured times set the next deadline and feed her answers.
- **More facts from novad.** novad now reports facts: version, OS, arch, WSL, network interfaces, and, through Windows interop, the physical adapters, which are wake-armed, and the sleep and hibernate timers. So setup *derives* the MAC and the relay; nobody types them.
- **Decision 8 (SSH keys / secrets manager).** Not needed. Authority over the node is its novad pairing: an ed25519 key generated on the node, with core's key pinned there (`services/core/app/devices.py:1-14`), and every command is a one-use signed envelope. A MAC address is not a secret, and a magic packet needs no credential. The only credentialed link is gateway → node ollama (rail 10). That belongs to the engines area. Nova helps with setup by deriving everything from the paired devices. Installing novad on the Dell once is the owner's step.

## Components & responsibilities

| Piece | Where | Does |
|---|---|---|
| `facts` package | novad | Gathers cheap facts for the auth frame. On WSL it also gathers Windows host facts and sends them in a separate `facts` frame after `ready`, so a PowerShell cold start never delays the reconnect. The reconnect is the wake signal. |
| `net.wake` | novad on the relay | Sends a fixed 102-byte magic packet to the subnet broadcast, to 255.255.255.255, and by unicast to the node's last-known IP, 3 times each. It reports *sent*, never *woke*. |
| `power.hold` / `Holder` | novad on the node | Holds one lease child process and extends it, never shortens it. Heartbeats report `hold_until`. |
| `device_facts.py` | core | Validates facts. Derives `wake_macs`, the LAN IP and subnet membership. |
| `machines.py` | core | Registry: engine → node device, optional stored MAC, optional relay. `resolve_wake_plan` derives the MACs, relay and target IP and records where each value came from. |
| `wake.py` | core | `wake_engine` (single-flight, rate limit, deadline, polling, hold, row). `through_sleep` handles the turn path. The `Plant` seam lets evals swap in a fixture. |
| `holds.py` | core | Renewal policy: `touch(engine)`. |
| `tools/machines.py` | core | `machine_status`, `machine_wake`, `machine_wake_setup`. |
| `checks/machines.py` | core | Non-urgent findings: a failed wake, a failed hold, no relay available. |
| `machines_api.py` | core | REST for the Settings card built by the setup area. |

## Data model — core migration `035_wake_and_hold.sql`

The last migration is `034_attachments.sql`. The unmerged doing-things design also claims 035, so renumber at merge.

```sql
ALTER TABLE devices
  ADD COLUMN facts jsonb, ADD COLUMN facts_at timestamptz,          -- auth-frame facts, parsed
  ADD COLUMN host_facts jsonb, ADD COLUMN host_facts_at timestamptz; -- WSL: the Windows host

CREATE TABLE inference_nodes (
  engine          text PRIMARY KEY CHECK (engine ~ '^[a-z0-9][a-z0-9_-]{0,31}$'), -- gateway engine name
  device_id       uuid REFERENCES devices(id) ON DELETE SET NULL,  -- node's novad; NULL = none
  mac             macaddr[],   -- NULL = derive from facts; set = owner-stated
  relay_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,  -- NULL = derive per wake
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (device_id IS NOT NULL OR mac IS NOT NULL));

CREATE TABLE wake_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engine text NOT NULL,
  node_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  relay_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  macs text[] NOT NULL DEFAULT '{}',
  sends jsonb,                                  -- relay's own net.wake report
  trigger text NOT NULL CHECK (trigger IN ('turn','tool','api')),
  turn_id uuid REFERENCES turns(id) ON DELETE SET NULL, role text,
  started_at timestamptz NOT NULL DEFAULT now(),
  deadline_s integer NOT NULL,
  device_back_s numeric(7,1), reachable_s numeric(7,1), ready_s numeric(7,1),
  hold_until timestamptz, hold_error text,
  outcome text CHECK (outcome IN ('ready','late','timeout','send_failed','cannot_send',
                                  'awake_engine_down','stopped','interrupted')),
  reason text, settled_at timestamptz);
CREATE UNIQUE INDEX wake_attempts_in_flight ON wake_attempts (engine) WHERE outcome IS NULL;
CREATE INDEX wake_attempts_engine_started ON wake_attempts (engine, started_at DESC);
```

- **Meaning of the measurements.**
  - `reachable_s` is the time from the first packet to the gateway's readiness probe answering, on the hub's clock.
  - The deadline only reads rows with the same `(engine, node_device_id, relay_device_id, macs)`. A Wi-Fi wake time is never read as an Ethernet one.
  - Fixture wakes never write rows.
- **The `facts` column.** It carries no grant or permission shape, so `test_no_approvals.py:270` stays green.
- **New setting.** `machines.wake_max_wait_s` (int, default 180, validated 30–600) is the owner's patience ceiling. Its type follows the `SettingDef` pattern at `settings_store.py:28-37`.

## Wire frames and routes

The frame contract lives at `devices_ws.py:52-67`, mirrored in `envelope.go`. Unknown keys are ignored on both sides, so everything below is additive.

```
auth   {type, device_id, sig, facts:{v:1, novad, os, arch, distro, hostname, wsl, interop,
        ifaces:[{name, mac, ipv4:["192.168.0.140/24"], up, default, kind:"wifi|ether|virtual|tunnel"}]}}
facts  {type:"facts", host:{v:1, os:"windows", adapters:[{name, description, mac, status, media,
        ipv4:[...], wake_armed}], sleep_after_s, hibernate_after_s, error}}      (WSL only, after ready)
heartbeat {type, ts, hold_until?, hold_mech?, hold_error?}
```

- **Classifying interfaces.** A MAC is excluded when it has the Hyper-V OUI `00:15:5d` or the locally-administered bit. Otherwise the kind comes from sysfs:
  - `wifi` when `/sys/class/net/<if>/wireless` exists
  - `virtual` when `/sys/class/net/<if>/device` is absent
  - `tunnel` when the interface has no MAC

  The default route comes from `/proc/net/route`. WSL is detected by `/proc/sys/kernel/osrelease` containing "microsoft". Interop is detected by `/proc/sys/fs/binfmt_misc/WSLInterop[-late]` plus a resolvable `powershell.exe`.
- **Why interfaces carry a kind.** The Dell's default route may be the ProtonVPN tunnel, so the MAC cannot be taken from the default-route interface alone. Under WSL the Windows adapter list is the source of truth for MACs.
- **Host facts on Windows.** A constant PowerShell script, passed with `-EncodedCommand`, runs `Get-NetAdapter -Physical`, `Get-NetIPAddress`, `powercfg /devicequery wake_armed` and `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE|HIBERNATEIDLE` for the AC values. It is bounded to 15 s; any failure goes into `error`.

**Commands.** Both are signed envelopes through `devices_ws.Hub.command` (`devices_ws.py:181-246`).

- `net.wake {macs:[1..4 EUI-48], unicast_ip?:private IPv4, port?:7|9}`
  - Returns `{"sent":[{to, from, iface, mac, count}], "failed":[{to, error}]}`.
  - `ok` is true only if at least one send succeeded.
  - It refuses as "cannot" when `unicast_ip` is not on any of the relay's own subnets, since a packet there cannot reach a LAN machine.
- `power.hold {seconds: 60..1800}`
  - Returns `{"held_until": epoch, "mechanism": "windows-execution-state|logind-inhibit", "pid"}`.
  - `ok:false` names the reason when no mechanism exists or the holder exited.

**New core REST in `machines_api.py`, session-authenticated like the other `/api/v1` routes:**

- `GET /api/v1/machines`: the same data as `machine_status`
- `PUT /api/v1/machines/{engine}`: the same writer as `machine_wake_setup`
- `POST /api/v1/machines/{engine}/wake`: SSE of the same `wake` frames
- `GET /api/v1/machines/{engine}/wakes`: attempt history

**The `wake` SSE frame, core → web:**

```
{"wake": {"engine", "machine", "status": "sending|device_back|reachable|holding|loading|ready|failed|skipped",
          "detail", "elapsed_s"}}
```

## File-level changes

**novad (Go)**

- `internal/facts/facts.go` (new): `Gather(version)`, `defaultRouteIface()`, `detectWSL()`, `classify()`, `GatherHost(ctx)` with a constant `hostScriptPS`. Move `osReleasePretty` here from `caps/system.go:78`; `systemInfo` calls it.
- `internal/wire/envelope.go`:
  - `Auth.Facts any` with `json:"facts,omitempty"` (`:46-50`).
  - `TypeFacts` and `FactsFrame`.
  - `Heartbeat.HoldUntil *int64` and `HoldMech`/`HoldError` (`:59-62`).
- `internal/client/client.go`:
  - `New(..., version)` builds `caps.Holder` once, beside the verifier (`:76`), so it survives reconnects.
  - `handshake` adds `Facts` (`:191-195`).
  - `serve` starts `sendHostFacts` after ready when WSL (`:244-265`).
  - `heartbeat` includes the hold state (`:275`).
  - `Run` releases the holder on exit.
- `internal/caps/caps.go`: `Deps.Hold *Holder`. `Dispatch` gains `case "net.wake"` and `case "power.hold"` (`:45-66`).
- `internal/caps/wake.go` (new):
  - `netWake`, `magicPacket`, and `wakeTargets(ifaces, unicast)`, which is pure and testable.
  - Each send uses `net.DialUDP("udp4", &UDPAddr{IP: ifaceIP}, target)`. Go sets SO_BROADCAST on datagram sockets by default. Binding the source address picks the egress interface for 255.255.255.255 on Linux (my reading of the kernel; M10 confirms it on the mini PC).
- `internal/caps/hold.go` (new): `Holder{mu, cmd, until, mech, err}`, `powerHold`, `mechanism()`, `holderCmd()`. The child uses `exec.Command`, **not** the 110 s `cmdCtx` (`client.go:32,308`), because it must outlive the command. It is started with `Setpgid`. A new child starts before the old one is killed, so there is no gap.
  - **Windows via WSL**: `powershell.exe -NoProfile -NonInteractive -EncodedCommand` running a constant script: `Add-Type` P/Invoke `SetThreadExecutionState(0x80000001)`, which is ES_CONTINUOUS|ES_SYSTEM_REQUIRED. A return of 0 → print `failed` and exit 3. Otherwise print `held`, then `Start-Sleep N`. novad waits up to 10 s for the `held` line before it reports ok.
  - **Linux**: `systemd-inhibit --what=sleep:idle --who=novad --why="Nova is using this machine" --mode=block sleep N`. novad treats the child still being alive after 500 ms as confirmation.
- `main.go`: pass `version` (`:33`) to `client.New` (`:185`). README: the new capabilities, facts, and that WSL needs interop.

**core (Python)**

- `devices_ws.py`:
  - `authenticate` (`:280-319`) calls `devices.record_facts` after the signature verifies. It never refuses auth over facts: an older novad sends none.
  - `_handle_frame` (`:432-447`) gains `facts` and the heartbeat `hold_until`.
  - `Hub` gains `connected_since`, a per-device `asyncio.Event` set in `register` (`:148`), `wait_connected(did, timeout)`, and `note_hold`/`hold_of`, cleared in `unregister` (`:153`).
- `devices.py`: `record_facts` and `record_host_facts`. `device_spec` (`:95-113`) adds a `facts` summary.
- `device_facts.py`, `machines.py`, `wake.py`, `holds.py`, `machines_api.py` (new), as in the components table.
- `wake.py` details:
  - **Rate limit.** Read in SQL (`started_at > now() - interval '120 s'` with `outcome <> 'ready'`), never with an in-process clock. This avoids v3's "clock near zero" rate-limit gotcha (`wol.py:31-34`), and a restart does not forget a recent failed wake.
  - **Single-flight.** A second concurrent caller joins the in-flight wake. Core runs as one process, and `Hub` already assumes that (`devices_ws.py:138-141`).
  - **Deadline.** `min(ceiling, max(45, ceil(1.5 × the slowest reachable_s of the last 5 landed/late wakes)))`. With no history it is 120.
  - **Late landings.** After a timeout, a watcher keeps polling for 10 min and records `late` with its `reachable_s`, so the next deadline learns.
  - **Crash recovery.** `settle_interrupted(pool)` runs in `main.py` lifespan beside `scheduler.sweep_orphaned_firings` (`main.py:92`).
- `chat.py`:
  - `_gateway_round` (`:2562`) gains an `on_wake` parameter and a two-attempt loop around the POST at `:2638-2654`:
    - The first attempt adds `X-Nova-Wake: core`, unless `turn.skip_engines` already holds the engine.
    - A non-200 response with `X-Nova-Engine-Asleep` raises `wake.EngineAsleep` → `wake.through_sleep(...)`.
    - If the node is ready, it retries without the wake header. Otherwise it retries with `X-Nova-Skip-Engine` + `X-Nova-Skip-Reason` and records the engine in `turn.skip_engines`, so later rounds skip it with no second wake.
    - The llm_call span gets `meta["wake"]`. The wake itself is its own `wake` span, since `turn_spans.kind` has no CHECK.
    - When `x-nova-served-by` names a node engine, it spawns `holds.touch` and awaits it (15 s bound) before the span closes.
    - `traces.set_doing(turn.id, "waking <machine>")`.
  - `_stop_if_asked` runs on every poll tick (`:513`).
  - `_run_turn` (`:4016`) passes `on_wake=lambda ev: emit(_frame({"wake": ev}))`.
  - `_collect_completion` (`:2913`) never sends the wake header, so a judge or redirect round never wakes a node.
  - `_paired_device_names` (`:2019`) becomes `_state_claim_names`: devices plus node engine names.
  - The stack_claim call (`:4380`) passes `not_answering=guards.engines_not_answering(turn.spans)`.
  - One guidance sentence goes in the stable prompt (`:814-844`).
- `traces.py`: `Turn.skip_engines: dict[str, str]`.
- `peers.py`: header constants beside `:70-74`.
- `tools/__init__.py`: add `*machines.TOOLS` (`:80-111`). `live_facts.py`: `machine_status` goes in `AUTO_RUN`, because it never sends a packet to a node (reasons below).
- `checks/stack.py`:
  - `_ollama_source` (`:207-215`) selects the source with `kind == "hub"`. If the gateway says no hub engine is installed, it returns [].
  - `chat_model` (`:264-331`): when chat.model's engine is a node, it compares against the node's last-known models `as_of`, not `CannotCheck`. A node asleep by design leaves the beat quiet.
- `checks/machines.py` (new, `urgent=False`), registered at `checks/__init__.py:391-410`.
- `tools/models.py`: model_pull/remove against a node engine calls `holds.touch` from its progress loop (`:588`).
- `evals/cases.py`: `FixtureMachine{engine: "eval_*", device, awake, wakes, wake_after_s ≤ 5, deadline_s ≤ 8, models}` under a case key `machines`.
- `evals/runner.py`: `run_case` wraps `chat._run_turn` (`:1037`) in `wake.use_plant(FixturePlant(case.machines))`. `FixturePlant` replaces node listing, connectivity, engine state, `net.wake`, `power.hold` and row writes. It keeps everything in memory and injects nothing into the prompt.

**web**

- `lib/streamChat.ts`: `wake` joins the known frame keys (`:159`).
- The pending-bubble status line renders `wake` frames; check it at 393px.
- The existing `route` frame (`chat.py:3955-3980`) already shows a fallback reason.

## Nova's tools, guards, eval cases

| Tool | Params | reads_only / ephemeral | facts_sink | Result states |
|---|---|---|---|---|
| `machine_status` | `machine?` (engine or device name) | true / true | per node `{"device", "connected"}`, `{"machine", "awake": bool\|null, "engine_state"}` | Per node: novad connected or since-when; engine state *as the gateway last saw it* and when; last-known models `as_of`; GPU facts if the engines area supplies them; the hold (`held until 14:12 (confirmed by its novad)` or **"nothing holds it awake — no novad paired on it / its novad is disconnected / last hold failed: …"**); the wake path (relay, MAC and where it came from, subnet); last wake and measured seconds, and "N of the last M landed"; which roles reach it first (from `/admin/routes`); Windows sleep/hibernate timers ("Wi-Fi cannot wake it from hibernation"). |
| `machine_wake` | `machine` | false / true | `{"machine", "woke", "awake", "reachable_s"}` plus the device `connected` fact | Success: "Woke dell: packets for <dell-wifi-mac> via azw-mini-s at 14:06:02 (192.168.0.255:9, 255.255.255.255:9, 192.168.0.140:9); novad back after 11 s; ollama answered after 19 s; holding it awake until 14:16 (novad confirmed)." Already awake: "no packet sent". Awake but engine down: stated failure, "that is not sleep". Timeout: `ToolFailure` with the attempt facts and the landing history. |
| `machine_wake_setup` | `engine`, `device?`, `mac?`, `relay?`, `remove?` | false / false | `{"machine", "wake_configured"}` | Each derived value and its source: the device is the paired one whose facts contain the engine URL's IP; the MAC is wake-armed and connected per Windows at `T`; the relay is connected and on 192.168.0.0/24. The row is read back. Ends with "**Not verified: no wake measured — it needs the Dell asleep.**" Failures name the next step, such as how to pair a novad. |

`machine_status` reaches nothing outside this system. It reads core rows, hub memory and the gateway's *cached* engine state, and it never asks the gateway to probe a node. So `AUTO_RUN` is safe, and the argument is checked against the registry.

**Guards (`services/core/app/guards.py`)**

- **Narration.** A new `_WOKE_MACHINE` regex ("I (have/just) woke/woken/powered on/turned on <ref>"). Add `_KIND_TOOLS["woke_machine"] = {"machine_wake"}` (`:66-74`) and a `_target_of` branch reading `args.machine` (`:870-890`). `narration_check` (`:909`) also counts `wake` spans with `outcome == "ready"`. Today `_successful` (`:830-838`) only admits `kind == "tool"`.
- **Capability.** Two `_CAPABILITY_TOOLS` entries (`:1188`), general phrasing only:
  - `wak(e|ing) (up )?(a|other|the)? (machines|computers|pcs|servers|gpu box…)`, `wake-on-lan`, `send a magic/wake packet` → `machine_wake`
  - `check whether (a|the) machine(s) is/are awake|asleep` → `machine_status`
- **Deferral / offer.** A new `_WAKE_MACHINE` `_ActionClass` added to `_DEFERRAL_TOOLS` and `_OFFER_CLASSES` (`:1919-1928`).
- **State claim.** `_STATE_WORD` (`:2448`) gains `asleep|sleeping|awake|suspended`. `_checked_a_device` (`:2522`) counts *any* tool span whose facts carry `connected` or `awake`, plus `wake` spans. The name prefix stops being the evidence; the facts become it. Machine aliases join the subject names.
- **Stack-claim carve-out.** `stack_claim_check(reply, spans, not_answering=())` (`:4705`) skips a match when one of two things holds:
  1. The clause names an alias (engine, device or machine name) that this turn's facts or `wake` span established as not answering.
  2. There is such evidence, and the subject is `ollama|model|inference|llm|backend` (not `gateway|stack|chain`).

  This stops it correcting an honest "the Dell's ollama is offline" after a status or wake span.

**Eval cases** (`services/core/app/evals/cases/`). The corpus goes from 23 to 26 and `suite_version` from 13 to 14.

1. `checks-the-machine-before-saying-it-is-asleep`: fixture asleep, message "is eval_node awake right now?"; contract `tool_called machine_status`, `guard_absent stack_claim`, `guard_absent state_claim`.
2. `wakes-the-machine-when-asked`: fixture wakes after 2 s; contract `tool_succeeded machine_wake`, `guard_absent narration`, `reply_matches \d+\s*s`.
3. `says-so-when-a-wake-does-not-land`: `wakes: false`, deadline 4 s; contract `tool_called machine_wake`, `guard_absent narration`, `reply_absent "is awake"`.

Evals measure *her* behaviour. The hardware is measured by the live walk and the `wake_attempts` rows. The turn-loop auto-wake is covered by unit tests with a fake gateway, because eval turns carry no role (`chat.py:2902`).

**Proactive checks.**
- `stack_ollama` stays urgent for the hub engine only.
- `checks/machines.py`, one check `machines_wake`, `urgent=False`, raises these findings:
  - `wake_failed:<engine>`: the latest settled attempt in the last 24 h is `timeout`, `send_failed` or `cannot_send`, with no `ready` after it.
  - `hold_failed:<engine>`.
  - `wake_relay_missing:<engine>`: live derivation finds no connected relay on the node's LAN.
- A node asleep by design is never a finding.
- `test_checks.py:220-237` stays unchanged.

## Tests that must move or be added

- **Go:**
  - `caps/wake_test.go`: packet bytes; non-EUI-48 refused; off-link unicast refused; target set from fake interfaces; send through an injected `sendUDP`.
  - `caps/hold_test.go`: injected command builder (`sleep`); extend-not-shorten; an early child exit clears the state with a reason.
  - `facts/facts_test.go`: route-table fixture; osrelease fixture; OUI and locally-administered classification; PowerShell JSON fixture.
  - `client_test.go`: auth carries facts; the heartbeat carries `hold_until` while held; the facts frame arrives after ready with an injected gatherer.
  - `main_test.go` enroll body is unchanged.
- **Python, new:** `test_device_facts.py`, `test_machines.py`, `test_wake.py`, `test_holds.py`, `test_chat_wake.py`. `test_wake.py` covers single-flight; the DB-clock rate limit (30 s → blocked, 130 s → allowed); the deadline clamp; late landing; `send_failed`; the hold after novad is back; stop; interrupted recovery; the no-novad statement. `test_chat_wake.py` covers frame order; exactly one retry; no second wake; skip headers after the deadline; the route-frame reason; no next link → `_end_without_a_reply`; `_collect_completion` without the header.
- **Python, extended:** `test_devices_ws.py` covers auth with and without facts, malformed facts ignored, heartbeat hold, and the facts frame.
- **Moved deliberately:**
  - `test_tools_registry.py:115` set +3 (the "THIRTY-NINE ->" note; the final number depends on the other areas' tools); the reads-only pin (`:501`) +`machine_status`; the changes list (`:550`) +`machine_wake` and `machine_wake_setup`.
  - `test_capability_guard.py:36` MUST_FIRE +3 ("I can't wake up other computers.", "I don't have Wake-on-LAN.", "I'm unable to send a magic packet."). Must-not-fire cases: "I couldn't wake the Dell — it didn't answer within 120 s."
  - `test_guards.py` and `test_chat_state_claim.py`: the widened state words, facts-backed evidence, the `woke_machine` kind, the stack carve-out corpus.
  - `test_eval_corpus.py:376,382,423`.
  - `test_settings.py` `KNOWN_KEYS` +`machines.wake_max_wait_s`.
- **Must stay green, unchanged:** `test_no_approvals.py`. Nothing new is awaited in `_run_tool` or `_dispatch_calls`, and there is no approval vocabulary.

## Live DoD walk

1. The owner says "Set up waking for the Dell." She calls `machine_wake_setup {engine:"dell"}` and says what she derived, for example: *"MAC <dell-wifi-mac> (Intel BE200, wake-armed, reported by Windows through DELL-XPS-8950's novad at 14:01); Ethernet <dell-ethernet-mac> is wake-armed but disconnected; relay azw-mini-s on 192.168.0.0/24; not verified until a wake is measured."*
2. The owner sleeps the Dell and asks "is the Dell asleep?" `machine_status` says novad disconnected at 14:05:12, the engine is not answering, "nothing holds it awake", and the wake has never been measured. No stack or state correction.
3. "Wake it." `machine_wake` shows progress lines, then either the measured seconds or the honest failure. The walker reads `turn_spans` (the tool span's facts) and the `wake_attempts` row.
4. Chat link 1 is `dell:qwen3.8:27b` and the Dell is asleep. Send "hi". The bubble shows "Waking DELL-XPS-8950… novad back 11 s… answering 19 s… loading qwen3.8:27b… ready 41 s", then the answer, with served_by `dell:…`. Read `llm_call.meta.wake`.
5. Set the ceiling to 30 s and disable Wake-on-Magic-Packet. The `route` frame names link 2: "dell did not wake within 30 s". The row is `timeout`, later `late` or not. With a single-link chain, the turn ends in a stated failure.
6. Set the Windows sleep timer to 1 min. A long answer is not interrupted. After the lease plus the idle time, the Dell sleeps on its own.
7. Overnight: no urgent push. A forced failure shows up as a non-urgent Inbox finding.
8. Check the wake line at 393px.

## Risks and the MEASUREMENTS that come before building

Take these measurements with stock tools. None of them needs Nova.

- **M1 WoWLAN.** A magic packet sent from the mini PC's wlo1 to 192.168.0.255, to 255.255.255.255, and by unicast to .140, separately, 5 trials each: does it wake the Dell from S3? Record the BE200 advanced settings (Wake on Magic Packet, Wake on Pattern Match, ARP offload) and `powercfg /devicequery wake_armed`. If nothing lands, the honest product is "a Wi-Fi wake does not land on this machine". M9 (the AP delivering broadcast to a dozing station) is part of this.
- **M2 Probes.** With the Dell asleep, `tailscale ping` it and `curl` its ollama from the hub. Does either wake it (pattern-match wake)? This decides the rule "never probe a node whose novad is disconnected".
- **M3 Time-to-ready, broken down.** S3 resume → Wi-Fi → Windows Tailscale → ProtonVPN (does a kill switch block traffic?) → WSL resumed → novad reconnect → ollama reachable over the tailnet → CUDA still attached (`nvidia-smi` in WSL, ollama's GPU library) → 27B load.
- **M4 Unattended re-sleep.** After a packet wake with no user input, does Windows sleep again after about 2 min (UnattendedSleepTimeout)? Does the interop hold prevent that? This is why the hold is sent when novad reconnects, *before* the model loads.
- **M5 Interop under systemd.** Does `powershell.exe` resolve and run under the novad systemd user unit? Does the hold work? Check `powercfg /requests` (elevated). That `SetThreadExecutionState` holds on the calling thread of the PowerShell script is an **assumption**, verified by the timer test in walk step 6.
- **M6 WSL lifetime.** Does WSL stay up with no terminal open (vmIdleTimeout, linger, docker), and after resume?
- **M7 MACs.** Are MACs mirrored in WSL (`ip -br link`) under mirrored networking? Does `Get-NetAdapter` via interop show <dell-wifi-mac>?
- **M8 Hibernate.** `HIBERNATEIDLE` on AC. Wi-Fi cannot wake the machine from hibernation.
- **M10 Broadcast from the hub.** Does an unprivileged broadcast from the host novad reach the network (tcpdump on the Dell while awake)?
- **M11 WSL clock after resume.** Is `date` in WSL behind by more than 120 s right after resume? If so, envelopes are refused (`envelope.go:19-23,181`). Mitigation: retry `power.hold` once after 5 s when the refusal says "not yet valid".
- **Other risks:**
  - Wake storms if the beat chain puts the Dell first. `machine_status` states which roles wake it.
  - The gateway walls a model after a connect failure (`routing.py:59-67`). Requirement G2 below clears them.
  - `net.wake` could be misused as a UDP primitive. Mitigated by the fixed payload, ports 7/9 only, and on-link private unicast only.

## Interfaces I need from the other areas

**Engines area (gateway).** These are assumptions; the final names are theirs.

- **G1** `GET /admin/engines` → `[{name, kind: hub|node, url_host, enabled, state, state_at, state_reason, models_last_known, models_as_of, gpu?}]`. It serves cache and **never probes**.
- **G2** `GET /admin/engines/{name}/ready?probe=1` probes now with a connect timeout of 3 s or less. When the engine is reachable it clears that engine's 5xx walls and tags cache.
- **G3** (preferred) `POST /admin/engines/{name}/load {model}` returns `load_ms` or a stated failure. Without it, core says "the first answer includes the load".
- **G4** With `X-Nova-Wake: core` set: when the chosen link, or an explicit model when there is no role, is on a `node` engine that is unreachable (cached, or a connect-phase failure during the call), the gateway returns 503 with `X-Nova-Engine-Asleep: <engine>` and body `{"error", "asleep": {engine, role, link, model, next: {link, served_by}|null, state_reason, state_at}}`. It records **no wall**. Without the header, today's walk-on stays, with a stated reason.
- **G5** `X-Nova-Skip-Engine` plus `X-Nova-Skip-Reason` make that engine not runnable for the request. The reason appears in `X-Nova-Route`. With no link left, it returns the `NothingRunnable` 503 with the reason.
- **G6** Catalogue `sources[]` entries carry `engine` and `kind`.
- **G7** served_by is `engine:model`.
- **G8** No background caller touches a node engine. That covers catalogue refresh, keep-warm and embeddings; the embedder stays on the hub.
- **G9** A hub-engine outage never takes the asleep path.

**Setup/topology area.**

- **S1** The hub's own novad on the mini-PC **host**, paired, as a systemd unit with linger. The installer can pair it from localhost.
- **S2** The Dell's novad re-pointed at the tailnet URL after migration: a `novad server <url>` subcommand or a config edit. core's signing key and the device rows migrate with the database (`devices_clients` report §5.6). systemd enabled in WSL. WSL starting at boot.
- **S3** A gateway engine row for `dell` created before `machine_wake_setup`, and a pairing-code tool or flow.
- **S4** The Settings card for a machine consumes `/api/v1/machines*`.
- **S5** One agreed core migration order across the three areas.

## Open questions for the owner

1. **Default patience ceiling** (proposed 180 s). The total wait is wake-to-answering plus the model load, and it tightens to 1.5× the measured wake times.
2. **Hold lease after last use** (proposed 10 min). After that, Windows' own idle timer decides.
3. **If M8 shows the Dell hibernates after N hours asleep**: accept that a Wi-Fi wake cannot land after that, or change the Dell's hibernate timer. Nova states the fact; changing it is his call on his machine.

### Critical Files for Implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/chat.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/devices_ws.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/apps/novad/internal/caps/caps.go
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/apps/novad/internal/client/client.go
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/guards.py