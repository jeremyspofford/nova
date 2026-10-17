# @nova/relay

The Relay protocol (FR-137, `docs/22` §3, `contracts/rest-api.md` §3, ADR-071, ADR-094): sealed
envelopes, the reliable per-stream session, the WebSocket connection to a Relay, pairing through a
Relay, and the API tunnel. The Hub (`packages/core/src/relayhub`), the self-hosted Relay
(`services/relay`) and clients (the PWA, native apps) all use it. It runs in Node and in browsers:
the only primitives are WebCrypto (X25519, Ed25519, HKDF-SHA256, PBKDF2-SHA256, SHA-256) and
`@noble/ciphers` (XChaCha20-Poly1305); there are no `node:` imports.

## Pieces

| Module | What it does |
| --- | --- |
| `envelope.ts` | `RelayEnvelope`, `validateEnvelope` (the rules of `contracts/schemas/relay-envelope.json`, plus `reason` only on `close`, `seg.i < seg.n`, `ct` must be base64), `parseEnvelope` with the 96 KiB frame limit, `associatedData` |
| `crypto.ts` | X25519 keys, per-direction session keys, `seal`/`open`, Ed25519, the pairing-code secrets |
| `session.ts` | `RelaySession`: per stream, 64 KiB segments (up to 256, 16 MiB), in-order delivery, cumulative acks (standalone or riding on data), a window of 256 unacked segments, retransmit after 5 s, resume after reconnect from the last acked seq, duplicate and out-of-window drops, 60 s reassembly timeout, at most 32 MiB held for reassembly or out-of-order delivery (plus the next message in order), and an admission check per new stream that may be asynchronous (the Hub stores its replay floor before a request runs) |
| `streams.ts` | Stream ids (`c…` client-opened, `h…` Hub-opened, growing counters) and `StreamGuard`, which accepts each peer stream once above a floor that survives restarts |
| `connection.ts` | `RelayConnection`: one outbound WebSocket, the route token as the `bearer.<token>` subprotocol, `ping` every 25 s, close after 3 missed pongs, exponential backoff with jitter, no reconnect after `revoked` or an unauthorized token |
| `pairing.ts` | The Hub's sealed offer and the client's sealed claim; `confirmationCode` (the Add Device confirmation both screens show) |
| `tunnel.ts` | Tunnel messages and `TunnelServer` (the Hub side: one request per client stream, streamed responses with backpressure; the request's random id is echoed in `head`; failures reach the client only as a generic `server_error`) |
| `client.ts` | `pairWithRelay` and `RelayClient` (`fetch` over the tunnel, `waitForPaired`); an answer whose request id is not the request's is refused; a request the Hub calls stale is sent again once only if it is a GET or HEAD |

## Using it from a client

```ts
import { RelayClient, generateEd25519, pairWithRelay } from '@nova/relay';

const device = await generateEd25519(); // the Add Device key; keep it
const { paired, confirmation, addPairingId } = await pairWithRelay({
  relayUrl, relayPairingId, code, // from the QR payload
  device, name: 'Ada’s phone', platform: 'ios', kind: 'browser',
});
show(confirmation); // the owner approves on the Hub when both screens match
const client = new RelayClient({ paired });
client.start();
const { requestId } = await client.waitForPaired();
// Poll GET /api/v1/devices/add/status/:requestId through client.fetch (signed with the device
// key) for the device session, then call the Hub API with it:
const res = await client.fetch('/api/v1/threads', { headers: { authorization: `Bearer ${token}` } });
```

`paired` holds the route token and the session keys: store it like a session token. The event
stream works through `fetch` (`/api/v1/events/stream`, read the body as it arrives); the Hub's
WebSocket does not.

## Security notes

- The Relay sees routing ids, frame kinds, sequence numbers and sizes, never content. Every data
  segment is sealed with client, stream, seq and seg as associated data.
- Acks travel outside the seal (the schema gives ack frames no `ct`): a forged ack can only make a
  sender stop resending, which a Relay could do anyway by dropping frames.
- The pairing code never reaches the Relay: it gets a PBKDF2-stretched hash (600,000 iterations,
  salted with the Relay pairing id) to check claims against, and both pairing blobs are sealed
  with keys derived from the code.
- Route tokens authenticate to the Relay only. The Hub authenticates a tunneled request by the
  device session token in its own Authorization header.
- `isSecureRelayUrl`: a Relay URL must be https/wss, or http/ws to this machine only, so route
  tokens and pairing metadata never cross a network in clear.
- Known limitation: session keys are static per pairing (X25519 static-static), so there is no
  forward secrecy; a later compromise of either side's X25519 private key exposes recorded
  traffic of that pairing. Re-pairing rotates the keys.

Tests: `npm test` (vitest; 90 % lines / 85 % branches enforced).
