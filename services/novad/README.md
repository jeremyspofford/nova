# novad

The Nova device agent (`docs/23`). A small supervisor that enrolls a device with the Hub,
reports a signed capability document (`contracts/schemas/device-capability.json`), serves the
management channel (`contracts/hub-api.md` §3) and runs signed, sandboxed modules as separate
processes. Dependencies are `serde`/`serde_json` plus pinned crypto crates: SHA-256/512 come
from `sha2` (RustCrypto, MIT/Apache-2.0) and Ed25519 (RFC 8032) from `ed25519-dalek`
(BSD-3-Clause), because widely reviewed, constant-time implementations are safer than hand-written
primitives; `src/crypto.rs` only adapts them and pins the FIPS 180-4 and RFC 8032 test vectors.
Verification is strict: canonical key encodings only, S < L, and no small-order key or R. TLS to
the Hub is `rustls` 0.23.45 (Apache-2.0 OR ISC OR MIT) with the `ring` 0.17.14 provider
(Apache-2.0 AND ISC; it builds with the C compiler of the Rust image, where aws-lc would need
cmake), and its certificate checks are `rustls-webpki` (ISC); the tests make their certificates
with `rcgen` 0.14.10 (MIT OR Apache-2.0, a dev dependency), so no key material is committed.
`libc` 0.2.191 (MIT OR Apache-2.0, already in the build through ring) gives the fork, setuid and
`SCM_RIGHTS` calls of the per-user sockets. The HTTP/1.1 server and client, hex/base64 and the
unified diff are in-crate.

```bash
npm run test:rust                       # cargo test, in a container when cargo is not installed
node scripts/cargo.mjs build            # target/debug/novad (the Hub's integration tests run it)

novad install --hub http(s)://hub:7419 --code ABCD-EFGH --pin <hub fingerprint> \
  [--pairing ID] [--role client|compute|wake-helper]… [--name N] [--listen 0.0.0.0:7420] \
  [--endpoint http://this-device:7420] [--user NAME]… [--no-service] [--dry-run]   # Add Device (FR-132, FR-133)
novad enroll --hub http(s)://hub:7419 --token nvd_… [--pin <hub fingerprint>] --listen 0.0.0.0:7420 \
  --endpoint http://this-device:7420 [--role client|compute|wake-helper]… [--user NAME]… \
  [--name N] [--channel stable|beta|nightly] [--update-key KEY]   # --pin is required for https://
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
command line. For an `https://` Hub the download skips the certificate check (`curl -fsSLk`,
`wget --no-check-certificate`, PowerShell `-SkipCertificateCheck`): the machine does not trust the
Hub local CA yet, and the SHA-256 in the command carries the download's integrity. Before anything
is written, `install` checks that the Hub's identity key (`GET /api/v1/hello` `hubPublicKey`)
hashes to `--pin`, that `novad-manifest.sig` verifies with
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
(`--no-service` skips that; installing it needs root). `--dry-run` stops after the checks. An
`https://` Hub is trusted through the pin (below), so the code and the tokens are not visible on
the LAN; over `http://` the pin, the signed manifest and the signed confirmation carry the
integrity of the install (ADR-094), and novad learns the Hub local CA from the Hub's signed
identity statement so it can use HTTPS later. `--user NAME` (repeatable; by default the user who
ran `sudo`, never root) names the users who get a local runtime socket (below), stored as
`config.json` `localRuntime.users`.

## TLS to the Hub (R-023, FR-126, FR-134; `src/tls.rs`)

novad trusts an `https://` Hub the way `docs/22` §5 tells native shells to, with the fingerprint
pinned at Add Device (`--pin`, kept in `hub-trust.json`):

