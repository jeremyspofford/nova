# Adversarial review: the cross-platform Nova agent (novad v2)

## Verdict

The main architecture holds up: one Go binary, roles treated as availability, holds taken in-process, own TLS on the models listener, and a Transport seam. Two findings are critical:
1. **Tailnet join credentials.** The design hands out tailnet-joining credentials with a lifetime and exposure it never states.
2. **Owner decision 10a.** The design silently rewrites 10a, "approval via a login link Nova shows". In the design the link prints only on the new machine's terminal.

The majors fall into three groups:
- **Owner decisions broken or unserved.** A second agent in WSL breaks decision 9. The Dell's models are orphaned after the move.
- **OS realities not handled.** These were never checked: macOS Local Network Privacy, the Windows Defender Firewall, and a persistent console window from the Run key.
- **Parts that would need redesign later.** The Headscale and LAN transports would need rework. The compute identity only works for NVIDIA.
- **Plus:** proxy body attacks, and eval contracts that cannot pass.

## Ranked findings

### Critical

**F1. Tailnet credential custody is unspecified. A leaked card or command line adds an attacker to the owner's tailnet.**
- **Defect.**
  - The card and command line carry `--ts-authkey …` (wire contract 7).
  - Auth keys last **1 to 90 days**. "Revoking a key does not deauthorize nodes using the key." A one-off key is revoked automatically only *after use* (verified: https://tailscale.com/docs/features/access-control/auth-keys).
  - A 10-minute code can therefore leave a key that works for at least 24 h. It sits in shell history, in PSReadLine's history file, in the DOM, and in `argv`. `argv` is visible in `ps` or the Windows process command line, and in expvar's `cmdline` if a debug mux is ever served.
  - I assume tailscale.com pulls in `expvar` transitively. That is unverified; check it with `go list -deps`.
  - Nothing says the installed service definition (the Run key value or the unit's `ExecStart`) leaves the key out.
  - Revoking the device in Nova leaves the tsnet node on the tailnet.
  - Most home tailnets use the default allow-all policy, so any `tag:nova-agent` node, whether an attacker's or a revoked machine, reaches every device the owner has.
- **Fix.**
  - Mint the key with `expirySeconds=86400` (the minimum), `reusable=false`, `preauthorized=true`, `tags=[tag:nova-agent]`.
  - Store the key id on the `pairing_codes` row. Call `DELETE` on the key when the code expires unused, and state that it was deleted.
  - `novad install` reads the key from stdin or an environment variable that it clears. It never takes the key in argv, and never writes it to a service definition.
  - Revoke order: the signed `agent.leave` (tsnet `Logout`, then wipe state) goes out *before* `devices.revoke`. With the `devices:core` scope, also delete the node through the API. Without that scope, `machine_status` states "<name> is still on your tailnet; remove it at …".
  - Tests: `test_secrets_not_logged` gains the auth key, and a Go test asserts that the rendered unit, plist and Run key contain no `tskey`.

**F2. Decision 10a says "a login link Nova shows". The design has the link print on the new machine instead (walk 2), because the agent cannot reach core before it joins.**
- **Evidence.** The hub is reachable only on the tailnet (the `TS_AUTHKEY` flow, `deploy/docker-compose.yml:274-279`). `tsnet` puts the AuthURL only in `UserLogf` or `Status()` on the new machine (verified: https://pkg.go.dev/tailscale.com/tsnet v1.102.4).
  - A machine that is not on the hub's LAN has no download path at all. The design mentions a "copy path" only in passing.
- **Fix: a pre-join channel.**
  1. The hash-verified binary posts `{code, auth_url, os, arch, hostname}` to the hub agent's LAN listener, over TLS pinned by the card's `--pin`.
  2. The code is the credential: one post per code, rate-limited.
  3. The hub agent forwards it to core over its WSS as a `join_pending` frame. That is agent to core, the allowed direction.
  4. Core pushes an SSE `join` frame into the same card: "open this to add <name> to your tailnet". The link never enters her context.
  5. The terminal also prints the link and a QR code.
- **Off the LAN.** The card states "this machine cannot reach your hub. Copy the file (the hash on this card verifies it), or sign it into Tailscale first." That is stated, never silent.
- **Device approval.** When device approval is on, `BackendState=NeedsMachineAuth` becomes a named transport state.

### Major

**F3. The second WSL agent breaks decision 9 ("ONE NOVA AGENT PER MACHINE").**
- **Evidence.** Per-OS table row "Windows + WSL"; walk 4; `machine_add_code(os=wsl)`; A-P0-8; the `machine_uid` merge; the "WSL rule".
- **Fix: one Windows agent per machine.**
  - Linux hands reach WSL through `shell.exec ["wsl.exe","-d",<distro>,"--",…]`, and the facts list the distros.
  - The Windows agent also fronts a GPU Ollama running inside WSL, because WSL's localhost forwarding exposes it on Windows `127.0.0.1` (measure this).
  - Delete the `wsl` OS option, A-P0-8, `add_device` merging, the WSL relay rule and the WSLg note.
  - Add a migration step to the Dell walk: pair the Windows agent, then revoke the existing WSL novad (pid 441, per `integration.md:6`).

**F4. After the move, nothing runs the Dell's Docker Ollama, and its model volume has no adopt path. Nodes that have no Ollama are not provisioned at all.**
- **Evidence.**
  - The move runs `docker compose --profile '*' down` on the Dell (`integration.md:473`).
  - The design deletes `deploy/node/*` and `--adopt-ollama-volume nova_v4_ollama` (`integration.md:388,518`).
  - Yet walk 2 says "first on Docker Desktop's Ollama". There is only "discovery (native, container or unknown)".
- **Fix.**
  - `models.enable {source: native|container}`.
  - **`container`**: the agent runs an embedded one-service compose file, project `nova-node`, with a pinned `ollama/ollama` image, `127.0.0.1:11434`, the GPU reservation when Docker reports NVIDIA, and `--adopt-volume <name>`. It refuses when a running container mounts that volume (baseline step 5).
  - **`native`**: readiness reason "Ollama is not installed", with per-OS steps. The Windows installer needs no admin (verified: https://docs.ollama.com/windows).
  - P0-4 still picks the Dell's source.
  - Report `ollama.bind`. If the user's Ollama listens on `0.0.0.0`, state that it is exposed on the LAN whatever Nova's bearer does.

**F5. macOS Local Network Privacy breaks the default LaunchAgent mode for the relay role and for transport (c).**
- **Evidence.** LaunchAgents are subject to Local Network Privacy. Root and launchd daemons are exempt (TN3179 via search results, https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).
  - Apple DTS reports "no route to host" from launch agents running ad-hoc-signed CLI tools, and says to sign "Without that, the system has a hard time tracking its identity" (https://developer.apple.com/forums/thread/778457).
  - So a relay's broadcast from a LaunchAgent fails with EHOSTUNREACH, and any grant is lost at every ad-hoc-signed update (S31).
- **Fix.**
  - On macOS, `roles.available.relay` is true only in LaunchDaemon mode, or once a signed build exists (owner question 1).
  - The relay sends classify EHOSTUNREACH as `cannot: macOS local network permission`, never as "sent".
  - The matrix cell becomes "LaunchDaemon (C) / LaunchAgent: blocked by Local Network Privacy unless signed".

**F6. The Windows Defender Firewall is never considered, yet the design claims "no admin" on Windows.**
- **Evidence.** A program without an allow rule gets a prompt that needs administrator rights. Non-admins cannot answer it without Group Policy (https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules and search results).
  - This affects the LAN models listener, the hub dist window on a Windows hub, and possibly tsnet's direct UDP paths.
- **Fix.**
  - `novad install --lan` asks for elevation once and adds a program rule scoped to the private profile and the local subnet. The card states "needs admin once".
  - Measure tsnet under the Run key without admin: direct or relayed through DERP (Tailscale's relay servers). This is new A-P0-9.

**F7. The Run key opens a persistent console window, and the self-update revert only works under systemd.**
- **Evidence.**
  - A console-subsystem Go exe started from the Run key gets a visible conhost window. Closing it kills the whole process tree, `supervise` included (search results on conhost and `CREATE_NO_WINDOW`).
  - Doing-things S31 reverts with `StartLimitBurst` + `OnFailure=novad-revert.service` (branch `claude/nova-autonomous-capabilities-c25b5c`, `doing-things.md:351-356`).
- **Fix.**
  - Build Windows with `-H windowsgui`. CLI verbs call `AttachConsole(ATTACH_PARENT_PROCESS)`.
  - Make `novad supervise` the parent on every OS (systemd, launchd and the Run key all start it). It owns restart backoff and the `.prev` revert, so S31 has one revert mechanism.
  - Rename `agent.update` to S31's `daemon.update`.

**F8. The Headscale transport would need a redesign: the core link has no TLS there, and the refusal rule blocks `models.enable`.**
- **Evidence.** Headscale has no HTTPS certificates ([6] in the design), so core over Headscale would be `ws://100.64.x`. The rule "refused … when the WSS is `ws://` to a non-loopback host" then always refuses. Own TLS is designed only for the models listener.
- **Fix.**
  - The agent always dials core with `Transport.DialContext` plus TLS verified either by a public CA (Tailscale serve) or by the card's pin.
  - The rule becomes "cannot: the core link is neither verified TLS nor loopback".
  - Interface for the transport area: the hub serves pinned-TLS ingress for (b) and (c).

**F9. The LAN transport (c) has no discovery and its addressing is brittle. The owner asked for discovery explicitly.**
- **Evidence.** `base_url = https://<ip>:11435` breaks on the first DHCP change or Wi-Fi flap. A pinned cert with an IP subject alternative name fails hostname checks.
- **Fix.**
  - The engine's identity is the SPKI pin, not the IP.
  - The agent reports its current LAN IPs in `facts`. When they change, core `PUT`s the new `base_url` to `/admin/engines/{n}`.
  - The gateway verifies the pinned cert with `check_hostname=False`.
  - The agent finds the hub by the card's endpoint plus mDNS `_nova-hub._tcp`, verified by the pin.
  - The LAN listener rebinds when the interface changes.
  - A simpler alternative worth weighing, since it touches the star rule: an agent-initiated reverse connection for (c). It needs no inbound port, firewall rule or node discovery.

**F10. `agent.configure` can strand an agent.**
- **Defect.** It is persisted "after verification" and switches the transport. If the new transport fails, the agent can never reach core again, and no remote fix exists.
- **Fix: a two-phase switch.**
  1. The agent brings up the new transport alongside the old one.
  2. It completes a full challenge and auth over the new one.
  3. Only then does it commit; after T seconds without that it rolls back.
  4. It returns `{applied_hash, verified_over}`, and the result is read back.

**F11. The compute identity and readiness only work for NVIDIA.**
- **Evidence.** Ollama turns Vulkan on by default on Windows and Linux, and Intel iGPUs work through Vulkan on Linux (verified: https://docs.ollama.com/gpu).
  - The N150 walk expects `cpu:Intel(R) N150…`, but native Ollama may put layers on the iGPU.
  - The readiness clause `(¬gpu_expected ∨ vendor tool readable)` fails on AMD under Windows and on Apple, where no vendor tool exists.
  - Ollama logs an `inference compute` line with `id, library, pci_id, type, total` (search results; https://github.com/ollama/ollama/issues/18482).
- **Fix.**
  - Take compute from Ollama's own device report: `gpu:<library>:<id>`, or `…:<pci_id>@<machine_uid>` when the id is not stable. Multiple GPUs become a sorted `+`-joined set.
  - Vendor tools only add a card name, total and used.
  - Readiness becomes `ollama.ok ∧ (model∅ ∨ installed)`. Whether the GPU was used is decided only by `size_vram` from `/load`.
  - Walk 1 expects what Ollama reports.
  - New A-P0-10 covers where the log lives (Docker `logs`, `%LOCALAPPDATA%\Ollama\server.log`, `~/.ollama/logs`, journald).

**F12. The proxy allowlists paths only, not bodies.**
- **Evidence.** `/api/pull` is allowlisted and accepts any registry host plus `insecure:true`. That is the CVE-2024-37032 class (path traversal through a rogue registry, then RCE; fixed in 0.1.34; https://www.wiz.io/blog/probllama-ollama-vulnerability-cve-2024-37032). The listener runs in the same process that executes signed `shell.exec`.
- **Fix.**
  - Parse the pull `model` and refuse any host component and `insecure:true`.
  - Refuse any Ollama older than a pinned floor.
  - Use an explicit `ServeMux`, never `DefaultServeMux`. Match on exact method and cleaned path, and reject encoded or doubled slashes.
  - Tests: `/api//create`, `/API/create`, `%2e%2e`, a pull from `evil.example/x`.

**F13. Both eval contracts can never pass.**
- **Evidence.**
  - `reply_absent "(fully )?tested on (a )?mac"` is a case-insensitive `re.search` (`services/core/app/evals/predicates.py:79-81`), so it fails the honest reply "built but not tested on a Mac".
  - `tool_called machine_status|machine_configure` matches the name exactly (`predicates.py:44-50`), so it never matches.
- **Fix.**
  - First case: `reply_matches "(not|never|hasn'?t been)\s+(yet\s+)?(walked|tested)"` plus `reply_absent "\b(is|was|has been|fully)\s+tested on (a )?mac"`.
  - Second case: `tool_called machine_status`.

**F14. House rules: capabilities without a tool and eval, and a silent cross-mode fallback.**
- **Evidence.** `models.enable` has no eval. `agent.configure` has no tool at all ("core pushes"). If minting a key with a configured credential fails, the card falls back to the login link without saying so.
- **Fix.**
  - Eval `enables-models-on-a-machine` (fixture `eval_node`): `tool_succeeded machine_configure`, `guard_absent narration`.
  - `machine_configure(transport=…)` is the only route to `agent.configure`, it reads the result back, and it gets an eval.
  - A mint failure appears on the card and in the tool result: "could not mint a tagged key: <reason>; this card uses a login link".

**F15. Editing the ACL through the `policy_file` scope overwrites the whole tailnet policy, and T4 is wrong.**
- **Evidence.**
  - The API replaces the entire policy file; `If-Match` with the ETag is optional (Terraform `tailscale_acl` docs and search results).
  - T4 names `tag:nova-hub`, but the hub sidecar joins with an owner-minted, untagged key (`deploy/docker-compose.yml:274-279`).
  - T4 also omits agent → hub:443.
  - The credential is stored in plaintext and travels in the move archive's `pg_dump`.
- **Fix.**
  - Read, merge a marked managed block, `POST /acl/validate`, then `POST` with `If-Match`, then read back.
  - Never touch rules outside the managed block.
  - The hub gets tagged by re-authenticating during S42.
  - Grants: `tag:nova-hub → tag:nova-agent:11435` and `tag:nova-agent → tag:nova-hub:443`.
  - Storage becomes owner question 3.

### Minor

- **F16. Wrong "V" marks.**
  - `shell.exec` `Setpgid` (V) does not exist: `apps/novad/internal/caps/shell.go:37-42` sets no `SysProcAttr`. It is S30's unmerged work.
  - "The pin is authenticated by the device key over this channel" is false. The auth signature covers the raw nonce only (`apps/novad/internal/client/client.go:190`, `services/core/app/devices_ws.py:311`). Facts and result frames are unsigned, so their integrity rests on the WSS TLS or WireGuard. State that, or sign `sha256(nonce‖canonical(facts))`.
  - The `test_no_approvals` assert is at line 289, not 292.
- **F17. Two truths for the same facts.**
  - The agent computes `roles` and core's `device_facts.py` derives them again. Core alone should derive.
  - `agent.build` sits in facts while S30 adds `devices.daemon_build`. Use S30's column.
  - The pin is stored as PEM in one place and as SPKI sha256 in another. Store SPKI sha256 only, from the `models.enable` result.
  - Cut `engines.agent_device`, a cross-database uuid that goes stale on re-pair.
- **F18. `PLATFORM_STATUS` is a hardcoded verification claim.** It is also coarse: the Run key is walked, the Service is not, and arm64 is not. Derive it from a walk record keyed `(os, arch, mode, role)`, pinned by a test.
- **F19. Two guard and UI problems.**
  - `install_command_claim` fires on an explanation such as "what does `novad install` do?". Fire only on a 64-hex hash, an `/agent/dist/` URL or a code-shaped `--code` without a card this turn.
  - The OS tab comes from `navigator.userAgentData`, which is Chromium-only and reports the *viewer's* OS, not the target's. Use `os_hint` first.
- **F20. The `devices_platform` CHECK can fail on real data.** Enroll accepts free text (`services/core/app/devices_api.py:60`; `devices.py:221`). The migration must first `UPDATE … SET platform='unknown' WHERE platform NOT IN (…)`, and enroll should return 400 for anything else.
- **F21. Installer-to-service handoff.** The foreground installer's tsnet and the service's tsnet share one node key. The repo already documented the flap two nodes cause when they share state (`deploy/docker-compose.yml:342-348`). Stop the foreground node before starting the service.
- **F22. VPNs.** Bind every WoL send to the LAN interface address on every OS, not just Linux. On Windows, 255.255.255.255 can leave through the VPN adapter. Add a fact `default_route_via_tunnel`. ProtonVPN's "allow LAN" setting goes in A-P0-11.
- **F23. Linux hold and WoL facts.**
  - Linux facts lack wired Wake-on (`ethtool` or NetworkManager `wake-on-lan`). Reading it probably needs `CAP_NET_ADMIN`: measure it.
  - The `systemd-inhibit` child needs `Pdeathsig`, or use the D-Bus `Inhibit` file descriptor.
  - An XDG-autostart helper runs in the session scope, so it could take the `sleep` block without sudo while a user is signed in (the policy allows `allow_active=yes`). Add it to A-P0-4.
- **F24. Rebuild cost on the hub.** Building six targets with tsnet inside the core image makes every core rebuild on the N150 slow, and her self-deploy loop rebuilds core often. Use a separate dist stage or volume keyed by a hash of `apps/novad`.
- **F25. Auth-frame size.** A 4 KiB auth frame can overflow on Windows machines with many adapters (Hyper-V, WSL, VPN). Move `ifaces` to the 16 KiB `facts` frame.
- **F26. No slice mapping.** Keep the baseline order: prove the agent's models role with the mini PC as a CPU node of the Dell hub *before* the move (`integration.md:255`). The design's walks assume the move is already done.
- **F27. CI and cost.**
  - `macos-latest` runs macOS 26 on arm64, so darwin/amd64 is cross-compile only. State that.
  - The repo is public (`gh repo view`: PUBLIC). Standard hosted runners are free for public repos (https://docs.github.com/en/billing/reference/actions-runner-pricing), so owner question 4 is moot.
- **F28. Lid close beats every hold on laptops.** State it when facts show a battery.

## What survives unchanged

These parts stand as designed:
- **Agent shape.**
  - One pure-Go binary with `CGO_ENABLED=0`, built for 6 targets with per-OS build tags. One pairing per machine.
  - Roles are availability derived from facts. The owner's switch is `engines.serving`, and `devices` has no `capabilities` column.
- **Models listener.** The node contract (`/node/*`, `X-Nova-Hold-S` clamped to 60–1800, `X-Nova-Node-Compute`); a bearer stored only as a sha256; a self-signed cert pinned at pairing; the listener bound only on the chosen transport.
- **Holds.** In-process holds driven by the lease: `PowerSetRequest(SystemRequired)` with a `SetThreadExecutionState` fallback on a locked OS thread, `caffeinate -i -s -w`, and `systemd-inhibit`.
  - The logind analysis is correct: `inhibit-block-sleep` is `allow_any=auth_admin_keep`, and both `inhibit-block-idle` and `set-self-linger` are `yes` (verified: systemd `org.freedesktop.login1.policy`).
- **Installer.** A Go `novad install` on every OS, with the sha256 carried on the card.
- **Tailnet join.** tsnet as transport (a), and Headscale through `ControlURL`.
  - The hub mints keys, and the OAuth secret never reaches agents. `tsnet` has a `ClientSecret` field; do not use it.
  - `key_expiry` is in facts with a 14-day finding. Tagged devices have expiry off (verified: https://tailscale.com/kb/1028/key-expiry).
- **Wire.**
  - The additive auth `facts` and the `facts` frame.
  - The enroll body stays at five keys, with `platform=runtime.GOOS`.
  - `_check_fs_path` becomes platform-aware (`services/core/app/tools/devices.py:108-116`).
- **Baseline pieces kept.** The wake, engines and data pieces the design keeps from the baseline (gateway 009; core `wake_attempts`; `net.wake`; relay derivation; the code card kept out of her context).
- **Numbering.** Core's next free migration is 035 and the gateway's is 009 (verified at HEAD `0531b496`).
- **Measurements.** A-P0-1 through A-P0-7.
- **Tests.** The fake-driven Go test plan, golden files for unit, plist and Run-key renderers, and the native-runner smoke tests.
- **The UNWALKED list.** It gains "macOS relay under Local Network Privacy" and "Vulkan compute".

## Corrected design deltas (apply as written)

1. **Card and credentials (F1, F2).**
   - Wire 7: `commands:{linux,macos,windows}`, with no `wsl`.
   - The auth key is never in argv. `novad install` reads it from stdin; a `NOVA_TS_AUTHKEY` environment variable is read and then cleared.
   - `pairing_codes ADD ts_key_id text NULL`. A core job deletes the key when the code expires unused.
   - New signed capability `agent.leave {}` (tsnet Logout, wipe state), always sent before `devices.revoke`.
   - New pre-join path: `POST https://<hub-lan>:7420/agent/join-pending {code, auth_url, os, arch, hostname}`, pinned TLS, the code as the credential, one post per code.
     - The hub agent forwards it as a WSS frame `join_pending`.
     - Core emits an SSE `join {code_id, auth_url}` and adds `join` to `KNOWN_FRAME_KEYS`.
2. **One agent per machine (F3).**
   - Delete `os=wsl`, A-P0-8, the `machine_uid` grouping, `add_device` merging and the WSL rule.
   - `machines(name PK, device_id uuid UNIQUE NULL FK devices ON DELETE SET NULL, mac_override, relay_override, …)`. `machine_uid` is a fact used only for duplicate-install detection.
3. **Ollama source (F4).**
   - `models.enable {engine, source: native|container, adopt_volume?}` returns `{base_urls[], token, spki_sha256, ollama{kind,version,bind}}`.
   - Embed `deploy/node/ollama.compose.yml`.
4. **macOS (F5).** Relay availability = `mode ∈ {launch-daemon}` or `signed`. EHOSTUNREACH maps to `cannot: macOS local network permission`.
5. **Windows (F6, F7).**
   - `novad install --lan` creates the firewall rule once with elevation.
   - Build with `-H windowsgui` and `AttachConsole`.
   - `supervise` is the parent on every OS and owns the `.prev` revert. Capability names follow S30 and S31 (`daemon.info`, `daemon.update`).
6. **Transports (F8–F10).**
   - The core dial always goes through verified TLS (public CA or pin); the refusal text is as in F8.
   - (c): engine identity = the SPKI pin. Core calls `PUT /admin/engines/{n} {base_url}` when facts change. mDNS `_nova-hub._tcp` is verified by the pin.
   - `agent.configure` is two-phase, with rollback, and returns `{applied_hash, verified_over}`.
7. **Compute and readiness (F11).**
   - Compute comes from Ollama's `inference compute` report, with the grammar in F11.
   - `/node/ready` = `ollama.ok ∧ (model∅ ∨ installed)`.
   - Remove `gpu_expected`.
8. **Proxy (F12).** Body validation for `/api/pull`; a minimum Ollama version; an explicit mux; strict path matching.
9. **Tools and evals (F13, F14).**
   - Fix both contracts as in F13.
   - Add `enables-models-on-a-machine`.
   - Add `machine_configure(transport=…)` with its eval.
   - Mint failures are stated. The suite grows by 3, not 1.
10. **ACL (F15).** A managed-block merge with validate, `If-Match` and read-back. The hub is re-tagged in S42. The grants are as listed in F15.
11. **Data (F17, F20).**
    - Drop `engines.agent_device` and `providers.tls_pin` PEM. Add `providers.tls_spki_sha256 text`.
    - Normalize `platform` before the CHECK, and have enroll return 400.
    - Build identity lives only in S30's column.
12. **Sequencing (F26).**
    - S41 becomes "agent v2 + models role", walked with the mini PC as a node of the Dell hub.
    - The Windows-native walks come after S42b.
    - S30's dispatch table lands first.

## New P0 measurements

| ID | Measure | Branch |
|---|---|---|
| A-P0-9 | Dell, non-admin Run-key agent: firewall prompt for (i) tsnet (direct vs DERP), (ii) LAN :11435, (iii) :7420; network profile Public or Private | Prompt or block → the `--lan` elevation step is required and stated |
| A-P0-10 | Is the `inference compute` line present in Docker Desktop logs, native Windows `server.log`, and on the mini PC (native and container)? Does Vulkan put the N150's layers on the GPU (`size_vram>0`)? | Absent → compute is `unknown` (omitted, never guessed) |
| A-P0-11 | ProtonVPN up on the Dell: does the relay's bound broadcast leave the Wi-Fi adapter (tcpdump on the mini PC), with "allow LAN" on and off? | Blocked → the relay role is unavailable, with the reason |
| A-P0-12 | `go list -deps` on the agent; confirm the listener serves nothing outside `/node/*` and the allowlist | Any leak → build failure |
| A-P0-4+ | Add: an XDG-autostart session-scope helper takes `--what=sleep` without sudo | Works → the Linux hold is full while signed in |

A-P0-8 is dropped.

## Interfaces required from the other areas (changes)

- **Transport area**
  - Key minting with the F1 parameters, plus deletion.
  - The pre-join relay (F2).
  - Pinned-TLS core ingress for (b) and (c) (F8).
  - The managed-block ACL merge and re-tagging the hub (F15).
  - Stating mint failures.
- **Engines, wake and hub area**
  - Accept `PUT base_url` from core (F9).
  - The readiness and compute changes (F11).
  - The node Ollama compose file and volume adopt (F4).
  - A dist build that is not part of the core image (F24).
  - The hub installer's path on a Windows hub with no bash (E5 is unowned).

## Owner-level questions (corrected)

1. **Signing.** Should we buy Authenticode and Apple Developer ID certificates? Smart App Control blocks unsigned apps and offers no per-app bypass (verified: https://support.microsoft.com/en-us/topic/what-is-smart-app-control-285ea03d-fa88-4d56-882e-6698afdb7003). On macOS, the relay role and persistent Local Network Privacy grants depend on signing.
2. **Default start mode on Windows and macOS.** Per-user, or system with admin? On macOS the relay role needs the LaunchDaemon unless the binary is signed.
3. **New: the policy-writing credential and Proposal A.** A Tailscale credential with the `policy_file` scope can rewrite the whole tailnet policy. Should it be accepted before Proposal A (secrets at rest) lands? Until then it is stored in plaintext and travels in move archives.

Remove the CI-cost question (the repo is public). Remove "install command shape" too: the copy-paste command with its hash is the only form that meets "never report success you did not verify".

**Verified:** logind polkit defaults, tsnet v1.102.4 fields and AuthURL behaviour, OAuth `auth_keys` requiring tags, the auth-key expiry range and revoke semantics, tagged-device key expiry, the Ollama Windows install and NSSM notes, Ollama's Vulkan/Intel support, Smart App Control, Go 1.27 needing macOS 13+, the macOS 26 arm64 runners, the free public-repo runners, and the CVE. Several of these came from search-result summaries rather than full pages: TN3179 (its page did not render), the policy API's whole-file overwrite, the "inference compute" log fields, the Windows Firewall prompt behaviour, and the Tailscale Personal plan's 50 tagged resources.

**Assumed:** expvar is imported transitively; the conhost window behaviour; `ethtool` Wake-on needs `CAP_NET_ADMIN`; WSL localhost forwarding of a GPU Ollama.

### Critical Files for Implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/apps/novad/internal/client/client.go
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/apps/novad/internal/caps/caps.go
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/devices_ws.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/evals/predicates.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/deploy/docker-compose.yml