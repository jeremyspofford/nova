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
`SCM_RIGHTS` calls of the per-user sockets. `ring` 0.17.14 is also a direct dependency (the same
crate rustls builds) for the one SHA-1 RFC 6455 requires in the WebSocket handshake of the
browser's DevTools relay (`src/ws.rs`). The HTTP/1.1 server and client, the WebSocket codec,
hex/base64 and the unified diff are in-crate.

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
novad uninstall [--purge]               # remove the service and wipe the identity (docs/23 §11)
novad bridge enable|disable             # as the user: the extension bridge (FR-096)
novad bridge-host                       # what the browser starts for the extension
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

## Local browser (FR-209; `src/browser.rs`, `src/egress.rs`, docs/11 §4.6)

The `browser` module (on client devices by default) runs a clean Chromium for an agent whose own
browser a site blocked, once the user consented on the Hub for that site. The Hub calls
`POST /agent/v1/browser/launch {sessionId, grantee, allowHosts, headless?}` →
`{sessionId, cdpPath}`, `/browser/close {sessionId}` → `{closed: true, egress: {allowed,
refused}}` and `/browser/list`, then drives the browser over the DevTools protocol at
`GET /agent/v1/browser/cdp/<sessionId>`.

- The browser: `config.json` `browser.executablePath`, else the usual Chromium-family install
  paths (none: 409 `capability_missing` `{reason: no_browser}`). At most 2 sessions (409
  `conflict` `{reason: session_limit}`; a repeated id is `session_exists`). Each gets a fresh
  profile (0700) under `browser.profileRoot` (default `<tmp>/nova-browser-<hash of the data
  folder>`, 0711, a folder of novad's user), deleted when the session closes; leftover `s-…`
  profiles of a crash go when the module starts. Chromium speaks DevTools over a pipe and opens no
  port (`--remote-debugging-pipe`: it reads fd 3 and writes fd 4, NUL-terminated JSON), and gets
  `--proxy-server` for the session's egress filter, `<-loopback>` so loopback goes through it too,
  and WebRTC off UDP. A session is ready when the browser answered novad's own
  `Browser.getVersion` (its `product` shows in `/browser/list` as `browser`); a browser that exits
  at start or does not answer within 20 s is 503 `{reason: browser_start_failed}` with the tail
  of its output. A visible (`headless: false`) browser needs a display.
- `allowHosts` entries novad cannot use (`*.dev`, an IP, a number) are skipped and listed in the
  answer as `skippedHosts: [{host, reason}]`; the launch is refused (400) only when none is left.
- A session with no DevTools client for 10 minutes is closed, and every session after 4 hours.
- Who it runs as: a novad that is not root runs Chromium as itself. Chromium never runs as root,
  as `nobody` or as a user of group root: a root novad runs each session as its own dedicated
  user (`nova-browser1`, `nova-browser2`: `useradd --system --user-group`, made by `novad install`
  and `novad enroll` as root for a client, removed by `novad uninstall`; `browser.runAs` may name
  others, a name or a list), so no other process shares the browser's uid and its DevTools pipe.
  An unsafe `runAs` is 403 `{reason: unsafe_browser_user}`; no such user, or none free, is 409
  `{reason: no_browser_user | no_free_browser_user}` (fail closed). The profile is owned by that
  user, in novad's own 0711 folder `nova-browser-<hash>` inside `browser.profileRoot` (which novad
  never changes or cleans; it must be passable, o+x). It is spawned on novad's spawner
  thread (`hardening::spawn_kept`: the parent-death signal follows the thread that forked, so a
  child spawned on a request's thread would die with it; modules and Code processes are spawned
  the same way) in its own process group, which is killed on close: SIGTERM, then SIGKILL to the
  group before the browser is reaped, so the group id cannot have been reused.
- The DevTools WebSocket: the management token first (401), no `Origin` (403 `origin_rejected`),
  a WebSocket upgrade with a 16-byte key (400 otherwise). The supervisor then connects to the
  module's DevTools socket (`<data>/browser/cdp.sock`, 0600 in a 0700 folder) and names the
  session (404 when the module has none; 503 `{reason: module_unavailable}` without the module),
  answers the handshake itself (no extension or subprotocol) and relays: each text message to the
  pipe, each of the browser's messages back as a text frame (`src/ws.rs`: client frames masked,
  fragments joined, ping answered, binary refused with 1003, invalid UTF-8 or a NUL in a message
  1007, 64 MiB per message either way, 1009 past it; the client is decoded one read at a time). The module passes only whole messages, so a connection that
  ends mid-message leaves nothing for the next. One connection per session: a newer one replaces
  the older (closed with 1001); closing the session closes it with 1001. Over mutual TLS the same
  runs on the TLS stream.
