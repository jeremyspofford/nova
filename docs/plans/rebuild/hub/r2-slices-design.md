# Revised slice plan: hub, engines, wake and move for any OS and device (owner decisions 9–11)

## Summary

The baseline plan survives in how the gateway works and in how wake and the move work. What changes is the machine side.

- **No node package.** The Python node-agent, the per-node tailscale sidecar, the Windows and Linux hold helpers and `./install node` are all dropped. They become roles of the **one native Go agent per machine** (novad grown up): hands, models, relay, hold and facts.
- **Engines.**
  - An engine is an Ollama endpoint fronted by an agent on any machine, plus the hub's bundled container.
  - The builtin `hub` row gets a `kind`: `bundled` (today's container) or `agent` (the hub host's own agent fronting native Ollama). A Mac hub needs `agent`, because Docker cannot use its GPU.
- **Measurement identity** becomes vendor-neutral, and it is **taken per request**:
  - which devices come from the agent's facts;
  - whether the model actually sits on them comes from Ollama's `/api/ps` `size_vram`.
- **Wake**: the relay is any agent on the node's LAN, on any OS. Power facts and holding the machine awake are native agent code, with no WSL interop.
- **Hub move**: it survives. The fixes are about portability, not a new design.
- **Every slice is walked** on the mini PC (Linux) and the Dell. The Dell is walked as a Windows-native agent with native Ollama, and as a Windows agent fronting Ollama in Docker Desktop (WSL2). **All macOS paths are CI-only and UNWALKED.**

Current numbers (verified today):
- core migrations go up to `034_attachments.sql`, so the next is 035;
- gateway migrations go up to `008_probe_vram_frame.sql`, so the next is 009;
- the tool registry holds 39;
- the eval corpus holds 23 cases at `suite_version` 13.

## What changes vs the baseline

| Baseline piece | Verdict |
|---|---|
| `providers` + `engines` rows; `hub` rename; first-colon ids; `library:` ids; shadow check limited to the default provider | **Kept** |
| Wait rule (`X-Nova-Wake: wait`, derived `routing.wait_links`); 409 `engine_asleep` (below 500, never walled); `X-Nova-Skip-Engines`; `ProviderUnreachable` never walled; `asyncio.timeout(ENGINE_REACH_S)`; per-engine TTL caches with cached failures; `engine_models`; standby skips embedders; D11 (background reads never touch a sleeping engine); finite pull timeout; `/load` with pinned options; handover route | **Kept unchanged** |
| Builtin compute derived per process, never persisted (D5) | **Kept, generalised.** Every stamp comes from the same request's observation. |
| `gpu:<uuid>` / `cpu:…` compute ids | **Changed** to the vendor-neutral grammar below |
| `services/node/` (Python), `deploy/node/*`, node sidecar, `nova-hold.ps1/.sh`, the `127.0.0.1:11436` helper, `hold.token`, `cmd_node`, `NOVA_SERVE_TARGET` | **Deleted.** Replaced by the agent's models and hold roles. |
| `/node/*` routes | **Renamed** to `/agent/v1/*` on the agent's transport listener |
| Enrollment through `pairing_codes.purpose='inference_node'` and public `POST /api/v1/machines/enroll` | **Deleted.** A machine pairs once as a device. Then core sends a signed `models.link` envelope, and the agent mints the bearer. |
| `*.ts.net` suffix decides the proxy | **Changed.** `engines.transport` (`internal`, `tailnet` or `lan`) decides it. |
| Hub sidecar `TS_OUTBOUND_HTTP_PROXY_LISTEN` as the gateway's tailnet egress | **Kept.** Under Headscale the same sidecar is logged in to Headscale instead. |
| Relay = hub-host novad (Linux) | **Changed** to any agent on any OS |
| Host facts through helper or WSL interop | **Changed** to native readers inside the agent, per OS |
| `wake_attempts`, `through_sleep`, rate limit counted from `settled_at`, no-wait rule, single budget per turn, late watcher, `ready_cpu` | **Kept.** The ledger is keyed by machine (device id), not engine. |
| Backup and restore verbs, manifest, drill, `MOVED_TO`, `refuse_if_moved`, `repoint` | **Kept.** Portability fixes are below. |
| S44 thin clients | **Kept.** It gains the no-trusted-HTTPS statement for LAN and Headscale. |

## Decisions made in this area

**D-1. Where the agent runs on Windows with WSL: natively on Windows.**
- WSL is only where Docker Desktop or an Ollama distro may live. The agent reaches it on `127.0.0.1`.
- Measured facts behind this:
  - novad's unit has no `powershell.exe` on its PATH and no `WSL_INTEROP` (wake-critique #16, measured);
  - WSL's adapters are all `hv_netvsc`, so they cannot say which is Wi-Fi.
- An agent **inside** WSL still installs, for hands and models only. It reports its hold, relay and power-fact roles as `cannot: this agent runs inside WSL; Windows' sleep and adapters are outside its reach — install the Windows agent`.

