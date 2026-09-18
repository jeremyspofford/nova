# Adversarial review: the revised engines, wake, hub move and surfaces for decisions 9–11

## Summary

Most of the baseline carries over correctly. These parts survive: the wait rule, the 409, walls, the ledger, the move verbs, and the one-agent `models.link` envelope that replaces enrollment.

Two structural choices would lock the design into the wrong shape.

1. **An `agent`-kind hub can only reach its own models over an overlay.** The CHECK `(kind='bundled') = (transport='internal')` plus "agent hubs are reached over the transport" force this. A Mac-only owner therefore cannot use their own GPU without Tailscale, or without S49 exposing the agent on the LAN for a same-host hop.
2. **The accelerator part of `served_on` is guessed from a hardware inventory rather than read from Ollama.** Rows get stamped with devices that did not serve the request. Rows never change meaning, so this can't be fixed later.

Beyond those two, the review found:
- two contradictions of binding owner decisions (two agents on one machine; a quiet regression on holding the machine awake);
- several Windows and macOS realities that the "V"/"CI" labels hide;
- gaps in revoke, key-expiry and move-under-Headscale/LAN handling that the transport choice creates.

**Verified in the repo:**
- The baseline numbers are right: core `034`, gateway `008`, registry 39 (`test_tools_registry.py:115`), corpus 23 at `suite_version` 13 (`test_eval_corpus.py:376,382`).
- These citations are right: `main.go:162`, `devices_ws.py:52-67`, `tools/devices.py:108-116`, `client.go:32`, `providers.py:82-92,222-237` and `checks/stack.py:49-50,207-215`.
- One citation is wrong: `embedding.py:75` is `services/memory/app/embedding.py:75`, not core.

## Ranked findings

### Critical

**1. An `agent`-kind hub needs an overlay to reach its own GPU (rigidity: Mac-only users; decision 10 ordering)**
- **Defect.**
  - D-2 says an `agent` hub is "reached over the hub's transport like any other agent".
  - Migration 010 enforces `(kind='bundled') = (transport='internal')`, so a hub agent must use `tailnet` or `lan`.
  - The tailscale sidecar exists only under `profiles: ["tailnet"]` (`deploy/docker-compose.yml:243-244`).
- **Scenario.** A single MacBook with no Tailscale account runs `install.sh`, then picks "This machine" in `ChooseEngine`.
  - Metal is unreachable until S49.
  - S49 then binds the models listener on the LAN, with TLS pinning, for a hop that never leaves the machine.
  - With Tailscale, every token goes gateway → sidecar netstack → tailnet → tsnet netstack on the same host. The hub's own models then fail on DERP, coordination-server or key-expiry problems.
  - P0-14 exists only to measure this hairpin.
