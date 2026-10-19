# 22 — Networking, Transports & Relay

Nova must reach the Hub from anywhere a user is, without requiring the user to open ports or
run a VPN by hand. This document defines the transport abstraction, the Add Device flow, the
trust/HTTPS story, and the Relay.

## 1. Goals

- Work on the LAN with zero setup.
- Work remotely (phone on cellular) with minimal setup.
- Never hard-depend on a third-party service.
- Be safe by default: authenticated, encrypted, least-privilege.

## 2. Transports (the mesh abstraction)

A **transport** is a way two Nova roles can reach each other. The Hub publishes a set of
reachable **endpoints**; clients try them in order and use the first that works.

| Transport | Description | Requires |
| --- | --- | --- |
| **LAN** | Direct on the local network (mDNS/`.local` names or IP). | Same network |
| **Mesh** | A WireGuard-based mesh. Supported control planes: **Headscale** (self-hosted, recommended), **Tailscale** (managed), **NetBird** (self-hosted, mobile-friendly), or **plain WireGuard**. | An installed mesh client |
| **Relay** | A content-blind forwarding server that both sides connect **outbound** to. | A reachable Relay |
| **Direct public** | Hub exposed on a public address/port. | Port forwarding or public host |

Endpoint selection order (happy-eyeballs, roughly 300 ms budget per candidate):

```
LAN → Mesh → Relay → (Direct public if configured)
```

If a candidate fails a health check, the Hub stops advertising it (`docs/23` diagnostics).

*As built in M6.5 (ADR-094; `packages/core/src/network`, `apps/hub/src/network.ts`).* An endpoint is
an `EndpointCandidate` (`contracts/hub-api.md` §1, Network). The sources:

- **LAN**: the addresses the Hub's listener accepts on its own interfaces, plus `<name>.local` while
  mDNS runs. Loopback and IPv4 link-local addresses are left out unless
  `network.lan.includeLoopback` or `network.lan.includeLinkLocal` is on; IPv6 link-local never (a
  URL cannot carry its zone). Container, VM bridge and tunnel interfaces (`docker`, `br-`, `veth`,
  `virbr`, `tailscale`, `wg0`, `tun` and the like) are skipped, and the CGNAT range `100.64.0.0/10`
  and Tailscale's `fd7a:115c:a1e0::/48` count as Mesh, never LAN. Priorities: IPv4 10, the mDNS name
  11, IPv6 12.
- **Mesh**: the Hub's mesh URLs from the Network Setup area's detection (20 and up).
- **Relay**: the Relay URL while the connector is configured, healthy while it is connected (30 and
  up). A `wss://` candidate keeps the health its source reports.
- **Direct public**: `network.directPublic.url` while Direct public is on (40).

Each candidate is checked every `network.healthCheckSeconds` (60 s by default) and on demand
(`POST /api/v1/network/test`; concurrent calls share one run). The check is a real
`GET <url>/api/v1/hello` over a fresh connection, 300 ms for every request it makes. It passes only
when a Nova Hub answers, and once the Hub knows its own fingerprint, only when the answer carries
that fingerprint and the endpoint also answers `GET /api/v1/trust/identity?nonce=<fresh nonce>` with
a statement for that nonce signed by the pinned key (a fingerprint is public, so an impostor could
echo it). HTTPS is verified against Node's default roots (with `NODE_EXTRA_CA_CERTS` and the system
store) plus the Hub's own CA, so an endpoint a client could not verify is not advertised either. The
mDNS name is checked by connecting to a LAN address with the name as the Host header. One failure
withdraws an endpoint and the next success adds it back (no hysteresis). Only healthy candidates of
enabled transports are advertised, best first: in the `POST /api/v1/hello` answer (`endpoints`) and
the Add Device QR (at most 4). The `network.transports` switches change only what is advertised; no
listener is ever closed by them. Nothing is checked or advertised until the Hub reports its bound
listener.

Every probe is kept 7 days (`network_endpoint_check`) and every change to what is advertised is
logged for 90 days (`network_transport_event`) and announced (`network.endpoints.changed`,
`network.transport.changed`): a LAN outage that leaves Mesh or Relay as the preferred transport is
the logged fallback the M6.5 exit criteria ask for. A transport the owner turns off is logged as
`off` ("LAN was turned off; Relay is now primary"), never as a failed check. The Relay endpoint's
health is the Relay connector's state, whatever its URL scheme (a Relay is never sent the Hub's
hello probe), and a change of that state runs the checks at once, so a Relay that connects or drops
is advertised or withdrawn immediately rather than at the next scheduled check.

The client side of the selection order is `selectEndpoint` in `@nova/shared`: candidates in priority
order, the next one started after the 300 ms budget or at once when one fails, the first success
wins and the others are cancelled, 5 s at most per attempt, with an attempts log.

*As built in M7 (ADR-095; `apps/web/src/relaytransport`).* The web app calls `selectEndpoint` once
the browser is paired through the Relay (§4.4); a browser that is not passes every request straight
to the origin it was loaded from with its session cookie, as before. A paired browser has two
candidates: the page's own origin (labelled LAN, Mesh or Direct from the endpoint the Hub advertises
at that address, else guessed from the address) and the Relay, tried in priority order (normally the
origin first and the Relay 300 ms later or as soon as the origin fails); each passes only when `GET
/api/v1/hello` answers as a Nova Hub with the pinned fingerprint. Other advertised endpoints only
name the transport: the Hub sends no CORS headers and the session belongs to one origin, so the
browser never calls another address. On either path the device session token goes as a bearer header
(cookies the Hub sets do not come back through the tunnel). When the origin stops answering, only a
read (GET or HEAD) or a write carrying an `Idempotency-Key` is sent again through the tunnel;
anything else fails back to the caller (the offline queue, `docs/21` §9). While on the Relay the
browser tries the origin again every 60 s and on the browser's `online` event. The event stream
follows the path (a fetch-based reader with the token, since `EventSource` cannot send one). The
account menu names the path in use (LAN, Mesh, Relay or Direct). **Known limitations:** over the
Relay, resources the app loads by address (attachment and raw file URLs, artifact content, avatars)
and the terminal WebSocket do not go through the tunnel, so images, attachments and terminals do not
load; fetching an attachment through the API works. The device token is sealed in IndexedDB but page
script can use it, which is weaker than an HttpOnly cookie. No native app calls `selectEndpoint`
yet.

**mDNS.** The Hub announces `_nova._tcp` (instance `<name>._nova._tcp.local`) with its port, a TXT
record holding only `v=1` and `fp=<hub fingerprint>`, and `A`/`AAAA` records of its healthy LAN
addresses (TTL 120 s), using the MIT-licensed `multicast-dns` package. It runs only while the LAN
transport is advertised, `network.lan.mdns` is on and the Hub does not listen on loopback only. The
name is `network.lan.mdnsName`, else the first label of the host name (`nova-hub` when that is
empty); while mDNS runs the Hub answers to `<name>.local` (it joins the Host allowlist). Not built:
name-conflict probing (RFC 6762 §8) and a throttle on answers.

### 2.1 Control plane vs data plane (important)

- The **control plane** hands out keys and introduces peers. Headscale/Tailscale/NetBird are
  control planes.
- The **data plane** is the actual encrypted tunnel: direct where possible, through a
  **DERP** relay when NAT blocks a direct path.

Self-hosting Headscale gives you a self-hosted control plane, but:

- **Desktop/Linux/Windows/macOS**: Tailscale clients can point at Headscale — works well.
- **Mobile**: the official Tailscale apps historically do **not** allow a custom control
  server. If mobile must work with a self-hosted mesh, prefer **NetBird** (self-hostable
  with mobile apps) or rely on the **Relay**.

### 2.2 Mesh recommendation

- **Default recommendation for self-hosters: Headscale**, documented and orchestrated by Nova.
- **Managed Tailscale** offered for the easiest mobile experience.
- **NetBird** supported and evaluated as the "self-hosted *and* mobile" answer.
- **Plain WireGuard** supported for minimalists.

Nova never requires a Mesh; LAN + Relay always work.

## 3. The Relay

A Relay is a small always-reachable server that the Hub and Clients each connect **out to**.
It forwards sealed messages between them when no direct path exists.

