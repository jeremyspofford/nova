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

### 3.1 Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/relay/connect` | WebSocket upgrade with a route token; every frame is a [`RelayEnvelope`](schemas/relay-envelope.json) |
| `POST` | `/v1/relay/hubs` | A Hub registers and receives its routing id and route token |
| `POST` | `/v1/relay/pairings` | The Hub opens a pairing slot `{codeHash, expiresAt}` (single use, 5 min TTL); returns a pairing id for the QR payload |
| `POST` | `/v1/relay/pairings/:id/claim` | A client presents the code and a sealed blob with its public key; the Relay forwards the blob to the Hub and returns a pending client routing id and route token |
| `POST` | `/v1/relay/pairings/:id/confirm` | The Hub confirms after the user approves (matching codes on both screens); the client route becomes active |
| `GET` | `/v1/relay/routes` | The Hub lists its client routes: routing id, created, last seen, connected (no names) |
| `DELETE` | `/v1/relay/routes/:routeId` | The Hub revokes a client route: open connections close with `revoked`, reconnects are refused |
| `POST` | `/v1/relay/messages` | Inbound channel message (webhook target) `{bindingId, externalRef, ciphertext}` |
| `GET` | `/v1/relay/outbox?since=` | Agent outbound channel messages to deliver |
| `POST` | `/v1/relay/push/register` | Register a push token (APNs/FCM) for a client route |
| `GET` | `/v1/relay/health` | Liveness |

Approvals, questions and other server-to-client requests travel as ordinary sealed streams
(`contracts/hub-api.md` §5); push notifications carry only ids and redacted titles. The Hub's
own list and revoke of paired clients is `GET /api/v1/relay/clients` and
`POST /api/v1/relay/clients/:id/revoke`, which call `GET /v1/relay/routes` and
`DELETE /v1/relay/routes/:routeId`.

### 3.2 Framing

| Rule | Value |
| --- | --- |
| Envelope fields | `v`, `kind` (`data`, `ack`, `ping`, `pong`, `close`), `to`, `from`, `client`, `stream`, `seq`, `seg {i, n}`, `ack`, `ct` |
| Sealing | XChaCha20-Poly1305 to the recipient's device key; `client`, `stream`, `seq`, `seg` bound as associated data |
| Streams | One `stream` id per logical channel (thread stream, request, transfer); `seq` starts at 1 per stream |
| Segment size | 64 KiB plaintext; at most 256 segments (16 MiB per message); an incomplete message is discarded after 60 s |
| Acks | Cumulative per stream (highest contiguous `seq` received); may ride on data frames |
| Retransmit | Unacked window of 256 segments; resend after 5 s without an ack; on reconnect resume from the last acked `seq` |
| Duplicates | Dropped by `(client, stream, seq, seg.i)`; `seq` outside the window is dropped |
| Keepalive | `ping` every 25 s; 3 missed `pong`s close the connection, which reopens with backoff |
| Limits | Frames above the size limit are refused with `close {reason: too_large}`; unknown routes with `unknown_route` |

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
