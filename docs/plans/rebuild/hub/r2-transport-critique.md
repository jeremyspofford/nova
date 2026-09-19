# Adversarial review: Transport design (Tailscale-first, headscale and LAN seams)

## Verdict

The core of the design holds up. A transport only locates; identity comes from pairing. Every non-loopback agent door is pinned with TLS. The edge allowlist and the three exposure pins are sound. Two things are broken outright:

1. **The main capability cannot bootstrap.** A machine without the Tailscale app cannot join the tailnet, because the agent download needs a door the machine cannot reach.
2. **The key-expiry remedy cannot work.** The fix the design offers (`key_expiry_off`) is ruled out by Tailscale's own credential scoping, and the always-on hub drops off after 180 days by default.

About a dozen major defects follow: platform, security and house-rule problems. Most are cheap to fix.

---

## Ranked findings

### Critical

**C1. A machine without the Tailscale app cannot bootstrap. The walk hides this.**
- **Defect.** The card command downloads the agent from `https://<door>:8443`. The door is either the hub's tailnet IP or the LAN door, and the LAN door is off by default. A machine with no Tailscale app that is not on the hub's LAN can reach neither. `machine_add_code` then refuses with "use the public release channel once it exists". Decision 10(a) promises exactly this capability ("no Tailscale app needed on that machine"), and it depends on a channel that is not being built.
- **Evidence.** Design "Wire contracts → Card command". Walk (a)2 says "(the Dell has the Tailscale app)", so the only live walk goes around the gap.
- **Fix.** Make the release channel part of phase (a):
  - Publish reproducible builds (`-trimpath`, pinned toolchain; the agent has no cgo) as GitHub Release assets.
  - The hub builds the same commit and computes SHA-256 values. The card carries the hash and checks it before running: `shasum -a 256 -c` / `sha256sum -c` / `Get-FileHash`.
  - Order of operations: download from the release, then `install --transport tailnet` (tsnet joins by login link or key), then dial the edge over the overlay with the pin, then enroll.
  - The door download stays as an alternative for machines on the hub's LAN or tailnet.
  - Add a DoD walk on a machine with **no** Tailscale app (the Dell with the app signed out or uninstalled, or a fresh VM).

**C2. The key-expiry remedy does not work, and the hub is a 180-day time bomb.**
- **Defect 1.** `network_configure(key_expiry_off=hub|machine)` cannot succeed. OAuth `devices:core` write operations are limited to devices that carry the credential's tags. Login-link nodes are untagged and user-owned, so the credential cannot touch them. Tagged nodes already have key expiry disabled by default. The tool is therefore useless in every case, and walk (a)3 ("`key_expiry_off=hub` reads back") will fail.
- **Defect 2.** The hub joins by login link, so it is user-owned with the default 180-day expiry. When it expires, every thin client and every tailnet agent loses Nova.
- **Defect 3.** A login-joined agent whose only path to core is the tailnet gets its new AuthURL at expiry, but has no way to deliver it. The `net` frame rides the path that just died.
- **Evidence (verified).**
  - https://tailscale.com/docs/reference/trust-credentials: "Operations are limited to devices carrying those tags or tags owned by the credential's assigned tags."
  - https://tailscale.com/kb/1028/key-expiry: 180 days by default; key expiry disabled by default for tagged devices.
- **Fix.**
  - Delete `key_expiry_off`.
  - At login-link join, Nova states the exact admin-console step: "disable key expiry for `<name>` at login.tailscale.com/admin/machines; until then it drops off on `<date>`". Keep the `tailnet_key_expiring:<m>` check, which reads expiry from agent facts or the hub status file.
  - Let the hub join **tagged** when a credential exists. Core writes a one-use tagged key into a new core-owned volume `v4_tailnet_join/` (one writer). `start.sh` notices it, runs `tailscale up --auth-key=file:… --force-reauth`, and deletes the file. Whether the node keeps its IP and name across that re-auth is a new measurement (T14).
  - Agent side: on NeedsLogin, `nova-agent status` prints the AuthURL locally, and the agent logs it at warning level.

### Major

