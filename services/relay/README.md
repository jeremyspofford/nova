# @nova/relay-service

A self-hostable, content-blind Relay (FR-137, `docs/22` §3, `contracts/rest-api.md` §3). A Hub
and its paired clients each connect **out** to it; it forwards sealed envelopes between them when
no direct path exists. It sees routing ids, frame kinds, sequence numbers and sizes, never
content, and stores nothing beyond routing registrations and a bounded queue of ciphertext
awaiting delivery.

Apache-2.0 (ADR-023, `LICENSE`): it imports no AGPL package. Its only Nova dependency is the
Apache-2.0 protocol library `@nova/relay`; it logs JSON lines on stderr with its own small logger
(`src/log.ts`), which never writes values under secret-looking keys (route and registration
tokens, authorization, secrets, passwords, cookies, credentials).

## Run it

Any machine both sides can reach (a small VPS, a home server with a forwarded port, a container
host). Node 24 or newer:

```bash
npm ci
node services/relay/src/main.ts --host 0.0.0.0 --port 7430 --data-dir /var/lib/nova-relay
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--host` | `0.0.0.0` | Address to listen on |
| `--port` | `7430` (`NOVA_RELAY_PORT`) | Port; `0` picks a free one |
| `--data-dir` | none (`NOVA_RELAY_DATA_DIR`) | Keep routing registrations across restarts in `relay-state.json` (mode 0600; changes are written asynchronously, at most once a second). Without it a restart forgets every Hub and client: Hubs without clients register again by themselves, paired clients must pair again |
| `--trust-proxy <hops\|addrs>` | off | Behind a reverse proxy: the number of proxies in front (`1` for one), or their addresses or CIDR ranges (`10.0.0.1,10.1.0.0/16`). The per-address limits then use the address the trusted proxy saw; an address the client writes into `X-Forwarded-For` itself is never believed. `true` is refused |

`NOVA_RELAY_REGISTRATION_TOKEN` makes Hub registration need that bearer token (a private Relay);
without it any Hub may register (rate-limited per address). It is read from the environment only,
never from the command line. Since M7 the Hub sends it: the owner stores it with
`PUT /api/v1/relay/registration-token` (Network → Relay), it is kept in the Hub's vault, and the
Hub's connector presents it only when it registers.

**Push (M7, FR-111).** Without configuration the Relay keeps a recording mock sender. Real senders
are switched on by the operator's environment only: APNs with `NOVA_RELAY_APNS_KEY_FILE` (the
token-signing key, EC), `NOVA_RELAY_APNS_KEY_ID`, `NOVA_RELAY_APNS_TEAM_ID`,
`NOVA_RELAY_APNS_TOPICS` (comma-separated bundle ids) and `NOVA_RELAY_APNS_SANDBOX=1` for the
sandbox gateway; FCM with `NOVA_RELAY_FCM_SERVICE_ACCOUNT_FILE` (the service account JSON). These
are the app publisher's credentials, which is why native push goes through the Relay and never
from a Hub.

Put TLS in front of it (a reverse proxy terminating HTTPS and passing WebSocket upgrades on
`/v1/relay/connect`). Envelopes are end-to-end sealed either way; TLS keeps route tokens and
metadata off the wire. Then, on the Hub: Network → Relay, the URL
(`wss://relay.example.org` or `https://…`), and turn it on (`PATCH /api/v1/relay`).

## Endpoints