- The egress filter (one per session, `127.0.0.1:<free port>`): CONNECT and absolute `http://`
  requests only (400 otherwise), to ports 80 and 443 only; only `allowHosts` (exact names,
  `*.name` for the names under it);
  IP literals and numeric names refused; the name is resolved by novad and refused when any
  address is private, loopback, link-local, multicast, unspecified, CGNAT, unique-local or
  reserved (IPv4-mapped, NAT64 and 6to4 judged by their IPv4 address), then the checked address is
  dialed. No TLS inspection. 64 connections at most, 30 s for a request head, 5 minutes idle. It
  logs hosts and decisions (never URLs) and counts them. It has no token: Chromium cannot present
  proxy credentials, and it only narrows what a local process can already reach.

## Extension bridge (FR-096; `src/bridge.rs`, docs/11 §4.3, docs/12 §15)

The user's own browser reaches the Hub through Nova's extension and this device's novad only.

- `novad bridge enable`, run by the user (refused as root): writes `~/.config/nova/bridge-token`
  (`nvbr_…`, 0600 in a 0700 folder) and `ai.nova.bridge.json` into `NativeMessagingHosts` of each
  Chromium-family browser whose own config folder exists in the user's home (Chromium, Chrome,
  Edge, Brave, Vivaldi; `$XDG_CONFIG_HOME` honored; macOS Application Support), with `path` this
  binary and `allowed_origins` only `chrome-extension://<bridge.extensionId>/`. The id is the
  device owner's `config.json` `bridge.extensionId` (required), read from novad over the bridge
  socket when the user cannot read the config. `novad bridge disable` removes the manifests and the
  token. Nothing else is written into a browser's configuration, and the installer writes none.
- The host (`novad bridge-host`, or `novad chrome-extension://…/` as the browser starts it): native
  messaging on stdin/stdout (4-byte native-endian length + JSON, at most 1 MiB), relayed with the
  same framing to `bridge.sock` beside the local runtime's socket (`/run/user/<uid>/nova/`,
  macOS `~/Library/Application Support/Nova/run/`). It says `hello {role: host, token, origin}`,
  reports `{type: status, connected, reason?}` to the extension, then passes only `call` frames to
  the extension and only `result`, `error` and `event` frames to novad.
- The browser module binds `bridge.sock` for each user in `localRuntime.users` exactly as the local
  runtime binds its socket (as the user, 0600 in 0700, links refused, re-checked every 30 s). A
  connection must come from that user's uid (kernel peer credentials), present the token in that
  user's token file (read by a child that switched to the user's ids, without following links;
  0600, regular, the user's) and, for a host, the configured extension's origin
  (`bridge_not_configured`, `origin_not_allowed`, `token_required` otherwise). One host at a time:
  a newer host of the same user replaces it (novad reports `disconnected` for the older one, then
  `connected`); a host of another OS user is refused (`bridge_busy`) until the connected one is
  gone.
- `POST /agent/v1/bridge/call {method, params?, timeoutMs?}` → `{result}` or `{error: {code,
  message}}`; methods `tabs.list`, `tabs.open`, `tab.attach`, `tab.detach`, `cdp.send`,
  `history.search`; `timeoutMs` 1,000 to 120,000 (default 30,000; 504 `{reason: bridge_timeout}`);
  no host (or no browser module): 409 `bridge_offline`. `POST /agent/v1/bridge/status` →
  `{configured, connected, user, since, users}`.
- Events: the extension's `tab.shared`, `tab.unshared`, `tab.closed`, `host.granted`,
  `host.revoked` (others dropped, 16 KiB each) and novad's `connected` and `disconnected` (with
  `user`), each stamped `at`, are queued (500, oldest dropped) and posted by the supervisor to the
  Hub's `POST /agent/v1/bridge/events {events}` (at most 100 and under 900 KiB a post) with the
  device credential, over the heartbeat's TLS. What the Hub does not take is retried after 5xx,
  408 and 429; a 413 halves the batch (a single event that still does not fit is dropped), any
  other 4xx drops the batch with a log line.

Native messaging shapes (host ↔ extension): novad → extension `{type: "call", id, method,
params}`; extension → novad `{type: "result", id, result}`, `{type: "error", id, error: {code,
message}}`, `{type: "event", event: {kind, …}}`; host → extension `{type: "status", connected,
reason}`.

