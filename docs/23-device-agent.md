# 23 — Device Agent (`novad`)

`novad` is the Nova device agent. It runs on the Hub, on Compute Nodes, and on desktop
clients. It is responsible for registration, capability reporting, local execution, device
management, power/boot, and (optionally) firmware/BIOS management. Mobile devices do not run
`novad`; their app performs the subset the OS allows.

## 1. Architecture: supervisor + modules (hybrid)

```
                 ┌────────────────────────────────┐
                 │            novad               │  small, auditable supervisor
                 │  install · update · register   │  (root/admin, minimal surface)
                 │  capabilities · policy broker  │
                 └───────┬────────────────────────┘
        ┌───────────┬────┴──────┬───────────┬─────────────┬────────────┐
        ▼           ▼           ▼           ▼             ▼            ▼
   management   compute     browser     screen       storage       capture     (signed modules,
   (power/boot/  (inference) (automation) (input)     (files, MCP)  (ambient,    sandboxed, optional)
    services/BIOS)                                                  no network)
```

- The **supervisor** is the only component that needs elevated privileges continuously.
- **Modules** are separately signed binaries/workers, spawned on demand, each sandboxed and
  independently updatable. A device installs only the modules it needs.
- The supervisor enforces policy per module (filesystem scopes, network, resource limits).

Rationale: least privilege + isolation + independent updates, without the packaging sprawl of
entirely separate products.

*As built in M6 (ADR-093).* `novad` 0.6.0 is a Rust binary (`services/novad`; dependencies
`serde`, `serde_json`, `ed25519-dalek` and `sha2`; HTTP and diff are its own). `novad run` hardens
itself, starts the modules of its manifest (`<data>/modules.json`) and serves the management
channel. Each module is a separate process (`novad module <name>`, or the program an update
installed, whose SHA-256 is checked at every start) that speaks one JSON object per line on stdin
(`{id, op, args}`) and stdout (`{id, ok, result}` or `{id, ok: false, status, error}`); each
request runs on its own thread, at most 16 in flight. The default manifest has `management` and
`storage` on every device and `compute` on compute-role devices; only `storage` (files, grants,
staged writes, commands, processes, local MCP) and `management` (power, Wake-on-LAN, systemd
services) do real work. `compute`, `browser`, `screen` and `capture` are placeholders that answer
only `ping` and `status` (M7.5 made `browser` real, below). Modules run as `novad`'s user with
resource limits only: there is no separate unprivileged module user and no per-module filesystem or
network sandbox yet.

*As built in M7 (ADR-095).* The default manifest also has `local-runtime` on client-role devices
(§4.3), so a client runs three module processes (`management`, `storage`, `local-runtime`) and a
device that is both client and compute runs four (one more each since M7.5, below). `novad`
gained a TLS client: `rustls` 0.23.45 (Apache-2.0 OR ISC OR MIT) with the `ring` 0.17.14 provider
(Apache-2.0 AND ISC; it builds with the C compiler of the Rust image, where aws-lc would need
cmake), whose certificate checks are `rustls-webpki`; the tests make their certificates with
`rcgen` 0.14.10 (MIT OR Apache-2.0), a dev dependency only, so no key material is committed.

*As built in M7.5 (ADR-096; `services/novad/src/{hardening,supervisor,procs,browser,firmware,boot}.rs`).*
`novad` is 0.7.0.

- **Long-lived children are spawned on one thread.** A module started by a management request
  (`modules/*`, `services/*`, an update's restart, a policy change), a Code process (`proc.spawn`)
  and a browser session are spawned on `novad`'s spawner thread (`spawn_kept` in `hardening.rs`,
  which also retries a program that is still busy from being written, ETXTBSY), so they outlive the
  request thread that asked for them. Every hardened child gets the kernel's parent-death signal,
  and Linux sends it when the *thread* that forked the child ends, not the process. Before M7.5
  they were spawned on the request's own thread: a module started that way was killed as soon as
  its request returned, counted as a crash and restarted on backoff, and a Code process died with
  the request that started it.
- **One new direct dependency.** `ring` 0.17.14 (Apache-2.0 AND ISC), for the one SHA-1 the
  WebSocket handshake of the browser's DevTools relay needs (`src/ws.rs`). It is the crate rustls
  already builds, so the lock file gains no new crate.
- **Which modules are real.** `browser` does real work now (the local browser fallback and the
  extension bridge host, §4.4) and is in the default manifest of client-role devices, so a client
  runs four module processes (`management`, `storage`, `local-runtime`, `browser`) and a device that
  is also compute runs five. BIOS settings and low-level boot are not separate processes: the
  supervisor serves their routes itself (§5.2, §6) and asks the `management` module for the
  restarts, and the capability document lists `firmware` when a BIOS backend works (§3).
  Out-of-band management is the Hub's own and never goes through `novad` (§7). `screen` (moved to
  M9 with the capture work) and `compute` (the compute node is `services/compute`) are still
  placeholders that answer only `ping` and `status`, and so is `capture`.
- The management channel also lists the owner's managed services with their state
  (`POST /agent/v1/services`, FR-145); a service whose state cannot be read is listed as `unknown`
  with the reason.

## 2. Install & bootstrap

- The Hub serves signed, per-arch builds at `/api/v1/agent/dist/novad-<os>-<arch>`.
- Installation uses the Add Device code (`docs/22` §4.3), verifies the **signature** and
  **checksum**, pins/validates the Hub certificate, then registers.
- `novad install --hub <url> --code <PAIR-CODE> [--role client|compute|wake] [--modules …]`.
- The installer sets up a service (systemd / launchd / Windows service), a data directory, and
  an unprivileged runtime user for modules.
- Uninstall (`novad uninstall --purge`) revokes the device certificate and removes data.

*As built in M6 (ADR-093).* Enrollment is `novad enroll --hub http://<hub> --token nvd_…
[--role …] [--endpoint http://<device>:7420]`, with a token the owner creates on the Hub
(`POST /api/v1/devices/add/start` or `/devices/novad/enroll`, one use, 15 min); the Hub URL must be
`http://` until certificates arrive (M6.5). Enrollment generates a fresh Ed25519 key (so a revoked
device can be added again) and a management token, and stores the device credential. `novad
install`, the download route, pairing codes, Hub certificate pinning and signed binaries are not
built (`install` parses its arguments and only `--dry-run` does anything). `novad service-unit
--platform linux|macos|windows` prints a systemd unit (`Restart=always`, `NoNewPrivileges`,
`ProtectSystem=full`, `PrivateTmp`, `LimitCORE=0`, `UMask=0077`), a launchd plist or `sc.exe`
commands; nothing installs them yet. Other commands: `novad version`, `capabilities [--sign]`,
`run`, `access list|approve|deny`, `wol status|plan|enable [--apply]`. The data folder (0700) holds
`device.json`, `key.seed` (0600), the owner's `config.json` (services, power flags, local MCP
servers, local overrides), `hub-config.json`, `modules.json`, `storage/` and `modules/`. Key
generation reads `/dev/urandom`, so enrollment does not work on Windows yet.

*As built in M6.5 (ADR-094).* `novad install` joins with an Add Device code (FR-132, FR-133;
`docs/22` §4.3 has the one-line command the Hub shows, which always passes `--pairing`):

```bash
novad install --hub http://<hub> --code - --pin <hub fingerprint> [--pairing <id>] \
  [--role client|compute|wake-helper]… [--name N] [--listen ADDR] [--endpoint URL] \
  [--no-service] [--dry-run] [--data-dir D]
```

- **The code stays off the command line.** `--code -` reads it from standard input (the Hub's
  command pipes it in with the shell's `printf` builtin, which survives `sudo`); without `--code` it
  comes from `NOVA_ADD_CODE` (the PowerShell command sets it and removes it afterwards);
  `--code ABCD-EFGH` still works by hand. Codes are normalised like the Hub's (O reads as 0, I and L
  as 1).
- **Checks before anything is written.** The Hub's identity key from `GET /api/v1/hello`
  (`hubPublicKey`) must hash to `--pin`; `novad-manifest.sig` must verify with that key over the
  domain tag `nova-novad-manifest-v1\n` followed by the exact bytes of `novad-manifest.json` (so no
  other statement the Hub identity signs can pass as a manifest); and the SHA-256 of `novad`'s own
  binary must be the manifest's entry for its OS and architecture. The binary is read once and those
  same bytes are installed. A data folder already enrolled is refused. `--dry-run` stops after these
  checks.
- **Add Device v2** as `kind: novad` with a fresh Ed25519 key held in memory: `complete` with a
  commitment to a secret nonce, then `reveal`, signed at the Hub's clock (from its `Date` header).
  The Hub's confirmation must equal `novad`'s own computation and `hubSignature` must verify with
  the pinned key over the request, the pairing, this device's key and the digits; otherwise it stops
  with "This is not your Hub" before showing anything. It prints
  `Confirm this code on the Hub: 123 456`, then polls `status` with signed requests (every 1 s,
  slowing to 5 s; each newer than the last).
- **After approval** it writes the key, registers with the granted `nvd_` token and the same key
  (`/agent/v1/register`; the token is bound to that key), keeps a granted device certificate as
  `device-cert.pem`, writes the checked bytes to `/usr/local/bin/novad`, hashes the installed copy
  again and installs and starts the service: `systemctl daemon-reload` and `enable --now` on Linux,
  `launchctl load -w` on macOS, `sc.exe create`, `failure` and `start` on Windows. Installing the
  service needs root (checked first); `--no-service` skips it.

**Known limitations (M6.5).** The install ran over plain HTTP only: `novad` had no TLS client and
refused an `https://` Hub (M7 below). The Windows command is generated but untested and key
generation reads `/dev/urandom`, so install fails there; the macOS service setup is untested.
`novad uninstall` is still not built (M7.5 built it, §11).

*As built in M7 (ADR-095; `services/novad/src/{tls,install,cli,agent}.rs`).*