- **Purpose**: off-LAN reach, NAT traversal, and **push** wake-up on mobile.
- **Content-blind**: carries ciphertext + routing metadata only; it stores nothing beyond
  routing registrations and queued ciphertext awaiting delivery (`contracts/rest-api.md` §3).
- **Protocol**: persistent outbound WebSocket/HTTPS; messages are
  XChaCha20-Poly1305 sealed to the recipient's device key.
- **Deployment**: self-hostable (a small VPS or container) and optionally offered as a hosted
  service. The user chooses in Hub settings.
- **Push**: integrates APNs (iOS) and FCM (Android) for wake-up and notifications.
- **Rejected design**: relays run by a vendor that can read content (they decrypt, terminate
  TLS on plaintext, or hold the keys) are not used, even as an option (ADR-071, ADR-080). Nova's
  Relay only ever sees ciphertext and routing metadata.

### 3.1 Framing (FR-137, ADR-071)

Every message crosses the Relay as a **sealed envelope**. The outer fields are the only
metadata the Relay sees:

| Field | Meaning |
| --- | --- |
| `v` | Envelope version |
| `to` / `from` | Opaque routing ids issued at pairing (never device names) |
| `client` | The paired client's id |
| `stream` | Stream id: one per logical channel (a thread stream, an approval request, a file transfer) |
| `seq` | Per-stream sequence number, starting at 1 |
| `seg` | Segment index and count for a segmented message |
| `ack` | Cumulative ack: the highest contiguous `seq` received on this stream in the other direction |
| `kind` | `data`, `ack`, `ping`, `pong` or `close` |
| `ct` | Ciphertext |
| `reason` | `close` frames only: `normal`, `revoked`, `unknown_route`, `too_large` or `idle` |

- **Sealing**: the payload is XChaCha20-Poly1305-sealed to the recipient's device key, with
  `client`, `stream`, `seq` and `seg` bound as associated data, so the Relay cannot reorder,
  splice or replay envelopes without detection. Receivers drop duplicates and sequence numbers
  outside the window.
- **Segmenting**: payloads above 64 KiB are split into segments; the largest message is 16 MiB;
  an incomplete message is discarded after 60 s.
- **Acks and retransmit**: acks are cumulative per stream (and may ride on data envelopes). The
  sender keeps unacked segments in a bounded window (default 256), retransmits after 5 s
  without an ack, and on reconnect resumes from the last acked `seq`.
- **Keepalive**: `ping` every 25 s; after 3 missed pongs the connection is closed and re-opened
  with backoff.
- **Pairing**: a client pairs by QR or short code shown by the Hub (single use, 5 min TTL, as
  in §4). The client and the Hub exchange public keys and confirm a matching code on both
  screens; the Relay learns only the routing ids.
- **Paired clients**: Hub → Network → Relay lists every paired client: its device (name and
  platform), relay client id and last seen (`GET /api/v1/relay/clients`, `contracts/hub-api.md`
  §1). **Revoke** removes its routing registration at the Relay,
  blacklists its key, and makes the Hub reject further envelopes from it. Pairing and revocation
  are audited.

*As built in M6.5 (ADR-094; `packages/relay`, `services/relay`, `packages/core/src/relayhub`,
`apps/hub/src/relay.ts`).* The Relay's routes, limits and close codes are in `contracts/rest-api.md`
§3; the Hub's routes in `contracts/hub-api.md` §1 (Relay). The primitives are WebCrypto (X25519,
Ed25519, HKDF-SHA256, PBKDF2-SHA256, SHA-256) and the MIT-licensed `@noble/ciphers`
(XChaCha20-Poly1305), so the same library runs in Node and in browsers. The construction:

- **Keys.** Each side has an X25519 key for the Relay, separate from its Ed25519 identity key: the
  Hub one per Relay registration (vault `secret://relay/<registration id>/x25519`, imported as
  non-extractable), the client one made at pairing. Each X25519 public key travels inside a sealed
  pairing blob, signed by that side's Ed25519 key (the device key; the Hub identity when it is
  loaded) over the JSON array `["nova-relay-bind-v1", role, x25519, relayPairingId, hubRoute]`.
- **Session keys.** One key per direction (`h2c`, `c2h`), HKDF-SHA256 over the X25519 shared secret;
  the info is the JSON array
  `["nova-relay-session-v1", hubRoute, clientRoute, clientId, hubX25519, clientX25519, direction]`.
  A frame reflected back to its sender never opens. So "sealed to the recipient's device key" above
  means sealed with the per-direction key both devices derive.
- **Sealing.** XChaCha20-Poly1305 with a random 24-byte nonce; `ct` is base64 of nonce, ciphertext
  and tag; the associated data is the JSON array
  `["nova-relay-v1", client, stream, seq, seg.i, seg.n]`, which cannot be ambiguous about field
  boundaries. Acks are not sealed (the schema gives ack frames no `ct`): a forged ack can only stop
  resends, which a Relay could do by dropping frames.
- **The code never reaches the Relay.** Both sides stretch the canonical pairing code with
  PBKDF2-SHA256, 600,000 iterations, salted with `nova-relay-pair-v1|<relayPairingId>`. From that
  come, by HKDF, the hash the Relay compares claims against, the key that seals the Hub's offer (its
  routing id, its signed X25519 key and the Add Device pairing id) and the key that seals the
  client's claim (the code, its device and X25519 keys with the signature, name, platform and kind).
  A fast hash of a 40-bit code could be brute-forced within the 5-minute life; this cannot. The Hub
  picks the Relay pairing id, since the hash and the offer are bound to it; the Relay refuses a
  duplicate. Five wrong hashes burn the slot at the Relay.
- **Pairing.** The QR carries the Relay URL and pairing id (`r=`, `rp=`); a typed code alone cannot
  pair over the Relay. The claim reaches the Hub as a data frame on stream `pair.<pairingId>`
  (re-sent each time the Hub connects until confirmed, never queued). The Hub opens it, refuses a
  claim for a slot past its 5 minutes, a client id or route it already knows (`client_conflict`) or
  a revoked key, and hands it to Add Device as a request with the v1 confirmation (§4.1). On
  approval the Hub confirms the route at the Relay and sends the client a sealed `paired` notice;
  the client then polls its Add Device status through the tunnel and gets its device session.
  *M7 (ADR-095):* a declined client learns why. When the owner denies the request, it expires, or
  the Hub refuses the claim (sent as `denied`), the Hub sends a sealed `decided` notice
  `{requestId, decision: denied|expired}` on a Hub-opened stream; the Relay passes the Hub's data
  frames on Hub-opened streams to a pending route (nothing goes back until the route is
  confirmed). The client cannot acknowledge it, so the Hub deletes the route after a grace period
  (2 s by default; sooner when it reconnects or stops). The client library's `waitForDecision()`
  resolves to approved, denied or expired, the first decision standing; a Relay that predates the
  notice drops it and the client sees its route revoked, as before.
- **Stream ids and floors.** A stream id is a side prefix (`c` client-opened, `h` Hub-opened) and a
  base36 counter that only grows (max(previous + 1, now in ms × 1024)). The Hub stores the highest
  client counter per client (`relay_client.stream_floor`) before the stream's first message is
  delivered (a failed write refuses the stream), so a Relay that recorded an old stream cannot
  replay it after a restart. A client whose clock went backwards gets a sealed `stale` notice and
  resends once on a new stream, only for GET and HEAD. The client's floor for Hub-opened streams is
  in memory unless the app persists it (`hubStreamFloor`, `onHubFloor`).
- **Tunnel.** One stream per request: `req {id, method, path, headers, body}`, answered by
  `head {id, status, headers}`, `body` chunks of 256 KiB and `end` (or `error`); the client refuses
  an answer whose `id` is not its request's. The Hub dispatches into its own routes with Fastify's
  `inject`: the path is normalised with `new URL` and must start with `/api/v1/` and not be
  `/api/v1/ws`; `%2e`, `%2f`, `%5c`, backslashes and `//` are refused in the path part (a query may
  carry them). Only an allowlist of request headers passes (`authorization`, `content-type`,
  `accept`, `accept-language`, `last-event-id`, `if-*`, `range`, since M7 `idempotency-key`, and
  `x-nova-*` except `x-nova-relay-client`), with `Host: localhost` and the address
  `relay:<clientId>`, so per-address limits apply per client and Network setup knows the request
  came over the Relay; `set-cookie` and hop-by-hop headers do not come back. The client's own
  `Authorization` header (its device session) authenticates the request exactly like a direct one;
  the route token authorizes nothing on the Hub. A response body pauses at 4 MiB unacked and the
  stream is dropped at 16 MiB; a session holds at most 32 MiB for reassembly or out-of-order
  delivery. Failures reach the client as a generic `server_error` (the detail goes to the Hub log).
  The event stream (SSE) works through the tunnel; the WebSocket does not.
