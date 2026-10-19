# REST APIs (Optional Server Components)

These APIs exist only for optional cloud features (sync, relay, catalog, cloud runner). The
Hub never requires them. All endpoints are versioned under `/v1` and authenticated with a
device/account token. **The server is content-blind for user content.**

Default hosted endpoints (all configurable / self-hostable):

| Service | Default |
| --- | --- |
| Catalog | `https://catalog.arialabs.ai` (also `https://catalog.<tailnet>.ts.net`) |
| Relay | `wss://relay.arialabs.ai` |
| Sync | `https://sync.arialabs.ai` (not used: the Hub plays the sync service, §2) |
| Auth | `https://auth.arialabs.ai` |
| Cloud runner | `https://runner.arialabs.ai` |

## 1. Auth

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/auth/device` | Begin device authorization (returns user_code, verification_uri) |
| `POST` | `/v1/auth/token` | Exchange device code for access + refresh tokens |
| `POST` | `/v1/auth/refresh` | Refresh an access token |
| `POST` | `/v1/auth/revoke` | Revoke a device/token |

Tokens are short-lived; refresh tokens rotate. Device identity is an Ed25519 keypair; the
public key is registered at link time.

## 2. Sync

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/sync/cursor` | Current server cursor for the account |
| `POST` | `/v1/sync/push` | Upload encrypted entity changes `{deviceId, ops:[{entityKind,entityId,revision,ciphertext,nonce}]}` |
| `GET` | `/v1/sync/pull?since=<cursor>` | Download encrypted changes since a cursor |
| `GET` | `/v1/sync/devices` | List linked devices + public keys |
| `POST` | `/v1/sync/devices` | Register a new device (signed by an existing device) |
| `DELETE` | `/v1/sync/devices/:id` | Revoke a device |

- Payloads are opaque ciphertext; the server validates only structure, size, and account scope.
- The server stores a monotonically increasing cursor per account.
- Conflict resolution happens client-side (ADR-010); the server does not merge.

*Amended in M7* (decision 1 of ADR-095). This standalone store-and-forward sync service is not
built in v1, and `https://sync.arialabs.ai` is not used. The Hub is canonical (ADR-033) and plays
the sync service itself: a client whose device session has the `offline-replica` scope syncs its
encrypted local replica with the Hub through `/api/v1/sync/*` (`contracts/hub-api.md`, "Sync"),
over LAN, Mesh or the Relay tunnel. The Relay is the content-blind path: it forwards sealed
envelopes and never sees the replica's content. Differences from the table above:

- **No ciphertext on the server side.** The Hub holds the canonical plaintext (encrypted at rest
  like the rest of its data); the replica is sealed on the device (in the web app, AES-GCM under a
  non-extractable key in IndexedDB).
- **The Hub merges.** Pushed ops are field changes `{kind, id, field, value, hlc, base?}`, merged
  per field last-writer-wins by hybrid logical clock (ADR-010); the losing value goes to a merge
  log the owner can restore from. The device does not merge; it applies the change feed.
- **Routes.** `GET /api/v1/sync/snapshot` (paged current state; replaces `cursor` plus a first
  `pull`), `GET /api/v1/sync/changes?since=` (replaces `pull`), `POST /api/v1/sync/push`,
  `GET /api/v1/sync/merge-log` and `POST …/:id/restore`, `GET /api/v1/sync/devices` and
  `POST …/:id/reset`. Linking a device is Add Device with the `offline-replica` scope
  (`docs/22` §4); revoking it is the Hub's device revocation (no separate device registry).
- **Idempotency.** Writes a client queued offline carry `Idempotency-Key`; the Hub answers a
  repeat with the first answer for 24 hours (`contracts/hub-api.md`, "Idempotent writes").

## 3. Relay (channels, mobile, notifications)

The Relay forwards sealed envelopes between the Hub and paired clients that both connect **out**
to it (FR-137, ADR-071, `docs/22` §3). It sees routing ids, frame kinds, sequence numbers and
sizes, never content, and it stores nothing beyond routing registrations and queued
ciphertext awaiting delivery.