**M1. The status file freezes at "Running", and raw status leaks every peer.**
- **Defect 1.** `start.sh` blocks in `wait_for_containerboot` after serve (`deploy/tailscale/start.sh:170-178`). Nothing polls after Running. "Written on every poll" is therefore true only before Running, and core reads Running forever: after a key expiry, after a stopped sidecar, after an IP change. That breaks "never report success you did not verify".
- **Defect 2.** Raw `tailscale status --json` includes every device of every user in the tailnet, and `network_status` would put that into her facts.
- **Evidence.** `--peers` flag and "WARNING: format subject to change" (https://tailscale.com/kb/1080/cli).
- **Fix.**
  - A background writer loop in `start.sh` (for example every 15 s) using `tailscale status --json --peers=false`, plus `tailscale serve status --json`.
  - Core treats a file with `written_at` older than 3× the interval as `unknown (status file stale since …)` and never as Running.
  - The status parser is tested against fixtures captured from the pinned image.

**M2. The `host` transport has no bind rule and does not work on Linux as written.**
- **Defect.** The gateway dials `https://host.docker.internal:11435` with `host-gateway`.
  - On Docker Engine (Linux), `host-gateway` resolves to the default `docker0` address, and a host process bound to 127.0.0.1 cannot be reached from containers.
  - ufw's INPUT policy drops container-to-host traffic.
  - On Docker Desktop (macOS and Windows), 127.0.0.1 is reachable.
  - The design never says which address the listener binds. This is the only path for a Mac hub's Metal Ollama and for any Linux hub with native ROCm or Intel Ollama.
- **Evidence.** `host-gateway` behaviour and ufw (for example https://hostim.dev/blog/fixing-host-docker-internal-linux/); widely reported, assumed rather than read from Docker's own docs. The integration pins the project network gateway as `172.18.0.1` (`deploy/docker-compose.yml:329-334`), which is not `docker0`.
- **Fix.** Per-OS bind rule inside `transport/host.go`:
  - **Linux:** bind the project network's gateway IP (`NOVA_SUBNET` gateway, derived by `decide_subnet`). Set `extra_hosts: host.docker.internal:${NOVA_SUBNET_GATEWAY}`. Retry the bind until the bridge exists (boot race). State "ufw blocks 172.x→host" as a check.
  - **Docker Desktop:** bind 127.0.0.1.
  - Extend T11 to cover ufw enabled.

**M3. The transport-provenance rule cannot tell tailnet from LAN, or `host` from browsers.**
- **Defect.**
  - Core only ever sees `client.host` equal to the edge or to web.
  - Through the edge, tailnet traffic arrives from the sidecar's fixed IP. LAN traffic arrives from the LAN client on Linux, or from Docker Desktop's gateway on macOS and Windows.
  - Through web, a hub-host agent looks like every other request.
  - Legacy agents still connect to web's WebSocket carve-out from every source (`apps/web/nginx.conf.template:398-415`).
- **Fix.**
  - The edge sets `X-Nova-Edge-Peer: $remote_addr`, trusted only when `client.host == NOVA_EDGE_ADDR`. Core derives `tailnet` if the peer is the sidecar address, `lan` otherwise.
  - Through web, use `X-Real-IP`: the docker gateway means `host`, the sidecar means `tailnet-via-web` (legacy).
  - Record the derivation in the device row.

**M4. `tailnet_join` holds a turn for up to 10 minutes waiting for a human click, and misses two join states.**
- **Defect 1.** The tool blocks until the owner approves in Tailscale. That is a "waiting on you" shape (the `tests/test_no_approvals.py` philosophy) and it freezes chat.
- **Defect 2.** It ignores `NeedsMachineAuth`. Device approval is available on all plans; pre-approved keys skip it; the API can authorize only tagged devices (https://tailscale.com/kb/1099/device-approval).
- **Defect 3.** It ignores Tailnet Lock: nodes stay locked out until signed.
- **Defect 4.** The eval name `says-approval-is-pending…` uses approval vocabulary.
- **Fix.**
  - `tailnet_join` returns at once with `{state: login_pending|awaiting_admin_authorization|locked_out|running}` and no verb that could be read as a gate.
  - Completion is observed by `network_status` and a `machine_joined` notice driven by the `net` frame.
  - Rename the eval to `says-login-is-pending-not-joined`.
  - Map `NeedsMachineAuth` to: "CANNOT finish: your tailnet requires an admin to authorize `<name>` at …".
  - Map Tailnet Lock to: "CANNOT: tailnet lock — run `tailscale lock sign nodekey:…` on a signing node".

**M5. macOS LaunchDaemon (root) conflicts with one agent per machine and runs hands as root.**
- **Defect.** "The macOS network roles run as a LaunchDaemon." The exemption from Local Network privacy applies to **code running as root**. So the one agent (decision 9) would run shell, fs and apps as root, with no GUI session: it cannot open apps and its home is `/var/root`. Otherwise it has to split into two processes, which decision 9 does not describe.
- **Evidence (verified).** https://mjtsai.com/blog/2024/10/02/local-network-privacy-on-sequoia/: root is exempt; launchd agents *do* get the prompt; loopback is unaffected. Go ≥1.24 emits LC_UUID by default (https://go.dev/doc/go1.24), and the Go linker ad-hoc signs darwin/arm64, so the prompt identity works.
- **Fix.**
  - One LaunchAgent in the user session for all roles; accept a one-time Local Network prompt.
  - Record the prompt result as a fact. A denial degrades tsnet to DERP and blocks LAN listen and WoL sends: stated, not hidden.
  - LC_UUID comes from the build ID, so every agent update may re-prompt. List this as a risk; it is UNWALKED.
  - A Mac node with nobody logged in serves nothing. Native Ollama is a user app too.

**M6. The Windows + WSL column contradicts one agent per machine.**
- **Defect.** The matrix plans tsnet inside WSL (T2, "W, Dell WSL") and tells the owner to "use the native agent" for LAN. That means two agents and two pairings on one box, which decision 9 rules out. Nothing detects a second agent on one machine.
- **Fix.**
  - On any Windows machine the agent is the **native Windows build**. WSL hands are reached through `wsl.exe -d <distro> -- argv` (Area A).
  - The "Windows + WSL" column then only describes the hub stack under Docker Desktop.
  - Retire the Dell's WSL novad at migration.
  - Facts carry `machine_id`: Windows MachineGuid (read from WSL through interop), `/etc/machine-id`, or macOS IOPlatformUUID. Enroll refuses a second live agent with the same `machine_id` ("CANNOT: `<name>` already runs an agent on this machine").
  - Mention WSL mirrored mode (multicast and LAN access, with a Hyper-V firewall rule; https://learn.microsoft.com/windows/wsl/networking) only as a stated alternative, not built.

**M7. The LAN door is pinned to a DHCP address in `.env` and dies when that address moves.**
- **Defect.** `ports: ["${NOVA_LAN_BIND}:8443:8443"]`. At boot before Wi-Fi is up (the mini PC is `wlo1`), or after a lease change, Docker cannot bind the address and edge fails to start. That takes every LAN agent offline. mDNS relocation does not help, because the edge is not listening on the new address. Walk (c)4 only moves the *node's* lease.
- **Fix.**
  - LAN mode requires a DHCP reservation, stated by `decide_lan`.
  - A check compares the live default-route IP with `NOVA_LAN_BIND` and raises `lan_door_address_moved` with the one command to rerun.
  - Add walk (c)5: move the **hub's** lease.
  - Cut mDNS (see Y1).

**M8. The tailnet egress proxy is reachable by every container. Inherited from the baseline, but the stakes are now higher.**
- **Defect.** `TS_OUTBOUND_HTTP_PROXY_LISTEN` sits on the shared compose network, so searxng (which parses internet content), memory, ollama and web can all reach every tailnet device: the owner's SSH and SMB, and every agent's models listener. The baseline only tests that the gateway is *configured* with it (`integration.md:628`). With the tailnet now the machine fabric, this is a real pivot path.
- **Fix.** A compose network `tailnet_egress` with `internal: true`, attached only to `gateway` and `tailscale`. The proxy listens on the sidecar's address on that network. `exposure_test.sh` asserts that no other service joins it.

**M9. Pinned self-signed certificates meet Python's date checks.**
- **Defect.** Go skips dates (`InsecureSkipVerify` plus `VerifyConnection`). Python's `ssl` with `cadata` cannot turn off time checks. So:
  - An agent certificate minted on a clock that runs ahead (P0-6 skew after resume) is "not yet valid".
  - Any `NotAfter` eventually expires every models link silently.
  - The SAN `nova-agent-<device_id>` cannot exist, because the certificate travels *in* the enroll body before the device ID is issued.
- **Fix.**
  - `NotBefore = now − 48h`, `NotAfter = 9999-12-31T23:59:59Z`.
  - SAN is a random `nova-agent-<16 hex>`.
  - Gateway test: a certificate with `NotBefore` 10 min in the future must still connect, or the test fails. That proves the backdate.

**M10. The pin test is vacuous.**
- **Defect.** `http_client` uses the mounted fake transport whenever one matches (`services/gateway/app/adapters/base.py:139-144`), so no TLS happens in tests. "A wrong-key certificate is refused before the fake server receives a request" passes trivially.
- **Fix.** The pin tests run a real TLS server on a loopback socket (`ssl` plus `asyncio.start_server`) using the Go-generated fixture, and no mounted transport for that origin. Assert the server's accept count is 0 when the key is wrong.

**M11. Key custody on Windows is undefined, and the Windows CI job would be red on day one.**
- **Defect.** `config.Save`'s 0600/0700 mean nothing on Windows.
  - `apps/novad/internal/config/config_test.go:46-64` asserts those modes and fails on a Windows runner.
  - `caps/system.go:31-32` (`syscall.Statfs`) does not compile for Windows.
  - A service with state under `C:\ProgramData` inherits read access for Users, exposing the ed25519 seed, the tsnet node key and the models bearer. This is assumed from the well-known ProgramData ACL, not verified here.
- **Fix.**
  - Build tags now.
  - A `custody_windows.go` that sets an explicit DACL (SYSTEM plus the owning SID only, no inheritance) on the config and tsnet directories.
  - A Windows-runner test that reads the DACL back and fails on any `BUILTIN\Users` ACE.

**M12. The phase-a2 grant is inconsistent and incomplete.**
- **Defect.**
  - `tag:nova-hub → tag:nova-node tcp:11435` never matches a login-joined, untagged hub (see C2).
  - The grant set leaves out agents → hub `:8443` and members → hub `:443`, so a restrictive policy would cut agents off.
  - `tag:nova-node` must exist in `tagOwners` before the owner can create the OAuth client (T9). Nova cannot write it without `policy_file`, and that scope needs `devices:core:read` plus `devices:posture_attributes` (verified, trust-credentials page).
- **Fix.**
  - Settings shows the exact `tagOwners` snippet and the scope list, including those prerequisites, before the credential form.
  - The a2 grant set is three rules. The hub is addressed by a `hosts` alias (tailnet IP from the status file) when untagged.
  - Keep a2 deferred, but specify all three rules.

**M13. The login flow assumes a browser on the hub.**
- **Defect.** `install.sh` prints "approve in Nova → Settings → Network". Web is loopback-only, so on a headless hub nobody can open it.
- **Defect.** The agent `install` verb hands off to a service (systemd, LaunchAgent, Scheduled Task or Windows Service). The service's login URL goes to a log nobody sees, and a state directory created by the installing user may be unreadable by the service account.
- **Fix.**
  - `install.sh` and `nova-agent install` both run the join **in the foreground**. They print the AuthURL plus a terminal QR, wait for Running (or Ctrl-C with a stated "not joined"), and only then register the service over the same state directory, with its ownership set.

### Minor

- **m1. `test_live_facts` goes red.** Putting `tailnet_join` and `network_configure` in `NOT_AUTO_RUN` breaks `reads == classified` (`services/core/tests/test_live_facts.py:42-47`). Only `network_status` gets classified; the other two are excluded automatically by `reads_only=False`.
- **m2. Card commands fail as written.**
  - POSIX: there is no `chmod +x`, and `linux-amd64` is hardcoded. Use `uname -s/-m` mapping (x86_64→amd64, aarch64/arm64→arm64).
  - Windows: `&&` exists only in PowerShell 7+, and Windows PowerShell 5.1 rejects it (verified: https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_pipeline_chain_operators). Emit two lines, or `; if ($?) {…}`, and pick the arch from `$env:PROCESSOR_ARCHITECTURE`.
- **m3. Measurement meaning.** The baseline's `probes.path CHECK (local, tailnet)` (`integration.md:292`) cannot record `lan`, `headscale` or `host`. Extend the CHECK in 010 and do not map LAN rows to `tailnet`.
- **m4. One fact, two shapes.** The baseline's auth-frame `facts.ifaces` (`integration.md:122`) and this design's `facts.net.lan.ifaces` describe the same thing. Keep one (`facts.net.lan.ifaces`) and give Wake a single reader.
- **m5. "host if it is the hub machine" is unknowable when the code is minted.** The card should carry an ordered locator list (host, overlay, LAN door, each with the pin). The agent uses the first that passes the pin, and provenance (M3) records which one.
- **m6. A-0 claims.**
  - "A later absorbs the same key file and table" does not work, because Proposal A's store belongs to the gateway (provider keys live in `services/gateway/migrations/003_providers.sql:22`; `docs/plans/rebuild/ROADMAP.md:210-231`).
  - The move archive carries the ciphertext and the key together, so it is plaintext-equivalent.
  - Say this plainly. Better: leave the key file out of the archive and require re-entry, stated in a check.
  - `/state` needs a `chown` in the image (the pattern at `services/core/Dockerfile`, `/data`).
- **m7. Enroll lockout.** The rate limit is keyed on `request.client.host` (`services/core/app/devices_api.py:69-74`). Behind the edge that is one shared bucket, so five bad codes from any LAN host lock out enrollment for 15 min. Key it on `X-Nova-Edge-Peer` (M3).
- **m8. Hardcoded ports.** 8443 collides with common home-lab services, for example UniFi's controller. Derive `NOVA_EDGE_PORT` at install by checking whether the port is free, carry it in the locator, and do the same for the agent's 11435.
- **m9. Household thin clients.** "How does my wife use you" also needs a tailnet invite (Personal plan allows up to 6 users, verified at https://tailscale.com/pricing) or a node share. `nova_address` should state that step.
- **m10. The headscale seam is not a seam yet.**
  - `tailscale_api.py` should sit behind a `control_plane` interface (`mint_key`, `revoke_key`, `list_devices`).
  - `network_credentials` is a singleton with `kind='tailscale_oauth'`; key it by `kind` instead.
  - The `credential_claim` URL pattern is SaaS-only; derive it from `control_url` (headscale uses `/register/…`).
  - `access_origins.kind` has no `headscale`.
  - Over plain http the web app has no secure context, so no service worker or `crypto.subtle`; state it.
- **m11. Secrets pasted into chat.** Add a mechanical input-side redaction: a `tskey-(auth|client|api)-\S+` pattern in a user message is replaced before it is persisted or sent to the model, with the note "enter it in Settings → Network". Today this is only a risk bullet.
- **m12. Hands must be unreachable from the models listener.** Add a Go test that the models listener's mux holds only the allowlisted routes, never reaches `caps.Dispatch`, and refuses everything while no bearer is set.
- **m13. LAN interface choice.** Bind the models listener to the local address of the route to the hub door IP, and require it to be RFC 1918 or ULA. Otherwise `vEthernet (WSL)`, `docker0` or ProtonVPN's adapter can win. Add ProtonVPN "Allow LAN connections" on and off, and Wi-Fi client isolation, to T3.
- **m14. One justification for the edge is overstated.** Tagged nodes are gated only when `NOVA_PUBLIC_GATE_TOKEN` is set (`nginx.conf.template:135-141`), and the WebSocket is carved out from every source. The edge is justified by LAN and headscale, not by tagged gating.
- **m15. The core key pin authenticates commands, not the channel.** The challenge only compares a string (`apps/novad/internal/client/client.go:178-184`). The edge TLS pin is what gives channel confidentiality. Say so, so that no future transport skips the pin.

### YAGNI (cut or defer without losing an owner decision)

- **Y1. mDNS.** It only covers hub relocation, it does not work with M7, and it has 5 M/U cells. Instead, carry every hub locator in the `ready` frame (unknown-keys additive) so agents learn them while connected.
- **Y2. `key_expiry_off`.** Cut; it does nothing (C2).
- **Y3. `access_origins.kind='public'` and nginx `X-Nova-Gate-Passed`.** No owner decision needs a public-tunnel origin.
- **Y4. Six cross-builds plus a `hujson-patch` binary in core's image.** The release pipeline (C1) builds them; the hub only pins hashes. `hujson-patch` lands with a2.

---

## What was verified

**Verified against third-party sources**
- `tailscale serve --tcp` accepts non-localhost targets (`ipn/serve.go` `ExpandProxyTargetValue` on main). The edge mapping is plausible; T13 stays for coexistence.
- curl `--pinnedpubkey` supports Schannel since 7.58.1 and ignores `-k` (https://curl.se/libcurl/c/CURLOPT_PINNEDPUBLICKEY.html). T6 can be downgraded.
- tsnet v1.102.4 exposes `AdvertiseTags`, `ClientSecret` and `ControlURL` (pkg.go.dev).
- #16840 applies only when a Windows syspolicy value exists.
- The Ollama Windows installer needs no admin and runs per user; a service needs the standalone zip plus NSSM (https://docs.ollama.com/windows). Windows nodes serve nothing before sign-in.

**Verified in the repo**
- Migration numbering (core 034, gateway 008): 038 and 010 are free.
- WSL novad reaches Docker Desktop at `http://localhost:3000` (`~/.config/novad/config.json`), so `host` works from WSL today.

---

## What survives unchanged

- Identity is separate from transport: ed25519 pairing, the core key pin, the per-link bearer, and a pinned self-signed certificate on every non-loopback agent door.
- Two doors (browser `web` and agent `edge`) with the edge allowlist, `edge_guard`, `exposure_test.sh` and `edge_test.sh`. Web is never on the LAN, and the LAN door is off by default.
- tsnet in the agent; the node sidecar and Python node-agent are retired.
- The hub sidecar stays, with the outbound proxy (isolated per M8), a status file (single writer: `start.sh`), and login without `TS_AUTHKEY`.
- The OAuth mint body: single-use, pre-authorized, tagged, 3600 s. Keys never stored; key id only in her text; the card and the envelope are the only carriers; unused keys are revoked.
- The Go `transport` interface (overlay, lan, host) and `engines.client` choosing between proxy and pin per row.
- Migrations core `038_network.sql` and gateway `010_engine_transport.sql` (content amended below).
- Guards `credential_claim`, the generalised `address_claim` and the `state_claim` extensions; tools `network_status` and `machine_add_code(transport)`; the changes to `nova_address`.
- Headscale deferred to a seam. Windows hubs without WSL and all of macOS are stated as UNWALKED.

---

## Corrected design deltas

1. **Release channel in phase (a) (C1).** A CI job builds `nova-agent` for {linux, darwin, windows}×{amd64, arm64} with `-trimpath` and the go.mod toolchain pinned, and publishes to GitHub Releases with `SHA256SUMS`. Core computes the same hashes from its build and puts them in the card. The card runs the download, then a hash check, then `install`. The edge `/agent/*` route stays as a fallback. New DoD walk: a machine without the Tailscale app.
2. **Key expiry (C2).** Delete `key_expiry_off`. On a login-link join, Nova's result text includes the admin-console step and the expiry date. `tailnet_key_expiring:<m>` stays. Add `v4_tailnet_join` (core writes it, `start.sh` reads and deletes it) for a tagged hub re-auth. New measurement T14: does re-auth keep the node's IP and name?
3. **`start.sh`.**
   - The NeedsLogin branch waits with no bound.
   - A background `write_status` loop runs every 15 s after Running, using `--peers=false` plus serve status, written atomically.
   - Core sets `stale_after = 45 s`.
   - `start_test.sh` covers the loop, staleness, and the key file.
4. **Compose.**
   - `tailnet_egress` internal network (gateway plus tailscale only).
   - `extra_hosts: host.docker.internal:${NOVA_SUBNET_GATEWAY}` on Linux.
   - `NOVA_EDGE_PORT` derived at install.
   - Edge `depends_on: core: service_healthy`, so the certificate exists before edge starts.
   - `exposure_test.sh` asserts only gateway and tailscale sit on `tailnet_egress`.
5. **Edge.** `proxy_set_header X-Nova-Edge-Peer $remote_addr`. Core derives `last_transport` from it (sidecar IP means tailnet, otherwise lan) and from web's `X-Real-IP` (docker gateway means host). The enroll rate limit is keyed the same way.
6. **Agent (Go).**
   - `transport/host.go` bind rule: the bridge gateway IP on Linux, 127.0.0.1 on Docker Desktop.
   - `transport/lan.go` binds the source address of the route to the hub door, RFC 1918/ULA only, and polls for address changes every 30 s.
   - `pin`: `NotBefore −48h`, `NotAfter 9999-12-31`, random SAN.
   - `custody_windows.go` sets an explicit DACL.
   - Build tags for `caps/system.go`; the 0600 test becomes a POSIX-only build.
   - `install` joins in the foreground (URL plus QR), then registers the service.
   - On macOS, one LaunchAgent (no LaunchDaemon).
   - Windows is always the native build; WSL is reached through `wsl.exe`.
   - `machine_id` added to facts.
7. **Card command.** POSIX: `uname` arch mapping, `chmod +x`, `sha256sum -c` or `shasum -a 256 -c`. Windows: two statements (no `&&`), `$env:PROCESSOR_ARCHITECTURE`, `Get-FileHash`. The card carries ordered locators; `transport=auto` is decided on the agent and recorded by provenance.
8. **Tools.**
   - `tailnet_join` returns at once with `state ∈ {login_pending, awaiting_admin_authorization, locked_out, running}`.
   - A `machine_joined` notice on the `net` frame.
   - `live_facts` only classifies `network_status`, as AUTO_RUN.
   - Eval renamed to `says-login-is-pending-not-joined`.
   - Input-side `tskey-*` redaction in chat intake.
   - `nova_address` adds the tailnet invite or node-share step.
9. **Migrations.**
   - 010 extends `probes.path` to `(local, tailnet, headscale, lan, host)`.
   - 038 keys `network_credentials` by `kind` (no singleton), adds `headscale` to `access_origins.kind`, and drops `public`.
   - One facts shape: `facts.net.lan.ifaces`; the baseline's `facts.ifaces` is removed from 037's contract.
10. **A-0 (open question 1 stays).** If kept: a core-only store, stated as separate from the gateway's future Proposal A. The move archive leaves out the key file, and the credential must be re-entered, checked by `network_credential_unreadable`.
11. **Cut** mDNS, `key_expiry_off`, the `public` origin and `X-Nova-Gate-Passed`, and the cross-builds in core's Dockerfile. `hujson-patch` moves with a2. The a2 grant set becomes three rules, with a `hosts` alias for an untagged hub. The Settings form shows the `tagOwners` snippet and the prerequisite scopes.
12. **Tests.**
    - Gateway pin tests use a real TLS socket and assert zero accepts on the wrong key.
    - A certificate valid only from 10 min in the future still connects.
    - A Go models-mux isolation test.
    - `edge_test.sh` checks the peer header.
    - A Windows DACL read-back test.
    - `install_test.sh` gains the `decide_lan` reservation and address-moved cases.
13. **Measurements.**
    - T3 adds ProtonVPN "Allow LAN" and Wi-Fi client isolation.
    - T11 adds ufw enabled.
    - New T14: tagged re-auth keeps the node's IP and name.
    - New T15: a Windows Service versus a logon Scheduled Task for tsnet plus Ollama before sign-in, as a stated fact.
    - T6 is downgraded; its Schannel support is verified.
14. **Walks.** Add (a)0, a machine without the Tailscale app, through the release channel. Add (c)5, the hub's lease moves, and edge refusing is stated. Remove the `key_expiry_off` step from (a)3.

### Critical Files for Implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/deploy/tailscale/start.sh
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/deploy/docker-compose.yml
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/apps/novad/internal/client/client.go
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/gateway/app/adapters/base.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/devices_api.py