**D-2. The builtin `hub` row has `kind ∈ {bundled, agent}`.**
- `bundled`: `base_url = OLLAMA_URL`, facts come from the gateway process, transport `internal`.
- `agent`: `machine_id` is the hub host's paired agent, reached over the hub's transport like any other agent.
- `machine_configure(machine="hub", models_via=…)` switches it and reads the value back.
- The bundled container stays the embedder in both cases: `embedding.py:75` defaults to `http://ollama:11434`.
- A kind switch never relabels a measurement, because stamps are taken per request.

**D-3. Compute grammar (exact).**
```
served_on := dev ("+" dev)*                 ; sorted, ≤4, header-safe
dev := "gpu:nvidia:" uuid                   ; nvidia-smi uuid, lowercased, "GPU-" stripped (Linux, Windows, Docker Desktop)
     | "gpu:" ("amd"|"intel") ":pci-" vvvv "-" dddd "-" ssssssss "|" vram "g"   ; class id: PCI ids + floor VRAM GiB
     | "apple:" chip ["|" gc "gc"] "|" mem "g"   ; chip slug from brand ("m4-pro"), GPU cores from ioreg, hw.memsize
     | "cpu:" model "|" n "c|" mem "g"           ; logical CPUs and MemTotal as the process sees them
slug := lowercase, [^a-z0-9.]+ -> "-", trimmed, ≤48
```
- **Which devices a request is stamped with**, read from `/api/ps` for the served model:
  - `size_vram == size` → the accelerator(s);
  - `0` → the `cpu:` device;
  - anything between → accelerator `+` cpu. A partial offload therefore gets its own identity and is never averaged into GPU speed.
- **Inside a container** the `cpu:` id describes the VM (Docker Desktop). That is correct, because it is different compute.
- **The runtime is not part of identity.** `container` or `native` is recorded beside it (`probes.runtime`, span `meta.runtime`). Speed baselines key on `(served_by, served_on, runtime)`.
- **Two identical AMD cards, or two identical Macs, share an id.** This is accepted: identity here means the performance class.
- **Legacy rows** carry no compute and are never read by fit or speed (the 008 precedent).

**D-4. The hub runs on Linux, macOS, or Windows with WSL.**
- A Windows machine **without** WSL can be any node but not the hub. `install.sh` needs bash, and Docker Desktop's GPU path needs WSL2 anyway ([Docker GPU docs](https://docs.docker.com/desktop/features/gpu/)).
- `install.ps1` states `cannot` and prints `wsl --install`. This is owner question 1.

## Components

| Component | Owns |
|---|---|
| Gateway `engines.py`, `engines_api.py`, `routing.py`, `data_plane.py`, `catalog.py`, `admin.py` | As in the baseline, plus `kind`, `transport` and `runtime`. Engine clients come from `engines.client(row)` with bearer, proxy or pin. |
| Gateway `compute_id.py` (new) | Parses and validates the grammar, and computes `served_on` for bundled engines. Golden vectors are shared with the Go agent. |
| Agent (Go, agent area) | models (reverse proxy, `/agent/v1/*`, lease), hold, relay (`net.wake`), facts (`host_power`, compute ids), hands (existing capabilities) |
| Core `machines.py`, `machines_api.py`, `tools/machines.py`, `wake.py`, `checks/machines.py` | Machine list = paired devices + engines + checklist; `link_models` (receives the token from the envelope result and forwards it to gateway `POST /admin/engines`); wake; overrides |
| `deploy/install.sh` + `deploy/backup.sh` | Hub install on Linux, macOS, or Windows with WSL; backup, restore, move |
| Core image | Serves `/api/v1/agent/{install.sh,install.ps1,SHA256SUMS,<os>-<arch>}`. Reuses S31's signed manifest if S31 lands first. |

## Per-OS matrix

Status key:
- **V**: verified now, or walked in a slice on the available hardware.
- **CI**: cross-compiled plus native `go test` on GitHub runners `macos-15-arm64`, `windows-2025` and `windows-11-arm` (labels verified), using fixtures.
- **M**: needs a P0 measurement.
- **UNW**: unwalked.