*As built in M6.5* (ADR-094). The self-hostable Relay is `services/relay` (`@nova/relay-service`,
Node 24, default port 7430); the protocol library both sides use is `packages/relay`
(`@nova/relay`); the Hub's connector is `packages/core/src/relayhub`. The hosted default
(`wss://relay.arialabs.ai`) is used only when `relay.selfHosted` is off and no URL is set. Push
senders are a recording mock (real APNs and FCM senders are M7), and the channel relay routes
answer 501 (M7). *As built in M7* (ADR-095): the real APNs and FCM senders are in the Relay,
off unless the operator configures them (below), and the Hub asks the Relay to push to its native
clients (`POST /v1/relay/push/notify`); the Hub's connector sends a registration token when
`relay.registrationTokenRef` names one; the channel relay routes still answer 501 (not built).
`services/relay` and `packages/relay` are Apache-2.0 (ADR-023) and the Relay logs JSON lines with
its own logger (values under secret-looking keys never reach a line). Errors use the shape in §6 with these codes: `validation` (400), `auth_missing`
(401), `invalid_code` (401), `not_found` (404), `conflict` (409), `expired` (410),
`rate_limited` (429), `not_implemented` (501), `relay_full` (503).

### 3.1 Endpoints

The routes a client calls from a browser page (`/v1/relay/health`, `/v1/relay/pairings/:id/claim`,
`/v1/relay/push/register`) answer cross-origin requests: a preflight gets 204 with
`Access-Control-Allow-Origin: *`, methods `GET, POST` and headers `content-type, authorization`,
and their answers carry `Access-Control-Allow-Origin: *`. Credentials are never allowed (claims
are sealed and pushes carry a route token). The Hub routes stay same-origin only. The Hub, in turn,
adds the Relay's https and wss origins (http and ws for a plain self-hosted Relay), whichever of
the four schemes `relay.url` is given in, to its own `connect-src` while `relay.enabled` is on, so
its pages can reach the Relay.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/relay/connect` | WebSocket upgrade with a route token; every frame is a [`RelayEnvelope`](schemas/relay-envelope.json). As built: the token goes in `Authorization: Bearer <token>` or, since browsers cannot set WebSocket headers, as the subprotocol `bearer.<token>` offered next to `nova-relay.v1` (the server selects `nova-relay.v1`). An unknown token closes with 4001, a revoked route sends `close {reason: revoked}` and closes with 4003, a full Relay closes with 1013. Text frames only |
| `POST` | `/v1/relay/hubs` | A Hub registers and receives its routing id and route token. As built: no body; 201 `{routeId, routeToken}` (`nvr_…`). No credential, or the registration token as a bearer token when the operator set `NOVA_RELAY_REGISTRATION_TOKEN` (401 `auth_missing` otherwise). Since M7 the Hub's connector sends the token from the vault entry `relay.registrationTokenRef` names (`PUT /api/v1/relay/registration-token`), and registers again at once when it is set after a refusal. 20 an hour per address (429); at most 10,000 Hubs (503 `relay_full`) |
| `POST` | `/v1/relay/pairings` | The Hub opens a pairing slot (single use, 5 min TTL); returns a pairing id for the QR payload. As built: Hub route token; `{id? (16–32 base64url characters; the Hub picks it), codeHash (43 base64url characters), expiresAt (capped at 5 minutes), offer (base64, ≤ 8 KiB: the Hub's sealed offer)}` → 201 `{pairingId, expiresAt}`. A used id is 409 `conflict`; more than 20 open slots per Hub is 429. The Relay never sees the code, only a stretched hash of it (`docs/22` §3.1) |
| `POST` | `/v1/relay/pairings/:id/claim` | A client presents the code and a sealed blob with its public key; the Relay forwards the blob to the Hub and returns a pending client routing id and route token. As built: `{codeHash, blob (base64, ≤ 16 KiB: the client's sealed claim)}` → 201 `{clientId, routeId, routeToken, hubRouteId, offer, expiresAt}`; no credential, 30 a minute per address. A wrong hash is 401 `invalid_code` `{attemptsLeft}` and the fifth burns the slot; an unknown, expired or used slot is 410 `expired` (alike); 100 client routes per Hub (429 `{reason: routes_per_hub}`) and 100,000 in total (503 `relay_full`). The claim reaches the Hub as a `data` frame on stream `pair.<pairingId>` (below) |
| `POST` | `/v1/relay/pairings/:id/confirm` | The Hub confirms after the user approves (matching codes on both screens); the client route becomes active. As built: Hub route token → `{ok: true, clientId, routeId}`; a slot of another Hub is 404, one not claimed 409 `{reason: not_claimed}`, a claimed route that is gone 410 |
| `GET` | `/v1/relay/routes` | The Hub lists its client routes: routing id, created, last seen, connected (no names). As built: Hub route token → `{items: [{routeId, clientId, status: pending\|active, createdAt, lastSeenAt, connected}]}` |
| `DELETE` | `/v1/relay/routes/:routeId` | The Hub revokes a client route: open connections close with `revoked`, reconnects are refused. As built: Hub route token → `{ok: true}`; another Hub's route is 404. The revoked token's hash is kept 30 days |
| `POST` | `/v1/relay/messages` | Inbound channel message (webhook target) `{bindingId, externalRef, ciphertext}`. As built: 501 `not_implemented` `{reason: channel_relay_not_built}`; not built, and no milestone plans it (channels reach the Hub directly or by polling) |
| `GET` | `/v1/relay/outbox?since=` | Agent outbound channel messages to deliver. As built: 501 `not_implemented` `{reason: channel_relay_not_built}`; not built |
| `POST` | `/v1/relay/push/register` | Register a push token (APNs/FCM) for a client route. As built: an active client's route token; `{platform: apns\|fcm, token (≤ 4,096), topic?}` → 201 `{ok: true}`. A client offline when a frame arrives for it gets a content-free wake-up, at most one per 30 s. Since M7 the token's shape is checked (an APNs device token, or an FCM registration token) and a malformed one is 400 `validation`; `topic` (a bundle id) is accepted only for APNs |
| `POST` | `/v1/relay/push/notify` | The Hub pushes a notification to its own native clients (FR-111, M7). Hub route token; `{routes: [routeId] (1–50), notification: {id (≤ 64 of letters, digits and `-`), category: approval\|completion\|error\|attention\|system, title (1–80), link: nova://run\|code\|approval\|chat/<id> \| null}}` (strict: nothing else can ride along, so a Hub cannot route content through push) → `{ok: true, sent, skipped, failed}`. Only the Hub's own active routes with a push registration are pushed; at most 30 per route per minute (the rest are skipped). A token the push service reports gone is dropped (the client registers a new one) |
| `GET` | `/v1/relay/health` | Liveness. As built: no credential → `{status: "ok", version}` |

Approvals, questions and other server-to-client requests travel as ordinary sealed streams
(`contracts/hub-api.md` §5); push notifications carry only ids and redacted titles. The Hub's
own list and revoke of paired clients is `GET /api/v1/relay/clients` and
`POST /api/v1/relay/clients/:id/revoke`, which call `GET /v1/relay/routes` and
`DELETE /v1/relay/routes/:routeId`.

### 3.2 Framing

| Rule | Value |
| --- | --- |
| Envelope fields | `v`, `kind` (`data`, `ack`, `ping`, `pong`, `close`), `to`, `from`, `client`, `stream`, `seq`, `seg {i, n}`, `ack`, `ct`, `reason` (close only) |
| Sealing | XChaCha20-Poly1305 with a per-direction session key (`docs/22` §3.1) and a random 24-byte nonce; `ct` is base64 of nonce, ciphertext and tag; associated data is the JSON array `["nova-relay-v1", client, stream, seq, seg.i, seg.n]` |
| Streams | One `stream` id per logical channel (thread stream, request, transfer); `seq` starts at 1 per stream. As built: `c<counter>` for client-opened and `h<counter>` for Hub-opened streams, base36 counters that only grow (max(previous + 1, now in ms × 1024)); the pairing claim uses `pair.<pairingId>` |
| Segment size | 64 KiB plaintext; at most 256 segments (16 MiB per message); an incomplete message is discarded after 60 s |
| Acks | Cumulative per stream (highest contiguous `seq` received); may ride on data frames. Ack frames are not sealed (the schema gives them no `ct`): a forged ack can only stop resends, which a Relay could do by dropping frames |
| Retransmit | Unacked window of 256 segments; resend after 5 s without an ack; on reconnect resume from the last acked `seq` |
| Duplicates | Dropped by `(client, stream, seq, seg.i)`; `seq` outside the window is dropped |
| Keepalive | `ping` every 25 s; 3 missed `pong`s close the connection, which reopens with backoff. As built: the Relay answers each `ping` itself (a `pong` from the Relay); pings are never forwarded |
| Limits | Frames above the size limit are refused with `close {reason: too_large}`; unknown routes with `unknown_route`. As built: the frame limit is 96 KiB; `unknown_route` is a per-frame `close` and the connection stays open; a frame claiming another sender is dropped |
| Validation | As built, slightly stricter than the schema: `reason` only on `close`, `seg.i < seg.n`, `ct` valid base64 |

WebSocket close codes next to the `close` frame's reason (as built):

| Code | Reason | When |
| --- | --- | --- |
| 1000 | `normal` | A newer connection on the same route replaced this one |
| 1009 | `too_large` | A frame over 96 KiB |
| 1013 | — | The Relay holds 20,000 connections; try again later |
| 4001 | `unauthorized` | No route token, or an unknown one |
| 4003 | `revoked` | The route was revoked |
| 4004 | `unknown_route` | (a per-frame `close`; the connection stays) |
| 4008 | `idle` | Nothing received for 90 s |
| 4009 | — | The client side closes after 3 missed pongs (keepalive) |

Limits as built (`DEFAULT_LIMITS` in `services/relay/src/server.ts`; `buildRelayServer({limits})`
overrides any of them):

| Limit | Default | When reached |
| --- | --- | --- |
| Frame size | 96 KiB | `close {reason: too_large}`, 1009 |
| Queue per offline route | 512 frames, 8 MiB | oldest frames of that route dropped (senders retransmit) |
| Queue per Hub (its own route and its clients') | 32 MiB | oldest frames of that Hub dropped |
| Queue in total | 256 MiB | oldest frames anywhere dropped |
| Queue age | 2 minutes | dropped |
| Client routes per Hub (pending and active) | 100 | claim 429 |
| Client routes in total | 100,000 | claim 503 `relay_full` |
| Hubs in total | 10,000 | registration 503 `relay_full` |
| Open connections in total | 20,000 | closed with 1013 |
| Connections per route | 2 | the newest replaces the oldest (`normal`) |
| Silent connection | 90 s | `close {reason: idle}`, 4008 |
| Open pairing slots per Hub | 20 | 429 |
| Wrong codes per pairing slot | 5 | the slot is burned |
| Hub registrations per address | 20 an hour | 429 |
| Claims per address | 30 a minute | 429 |
| Unconfirmed claimed route | 15 minutes | removed |
| A Hub with no client routes, not connected | 24 hours | forgotten (its token stops working; the Hub registers again by itself) |
| Any Hub not seen | 30 days | forgotten with its client routes |
| Revoked route token | 30 days | kept refused |

**Pairing stream.** A claim is forwarded to the Hub as a `data` frame on stream
`pair.<pairingId>` from the claimed route, `seq` 1, one segment, `ct` the client's sealed claim
blob as the Relay received it. Claims are not queued: unconfirmed claims are re-sent each time the
Hub connects.

**The `decided` notice (M7).** Nothing reaches a client route before the Hub confirms it, with one
exception: the Hub's `data` frames on Hub-opened streams (`h…`) are passed to a pending route, and
nothing goes back from it until it is confirmed. The Hub uses that to tell a client its request
was declined: a sealed tunnel message `{t: decided, requestId, decision: denied|expired}` when the
owner denies the request, when it expires, and when the Hub refuses the claim (sent as `denied`).
The client cannot acknowledge it, so the Hub deletes the route at the Relay after a grace period
(`decidedGraceMs`, 2 s by default; sooner when the Hub reconnects or stops). The client library's
`waitForDecision()` resolves to approved, denied or expired, the first decision standing. A Relay
that predates the notice drops it, and the client sees its route revoked as before.

**Address limits behind a proxy.** `--trust-proxy` takes a hop count (`1` to `10`) or the proxies'
addresses or CIDR ranges (`10.0.0.1,10.1.0.0/16`); the per-address limits then use the address the
trusted proxy saw, and an address a client writes into `X-Forwarded-For` itself is never
believed. `true` is refused.

**Push senders (M7).** Without configuration the Relay keeps the recording mock. Real senders are
switched on by the operator's environment: APNs with `NOVA_RELAY_APNS_KEY_FILE`,
`NOVA_RELAY_APNS_KEY_ID`, `NOVA_RELAY_APNS_TEAM_ID`, `NOVA_RELAY_APNS_TOPICS` (comma-separated
bundle ids) and `NOVA_RELAY_APNS_SANDBOX=1` for the sandbox gateway; FCM with
`NOVA_RELAY_FCM_SERVICE_ACCOUNT_FILE` (the service account JSON). They hold the app publisher's
credentials, which is why native push goes through the Relay and never from the Hub. A push
carries the notification id, its category, a redacted title and the deep link only.

**State.** With `--data-dir` (`NOVA_RELAY_DATA_DIR`), registrations survive restarts in
`relay-state.json` (mode 0600), written asynchronously and at most once a second (`close()`
flushes). Route tokens are kept only as SHA-256 hashes. Without a data folder a restart forgets
every Hub: a Hub with no paired clients registers again by itself (at most once a minute); one with
paired clients reports `error` until the owner turns the Relay off and on, and its clients pair
again.

- Route tokens authenticate connections to the Relay only; they never authorize anything on
  the Hub. The Hub authenticates the client inside the seal with its device key and token.
- Every pairing, confirmation and revocation is audited on the Hub.

## 4. Catalog

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/catalog/index` | Signed index of plugins/skills/themes/pets/MCP servers |
| `GET` | `/v1/catalog/items/:id` | Item metadata + versions + permissions |
| `GET` | `/v1/catalog/items/:id/:version/download` | Signed artifact (`.novax`) |
| `GET` | `/v1/catalog/keys` | Publisher public keys for signature verification |

- The index and every artifact are signed; the app verifies before install.
- No user data is sent to the catalog beyond the item request.

## 5. Cloud runner

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/runner/environments` | Create/reuse an environment `{repoUrls,setupScript,baseImage}` |
| `GET` | `/v1/runner/environments/:id` | Status + connection info |
| `POST` | `/v1/runner/runs` | Start a run `{environmentId,taskCiphertext,budget}` |
| `GET` | `/v1/runner/runs/:id` | Status, logs (redacted), artifacts metadata |
| `POST` | `/v1/runner/runs/:id/cancel` | Cancel |
| `GET` | `/v1/runner/runs/:id/stream` | Server-sent events of run progress (redacted) |
| `POST` | `/v1/runner/runs/:id/approve` | Answer an approval |
| `POST` | `/v1/runner/snapshots` / `GET .../:id` | Create/restore snapshots |

- Task payloads may be encrypted with the account key; the runner decrypts only within its
  isolated environment and never persists plaintext beyond the session.
- Resource usage is reported for billing/metering; hard caps are enforced server-side.

*Amended and as built in M7* (decision 4 of ADR-095; FR-108, FR-071, FR-116). The runner is a
remote execution environment for runs the Hub drives, not a place where tasks run on their own:
the Hub keeps the agent loop, the model calls and the policy gate, and nothing reaches the runner
before the Hub's gate allowed it. The runner holds environments (repositories cloned side by side,
a setup script run once, caches kept), runs their commands and file operations in a sandbox it
starts itself, streams output, keeps snapshots and enforces hard caps. So `taskCiphertext` is
refused (a run carries no task) and `POST /runs/:id/approve` answers 501 `not_implemented`
`{reason: approvals_on_hub}`. The service is `services/runner` (`@nova/runner-service`, Apache-2.0,
`nova-runner`, default `127.0.0.1:7431`); the local runner is the same service on this machine, a remote
one the same service at an https URL behind a TLS-terminating proxy. The Hub's side is
`contracts/hub-api.md`, "Cloud runner".

**Authentication.** Every route needs a Hub's bearer token (`Authorization: Bearer nvrun_…`, made
with `nova-runner token add`, printed once; the token file keeps only SHA-256 hashes and is re-read
when it changes). A token sees only what it created. Missing token: 401 `auth_missing`; unknown:
401 `auth_invalid`. Rate limits per token: 1,200 requests and 240 commands a minute, 30
environments created or rebuilt and 60 snapshots an hour; 30 failed sign-ins a minute per address
(429 `rate_limited`). Errors use §6, with `quota_exceeded` (409) at a cap and `not_implemented` (501) above.

**Network is off by default.** An environment's `network` is `off` (default), `setup` (only the
setup script may reach the network) or `on`; a command gets network only when its environment has
`on` and the command asks for it. Runner network does not pass the Hub's egress proxy, so the Hub
asks for it only when the owner turned on `cloud.runner.unrestrictedNetwork`. Repositories are
`https://` without credentials and never private or local host literals, or `file://` from
folders the operator listed with `--local-repos` (none by default); they are cloned inside the
sandbox with hooks, prompts and system and global Git config off.