```bash
novad install --hub http(s)://<hub> --code - --pin <hub fingerprint> [--pairing <id>] \
  [--role …]… [--name N] [--listen ADDR] [--endpoint http://…] [--user NAME]… \
  [--no-service] [--dry-run] [--data-dir D]
novad enroll --hub http(s)://<hub> --token nvd_… [--pin <hub fingerprint>] [--user NAME]… …
```

- **Over HTTPS with the pin.** `install` and `enroll` take an `https://` Hub; `enroll` then needs
  `--pin` (for `install` it is always required). The first connection checks the Hub's signed
  identity statement on the connection itself before anything is sent, and later connections trust
  what it vouched for (`docs/22` §5), so the code and the tokens no longer cross the network in the
  clear. The pin and what verified statements vouched for are kept in `hub-trust.json` (0600);
  `novad enroll` deletes it, the key and `device-cert.pem` and starts again. The bootstrap command
  downloads from an `https://` Hub without checking its certificate (`curl -fsSLk`, `wget
  --no-check-certificate`), because the SHA-256 in the command carries the download's integrity and
  `novad` then verifies the Hub by its pin (`docs/22` §4.3).
- **Over HTTP with a pin**, `novad` reads the statement over plain HTTP, checks its signature and
  nonce against the pin, and keeps the Hub local CA it lists (`GET /api/v1/trust/ca.pem` must hash
  to the listed SHA-256). When a heartbeat later cannot reach the Hub, it tries `https://` on the
  same address (at most once a minute) and switches for good once the pinned identity vouches for
  the certificate there; it never moves back to plain HTTP. Without a pin there is no TLS: `novad`
  has no platform trust store, and an `https://` URL without one is refused.
- **The device certificate** (`device-cert.pem`, issued in `local-ca` mode) is presented on every
  trusted connection, from registration on, signed with the device key; a connection not yet
  verified never carries it (it names the device), so `novad` reconnects with it after the check.
  A certificate that does not match the device key is not used. A Hub that refuses it answers 403
  `certificate_<why>`, which `novad` logs; it keeps its credentials (`docs/22` §5).
- **`--user NAME`** (repeatable) names the users who get a local runtime socket of their own (§4.3).
  Without it, the user who ran `sudo` (`SUDO_USER`) is used, never `root`; a name other than
  letters, digits, `_`, `.` and `-` (not starting with `-` or `.`, at most 64) is refused. The list
  is stored as `config.json` `localRuntime.users`; an enrollment that names nobody (no `--user`, not
  run through `sudo` by a user) keeps the existing list.
- `--endpoint`, the address the Hub calls for the management channel, stays `http://` (since M7.5
  `novad` registers it as `https://` once it holds a certificate, below).

*As built in M7.5 (ADR-096; `services/novad/src/{install,agent,mgmt_tls,browser,bridge,uninstall,cli}.rs`).*

```bash
novad bridge enable | disable      # as the user, never root: the extension bridge (§4.4)
novad bridge-host                  # what the browser starts for the extension
novad uninstall [--purge] [--data-dir D]   # §11
```

- **The endpoint becomes `https://`.** `--endpoint` is still given as `http://`. Once the device
  holds `device-cert.pem`, `install` and `enroll` register it, and every heartbeat reports it, as
  `https://` on the same address, because the management channel is then mutual TLS (§9). The Hub
  never moves a device that registered `https://` back to plain HTTP (a heartbeat offering
  `http://` is 403 `policy_denied` `{reason: endpoint_downgrade}`).
- **Browser users.** `install` and `enroll`, run as root for a client-role device on Linux, create
  the dedicated users the local browser runs as, `nova-browser1` and `nova-browser2` (`useradd
  --system --user-group --no-create-home`, no login shell; one per session, §4.4). An existing user
  of that name that is not a dedicated unprivileged one stops the step. When the users cannot be
  made, the device still enrolls and says so, and a root `novad` refuses to launch a browser until
  they exist. On macOS `novad` makes no users: the owner creates two and names them in
  `browser.runAs`. There is still no unprivileged user for the other modules.
- **The extension bridge** is registered only by `novad bridge enable`, run by the user it is for
  (refused as root), and removed by `novad bridge disable` (§4.4); the installer never writes a
  browser's configuration.
- **`novad uninstall [--purge]`** removes the service, the binary, the browser users and the bridge
  files, and wipes the device's identity (§11). It does not contact the Hub, so it revokes nothing
  there: remove or decommission the device on the Hub as well (the Hub's decommission revokes the
  device and its certificate, §11).

## 3. Capability declaration

On first connect and on change, `novad` reports a capability document. Default: declare
everything detectable. Advanced: the Hub or user can override. Includes the additions agreed
for DA7 (timezone/locale, energy/quiet hours, routing weight, egress limits).

```jsonc
{
  "schemaVersion": 1,
  "deviceId": "…",
  "roles": ["client", "compute"],            // roles this device takes
  "modules": ["management", "compute", "storage"], // modules installed (§4)
  "hardware": {
    "arch": "x86_64", "cores": 8, "ramBytes": 17179869184,
    "disks": [{ "mount": "/", "freeBytes": 500000000000 }],
    "gpus": [{ "vendor": "nvidia", "name": "RTX 4070", "vramBytes": 12884901888 }],
    "nic": { "wol": true, "macs": ["aa:bb:cc:dd:ee:ff"] },
    "firmware": { "type": "uefi", "vendor": "dell", "oob": { "amt": false, "ipmi": false, "redfish": false } }
  },
  "os": { "family": "linux", "version": "…", "init": "systemd", "packageManager": "apt",
          "sandbox": { "bubblewrap": true, "podman": true } },
  "services": {
    "computeBackends": ["llama.cpp", "vllm"],
    "listeningPorts": [8000],
    "modelsPresent": [{ "id": "qwen2.5-coder:14b", "format": "gguf", "sizeBytes": 9000000000 }]
  },
  "models": {
    "storagePaths": ["/var/lib/nova/models", "/mnt/models"],
    "cacheQuotaBytes": 200000000000
  },
  "computePolicy": {
    "gpuSharing": "shared", "vramReserveBytes": 1073741824,
    "maxConcurrentJobs": 2, "maxJobDurationSec": 3600
  },
  "peripherals": { "screens": 2, "camera": true, "mic": true, "speakers": true, "browser": true },
  "access": { "fsScopes": ["/home/user/projects"], "admin": true, "network": "lan+mesh" },
  "power": { "ac": true, "alwaysOn": true, "wakeable": true, "policy": "stay-awake",
             "thermalLimitC": 85 },
  "data": { "retentionDays": 30, "telemetryAllowed": false, "updateChannel": "stable" },
  "locale": { "timezone": "America/Los_Angeles", "locale": "en-US" },
  "scheduling": { "quietHours": ["22:00-07:00"], "energyPriceTier": "offpeak-cheap",
                  "routingWeight": 10 },
  "limits": { "maxEgressMbps": 500 }
}
```

The Hub validates this against `contracts/schemas/device-capability.json` and stores it in the
capability registry used for routing.

*As built in M6 (ADR-093).* `novad` detects `schemaVersion`, its own random `deviceId`, hostname,
roles, installed modules, arch, cores, RAM, OS family and version, `init: systemd`,
`sandbox.bubblewrap`, the time zone, the NICs' Wake-on-LAN state and MACs, `power.wakeable` and
`power.ac`, the update channel, `telemetryAllowed: false` and the granted folders; compute-role
devices also get default `models`, `computePolicy` and `scheduling` blocks. Disks, GPUs, firmware,
the package manager, services, models and peripherals are not detected. The document is signed
with the device's key over canonical JSON (sorted keys, no whitespace), as compute nodes sign
theirs, and the Hub verifies it with the key it pinned. Precedence: detected facts, role defaults,
the owner's local overrides, then the Hub's (`PATCH /api/v1/devices/:id`), which win; only the
Hub's are limited to the Advanced fields. The device's roles come from its document, and a
`novad` device is never a compute node. Minimum `novad` versions per capability (FR-148): 0.6.0
for files, staged writes, exec, MCP, power, services and updates; 0.7.0 for computer use and the
browser; 0.8.0 for capture; `devices.minNovadVersions` can raise them. Module versions are not
checked.

