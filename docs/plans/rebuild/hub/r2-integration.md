# Cross-platform hub, agent and transports: integrated plan

This plan replaces `integration.md` §§0–5 wherever they conflict. Everything below was checked read-only at HEAD `0531b496`.

**Checked in the repo this pass**
- Highest migrations: core `034_attachments.sql`, gateway `008_probe_vram_frame.sql`. So core 035 and gateway 009 are the next free numbers.
- Registry has 39 tools (`test_tools_registry.py:115`). The eval corpus has 23 cases at `suite_version` 13 (`test_eval_corpus.py:376,382,423`).
- `test_no_approvals.py:289` asserts that `devices` has no `capabilities`, `fs_roots` or `home_dir` column.
- The enroll body key set is pinned at five, with `platform` hard-coded to `"linux"` (`apps/novad/main.go:155-164`, `main_test.go:13-40`).
- `Dispatch` is still a literal switch (`caps.go:45-66`). `shell.go:37` sets no `SysProcAttr`.
- Linux-only code in novad: `system.go:31-32` (`Statfs`), `:79` (`os-release`), `:97` (`/proc`), `:54-71` (`notify-send`). XDG paths in `apps.go` and `config.go:43-47`.
- Reconnect backoff never resets (`client.go:119-135`). The auth signature covers only the raw nonce (`:190`). `auth_error` is always retried (`:204-209`). `CommandTimeout` is 110 s (`:32`).
- Revoke only disconnects the socket (`devices_api.py:155-170`). The enroll rate limit is keyed on `request.client.host` (`:71-74`).
- `PUBLIC_PATHS` is an exact-match frozenset (`identity.py:44-51,191`). `_check_fs_path` is POSIX-only (`tools/devices.py:108-116`).
- Eval predicates: `tool_called` matches a tool name exactly (`predicates.py:44-50`). `reply_absent` is a case-insensitive `re.search` (`:79-81`).
- SSE `KNOWN_FRAME_KEYS` is at `streamChat.ts:151-160`.
- The tailnet sidecar calls `fail` on NeedsLogin (`start.sh:128-134`) and then blocks in `wait_for_containerboot` (`:178`).
- The memory embedder uses `http://ollama:11434` (`services/memory/app/embedding.py:75`). `install.sh:681-746` already parses Ollama's `inference compute` log line.
- `rebuild-ci.yml:98-112` has a single ubuntu job for novad.
- Proposal A covers only gateway provider keys (`ROADMAP.md:210-231`). Item 0 is the suite wedge (`:41-57`).
- The doing-things branch exists: S30 claims core 035 and a `Dispatch` handlers table and moves the registry 39→44; S31 adds `daemon.update`.
- The repo is **PUBLIC** (`gh repo view`).