- A certificate issued by the Hub local CA that a verified statement vouched for (issuer,
  signature, validity, serverAuth and a SAN for the host dialed; the CA's name constraints
  apply), or one whose SHA-256 a verified statement listed (the Hub's leaf, a mesh certificate),
  is trusted at once.
- Otherwise the connection is provisional: before anything else is sent on it, novad asks for
  `GET /api/v1/trust/identity?nonce=<fresh>` on that same connection and checks the statement:
  the key hashes to the pin, the Ed25519 signature verifies over `nova-hub-identity-v1\n` and the
  JSON of the fields in the Hub's order, the nonce is this one, and the chain shown is listed or a
  server certificate of the listed CA (device certificates and CAs never pass). Anything else
  stops with "This is not your Hub". What it vouched for is cached. novad has no platform trust
  store, so `pinning: off` changes nothing (stricter, never weaker).
- With `device-cert.pem` (Add Device in local-CA mode) every trusted connection presents it as the
  client certificate, signed with the device key (mutual TLS). A provisional connection never
  does; after the statement check novad reconnects with it. A Hub that refuses the certificate
  (revoked, another device's) is named in the error or the log (`certificate_revoked`, …).
- A device enrolled over `http://` (with a pin) moves to `https://` on the same address the first
  time the Hub stops answering plain HTTP and the pinned identity vouches for its certificate (at
  most one try a minute). It never moves back to plain HTTP.

## Local runtime (FR-128; `src/local_runtime.rs`, docs/23 §4.3)

On client devices the `local-runtime` module proxies an OpenAI-compatible model server on the
device (`config.json` `localRuntime.upstream`, `http://` only, default `http://127.0.0.1:11434/v1`)
to local clients (the desktop shell, for the web app it shows), so they keep working with local
models while the Hub is unreachable. It serves `GET /v1/models` and `POST /v1/chat/completions`,
`/v1/completions` and `/v1/embeddings` (anything else is 404), passing on only `content-type` and
`accept` and streaming the answer as the server sends it. Limits: 16 MiB per request, 256 MiB per
answer, 32 connections, 300 s of silence from the server (502 `node_unavailable` when it does not
answer).

- Authenticated local clients only (FR-192): the Unix socket `local-runtime/runtime.sock` (mode
  0600 in a 0700 folder), and, if the owner sets `localRuntime.listen` to a loopback `HOST:PORT`,
  that address with the bearer token in `local-runtime/token` (0600, `nvlr_…`; else 401
  `token_required`). Requests there must name that loopback address as their Host
  (`host_not_allowed`) and carry no Origin unless `localRuntime.allowedOrigins` lists it
  (`origin_not_allowed`).
- A socket for each user in `localRuntime.users` (`novad install|enroll --user NAME`, repeatable;
  by default the user who ran sudo, never root), since novad's own socket belongs to root
  (`src/user_socket.rs`): `/run/user/<uid>/nova/runtime.sock` on Linux (the desktop shell looks in
  `$XDG_RUNTIME_DIR/nova/`), `~/Library/Application Support/Nova/run/runtime.sock` on macOS. The
  folder is 0700 and the socket 0600, both owned by the user, and the same admission applies. The
  module checks every 30 s, so the socket appears after login and stops serving after logout.
  Root never creates, changes or follows anything in the user's folder: a forked child switches to
  the user's ids (`setgroups`, `setgid`, `setuid`), makes the folder and binds with umask 077, and
  hands the listening descriptor back over a socket pair (`SCM_RIGHTS`); root then only re-reads
  the metadata (a 0600 socket of the user with one link, the inode the child reported). A link or
  another file where novad's folder or socket goes is refused. Users are looked up with `id`. Each
  connection (root's socket or a user's) takes one of the 32 slots before a thread starts and
  loses it after 30 s without a byte of its request or 60 s without reading the answer. There is no
  peer-credential check (the file mode is the authentication), and no Windows named pipe yet. A
  novad that does not run as root can make a socket only for its own user (`status` says why for
  the others).
- Only with the Hub's grant: every request answers 403 `scope_missing` unless the last heartbeat
  answer granted `local-runtime` (Add Device or the device page; kept in `scopes.json`, so the
  grant holds while the Hub is down; no answer yet means no grant, and enrolling again deletes the
  old grant).
- The module is listed in the capability document's `modules`, and its models go in as
  `services.computeBackends: ["local-runtime"]` and `services.modelsPresent`.

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

The Hub and the device authenticate with bearer tokens, like compute nodes (ADR-089): the device
generates the management token (`nvdm_…`, its own prefix, distinct from Nova's MCP client tokens
`nvm_…`) the Hub presents; the Hub issues the device credential (`nvc_…`) for registration,
heartbeats and capability updates, which go over HTTPS when the Hub serves it, with the device
certificate when Add Device issued one (mutual TLS; plain HTTP otherwise). The management channel
the Hub calls (`--endpoint`, always `http://`) is still bearer tokens over plain HTTP on the LAN
(R-022). Both sides refuse a management token without the
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
| `tls.rs` | TLS to the Hub: pinned identity statement, Hub CA cache, device certificate (R-023, FR-126) |
| `local_runtime.rs` | The local runtime module: local model proxy behind the Hub's grant (FR-128) |
| `user_socket.rs` | The local runtime's per-user sockets in each user's runtime folder (FR-128, FR-192) |
| `power.rs` | Wakeability, WoL plans, power actions (FR-144), the Wake Helper (FR-138) |
| `update.rs` | Signed bundles, staging, health checks, rollback, self-update watchdog (FR-148) |
| `capabilities.rs` | Detection, Advanced overrides, canonical JSON and signing (FR-142) |
| `agent.rs`, `http.rs` | Enrollment, the management routes, heartbeats |
| `hardening.rs` | No core dumps, not dumpable, loader variables stripped (FR-141) |

Data directory (mode 0700): `device.json` and `key.seed` (0600), `config.json` (the owner's
settings: services, power flags, MCP servers, local overrides), `hub-config.json` (what the Hub
pushed), `modules.json` (the manifest), `storage/` (grants and the staging area), `hub-trust.json`
(0600: the pin and the Hub CA and certificates verified statements vouched for), `scopes.json`
(what the Hub granted), `local-runtime/` and, after an install the trust area issued a certificate
for, `device-cert.pem`. `config.json` `localRuntime` holds `upstream`, `listen`, `allowedOrigins`
and `users`.