*As built in M7.5 (ADR-096; `services/novad/src/{agent,firmware,power}.rs`).* `modules` lists the
installed modules, so `browser` on client-role devices (§4.4), plus `firmware` whenever a BIOS
backend works on the machine (Dell, Lenovo or HP with its kernel driver loaded, a UEFI machine of a
vendor outside the matrix with `efibootmgr`, or the owner's fake; §6), whether or not the Hub
allows it.
The Hub's `allowedModules` (FR-150) may name `firmware`; a list without it makes every firmware
route answer 403 `module_not_allowed`. `hardware.firmware` is still not detected: the platform
facts and the settings come from `firmware/read` (§6). Power-on-after-power-loss is not in the
document: the power status (in heartbeats and `POST /agent/v1/power`) reports `afterPowerLoss` as
`on`, `off` or `last`, read from the BIOS by the firmware-attributes backend, and `unknown` where
none reads it (the boot-order-only `efibootmgr` backend included). `novad` 0.7.0 meets the 0.7.0
minimum for the browser; computer use runs in the `screen` module, which is still a placeholder
(§1).

## 4. Modules

| Module | Purpose | Privilege | Default |
| --- | --- | --- | --- |
| **management** | Power state, boot configuration, services, updates, (opt) BIOS | High | On for Hub/desktop |
| **compute** | Run inference/embeddings/media backends; manage models | Medium | On for Compute Nodes |
| **browser** | Headless browser automation for agents; the local browser fallback (FR-209); the native-messaging host for the extension bridge, which talks only to this `novad` (FR-096) | Low | On for clients |
| **screen** | Observe and control the desktop (computer use): per-app control tiers and grants, the kill key, the control indicator and edge highlight (FR-207); attach-window capture (FR-214) | Medium | Optional |
| **storage** | Device file operations for Hub sessions (§4.1); local MCP pass-through; model storage; snapshots | Medium | Optional |
| **capture** | Ambient capture helper with no network access (§4.2, FR-228) | Medium | Off |

Modules are sandboxed; the supervisor applies per-module policy (filesystem, network, CPU/RAM,
wall clock).

### 4.1 Device file operations (FR-210)

Hub sessions (Work runs, Code sessions, agents with a connected computer) reach a device's
files only through `novad`; there is no other path:

- **List and read** within the folders the device has granted to that session or agent.
- **Folder-access request**: to reach a new folder, the session asks; the request is approved
  on the device or on the Hub, and the grant is recorded and revocable.
- **Staged writes**: a write is first **staged** (content stored in a `novad` staging area
  with the target path, the SHA-256 of the current file and of the new content), the Hub shows
  the diff and runs the policy check, and only then is it **committed** (atomic replace). If the
  target changed since staging (hash mismatch), the commit fails as a conflict and nothing is
  written. Abandoned stages are discarded after 24 h. Protected paths (FR-190) can never be
  staged.
- **Local MCP pass-through**: `novad` can expose the device's local stdio MCP servers to Hub
  sessions under the device's grants. The servers run sandboxed under `novad`; every tool call
  goes through the Hub's policy engine and audit; their output is untrusted. *Since M8* (ADR-097)
  `POST /agent/v1/mcp/request` also passes five read-only methods (`resources/list`,
  `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`; anything else is
  refused) under the same `mcp` grant, so device servers offer their resources and prompts too
  (`contracts/hub-api.md` §3; the Hub audits reads and prompt fetches as `device.mcp.request`).

*As built in M6 (ADR-093).* Grants are per grantee (`user`, `agent`, `session`, `run`, `thread`)
in `<data>/storage/grants.json` (0600, locked), with a copy on the Hub (`device_grant`). Paths are
canonicalized; credential locations and `novad`'s data folder are never reachable; `.git`,
`.nova`, `.agents`, shell startup files and PowerShell profiles stay read-only inside write
grants; the Hub checks staged writes again, treating those as read-only anywhere in the path. A
write is staged under `<data>/storage/staged/` (0600, at most 10 MiB) with both hashes and a
unified diff (at most 256 KiB), committed by an atomic replace only while the base hash still
matches (else `conflict`, nothing written), and discarded after 24 h on both sides. A write
outside the grants files a folder request for the nearest existing folder; the Hub shows it as
an approval card (tier `confirm_at_action`, 24 h) and the device owner can decide it with `novad
access approve|deny`; the next heartbeat closes the card. Local MCP servers are declared by the
device owner in `config.json`; a grantee needs an `mcp` grant per server; each listing or call
starts the server under bubblewrap with network (unless the owner turned the sandbox off),
initializes it, makes the request and stops it within 30 s, and its output is untrusted. These
routes do not go through the Hub's policy engine: the device enforces its grants. Commands
(`exec`) and Code environment processes (`proc`) run only under bubblewrap, with no network, the
grantee's folders bound by grant and `cwd` inside one; processes are kept by the storage module
(the newest 1 MiB of output, exited ones for 10 minutes, 32 per grantee), so a Hub disconnect
loses nothing. Commands and Code processes get the Hub sandbox's protected locations (docs/12
§7.2): in each granted folder and in every folder from it down to the working folder, credential
locations (case-insensitive, `credentials*` prefixes) are hidden with an empty tmpfs or
`/dev/null`, `novad`'s data folder is hidden wherever a grant holds it, and inside write grants
`.git` (followed through a `.git` file to its Git and common directories), `.nova`, `.agents` and
shell startup files are bound read-only, parents before children. Links are resolved and their
targets protected when inside a grant; a grant of `/` is not mounted; locations that do not exist
when the command starts, or that sit in a subfolder off the path to the working folder, are not
covered. `novad`'s file operations refuse credential locations at any depth inside a grant. macOS
and Windows have no sandbox, so commands there are refused.

*Agent tools (FR-081).* An agent with a connected computer works on its files with
`device.files.list`, `device.files.read` (1 MiB by default, at most 8 MiB),
`device.files.stage_write`, `device.files.commit` and `device.files.discard`. They act only under
the agent's own grants (grantee `agent`) and appear only in the agent's private threads while its
connection includes `files` (reading) or `staged_writes` (writing); proactive research only reads.
Staging writes nothing: the result gives the staged id and the diff, and the write appears under
Staged writes on the device page. A commit is a write the policy gate asks the owner about under
the default policy, and a changed target is a `conflict`. A path outside the grants files a
folder-access request (its card also shows in the agent's conversation) and nothing is written.
File names, contents and diffs are untrusted content, and every call is audited (kind `device`)
with its thread, turn and call.

### 4.2 Ambient capture helper (FR-228)

- A separate capture helper process, launched and supervised by `novad`, reads the
  accessibility tree (and OCR when needed) for the focused window. It has **no network
  access** (enforced by the OS sandbox), runs as the logged-in user, and talks only to `novad`
  over a local socket.
- It applies exclusions and redaction before handing text and metadata to `novad`, which
  signs, queues and sends records to the Hub. Pixels, when enabled, are encrypted to a
  Hub-held key before upload; the local copy is deleted only after a read-back check of size
  and SHA-256 at the target.
- `novad` restarts the helper on crash with backoff, pauses it with the global pause and the
  resource governor (FR-156), and records any gap.

### 4.3 Local runtime (FR-128)

*As built in M7 (ADR-095; `services/novad/src/{local_runtime,user_socket}.rs`).*
On client-role devices the `local-runtime` module proxies an OpenAI-compatible model server on the
device (`config.json` `localRuntime.upstream`, `http://` only, default
`http://127.0.0.1:11434/v1`) to local clients, so the desktop app can answer with local models while
the Hub is unreachable (`docs/21` §9).

- **Where it listens.** `<data>/local-runtime/runtime.sock`, mode 0600 in a 0700 folder: the file
  mode is the authentication. When the owner sets `localRuntime.listen` to a loopback `HOST:PORT`
  (any other address is refused), also there: a request on it needs the bearer token in
  `<data>/local-runtime/token` (0600, `nvlr_…`, made on first use, else 401 `token_required`), must
  name this loopback address as its Host (`host_not_allowed`, against DNS rebinding) and carry no
  `Origin` unless `localRuntime.allowedOrigins` lists it (`origin_not_allowed`). Loopback alone is
  never authorization (FR-192).
- **Per-user sockets.** `novad` runs as root, so its own socket is out of reach of the desktop app
  in a user's session. For each user in `localRuntime.users` (`--user`, §2) the module also binds a
  socket in that user's runtime folder: `/run/user/<uid>/nova/runtime.sock` on Linux (the desktop
  app looks in `$XDG_RUNTIME_DIR/nova/`), `/Users/<name>/Library/Application
  Support/Nova/run/runtime.sock` on macOS. The folder is 0700 and the socket 0600, both owned by the
  user, with the same admission as the root socket. Users are looked up with `id`, so directory
  accounts resolve too. The module checks every 30 s: it binds once the user's folder exists
  (login), stops serving once the socket is gone or replaced (logout) and binds again at the next
  login. Nothing in the user's folder is followed: the user's folder must be a real directory owned
  by that uid, `novad`'s folder in it a real directory owned by the user or root, and the socket
  path empty or an old socket; a link or any other file there is refused (`unsafe_path`), and
  ownership changes use `lchown`. The module's `status` lists each user's socket or why there is
  none.
- **Only with the Hub's grant.** Every request answers 403 `policy_denied` `scope_missing` unless the
  last heartbeat answer granted `local-runtime`. The heartbeat answer carries the device's `scopes`
  (`docs/22` §4.2); `novad` keeps them in `scopes.json`, so the grant holds while the Hub is down,
  and before any answer there is no grant.
- **Only the model routes.** `GET /v1/models`, `POST /v1/chat/completions`, `/v1/completions` and
  `/v1/embeddings` (anything else is 404). Only `content-type` and `accept` are passed on, and the
  answer comes back byte for byte as the server sends it, so a streamed answer stays a stream.
  Limits: 16 MiB per request, 256 MiB per answer, 32 connections at once, 300 s of silence from the
  model server; a server that does not answer is 502 `node_unavailable`.
- **Capability document.** The models the server lists appear as
  `services.computeBackends: ["local-runtime"]` and `services.modelsPresent`. The module itself is
  listed in `modules` (`DOCUMENT_MODULES` in `src/capabilities.rs`), as
  `contracts/schemas/device-capability.json` allows.
- **Not built.** No peer-credential check on the sockets (the file mode is the authentication). A
  `novad` that does not run as root can make a socket only for its own user (for anyone else the
  `lchown` fails, and `status` says so). Windows has no per-user named pipe. Binding for another
  real user as root, and the macOS path on a Mac, have not been tried: the tests bind for the test's
  own user.

### 4.4 Local browser fallback and extension bridge (FR-209, FR-096)

*As built in M7.5 (ADR-096; `services/novad/src/{browser,egress,ws,bridge}.rs`).* The `browser`
module runs a clean Chromium on the device for an agent whose own browser a site blocked, once the
user consented on the Hub for that site, and it hosts the extension bridge to the user's own
browser. The Hub side (the offer, the per-site consent, the driver, the extension) is `docs/11` §4.6
and §4.3; the routes are in `contracts/hub-api.md` §3.