- **Revocation.** Revoking a paired client deletes its route at the Relay (open connections close
  with `revoked`), drops its envelopes on the Hub, keeps its key refused and revokes its device;
  revoking the device anywhere revokes the client. Only a revoked key is refused when pairing again:
  a denied or expired request does not block the key.

**Known limitations (M6.5).** There is **no forward secrecy**: session keys are static for the life
of a pairing (X25519 static-static), so a later leak of either side's X25519 private key exposes
recorded traffic of that pairing; pairing again changes the keys. Two tabs sharing one paired record
get Hub replies only on the newest connection.

*As built in M7 (ADR-095; `services/relay/src/push.ts`, `apps/hub/src/relay.ts`,
`apps/web/src/join/relay.ts`).*

- **Registration token.** A private Relay can require a token from Hubs that register
  (`NOVA_RELAY_REGISTRATION_TOKEN`). The owner stores it with `PUT /api/v1/relay/registration-token
  {token}` (8 to 512 printable characters; `null` removes it): it goes into the vault at
  `secret://relay/registration/token`, is never answered back (the Relay view says only
  `registrationToken: true`), and the connector registers again at once. The setting
  `relay.registrationTokenRef` names the vault entry and accepts only
  `secret://relay/registration/…`, so it can never name another secret the connector would then
  send. The token goes to the Relay only when the Hub registers. Setting and clearing it are audited
  (`relay.registrationToken.set`, `.clear`, kind `network`). A Relay that refuses the registration
  says whether a token is missing or wrong.
- **Push through the Relay** (FR-111; `docs/13` §6). The Hub sends Web Push to browsers itself; for
  native apps it calls `POST /v1/relay/push/notify` with its route token, the route ids of the
  account's active native clients (at most 50) and `{id, category, title, link}`, nothing else: the
  title is the redacted one of at most 80 characters, whatever `push.detail` says, and the link is a
  `nova://run|code|approval|chat/<id>` or none. The Relay allows 30 a minute per route and pushes to
  the routes that registered an APNs or FCM token. Tokens are checked for shape at
  `/v1/relay/push/register` (hex for APNs, the FCM character set and length; a topic only for APNs),
  and a token APNs answers 410 or FCM 404 is dropped. The real senders are off until the operator
  configures them: APNs (HTTP/2 with an ES256 provider token) with `NOVA_RELAY_APNS_KEY_FILE`,
  `_KEY_ID`, `_TEAM_ID`, `_TOPICS` and `_SANDBOX=1`, FCM (HTTP v1) with
  `NOVA_RELAY_FCM_SERVICE_ACCOUNT_FILE`; without them the Relay records pushes with a mock.
- **Licence and logging.** `services/relay` and `packages/relay` are Apache-2.0 and import no AGPL
  package (ADR-023); the Relay writes its own JSON lines to stderr, with values under secret-looking
  keys (tokens, authorization, passwords) replaced by `[redacted]`.
- **The web join page pairs through the Relay** when the QR carries `r` and `rp` (§4.4).

**Known limitations (M7).** No forward secrecy (above). No shipped native app registers a push
token with the Relay yet: the notify path is tested with routes set up in an in-process Relay.

### 3.2 Per-platform reachability

| Platform | Interactive path | Background wake |
| --- | --- | --- |
| Desktop (with `novad`) | LAN → Mesh → Relay | OS notification; no wake needed |
| Android | Mesh → Relay, plus optional persistent connection (foreground service) | FCM push; optional long-lived socket |
| iOS | Relay (or Mesh while foregrounded) | **APNs push only** (iOS suspends background tunnels) |
| Browser/PWA | Same as its host device | Web push where supported |

Policy: **Relay guarantees mobile**; Mesh is preferred for desktop and compute-node traffic.

## 4. Add Device

The Hub exposes **Add a Device** (Settings → Devices). A device is added by scanning a QR code
or entering a short code.

### 4.1 Flow

```
Hub: Add a Device
  ├─ choose role: Client · Compute Node · Wake Helper
  ├─ choose scope: offline replica? local runtime? which capabilities?
  └─ shows QR + short code (single-use, TTL 5 min)

Device scans QR
  ├─ app absent → Hub bootstrap page (platform-detected):
  │     • iOS/Android: install app (store) or Add to Home Screen (PWA)
  │     • macOS/Win/Linux: download native shell, or open the PWA
  │     • headless / compute: show the one-line install command
  ├─ app present → deep link `nova://add-device?…`
  └─ both → handshake

Handshake
  1. Device generates a keypair and sends its public key + one-time code
  2. Hub shows a confirmation code; the device shows the same code
  3. User approves on the Hub (always required by default)
  4. Hub issues a device certificate + scoped token; the code is burned
```

*As built in M6.5 (ADR-094; `packages/core/src/pairing`, `apps/hub/src/add-device.ts`): Add Device
v2.* The routes and refusals are in `contracts/hub-api.md` §1 (Auth & devices). The owner starts on
`/devices/add` (role, scopes, an optional name, and the Relay when `relay.enabled` is on); the Hub
shows the QR, the code with Copy, a countdown with New code, the join link, the install commands (or
why there are none) and Start over.

1. **Start.** The code is 8 characters of Crockford base32 without I, L, O and U (40 bits,
   unbiased), single use, 5 minutes, stored only as a SHA-256 hash salted with the pairing id. An
   account may start 20 pairings an hour. The QR is
   `<hub>/add-device?p=<pairingId>&fp=<hub fingerprint>&e=<endpoint>…#c=<code>`: the code rides in
   the fragment, which never reaches a server log.
2. **Commit.** The device makes an Ed25519 key and a 32-byte secret nonce and sends the code, its
   public key and a commitment, base64url SHA-256 of
   `nova-add-device-commit-v1|<publicKey>|<nonce>`. A good code is consumed and the Hub answers with
   its own 32-byte nonce. A wrong code counts against its pairing and the fifth burns it. A code
   typed without the pairing id finds its pairing alone and spends the account's own budget instead
   (10 wrong guesses per 5 minutes, then code-only joins are refused for 5 minutes), so nobody can
   burn the owner's pairings without knowing their ids; the QR, the install command (`--pairing`)
   and the join link carry the id.
3. **Reveal** (within 2 minutes). The device sends its nonce, signed by its key with a fresh time.
   The Hub checks the commitment; a wrong nonce or signature burns the request. Both sides compute
   the confirmation: SHA-256 of
   `nova-add-device-v2|<hub fingerprint or ''>|<pairingId>|<publicKey>|<CODE>|<deviceNonce>|<hubNonce>`
   read as a big-endian integer mod 10^6, six digits. The Hub returns it with `hubSignature`, its
   identity's signature over
   `nova-add-device-reveal-v1|<requestId>|<pairingId>|<publicKey>|<confirmation>`. A device with a
   pin (QR `fp=`, `--pin`) takes `hubPublicKey` from `GET /api/v1/hello`, checks it hashes to the
   pin and verifies the signature before showing anything; a missing or bad signature is a hard stop
   ("This is not your Hub"). Every device stops if the Hub's digits differ from its own. Only now is
   the request the owner's (an `attention` notification and `device.add.requested`); a request never
   revealed is never shown.
