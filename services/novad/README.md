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
node scripts/cargo.mjs build            # target/debug/novad (the Hub's integration test runs it)

novad enroll --hub http://hub:7419 --token nvd_… --listen 0.0.0.0:7420 \
  --endpoint http://this-device:7420 [--role client|compute|wake-helper]… [--update-key KEY]
novad run [--data-dir /var/lib/nova]    # supervisor + management channel + heartbeat
novad access list | approve ID | deny ID  # folder requests decided on the device
novad wol status | plan | enable --apply  # Wake-on-LAN (changes need elevation)
novad capabilities --data-dir D --sign  # the signed document
novad service-unit --platform linux|macos|windows  # systemd unit, launchd plist, sc.exe commands
```

Until certificates arrive (M6.5) the Hub and the device authenticate with bearer tokens over LAN
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
| `power.rs` | Wakeability, WoL plans, power actions (FR-144) |
| `update.rs` | Signed bundles, staging, health checks, rollback, self-update watchdog (FR-148) |
| `capabilities.rs` | Detection, Advanced overrides, canonical JSON and signing (FR-142) |
| `agent.rs`, `http.rs` | Enrollment, the management routes, heartbeats |
| `hardening.rs` | No core dumps, not dumpable, loader variables stripped (FR-141) |

Data directory (mode 0700): `device.json` and `key.seed` (0600), `config.json` (the owner's
settings: services, power flags, MCP servers, local overrides), `hub-config.json` (what the Hub
pushed), `modules.json` (the manifest), `storage/` (grants and the staging area).