- **Launch.** `POST /agent/v1/browser/launch {sessionId, grantee, allowHosts, headless?}` →
  `{sessionId, cdpPath, skippedHosts?}`. The browser is `config.json` `browser.executablePath` (an
  absolute path to an executable), else the first of the usual Chromium-family install paths on
  Linux or macOS; none is 409 `capability_missing` `{reason: no_browser}`. At most
  2 sessions run on a device (409 `conflict` `{reason: session_limit}`; a repeated id is
  `session_exists`). Each session gets a fresh profile folder (0700), deleted when it closes, inside
  `novad`'s own folder `nova-browser-<hash of the data folder>` (0711) under `browser.profileRoot`
  (default the temporary folder, private to the service under `PrivateTmp`); `novad` never changes
  or cleans the configured folder itself, and profiles a crash left behind are deleted when the
  module starts. Headless by default; a visible browser needs a display (409 `{reason:
  no_display}`). A session is ready once the browser answers `novad`'s own `Browser.getVersion`
  within 20 s; otherwise, or when it exits at start, the launch is 503 `{reason:
  browser_start_failed}` with the tail of its output. `close {sessionId}` → `{closed: true, egress:
  {allowed, refused}}` stops the browser's whole process group (SIGTERM, then SIGKILL before the
  browser is reaped) and deletes the profile; `list` first closes sessions whose browser died.
- **Who it runs as.** A `novad` that is not root runs Chromium as itself. A root `novad` runs each
  session as its own dedicated user, never root, `nobody`, or a user whose primary group is
  root's or `nobody`'s: `nova-browser1` and `nova-browser2` (§2), or the users `browser.runAs`
  names (a name or a list). An unsafe `runAs` is 403 `{reason: unsafe_browser_user}`; no such user
  is 409 `capability_missing` `{reason: no_browser_user}` and none free is 409 `conflict` `{reason:
  no_free_browser_user}` (fail closed). Two live sessions never share a uid, so no other process shares the browser's
  user and its DevTools pipe. The folder the profiles go in must be passable by that user (o+x),
  else 400.
- **Egress filter.** Each session's Chromium gets `--proxy-server` pointing at its own HTTP proxy
  on `127.0.0.1:<free port>`, with `<-loopback>` so loopback goes through it too, and WebRTC kept
  off non-proxied UDP. The filter takes CONNECT and absolute `http://` requests only (400
  otherwise), to ports 80 and 443 only, and only to `allowHosts`: exact names, and `*.name` for the
  names under it (not `name` itself). At most 200 entries; an entry `novad` cannot use (`*`, a
  wildcard over a whole top-level domain such as `*.dev`, an IP literal, a name whose last label
  has no letter) is skipped and returned as `skippedHosts: [{host, reason}]`, and the launch fails
  (400) only when no host is left. IP literals and numeric names are refused whatever the list
  says, and an unlisted name is refused before any lookup. `novad` resolves a listed name itself
  and refuses it (403) when any address it gets is private, loopback, link-local, multicast,
  unspecified, carrier-grade NAT, unique-local or reserved, so a public name cannot point the
  browser at the device's LAN; for IPv6 only 2000::/3 counts as public, and IPv4-mapped, NAT64 and
  6to4 addresses are judged by the IPv4 address they carry. It then connects to the address it
  checked, never to a second lookup. There is no TLS inspection. Bounds: 64 connections, 30 s for a
  request head, 5 minutes idle. It logs hosts and decisions, never URLs, and its counts go back to
  the Hub when the session closes. It has no token (Chromium cannot present proxy credentials);
  it only narrows what any local process could reach anyway.
- **DevTools.** Chromium runs with `--remote-debugging-pipe` (it reads fd 3 and writes fd 4,
  NUL-terminated JSON) and opens no TCP port. The Hub connects to `GET
  /agent/v1/browser/cdp/<sessionId>` with the management token, over mutual TLS when the device
  holds a certificate (§9); a request with an `Origin` is 403 `origin_rejected`, and the upgrade
  needs WebSocket version 13 and a 16-byte key (400 otherwise). The supervisor reaches the module
  over `<data>/browser/cdp.sock` (0600 in a 0700 folder; 404 for an unknown session, 503 `{reason:
  module_unavailable}` without the module) and answers the WebSocket itself (`src/ws.rs`, no
  extension or subprotocol): each text message goes to the pipe whole, and each of the browser's
  messages comes back as one text frame. Client frames must be masked; binary is refused (1003),
  invalid UTF-8 or a NUL inside a message is 1007, and a message over 64 MiB either way is 1009;
  the decoder holds at most one message plus one read. One connection per session: a newer one
  replaces the older (closed with 1001), and closing the session closes it with 1001. The pipe
  outlives a connection, so DevTools sessions a previous connection attached inside the browser
  stay attached after a reconnect.
- **Idle and lifetime.** A session with no DevTools client for 10 minutes is closed, and every
  session after 4 hours, so a Hub that crashed, or a close that never reached the device, cannot
  hold the two slots.
- **The extension bridge host.** `novad bridge enable`, run by the user (refused as root), writes
  `~/.config/nova/bridge-token` (`nvbr_…`, 0600 in a 0700 folder) and the native-messaging host
  manifest `ai.nova.bridge.json` into the `NativeMessagingHosts` folder of each Chromium-family
  browser whose config folder already exists in the user's home, with `allowed_origins` only Nova's
  extension (`config.json` `bridge.extensionId`, required; asked of `novad` over the bridge socket
  when the user cannot read the config). `disable` removes both. The browser starts the host
  (`novad bridge-host`, or `novad chrome-extension://…/`), which speaks native messaging on stdin
  and stdout (a 4-byte native-endian length, then JSON, at most 1 MiB each way) and relays with the
  same framing to the user's `bridge.sock` beside the local runtime's socket (§4.3); it passes only
  `call` frames to the extension and only `result`, `error` and `event` frames to `novad`. The
  module binds `bridge.sock` for each user in `localRuntime.users` the way the local runtime binds
  its socket. A connection must come from that user's uid (the kernel's peer credentials), present
  the token in that user's token file (read by a child running as the user) and, for a host, the
  configured extension's origin (`token_required`, `bridge_not_configured`, `origin_not_allowed`
  otherwise). One host at a time: a newer host of the same user replaces the older one (`novad`
  reports `disconnected` for it, then `connected`), and a host of another OS user gets
  `bridge_busy` until the connected one is gone.
- **Calls and events.** `POST /agent/v1/bridge/call {method, params?, timeoutMs?}` → `{result}` or
  `{error: {code, message}}`, for `tabs.list`, `tabs.open`, `tab.attach`, `tab.detach`, `cdp.send`
  and `history.search`; `timeoutMs` is 1 to 120 s (default 30 s; past it 504 `{reason:
  bridge_timeout}`); with no host connected, or no browser module, 409 `bridge_offline`. `POST
  /agent/v1/bridge/status` → `{configured, connected, user, since, users}`. The extension's
  `tab.shared`, `tab.unshared`, `tab.closed`, `host.granted` and `host.revoked` and `novad`'s own
  `connected` and `disconnected` (with the user) are queued (500, oldest dropped, 16 KiB each) and
  posted to the Hub's `POST /agent/v1/bridge/events` with the device credential, at most 100
  events and under 900 KiB a post. 5xx, 408 and 429 are retried, a 413 halves the batch (a single
  event that still does not fit is dropped), and any other 4xx drops the batch with a log line.
- **Not built.** No bridge on Windows (no named pipe, no registry manifest). A visible browser run
  as a dedicated user probably cannot use the desktop user's display. On a kernel without
  unprivileged user namespaces Chromium's own sandbox does not start, which shows as
  `browser_start_failed`. `novad`'s tests drive a fake Chromium that speaks the pipe protocol.

## 5. Boot & power

### 5.1 High-level boot

- **Linux**: systemd unit (`novad.service`) with `Restart=always`.
- **macOS**: launchd agent/daemon.
- **Windows**: Windows service.

The supervisor starts modules per configuration and re-registers with the Hub.

### 5.2 Low-level boot (opt-in)

For headless/compute machines and lab setups, `novad` may manage lower-level boot paths:

- **PXE / iPXE** network boot: serve boot images and menus so a device can netboot into a Nova
  image.
- **Bootloader** configuration: managed entries (e.g., systemd-boot/GRUB) with a safe default
  and automatic fallback.
- **Boot profiles**: choose an OS/image on next boot, with a watchdog that reverts if the
  machine fails to come up (Nova marks the boot successful only after `novad` reconnects).

Low-level boot is disabled by default and requires an admin toggle.

*As built in M7.5 (ADR-096; `services/novad/src/boot.rs`, `packages/core/src/boot`, `apps/hub/src/boot.ts`).*

- **Bootloaders.** Linux only (elsewhere `os_not_supported`). `config.json` `boot.backend` (default
  `auto`) tries systemd-boot (`bootctl is-installed`), then GRUB (`grub.cfg` in `/boot/grub` or
  `/boot/grub2` and `grub-reboot` or `grub2-reboot`; entries, `submenu>entry` ids included, read
  from `grub.cfg`), then UEFI boot entries (`efibootmgr`); `fake` reads a JSON file (tests and the
  E2E fake device) and `none` turns it off. Without one, `boot/status` answers `{supported: false,
  reason}` and every other route 409 `conflict` `{reason: unsupported_hardware, detail}`. The Hub
  reads the `bootloader` name leniently (`DeviceBootStatusView.bootloader` is a plain string):
  `fake` is a known one (shown as "Test bootloader (fake)"), a short plain name it does not know
  is kept and shown as "unknown (<name>)", and anything else or a missing name becomes
  `unreadable`, so a newer `novad` never makes the whole status unreadable. Every tool
  runs through the hardened child-process helper as an argument vector, never a shell, within 10 s.
- **One-shot.** `boot/set {profileId, entryId, watchdogSeconds?, reboot?}` sets a one-shot next boot
  (`bootctl set-oneshot`, `grub-reboot`, `efibootmgr --bootnext`), so a machine that never comes up
  returns to its default entry by itself at the next power cycle. `boot/commit` makes the entry the
  default (`bootctl set-default`, `grub-set-default`, or `efibootmgr --bootorder` with the entry
  moved first) and `boot/revert` clears a pending one-shot. Set and commit need the Hub's
  `lowLevelBoot` policy, from the heartbeat answer or pushed through `/agent/v1/config` (403
  `{reason: low_level_boot_off}`), and a Hub-signed authorization (§9); revert needs only its
  authorization. Before a set or commit the Hub pushes the toggle when the device last confirmed
  another value; a device that still refuses gets it again and the change once more with a new
  change id, and if it still refuses the request goes back to waiting with its approval unspent
  (`device_policy_stale`) and the Hub's sweep sends it again. One pending change at a time
  (409 `boot_pending`); a restart needs the owner's `power.allowActions`, checked before anything
  changes (409 `reboot_unavailable`).
