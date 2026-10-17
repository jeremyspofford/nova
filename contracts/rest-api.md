# REST APIs (Optional Server Components)

These APIs exist only for optional cloud features (sync, relay, catalog, cloud runner). The
Hub never requires them. All endpoints are versioned under `/v1` and authenticated with a
device/account token. **The server is content-blind for user content.**

Default hosted endpoints (all configurable / self-hostable):

| Service | Default |
| --- | --- |
| Catalog | `https://catalog.arialabs.ai` (also `https://catalog.<tailnet>.ts.net`) |
| Relay | `wss://relay.arialabs.ai` |
| Sync | `https://sync.arialabs.ai` |
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
answer 501 (M7). Errors use the shape in §6 with these codes: `validation` (400), `auth_missing`
(401), `invalid_code` (401), `not_found` (404), `conflict` (409), `expired` (410),
`rate_limited` (429), `not_implemented` (501), `relay_full` (503).

### 3.1 Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/relay/connect` | WebSocket upgrade with a route token; every frame is a [`RelayEnvelope`](schemas/relay-envelope.json). As built: the token goes in `Authorization: Bearer <token>` or, since browsers cannot set WebSocket headers, as the subprotocol `bearer.<token>` offered next to `nova-relay.v1` (the server selects `nova-relay.v1`). An unknown token closes with 4001, a revoked route sends `close {reason: revoked}` and closes with 4003, a full Relay closes with 1013. Text frames only |
| `POST` | `/v1/relay/hubs` | A Hub registers and receives its routing id and route token. As built: no body; 201 `{routeId, routeToken}` (`nvr_…`). No credential, or the registration token as a bearer token when the operator set `NOVA_RELAY_REGISTRATION_TOKEN` (401 `auth_missing` otherwise; the Hub's connector sends none yet, so it cannot register with such a private Relay). 20 an hour per address (429); at most 10,000 Hubs (503 `relay_full`) |
| `POST` | `/v1/relay/pairings` | The Hub opens a pairing slot (single use, 5 min TTL); returns a pairing id for the QR payload. As built: Hub route token; `{id? (16–32 base64url characters; the Hub picks it), codeHash (43 base64url characters), expiresAt (capped at 5 minutes), offer (base64, ≤ 8 KiB: the Hub's sealed offer)}` → 201 `{pairingId, expiresAt}`. A used id is 409 `conflict`; more than 20 open slots per Hub is 429. The Relay never sees the code, only a stretched hash of it (`docs/22` §3.1) |
| `POST` | `/v1/relay/pairings/:id/claim` | A client presents the code and a sealed blob with its public key; the Relay forwards the blob to the Hub and returns a pending client routing id and route token. As built: `{codeHash, blob (base64, ≤ 16 KiB: the client's sealed claim)}` → 201 `{clientId, routeId, routeToken, hubRouteId, offer, expiresAt}`; no credential, 30 a minute per address. A wrong hash is 401 `invalid_code` `{attemptsLeft}` and the fifth burns the slot; an unknown, expired or used slot is 410 `expired` (alike); 100 client routes per Hub (429 `{reason: routes_per_hub}`) and 100,000 in total (503 `relay_full`). The claim reaches the Hub as a `data` frame on stream `pair.<pairingId>` (below) |
| `POST` | `/v1/relay/pairings/:id/confirm` | The Hub confirms after the user approves (matching codes on both screens); the client route becomes active. As built: Hub route token → `{ok: true, clientId, routeId}`; a slot of another Hub is 404, one not claimed 409 `{reason: not_claimed}`, a claimed route that is gone 410 |
| `GET` | `/v1/relay/routes` | The Hub lists its client routes: routing id, created, last seen, connected (no names). As built: Hub route token → `{items: [{routeId, clientId, status: pending\|active, createdAt, lastSeenAt, connected}]}` |
| `DELETE` | `/v1/relay/routes/:routeId` | The Hub revokes a client route: open connections close with `revoked`, reconnects are refused. As built: Hub route token → `{ok: true}`; another Hub's route is 404. The revoked token's hash is kept 30 days |
| `POST` | `/v1/relay/messages` | Inbound channel message (webhook target) `{bindingId, externalRef, ciphertext}`. As built: 501 `not_implemented` `{reason: channel_relay_m7}` |
| `GET` | `/v1/relay/outbox?since=` | Agent outbound channel messages to deliver. As built: 501 `not_implemented` |
| `POST` | `/v1/relay/push/register` | Register a push token (APNs/FCM) for a client route. As built: an active client's route token; `{platform: apns\|fcm, token (≤ 4,096), topic?}` → 201 `{ok: true}`. A client offline when a frame arrives for it gets a content-free wake-up, at most one per 30 s (mock sender until M7) |
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

**Address limits behind a proxy.** `--trust-proxy` takes a hop count (`1` to `10`) or the proxies'
addresses or CIDR ranges (`10.0.0.1,10.1.0.0/16`); the per-address limits then use the address the
trusted proxy saw, and an address a client writes into `X-Forwarded-For` itself is never
believed. `true` is refused.

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