4. **Approve.** The Hub never shows the confirmation itself: the device shows the six digits and the
   owner types them on the request card (`/devices/add?request=<id>`, also listed under "Waiting for
   approval" on `/devices`), then Approve or Deny. A typed mismatch is refused. The request waits 10
   minutes. Approval is always required; there is no auto-approve.
5. **Grant.** Approval creates the device record. The device's next signed poll gets its grant
   exactly once: a device session for a browser or app, or a one-use enrollment token for `novad`
   (`nvd_`) or a compute node (`nve_`) bound to the device's key and record, plus a device
   certificate in `local-ca` mode (§5). The device has 10 minutes to collect it. Polls must be newer
   than the last accepted one, so a captured poll cannot be replayed.

Why commit-then-reveal: in a single-round design every input of the confirmation (the fingerprint,
the pairing id, the key and the code) is visible to someone on the network path, who can hold the
device's request and grind keys until one gives the same six digits, in seconds. Here each side
commits before it learns the other's random nonce, so a party in the middle gets one guess in a
million per code. The code is kept in Hub memory only between commit and reveal, so a Hub restart in
between expires the request. A Relay join keeps the single-round (v1) confirmation, SHA-256 of
`nova-add-device-v1|<fingerprint>|<pairingId>|<publicKey>|<CODE>`: its claim travels sealed with a
key derived from the code (§3.1), so a party on the path never sees the code.

### 4.2 Roles and scopes

- **Client** — UI access; optional offline replica; optional local runtime (if the device has
  models and the Hub grants it).
- **Compute Node** — registers capabilities and accepts Hub-authorized work.
- **Wake Helper** — allowed to send WoL packets to other devices on its LAN.

Scopes are chosen at add time and shown on the success screen; they can be edited later.

*As built in M6.5 (ADR-094).* The role decides which kind of device may join: a Client is a browser,
the native app or `novad`; a Wake Helper is `novad`; a Compute Node is `nova-compute` or `novad`.
The approved record is a `device` row of kind `compute` (a compute node), `wake-helper` (a `novad`
Wake Helper) or `client`. When `novad` registers it keeps only the roles its signed document
declares that the owner approved (the approved list when it declares none of them), so a device can
narrow its roles but never widen them. Scopes are lower-case names chosen on `/devices/add`, none on
by default: for a Client `offline-replica` (Offline copy), `local-runtime` (Local models), `files`,
`browser` and `computer_use`; for a Compute Node `exec` (Commands); none for a Wake Helper. They
show on the success screen and are edited on the device page (`PUT /api/v1/devices/:id/scopes`,
`device.scopes.changed`). **Known limitation:** only `offline-replica` and `local-runtime` set the
device's capability flags; the other scopes are recorded and shown, not yet enforced, and a
browser's or app's device session is an owner session that scopes do not narrow.

*As built in M7 (ADR-095).* `GET /api/v1/session` answers the device session's `deviceId` and
`scopes`. `offline-replica` gates the replica routes of `/api/v1/sync` (removing it ends the replica
with `sync.replica.revoked`; `docs/21` §9). `local-runtime` reaches a `novad` device in every
heartbeat answer (`scopes`, kept in `scopes.json`; `docs/23` §4.3) and lets a replica push answers
its local model wrote. The other scopes are still not enforced.

### 4.3 Bootstrap command (headless)

The Hub serves per-arch, **signed** `novad` binaries at `/api/v1/agent/dist/`. A typical
command (generalizing the prototype) is:

```bash
d=$(mktemp -d) && \
  case $(uname -m) in
    x86_64|amd64)  a=amd64; h=<sha256-amd64> ;;
    aarch64|arm64) a=arm64; h=<sha256-arm64> ;;
    *) echo "no build for $(uname -m)" >&2; a= ;;
  esac && \
  [ -n "$a" ] && \
  curl -fsSL -o "$d/novad" "https://<hub>/api/v1/agent/dist/novad-linux-$a" && \
  echo "$h  $d/novad" | sha256sum -c - && \
  chmod 0755 "$d/novad" && \
  "$d/novad" install --hub https://<hub> --code <PAIR-CODE>; s=$?; \
  rm -rf "$d"; [ "$s" -eq 0 ]
```

Enhancements over the prototype: **signature verification** (not just SHA-256), Hub TLS
pinning/fingerprint check, and a scripted `--role`/`--scope` selection. The manual
verification procedure for any official download is in `docs/15` §3.1 (FR-225).

*As built in M6.5 (ADR-094; `apps/hub/src/agent-dist.ts`, `services/novad/src/install.rs`).* The Hub
builds the command for the Add Device start answer (`bootstrap`), for every role. The POSIX form,
one line in practice:

```bash
d=$(mktemp -d) && case "$(uname -s)-$(uname -m)" in \
    Linux-x86_64|Linux-amd64) a=linux-amd64; h=<sha256>;; \
    Linux-aarch64|Linux-arm64) a=linux-arm64; h=<sha256>;; \
    *) echo "no novad build for $(uname -s) $(uname -m)" >&2; a=;; esac && \
  [ -n "$a" ] && \
  { curl -fsSL -o "$d/novad" 'http://<hub>/api/v1/agent/dist/novad-'"$a" || \
    wget -qO "$d/novad" 'http://<hub>/api/v1/agent/dist/novad-'"$a"; } && \
  x=$(sha256sum "$d/novad" 2>/dev/null || shasum -a 256 "$d/novad" 2>/dev/null) && \
  { [ "${x%% *}" = "$h" ] || { echo "the download is not the Hub's signed build" >&2; false; }; } && \
  chmod 0755 "$d/novad" && s= && { [ "$(id -u)" -eq 0 ] || s=sudo; } && \
  printf '%s\n' 'ABCD-EFGH' | $s "$d/novad" install --code - --hub 'http://<hub>' \
    --pairing '<pairing id>' --pin '<hub fingerprint>' --role '<role>'; \
  r=$?; rm -rf "$d"; [ "$r" -eq 0 ]
```

- The cases list only the builds the signed manifest has (macOS builds as `Darwin-…`); each SHA-256
  comes from the manifest. The shell compares the hash itself (no `-c` reading standard input), so a
  fallback tool never runs on input the first one used up.
- The code reaches `novad` on standard input from the shell's `printf` builtin (`--code -`): it is
  on no process's argument list, and a pipe survives `sudo`, which drops the environment.
  `NOVA_ADD_CODE` also works. `sudo` is added when the user is not root (installing the service
  needs root).
- The command always carries `--pairing` and `--pin`; scopes are chosen on the Hub, so there is no
  `--scope`.
- With Windows builds the answer also carries a PowerShell form (`bootstrap.powershell`, run as
  Administrator): it downloads `novad-windows-<arch>.exe`, checks its SHA-256 with `Get-FileHash`,
  sets `NOVA_ADD_CODE` and removes it again in `finally`.
- There is no command, with the reason in `bootstrap.why`, when the Hub has no builds
  (`NOVA_NOVAD_DIST` unset or empty), when the Hub was opened at a loopback address, when the Hub
  has no identity yet, when the manifest is not signed by this identity, or without a pairing id.
- *Since M7 (ADR-095)* the command works for a Hub opened at an `https://` address. Its download
  skips the certificate check (`curl -fsSLk`, `wget --no-check-certificate`; in PowerShell
  `-SkipCertificateCheck` on 6 and later, a validation callback on 5.1), since a Hub on its own local
  CA is not yet trusted by that machine and the SHA-256 in the command, from the owner's screen,
  carries the download's integrity. `novad` then verifies the Hub through the pinned identity before
  it sends anything (§5). The command passes no `--user`, so the user who ran `sudo` gets the
  local runtime's socket (`docs/23` §2).

`novad install` then checks, before it writes anything, that the Hub's identity key
(`GET /api/v1/hello` `hubPublicKey`) hashes to `--pin`, that `novad-manifest.sig` verifies with that
key over `nova-novad-manifest-v1\n` followed by the exact bytes of `novad-manifest.json`, and that
its own binary's SHA-256 is the manifest's entry for its OS and architecture. It reads the binary
once and installs exactly the bytes it hashed. It then runs Add Device v2 as `kind: novad` (§4.1)
and registers with the granted token (`docs/23` §2). Over plain LAN HTTP the pin, the signed
manifest and the Hub-signed confirmation carry the install's integrity, while the code and the
tokens are visible on the LAN. Since M7 an `https://` Hub is trusted through the pin on the
connection itself (§5), so nothing crosses the network in the clear; over `http://` `novad` learns
the Hub local CA from the signed identity statement and moves to HTTPS once the Hub serves it.

### 4.4 Mobile behavior

On Android and iOS the app does as much as the OS allows: open the store listing if the app
is missing, otherwise deep-link into the app; if a PWA is acceptable, prompt to install it.
Full capabilities (files, screen, services) require the native app plus `novad` where
applicable.

*As built in M6.5 (ADR-094; `apps/web/src/join/`).* A phone or any browser joins on the Hub's own
page `/add-device`, which needs no session. It reads the code from the `#c=` fragment and clears it
from the address at once (or asks for it), names the device from its user agent (only to label it;
the Hub trusts none of it), checks the pin when the link carries `fp=`, commits and reveals (§4.1),
and shows the six digits only after the Hub's signature and confirmation check out ("On the Hub,
type this code to approve…"). It then polls with signed requests, using the Hub's clock from its
`Date` header when the device clock is more than 10 s off. The key is a non-extractable WebCrypto
key kept in IndexedDB with the pending request, so a reload keeps polling (memory only where
IndexedDB is missing). A lost connection keeps the commit and sends the reveal again; any refusal
from the Hub stops. Once approved the browser holds the session cookie and the page waits for **Open
Nova** so the install help can be read: on iOS, Share → Add to Home Screen; in Chromium browsers the
install prompt when the app qualifies, else the browser menu's install item; Firefox on a computer
cannot install it (bookmark it). A code meant for a compute node or a Wake Helper says to run the
install command on that computer instead. The native-app deep link
`nova://add-device?p=…&fp=…&r=…&rp=…#c=<code>` maps to the same page with only the fields that
validate. The page needs a secure context: browsers give Web Crypto only to HTTPS pages (or this
computer itself), so on a Hub serving plain HTTP at a network address (trust mode `none`, the
default) it says so ("This page needs a secure connection": turn on HTTPS in Network → Trust or use
the Nova app) and sends nothing, and Add a device warns the owner when it makes a Client code on
such a Hub. Not built: store listings and the native mobile apps.

*As built in M7 (ADR-095; `apps/web/src/join/relay.ts`, `apps/web/src/relaytransport/store.ts`).*
When the QR link carries a Relay (`r`, `rp`; only an `https://` or `wss://` Relay, or one on
loopback, else the page joins directly), the page pairs through it (FR-137): it makes a
non-extractable device key, claims the Relay's pairing slot with `pairWithRelay` as kind `browser`
(the code never reaches the Relay, §3.1), checks the Hub's sealed offer against the pin and shows
the v1 confirmation. It skips the direct `GET /api/v1/hello`, since the offer carries the Hub's
signed key. It then waits for the Hub's sealed `paired` notice, polls its Add Device status through
the tunnel with signed requests and receives a device session token. The pairing (the Relay record
with its session keys, the token and a join still waiting) is kept in IndexedDB sealed with AES-GCM
under a non-extractable key, so a reload keeps waiting and the app can later reach the Hub through
the Relay (§2); without IndexedDB it is kept in memory only. The page waits for the owner's
decision with `waitForDecision()` (§3.1, "Pairing") and says "Not approved" or "expired"
accordingly; only with a Relay too old to pass the Hub's `decided` notice does a dropped route
leave it unable to tell which. A Relay that reports the device revoked ends the pairing. The desktop shell
joins through this same page as a `browser` device and then uses that session's cookie.

### 4.5 Revocation and re-adding

- One-click **Revoke** on the Hub kills the device certificate and instructs the device to
  wipe its credentials.
- Re-adding requires a fresh code; revoked keys are blacklisted.
- Every add/revoke writes an **audit log** entry.

*As built in M6.5 (ADR-094).* `POST /api/v1/devices/:id/revoke` revokes any device: a compute node,
a `novad` device, or a browser or app added with a code (or an approved device that never
registered). For every kind the Hub deletes the device's sessions at once (a revoked browser's next
request is 401; revoking the browser in use signs it out), records its key in `revoked_device_key`
so a later Add Device, approval or Relay claim with that key is refused (`key_revoked`), refuses an
enrollment token still bound to it and a grant it has not collected (also when the revocation lands
while the grant is being issued: the device is checked again in the same transaction that inserts
the session), revokes its device certificates and its Relay client. A `novad` device wipes its
credentials at its next heartbeat (401); a compute node's `run` exits with code 3 and wipes its
keys. Re-adding needs a new code and a new key: `novad install`, `nova-compute enroll` and the join
page make a fresh key every time. Revocations and every Add Device step are audited (`docs/12` §11).
Only revoked keys are blocked: a key whose request was denied or expired may join again.

