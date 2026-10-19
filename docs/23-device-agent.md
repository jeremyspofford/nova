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
only `ping` and `status`. Modules run as `novad`'s user with resource limits only: there is no
separate unprivileged module user and no per-module filesystem or network sandbox yet.

*As built in M7 (ADR-095).* The default manifest also has `local-runtime` on client-role devices
(§4.3), so a client runs three module processes (`management`, `storage`, `local-runtime`) and a
device that is both client and compute runs four. `novad` gained a TLS client: `rustls` 0.23.45
(Apache-2.0 OR ISC OR MIT) with the `ring` 0.17.14 provider (Apache-2.0 AND ISC; it builds with the C
compiler of the Rust image, where aws-lc would need cmake), whose certificate checks are
`rustls-webpki`; the tests make their certificates with `rcgen` 0.14.10 (MIT OR Apache-2.0), a dev
dependency only, so no key material is committed.

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
`novad uninstall` is still not built.

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
- `--endpoint`, the address the Hub calls for the management channel, stays `http://`.

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

## 4. Modules

| Module | Purpose | Privilege | Default |
| --- | --- | --- | --- |
| **management** | Power state, boot configuration, services, updates, (opt) BIOS/OOB | High | On for Hub/desktop |
| **compute** | Run inference/embeddings/media backends; manage models | Medium | On for Compute Nodes |
| **browser** | Headless browser automation for agents; the local browser fallback (FR-209); the native-messaging host for the extension bridge, which talks only to this `novad` (FR-096) | Low | Optional |
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
  goes through the Hub's policy engine and audit; their output is untrusted.

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
  `services.computeBackends: ["local-runtime"]` and `services.modelsPresent`. The module itself
  stays out of `modules` (`DOCUMENT_MODULES` in `src/capabilities.rs`), although
  `contracts/schemas/device-capability.json` now lists `local-runtime` in its enum.
- **Not built.** No peer-credential check on the sockets (the file mode is the authentication). A
  `novad` that does not run as root can make a socket only for its own user (for anyone else the
  `lchown` fails, and `status` says so). Windows has no per-user named pipe. Binding for another
  real user as root, and the macOS path on a Mac, have not been tried: the tests bind for the test's
  own user.

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

### 5.3 Wake-on-LAN

- Enable WoL where the platform allows (NIC setting, and BIOS where supported).
- A **Wake Helper** on the same LAN sends the magic packet (`docs/22` §7).
- `novad` reports wakeability; the Hub only offers "wake" for wakeable devices.
- Wakes are rate-limited and logged.

*As built in M6 (ADR-093).* Linux only. Wakeable means a physical NIC that supports and has
magic-packet wake on (`sysfs` plus `ethtool`). Enabling it is a plan by default (an `ethtool`
command and a systemd-networkd `.link` file per NIC); applying needs `apply`, the owner's
`power.allowChanges` and root. Sleep, restart and shutdown use `systemctl` and need
`power.allowActions`. Power-on-after-power-loss is `unknown` (it needs the firmware module). There
is no Wake Helper yet: the Hub sends the magic packet itself as a UDP broadcast on its own LAN,
at most `devices.wakesPerHour` per device. Low-level boot answers `capability_missing`.

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

## 7. Out-of-band management (BM4, opt-in)

- **IPMI** (BMC), **Redfish**, **Intel AMT/vPro**: power on/off/cycle, firmware settings,
  console access, health sensors — even with the OS down.
- Module is **off by default**; admin-only; credentials stored in the keychain; endpoints
  must be allowlisted.
- All operations are policy-gated, approved, and audited.
- Supports server hardware (Supermicro/Dell/HPE) and vPro client machines.

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
plain HTTP (`--endpoint` must be `http://`; R-022, narrowed to this channel). The first local
socket is the local runtime's (§4.3): 0600 Unix sockets, its own and one per listed user, or a
loopback address that needs its token, serving only the model routes after the Hub's grant. The
`local.*` methods of `contracts/hub-api.md` §4 and the local token they use are not built. Device
certificates are not renewed.

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
`unreachable` after three missed heartbeats (30 s). Firmware and out-of-band routes answer 403.
`novad uninstall` and decommission are not built.

## 11. Uninstall & decommission

- `novad uninstall` stops modules, removes services, and (with `--purge`) deletes data.
- The Hub removes the device from the registry and revokes its certificate.
- For rented/sold hardware, a **decommission** action wipes Nova data and, where supported,
  clears the BIOS management credentials it installed.