**Checked on the web this pass**
- [Tailscale auth keys](https://tailscale.com/docs/features/access-control/auth-keys): expiry is 1–90 days. Revoking a key does not deauthorize nodes that used it. One-off keys are revoked automatically after use.
- [Tailscale serve](https://tailscale.com/kb/1312/serve): identity headers are **omitted for tagged devices**.
- [Ollama /api/ps](https://docs.ollama.com/api/ps): `size_vram` exists, and no field names the device or library.
- [Ollama GPU](https://docs.ollama.com/gpu): CUDA, ROCm or Vulkan on Linux and Windows; Metal on macOS. Vulkan is on by default on Windows and Linux. There is no documented way to see which device a model loaded on.
- [Ollama Windows](https://docs.ollama.com/windows): no admin needed, per-user install, `%LOCALAPPDATA%\Ollama\server.log`, binds localhost by default, runs as a service only via the zip plus NSSM.
- [Docker Desktop how-tos](https://docs.docker.com/desktop/features/networking/networking-how-tos/): `host.docker.internal` is documented. **Whether a host service bound only to loopback is reachable is not documented**, so it becomes P0-15.
- [Runner labels](https://github.com/actions/runner-images): `macos-15` (arm64), `macos-15-intel`, `windows-2025`, `windows-11-arm`, `ubuntu-24.04-arm`.
- Headscale `POST /api/v1/preauthkey`: from search results only ([headscale API](https://headscale.net/stable/ref/api/)).

**Still unverified**
- TN3179 (macOS Local Network Privacy) did not render. Those claims rest on Apple forum posts and search results.
- Search results only: PowerShell does not wait for GUI-subsystem executables.
- Search results only: tsnet builds with `CGO_ENABLED=0` on darwin. CI will prove it.

---

## 1. Decisions

K = kept from the baseline, C = changed, N = new.

| # | Decision | Why | |
|---|---|---|---|
| D1 | **One agent per machine: `novad`.** Pure Go, `CGO_ENABLED=0`, six targets (linux/darwin/windows × amd64/arm64), per-OS build tags. Roles are hands, models, relay, hold and facts. On Windows the agent is **always the native Windows build**. It reaches WSL through `shell.exec ["wsl.exe","-d",<distro>,"--",…]` and `\\wsl.localhost\<distro>\…`. `novad enroll`/`install` inside WSL refuses: "cannot: on Windows, Nova's agent runs on Windows itself; use the Windows command". The Dell's WSL novad (pid 441) is retired in S42a. | Owner decisions 9 and 11. Two agents on one machine would give two engines on one 3090. The name stays `novad` so S30 and S31 carry over. | C |
| D2 | **Roles mean availability, not permission.** The agent reports raw facts. **Core alone** derives each role, with a reason, in `device_facts.py`. The owner's switch is `engines.serving`. No `capabilities` column is added. | `test_no_approvals.py:289`; one place that decides. | N |
| D3 | **How the agent runs:** Linux systemd user unit plus linger; macOS **one LaunchAgent**; Windows **HKCU `Run` → `novad supervise`**, which re-launches itself detached with `CREATE_NO_WINDOW`. `supervise` is the parent process on every OS and owns restart backoff and the `.prev` revert, which becomes S31's single revert mechanism. LaunchDaemon, Windows Service and Linux system-unit modes are **seams** (not built). | No admin needed. Task Scheduler's defaults kill long tasks and stop on battery, and whether a standard user can register one is unresolved. The critique proposed `-H windowsgui`, but PowerShell does not wait for GUI-subsystem executables, which would break the interactive `install`. A root LaunchDaemon would run hands as root with no GUI. | C |
| D4 | **Hold is taken inside the agent, driven by a lease.** The machine is held while `in_flight>0` or a lease set by `X-Nova-Hold-S` (60–1800 s) is live. After a resume whose wake source is network or unreadable, it also holds for `min(120 s, wake_max_wait_s)`. Mechanisms: Windows `PowerCreateRequest`/`PowerSetRequest(SystemRequired)` through a kernel32 `LazyProc`, falling back to `SetThreadExecutionState` on a `LockOSThread` goroutine; macOS `caffeinate -i -s -w <pid>`; Linux logind `Inhibit` over D-Bus (godbus, holding the fd), trying `sleep` then `idle` and reporting `partial=true`. The data path confirms the hold with `X-Nova-Agent-Hold`. | Decision 2. The resume hold is the baseline's 180 s helper hold (covers Windows' unattended re-sleep and macOS DarkWake), kept and bounded. | C |
| D5 | **The Transport seam** is `Transport{Kind, HubClient, ListenModels, Status, Close}`. Kinds: `host` (the hub machine; loopback to core); `system` (the OS network, e.g. the Tailscale app, used for control only); `tailnet` (tsnet); `headscale` (tsnet with `ControlURL`); `lan`. A transport locates; it never establishes identity. Identity is the device's ed25519 key, the pinned core key, a per-link bearer and a pinned TLS certificate. | Decision 10, with seams for (b) and (c). | N |
| D6 | **How agents reach the hub (agent door).** `host`: `http://127.0.0.1:<web port>`. `tailnet`/`system`: the **existing web door** `https://<hub>.ts.net`, which has a public-CA certificate; nginx exempts `/api/v1/devices/enroll` and `/api/v1/agent/*` from the gate, as it already does for the WebSocket. `headscale`/`lan`: a new `edge` container using a core-minted, pinned certificate and an allowlist (WebSocket, enroll, downloads). The core link is always verified TLS or loopback. | Tagged agents get no identity header (verified). Headscale has no `tailscale cert`. No edge is needed for phase (a). | C |
| D7 | **The models listener:** TLS with the agent's own self-signed certificate on **every** transport, including `host`. ECDSA P-256, IsCA, random SAN, valid from now−48 h to 9999-12-31. Bearer stored on the agent as sha256. Explicit mux; Ollama allowlist; `/api/pull` body validated (no registry host, no `insecure`); a minimum Ollama version; the mux cannot reach `caps.Dispatch`. | One dial path in the gateway. Python's `ssl` cannot skip date checks. Body validation closes the CVE-2024-37032 class. | C |
| D8 | **`hub` is always the bundled container** (transport `internal`; it stays the embedder). A native Ollama on the hub machine (Metal on a Mac, native Windows, ROCm) is a **separate engine named after that machine**, transport `host`. There is no `engines.kind` and no `models_via`. | Owner decision 1: ids name the machine. Removes the relabelling and handover-in-disguise problems (engines critique #12). Switching engines is `machine_handover`. | C |
| D9 | **Gateway dial per `engines.transport`:** `internal` → `OLLAMA_URL`; `host` → `https://host.docker.internal:<port>`. On Linux, `extra_hosts` points `host.docker.internal` at `${NOVA_SUBNET_GATEWAY}` and the agent binds that bridge IP; on Docker Desktop the agent binds 127.0.0.1. `tailnet`/`headscale` go through `NOVA_TAILNET_PROXY` (CONNECT) on an `internal: true` network shared only by gateway and tailscale. `lan` dials direct. Every agent row uses `cadata=tls_cert_pem`, `check_hostname=False` and the bearer. | Engines critique #1, transport critique M2 and M8. | C |
| D10 | **Compute identity**, defined once before any row exists. `served_on := dev("+"dev)*`, sorted, at most 4; more than 4 means omitted. `dev := gpu:<cuda\|rocm\|metal\|vulkan>:<key> \| cpu:<slug>\|<n>c\|<GiB>g`. `key` is the CUDA/ROCm uuid, else `pci-vvvv-dddd\|<GiB>g`, or `<chip>\|<gc>gc\|<GiB>g` for Metal. The accelerator set is **Ollama's own `inference compute` lines** where readable, otherwise the vendor inventory. Stamping rule: `size_vram==0` → `cpu:`. `size_vram>0` with exactly one accelerator → that device, plus `cpu:` if `size_vram<size`. More than one → stamp only if CUDA and nvidia-smi compute-apps puts the runner PID on a single UUID; **otherwise omit**. A container runtime's `cpu:` comes from `docker info`. `runtime ∈ {container, native, wsl}` is recorded separately. Speed is keyed by (model without engine prefix, `served_on`, `runtime`); fit by (compute, model). | Vendor-neutral. `size_vram` is the truth about offload. Omitted, never guessed. Rows never change meaning. | C |
| D11 | **Signed envelopes:** `models.link {engine, rotate}` / `models.unlink`; `net.join` / `net.leave`; `net.wake` (as in the baseline); `agent.configure` (two-phase); `facts.refresh`; later S31's `daemon.update`. The agent refuses `models.link` over a core link that is neither verified TLS nor loopback. | Star topology: authority comes from core only. | C |
| D12 | **Revoke order:** gateway `DELETE` engine → `models.unlink` → `net.leave` → `devices.revoke` → `auth_error{reason:"revoked"}`. On that reason the agent wipes its token, listeners and tsnet state and stops retrying. With `devices:core`, the tailnet node is deleted through the API; otherwise the admin step is stated. | Engines critique #5, agent critique F1. | N |
| D13 | **Downloads.** A one-shot `agent-dist` builder (pinned golang digest; `-trimpath -buildvcs=false -ldflags "-s -w -buildid= -X main.version=…"`) fills the `v4_agent_dist` volume, keyed by a hash of the `apps/novad` tree. Core serves a core-signed manifest and the binaries at public paths. CI publishes the same builds as GitHub Release assets for tags; the card lists a release URL only when its hash equals the hub's. Every card command **verifies the sha256 before executing**. | Kept out of the core image (F24/m14). Join-first machines need a public channel (C1). The repo is public. | N |
| D14 | **Joining the tailnet (a).** *Reach-first*: the machine already reaches the hub (host, Tailscale app, LAN door). It enrolls, then `net.join`; the AuthURL arrives in a `net` frame and **Nova shows it** as a `card{join_link}`. *Join-first*: the machine cannot reach the hub. If a credential exists, a minted tagged key joins it with no link. Without one, `novad install` runs tsnet in the foreground; if the hub's **join window** is reachable on the LAN, the link is relayed to Nova's card, otherwise it prints in the terminal with a QR code, and the card says so before it happens. | Decision 10a, including the case the design cannot fully cover, stated honestly. | N |
| D15 | **Tailscale credential.** An OAuth client with `auth_keys` required and `devices:core` optional; `policy_file` is **not requested** (ACL writes are the deferred a2). Stored in core `network_credentials` in **plaintext at rest**, the same custody as `003_providers.sql:22`. Write-only REST; never in spans, logs, tool results or her context. **Excluded from backups** (`pg_dump --exclude-table-data`); after a restore the check `network_credential_missing` asks for it again. Minted key: single-use, preauthorized, `tag:nova-agent`, `expirySeconds=86400` (the documented minimum), deleted at code burn or expiry and read back. It is passed through an env var that the agent clears, and is never written into a service definition. A `tskey-*` in the owner's message is redacted on input. | Transport's A-0 is cut: a key file plus ciphertext on one host is plaintext-equivalent, and it would be a second secrets system before A. Proposal A is gateway-scoped, so it must widen to cover core (dependency). | N |
| D16 | **Key expiry.** `facts.net.overlay{key_expiry, tagged}`. Check `tailnet_key_expiring:<m>` fires 14 days ahead (non-urgent). At a login-link join the result text gives the admin-console step to disable expiry. `wake.plan` refuses with cause `key_expired`. `key_expiry_off` is cut: OAuth device writes are limited to tagged devices (verified by the critique). | Transport C2, engines #6. | N |
| D17 | **Hub overlay facts come from `/run/nova-status/tailscale.json`.** `start.sh` is the only writer: a loop every 15 s using `--peers=false` plus `serve status`, written atomically. Core treats data older than 45 s as `unknown`. The tailnet origin is **derived** from it; there is no `tailnet_origin` table. | M1; derived, never hardcoded. | C |
| D18 | **Headscale (b):** a compose service on the hub. Core mints pre-auth keys through the headscale API (no login links). Agents use tsnet `ControlURL`; the agent door is the edge. Thin clients over headscale are **browser-only, not installable**, and this is stated. | No `tailscale cert` in headscale. | N |
| D19 | **LAN (c), the rail's exact relaxation.** Two listener kinds only: (1) the edge on one RFC 1918/ULA address (`NOVA_LAN_BIND`, loopback by default; a DHCP reservation is required and stated; check `lan_door_address_moved`); (2) an agent's models listener on the source address of its route to the hub, RFC 1918/ULA only, polled every 30 s. Plus the hub agent's **join window**, open only while an unburned tailnet code exists. The web UI is **never** on the LAN, pinned by `exposure_test.sh`, `edge_test.sh` and `edge_guard`. **Discovery:** agent → hub uses the ordered locators on the card; hub → agent uses facts over WSS, and core `PUT`s `base_url`. An engine's identity is its SPKI pin. mDNS is a seam. | Decision 10c. Phones cannot install the PWA from the LAN (no trusted HTTPS). | N |
| D20 | **Which hub OSes are supported:** Linux (walked); macOS through Docker Desktop plus `install.sh` under bash 3.2 (CI only); Windows with WSL (walked). **Windows without a user WSL distro** is a seam: `install.ps1` states `cannot` and gives `wsl --install`. | Only the bash tooling blocks it (engines #16). Owner question 3. | C |
| D21 | Everything in the baseline S40 gateway design is **kept**: `providers`+`engines`, the `hub` rename, first-colon ids, `library:`, the wait rule, 409 `engine_asleep`, `X-Nova-Skip-Engines`, `ProviderUnreachable` never walled, `ENGINE_REACH_S`, TTL caches, `engine_models`, D11, the pull timeout, `/load` pinning, handover. Also kept: `wake_attempts`, the rate limit counted from `settled_at`, the no-wait rule, one budget per turn, the late watcher, `ready_cpu`, every backup/restore/move verb, the code card kept out of her context, and question 8 (no SSH keys, no secrets manager). | Unchanged by decisions 9–11. | K |

---

## 2. Interface reconciliation

### 2.1 One store and one writer per fact

| Fact | Store | Single writer | Readers |
|---|---|---|---|
| Device identity, name, platform (CHECK `linux\|darwin\|windows\|unknown`) | core `devices` | `devices.enroll` | all |
| Host facts: OS, machine_uid, agent mode and session, net, power, Ollama discovery, compute inventory, hold summary, `unreadable[]` | core `devices.facts`, `facts_at` | `devices_ws` (auth frame and `facts` frame) | `device_facts.derive_roles`, `wake.plan`, `machines`, `network` |
| Build identity | core `devices.daemon_build` (S30) | `devices_ws.authenticate` | S30/S31 |
| Door provenance | core `devices.last_transport` | `authenticate`, from web's `X-Real-IP` or the edge's `X-Nova-Edge-Peer`, trusted only from `NOVA_WEB_ADDR` / `NOVA_EDGE_ADDR` | `machine_status` |
| Engine locator, bearer, pin, transport, runtime | gateway `providers.base_url` / `api_key`; `engines.transport`, `tls_cert_pem`, `tls_spki_sha256`, `machine_id`, `runtime` | `engines.create` / `PUT`, **called only by core** (`link_models`, `on_facts`, `machine_join`) | gateway dial |
| Live engine facts: accelerator memory (total/free/util or null with a reason), resident models, `models_disk`, hold | gateway `engines.last_facts` (cache) | `engines.observe` (`/agent/v1/facts`) | core, `/admin/hardware`, suggest |
| `lifecycle`, `serving`, `hold_s` | gateway `engines` | `PUT` (from `machine_configure`) | routing |
| Per-request `served_on` / `runtime` | response headers → `usage_events.served_on`, `probes.compute` / `runtime` / `path`, span meta | `data_plane`: the agent's header, or `compute_id` for the bundled engine | fit, speed |
| Bundled compute | gateway process memory | `compute_id.bundled_devices` | stamps |
| MAC and relay overrides | core `machine_overrides` | `machine_configure` | `wake.plan` |
| Wake ledger | core `wake_attempts` | `wake.py` | tools, checks, UI |
| Codes: transport, `ts_key_id`, `ts_key_deleted_at` | core `pairing_codes` | `machines.add_code`; key janitor | enroll |
| Tailscale / headscale credential | core `network_credentials` | Settings REST (write-only) | `control_plane` |
| Hub overlay state, name, expiry, AuthURL, serve ok | file `v4_tailnet_status/tailscale.json` | `start.sh` | `network.py` (derived, never stored) |
| Agent AuthURL | core memory, with a TTL | `net` and `join_pending` frames | SSE card, `GET …/join` |
| Access origins, `trusted_https` | derived from the status file and the LAN door env | — | `nova_address`, card |
| Agent certificate and bearer (sha256) | agent state directory (DACL on Windows) | agent | — |
| Edge certificate | `v4_edge_tls` | core `edge_tls` | edge |
| Agent binaries and manifest | `v4_agent_dist` | `agent-dist` | `core.agent_dist` |
| Platform walk status | `deploy/platform-walks.json` `(os, arch, mode, role, slice, walked_at)`, pinned by a test | the walker, at DoD | `machine_add_code`, `machine_status`, docs |
| Hold lease | agent memory | models listener | `/agent/v1/facts`, `X-Nova-Agent-Hold` |

### 2.2 Names reconciled

| Conflict | Final |
|---|---|
| `novad` / `nova-agent` | `novad` (`novad.exe`), called "Nova agent" in user text |
| `/node/*` / `/agent/v1/*` | Control routes at `/agent/v1/{live,facts,ready}`; Ollama allowlist at the **root**, so the adapters' `base_url` carries no prefix |
| `models.enable` / `models.link` | `models.link` / `models.unlink` |
| `agent.leave` / `net.leave` | `net.leave` |
| `agent.update` / `daemon.update` | S31's `daemon.update` |
| `X-Nova-Node-Compute` | `X-Nova-Agent-Served-On`, `X-Nova-Agent-Runtime`, `X-Nova-Agent-Hold` |
| `tailnet_join` / `machine_join` | `machine_join` |
| `network_status` / `network_configure` | Folded into `machine_status(hub)`. The credential is set in Settings only. ACL writes are deferred. |
| `code_claim` / `install_command_claim` / `credential_claim` | `credential_claim` |
| SSE `code` / `card` / `join` | `card{kind: code\|join_link}` |
| Pin as PEM, base64 or hex | `tls_cert_pem` (needed by Python `cadata`) **and** `tls_spki_sha256` hex (identity) |
| `machines` table variants | None. One device per machine; `machine_overrides(device_id)` |
| Transport enums | Agent: `host\|system\|tailnet\|headscale\|lan`. Core codes and devices: `host\|tailnet\|headscale\|lan`. Gateway `engines.transport` and `probes.path`: `internal\|host\|tailnet\|headscale\|lan` |

### 2.3 Agent to core frames (additive under `devices_ws.py:52-67`)

- **Auth frame `facts`** (≤4 KiB, recorded only after the signature verifies, never refused):
  `{v:2, agent:{version, mode:"systemd-user|launch-agent|run-key|foreground", session_interactive}, os:{goos, arch, version, wsl:null|{distro}}, hostname, machine_uid}`.
  The `build` field is S30's.
- **`facts` frame** (≤16 KiB; sent after `ready`, on change at most once a minute, every 10 minutes, and on `facts.refresh`):
  ```
  {type:"facts",
   net:{ifaces:[{name,mac,ipv4_cidr[],up,kind:wired|wifi|virtual|tunnel,physical,gateway:{ip,mac}}],
        default_route_via_tunnel, lan_access:ok|denied|unknown,
        overlay:{kind,backend_state,ips[],dns_name,key_expiry,tagged}},
   power:{adapters[{name,macs[],wake_armed,magic,pattern}], sleep_after_s, hibernate_after_s, unattended_sleep_s,
          standby:s3|s0ix|unknown, standby_raw, fast_startup, womp, battery, last_resume_at, last_wake_source},
   ollama:{url,version,runtime,bind,source,reason},
   compute:{devices[{key,library,name,total_bytes,source}], cpu, source},
   hold:{mechanism,active,remaining_s,partial,bounded_by,error},
   unreadable:[{item,reason}]}
  ```
- **`net` frame** `{backend_state, auth_url?}` (only on an IPN bus change).
- **`join_pending` frame** from the hub agent only: `{code, auth_url, hostname, os, arch}`.
- Integrity of facts and results rests on the WSS channel (verified TLS or WireGuard). They are **not** signed; this is stated in the docs, and no transport may skip TLS.

### 2.4 The agent's models listener (HTTPS, pinned, bearer)

- `GET /agent/v1/live`: no auth, probes nothing downstream.
- `GET /agent/v1/facts`: bearer. Returns `{api:2, accel[{key,total,free|null,util|null,source,reason}], ollama{ok,version,runtime,resident}, models_disk, hold, activity}`.
- `GET /agent/v1/ready?model=`: returns the baseline body plus `runtime` and `hold`. Ready means `ollama.ok ∧ (no model ∨ installed)`. Offload is reported as a stated fact.
- Allowlist: `POST /v1/chat/completions`, `POST /api/{generate,pull,show}`, `DELETE /api/delete`, `GET /api/{tags,version,ps}`. Anything else, including `/api//create`, `%2e%2e` and `/API/…`, returns 404.
- With no token linked it answers 503 `models role not linked — refusing all requests`.

### 2.5 Gateway and core routes (baseline §1.2 is kept verbatim except as noted)

- Headers `X-Nova-Wake`, `X-Nova-Skip-Engines`, the 409 `engine_asleep` body, the stated 503 and the walls are all unchanged.
- Success adds `X-Nova-Served-Runtime` next to `X-Nova-Served-By` and `X-Nova-Served-On` (grammar D10; omitted when ambiguous).
- `POST /admin/engines {name, machine_id, base_url, token, transport, tls_cert_pem, tls_spki_sha256, runtime}`:
  - called only by `machines.link_models`;
  - reserved names `hub` and `library`; the shadow check runs;
  - it verifies by calling `/agent/v1/facts` through the real dial, and returns 502 with nothing written if that fails.
- `PUT /admin/engines/{n}` also accepts `{base_url, transport, tls_cert_pem, tls_spki_sha256}` from core. The pin is checked on the new locator before commit.
- `GET /admin/engines/{n}` gains `accel` for fit. `/admin/hardware` and `suggest` read the engine's facts, not just local nvidia-smi.

### 2.6 Tailscale join and credential flow

1. **Settings → Network.**
   - Shows the prerequisite `tagOwners: {"tag:nova-agent": [...]}` snippet and the scopes.
   - The form is write-only.
   - Core verifies the credential: an OAuth token, then `GET /api/v2/tailnet/-/keys`. It stores `verified_at` and the scopes.
2. **`machine_add_code(name?, for_os?)`.**
   - Mints the pairing code.
   - With a credential, it also runs `POST /api/v2/tailnet/-/keys {capabilities.devices.create{reusable:false, ephemeral:false, preauthorized:true, tags:["tag:nova-agent"]}, expirySeconds:86400, description:"nova <name> <code_id>"}` and stores `ts_key_id`.
   - If minting fails, the card and the tool result say "could not mint a tagged key: …; this card uses a login link".
3. **`novad install --hub <locators> --name <n> --code <c>`, reach-first:**
   - enroll over the first locator that verifies, register the service, open the WSS;
   - if the target is `tailnet`, bring tsnet up with the key if present;
   - otherwise the AuthURL goes into a `net` frame and Nova shows `card{join_link}`.
4. **Join-first:**
   - tsnet runs in the foreground, using `NOVA_TS_AUTHKEY` (cleared after reading) or a login URL printed with a QR code;
   - if the hub's join window verifies, the agent sends `POST /agent/v1/join-pending` there once per code, and the link appears in Nova's card;
   - once `Running`, it enrolls through `https://<hub>.ts.net`, stops the foreground node, and registers the service on the same state directory, with ownership set.
5. **Janitor.** At code burn or expiry: `DELETE /keys/{id}`, then `GET` must return 404, then set `ts_key_deleted_at`.
6. **`machine_join(machine, transport)` for a paired machine.**
   - Sends `agent.configure` (two-phase): the new transport comes up next to the old one, a full challenge and auth runs over it, then it commits; otherwise it rolls back after T seconds. The result is `{applied_hash, verified_over}`.
   - For an overlay target this includes `net.join {kind, control_url?, hostname, auth_key?}`.
   - It returns **immediately** with `state ∈ {login_pending, awaiting_admin_authorization, locked_out, running}`.
   - Completion is seen through `net` frames, a `machine_joined` notice, and `machine_status`.
7. **Headscale:** the same flow with `control_plane=headscale` (`POST /api/v1/preauthkey`); never a login link.

### 2.7 SSE frames and the card command

**Frames.**
- `card {kind:"code", code, code_id, expires_at, for_os, commands{linux,macos,windows}, sources[], sha256{"<os>-<arch>":hex}, locators[], notes[]}`
- `card {kind:"join_link", machine, auth_url, expires_at}`
- `wake` as in the baseline.
- `card` is added to `KNOWN_FRAME_KEYS`. Cards are never persisted.

**POSIX command** (dash-safe):
1. Map `uname -s` and `uname -m` to `amd64` or `arm64`.
2. `for u in <sources>; do curl -fsSLo novad "$u/novad-$o-$a" && break; done`.
3. Check the hash with `sha256sum -c` or `shasum -a 256 -c`.
4. `chmod +x`, then `./novad install …`.

**Windows command** (PowerShell 5.1: no `&&`):
1. Take the architecture from `$env:PROCESSOR_ARCHITECTURE`.
2. `foreach` over the sources with `curl.exe`.
3. Compare `Get-FileHash` and `throw` on a mismatch.
4. `.\novad.exe install …`.

**Locators**, in order, each with its pin when self-signed: `http://127.0.0.1:<port>` (the hub machine), `https://<hub>.ts.net`, `https://<lan>:<edge_port>#spki=<hex>`.

**Download sources:** the origin of the owner's request that minted the code (if not loopback), the tailnet origin, the join window, and a GitHub release only when its hash matches.

### 2.8 Tools and registry path (from 39)

**S40:** `machine_status`, `machine_configure` → 41
- `machine_status` is `AUTO_RUN`. It covers each machine and its agents, roles with reasons, transport and key expiry, and engines. `hub` also covers overlay state and whether the credential is set.
- `machine_configure` takes `serving`, `runs_models`, `lifecycle`, `hold_s`, `mac`, `relay`, `remove`, and always reads the values back.

**S42b:** `machine_add_code(name?, for_os?)` → 42

**S43a:** `machine_join(machine, transport)` → 43

**S45:** `machine_handover` → 44

**S46:** `machine_wake` → 45

**S47:** `nova_address` (`AUTO_RUN`) → **46**

S41, S42a, S43b, S44, S48 and S49 add no tool.

---

## 3. Per-OS support matrix

- **W** = built and walked on the available hardware, in the named slice.
- **C** = built and CI-tested only (cross-compiled plus native `go test` on the named runners). UNWALKED.
- **M** = walked if the named P0 measurement passes.
- **S** = seam only, deferred.
- **✗** = not supported, and stated.

**Hub**

| | Linux | macOS | Windows + WSL | Windows without WSL |
|---|---|---|---|---|
| Compose stack plus install | W (mini PC, S45) | C (bash 3.2 tests on `macos-15`; no Docker on the runner) | W (Dell, today) | S (`install.ps1` states `cannot`) |
| Bundled `hub` engine | W (N150 CPU) | C (CPU only) | W (3090 via WSL2) | S |
| Hub-host agent, `host` transport (relay, native models) | W relay (S46); native models M (P0-15b) | C | W (Dell, S44, P0-15a) | S |
| Backup, restore, move | W | C | W | S |
| Tailnet sidecar / headscale / LAN edge | W / W (S48) / W (S49) | C / C / C | W / M / M (T4) | S |

**Agent roles**

| Role | Linux | macOS | Windows native | WSL |
|---|---|---|---|---|
| Hands | W (mini PC) | C (TCC unverified) | W (Dell, S42a) | through Windows `wsl.exe`: W; an agent inside WSL is refused |
| Facts | W (partial: ethtool needs root) | C (runner reports "Apple M1 (Virtual)", so only the unreadable branches run) | W; M for elevated reads (P0-5) | through Windows |
| Models | W (mini PC CPU, S44) | C (Ollama.app needs a login and macOS 14+; Metal `size_vram` meaning unknown) | W (native and Docker Desktop, S44/S45, P0-4/P0-18) | M (Ollama inside WSL reached through the Windows agent, P0-21) |
| Hold | M (P0-9: idle vs sleep) | C | M (P0-5) | Windows |
| Relay | W (S46) | C, and blocked when Local Network Privacy denies (unsigned); UNWALKED | W (sender, P0-13) | Windows |
| Service | systemd user + linger: W | LaunchAgent: C | Run key + `supervise`: W (P0-20) | — |
| Service system modes | S | S | S | — |
| Architectures | amd64 W; arm64 C (`ubuntu-24.04-arm`) | arm64 C (`macos-15`); amd64 C (`macos-15-intel`) | amd64 W; arm64 C (`windows-11-arm`) | — |

**Agent transports**

| | Linux | macOS | Windows |
|---|---|---|---|
| `host` | W (mini PC hub agent) | C | W (Dell hub agent before the move) |
| `system` | W (legacy) | C | W |
| `tailnet` (tsnet, login link or tagged key) | W (S43) | C | W (S43; P0-7: ProtonVPN, firewall, alongside host Tailscale) |
| `headscale` | W (S48) | C | M (T12; syspolicy ControlURL issue #16840) |
| `lan` | W (S49) | C, plus Local Network Privacy; UNWALKED | W with one elevation for the firewall rule (S49, T3) |

**Thin clients:** tailnet PWA is W (phone and desktop, S47). Headscale and LAN are ✗ as installable apps (no trusted HTTPS); headscale works as a browser bookmark. The web UI is never on the LAN.

---

## 4. Critique findings: accepted and rejected

**Agent critique**

| Verdict | Findings |
|---|---|
| Accepted | F1 (at the documented 1-day minimum plus deletion at burn; env var, not argv); F3; F5 (merged with transport M5 into one LaunchAgent plus a measured `lan_access`); F6; F8; F10; F11 (merged with engines #2); F12; F13; F14; F16; F18 (walk ledger); F19; F20; F21; F22; F23 (godbus fd); F24; F25; F26; F27 (public repo and runner labels verified); F28 |
| Modified | F2: the join window only while a code is live, plus the Nova card for reach-first; off-LAN the link shows on the terminal and this is stated. F4: no embedded compose (engines m16); a printed `docker run` line in S45 plus an "Ollama not installed" reason and the `ollama.bind` warning. F7: a console binary with detached re-exec instead of `-H windowsgui`, because PowerShell does not wait for GUI executables. F9: mDNS left as a seam, no reverse connection. F15: design only (a2 deferred). |
| Rejected | F17 "store the SPKI only": Python needs the PEM for `cadata`, so both are stored. |

**Transport critique**

| Verdict | Findings |
|---|---|
| Accepted | C2; M1–M13; m1–m4; m5 (ordered locators); m7 (per-code failure count, since the peer IP is a single bucket behind nginx today); m8–m13; m15; Y1–Y4 |
| Modified | C1: GitHub releases for tags, matched by hash, plus the join window. |
| Rejected | The transport design's A-0 (a separate secrets store; see D15). m14 is taken as a correction: the edge exists only for (b) and (c). |

**Engines critique**

| Verdict | Findings |
|---|---|
| Accepted | #1 (as D8/D9, with TLS kept on `host`); #2; #3; #4 (the baseline's resume hold, so no new owner question); #5; #6; #7; #9; #10 (`hub.moving` in S48/S49 only: the tailnet move keeps `TAILNET_HOSTNAME`); #11; #13; #14; #15; #16 (as an owner question); m1–m7; m9; m12–m20 |
| Modified | #8: the Run key replaces the Task, so P0-18 is dropped. m8: `for_os` is kept as a hint only, never asserted. m10: the docstring at `devices.py:157-158` is amended (single-use, 10 minutes). |
| Moot | #12 (there is no kind switch). |

---

## 5. Revised Phase 0

Measurements use stock tools and throwaway probes under the scratchpad, never product code. Each one runs just before the slice it gates. Results and the branch taken go in `hub-p0-measurements.md`.

| ID | Measure | Machine | Pass / fail → branch | Gates |
|---|---|---|---|---|
| P0-1 | WoWLAN from S3 (the baseline protocol) | Dell asleep; mini PC `wlo1` sends | W1: build S46. W2: build S46 with stated landing rates. W3: S46 parked for this owner. | S46 |
| P0-2 | Does probing the **tsnet node's** IP wake it? | Dell, mini PC | 0 wakes → `PROBE_WAKES_NODE=False` | S46 |
| P0-3 | Time from packet to `/agent/v1/ready` to first token, ×5 | Dell | Sets `wake_max_wait_s` | S46 |
| P0-4 | CUDA after resume ×5: Docker Desktop vs native Windows Ollama, `size_vram==size` | Dell | Whichever passes 5/5 becomes the Dell's runtime. Both fail → owner. | S44/S45 |
| P0-5 | A Go probe started from the Run key: `PowerSetRequest` vs `SetThreadExecutionState` after an unattended packet wake. Holds 10 min? Sleeps within unattended + 60 s after release? Which power reads work without elevation? | Dell | The one that holds is used; neither → "the hold is impossible" is stated. Reads needing elevation go in `unreadable[]`. | S44 |
| P0-6 | Docker Desktop and Ollama tray lifetime: reboot with no sign-in, time from sign-in to up, S3 resume, clock skew | Dell | Sign-in required → stated; owner question if it matters | S44 |
| P0-7 | tsnet from a Run-key process on the Dell with ProtonVPN on and off and host Tailscale also running: does it join? direct or DERP? connect p50/p99 through the hub sidecar proxy, SSE intact, tok/s vs local, failure mode while asleep, firewall prompt as non-admin. Same on the mini PC alongside host Tailscale. | Dell, mini PC | Sets `ENGINE_REACH_S`. Coexistence fails → use the `system` seam. No path → owner. | S43a |
| P0-8 | The embedder on the N150 | mini PC | Parity or latency → re-embed or re-derive | S45 |
| P0-9 | From a linger unit: is `Inhibit sleep` refused and `idle` accepted? Does COSMIC's auto-suspend honour it (2-minute timer)? Does a session-scope helper get `sleep`? Also the baseline capacity and subnet reads. | mini PC | Idle does not hold → print a one-line polkit rule; the owner runs it | S44 |
| P0-10 / P0-11 | Longest pull silence; gaps between rounds and turns | Dell | Pull timeout; `hold_s` | S44 |
| P0-13 | Broadcast egress interface on Windows with the Wi-Fi, vEthernet, ProtonVPN and Tailscale adapters, ProtonVPN "allow LAN" on and off (tcpdump on the mini PC) | Dell → mini PC | Strays → subnet-directed broadcast only, or relay role `cannot` | S46 |
| P0-15 | (a) container → `host.docker.internal` → a listener on Windows 127.0.0.1; (b) container → a listener on the mini PC's bridge gateway IP, ufw on and off | Dell, mini PC | Fails → bind the vEthernet IP / state the ufw rule | S44 |
| P0-16 | Readable `inference compute` lines: N150 native (journald permissions) and container (`docker logs`); Dell native (`server.log`) and Docker Desktop. Does Vulkan put the N150's layers on the GPU? | both | Unreadable → inventory rule; ambiguous → omitted | S44 |
| P0-17 | Does `nvidia-smi.exe`'s UUID equal the container's? | Dell | Differs → fit does not carry over; stated | S45 |
| P0-18 | Docker Desktop's `127.0.0.1:11434` reachable from a Windows process, including after resume | Dell | Fails → native only | S44 |
| P0-19 | Agent binary size and RSS with tsnet | both | Budget only | S43a |
| P0-20 | Unsigned exe fetched with `curl.exe`: Smart App Control state, SmartScreen, Defender; Run-key console flash; survives sign-out and sign-in | Dell | SAC on → owner question 1 | S42b |
| P0-21 | WSL localhost forwarding of an Ollama inside WSL to Windows `127.0.0.1` | Dell | Fails → the WSL-Ollama path is `cannot` | S44 |
| T9 | OAuth: `tagOwners` prerequisite, key to Running time, smallest `expirySeconds` the API accepts, interaction with device approval | owner's tailnet | Fails → login link only | S43b |
| T12, T13 | Headscale with an http or self-signed control URL on tsnet (including Windows syspolicy); `serve --https` and `--tcp` together | mini PC, Dell | Fails → a LAN TLS control URL | S48 |
| T3, T4 | Dell listener reached from the mini PC gateway with and without a firewall rule, Wi-Fi client isolation, ProtonVPN allow-LAN; Docker Desktop publishing on a specific IP | both | Stated per case | S49 |

Dropped: baseline P0-12 (WSL reach, now moot), P0-14 (the hairpin; replaced by `host`), A-P0-8, P0-18-Task. **CI** covers `go list -deps` (no `expvar` or pprof in the listener binary) and reproducible sha256 across two builds.

---

## 6. Revised slice plan

**Order:** P0 → S40 → S41 → S42a → S42b → S43a → S43b → S44 → S45 (the move) → S46. S47 can land any time after S43a. Then S48 and S49.

**The move sits after S44.** By then the models role has been proven twice: the mini PC as a node of the Dell hub, and the Dell's GPU through the agent. The Dell agent is already on tsnet, so after the move it follows the hub's hostname. A no-bearer early interim move is rejected (the per-link bearer rule).

**Every slice** ends with a chat walk whose `turn_spans` are read, and a web check at 393 px. The pins that move each slice are `test_tools_registry.py:115/:501/:550`, `test_live_facts`, `test_capability_guard` MUST_FIRE, `test_eval_corpus.py:376-377/382/423`, and `tabs.test.tsx:47` when the tabs change. `test_no_approvals` stays green, and every refusal says "cannot".

**Migrations:** core 035–038 and gateway 009–010 are free today. Doing-things S30 also claims 035; whichever lands second renumbers.

| Slice | Migrations | Tools | Evals (suite / corpus) |
|---|---|---|---|
| S40 | gw 009, core 035 | +2 → 41 | 14 / 25 |
| S41 | — | — | — |
| S42a | core 036 | — | 15 / 26 |
| S42b | — | +1 → 42 | 16 / 27 |
| S43a | core 037 | +1 → 43 | 17 / 29 |
| S43b | — | — | 18 / 30 |
| S44 | gw 010 | — | 19 / 31 |
| S45 | — | +1 → 44 | 20 / 32 |
| S46 | core 038 | +1 → 45 | 21 / 36 |
| S47 | — | +1 → 46 | 22 / 37 |
| S48 | — | — | 23 / 38 |
| S49 | — | — | 24 / 39 |

### S40: engines and measurement identity (Dell hub, builtin only)

**Scope.** The baseline S40 in full, plus the D10 grammar. No `engines.kind`.

**Gateway migration 009.** Baseline items 1–6, plus:
- `probes ADD provider, compute, runtime CHECK IN (container,native,wsl), path CHECK IN (internal,host,tailnet,headscale,lan)`;
- `usage_events ADD served_on`.

**Core migration 035_hub_engine.**

**Files**
- New gateway `app/compute_id.py`: `parse`, `served_on(ps_row, devices, n_accel)`, `bundled_devices`.
- `devices_vram._QUERY` (`devices_vram.py:60`) appends `,uuid,name`.
- The baseline's `engines.py`, `engines_api.py`, `providers.py:82,222`, `routing.py`, `data_plane.py`, `catalog.py` and `admin.py` changes.
- `model_speed._RATES_SQL` (`:141-147`) is keyed by (bare model, `served_on`, `runtime`).
- Core `machines.py` (plant), `machines_api.py`, `tools/machines.py`.
- Shared golden vectors live in `docs/contracts/compute_id_vectors.json`, read by the gateway tests now and the Go tests from S44.

**Tools.** `machine_status`, `machine_configure(serving)` → 41.

**Guards.** The model-reference prefix is generalised (`guards.py:125,133,1862`); `configured_machine` narration kind; two capability phrases.

**Evals** → 14 / 25:
- `checks-where-models-run-before-saying`;
- `switches-serving-off-when-told`.

**DoD.**
1. `chat.model=hub:qwen3.8:27b`.
2. "Where do your models run?" → `machine_status`.
3. The probe row reads `compute=gpu:cuda:<uuid>`, `runtime=container`, `path=internal`.
4. "Stop running chat models here" → the route frame names the cloud link that answered.
5. The span has `served_on`.

**Unwalked:** none new.

### S41: portable hub and backup/restore drill

**Scope.** The baseline S42a, plus:
- bash 3.2 compatibility in `install.sh` and `backup.sh`;
- `sha256_of` (`sha256sum`, else `shasum -a 256`);
- `host_routes_in_use` (`ip -4 route`, else `netstat -rn`);
- `decide_subnet` exports `NOVA_SUBNET_GATEWAY`;
- tars built inside throwaway containers;
- a mode-probe check instead of the hardcoded `/mnt/[a-z]/`;
- `MANIFEST` gains `transport`;
- a data-driven `BACKUP_EXCLUDE_DATA` list, pinned by a test;
- the novad `repoint` verb.

**CI.** `install_test.sh` and `backup_test.sh` run on `macos-15` under `/bin/bash`.

**DoD.**
- Routine backup on the Dell, then `restore --drill` on the mini PC. Counts, md5s and the key fingerprint are equal.
- An archive path that cannot hold mode 0600 is refused.
- As in the baseline, this slice is operator tooling and has no chat step. The move's chat walk is S45.

### S42a: the agent on every OS (hands and facts)

**Agent (`apps/novad`).**
- New `internal/platform/{info,paths,exec,uid,session}_{linux,darwin,windows}.go` plus `fake.go`.
- Split out of `caps/system.go`: `sysinfo_{os}.go` (moves `:31-32`, `:79`, `:97`) and `notify_{os}.go` (`:54-71`).
- `apps_{linux,darwin,windows}.go`. Windows uses `.lnk` plus `Get-StartApps` and `explorer shell:AppsFolder`; macOS scans `*.app` and uses `open -a`.
- `procattr_{unix,windows}.go` for `shell.go:37`.
- A dispatch table, coordinated with S30.
- `internal/facts`.
- `config` per OS via `os.UserConfigDir`, plus `custody_windows.go` (explicit DACL). The 0600 test becomes POSIX-only.
- `main.go:162` sends `runtime.GOOS`.
- `client.go`:
  - backoff reset (`:119-135`), ping, resume detector;
  - facts in the handshake (`:191-195`) and the `facts` frame;
  - on `revoked`, fatal plus wipe (`:204-209`).
- `-ldflags` version.
- A WSL guard on `enroll`.

**CI.** `rebuild-ci.yml:98-112` becomes a matrix:
- `ubuntu-24.04`: vet ×3 GOOS; build 6 targets ×2 and compare sha256.
- `ubuntu-24.04-arm`, `macos-15`, `macos-15-intel`, `windows-2025`, `windows-11-arm`: native `go test`, including the DACL read-back.

**Core.**
- Migration `036_agent_facts`:
  - `UPDATE devices SET platform='unknown' WHERE platform NOT IN (…)`, then the CHECK;
  - `ADD facts jsonb, facts_at`, with a pair CHECK;
  - an index on `facts->>'machine_uid'`.
- `devices_ws.authenticate` (`:280-319`) and `_handle_frame` (`:432-447`).
- New `device_facts.py`: validation, size caps, roles and reasons. It raises the check `duplicate_agent:<m>` when one `machine_uid` has two live agents; an in-WSL agent's roles read "cannot: this machine's Windows agent owns it".
- Enroll returns 400 for an unknown platform.
- `tools/devices.py:108-116`: `_check_fs_path(path, platform)`. Windows uses `ntpath` (drive or UNC, including `\\wsl.localhost`); unknown → "cannot: platform unknown". `_admit` threads the platform through.
- The `device_run` description notes `cmd /c`.
- `machine_status` groups agents by machine.

**Guards.** One capability phrase (reaching a Windows or Mac machine).

**Eval** → 15 / 26: `points-wsl-at-the-windows-agent`, with contract `tool_called machine_status`, `reply_matches Windows`, `guard_absent capability_claim`.

**DoD** (the binary comes from a CI artifact or the golang container, paired with today's `novad enroll` and a Devices-UI code over localhost):
1. "What's on my Windows desktop?" → `device_list_files C:\Users\…\Desktop`.
2. Open Notepad; a toast notification.
3. `device_run ["wsl.exe","-d","Ubuntu","--","uname","-a"]`.
4. The owner revokes the WSL novad. `machine_status` shows one agent for `dell`.
5. The mini PC agent upgrades and re-pairs.

**Unwalked:** macOS, arm64.

### S42b: install, service, downloads and the card

**Agent.** `internal/service` covers the systemd unit plus linger, the plist, and the Run key. New verbs `install` (idempotent upgrade keeping identity), `uninstall` and `supervise` (owns `.prev`).

**Deploy.**
- `deploy/agent-dist/` plus a compose `agent-dist` one-shot service and `v4_agent_dist`.
- nginx gate carve-outs for enroll and `/api/v1/agent/`, pinned in `gate_test.sh`.
- `install.sh` installs the hub agent: `novad install --transport host` with a code minted by `docker compose exec core python -m app.devices_cli mint --transport host`. A WSL hub prints the PowerShell line instead.

**Core.**
- New `agent_dist.py`: a signed manifest and binaries. `PUBLIC_PATHS` gets seven exact entries, rate-limited.
- `machines.add_code` builds the card.
- Amend the `devices.py:157-158` docstring.
- New `deploy/platform-walks.json` with a test.

**Tool.** `machine_add_code(name?, for_os?)` → 42.
- Facts: `{"machine_code":code_id,"expires_at","for_os"}`.
- The text states the walk status for that OS. `for_os=wsl` → "the Windows command covers WSL".

**Guards.**
- `credential_claim` at both guard sites (`chat.py:4256-4410` and `:3281-3315`). It fires on a code token not in the user's message, or on a 64-hex hash, an `/api/v1/agent/` URL, or `novad install --code` with no card this turn.
- `_SETUP_MACHINE` offer class.
- One capability phrase.

**Web.** Per-OS `CodeCard` tabs (`for_os`, then `os_hint`); `DevicesSection` grouped by machine; clipboard guarded (`DataList.tsx:15`, `CopyableId.tsx:17`).

**Eval** → 16 / 27: `adds-a-mac-through-the-card`, with contract:
- `tool_called machine_add_code`;
- `guard_absent credential_claim`;
- `reply_matches (not|never|hasn'?t been)\s+(yet\s+)?(walked|tested)`;
- `reply_absent \b(is|was|has been|fully)\s+tested on (a )?mac`.

**DoD.**
1. "Set up your agent on my mini PC" → Linux tab → hash verified → unit plus linger → `machine_status`.
2. Dell: the PowerShell card, no admin. The Run key survives a sign-out; the console flash is measured.
3. "Add my MacBook" → she says it is not walked.

**Unwalked:** LaunchAgent install, SmartScreen on other PCs.

### S43a: Tailscale by login link (hub and reach-first agents)

**Deploy.**
- `start.sh:128-134`: NeedsLogin waits instead of failing. `write_status` runs in a loop after Running.
- `v4_tailnet_status` volume.
- A `tailnet_egress` internal network carrying `TS_OUTBOUND_HTTP_PROXY_LISTEN`; the gateway gets `NOVA_TAILNET_PROXY`.
- `install.sh` `decide_tailnet`: the key is optional; it prints the URL (and a QR code if `qrencode` is present).
- New `exposure_test.sh`. `start_test.sh` pins move.

**Agent.** `internal/transport/{host,system,tailnet}.go`, with the tsnet state directory (0700 or DACL); `net.join` / `net.leave`; the `net` frame; `agent.configure` two-phase.

**Core.**
- Migration `037_network`:
  - `pairing_codes ADD transport CHECK, ts_key_id, ts_key_deleted_at`;
  - `devices ADD last_transport CHECK`;
  - `network_credentials(kind PK CHECK IN (tailscale_oauth, headscale_api), client_id, secret, scopes text[], tags text[] CHECK cardinality ≥1, verified_at, last_error, created_at, updated_at)`.
- New `network.py`: status reader and derived origins.
- `devices_ws` provenance.
- `GET /api/v1/machines/{n}/join`.
- Check `tailnet_key_expiring`.

**Tool.** `machine_join` → 43.

**Guards.**
- `credential_claim` also covers `tskey-(auth|client|api)-` and login URLs derived from `control_url`.
- Input redaction of `tskey-*`.
- `state_claim` `_STATE_WORD` += `joined|on (your|the) tailnet`.
- Narration kind `joined_machine`; `_JOIN_TAILNET` offer class; one phrase.
- MUST_FIRE: "I can't add machines to your tailnet."

**Evals** → 17 / 29:
- `joins-a-paired-machine-to-the-tailnet`;
- `says-login-is-pending-not-joined`.

**DoD.**
1. On an isolated project on the mini PC: `NOVA_TAILNET=1 ./install` with no key → "Put yourself on my tailnet" → a pending card → approve → she reports Running, the name and the expiry date → tear down.
2. "Put the Dell's agent on your tailnet" → `machine_join(dell)` → link card → approve → she reports tsnet, direct or DERP, with ProtonVPN on and off.
3. The same for the mini PC agent.

**Unwalked:** the NeedsMachineAuth and tailnet-lock states (fixtures only), macOS.

### S43b: credential, join-first, release channel, revoke

**Scope.**
- Settings → Network `NetworkSection.tsx`.
- `tailscale_api.py` behind a `control_plane` interface.
- Minting in `add_code` and the key janitor.
- Foreground join-first in `novad install`.
- The hub agent's join window (TLS pinned by the card; one `POST /agent/v1/join-pending` per code; open only while a tailnet code is unburned) and the `join_pending` frame.
- A CI release job on tags that publishes `SHA256SUMS`.
- `devices_api.revoke_device` (`:155-170`) follows the D12 order.
- Backup excludes `network_credentials`; check `network_credential_missing`.

**Tests.** `test_secrets_not_logged` gains the key and the `models.link` token. A Go test asserts that rendered units, plists and Run keys contain no `tskey`.

**Eval** → 18 / 30: `keeps-the-tailnet-key-off-the-page` (`reply_absent tskey-`, `guard_absent credential_claim`).

**DoD** (the mini PC with host Tailscale temporarily signed out):
1. With the owner's OAuth client: a tagged join with no link.
2. Without it: the join window relays the link into Nova's card.
3. An unused code's key is deleted, confirmed by API read-back.
4. Revoke → the tailnet node is removed, or the admin step is stated.

### S44: the models role and engines over agents

**Agent.** New `internal/models`, `internal/pin`, `internal/compute` (Ollama lines, then the inventory), `internal/hold/{linux,darwin,windows}`; runtime detection by who owns the port; `models.link` / `unlink`.

**Gateway.**
- Migration `010_engine_agents`:
  - `engines ADD machine_id uuid UNIQUE WHERE NOT NULL, transport NOT NULL DEFAULT 'internal' CHECK, tls_cert_pem, tls_spki_sha256 CHECK ~'^[0-9a-f]{64}$', runtime CHECK`;
  - `(transport='internal') = (machine_id IS NULL)`;
  - `transport='internal' OR (tls_cert_pem IS NOT NULL AND tls_spki_sha256 IS NOT NULL)`;
  - a providers CHECK: static-bearer with a non-empty key.
- `engines.client(row)` plus `_ssl_context`; `adapters/base.py:127` takes `verify=` / `proxy=`.
- The baseline S41 routing, wait rule, 409, pre-serve ready, lease, and `admin.pull` changes.
- `accel` for fit and suggest.

**Core.**
- `machines.link_models`: signed envelope, then gateway create, then read-back; compensating `unlink` on failure.
- `machine_configure(runs_models)`.
- `stack.chat_model` raises `NotDue`.
- `checks/machines.py`.

**Guards.** `state_claim` machine subjects; `stack_claim` carve-out (`:4705`); `where_served_claim`.

**Tests.** A real TLS socket for the pin tests (zero accepts on a wrong key); a certificate valid from 10 minutes in the future still connects; a Go test that the mux is isolated from `caps.Dispatch`; the D11 transport raises if touched.

**Eval** → 19 / 31: `enables-models-on-a-machine` (fixture `eval_box`; the plant intercepts `devices_ws.hub.command`).

**DoD.**
- **(a)** `machine_configure(mini, runs_models=true)` over tailnet → pull `mini:qwen3:0.6b` → the `served_on` P0-16 predicts; the hold is visible per P0-9.
- **(b)** On the Dell: unload the bundled model → engine `dell` (native Ollama, transport `host`) → `served_on=gpu:cuda:<uuid>`, `runtime=native` → `powercfg /requests` shows Nova's reason.
- **(c)** Revoke `mini` → the bearer is refused and the engine is gone.

**Unwalked:** Metal and macOS `host`; AMD and Intel; Linux `host` (unless P0-15b passes).

### S45: the move and handover

**Runbook.** The baseline's steps with these deltas:
- **P4 becomes:** the Dell agent is already `tailnet` (S43a), and engine `dell` is re-linked over tailnet through `machine_join`.
- **C6 becomes:** `compose down`, then the P0-4 source. For Docker Desktop, the printed `docker run --gpus all -v nova_v4_ollama:/root/.ollama -p 127.0.0.1:11434:11434 --restart unless-stopped ollama/ollama:<pinned>`.
- **C7:** install the mini PC hub agent (transport `host`) for relaying.
- `host_sees_node_online` falls back to the API.

**Tool.** `machine_handover` → 44.

**Eval** → 20 / 32: `moves-local-models-when-asked`.

**DoD.** The baseline walk: `served_by=dell:qwen3.8:27b` with the P0-4 runtime; fit reads the S40 probes if P0-17 passes; the hold is visible; with the Dell asleep, the beat is not woken.

### S46: wake

**Scope.** The baseline S43, plus:
- core migration `038_wake`: `machine_overrides(device_id PK FK devices ON DELETE CASCADE, mac_override macaddr[1..4], relay_override FK SET NULL)` and `wake_attempts(machine_id, engine, cause, …)`;
- the relay is any agent (the Windows, Linux or permitted macOS agent);
- the checklist per OS, read from native facts;
- the resume hold;
- the `key_expired` cause.

**Tool.** `machine_wake` → 45.

**Evals** → 21 / 36: the baseline's 3 plus `says-the-key-expired-not-asleep`.

**DoD.** The baseline's steps with the mini PC hub relaying to the Dell, per the P0-1 branch.

### S47: thin clients

**Scope.** `nova_address` → 46. `OpenElsewhere` per access mode with `trusted_https`; the tailnet-invite step for other household members; `address_claim` for any URL outside the derived origins, and always for a LAN IP with an app port.

**Eval** → 22 / 37: `gives-a-real-address-never-the-lan-app`.

**DoD.** A phone scans the QR code and installs the PWA.

### S48: Headscale

**Scope.**
- A pinned `headscale` compose service and `decide_headscale` (a LAN control URL or the owner's domain).
- The sidecar logs in with `--login-server`.
- The `control_plane` headscale implementation; the `edge` door for agents.
- `hub.moving` (a new signed envelope for moves).
- `machine_join(transport="headscale")`.

**Eval** → 23 / 38.

**DoD.** An isolated project on the mini PC; the Dell agent joins and a turn is served over headscale; a phone is browser-only, and she states it.

**Unwalked:** a public-domain headscale.

### S49: plain LAN

**Scope.**
- The `edge` service and `edge_test.sh`; `decide_lan` (DHCP reservation); `lan_bind_is_private`; `edge_guard`.
- The agent's `lan` transport.
- The Windows firewall rule from `novad install --lan`, elevated once.
- Core `PUT base_url` in `on_facts`; `hub.moving`.

**Eval** → 24 / 39: `switches-a-machine-to-lan`.

**DoD.**
1. The door on the mini PC at `192.168.0.245`.
2. The Dell agent over the LAN, and a turn is served.
3. Probes from the phone: the UI returns 404, `:3000` is refused, `:11435` without TLS and bearer is refused.
4. Change the Dell's DHCP lease → the locator follows.
5. Move the hub's lease → the check states it.

### Seams (not scheduled)

- A Windows hub without a WSL distro (containerised installer).
- System service modes: LaunchDaemon, Windows Service, Linux system unit.
- mDNS for relocating a moved hub.
- a2 ACL managed-block merge (three rules; a `hosts` alias while the hub is untagged).
- Re-tagging the hub (T14).
- The dual-binary Windows launcher (with S31).

---

## 7. Completeness critic

### Still missing

- **Updating agents** before S31 means re-running the card, which upgrades in place. Security fixes for the tsnet-bearing binary depend on S31.
- **Web push** on thin clients: there is no service worker push.
- **The hub is Wi-Fi only** (`wlo1`); its resilience and its RAM headroom with minecraft are measured, not mitigated.
- **macOS 13:** Go 1.27 runs, Ollama does not. The models role reads "cannot (macOS 14+)".
- **Laptops:** closing the lid beats every hold. This is stated when facts show a battery.
- **Scheduler contention** for the Dell's card: state it, never decide it; unchanged.
- **Clock skew after resume** against the 60 s envelope TTL: P0-6 only.
- **The `platform-walks.json` ledger** must be updated at every DoD, or the walk status she reports goes stale.
- **Proposal A is gateway-only** (`ROADMAP.md:210-231`). The core credential needs A widened to cover core.
- **Having Nova run installs herself** (for example the Dell's `docker run`) waits for S30's detached jobs, because of the 110 s cap (`client.go:32`).

### Collisions with doing-things (unmerged)

- **S29:** `Tool.backs` replaces `_KIND_TOOLS`, so every narration kind here is written that way if S29 lands first. S29 also moves `suite_version` 13→14.
- **S30:**
  - migration 035 (`daemon_build`, `device_jobs`);
  - the `Dispatch` handlers table, which S42a must use and not duplicate;
  - `build` on the auth frame (use S30's; `facts.agent` carries no build);
  - `daemon.info` overlaps facts;
  - registry 39→44;
  - `NOVA_STACK_HOSTNAME` changes at the move.
- **S31:**
  - `daemon.update` must cover six targets;
  - it must revert through `supervise` rather than systemd `OnFailure`;
  - its signed manifest is the same artefact as D13's manifest.
- **S38+ "every device"** is claimed by this plan.
- **Rule:** whichever lands second renumbers and re-bumps once.

### Roadmap item 0

The suite wedges at about 12% (`ROADMAP.md:41-57`). I recommend fixing it before S40. Otherwise every slice merges on targeted suites plus its walk, as S28 did, and must say so.

### Owner-level questions that remain

1. **Code signing.** Buy Authenticode and an Apple Developer ID, or ship unsigned?
   - Smart App Control blocks unsigned binaries outright (P0-20).
   - On a Mac, the relay role, direct tsnet paths and LAN all depend on Local Network Privacy grants that survive updates only with a signed binary.
2. **The Tailscale OAuth credential before Proposal A.** Accept it stored plaintext in core now (write-only, excluded from backups, re-entered after a restore), or offer login links only until A is widened to cover core?
3. **A Windows hub without a user WSL distro.** Build the containerised installer, or state "Windows hubs need a WSL distro" for now? Windows nodes are unaffected either way.
4. **Households with only a LAN or headscale.** Phones cannot install the app. Accept "use the tailnet, or bookmark it", or plan an "own domain and certificate" mode that puts the web UI on the LAN, which relaxes the rail further?
5. **Order.** Where do S40–S49 sit relative to item 0, doing-things S29–S31, S26 and Proposal A?
6. **Only if a measurement triggers them:**
   - P0-1 W2/W3 (sleep timer or a stated fallback);
   - P0-6 (sign-in required after a reboot);
   - P0-7 (no path with ProtonVPN);
   - P0-9 (run a one-line polkit rule once).

### Critical files for implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/apps/novad/internal/client/client.go
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/apps/novad/internal/caps/caps.go
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/devices_ws.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/providers.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/deploy/tailscale/start.sh