## 5. Trust & HTTPS

Browser/PWA features (camera, mic, service workers, notifications) require a **secure
context**. Three supported paths, chosen in Hub settings during onboarding (H1):

| Path | How | Best for |
| --- | --- | --- |
| **Hub local CA** | Hub generates a CA; Add Device installs the root cert on the device. | Fully private, LAN-only |
| **Mesh certificates** | Real TLS certs from the mesh (`*.ts.net` or your domain). | Remote + mobile |
| **Native shell pinning** | Native clients pin the Hub key. | Desktop, no CA install |

A device may use more than one path (e.g., LAN via local CA, remote via Mesh certs).

*As built in M6.5 (ADR-094; `packages/core/src/trust`, `apps/hub/src/trust.ts`).* Routes are in
`contracts/hub-api.md` §1 (Trust); the settings are `trust.mode`, `trust.meshCerts` and
`trust.pinNativeShells` (§8).

- **Hub identity.** An Ed25519 key in the vault (`secret://hub/identity`), made on the first start;
  its public half is kept in `trust_identity`. The fingerprint devices pin is base64url(SHA-256(raw
  public key)), 43 characters; `GET /api/v1/hello` carries it and the key (`hubFingerprint`,
  `hubPublicKey`), and it signs the Add Device reveal, the `novad` manifest, the Relay offer and the
  identity statement. When the database records a key and the vault lacks it, holds another or
  cannot be read, the identity refuses to load (`identity_missing`, `identity_mismatch`,
  `identity_unavailable`): hello answers null fields, nothing is issued, the identity statement
  answers 409 and the trust view says why, but the Hub still starts. It never makes a new identity
  in that case, since every pin would break. A key already in the vault with nothing recorded is
  adopted. Rotation is not built.
- **Modes.** `none` (the default) serves plain HTTP unless `NOVA_TLS_CERT` and `NOVA_TLS_KEY` are
  set, which always win. `local-ca` serves a certificate of the Hub local CA and, with
  `trust.meshCerts`, the mesh certificate to clients that name the mesh host (SNI). `mesh` serves
  only the mesh certificate and stays plain HTTP until one exists. Switching between HTTP and HTTPS
  applies at the next start (`restartRequired`); renewed certificates are swapped into the running
  listener (a failure is logged and the current certificates kept). Choosing `local-ca` creates the
  CA at once, so devices can install the root before the restart. If the trust certificates cannot
  be read at start, the Hub serves plain HTTP on `127.0.0.1` only (never on every interface) and
  reports why (`serving.fallbackReason`). Onboarding (H1) does not choose a mode yet.
- **Local CA.** ECDSA P-256, 10 years, path length 0, with RFC 5280 name constraints so the root a
  device installs can never vouch for anyone else's site. Permitted: the DNS names `local`,
  `localhost`, `home.arpa` and `internal`, plus the Hub's own names of two labels or more as it has
  them when the CA is created; the IP ranges `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
  `127.0.0.0/8`, `100.64.0.0/10`, `169.254.0.0/16`, `::1`, `fc00::/7` and `fe80::/10`. A
  single-label name (a host called `dev`) is never added, since it would cover a whole top-level
  domain; a name added later outside the constraints is left out of the certificate and reported as
  a problem. The key is a vault entry (`secret://hub/ca/<id>/key`); the database keeps only the
  public certificate. The Hub never replaces its CA on its own: a missing or mismatched key is
  reported (`ca_key_missing`, `ca_key_mismatch`) and the current certificate keeps being served.
  Only `POST /api/v1/trust/renew {target: "ca"}` replaces it (the new key goes into the vault first,
  then one transaction swaps the CA rows); every device must then install the new root.
- **Hub certificate.** Valid 90 days, renewed at two thirds of its life or when the names the Hub
  answers to change: `localhost`, the configured host, the hosts of the allowed origins,
  `<host name>.local`, a dotted host name, the interface addresses (not IPv6 link-local), the mDNS
  name and the direct public host. Its key is `secret://hub/tls/<id>/key`; superseded keys leave the
  vault.
- **Device certificates.** Issued only in `local-ca` mode, with the Add Device grant: the device's
  own Ed25519 key signed by the CA, valid 365 days, client authentication only, OU = the role and
  the SAN `urn:nova:device:<id>`. Revoking the device revokes them, and `verifyDeviceCertificate`
  checks issuer, signature, validity, the recorded serial and revocation. Since M7 the device and
  node routes check them (mutual TLS, below); there is no renewal.