- **Watchdog.** `boot/pending.json` (the deadline, this boot's id, the authorization's change id) is
  written before the one-shot and removed again when setting it fails. The deadline is
  `watchdogSeconds` (120 to 3600, default 600; the Hub sends `devices.boot.watchdogSeconds`) counted
  from `set`, even without `reboot`. After a restart, the first heartbeat the Hub accepts before the
  deadline reports `boot.watchdog.ok` with `{booted, verified}`. A machine that booted another entry
  gets the one-shot cleared and `boot.watchdog.reverted` (`not_booted`, no restart). The deadline
  passing first clears the one-shot, reports `reverted` (`deadline`) and restarts once into the
  default, only when the machine is on the pending entry or cannot tell. A machine never restarted
  by the deadline is cleared without a restart (`not_restarted`). A marker is handled once and
  never loops.
- **GRUB.** GRUB cannot name the entry it booted. `verified` is false when `next_entry` is still set
  in grubenv (the one-shot never ran) or `/proc/cmdline` names another kernel than the entry's
  `linux` line. The entry list marks the default grub.cfg really boots, and commit is refused with
  409 `{reason: grub_default_not_saved}` unless grub.cfg boots `saved_entry` (`GRUB_DEFAULT=saved`),
  because `grub-set-default` changes nothing otherwise. The service unit keeps `/boot/grub`,
  `/boot/grub2`, the ESP and the EFI variables writable (§9).
- **The Hub.** Named boot profiles per device, each an entry id; kernel arguments are not supported
  (400 `capability_missing` `{reason: kernel_args_not_supported}`). Trying a profile and making a
  confirmed trial the default each open an approval card (risk high, confirm at action, 30 minutes,
  answered only in Nova by the signed-in owner) and are sent once, with a signed authorization, when
  the owner allows them; with `devices.boot.allowLowLevel` off both are refused when asked and again
  when sent. A revert is a safety action: the owner's own request is its approval, and it works with
  the toggle off. One trial and one waiting request per device. A trial reported with `verified:
  false` becomes the default only with `confirmUnverified: true` (else 409 `{reason:
  unverified_trial}`). A trial with no report 120 s after its deadline is marked `failed`
  (`no_heartbeat`, or `no_watchdog_report` when the device was heard from) and the owner is told,
  with a power-cycle link when an out-of-band endpoint is linked to the device (the owner's own
  action, §7); a later report from the device corrects the record.
- **Network boot is the Hub's.** PXE/iPXE is served by the Hub, not `novad`, and only with
  `devices.pxe.enabled` (off by default; it does not need the low-level toggle). Each device gets a
  boot token (`nvb_` and 256 random bits, shown once, only its hash kept, rotatable, dead with the
  device). `GET /boot/ipxe/<token>` answers an iPXE menu of the images in `<dataDir>/boot-images/`
  (the local disk after 30 s), and `GET /boot/images/<token>/<name>` serves one (plain file names
  directly in that folder; single byte ranges). Both answer 404 while PXE is off and for an unknown
  or revoked token, allow 30 menus and 120 images a minute per address, audit every fetch, and are
  masked in the Hub's request log so the token never reaches it. Nova runs no DHCP or TFTP: point a
  DHCP server's next-server/filename, or an iPXE build's embedded script, at `/boot/ipxe/<token>`.
  iPXE over plain HTTP carries the token in the clear, so images must hold no secrets; iPXE over
  HTTPS needs the Hub local CA built into it. Either way iPXE must use an address the Hub answers
  to (its Host check applies).
- **Not built.** Kernel arguments, DHCP and TFTP, and low-level boot on Windows or macOS. The
  bootloaders were tested with fake tools only, never on real hardware.

### 5.3 Wake-on-LAN

- Enable WoL where the platform allows (NIC setting, and BIOS where supported).
- A **Wake Helper** on the same LAN sends the magic packet (`docs/22` §7).
- `novad` reports wakeability; the Hub only offers "wake" for wakeable devices.
- Wakes are rate-limited and logged.

*As built in M6 (ADR-093).* Linux only. Wakeable means a physical NIC that supports and has
magic-packet wake on (`sysfs` plus `ethtool`). Enabling it is a plan by default (an `ethtool`
command and a systemd-networkd `.link` file per NIC); applying needs `apply`, the owner's
`power.allowChanges` and root. Sleep, restart and shutdown use `systemctl` and need
`power.allowActions`. Power-on-after-power-loss is `unknown` (it needs the firmware module; since
M7.5 it is read from the BIOS where a backend can, §3, §6). There is no Wake Helper yet: the Hub
sends the magic packet itself as a UDP broadcast on its own LAN, at most `devices.wakesPerHour` per
device. Low-level boot answers `capability_missing` (M7.5 built it, §5.2).

*As built in M6.5 (ADR-094).* A device whose roles include `wake-helper` accepts
`POST /agent/v1/power/wake-other {mac, broadcast?, port?}` on the management channel, with the same
management token as every management call (`contracts/hub-api.md` §3). The MAC must be unicast;
`broadcast`, when given, must lie on one of the device's physical IPv4 subnets (from
`/proc/net/route`; container bridges and tunnels do not count), else the packet goes to every
physical subnet's broadcast address; the port is 9 (default) or 7. At most 10 wakes a minute,
counted in the supervisor so a module restart does not reset it (429 `rate_limited`). Refusals are
403 `policy_denied` (`not_wake_helper`, `not_on_lan`), 409 (`no_lan`) and 400 `validation`. The
power status in every heartbeat carries `lan: [{interface, network, broadcast}]`, the device's
physical subnets, so the Hub can pick a helper on a target's subnet (`docs/22` §7); the Hub computes
the broadcast address from `network` itself. Linux only.

## 6. BIOS / firmware management

Capability varies by platform. Support ladder (BM1): **Dell → Lenovo → HP → ASUS →
Supermicro/server → generic UEFI**.

### 6.1 Methods

| Method | Use |
| --- | --- |
| Vendor OS agents (Dell Command \| Configure, Lenovo WMI, HP BCU, ASUS/Dell WMI) | Change settings from the OS |
| `fwupd` | Firmware **updates** (not arbitrary settings) |
| `dmidecode` | Read-only inventory |
| Out-of-band: IPMI / Redfish / Intel AMT/vPro | Settings + power **without a running OS** |

### 6.2 Settings in scope (BM2)

Wake-on-LAN enable · power-on-after-power-loss · boot order · virtualization (VT-x/AMD-V) ·
Secure Boot / TPM state · fan/thermal profile.

### 6.3 Safety model (mandatory)

1. **Global toggle** "Allow BIOS/firmware changes" — **off by default** (BM3).
2. Even when enabled, **every change requires explicit approval** on the Hub; BIOS changes are
   **never** proactive or autonomous.
3. **Dry-run + diff preview** (current → proposed) before applying.
4. **Snapshot** the current configuration first; support **rollback**.
5. **Allowlist only**; **security-degrading changes** (disabling Secure Boot/TPM, turning off
   firmware write-protect) are blocked by default and require a separate, explicit override.
6. **Supported-hardware matrix**; unsupported devices get a clear refusal, never a guess.
7. Reboot/power-cycle coordination, with a watchdog and automatic rollback on failed boot.
8. Every change is written to the **audit log** with before/after values.

*As built in M7.5 (ADR-096; `services/novad/src/firmware.rs`, `packages/core/src/firmware`,
`apps/hub/src/firmware.ts`, `packages/shared/src/m75/firmware.ts`).* `novad` reads and writes the
settings; the Hub decides whether it may. Linux only, through the kernel's firmware-attributes class
(`/sys/class/firmware-attributes/<driver>/attributes/<name>/current_value`) or `efibootmgr`, with
the platform read from `/sys/class/dmi/id` (no `dmidecode`). The vendor tools of 6.1 are not used.
Nothing has run on real BIOS hardware: the vendor attribute names are checked against mock sysfs
trees only.

**Support matrix.** `novad`'s vendor table decides (the first attribute name a machine has wins):