## Uninstall and decommission (docs/23 §11; `src/uninstall.rs`)

`novad uninstall` (root when a service is installed) runs `systemctl disable --now` (macOS
`launchctl unload -w`, Windows `sc.exe stop|delete`), removes the unit, the installed binary and
the browser users (`userdel`), removes the bridge's host manifests and token from the homes of
the users in `localRuntime.users` (as each user, by a forked child that switched to their ids),
and wipes `key.seed` (zeroed first), `device.json`, `device-cert.pem`, `hub-trust.json`,
`hub-key.json`, `scopes.json`, `policy.json` and the local runtime's token and socket.
`--purge` also deletes the data folder, only one marked as novad's (`.novad-data`, written when
novad makes the folder, or its `device.json`, `key.seed` and `modules.json` together), and never
`/`, a folder right under it, a system folder or a home folder.

`POST /agent/v1/decommission {purge?, authorization}` (D9) needs a Hub-signed `device.decommission`
authorization for exactly this body (`src/authz.rs`; over mutual TLS on a device with a
certificate). novad stops every module, forgets its credential and management token at once
(later calls are 401), wipes the same files and answers `{decommissioned, purge, wiped,
service}`. Half a second later it removes the users' bridge files and deletes the folder when
`purge`, then hands the rest to a transient unit (`systemd-run --on-active=3`), because the
service cannot write /etc or /usr under ProtectSystem=full and stopping it ends novad: that unit
disables the service, removes the unit file and the binary, reloads systemd, removes the browser
users and only then stops novad (macOS: the files first, then `launchctl bootout`; Windows:
`sc.exe delete`, then `stop`). Without a service novad exits at its next heartbeat. The authorization replay store stays
until the folder goes. novad installs no BIOS management credentials, so there are none to clear.

## Management channel

The Hub and the device authenticate with bearer tokens, like compute nodes (ADR-089): the device
generates the management token (`nvdm_…`, its own prefix, distinct from Nova's MCP client tokens
`nvm_…`) the Hub presents; the Hub issues the device credential (`nvc_…`) for registration,
heartbeats and capability updates, which go over HTTPS when the Hub serves it, with the device
certificate when Add Device issued one (mutual TLS; plain HTTP otherwise). The management channel
the Hub calls is mutual TLS once the device holds a certificate (below; closes R-022 for those
devices) and bearer tokens over plain HTTP on the LAN otherwise. Both sides refuse a management
token without the `nvdm_` prefix, so a device enrolled before the prefix changed must be added
again. Since 0.7.0 `POST /agent/v1/services` lists the services the owner declared in
`config.json` with their state (`{services: [{name, kind, state, …}]}`; one that cannot be read
shows `state: unknown` and its error), next to the per-service
`/agent/v1/services/:name/{start,stop,restart,status}`.

### Mutual TLS on the management channel (D1 of ADR-096; `src/mgmt_tls.rs`)

With `device-cert.pem` the management server speaks TLS 1.3 only (client certificates travel
encrypted), presents the device certificate with the device's own Ed25519 key, and requires a
client certificate that chains to the cached Hub local CA (`hub-trust.json`), has EKU clientAuth
and the URI SAN `urn:nova:hub:<pinned fingerprint>` (another device's certificate from the same CA
is refused); the bearer management token is still checked. The configuration is read per
connection, so a CA learned later applies at once; without a cached CA, or with a certificate for
another key, every connection is refused (logged at most once a minute), never served over plain
HTTP. novad registers and heartbeats its endpoint as `https://` then (`endpoint` in the heartbeat
body). The Hub checks the device by chain and `urn:nova:device:<id>`, never by host name, so the
device certificate carries serverAuth as well as clientAuth. Privileged requests (firmware apply
and rollback, boot set, commit and revert, decommission) that reach a plain server on a device
with a certificate are 403 `policy_denied` `{reason: tls_required}`.

Renewal: a heartbeat answer may carry `certificate: {pem, notAfter}` (for a certificate without
serverAuth, issued in M7, or with a third of its life left). novad accepts it only when it chains
to the cached Hub CA, is valid now, has serverAuth and clientAuth, holds the device's own Ed25519
key and names `urn:nova:device:<id>`, and only as a renewal (a device without a certificate never
gets one this way); it then replaces `device-cert.pem` atomically (0600). The listener stays up
and each new connection uses the new certificate; the calls to the Hub present it from the next
request. A refusal (`wrong_key`, `wrong_device`, `untrusted`, `expired`, `not_yet_valid`,
`missing_server_auth`, `missing_client_auth`, `not_pem`, `no_ca`) is logged and the current one
kept. A certificate without serverAuth is served as it is until its renewal arrives; the Hub
decides whether to accept it.

