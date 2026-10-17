# novad

The Nova device agent (`docs/23`). A small supervisor that enrolls a device with the Hub,
reports a signed capability document (`contracts/schemas/device-capability.json`), serves the
management channel (`contracts/hub-api.md` §3) and runs signed, sandboxed modules as separate
processes. Dependencies are `serde`/`serde_json` plus two pinned crypto crates: SHA-256/512 come
from `sha2` (RustCrypto, MIT/Apache-2.0) and Ed25519 (RFC 8032) from `ed25519-dalek`
(BSD-3-Clause), because widely reviewed, constant-time implementations are safer than hand-written
primitives; `src/crypto.rs` only adapts them and pins the FIPS 180-4 and RFC 8032 test vectors.
Verification is strict: canonical key encodings only, S < L, and no small-order key or R. The
HTTP/1.1 server and client, hex/base64 and the unified diff are in-crate.

```bash
npm run test:rust                       # cargo test, in a container when cargo is not installed
node scripts/cargo.mjs build            # target/debug/novad (the Hub's integration tests run it)

novad install --hub http://hub:7419 --code ABCD-EFGH --pin <hub fingerprint> \
  [--pairing ID] [--role client|compute|wake-helper]… [--name N] [--listen 0.0.0.0:7420] \
  [--endpoint http://this-device:7420] [--no-service] [--dry-run]   # Add Device (FR-132, FR-133)
novad enroll --hub http://hub:7419 --token nvd_… --listen 0.0.0.0:7420 \
  --endpoint http://this-device:7420 [--role client|compute|wake-helper]… [--update-key KEY]
novad run [--data-dir /var/lib/nova]    # supervisor + management channel + heartbeat
novad access list | approve ID | deny ID  # folder requests decided on the device
novad wol status | plan | enable --apply  # Wake-on-LAN (changes need elevation)
novad capabilities --data-dir D --sign  # the signed document
novad service-unit --platform linux|macos|windows  # systemd unit, launchd plist, sc.exe commands
```

## Install (FR-133, docs/22 §4.3)

The Hub serves signed builds at `/api/v1/agent/dist/` and shows a one-line command (Devices →
Add a device) that downloads the build for the machine, checks its SHA-256 and runs
`novad install`, piping the code in (`--code -`; `NOVA_ADD_CODE` works too) so it is not on any
command line. Before anything is written, `install` checks that the Hub's identity key
(`GET /api/v1/hello` `hubPublicKey`) hashes to `--pin`, that `novad-manifest.sig` verifies with
that key over `nova-novad-manifest-v1\n` followed by the exact bytes of `novad-manifest.json`,
and that its own binary's SHA-256 is the manifest's entry for its os and arch. It reads the
binary once and installs exactly the bytes it hashed. Any failure stops it with a message and a
non-zero exit.

It then runs Add Device v2 as `kind: novad` with an Ed25519 key held in memory: `complete` sends
the code, the key and a commitment to a secret nonce; `reveal` (signed by the key at the Hub's
clock, from its `Date` header) opens it after the Hub has fixed its own nonce. The Hub's
confirmation must equal this device's own computation and carry `hubSignature`, the pinned key's
signature over the request, the pairing, this device's key and the confirmation; otherwise it
stops ("This is not your Hub") before showing anything. Then it prints `Confirm this code on the
Hub: 123 456`, polls `status` with signed requests, and on approval writes the key, registers with
the granted `nvd_` token and the same key, keeps a granted `device-cert.pem`, writes the checked
binary to `/usr/local/bin/novad`, re-hashes it and installs and starts the service unit
(`--no-service` skips that; installing it needs root). `--dry-run` stops after the checks. The Hub
address is `http://`: novad has no TLS client yet, so the pin, the signed manifest and the signed
confirmation carry the integrity of the install (the code and tokens are visible on the LAN, as
for `enroll`; ADR-094).

## Wake Helper (FR-138, docs/22 §7)

A device whose roles include `wake-helper` accepts `POST /agent/v1/power/wake-other
{mac, broadcast?, port?}` on the management channel (same token as every management call). The
MAC must be a unicast address; `broadcast`, when given, must be an address on one of the device's
physical IPv4 subnets (from `/proc/net/route`; container bridges and tunnels do not count), else
the packet goes to every physical subnet's broadcast address; `port` is 9 (default) or 7. At most
10 wakes a minute (429 `rate_limited`); other refusals are 400 `validation`, 403 `policy_denied`
(`not_wake_helper`, `not_on_lan`) and 409 (`no_lan`). The power status the heartbeat reports
carries `lan` (interface, network, broadcast) so the Hub can choose a helper on a target's subnet.
Linux only, like Wake-on-LAN detection.

## Management channel

Until certificates arrive the Hub and the device authenticate with bearer tokens over LAN
HTTP, like compute nodes (ADR-089): the device generates the management token (`nvdm_…`, its own
prefix, distinct from Nova's MCP client tokens `nvm_…`) the Hub presents; the Hub issues the
device credential (`nvc_…`) for heartbeats. Both sides refuse a management token without the
`nvdm_` prefix, so a device enrolled before the prefix changed must be added again.

Commands (`exec`) and Code processes (`proc`) run under bubblewrap with the grantee's folders and
the same protected locations as the Hub's own sandbox (`paths.rs`, kept equal to
`packages/policy/src/paths.ts`): in each granted folder, and in every folder from it down to the
working folder, credential locations (case-insensitive, `credentials*` prefixes) are hidden with an
empty tmpfs or `/dev/null`; novad's data folder is hidden wherever a grant holds it; inside write
grants `.git` (followed through a `.git` file to its Git and common directories), `.nova`,
`.agents` and shell startup files are bound read-only. Parents are mounted before children;
locations that do not exist when the command starts are not covered.

| Source | What |
| --- | --- |
| `supervisor.rs` | Module manifest, spawn/stop/restart, backoff, crash-loop disable, JSON-lines RPC |
| `module.rs` | The module processes (`novad module <name>`): storage, management, placeholders |
| `fsops.rs`, `grants.rs`, `paths.rs` | Granted folders, protected paths, staged writes (FR-210) |
| `exec.rs`, `mcp.rs` | Sandboxed commands (bubblewrap) and local MCP pass-through |
| `install.rs` | `novad install`: Hub pin, signed manifest, self-hash, Add Device, service setup (FR-132, FR-133) |
| `power.rs` | Wakeability, WoL plans, power actions (FR-144), the Wake Helper (FR-138) |
| `update.rs` | Signed bundles, staging, health checks, rollback, self-update watchdog (FR-148) |
| `capabilities.rs` | Detection, Advanced overrides, canonical JSON and signing (FR-142) |
| `agent.rs`, `http.rs` | Enrollment, the management routes, heartbeats |
| `hardening.rs` | No core dumps, not dumpable, loader variables stripped (FR-141) |

Data directory (mode 0700): `device.json` and `key.seed` (0600), `config.json` (the owner's
settings: services, power flags, MCP servers, local overrides), `hub-config.json` (what the Hub
pushed), `modules.json` (the manifest), `storage/` (grants and the staging area) and, after an
install the trust area issued a certificate for, `device-cert.pem`.