| Vendor | Method (driver) | Canonical keys (the vendor's attribute) | Not offered |
| --- | --- | --- | --- |
| Dell | firmware-attributes (`dell-wmi-sysman`) | `wol` WakeOnLan, `powerOnAfterPowerLoss` AcPwrRcvry, `virtualization` Virtualization, `secureBoot` SecureBoot, `tpm` TpmSecurity, `fanProfile` ThermalManagement | `bootOrder` |
| Lenovo | firmware-attributes (think-lmi, `thinklmi`) | all seven; `bootOrder` BootOrder (a colon-separated list) | — |
| HP | firmware-attributes (`hp-bioscfg`) | `wol`, `powerOnAfterPowerLoss`, `bootOrder` (UEFI Boot Order), `virtualization`, `secureBoot`, `tpm` (TPM State or TPM Device) | `fanProfile` |
| ASUS | none | — | refused: no interface to these settings from Linux |
| Supermicro | none | — | refused: manage it out of band (§7) |
| Any other UEFI machine | `efibootmgr` | `bootOrder` only | everything else |

Refusals name their reason: `os_not_supported` (Windows and macOS; the vendor tools there are
Windows-only and not built), `driver_missing` (a matrix vendor whose kernel driver is not loaded),
`vendor_not_supported` (ASUS, Supermicro, and other vendors' machines without UEFI, which the Hub's
matrix calls `legacy_bios`), `tool_missing` (a UEFI machine without `efibootmgr`) and
`disabled_by_owner` (`config.json` `firmware.backend: "none"`). `firmware/read` then answers
`supported: false` with the reason, and every write is 409 `conflict` `{reason:
unsupported_hardware, detail}`; the Hub requires both the device and its own matrix to say
supported. The Hub's copy (`FIRMWARE_SUPPORT_MATRIX`, shown on the support route) matches `novad`'s
table on vendor, method, driver folder, support and keys: one fixture
(`services/novad/tests/fixtures/firmware-support-matrix.json`) is compared by both test suites, so
they cannot drift (vendor names still match a little differently: `novad` looks for the name
anywhere, the Hub at the start of a word). The Hub reads `firmware/read`'s `method` leniently
(`FirmwareReadView.method` is a plain string): `firmware-attributes`, `efibootmgr`, `fake` or
`unknown`, or a short plain name a newer `novad` sends, which the web shows as "unknown (<name>)";
anything else becomes `unreadable`, and never the whole answer. **fwupd** is read-only: `firmware/read` lists the updates `fwupdmgr get-updates
--json` offers (within 10 s, at most 50; none without fwupd), and installing them is not built.

**The safety model of 6.3, as the code does it.**

1. **Toggle.** `devices.firmware.allowChanges` (off, owner-only, `security: true`; turning it on
   needs `{confirm: true}` and is audited with the values before and after). The Hub refuses plan,
   approval and apply while it is off (`firmware_disabled`). `novad` learns it in every heartbeat
   answer (`policy.firmwareChanges`, kept in `policy.json`; only `true` counts, a damaged file is
   off, enrollment deletes it) and refuses apply and rollback without it (403 `firmware_disabled`),
   even with a valid authorization. The Hub does not wait for a heartbeat: it pushes the toggle
   with `POST /agent/v1/config {policy: {firmwareChanges, lowLevelBoot}}` (§9) to every active
   device when the switch changes, and before each apply and rollback when the device last
   confirmed another value (`DeviceService.syncPolicy`). A device that still answers
   `firmware_disabled` while the switch is on gets the toggle again and the change once more with a
   freshly signed authorization; if it still refuses, the Hub answers 409 `device_policy_stale`
   (retryable) and the change stays approved. Reading and planning on the device work whatever the toggle,
   but only while the Hub allows the `firmware` module (403 `module_not_allowed`).
2. **Approval.** Each change is an approval card (risk high, confirm at action, Allow once or Deny,
   24 h) that shows the diff and is answered only by the signed-in owner in Nova: a channel button,
   reply or link, a hook or a rule is refused `hub_only`. Its hash binds it to the change, the diff
   and the snapshot, and it is used once. The Hub then signs an authorization of kind
   `firmware.apply` or `firmware.rollback` for exactly that request body, which `novad` requires
   (§9). No model-facing tool plans, approves or applies a firmware change.
3. **Dry run and diff.** `firmware/plan {changes}` (1 to 16 keys, each once) changes nothing and
   answers the diff (`from`, `to`, `securityDegrading`) and the keys it refused (`unknown_key`,
   `read_only`, `not_allowed_value`, `unsupported`). An enumeration takes only its possible values,
   an integer only values within its bounds, and a boot order may only be reordered, never
   shortened or extended. The Hub caches a device's read for 60 s and runs one firmware operation
   per device at a time (`firmware_busy`).
4. **Snapshot and rollback.** Each plan snapshots every allowlisted value on the device
   (`firmware/snapshots/<id>.json`, 0600, the newest 20 and any a watchdog marker names); the Hub
   keeps its own copy, sealed with the data key. Apply writes only while the machine still holds the
   snapshot's values (409 `base_mismatch`, nothing written), and a write that fails midway restores
   what it had written (500 `apply_failed` with `restored`). `firmware/rollback` restores a
   snapshot from the device's copy or, when the device lost it, from the Hub's (its SHA-256
   checked). A rollback is a change of its own, with its own approval, and never restarts the
   machine.
5. **Allowlist and override.** Only `wol`, `powerOnAfterPowerLoss`, `bootOrder`, `virtualization`,
   `secureBoot`, `tpm` and `fanProfile` exist; every other setting a BIOS has, firmware write
   protection included, cannot be read or changed. Setting Secure Boot or the TPM to a value that
   is not "on" is security-degrading: it needs `devices.firmware.allowSecurityDegrading` (also off,
   also confirmed), which the Hub checks at approval and again at apply, rollbacks included, before
   it sends `allowSecurityDegrading: true` inside the signed body. `novad` refuses such a write
   without it (403 `security_degrading`). The Hub flags these keys even when the device does not.
6. **Matrix.** Above.
7. **Watchdog.** With `reboot: true`, `novad` first checks that it may restart (the owner's
   `power.allowActions`, else 409 `reboot_unavailable`), writes `firmware/pending.json` before the
   first BIOS write (removed again when the change fails), answers, and restarts through the
   `management` module 1.5 s later. The deadline is `watchdogSeconds` after the apply: the Hub
   sends `devices.firmware.watchdogSeconds` ("Firmware watchdog", default 600, kept inside 120 to
   3600) with every apply that restarts, separate from the boot watchdog because a restart into new
   firmware settings goes through the BIOS start-up; `novad` takes 120 to 3600 and defaults to 600. The first heartbeat the Hub accepts after the restart, before the
   deadline, reports `firmware.watchdog.ok`; the deadline passing first restores the snapshot key by
   key and reports `firmware.watchdog.reverted` (§10). Only a complete revert restarts, once; one
   guarded restart is pending at a time (409 `watchdog_pending`) and a snapshot never gets a second
   watchdog (409 `watchdog_already_used`). **A BIOS admin password** changes this. `novad` never
   keeps the password, so its watchdog cannot write such a BIOS (every key fails with
   `admin_password_required`, and there is no restart); the Hub therefore refuses `reboot: true` on
   a device that reports `adminPasswordSet` (403 `policy_denied` `{reason: watchdog_unavailable}`)
   before it reads the vault: apply without a reboot, restart by hand, and roll back from Nova if
   needed. The password (`secret://devices/<id>/bios-admin`, write-only on the Hub) is read and sent
   per call, only to a device with an `https://` endpoint (else 403 `tls_required`, and no vault
   read), and is left out of the signed body hash. `novad` writes it to the driver's
   `authentication/Admin/current_password` before each write and clears it after, never stores or
   logs it, and refuses a body that carries it over plain HTTP (403 `tls_required`). An apply or
   rollback without it on such a BIOS is 403 `admin_password_required`.
8. **Audit.** The Hub audits `device.firmware.read|plan|approval|apply|rollback|watchdog` (kind
   `device`) with the values before and after, the password's `device.firmware.password.set|clear`
   (kind `secret`), and the toggles once each as `setting.changed` (kind `settings`, from the
   settings writer's `settings.changed`); it emits `device.firmware.changed`.

## 7. Out-of-band management (BM4, opt-in)

- **IPMI** (BMC), **Redfish**, **Intel AMT/vPro**: power on/off/cycle, firmware settings,
  console access, health sensors — even with the OS down.
- Module is **off by default**; admin-only; credentials stored in the keychain; endpoints
  must be allowlisted.
- All operations are policy-gated, approved, and audited.
- Supports server hardware (Supermicro/Dell/HPE) and vPro client machines.

*As built in M7.5 (ADR-096; `packages/core/src/oob`, `apps/hub/src/oob.ts`).* Out-of-band
management is the Hub's own: the Hub talks to the BMC, and `novad` has no out-of-band route (it
answers `/agent/v1/oob/*` with 403 `oob_disabled`). `devices.oob.enabled` is off by default and is
turned on only by `POST /api/v1/oob/enable {confirm: true}` (the settings route refuses it); every
route is owner-only and every step is audited (`device.oob.<action>`, with the values before and
after).

- **Endpoints.** The owner registers each BMC (the registry is the allowlist): Redfish over HTTPS,
  or IPMI through `ipmitool` (lanplus; the password goes only through `IPMI_PASSWORD`, never on the
  command line). Intel AMT is not built (`capability_missing` `{reason: not_built}`), nor are
  console access and BIOS settings over IPMI. The address may not be loopback, link-local,
  unspecified, multicast or the Hub's own, and every address a name resolves to is checked again
  at each connection. Credentials live only in the vault (`secret://oob/<id>`).
- **Pinning.** A Redfish BMC's certificate is pinned like an SSH host key: the first `check` reads
  its SHA-256 without sending credentials, and the owner confirms it (`POST
  /api/v1/oob/endpoints/:id/pin/confirm`) before any are sent. Every later connection is checked
  against the pin before a byte is written (403 `policy_denied` `{reason: tls_pin_mismatch}`
  otherwise); redirects are never
  followed, and each call times out after 10 s.
- **Actions.** `check`, `power.status|on|off|cycle|reset`, `sensors`, `bios.read`, `bios.plan` and
  `bios.apply` (Redfish pending settings, applied at the next reboot; the canonical keys and both
  firmware toggles of §6 with this area's own attribute table: Dell and HPE mapped, Lenovo and
  Supermicro refused), and `boot.next` (a one-time boot override; many BMCs drop it if the machine
  does not restart within about 60 s).
- **Approvals.** Every action but `check`, `power.status`, `sensors` and `bios.read` files a
  Hub-only approval card (risk high), bound to the BMC as it was (address, port, system, pin) and
  run only on the signed-in owner's own Allow once: power and `boot.next` run when allowed within 10
  minutes, and a `bios.plan` card shows the diff and covers its single `bios.apply`. Editing or
  deleting an endpoint withdraws its open cards and approved plans. No device authorization (§9) is
  involved, because no device is called.

The policy side is `docs/12` §4 (approvals) and §5 (the vault); the routes are in
`contracts/hub-api.md` §1.

## 8. Updates

- The Hub serves signed module bundles; `novad` verifies signature + version pinning.
- **Minimum version per capability** (FR-148): the Hub keeps a table of the minimum `novad`
  and module versions for each capability (for example computer use, staged writes, capture).
  A device below the minimum is refused that capability, keeps its others, and shows "Update
  required" in Devices with the update offered. Agent connections (FR-081) check the same
  table.
- Update flow: download → verify → stage → health check → commit; on failure, roll back to the
  previous module version.
- Channels: stable / beta / nightly, set per device (default stable).
- The supervisor updates itself last, with a fallback binary and a watchdog.

*As built in M6 (ADR-093).* A bundle is `{manifest, signature, payload}`; the signature covers
the manifest's canonical JSON and is verified strictly (small-order keys rejected) against the key
pinned at enrollment (`novad enroll --update-key`; the M6 Hub has no update key of its own, so
without one every bundle is refused). A device accepts its own channel and the more stable ones,
only strictly newer versions, and only a payload whose size and SHA-256 match. A module update is
staged under `<data>/modules/<name>/<version>/`, swapped in, restarted and health-checked (it must
answer `ping` within 10 s and still run 2 s later), else the previous version is restored;
`rollback` returns to it on request. The Hub pushes bundles (`POST /api/v1/devices/:id/updates`),
modules first, and refuses the `novad` bundle when an earlier one failed. `novad` keeps its old
binary as `<data>/bin/novad-previous`, renames the new one over itself and exits with 75; a
watchdog restores the old binary after 3 starts without an accepted heartbeat, and the first
accepted heartbeat commits the update and reports it. A watchdog rollback is not reported, so the
Hub keeps that bundle as `staged`. The Hub hosts no bundles.

*As built in M7.5 (ADR-096).* `novad` is 0.7.0. A watchdog rollback of a `novad` update is still
not reported: `update.rs` `watchdog_on_start` restores the old binary, `novad` logs it and exits,
and no heartbeat event carries it, so the M6 sentence above stands. The device page now shows
whether a newer `novad` build is available (`GET /api/v1/devices/:id/updates/available`, compared
with the signed builds the Hub serves for Add Device): information only, nothing is pushed.
Firmware updates are only listed, from fwupd (§6).

## 9. Security model

- **Elevated supervisor, unprivileged modules.** Modules run as a restricted user in a sandbox.
  The exceptions are modules that must act in the signed-in user's desktop session (the
  `screen` module and the `capture` helper): they run as that user, without elevation, under
  their own OS sandbox, and the capture helper has no network access (§4.2, `docs/24` §4.1).