| Capability | Linux | macOS | Windows native | Windows + WSL |
|---|---|---|---|---|
| Hub runs the stack | Docker Engine + `install.sh` — V (mini PC) | Docker Desktop + `install.sh` under bash 3.2 — CI (bash unit tests on `/bin/bash`; no Docker on the runners), UNW | not supported (D-4) | Docker Desktop + `install.sh` in WSL — V (Dell today) |
| Hub runs models | `bundled` (NVIDIA overlay or CPU) — V (N150 CPU); `agent` → native Ollama — optional walk | `agent` → Ollama.app on Metal. Docker has no GPU ([Ollama blog](https://ollama.com/blog/ollama-is-now-available-as-an-official-docker-image)); the bundled container stays the CPU embedder — CI, UNW | — | `bundled` via GPU-PV — V; `agent` → native Windows Ollama — V (S44 walk) |
| Node models role | User systemd unit fronting systemd `ollama` — V (mini PC) | LaunchAgent fronting Ollama.app, **only while logged in** ([ollama#2955](https://github.com/ollama/ollama/issues/2955)) — CI, UNW | Logon Scheduled Task fronting Ollama's per-user app, which runs at login and needs no admin ([docs.ollama.com/windows](https://docs.ollama.com/windows)) — V (Dell) | The Windows agent fronts Docker Desktop's `127.0.0.1:11434` (starts only at logon, verified) — V (Dell); agent inside WSL is degraded (D-1) — V |
| Compute id | `/proc`, nvidia-smi, sysfs PCI ids and `mem_info_vram_total` — V for CPU and NVIDIA; AMD/Intel CI | `sysctl machdep.cpu.brand_string`, `hw.memsize`, `ioreg` gpu-core-count — CI (real sysctl on the M-series runner VM), UNW | Registry `ProcessorNameString`, `nvidia-smi.exe`, display-class registry `HardwareInformation.qwMemorySize` for non-NVIDIA — V (NVIDIA) | Same as Windows native |
| Offload truth | `/api/ps` `size_vram` ([API doc](https://docs.ollama.com/api/ps): "VRAM usage in bytes") — V | Same field; its meaning under unified memory is **assumed** — UNW | V | V |
| Hold | logind `Inhibit("sleep","block")` fd over D-Bus. Polkit default for `inhibit-block-sleep` is `allow_any=auth_admin_keep`, `allow_active=yes` ([policy](https://github.com/systemd/systemd/blob/main/src/login/org.freedesktop.login1.policy)), so a linger unit outside a session needs a one-time polkit rule (one sudo line) — M (P0-9) | `caffeinate -i -t N` child, restarted before expiry; pure Go, no cgo — CI, UNW | `PowerCreateRequest` + `PowerSetRequest(SystemRequired)` with a reason, falling back to `SetThreadExecutionState(ES_CONTINUOUS\|ES_SYSTEM_REQUIRED)` on a `LockOSThread` goroutine. **Neither is wrapped in x/sys/windows** (checked `zsyscall_windows.go`), so both go through a kernel32 `LazyProc`. The unattended timeout (default 120 s) applies after a WoL wake ([MS](https://learn.microsoft.com/en-us/windows-hardware/customize/power-settings/sleep-settings-sleep-unattended-idle-timeout)); requests end on user-initiated sleep ([PowerSetRequest](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest)) — M (P0-5) | Windows agent (same as native); agent inside WSL: cannot |
| Wake relay (LAN UDP) | Go sets `SO_BROADCAST` by default (Go source) — V (mini PC) | Same default (verified in `sockopt_bsd.go`). LaunchAgents get Local Network privacy prompts; root daemons are exempt (TN3179, per [Apple forums](https://developer.apple.com/forums/thread/763753)) — UNW | Same default (verified in `sockopt_windows.go`). Egress interface for limited broadcast — M (P0-13) | Windows agent |
| Power facts / wake checklist | `/sys/class/net/*/device/power/wakeup`; nmcli `802-3-ethernet.wake-on-lan` / `802-11-wireless.wake-on-wlan` = `magic`; `/sys/power/mem_sleep`; ethtool needs root (stated) — partly V | `pmset -g`: `womp` shows only on AC ([ss64](https://ss64.com/mac/pmset.html)); "Wake for network access" is under Energy (desktops) or Battery → Options (laptops) ([Apple](https://support.apple.com/guide/mac-help/set-sleep-and-wake-settings-mchle41a6ccd/mac)) — CI, UNW | `powercfg /a`, `/devicequery wake_armed`, `/lastwake`, `/qh SUB_SLEEP` (incl. `UNATTENDSLEEP`), `HiberbootEnabled`, adapter power management. Which reads need elevation — M (P0-12) | Windows agent |
| Service manager | systemd user unit + linger (existing `novad.service`) — V | LaunchAgent (default); LaunchDaemon (root) mode for relay-only machines — CI, UNW | Scheduled Task "at logon, only when logged on", in the same session as Ollama and Docker Desktop — V; Windows Service (session 0) mode for relay/hold only — CI, UNW | Windows task |
| Backup / restore | V (mini PC) | CI, UNW | — | V (Dell) |
| PWA install | Tailnet HTTPS via serve — V. Headscale has no `tailscale cert` ([headscale#2527](https://github.com/juanfont/headscale/issues/2527), open). LAN has no trusted HTTPS, so a phone cannot install ([web.dev](https://web.dev/articles/install-criteria): "Be served over HTTPS") | same | same | same |

## Data model and migrations

The rule from the baseline still holds: **whichever of this plan and doing-things lands second renumbers**.

**Gateway `009_engines.sql` (S40).**
- Everything the baseline's 009 has.
- Plus `engines.kind text NOT NULL DEFAULT 'bundled' CHECK (kind IN ('bundled'))`.
- `probes ADD provider, compute, runtime CHECK (runtime IN ('container','native')), path CHECK (path IN ('local','tailnet','lan'))`.
- `usage_events ADD served_on`.
- A providers-only CHECK.

**Gateway `010_engine_agents.sql` (S44).**
- The `kind` CHECK widens to `('bundled','agent')`.
- `ADD machine_id uuid` (the core device id; there is no cross-database FK), `transport text CHECK (transport IN ('internal','tailnet','lan'))`, `tls_pin text CHECK (tls_pin ~ '^[0-9a-f]{64}$')`, `runtime text`.
- Shape CHECKs:
  - `(kind='bundled') = (machine_id IS NULL)`;
  - `(kind='bundled') = (transport='internal')`;
  - `(transport='lan') = (tls_pin IS NOT NULL)`.
- The pin CHECK lands now so that S49 needs no migration.

**Core migrations.**

| Number | Slice | Contents |
|---|---|---|
| 035 `_hub_engine` | S40 | Rewrite `chat.model` / `chat.vision_model` from `ollama:X` to `hub:X` |
| 036 `_machine_facts` | S42 | `devices ADD facts jsonb, facts_at timestamptz, os text CHECK (os IN ('linux','darwin','windows')), arch text, agent_version text`. `platform` now carries the real GOOS; it was hardcoded `"linux"` at `main.go:162`. |
| 037 | S43 (transport area; number reserved) | The tailnet credential table, and `tailnet_origin` with baseline provenance (the sidecar address must be the client). |
| 038 `_wake` | S46 | Baseline 037, re-keyed by machine: `machine_overrides(device_id PK FK devices ON DELETE CASCADE, mac_override macaddr[1..4], relay_override uuid FK devices ON DELETE SET NULL)`; `wake_attempts.machine_id uuid` (no FK), plus `engine text`, the baseline columns and `wake_source`; setting `machines.wake_max_wait_s`. |

S48 and S49 migrations, if any, are the transport area's.

## Wire contracts

**Auth-frame `facts`** (additive under `devices_ws.py:52-67`; merged with S30's `build`):
```
{v:1, agent:{version, build, service, roles:{hands,models,relay,hold,facts: "ok"|"cannot: <reason>"}},
 os:{goos, arch, name, version, wsl}, hostname, cpu:{model, logical}, memory_bytes,
 gpus:[{vendor, name, id, vram_bytes|null, source}], compute:{accel:[dev…], cpu:dev},
 ifaces:[{name, mac, ipv4[], up, kind, physical}], gateway:{ip, mac, iface},
 transport:{kind, addr, port, dns_name?, tls_pin?},
 host_power:{sleep_after_s, hibernate_after_s, unattended_sleep_s, standby:"s3|s0|s2idle|deep|unknown",
   wake_armed:[{iface, macs[], magic, pattern, source}], fast_startup, womp,
   last_wake:{at, source}, unreadable:[{item, reason}]},
 hold:{mechanism, active, remaining_s, error}}
```

**Envelopes** (signed by core, one use):
- `models.link {engine, rotate}` → `{token, listen:{transport, addr, port, tls_pin?}}`. The token appears only in the result frame. The audit `summary` is `"linked; token sha256:abcd…"`.
- `models.unlink`.
- `net.wake {macs[1..4], subnet, unicast_ip?, port:7|9}` → `{sent[], failed[], neighbor}`, as in the baseline.
- `power.facts` refreshes `host_power`.

**Agent models listener.** It binds only on the transport: the tsnet listener, or LAN TLS (S49).
- `GET /agent/v1/live`: no auth, probes nothing downstream.
- `GET /agent/v1/facts`, bearer.
- `GET /agent/v1/ready?model=` returns the baseline body plus `runtime`.
- Proxy allowlist under `/agent/v1/ollama/…`: the baseline's verbs; anything else returns 404.
- Every generation response carries `X-Nova-Agent-Served-On`, computed from `/api/ps` when upstream headers arrive, and `X-Nova-Agent-Runtime`.
- `X-Nova-Hold-S` (60–1800) sets the lease. The agent holds while `in_flight > 0` or the lease is live.
- With no token it answers 503 `models role not linked — refusing all requests`.

**Gateway.**
- The baseline `/admin/engines*` routes are kept.
- `POST /admin/engines` takes `{name, machine_id, base_url, token, transport, tls_pin?, runtime, facts}`. It is called only by core's `link_models`. It verifies with a call back to `/agent/v1/facts`, and writes nothing on failure.
- `PUT` also accepts `models_via` for `hub`.
- `X-Nova-Served-On` passes the agent's value through, or computes it for `bundled`.

**Core → web.**
- The `code` frame is never persisted: `{code, code_id, expires_at, origin, commands:{linux, darwin, windows}}`.
  - linux, darwin, WSL: `curl -fsSL <origin>/api/v1/agent/install.sh | sh -s -- --hub <origin> --code <c>`;
  - windows: `& ([scriptblock]::Create((irm <origin>/api/v1/agent/install.ps1))) -Hub <origin> -Code <c>`.
- The `wake` frame is as in the baseline.

## File-level changes (beyond the baseline's lists)

**Gateway**
- `app/compute_id.py` (new): `parse`, `served_on(ps_row, devices)`, `bundled_devices()` (`/proc` plus `devices_vram`).
- `devices_vram._QUERY` (`devices_vram.py:60`) appends `,uuid,name`.
- `engines.client(row)`: proxy chosen by `transport`; SPKI pin for `lan`.
- `data_plane` stamps `served_on`/`runtime`.
- `providers.base_url_of` (`:82-92`) and `ensure_builtin` (`:222-237`) become kind-aware.

**Core**
- `tools/devices.py:108-116` `_check_fs_path(path, os)`: `ntpath` for `os='windows'` (drive or UNC), `posixpath` otherwise.
- `devices_ws.authenticate` stores `facts`.
- `machines.link_models`: signed `models.link`, then gateway create, then a read-back. A compensating `models.unlink` runs on failure.
- `checks/stack.py:49-50,207-215` uses `kind`-aware sources.
- `model_speed._RATES_SQL` (`:141-147`) keys on `(served_by, served_on, runtime)`.

**Deploy**
- `install.sh`:
  - `detect_accelerator` (Darwin/arm64 → "Docker cannot use this Mac's GPU; models run through the Nova agent");
  - `host_routes_in_use` (`ip -4 route` or `netstat -rn`);
  - `sha256_of` (`sha256sum`, else `shasum -a 256`);
  - the `extra_hosts: host.docker.internal:host-gateway` line on the gateway is not needed: `agent` hubs are reached over the transport.
- `deploy/install.ps1` states `cannot` for a Windows hub without WSL.
- `backup.sh` does every tar and hash inside throwaway containers, and refuses archive paths under `/mnt/[a-z]/` (NTFS cannot hold 0600).

**Web**
- `MachinesSection.tsx`: a tile per machine with OS, roles and their `cannot` reasons, engine, compute, hold, wake.
- `AddMachineFlow.tsx`: per-OS tabs plus a transport choice (Tailscale now; Headscale and LAN appear greyed with "arrives in S48/S49" until built).
- `ChooseEngine.tsx:14-35`: "This machine" (bundled, or native through this machine's agent on a Mac), "Another machine", "Remote endpoint" (kept, for non-Nova servers), "Cloud".
- `HardwareDetection.tsx:108` wording for Apple silicon.

## Nova's tools, guards and eval cases

The registry grows from 39 to **46**. `suite_version` grows from 13 to 20, and the corpus from 23 to 33, before any transport-area cases.

| Slice | Tool (registry) | Guards | Eval (suite / corpus) |
|---|---|---|---|
| S40 | `machine_status` (AUTO_RUN), `machine_configure` (+`models_via`, `runs_models`) → 41 | `_MODEL_REF` prefix generalised (`guards.py:125,133,1862`); `configured_machine` narration kind; generic capability phrases | `checks-where-models-run-before-saying`, `switches-serving-off-when-told` → 14 / 25 |
| S42 | `machine_add_code(name?, os?)` → 42. The result says "the command for <os> is on your screen". | `code_claim` at both sites (`chat.py:4256-4410`, `:3281-3315`); `_SETUP_MACHINE` offer class; capability phrase "can't set up/add (a|your) (mac|windows|linux|pc|computer|machine)" | `adds-a-machine-on-the-os-named` ("add my MacBook"): `tool_called machine_add_code`, `guard_absent code_claim`, `reply_absent \bWSL\b` → 15 / 26 |
| S43 | `machine_join` → 43 (the transport area owns its shape) | theirs | theirs → 16 / 27 |
| S44 | none. `machine_configure(runs_models=true)` triggers `link_models`. | `state_claim` gains machine subjects and sleep words; `stack_claim` carve-out rule 1 (`:4705`); **new `where_served_claim`**: first-person present "I'm running/answering on <alias>" is backed only by this turn's `served_by` engine | `turns-models-on-for-a-machine` (fixture `eval_box`) → 17 / 28 |
| S45 | `machine_handover` → 44 | `handed_over` kind | `moves-local-models-when-asked` → 18 / 29 |
| S46 | `machine_wake` → 45 | `_WOKE_MACHINE` anchored on live aliases; `_WAKE_MACHINE` in offer classes only; 3 phrases | the baseline's three → 19 / 32 |
| S47 | `nova_address` → 46 | `address_claim` (any https origin that is not observed) | `gives-the-real-address-for-another-device` → 20 / 33 |

Two notes:
- If S29 has landed, every narration kind is written as `Tool.backs`.
- `test_no_approvals` stays green throughout. Every refusal says `cannot`: for example "needs an elevated PowerShell — here is the one line", or "BIOS: I cannot reach firmware".

## The revised slice plan

**Order:** P0 → S40 → S41 → S42 → S43 → S44 → S45 → S46. S47 can land any time after S43. Then S48 and S49.

- Each slice ends with Nova doing the thing in chat, and the `turn_spans` being read.
- Pins move in every slice: `test_tools_registry.py:115,501,550`, `test_live_facts`, `test_capability_guard.py:36`, `test_eval_corpus.py:376,382,423`, plus `tabs.test.tsx:47` where the web changes.
- Every slice's walk includes the web at 393 px.

### S40: engines, identity, the "runs models" switch (Dell hub)
- **Scope:** the baseline S40, plus D-3's grammar and `engines.kind`.
- **Migrations:** gateway 009, core 035.
- **New tests:**
  - golden `compute_id` vectors, shared with Go later;
  - `served_on` equals the `gpu:` device, `gpu:…+cpu:…` or the `cpu:` device, for `size_vram` equal to size, in between, and zero;
  - a stale database value is ignored.
- **DoD:**
  1. `chat.model=hub:qwen3.8:27b`.
  2. "Where do your models run?" She calls `machine_status`.
  3. The probe row shows `compute=gpu:nvidia:<uuid>`, `runtime=container`.
  4. "Stop running chat models here" → `machine_configure`, then the route frame names the cloud link that answered.

### S41: portable hub and verified backup/restore (drill only)
- **Scope:** the baseline S42a, moved earlier because it needs no agent. It adds the portability fixes above.
- **Tests:** `backup_test.sh` and `install_test.sh` run in CI under macOS `/bin/bash` 3.2 as well as Linux.
- **Migrations and tools:** none.
- **DoD:** a routine backup on the Dell, then `restore --drill` on the mini PC. Counts, md5s and the key fingerprint are equal, and a Windows `/mnt/c` archive path is refused. There is no chat step: this slice is operator tooling, and the chat walk comes in S45.

### S42: one agent per machine, any OS (hands, facts, service, downloads)
- **Scope:** the agent area's internals, plus core 036, the Windows path check, `machine_add_code` and the per-OS card.
- **Transport:** whatever reaches core today (localhost, or the tailnet URL through host Tailscale).
- **DoD (Dell and mini PC):**
  1. "Add my Windows side of the Dell." The card shows PowerShell. After install, `device_info` returns Windows facts.
  2. `device_read_file C:\Users\…\hosts` works.
  3. The in-WSL novad, upgraded, reports "hold: cannot (inside WSL)".
  4. The mini PC agent pairs.
  5. `machine_status` lists both machines with their roles.
- **macOS:** `go test` passes on `macos-15-arm64`, with real sysctl facts. UNW.

### S43: Tailscale join (transport a, the transport area's design)
- **My requirements:** core 037 reserved; engines untouched.
- **DoD:**
  1. The paired Dell Windows agent is moved onto its own tsnet node. The login link is shown as a never-persisted card.
  2. The agent's control WebSocket then runs over tsnet.
  3. P0-7 numbers are restated.
  4. The OAuth path is walked if the owner supplies a credential.

### S44: models role and engines over agents (the baseline S41, revised)
- **Scope:** gateway 010; `link_models`; routing across engines, the wait rule, the 409, and the lease; the hub sidecar's outbound proxy.
- **Tests:**
  - `models.link` token custody: the token is not in the audit summary or in any span;
  - two-agent routing;
  - an agent transport that raises if touched under D11;
  - `kind` switch read-back.
- **DoD:**
  - **(a)** "Use my mini PC for models." `machine_configure(mini, runs_models=true)`. Pull `mini:qwen3:0.6b`. Its answer shows `served_on=cpu:intel-r-n150|4c|15g`, and `systemd-inhibit --list` shows Nova's hold during generation (P0-9 decides whether the polkit line was needed).
  - **(b)** "Serve the hub's models from native Ollama." `machine_configure(hub, models_via=agent)` points at the Dell's Windows agent fronting native Windows Ollama on another port. Answers stamp `gpu:nvidia:<uuid>` with `runtime=native`. This walks both the Windows-native node path and the Mac-hub shape. Then switch back.

### S45: the move and handover (the baseline S42b)
- **Runbook:** the baseline's, with C6 changed.
  - C6: the Dell's Windows agent is already paired and on tsnet. Run `nova-agent ollama container --gpu --adopt nova_v4_ollama`, shown on the card and run by the owner, because it can exceed the 110 s command cap (`client.go:32`) until S30's detached jobs exist. Then `machine_configure(dell, runs_models=true)`.
  - A mini PC hub-host agent is installed for relaying.
  - `host_sees_node_online` falls back to the API check when the host has no tailscale CLI.
- **DoD:** the baseline's handover walk in **WSL mode**. `served_by=dell:qwen3.8:27b`, `served_on=gpu:nvidia:<uuid>`, `runtime=container`. Fit for `dell:` reads the probes stamped in S40. The hold is visible in `powercfg /requests` with Nova's reason string.

### S46: wake (the baseline S43)
- **Scope:** core 038; relay = any agent; the checklist per OS.
  - Windows: Wake on Magic Packet and wake-armed; hibernate-after (Wi-Fi cannot wake from S4); Fast Startup (S5 only); unattended 120 s; `s0` vs `s3`; ProtonVPN kill switch.
  - macOS: Wake for network access / `womp`; Wi-Fi caveat; lid.
  - Linux: nmcli `magic`, `power/wakeup`, `mem_sleep`, desktop auto-suspend, ErP.
  - BIOS "Wake on LAN/WLAN" and "Deep Sleep": she cannot reach these.
- **DoD:** the baseline's steps with the mini hub relaying to the Dell, in the P0-1 branch. The checklist is read from native facts, with no interop.

### S47: thin clients (the baseline S44)
- The baseline design, plus the origin's `trusted_https` flag.
- For LAN and Headscale origins it says: "phones cannot install from this address; bookmark it, or use the tailnet."

### S48: Headscale and S49: plain LAN
- These are the transport area's slices.
- On my side:
  - S49 gateway pinning for `transport='lan'` (the columns already exist from 010);
  - the backup includes the Headscale state and the LAN TLS key volume;
  - `address_claim` covers LAN origins.

## Phase 0, revised

These use stock tools plus throwaway probe binaries under scratch, never product code.

**Kept from the baseline:**
- P0-1 WoWLAN, which also reads `powercfg /a` for S3 vs S0;
- P0-2 whether probing wakes it;
- P0-3 time to ready;
- P0-6 Docker Desktop lifetime, which now also covers native Ollama's tray starting at logon;
- P0-8 the N150 embedder;
- P0-10 the longest silence in a pull;
- P0-11 the gaps between rounds and turns.

**Changed or new:**

| ID | Measure | Branch |
|---|---|---|
| P0-4 | CUDA after S3 resume, **both** Docker Desktop and native Windows Ollama: `size_vram == size`, ×5 each | The default Dell runtime is whichever passes 5/5. If both fail: the owner. |
| P0-5 | A Go probe started by a **logon Scheduled Task**: `PowerSetRequest` vs `SetThreadExecutionState` (with `LockOSThread`) after an unattended packet wake. Does it stay up 10 min, and does it sleep within unattended + 60 s after release? | Pick the mechanism that holds; if neither holds, "the hold is impossible" is stated. |
| P0-7 | tsnet node inside a Windows-native process **with ProtonVPN up**: direct or DERP, connect p50/p99, SSE intact, tok/s vs local, the failure mode while asleep; whether a Windows Firewall prompt appears | Sets `ENGINE_REACH_S`. No path → the owner. |
| P0-9 | Mini PC: `systemd-inhibit --what=sleep --mode=block` from the linger unit; systemd version; does COSMIC's auto-suspend honour it? | Refused → print the polkit rule line. |
| P0-12 | Which Windows facts read without elevation | Anything that needs elevation goes into `unreadable[]` with its reason. |
| P0-13 | A Windows Go sender with the Wi-Fi, vEthernet, ProtonVPN and Tailscale adapters present: which interface 255.255.255.255 and x.y.z.255 leave on (capture on the mini PC) | Subnet-directed broadcast first if the limited broadcast strays. |
| P0-14 | tok/s for gateway → sidecar → tsnet to the hub's own host agent, vs the bundled container | Above 5% overhead → `agent` hubs are stated as slower. |

**First measurements once a Mac exists (UNW until then):**
- the Local Network prompt for a LaunchAgent relay;
- `caffeinate -i` holding after a `womp` wake;
- `size_vram` semantics on Metal;
- Ollama.app lifetime at the login window;
- whether a curl-fetched binary runs under Gatekeeper (sources disagree).

## Live walks, and what stays UNWALKED

**Walked:**
- the mini PC as hub, node and relay (Linux);
- the Dell as hub (WSL and Docker Desktop), as a Windows-native agent with native Ollama, as a Windows agent fronting Docker Desktop Ollama, and as an agent inside WSL (degraded).

**UNWALKED, stated in each slice's carries:**
- every macOS path: hub install, agent service, facts on real hardware, Metal, hold, relay, the Local Network prompt, Wake for network access;
- the Windows Service (session 0) and LaunchDaemon modes;
- AMD/Intel compute ids (fixtures only);
- Windows and Linux on arm64 (CI only);
- multi-GPU;
- a Wi-Fi wake, unless P0-1 passes;
- Headscale and LAN until S48/S49.

## Risks

1. **Ollama is per-user on every desktop OS.** After a reboot with nobody signed in, a node serves nothing. This is stated on the machine tile, and not worked around.
2. **Legacy WSL novad plus the Windows agent** show as two devices for one machine. The tile flags a hostname match and states it, without deciding anything.
3. **Unsigned binaries** trigger SmartScreen and Gatekeeper, and tsnet adds roughly 20–30 MB (not measured).
4. **Class-level GPU ids** merge identical cards. Accepted and documented.
5. **The Tailscale credential is a new secret.**
   - It is stored plaintext in core until Proposal A, like `003_providers.sql:22`, masked in spans and never in a tool result.
   - Proposal A's key-encryption key must then be carried by `backup --move`. That reverses the baseline's "fresh secrets" rule, and is a dependency to record.
6. **Scheduler contention** for the Dell's card: still not addressed (state, never decide).

## Interfaces required

**From the agent area:**
1. `{linux,darwin,windows}×{amd64,arm64}` builds with `CGO_ENABLED=0`. Native `go test` on the three runner OSes.
2. The `facts` shape above. A shared `computeid` Go package whose vectors byte-match the gateway's.
3. `models.link`/`unlink`, `net.wake`, `power.facts`. The models listener and routes above. The in-process lease and hold per the matrix.
4. Service installers per OS. Core-served `/api/v1/agent/*`, reusing S31's signed manifest.
5. `repoint` (keeping the pinned key), and `ollama container --adopt`.
6. Agent inside WSL: degraded roles, stated as `cannot`.

**From the transport area:**
1. `facts.transport` addresses. In tailnet mode the models listener binds **only** on tsnet.
2. Gateway egress per `engines.transport`: the sidecar proxy (Tailscale or Headscale), or LAN with an SPKI pin.
3. Join flows: the login-link card (never persisted, like the code); the credential table (037); minted keys tagged `tag:nova-agent`; an ACL that lets the hub reach agents on 11435 only.
4. A **bootstrap download path** for a machine that is on no overlay yet. My proposal: the hub serves `/api/v1/agent/*` on the LAN only while an add-machine code is live, with the sha256 printed on the card.
5. Transport state volumes included in the backup, and a peer-online check through the API.
6. Origins carrying `trusted_https`.

## Collisions

**Doing-things (branch `claude/nova-autonomous-capabilities-c25b5c`, unmerged):**
- S29: `Tool.backs` replaces `_KIND_TOOLS`, and it also moves `suite_version` from 13 to 14.
- S30:
  - migration 035;
  - the `Dispatch` handlers table (my roles plug into it);
  - `build` in the auth frame (merge it into `facts.agent`);
  - `daemon.info` overlaps `facts`;
  - re-pointing the daemon at `:8000` fits only the hub-host agent;
  - its registry move 39 → 44 collides with mine;
  - `NOVA_STACK_HOSTNAME` changes at the move.
- S31: self-update and a two-architecture Linux build. It must widen to six targets, and its systemd-only revert needs launchd and Task Scheduler equivalents. Until then, updating on Windows or a Mac means re-running the install command.
- S38+ "every device": this plan claims that item.
- Rule: whichever lands second renumbers and re-bumps once.

**Roadmap item 0 (the core suite wedges at about 12%, `ROADMAP.md:41-57`):** no slice here can show a full-suite green. I recommend doing item 0 before S40. Otherwise each slice merges on targeted suites plus its walk, as S28 did, and says so.

## Open questions for the owner

1. **A Windows hub without WSL.** Accept "a Windows hub needs WSL; Windows nodes do not" (D-4)?
2. **Code signing.** Pay for an Apple Developer ID and a Windows Authenticode certificate, or ship unsigned with the Gatekeeper and SmartScreen friction stated? The Mac stays unwalked either way.
3. **Order.** Where do S40–S49 sit relative to item 0, doing-things S29–S31, S26 and Proposal A? The Tailscale credential makes Proposal A more urgent.
4. **Only if a measurement triggers them:** the baseline's conditional questions for P0-1, P0-6 and P0-7.

## Verified vs assumed

**Verified this session:**
- [tsnet fields, auth order and login URL](https://pkg.go.dev/tailscale.com/tsnet); tsnet uses a userspace network stack ([Tailscale docs](https://tailscale.com/docs/features/tsnet)).
- [OAuth clients](https://tailscale.com/docs/features/oauth-clients): the `auth_keys` scope needs tags; tokens last 1 h; the secret can be used as an auth key.
- [HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates) need MagicDNS, and machine names go into public CT logs.
- Headscale `tailscale cert` is still open ([#2527](https://github.com/juanfont/headscale/issues/2527)).
- [SetThreadExecutionState](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate), [system sleep criteria](https://learn.microsoft.com/en-us/windows/win32/power/system-sleep-criteria), the [unattended timeout](https://learn.microsoft.com/en-us/windows-hardware/customize/power-settings/sleep-settings-sleep-unattended-idle-timeout), [PowerSetRequest](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest).
- x/sys/windows does not wrap either API (`zsyscall_windows.go`).
- Go's `SO_BROADCAST` default on Windows and BSD (`sockopt_*.go`).
- The logind polkit defaults.
- Ollama on [Windows](https://docs.ollama.com/windows), [macOS](https://docs.ollama.com/macos), the [FAQ](https://docs.ollama.com/faq), [GPU support](https://docs.ollama.com/gpu) and [/api/ps](https://docs.ollama.com/api/ps).
- Docker Desktop: [host networking is layer-4 only](https://docs.docker.com/engine/network/drivers/host/); GPU needs the WSL2 backend; it starts only at logon ([docker/roadmap#515](https://github.com/docker/roadmap/issues/515)).
- Apple's [sleep and wake settings](https://support.apple.com/guide/mac-help/set-sleep-and-wake-settings-mchle41a6ccd/mac); the Local Network privacy exemption for daemons ([Apple forums](https://developer.apple.com/forums/thread/763753)).
- The Go linker ad-hoc signs darwin/arm64 binaries.
- The GitHub runner labels ([changelog](https://github.blog/changelog/2026-05-14-github-actions-upcoming-image-migrations/)).

**Assumed, and assigned to a check:**
- Windows Firewall prompts for tsnet (P0-7).
- Power requests surviving the unattended timeout (P0-5).
- `size_vram` semantics on Metal (Mac first measurement).
- Gatekeeper and curl downloads (Mac first measurement).
- COSMIC honouring logind block inhibitors (P0-9).

### Critical Files for Implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/routing.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/providers.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/devices_ws.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/apps/novad/internal/caps/caps.go
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/deploy/install.sh