**Sandbox and caps.** bubblewrap when present (new namespaces, every capability dropped, a seccomp
filter, the host's system folders read-only, only the environment's own folders mounted: the
workdir at `/workspace`, caches at `/cache/<name>`, and the Hub's state at `/nova` only for the
Hub's own `/runs/:id/run` programs; it refuses to run as root), else docker or podman (the
environment's `baseImage` or `debian:stable-slim`, a non-root user, `--network none` unless allowed,
pids and memory limits, the program as the entrypoint), else environments are refused with the
reason. Per command: RLIMIT_DATA (2 GiB), RLIMIT_CPU (the run's CPU left) and RLIMIT_FSIZE (the
disk left). Per sandbox: 256 processes and, where `systemd-run --user --scope` works, a cgroup with
pids and a 4 GiB memory limit. At most 64 commands at once, 16 per token, 8 per run; 20
environments per token. Each run has CPU and wall-time caps (defaults 3,600 s and 4 h, at most 7
days; wall time counts only while a command runs), each environment a disk cap (default 10 GiB, at
most 50 GiB); a `cap.warning` event at 80 % and a hard stop at the cap. A disk count that stops at
500,000 entries counts as over the cap. Commands and their output live in memory only; what is
kept on disk (clones, caches, snapshots as tar files) lives inside the environment's folder.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/runner/health` | `{status: ok, version, substrate: {kind: bwrap\|docker\|podman\|null, ok, detail}, limits: {maxDiskMb, maxCpuSeconds, maxWallSeconds, defaultCpuSeconds, defaultWallSeconds, defaultDiskMb, baseImages}}` |
| `POST` | `/v1/runner/environments` | `{name?, repoUrls (≤ 10), setupScript?, baseImage?, caches? (≤ 8 names), network?: off\|setup\|on, diskMb?, reuse?}` → 201 (200 when an identical one is reused): the environment view (`status: provisioning\|ready\|failed\|deleting`, repos, caches, setup with its redacted log tail, disk usage and cap, active runs and processes) |
| `GET` | `/v1/runner/environments[/:id]` | `{items}` / one environment view |
| `POST` | `/v1/runner/environments/:id/rebuild` | Clone again and run setup once more (caches kept) |
| `DELETE` | `/v1/runner/environments/:id` | Remove it with its folder and snapshots |
| `GET/PUT/DELETE` | `/v1/runner/environments/:id/files?path=` | Read a file or folder (`stat=1` for metadata), write `{content (base64, ≤ 12 MiB)}`, delete; inside the workdir only |
| `POST` | `/v1/runner/runs` | A lease on an environment `{environmentId, label?, budget?: {cpuSeconds?, wallSeconds?}}` → 201 the run (`status: active\|completed\|cancelled\|capped\|failed`, caps, usage `{cpuSeconds, wallSeconds, commands}`, warnings). `taskCiphertext` is refused |
| `GET` | `/v1/runner/runs?environmentId=`, `/v1/runner/runs/:id` | `{items}` / one run |
| `PATCH` | `/v1/runner/runs/:id` | `{budget: {cpuSeconds?, wallSeconds?}}`: raise or change its caps; a capped run with room is active again |
| `POST` | `/v1/runner/runs/:id/cancel`, `…/finish` | Stop its processes and end it cancelled / completed |
| `POST` | `/v1/runner/runs/:id/exec` | Start a command `{cmd, cwd?, env? (≤ 64), tag?, network?: off\|on, readOnly?, timeoutMs?, stdin?}` → 201 the process view |
| `POST` | `/v1/runner/runs/:id/run` | One program to its end, bytes in and out (the Hub's environment transport for Git and files) `{argv (≤ 512), cwd?, env?, stdin? (base64, ≤ 12 MiB), timeoutMs? (≤ 1 h), maxBytes? (≤ 64 MiB)}` → `{code, stdout (base64), stderr}` |
| `GET` | `/v1/runner/runs/:id/processes` | The run's processes `{items}` |
| `GET` | `/v1/runner/runs/:id/processes/:pid/output?offset=&waitMs=` | Buffered output from `offset` (the newest 1 MiB is kept), waiting up to 30 s for more |
| `POST` | `/v1/runner/runs/:id/processes/:pid/input` | `{text?, closeStdin?, signal?: interrupt\|terminate}` |
| `POST` | `/v1/runner/runs/:id/kill` | Kill the processes of a `{tag}` |
| `POST/GET` | `/v1/runner/runs/:id/artifacts[/:aid]` | Keep a workdir file `{path, name?}` (≤ 50 MiB) → 201 its record with SHA-256 / download it (`x-nova-sha256`) |
| `GET` | `/v1/runner/runs/:id/stream?since=&output=0\|1` | Server-sent events of the run, resumable with `Last-Event-ID`: `process.started`, `output`, `process.exited`, `usage`, `cap.warning`, `cap.reached`, `artifact`, `run.ended` (the stream ends there); a ping comment every 15 s |
| `POST` | `/v1/runner/runs/:id/approve` | 501 `not_implemented` `{reason: approvals_on_hub}` |
| `POST/GET` | `/v1/runner/snapshots` | Take one `{environmentId, label?}` (201; a tar of the workdir inside the environment's folder) / list |
| `GET/DELETE` | `/v1/runner/snapshots/:id` | One / delete it |
| `POST` | `/v1/runner/snapshots/:id/restore` | Put the workdir back as it was |

Snapshots are not encrypted by Nova (encryption at rest is the runner operator's); metering for
billing is not built.

## 6. Errors

```json
{ "error": { "code": "quota_exceeded", "message": "Monthly run budget reached.",
             "retryable": false, "details": { "limit": 100, "used": 100 } },
  "requestId": "req_..." }
```

Standard HTTP status mapping: 400 validation, 401 auth, 403 policy, 404 missing, 409 conflict,
413 too large, 429 rate limit, 5xx server. `retryable` drives client backoff.

## 7. OpenAPI

Generated from the shared Zod schemas in `packages/shared` and published at build time to
`contracts/openapi.json` (regenerated in CI, drift fails the build). This document is the
human-readable summary; the generated spec is authoritative for shapes.