- **Process hardening** (FR-141): the supervisor and every helper disable core dumps, refuse
  debugger attachment (Linux not-dumpable, macOS deny-attach, equivalent Windows mitigation
  policies), and strip loader environment variables (`LD_PRELOAD`, `LD_LIBRARY_PATH`,
  `DYLD_*`) before starting children. On Windows, children run in kill-on-close job objects.
- **Local socket** (FR-192): the native shell reaches `novad` over a Unix socket of mode 0600
  in a `novad`-owned directory, or a named pipe whose ACL admits only the user; each connection
  presents a local token. Loopback or same-machine access is never treated as authorization.
- **Signed everything**: binaries, modules, update bundles, and capability profiles.
- **mTLS** between `novad` and the Hub, using the device certificate.
- **Least privilege per module**, enforced by the supervisor and OS sandbox.
- **No secrets to the model**: credentials stay in the keychain/vault; modules receive
  short-lived tokens only for the operation in flight.
- **Audit**: every privileged action (install, module start/stop, power, boot, BIOS, OOB) is
  recorded on the Hub audit log.
- **Revocation** instantly disables the device certificate and stops module execution.

*As built in M6 (ADR-093).* The management channel is bearer tokens over LAN HTTP until M6.5
(ADR-089 extended to `novad`): the device presents its credential (`nvc_`) to the Hub, the Hub
presents the device's management token to `novad`, which compares it in constant time; there is
no TLS, mTLS or device certificate yet. The management server is HTTP/1.1, one request per
connection, at most 256 connections. Hardening: the supervisor and modules turn core dumps off;
on Linux they are not dumpable, and children get a cleared environment (`LD_*` and `DYLD_*` never
passed), no new privileges, death with the parent and memory, CPU and open-file limits; macOS gets
deny-attach and no core dumps; the Windows measures are not built. Every privileged action is
audited on the Hub (kind `device`). The local socket for the native shell
(`contracts/hub-api.md` §4) is not built. Revocation reaches the device at its next heartbeat: the
401 makes it stop its modules and wipe its credentials.

*As built in M6.5 (ADR-094).* The management channel is still bearer tokens over LAN HTTP. A
device added with Add Device may hold a device certificate (`device-cert.pem`, issued in the
`local-ca` trust mode), which nothing checked yet (mutual TLS came in M7, below). Revoking a device
now also blocks its key and refuses an enrollment token still bound to it (`docs/22` §4.5).

*As built in M7 (ADR-095).* `novad`'s calls to the Hub (register, heartbeat, capabilities) go over
HTTPS when the Hub serves it, trusted only through the pinned Hub identity (§2), and present
`device-cert.pem` as the client certificate (mutual TLS); the Hub checks it on those routes, while
`devices.tls.allowWithoutCertificate` (on for one release) still accepts a device without one
(`docs/22` §5). The management channel the Hub calls on the device is still bearer tokens over
plain HTTP (`--endpoint` must be `http://`; R-022, narrowed to this channel; M7.5 made it mutual
TLS for a device that holds a certificate, below). The first local socket is the local runtime's
(§4.3): 0600 Unix sockets, its own and one per listed user, or a loopback address that needs its
token, serving only the model routes after the Hub's grant. The `local.*` methods of
`contracts/hub-api.md` §4 and the local token they use are not built. Device certificates are not
renewed (M7.5 renews them, below).

*As built in M7.5 (ADR-096; `services/novad/src/{mgmt_tls,authz,paths,grants,cli,browser}.rs`,
`packages/core/src/devices`, `packages/core/src/firmware/authz.ts`).*

- **Mutual TLS on the management channel** (closes R-022 for devices with a certificate). When
  `novad` starts holding `device-cert.pem`, its management server (default port 7420) speaks TLS
  1.3 only, so the client certificate travels encrypted. It presents the device certificate with
  the device's own Ed25519 key and requires a client certificate that chains to the Hub local CA
  `novad` cached from a verified identity statement (`hub-trust.json`), carries EKU clientAuth and
  the URI SAN `urn:nova:hub:<pinned fingerprint>` (another device's certificate from the same CA is
  refused); the bearer management token is still checked on every request. The configuration is
  read per connection, so a CA learned later applies at once; when it cannot be built (no cached
  CA, a damaged certificate, one for another key) every connection is refused, logged at most once
  a minute, and nothing is ever served over plain HTTP instead. Whether the channel is TLS is fixed
  when `novad` starts. Without a certificate it stays plain HTTP, but even there a body carrying
  the BIOS admin password is refused (403 `policy_denied` `{reason: tls_required}`).
- **No downgrade.** On a device that holds a certificate, a privileged request (firmware apply and
  rollback, boot set, commit and revert, decommission) that arrives over plain HTTP is 403
  `policy_denied` `{reason: tls_required}` before anything else is looked at. The device registers
  and heartbeats its endpoint as `https://` (§2). The Hub calls such a device only over TLS 1.3
  with its own client certificate (from the Hub local CA: URI SAN `urn:nova:hub:<fingerprint>`,
  clientAuth, 90 days, kept in the vault and renewed with the TLS leaf), without session reuse, and
  checks `novad`'s certificate by chain, the URI SAN `urn:nova:device:<id>` and the pinned key,
  never by host name; it never falls back to plain HTTP for a device that registered `https://`
  (`docs/22` §5).
- **Certificate renewal.** New device certificates carry serverAuth as well as clientAuth. A
  heartbeat answer may carry `certificate: {pem, notAfter}` when the device's certificate lacks
  serverAuth (issued in M7) or has a third of its life left. `novad` takes it only as a renewal,
  when it chains to the cached Hub CA, is valid now, has serverAuth and clientAuth, holds the
  device's own key and names `urn:nova:device:<id>`; it replaces `device-cert.pem` atomically
  (0600), new connections use it at once and the calls to the Hub from the next request. A refusal
  (`wrong_key`, `wrong_device`, `untrusted`, `expired`, `not_yet_valid`, `missing_server_auth`,
  `missing_client_auth`, `malformed`, `not_pem`, `no_ca`) is logged and the current certificate
  kept. The Hub sends the renewal until the device presents it, then revokes the old certificate;
  an M7 certificate without serverAuth is still accepted (checked byte for byte against the one the
  Hub issued) until the renewal is presented or 10 minutes after it was offered. The device page
  shows the renewal state, and diagnostics report a device still on the old certificate after that
  grace.
