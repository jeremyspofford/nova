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

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/relay/messages` | Inbound channel message (webhook target) `{bindingId, externalRef, ciphertext}` |
| `GET` | `/v1/relay/outbox?since=` | Agent outbound messages to deliver |
| `POST` | `/v1/relay/approvals` | Deliver an approval request to a device |
| `POST` | `/v1/relay/approvals/:id/decision` | Phone answers an approval |
| `POST` | `/v1/relay/push/register` | Register a push token for a device |
| `GET` | `/v1/relay/health` | Liveness |

- The relay routes ciphertext + routing metadata only.
- Approval decisions are signed by the device key and verified before being honored.

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