| Method | Path | Authentication |
| --- | --- | --- |
| `GET` | `/v1/relay/health` | none: `{status, version}` |
| `POST` | `/v1/relay/hubs` | none, or the registration token; answers `{routeId, routeToken}` |
| `POST` | `/v1/relay/pairings` | Hub route token: `{id, codeHash, expiresAt, offer}`, at most 5 minutes |
| `POST` | `/v1/relay/pairings/:id/claim` | the code's hash (5 wrong ones burn the slot): `{codeHash, blob}`; answers the pending route and the Hub's sealed offer, and forwards the sealed blob to the Hub |
| `POST` | `/v1/relay/pairings/:id/confirm` | Hub route token: the route becomes active |
| `GET` | `/v1/relay/routes` | Hub route token: its client routes (no names) |
| `DELETE` | `/v1/relay/routes/:routeId` | Hub route token: open connections close with `revoked`; reconnects are refused |
| `POST` | `/v1/relay/push/register` | client route token: `{platform: apns\|fcm, token, topic?}`; the token's shape is checked (an APNs device token or an FCM registration token), and `topic` (a bundle id) only for APNs |
| `POST` | `/v1/relay/push/notify` | Hub route token: `{routes (1–50), notification: {id, category, title (≤ 80), link: nova://run\|code\|approval\|chat/<id> \| null}}`, nothing else; pushes to the Hub's own active routes with a registration, at most 30 per route a minute; answers `{ok, sent, skipped, failed}` |
| `GET` (WebSocket) | `/v1/relay/connect` | route token as `Authorization: Bearer` or the `bearer.<token>` subprotocol (with `nova-relay.v1`) |
| `POST` | `/v1/relay/messages`, `GET /v1/relay/outbox` | 501 `not_implemented`: the channel relay is not built (it was planned for M7 and is still missing) |

## Behaviour

- Route tokens (`nvr_…`) are stored as SHA-256 hashes. A revoked route's hash is kept 30 days so
  its token stays refused.
- A Hub reaches only its own confirmed client routes; a client only its Hub. Anything else gets a
  `close {reason: unknown_route}` frame (the connection stays). Frames from a pending client are
  dropped. A frame claiming another sender is dropped.
- Frames above 96 KiB close the connection with `close {reason: too_large}` (WebSocket 1009). A
  connection silent for 90 s closes with `idle` (4008). At most 2 connections per route; a newer
  one replaces the oldest (`normal`).
- The Relay answers each `ping` with a `pong` itself; pings are never forwarded.
- Frames for an offline route wait in a delivery queue (oldest dropped first everywhere; senders
  retransmit). An offline client with a push registration gets a content-free wake-up (at most one
  per 30 s), through the real APNs or FCM sender when one is configured (above), else the recording
  mock. A token the push service reports gone is dropped; the client registers a new one.
- A claimed route the Hub has not confirmed gets only the Hub's data frames on Hub-opened streams
  (its sealed `decided` notice when the request was denied or expired) and sends nothing until it is
  confirmed.
- Unconfirmed pairing claims are re-sent to the Hub when it connects; a claimed route that is not
  confirmed within 15 minutes is removed.

## Limits

One party must not be able to exhaust a shared Relay. The defaults (`DEFAULT_LIMITS` in
`src/server.ts`; `buildRelayServer({limits})` overrides any of them):

| Limit | Default | When reached |
| --- | --- | --- |
| Frame size | 96 KiB | `close {reason: too_large}`, WebSocket 1009 |
| Queue per route | 512 frames, 8 MiB | oldest frames of that route dropped |
| Queue per Hub (its own route and all its clients') | 32 MiB | oldest frames of that Hub dropped |
| Queue in total | 256 MiB | oldest frames anywhere dropped |
| Queue age | 2 minutes | dropped |
| Client routes per Hub (pending and active) | 100 | claim answers 429 `rate_limited` |
| Client routes in total | 100,000 | claim answers 503 `relay_full` |
| Hubs in total | 10,000 | registration answers 503 `relay_full` |
| Open connections in total | 20,000 | WebSocket closed with 1013 (try again later) |
| Connections per route | 2 | the newest replaces the oldest (`normal`) |
| Silent connection | 90 s | `close {reason: idle}`, 4008 |
| Open pairing slots per Hub | 20 | 429 |
| Wrong codes per pairing slot | 5 | the slot is burned |
| Hub registrations per address | 20 an hour | 429 |
| Claims per address | 30 a minute | 429 |
| A Hub with no client routes, not connected | forgotten after 24 h | its token stops working (the Hub registers again) |
| Any Hub not seen | forgotten after 30 days, with its client routes | their tokens stop working |

Tests: `npm test` in this folder (70 % lines enforced).
