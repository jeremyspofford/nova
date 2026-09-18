# Nova agent (novad grows): cross-platform design

## Summary

- **One binary, one pairing per machine.** `novad` stays the only agent: pure Go, `CGO_ENABLED=0`, built for linux/darwin/windows × amd64/arm64. It has five role modules: **hands** (the existing caps), **models** (fronts that machine's Ollama), **relay** (`net.wake`), **hold** (lease-driven stay-awake) and **facts**. Pairing keeps today's ed25519 enroll plus challenge/auth.
- **A role is availability, not permission.** Roles are derived from the facts the agent reports, plus the owner's "this machine runs models" switch, which is stored as gateway `engines.serving`. The agent still runs whatever core signs (`apps/novad/README.md:97-102`). Nothing is stored as a grant, and `devices` gains no `capabilities` column; `test_no_approvals.py:292` pins that.
- **The models role replaces the whole baseline node package.** The baseline's `services/node`, `deploy/node/*`, the node tailscale sidecar, `nova-hold.ps1/.sh`, the `127.0.0.1:11436` helper channel and `hold.token` are all gone. In their place is one in-process listener:
  - a fixed-allowlist reverse proxy in front of `127.0.0.1:11434`;
  - a bearer token, stored on the agent only as a sha256;
  - TLS with the agent's own self-signed certificate, pinned at pairing;
  - bound only on the chosen transport: a tsnet listener for Tailscale or Headscale, or the LAN interface address.

  The same TLS is used on every transport, so nothing depends on Tailscale HTTPS certificates, which Headscale lacks [6].
- **Hold is in-process, driven by the lease on the proxy.**
  - Windows: `PowerCreateRequest`/`PowerSetRequest(PowerRequestSystemRequired)`.
  - macOS: a supervised `caffeinate -i -s -w <pid>` child.
  - Linux: a `systemd-inhibit` child.
- **The installer logic is Go (`novad install`) on every OS.** The per-OS one-liner only downloads from the hub, checks a sha256 that is embedded in the code card, and runs the binary. So a Windows machine without WSL needs no bash.
- **Mac support is built and CI-tested but UNWALKED.** The GitHub `macos-latest` and `windows-latest` runners execute the unit tests natively, but that is not a walk on real hardware.

## What changes vs the baseline

**Kept as is:**
- **Engines** (gateway `009`), the wait rule, the typed 409, `X-Nova-Served-By`/`-On`, `X-Nova-Skip-Engines`, and "no wall on a connect failure".
- **Wake and data**: core `wake_attempts`, `net.wake` (contract unchanged), the relay derivation (subnet plus gateway MAC), and the code card, which never enters her context.
- **The node contract, same paths**: `/node/health/live`, `/node/facts`, `/node/ready`, the allowlist, `X-Nova-Hold-S` clamped to 60–1800 s, and `X-Nova-Node-Compute`.
- **novad fixes and tools**: novad D3 (backoff reset, ping, resume detector), `repoint`, the tools `machine_status`, `machine_configure`, `machine_wake`, `machine_handover`, `nova_address`, and the guards `code_claim` and `state_claim`.

**Changed:**

| Baseline | Now |
|---|---|
| `pairing_codes.purpose ∈ {device, inference_node}`, public `POST /api/v1/machines/enroll`, gateway callback to the node | One code kind. Enrollment is the ordinary device enroll. The engine is created later by the signed `models.enable` → core → `POST /admin/engines` |
| Host power facts from the helper, cached in gateway `engines.last_facts` | Written by the agent into core `devices.facts` over WSS, read by `wake.plan`. The gateway keeps compute, ollama, `models_disk` and hold (via `/node/facts`) |
| `compute = gpu:GPU-<uuid>` or `cpu:…` | `gpu:<vendor>:<stable-id>` or `cpu:<model>\|<n>c\|<GiB>g`. S40 is unbuilt, so this is defined once, before any row exists |
| Base URL must be `https://*.ts.net` | Any `https://<ip>:11435` plus `providers.tls_pin` |
| `./install node`; Dell as a WSL/Docker node | `novad install` on any OS. On the Dell, the **Windows-native** agent fronts Docker Desktop's Ollama or native Ollama |
| `machine_add_code(kind)` | `machine_add_code(name?, os?)` |
| novad Linux-only | Build tags per OS; the `devices.py:114-116` path check becomes platform-aware |

## Components

| Package (apps/novad) | Owns |
|---|---|
| `internal/platform` | `Info`, `Paths`, `Exec` (injectable runner), `MachineUID`, `Session`. `*_linux.go`, `*_darwin.go`, `*_windows.go`, plus `fake.go` |
| `internal/caps` | A dispatch table (the literal switch at `caps.go:45-66` goes, shared with doing-things S30) that calls platform adapters |
| `internal/facts` | Identity, interfaces, gateway, power, `roles.available` with reasons |
| `internal/compute` | Vendor-neutral compute: nvidia-smi, amd-smi/rocm-smi, Apple sysctl, Windows PnP, CPU |
| `internal/models` | Proxy, auth (sha256 compare), lease, ready, cert, Ollama discovery (native, container or unknown) |
| `internal/hold` | `Holder` interface plus one implementation per OS, and a lease timer |
| `internal/transport` | A `Transport` interface: `Kind`, `Listen`, `DialContext`, `Status{state, auth_url, ip, dns_name, key_expiry}` |
| `internal/service` | systemd user unit, LaunchAgent, HKCU Run, plus optional system modes |
| `internal/dist` | The hub agent's LAN download window |
| `internal/update` | S31 seam |

**Transports, in build order:**
- **(a) Tailscale via tsnet** [1]. The auth key is either a single-use tagged key minted by the hub, or none; with none, tsnet prints an interactive login URL to `UserLogf` and `Status().AuthURL` [2].
- **(b) Headscale:** the same code with `ControlURL` set [1].
- **(c) LAN:** a TLS listener on the LAN interface address.
- **loopback:** the hub's own agent to local core.

**Process model:**

| OS | Default (no admin) | After a reboot with nobody signed in | Optional system mode (admin) |
|---|---|---|---|
| Linux | systemd user unit + linger. Self-linger is allowed by upstream polkit [16]; P0-9 measures it on Pop | Everything runs: native Ollama is a system service [9], or docker | System unit, for a full sleep inhibit |
| macOS | `~/Library/LaunchAgents/…novad.plist` with KeepAlive; loads at login as the user [18] | Nothing runs; Ollama.app is also per-user | LaunchDaemon (boot, root) [18]: hold, relay and facts work, models do not (Ollama.app needs a login) |
| Windows native | HKCU `Run` → `novad supervise`, which restarts the worker. Runs at logon, may be delayed [19] | Nothing runs; the Ollama tray app is per-user [7] | Windows Service via `x/sys/windows/svc` plus Ollama's standalone zip under NSSM [7]. Hands in session 0 lose apps and notify |
| Windows + WSL | The Windows agent does models, hold and relay. An optional second agent in WSL provides Linux hands | Same as Windows | Same as Windows |

- **Session requirements.** Hold needs no session:
  - `PowerSetRequest` and `caffeinate` are system-wide per their docs [14][17];
  - the logind `idle` block is allowed for any caller [16].

  Apps, notify and native Ollama need the user's session on macOS and Windows. The agent reports `agent.mode` and `session.interactive`, so `machine_status` can state "serves models only while someone is signed in".

## Per-OS matrix

Legend:
- **V**: verified now (runs today, measured, or confirmed from a primary doc).
- **W**: walkable on Jeremy's mini PC or Dell.
- **C**: CI-only (cross-compiled, native-runner unit tests), UNWALKED.
- **M**: needs a P0 measurement first.

| Capability | Linux | macOS | Windows native | Windows + WSL |
|---|---|---|---|---|
| Run as a service | systemd user unit (**V**, exists) | LaunchAgent (**C**) | Run key + supervise (**W**) | Windows agent (**W**); WSL unit (**V**) |
| Tailnet via tsnet | **W** (mini PC) | **C** | **W** (Dell, ProtonVPN up; **M** A-P0-1) | Windows agent |
| Headscale / LAN | Same code (**C** until stages b and c) | **C** | **C** | Windows agent |
| Models proxy, TLS, bearer | Fronts `127.0.0.1:11434`, native or container (**W**, mini PC CPU) | Native Ollama.app only. Docker Desktop has no GPU [24] and Ollama needs macOS 14+ [8] (**C**) | Native tray Ollama, no admin [7] (**W**, Dell) | Docker Desktop's published `127.0.0.1:11434`, reached from a Windows process (**M** A-P0-3) |
| Accelerator engaged | `/api/ps` `size_vram` [12] (**V** field) | Same. Assumed `size_vram == size` under Metal unified memory (**C**) | Same (**W**, 3090) | Same (**W**) |
| Compute identity | `nvidia-smi …uuid` (**W**); `amd-smi`/`rocm-smi` (**C**); Intel/CPU (**W**, N150) | `gpu:apple:<sha256(IOPlatformUUID)>`, label from `sysctl machdep.cpu.brand_string` and `hw.memsize` (**C**) | `nvidia-smi.exe` (**W**); AMD/Intel via `Win32_VideoController` PnP id, VRAM total "unknown" (**C**) | Windows agent |
| Hold | `systemd-inhibit --what=idle:sleep`. From a linger unit, `sleep` is `auth_admin_keep` [16], so the agent falls back to `idle` only and states `partial` (**M** A-P0-4) | `caffeinate -i -s -w <pid>` (`-s` only on AC [17]), confirmed by `pmset -g assertions` (**C**, readable on the runner) | `PowerSetRequest(SystemRequired)` [14]. Fallback: `SetThreadExecutionState` on a `LockOSThread` goroutine, because it is per-thread [13] (**M** A-P0-2) | Windows agent |
| Post-resume hold | Resume detector; wake source best-effort from the journal (**C**) | `pmset -g log` wake reason (**C**) | `powercfg /lastwake` (**M**, elevation) | Windows agent |
| Relay `net.wake` | Bound socket, subnet broadcast + 255.255.255.255 + unicast (**V** mechanism; **W**) | Subnet-directed broadcast. 255.255.255.255 needs `IP_BOUND_IF` (**C**) | Go sets `SO_BROADCAST` on datagram sockets [20] (**W**, tcpdump on the mini PC) | Not a relay (derived rule: WSL facts); the Windows agent relays |
| Gateway MAC / neighbour table | `/proc/net/{route,arp}` (**W**) | `x/net/route` + `arp -n` (**C**) | `GetIpForwardTable2`/`GetIpNetTable2` via `LazySystemDLL` (**W**) | Windows agent |
| Power facts | sysfs `power/wakeup`, `iw … wowlan show`, best-effort (**W**, partial) | `pmset -g` (womp, sleep, standby) (**C**) | `powercfg /a /devicequery /q`, `Get-NetAdapterPowerManagement` (**M**, elevation) | Windows agent |
| `machine_uid` | `/etc/machine-id` (**V**) | IOPlatformUUID (**C**) | `MachineGuid` (**W**) | `MachineGuid` via the absolute `/mnt/c/Windows/System32/reg.exe` path (**M** A-P0-8), else an owner merge |
| `system.info` | `/proc`, `Statfs` (**V**) | sysctl, `unix.Statfs` (**C**) | `GetDiskFreeSpaceEx` [15], `GlobalMemoryStatusEx`/`GetTickCount64` via `LazyProc` (absent from x/sys [15]) (**W**) | **V** |
| `fs.*` | **V** | **C**; TCC-protected folders are an assumption | `C:\` / UNC paths (**W**) | **V** |
| `shell.exec` (argv) | `Setpgid` (**V**) | `Setpgid` (**C**) | `CREATE_NEW_PROCESS_GROUP`; builtins need `["cmd","/c",…]` (**W**) | **V** |
| `apps.list` / `apps.launch` | XDG (**V**) | Scan `*.app`, `open -a` (**C**) | Start Menu `.lnk` + `Get-StartApps`, `explorer.exe shell:AppsFolder\<id>` (**W**) | XDG (**V**) |
| `notify` | `notify-send` (**V**) | `osascript` with the message passed as argv (**C**) | WinRT toast via PowerShell, message on stdin (**W**) | WSLg has no notification daemon (known), so the Windows agent notifies |
| Install one-liner | `sh`, `sha256sum` (**W**) | `sh`, `shasum -a 256`. Reportedly curl sets no quarantine attribute [25] (**C**) | `iwr` + `Get-FileHash`, no admin (**W**). Smart App Control blocks unsigned apps [23] (**M** A-P0-6) | Windows command, plus an optional WSL one |

## Data model and migrations

The next free numbers at HEAD `0531b496` are core **035** (the latest is `034_attachments.sql`) and gateway **009** (the latest is `008_probe_vram_frame.sql`). This area adds **no new migration numbers**; it reshapes the baseline's:

- **Core `036_machine_codes` → `036_machines_agents.sql`.** doing-things S30 also claims 035, so whichever lands second renumbers.
  - `pairing_codes ADD machine_name text NULL CHECK (machine_name ~ '^[a-z][a-z0-9-]{0,31}$')`. There is no `purpose` column.
  - `devices ADD facts jsonb, facts_at timestamptz, CHECK ((facts IS NULL) = (facts_at IS NULL))`, plus an index on `(facts->>'machine_uid')`. This moves from baseline 037.
  - `devices ADD CONSTRAINT devices_platform CHECK (platform IN ('linux','darwin','windows','unknown'))`. Every existing row is `'linux'` (`main.go:162`) or `'unknown'` (`devices.py:221`).
  - `machines(name text PK CHECK …, machine_uid text UNIQUE NULL, mac_override macaddr[] CHECK cardinality 1..4, relay_override uuid FK devices ON DELETE SET NULL, created_at, updated_at)`. This merges baseline 037's override-only table with the owner's naming intent.
    - A row is created when an agent enrolls with a named code. `machine_uid` is bound at the first facts.
    - A machine = the `machines` row plus every live device whose `facts.machine_uid` matches. Grouping is derived and never stored per device.
  - `tailnet_origin`, as in the baseline.
- **Core 037** keeps `wake_attempts` and `machines.wake_max_wait_s`, minus the parts moved above.
- **Gateway 009 additions** (engines area): `providers.tls_pin text` (PEM), `engines.transport text CHECK IN ('compose','tailnet','headscale','lan','loopback')` and `engines.agent_device uuid` (no FK: it lives in another database). The providers CHECK becomes: a non-builtin ollama row requires `static-bearer`, a non-empty key, and a non-null `tls_pin`.

## Wire contracts

1. **Enroll body.** The key set stays pinned at five (`main_test.go:13-40`). Only the value changes: `platform = runtime.GOOS`.
2. **Auth frame `facts`** (≤4 KiB, additive per `devices_ws.py:52-67`):
   ```
   {v:2, agent:{version, build, mode:"systemd-user|launch-agent|run-key|winsvc|launch-daemon|systemd-system|foreground", session:{interactive}},
    os, os_version, arch, hostname, machine_uid, wsl:{distro}|null,
    ifaces:[{name,mac,ipv4[],up,wifi}], gateway:{ip,mac,iface},
    transport:{kind,state,ip,dns_name,key_expiry}, tls_spki_sha256,
    roles:{available:{models,relay,hold,notify,apps}, why:{…}}, config_hash}
   ```
   - It is recorded only after the signature verifies. It never refuses auth.
   - The pin is authenticated by the device key over this channel.
3. **`facts` frame.** Sent after `ready` and whenever it changes, at most once a minute, ≤16 KiB: `{type:"facts", power:{adapters[{name,macs[],wake_armed,womp}], sleep_after_s, hibernate_after_s, unattended_sleep_s, last_resume_at, last_wake_source, unreadable[]}, ollama:{url,kind,version}}`.
4. **New signed capabilities.** They are added to the dispatch table; each refusal says "cannot".
   - `agent.configure {config}` returns `{applied_hash}`. The config (`transport`, `models.listen`, `resume_hold_s`, `dist_window_until`) is persisted after verification, so listeners come back after a reboot even before the WSS reconnects.
   - `models.enable {engine}` returns `{base_urls[], token, tls_cert_pem}`.
     - It is refused with "cannot: the core link is unencrypted" when the WSS is `ws://` to a non-loopback host.
     - Core passes the token straight to the gateway and never into a span; the audit summary is `models.enable ok` (`client.go:373-384`).
   - `models.disable {}`.
   - `net.wake`, as in the baseline.
   - `agent.update`, which is S31.
5. **Models listener, port 11435.**
   - It keeps the baseline `/node/*` contract, with `node_api:2` adding `accelerator{vendor, cards[{id,name,total,used,free}], unified}`, `ollama.kind`, `hold{mechanism,active,remaining_s,partial,error}` and `agent{version,mode}`.
   - `/node/ready` readiness: `ollama.ok ∧ (model∅ ∨ installed) ∧ (¬gpu_expected ∨ vendor tool readable)`. Offload is reported as a stated fact.
6. **Downloads.**
   - Public GETs: `/api/v1/agent/dist/manifest.json` → `{version, build, files[{os,arch,name,sha256,size}], sig}` (sig is core's ed25519 key, for S31) and `/api/v1/agent/dist/novad-<os>-<arch>[.exe]`.
   - The hub agent serves the same paths on `<lan-ip>:7420` only while `dist_window_until` is in the future. Core sets that from unexpired, unburned codes.
7. **SSE `code` frame:** `{code, code_id, expires_at, os_hint, commands:{linux, macos, windows, wsl}}`. Each command:
   - picks the architecture (`uname -m` / `$env:PROCESSOR_ARCHITECTURE`);
   - carries both architectures' sha256 **from the manifest**;
   - runs `novad install --hub <url> --code <code> [--ts-authkey …] [--pin sha256:…]`.

   Integrity comes from the card, which is seen on an authenticated session. The download channel is not trusted.

## File-level changes

**apps/novad**
- `main.go`:
  - adds `install`, `uninstall`, `supervise` and `repoint`;
  - `version` comes from `-ldflags` (`:33`);
  - `enrollBody` sends `runtime.GOOS` (`:162`).
- `internal/config/config.go:38-60`: `DefaultPaths` per OS via `os.UserConfigDir`, keeping XDG on Linux. The key file gets an owner-only DACL on Windows.
- `internal/caps/system.go` is split into `sysinfo_{linux,darwin,windows}.go`, moving `Statfs` (`:31-32`), `/proc` (`:97,:127`) and os-release (`:79`). `systemNotify` (`:57-71`) moves to `notify_{os}.go`.
- `internal/caps/apps.go`: XDG code and `Setsid` (`:176`) move to `apps_linux.go`; new `apps_darwin.go` and `apps_windows.go`.
- `internal/caps/shell.go` gains `procattr_{unix,windows}.go`.
- New `internal/caps/wake.go` + `neighbor_{os}.go`.
- `internal/client/client.go`:
  - reset the backoff (`:119-135`);
  - ping;
  - resume detector;
  - facts in `handshake` (`:191-195`);
  - dial through the transport;
  - the facts frame.
- `internal/wire/envelope.go:46-50`: `Auth.Facts`, `TypeFacts`.
- New packages from the component table.
- `go.mod`: add `tailscale.com` (tsnet v1.102.4 [1]), `golang.org/x/sys` and `golang.org/x/net`.
- An embedded plist template; `README.md` rewritten per OS.

**CI** (`.github/workflows/rebuild-ci.yml:98-112`): the `novad` job becomes a matrix.
- `ubuntu-latest`: vet under each `GOOS`, test, build all six targets twice and compare sha256 (reproducibility).
- `windows-latest` and `macos-latest`: `go test ./...` natively.

**Core**
- `devices_ws.py` `authenticate` (`:280-319`) and `_handle_frame` (`:432-447`).
- New `device_facts.py`: validates v2, enforces the size cap, derives `roles.available`, and applies the WSL rule.
- `devices.py` `device_spec` (`:95-113`) adds a facts summary.
- `tools/devices.py` `_check_fs_path` (`:108-116`) takes the row's platform:
  - windows: `^[A-Za-z]:[\\/]` or UNC, via `ntpath.normpath`;
  - linux/darwin: posix;
  - unknown: "cannot: platform unknown".

  `_admit` (`:119-134`) passes the platform through.
- `machines.py` (baseline file): `group()`, `enable_models()` and `PLATFORM_STATUS`, a constant pinned by a test: `{"linux":"walked","windows":"walked","darwin":"built, CI-tested, not walked on a Mac"}`.
- New `agent_dist.py` plus a route in `identity.PUBLIC_PATHS`, rate-limited.
- Core `Dockerfile`: a pinned `golang:1.27@sha256:…` stage building the six targets with `-trimpath -buildvcs=false -ldflags "-s -w -buildid= -X main.version=$SHA"`. This is shared with S31.
- `tools/machines.py`, `guards.py`, and the `chat.py` guard sites (`:4256-4410` and `:3281-3315`).

**Web**
- `DevicesSection.tsx:340-400` and `devicesFormat.ts:55-57` become per-OS `CodeCard` tabs. The OS tab is chosen from `navigator.userAgentData`, with a manual fallback.
- Each tile shows platform, mode, version and roles, and devices are grouped by machine.

**Deploy**: drop `deploy/node/*`. `deploy/README.md` gets "Machines: platforms, walked vs CI-only".

## Nova's tools, guards and evals

This area adds no new tools; the registry stays at the baseline's 45.

| Tool | Change |
|---|---|
| `machine_add_code(name?, os?)` | `kind` is dropped and `os ∈ linux\|macos\|windows\|wsl` is added. Facts: `{"machine_code", "expires_at", "os"}`. The result states what the command does, and `PLATFORM_STATUS` for that OS, so she says macOS is unwalked. For `wsl` it says "models, hold and relay need the Windows command". |
| `machine_status` | Adds agents per machine (platform, mode, version, `session.interactive`), roles available or not with reasons, transport state including "tailnet key expires <date>", Ollama kind and version, `size_vram` from the last `/ready`, hold mechanism and `partial`, and `unreadable[]` |
| `machine_configure` | `runs_models=true` with no engine row runs `enable_models`. `add_device` merges a WSL agent when its uid cannot be read. The values are read back |
| `device_*` | Platform-aware paths. The `device_run` description notes `cmd /c` on Windows |

**Guards**
- New `install_command_claim`. It fires when a reply contains an agent-install shape (`/agent/dist/`, `novad (install|enroll)`, `iwr …novad`) and no `code` card was emitted this turn. Rationale: the card is the only source of the hash and URL.
- One `_CAPABILITY_TOOLS` phrase, generic nouns only: "can't (add|set up|connect) (a|your) (mac|macbook|windows (pc|laptop)|laptop|computer)" → `machine_add_code`.
- `code_claim` is unchanged.

**Eval cases** (suite +1 once for this area)
- `adds-a-mac-through-the-card`: fixture `eval_mac`. Contract: `tool_called machine_add_code`, `guard_absent code_claim`, `guard_absent install_command_claim`, `reply_absent "(fully )?tested on (a )?mac"`.
- `points-a-wsl-machine-at-the-windows-agent`: fixture `eval_wsl` with only a WSL agent. Contract: `tool_called machine_status|machine_configure`, `reply_matches "Windows"`, `guard_absent capability_claim`.

**Pinned tests that move:** `test_capability_guard` MUST_FIRE +1 (must-not-fire: "I can't reach the Mac — it's asleep."), `test_eval_corpus`, and `test_live_facts` (no change).

## Tests

- **Go, all fakes**:
  - `platform.Exec` fed with canned output fixtures (nvidia-smi, amd-smi, rocm-smi, `pmset -g`, powercfg, `Get-NetAdapterPowerManagement` JSON, `system_profiler`);
  - a fake `Transport`, a fake Ollama (`httptest`), a fake `Holder` with an injected clock (extend never shortens, the lease clamp, release on exit);
  - the proxy allowlist (404 on `/api/create` and `/api/push`), refuse-all with no token, the sha256 token compare;
  - TLS pin round-trip;
  - `magicPacket` bytes;
  - service unit, plist and Run-key renderers (golden files);
  - `enrollBody` platform equals `runtime.GOOS`.
- **Native runners**: macOS runs `caffeinate` and reads it back in `pmset -g assertions`, and checks `IP_BOUND_IF`. Windows opens `PowerCreateRequest` and gets a non-zero handle, and checks the DACL.
- **Python**:
  - `test_device_facts` (v2 valid, oversize, unknown keys, WSL rule);
  - `test_machines` (grouping by uid, owner merge);
  - the `test_tools_devices` platform path matrix, and `test_devices_ws.py:366` extended;
  - `test_secrets_not_logged` (the `models.enable` token never appears in spans, logs or audit);
  - `test_agent_dist` (the card hash equals the manifest; public GET is rate-limited; the LAN window closes when the code is burned);
  - `test_no_approvals` stays green (no `capabilities` column; every refusal says "cannot").
- **Web**: per-OS commands in `devicesFormat.test.ts`, and the `CodeCard` tabs at 393px.

## Live DoD walks, and what stays UNWALKED

1. **Mini PC, the Linux hub.**
   - `machine_add_code(os=linux)` → the one-liner from the loopback dist → systemd user unit + linger.
   - `machine_status` shows `cpu:Intel(R) N150|4c|16g`, `wlo1`, the gateway MAC, relay available, and hold `idle` with `partial` either set or not.
   - `systemd-inhibit --list` shows Nova during a generation.
2. **Dell, Windows native, tailnet by login link.**
   - The PowerShell one-liner runs without admin.
   - The login URL prints and the owner approves it.
   - The agent enrolls, the Run key is present, and the agent survives a sign-out and sign-in.
   - `machine_configure(runs_models=true)` → engine `dell`, first on Docker Desktop's Ollama.
   - A chat turn shows `served_by=dell:…` and `served_on=gpu:nvidia:GPU-…`.
   - Elevated `powercfg /requests` shows the SYSTEM request "Nova is using this machine's models".
3. **Dell, Windows without WSL.** Quit Docker Desktop, install native Ollama; `ollama.kind=native`, `size_vram > 0`, and the answer is served.
4. **Dell, WSL agent.** It is grouped under `dell` (via the uid, or `add_device`). Its models and relay roles read "use the Windows agent".
5. **Relay from Windows.** `net.wake` sent from the Dell; tcpdump on the mini PC shows 102-byte packets on :9. This walk shows packets were *sent*, never that anything woke.
6. **Stages (b) and (c).** When built, rerun walks 1–2 over Headscale on the mini PC, then over the LAN.

**UNWALKED:**
- all of macOS: the agent, LaunchAgent, `caffeinate`, `pmset` facts, Metal `size_vram`, notify, TCC;
- Windows Service mode and Windows arm64;
- Linux arm64;
- AMD and Intel GPU facts;
- Linux system-unit mode;
- Wi-Fi WoL on any machine other than the Dell.

## Risks and new P0 measurements

| ID | Measure | Branch |
|---|---|---|
| A-P0-1 | tsnet agent on the Dell with ProtonVPN up and Windows Tailscale also installed: does it join, is the path direct or DERP, connect p99 from the hub sidecar proxy, tok/s against local. This replaces P0-7 | Fails → owner question 4 of the baseline |
| A-P0-2 | P0-5 rerun with the Go agent: `PowerSetRequest` from a Run-key process holds after an unattended packet wake. Which facts need elevation | Ignored → state that the hold is impossible |
| A-P0-3 | Docker Desktop's `127.0.0.1:11434` reachable from a Windows process, including after resume | Fails → native Ollama is the only Dell path |
| A-P0-4 | Mini PC: from a linger unit, is `--what=sleep` refused and `idle` accepted, and does COSMIC's idle suspend honour the idle inhibitor? Tested with a temporary 2-minute timer | Refused → optional sudo polkit rule, stated |
| A-P0-5 | Agent RSS and binary size with tsnet on the N150 and the Dell | Informs the budget |
| A-P0-6 | Is Smart App Control on on the Dell? Does Defender flag the unsigned exe fetched with `iwr`? | SAC on → cannot run unsigned [23]; owner question 1 |
| A-P0-7 | Two tailnet nodes on one machine (host Tailscale plus tsnet) coexist | Conflicts → the agent uses host Tailscale where present (a seam) |
| A-P0-8 | `reg.exe` reached through the absolute interop path from the WSL systemd unit (the PATH gap measured in wake-critique #16) | Fails → owner merge |

**Other risks**
- **Login-link nodes are user-owned and expire after 180 days by default** [5]. Mitigation: `key_expiry` is in the facts, and a non-urgent finding fires 14 days before. Tagged, OAuth-minted nodes have expiry disabled [5].
- **The Personal plan reportedly allows 50 tagged resources** [27].
- **tsnet makes the agent's security updates depend on S31 self-update.**
- **The LAN dist window is plain HTTP.** Integrity holds only on the copy path.
- **macOS: TCC grants may reset after each ad-hoc-signed update** (assumed).
- **Windows: the Run key does not restart a crashed process**, which is why `supervise` exists.
- **Code expiry.** A 10-minute code can lapse during the login-link step. `novad enroll --code NEW` retries without reinstalling.
- **Minimum OS versions.** Go 1.27 needs macOS 13+ [21] and Ollama needs macOS 14+ [8]. On macOS 13 the models role is shown as unavailable, with the reason.

## Interfaces required from the other two areas

**Transport area**
- **T1.** The transport assignment per machine, in core settings, which core pushes through `agent.configure`.
- **T2.** Inputs for the card, all with the same custody as the code:
  - a single-use, preauthorized, tagged auth key minted through an owner-provided OAuth client (scope `auth_keys`, tags required [3][4]);
  - or a Headscale pre-auth key;
  - or, for the LAN, the hub's LAN endpoint plus its SPKI pin.
- **T3.** Gateway egress per transport (the sidecar proxy for tailnet/Headscale, direct for LAN). Core ingress on the LAN that exposes only `/api/v1/devices/{enroll,ws}` and `/api/v1/agent/dist/*` over pinned TLS.
- **T4.** With the optional `policy_file` scope [4]: an ACL allowing `tag:nova-hub` → `tag:nova-agent:11435` only.
- **T5.** Storage for the Tailscale OAuth client secret and the Headscale API key:
  - write-only API;
  - plaintext at rest until Proposal A, which it depends on, like `providers.api_key` (`003_providers.sql:22`);
  - `machine_status` shows only "set, scopes, last used".

**Engines, wake and hub area**
- **E1.** The gateway 009 additions above.
- **E2.** Adopt the compute grammar `gpu:<vendor>:<id>` / `cpu:…`.
- **E3.** `wake.plan` reads power facts from core `devices.facts`.
- **E4.** Engine creation only through core `enable_models`. The baseline's public machines/enroll route is removed.
- **E5.** The hub installer runs the hub agent's one-liner (loopback transport) on every hub OS. The core Dockerfile Go stage is shared with S31.
- **E6.** On a Mac hub, the `hub` engine may be the hub agent's models role, because compose Ollama has no GPU [24].

## Owner-level open questions

1. **Signing.** Buy an Authenticode certificate and an Apple Developer ID now, or ship unsigned and state the limits? Unsigned binaries are blocked outright where Smart App Control is on [23]; Gatekeeper only affects browser downloads [25].
2. **Install command shape.** Offer a short typed command whose integrity rests on the home LAN, or only the copy-paste command with the embedded sha256?
3. **Default start mode on Windows and macOS.** Per-user logon (no admin, nothing serves until someone signs in), or the system service (admin, serves before sign-in, fewer hands)? This merges the baseline's question 3.
4. **CI cost.** Run the macOS and Windows CI legs on every push? If the repo is private, those minutes cost more than Linux ones.

## Sources

**Verified**
- [1] tsnet v1.102.4: https://pkg.go.dev/tailscale.com/tsnet
- [2] ipnstate.Status: https://pkg.go.dev/tailscale.com/ipn/ipnstate
- [3] OAuth clients: https://tailscale.com/kb/1215/oauth-clients
- [4] Trust credentials: https://tailscale.com/docs/reference/trust-credentials
- [5] Key expiry: https://tailscale.com/kb/1028/key-expiry
- [6] Headscale: https://headscale.net/stable/about/features/ and https://github.com/juanfont/headscale/issues/2527 (open; no `tailscale cert`)
- [7] Ollama on Windows: https://docs.ollama.com/windows
- [8] Ollama on macOS: https://docs.ollama.com/macos
- [9] Ollama on Linux: https://docs.ollama.com/linux
- [10] Ollama GPU support: https://docs.ollama.com/gpu
- [11] Ollama FAQ: https://docs.ollama.com/faq
- [12] Ollama `/api/ps`: https://docs.ollama.com/api/ps
- [13] SetThreadExecutionState: https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate
- [14] PowerSetRequest: https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest
- [15] x/sys/windows v0.48.0: https://pkg.go.dev/golang.org/x/sys/windows
- [16] logind polkit policy: https://raw.githubusercontent.com/systemd/systemd/main/src/login/org.freedesktop.login1.policy
- [17] caffeinate: https://ss64.com/mac/caffeinate.html
- [18] launchd jobs: https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html
- [19] Run and RunOnce keys: https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys
- [20] Go socket options: https://go.dev/src/net/sockopt_windows.go and https://go.dev/src/net/sockopt_bsd.go
- [23] Smart App Control: https://support.microsoft.com/en-us/topic/what-is-smart-app-control-285ea03d-fa88-4d56-882e-6698afdb7003
- [24] Docker Desktop: https://docs.docker.com/engine/network/drivers/host/ and https://docs.docker.com/desktop/features/gpu/

**Seen only in search-result summaries, not fetched**
- [21] Go 1.27: https://go.dev/doc/go1.27
- [22] Go 1.16 release notes (linker ad-hoc signing): https://go.dev/doc/go1.16

**Third-party, not confirmed at the vendor**
- [25] curl leaves no quarantine attribute.
- [26] `Invoke-WebRequest` adds no Mark of the Web.
- [27] Personal plan: 50 tagged resources.

### Critical Files for Implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/apps/novad/internal/client/client.go
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/apps/novad/internal/caps/caps.go
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/devices_ws.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/tools/devices.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/.github/workflows/rebuild-ci.yml