- **Mesh certificates.** Requested from the mesh through the Network Setup area (`tailscale cert`),
  checked to cover the host and match their key, stored with the key in the vault
  (`secret://hub/tls/mesh/<id>/key`), renewed at two thirds of their life and served by name.
- **Installing the root.** `GET /api/v1/trust/ca.pem` and `ca.crt` (DER, the form phones open to
  install) while the mode is `local-ca`. No Apple configuration profile is served.
- **Audit and events.** Kind `network`: `trust.change` (with `via: settings|rollback`),
  `trust.ca.create`, `trust.ca.rotate`, `trust.leaf.issue`, `trust.device.issue`,
  `trust.device.revoke`, `trust.mesh.store`; `trust.changed` with its reason. A mode change through
  either route goes into the network change log (kind `trust.mode`), so one-click rollback undoes
  it.

**Native-shell pinning procedure** (FR-134; `checkHubIdentity` in `@nova/core` is the reference,
`hubIdentityStatementBytes` in `@nova/shared` gives the signed bytes; the desktop shell's copy is
`apps/desktop/src/pinning.ts`, `novad`'s `services/novad/src/tls.rs` and the compute node's
`services/compute/src/hub-tls.ts`):

1. Take the pin (`hubFingerprint`) only from Add Device: the QR code, the deep link, or `--pin`.
2. Open TLS to the Hub, keep the presented chain (leaf first), and send no credential yet.
3. On that same connection, call `GET /api/v1/trust/identity?nonce=<fresh random nonce>` (16–64
   base64url characters, at least 128 bits).
4. Check the statement: `hubFingerprint` equals the pin, and base64url(SHA-256(`hubPublicKey`))
   equals the pin; the Ed25519 `signature` verifies over `nova-hub-identity-v1` and a newline
   followed by the canonical JSON of the other fields (the nonce included); `nonce` is the one just
   sent.
5. If `pinning` is `off` (the owner turned `trust.pinNativeShells` off), verify the chain with the
   platform's trust store instead. The flag is signed and tied to the nonce, so it cannot be
   replayed.
6. Otherwise accept only if one of these holds:
   - the leaf's SHA-256 matches a listed `leaf` or `mesh` entry and the leaf is within its validity;
     or
   - the leaf was issued by the CA whose SHA-256 is listed (issuer and signature both check), is not
     a CA, has the serverAuth usage, has a DNS or IP name matching the host dialed (the subject's
     common name is never used), and is within its validity.

   Device certificates are client-only and never pass, revoked or not. On anything else, refuse,
   warn, and send no credential.
7. Cache the verified CA hash. When a later connection shows an unknown leaf, repeat steps 3–6 with
   a new nonce.

The Hub's own reachability probe runs the same statement check against its endpoints (§2).

*As built in M7 (ADR-095; `apps/desktop/src/pinning.ts`, `services/novad/src/tls.rs`,
`services/compute/src/hub-tls.ts`, `apps/hub/src/device-trust.ts`).*

- **Desktop shell.** `apps/desktop/src/pinning.ts` follows the procedure with a fresh 192-bit
  nonce, on the same TLS connection, before any credential, code or cookie is sent; afterwards
  Chromium's certificate check accepts only what the statement vouched for, and an unknown leaf
  repeats the check with a new nonce. A statement with `pinning: off` hands the check to the
  platform's trust store (step 5). Plain HTTP is allowed only to a Hub on the same computer
  (loopback). A Hub with a different identity clears the stored cookies and site data before
  anything loads, but only when a previous Hub is on record.