- **Fix.**
  - Add `transport='host'`, allowed only on the builtin `hub` row.
  - Docker Desktop (macOS and Windows): the agent binds `127.0.0.1:<port>` and the gateway calls `http://host.docker.internal:<port>` with the bearer. Docker documents `host.docker.internal` as the host address ([how-tos](https://docs.docker.com/desktop/features/networking/networking-how-tos/)). That the host side can bind to loopback only is **not stated by Docker**; it is widely reported, so it needs a new P0-15 on the Dell.
  - Linux: keep `bundled` (NVIDIA or a ROCm overlay), or bind-mount a Unix socket from the agent into the gateway.
  - This drops P0-14 and the `extra_hosts` debate, and keeps the "tailnet is the only non-loopback exposure" rail intact.

**2. The accelerator identity is guessed, so rows are mislabelled permanently (house rules: "omitted, never guessed" and "rows never change meaning")**
- **Defect.** D-3 stamps `size_vram == size → the accelerator(s)`, where the device list comes from an independent inventory: sysfs, the registry, or nvidia-smi.
- **Evidence.**
  - Ollama enables Vulkan by default on Windows and Linux ([docs.ollama.com/gpu](https://docs.ollama.com/gpu)).
  - On hybrid laptops it picks the Intel iGPU and runs in shared RAM while the NVIDIA dGPU sits idle ([ollama#16667](https://github.com/ollama/ollama/issues/16667)).
  - `/api/ps` still reports the model as fully in "VRAM". The design would stamp `gpu:intel…+gpu:nvidia:…`, or the NVIDIA card alone.
  - Multi-GPU machines get stamped with every card. `devices_vram.py:24-31` already admits it cannot attribute across cards.
  - On the N150 mini PC, native Ollama with Mesa ANV may take the UHD iGPU. The S44 DoD expectation `served_on=cpu:intel-r-n150|4c|15g` is then unmeasured.
- **Fix.**
  - Take the accelerator set from **Ollama's own report**, its `msg="inference compute"` lines. These carry `library`, `description`, `pci_id`, `type` and `total`/`available` ([examples in ollama#16624](https://github.com/ollama/ollama/issues/16624)). `install.sh` already reads this line (`check_inference_compute`).
  - Key the identity on `pci_id` plus `description`, not on `type`: #16667 shows `type` can be inverted.
  - Rule: exactly one device Ollama reported plus `size_vram == size` → that device. More than one reported device → omit the accelerator part, unless the library is CUDA and nvidia-smi's compute-apps shows the runner PID on a single UUID.
  - Add P0-16: record the line on the N150 (native and container) and on the Dell (native and Docker Desktop).

### Major

**3. D-1 contradicts decision 9 (one agent per machine) and allows two engines on one GPU**
- **Defect.** The in-WSL agent stays "for hands and models". Risk 2 only flags the duplicate by hostname.
- **Scenario.** Docker Desktop's `127.0.0.1:11434` is reachable from both Windows and WSL. The owner links models on both agents and gets `dell:X` and `wsl:X` on one 3090. Each engine's fit then counts the other's residency as outside use.
- **Fix.**
  - The Windows agent is the machine's agent. Hands inside WSL go through `["wsl.exe","-d",<distro>,"--",…]`. Files go through `\\wsl.localhost\<distro>\…`, which the proposed `ntpath` UNC check already admits. This works because the logon task runs in the user's session.
  - An agent inside WSL reports **every** role, models included, as `cannot: this machine's Windows agent owns it`, whenever a Windows agent with the same hostname is paired.
  - The in-WSL novad is retired in S42, which changes DoD step 3.
  - Add `UNIQUE (machine_id) WHERE machine_id IS NOT NULL` on `engines`.

**4. The resume-time hold was dropped (regression against the baseline; macOS DarkWake)**
- **Defect.** The baseline helper held for 180 s after a resume whose wake source was a network adapter or unreadable (integration.md §1.3). The revised design holds only while `in_flight>0` or a lease set by a request is live.
- **Evidence.**
  - A Mac woken by a magic packet enters DarkWake for about 30–60 s, and repeated packets do not extend it ([Apple forums 771999](https://developer.apple.com/forums/thread/771999)).
  - The first `/ready` must wait for tsnet to re-handshake from a user-session process.
- **Fix.**
  - The agent runs a pure-Go resume detector, which watches for wall-clock versus monotonic jumps.
  - After a resume whose source is network or unknown, it takes a hold bounded by `min(120 s, machines.wake_max_wait_s)` and reports it in facts.
  - Whether this counts as "using it" under decision 2 is owner question 3 below.
  - On macOS use `caffeinate -i -s -w <agent pid>` (`-s` only on AC), and kill it on release. `-t N` with restarts leaves gaps.
  - The Mac's first measurement must record DarkWake length and whether `-i` holds.

**5. Revoke leaves a working bearer and listener**
- **Defect.** novad treats every `auth_error` as retryable (`client.go:204-209`). `revoke_device` only disconnects (`devices_api.py:156-170`). The gateway keeps the engine row and its `api_key`.
- **Scenario.** A revoked laptop keeps serving `/agent/v1/ollama/*` to the old token, and anything that restores an old backup can still use it.
- **Fix.** Revoke runs in this order:
  1. gateway `DELETE /admin/engines/{n}`;
  2. `models.unlink`, if the device is connected;
  3. revoke.
  - Also add a distinct `auth_error` reason code `revoked`. On that code the agent wipes its token, closes its listeners and, for tsnet, logs out.
  - Add a test that revoke empties `providers.api_key` for that `machine_id`.

**6. An expired node key looks exactly like sleep**
- **Scenario.** Login-link tsnet nodes are user-owned, so their node keys expire (180 days by default). The control WebSocket (tsnet since S43) and the models listener disappear together.
  - The wake plan then sends packets to an awake machine and records `no_answer`.
  - After three of those, the no-wait rule starts stating that the machine sleeps.
- **Fix.**
  - `facts.transport` gains `key_expiry` and `tagged`.
  - Core adds a check `transport_key_expiring:<m>`, 7 days ahead.
  - `wake.plan` refuses with a stated cause when the last facts showed an expiry in the past: "dell's tailnet key expired 03:12; I cannot reach it until it's signed in again".

**7. The bootstrap path relaxes the rail on every hub, and its integrity check doesn't work as written**
- **Defect.** Interface #4 serves `/api/v1/agent/*` over plain LAN HTTP "while a code is live" with "the sha256 on the card". But `curl … | sh` runs whatever arrives, so a hash printed on the card checks nothing.
- `PUBLIC_PATHS` is an exact-match frozenset (`identity.py:44-51,191`), so every download path must be listed or the install gets 401.
- **Fix.**
  - The command verifies before it executes. For example: `curl -fsSLo i.sh <url> && echo '<sha>  i.sh' | shasum -a 256 -c - && sh i.sh …`. On Windows, the equivalent uses `Get-FileHash`.
  - The installer then checks the binary against a hash embedded in it.
  - The LAN window opens only on hubs that chose transport (c). Tailnet hubs serve downloads over `tailscale serve` HTTPS, reached after tsnet has joined.
  - The code is sent to core only **after** the overlay is up, or over the pinned LAN TLS channel.
  - List the downloads in `PUBLIC_PATHS` and pin them in `test_devices_e2e`.

**8. Windows Scheduled Task defaults kill the agent**
- **Defect.** Task Scheduler's defaults include "stop the task if it runs longer than 3 days" and "start only on AC" / "stop if going on batteries". The matrix marks this row "V", but a 30-minute walk cannot see it.
- Whether a **standard** (non-admin) user can register a logon-triggered task is unresolved: search results conflict. The Dell walk runs as an admin account, so it cannot answer it.
- **Fix.**
  - Register with `ExecutionTimeLimit=PT0S`, `DisallowStartIfOnBatteries=false`, `StopIfGoingOnBatteries=false`, `RestartCount/Interval`, `MultipleInstances=IgnoreNew`.
  - Fall back to `HKCU\…\Run` (no admin) and state which one was used.
  - Add P0-18: register the task from a standard local account, only if the owner allows creating one.

**9. macOS Local Network privacy undermines LaunchAgent roles**
- **Evidence.**
  - Apple exempts launchd daemons and root, but **not** launchd agents.
  - For non-Apple-signed binaries in a LaunchAgent, the denial is silent or shows as "no route to host" ([nixpkgs#375072](https://github.com/NixOS/nixpkgs/issues/375072), [forums 778457](https://developer.apple.com/forums/thread/778457)).
  - Apple's DTS engineer notes that ad-hoc signing does not help identity tracking. Each self-update is a new identity.
- **Affected.** The relay broadcast, tsnet's direct LAN paths (which degrade to DERP), and all of S49 on macOS.
- **Fix.**
  - The macOS relay role defaults to the LaunchDaemon mode.
  - The Mac tile states that LaunchAgent LAN access "may be denied without a prompt".
  - The design must say that owner question 2 (signing) now decides whether the LAN roles work on a Mac, not just cosmetics.

**10. A move under Headscale or LAN breaks every agent**
- **Defect.** Tailnet mode survives the move because `TAILNET_HOSTNAME` moves with the sidecar state. Headscale's `server_url` is baked into every tsnet node, and LAN agents pin the hub's address and certificate. Both change at a Dell-to-mini move.
- **Fix.**
  - Record the transport in `MANIFEST`.
  - Require a stable hub name at install: a DNS name for Headscale `server_url`, mDNS `_nova._tcp` for LAN.
  - Before `backup --move`, core sends each connected agent a signed `hub.moving {new_addr, control_url?}`. The signing key moves with the backup, so agents re-point once the new hub answers the challenge.
  - `restore` refuses to continue if the address changes and some agent never acknowledged the move.

**11. The live accelerator memory is gone, so fit, suggest and onboarding stay NVIDIA-only**
- **Defect.** The baseline node facts carried `cards[total,used,free,util]`. The revised facts carry `vram_bytes|null` only, sent once in the auth frame.
- Everything that computes a fit is NVIDIA-only:
  - `_free_and_total_vram_gb` / `devices_vram.read_vram` (`admin.py:141-166`);
  - `suggest.largest_single_gpu_vram_gb` (`suggest.py:47`);
  - `detect_gpus_json` (`install.sh:641-667`).
- **Scenario.** A Mac hub hits `HardwareDetection.tsx:106-108` and says "No GPU detected". A reword does not fix the data.
- **Fix.**
  - The agent's `/agent/v1/facts` returns `accel:[{id, total_bytes, free_bytes|null, util|null, source, reason}]`, per the matrix: nvidia-smi; amdgpu sysfs `mem_info_vram_used`; Ollama's `available` at startup; otherwise null with a reason.
  - Cache it 30 s per engine.
  - `/admin/hardware` and `suggest` read the hub engine's facts.
  - Fit states "free unknown" rather than assuming the card is empty.

**12. A kind switch is a handover in disguise**
- **Defect.** `models_via` swaps the hub's entire model store. Chains naming `hub:X` may now point at nothing, and `engine_models` still describes the old store (vision flags, context lengths).
- **Fix.** `machine_configure(models_via)` should:
  - clear `engine_models` for `hub`;
  - return `not_on_target[]` like the handover route;
  - have its read-back include "chat.model hub:X is not installed on the native Ollama".
- Also unload the bundled model before the S44(b) walk. Otherwise two Ollamas share the 3090 and the stamp becomes `gpu+cpu`.

**13. The container CPU id is computed by the wrong process**
- **Defect.** D-3 says the `cpu:` id inside a container "describes the VM". But in the Dell's C6 shape, a **native Windows** agent fronts Docker Desktop's Ollama and reads the registry, so it stamps the host's CPUs and RAM.
- **Fix.** When the upstream is a container, derive `cpu:` from `docker info --format '{{.NCPU}} {{.MemTotal}}'`, or from `/proc` inside the container.

**14. How the agent finds Ollama and labels the runtime is unspecified**
- **Defect.** The facts drop the baseline's `ollama{ok,version,resident}`. `runtime` becomes a label nobody derives.
- **Fix.**
  - Add `facts.ollama = {url, version, runtime: native|container|wsl, source, reason}`.
  - The runtime comes from the process that owns the listening port:
    - Windows: `GetExtendedTcpTable` → image name (`ollama.exe`, `com.docker.backend.exe`, `wslrelay.exe`);
    - Linux: `/proc/net/tcp` inode → `/proc/<pid>/exe`;
    - macOS: `lsof -Fp`.
  - Put a CHECK on `engines.runtime` matching `probes.runtime`, including `wsl`.

**15. The star topology stretches without saying so**
- **Defect.** The gateway now drives state changes (`pull`, `delete`) on a process that also holds `shell.exec`, on a bearer rather than a core-signed envelope.
- **Fix.**
  - Say it explicitly: the models listener is the gateway's engine surface, like Ollama itself, and never a star leaf.
  - A Go test pins that the listener's mux cannot reach `caps.Dispatch`.
  - The gateway validates `listen.addr` against the agent's own `facts.transport` (tailnet CGNAT or ULA address, or one of its own LAN interface IPs).

**16. Decision D-4 rests on a partly false premise**
- **Defect.** Docker Desktop's GPU path needs the **WSL2 backend**, which installs its own `docker-desktop` distribution, not a user distribution ([Docker GPU](https://docs.docker.com/desktop/features/gpu/)). A hub that runs its models natively through the `host` transport (finding 1) doesn't need Docker's GPU at all.
- Only the bash installer and `backup.sh` block a Windows hub without a user distribution.
- **Fix.** Reframe owner question 1 with a cheap option: `install.ps1` runs `install.sh` and `backup.sh` inside a throwaway bash+docker-cli container, with the socket and repo mounted. That path is unmeasured, and it needs host-path translation, the same problem `NOVA_HOST_ROOT` has.

### Minor

| # | Defect → fix |
|---|---|
| m1 | Risk 1 is wrong. Linux Ollama runs as a system service at boot ([docs](https://docs.ollama.com/linux)). Windows documents running `ollama serve` as a service from the standalone zip ([docs](https://docs.ollama.com/windows)). Restate it, and treat "agent-supervised `ollama serve`" as an option. |
| m2 | `macos-15-arm64` is an image name, not a `runs-on` label. Use `macos-15`, plus `macos-15-intel` and `ubuntu-24.04-arm` ([runner-images](https://github.com/actions/runner-images)). The macOS VM reports "Apple M1 (Virtual)" and no GPU-core count, so CI tests only the unreadable branch. |
| m3 | `devices.os` duplicates `devices.platform` (`011_devices.sql:43`). Put a CHECK on `platform` and keep arch and version in `facts`. |
| m4 | `/mnt/[a-z]/` is hardcoded. Instead, derive it: write a probe file, `chmod 600`, and refuse if the mode doesn't read back. |
| m5 | A single top-level `gateway` becomes the VPN adapter under full-tunnel ProtonVPN. Move it to `ifaces[].gateway`. `standby` mixes OS terms; normalise it to `s3\|s0ix\|unknown` plus a raw value. |
| m6 | On Modern Standby machines on DC power, power requests end 5 min after the sleep timeout ([PowerSetRequest](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest)). Add `hold.bounded_by`. The claim that "holds differ by session" is unsupported; drop it or measure it. |
| m7 | "Phones cannot install over LAN" is only proven for Chrome. iOS Add to Home Screen over HTTP is unverified; state it per platform. `navigator.clipboard` is unguarded at `DataList.tsx:15` and `CopyableId.tsx:17`, so copy buttons throw on HTTP origins, including the install card's. |
| m8 | The eval can't check `machine_add_code(os=…)`: there is no argument predicate (`cases.py:57`). The card already carries all three commands, so drop `os`. |
| m9 | The speed key includes `served_by`, so the baselines reset at handover. Key on the model without its engine prefix, plus `served_on` and `runtime`. |
| m10 | The code on the command line lands in shell and PSReadLine history, which falsifies `devices.py:157-158`. Read it from a prompt with `--code -`, or amend the docstring. |
| m11 | S40 exposes `models_via` before `agent` exists. The single-value `kind` CHECK in 009 is YAGNI; add the column in 010. |
| m12 | More than 4 devices must mean omitted, never truncated. |
| m13 | The agent `install.sh` runs under `sh`, which is dash on Ubuntu. Make it POSIX and test it under dash. |
| m14 | Six tsnet binaries (~30–40 MB each, not measured) in the core image. Use a separate artifact image or volume that S31 fills. |
| m15 | The greyed "arrives in S48/S49" options put slice ids in user text. Don't render them until built. |
| m16 | YAGNI: `ollama container --adopt` can be one printed `docker run --gpus all -v nova_v4_ollama:/root/.ollama -p 127.0.0.1:11434:11434 --restart unless-stopped ollama/ollama:0.33.1`. Defer the Windows Service mode. Defer `tls_pin` to S49. |
| m17 | `kind=agent` still needs the `inference` profile for memory's embedder (`memory/app/embedding.py:75`). `install.sh` must enforce it, not assume it. |
| m18 | `address_claim` covers HTTPS only, and only from S47. Invented `http://192.168…` or install URLs pass through S42–S46. Add an origin check to `code_claim` in S42. |
| m19 | Nothing on the data path confirms the hold. Add `hold` to the `/ready` body and an `X-Nova-Agent-Hold` response header, so "held" in `machine_wake` is verified. |
| m20 | The eval plant must also intercept `devices_ws.hub.command`; `link_models` sends a real envelope. |

## What survives unchanged

- The providers and engines rows, the `hub` rename, first-colon ids, and `library:`.
- The wait rule and derived `wait_links`; 409 `engine_asleep`; `X-Nova-Skip-Engines`; `ProviderUnreachable` never walled; `ENGINE_REACH_S`; the TTL caches; `engine_models`; D11; the pull timeout; `/load` pinning.
- Deleting the node package, and pairing once plus a `models.link` envelope in which the agent mints the token. The token shows up only in the result frame, and the audit summary is `capability ok` (`client.go:371-382`).
- `engines.transport` choosing egress in place of the `*.ts.net` suffix. The Headscale seam through tsnet `ControlURL` and the same hub sidecar. tsnet exposes `ControlURL` and `ClientSecret` ([pkg.go.dev](https://pkg.go.dev/tailscale.com/tsnet)).
- A per-request stamp and a separate `runtime`, once finding 2's attribution rule is in.
- The wake ledger keyed by machine; the rate limit counted from `settled_at`; the no-wait rule; a single budget; the late watcher; `ready_cpu`; relay = any agent (the Windows or LaunchDaemon agent).
- Every backup, restore and move verb, and the drill, plus the throwaway-container tars.
- The per-OS checklist content; S47's `trusted_https`; the tool list and pin choreography; P0-1, -5, -6, -7, -9, -10, -11, -12 and -13.
- The Windows hold mechanism. Neither API is wrapped in x/sys/windows; the fetched `zsyscall_windows.go` did not contradict this. The logind polkit default (`allow_any=auth_admin_keep`) is [verified](https://github.com/systemd/systemd/blob/main/src/login/org.freedesktop.login1.policy). Also take `inhibit-block-idle`, which is `allow_any=yes`, as the no-polkit half, and report both.

## Corrected design deltas

**Data model**
- Gateway 009: drop `engines.kind`.
- Gateway 010:
  - `kind IN ('bundled','agent')`;
  - `transport IN ('internal','host','tailnet','lan')`;
  - `CHECK ((kind='bundled') = (transport='internal'))` and `CHECK (transport<>'host' OR provider='hub')`;
  - `runtime CHECK IN ('container','native','wsl')`;
  - `UNIQUE(machine_id)`;
  - `tls_pin` moves to S49.
- Core 036:
  - `devices ADD facts jsonb, facts_at`;
  - CHECK on the existing `platform`;
  - no `os`, `arch` or `agent_version` columns.
- Core 038 also gets `wake_attempts.cause text`, which records `key_expired`, `revoked` and similar.

**Wire**
- `facts` gains:
  - `ollama{url,version,runtime,source,reason}`;
  - `accel_live` via `/agent/v1/facts`;
  - `inference_compute[]` (Ollama's own lines);
  - `transport.{key_expiry,tagged}`;
  - `ifaces[].gateway`;
  - `hold.{bounded_by,resume_hold_s}`.
- New envelope `hub.moving`.
- New `auth_error` reason code `revoked`.
- `/ready` gains `hold`.
- `X-Nova-Agent-Served-On` follows finding 2's rule and is omitted when ambiguous.

**Files**
- `app/compute_id.py`: `served_on(ps_row, inference_compute, n_accel)`.
- `engines.client`: add the `host` branch.
- `devices_api.revoke_device`: revoke in the finding 5 order.
- `identity.PUBLIC_PATHS`: add the downloads.
- `backup.sh`: the mode-probe check; the `MANIFEST` transport; refuse on an unacknowledged move.
- `install.sh`: ROCm overlay row (`inference_library_for_driver`); enforce the embedder profile.
- `model_speed._RATES_SQL`: key without the engine prefix.
- `DataList.tsx` and `CopyableId.tsx`: guard the clipboard.
- `HardwareDetection`: fed from hub engine facts.

**Tools, guards and evals**
- Drop `machine_add_code.os`.
- `machine_configure(models_via)` returns `not_on_target[]`.
- `code_claim` gains the origin check.
- Evals: add `says-the-key-expired-not-asleep` (fixture). The corpus becomes 34 and the suite 20 is unchanged if it lands inside S46.

**P0 additions**
- **P0-15** (Dell): `host.docker.internal` reaching a listener bound to Windows loopback.
- **P0-16**: Ollama's `inference compute` lines on the N150 (native and container) and the Dell (native and Docker Desktop).
- **P0-17**: the nvidia-smi.exe UUID equals the Docker Desktop container's. S45's claim that fit carries over depends on it.
- **P0-18**: registering the task as a standard user (owner-gated).
- **P0-2 and P0-3 re-targeted** at the agent's **tsnet** node, whose IP and UDP port differ from host Tailscale's `<dell-tailnet-ip>`.
- **P0-14 dropped.**

**Slice plan**
- S42 retires the in-WSL novad.
- S44(b) uses the `host` transport and unloads the bundled model first, and says it walks only the code path of the Mac hub shape.
- S45 C6 prints the `docker run` line.
- S46 adds the resume hold and the key-expiry cause.
- An optional early move: after S41, a stated interim with the Dell's Ollama as a "Remote endpoint" through host Tailscale, with no hold or wake. This gets the owner an always-on hub before S42–S44.

**Interfaces**
- **Agent area:** the `inference compute` reader per OS (log paths: `~/.ollama/logs/server.log`, `%LOCALAPPDATA%\Ollama\server.log`, journald, `docker logs`); port-owner runtime detection; the `host` listener; the resume detector and hold; the task settings from finding 8; LaunchDaemon relay; `revoked` handling.
- **Transport area:** `key_expiry`; a bootstrap that verifies before it executes and doesn't touch the LAN on tailnet hubs; stable hub names; `hub.moving`; `addr` validation.

## Owner questions (reframed)

1. **A Windows hub without a user WSL distribution.** Docker's WSL2 backend is enough; only the bash tooling blocks it. Build the containerised-installer path, or keep "a Windows hub needs a WSL distro"?
2. **Signing.** It now decides whether the Mac relay, tsnet direct paths and LAN work from a LaunchAgent, not just whether warnings appear.
3. **Decision 2.** May an agent hold for 120 s or less after a network wake, before Nova's first request arrives? Without it, a Mac's roughly 30–60 s DarkWake may end before she can use it.

**Assumed, not verified:**
- loopback reach through `host.docker.internal`;
- whether iOS HTTP home-screen apps honour the manifest;
- whether tsnet builds with `CGO_ENABLED=0` on darwin;
- the Windows standard-user task registration;
- the macOS DarkWake behaviour of `caffeinate -i`.

### Critical Files for Implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/providers.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/admin.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/devices_api.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/apps/novad/internal/client/client.go
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/deploy/install.sh