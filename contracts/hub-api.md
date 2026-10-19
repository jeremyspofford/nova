# Hub API (Client ↔ Hub, Hub ↔ Node, Hub ↔ novad)

The Hub is the only canonical service. Everything speaks to it. This file summarizes the
boundaries; the generated OpenAPI document (from the shared Zod schemas) is authoritative.
The shape stays REST plus WebSocket/SSE (ADR-072), with server-to-client requests over the
stream (§5) and a capability handshake (§7).

## 1. Client ↔ Hub

Transport: HTTPS (REST) plus WebSocket/SSE for streams. Authentication: device certificate
+ scoped bearer token issued at Add Device. All requests are authorized by the policy engine.
Every listener requires a token or certificate; loopback is never treated as authorization
(FR-192, ADR-075). The only exceptions authenticate another way and say so below: Add Device
(pairing code, then the device key), the MCP event webhook (signature), the `novad` download route (static,
signed artifacts only), the MCP OAuth callback (single-use state), Nova's OAuth client
metadata document and `GET /api/v1/hello` (both public, no account data), and `/mcp` (a
client token of its own). M6 adds (the list `apps/hub/test/listeners.test.ts` enforces):

| Route | How it authenticates |
| --- | --- |
| `POST /api/v1/channels/:id/inbound` | The channel's own proof over the raw body: Slack's signing-secret HMAC, a Bot Framework JWT for Teams, or a webhook binding's bearer token plus `x-nova-signature` HMAC; 5-minute window. 401 otherwise, 404 for an unknown binding |
| `POST /api/v1/triggers/:id/webhook` | The trigger's bearer token plus `x-nova-signature` HMAC over `<timestamp>.<body>`, or `<timestamp>.<event id>.<body>` when `x-nova-event-id` is sent; 5-minute window. 401 otherwise (audited), 404 for an unknown trigger |
| `POST /api/v1/mcp/events/:subscriptionId` | `x-nova-event-signature` HMAC with the subscription's secret over `<id>.<timestamp>.<body>`; 5-minute window. 401 otherwise, 410 for an unknown or removed subscription |
| `POST /agent/v1/register` | A one-use `novad` enrollment token (`nvd_…`) in the body |
| `POST /agent/v1/heartbeat`, `POST /agent/v1/capabilities` | The device credential (`nvc_…`) as a bearer token |

M6.5 adds (ADR-094; same list). Add Device's three routes are rate-limited per client address;
the routes marked "none" hand out only public information and answer anyone:

| Route | How it authenticates |
| --- | --- |
| `POST /api/v1/devices/add/complete` | The single-use pairing code in the body (5 minutes; five wrong codes burn its pairing; a code sent without `pairingId` spends the account's code-only budget instead). 10 a minute per address |
| `POST /api/v1/devices/add/reveal` | The commitment sent with `complete`, plus the device key's Ed25519 signature (`x-nova-device-signature`) over `nova-add-device-reveal-v1.<requestId>.<time>`, with `x-nova-device-time` within 60 s. A wrong nonce or signature burns the request. 10 a minute per address |
| `GET /api/v1/devices/add/status/:requestId` | The device key's signature over `nova-add-device-status-v1.<requestId>.<time>`; the time is within 60 s and newer than the last accepted poll, so a captured poll cannot be replayed. 120 a minute per address |
| `GET /api/v1/trust/ca.pem`, `GET /api/v1/trust/ca.crt` | None: the local CA's root certificate is public (404 unless the trust mode is `local-ca`) |
| `GET /api/v1/trust/identity?nonce=` | None: the statement is signed by the Hub identity key and echoes the caller's nonce |
| `GET /api/v1/agent/dist/:file` | None: builds are not secret; their integrity is the manifest's Ed25519 signature by the Hub identity plus each build's SHA-256. 60 a minute per address |

M7 adds (ADR-095; same list). The join, OIDC and profile routes are rate-limited per client
address (10, 30 and 60 a minute; 429 `rate_limited` `{reason: address_rate_limited}`); a new
member has no session yet:

| Route | How it authenticates |
| --- | --- |
| `GET /api/v1/channels/approval-links/:token` | The signed one-use approval link from an approval email (HMAC with the Hub's link key in the vault, lifetime capped by the approval and `channels.approvalLinkMinutes`). Shows the choices and changes nothing (mail scanners follow links) |
| `POST /api/v1/channels/approval-links/:token` | The same link; answers the approval once (form or JSON `{decision}`) |
| `POST /api/v1/team/join/preview`, `POST /api/v1/team/join` | The one-use invitation token in the body (256 random bits, only its hash stored, expires) |
| `GET /api/v1/auth/oidc/providers` | None: the enabled providers' ids and labels only |
| `POST /api/v1/auth/oidc/start` | None for `sign_in` (it only returns the provider's URL); `join` needs a usable invitation; `link` needs a session |
| `GET /api/v1/auth/oidc/callback` | The single-use 10-minute state from start, the `nova_oidc_binding` cookie of the browser that started, then the ID token's checks; it only ever redirects to fixed paths (refusals to `/sign-in?oidc_error=` or `/settings/account?oidc_error=`) |
| `GET /api/v1/profiles/:handle`, `GET /api/v1/profiles/:handle/avatar` | None: only cards their person published while `team.publicProfiles` is on |

Telegram webhooks arrive on the existing `POST /api/v1/channels/:id/inbound` (the secret-token
header the Hub generated), and so do Slack button presses (form-encoded, the same signing-secret
check).

The Relay adds no public Hub route: requests a client tunnels through it are dispatched into the
Hub's own routes and authenticate like direct ones (`/api/v1/relay` below); since M7 the tunnel
also passes `Idempotency-Key`.

**Members (M7, decision 5 of ADR-095).** A Hub may have several people: the owner and members
(each their own account) and team agents' identity accounts (which never sign in). Every
account-scoped route shows a caller only its own account's data. Routes that administer the Hub
or reach its machine are the owner's: any other account gets 403 `policy_denied`
`{reason: owner_only}`. The list is `OWNER_ONLY_ROUTES` in `packages/core/src/team/access.ts`:
`/api/v1/settings` (all methods; members keep their own appearance, keyboard and onboarding
preferences at `/api/v1/team/me/settings`), `PUT /presets`, `/providers/detect`, `GET/PATCH /trust`,
`/trust/renew`, everything under `/network`, `/relay`, `/devices` and `/nodes`, `/audit/verify`,
`/diagnostics`, `GET /egress`, `POST /app-authorizations`, installing, changing and removing
plugins and their catalogs, creating, changing and deleting skills, `/hooks`, `/files`,
`/terminals`, `/library`, `/projects/:id/folders`, `/import`, `/code`, `/environments`, `/cloud`,
`/agent-adapters`, `/delegations`, `/mcp/bundles` and site publish and unpublish. A member may add
remote MCP servers but not stdio ones (a body with `transport: stdio`, `command`, `args` or `env`
is refused the same way). The three public Add Device routes stay open to a signed-in member.

### Idempotent writes (M7, FR-112, decision 2 of ADR-095)

A client that queues mutating requests while offline sends each with `Idempotency-Key` (1–200
visible ASCII characters; else 400 `validation` `{reason: idempotency_key_invalid}`). Only
`POST`, `PUT`, `PATCH` and `DELETE` with a session take part: a key is scoped to the principal
(`device:<id>` for a device session, else the session token), the method and the path, and lives
24 hours.

- **Replay is opt-in per route.** These routes keep their first answer and answer a repeat with it
  (same status and body, header `idempotent-replay: true`): `POST /sync/push`, `POST /threads`,
  `PATCH/DELETE /threads/:id`, `POST /threads/:id/messages`, `POST /threads/:id/messages/:mid/edit`,
  `POST /projects`, `PATCH/DELETE /projects/:id`, `POST /memory/items`,
  `PATCH/DELETE /memory/items/:id`, `POST /spaces`, `POST /spaces/:id/pages`,
  `PUT/PATCH/DELETE /spaces/:id/pages/:pageId`, `POST /spaces/:id/pages/:pageId/comments`,
  `POST /approvals`, `POST /requests/:id/respond` and `POST /runs` (`REPLAYABLE_ROUTES` in
  `apps/hub/src/sync.ts`), plus routes that opt in with `config.idempotentReplay` (so far
  `POST /threads/:id/messages/:mid/answer`). Every other
  route remembers the key without its answer, so the effect still never happens twice.
- **Refusals** (409 `conflict`): `{reason: idempotency_key_reused}` (the same key with a different
  body), `{reason: idempotency_in_flight}` (the first request is still running; `retryable`; after
  5 minutes it counts as lost) and `{reason: idempotency_not_replayable}` (the key was used on a
  route that does not replay, or its answer could not be kept).
- **Never stored**, whatever the route: an answer marked `Cache-Control: no-store`, larger than
  256 KiB, or carrying a credential (a Nova token, a token-shaped string the redactor knows, a
  non-empty value under a key named like `…token`, `…secret`, `password`, `credentials`,
  `privateKey`, `apiKey`, `cookie` or `grant`). Routes that hand out credentials also send
  `no-store` (`POST /app-authorizations`, `/devices/compute/enroll`, `/devices/novad/enroll`,
  `/team/invitations`, `/team/join`, `/schedules/:id/webhook-secret`).
- **Forgotten:** a 5xx or 429 answer, so the retry runs.

These receivers still pass the Host and Origin checks: the host name external services use must
be one of the Hub's names; the host of `channels.publicUrl` is one (it follows the setting), and
so are the Hub's mDNS name (`<name>.local`, while mDNS runs) and the host of
`network.directPublic.url` (while Direct public is on). `GET /api/v1/health`
(liveness), `POST /api/v1/auth/setup` (the one-use setup code) and `/node/v1/*` (an enrollment
token or the node credential, §2) are public in the same way.

### Handshake & streams

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/hello` | Public: `{name, version, apiVersions, features, setupRequired}`; no account data. M6.5 adds `hubFingerprint` (base64url SHA-256 of the Hub identity's raw Ed25519 public key, 43 characters: what devices pin) and `hubPublicKey` (that key, base64url of its raw 32 bytes); both are null while the identity key cannot be loaded (FR-134) |
| `POST` | `/api/v1/hello` | Capability handshake (§7), with a session. M5 ships the body `{capabilities: {serverRequests}}` (other fields are accepted and ignored) and the answer `{name, version, apiVersions, serverRequests, clientSessionId}`: `serverRequests` is the request kinds the Hub agrees to send this client (the known kinds it asked for, §5) and `clientSessionId` a new id the client names on its WebSocket (`?clientSessionId=`) and in the `x-nova-client-session` header. Client sessions live in Hub memory (the newest 1,000); the session's token is the client's device for `targetDeviceId`. M6.5 adds `endpoints`: the Hub's endpoints that passed their own reachability test, best first, as `EndpointCandidate` (Network below; FR-135). The full §7 shape is a follow-up |
| `GET` | `/api/v1/events/stream` | SSE stream of the signed-in account's events and account-less system events (§5), `request.created` included. Opens with `: connected`; with `Last-Event-ID` or `?after=` it first replays persisted events after that id, else live events only. Since M7 account-less system events (network, Relay, trust) go to the Hub's owner only, and a removed member's open streams close at once |
| `GET` | `/api/v1/events?after=&limit=` | Persisted events after a cursor, with the same owner-only rule for account-less events (M7) |
| `GET` | `/api/v1/session` | The signed-in session: `{accountId, displayName, kind, deviceId, scopes, role}`. M7 (decision 3 of ADR-095): a device session made by Add Device names its `deviceId` and `scopes` (null for a session of no device, such as the owner's own browser); scopes are read from `device_session` on every request, so a revoked device fails closed (401). `role` is `owner` or `member` (null for an account of neither, such as a team agent's identity); `displayName` is the account's own |
| `GET` (WebSocket) | `/api/v1/ws?clientSessionId=` | The same events as `event` frames, plus server-to-client `request` frames for the kinds the handshake agreed, and `respond` frames from the client (§5). The session is checked before the upgrade (401 `token_required`). Since M7 account-less events reach only the owner, and removing a member closes their sockets with 4401 `account_closed` |

### Auth & devices

Add Device as built in M6.5 (FR-132, FR-140, `docs/22` §4, ADR-094) is a commit-then-reveal
handshake ("v2"). The owner starts a pairing with a session and gets a short code. The new device
sends the code, its Ed25519 public key and a commitment to a secret nonce (`complete`), gets the
Hub's nonce, then reveals its own (`reveal`). Both sides then compute the same six-digit
confirmation; the owner types the digits the device shows to approve. The device polls its status
with requests signed by its key and gets its grant once. `complete`, `reveal` and `status` are
public (table above). Owner routes need a session.

- **Code.** 8 characters of Crockford base32 without I, L, O and U (40 bits), shown as
  `ABCD-EFGH`; case, dashes and spaces are ignored, and O reads as 0, I and L as 1. Single use,
  5 minutes, stored only as hex SHA-256 of `nova-add-device-code-v1|<pairingId>|<CODE>`.
- **Commitment.** base64url SHA-256 of UTF-8 `nova-add-device-commit-v1|<publicKey>|<deviceNonce>`;
  `deviceNonce` is 32 random bytes (base64url), kept on the device until `reveal`.
- **Confirmation.** SHA-256 of UTF-8
  `nova-add-device-v2|<hubFingerprint or ''>|<pairingId>|<publicKey>|<CODE>|<deviceNonce>|<hubNonce>`
  read as one big-endian integer, mod 10^6, zero-padded to six digits (shown `123 456`). `CODE` is
  the canonical code (upper case, no dash). A Relay claim keeps the v1 formula (`nova-add-device-v1`
  without the two nonces): its claim travels sealed with a key derived from the code (§3 of
  `rest-api.md`).
- **Hub signature.** `hubSignature` is the Hub identity's Ed25519 signature (base64url) over UTF-8
  `nova-add-device-reveal-v1|<requestId>|<pairingId>|<publicKey>|<confirmation>`, or null while
  the Hub has no identity. A device that holds a pin (QR `fp=`, `--pin`) fetches `hubPublicKey`
  from `GET /api/v1/hello`, checks base64url(SHA-256(raw key)) equals the pin and verifies the
  signature before it shows the digits; a null or bad signature with a pin is a hard stop. Every
  device also compares the Hub's confirmation with its own computation.
- **Windows.** A committed request must be revealed within 2 minutes; a revealed request waits
  10 minutes for the owner; after approval the device has 10 more minutes to collect its grant.
  The code is kept in Hub memory only between `complete` and `reveal`, so a Hub restart in
  between expires the request.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/devices/add/start` | Start Add Device (owner) `{role: client\|compute\|wake-helper, scopes? (≤ 20 names, `^[a-z][a-z0-9_.:-]{0,63}$`), name? (1–100; wins over the name the device reports), transport?: direct\|relay}` → 201 `AddDeviceStartView` `{pairingId, code, expiresAt, role, scopes, transport, qr, deepLink, pageUrl, bootstrap: {command, powershell, why}, hubFingerprint, endpoints, relay: {relayUrl, relayPairingId}\|null}`, `Cache-Control: no-store`. `qr` is `<hub>/add-device?p=<pairingId>&fp=<hubFingerprint>&e=<endpoint>…&r=<relayUrl>&rp=<relayPairingId>#c=<code>` (the code rides in the fragment, which never reaches a server log); `deepLink` is `nova://add-device?h=<hub>&…#c=<code>`; `pageUrl` carries no code. `endpoints` are at most 4 healthy http(s) endpoints (Network below). `bootstrap` is the agent-dist area's one-line install for `novad` (sh `command`; `powershell` when the Hub has Windows builds), or null with `why`. `transport: relay` opens a Relay pairing slot (FR-137). Refusals: `policy_denied` `{reason: add_device_disabled}` (`devices.add.enabled` off), 429 `rate_limited` `{reason: start_rate_limited, limit: 20}` (starts per account per hour), `capability_missing` `{reason: relay_unavailable}`, `node_unavailable` `{reason: relay_refused}`. Audited as `device.add.start`. M6.5 replaces the M2/M6 behaviour of this route: no token is handed out before approval (the scripted paths are `compute/enroll` and `novad/enroll`) |
| `POST` | `/api/v1/devices/add/complete` | The new device commits (public) `{pairingId?, code (8–20 characters), publicKey (raw Ed25519, base64url, 43 characters), name (1–100), platform (1–50), kind: browser\|novad\|compute\|native, commitment}` → 202 `{requestId, pairingId, expiresAt (the reveal deadline), hubNonce (32 random bytes, base64url), status: committed}`, `Cache-Control: no-store`. A good code consumes its pairing. Kinds per role: `client` takes `browser`, `native` or `novad`; `wake-helper` takes `novad`; `compute` takes `compute` or `novad`. Without `pairingId` (a typed code) the code finds its pairing alone and a wrong guess spends the account's code-only budget (10 per 5 minutes, then code-only completes are refused for 5 minutes) instead of a pairing's attempts. Refusals: 401 `auth_missing` `{reason: wrong_code, attemptsLeft}` (the fifth wrong code burns the pairing); 410 `request_expired` `{reason: expired}` for an unknown, expired, used or burned pairing (alike: no oracle); 429 `rate_limited` `{reason: code_only_locked}` or `{reason: address_rate_limited}`; `policy_denied` `{reason: key_revoked}` (a revoked device's key); `validation` `{reason: kind_not_allowed, role, kind}`; `conflict` `{reason: key_in_use}`; `policy_denied` `{reason: add_device_disabled}`. Nothing is shown to the owner yet. Audited as `device.add.complete` (result `committed`, or `denied` with the reason) |
| `POST` | `/api/v1/devices/add/reveal` | The device reveals its nonce (public) `{requestId, nonce}` with `x-nova-device-time` and `x-nova-device-signature` → 200 `{requestId, confirmation, status: pending, hubSignature}`. The Hub checks the signature and that the nonce matches the commitment. A wrong nonce or signature burns the request (`denied`) and counts as a wrong code on its pairing: 401 `auth_missing` `{reason: bad_reveal}`. A good signature with a time more than 60 s off is 401 `{reason: stale_time}` and burns nothing; missing headers `{reason: missing_proof}`; an unknown request answers like a bad signature (`{reason: bad_signature}`). A second reveal is 409 `conflict` `{reason: already_revealed}`; one after 2 minutes, or after a Hub restart since `complete`, is 410 `request_expired`. Only now is the request pending for the owner: `device.add.requested`, an `attention` notification linking to `/devices/add?request=<id>` (the digits stay out of it). Audited as `device.add.reveal` |
| `GET` | `/api/v1/devices/add/status/:requestId` | The device's signed poll (public) → `{status: pending\|approved\|denied\|expired, deviceId?, grant?}`, `Cache-Control: no-store`; a committed request answers `pending`. The first approved poll hands out the grant exactly once: `{type: session, token}` for a `browser` or `native` device (a device session lasting `devices.add.sessionDays`, 30 by default; a browser also gets the HttpOnly, `SameSite=Strict` session cookie), `{type: novad, enrollToken: "nvd_…"}` or `{type: compute, enrollToken: "nve_…"}` (one use, 15 min, bound to this key: `/agent/v1/register` or `/node/v1/register` must present the same key, else `policy_denied` `{reason: key_mismatch}`, and activate the record approval created), plus `certificatePem` when the trust mode issues device certificates (`local-ca`). A device revoked before it collects gets `denied`, now and later. Refusals: 401 `auth_missing` `{reason: missing_proof\|bad_signature\|stale_time\|replayed}` (`replayed`: not newer than the last accepted poll). A grant that fails to issue is put back for the next poll |
| `GET` | `/api/v1/devices/add/requests?status=pending\|approved\|denied\|expired\|all` | Requests for the owner, newest first, at most 200 (default `pending`): `{items: AddDeviceRequestView[]}` `{id, pairingId, role, kind, name, platform, scopes, confirmation, fingerprint (hex SHA-256 of the key), via: direct\|relay, status, deviceId, createdAt, expiresAt, decidedAt}`. Committed requests that were never revealed are never listed |
| `POST` | `/api/v1/devices/add/requests/:id/approve` | `{confirmation}` (`123456` or `123 456`): the digits the device shows, which must equal the request's. Creates the device record: `active` for a browser or app, `pending` until it registers for `novad` and compute nodes; its `kind` is `compute` for a compute node, `wake-helper` for a `novad` Wake Helper, else `client`; roles `[role]`, scopes as chosen. Returns `AddDeviceRequestView`. Refusals: `validation` `{reason: confirmation_mismatch, field: confirmation}`, `policy_denied` `{reason: key_revoked}`, `conflict` `{reason: decided, status}` or `{reason: key_in_use}`, `request_expired`, `not_found`. Audited as `device.add.approve`; `device.add.decided` |
| `POST` | `/api/v1/devices/add/requests/:id/deny` | Returns `AddDeviceRequestView`. Takes effect only while the request is still pending: if an approval won, `conflict` `{reason: decided, status}` and nothing is audited or announced. Audited as `device.add.deny`; `device.add.decided` |
| `POST` | `/api/v1/devices/compute/enroll` | The scripted path for a compute node (ADR-089, M6.5): 201 `{token: "nve_…", expiresAt}`, one use, 15 min, for `nova-compute enroll --token`; creating it with a session is the owner's approval. (M2 returned this from `add/start {role: compute}`) |
| `GET` | `/api/v1/devices/all` | Every device record of the account, whatever it runs, oldest first (FR-140, M6.5): `{items: DeviceSummaryView[]}` `{id, name, kind, addedAs: browser\|novad\|compute\|native\|null, roles, scopes, platform, status: pending\|active\|revoked\|unreachable, fingerprint, sessions (live device sessions), novadVersion, lastSeenAt, createdAt}` |
| `PUT` | `/api/v1/devices/:id/scopes` | Replace a device's scopes `{scopes (≤ 20)}` (`docs/22` §4.2) → `DeviceSummaryView`; a revoked device is `conflict` `{reason: revoked}`. `offline-replica` and `local-runtime` also set the device's capability flags; the other scopes are recorded and shown, not yet enforced. Since M7 `offline-replica` gates the replica routes of `/api/v1/sync` (removing it ends the replica: `sync.replica.revoked`), and `local-runtime` reaches a `novad` device in its next heartbeat answer and lets a replica push its local model's answers. Audited as `device.scopes.update`; `device.scopes.changed` |
| `GET` | `/api/v1/agent/dist/:file` | Signed `novad` builds for the one-line install (FR-133, `docs/22` §4.3; public, above). Serves `novad-manifest.json`, `novad-manifest.sig` and each build the manifest lists, `novad-<linux\|darwin\|windows>-<amd64\|arm64>` (`.exe` for Windows); every other name is 404. The manifest is `{version, files: [{name, os, arch, sha256, size}], hubFingerprint, signedAt}`; the signature is standard base64 of the Hub identity's Ed25519 signature over `nova-novad-manifest-v1\n` followed by the manifest's exact bytes, re-signed only when a build or the identity changes, and 404 while the Hub has no identity. Builds come from the folder in `NOVA_NOVAD_DIST` (with an optional `VERSION` file); empty files and files over 512 MiB are skipped. `Cache-Control: no-store`, `Content-Length`, attachment disposition for builds. Over 60 a minute from one address: 429 `rate_limited` `{reason: address_rate_limited}` |
| `GET` | `/api/v1/devices?role=` | List devices with role, scopes, health, reachability, `novad` version. Without `role`, or `role=compute`, compute nodes as `NodeView` (M2); `role=client\|wake-helper` lists the `novad` devices whose roles include it as `DeviceView` (M6; `GET /devices/novad` lists them all; `GET /devices/all` lists every record) |
| `PATCH` | `/api/v1/devices/:id` | Edit a `novad` device (M6) `{name? (1–100), capabilityOverrides?, policy?, updateChannel?: stable\|beta\|nightly}`. `capabilityOverrides` (FR-142) replaces the Hub's set and takes only the Advanced fields: `models {storagePaths, cacheQuotaBytes}`, `computePolicy {gpuSharing, vramReserveBytes, maxConcurrentJobs, maxJobDurationSec}`, `scheduling {quietHours, routingWeight, energyPriceTier}`, `limits {maxEgressMbps}`, `power {policy, thermalLimitC}`, `locale {locale}`; detected facts cannot be overridden. `policy` (FR-150) `{routingEligible?, allowedModules?, resourceCaps?: {memoryBytes, cpuSeconds, openFiles}, quietHours?}` is merged. A change goes to the device at once (it answers with its re-signed capability document, which must verify against the pinned key) or with its next heartbeat; `configPending` is true until then. Returns `DeviceView`; a revoked device is `conflict`. Audited as `device.update`; `device.overrides.changed` |
| `POST` | `/api/v1/devices/:id/wake` | Wake-on-LAN (FR-144, FR-138). `capability_missing` `{reason: not_wakeable}` unless the signed document reports `power.wakeable` and a MAC. M6.5 routes it through a Wake Helper: an active `novad` device with the `wake-helper` role (only those in `network.wakeHelpers`, in that order, when the setting lists any) on the target's LAN. A device's LAN is what it last reported: the physical subnets in its heartbeat's `power.lan` (exact), else its endpoint address with the prefix of the Hub's own interface on that network, else /24 (IPv4) or /64 (IPv6); loopback and mesh addresses never match. The Hub calls the helper's `POST /agent/v1/power/wake-other` (§3) with the broadcast address computed from the subnet (a reported one is ignored). With no helper, the Hub sends a directed broadcast itself only from a physical LAN interface on the target's subnet; else 409 `conflict` `{reason: no_wake_helper, tried}`, logged as a failed wake and audited with `via: null`. The limit counts every attempt (pending, sent, failed) in the last hour, recorded in one transaction before anything is sent: past `devices.wakesPerHour` (default 6), 429 `rate_limited` `{reason: wake_rate_limited, limit}`. Returns `{id, deviceId, mac, status: sent, createdAt, via}` (`via`: the helper's device id or `hub`); a send that fails is `server_error`. Works while the target is unreachable. Audited as `device.wake` (with `via`); `device.wake.sent` |
| `POST` | `/api/v1/devices/:id/revoke` | Revoke any device: a compute node, a `novad` device, or (M6.5) a browser or app added with a code or an approved device that never registered; tried in that order, `not_found` when none has the id. Returns `{ok: true}`. For `novad` the device credential and the management token are deleted, its agent connections and the Hub's copy of its grants are revoked, and it becomes `revoked` (`device.status.changed`); the device stops its modules and wipes its credentials when its next heartbeat gets 401. A browser or app becomes `revoked`, its credential goes and its transport endpoints are marked unhealthy (`device.status.changed`). For every kind (M6.5, `docs/22` §4.5) its device sessions are deleted, its key is blocked (a later `complete`, approval or Relay claim with it is `policy_denied` `{reason: key_revoked}`), an enrollment token bound to it and a grant it has not collected are refused, its device certificates are revoked and its Relay client is revoked. Audited as `device.revoke` (compute nodes by the add-device area) |
| `GET` | `/api/v1/devices/tls` | What each `novad` device and compute node last presented over HTTPS (FR-126, M7): `DeviceTlsSummaryView` `{requireCertificate, items: [{deviceId, kind: novad\|compute, name, certificate: verified\|missing\|refused, reason, serial, lastHttpsAt}], problems}`, newest first; `requireCertificate` is `devices.tls.allowWithoutCertificate` turned off; `problems` are plain sentences (also in diagnostics). Kept in Hub memory, rebuilt by the next heartbeat; a revoked device is forgotten. Plain HTTP and Relay-tunnelled requests are not checked (§3) |

### Chat, projects, files

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/projects` | List/create projects (`memoryScope: shared\|project_only`, fixed at creation, FR-205) |
| `GET/PATCH/DELETE` | `/api/v1/projects/:id` | Project / rename, instructions (FR-034) / soft delete; its chats stay, detached |
| `GET/POST` | `/api/v1/projects/:id/sources` | List / add a source (file as base64 or pasted text); indexing runs in the background, `pending → indexing → ready\|error`, with `source.status.changed` events (FR-040). M2 indexes text types only |
| `POST` | `/api/v1/sources/:id/reindex` | Index again |
| `DELETE` | `/api/v1/sources/:id` | Remove; its chunks leave retrieval at once |
| `GET/POST` | `/api/v1/projects/:id/folders` | Local project folders as `ProjectFolderView` / bind one `{path, access: read\|write}` (201) (FR-035). The path is resolved to its real path (`~` is the Hub user's home). `policy_denied` `{reason: protected_folder}` for the filesystem root, the home folder or a folder containing it, the Hub data folder (inside, equal or containing) and credential locations; `validation` for a relative or missing path, a file, or a 21st folder (`{reason: too_many_folders}`); `conflict` for the same folder twice. Indexing runs in the background (`project.folder.indexed`): each text file becomes a source whose bytes stay in the folder. Symlinks are not followed; version-control, dependency and build folders, top-level `.gitignore` patterns, protected paths, binaries and files over 20 MB are skipped; at most 5,000 files. A bound folder is also a tool root for the project's chats, with `access` capped by the permission profile (FR-190) |
| `POST` | `/api/v1/projects/:id/folders/:fid/reindex` | Index the folder again; returns it |
| `DELETE` | `/api/v1/projects/:id/folders/:fid` | Unbind; its sources leave retrieval at once and the files on disk are untouched |
| `GET/POST` | `/api/v1/threads` | List (`mode`, `archived`, `q`, `projectId`, `cursor`, `limit`; pinned first, then most recent; side chats excluded) / create conversations (`temporary`, `memoryOptOut`, `projectId`). Shapes: `packages/shared/src/api.ts`. Since M5 each listed `ThreadView` carries `derived` `{status: needs_input\|blocked\|running\|ready, reason}` (FR-215), counting its child threads |
| `GET/PATCH/DELETE` | `/api/v1/threads/:id` | Thread with its active path, version info, citations and follow-up queue (its `thread.derived` filled as in the list; since M5 a user message Nova started has `provenance` `run\|schedule\|goal\|subagent\|system` (M7: `sync` for a user message a replica wrote offline, `offline` for an answer a device's local model wrote), a compaction is a `summary` message with a `compaction` part, and a reply may carry a `notice` part) / rename, pin, archive, model, reasoning level, memory opt-out, project / soft delete; a temporary thread is purged (FR-027) |
| `POST` | `/api/v1/threads/:id/messages` | Send a message: 202 `{disposition, turnId, userMessageId, assistantMessageId, queuePosition?}`; output arrives as events (§5). Body up to 30 MB with attachments, else 413. While a turn runs, `inputMode` (or the `general.followUp` setting) decides (FR-019): `steered` joins the running turn and is applied at the start of its next model step; `queued` is persisted and runs as the next turn, surviving a restart; its id becomes the `userMessageId` of the message it creates |
| `GET` | `/api/v1/threads/:id/queue` | Queued follow-ups, oldest first |
| `DELETE` | `/api/v1/threads/:id/queue/:queuedId` | Cancel a queued follow-up |
| `POST` | `/api/v1/threads/:id/messages/:mid/edit` | Edit a user message as a new sibling version and run it; prior turns are kept (FR-020) |
| `POST` | `/api/v1/threads/:id/messages/:mid/regenerate` | Add a sibling reply to the same user message (FR-020) |
| `POST` | `/api/v1/threads/:id/active` | Switch the active path to the one through `{messageId}` (the thread's own messages only); returns the thread detail; `conflict` while a turn runs |
| `DELETE` | `/api/v1/threads/:id/messages/:mid` | Soft-delete a message (a user message takes its reply with it); excluded from view, context and search |
| `POST` | `/api/v1/threads/:id/branch` | Branch from `{fromMessageId}` into a new thread that inherits the path by reference (FR-020, FR-033) |
| `GET` | `/api/v1/threads/:id/tree` | The lineage tree: root, branches and side chats (FR-033) |
| `POST` | `/api/v1/threads/:id/side` | Side chat `{text, model?}`: a child thread that reads the parent's context and adds no turns to it (FR-026) |
| `GET` | `/api/v1/threads/:id/turns` | Turns with their items (`docs/06` §2), paged |
| `GET` | `/api/v1/threads/:id/stream` | SSE stream of this thread's events and server requests (§5). Opens with a `: connected` comment. With `Last-Event-ID` or `?after=` it first replays persisted events after that id (ids compare as UUIDv7, so an ephemeral id works); without a cursor it sends live events only, so clients load the thread first and refetch on `chat.message.completed` |
| `POST` | `/api/v1/threads/:id/cancel` | Cancel generation; the turn ends `interrupted` |
| `GET` | `/api/v1/threads/:id/suggestions` | Up to three follow-up prompts `{items: string[]}` after the last completed turn (FR-028), generated once per turn by the turn's model (a heuristic with the mock provider or when the model fails); empty when `chat.suggestions` is off, for a temporary chat, and while a turn runs or waits |
| `POST` | `/api/v1/threads/:id/handoff` | Move a chat to another of the account's devices (FR-213, M7) `{to: {deviceId}, interrupt?}` → `SessionHandoffView` (`sessionId: null`). A recorded, announced move (`session.handedOff`, audited as `thread.handoff`) that takes effect from the next turn; turns still run on the Hub. Code sessions move with `POST /code/sessions/:id/handoff` |
| `POST` | `/api/v1/threads/:id/messages/:mid/answer` | Answer a user message a replica wrote offline (FR-112, M7), which the Hub recorded without a turn: `{model?, reasoningLevel?}` (as regenerate) → 202 `{disposition, turnId, userMessageId, assistantMessageId}` as for sending. It reuses the stored message (no copy) and runs it through the normal turn, so prompt hooks and user text apply. Any session of the account; replays a repeated `Idempotency-Key`. Refusals: 409 `conflict` `{reason: turn_in_progress}`, `{reason: answered}` (it already has a reply), `{reason: not_last}` (later messages follow it); 400 `validation` `{reason: not_user_message}`, `{reason: shared_thread}` (another member's words never run under the caller's authority) |
| `GET/POST` | `/api/v1/files` | List/upload files (projects, artifacts, window-capture attachments, FR-214) |
| `GET` | `/api/v1/search?q=` | Search message text (`projectId?`), ranked by relevance (FTS5 bm25, recency breaks ties); snippets mark matches with `<mark>…</mark>` and are otherwise plain text; temporary, side and deleted threads and deleted messages excluded (FR-025). Vector ranking joins when local embeddings land |
| `GET` | `/api/v1/attachments/:id` | Attachment bytes with their type; `Content-Disposition: attachment` except images |

### Workspace: files, terminals, library

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/files/roots?threadId=&projectId=` | Folders the file browser may open (FR-039): exactly the roots the thread's tools get, the project's folders included (none for a Code session on another machine: its folder is not on the Hub); `{items: [{path, label, access: read\|write}]}` |
| `GET` | `/api/v1/files/list?root=&path=` | A folder's entries as `FileEntryView` (at most 5,000). A path outside the roots or a protected path is `policy_denied` `{reason: path_denied}`; symlinks are listed only when they point inside the roots; the Hub data folder is hidden |
| `GET` | `/api/v1/files/content?root=&path=` | `FileContentView`: `text` for text files up to 5 MB (else `null`; fetch `/files/raw`), `sha256` to pass back on save, `readOnly` |
| `PUT` | `/api/v1/files/content` | Save `{root, path, text, baseSha256}` (text ≤ 5 MB; `baseSha256: null` creates a file); returns `FileContentView`. The save passes the policy gate as `fs.write` with origin `ui` and the user's own instruction, so it is allowed without a card unless a rule or a confirm-every-time step asks; then the answer is 202 `{approvalId}` and the save runs once it is approved. A file that changed, appeared or was deleted since it was read is `conflict` `{reason: changed\|exists\|deleted, sha256}` (the current hash; files over 256 MB are versioned by size and modification time). A denied or timed-out approval is `policy_denied` `{reason: denied\|timeout, approvalId?}`. The file mode is kept; audited as `fs` / `fs.write` |
| `GET` | `/api/v1/files/raw?root=&path=` | The file's bytes, inert: `Content-Security-Policy: default-src 'none'; img-src data:; sandbox`, `nosniff`, `Content-Disposition: inline` |
| `GET/POST` | `/api/v1/terminals` | This account's terminals as `TerminalView` / open one `{root?, threadId?, cols, rows}` (201) in the sandbox, with the thread's roots and permission profile (FR-006); `root` defaults to the first root. Without a sandbox: 409 `sandbox_unavailable`. At most 4 running per account (`conflict` `{reason: too_many_terminals}`). Terminals live in Hub memory only: one that no client has watched for 15 minutes is closed, and the last 256K characters of output are replayed to a viewer that reconnects. Commands typed in a terminal are confined by the sandbox and the profile, not checked one by one. Audited as `terminal.open` and `terminal.close` |
| `DELETE` | `/api/v1/terminals/:id` | Close it (`terminal.exited` with `code: null`) |
| `GET` | `/api/v1/exec/sessions?threadId=` | The agent's commands still running as interactive exec sessions (FR-184), for the terminal pane: `{items: ExecSessionView[]}` `{id, threadId, turnId, callId, cmd, cwd, startedAt, retained}` (`cmd` redacted, ≤ 500 characters; `retained` once its turn ended and the run kept it). Without `threadId`, every session of the account; another account's thread is `not_found`. Sessions live in Hub memory (8 per thread) |
| `DELETE` | `/api/v1/exec/sessions/:id` | Kill one: `{ok: true}`, `exec.session.ended` with `reason: killed`, audited as `exec.session.kill`. An unknown session or another account's is `not_found` |
| `GET` (WebSocket) | `/api/v1/terminals/:id/ws` | The terminal's stream (frames in §5). The session is checked before the upgrade (401 `token_required`); an unknown terminal closes the socket with 4404, an invalid id with 4400 |
| `GET` | `/api/v1/library?kind=&q=&cursor=&limit=` | One paged list (FR-041), newest first, as `Page<LibraryItemView>`: `kind` is `artifact\|attachment\|source\|image\|file` (`file` = artifacts of kind `file`, `image` = image attachments) and `q` searches titles. Project-folder files, temporary chats and deleted chats are left out |

### Providers, models, account

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/providers` | List / add provider accounts; each carries `active` (FR-115). `apiKey` is write-only: stored in the secret vault, never returned; the database holds only a `secret://` reference (FR-101) |
| `PATCH` | `/api/v1/providers/:id` | `{active: true}` (nothing else): make it the active account of its provider kind (FR-115); returns the account; `provider.account.activated`. Without a choice the oldest live account of a kind is active. Models the active account shares with another account of its kind are listed for it alone, so new chats and the built-in presets use it |
| `DELETE` | `/api/v1/providers/:id` | Remove an account and its secret; removing the active account makes the next one of its kind active |
| `POST` | `/api/v1/providers/:id/test` | Connect and list models; returns `{ok, detail?, models?}` and never fails the request for a bad key |
| `GET` | `/api/v1/models` | Presets first (`ref: "preset:<id>"`, `disabledReason` when no target is usable), then models of all active accounts (`ref: "<accountId>/<modelId>"`), then compute-node models (`ref: "node:<nodeId>/<modelId>"`); each with `kind`, `source`, `label`, `reasoning` (FR-023, FR-221) |
| `GET/PUT` | `/api/v1/presets` | The Faster ↔ Smarter presets `{items, builtIn}`; `PUT {items: []}` restores the built-in set generated from the configured models (FR-221, `docs/07` §8.1) |
| `GET` | `/api/v1/providers/detect` | Probe local model servers (Ollama, llama.cpp, `NOVA_DETECT_URLS`); never sends credentials (`docs/07` §12) |
| `GET/PATCH` | `/api/v1/account` | Profile (FR-113): `AccountView` `{accountId, displayName, username, hasAvatar, createdAt}` / update `{displayName?, username?, avatar?}` (body ≤ 4 MB). A blank display name clears it. `username` matches `^[a-z0-9][a-z0-9_-]{1,31}$` and is unique among live accounts (`conflict` `{field: username, reason: taken}`). `avatar` is `{mime: image/png\|image/jpeg\|image/webp, data}` (base64, ≤ 2 MB), checked by its bytes, stripped of metadata and stored as a sealed blob, or `null` to remove it; a bad image is `validation` `{field: avatar, reason}`. `account.updated` |
| `GET` | `/api/v1/account/avatar` | The avatar image (`Content-Security-Policy: default-src 'none'; sandbox`), or 404 |
| `GET` | `/api/v1/usage?from=&to=` | Usage insights (FR-114), computed on the Hub from `usage_event` and `turn`: `UsageSummary` with totals, by model, by project, by UTC day (days with usage only), active days, streak and the longest completed turn; the default range is the last 30 days |

### Tasks, goals, agents, approvals, requests

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/runs` | List `?status=active\|all` (default `active`: planning, running, waiting for approval or paused), `projectId`, `cursor`, `limit` (≤ 200, default 50), newest change first: `{items: RunView[], nextCursor}` / create `{objective (≤ 8,000), title?, projectId?, autonomy?: ask_first\|standard\|autonomous, budgets?: {timeSeconds?, tokens?, costUsd?}, goal?: {objective, budgets?}, expectedOutput?: {kind: artifact\|message\|file, ref?}, model?, attachmentIds?, template?: deep_research}` (201 `RunView`). A run is a `work` thread plus its run; the user typed the objective, so it carries their authority (FR-189). It starts at once, except `ask_first`, which waits in `planning` until `start`. Defaults come from `runs.defaultBudgets` and `runs.autonomy`; budgets are bounded (time 60 s–7 days, tokens 1,000–100M, cost ≤ 100,000; `costUsd: null` means the provider spend cap). An autonomous run (given or by default) without `review.model` is `validation` `{field: autonomy, reason: review_model_required}`, since the auto-reviewer would deny every consequential action (FR-085). Audited as `run.create` (FR-051, FR-182, FR-220) |
| `GET` | `/api/v1/runs/:id` | One `RunView` with plan, budgets and use, result and `derived` status; another account's run is `not_found`. M7: `RunView.environmentId` is the cloud environment of a Work run started on one (`POST /cloud/work`), null for a run on the Hub |
| `POST` | `/api/v1/runs/:id/{pause,resume,cancel,start}` | Control a run; each returns the `RunView`. `start` begins a run waiting in `planning` (an ask-first plan, or a run proposed in a chat, FR-186) and gives its objective and plan the user's authority; `conflict` when it is not in `planning`. `pause` (reason `user`) is `conflict` once the run ended; `cancel` ends the run and its sub-agents (an ended run is left as it is). `resume` is `conflict` unless paused, and `budget_exhausted` `{bound}` while a budget that paused it is still used up. Audited as `run.<action>` |
| `POST` | `/api/v1/runs/:id/redirect` | New instructions `{text}` (≤ 8,000) that steer the run (FR-019): a turn now, or after the running turn ends; a paused run resumes, except one a budget paused, which takes the text once the budget is extended. Audited as `run.redirect` with the text's hash only; `conflict` once the run ended |
| `POST` | `/api/v1/runs/:id/budget` | Extend a budget `{timeSeconds?, tokens?, costUsd?, steps?: true}` (FR-182); at least one field. Each amount is added to the current bound (`{timeSeconds: 1800}` is 30 more minutes); `costUsd` does nothing while the run has no cost cap; `steps: true` allows one more turn after the 200-step backstop. A run that this bound paused resumes when it now fits (a goal budget still used up keeps it paused). Returns the `RunView`; `run.budget.extended`; audited as `run.budget.extend` |
| `PUT` | `/api/v1/runs/:id/plan` | Replace the plan `{steps: [{title, detail?}]}` (1–50); the user wrote it, so it is approved. Returns the `RunView`; `run.plan.amended`; `conflict` once the run ended |
| `GET` | `/api/v1/runs/:id/subagents` | `{items: SubagentView[]}` `{id, runId, threadId, role, objective, status: queued\|running\|done\|failed\|cancelled, result, createdAt, endedAt}` (FR-053) |
| `GET` | `/api/v1/runs/:id/activity` | The run's trace, oldest first (FR-057): its thread's turns, tool calls, approvals and policy decisions merged with its plan, step, status, budget, sub-agent, goal and result events (`{items: ActivityItemView[]}`; run events have kind `notice`). Sub-agent threads are not included |
| `GET/PUT/DELETE` | `/api/v1/runs/:id/goal` | Read (the open goal, else the latest; `null` when there is none) / set `{objective (≤ 4,000), budgets?: {timeSeconds?, tokens?, costUsd?}}`, which replaces an open goal's objective and budgets (`conflict` once the run ended) / clear the open goal (`{ok: true}`; its row is deleted, and a run that only waited on it finishes) ([`goal.json`](schemas/goal.json), FR-181). GET and PUT return `GoalView`. Audited as `goal.set` / `goal.clear` |
| `GET` | `/api/v1/goals?status=` | `{items: GoalView[]}` across runs and, since M6, agents (`agentId` set, `runId` null) (FR-181); `PATCH /goals/:id` and `/goals/:id/{pause,resume,complete}` work on agents' goals too. An agent's goal is set with `PUT /agents/:id/goal` ("Agents" below) |
| `GET/PATCH` | `/api/v1/goals/:id` | Read; edit `{objective?, budgets?}` (applies at the next turn; audited as `goal.update`) |
| `POST` | `/api/v1/goals/:id/{pause,resume,complete}` | User status changes; `usage_limited`/`budget_limited` are never settable here. A change the status does not allow does nothing. Resuming (or reopening a complete goal) while its budget is used up is `budget_exhausted` `{bound}`; reopening when the run has another open goal is `conflict`. Returns `GoalView`; audited as `goal.status` |
| `GET/POST` | `/api/v1/schedules` | `{items: ScheduleView[]}` / create (201 `ScheduleView`) `{when: {cron}\|{rrule}\|{intervalSeconds}\|{at}, timezone, startsAt?, endsAt?, title?, instructions (≤ 8,000), notifyCondition?, deliveryTargets? (default `[{kind: inapp}]`, ≤ 10), output?, catchUp?: {policy?: once\|skip, lookbackSeconds?}, projectId?, autonomy?, enabled?}` ([`schedule.json`](schemas/schedule.json), FR-055). Each fire starts a Work run (origin `schedule`) whose objective is the instructions. The strict body has no `origin`: the API creates only the user's own schedules. A rule that fires more than once a minute, has no future fire, or uses `BYSETPOS`, `BYYEARDAY`, `BYWEEKNO` or `SECONDLY` is `validation` naming the field (`when.cron`, `when.rrule`, …). Audited as `schedule.create`; `schedule.created`. M6: `ScheduleView` gains `agentId` (null unless the schedule wakes an agent) and `wakeReason` (an agent's self-set wake); `origin` adds `agent` (`schedule.create`) and `agent_self` (`schedule.wake`). The list includes agents' schedules and wakes, and `PATCH`/`DELETE` work on them (the user cancels an agent's wake here); a schedule for an agent is created with `POST /agents/:id/schedules`; delivery targets `slack` and `teams` take a channel binding id as `ref` |
| `PATCH/DELETE` | `/api/v1/schedules/:id` | Edit the fields sent (`enabled: false` pauses it; resuming does not catch up the paused time; `nothing to update` is `validation`) / cancel it: `{ok: true}`, its history and webhook secret go, a run already going continues; proxied by the shell's `schedule.upsert` / `schedule.cancel`. Audited as `schedule.update` / `schedule.delete` |
| `GET` | `/api/v1/schedules/:id/fires?limit=` | The schedule's history, newest first (`limit` 1–500, default 100): `{items: ScheduleFireView[]}` `{id, scheduleId, kind: fire\|catch_up\|skipped, window: {first, last, count}\|null, runId, outcome: done\|output_missing\|failed\|cancelled\|no_news\|null, firedAt}` (ADR-079) |
| `POST` | `/api/v1/schedules/:id/run` | Run now, outside the rule (the next fire is unchanged): 201 `{runId}`; `schedule.fired` with `manual: true`; audited as `schedule.run_now`. `capability_missing` when Work runs are unavailable, `server_error` when the run could not start. M6: for an agent's schedule 201 `{runId: null, threadId}` (a turn on the agent's main thread); `capability_missing` when agents are unavailable |
| `GET/POST` | `/api/v1/approvals` | List (`status=pending\|all`, `threadId`; a handed-off approval stays pending until marked done) / decide approvals; a decision is an [`ApprovalDecision`](schemas/approval-decision.json) without `decidedBy`/`decidedAt`, which the Hub sets. The first valid answer wins; a later one is `conflict`. A decision the tier does not offer is `validation`; `allow_always` while managed policy disables persistent grants is `policy_denied` (FR-100, FR-189). Allow once on a card the auto-reviewer opened records `override` (audited as `review.override`, FR-085). M5 ships `ApprovalView` without the reviewer's verdict (stored in `docs/06` `approval.review_json`); showing it on the card is a follow-up. M7: every `ApprovalView` also carries `runId` (its thread's Work run, else the run stored on the approval), `codeSessionId` and `threadTitle`, looked up from its thread (null for a deleted thread); the shared type marks them optional, the Hub always fills them |
| `GET` | `/api/v1/approvals/:id` | One approval as shown on the card |
| `POST` | `/api/v1/approvals/:id/handoff-done` | The user finished a handed-off step `{note?}`; the waiting turn resumes |
| `GET` | `/api/v1/requests?status=pending\|all&threadId=` | Server-to-client requests ([`server-request.json`](schemas/server-request.json), FR-188), newest first: the pending ones (default) or the last 200 of any status, plus pending approvals as read-only `approval` items whose id is the approval id. `{items: ServerRequestView[]}`. With the `x-nova-client-session` header, requests aimed at another device are left out |
| `GET` | `/api/v1/requests/:id` | One request, or a pending approval as an `approval` item; otherwise `not_found` |
| `POST` | `/api/v1/requests/:id/respond` | Answer `{result}` (§5); returns the resolved `ServerRequestView`. The first valid answer wins: a later one is `conflict` with `details.resolution`; one after `expiresAt` is `request_expired` `{status, reason}`; one that does not fit the kind is `validation`; a request aimed at another device than the `x-nova-client-session` header names is `policy_denied`. An approval id takes an `ApprovalDecision` without `approvalId` and is decided by the approvals flow (no `request.resolved`; `approval.decided`). M5 ships `ServerRequestView.resolution` as `{by, at, result}`; the schema's `{result, resolvedBy, deviceId, resolvedAt}` is a follow-up |
| `GET` | `/api/v1/activity?ref=` | Activity trace for a thread/run/agent, oldest first: turns, tool calls, approvals, policy decisions; `not_found` for another account's thread. M5 takes a thread id only (a run's trace is `GET /runs/:id/activity`, or this route with the run's thread). M6 still takes a thread id only; an agent's trace is `GET /agents/:id/activity`. Since M6 `ActivityItemView.kind` adds `computer` (browser and screen actions, `browser.navigated`), with `shots: {before, after}` (API paths) when screenshots exist |
| `GET` | `/api/v1/audit?kind=&threadId=&cursor=&limit=` | Audit entries, newest first, paged by sequence (FR-104) |
| `GET` | `/api/v1/audit/verify` | Walk the hash chain; reports the first entry whose sequence, previous hash or hash does not match |
| `GET` | `/api/v1/audit/export` | Audit log export (`application/x-ndjson`, redacted) |
| `GET` | `/api/v1/notifications?unread=` | Notifications, newest first, with the unread count (FR-013). Since M6 a category whose in-app rule is off is recorded read (no badge; `docs/13` §5) |
| `POST` | `/api/v1/notifications/read` | Mark `{ids}` or `{all: true}` read (one of them is required) |
| `DELETE` | `/api/v1/notifications/:id` | Delete a notification |

### Permissions, rules & hooks

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/policy/rules` | Tool/resource rules ([`policy-rule.json`](schemas/policy-rule.json)) |
| `PATCH/DELETE` | `/api/v1/policy/rules/:id` | Edit/delete a rule |
| `POST` | `/api/v1/policy/evaluate` | Preview the decision for a hypothetical action (FR-084 preview); no side effects |
| `GET/POST` | `/api/v1/permission-profiles` | Permission profiles ([`permission-profile.json`](schemas/permission-profile.json), FR-190): built-ins `read-only`, `workspace`, `full` and user ones |
| `GET/DELETE` | `/api/v1/permission-profiles/:id` | Built-in and managed profiles are read-only (editing in place arrives later; create a new one) |
| `GET/POST` | `/api/v1/command-rules` | Command prefix rules ([`command-rule.json`](schemas/command-rule.json), FR-191); a rule whose examples fail is rejected with `validation` |
| `PATCH/DELETE` | `/api/v1/command-rules/:id` | Edit/delete a rule (examples re-checked) |
| `POST` | `/api/v1/command-rules/test` | Match `{command, threadId?, projectId?}` against the rules in that scope; returns the decision and the matching rule. A failing rule example on create or edit is `validation` with `details: {field: matchExamples\|notMatchExamples, example}` |
| `GET` | `/api/v1/permission-grants` | Remembered session and always grants |
| `DELETE` | `/api/v1/permission-grants/:id` | Revoke a grant |
| `GET/PUT` | `/api/v1/tool-defaults` | Per-tool defaults `{tool, default: allow\|ask\|deny\|null}` (FR-048); `null` clears one |
| `GET` | `/api/v1/tools?threadId=` | Built-in and MCP tools with the user's default and the effective decision preview (FR-048) |
| `GET/POST` | `/api/v1/hooks` | Hooks from every source with trust state as `HookView` ([`hook-config.json`](schemas/hook-config.json), FR-197): managed policy, `<dataDir>/hooks.json`, each project folder's `.nova/hooks.json` and plugins. Files are re-read and re-hashed on every list, so a changed hook or script shows `needs_trust` with `changedSinceTrust`. Ids are `hook:<origin>.<hookId>` (`hook:project:<projectId>.<hookId>` for project hooks). M4 ships `GET` only (hooks are added by editing a hooks file or installing a plugin) and `HookView.matcher` as one string with the globs joined by `, `; `POST` and a matcher list are a follow-up |
| `PATCH/DELETE` | `/api/v1/hooks/:id` | Enable/disable `{enabled}` or delete a user hook (deleting also removes it from `hooks.json`); a hook from any other source is `policy_denied` (plugin hooks follow their plugin) |
| `POST` | `/api/v1/hooks/:id/trust` | Trust `{contentHash}`: must equal the current hash, else `conflict` with `details.contentHash` (the current one); managed hooks are trusted by policy; `hook.trust.changed` |
| `POST` | `/api/v1/hooks/:id/untrust` | Revoke trust; the hook stops at once; managed hooks are `policy_denied` |

### Memory & import

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/memory/items?scopeKind=&scopeRef=&category=&q=&status=` | Memory items, pinned first (FR-032, FR-204) / add one by hand |
| `PATCH/DELETE` | `/api/v1/memory/items/:id` | Correct, pin, dismiss or delete an item |
| `POST` | `/api/v1/memory/import` | Import facts from a provided export (JSON array or one per line); duplicates skipped (FR-032) |
| `GET` | `/api/v1/memory/summary?scopeKind=&scopeRef=` | The current injected summary (≤ 2,500 tokens) and its source run (`scope` is accepted for `scopeKind`). Correcting, dismissing or deleting an item clears its scope's summary until the next run |
| `POST` | `/api/v1/memory/consolidate` | Start a consolidation run now `{scope}` |
| `GET` | `/api/v1/memory/consolidations` | Consolidation run history |
| `PATCH` | `/api/v1/memory/topics` | "Remember more / less about this topic" `{topic, preference: more\|less\|default}` |
| `POST` | `/api/v1/import/preview` | Scan sources `{deviceId, paths[], kinds[]}` through `novad`; returns items, targets, conflicts, masked secrets, duplicates (FR-200). M4 ships a Hub-local scan `{paths[] (≤ 20), kinds[]}` with no `deviceId`; scanning a device through `novad` is a follow-up. `kinds` are `instructions\|skills\|commands\|plugins\|mcp_servers\|projects\|memories\|chats`; symlinks are not followed and sizes are capped. Returns `ImportPreview` `{previewId, items}`: each item with its target, SHA-256, status `new\|duplicate\|conflict\|unsupported` and its secrets masked with the `secret://` reference each becomes. Nothing is written; a preview expires after 30 min |
| `POST` | `/api/v1/import/apply` | Import selected preview items `{previewId, items[]}`; plugins and MCP servers stay disabled. Returns `ImportResult` `{importId, imported, duplicates, disabled, secretsMigrated}`. Skills become user skills with an import origin; every secret goes to the vault; one `import_record` per item; source files are never modified; a failed item does not block a retry, and a name conflict is imported under the next free name. An expired preview is `not_found` `{reason: preview_expired}`; `import.completed` |
| `GET` | `/api/v1/import/records` | Import ledger as `ImportRecordView` (source, kind, SHA-256, target, time), newest first |

The "reference past chats" toggle (FR-205) is the setting `memory.referencePastChats`.

### Code, tools, extensions

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/environments` | Where Code sessions run (FR-062): `{items: SavedEnvironmentView[]}`, the built-in `local` one ("This Hub", health-checked on every list) first, then by creation. `SavedEnvironmentView` is M5's `EnvironmentView` `{id, kind: local\|container\|ssh\|wsl\|device\|cloud\|vm, label, isolated, status: ok\|degraded\|down\|unknown, detail, checkedAt}` plus `{builtIn, connection, sessions, createdAt, updatedAt}`; `connection` never holds a secret (`{kind: container, image, setupScript}`, `{kind: ssh, host, port, user, auth, hostKey, root, hasCredential}`, `{kind: wsl, deviceId, distro}`, `{kind: device, deviceId, root}`), `sessions` counts the active sessions bound to it / create (201, `status: unknown`) with `label` (1–100) and, by kind: `container` `{connection: {image, setupScript?}}` (an image reference ≤ 300 characters, never shell syntax; a setup script ≤ 20,000 characters, run once per session); `ssh` `{connection: {host, port? (default 22), user, auth: key\|password, hostKey?, root?}, credential: {privateKey?, passphrase?, password?}}`; `wsl` `{connection: {deviceId, distro}}`; `device` `{connection: {deviceId, root?}}`. The SSH credential goes to the keychain (`secret://code/environment/<id>/credential`) and is never returned; a missing one is `validation` `{reason: credential_required}`; a device that is not the account's is `not_found` `{reason: unknown_device}`. Audited as `environment.created`; `environment.updated`. In the M6 Hub no SSH transport is bound, so SSH environments check `down` and their routes answer `capability_missing` `{reason: no_ssh_transport}`; the device connection has no WSL operations yet, so WSL answers `{reason: not_windows}`. M7 binds the SSH transport (`docs/10` §2): off until `code.ssh.enabled` (`capability_missing` `{reason: ssh_disabled}`); a host or user starting with `-` is `validation`. The `hostKey` is pinned on first connection (`environment.updated` `{change: hostkey_pinned}`, audited `environment.hostkey.pinned`); a different key later is refused and audited (`environment.hostkey.mismatch`). M7 also adds kind `cloud` (`createCloudEnvironmentSchema` in `packages/shared/src/m7/runner.ts`): `{kind: cloud, label, connection: {repoUrls (≤ 10, https or an allowed file://, never with a user name or password), setupScript?, baseImage?, caches? (≤ 8 names), network?: off\|setup\|on (default off), diskMb?, folder? (under /workspace)}}`; it needs the cloud runner (`/api/v1/cloud` below) and refuses network `setup` or `on` unless `cloud.runner.unrestrictedNetwork` is on (`validation` `{reason: cloud_network_off, field: network}`); credentials in a URL are `validation` `{reason: credentials_in_url}`. Its view's `connection` is `CloudConnectionView` `{kind: cloud, runnerEnvironmentId, repoUrls, setupScript, baseImage, caches, network, diskMb, folder}` (a member of `EnvironmentConnectionView`), and its `isolated` is false: the runner is another machine, so Bypass is not offered there (`docs/10` §12) |
| `GET` | `/api/v1/environments/wsl/distros?deviceId=` | WSL distros of a Windows device: `{items: [{name, default, state: running\|stopped\|unknown, version}]}`; `not_found` `{reason: unknown_device}`; `capability_missing` `{reason: no_device_provider\|device_offline\|not_windows}` (every device in M6) |
| `GET/PATCH/DELETE` | `/api/v1/environments/:id` | One `SavedEnvironmentView` / change `{label?, connection?, credential?}` (connection fields are merged over the saved ones; `credential` is SSH only and replaces the keychain entry; an SSH change of host, user or `auth` needs a new credential, `validation` `{reason: credential_required}`); a change resets `status` to `unknown`. Audited as `environment.updated` / remove it with its credential (204); `conflict` `{reason: in_use, sessions}` while active sessions use it. The built-in one is `validation` `{reason: built_in}`. Audited as `environment.removed`; both emit `environment.updated`. M7: a pinned SSH `hostKey` cannot be changed or cleared by an update (409 `conflict` `{reason: repin_required}`; reset it below); changing the host or port drops the pinned key (audited `environment.hostkey.reset`) |
| `POST` | `/api/v1/environments/:id/check` | Check health now; returns `SavedEnvironmentView`. `local`: Git and the sandbox; `container`: a container engine and `true` in the image with network off, else `down`; `ssh`, `wsl`, `device`: reconnect to `novad` and read its hello (20 s each): `ok` with its version and platform, `down` when its signature is not verified or the connection fails. A failed check is stored as `down` with its detail, not answered as an error. In-use non-local environments are also checked every 5 minutes; a status change emits `environment.health.changed`. Not audited |
| `POST` | `/api/v1/environments/:id/hostkey/reset` | Forget an SSH environment's pinned host key on purpose (the host was reinstalled); the next connection pins anew (M7). Returns `SavedEnvironmentView`; `environment.updated` `{change: hostkey_reset}`; audited as `environment.hostkey.reset` with the previous fingerprint |
| `GET` | `/api/v1/environments/:id/processes` | Processes the environment's `novad` helper runs (FR-078): `{items: [{id, environmentId, sessionId, cmd, cwd, running, exitCode, outputBytes, startedAt}]}` (`cmd` redacted; `sessionId` is the helper's process tag, in M6 the turn rather than the session). They keep running and buffering output while the Hub is disconnected. `local` and `container` are `validation`; `capability_missing` as above; `validation` `{reason: credential_missing}` |
| `GET` | `/api/v1/environments/:id/processes/:processId/output?offset=` | Buffered output from `offset` to reattach (FR-078): `{processId, data, offset, dropped, running, exitCode}`; `data` redacted, at most 256 Ki characters per read; `dropped` counts bytes the helper discarded before `offset` |
| `GET/POST` | `/api/v1/code/githosts` | Connected Git hosts (FR-070): `{items: GitHostView[]}` `{id, kind: github, label, apiUrl, webUrl, login, status: ok\|error\|unknown, detail, checkedAt, createdAt}` / connect `{kind: github, label?, apiUrl? (default https://api.github.com), webUrl? (default https://github.com), token}` (201). The token goes to the keychain (`secret://code/githost/<id>/token`) and is never returned. A 401 from the host is `validation` `{reason: token_rejected}` and nothing is saved; an unreachable host is saved with `status: error`. A second host with the same `webUrl` is `conflict` `{reason: duplicate}`. Audited as `code.githost.connected` (kind `secret`) |
| `POST` | `/api/v1/code/githosts/:id/check` | Sign in again with the stored token; returns `GitHostView`. Not audited |
| `DELETE` | `/api/v1/code/githosts/:id` | Disconnect (204): the token leaves the keychain. `conflict` `{reason: in_use, pullRequests}` while pull requests opened through it are open. Audited as `code.githost.removed` (kind `secret`) |
| `GET/POST` | `/api/v1/code/sessions` | List `?archived=true\|false` (default `false`), newest change first: `{items: CodeSessionView[]}` / create `{folder, projectId?, environmentId?, permissionMode?, model?, title?, worktree?}` (201 `CodeSessionView`): a `code` thread bound to the folder (FR-061). `folder` is an absolute path on the Hub (`~` is the Hub user's home), resolved to its real path; a relative or missing path or a file is `validation` (`{reason: missing\|not_a_folder}`); the filesystem root, system folders, the home folder and its ancestors, the data folder (inside or around it), credential locations and `.git`, `.nova` or `.agents` are `policy_denied` `{reason: protected_folder}`. Without `permissionMode` the folder's remembered mode is used, else `code.permissionMode`, else Manual; one that cannot be used now falls back to Manual. A chosen mode that cannot be used is `validation` `{reason: mode_unavailable, mode}`: Auto needs `review.model`, Bypass needs `code.allowBypass` and a VM or container sandbox where the session's commands run (the environment's for a container environment, never on another machine: SSH, WSL, device). `worktree: true` creates `<repo>/.nova/worktrees/<8 hex>` on `nova/<slug>` with Git hooks off and leases it to the session (FR-073): `validation` outside Git or before the first commit, `conflict` `{reason: worktree_cap}` at 15 per repo. An unknown model is `validation` `{reason: unknown_model}`. Audited as `code.session.created`; `code.session.created`, `worktree.leased` M6 adds `{worktreeId?, budgets?: {timeSeconds?, tokens?, costUsd?}}`. `environmentId` is any saved environment of the account (`not_found` otherwise; `local` by default). A `container` session works on the Hub folder and runs its commands in the image; the environment's setup script runs once in the background (network off, at most 30 min; see `/extras`). In `ssh`, `wsl` and `device` environments `folder` is an absolute path on that machine, checked through its helper (protected folders `policy_denied` `{reason: protected_folder}`, `validation` `{reason: missing\|not_a_folder}`, `capability_missing` `{reason: no_ssh_transport\|no_device_provider\|device_offline\|not_windows}`); `worktree` or `worktreeId` there is `validation` `{reason: worktree_unavailable}`. M7: there the thread's `fs.read`, `fs.list`, `fs.write`, `fs.edit`, `fs.delete` and `exec.run`'s `cwd` act on the folder on that machine through its helper or device provider, with the Hub's path rules and no symbolic link followed (`path_denied`); the thread has no root on the Hub (tool scope, `/files/roots`, mentions, instruction files) and the gate's only root is that folder; `fs.search`, `document.read` and `document.create` are denied (so hidden); an unreachable machine fails file tools with `remote_unavailable` (`docs/10` §2). `worktreeId` binds an unleased registry worktree, leased to the session until it is archived (`validation` `{reason: worktree_repo}` outside its repository; `conflict` `{reason: removed\|missing\|leased}`). `budgets` bound the session's turns (time 60 s–7 days, tokens 1,000–10^9, cost 0.01–100,000 USD, `null` for none; omitted ones come from `code.budgets`), checked before every model step: a turn they stop ends with stop reason `budget`. A worker started with `task.spawn` is audited with actor `agent` |
| `GET/PATCH` | `/api/v1/code/sessions/:id` | One `CodeSessionView` (`repo` `{root, branch, head, dirty, defaultBranch}` when the folder is a Git repository; `defaultBranch` from origin's HEAD, else `init.defaultBranch`, else `main` or `master`) / change `{permissionMode?, title?, model?}`. A mode change is checked as on create, remembered for the folder (`code.folderModes`; Plan never is), audited as `code.mode.changed` and announced as `code.session.modeChanged`; every change emits `code.session.updated`. A session whose thread is archived or deleted is archived and releases its worktree (a clean one is removed) M6: `repo` is null for sessions in `ssh`, `wsl` and `device` environments; `pullRequestUrl` and `ciStatus` follow the session's pull request; archiving ends the leases the session held for its workers, and its dev servers stop at the next 5-minute sweep |
| `GET` | `/api/v1/code/sessions/:id/changes` | The session's uncommitted changes, refreshed first (FR-064): `{items: CodeChangeView[]}` `{id, sessionId, path, kind: add\|modify\|delete\|rename, oldPath, additions, deletions, callId, state: pending\|accepted\|rejected\|partial, hunks, binary, createdAt}`. Paths are relative to the session folder. Changes are also refreshed after each decision, at the end of every turn and after every tool call of the session's thread that may write files (that call's id is `callId`). M5 never detects renames: a rename is a delete and an add M6 sessions in `ssh`, `wsl` and `device` environments had no Hub-side change capture; since M7 sessions on another machine (SSH, WSL, device, cloud) capture changes through the environment's transport, with review, commits, branches and the read-only `git.*` tools, while `symbols`, `refs` and `push` stay `capability_missing` `{reason: remote_environment}` (`docs/10` §2) |
| `POST` | `/api/v1/code/sessions/:id/changes/:changeId/hunks` | Decide hunks `{decisions: [{hunkId, accept}]}` (1–1,000; a hunk id is `<oldStart>-<newStart>`). Accepting moves the hunk into the accepted baseline; rejecting reverts it in the work tree. Returns the `CodeChangeView`. A hunk that is no longer pending or no longer applies, or a file changed since it was shown, is `conflict` `{reason: stale_hunk}`; reload the changes. `code.change.applied` / `code.change.reverted`; a rejection is audited as `code.change.rejected` |
| `POST` | `/api/v1/code/sessions/:id/changes/{accept,reject}` | Accept or reject everything pending `{changeIds?}` (all pending changes when omitted; an unknown id is `not_found`): `{items: CodeChangeView[]}` |
| `GET/POST` | `/api/v1/code/sessions/:id/comments` | Diff comments, user comments and review findings (FR-065): `{items: DiffCommentView[]}` `{id, changeId, path, line, side: old\|new, body, resolved, author: user\|review, reviewId, submittedAt, createdAt}` / add a batch `{comments: [{changeId, line, side, body}] (1–200), submit?}` (201 `{items}`). `submit: true` sends every unsent user comment of the session to the agent as one turn, with the user's authority, and the agent revises the diff; `conflict` `{reason: turns_unavailable}` when no agent can take it. `code.diff.commented` per comment |
| `POST` | `/api/v1/code/sessions/:id/comments/:commentId/resolve` | Mark a comment resolved; returns it |
| `POST` | `/api/v1/code/sessions/:id/review` | Start a `/review` of all uncommitted session changes, accepted and pending (FR-069): 202 `CodeReviewView` `{id, sessionId, status: running, findings: [], createdAt}`. The session's model (else the default model) reviews the diff, at most 5 minutes; `validation` when there are no changes or no model. Findings are `{id, path, line, severity: info\|warn\|error, title, reasoning, fix}`; one on a changed file's line is also stored as a diff comment with `author: review`. M5 does not return the view's `model` and `error` yet. Audited as `code.review`; `code.review.completed` |
| `GET` | `/api/v1/code/sessions/:id/reviews/:reviewId` | One `CodeReviewView` (`status: running\|done\|failed`) |
| `POST` | `/api/v1/code/sessions/:id/commit` | Commit the accepted changes (`docs/10` §8) `{message (≤ 5,000), branch?, acceptPending?}`. `acceptPending` accepts what is still pending first. The accepted content is staged into the user's index without touching the work tree, so pending hunks stay out; `branch` creates a free `nova/<slug>` branch from it without a checkout. Commit hooks run in the sandbox (repo root writable, network off) when the repository has hooks and the sandbox has Git; otherwise the Hub commits with hooks off and says so. Nothing is ever pushed. Returns `CommitResult` `{sha, branch, files, hooksRan, hooksNote}`; audited as `code.commit`; `code.commit.created`, `code.session.updated`. Errors, after which the index and branch are put back: `validation` `{reason: nothing_accepted}`, `{reason: no_identity}` (Git has no author on the Hub) or a folder outside Git or a bad branch name; `policy_denied` `{reason: default_branch, branch}` (give `branch`) or `{reason: secrets_found, findings: [{path, line, rule, preview}]}` (previews masked); `conflict` `{reason: staged_changes}` (other changes are staged), `{reason: detached_head}`, `{reason: commit_failed, output}` or hooks that did not finish in time M6: the agent's `git.commit` tool commits only accepted changes (no `acceptPending`, no `branch`) and is audited as `code.commit` with actor `agent`. Commit hooks run in the Hub's sandbox, not a container environment's image; inside a command sandbox `.git` is read-only except for this commit (`docs/12` §7.2) |
| `GET` | `/api/v1/code/sessions/:id/symbols?q=&limit=` | Go to symbol (FR-074): `{items: CodeSymbolView[]}` `{name, kind, path, line, container}`, `limit` ≤ 200 (default 50). M5 indexes with a pattern-based extractor held in Hub memory (512 KiB per file, 20,000 files), not tree-sitter |
| `GET` | `/api/v1/code/sessions/:id/refs?name=&limit=` | Lines that name a symbol: `{items: [{path, line, text}]}`, `limit` ≤ 200 (default 100). Symbol and ref paths are relative to the repository root (the session folder outside Git) |
| `POST` | `/api/v1/code/sessions/:id/terminal` | Open a terminal in the session folder `{cols?, rows?}` (default 100 × 30): 201 `TerminalView` with the session's `threadId`; it streams on `/api/v1/terminals/:id/ws` and is listed by `GET /terminals`. 409 `sandbox_unavailable` without terminals. Terminals run on the Hub's disk, so a session on another machine (SSH, WSL, device, cloud) is `capability_missing` `{reason: remote_environment}` (M7) |
| `GET` | `/api/v1/code/sessions/:id/extras` | M6 facts the `CodeSessionView` does not carry: `{sessionId, environment: {id, kind, label}\|null, parentSessionId, role, setup: {status: running\|ok\|failed, detail}\|null, budget: CodeBudgetView, pullRequest: PullRequestView\|null, lastVerify: VerifyRunView\|null, devServers: DevServerView[]}`. `parentSessionId` and `role` are set for a `task.spawn` worker; `setup` is a container environment's setup script (the last 20 output lines, redacted) |
| `POST` | `/api/v1/code/sessions/:id/budget/extend` | Extend the session's bounds (`docs/09` §2) `{timeSeconds?, tokens?, costUsd?}` (at least one): each amount is added to its limit (a bound the session lacks becomes what it used plus the amount) and `reached` is cleared. Returns `CodeBudgetView` `{limits, used, reached: time\|tokens\|cost\|null}`. Audited as `code.budget.extended`; `code.session.updated` |
| `POST` | `/api/v1/code/sessions/:id/branch` | Create a free `nova/<slug>` branch at HEAD and switch the session to it without a checkout, so no hook runs (FR-211) `{name (1–200)}`: `{branch, from}`. `validation` outside Git; `conflict` when no free name is found. Audited as `code.branch.created`; `code.session.updated` |
| `POST` | `/api/v1/code/sessions/:id/push` | Push the session's branch (FR-070) `{remote? (default origin), confirmBranch?, force?, hostId?}` with hook-free Git, at most 5 min. Guards, in order: a connected host that matches the remote is asked for its default branch and the branch's protection first (a host error refuses the push); a protected or default branch is never force-pushed (`policy_denied` `{reason: force_protected, branch, protected, default}`) and needs `confirmBranch` equal to its exact name, typed by the user (`policy_denied` `{reason: confirmation_required, …}`; the agent can never confirm, FR-189); the commits the remote lacks (the newest 200) are scanned for secrets on the lines they add (`policy_denied` `{reason: secrets_found, findings}`, previews masked). The pre-push hook runs only in the session's sandbox (repository writable, network off, 5 min): a refusal is `conflict` `{reason: hook_failed, output?}`; without a sandbox with Git it does not run and `hooksNote` says so. A matched host's token goes only into that one Git call's environment as an authorization header, never into a config file or a remote URL, and never to an `http://` remote (`policy_denied` `{reason: insecure_remote}`, checked before anything is sent). `force: true` uses `--force-with-lease`. Returns `{sessionId, remote, branch, sha, hooksRan, hooksNote}`. Other errors: `capability_missing` `{reason: remote_environment}`; `validation` outside Git or `{reason: no_remote}`; `conflict` `{reason: detached_head\|push_failed}`; host errors `validation` `{reason: token_rejected\|token_missing}`, `server_error` `{reason: host_unreachable\|host_error}`. Audited as `code.push` (also when denied); `code.push.completed` |
| `GET/POST` | `/api/v1/code/sessions/:id/pr` | The session's newest pull request: `PullRequestView` `{id, sessionId, hostId, repo, number, url, title, state: open\|closed\|merged, headBranch, baseBranch, headSha, ci: {status: none\|queued\|running\|passed\|failed, checks: [{name, status, conclusion, url, summary}]}, polledAt, createdAt, updatedAt}` (`summary` is the host's text: untrusted, redacted); `not_found` without one / push and open one on the connected host `{title (1–256), body? (≤ 60,000), base? (default the host's default branch), draft?, remote?, repo?, hostId?, confirmBranch?}` (201). The push is the one above, never forced; a pull request already open for the branch is returned instead. `validation` `{reason: no_git_host\|repo_unknown\|same_branch}`; push and host errors as for `/push`. Audited as `code.pr.opened`; `code.pr.opened` (both only for a newly recorded pull request) |
| `POST` | `/api/v1/code/sessions/:id/pr/refresh` | Read the pull request and its CI (check runs and commit statuses) now; returns `PullRequestView`. Open pull requests are also polled every `code.ciPollSeconds` (default 60); there is no webhook. A CI status or state change emits `code.pr.ci.changed`. When CI fails on an open pull request's head and `code.ciFeedback` is on, the failed checks go to the session's agent once per head commit, as a turn without the user's authority |
| `GET/POST` | `/api/v1/code/sessions/:id/devservers` | Dev servers (FR-097): `{candidates: DevServerCandidateView[], items: DevServerView[]}`. Candidates are detected in the session folder: `.nova/launch.json` (`{configurations: [{name, command, cwd?, port?}]}`), package.json `dev`, `start`, `serve` or `preview` scripts, Django `manage.py`, Rails and Go; `{id, label, framework, command, cwd, port, source}`. `DevServerView` `{id, sessionId, candidateId, label, command, status: starting\|running\|stopped\|failed, url, port, execSessionId, exitCode, startedAt, stoppedAt}`; servers live in Hub memory / start `{candidateId?, port? (1,024–65,535)}` (201): an exec session in the session's sandbox with the folder writable, the network off and `PORT`, `HOST=127.0.0.1`, `BROWSER=none`; a running candidate is returned as it is. The port is published through the dev-server bridge: `url` is `http://127.0.0.1:<hostPort>/`, the bridge's port on the Hub (`port` stays the server's own). The session thread's agent browser gets the egress proxy's grant for that host and port (`browser.devserver.granted`, revoked when the server stops) and opens it once it answers HTTP (in the browser's action trace as tool `devserver.open`). Errors: `capability_missing` `{reason: remote_environment}`; `validation` or `not_found` `{reason: no_dev_server}`; `conflict` `{reason: too_many_dev_servers}` (4 running per session); 409 `sandbox_unavailable`; `conflict` `{reason: dev_server_exited, output, server}` when it exits within 3 s. Audited as `code.devserver.start`; `code.devserver.started` |
| `POST` | `/api/v1/code/sessions/:id/devservers/stop-all` | Stop every running server: `{items: DevServerView[]}`. Audited as `code.devserver.stop` per server; `code.devserver.stopped` |
| `POST` | `/api/v1/code/sessions/:id/devservers/:serverId/stop` | Stop one server; returns `DevServerView`. Audited as `code.devserver.stop`; `code.devserver.stopped`. Servers of archived sessions stop at the 5-minute sweep |
| `GET/POST` | `/api/v1/code/sessions/:id/verify` | Auto-verify runs (FR-068), newest first, at most 20: `{items: VerifyRunView[]}` `{id, sessionId, trigger: auto\|manual, status: running\|passed\|failed\|error\|skipped, checks: [{name, command, status, exitCode, log, durationMs}], createdAt, completedAt}` / run now (202 `VerifyRunView`); `conflict` `{reason: verify_running}`. The checks are `code.autoVerify.commands`, else (sessions on the Hub) the detected typecheck or build script and the test command; each runs in the session's sandbox with network off up to `code.autoVerify.timeoutSeconds`; logs are redacted and capped at 8,000 characters. After a turn that edited files a run starts by itself when `code.autoVerify.enabled` (sessions on the Hub only); a failure goes to the agent as a turn without the user's authority, at most `feedbackTurns` in a row. Not audited; `code.verify.started`, `code.verify.completed` |
| `GET` | `/api/v1/code/sessions/:id/verify/:verifyId` | One `VerifyRunView` |
| `POST` | `/api/v1/code/sessions/:id/ask` | A side question (FR-072) `{question (1–4,000)}`: one model call without tools over the session's facts and newest transcript (60 messages, ≤ 24,000 characters, as data); nothing is added to the thread. `{sessionId, answer, model}`. No model is `validation`. Not audited |
| `POST` | `/api/v1/code/sessions/:id/handoff` | Move a session with its Git state (FR-213, M7, `docs/10` §15) `{to: {environmentId?, folder?, worktree?: new\|main\|<worktreeId>}, source?: keep\|clean (default `code.handoffSource`), interrupt?}`: another saved environment and the repository folder there, or on the same machine a new worktree (`nova/<slug>`), an unleased registry worktree or the main checkout. 202 `SessionHandoffView` `{id, threadId, sessionId, from, to, fromLabel, toLabel, status: pending\|running\|completed\|refused\|failed, reason, detail, source, git: {branch, head, tree, patchSha256, patchBytes, files, bundleSha256, bundleCommits, worktreeId, stateHash}, folder, createdAt, completedAt}`; it continues in the background. The branch, HEAD, local commits (a Git bundle through the Hub) and every uncommitted change (one binary-safe patch) travel; the target must be clean and confirm the same state hash before the session moves; a running turn is waited for (or interrupted) and the next is held. `reason` (also `details.reason` of a refusal): `turn_running`, `same_location`, `not_a_repository`, `no_commits`, `detached_head`, `target_dirty`, `target_missing`, `target_unreachable`, `protected_folder` (the target folder leaves the repository or fails the folder checks of a new session), `other_repository`, `missing_commits`, `branch_diverged`, `branch_in_use`, `conflicts`, `verify_failed`, `too_large`, `remote_state_unavailable`, `environment_unavailable`, `failed` (`same_location` is answered as a request error and never recorded; `detached_head`: the session is not on a branch; `other_repository`: the target repository has commits but none of the session HEAD's root commits, and an empty repository or a shallow clone is not judged by this check). A target that cannot offer the session's mode changes it (`code.mode.changed`, actor system). A bundle is deleted when its handoff completes; patches, and the bundles of refused or failed handoffs, expire after 7 days (the 5-minute sweep). `session.handedOff` at pending, running and the end; audited as `code.handoff.requested\|completed\|refused\|failed` |
| `GET` | `/api/v1/code/sessions/:id/handoffs` | The session's handoffs, newest first: `{items: SessionHandoffView[]}` |
| `GET` | `/api/v1/handoffs/:id` | One `SessionHandoffView` (a session's or a chat's) |
| `POST` | `/api/v1/code/sessions/:id/merge` | Three-way merge onto the session's folder (FR-073, M7, `docs/10` §14) `{from: {sessionId} \| {patch (a `git diff --binary --full-index` patch, ≤ 16 MiB), base? (the commit it was made against; default HEAD)}, onConflict?: refuse\|markers}` → 201 `CodeMergeView` `{id, sessionId, source: {kind: session\|attempt\|patch, ref}, status: applied\|conflicted\|resolved\|refused\|aborted, baseSha, files: [{path, result: applied\|merged\|conflict\|added\|deleted\|unchanged\|binary_conflict, conflicts}], conflicts: [{path, binary, base, ours, theirs, merged, truncated}], createdAt, resolvedAt}` (the three sides are bounded, redacted text). Runs on the Hub with `git merge-file` (diff3 markers); binary files and symlinks always conflict. With `refuse` (default) a conflict writes nothing and answers 409 `conflict` `{reason: merge_conflict, mergeId, paths}` (the merge is kept as `refused`; `GET …/merges/:mergeId` shows its three sides); with `markers` the markers are written and the session's commits answer 409 `{reason: merge_conflicts, mergeId, paths}` while markers remain (a commit after they are gone marks the merge resolved). Merging a session needs both folders on the Hub (`capability_missing` `{reason: remote_environment}`) in the same repository and the same folder of it (`validation` `{reason: same_session\|other_repository\|other_folder}`); a patch whose base the repository lacks, or that does not apply to it, is `validation` `{reason: missing_base\|patch_mismatch}`. `code.merge.completed`; audited as `code.merge` |
| `GET` | `/api/v1/code/sessions/:id/merges` | `{items: CodeMergeView[]}`, newest first |
| `GET` | `/api/v1/code/sessions/:id/merges/:mergeId` | One `CodeMergeView` |
| `POST` | `/api/v1/code/sessions/:id/merges/:mergeId/resolve` | Mark a conflicted merge resolved once no markers remain; 409 `conflict` `{reason: merge_conflicts}` while any do. Audited as `code.merge.resolved` |
| `POST` | `/api/v1/code/sessions/:id/merges/:mergeId/abort` | Put the files back as they were before the merge. Audited as `code.merge.aborted` |
| `POST` | `/api/v1/code/sessions/:id/attempts` | Best-of-N (FR-212, M7, `docs/10` §9) `{objective (≤ 20,000), count? (2–4; default `code.attempts.count`), budgets? {timeSeconds?, tokens?, costUsd?} (default `code.attempts.budgets`; never more than the parent session has left), models? (one per attempt)}` → 201 `CodeAttemptSetView` `{id, sessionId, objective, baseSha, status: running\|ready\|applied\|discarded, attempts: [{id, index, sessionId, threadId, worktreeId, branch, model, status: running\|done\|failed\|applied\|discarded, files, additions, deletions, patch (redacted, ≤ 256 KiB), patchTruncated, tests: VerifyRunView\|null, budget, reply}], appliedAttemptId, mergeId, createdAt, updatedAt}`. Each attempt is its own session in its own worktree, started from the session's last commit; with auto-verify off it runs no checks. `code.attempts.updated`; audited as `code.attempts.started` |
| `GET` | `/api/v1/code/sessions/:id/attempts` | `{items: CodeAttemptSetView[]}` |
| `GET` | `/api/v1/code/attempts/:setId` | One `CodeAttemptSetView` |
| `POST` | `/api/v1/code/attempts/:setId/apply` | Merge one attempt into the session `{attemptId, onConflict?: refuse\|markers}` (as `/merge`); then every attempt worktree is removed and attempt branches with no commits are deleted. Audited as `code.attempt.applied` |
| `POST` | `/api/v1/code/attempts/:setId/discard` | Discard every attempt (worktrees removed). Audited as `code.attempts.discarded` |
| `GET/POST` | `/api/v1/code/worktrees?repo=&status=&deviceId=` | The worktree registry (FR-073): `{items: WorktreeView[]}` `{id, name, repoPath, path, branch, sourceBranch, leasedBy, leaseExpiresAt, status: active\|released\|removed, dirty, included, createdAt, updatedAt}`, at most 500; `status` defaults to `active` (`all` lists every one); `deviceId` lists nothing in M6 (the Hub's worktrees only) / create `{repo, sessionId?, branch?, ttlMinutes? (5–10,080), removeOldest?}` (201): `<repo>/.nova/worktrees/<8 hex>` on a free `nova/<slug>` branch from HEAD with Git hooks off (FR-211); then `.worktreeinclude` files are copied in (`included`: only files both ignored and matched, never protected or credential locations or links; ≤ 2,000 files, 200 MiB). With `sessionId` it is leased to that session for `ttlMinutes`, else until released or the session is archived; without it, it waits for a session to bind it (`worktreeId` on `POST /code/sessions`). At 15 per repository: `conflict` `{reason: worktree_cap, unleased, removable}`; `removeOldest: true` first removes the oldest unleased clean one. Audited as `code.worktree.created`; `worktree.leased` when leased |
| `POST` | `/api/v1/code/worktrees/:id/renew` | Extend the lease `{ttlMinutes? (default 60)}` from now; `conflict` `{reason: not_leased}` without a current lease. `worktree.leased`; not audited |
| `POST` | `/api/v1/code/worktrees/:id/release` | End the lease; the worktree stays (`status: released`). `conflict` `{reason: in_use}` while a session works in it. Audited as `code.worktree.released`; `worktree.released` `{reason: done}`. Leases also end when their session is archived (the session's own worktree is removed when clean unless `code.worktreeCleanup` is `keep`) and when they expire (`{reason: expired}`, the 5-minute sweep) |
| `DELETE` | `/api/v1/code/worktrees/:id?force=` | Remove the worktree with Git hooks off; its branch stays. 200 `WorktreeView` (`status: removed`). `conflict` `{reason: in_use\|leased\|dirty\|remove_failed}`; a dirty one needs `force=true`. Audited as `code.worktree.removed`; no event |
| `GET/POST` | `/api/v1/mcp/servers` | MCP servers ([`mcp-config.json`](schemas/mcp-config.json)); env values go to the vault and only their names come back; for `sse`/`http` servers each env entry is sent as a header with `_` turned into `-`; names are unique per account (FR-042). `McpServerView` also carries `auth` (FR-047), `bundle` `{name, version, signature}` (FR-199), `connectedAt` and `restarts` (automatic restarts in the last 10 minutes, FR-043); a server that refuses an unauthenticated connection shows "needs authorization". M4 ships the request without the `oauth` and `auth` fields of `mcp-config.json` (OAuth is started per server below and asks for the scopes the resource advertises); the full shape is a follow-up. M7 (FR-042, FR-047): a stdio server may take `deviceId` (it runs on that device through `novad`; `command` is the server's name as the device lists it; the Hub never sends a command line, and a device still pending approval is refused); an `sse`/`http` server may take `auth` (an API key or bearer token stored in the vault and sent as `Authorization`; `''` keeps it) or `oauth` `{clientMetadataUrl? (https), dynamicRegistration?, scopes?}`, not both. The view adds `deviceId`, `hasAuth` and `oauthSettings`; audited `mcp.server.add` records them. A member may add only remote servers (§1) |
| `GET/PATCH/DELETE` | `/api/v1/mcp/servers/:id` | One server / change it (a sent `env` is the complete set: an empty value keeps the saved secret, a value replaces it, an omitted name is deleted; `secret://` values are refused) / remove it with its secrets and working directory. A plugin's server (`McpServerView.pluginId`) changes only through its plugin: PATCH and DELETE answer `conflict` `{reason: plugin_owned, pluginId}`. `readOnlyTools` (at most 500 names of 1-200 characters, matched like `enabledTools`) is the owner's declaration that those tools only read (FR-082): their descriptors carry `userReadOnly`, and a change is audited with the names added and removed; a plugin's server has none |
| `POST` | `/api/v1/mcp/servers/:id/restart` | Reconnect now and reset the restart backoff (`conflict` while disabled) (FR-043) |
| `GET` | `/api/v1/mcp/servers/:id/logs` | Last 500 redacted log lines (stderr, protocol, status) |
| `GET` | `/api/v1/mcp/servers/:id/tools` | Every tool the server offers, including disabled ones |
| `POST` | `/api/v1/mcp/bundles/preview` | Upload a bundle; returns manifest, signature state and proposed permissions (FR-199). Body `{name, data}`: the archive as base64, at most 50 MB decoded. It is read with path-traversal checks and caps of 10,000 entries, 500 MB unpacked and 200 MB per file (the manifest ≤ 1 MB); a bad manifest is `validation` naming the field. Returns `BundlePreview` (manifest fields, `signature`, proposed `permissions {network[], fs}`, typed `userConfig` fields, tools, warnings). Previews expire after 30 min. No publisher is trusted yet, so every bundle is `unverified` |
| `POST` | `/api/v1/mcp/bundles/install` | Install `{previewId, permissions, userConfig, confirmSideload?}`; unsigned without `confirmSideload: true` is refused (`validation` `{field: confirmSideload, reason: sideload_confirmation_required}`). Returns 201 `McpServerView`; an expired preview is `not_found`. Files go to `<dataDir>/mcp/bundles/<name>/<version>`; sensitive settings, and env values and arguments that use one, go to the vault (`secret://mcp/<id>/…`, resolved at launch); the tools default to `ask`. A newer version updates the server in place and keeps the previous version's folder; a name taken by a server that is not this bundle is `conflict`. Audited as `bundle.install` / `bundle.update`; `mcp.bundle.installed`. M4 ships `permissions.fs` as one choice `none\|read\|project`, applied as `read` or `write` to each folder or file entered in `userConfig` (the install record keeps the per-path list); the per-path request shape is a follow-up. Bundle servers still run outside the sandbox, as in M3 |
| `POST` | `/api/v1/mcp/servers/:id/oauth/start` | Begin OAuth 2.1 with PKCE (S256) for an `sse`/`http` server (FR-047); returns `{authorizeUrl}` for the user to open (`validation` for stdio). Nova registers with its client metadata document when the authorization server accepts one and the Hub URL is HTTPS, else by dynamic registration. The state is random, single-use, expires after 10 min and remembers the account. Audited as `oauth.start` |
| `GET` | `/api/v1/mcp/oauth/callback?state=&code=&error=&iss=` | **OAuth redirect target.** No session (a cross-site redirect carries none): the single-use state ties it to the account. A malformed query is `validation`; otherwise it always answers 302 to `/settings/tools?oauth=ok` or `/settings/tools?oauth=error`. Tokens live only in the vault and refresh within 60 s of expiry or after a 401. Audited as `oauth.connect` or `oauth.failed` |
| `DELETE` | `/api/v1/mcp/servers/:id/oauth` | Sign out: revoke the tokens at the server's revocation endpoint and forget them; returns the server (`auth.status: needs_auth`); audited as `oauth.revoke`. M4 ships `McpAuthView` `{kind, status, expiresAt, scopes}` without `lastError`; the full shape is a follow-up |
| `GET` | `/.well-known/nova-client.json` | Nova's OAuth client metadata document: `client_id` is this URL, `redirect_uris` the callback above, `grant_types` `authorization_code` and `refresh_token`, `token_endpoint_auth_method: none`. Public: it holds no account data |
| `GET/POST` | `/api/v1/mcp/subscriptions` | MCP event subscriptions (FR-201), each bound to an `mcp_event` trigger: `{items: McpSubscriptionView[]}` (removed ones included) `{id, triggerId, serverId, event, status: pending\|active\|refreshing\|lapsed\|failed\|removed, filter, expiresAt, refreshBefore, lastDeliveryAt, lastError, webhookPath, createdAt, updatedAt}` / create a trigger and its subscription in one call `{serverId, event (≤ 200), filter?, instructions (1–8,000), title?, action?: run\|wake, agentId?, projectId?, autonomy?: ask_first\|standard, enabled?}` (201; the errors of `POST /triggers`). The Hub makes a random 32-byte signing secret (`secret://mcp/<serverId>/events/<id>`, never returned) and calls `nova/events/subscribe` with the webhook URL `<channels.publicUrl, else the Hub address>/api/v1/mcp/events/<id>`, the secret, the filter and a 24 h lifetime (15 s per call). A server that is not connected or fails leaves it `pending` with `lastError`, retried every 60 s; one that does not offer the event makes it `failed`. An active subscription is refreshed (`nova/events/refresh`) from three quarters of its lifetime and at least 5 minutes before expiry; one that expires unrefreshed is `lapsed` and subscribed again. Audited as `mcp.subscription.create` and `trigger.create`; `trigger.changed`, `mcp.subscription.changed` |
| `GET/DELETE` | `/api/v1/mcp/subscriptions/:id` | One `McpSubscriptionView` / unsubscribe (`nova/events/unsubscribe`, best effort): the row stays as `removed`, its trigger is turned off and its secret deleted; the webhook then answers 410. Returns the view. Audited as `mcp.subscription.remove`; `mcp.subscription.changed` `{status: removed}`. Deleting an MCP server unsubscribes its subscriptions first, while it is still connected |
| `GET` | `/api/v1/mcp/event-sources` | Connected servers that advertise events (experimental capability `nova/events` `{events: [{name, description?}]}`): `{items: [{serverId, name, events}]}` |
| `POST` | `/api/v1/mcp/events/:subscriptionId` | **Public: webhook receiver** for MCP events. No session: `x-nova-event-id` (≤ 200), `x-nova-event-timestamp` (Unix seconds or ISO-8601, within 5 minutes) and `x-nova-event-signature: sha256=<hex>`, HMAC-SHA256 with the subscription's secret over `<id>.<timestamp>.<raw body>`, constant-time. An unknown or removed subscription is 410; a body over 256 KiB is 413; a missing header, a stale timestamp or a wrong signature is 401 `token_required`; a body that is not JSON is 400 `validation`. Each refusal is audited as `mcp.event.rejected` and noted in the subscription's `lastError`; nothing is stored. A delivery id seen before (kept 7 days) is 200 `{ok: true, duplicate: true}` and starts nothing. Otherwise 200 `{ok: true, duplicate: false, outcome: started\|duplicate\|skipped\|failed, runId}`: the trigger fires with the payload as untrusted data. Error bodies here are `{error: {code, message, retryable: false}}` without `requestId`. `mcp.event.received` (also for a repeat, with `duplicate: true`) |
| `GET/POST` | `/api/v1/plugins` | Installed plugins as `PluginView` (status `ok\|needs_trust\|disabled\|error`, verified, confirmed permissions, component counts) (FR-045) / install `{previewId, confirmSideload, enable?, trustHooks?: [{id, contentHash}]}` (201). No plugin is verified until signing lands (FR-049), so `confirmSideload: true` is required (`validation` `{field: confirmSideload, reason: sideload_confirmation_required}`). An expired preview is 410 `request_expired`; a folder that changed or went away after the preview is `conflict`. Installs run one at a time; an update swaps the version folder atomically and rolls back on failure. The plugin's MCP servers become servers with source `plugin`, named by manifest key (`-2`, `-3` on a clash); literal env and header values go to the vault, references must be `secret://plugin/<pluginId>/…`, `deviceId` is refused and `auth` is ignored with a warning. Node servers get `NODE_PATH` set to Nova's own `node_modules`. `plugin.installed` / `plugin.updated` |
| `POST` | `/api/v1/plugins/preview` | What installing would do `{source}`: `{kind: path, path}` (a folder on the Hub), `{kind: catalog, catalogId, pluginId, version?}` or `{kind: git, url, ref?}`. Returns `PluginPreview` (manifest, permissions, hooks with their hashes, MCP servers, skills, warnings, `replaces` on update); held in memory for 30 min with a digest of the whole folder. Nothing is installed |
| `PATCH/DELETE` | `/api/v1/plugins/:id` | Enable or disable `{enabled}` (its servers, skills and hooks follow; `plugin.updated`) / uninstall: its servers and their secrets, roles, skill state and files go (`plugin.removed`) |
| `GET` | `/api/v1/plugins/catalogs` | Catalog sources as `CatalogView` (`local\|url\|git`): the built-in sample catalog `nova-sample` plus the `plugins.catalogs` setting |
| `GET` | `/api/v1/plugins/catalog?q=` | Search every catalog: `CatalogEntryView` with the installed version. Folder catalogs read `catalog.json` or `nova-catalog.json`; URL catalogs need https, an index ≤ 1 MB and same-host zip archives ≤ 50 MB (optional SHA-256 check); Git catalogs take https, ssh or git URLs, cloned shallow with Git hooks off, and answer `capability_missing` when Git is not installed |
| `GET/POST` | `/api/v1/skills?projectId=` | Skills from every source as `SkillView` with `shadowedBy` (managed > project > user > plugin > built-in; a disabled skill drops out) (FR-046) / create `{name, description, whenToUse?, allowedTools?, body, projectId?}` (201): a user skill, or a project skill with `projectId`; a name in use is `conflict`. Skills are `SKILL.md` folders on disk; ids are `skill:<source or pluginId>:<name>` (`skill:project:<projectId>:<name>`) |
| `GET/PATCH/DELETE` | `/api/v1/skills/:id` | `SkillDetail` with body and files / `{enabled}` (a managed skill is `policy_denied`) / delete a user, imported or project skill (others are `conflict`: disable them instead); `skill.changed` |
| `GET` | `/api/v1/slash-commands?projectId=` | `/name` completions as `SlashCommandView`: enabled skills and plugin commands (FR-046) |
| `POST` | `/api/v1/tools/:name/invoke` | Invoke a tool from the UI `{args, threadId?, initiator?}`; it passes the policy gate like a model call (origin `ui`). `initiator: "user"` is only for a click the user made in a Nova client: it counts as the user's own instruction, so a direct action is allowed without a card unless a confirm-every-time step, a handoff, a rule, a deny or the network allowlist applies (policy changes and secret reads always keep their card). The default `"app"` (an MCP App's call) carries no user authority. Returns `{ok, text, error?}`; if it must wait for an approval for more than 60 s the answer is 202 `{approvalId, callId}`. M7: the answer is `{ok, text, meta, error?}`: `meta` is the tool result's metadata (an artifact the tool made, e.g. `meta.artifact.id` of a generated image), redacted like the stored result, `{truncated: true}` above 20,000 characters, null on failure |
| `GET` | `/api/v1/artifacts?threadId=` | A thread's artifacts (FR-038) |
| `GET` | `/api/v1/artifacts/:id` | One artifact's metadata |
| `GET` | `/api/v1/artifacts/:id/content` | Its bytes under a restrictive CSP: HTML only with `sandbox allow-scripts` (never same-origin), PDFs without a sandbox directive so the browser viewer works; `?version=N` serves an earlier version; `?v=` (a client cache-buster) is ignored. Since M6 every artifact CSP ends `frame-ancestors 'self'` and the route sends `X-Frame-Options: SAMEORIGIN`, so the Inspector can frame it; every other response keeps the Hub's `X-Frame-Options: DENY` |
| `GET` | `/api/v1/artifacts/:id/preview?version=` | A document artifact's text, extracted on the Hub (FR-219): `{format: docx\|pptx\|xlsx\|pdf, title, blocks?, slides?, sheets?, pages?, readable, note, truncated}`, cut to 500 rows × 50 columns per sheet and 200,000 characters. Blocks are headings, paragraphs, lists and tables; slides carry their notes; `readable: false` with a `note` when the text cannot be read (a scan, unmapped fonts, encryption). An artifact that is not a document is `validation`; another account's is `not_found`. M5 has no shared type for it yet |
| `GET` | `/api/v1/mentions?q=&threadId=` | `@`-mention candidates: files and folders under the thread's roots, MCP servers and tools (FR-022) |
| `GET` | `/api/v1/ui/entry-points?kind=global\|thread\|file` | MCP Apps entry points as `UiEntryPointView` (FR-198): enabled plugins' `ui.entryPoints`, served by one of the plugin's own servers, and `ui://` resources that other servers' tools (`_meta.ui.resourceUri`) or resource lists declare (these open in a thread). Ids are stable 22-character hashes of owner, kind and resource. M4 does not fill `domains` yet |
| `GET` | `/api/v1/ui/resource?entry=` | The entry's `ui://` resource, read through the MCP manager and served as `text/html` (≤ 5 MB) with `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:` plus the allowed domains and `frame-ancestors 'self'; base-uri 'none'; form-action 'none'`, `X-Frame-Options: SAMEORIGIN`, `Cross-Origin-Resource-Policy: same-origin` and an ETag (304 on `If-None-Match`). Allowed domains are the resource's `_meta.ui.csp` and the plugin's `permissions.ui`, intersected with its network permissions (a plugin's `permissions.network`, a bundle's install record or the server's `policy.network`; none otherwise): plain hosts only, `*.x` covers subdomains but not the apex, https by default. Resource domains extend script, style, img, font and media; frame domains `frame-src`; connect domains `connect-src`. A missing, failing or non-HTML resource is 404: a small HTML page when the request accepts `text/html`, else `not_found` |
| `PUT` | `/api/v1/ui/context` | An open app's model-visible context `{threadId, entryId, instanceId, text}` (`text` ≤ 16,000 characters; `null` clears it); returns `{ok: true}`. Kept in Hub memory only (8 apps per thread, 500 threads) and added to the thread's next turn as untrusted content; parts an app marks private (`_meta["nova/private"]`) never leave the browser |
| `GET/POST` | `/api/v1/app-authorizations` | Per-client tokens: MCP clients of Nova's MCP server (FR-192) and third-party apps (FR-222). Create returns the token once. List: `AppAuthorizationView` (revoked ones stay in the database for the audit trail and are not listed). Create `{kind: mcp_client, clientName, scopes: {tools: [..]\|"*", projects: [..]\|"*", threads: none\|read\|read_write, mode: read_only\|run_allowed}, expiresInDays?}` (1–365, default 90; `null` never expires) returns 201 `{authorization, token, endpoint}`: the token starts `nvm_` and is stored only as its SHA-256 hash. An unknown project is `validation` `{field: scopes.projects}`. The first client turns `mcpServer.enabled` on. Audited as `app_authorization.create`; `app.authorization.changed`. M4 ships `kind: mcp_client` only and `AppAuthorizationView` without `status`; the full shape is a follow-up |
| `DELETE` | `/api/v1/app-authorizations/:id` | Revoke; open sessions close at once (calls in progress are cancelled but still answered); audited as `app_authorization.revoke` |
| `POST` | `/api/v1/app-authorizations/requests` | A third-party app requests scopes; returns a user code and verification URL (FR-222). Not in M4 |
| `POST` | `/api/v1/app-authorizations/requests/:id/{approve,deny}` | The user decides in a Nova client. Not in M4 |
| `POST` | `/api/v1/app-authorizations/token` | The app exchanges an approved request for its token. Not in M4 |
| `POST/GET/DELETE` | `/mcp` | **Nova's MCP server** for external MCP clients (streamable HTTP: `POST` carries JSON-RPC messages, `GET` opens the server stream, `DELETE` ends the session). Off until the user adds a client; `Authorization: Bearer` with that client's token from `/api/v1/app-authorizations`, which scopes its tools, projects, thread scope, read-only or run-allowed, and expiry. Missing, wrong, expired or revoked token → 401 `token_required`; non-allowlisted `Origin`/`Host` → 403 `origin_rejected`. Every call is audited with the client id and passes the policy engine; the `nova mcp stdio` launcher proxies to this endpoint with a token from an environment variable or file (FR-044, FR-192, ADR-075, `docs/08` §2.2). M4: while `mcpServer.enabled` is off every method answers 404 `not_found`, and turning it off closes open sessions; a 401 carries `WWW-Authenticate: Bearer realm="nova"`. Tools offered: `projects.list` (when the client has projects), `threads.list` and `threads.read` (when `threads` is not `none`; temporary chats never, and a client limited to some projects sees only their chats), plus the Hub tools its `tools` scope allows, with invalid name characters replaced (`mcp:x.y` → `mcp_x.y`). `read_only` clients get only tools whose action is a read; `tool.search` is never offered; `threads: read_write` grants read only. Calls pass the gate with origin `mcp_client`, never as the user's instruction (FR-189), and are audited as `client.call`. Resources, prompts and the `nova mcp stdio` launcher are not in M4. M7 (FR-044): it also answers `resources/list`, `resources/templates/list` and `resources/read` (chat transcripts in the client's thread scope and read-only files of its account's projects, opened with `O_NOFOLLOW`) and `prompts/list` and `prompts/get` (active skills, only for a client whose tools include `skill.load`); list calls pass the gate as `threads.list`, `projects.list` and `skills.list`, and anything out of scope or denied reads as missing; every read is audited as `client.call`. `script.run` is never served. The stdio launcher is `packages/mcp/src/launcher-main.ts` (`mcp stdio`, token from `NOVA_MCP_TOKEN` or a file) |

### Agents (M6)

Always-on agents (`docs/09` §8). Every route needs a session; none is public. Another account's
agent is `not_found`. Bodies are checked by their schema (`validation` with `details.issues`);
agent bodies may be up to 4 MiB (avatar).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/agents` | `{items: AgentView[]}`, oldest first / create `{name (1–100), instructions? (≤ 16,000), avatar?: {mime: image/png\|image/jpeg\|image/webp, data}, responsibilities? (≤ 20 {title (1–200), instructions? (≤ 4,000)}), autonomy?: ask_first\|standard\|autonomous, budgets?: {timeSeconds? (60 s–7 days), tokens? (1,000–100M), costUsd? (≤ 100,000, or null)}, proactive?, memoryEnabled?, model? (≤ 300)}` (201 `AgentView`) (FR-079). Defaults come from `agents.autonomy`, `agents.defaultBudgets` and `agents.proactive.enabledByDefault`; memory is on. Budgets apply per turn chain (a turn plus its hook continuations); `costUsd: null` means the provider spend cap. The agent gets a main `agent` thread (kept out of chat memory) and, best effort, its own computer (`computerId`, FR-080). `avatar` is handled as on `/account`; a bad image is `validation` `{field: avatar, reason}`. An autonomous agent without `review.model` is `validation` `{field: autonomy, reason: review_model_required}` (FR-085). Audited as `agent.create`; `agent.created` |
| `GET/PATCH/DELETE` | `/api/v1/agents/:id` | One `AgentView` `{id, name, hasAvatar, instructions, status: active\|paused\|stopped, pauseReason: user\|safety\|null, statusDetail, autonomy, model, computerId, primaryThreadId, proactive: {enabled, lastRunAt}, memoryEnabled, budgets, usage (lifetime), goalId, responsibilities, derived: StatusView, openSuggestions, lastActiveAt, createdAt, updatedAt}`; `derived` is the most urgent status of its threads, and `blocked` while it is paused for safety or its goal is blocked or out of budget (FR-215) / change `{name?, instructions?, avatar? (null removes), autonomy?, budgets?, proactive?, memoryEnabled?, model? (null clears)}` (an empty body is `validation`): `autonomous` needs `review.model` as on create; a rename renames the main thread; `memoryEnabled: false` deletes the notes the agent wrote and its conversation memory (`agent.memory.purged`, audited as `agent.memory.purge`). Audited as `agent.update`; `agent.updated` `{changed}` / delete, irreversible (FR-090): the body must be `{confirm: true}`, else `validation` `{field: confirm, reason: confirmation_required}` whose message is the notice the client shows. Its turns stop and its live background runs are cancelled; the channels area removes its bindings and the computers area its computer with its browser session, screen records and desktop; if that fails the answer is `server_error` (retryable) and the agent stays. Then its schedules and wakes, goal, notes, rules, suggestions, conversation memory and threads go; threads of runs it delegated stay as Work history. `{ok: true}`; audited as `agent.delete`; `agent.deleted` |
| `GET` | `/api/v1/agents/:id/avatar` | The avatar image (`Content-Security-Policy: default-src 'none'; sandbox`), or `not_found` |
| `POST` | `/api/v1/agents/:id/{pause,resume,stop}` | No body; each returns the `AgentView` (FR-090). `pause` (reason `user`) stops its turns, pauses its live background runs and disables its enabled schedules and wakes, remembering them. `resume` takes a paused or stopped agent (`conflict` when active): what the pause disabled comes back (a one-shot wake whose time passed fires a minute later), those runs resume and an active goal continues. `stop` cancels its current turns and background runs (partial results stay); the agent is `stopped` until its next turn or a resume, and meanwhile neither research nor goal continuations start. Typing in a paused agent's thread resumes it; an agent paused for safety refuses every turn until the user resumes it. Audited as `agent.pause` / `agent.resume` / `agent.stop`; `agent.status.changed`, `agent.paused` / `agent.resumed` |
| `POST` | `/api/v1/agents/:id/research` | Proactive research now (FR-082), no body: 202 `{started, reason}`; `started: false` while the agent is paused or research is running. It ignores the `proactive` switch, the interval and quiet hours. The turn runs in the agent's research thread with the `read-only` profile, only the reading agent tools and a deny for every action that is not read-only (MCP tools the owner declared read-only count, `docs/08` §1); an approval it asks for stops it. A reply other than "Nothing new" becomes an observation note (when memory is on), an open suggestion and an `attention` notification. `capability_missing` when agent turns are unavailable. Audited as `agent.proactive.start`; `agent.research.finding`, `agent.suggestion.created` |
| `GET` | `/api/v1/agents/:id/activity` | The agent's trace, oldest first: the latest 2,000 events correlated with the agent or one of its threads (main, research, channel bindings, delegated runs) as `{items: ActivityItemView[]}` |
| `GET` | `/api/v1/agents/:id/threads` | `{items: AgentThreadView[]}` `{threadId, agentId, kind: main\|proactive\|binding\|background, bindingRef, audience: private\|shared, runId, title, createdAt}`, oldest first |
| `GET` | `/api/v1/agents/:id/background` | The Work runs it delegated (FR-083), newest first, at most 200: `{items: AgentBackgroundView[]}` `{runId, threadId, title, status, createdAt, endedAt}` |
| `GET/POST` | `/api/v1/agents/:id/responsibilities` | `{items: AgentResponsibilityView[]}` by position `{id, agentId, title, instructions, status: active\|paused\|done, goalId, progressNote, position, createdAt, updatedAt}` (`progressNote` is the agent's, untrusted) / add `{title (1–200), instructions? (≤ 4,000)}` (201). Audited as `agent.responsibility.create`; `agent.responsibility.changed` |
| `PATCH/DELETE` | `/api/v1/agents/:id/responsibilities/:responsibilityId` | Edit `{title?, instructions? (null clears), status?, position? (0–1,000)}` / remove (`{ok: true}`). Audited as `agent.responsibility.update` / `.delete`; `agent.responsibility.changed` |
| `GET/POST` | `/api/v1/agents/:id/rules` | The agent's rules ([`agent-rule.json`](schemas/agent-rule.json), FR-084, `docs/12` §3), by priority: `{items: AgentRuleView[]}` `{id, agentId, description, effect, match, command, priority, enabled, createdAt, updatedAt}` / create `{description (1–300), effect: act\|act_on_request\|ask\|handoff, match?: {tools? (≤ 20 names or globs), hosts? (≤ 20), actions? (read\|write\|send\|delete\|execute), effects?, channels? (≤ 20 {kind, conversation?})}, command?: {pattern, matchExamples (1–20), notMatchExamples (1–20), justification?, tools? (exec.run\|exec.write)}, priority? (0–1,000, default 100), enabled?}` (201). `validation` `{field: match, reason: hosts_and_channels}` (hosts or channels, not both), `{field: effect, reason: command_effect}` (a command prefix rule only acts or asks), `{field: command, reason: pattern\|example}` (FR-191). The rules join the user rules of every thread of the agent: `act` allows, `act_on_request` allows only for the user's own untainted instruction and otherwise asks, `ask` asks, `handoff` hands off; built-in safety and the confirmation tiers still apply. Audited as `agent.rule.create`; `agent.rule.changed` |
| `PATCH/DELETE` | `/api/v1/agents/:id/rules/:ruleId` | Edit (checked again as a whole) / delete (`{ok: true}`). Audited as `agent.rule.update` / `.delete`; `agent.rule.changed` |
| `GET` | `/api/v1/agents/:id/rules/:ruleId/preview?limit=` | What the rule would have matched (`limit` 1–200, default 50), best effort: among the latest 500 tool calls on the agent's threads, those whose tool, a host or channel in the arguments, or the command's first word fit: `{items: [{callId, threadId, tool, status, decision, createdAt}]}` |
| `GET/POST` | `/api/v1/agents/:id/memory` | What the agent remembers (FR-089): its notes (`store: notes`), then its conversation memory (`store: conversation`, facts and preferences from what the user typed in its threads): `{items: AgentMemoryItemView[]}` `{id, agentId, store, kind: note\|fact\|preference\|observation, content, author: user\|agent, source: manual\|tool\|proactive\|conversation, sourceThreadId, responsibilityId, pinned, originAudience: private\|shared, createdAt, updatedAt}` / add a note `{content (1–8,000), kind?, responsibilityId?, pinned?}` (201; the user's words). Audited as `agent.note.create`; `agent.note.created` |
| `PATCH/DELETE` | `/api/v1/agents/:id/memory/:itemId` | Edit `{content?, pinned?}` / forget (`{ok: true}`). A note the user rewrites becomes the user's. Notes: `agent.note.updated` / `.deleted`, audited as `agent.note.update` / `.delete`; conversation items: `memory.item.updated` / `.deleted` `{scopeKind: agent}`, audited as `agent.memory.update` / `agent.memory.forget` |
| `GET` | `/api/v1/agents/:id/suggestions?status=open\|accepted\|dismissed` | Suggestions from proactive research (FR-082), newest first, at most 200: `{items: AgentSuggestionView[]}` `{id, agentId, noteId, title, body, status, threadId, createdAt, decidedAt}` |
| `POST` | `/api/v1/agents/:id/suggestions/:suggestionId/{accept,dismiss}` | Returns the `AgentSuggestionView`; `conflict` once decided. Accepting only records it: a suggestion is never the user's instruction (FR-189). Audited as `agent.suggestion.accept` / `.dismiss`; `agent.suggestion.updated` |
| `GET/PUT/DELETE` | `/api/v1/agents/:id/goal` | Read (the open goal, else the latest one; `null` when none) / set `{objective (≤ 4,000), budgets?: {timeSeconds? (≥ 60), tokens? (≥ 1,000), costUsd? (≥ 0)}, responsibilityId?}`: replaces the open goal's objective and budgets (budgets left out mean none) or creates an active goal on the main thread; `responsibilityId` attaches it to that responsibility / clear the open goal (`{ok: true}`; its row is deleted). GET and PUT return `GoalView` with `agentId` ([`goal.json`](schemas/goal.json), FR-181). One open goal per agent; there is no `conflict`, since an agent does not end. An active goal of an idle agent continues 5 s after it is set, resumed or a turn ends, after quiet hours, without the user's authority; a used-up goal budget makes it `budget_limited`. Status changes go through `/goals/:id/{pause,resume,complete}`. Audited as `goal.set` / `goal.clear` (kind `agent`); `goal.created` / `goal.updated` |
| `GET/POST` | `/api/v1/agents/:id/schedules` | The schedules that wake the agent (FR-055, FR-206), newest first: the user's (`origin: user`), the agent's own (`agent`) and its wakes (`agent_self`, with `wakeReason`): `{items: ScheduleView[]}` / create one with the body of `POST /schedules` (201 `ScheduleView` with `agentId`). Each fire starts a turn on the agent's main thread (trigger `schedule`), not a Work run; only a schedule the user made carries the user's authority; the agent's autonomy applies. `capability_missing` without the scheduler. Audited as `schedule.create`; `schedule.created` |
| `GET/POST` | `/api/v1/external-agents` | Identities the user marked as AI agents (FR-194, `docs/12` §6.2): `{items: ExternalAgentView[]}` `{id, address, label, createdAt}` / mark `{address (1–300), label? (≤ 200)}` (201). The address is normalized (lower case, punctuation other than `@ . _ -` dropped, a leading "the" removed); marking one again returns the existing entry. Content from a marked identity is data, never a task. Audited as `external_agent.mark` (kind `agent`) |
| `DELETE` | `/api/v1/external-agents/:id` | Unmark: `{ok: true}`. Audited as `external_agent.unmark` |

### Channels, triggers & notification routing (M6)

Channel bindings (`docs/13` §4, ADR-070), event triggers (`docs/09` §7) and notification routing.
The CRUD routes need a session. The two receivers marked **public** authenticate by the sender's
signature or token instead (§1); like every route they still pass the Host and Origin checks, so
the public host name must be one of the Hub's names.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/channels` | Channel bindings (FR-088): `?agentId=`, in creation order: `{items: ChannelBindingView[], adapters: ChannelAdapterView[]}` (`adapters`: `inapp`, `slack`, `teams`, `email`, `webhook` with `available` and `detail`) / create (201 `ChannelBindingView`) `{kind: inapp\|slack\|teams\|webhook\|email, externalRef (≤ 300), agentId?, label? (≤ 200), audience?: private\|shared, sharePrimaryThread?, allowUnknown?, rateLimit?: {perMinute (1–600), perHour (1–10,000)}, enabled?}` plus, per kind: Slack `credentials?: {botToken, signingSecret}`, `shareCredentialsWith?`, `config?: {botUserId?, teamId?}`; Teams `credentials?: {appPassword}`, `shareCredentialsWith?`, `config?: {appId, serviceUrl?}`; webhook `credentials: {token (24–500), secret (32–500)}`, `config?: {callbackUrl?}`. Credentials go to the vault (`secret://channel/<id>/<name>`) and are never returned. A Slack or Teams binding takes its own credentials or shares another binding's app: both or neither is `validation` `{field: credentials}`. Teams needs `config.appId`. A callback URL must be https to a public host. In-app bindings are always private, others default to `shared`; `sharePrimaryThread` needs `private`. Defaults: 10 turns or messages per minute and 120 per hour. A conversation already bound for the same app is `conflict` `{field: externalRef}`; `email` is `capability_missing` (no mailbox connector yet). Audited as `channel.create`; `channel.binding.changed` |
| `GET/PATCH/DELETE` | `/api/v1/channels/:id` | One `ChannelBindingView` (`status: connected\|not_configured\|disconnected`, `statusDetail`, `inboundPath` for Slack, Teams and webhook, `sharesCredentialsWith`, `config` without secrets) / change `{label?, audience?, sharePrimaryThread?, allowUnknown?, rateLimit?, credentials?: {<name>: value}, config?: {<key>: value\|null}}` (at least one): a credential replaces the stored one by name; unknown credential or config names are `validation` naming the field; the in-app binding stays private. Audited as `channel.update`; `channel.binding.changed` / delete: `{ok: true}`; the binding, its message log and pending notification copies go, and the secrets with the last binding that uses them. Audited as `channel.delete` |
| `POST` | `/api/v1/channels/:id/{connect,disconnect}` | Connect turns the binding on and checks its credentials (Slack `auth.test`, Teams a connector token; 30 s); a failed check is not an error: the binding is on and `statusDetail` says what failed. Disconnect turns it off at once: inbound messages are dropped, nothing is sent, and the turns it started are cancelled. Returns the `ChannelBindingView`. Audited as `channel.connect` / `channel.disconnect`; `channel.binding.changed` |
| `POST` | `/api/v1/channels/:id/test` | Send `{text? (1–2,000)}` to the conversation: `{receipt: {id, at}}`. `conflict` when disconnected; a missing credential is `capability_missing`; a service that refuses is `server_error` (retryable). Audited as `channel.test`; `channel.message.sent` |
| `GET/POST` | `/api/v1/channel-identities` | Identity mapping: `{items: ChannelIdentityView[]}` `{id, kind, externalId, displayName, role: owner\|member, createdAt}` / map `{kind, externalId (1–300), displayName?, role? (default member)}` (201; mapping the same identity again replaces it). Only `owner` may write in a private binding and answer approvals from a channel. Unmapped senders are ignored unless the binding has `allowUnknown`. Audited as `channel.identity.set` |
| `DELETE` | `/api/v1/channel-identities/:id` | `{ok: true}`. Audited as `channel.identity.remove` |
| `POST` | `/api/v1/channels/:id/inbound` | **Public: inbound deliveries** from Slack, Teams and webhook channels. No session: the binding's credentials authenticate the raw body before anything is read (1 MiB, larger is 413). Slack: `x-slack-signature` `v0=` HMAC-SHA256 with the signing secret over `v0:<x-slack-request-timestamp>:<body>`, within 5 minutes. Teams: `Authorization: Bearer` a Bot Framework JWT (RS256, issuer `https://api.botframework.com`, audience the app id, 5 minutes' skew, a `serviceUrl` claim equal to the activity's). Webhook: `Authorization: Bearer <token>` and `x-nova-signature: sha256=` HMAC-SHA256 with the secret over `<x-nova-timestamp>.<body>`, within 5 minutes; body `{id, text, from: {id, name?}, conversation?, threadRef?}`. Comparisons are constant-time. A missing, stale or wrong signature or token is 401 `token_required` (not audited); an unknown or in-app binding is 404. Every other outcome is 200 `{ok: true, status: started\|answered\|ignored\|duplicate\|dropped}` so the service does not retry (Slack's URL check gets `{challenge}`). A message id seen before starts nothing; the bot's own messages, unmapped senders and messages that are neither a DM nor a mention are ignored; a disconnected binding, a sender who is not the owner of a private binding, the external-agent rule (FR-194) and the rate cap drop (audited as `channel.message.dropped`). Otherwise a turn starts on the binding's thread (trigger `channel`, no authority, FR-189) and its reply goes back to the conversation. `channel.message.received` |
| `GET/POST` | `/api/v1/triggers` | Event triggers (FR-056; schedule triggers are not listed): `{items: TriggerView[]}` / create (201 `TriggerView`) `{kind, instructions (1–8,000), title? (≤ 200), action?: run\|wake (default run), agentId?, projectId?, autonomy?: ask_first\|standard, enabled?}` plus, per kind: `webhook` `{credentials: {token (24–500), secret (32–500)}, dedupeKey? (a dotted field path; default id)}`; `connector_event` `{bindingId (a Slack binding), conversation?, contains? (≤ 500)}`; `mcp_event` `{serverId, event, filter?}` (also subscribes, as `POST /mcp/subscriptions`); `fs_change` `{deviceId, path}`; `email` `{mailbox, label}`. `wake` needs `agentId`. A fired `run` starts a Work run (origin `trigger`), a `wake` a turn on the agent's thread (trigger `event`); neither carries the user's authority, and the event follows the instructions fenced as data (cut at 16,000 characters). `fs_change` and `email` triggers are stored with `available: false` and do not fire yet. Webhook credentials are write-only (`secret://trigger/<id>`); `webhookPath` is `/api/v1/triggers/:id/webhook`. Audited as `trigger.create`; `trigger.changed` |
| `GET/PATCH/DELETE` | `/api/v1/triggers/:id` | One `TriggerView` (`subscription` for an `mcp_event` trigger) / change `{title?, instructions?, enabled?, autonomy?, dedupeKey?, contains?, credentials?}` (kind, action, agent, project and source cannot change). Audited as `trigger.update` / delete: `{ok: true}`; an `mcp_event` trigger unsubscribes first; its secrets are deleted. Audited as `trigger.delete`; `trigger.changed` |
| `GET` | `/api/v1/triggers/:id/events?limit=` | The trigger's events by dedupe key, newest first (`limit` 1–500, default 100): `{items: [{triggerId, dedupeKey, status: started\|failed\|skipped, runId, threadId, turnId, detail, receivedAt}]}` |
| `POST` | `/api/v1/triggers/:id/webhook` | **Public: webhook trigger receiver.** No session: `Authorization: Bearer <token>` and `x-nova-signature: sha256=` HMAC-SHA256 with the trigger's secret over `<x-nova-timestamp>.<raw body>`, or `<x-nova-timestamp>.<x-nova-event-id>.<raw body>` when the event id header is sent (so the id cannot be swapped in a replay), within 5 minutes, constant-time; 1 MiB. An unknown id or a trigger that is not `webhook` is 404; a bad token or signature is 401 `token_required`, audited as `trigger.rejected` `{reason: bad_token\|unsigned\|stale\|bad_signature}`. The body is the event (JSON, else text); its dedupe key is the `x-nova-event-id` header, else the trigger's `dedupeKey` field, else the body's hash, and a key seen before is 200 `{ok: true, status: duplicate}`. Disabled, or past `triggers.ratePerHour`: 200 `{ok: true, status: skipped, reason: disabled\|rate_limited}`; could not start: 200 `{ok: false, status: failed, reason}`; started: 202 `{ok: true, status: started, runId?}`. Audited as `trigger.fired`; `trigger.fired` |
| `GET` | `/api/v1/notification-rules` | Where each category goes (FR-060): `{items: NotificationRuleView[], quietHours: QuietHoursView}`, one rule for each of `approval`, `completion`, `error`, `attention`, `system`: `{category, inapp, os, channels, bypassQuietHours, isDefault, updatedAt}`. Without a stored rule: in-app and OS on, no channels, and only approvals pass quiet hours |
| `PUT/DELETE` | `/api/v1/notification-rules/:category` | Set `{inapp, os, channels? (binding ids, ≤ 10), bypassQuietHours? (default false, approvals included)}` / reset to the default; both return the rule. A channel that is not one of the account's Slack, Teams or webhook bindings is `validation`. `inapp: false` records the category's notifications as read (history and channel copies, no badge); `os: false` and quiet hours make `notification.created` carry `os: false`. Each listed binding gets a copy when the notification is created, or when quiet hours end unless `bypassQuietHours`; a shared binding only when `channels.privateToShared` is `allow`, else the copy is recorded failed with the reason `withheld: …`. A failed copy is not retried. Audited as `notification.rule.set` / `notification.rule.reset` (kind `settings`) |
| `GET/PUT` | `/api/v1/quiet-hours` | `QuietHoursView` `{enabled, start, end, timezone, days, active, until}` (default off, 22:00–07:00 UTC, every day) / set `{enabled, start, end (HH:MM, different), timezone, days? (0–6, 0 = Sunday)}`; an end not after the start crosses midnight. An unknown time zone is `validation`. While in force, notifications are not raised on the OS, channel copies wait for the window to end, and agents move self-set wakes and goal continuations to its end. Audited as `quiet_hours.set` (kind `settings`) |

M7 adds (FR-110, FR-111, FR-060, FR-055; shapes in `packages/shared/src/m7/channels.ts`):

- **Kinds.** `POST /channels` also takes `telegram` and `email` (email is no longer refused), and
  the adapter list includes `telegram`. A Telegram binding is one chat of a bot `{kind: telegram,
  externalRef (a numeric chat id; groups are negative), credentials?: {botToken}, shareCredentialsWith?,
  config?: {mode?: polling\|webhook}}`; polling is the default, `webhook` needs an https
  `channels.publicUrl`, and its secret token is made by the Hub: a client-supplied `credentials.webhookSecret` is refused on create and update (`validation` on that field). An email
  binding is one correspondent (or a list address) of a mailbox `{kind: email, externalRef (their
  address), credentials?: {password}, shareCredentialsWith?, config: {address, username?, imapHost,
  imapPort?, imapSecurity?: tls\|starttls\|none, smtpHost, smtpPort?, smtpSecurity?, folder? (INBOX),
  mode?: idle\|polling, senderCheck?: dmarc\|none, authservId?}}`, with
  `confirmSenderCheckNone: true` beside `config` whenever `senderCheck: none` is set on create or
  turned on by `PATCH` (else `validation`, reason `confirm_required`); `none` security only to this machine; a
  non-owner's mail servers must be public addresses (`private_address`). Passwords and bot tokens go
  to the vault. `channel-identities` take Telegram user ids and email addresses. Notification rules
  may name Telegram and email bindings, and a schedule's `email` delivery target takes an email
  binding id as `ref`.
- **Inbound.** `POST /channels/:id/inbound` also takes Telegram webhooks
  (`x-telegram-bot-api-secret-token`) and Slack button presses (a form-encoded `payload` with the
  same signing-secret check). Polling bindings (Telegram long polling, IMAP polling or IDLE) are
  read by the Hub's pollers. Email reads past a UID cursor that starts at the end of the folder;
  a sender counts as their mapped identity only with `dmarc=pass` for the From domain (or an
  aligned `dkim=pass`) in the topmost Authentication-Results carrying the binding's `authservId`
  (default: the IMAP host's domain), unless `senderCheck: none`; a mapped sender who fails the check
  counts as unknown (logged `ignored` with reason `unverified_sender`); a message accepted under
  `senderCheck: none` is logged `started` with reason `sender_unchecked`. Messages over 25 MiB are
  skipped.
- **Approvals.** Slack approval prompts carry buttons; a press counts only from the owner, for an
  approval of that binding's own thread, under the same tier rules as a text answer. Email
  approvals are answered only by the signed link in the email (the public `approval-links` routes,
  §1), sent only to a private binding whose sender is the owner; reply text is refused.
  `channel.approval.answered` / `.refused` are audited with `detail.via: button\|link` and refusal
  reasons `unknown`, `other_conversation`, `already_decided`, `link_required`, `unavailable`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/channels/:id/messages?direction=in\|out&status=&cursor=&before=&limit=` | The binding's message log, newest first (`limit` ≤ 500, default 100; `cursor` the previous page's `nextCursor`, a time-and-id cursor so messages sharing a timestamp are never skipped; `before` an ISO time, strictly older; both together is 400 `validation`): `{items: ChannelMessageView[], nextCursor}` `{id, bindingId, direction, externalId, conversation, threadRef, sender, threadId, turnId, status: started\|answered\|ignored\|dropped\|sent\|failed\|withheld, reason, createdAt}`. No content: the text is in the thread |
| `GET/POST` | `/api/v1/channels/approval-links/:token` | **Public** (§1): GET shows the approval and its choices as a plain HTML page and changes nothing; POST `{decision: allow_once\|allow_session\|deny_continue\|deny_stop}` (form or JSON) answers once. `no-store`, `no-referrer`, `default-src 'none'` with only inline style and `form-action 'self'`, no framing |
| `POST` | `/api/v1/mcp/subscriptions/:id/refresh` | Refresh an MCP event subscription now (`{}`) → `McpSubscriptionView`; audited as `mcp.subscription.refresh` |
| `POST` | `/api/v1/notification-rules/:category/test` | Send a test notification of that category through the whole pipeline (in-app, OS and push, channels) `{title?}` → `{category, inapp, os, channels, deferUntil}` (where the rule sends it now, quiet hours included). Audited as `notification.test` |
| `POST` | `/api/v1/schedules/:id/webhook-secret` | FR-055: a new signing secret for the schedule's webhook delivery, shown once (`no-store`): `{scheduleId, secret, scheme: hmac-sha256, rotatedAt}`; receivers check `sha256=` HMAC-SHA256 over `<x-nova-timestamp>.<body>`. The old secret stops working at once and the Hub never returns one again. A schedule with no webhook target is `conflict`. Audited as `schedule.webhook_secret.rotate` |

### Computers, egress & browser (M6)

Every route needs a session; none is public. Another account's object is `not_found`; bodies and
queries are checked by their schema (`validation` with `details.issues`).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/computers` | The account's computers, oldest first (FR-080): `{items: ComputerView[]}` `{id, kind: cloud\|local_container\|local_host, agentId, deviceId, provider, state: starting\|running\|stopped\|degraded\|error, substrate: container\|micro_vm\|bwrap\|host\|cloud_stub\|null, detail, baseImage, snapshotCount, createdAt, updatedAt, lastUsedAt}`. There is no create route: an agent's computer is made on first use as `computers.agentComputer` says (`local_container`: a folder on the Hub plus its sandbox; `cloud`: in M6 a mock runner on the Hub, provider `mock_cloud`, substrate `cloud_stub`), and a connected device's computer by the devices area (`local_host`, provider `novad`). `degraded` while the Hub has no usable sandbox (files work, commands do not); every computer is `stopped` after a Hub restart |
| `GET` | `/api/v1/computers/:id` | One `ComputerView` |
| `GET/POST` | `/api/v1/computers/:id/snapshots` | `{items: ComputerSnapshotView[]}` `{id, computerId, label, sizeBytes, createdAt}`, newest first / take one `{label? (≤ 200)}` (201): a copy of the computer's whole folder (home and browser profile) under `<dataDir>/blobs/snapshots/<computerId>/<snapshotId>/`. Snapshot, restore and stop of one computer run one at a time. A device's computer is `capability_missing` (managed on the device). Audited as `computer.snapshot`; `computer.snapshot.created` |
| `DELETE` | `/api/v1/computers/:id/snapshots/:snapshotId` | Delete a snapshot and its files: `{ok: true}`. Audited as `computer.snapshot.delete` |
| `POST` | `/api/v1/computers/:id/restore` | `{snapshotId}`: the computer's running commands and the sessions its agent's turns started are killed, then its folder is swapped for the snapshot's copy. Returns the `ComputerView`; a device's computer is `capability_missing`. Audited as `computer.restore`; `computer.restored` |
| `POST` | `/api/v1/computers/:id/stop` | Kill its running commands and sessions; the state becomes `stopped` (`computer.state.changed`). An open agent browser is not closed (`DELETE /browser/sessions/:computerId`). Returns the `ComputerView`. Audited as `computer.stop` |
| `GET` | `/api/v1/egress` | What Settings → Network shows (FR-102, FR-193): `EgressView` `{global: {mode: off\|allowlist\|limited, allow, deny}, scopes: EgressScopeView[], inspection: {https, caCertPem}}`. `global` is `network.egressMode`, `network.egressAllow` and `network.egressDeny`; `inspection.https` is false when the Hub's inspection CA could not be loaded (then `limited` blocks HTTPS and credentials go over plain HTTP only) |
| `GET` | `/api/v1/egress/ca.pem` | The inspection CA's public certificate (`application/x-pem-file`); the key never leaves `<dataDir>/egress/`. `not_found` without HTTPS inspection |
| `PUT/DELETE` | `/api/v1/egress/scopes/:kind/:id` | Set (replace) / remove one scope's network policy (FR-193); `kind` is `run\|session\|agent\|plugin\|mcp_server`, `id` is not checked against the object. Body `{mode?: off\|allowlist\|limited\|null, allow? (≤ 500), deny? (≤ 500), hooks? (≤ 100), allowLocalBinding?}`; an omitted field resets (`null` inherits the global mode). A scope's mode only narrows (off < limited < allowlist); its allow entries add hosts; deny entries always win. A host entry is a host name or IP literal; a wildcard only as the whole leftmost label and never over a top-level domain; a bare `*` is `validation`. A hook is `{id, host, methods?, pathPrefix?, action: strip_header\|strip_cookies\|block, header?}` and only tightens. PUT returns `EgressScopeView`; DELETE `{ok: true}`. A change applies to commands started after it. Audited as `egress.scope.set` / `egress.scope.delete` (kind `settings`); `egress.policy.changed`. M6 applies `agent`, `run` and `session` policies; `plugin` and `mcp_server` policies are stored but nothing runs under them yet |
| `GET/POST` | `/api/v1/egress/credentials` | Credentials the proxy injects (ADR-063): `{items: EgressCredentialView[]}` `{id, name, hosts, scheme: bearer\|basic\|header, header, username, scope, secretRef, createdAt, updatedAt}` / create `{name (≤ 100), hosts (1–50), scheme, header?, username?, scope?: {kind, id}\|null, value (1–16,384)}` (201). `value` goes to the vault (`secret://egress/<id>`) and is never returned. `header` (required for `header`) cannot be `Host`, `Connection`, `Proxy-*`, `Content-Length`, `Transfer-Encoding`, `TE`, `Upgrade` or `Cookie`. Without `scope` every sandbox of the account may receive it. Audited as `egress.credential.create` (kind `secret`, never the value) |
| `PATCH/DELETE` | `/api/v1/egress/credentials/:id` | Change `{name?, hosts?, scheme?, header?, username?, scope?, value?}` (a new `value` replaces the vault entry) / delete it with its vault entry (`{ok: true}`). Audited as `egress.credential.update` (field names only) / `egress.credential.delete` |
| `GET` | `/api/v1/egress/decisions?decision=allow\|deny&host=&before=&limit=` | The network decision log (`docs/12` §8): the proxy's audit entries (kind `network`), newest first, `limit` 1–500 (default 100), older than the decision id `before`: `{items: NetworkDecisionView[], nextCursor}` (the last id when the page is full, else null) `{id, createdAt, decision, cause: allowlist\|denylist\|method\|private_address\|inspection\|policy\|null, method, host, port, scope, addressClass, mode, status, inspected, bytesIn, bytesOut}`; `host` is an exact match. No bodies, paths or full URLs are stored |
| `GET` | `/api/v1/browser/status` | `BrowserStatusView` `{available, detail, driver: playwright, egress: wired\|missing\|not_required}` (FR-092). `available` needs Chromium (`browser.executablePath`, else the one installed for Playwright) to start headless on the Hub and the egress proxy: without the proxy the agent browser stays closed |
| `GET/PUT` | `/api/v1/browser/sites` | Site permissions (FR-094): `{items: BrowserSiteView[]}` `{pattern, access: allow\|block, level: always_ask\|auto_review\|always_allow\|null, devProtocol, createdAt, updatedAt}` / add or change one `{pattern, access? (default allow), level?, devProtocol?}`. `pattern` is a host, `*.host` or a bracketed IPv6 literal (no scheme, port, path or bare `*`). A new allowed site starts at `always_ask`; a blocked site has no level and no developer-protocol mode. `devProtocol: true` while `browser.devProtocol` is off is `policy_denied`. Each allowed site's level is one user policy rule on `browser.act` scoped to the site: `ask` for Always ask, `allow` for the others, plus the auto-reviewer on `auto_review` sites; confirmation tiers apply at every level (FR-189). Audited as `browser.site.set` (and `browser.devprotocol.enabled` / `.disabled`) |
| `PATCH/DELETE` | `/api/v1/browser/sites/:pattern` | Change `{level?, devProtocol?}` / remove the site with its level rule and the `browser.site` rules its "Always allow" answers wrote, so the next visit asks again. Audited as `browser.site.set` / `browser.site.removed` |
| `GET/PUT` | `/api/v1/browser/domains` | The allow and block lists as patterns `{allow, deny}` (`network.egressAllow` and `network.egressDeny` also count) / replace either `{allow? (≤ 500), deny? (≤ 500)}`; a pattern on both is blocked. Audited as `browser.domains.set` |
| `GET` | `/api/v1/browser/sessions` | Open agent browsers, held in Hub memory (FR-096): `{items: [{computerId, state: starting\|running\|paused\|closed\|error, url, title, host, pausedBy, pageTools, startedAt, lastActionAt, persistCookies}]}`; `pageTools` are `page:<host>.<name>` (FR-208). A browser runs on the thread's agent computer, else `thread-<threadId>`; at most `browser.maxConcurrent` are open (the least recently used idle one closes). M7 adds `crash` `{at, reason}\|null` (it crashed and restarts on the next action) and `restarts` |
| `DELETE` | `/api/v1/browser/sessions/:computerId` | Close that browser (cookies saved first when `browser.persistCookies` is on): `{ok: true}`. Audited as `browser.session.closed`; `browser.session.changed` |
| `GET` | `/api/v1/browser/actions?threadId=&callId=&computerId=&limit=` | The browser's trace (FR-098), oldest first, `limit` 1–500 (default 100): `{items: BrowserActionView[]}` `{id, computerId, threadId, turnId, callId, tool, action, target, url, host, result: ok\|error\|blocked\|denied\|handoff, error, classification: {effects, flagged, reasons, handoff}\|null, before, after, approvalId, createdAt}`. `url` has no query or fragment; `target` and `error` are redacted; typed text is never stored. M7: newest first with `?cursor=` (the previous page's `nextCursor`): `{items, nextCursor}` (null on the last page); a forged or malformed cursor is 400 `validation`. `browser.crash` and `browser.restart` rows join the trace |
| `GET` | `/api/v1/browser/site-levels?scopeKind=project\|agent&scopeRef=&pattern=` | Site levels set for one project or agent (FR-094, M7, `docs/11` §4.4): `{items: BrowserSiteScopedLevelView[]}` `{pattern, scopeKind, scopeRef, level, createdAt, updatedAt}`. The narrower scope wins: an agent's level, then a project's, then the account's. `BrowserSiteView` gains `scopedLevels` |
| `PUT/DELETE` | `/api/v1/browser/sites/:pattern/levels/:scopeKind/:scopeRef` | Set `{level: always_ask\|auto_review\|always_allow}` / remove an allowed site's level for that project or agent (`scopeRef` letters, digits, `_` and `-`). Blocking or removing the site removes its scoped levels. Audited as `browser.site.level.set` / `.removed` |
| `GET` | `/api/v1/browser/sessions/:computerId/console?limit=`, `…/network?limit=` | What the open browser captured (FR-092, FR-103, M7), newest last (`limit` 1–300, default 100): `{items, dropped}` of `BrowserConsoleEntryView` `{seq, at, level: error\|warning\|info\|log\|debug, source: console\|pageerror, text, url, line, pageUrl}` or `BrowserNetworkEntryView` `{seq, at, method, url, resourceType, navigation, status, statusText, mimeType, size, durationMs, failure, blocked, requestHeaders, responseHeaders, body, bodyOmitted: binary\|too_large\|unavailable\|none\|null}`; redacted like what the agent reads (`docs/11` §4), page content and untrusted. 404 when that computer has no open browser |
| `GET` | `/api/v1/browser/actions/:id/screenshots/:which` | The `before` or `after` PNG (`Cache-Control: private, no-store`): `<dataDir>/blobs/screenshots/<yyyymmdd>/<id>-<which>.png`, sealed with the data key, swept after `browser.screenshotRetentionDays` (the trace row stays) |
| `GET` | `/api/v1/browser/signins?threadId=` | Private sign-in forms waiting for the user (FR-086), held in Hub memory: `{items: [{id, computerId, threadId, host, url, state, savedLogins: [{id, username}], createdAt, expiresAt}]}`; a form waits 15 minutes |
| `POST` | `/api/v1/browser/signins/:id/submit` | `{username (≤ 500), password (≤ 1,000), save?}` or a saved login of this host `{loginId, confirm: true}`. The values go only to the browser, which fills the page and submits: `{state: completed\|failed, message}`. `save: true` stores the password in the vault (`secret://browser/login/<id>`). The password is never echoed, logged or audited. A form no longer waiting is 410 `request_expired`; a saved login of another host is `validation`. Audited as `browser.signin.submitted` (and `browser.login.saved` or `.used`); `signin.completed` |
| `POST` | `/api/v1/browser/signins/:id/cancel` | Decline: `{ok: true}`; the agent's call ends `cancelled`; 410 when no longer waiting. Audited as `browser.signin.cancelled`; `signin.cancelled` |
| `GET` | `/api/v1/browser/logins` | Saved logins (passwords only in the vault): `{items: [{id, host, username, createdAt, lastUsedAt}]}` |
| `DELETE` | `/api/v1/browser/logins/:id` | Delete a saved login and its vault entry: `{ok: true}`. Audited as `browser.login.deleted` |

### Computers: screen, takeover & appshots (M6)

Every route needs a session; none is public. `:id` is a computer of the account, else
`not_found`. In M6 only `cloud` computers have a controlled desktop (a mock desktop on the Hub;
the default agent computer is `local_container`); other computers answer `conflict` where a
desktop is needed.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/computers/:id/screen` | Computer use status (FR-093, FR-207): `ScreenStatusView` `{computerId, enabled, state: disabled\|idle\|controlling\|stopped\|taken_over, stoppedAt, stoppedBy: user\|key\|system, grants (active only), takeover, indicator: {visible, apps, text, killKey}, lastActionAt, activeApp}`. Precedence: `taken_over`, `disabled`, `stopped` (after the kill key until resumed), `controlling` (an active grant), `idle`. The indicator shows only while `controlling` |
| `PUT` | `/api/v1/computers/:id/screen/control` | The enablement toggle `{enabled}` (FR-093; off until the user enables it); returns `ScreenStatusView`. Turning it off aborts the agent's input in flight without the kill key's stop and without pausing the agent; turning it on does not clear a kill-key stop. Audited as `screen.control.enabled` / `.disabled`; `screen.control.changed` |
| `POST` | `/api/v1/computers/:id/screen/kill` | The kill key (FR-207), no body. Delivery stops first: the input in flight is aborted, the agent's controller handle is killed and dropped and queued input is refused; the stop is stored and holds across restarts until `resume`. The agent that uses the computer is paused (its turns are cancelled, its runs paused) and so is the computer's browser. Returns `ScreenStatusView`. Audited as `screen.kill`; `screen.control.changed` |
| `POST` | `/api/v1/computers/:id/screen/resume` | Clear the stop; resumes the computer's paused browser and the agent the screen area paused (that memory does not survive a restart). Returns `ScreenStatusView`. Audited as `screen.resume`; `screen.control.changed` |
| `GET` | `/api/v1/computers/:id/screen/observation` | The user's view of the desktop: `{computerId, width, height, takenAt, windows: [{id, app, title, focused, tier: none\|view\|click\|full, bounds, granted}], tree, mime: image/png, image}` (base64; windows front first; `tree` is untrusted screen content). Not stored; it does not replace the agent's last observation. `conflict` without a desktop, `conflict` `{reason: observation_failed}` |
| `GET` | `/api/v1/computers/:id/screen/frame?surface=desktop\|browser` | The current frame as `image/png` (`no-store`); `browser` screenshots the computer's agent browser |
| `GET` | `/api/v1/computers/:id/screen/grants?all=` | Per-app grants (FR-207), newest first: `{items: ScreenGrantView[]}` `{id, computerId, app, tier, grantedBy, threadId, createdAt, expiresAt, revokedAt, active, remainingSeconds}`; active ones unless `all` |
| `POST` | `/api/v1/computers/:id/screen/grants` | Grant an app `{app (1–200), minutes? (1–1,440; default screen.grantMinutes), threadId?}`: 201 `ScreenGrantView`. Only the user makes grants. An app at tier `none` (password managers, system settings, banking and the like) is `policy_denied` `{app, tier}`; an active grant for the same app is renewed instead. Audited as `screen.grant.created`; `screen.grant.changed` |
| `POST` | `/api/v1/computers/:id/screen/grants/:grantId/renew` | `expiresAt` becomes now plus `screen.grantMinutes`; `conflict` once revoked. Audited as `screen.grant.renewed`; `screen.grant.changed` |
| `DELETE` | `/api/v1/computers/:id/screen/grants/:grantId` | Revoke; returns the grant. Audited as `screen.grant.revoked`; `screen.grant.changed`. An expiring grant emits nothing: clients read `expiresAt` |
| `GET` | `/api/v1/computers/:id/screen/actions?limit=&before=` | Recorded input actions (FR-098), newest first, `limit` 1–200 (default 50), `before` an action id: `{items: ScreenActionView[]}` `{id, computerId, actor, origin: tool\|takeover, kind: click\|scroll\|type\|key\|drag, args, app, windowTitle, tier, status: ok\|refused\|failed\|stopped, error, threadId, turnId, callId, takeoverId, hasBefore, hasAfter, createdAt, completedAt}`. Typed text is kept as its length only. Refused actions and the user's takeover input have no screenshots; browser takeover input is not recorded here |
| `GET` | `/api/v1/computers/:id/screen/actions/:actionId/{before,after}` | The action's screenshot (`image/png`); `not_found` when it has none or it was pruned (`screen.screenshotRetentionDays`) |
| `GET` | `/api/v1/computers/:id/takeover` | `{takeover: ScreenTakeoverView\|null}` `{id, computerId, surface: desktop\|browser, startedBy, startedAt, endedAt, endReason: returned\|restart\|null, inputCount}` |
| `POST` | `/api/v1/computers/:id/takeover` | Take over the keyboard and mouse (FR-087) `{surface? (default desktop)}`: 201 `ScreenTakeoverView`. One open takeover per computer (a second is `conflict`). The agent's input in flight is aborted, its later actions wait until control returns and it must observe again; the agent that uses the computer is paused as for the kill key (its running turns are cancelled), and so is its browser. Audited as `computer.takeover.started` (kind `computer`); `computer.takeover.started`, `screen.control.changed` |
| `POST` | `/api/v1/computers/:id/takeover/input` | The user's input while they have control: `{action}` (desktop) or `{browser}` (browser takeover), exactly one; `{ok, error}`. No tiers or grants apply to the user. `action`: `{kind: click, x, y, button?}`, `{kind: scroll, x, y, dy}`, `{kind: type, text (1–10,000)}`, `{kind: key, keys}`, `{kind: drag, from, to}`; `browser`: `{kind: click, x, y}`, `{kind: type, text}`, `{kind: key, key}`, `{kind: scroll, dy}`. Each event times out after 30 s. `conflict` without an open takeover. Desktop input is recorded as a screen action (origin `takeover`, audited as `screen.<kind>`) |
| `POST` | `/api/v1/computers/:id/takeover/end` | Return control; returns the closed takeover (`endReason: returned`); waiting agent actions go on and must observe again; what the takeover paused is resumed. `conflict` when not taken over. Audited as `computer.takeover.ended`; `computer.takeover.ended`, `screen.control.changed`. Takeovers a restart left open are closed at startup (`endReason: restart`) |
| `GET` (WebSocket) | `/api/v1/computers/:id/screen/live?surface=desktop\|browser` | Live view (FR-087): `state` and `frame` frames (a frame every 2 s) and the user's `input`, `kill` and `refresh` (§5 "Screen live frames"). The session and the computer's owner are checked before the upgrade |
| `POST` | `/api/v1/computers/:id/appshots` | Capture an appshot (FR-075) `{source?: window\|screen\|browser (default window), windowId?, app?, threadId?}`: 201 `AppshotView` `{id, computerId, artifactId, source, app, windowTitle, url, width, height, threadId, capturedBy, capturedAt}`. A window is cropped out of the screen; the image becomes an `image` artifact (`artifact.created`). Audited as `appshot.captured` |
| `GET` | `/api/v1/appshots?computerId=&threadId=&limit=` | The account's appshots, newest first: `{items: AppshotView[]}` |
| `GET` | `/api/v1/appshots/:id` | One `AppshotView` |

### Devices: `novad` (M6, `docs/23`)

Every route needs a session. A route that acts on a device needs it `active` with an endpoint
(`node_unavailable` `{reason: unreachable, status}`, retryable; a revoked device is `not_found`)
and the capability the row names, else `capability_missing` `{reason:
module_missing|module_not_allowed|update_required, capability, module, minVersion, novadVersion}`
(FR-148). The device's own refusals come back with their code; a device that refuses the
management token is `auth_missing` `{reason: device_token_rejected}`. File and MCP routes act as
the signed-in user's grantee `{kind: user, id: <accountId>}` unless a `grantee` is given. They do
not consult the policy engine: the device enforces its grants and protected paths, and the Hub adds
its own protected-path check on writes.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/devices/novad` | The account's `novad` devices, any status, oldest first: `{items: DeviceView[]}` `{id, name, roles, status: pending\|active\|unreachable\|revoked, platform, novadVersion, updateChannel, endpoint, capability (the last signed document), capabilities: DeviceCapabilityStatus[], updateRequired, capabilityOverrides, policy, configPending, routingEligible, modules: DeviceModuleView[], wake: {wakeable, macs}, lastSeenAt, createdAt}`; `unreachable` after 3 missed heartbeats (30 s) |
| `POST` | `/api/v1/devices/novad/enroll` | A `novad` enrollment token `{roles? (client\|compute\|wake-helper, 1–3; default [client])}`: 201 `{token: "nvd_…", expiresAt, command}` (one use, 15 min, shown once). A `novad` device is never a compute node, whatever its roles |
| `GET` | `/api/v1/devices/:id` | One `DeviceView`; a compute node is `not_found` here |
| `GET` | `/api/v1/devices/:id/capabilities` | `{novadVersion, updateRequired, items: [{name, module, minVersion, available, reason: module_missing\|module_not_allowed\|update_required\|null}], document}` for `files`, `staged_writes`, `exec`, `mcp` (storage module), `power`, `services`, `updates` (management), `computer_use` (screen), `browser` and `capture` |
| `POST` | `/api/v1/devices/:id/modules/:name/{start,stop,restart,rollback}` | Control a module (FR-141); needs `services`. Anything but `stop` of a module outside `policy.allowedModules` is `policy_denied` `{reason: module_not_allowed}`; `rollback` returns to the version an update replaced (`conflict` when none); a module whose program no longer matches its signed hash is `policy_denied` `{reason: checksum_mismatch}`. Returns `{module: {name, version, state: running\|stopped\|backoff\|disabled, pid, restarts, lastExit, disabledReason, startedAt, previousVersion}}`. Audited as `device.module.<action>`; `device.module.changed` |
| `POST` | `/api/v1/devices/:id/services/:name/{start,stop,restart,status}` | Services the device owner declared in `novad`'s config (FR-145): a supervised module or a systemd unit; another name is `not_found`. Needs `services`. `{service: {name, kind, state, module\|unit}}`. `start`, `stop` and `restart` are audited as `device.service.<action>` and emit `device.service.changed` |
| `GET/POST` | `/api/v1/devices/:id/power` | Power and Wake-on-LAN (FR-144); needs `power`. GET: `{wakeable, wol: [{interface, mac, supports, wakeOn, magicSupported, magicEnabled, …}], macs, ac, afterPowerLoss: "unknown", changesAllowed, actionsAllowed, elevated}` / POST `{action: status\|wol-plan\|wol-enable\|sleep\|restart\|shutdown, apply?}`: `wol-plan` returns the plan (an `ethtool` step and a systemd-networkd `.link` file per capable NIC) and changes nothing, as does `wol-enable` without `apply: true`; applying needs the device's own config to allow changes and `novad` to run elevated, else `policy_denied` `{reason: power_changes_disabled\|elevation_required, plan}`; `sleep`, `restart` and `shutdown` need the device's config to allow power actions (`policy_denied` `{reason: power_actions_disabled}`). Audited as `device.power.<action>`; `device.power.requested`. Linux only |
| `GET/POST` | `/api/v1/devices/:id/updates` | Signed updates (FR-148): `{items: DeviceUpdateView[]}` `{id, deviceId, target, fromVersion, toVersion, channel, status: applied\|rolled_back\|staged\|refused\|failed, detail, createdAt}` / push `{bundles: [{manifest: {target, version, channel, sha256, size (≤ 64 MiB)}, signature, payload}] (1–10)}` (body ≤ 96 MiB); needs `updates`. Bundles apply one at a time, a `novad` bundle last and only when the earlier ones applied (else `refused`). The device checks the signature against the key it pinned at enrollment, its channel (its own or a more stable one), a strictly newer version and the payload's size and SHA-256. A module update is staged, swapped in, restarted and health-checked, else rolled back; a `novad` bundle is `staged`, and its first accepted heartbeat after the restart records it `applied`. `{items}`, one per bundle. Audited as `device.update`; `device.update.result`. The M6 Hub has no update key of its own, so a device takes bundles only when `novad enroll --update-key` pinned one |
| `GET` | `/api/v1/devices/:id/files?path=` | List a folder inside the grantee's grants (FR-210); needs `files`. `{path, entries: [{name, kind: file\|dir\|symlink\|other, size}], truncated}` (5,000; protected entries left out). Outside the grants: `policy_denied` `{reason: folder_access_required, path, access}`; credential locations and `novad`'s data folder: `policy_denied` `{reason: protected_path}` |
| `GET` | `/api/v1/devices/:id/files/content?path=&maxBytes=` | Read a file inside the grants: `{path, contentBase64, size, sha256, truncated}` (`maxBytes` up to 8 MiB, default 1 MiB) |
| `GET/POST` | `/api/v1/devices/:id/grants` | The Hub's copy of the device's grants and requests: `{items: DeviceAccessRequestView[]}` `{id, deviceId, grantee: {kind: user\|agent\|session\|run\|thread, id}, kind: folder\|mcp, target, access: read\|write\|call, reason, status: pending\|granted\|denied\|revoked, approvalId, decidedBy: device\|hub\|null, createdAt, decidedAt}` / grant directly, the signed-in user's own decision: `{kind: folder, grantee, path, access}` or `{kind: mcp, grantee, server}` (201). A credential location is `policy_denied` `{reason: protected_path}`. Audited as `device.grant.create`; `device.access.decided` |
| `DELETE` | `/api/v1/devices/:id/grants/:grantId` | Revoke a grant or withdraw a pending request (its card is cancelled): `{ok: true}`. Audited as `device.grant.revoke`; `device.grant.revoked` |
| `POST` | `/api/v1/devices/:id/access-requests` | Ask for a folder `{path, access? (default read), reason? (≤ 500), grantee?}`: 201 `DeviceAccessRequestView`. The signed-in user's own request is granted at once. For another grantee it waits `pending` with a Hub approval card (tier `confirm_at_action`, allow once or deny, expires after 24 h; the reason is shown as the requester's words), which the device owner can also decide with `novad access approve\|deny`: `approval.requested`, `device.access.requested`. A folder an existing grant covers comes back `granted`. At most 200 pending per device (429). Audited as `device.access.request` and `device.access.decide`; `device.access.decided` |
| `GET` | `/api/v1/devices/:id/access-requests/:rid` | One `DeviceAccessRequestView` |
| `GET/POST` | `/api/v1/devices/:id/staged?status=&sessionRef=` | Staged writes (FR-210): `{items: StagedWriteView[]}` `{id, deviceId, grantee, sessionRef, path, baseSha256, newSha256, size, diff, additions, deletions, binary, status: staged\|committed\|discarded\|conflict\|expired\|failed, error, createdAt, committedAt}` / stage `{path, content? \| contentBase64? (exactly one; ≤ 10 MiB on the device), baseSha256?, createDirs?, grantee?, sessionRef?}` (201): nothing changes on the device yet; `novad` keeps the content and returns the diff. The Hub refuses credential locations and `.git`, `.nova`, `.agents` or shell startup files anywhere in the path (`policy_denied` `{reason: protected_path}`). A stale `baseSha256` is `conflict` `{reason: base_mismatch, currentSha256}`. A path outside the write grants files a folder request (`policy_denied` `{reason: folder_access_required, requestId, approvalId}`; for the signed-in user it is granted at once and the answer is `conflict` `{reason: access_granted}`: stage again). Stages expire after 24 h. Audited as `device.write.stage`; `device.write.staged` |
| `GET` | `/api/v1/devices/:id/staged/:sid` | One `StagedWriteView` |
| `POST` | `/api/v1/devices/:id/staged/:sid/{commit,discard}` | `commit`: the device replaces the file atomically only while the grant holds and the file still has the base hash; a changed file is `conflict` `{reason: base_mismatch}` and staged content changed on the device `{reason: staged_tampered}`: nothing is written (`device.write.conflict`); a stage the device no longer has becomes `expired`. Audited as `device.write.commit`; `device.write.committed`. `discard`: dropped on both sides; audited as `device.write.discard`; `device.write.discarded` |
| `GET` | `/api/v1/devices/:id/mcp?granteeKind=&granteeId=` | The device's local stdio MCP servers (declared by its owner) that the grantee holds an `mcp` grant for, with their tools: `{servers: [{name, tools, error?}]}`; needs `mcp` |
| `POST` | `/api/v1/devices/:id/mcp/call` | `{server, tool, arguments?, grantee?}` → `{content, isError, untrusted: true}`; needs `mcp`. Without a grant `policy_denied` `{reason: mcp_grant_required}`; a sandboxed server on a device without bubblewrap is `sandbox_unavailable`; past 30 s `server_error`. The server starts for the call (under bubblewrap unless the owner turned it off) and its output is untrusted. Audited as `device.mcp.call` |
| `GET/POST` | `/api/v1/devices/connections?agentId=&deviceId=` | An agent's connected computer (FR-081): `{items: AgentDeviceConnectionView[]}` `{id, agentId, deviceId, deviceName, capabilities, status: active\|revoked, createdAt, revokedAt}` / connect `{agentId, deviceId, capabilities? (files\|staged_writes\|exec\|mcp\|computer_use\|browser; default files, staged_writes, exec), replace?}` (201). One active connection per agent: another device is `conflict` `{reason: agent_connected}` unless `replace: true`. A device with `policy.routingEligible: false` is `policy_denied` `{reason: not_routing_eligible}`; a capability below its minimum `novad` version is `capability_missing`. The agent gets a `local_host` computer: files through stage and commit, commands sandboxed on the device and refused in the device's quiet hours (`policy_denied` `{reason: quiet_hours}`). Audited as `device.connection.create`; `device.connection.changed` |
| `DELETE` | `/api/v1/devices/connections/:id` | End a connection; the agent's grants go with it. Returns the view (`revoked`). Audited as `device.connection.revoke`; `device.connection.changed` |

### Spaces, sites & visualizations (M6)

Every route needs a session; none is public. Another account's space, page, comment, proposal or
site, or a deleted one, is `not_found`. Bodies are strict (unknown fields are `validation`) and
capped by the Hub's 1 MiB body limit, so a page save near the 500,000-character cap in multi-byte
text is refused (413, reported as `validation`) before it is read.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/spaces` | The account's spaces, newest change first: `{items: SpaceView[]}` `{id, name, description, projectId, agentEdits: propose\|direct, pageCount, createdAt, updatedAt}` / create `{name (1–200), description? (≤ 2,000), projectId?, agentEdits?}` (201 `SpaceView`); without `agentEdits` the `spaces.agentEdits` setting decides (default `propose`). An unknown project is `not_found`. `space.created` (FR-036) |
| `GET/PATCH/DELETE` | `/api/v1/spaces/:id` | One `SpaceView` / change `{name?, description?, agentEdits?}` (`space.updated`) / delete: `{ok: true}`; the space and its pages are soft-deleted and their open proposals end rejected (no event). Sites built from it stay and fail their next build. Audited as `space.deleted`; `space.deleted` |
| `GET/POST` | `/api/v1/spaces/:id/pages` | The pages in order: `{items: PageSummaryView[]}` `{id, spaceId, title, slug, position, version, updatedBy: user\|agent, openComments, openProposals, createdAt, updatedAt}` / create `{title (1–200), content? (Markdown, ≤ 500,000 characters), slug?}` (201 `PageView`, the summary plus `content`; version 1, placed last). `slug` (`^[a-z0-9][a-z0-9-]{0,62}$`) is the page's file name in a site: one in use is `conflict` `{reason: slug_taken}`; without one it is made from the title with `-2`, `-3`, … on a clash. `space.page.created` |
| `GET/PUT/PATCH/DELETE` | `/api/v1/spaces/:id/pages/:pageId` | One `PageView` / save a version `{baseVersion, title?, content? (≤ 500,000), summary? (≤ 500)}` (a title or content is required): a `baseVersion` that is not the current version is `conflict` `{reason: stale_version, current: PageView}`, checked again inside the write, never an overwrite; a save that changes nothing makes no version; comment anchors move to the new text. `space.page.updated` / change `{position? (0–10,000), slug?}`, not versioned; returns `PageSummaryView` and emits `space.page.updated` with the same version / delete: `{ok: true}` (soft); its open proposals end rejected. Audited as `space.page.deleted`; `space.page.deleted` |
| `GET` | `/api/v1/spaces/:id/pages/:pageId/versions` | Every version, newest first, without content: `{items: PageVersionView[]}` `{pageId, version, title, authorKind: user\|agent, authorRef (the agent's thread), summary, restoredFrom, proposalId, size, createdAt}` |
| `GET` | `/api/v1/spaces/:id/pages/:pageId/versions/:version` | One `PageVersionView` with `content`; an unknown version is `not_found` |
| `POST` | `/api/v1/spaces/:id/pages/:pageId/restore` | Restore `{version, baseVersion}`: the old title and content become a new version (`restoredFrom` set), so history keeps everything. Returns the `PageView`; a stale `baseVersion` is `conflict` `{reason: stale_version, current}`. Audited as `space.page.restored`; `space.page.updated` |
| `GET/POST` | `/api/v1/spaces/:id/pages/:pageId/comments` | All comments and replies, oldest first: `{items: PageCommentView[]}` `{id, pageId, parentId, authorKind, authorRef, body, anchor, version, detached, resolved, resolvedAt, createdAt, updatedAt}` / add `{body (1–4,000), anchor?, version?, parentId?}` (201). `anchor` is `{kind: page}` (default), `{kind: range, start, end, quote (1–2,000)}` or `{kind: block, index, quote}` (a top-level Markdown block), checked against `version` (default the current one): a quote not at those offsets or a block past the last is `validation` `{reason: anchor_mismatch}`; an anchor from an older version is moved forward and may start `detached`. `parentId` names a top-level comment; a reply to a reply is `validation`. `space.comment.created` |
| `POST` | `/api/v1/spaces/:id/pages/:pageId/comments/:commentId/resolve` | `{resolved: boolean}`: resolve or reopen; returns the comment; `space.comment.updated` |
| `DELETE` | `/api/v1/spaces/:id/pages/:pageId/comments/:commentId` | Delete a comment with its replies: `{ok: true}`; `space.comment.deleted` |
| `GET` | `/api/v1/spaces/:id/proposals?status=open\|all&pageId=` | Agent edits waiting for the user (default `open`), newest first: `{items: PageProposalView[]}` `{id, spaceId, pageId (null: a new page), baseVersion, title, content, summary, authorKind: agent, authorRef, status: open\|accepted\|rejected, stale, createdAt, decidedAt}`; `stale` when the page moved past `baseVersion` or was deleted. Only `page.edit` in a `propose` space makes proposals |
| `POST` | `/api/v1/spaces/:id/proposals/:proposalId/accept` | `{force?}`: the proposal becomes a new version authored by the agent with its `proposalId` (or a new page). Returns the `PageView`. A decided proposal is `conflict` `{reason: decided}`; a stale one without `force: true` is `conflict` `{reason: stale_proposal, current}`; with `force` it is saved over the current version. Audited as `space.proposal.accepted`; `space.page.updated` (or `.created`), then `space.proposal.decided` |
| `POST` | `/api/v1/spaces/:id/proposals/:proposalId/reject` | Returns the `PageProposalView`; `conflict` `{reason: decided}` once decided. Audited as `space.proposal.rejected`; `space.proposal.decided` |
| `GET` | `/api/v1/sites` | `{items: SiteView[]}`, newest change first: `{id, name, description, source: {kind: space, spaceId}\|{kind: artifact, artifactId}, sourceLabel, data: [{sourceId, name}], latestVersion, publishedVersion, publishedTarget, publishedAt, createdAt, updatedAt}` (FR-037) |
| `GET` | `/api/v1/sites/data-sources` | The account's JSON and CSV project sources a site can use as data: `{items: SiteDataSourceView[]}` `{id, name, mime, size, projectId, projectName}` |
| `POST` | `/api/v1/sites` | Create `{name (1–200), description? (≤ 2,000), source, data?: [{sourceId, name}]}` (201 `SiteView`; nothing is built yet). `data` holds up to 10 connections with unique names (`^[a-z0-9][a-z0-9_-]{0,39}$`), each written into the site as `data/<name>.json`. An unknown space is `not_found`; a missing artifact `not_found` `{reason: source_missing}`; an artifact that is not HTML or Markdown `validation` `{reason: source_kind}`; a data source that is not JSON or CSV `validation` `{reason: data_format}`. `site.created` |
| `GET/PATCH/DELETE` | `/api/v1/sites/:id` | One `SiteView` / change `{name?, description?, source?, data?}` (checked as on create; `data` replaces the list; `site.updated`) / delete: `{ok: true}`; a site with a live publish is `conflict` `{reason: published}`. Audited as `site.deleted`; `site.deleted` |
| `POST` | `/api/v1/sites/:id/build` | Build a version from the source as it is now `{note? (≤ 500)}`: 201 `SiteVersionView` `{siteId, version, note, files: [{path, size}], size, sha256, scripts, published, createdAt}`. A space site is one HTML page per page (`index.html`, then `<slug>.html`; at most 200) with inline CSS and no script; an artifact site is the HTML artifact as it is, or a Markdown artifact rendered as one page. `chart`, `diagram` and `nova-table <name>` fenced blocks become static SVG and tables. The zip is byte-identical for the same content; it and the preview are stored as blobs. Errors: `not_found` `{reason: source_missing}` or `{reason: data_missing, name}`; `validation` `{reason: source_kind\|size\|parse\|shape\|data_format}` (data over 2 MiB, bad JSON, not a list of rows). `site.version.created` |
| `GET` | `/api/v1/sites/:id/versions` | `{items: SiteVersionView[]}`, newest first; `published` marks the live version, `scripts` whether its preview may run the source's own scripts |
| `GET` | `/api/v1/sites/:id/versions/:version/preview` | The version as one HTML document (a space site's pages are sections switched by in-page links, because a sandboxed frame cannot load other URLs with the session). `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'`, or, only for a version built from an HTML artifact that contains a script, `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; frame-ancestors 'self'` (never same-origin); plus `X-Frame-Options: SAMEORIGIN`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: private, no-cache`. Nothing loads from elsewhere |
| `GET` | `/api/v1/sites/:id/versions/:version/zip` | The files as `application/zip`, `Content-Disposition: attachment; filename="<name>-v<version>.zip"`, `nosniff`; the Hub's default CSP and `X-Frame-Options: DENY` stay |
| `GET` | `/api/v1/sites/:id/publishes` | Publish history, newest first: `{items: SitePublishView[]}` `{id, siteId, version, target: {kind: folder, folder}\|{kind: zip}, current, revertedAt, createdAt}` |
| `POST` | `/api/v1/sites/:id/publish` | `{version, target, confirm: true}`: the strict body without `confirm: true` is `validation`, so publishing is always explicit; an earlier version is a rollback. A folder target (`^[a-z0-9][a-z0-9-]{0,62}$`) is written under `sites.publishRoot` (default `<data>/sites`) with a `.nova-site` marker holding the site id and swapped in atomically; an existing folder without this site's marker (or a link or a file) is `conflict` `{reason: folder_in_use}`. Moving to another target removes the previous marked folder. Returns `SitePublishResult` `{site, publish, downloadUrl, folderPath}`. Audited as `site.published`; `site.published`. Remote hosting targets are not in M6 |
| `POST` | `/api/v1/sites/:id/unpublish` | `{confirm: true}`: the live publish is marked reverted and the previous one not yet undone is live again (its folder written back), or nothing is published. Returns `SitePublishResult`; nothing published is `conflict` `{reason: not_published}`. Audited as `site.unpublished`; `site.unpublished` |

Visualizations (FR-076) have no route: `visualize.create` saves a `chart` artifact
(`application/json`) holding `{type: "nova.visualization", version: 1, kind: chart|diagram|notebook,
title, spec}`, read through `GET /api/v1/artifacts/:id/content` and drawn by the client from the
spec. Pets (FR-012) are the `appearance.pet*` settings. The `spaces` diagnostics probe reports
Hub-wide counts of spaces, pages and sites and the resolved publish root.

### Ambient (`docs/24`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/ambient/summary?from=&to=` | Activity summary (FR-229) |
| `GET` | `/api/v1/ambient/search?q=&from=&to=` | Full-text search, time-ordered (FR-153) |
| `GET` | `/api/v1/ambient/elements?q=&from=&to=` | Element matches with bounds |
| `GET` | `/api/v1/ambient/records/:id/context` | One record with its neighbours and, when pixels exist, a short-lived image handle |
| `GET` | `/api/v1/ambient/timeline?from=&to=` | Records and status changes in order |
| `GET` | `/api/v1/ambient/coverage?from=&to=` | Captured, paused, excluded and gap intervals (FR-155) |
| `GET/POST` | `/api/v1/ambient/grants` | Scoped grants for schedules, automations, agents and apps (FR-233) |
| `DELETE` | `/api/v1/ambient/grants/:id` | Revoke a grant |
| `POST` | `/api/v1/ambient/forget` | Delete the last N minutes `{minutes, sources?}` (FR-154) |

Ambient reads return certified rows only (FR-227) and always state the window covered and its
gaps. Calls on behalf of a schedule, automation, agent or app are checked against its grant.

### Settings, network, diagnostics

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/PATCH` | `/api/v1/settings` | Read/update settings |
| `GET` | `/api/v1/flags` | Feature flags with stage ([`feature-flag.json`](schemas/feature-flag.json), ADR-082) |
| `PATCH` | `/api/v1/flags/:key` | Toggle a `beta` or `experimental` flag; `removed` flags and managed locks are refused |
| `GET/PATCH` | `/api/v1/network` | Transports, endpoints, mDNS and Wake Helpers (M6.5; Network below). The egress policy lives under `/api/v1/egress` (M6) |
| `POST` | `/api/v1/network/setup` | One Network Setup assistant action (M6.5; Network setup below) |
| `POST` | `/api/v1/network/test` | Run every reachability test now (M6.5; Network below) |
| `POST` | `/api/v1/network/rollback` | Revert the last network change, or a named one (M6.5; Network below) |
| `GET` | `/api/v1/diagnostics` | Health snapshot (providers, nodes, MCP servers, sandbox, secrets backend, encryption at rest, warnings, other probes); M6 adds the probes `agents`, `channels`, `egress`, `browser`, `devices` and `spaces`; M6.5 adds `trust`, `network`, `networkSetup`, `relay` and `agentDist` |
| `GET` | `/api/v1/diagnostics/logs?level=&module=&since=&limit=` | Recent log entries from the in-memory ring (5,000), newest first; `level` means that level and above; redacted (FR-118) |
| `GET` | `/api/v1/diagnostics/logs/export` | The same as `application/x-ndjson` |
| `POST` | `/api/v1/diagnostics/test` | Test one component (FR-119) `{component: provider\|mcp\|sandbox\|storage\|update, ref?}`; `ref` is a provider account or MCP server id (all of them when omitted). Returns `{component, ref, status: ok\|warning\|error\|unavailable, detail, checks: [{name, ref, status, detail}], durationMs, testedAt}`; a failing component is a result, not an error. `provider` connects, lists the account's own models and sends one 16-token request held to that account (no fallback); `mcp` reports the connection and the server's last tool list; `sandbox` runs `true` with network off; `storage` writes, reads back and deletes a test file in the data folder, runs a SQLite integrity check and reports free space (`warning` under 1 GB); `update` is `unavailable` (no update channel yet). Each test stops after 30 s. Results are not audited. A bad body is `validation`, an unknown `ref` is `not_found`. M5 keeps the result type in the Hub; a shared type is a follow-up |

### Network (M6.5, `docs/22` §2, §6, §7)

Every route needs a session; none is public (FR-135, FR-138, FR-139). An endpoint is
`EndpointCandidate` `{transport: lan\|mesh\|relay\|direct, url, priority, health: ok\|failing\|unknown,
latencyMs, checkedAt, detail}`; lower `priority` is tried first (LAN 10, the mDNS name 11, LAN
IPv6 12, Mesh 20+, Relay 30+, Direct public 40). The Hub checks each candidate with a real
`GET <url>/api/v1/hello` and advertises only healthy ones of enabled transports, best first
(`docs/22` §2). Nothing is checked or advertised until the listener is bound.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/network` | `NetworkView` `{transports: [{transport, enabled, status: up\|down\|off\|none, endpoints, detail}], advertised, primary, listener: {host, port, protocol}\|null, lan: {mdns: {enabled, running, name}, includeLoopback, includeLinkLocal}, directPublic: {url}, healthCheckSeconds, trust (the trust summary, or null), egress: {mode, href: "/api/v1/egress"}, wakeHelpers: {configured, available: WakeHelperView[], recent: WakeLogView[]}, lastChange}`. `WakeHelperView` `{deviceId, name, status, addresses, subnets, lastSeenAt}`; `recent` is the account's newest 20 wakes `{id, deviceId, deviceName, mac, status: pending\|sent\|failed\|rate_limited, via (helper id, `hub`, or null), viaName, error, createdAt}` |
| `PATCH` | `/api/v1/network` | `{transports?: {lan?, mesh?, relay?, directPublic?}, lan?: {mdns?, mdnsName? (a DNS label or null), includeLoopback?, includeLinkLocal?}, directPublic?: {url (plain http(s), no credentials, query or fragment) \| null}, wakeHelpers? (≤ 50 ids), healthCheckSeconds? (10–3,600)}` → the `NetworkView` plus `change` (null when nothing changed). Written as the `network.*` settings, all or nothing (a failed write puts back what was written; a value managed policy sets is refused as on `PATCH /api/v1/settings`). Refusals: `validation` `{field: transports, reason: no_transport}` (every transport off), `{field: directPublic.url, reason: url_required}` (Direct public on without a URL), `{field: wakeHelpers, reason: unknown_device, ids}`. The switches only change what is advertised; no listener is ever closed, so this cannot lock the owner out. Recorded in the change log (kind `network.settings`), audited as `network.change`; `network.changed` |
| `POST` | `/api/v1/network/test` | Run every reachability test now → `NetworkTestResult` `{checkedAt, transports, advertised, primary}`; concurrent calls share one running check. `capability_missing` `{reason: no_listener}` before the listener is bound |
| `POST` | `/api/v1/network/rollback` | One-click rollback (FR-139) `{changeId?}`: the newest applied change, or the one named → `{change, network}`. Each change kind has an undo handler: `network.settings` (this panel), `trust.mode` (a trust change, through any route) and `network.setup.step` (an applied setup step, undone like `POST /network/setup/runs/:id/rollback {stepId}`). Refusals: `conflict` `{reason: nothing_to_roll_back}`, `{reason: rolled_back}` (already), `{reason: rollback_in_progress}`; `not_found`; `capability_missing` `{reason: no_undo_handler, kind}`. Audited as `network.rollback` (result `failed` with the error when the undo throws); `network.changed` |
| `GET` | `/api/v1/network/diagnostics` | `NetworkDiagnosticsView` `{checkedAt, primary, transports, endpoints (each with uptime24h: {checks, ok}), trust, mesh (the mesh ACL summary), relay (the Relay connector's status), devices: [{deviceId, name, kind, roles, status, lastSeenAt, reachable, relayPaired, endpoints}], events (the transport event log, newest first, 50), changes (newest first, 20), problems (plain sentences, e.g. "LAN: …", "Trust: …")}`. Probe history is kept 7 days, transport events 90 days |

### Network setup (M6.5, `docs/22` §6)

The Network Setup assistant (FR-136). Every route needs a session. Steps that run host commands
need `network.setup.allowSystemChanges` (security setting, off by default); detection and
planning never change anything. Secrets the owner types (`authKey`, `headscale.apiKey`) are
write-only: planning moves them to the vault (`secret://network/setup/<runId>/…`) and views show
`stored`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/network/setup` | One action. `{action: detect}` → `{action, detection: NetworkDetectionView}` (interfaces and their kind, LAN subnets, DNS, each mesh provider's state, peers and routes, ufw, the package manager, the Hub's mesh URLs). `{action: plan, provider: headscale\|tailscale\|netbird\|wireguard, options?}` → 201 `{action, run: NetworkSetupRunView}` (`options`: `controlUrl`, `hostname`, `authKey`, `installClient`, `headscale {user, cliAddress, apiKey, acl}`, `tags`, `magicDns`, `advertiseRoutes`, `exitNode`, `certs: auto\|mesh\|local-ca\|none`, `firewall`, `relay {url}`, `wireguard {interface, address, listenPort, dns, peers}`, `replaceExisting`). `{action: apply, runId, stepId?, consent?: {stepId, description}}` → `{action, run, step}`: applies the next pending step (or `stepId`), checks it with the reachability test and rolls it back automatically when an expected path fails. `{action: verify, runId, stepId?}` → `{action, run, ok, checks}`. A step that fails comes back as a result (step status `failed`, `rolled_back` with `autoRolledBack`, or `rollback_failed`), not as an error |
| `GET` | `/api/v1/network/setup/runs` | The account's runs: `{items: NetworkSetupRunView[]}` `{id, provider, status: planned\|in_progress\|completed\|failed\|rolled_back, options (secrets as `stored`), outputs (public material, e.g. the Hub's WireGuard public key), steps: NetworkSetupStepView[], error, createdAt, updatedAt}`; a step is `{id, runId, index, kind, provider, title, description, commands (argv lists; secrets as `<secret>`), undoCommands, affects, undoAffects, systemChange, status: pending\|applied\|verified\|failed\|rolled_back\|rollback_failed\|manual\|skipped, consent: {required, remembered}, checks, error, autoRolledBack, appliedAt, verifiedAt, rolledBackAt}` |
| `GET` | `/api/v1/network/setup/runs/:id` | One `NetworkSetupRunView` |
| `POST` | `/api/v1/network/setup/runs/:id/rollback` | `{stepId?}`: undo the whole run (every applied step, newest first, and `rollback_failed` ones again), or only its last applied step → the run. Allowed while `network.setup.allowSystemChanges` is off (undo puts back what the owner had; the audit records the setting's value) |
| `GET` | `/api/v1/network/setup/consents` | Remembered consents `{items: [{id, kind, provider, description, grantedAt}]}` |
| `DELETE` | `/api/v1/network/setup/consents/:id` | Revoke one: `{ok: true}`; the next step of that kind and provider asks again |

Refusals: 403 `policy_denied` `{reason: system_changes_disabled, setting}` (a host change with the
setting off) and `{reason: consent_required, stepId, description, changed?}` (send the exact
description back as `consent`; `changed: true` when a remembered consent covered different text);
409 `conflict` `{reason: would_lock_out, transport, affects}` (the step, or its undo, could cut the
path the request came in on and no other path passes its test), `setup_busy`,
`earlier_step_pending`, `not_applicable`, `already_applied`, `nothing_to_apply`,
`rollback_pending` (undoing this step failed: roll it back again first), `not_applied`,
`not_last_step`, `nothing_to_roll_back`, `mesh_in_use` (already joined elsewhere: set
`replaceExisting`); 400 `validation` `{reason: control_url_required\|auth_key_required\|headscale_unavailable\|api_key_required\|wireguard_options_required\|mesh_certs_unavailable}`.
Audited (kind `network`): `network.setup.consent` (`granted` or `revoked`), `network.setup.apply`
(also when denied), `network.setup.rollback` (actor `system` when automatic; result
`rollback_failed` when an undo failed); `network.setup.step`.

### Trust (M6.5, `docs/22` §5)

The Hub identity, the Hub local CA, the Hub's TLS certificate and mesh certificates (FR-134).
Owner routes need a session; the three public routes are in the table at the top of §1.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/trust` | `TrustView` `{mode: none\|local-ca\|mesh, meshCerts, pinNativeShells, hubFingerprint, hubPublicKey (both null while the identity cannot load), serving: {scheme, source: explicit\|trust\|none, fallbackReason}\|null, restartRequired, ca: {fingerprint (SHA-256 of the DER, upper-case hex with colons), subject, notBefore, notAfter, nameConstraints: {dns, ip}}\|null, leaf: {serial, sans, notBefore, notAfter, renewAt}\|null, meshCert: {host, notAfter, status: ok\|expiring\|expired}\|null, issued (newest 200 certificates), problems}` |
| `PATCH` | `/api/v1/trust` | `{mode?, meshCerts?, pinNativeShells?}` (at least one) → `TrustView`. Written as the `trust.*` settings; a value managed policy sets is refused with `policy_denied` `{reason: managed}` and the write rolled back. Switching between HTTP and HTTPS applies at the next start (`restartRequired`); choosing `local-ca` creates the CA and its certificate at once, so devices can install the root first. A change through this route or `PATCH /api/v1/settings` is audited as `trust.change`, recorded in the change log (kind `trust.mode`) and emits `trust.changed` |
| `POST` | `/api/v1/trust/renew` | `{target: leaf\|mesh\|all\|ca}` (default `all`) → `TrustView`. `all` renews the Hub certificate and the mesh certificates; `ca` replaces the local CA (the owner's explicit choice, never part of `all`: every device must install the new root and device certificates of the old CA stop verifying). Refusals: `conflict` `{reason: trust_off\|no_local_ca\|no_mesh_cert}`; `capability_missing` `{reason: no_mesh_cert_source}` |
| `GET` | `/api/v1/trust/ca.pem`, `/api/v1/trust/ca.crt` | Public. The local CA's root certificate as PEM (`application/x-pem-file`) or DER (`application/x-x509-ca-cert`, which phones open to install), as an attachment; 404 unless the mode is `local-ca` |
| `GET` | `/api/v1/trust/identity?nonce=` | Public, `Cache-Control: no-store`. `nonce`: 16–64 base64url characters (else `validation`). → `HubIdentityStatement` `{v: 1, nonce, hubFingerprint, hubPublicKey, pinning: required\|off, certificates: [{kind: ca\|leaf\|mesh, sha256 (hex of the DER), notAfter}], issuedAt, signature}`: the signature (base64url Ed25519 by the Hub identity) covers `nova-hub-identity-v1\n` followed by the canonical JSON of the other fields (`hubIdentityStatementBytes` in `@nova/shared`). While the identity cannot load: 409 `conflict` `{reason: identity_missing\|identity_mismatch\|identity_unavailable}` |

### Relay (M6.5, `docs/22` §3, `rest-api.md` §3)

The Hub's connector to a content-blind Relay (FR-137). Every route needs a session. The settings
are `relay.enabled`, `relay.url` and `relay.selfHosted` (security settings); a change through
these routes or `PATCH /api/v1/settings` applies at once. Requests a paired client tunnels through
the Relay are dispatched into the Hub's own `/api/v1` routes (not `/api/v1/ws`) and authenticate
by the client's own `Authorization` header, like direct requests; the Relay's route token never
authorizes anything here.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/relay` | `RelayConfigView` `{enabled, url, selfHosted, effectiveUrl (the URL, or the hosted Relay `wss://relay.arialabs.ai` when not self-hosted and no URL is set), status: {state: disabled\|unconfigured\|registering\|connecting\|connected\|error, detail, url, routeId, since, latencyMs}, clients: {active, pending}}` |
| `PATCH` | `/api/v1/relay` | `{enabled?, url?, selfHosted?}` → `RelayConfigView`. The URL is written before `enabled`, so turning the Relay on in the same change never sees the old URL. `url` is `wss://` or `https://` (`ws://` or `http://` only to this machine), without credentials, query or fragment, or `''`. A value managed policy sets is `policy_denied` `{reason: managed}`. Audited as `relay.change` |
| `POST` | `/api/v1/relay/test` | `RelayTestView` `{ok, url, reachable, latencyMs, version, state, detail}`: the Relay's `GET /v1/relay/health` and the connection's state |
| `GET` | `/api/v1/relay/clients` | Paired clients, newest first: `{items: RelayPairedClientView[]}` `{id (the relay client id), deviceId, requestId, name, platform, kind: browser\|native, status: pending\|active\|denied\|expired\|revoked, routeId, relayUrl, createdAt, lastSeenAt, revokedAt}` |
| `POST` | `/api/v1/relay/clients/:id/revoke` | `{ok: true, client}`: the Relay stops routing it (its open connections close with `revoked`; a Relay that cannot be reached is told when the Hub next connects), the Hub drops its envelopes, its key stays refused for new pairings and its device is revoked (`POST /devices/:id/revoke`). A device revoked anywhere else loses its Relay client too. `not_found` for an unknown client. Audited as `relay.revoke`; `relay.client.revoked` |
| `PUT` | `/api/v1/relay/registration-token` | The bearer token a private Relay asks for when a Hub registers (services/relay `NOVA_RELAY_REGISTRATION_TOKEN`; M7) `{token (8–512 printable characters without spaces) \| null}` → `RelayConfigView` plus `registrationToken: boolean`. The token is for the Relay in use: it goes to the vault at `secret://relay/registration/token` together with the current `relay.url` and is never answered back, and the connector sends it only to that same Relay (after a change of `relay.url` it is not sent, and the status says which Relay it was set for). With no Relay URL set, a token is refused with 409 `conflict`, `details.reason` `relay_url_missing`; `relay.registrationTokenRef` names the entry (it accepts only `secret://relay/registration/…`, so it can never name another secret) and the connector sends it only when it registers, again at once if a registration was refused. `null` removes it. Audited as `relay.registrationToken.set` / `.clear` (kind `network`). `GET` and `PATCH /api/v1/relay` also answer `registrationToken` |

Pairing through the Relay is Add Device with `transport: relay` (Auth & devices above): the claim
reaches the Hub as a pending Add Device request (v1 confirmation), and the owner's decision
confirms or drops the client's route. Pairing outcomes are audited as `relay.pair` with decision
`approved`, `denied`, `expired` or `refused`; a refusal's reason is `expired`, `bad_claim`,
`client_conflict`, `revoked_key`, `add_device_unavailable` or `add_device_refused`.

Since M7 the Hub also asks the Relay to push notifications to paired native clients
(`POST /v1/relay/push/notify`, `rest-api.md` §3; Push below).

### Sync (M7, `docs/13` §2, `rest-api.md` §2)

The Hub is canonical and plays the sync service (decision 1 of ADR-095; shapes in
`packages/shared/src/m7/sync.ts`). A client whose device session has the `offline-replica` scope
keeps a local replica: it loads a paged snapshot, then follows the change feed from the first
page's `feedCursor`, and pushes field ops that the Hub merges per field, last writer wins by hybrid
logical clock (ADR-010). Every route needs a session (401 without one; a revoked device's sessions
are gone, so its calls get 401). The replica routes (snapshot, changes, push) need a device session
with `offline-replica` (403 `policy_denied` `{reason: replica_not_granted}`) and `sync.enabled`
(403 `policy_denied` `{reason: sync_disabled}`); the merge log and restore need `sync.enabled`;
the replica list and reset take any session of the account.

- **Kinds and fields** (`SYNC_FIELDS`): `thread` (write `title`, `pinned`, `archived`, `project`;
  read `mode`, `createdAt`), `message` (one immutable `body`), `project` (`name`, `instructions`),
  `memory` (`content`, `status`; read `scope`, `category`, `createdAt`), `space` (`name`), `page`
  (`title`, `content`; read `space`, `version`, `createdAt`), `schedule` (`enabled`; read `title`)
  and `setting` (`value`; the owner's non-security global settings only). Replicas may create only
  `thread` and `message` (with their own UUIDs) and delete (field `_deleted`, value `true`) only
  `thread`, `project`, `memory` and `page`.
- **Clock values** are `<15-digit ms>-<4 hex>-<node>` (`001760000000000-0000-hub`); a pushed clock's
  node must be the pushing device.
- **A message body** is `{threadId, role: user, text (≤ 100,000), parentId?}` (written offline;
  no turn starts) or, from a device with the `local-runtime` scope, `{threadId, role: assistant,
  text (≤ 500,000), parentId (in the thread), model, provenance: offline}` (its local model's answer,
  FR-128). Its `created_at` is the Hub's receipt time. `chat.message.created` follows with
  `turnId: null` and `provenance: sync` (user) or `offline` (assistant).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/sync/snapshot?kind=&cursor=&limit=` | One page of the current state, kind by kind (`limit` 1–500, default 200): `SyncSnapshotView` `{kind, items: [{kind, id, fields: {<field>: {value, hlc, deviceId}}}], nextCursor (the next page, of this kind or the next; null after the last), feedCursor}`. A first page (no `cursor`) clears a reset. A cursor of another kind or a bad one is `validation` |
| `GET` | `/api/v1/sync/changes?since=&limit=` | The change feed after `since`, oldest first (`limit` 1–1,000, default 500): `SyncChangesView` `{changes: [{cursor, kind, id, field, value, hlc, deviceId}], cursor (pass as `since`), more}`; one row per field, current values only; deletes are `_deleted` tombstones. 409 `conflict` `{reason: replica_reset}` after the owner reset this replica, or `{reason: cursor_ahead, cursor}`: load a snapshot again |
| `POST` | `/api/v1/sync/push` | `{deviceId, ops: [{kind, id, field, value, hlc, base?}] (1–500)}` → `SyncPushResult` `{results: [{index, kind, id, field, status: accepted\|overwritten\|rejected, reason?, entryId?, hlc?, value?}], cursor, hlc (the Hub's clock now)}`. `deviceId` must be the session's device (403 `policy_denied` `{reason: device_mismatch}`). `base` is the clock the device's edit started from. `overwritten`: a newer value won (the op's value is in the merge log with `entryId` when it differed; `value` is the winner). Rejection reasons: `unknown_field`, `read_only_field`, `invalid_value`, `not_deletable`, `not_syncable` (a security or unknown setting), `local_runtime_not_granted`, `invalid_hlc`, `hlc_device_mismatch`, `clock_skew` (more than `sync.maxSkewSeconds`, default 300, ahead), `not_found` (another account's entity, or a kind that must exist), `deleted`, `append_only` (a message pushed again with another clock), `invalid_id`, `not_supported`, `apply_failed`. A delete wins only if it is newer than every field. Replays a repeated `Idempotency-Key` |
| `GET` | `/api/v1/sync/merge-log?status=open\|restored\|all&limit=&before=` | Overwritten values (FR-109), newest first (`limit` ≤ 500, default 100): `{items: SyncMergeEntryView[]}` `{id, kind, entityId, field, reason: concurrent\|stale\|restore, lost: {value, hlc, deviceId, deviceName}, winner: {…}, status: open\|restored, createdAt, restoredAt}`. Kept `sync.mergeLogDays` (90); a tombstone removes its entity's entries |
| `POST` | `/api/v1/sync/merge-log/:id/restore` | Write the lost value back as a new change with a fresh Hub clock (every replica takes it); the value it replaces goes to the merge log as `restore`. Returns the entry. 409 `conflict` `{reason: already_restored}`, `{reason: deleted}` (the entity is gone), `{reason: not_supported}`; `validation` `{reason: invalid_value}`. `sync.conflict` is not re-sent. Audited as `sync.restore` (kind `device`) |
| `GET` | `/api/v1/sync/devices` | The account's replicas: `{items: SyncReplicaView[]}` `{deviceId, name, platform, granted (has `offline-replica` now), revoked, status: synced\|pending\|offline\|error, cursor, behind, lastPullAt, lastPushAt, lastError, resetAt}`; `offline` after `sync.offlineAfterMinutes` (10) without a pull or push |
| `POST` | `/api/v1/sync/devices/:id/reset` | Make a replica load a snapshot again: its next `changes` answers `replica_reset` until it loads the first page. Returns `SyncReplicaView`; `sync.replica.reset`; audited as `sync.replica.reset` (kind `device`) |

Losing the scope (`device.scopes.changed` without `offline-replica`) or the device
(`device.status.changed` `revoked`) emits `sync.replica.revoked` `{deviceId, reason: scope_removed\|revoked}`:
the device must wipe its copy. Answering a message written offline is
`POST /api/v1/threads/:id/messages/:mid/answer` (Chat above). `sync.status.changed` is not emitted.

### Cloud runner (M7, `docs/13` §3, `docs/10` §12, `rest-api.md` §5)

The Hub's side of the cloud runner (FR-108, FR-071, FR-116; decision 4 of ADR-095; shapes in
`packages/shared/src/m7/runner.ts`). Every route needs a session and is owner-only (Members
above); none is public. Cloud environments are saved environments of kind `cloud`, created,
changed and removed through `/api/v1/environments` (Code above); a Code session on one, or a Work
run started below, runs its commands and files on the runner. Refusals: `capability_missing`
`{reason: runner_disabled}` while `cloud.runner.enabled` is off, `validation`
`{reason: runner_unconfigured}` without a URL or token, `node_unavailable`
`{reason: runner_unreachable}`, `auth_missing` `{reason: runner_token}` (the runner refused the token), `budget_exhausted` `{reason: cap_reached}` (the runner's `quota_exceeded` at a cap).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/cloud/runner` | `CloudRunnerView` `{enabled, url, hasToken, state: disabled\|unconfigured\|unknown\|ok\|error, detail, version, substrate: {kind, ok, detail}\|null, checkedAt, caps: {cpuSeconds, wallSeconds, diskMb, warnAt}}`; the token is never returned |
| `PUT` | `/api/v1/cloud/runner` | Register or change the runner `{url (https://, or http:// only to this machine; no credentials, query or fragment), token? (`nvrun_…`, as `nova-runner token add` prints it), enabled?}`: the token goes to the vault (`secret://cloud/runner/token`, `cloud.runner.token` holds only that reference) and the runner is tested. Returns `CloudRunnerView`; `cloud.runner.updated`; audited as `cloud.runner.change` (kind `settings`). A setting locked by managed policy is `policy_denied` `{reason: managed}` |
| `PATCH` | `/api/v1/cloud/runner` | `{enabled}` → `CloudRunnerView`; turning it on without a URL and token is `validation` `{reason: runner_unconfigured}` |
| `POST` | `/api/v1/cloud/runner/test` | Reach the runner now: `CloudRunnerTestView` `{ok, latencyMs, version, substrate, detail}`. A reachable runner also deletes environments no saved environment refers to any more (skipping ones still being created or younger than 10 minutes) |
| `DELETE` | `/api/v1/cloud/runner` | Forget the runner: token out of the vault, settings cleared, off. `{ok: true}`; audited as `cloud.runner.remove` |
| `GET` | `/api/v1/cloud/environments[/:id]` | `{items: CloudEnvironmentView[]}` / one: `{id (the saved environment's), label, status, detail, connection: CloudConnectionView, runner: {status: provisioning\|ready\|failed\|deleting, detail, substrate, repos: [{name, path, ref, head}], caches, setup: {status: none\|running\|ok\|failed, exitCode, log (redacted tail), startedAt, endedAt}, usage: {diskBytes}, caps: {diskBytes}, runs: {active}, processes: {running}, readyAt}\|null (null while the runner cannot be reached), sessions, createdAt, updatedAt}` |
| `POST` | `/api/v1/cloud/environments/:id/rebuild` | Clone again and run the setup script once more (caches are kept): 202 `CloudEnvironmentView`; `environment.updated` `{change: rebuilding}`; audited as `cloud.environment.rebuild` |
| `GET` | `/api/v1/cloud/environments/:id/files?path=` | A file or folder of the workdir (FR-108): `CloudFileView` `{kind: dir, path, entries: [{name, kind: file\|dir\|link\|other, size}], truncated}` or `{kind: file, path, size, text (UTF-8, null for binary), truncated}` |
| `GET/POST` | `/api/v1/cloud/environments/:id/snapshots` | `{items: CloudSnapshotView[]}` / take one `{label?}` (201) `{id, environmentId, label, reason: manual\|run_start\|before_restore, sizeBytes, createdAt, restoredAt}`; `cloud.snapshot.created`; audited as `cloud.snapshot.create`. Snapshots are tar files inside the environment's folder on the runner |
| `POST` | `/api/v1/cloud/snapshots/:id/restore` | `{keepCurrent?}` (take a `before_restore` snapshot first) → `CloudSnapshotView`; `cloud.snapshot.restored`; audited as `cloud.snapshot.restore` |
| `DELETE` | `/api/v1/cloud/snapshots/:id` | `{ok: true}`; `cloud.snapshot.deleted`; audited as `cloud.snapshot.delete` |
| `GET` | `/api/v1/cloud/runs?environmentId=&threadId=&status=active\|all` | Leases with their metering (FR-116): `{items: CloudRunView[]}` `{id, environmentId, threadId, kind: code\|work\|system, workRunId, sessionId (a Code session's lease), status: active\|completed\|cancelled\|capped\|failed\|lost, reason, caps: {cpuSeconds, wallSeconds}, usage: {cpuSeconds, wallSeconds, commands}, warnings, createdAt, updatedAt, endedAt}`. One lease per thread; the Hub's own Git and file calls use a separate per-environment lease (`system`). Wall time counts only while a command runs |
| `GET` | `/api/v1/cloud/runs/:id` | One `CloudRunView` |
| `PATCH` | `/api/v1/cloud/runs/:id` | New caps `{cpuSeconds?, wallSeconds?}` (60 s to 7 days; at least one); a capped run with room again is active. Audited as `cloud.run.caps` |
| `POST` | `/api/v1/cloud/runs/:id/cancel` | Stop its commands and end the lease; `cloud.run.ended`; audited as `cloud.run.cancel` |
| `POST` | `/api/v1/cloud/runs/:id/artifacts` | Keep a file of the workdir in the thread `{path, title?}` → 201 `ArtifactView`; files over 5 MiB are refused before hashing. Audited as `cloud.artifact.import` |
| `POST` | `/api/v1/cloud/work` | Start a Work run on a cloud environment `{environmentId, objective (≤ 8,000), title?, projectId?, autonomy?, budgets?, model?, caps? {cpuSeconds?, wallSeconds?}, snapshot? (default true: a `run_start` snapshot first)}` → 201 `CloudWorkView` `{runId, threadId, environmentId, cloudRun, snapshot}`. The run is created waiting, bound to the environment, then started, so its first command goes to the runner; it carries the user's authority like `POST /runs`. An autonomous run without `review.model` is `validation` `{reason: review_model_required}`. Audited as `cloud.work.start` |

In a cloud thread the Hub's own `fs.*` tools are denied (so hidden); commands, Git and files go to
the runner. (In SSH, WSL and device threads the `fs.*` tools reach the folder on that machine
instead; `fs.search`, `document.read` and `document.create` are denied there, `docs/10` §2.) Network is off for every cloud command unless `cloud.runner.unrestrictedNetwork` is on
and the turn's own network mode is not `off` (runner network does not pass the Hub's egress proxy).
A path the runner reports outside `/workspace` is refused (`validation` `{reason: runner_path}`).
The Hub reads at most 96 MiB per runner answer and 1 MiB per event-stream event.

### Push (M7, `docs/13` §6)

Web Push for browsers and the PWA (FR-111; RFC 8291 encryption and RFC 8292 VAPID on
`node:crypto`). Every route needs a session; a device session's subscription is tied to its
device. Native apps register their APNs or FCM token with the Relay themselves (`rest-api.md` §3);
the Hub asks the Relay to push to them. Pushes follow the OS leg of notification routing (FR-060):
the rule's `os` flag and quiet hours (suppressed, not deferred). A push carries only
`{v: 1, id, category, title, path, link, at}` (`PushPayload`): the title per `push.detail`
(`none`: "Nova"; `redacted` (default): a fixed title per category; `titles`: the notification
title, encrypted to the browser); native pushes always get the redacted title. `path` is the web
route and `link` the `nova://` deep link (decision 7). Nothing is pushed while `push.enabled` is
off.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/push/vapid-key` | `{publicKey}`: the Hub's VAPID application server key (uncompressed P-256, base64url), made on first use (audited as `push.vapid.create`) |
| `GET` | `/api/v1/push/subscriptions` | The account's browser subscriptions: `{items: PushSubscriptionView[]}` `{id, kind: webpush, endpointOrigin (the full endpoint is a capability and is never returned), label, deviceId, status: active\|failing\|gone, lastSuccessAt, lastError, createdAt, updatedAt}` |
| `POST` | `/api/v1/push/subscriptions` | Add or renew one: the browser's `PushSubscription.toJSON()` `{endpoint, expirationTime?, keys: {p256dh, auth}, label?}` → 201 `PushSubscriptionView`. The endpoint must be https on the `push.webPushHosts` allowlist (`validation` otherwise). Audited as `push.subscribe` |
| `DELETE` | `/api/v1/push/subscriptions/:id` | `{ok: true}`; audited as `push.unsubscribe`. A subscription the push service reports gone is dropped (`push.subscription.gone`) |
| `POST` | `/api/v1/push/test` | `{subscriptionId?}` → `PushTestView` `{sent, failed, results: [{subscriptionId, status: sent\|failed\|gone, detail}]}`; audited as `push.test` |

### Team: members, OIDC, profile cards, shared threads, team agents (M7, `docs/13` §7)

Several people on one Hub (decision 5 of ADR-095; FR-217, FR-091, FR-113; shapes in
`packages/shared/src/m7/team.ts`). Every route needs a session except the public ones in §1. The
owner-only checks of this area are in its services: a non-owner gets 403 `policy_denied`
`{reason: owner_only}`. An account that is neither the owner nor a member (a team agent's identity)
gets `not_found` ("no such person on this Hub") on the person routes.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/team/me` | `TeamMeView` `{accountId, displayName, username, role: owner\|member, hasAvatar, identities: OidcIdentityView[]}` |
| `GET` | `/api/v1/team/members` | Everyone on the Hub (any person): `{items: TeamMemberView[]}` `{…person, joinedAt, invitedBy, you}` |
| `DELETE` | `/api/v1/team/members/:id` | Remove a member (owner) → `{sessionsEnded}`. Their sessions end at once and their open sockets and event streams close; their schedules, triggers, channel bindings and MCP servers are disabled, their MCP event and push subscriptions end and their agents stop; the account is closed (turns, runs, triggers and sign-ins answer `account_closed`). Their data is kept. `team.member.removed`; audited as `team.member.remove` (kind `auth`) |
| `GET/POST` | `/api/v1/team/invitations` | Invitations (owner), newest first, at most 200: `{items: InvitationView[]}` `{id, label, status: pending\|redeemed\|expired\|revoked, createdAt, expiresAt, redeemedAt, redeemedBy}` / create `{label?, ttlHours? (1–720; default `team.invitationHours`, 72)}` → 201 `{invitation, token, url}`, `no-store`: a one-use token (256 bits; only its hash is stored) shown once, carried in the link's fragment (`/join#invite=<token>`). `team.invitation.created`; audited as `team.invite` |
| `DELETE` | `/api/v1/team/invitations/:id` | Withdraw a pending invitation (owner) → `InvitationView`; `team.invitation.revoked`; audited as `team.invite.revoke` |
| `POST` | `/api/v1/team/join/preview` | Public. `{token}` → `JoinPreviewView` `{valid, label, invitedBy, expiresAt, providers: [{id, label}]}` (`no-store`); an unusable token answers `valid: false`, nothing more |
| `POST` | `/api/v1/team/join` | Public. `{token, displayName (1–100)}` → 201 `{accountId, role: member}` with the session cookie (`no-store`). The token is burned in the same transaction that creates the account. An invalid, used or expired token is 401 `auth_missing` `{reason: invitation_invalid}`. `team.member.joined`; audited as `team.join` |
| `GET/PATCH` | `/api/v1/team/me/settings` | A member's own preferences: `{settings}` / `{key, value}`: only keys under `appearance.`, `keyboard.` and `onboarding.`; any other key is `policy_denied` `{reason: owner_only}`. `settings.changed` with `scope: member` |
| `GET/PUT` | `/api/v1/team/me/card` | The public profile card (FR-113): `ProfileCardView` `{allowed (`team.publicProfiles`), enabled, handle, showAvatar, path}` / `{enabled, handle (3–40, `^[a-z0-9][a-z0-9_-]{2,39}$`), showAvatar?}`; off by default; `policy_denied` `{reason: setting_off}` while the owner's switch is off; a taken handle is `conflict`. Audited as `profile.card` |
| `GET` | `/api/v1/profiles/:handle`, `/api/v1/profiles/:handle/avatar` | Public. `PublicProfileView` `{handle, displayName, avatarPath}` (`Cache-Control: public, max-age=60`) / the avatar (`default-src 'none'; sandbox`); 404 unless the person published the card while `team.publicProfiles` is on |
| `GET/POST` | `/api/v1/team/oidc` | OIDC providers (owner): `{items: OidcProviderView[]}` `{id, label, issuer, clientId, hasClientSecret, scopes, enabled, redirectPath, createdAt, updatedAt}` / create `{label, issuer (https://, http:// only on this machine; no credentials, query or fragment), clientId, clientSecret? (to the vault, never returned), scopes? (must include `openid`), enabled?}` (201). Audited as `oidc.provider.create` |
| `PATCH/DELETE` | `/api/v1/team/oidc/:id` | Change (`clientSecret: null` removes it) / remove (owner). Audited as `oidc.provider.update` / `.delete` |
| `POST` | `/api/v1/team/oidc/:id/test` | Discovery and the key set from the Hub, with the same address rules as a sign-in, also for a provider that is off (owner): `{ok, detail}`. Audited as `oidc.provider.test` |
| `DELETE` | `/api/v1/team/me/identities/:id` | Unlink one of the caller's own identities; audited as `oidc.unlink` |
| `GET` | `/api/v1/auth/oidc/providers` | Public. `{items: [{id, label}]}`: enabled providers only |
| `POST` | `/api/v1/auth/oidc/start` | `{providerId, flow: sign_in\|join\|link (default sign_in), invitation? (required for join), displayName?}` → `{url (the provider's authorization URL), expiresAt}` (`no-store`) and the `nova_oidc_binding` cookie (HttpOnly, SameSite=Lax, path the callback, 600 s; its SHA-256 is kept with the pending sign-in). `link` needs a session; `join` a usable invitation (401 `auth_missing` `{reason: invitation_invalid}`). Code flow with PKCE (S256), a nonce, `client_secret_basic`. Pending sign-ins: at most 10 per address and 1,000 in all (429 `rate_limited` `{reason: oidc_busy}`) |
| `GET` | `/api/v1/auth/oidc/callback?state=&code=&error=` | Public; always a 302 (`no-store`). The state is single use and lives 10 minutes; the binding cookie must match in constant time (else `browser_mismatch`); the ID token is checked with `node:crypto` (RS, PS, ES and EdDSA; `none` and HS refused; RSA ≥ 2048 bits; EC curves matching the algorithm), issuer, audience/azp, expiry, nbf/iat and nonce; the key set is read again once for an unknown key id. Success: `sign_in` and `join` set the session cookie and go to `/`; `link` goes to `/settings/account?oidc=linked`. A refusal goes to `/settings/account?oidc_error=<reason>` for a link and `/sign-in?oidc_error=<reason>` otherwise; reasons include `state_invalid`, `browser_mismatch`, `provider_error`, `provider_disabled`, `invitation_invalid`, `account_closed`, `not_linked` (no sign-up without an invitation), `identity_taken`, `already_linked`. Audited as `oidc.sign_in`, `oidc.link` or `oidc.refused` |
| `GET` | `/api/v1/team/threads` | Shared threads the caller owns or takes part in: `{items: SharedThreadView[]}` `{thread, owner, participants, you: owner\|participant, sharedAt}` |
| `GET` | `/api/v1/team/threads/:id` | `SharedThreadDetailView`: the view plus `messages` and `authors` (by message id: `{accountId, displayName, as: wrote\|asked}`); 404 for someone who cannot see it |
| `POST` | `/api/v1/team/threads/:id/share` | Share one of the caller's own threads `{accountIds (1–50)}` → `SharedThreadView`. Only a plain chat outside a project (`validation` `{reason: not_shareable}`); accounts that are not people of the Hub are `validation` `{reason: not_a_person}`. `thread.shared` `{threadId, ownerAccountId, participants}`; audited as `thread.share` |
| `DELETE` | `/api/v1/team/threads/:id/share/:accountId` | The owner takes someone out, or a participant leaves (anyone else: `policy_denied` `{reason: owner_only}`); audited as `thread.unshare` |
| `POST` | `/api/v1/team/threads/:id/messages` | Send in a shared thread (body as `POST /threads/:id/messages`, ≤ 30 MB) → 202. The turn runs under the account that wrote (its providers, policy, approvals and audit); if the thread's model is another person's provider account, the writer's default model answers. Only built-in tools are offered: web search, artifact, document, visualization and image creation, `tool.search`, `context.remaining`, `context.fresh`. Nobody's memory, past chats, skills, instructions, app context or project joins, and nothing said there becomes memory. Editing and regenerating are refused (`validation` `{reason: shared_thread}`) |
| `POST` | `/api/v1/team/threads/:id/cancel` | Any participant may stop the running turn (`{ok, cancelled}`); nobody can cancel another person's queued message |
| `GET` | `/api/v1/team/threads/:id/stream` | SSE of the thread's events for its participants, with `Last-Event-ID`/`?after=` replay; access is checked on every event, so someone taken out stops hearing it |
| `GET/POST` | `/api/v1/team/agents` | Team agents (FR-091): `{items: TeamAgentView[]}` (any person) `{agentId, identityAccountId, name, status, autonomy, createdBy, createdAt, credentials}` / provision one (owner) `{name, instructions?, responsibilities? (≤ 20), autonomy?, model?}` (201): an agent in its own identity account, which never signs in; proactive research starts off. Audited as `team_agent.provision` (kind `agent`) |
| `GET/DELETE` | `/api/v1/team/agents/:id` | One `TeamAgentView` / remove it (owner; audited as `team_agent.remove`) |
| `POST` | `/api/v1/team/agents/:id/credentials` | Bind a credential to the agent's identity (owner) `{kind: provider, provider, label, baseUrl?, apiKey?}` or `{kind: egress, label, hosts (1–50), scheme, header?, username?, value}` → 201 `TeamAgentCredentialView` `{id, kind, label, refId, secretRef, createdAt}`: values go to the vault; only `secret://` references are kept; egress credentials are scoped to the agent. Audited as `team_agent.credential.add` |
| `DELETE` | `/api/v1/team/agents/:id/credentials/:credentialId` | Owner; audited as `team_agent.credential.remove` |
| `GET/POST` | `/api/v1/team/agents/:id/tasks` | Tasks (the owner sees all, others their own): `{items: TeamTaskView[]}` / give it a task (any person) `{text (≤ 8,000)}` → 202 `TeamTaskView` `{id, agentId, requestedBy, text, status: queued\|running\|done\|failed\|cancelled, result, error, threadId, turnId, createdAt, startedAt, endedAt}`. Each task runs in a shared thread of its own, labelled with the requesting account and its role, under the agent's identity with the requester's authority (`team-task:<id>`); the audit actor is `agent:<id>`. `team.task.updated` goes to the requester at `running` and at the end. Audited as `team_task.start` / `.end` |
| `GET` | `/api/v1/team/tasks?agentId=`, `/api/v1/team/tasks/:id` | The caller's tasks (the owner: all) / one (`not_found` for someone else's) |
| `POST` | `/api/v1/team/tasks/:id/cancel` | Cancel a task; only the thread that task alone uses is cancelled |
| `GET` | `/api/v1/team/agents/:id/audit?kind=&cursor=&limit=` | The agent's audit entries (owner) |
| `GET` | `/api/v1/team/agents/:id/approvals` | The agent's pending approvals (owner): `{items: ApprovalView[]}` |
| `POST` | `/api/v1/team/agents/:id/approvals/:approvalId` | The owner answers one (`ApprovalDecision` without `approvalId`); an answered one is `conflict` |
| `GET/PUT` | `/api/v1/agents/:id/plugins` | Plugins connected to one of the caller's agents (FR-045): `{agentId, pluginIds}` / `{pluginIds: [..] \| null}` (`null`: every plugin the account enabled, the default); the tools of plugins not connected are blocked at the gate for that agent and its delegated Code sessions (built-in tools and MCP servers no plugin installed stay usable). Audited as `agent.plugins` |

A team agent's events (its approvals included) are also copied to the owner's account with
`payload.teamAgent: {agentId, identityAccountId}`.

### Scripts and external agents (M7, flagged, `docs/08`)

Both features are off by default (`scripts.enabled`, `externalAgents.enabled`; FR-202, FR-203;
shapes in `packages/shared/src/m7/flagged.ts`). Every route needs a session; the adapter and
delegation routes are owner-only (Members above). While a flag is off its routes answer 404
`not_found`, except reading and cancelling a delegation, which always work (turning the flag off
stops running delegations).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/scripts/runs?threadId=&limit=&cursor=` | The account's `script.run` calls, newest first, or one thread's (`limit` ≤ 200, default 100; `cursor` the previous page's `nextCursor`; runs of deleted threads left out): `{items, nextCursor}` of `ScriptRunView` without `nested` `{id (the tool call's), threadId, turnId, status: running\|ok\|error\|cancelled, errorCode (`cpu_limit`, `memory_limit`, `stack_limit`, `syntax_error`, `script_error`, …), calls, cpuMs, codeSha256 (the code is kept only as a hash), createdAt, endedAt}` |
| `GET` | `/api/v1/scripts/runs/:id` | One `ScriptRunView` with `nested: [{callId, tool, status, decision, approvalId, createdAt, durationMs}]` (each nested call is a tool call of its own whose `parent_call_id` is the script's) |
| `GET/POST` | `/api/v1/agent-adapters` | External agent adapters: `{items: AgentAdapterView[]}` / add one `{name (≤ 64), command (a program name or path, no shell syntax), args? (≤ 50), env? (values are `secret://agent-adapter/<id>/…` references or secrets to store there), network? (≤ 20 host patterns the agent may reach), permissionRouting: client, enabled?}` → 201 `AgentAdapterView` `{id, name, command, args, env (names to references), network, permissionRouting, enabled, lastCheck: {ok, at, agent: {name, version}, protocolVersion, reason}\|null, createdAt, updatedAt}`. `permissionRouting: agent` is `validation` `{reason: permission_routing}`; a reference outside the adapter's own prefix is `validation` `{reason: foreign_secret, field: env.<name>}`. Audited as `agent_adapter.create` (kind `code`) |
| `GET/PATCH/DELETE` | `/api/v1/agent-adapters/:id` | One / change `{name?, args?, env? (replaces it; an empty value keeps a saved secret), network?, enabled?}` / remove. Audited as `agent_adapter.update` / `.delete` |
| `POST` | `/api/v1/agent-adapters/:id/check` | Start the agent in that Code session's sandbox and run the handshake only `{sessionId}` → `AgentAdapterView` with `lastCheck`; the agent's name and version are redacted and clipped. A sandbox with no substrate is `{reason: no_substrate}`; network on a sandbox the egress proxy cannot enforce (a cloud runner) is `{reason: no_egress_proxy}`. Audited as `agent_adapter.check` |
| `GET/POST` | `/api/v1/code/sessions/:id/delegations` | A Code session's delegations: `{items: DelegationView[]}` / delegate `{adapterId, prompt (≤ 20,000)}` → 202 `DelegationView` `{id, threadId, adapterId, adapterName, status: starting\|running\|completed\|failed\|cancelled, prompt, output (redacted, capped), stopReason, error, agent, permissionRequests, operations, createdAt, endedAt}`. The agent runs in the session's own sandbox (the session folder read-only, network only to the adapter's hosts); every file read, write and command it asks for runs as an `fs.*` or `exec.*` call through the gate; Nova never picks the agent's `allow_always`. `delegation.started`, `delegation.updated`, `delegation.finished`; audited as `delegation.start`, `.permission`, `.finish` |
| `GET` | `/api/v1/delegations/:id` | One `DelegationView` |
| `POST` | `/api/v1/delegations/:id/cancel` | Stop it (the agent gets a grace period to end its turn; its terminals are killed at once); audited as `delegation.cancel` |

## 2. Hub ↔ Compute Node

Internal, authenticated (mTLS over Mesh or LAN). The Hub authorizes every job; nodes never
initiate to clients.

Until certificates arrive with the Mesh (M6.5), a node authenticates with bearer tokens over
LAN HTTP (ADR-089): it registers with a one-use enrollment token, an Ed25519 public key and a
capability document ([`device-capability.json`](schemas/device-capability.json)) signed with
that key; the Hub pins the key, returns a node credential (`nvn_…`, stored hashed) for
heartbeats and model sync, and keeps the node's job token (generated by the node) in the
secret vault to call the node's job API. Every re-sent capability document must verify against
the pinned key. Heartbeats every 10 s; three missed beats mark the node `unreachable`.

*As built in M6.5* (ADR-094): still bearer tokens over LAN or Mesh HTTP. A node joins with Add
Device (`nova-compute enroll --code`, §1) or with a token from `POST /api/v1/devices/compute/enroll`.
A token Add Device granted is bound to the node's key and to the pending device record its
approval created: `/node/v1/register` must present that key (else `policy_denied` `{reason:
key_mismatch}`) and activates that record, keeping the name the owner approved (`conflict`
`{reason: device_not_pending}` when the record is gone or revoked). Device certificates are issued
in `local-ca` mode but no route checks them yet (mutual TLS is M7).

*As built in M7* (ADR-095, FR-126): over HTTPS the node pins the Hub as `novad` does (§3) and
presents the device certificate Add Device granted as its client certificate once the identity
check passed; the `/node/v1` routes check it (§3, mutual TLS). An unpinned node uses the system
roots for an https Hub. The Hub → node job channel is unchanged.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/node/v1/register` | (node → Hub) Announce capabilities + certificate; M2: `{enrollToken, name, endpoint, publicKey, capability, signature, jobToken, protocolVersions}` → `{nodeId, credential, heartbeatIntervalMs, protocolVersion}` |
| `POST` | `/node/v1/heartbeat` | (node → Hub) Health, load, queue depth, temperature; `401` once revoked |
| `POST` | `/node/v1/models/sync` | (node → Hub) Advertise available models in a re-signed capability document |
| `POST` | `/node/v1/jobs` | (Hub → node) Submit a job (chat/tool/embedding/media); M2: `{kind: "chat", request}` → `{jobId}` |
| `GET` | `/node/v1/jobs/:id/stream` | (Hub → node) Stream job output as SSE of normalized stream events (`docs/07` §2) |
| `POST` | `/node/v1/jobs/:id/cancel` | (Hub → node) Cancel a job |
| `GET` | `/node/v1/health` | (Hub → node) Health and load |
| `POST` | `/node/v1/services/:name/{start,stop,restart}` | Manage a service |

## 3. Hub ↔ `novad` (management channel)

The design is mTLS with the device certificate. Every privileged action is audited. Calls go
Hub → `novad` unless marked (novad → Hub).

*As built in M6* (ADR-093): until certificates arrive with the Mesh (M6.5), the Hub and `novad`
use bearer tokens over LAN HTTP, like compute nodes (ADR-089); `novad`'s client refuses
`https://` until then. `novad` registers with a one-use enrollment token (`nvd_…`), an Ed25519
public key, a capability document ([`device-capability.json`](schemas/device-capability.json))
signed with that key over its canonical JSON, and a management token it generated (`nvdm_…`). The
Hub pins the key (its fingerprint is unique across devices, revoked ones included), keeps the
management token in the vault (`secret://devices/<id>/management-token`) and returns a device
credential (`nvc_…`, shown once, stored hashed in its own domain) for heartbeats and capability
updates. Every re-sent document must verify against the pinned key. Heartbeats every 10 s; three
missed beats mark the device `unreachable`. The Hub calls the device's endpoint (default port
7420) with `Authorization: Bearer nvdm_…`; `novad` compares it in constant time and answers 401
`token_required` otherwise, 405 to anything but `POST`, 400 to a body that is not a JSON object,
404 to an unknown route and 413 over 96 MiB. Errors use the Hub's error shape (§6). Calls run in
a module process: a module that is not running is 503 `node_unavailable` `{reason:
module_unavailable}`, one that crashes during the call `{reason: module_crashed}`; more than 16
calls in flight to one module is 429. The Hub does not run these calls through the policy engine:
the device enforces its grants and protected paths, and the Hub checks protected paths again on
writes.

*As built in M6.5* (ADR-094): the channel is still bearer tokens over plain HTTP; `novad` has no
TLS client, and the device certificate a grant may carry is kept (`device-cert.pem`) but not used
yet (mutual TLS is M7). `novad install` joins with Add Device (§1, `docs/23` §2) and registers
with the `nvd_` token it was granted: that token is bound to its key and to the pending device
record approval created, so `/agent/v1/register` must present the same key (`policy_denied`
`{reason: key_mismatch}`), activates that record and keeps the name and scopes the owner approved
(`conflict` `{reason: device_not_pending}` when the record is gone or revoked). The roles are
only those the document declares that the owner approved (the approved list when it declares
none of them): a device's own document can narrow its roles, never widen them. Heartbeats may
report the device's physical LAN subnets (`power.lan`, below), which Wake Helper routing uses.

*As built in M7* (ADR-095; FR-126, R-022, R-023). `novad` has a TLS client (rustls with the
`ring` provider). With an https Hub it asks for the identity statement with a fresh nonce on the
same connection and checks it against the pinned fingerprint before it sends anything, then trusts
only what the statement vouched for (no platform trust store once pinned, so `pinning: off` changes
nothing for it); it presents its device certificate only on a connection that passed that check.
`novad install` and `enroll` take an `https://` Hub with `--pin` (§1; `docs/23` §2); a device moves
from http to https when the Hub does, never back. **Mutual TLS** on the novad → Hub routes
(`/agent/v1/register`, `heartbeat`, `capabilities`) and the node routes: when the Hub serves HTTPS
its listener asks every client for a certificate of the Hub local CA without requiring one
(browsers keep working); a presented certificate must verify (issuer, signature, validity, the
recorded serial, revocation) and belong to the caller (the device the credential names, or on
registration the key in the body). Without one, `devices.tls.allowWithoutCertificate` (on by
default for one release) accepts the call and reports a diagnostics problem; off, it is refused. A
device that holds an unrevoked, unexpired certificate is refused without it whatever the setting
says (a bearer credential captured before the move to HTTPS cannot be replayed without the
certificate). `novad` and compute nodes present their certificate only on TLS 1.3 handshakes whose
server already verified against the cached Hub trust, so an impostor never learns the device id.
Refusals are 403 `policy_denied` with `details.reason` `certificate_required`,
`certificate_mismatch` (another device's certificate) or `certificate_<why>` from the check
(`revoked`, `expired`, `unknown_issuer`, `unknown_serial`, `malformed`, `not_yet_valid`,
`bad_signature`, `no_ca`); `device.tls.changed` announces a device's new state and refusals are
audited as `device.tls.refuse` (at most once an hour per device and reason). Plain HTTP and
requests the Relay tunnels in are not checked. The heartbeat answer adds `scopes` (the device's
granted scopes, `local-runtime` included), which `novad` keeps in `scopes.json` so a grant holds
while the Hub is away. The Hub → `novad` calls below are still bearer tokens over plain HTTP.

novad → Hub (no session; §1 lists how each authenticates):

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/agent/v1/register` | (novad → Hub) `{enrollToken, name (1–100), endpoint (a plain http(s) base URL without credentials, query or fragment), publicKey (raw Ed25519, base64url), capability, signature, managementToken ("nvdm_…"), novadVersion, protocolVersions}` → 201 `{deviceId, credential: "nvc_…", heartbeatIntervalMs, protocolVersion, updateChannel, updateKey}` (`updateKey`: the update signing key the device pins, or null; the M6 Hub has none). A bad body is `validation` and no protocol version in common `capability_missing`, both before the token is spent. An unknown, used or expired token is 401 `auth_missing`. After that the token is spent even on failure: a document that fails the schema is `validation` `{reason: invalid_capability}`, a bad signature `policy_denied` `{reason: bad_signature}`, a key already registered `conflict` `{reason: key_in_use}`. The roles are the ones the document declares (the token's when it declares none); the device's kind is `hub`, `wake-helper` or `client`, never `compute`. Audited as `device.register`; `device.registered` |
| `POST` | `/agent/v1/heartbeat` | (novad → Hub) `Authorization: Bearer nvc_…` (none: 401 `token_required`; unknown or revoked: 401 `auth_missing`, and the device then stops its modules and wipes its credentials). `{novadVersion, modules?, events? (≤ 500), accessDecisions? (≤ 500), power?}` → `{ok: true, heartbeatIntervalMs, capabilityRequested}`. Marks the device `active`; module events become `device.module.changed` (crashes and disables are audited); decisions made on the device (`novad access approve\|deny`) close their Hub cards; a `novad` self-update the device reports is recorded; overrides or policy the device has not taken yet are pushed after the beat. M6.5: `power` may carry `lan: [{interface?, network, broadcast?}]`, the device's physical IPv4 subnets (from `/proc/net/route`, container bridges and tunnels left out), for Wake Helper routing; `network` must be an IPv4 network `a.b.c.d/p` with p from 1 to 30 and no host bits set (at most 32 entries), else the beat is `validation`. A reported `broadcast` is kept but never used: the Hub computes it from `network` |
| `POST` | `/agent/v1/capabilities` | (novad → Hub) Device credential as for heartbeats. `{capability, signature, novadVersion}` → `{ok: true}`. The document must pass the schema, verify against the pinned key and keep its `deviceId` (`validation` `{reason: device_mismatch}`). `device.capabilities.changed` when its modules or version changed. Sent at start, every 30th heartbeat and when a heartbeat answer asks |

Hub → novad (all `POST`, management token):

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/agent/v1/status` | `{novadVersion, deviceId, channel, modules: [{name, version, state, desired, pid, restarts, lastExit, disabledReason, startedAt, previousVersion}], uptimeMs, sandbox, hardened}` |
| `POST` | `/agent/v1/capabilities` | The current signed document `{capability, signature, novadVersion}` (not called by the M6 Hub) |
| `POST` | `/agent/v1/config` | The Hub's overrides and policy (FR-142, FR-150) `{capabilityOverrides?, policy?: {allowedModules?, resourceCaps?, quietHours?, routingEligible?}, updateChannel?, revision}`: saved and applied (modules outside `allowedModules` stop; resource caps apply from each module's next start); answers `{capability, signature, revision, modules}` with the re-signed document. An override outside the Advanced fields is `validation` |
| `POST` | `/agent/v1/modules/:name/{start,stop,restart,rollback}` | Start, stop, restart a module or roll it back to the version an update replaced (FR-141): `{module}`. `not_found` for a module that is not installed; `policy_denied` `{reason: module_not_allowed\|checksum_mismatch}`; `conflict` without a previous version |
| `POST` | `/agent/v1/services/:name/{start,stop,restart,status}` | A service the device owner declared: a supervised module, or a systemd unit through `systemctl` (FR-145). `{service: {name, kind, state}}` |
| `POST` | `/agent/v1/power` | `{action: status\|wol-plan\|wol-enable\|sleep\|restart\|shutdown, apply?}` (FR-144); refusals as `POST /api/v1/devices/:id/power`. There is no `wake` here: a device wakes other devices through `power/wake-other`. Linux only |
| `POST` | `/agent/v1/power/wake-other` | The Wake Helper (FR-138, M6.5) `{mac, broadcast?, port?}` → `{sent: true, mac, port, targets: [{broadcast, interface}]}`: the device sends the magic packet on its LAN. Only a device whose roles include `wake-helper` (else 403 `policy_denied` `{reason: not_wake_helper}`). `mac` must be a unicast address; `broadcast`, when given, must be on one of the device's physical IPv4 subnets (else 403 `policy_denied` `{reason: not_on_lan, lan}`), otherwise the packet goes to every physical subnet's broadcast address; `port` is 9 (default) or 7. A device with no LAN interface is 409 `{reason: no_lan}`; more than 10 a minute is 429 `rate_limited` `{retryAfterMs}` (counted in the supervisor, so a module restart does not reset it); a bad body is 400 `validation`. The Hub calls it from `POST /api/v1/devices/:id/wake` with the broadcast address it computed. Linux only |
| `POST` | `/agent/v1/update` | Apply a signed bundle `{bundle: {manifest: {target, version, channel, sha256, size}, signature, payload}}` (FR-148) → `{status: applied\|rolled_back, target, from, to, at}` for a module, `{status: staged, target: novad, restart: true}` for `novad` (it exits with 75 for its service manager to restart it). `policy_denied` `{reason: no_trust_key\|bad_signature\|channel_mismatch\|checksum_mismatch\|elevation_required}`, `conflict` `{reason: not_newer}` |
| `POST` | `/agent/v1/fs/{list,stat,read}` | Inside the grantee's grants (FR-210): `{grantee, path}` → a listing (5,000 entries, protected ones left out), `{path, kind, size, mtimeMs}`, or `{path, contentBase64, size, sha256, truncated}` (`maxBytes` default 1 MiB, at most 8 MiB) |
| `POST` | `/agent/v1/fs/request-access` | Ask for a folder or an MCP server `{grantee, kind?: folder\|mcp, path\|target, access?, reason?}` → `{request}`; approved on the device (`novad access approve`) or the Hub (`fs/decide`); a folder an existing grant covers comes back `granted`; 200 pending at most |
| `POST` | `/agent/v1/fs/{grant,decide,grants,revoke}` | The Hub's side of grants: grant directly; decide a request `{requestId, decision: grant\|deny}` (the opposite of an earlier decision is `conflict`); list `{grantee?}`; revoke `{grantId}` or every grant of `{grantee}` |
| `POST` | `/agent/v1/fs/stage` | Stage a write `{grantee, path, contentBase64, baseSha256?, createDirs?, sessionRef?}` → `{staged: {id, path, baseSha256, newSha256, size, diff, additions, deletions, binary, diffTruncated, createdAt}}` (content ≤ 10 MiB, diff ≤ 256 KiB). Outside the write grants: `policy_denied` `{reason: folder_access_required, request}` with the folder request it filed for the nearest existing folder |
| `POST` | `/agent/v1/fs/commit` | `{grantee, stagedId}` → `{path, sha256, size, committedAt}`: an atomic replace only while the file still has the base hash, else `conflict` `{reason: base_mismatch\|staged_tampered}` and nothing is written. The Hub decides when to call it |
| `POST` | `/agent/v1/fs/{discard,delete,move}` | Drop a stage; delete a file or empty folder inside a write grant (never a grant root or a folder holding a protected location); move inside write grants |
| `POST` | `/agent/v1/exec` | `{grantee, cmd, args?, cwd, env?, timeoutMs?, stdin?, network?}` → `{exitCode, stdout, stderr, timedOut}`: under bubblewrap only (else 409 `sandbox_unavailable`), `cwd` inside a grant, no network (`network` other than `off` is `policy_denied` `{reason: egress_unavailable}`), 100 ms–30 min |
| `POST` | `/agent/v1/proc/{spawn,read,write,list}` | Long-lived processes kept by `novad` for Code environments (FR-062, FR-078): spawn `{grantee, cmd, cwd, env?, tag?}` → `{id}` (32 per grantee); read `{grantee, id, offset?, waitMs? (≤ 30,000)}` → `{data, offset, dropped, running, exitCode}` (the newest 1 MiB is kept); write `{text?, closeStdin?, signal?}`; list |
| `POST` | `/agent/v1/mcp/list` | `{grantee}` → the device's local stdio MCP servers the grantee holds an `mcp` grant for, with their tools |
| `POST` | `/agent/v1/mcp/call` | `{grantee, server, tool, arguments?}` → `{content, isError, untrusted: true}`; the server starts for the call, under bubblewrap unless its owner turned that off |
| `POST` | `/agent/v1/boot/profile` | Set/inspect the next boot profile (FR-143). Not built: every `boot/*` path answers 400 `capability_missing` |
| `POST` | `/agent/v1/firmware/read` | Read current BIOS/firmware settings (allowlisted) (FR-146). Not built: every `firmware/*` path answers 403 `firmware_disabled` |
| `POST` | `/agent/v1/firmware/plan` | Dry-run: proposed vs current diff. Not built |
| `POST` | `/agent/v1/firmware/apply` | Apply an approved change (snapshot + rollback). Not built |
| `POST` | `/agent/v1/firmware/rollback` | Restore a snapshot. Not built |
| `POST` | `/agent/v1/oob/:action` | Out-of-band action (IPMI/Redfish/AMT), off by default (FR-147). Not built: answers 403 `oob_disabled` |
| `POST` | `/agent/v1/ambient/records` | (novad → Hub) Signed batch of capture and status records ([`ambient-record.json`](schemas/ambient-record.json)); the Hub acks each record id or refuses it with `redaction_policy_stale`, `redaction_categories_insufficient`, `redaction_model_missing`, `redaction_model_rejected` or `forgotten_window` (FR-227, FR-228). Not built |
| `GET` | `/agent/v1/ambient/policy` | (novad → Hub) Current redaction policy version and categories, capture rules, accepted models and profile settings. Not built |
| `POST` | `/agent/v1/ambient/forget` | Delete a window from the device spool, queue and pixel targets; also novad → Hub to forward a forget made while offline (FR-154). Not built |

Every `fs/*`, `exec`, `proc/*` and `mcp/*` call names a `grantee` `{kind: user\|agent\|session\|run\|thread, id}` and refuses
credential locations and `novad`'s data folder whatever the grant (`policy_denied` `{reason:
protected_path}`); writes also refuse the read-only locations (`.git`, `.nova`, `.agents`, shell
startup files) inside a grant. `/agent/v1/firmware/*` will return `403` unless the global "Allow
BIOS/firmware changes" toggle is enabled **and** the change has an approval record, and
`/agent/v1/oob/*` unless the out-of-band module is enabled.

## 4. Native shell ↔ local `novad`

Desktop shells talk to the local `novad` over a Unix domain socket (macOS/Linux) or named pipe
(Windows). The socket is mode **0600** in the user's runtime directory; the named pipe's ACL
allows only the signed-in user. Every request carries the local token, which `novad` writes to
a user-only file and rotates when it restarts; a connection without a valid token is closed
(FR-192). Loopback TCP is not offered.

| Method | Purpose |
| --- | --- |
| `local.capabilities` | Read this device's capabilities |
| `local.exec` | Run a local command in the sandbox (agent tools) |
| `local.fs.list` | List a directory inside granted scopes (FR-210) |
| `local.fs.read` | Read a file inside granted scopes |
| `local.fs.requestAccess` | Ask the user to grant a folder; returns the grant or a denial |
| `local.fs.stage` | Stage a write and return its diff |
| `local.fs.commit` | Commit a staged write after the diff is shown and policy allows |
| `local.mcp.list` | List local stdio MCP servers and their tools |
| `local.mcp.call` | Call a local MCP tool under the device's grants |
| `local.window.capture` | Capture the frontmost (or picked) window: screenshot + accessibility text, redacted, excluded apps and password fields never captured (FR-214) |
| `local.screen` | Computer-use operations |
| `local.browser` | Local browser automation |

The shell never receives raw secrets; it requests scoped operations that `novad` enforces.

Not built in M6: the local socket, the local token and every `local.*` method. Computer use on a
real desktop (`local.screen`) and the local browser (`local.browser`) wait for the `screen` and
`browser` modules, which answer only `ping` and `status` in M6.

*As built in M7* (ADR-095, FR-128): what exists is `novad`'s **local runtime** module on client
devices, not the `local.*` methods above (still not built). It serves only the four OpenAI-style
model routes of this computer's OpenAI-compatible model server (`localRuntime.upstream`, default
`http://127.0.0.1:11434/v1`): `GET /v1/models`, `POST /v1/chat/completions`, `/v1/completions` and
`/v1/embeddings`, streaming the answer through, and only while the last heartbeat answer granted
the device `local-runtime` (else 403 `scope_missing`; a model server that does not answer is 502
`node_unavailable`). It listens on a Unix socket of mode 0600 in a 0700 folder
(`<data>/local-runtime/runtime.sock`, `/var/lib/nova/local-runtime/runtime.sock` for a root
`novad`) and, when the owner sets `localRuntime.listen`, on a loopback address that needs the bearer
token in `<data>/local-runtime/token` (0600), names a loopback Host and carries no `Origin` unless
the owner allowed it (`localRuntime.allowedOrigins`); loopback is never authorization on its own. **Per-user sockets:**
for each user named with `novad install`/`enroll --user <name>` (repeatable; default the user who
ran sudo, never root; kept as `localRuntime.users` in `config.json`) the root module binds
`/run/user/<uid>/nova/runtime.sock` (`$XDG_RUNTIME_DIR/nova/runtime.sock`; macOS
`~/Library/Application Support/Nova/run/runtime.sock`), folder 0700 and socket 0600 owned by that
user, with no token and no TCP port; it re-checks every 30 s, binding at login and stopping at
logout. A link or a foreign file at those paths is refused, never followed; ownership changes use
`lchown`. The desktop shell's main process uses it for `window.novaShell.localRuntime`
(`ipc-channels.md`); the page never sees the socket, the token or the address. Windows has no
per-user named pipe yet.

## 5. Streaming & backpressure

- Streams use SSE or WebSocket; events follow `contracts/events.md`.
- High-frequency deltas are coalesced (≤ 60/s); screenshots ≤ 1 per 2 s.
- Slow clients drop ephemeral deltas but never persisted events.
- Reconnect resumes from the last event id; the Hub replays missed persisted events and
  re-sends every request that is still `pending`. Without a cursor (`Last-Event-ID` or
  `?after=`) a stream sends live events only, on `/api/v1/events/stream` as on a thread's stream.
- The global streams (`/api/v1/events/stream`, `/api/v1/ws`) deliver only the signed-in
  account's events and account-less system events; a thread's stream only that thread's.
- **Notification opt-out**: a client lists event names it does not want in `/api/v1/hello`
  (`suppressEvents`); the Hub omits them from that client's streams. `request.*` events
  cannot be suppressed. M5 does not apply `suppressEvents` yet.

### WebSocket upgrade checks

- The upgrade needs the client's token or certificate (browsers: the Hub session cookie,
  `SameSite=Strict`); otherwise `401 token_required`.
- `Host` must be one of the Hub's configured hostnames. When `Origin` is present it must be
  on the allowlist (the Hub's own web origins plus any the owner adds); otherwise
  `403 origin_rejected`. Native clients that send no `Origin` are accepted on token alone.

### Terminal frames (FR-006)

`/api/v1/terminals/:id/ws` carries JSON text frames:

```json
{ "type": "input",  "data": "ls -la\r" }
{ "type": "resize", "cols": 120, "rows": 32 }
{ "type": "output", "data": "…" }
{ "type": "exit",   "code": 0 }
{ "type": "error",  "error": { "code": "validation", "message": "unknown terminal frame" } }
```

- The client sends `input` (at most 256 KiB) and `resize` (`cols` 10–500, `rows` 5–200); it
  sends a `resize` when the socket opens and whenever its size changes, and closes the socket
  after `exit`.
- The Hub sends `output`, `exit` (`code` is null when the terminal was closed or killed) and
  `error` for a frame it cannot read. On attach it first replays the scrollback, then `exit` if
  the terminal has already ended. Several viewers may attach to one terminal.

### Screen live frames (FR-087, FR-093)

`/api/v1/computers/:id/screen/live?surface=desktop|browser` carries JSON text frames (M6):

```json
{ "type": "input",     "action": { "kind": "click", "x": 640, "y": 120 } }
{ "type": "input",     "browser": { "kind": "type", "text": "hello" } }
{ "type": "kill" }
{ "type": "refresh" }
{ "type": "state",     "status": { "...": "ScreenStatusView" } }
{ "type": "frame",     "surface": "desktop", "computerId": "…", "width": 960, "height": 600, "takenAt": "…", "windows": [], "tree": "…", "mime": "image/png", "image": "<base64>" }
{ "type": "frame",     "surface": "browser", "mime": "image/png", "image": "<base64>", "takenAt": "…" }
{ "type": "input.ack", "ok": true, "error": null }
{ "type": "error",     "error": { "code": "conflict", "message": "take over the computer first" } }
```

- Before the upgrade the Hub checks `Host` and `Origin` (403 `origin_rejected`), the session
  (401 `token_required`) and that the computer is the account's (404 `not_found`), as plain HTTP
  answers. After the upgrade an unreadable id or `surface` closes the socket with 4400.
- `surface` (default `desktop`) picks the frames: the controlled desktop as a
  `ScreenObservationView`, or the computer's agent browser page as a PNG.
- On open the Hub sends `state`, then a `frame`; then a `frame` every 2 s (a tick is skipped while
  the previous frame is still being read) and a `state` whenever control, grants or the takeover
  change, an input arrives or an action is recorded. Frames are not stored and do not count toward
  the agent's one observation per 2 s.
- The client sends (each message ≤ 1 MiB): `input` with exactly one of `action` (desktop) or
  `browser`, with the shapes and limits of `POST /takeover/input`, only during a takeover started
  with `POST /api/v1/computers/:id/takeover` (the socket never starts one); the Hub answers
  `input.ack` and a fresh `frame`. `kill` stops control as `POST /screen/kill` does (the change
  arrives as `state`). `refresh` asks for a `frame` now. Anything else gets `error`
  `{code: validation, message: "unknown live frame"}`.
- `error` frames never close the socket. Several viewers may attach to one computer.

### Server-to-client requests (FR-188)

The Hub asks connected clients questions over the stream they already hold: approvals,
user input, MCP elicitations, client-side tools and credential refreshes
([`server-request.json`](schemas/server-request.json)). Request ids are UUIDv7 (`0192f…`
below).

WebSocket frames on `/api/v1/ws?clientSessionId=`:

```json
{ "type": "hello",   "version": "0.5.0" }
{ "type": "event",   "event": { "...": "EventEnvelope" } }
{ "type": "request", "request": { "id": "0192f…", "kind": "approval", "payload": { }, "expiresAt": "…" } }
{ "type": "respond", "requestId": "0192f…", "result": { "decision": "allow_once" } }
{ "type": "respond.ack", "requestId": "0192f…", "status": "resolved | conflict | expired" }
{ "type": "error",   "requestId": "0192f…", "error": { "code": "validation", "message": "…" } }
{ "type": "ping" }
{ "type": "pong" }
```

- The Hub sends `hello` when the socket opens, then `event` frames, and a `request` frame
  (a `ServerRequestView`) for each request the client may answer. On attach it first re-sends
  every pending request the client may answer, oldest first.
- The client answers with `respond`. The Hub replies `respond.ack`: `resolved`, `conflict`
  with the winning `resolution`, or `expired`; or an `error` frame for an answer that is not
  valid. A `ping` gets a `pong`.

Over SSE, requests arrive as `request.created` events and are answered with
`POST /api/v1/requests/:id/respond {result}`; the client names itself with the
`x-nova-client-session` header.

Rules:

1. A `request` frame goes only to WebSocket clients whose handshake agreed its kind; a request
   with a `targetDeviceId` goes only to that device. Every SSE stream of the account gets
   `request.created`. Pending approvals are pushed as `approval` requests (id = approval id,
   payload `{approvalId, action, reason, tier, options, alwaysScopes, nativeClientOnly, risk?}`)
   to clients that agreed `approval`; M5 sends no `review` in that payload yet.
2. Each request has exactly one resolution. The first valid answer wins and every other
   client receives `request.resolved`; a later answer gets `409 conflict` with the winning
   resolution, and an answer after `expiresAt` gets `410 request_expired`.
3. Answers are validated per kind: an approval result is an `ApprovalDecision` allowed for the
   tier (FR-189), decided by the approvals flow; `user_input` takes `{text}` or `{choice}` (one
   of `choices`; free text is refused when `allowFreeText` is false); `elicitation` takes
   `{action: accept|decline|cancel, content?}` (content only with accept, checked against
   `requestedSchema`); `client_tool` takes `{ok: true, output}` or
   `{ok: false, error: {code?, message}}`; `credential_refresh` takes `{refreshed}`.
   `handoff_required` and `confirm_at_action` requests (`nativeClientOnly`) can be answered
   only from an authenticated Nova client, never from a channel. An answer to a request aimed
   at another device is `403 policy_denied`.
4. A request no WebSocket client can take is notified at once (FR-060); one that was
   delivered and is still unanswered after 2 minutes is notified then; never more than once.
   At `expiresAt` the request becomes `expired` (`request.expired` with `reason: timeout`);
   an approval records the decision `timeout` and the run pauses (default 24 h). Cancelling
   the turn expires its requests with `reason: cancelled`; requests a restart left pending
   are expired at startup (`restart`).
5. M5 asks `user_input` through the `ask_user` tool, offered in Work and Code threads only:
   payload `{question, choices?, multiline?}`. It waits `policy.approvalTimeoutMinutes` (24 h
   by default, 1 s to 7 days); the answer becomes the tool result, labelled as the user's.
   Unanswered, the tool fails with `approval_timeout`, which ends the turn with that stop
   reason and pauses the run. While a request waits, the thread is `waiting_input` (Needs
   input) and the run's time budget does not run.

## 6. Error shape

```json
{ "error": { "code": "policy_denied", "message": "Action requires approval.",
             "retryable": false, "details": { "approvalId": "…" } },
  "requestId": "req_…" }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `auth_missing` | 401 | No credentials. M6.5 also answers it for a wrong Add Device code (`wrong_code`, with `attemptsLeft`) and for a reveal or status poll the device key did not sign freshly (`missing_proof`, `bad_signature`, `bad_reveal`, `stale_time`, `replayed`) |
| `auth_expired` | 401 | Token or certificate expired |
| `token_required` | 401 | A listener or stream upgrade without a valid token or certificate (FR-192) |
| `origin_rejected` | 403 | WebSocket or MCP request with a non-allowlisted `Origin` or `Host` |
| `policy_denied` | 403 | The policy engine denied the action. M6.5 also answers it with `details.reason` `add_device_disabled`, `key_revoked`, `key_mismatch`, `managed` (a setting managed policy fixes), `system_changes_disabled` and `consent_required` (Network setup) |
| `approval_required` | 409 | An approval is pending; `details.approvalId` |
| `hook_untrusted` | 409 | The hook's content hash changed or was never trusted |
| `rate_limited` | 429 | Retry after `details.retryAfter`. M6 also answers it for a wake past `devices.wakesPerHour` and for more than 200 pending folder requests on a device. M6.5 adds `details.reason`: `start_rate_limited` (20 Add Device starts an hour), `code_only_locked` (10 wrong typed codes in 5 minutes), `address_rate_limited` (the public Add Device and dist routes per client address), `wake_rate_limited` |
| `over_budget` | 402 | Account or provider spend cap reached (FR-116) |
| `budget_exhausted` | 409 | A run or goal budget, or the 200-step backstop, was reached; `details.bound` (FR-182). M5 answers it when a run or goal is resumed while that budget is still used up |
| `goal_blocked` | 409 | The goal is `blocked`; `details.blocker` (FR-181) |
| `request_expired` | 410 | The server request expired before this answer. M6.5: an Add Device pairing or request that expired, was used or never existed (`details.reason: expired`) |
| `capability_missing` | 400 | Feature, request kind or experimental field not negotiated (§7) |
| `sandbox_unavailable` | 409 | No sandbox could be created (for example for a terminal); fails closed, read-only mode offered |
| `node_unavailable` | 503 | No node can take the job |
| `firmware_disabled` | 403 | Firmware changes are off |
| `oob_disabled` | 403 | Out-of-band module is off |
| `validation` | 400 | Payload failed its schema or rule examples |
| `conflict` | 409 | State changed (request already resolved, stale hash, lease held, worktree cap); `details.reason` names it where there is one, e.g. `stale_hunk`, `staged_changes`, `detached_head`, `commit_failed`, `worktree_cap`; M6 adds `stale_version`, `stale_proposal`, `decided`, `slug_taken`, `published`, `not_published`, `folder_in_use`, `in_use`, `leased`, `dirty`, `not_leased`, `verify_running`, `too_many_dev_servers`, `dev_server_exited`, `hook_failed`, `push_failed`, `base_mismatch`, `staged_tampered`, `access_granted`, `agent_connected`, `key_in_use`; M6.5 adds `already_revealed`, `device_not_pending`, `revoked`, `no_wake_helper`, `nothing_to_roll_back`, `rollback_in_progress`, `rolled_back`, `trust_off`, `no_local_ca`, `no_mesh_cert`, `identity_missing`, `identity_mismatch`, `identity_unavailable`, and the Network setup reasons (`would_lock_out`, `setup_busy`, `earlier_step_pending`, `not_applicable`, `already_applied`, `nothing_to_apply`, `rollback_pending`, `not_applied`, `not_last_step`, `mesh_in_use`) |
| `not_found` | 404 | No such resource |
| `server_error` | 500 | Unexpected failure |

## 7. Versioning

- Path prefix `/api/v1`, `/node/v1`, `/agent/v1`.
- Breaking changes bump the major version; one compatibility shim is supported for one release.
- **Capability handshake** (ADR-072). A client calls `POST /api/v1/hello` after
  authenticating, before opening streams:

```json
{ "client": { "name": "nova-web", "version": "0.5.0", "platform": "web" },
  "protocolVersions": [1],
  "capabilities": {
    "experimental": false,
    "serverRequests": ["approval", "user_input", "elicitation", "credential_refresh"],
    "clientTools": [],
    "suppressEvents": ["chat.search.indexed"],
    "mcpApps": true,
    "streams": ["ws", "sse"]
  } }
```

  The Hub answers with what was agreed:

```json
{ "hub": { "id": "…", "version": "0.5.0" },
  "protocolVersion": 1,
  "apiVersions": { "api": ["v1"], "node": ["v1"], "agent": ["v1"] },
  "features": { "goals": "stable", "sandbox.microVm": "beta" },
  "serverRequests": ["approval", "user_input", "elicitation", "credential_refresh"],
  "limits": { "eventsPerSecond": 60, "maxUploadBytes": 104857600 },
  "clientSessionId": "…" }
```

- M5 ships the smaller answer described in §1 (`{name, version, apiVersions, serverRequests,
  clientSessionId}`) and does not negotiate protocol versions, features, limits or
  `suppressEvents` yet.
- The Hub picks the highest common protocol version; with none in common it answers
  `capability_missing` naming both sides' versions.
- `features` lists feature flags with their stage (ADR-082). Experimental methods and fields
  are rejected with `capability_missing` unless the client set `experimental: true`;
  experimental flags appear only for such clients.
- Nodes and `novad` negotiate the same way in the body of `/node/v1/register` and
  `/agent/v1/register`; the Hub refuses a `novad` below the minimum version for a requested
  capability (FR-081).