- **`novad` and compute nodes** (FR-134, R-023). Both keep the pin from Add Device (`--pin`) with
  what verified statements vouched for (`novad`: `hub-trust.json`, 0600; the node: `hubTrust` in its
  state file). A certificate the cached Hub local CA issued for the host dialed (issuer, signature,
  validity, serverAuth, a SAN for the host; for `novad`, whose checks are `rustls-webpki`, also the
  CA's name constraints), or one whose SHA-256 a statement listed and still within its validity, is
  trusted at once. Otherwise the connection is provisional: on it, before anything else, the client
  asks for the statement with a fresh nonce and checks steps 4 and 6 (device certificates and CAs
  never pass as the server); anything else stops with "This is not your Hub" and nothing is sent.
  Once pinned, neither uses the platform's trust store, so `pinning: off` changes nothing for them
  (stricter, never weaker); `novad` has no platform trust store at all and refuses an `https://` Hub
  without a pin, while an unpinned compute node checks an `https://` Hub against the system's roots.
  A device certificate is never presented on a provisional connection: the client reconnects with it
  after the check. Over `http://` with a pin, both learn the Hub local CA from the signed statement
  (it lists the CA's SHA-256, which must match `GET /api/v1/trust/ca.pem`) and move to `https://` on
  the same address the first time the Hub stops answering plain HTTP and the pinned identity vouches
  for it (at most one try a minute), never back. `novad` is `rustls` 0.23.45 with the `ring`
  provider (TLS 1.3 and 1.2); the node uses `node:tls`.
- **Mutual TLS** (FR-126). When the Hub serves HTTPS and has a local CA, its listener asks every
  client for a certificate of that CA without requiring one (`requestCert`, `rejectUnauthorized:
  false`), so browsers keep working; this holds with `NOVA_TLS_CERT` too. `novad` and compute nodes
  present the device certificate Add Device granted in `local-ca` mode, signed with their own
  Ed25519 key. The device and node routes (`/agent/v1/register`, `heartbeat`, `capabilities`,
  `/node/v1/register`, `heartbeat`, `models/sync`) check a presented certificate with
  `verifyDeviceCertificate` and that it belongs to the caller: the device the bearer credential
  names (its id and key) or, on registration, the key in the body. Without one,
  `devices.tls.allowWithoutCertificate` decides (security setting, on by default for one release so
  devices added before M7 keep working, with a diagnostics problem); off, the call is refused. A
  refusal is 403 `policy_denied` with `details.reason` `certificate_<why>`: `required`, `mismatch`
  (another device's certificate), or the trust check's `revoked`, `expired`, `not_yet_valid`,
  `unknown_issuer`, `unknown_serial`, `bad_signature`, `malformed` or `no_ca`. `novad` and the node
  log the reason and keep their credentials. Plain HTTP and requests tunnelled through the Relay are
  not affected. `GET /api/v1/devices/tls` (session) lists what each device last presented over HTTPS
  (`verified`, `missing` or `refused`, the reason and serial) with `requireCertificate` and the
  problems; the Hub's diagnostics (`deviceTls`) report the counts and problems. The state is kept in
  memory and rebuilt by the next heartbeat (migration 0039 is comment-only); a change emits
  `device.tls.changed`, a refusal is audited as `device.tls.refuse` (kind `device`) at most once an
  hour per device and reason, and a revoked device is forgotten.
- **Not built.** Device certificates are not renewed. The Hub → `novad` management channel (§9 item
  1) is still bearer tokens over plain HTTP.

## 6. Network Setup (assistant)

Nova must be able to configure its own networking (L3). The assistant:

1. Detects existing VPNs, meshes, IP/subnet, and DNS state.
2. Offers to install and authenticate a chosen Mesh (Headscale / Tailscale / NetBird /
   WireGuard), with a **one-time consent** per change, then remembers the choice.
3. Applies tags/ACLs, MagicDNS names, subnet routes, and (optionally) an exit node.
4. Fetches/installs TLS certs, or provisions the Hub local CA.
5. Configures the Hub/Compute firewall and which ports listen.
6. Enrolls the Relay and verifies an off-LAN path.
7. Runs **reachability tests** (LAN, Mesh, Relay) and refuses to advertise a failing path.
8. Offers **one-click rollback**; must never lock the user out of their own Hub.

A **Network** panel shows active transports, latency, certificate status, ACL summary, Relay
status, and per-device reachability, with guided fixes for common failures.

*As built in M6.5 (ADR-094; `packages/core/src/network/mesh`, `packages/core/src/network/setup`,
`apps/hub/src/network-setup.ts`).* Routes and refusals are in `contracts/hub-api.md` §1 (Network
setup); the surface is Network → Setup (`docs/04` §9).

- **Detect, then plan.** Detection reads interfaces, LAN subnets, `/etc/resolv.conf`, each mesh
  CLI's state, ufw and the package manager (apt, dnf, brew, winget), and changes nothing. A plan for
  Headscale (with the Tailscale client), Tailscale, NetBird or plain WireGuard is a list of steps,
  each with the exact argument lists it will run, the undo planned from a snapshot, the transports
  applying or undoing it could cut, and whether it is a host change. Planning changes nothing on the
  host. A client already joined to another control server is not taken over unless the plan says
  `replaceExisting` (the old login cannot be restored by a rollback).
- **Host changes switch.** Steps that run commands on the Hub need
  `network.setup.allowSystemChanges` (security setting, off by default); its switch sits at the top
  of Network → Setup and asks before turning on. With it off the assistant detects and plans only.
  The certificate step (through the trust area) and Relay enrollment (through the relay area) are
  not host changes and run with it off.
- **Consent bound to the exact description.** Each step has a description the owner confirms by
  sending it back word for word. The consent is remembered per change kind and provider, but only
  for that exact text: a later step of the same kind that says something else (another server, user,
  route or port) asks again (`consent_required` with `changed: true`) and replaces the old consent.
  Descriptions hold no run-specific paths, so re-planning the same change still matches. Consents
  are listed and revoked under `/api/v1/network/setup/consents`.
- **One step at a time, verified.** Applying a step snapshots what it changes, runs it, then runs
  the reachability test (up to 5 tries, 2 s apart). When a path the step should leave working fails,
  when the step's own check fails, or when the owner's own path stops answering, the step is rolled
  back at once with its undo commands (`rolled_back`, `autoRolledBack`). Without a reachability test
  connected, steps that expect one fail closed.
- **Lock-out guard.** A step (or its undo) that could cut the path the owner's request came in on is
  refused (`would_lock_out`) unless another path the step does not touch passes its test. The path
  is what the Hub can vouch for: the Relay tunnel marks its requests `relay`; otherwise the socket's
  local address decides. Loopback proves nothing (an SSH tunnel or a proxy on the Hub arrives from
  127.0.0.1), and any `x-forwarded-for`, `forwarded`, `x-real-ip` or `x-forwarded-host` header means
  the real path is elsewhere: both count as `unknown`, which the guard treats as possibly any path.
  So an owner in a browser on the Hub at 127.0.0.1 can change a path they might be using only while
  another path (normally the LAN) answers. For plain WireGuard the peers' AllowedIPs decide what a
  step can cut: LAN when they overlap a LAN subnet, Mesh for `100.64.0.0/10`, Relay and Direct
  public for anything public, and `0.0.0.0/0` or `::/0` all four; the step's description lists each
  peer's AllowedIPs and the paths at risk.
- **Rollback.** A run's rollback undoes every applied step, newest first; a step's rollback undoes
  only the last applied one; one-click rollback on Network (FR-139) undoes the newest change in the
  network change log, a setup step included. Every undo command runs and their errors are reported
  together. A step whose undo fails becomes `rollback_failed` with both errors, the run shows
  `failed` ("could not be undone; roll back again"), applying it is refused (`rollback_pending`) and
  a rollback retries it. Rollback works while `network.setup.allowSystemChanges` is off, since it
  puts back what the owner had; the audit records the setting's value. Applying always needs the
  setting.
- **Secrets per CLI.** Secrets never appear in argument lists, logs, events, audit rows or the
  database; typed ones go to the vault (`secret://network/setup/<runId>/…`) when the plan is made.
  Tailscale reads the auth key from `--auth-key=file:/dev/stdin` (on Windows from a 0600 file in the
  data folder, deleted right after); NetBird gets its setup key in `NB_SETUP_KEY`; a remote
  Headscale gets `HEADSCALE_CLI_ADDRESS` and `HEADSCALE_CLI_API_KEY` in the environment; a Headscale
  pre-auth key goes from the CLI's output straight into the vault (rolling back drops it from the
  vault but does not expire it on the server; it is single use and lasts an hour). WireGuard keys
  are made with `node:crypto` and kept in the vault
  (`secret://network/wireguard/<interface>/private-key`); `wg-quick` can read the private key only
  from its config file, so it sits in a 0600 file under the data folder while the interface is
  configured. A typed auth, setup or pre-auth key is deleted once `mesh.up` succeeds or is undone,
  and every typed secret of a run once nothing in it is applied; re-applying a rolled-back run needs
  a new plan with a new key.
- **Commands.** Always an argument list through `spawn`, never a shell string, with a timeout (60 s
  by default), the program in its own process group (a timeout kills everything it started) and a
  small fixed environment (`HOME`, `LANG`, `LC_ALL`, `USER`, `LOGNAME`, `TMPDIR`, `SystemRoot`).
  CLIs are found only in fixed system folders, never through the inherited `PATH` (which can hold
  `node_modules/.bin` or a user's folders): `/usr/local/sbin`, `/usr/local/bin`, `/usr/sbin`,
  `/usr/bin`, `/sbin`, `/bin` on Linux, plus `/opt/homebrew/{bin,sbin}` on macOS, and on Windows
  `System32`, the Tailscale, NetBird and WireGuard program folders and
  `%LOCALAPPDATA%\Microsoft\WindowsApps` (where `winget` lives); the child's `PATH` is that same
  list. `NOVA_NETWORK_TOOLS_FILE` (a JSON file
  `{bins: {<cli>: [absolute argv prefix]}, baseEnv: {…}}`) names the programs to run for each mesh,
  firewall or package CLI instead: the E2E journeys point it at fakes, and an operator can point it
  at CLIs installed outside the system folders. Only whoever starts the Hub can set it, the Hub logs
  a warning when it is set, and a file that cannot be read or parsed stops the Hub from starting.
  The setup lock is taken before the first await and always released; calls to the other areas are
  capped at 60 s (certificates 180 s).
- **Headscale ACLs and the firewall.** ACL changes only add rules; with no existing policy (which
  means allow-all) the allow-all rule is kept, and tag owners are written `user@`. Only Headscale's
  own "acl policy not found" counts as no policy: any other error reading it stops the step before
  it changes anything, and the undo writes back the exact text read at snapshot time. ufw only ever
  gets `allow` rules; it is never enabled, reset or given a deny rule, and the undo deletes only
  rules that are present.
- **Manual steps** (described, never run): Headscale MagicDNS (a setting in the server's config
  file); NetBird routes, DNS and exit node (set in its management service); WireGuard routes and
  exit node; WireGuard on Windows.
- **Audit and events.** Kind `network`: `network.setup.consent` (`granted` or `revoked`),
  `network.setup.apply` (also when denied), `network.setup.rollback` (actor `system` when automatic,
  with `allowSystemChanges`, `failed` and `reason`); the event `network.setup.step`.
- **Not built.** No elevation: commands run as the Hub's user, so `apt-get`, `ufw`, `wg-quick` and
  `tailscale up` without an operator fail with the CLI's own (redacted) error. apt and dnf installs
  assume the vendor's repository is configured (Tailscale and NetBird are not in default distro
  repositories). Headscale itself is never installed: the Hub must run it or reach it. Only fake
  CLIs were exercised; the assumed versions are Tailscale 1.7x (`debug prefs`,
  `cert --cert-file=- --key-file=-`), Headscale 0.26 (`nodes approve-routes`, `policy get/set`,
  `preauthkeys --user <id>`) and NetBird's `status --json`.

## 7. Wake Helper (WoL)

Wake-on-LAN magic packets only cross a single LAN segment. To wake a sleeping device:

- The Hub uses a **Wake Helper** on the same LAN (a router, NAS, or another `novad` device).
- The Helper is an opt-in role granted during Add Device.
- Wake requires the target to have WoL enabled (Nova can set this via BIOS management where
  supported — `docs/23`) and to be on AC power (or battery policy allowing it).
- Wakes are logged and rate-limited.

*As built in M6.5 (ADR-094; `packages/core/src/network/wake.ts`, `services/novad/src/power.rs`).* A
Wake Helper is a `novad` device added with the `wake-helper` role (or holding it among approved
roles). `POST /api/v1/devices/:id/wake` picks one on the target's LAN: an active helper (only those
in `network.wakeHelpers`, in that order, when the setting lists any) whose subnet holds one of the
target's addresses. A device's LAN is what it last reported: the physical IPv4 subnets in its
heartbeat's `power.lan` (exact; `novad` reads them from `/proc/net/route` and leaves container
bridges and tunnels out), else its endpoint address with the prefix of the Hub's own interface on
that network, else /24 or /64. Loopback and mesh addresses never match. The Hub calls the helper's
`POST /agent/v1/power/wake-other` with the broadcast address it computes from the subnet (a reported
broadcast is ignored; a malformed `power.lan` makes the heartbeat a `validation` error). The helper
sends the packet only on its own physical subnets, to UDP port 9 (or 7), at most 10 a minute. With
no helper on that LAN the Hub sends a directed broadcast itself, but only from a physical LAN
interface on the target's subnet (never a mesh range or a tunnel or bridge interface); else the wake
is refused (`no_wake_helper`), logged as failed and audited. The per-device limit
(`devices.wakesPerHour`) counts every attempt in the last hour, pending, sent and failed, recorded
in one transaction before anything is sent. `wake_request.helper_device_id` names the helper; the
wake result, `device.wake.sent` and the audit entry carry `via` (the helper's id or `hub`), and
Network → Wake helpers lists the newest 20 wakes. Wake Helpers are Linux only, like Wake-on-LAN
detection; there is no IPv6 fallback from the Hub. Enabling WoL in firmware is still M7.5 (`docs/23`
§6).

## 8. Configuration model

```jsonc
// Hub settings → Network
{
  "transports": {
    "lan": { "enabled": true, "mdns": true },
    "mesh": { "enabled": true, "provider": "headscale", "controlUrl": "https://headscale.lan" },
    "relay":   { "enabled": true, "url": "wss://relay.arialabs.ai", "selfHosted": true },
    "directPublic": { "enabled": false }
  },
  "trust": { "mode": "local-ca", "meshCerts": true, "pinNativeShells": true },
  "egress": { "mode": "allowlist", "allow": ["*.corp.example"] }, // unlisted hosts are denied (docs/12 §8)
  "wakeHelpers": ["device:<id>"]
}
```

Managed policy can restrict transports, require a specific provider, or force the Relay off.

*As built in M6.5 (ADR-094).* The model above is realized as flat settings keys
(`packages/shared/src/settings.ts`, the `// ---- M6.5` blocks; defaults and notes in `docs/14`
§1.1), all security-relevant except `network.healthCheckSeconds`:

```jsonc
{
  "network.transports": { "lan": true, "mesh": true, "relay": true, "directPublic": false },
  "network.lan.mdns": true,
  "network.lan.mdnsName": null,            // null: the host name's first label
  "network.lan.includeLoopback": false,
  "network.lan.includeLinkLocal": false,
  "network.directPublic.url": null,        // required while directPublic is on
  "network.healthCheckSeconds": 60,
  "network.wakeHelpers": [],               // device ids, in order; empty: any helper on the LAN
  "network.setup.allowSystemChanges": false,
  "relay.enabled": false,
  "relay.url": "",                         // wss:// or https://; ws:// or http:// on loopback only
  "relay.selfHosted": true,                // off with no URL: the hosted wss://relay.arialabs.ai
  "trust.mode": "none",                    // none | local-ca | mesh
  "trust.meshCerts": true,
  "trust.pinNativeShells": true,
  "network.egressMode": "allowlist",       // M6 (docs/12 §8); also network.egressAllow, egressDeny
  "devices.add.enabled": true,
  "devices.add.sessionDays": 30
}
```

The mesh provider and its control URL are not settings: they are the options of a Network Setup run
(§6). `PATCH /api/v1/network`, `PATCH /api/v1/trust` and `PATCH /api/v1/relay` write these keys (the
generic settings route works too), so managed policy can lock any of them, for example
`relay.enabled: false` to force the Relay off or `network.transports` to restrict transports.
Requiring a specific mesh provider is not enforced yet.

M7 adds two security settings (the `// ---- M7 devices` block): `devices.tls.allowWithoutCertificate`
(`true`: over HTTPS a device or compute node without a device certificate is still accepted, §5)
and `relay.registrationTokenRef` (`""`, or a `secret://relay/registration/…` reference, §3.1).

## 9. Security requirements

1. Every transport is authenticated with device keys; no anonymous access.
2. Relay payloads are end-to-end encrypted; the Relay sees only routing metadata.
3. The Add Device code is single-use, short-lived, and rate-limited.
4. Joining always requires Hub-side confirmation (auto-approve off by default).
5. Transport changes are audited and reversible.
6. A compromised transport (e.g., revoked mesh key) can be disabled without data loss.
7. The Hub never advertises an endpoint that fails its own reachability test.
8. **Listener hygiene** (FR-192): every Hub and `novad` listener (HTTP, WebSocket, Unix
   socket, named pipe) requires a token or certificate; a request from loopback or the LAN is
   not trusted for being local. WebSocket upgrades whose `Origin` or `Host` is not on the
   allowlist are refused. Unix sockets are mode 0600. mDNS advertisements carry no secrets.
9. Relay envelopes from a revoked or unknown client id are dropped and logged; sequence
   numbers are authenticated, so replays fail (§3.1).
10. When the configured port is taken, the Hub reports it and falls back to another port
    rather than exiting silently (`docs/15` §5.1).

*As built in M6.5 (ADR-094): how each requirement is met.*

1. Every Hub route needs a session or a credential of its own; the public Add Device routes
   authenticate by the code, then by the device key's signatures, and the only routes that answer
   anyone hand out public information (`contracts/hub-api.md` §1). Since M7 `novad` and compute
   nodes reach an HTTPS Hub through the pinned identity and present their device certificate, which
   the device and node routes check (mutual TLS, §5). **Gap (R-022, narrowed in M7):** the Hub →
   `novad` management channel is still bearer tokens over plain HTTP, and so is a device or node
   whose Hub serves plain HTTP; `devices.tls.allowWithoutCertificate` still accepts a device without
   a certificate over HTTPS.
2. Relay payloads are sealed end to end with per-direction keys derived from the two sides' X25519
   keys (§3.1); the Relay sees routing ids, kinds, sequence numbers and sizes, never the pairing
   code. **Gap:** no forward secrecy (§3.1).
3. The code is single use, 5 minutes, stored as a salted hash, five wrong codes burn its pairing,
   typed codes have their own budget per account, starts are capped at 20 an hour, and the public
   routes are rate-limited per address (§4.1).
4. Approval is always required: the owner types the six digits the device shows, and a party in the
   middle gets one guess in a million (commit-then-reveal, §4.1). There is no auto-approve.
5. Transport changes are recorded in the network change log with an undo (panel settings, trust
   mode, setup steps), audited (kind `network`) and reverted with one-click rollback; setup steps
   roll back on their own when they break a path (§6).
6. A transport is turned off with `network.transports` without closing any listener or losing data;
   a paired Relay client or a device is revoked without touching the rest (§3.1, §4.5).
7. Each endpoint passes a real hello probe (with the signed identity check once the Hub knows its
   fingerprint) before it is advertised, and one failure withdraws it (§2).
8. Listener hygiene: the M6 rules hold; mDNS carries only `v=1` and the fingerprint; the Hub answers
   to its mDNS name and its direct public host only while they are in use; a failed certificate read
   at start serves plain HTTP on loopback only (§5). Since M7 `novad`'s local runtime listens only on
   0600 Unix sockets (its own, and one per listed user) or, if the owner sets one, a loopback address
   that needs a token and checks Host and Origin (`docs/23` §4.3).
9. Envelopes from unknown, pending or revoked clients are dropped and logged; segments carry client,
   stream, seq and seg as associated data, and stream floors that survive a restart refuse replayed
   streams (§3.1).
10. The port fallback of M0 is unchanged; the network area reports the port actually bound
    (`listener` in `GET /api/v1/network`).

## 10. Failure & degradation

| Failure | Behavior |
| --- | --- |
| LAN down | Use Mesh; else Relay |
| Mesh down | Use LAN; else Relay |
| Relay down | LAN/Mesh continue; mobile loses background wake but resumes on reconnect |
| Cert expired | Native shells warn; Mesh path auto-renews; CA path prompts re-install |
| ACL misconfig | Reachability test fails; Nova refuses to advertise; rollback offered |
| Hub unreachable | Client local fallback (`docs/21` §9) |