### Hub-signed authorizations (D2; `src/authz.rs`)

Privileged requests carry `authorization: {payload, signature}`: `payload` is `{v: 1, kind,
deviceId, changeId (UUIDv7), bodySha256, approvalId, issuedAt, expiresAt}` (`expiresAt` at most 10
minutes after `issuedAt`; ISO timestamps or epoch milliseconds), signed with Ed25519 by the Hub
identity key over `"nova-device-authz-v1\n"` + the payload's canonical JSON (base64url).
`bodySha256` is the hex SHA-256 of the body's canonical JSON without `authorization` (also
accepted: without `adminPassword` too). The key is the one the pinned fingerprint names: read once
from the Hub's `GET /api/v1/hello` and kept in `hub-key.json` only when it hashes to the pin.
novad checks the signature, its own device id, the kind of the route, the body hash and the time
window (120 s skew), then spends the change id (`authz-replay.json`, 24 h, at most 4096; a store
that cannot be read refuses every privileged request, 500 `{reason: replay_store_unreadable}`). Refusals:
403 `policy_denied` `{reason: authorization_invalid | authorization_expired |
authorization_mismatch}`, 409 `conflict` `{reason: replayed}`. The Rust tests verify the Hub's
vectors (`packages/core/test/fixtures/device-authz-vectors.json`), copied to
`tests/fixtures/device-authz-vectors.json` because the containerized cargo sees only this crate; a
native `cargo test` fails when the copy drifts.

The Hub's toggles arrive in every heartbeat answer as `policy: {firmwareChanges, lowLevelBoot}`
and are kept in `policy.json` (0600, deleted at enrollment like `scopes.json`); anything but
`true` is off, and so is a damaged file. The Hub also pushes a change at once through
`POST /agent/v1/config` with the toggles inside `policy` (beside `allowedModules` and the other
per-device fields): a toggle present sets it, an absent one keeps it, and toggles sent alone leave
the rest of the policy as it is. The answer adds `policy: {firmwareChanges, lowLevelBoot}`, the
toggles now in effect.

### BIOS/firmware settings (FR-146, docs/23 §6; `src/firmware.rs`)

Routes (all `POST`): `firmware/read {}` → `{supported, reason?, platform: {vendor, product,
biosVendor, biosVersion, biosDate, uefi}, method, adminPasswordSet, settings: [{key, vendorKey,
value, type: enum|order|string|int, allowed, readOnly, securityDegrading}], updates: [{device,
version, summary}]}`; `firmware/plan {changes: [{key, value}]}` → `{planId, snapshot: {id,
takenAt, values, sha256}, diff: [{key, vendorKey, from, to, securityDegrading}], refused: [{key,
reason: unknown_key|read_only|not_allowed_value|unsupported}], requiresReboot}`; `firmware/apply
{planId, snapshotId, changes, reboot?, watchdogSeconds? (120-3600, 600), allowSecurityDegrading?,
adminPassword?, authorization}` → `{applied: [{key, from, to}], pendingReboot, watchdog:
{deadline}|null}`; `firmware/rollback {snapshotId, snapshot?: {values, sha256},
allowSecurityDegrading?, adminPassword?, authorization}` → `{restored: [{key, from, to}]}`.

- Every route needs the `firmware` module allowed for the device (`allowedModules`, 403
  `module_not_allowed`); apply and rollback also need `firmwareChanges` (403 `firmware_disabled`)
  and an authorization of kind `firmware.apply` or `firmware.rollback`.
- Only `wol`, `powerOnAfterPowerLoss`, `bootOrder`, `virtualization`, `secureBoot`, `tpm` and
  `fanProfile` exist. Backends: the kernel firmware-attributes class (Dell `dell-wmi-sysman`,
  Lenovo `thinklmi`, HP `hp-bioscfg`; vendor names in `firmware.rs`), generic UEFI boot order
  through `efibootmgr`, and a fake (`config.json` `firmware: {backend: "fake", fakePath}`). The
  platform comes from `/sys/class/dmi/id`. ASUS, Supermicro, other vendors and other systems are
  refused: `supported: false` with `reason` (`vendor_not_supported`, `driver_missing`,
  `tool_missing`, `os_not_supported`, `disabled_by_owner`), and the other routes are 409
  `conflict` `{reason: unsupported_hardware, detail}` with that reason as `detail` (so is every
  boot route but status on a machine without a manageable bootloader). `fwupdmgr get-updates --json` (10 s) lists updates read-only.