- **Hub-signed authorizations** (D2 of ADR-096). Every privileged request carries `authorization:
  {payload, signature}`, without which `novad` refuses it whatever the management token says. The
  payload is `{v: 1, kind, deviceId, changeId, bodySha256, approvalId, issuedAt, expiresAt}`, signed
  with Ed25519 by the Hub identity key over `nova-device-authz-v1\n` followed by the payload's
  canonical JSON (base64url). `novad` takes the key only as the one its pinned fingerprint names
  (read once from `GET /api/v1/hello` and kept in `hub-key.json` while it hashes to the pin) and
  checks the signature; `v`; a known `kind` equal to the route's (`firmware.apply`,
  `firmware.rollback`, `boot.set`, `boot.commit`, `boot.revert`, `device.decommission`); its own
  device id; `changeId` a UUIDv7; `bodySha256` equal to the SHA-256 of the body's canonical JSON
  without `authorization` (also accepted: without `adminPassword` too, so a hash never covers a
  secret); `expiresAt` at most 10 minutes after `issuedAt` (ISO times or epoch milliseconds); and
  the time window with 120 s of skew. It then spends the change id: used ids are kept 24 h
  (`authz-replay.json`, 0600, at most 4096). Refusals are 403 `policy_denied` `{reason:
  authorization_invalid | authorization_expired | authorization_mismatch}` and 409 `conflict`
  `{reason: replayed}`; a replay store that cannot be read refuses every privileged request (500
  `{reason: replay_store_unreadable}`). The Hub signs only for the owner's own request, with the
  action's toggle on (a boot revert and a decommission have none), after an approval card for
  exactly that change was allowed by the signed-in owner in Nova (a boot revert's approval is the
  owner's request itself), and for a device that is not revoked. Both sides test the same fixed
  vectors (`packages/core/test/fixtures/device-authz-vectors.json`, copied into the crate).
- **The device-side toggles.** `policy.json` (0600) holds `firmwareChanges` and `lowLevelBoot`, the
  second half of the double check: the device refuses firmware apply and rollback, and boot set
  and commit, while its toggle is off, even with a valid authorization. Two routes set them. A
  heartbeat answer's `policy` sets both (a missing one counts as off; an answer without `policy`
  keeps the last values). `POST /agent/v1/config` (management token) accepts `policy:
  {firmwareChanges?, lowLevelBoot?}` and merges: a toggle present sets its value (only `true`
  turns it on), one absent or null keeps it, toggles sent alone leave `allowedModules` and the
  other per-device fields as they are, and the answer always carries the `policy` in effect. The
  Hub uses it to push the toggles when the owner changes a switch and before each privileged send
  (`DeviceService.syncPolicy`; §6, §5.2), so a change sent right after a switch is turned on is not
  refused. Since this route takes the management token, whoever holds that token can now set the
  toggles too (before M7.5's push, only the Hub's heartbeat answer could). That removes only the
  device-side half of the check: every firmware and boot change still needs the Hub-signed
  authorization over its exact body, which the token cannot make (ADR-096 D3).
- **Dedicated browser users.** A root `novad` never runs Chromium as root or `nobody`: each session
  runs as `nova-browser1` or `nova-browser2` (§2, §4.4). Every other module still runs as `novad`'s
  user; there is no unprivileged module user yet.
- **Protected system paths.** `/sys`, `/proc`, `/dev`, `/boot`, `/efi` and `/etc` are never granted,
  resolved or used as a working folder (`protected_path`), and a grant of one made before this rule
  is never mounted into the command sandbox. So BIOS settings and EFI variables change only through
  the firmware and boot routes, with a Hub-signed authorization, never through the file or command
  modules.
- **The service unit** keeps `ProtectSystem=full` and adds `ReadWritePaths=-/boot/grub -/boot/grub2
  -/boot/efi -/efi -/sys/firmware/efi/efivars`, so low-level boot can write grubenv, the ESP and
  the EFI variables; BIOS settings sit under `/sys/class/firmware-attributes`, which
  `ProtectSystem` does not touch, and nothing in the unit makes `/sys` read-only or hides devices.

## 10. Failure & recovery

| Failure | Behavior |
| --- | --- |
| Hub unreachable | Keep running local fallback (if enabled); buffer management events |
| Module crash | Supervisor restarts with backoff; repeated crashes disable the module |
| Bad firmware/BIOS change | Watchdog reverts boot profile / restores snapshot; alert the user |
| Update fails health check | Automatic module rollback |
| Service can't start at boot | Boot profile marked failed; fallback to known-good; `novad` reports |
| Certificate revoked | `novad` stops modules, wipes credentials, awaits re-add |

*As built in M6 (ADR-093).* The supervisor checks modules every 200 ms; a crash fails that
module's calls in flight (`module_crashed`) and restarts it after 1 s, doubling to 60 s; five
crashes in ten minutes disable it (`crash_loop`) until the Hub or the owner starts it again.
Starts, stops, crashes and disables are reported on the next heartbeat (`device.module.changed`);
while the Hub is unreachable they are buffered in memory only (500 at most). A device is
`unreachable` after three missed heartbeats (30 s). Firmware and out-of-band routes answer 403
(M7.5 built the firmware routes, §6; out-of-band management is the Hub's, §7). `novad uninstall`
and decommission are not built (M7.5 built them, §11).

*As built in M7.5 (ADR-096; `services/novad/src/{firmware,boot,agent}.rs`, `packages/core/src/{firmware,boot}`).*

- **The event outbox.** Firmware and boot watchdog results wait in file outboxes
  (`firmware/events.json`, `boot/events.json`, at most 100 each) that survive restarts. Every
  heartbeat carries them with the module events (500 in all), and they are removed only once the
  Hub accepted that heartbeat. Each carries the authorization's `changeId`; the Hub matches by it,
  falling back to the snapshot or the profile only for an event without one.
- **Firmware watchdog events.** `firmware.watchdog.ok` `{snapshotId, changeId, at, detail: {}}`, and
  `firmware.watchdog.reverted` with `detail: {reason: deadline | not_restarted, complete, restored:
  [{key, from, to}], failed: [{key, from, to, error}], rebooted}` (or `complete: false` with
  `error` and `errorCode` when the backend or the snapshot is gone). The revert restores key by key:
  a key it cannot write stays as it is and is listed in `failed` (on a BIOS with an admin password
  every key, `admin_password_required`), the keys restored stay restored, and only a complete revert
  restarts the machine, so a half-reverted machine stays reachable.
- **Boot watchdog events.** `boot.watchdog.ok` `{profileId, entryId, changeId, at, detail: {booted,
  verified}}` and `boot.watchdog.reverted` with `detail: {reason: deadline | not_restarted |
  not_booted, booted, rebooted, error}` (§5.2).
- **On the Hub.** A firmware revert counts only when it is complete (`complete` not false, nothing
  in `failed`, no `error`, every changed key restored). Anything else makes the change
  `revert_failed`: the owner gets an attention notice ("A firmware change could not be reverted"),
  the audit records the values the machine really holds and what was not restored, and rollback
  stays open. A firmware change whose device has not reported 120 s after its deadline is marked
  `missed`, and a boot trial `failed` (§5.2), each with an attention notice: the Hub cannot revert
  a machine that does not come up (`novad` does when it starts, and a boot one-shot is gone after
  the next power cycle).

## 11. Uninstall & decommission

- `novad uninstall` stops modules, removes services, and (with `--purge`) deletes data.
- The Hub removes the device from the registry and revokes its certificate.
- For rented/sold hardware, a **decommission** action wipes Nova data and, where supported,
  clears the BIOS management credentials it installed.

*As built in M7.5 (ADR-096; `services/novad/src/uninstall.rs`, `packages/core/src/devices/service.ts`).*

- **`novad uninstall [--purge]`** (root when a service is installed) stops and removes the service
  (`systemctl disable --now`, the unit file, `daemon-reload`; macOS `launchctl unload -w`; Windows
  `sc.exe stop` and `delete`), removes the installed binary and, as root, the browser users
  (`userdel`), removes the bridge's host manifests and token from the homes of the users in
  `localRuntime.users` (as each user, through a forked child that switched to their ids), and wipes
  `key.seed` (zeroed first, best effort), `device.json` (with the credential and management token),
  `device-cert.pem`, `hub-trust.json`, `hub-key.json`, `scopes.json`, `policy.json` and the local
  runtime's token and socket. The authorization replay store stays until the folder goes, so a
  spent authorization stays spent. It does not contact the Hub: remove or decommission the device
  there too.
- **Purge.** `--purge` also deletes the data folder, but only one marked as `novad`'s
  (`.novad-data`, written when `novad` makes the folder, or its `device.json`, `key.seed` and
  `modules.json` together), and never `/`, a folder right under it, a folder right under `/home` or
  `/Users`, the usual system folders or the caller's home folder. `uninstall --purge` on an
  unmarked folder stops before removing anything; a decommission skips the purge and says so
  (`purge: false` in its answer).
- **Decommission.** `POST /api/v1/devices/:id/decommission {purge}` (owner) opens an approval card
  (risk high, Allow once or Deny, 1 hour, answered only in Nova by the signed-in owner); one open
  request per device (`decommission_pending`). Once allowed, a reachable device is told through
  `POST /agent/v1/decommission {purge?, authorization}` with a Hub-signed `device.decommission`
  authorization for exactly that body (§9; over mutual TLS when it holds a certificate; any other
  field is 400). `novad` closes the browser sessions (their profiles go), stops every module,
  forgets its credential and management token at once (later calls are 401), wipes the same files
  as uninstall and answers `{decommissioned, purge, wiped, service}`.
- **The fixed order.** Half a second after answering, `novad` removes the users' bridge files and,
  when purging, the data folder, then hands the rest to one transient unit (`systemd-run
  --unit=novad-decommission --on-active=3`), because the service cannot write `/etc` or `/usr`
  under `ProtectSystem=full` and stopping it ends `novad`. That unit disables the service, removes
  the unit file and the binary, reloads systemd, removes the browser users and only then stops
  `novad`. On macOS the files go first, then `launchctl bootout`; on Windows `sc.exe delete`, then
  `stop`. A `novad` that runs without a service exits at its next heartbeat.
- **The Hub revokes whether told or not.** Whatever the device answered (`wiped`, `refused`,
  `unreachable`, or `not_told` when the Hub identity could not sign), the Hub then revokes the
  device and its certificate. An offline device is revoked at once and wipes its credentials at
  its next contact (the 401 of §10). A decommission a Hub restart interrupted is finished at the
  next start. Events `device.decommission.requested` and `device.decommissioned`; audit
  `device.decommission.request`, `device.decommission.decide` and `device.decommission` with the
  status before and after.
- **BIOS credentials.** `novad` installs none: the BIOS admin password lives only in the Hub's vault
  (§6), and is deleted from it when the device is revoked or decommissioned (audited
  `device.firmware.password.clear`, reason `device_revoked`). Out-of-band credentials (§7) belong
  to an endpoint, not to the device, and go when the owner deletes the endpoint.