- A plan snapshots every allowlisted value (`firmware/snapshots/<id>.json`, 0600, the last 20).
  Apply writes only when the values still equal the snapshot (409 `conflict` `{reason:
  base_mismatch}`), refuses Secure Boot or TPM off without `allowSecurityDegrading: true` (403
  `{reason: security_degrading}`), needs `adminPassword` when the BIOS has one (403 `{reason:
  admin_password_required}`; only over mutual TLS, else 403 `{reason: tls_required}`; written to
  `authentication/Admin/current_password` and cleared after, never stored), and restores what it
  wrote when a write fails (500 `{reason: apply_failed, restored, key}`). A boot order is only
  reordered, never shortened or extended.
- With `reboot: true` novad checks first that it may restart (409 `{reason: reboot_unavailable}`
  without the owner's `power.allowActions`), writes `firmware/pending.json` before the first BIOS
  write (removed again when the change fails), answers, and restarts through the power module.
  After the restart the first heartbeat the Hub accepts before the deadline reports `{kind:
  "firmware.watchdog.ok", snapshotId, changeId, at, detail}`; the deadline passing first restores
  the snapshot key by key and reports `firmware.watchdog.reverted` (`detail: {reason: deadline,
  complete, restored: [{key, from, to}], failed: [{key, from, to, error}], rebooted}`; a key that
  cannot be written, for example on a BIOS with an admin password, stays as it is and the ones
  restored stay restored). Only a complete revert restarts, once. A restart that never happened is reverted at the
  deadline without a restart (`reason: not_restarted`). The same snapshot never gets a second
  watchdog (409 `{reason: watchdog_already_used}`: plan again). Events wait in
  `firmware/events.json` until a heartbeat delivers them.
- The power status reports `afterPowerLoss` (`on`, `off`, `last`) from the BIOS backend.

### Low-level boot (FR-143, docs/23 §5.2; `src/boot.rs`)

Routes: `boot/status {}` → `{supported, reason?, bootloader: systemd-boot|grub|uefi|fake|none,
entries: [{id, title, isDefault}], booted, pending: {profileId, entryId, deadline}|null, last:
{profileId, entryId, result: ok|reverted|failed, at}|null}`; `boot/set {profileId, entryId,
watchdogSeconds?, reboot?, authorization}` → `{pending}`; `boot/commit {profileId, entryId,
authorization}` → `{committed, entries}`; `boot/revert {authorization}` → `{reverted, pending:
null}`. Set and commit need `lowLevelBoot` (403 `{reason: low_level_boot_off}`); revert needs only
its authorization.

- A set is a one-shot next boot (`bootctl set-oneshot`, `grub-reboot`, `efibootmgr --bootnext`), so
  a machine that never comes up returns to its default by itself; commit makes it the default
  (`bootctl set-default`, `grub-set-default`, `efibootmgr --bootorder`). Detection (`config.json`
  `boot.backend`, default `auto`): systemd-boot (`bootctl is-installed`), then GRUB (`grub.cfg` and
  `grub-reboot` or `grub2-reboot`; entries and `submenu>entry` ids read from `grub.cfg`, the
  default from `grubenv`), then UEFI boot entries; `fake` reads a JSON file. Every tool runs
  through the hardened child-process helper with a 10 s limit, never a shell.
- Watchdog: `boot/pending.json` with the deadline and the boot id, written before the one-shot
  (removed again when it fails). After a restart, the first accepted heartbeat reports
  `boot.watchdog.ok` (`{kind, profileId, entryId, changeId, at, detail: {booted, verified}}`);
  `verified` is false when the bootloader cannot show the boot was the one-shot (GRUB: `next_entry`
  still set in grubenv, or `/proc/cmdline` names another kernel than the entry's `linux` line).
  Booted into another entry: one-shot cleared, `boot.watchdog.reverted` (`reason: not_booted`, no
  restart); the deadline first: one-shot cleared, `boot.watchdog.reverted` (`reason: deadline`),
  and one restart into the default only when the machine is on the pending entry or cannot tell;
  never restarted by the deadline: cleared without a restart (`reason: not_restarted`). On GRUB,
  commit needs grub.cfg to boot `saved_entry` (GRUB_DEFAULT=saved; 409 `{reason:
  grub_default_not_saved}` otherwise), and the default shown is what grub.cfg really boots. The
  systemd unit keeps `/boot/grub`, `/boot/grub2`, the ESP and the EFI variables writable
  (`ReadWritePaths`); BIOS settings are under /sys, which `ProtectSystem=full` does not touch.
  Kernel arguments in profiles are not built.

Commands (`exec`) and Code processes (`proc`) run under bubblewrap with the grantee's folders and
the same protected locations as the Hub's own sandbox (`paths.rs`, kept equal to
`packages/policy/src/paths.ts`): in each granted folder, and in every folder from it down to the
working folder, credential locations (case-insensitive, `credentials*` prefixes) are hidden with an
empty tmpfs or `/dev/null`; novad's data folder is hidden wherever a grant holds it; inside write
grants `.git` (followed through a `.git` file to its Git and common directories), `.nova`,
`.agents` and shell startup files are bound read-only. Parents are mounted before children;
locations that do not exist when the command starts are not covered. /sys, /proc, /dev, /boot,
/efi and /etc are never granted, resolved or used as a working folder, so BIOS settings and EFI
variables change only through the firmware and boot routes with a Hub-signed authorization.

| Source | What |
| --- | --- |
| `supervisor.rs` | Module manifest, spawn/stop/restart, backoff, crash-loop disable, JSON-lines RPC |
| `module.rs` | The module processes (`novad module <name>`): storage, management, local runtime, browser, placeholders |
| `fsops.rs`, `grants.rs`, `paths.rs` | Granted folders, protected paths, staged writes (FR-210) |
| `exec.rs`, `mcp.rs` | Sandboxed commands (bubblewrap) and local MCP pass-through |
| `install.rs` | `novad install`: Hub pin, signed manifest, self-hash, Add Device, service setup (FR-132, FR-133) |
| `tls.rs` | TLS to the Hub: pinned identity statement, Hub CA cache, device certificate (R-023, FR-126) |
| `local_runtime.rs` | The local runtime module: local model proxy behind the Hub's grant (FR-128) |
| `user_socket.rs` | Per-user sockets in each user's runtime folder (local runtime, bridge), reading a user's file as the user (FR-128, FR-192) |
| `browser.rs`, `ws.rs`, `egress.rs` | The browser module: sessions, the DevTools pipe and its WebSocket, the per-session egress filter (FR-209) |
| `bridge.rs` | The extension bridge: native-messaging host, bridge sockets, calls, events, `bridge enable` (FR-096) |
| `uninstall.rs` | `novad uninstall` and the Hub's decommission (docs/23 §11) |
| `power.rs` | Wakeability, WoL plans, power actions (FR-144), the Wake Helper (FR-138) |
| `update.rs` | Signed bundles, staging, health checks, rollback, self-update watchdog (FR-148) |
| `capabilities.rs` | Detection, Advanced overrides, canonical JSON and signing (FR-142) |
| `agent.rs`, `http.rs` | Enrollment, the management routes, heartbeats |
| `mgmt_tls.rs`, `authz.rs` | The management channel over mutual TLS, Hub-signed authorizations (D1, D2) |
| `firmware.rs`, `boot.rs` | BIOS settings, low-level boot, their watchdogs (FR-146, FR-143) |
| `hardening.rs` | No core dumps, not dumpable, loader variables stripped (FR-141); `spawn_kept`, the one long-lived thread that starts modules, Code processes and browsers so they outlive the request that asked |

Data directory (mode 0700): `device.json` and `key.seed` (0600), `config.json` (the owner's
settings: services, power flags, MCP servers, local overrides), `hub-config.json` (what the Hub
pushed), `modules.json` (the manifest), `storage/` (grants and the staging area), `hub-trust.json`
(0600: the pin and the Hub CA and certificates verified statements vouched for), `scopes.json`
(what the Hub granted), `local-runtime/` and, after an install the trust area issued a certificate
for, `device-cert.pem`; `policy.json`, `hub-key.json` and `authz-replay.json` (0600), `firmware/`
and `boot/` (snapshots, watchdog markers, event outboxes). `config.json` `localRuntime` holds `upstream`, `listen`, `allowedOrigins`
and `users`; `browser` holds `executablePath`, `runAs` and `profileRoot`; `bridge` holds
`extensionId`; `firmware` holds `backend` and `fakePath`; `boot` holds `backend`, `fakePath` and
`grubCfg`.
