---
status: accepted
date: 2026-10-17
extends: ADR-089 (bearer tokens for compute nodes and `novad`), ADR-071 (the content-blind Relay)
---

## Context
M6.5 built Add Device (FR-132), signed `novad` builds and `novad install` (FR-133), the Hub
identity and trust paths (FR-134), endpoints and transports with health checks and mDNS
(FR-135), the Network Setup assistant (FR-136), the Relay ahead of its M7 milestone (FR-137),
the Wake Helper (FR-138), network diagnostics with one-click rollback (FR-139) and the device
management UI (FR-140). Building them, and fixing what two security reviews found, settled
choices the spec left open. The most consequential: Add Device became a commit-then-reveal
handshake, because a review showed that a party on the network path could grind a device key
until it produced the same six-digit confirmation in seconds; and `novad` and compute nodes still
talk to the Hub with bearer tokens over plain HTTP, so the install's integrity rests on a pinned
identity key and Hub signatures rather than TLS. The details are in `docs/22` and
`contracts/hub-api.md` §1, §3, `contracts/rest-api.md` §3; the entry in
[`../20-decisions-and-defaults.md`](../20-decisions-and-defaults.md) links here.

## Decision

### Add Device (FR-132, FR-140)
1. **Commit-then-reveal (v2).** `complete` carries the code, the device's Ed25519 key and a
   commitment, base64url SHA-256 of `nova-add-device-commit-v1|<publicKey>|<deviceNonce>`; the
   Hub consumes the code and answers with its own 32-byte nonce; `reveal` sends the device nonce,
   signed by the device key. The confirmation is SHA-256 of
   `nova-add-device-v2|<fingerprint or ''>|<pairingId>|<publicKey>|<CODE>|<deviceNonce>|<hubNonce>`
   read as a big-endian integer mod 10^6. A party in the middle gets one guess in a million per
   code.
2. **Hub-signed reveal and the pin.** The reveal answer carries `hubSignature`, the Hub
   identity's signature over `nova-add-device-reveal-v1|<requestId>|<pairingId>|<publicKey>|<confirmation>`
   (null without an identity, or when signing throws). A device with a pin checks that hello's
   `hubPublicKey` hashes to it and verifies the signature before showing the digits; a null or bad
   signature with a pin is a hard stop. Every device compares the Hub's digits with its own.
3. **The Relay path keeps v1** (`nova-add-device-v1|<fingerprint>|<pairingId>|<publicKey>|<CODE>`):
   its claim travels sealed with a key derived from the code, so a party on the path never sees
   the code.
4. **Windows.** A commit must be revealed within 2 minutes; a revealed request waits 10 minutes
   for the owner; after approval the device has 10 more minutes to collect its grant. A status
   poll while committed answers `pending`; the reveal does not advance `last_poll`.
5. **The code in memory.** The consumed code is kept in Hub memory only until the reveal (at most
   2 minutes), so a Hub restart in between expires committed requests. For Relay pairings the code
   is kept in memory until the pairing is used or expires; after a restart a Relay claim without the
   code is refused.
6. **Burning and refusals.** A wrong nonce or signature at the reveal burns the request (`denied`,
   `bad_reveal`) and counts as a wrong code on its pairing; a correctly signed reveal with a stale
   time is refused without burning. A second reveal is 409 `already_revealed`. Burned or never
   revealed requests are never shown to the owner.
7. **Codes.** 8 characters of Crockford base32 without I, L, O and U, shown `ABCD-EFGH`, read
   case-insensitively with O as 0 and I, L as 1; single use, 5 minutes, stored as hex SHA-256 of
   `nova-add-device-code-v1|<pairingId>|<CODE>` (also the Relay claim's `codeHashCheck`). Five
   wrong codes burn a pairing; 20 starts per account per hour.
8. **`pairingId` optional; a code-only budget.** A typed code (and `novad install` without
   `--pairing`) finds its pairing alone; its wrong guesses spend an account budget (10 per
   5 minutes, then code-only completes are refused for 5 minutes, 429 `code_only_locked`) instead of
   every open pairing's attempts. The QR, the install commands and the join link carry the pairing
   id; the install command builders now always pass it.
9. **410 code.** An expired, used, burned or unknown pairing is `request_expired` (410) with
   `details.reason: expired`, alike (no oracle); the protocol's `expired` code does not exist.
10. **Grants.** The first approved status poll hands out the grant exactly once: a device session
    (an `auth_token` of kind `session` made as `AuthService` makes them, tied to the device in
    `device_session`; a browser also gets the session cookie) for a browser or app, or a one-use
    `nvd_`/`nve_` enrollment token bound to the device key and the pending record approval created,
    plus a device certificate when the trust mode issues one. A grant that fails to issue is put
    back for the next poll.
11. **Revocation during issuance.** The device's status is re-checked inside the transaction that
    inserts the session; a device revoked before or while it collects gets `denied` and no
    session, now or later, and certificates are not issued to revoked devices.
12. **Deny race.** A deny takes effect only while the request is still pending; if an approval
    won, deny is 409 and writes no audit row, event or listener call.
13. **Kinds and names.** The compute role takes kind `compute` or `novad`; a client takes
    `browser`, `native` or `novad`; a Wake Helper only `novad`. The name the owner gives on the Hub
    wins over the device's. The record's kind is `compute`, `wake-helper` (a `novad` helper) or
    `client`.
14. **Roles.** A registering `novad` keeps only the declared roles the owner approved (falling back
    to the approved list): its own document can narrow its roles, never widen them.
15. **Start answer.** `add/start` also returns `role`, `scopes`, `transport`, `deepLink`,
    `endpoints` (at most 4 healthy http(s) ones) and `relay`; the QR query carries `p`, `fp`, `e`,
    `r`, `rp`, the code only in the `#c=` fragment. `bootstrap` carries `command`, `powershell` and
    `why`.
16. **Scripted paths stay.** `add/start` no longer hands out a token; `POST
    /api/v1/devices/compute/enroll` (new) and `/devices/novad/enroll` keep the M2/M6 tokens, whose
    creation with a session is the owner's approval.
17. **Revocation covers every kind.** `POST /devices/:id/revoke` tries a compute node, a `novad`
    device, then a browser, app or approved-but-unregistered device. Every revocation deletes the
    device's sessions, records its key in `revoked_device_key`, refuses tokens and grants bound to
    it, and revokes its certificates and Relay client. Only revoked keys are blocked; a denied or
    expired request does not block its key.
18. **Public route limits.** `complete` and `reveal` 10 a minute and `status` 120 a minute per
    client address (an in-memory sliding window), 429 `address_rate_limited`.
19. **Web UI.** The Hub never displays the confirmation: the device shows it and the owner types
    it ("On the Hub, type this code to approve…"). No scope is on by default. The Relay choice
    appears only when `relay.enabled` is on. After approval the join page waits for Open Nova so
    the install help can be read. The QR is an SVG drawn in the browser, black on white in both
    themes. A request is found by the live event plus a check every 5 s. A lost connection keeps the
    commit and resends the reveal; any refusal stops. Polls use the Hub's clock when the device's
    is more than 10 s off. The `nova://add-device` deep link maps to `/add-device` with only the
    fields that validate.

### Signed `novad` builds and install (FR-133)
20. **The manifest.** `novad-manifest.json` `{version, files: [{name, os, arch, sha256, size}],
    hubFingerprint, signedAt}`, its version from a `VERSION` file in `NOVA_NOVAD_DIST`; builds named
    `novad-<os>-<arch>[.exe]`, symlinks followed, empty files and files over 512 MiB skipped. The
    signature is standard base64 Ed25519 by the Hub identity over the domain tag
    `nova-novad-manifest-v1\n` followed by the exact manifest bytes (so no other statement the
    identity signs can pass as one), re-signed only when something changes. Without an identity the
    manifest is served unsigned and the `.sig` is 404.
21. **The dist route is public.** It serves only listed builds, the manifest and its signature, is
    rate-limited (60 a minute per address) and sends `no-store`.
22. **HTTP only.** `novad` has no TLS client: `novad install` refuses an `https://` Hub, and the
    command builder returns null with the reason for an https or loopback Hub address. The pin, the
    signed manifest and the Hub-signed confirmation carry the integrity; the code and tokens are
    readable on the LAN, as for `enroll`.
23. **`--pin` required, `--pairing` optional** for `novad install`; the command always passes both.
24. **Checks before anything is written.** The Hub key matches the pin, the manifest signature
    verifies, and the binary's own SHA-256 is in the manifest. The device key stays in memory until
    approval, and a data folder already enrolled is refused.
25. **Hash and install the same bytes.** `novad` reads its binary once, hashes those bytes, writes
    exactly them to `/usr/local/bin/novad` and hashes the installed copy again before enabling the
    service.
26. **The command.** It computes the hash with `sha256sum`, else `shasum -a 256`, and compares it
    in the shell (nothing reads standard input). The code is piped with the shell's `printf`
    builtin into `novad install --code -` (a pipe survives `sudo`, which drops the environment);
    `NOVA_ADD_CODE` also works and the PowerShell command sets and removes it. Root is checked
    first and the command adds `sudo` when needed.
27. **Polling.** Status polls use the Hub's clock from its `Date` header, each strictly later than
    the last.
28. **Service setup.** The binary is copied to `/usr/local/bin/novad`; Linux runs `systemctl enable
    --now`, macOS `launchctl load -w`, Windows `sc.exe`.

### Hub identity and trust (FR-134)
29. **The identity.** An Ed25519 key at `secret://hub/identity`, its public half kept in
    `trust_identity`. If the database records a key and the vault lacks it, holds another or cannot
    be read, the identity refuses to load (`identity_missing`, `identity_mismatch`,
    `identity_unavailable`) and never generates a new one; a key in the vault with nothing recorded
    is adopted. While it is down, hello fields are null, nothing is issued, the identity statement
    answers 409, and the Hub still starts. Rotation is not built.
30. **Modes.** `local-ca` serves the CA's certificate and, with `meshCerts`, the mesh certificate to
    clients that name the mesh host; `mesh` serves only the mesh certificate and stays plain HTTP
    until one exists. Switching between HTTP and HTTPS needs a restart; certificate changes apply
    live (renewals go through `watchTrust`, which logs a failure and keeps the current
    certificates). `trust.mode` defaults to `none`.
31. **Keys in the vault.** The CA, Hub TLS and mesh keys are vault entries
    (`secret://hub/ca/<id>/key`, `secret://hub/tls/<id>/key`, `secret://hub/tls/mesh/<id>/key`),
    not files; signing is rare, so asynchronous access is fine. Keys of retired CAs and of
    superseded or revoked certificates are deleted from the vault.
32. **Name constraints.** Permitted: `local`, `localhost`, `home.arpa`, `internal`, the private,
    loopback, link-local and CGNAT ranges, `::1`, `fc00::/7` and `fe80::/10`, plus the Hub's names
    of two labels or more at creation. Single-label names are never added (`dev` would cover every
    `.dev` site); `lan`, `home` and `localdomain` are not reserved, so they are not permitted. A name
    added later outside the constraints is left out of the certificate and reported. `hubNames` no
    longer lists the bare host name, only `<name>.local`.
33. **The CA is never replaced on its own.** A missing or mismatched CA key is a problem
    (`ca_key_missing`, `ca_key_mismatch`) and the current certificate keeps being served. Only
    `POST /api/v1/trust/renew {target: "ca"}` replaces it (`all` never does): the new key goes into
    the vault first, then one transaction retires the old CA and inserts the new one (SQLite checks
    the one-active-CA index per statement, so the old row is retired first, inside the
    transaction).
34. **Device certificates.** Only in `local-ca` mode, OU = role, SAN `urn:nova:device:<id>`,
    365 days, client authentication only; device ids may not contain dots, so the name can never
    look like a host name. No renewal yet.
35. **Identity statement.** `GET /api/v1/trust/identity` requires `?nonce=` (16–64 base64url
    characters), echoes it and signs it, so a statement cannot be replayed; `checkHubIdentity`
    in `@nova/core` is the reference check. The pinning procedure in `docs/22` §5 accepts only a
    listed leaf or mesh hash, or a server certificate (serverAuth, a SAN for the dialed host, not a
    CA) of the listed CA; device certificates never pass.
36. **Start fallback.** If the trust certificates cannot be read at start and no explicit
    certificate is set, the Hub binds plain HTTP to `127.0.0.1` only, even with `NOVA_HOST=0.0.0.0`,
    and reports `fallbackReason`.
37. **Audit kind `network`** for trust actions (the core audit kinds have no `trust`); system
    actions are attributed to the owner account and not audited before setup.
38. **No Apple profile.** `ca.mobileconfig` would mean reproducing Apple's profile format; the Hub
    serves `ca.crt` (DER), which phones open to install.

### Endpoints, transports and Wake Helper routing (FR-135, FR-138, FR-139)
39. **The probe** is a real `GET <url>/api/v1/hello` over a fresh connection with 300 ms for all
    its requests, passing only for a Nova Hub, and for this Hub: once the fingerprint is known the
    hello must carry it and `GET /api/v1/trust/identity?nonce=` must return a statement for a fresh
    nonce signed by the pinned key. HTTPS is checked against Node's default roots
    (`getCACertificates('default')`, so `NODE_EXTRA_CA_CERTS` and the system store count) plus the
    Hub CA. One failure withdraws an endpoint and the next success re-adds it (no hysteresis).
40. **Relay candidates** with `wss://` URLs keep the health their source reports.
41. **LAN candidates** follow the listener address; loopback and IPv4 link-local are left out
    unless the settings say otherwise; IPv6 link-local never; container, VM bridge and tunnel
    interfaces are skipped; the CGNAT range and Tailscale's IPv6 range count as Mesh. Priorities:
    IPv4 10, mDNS 11, IPv6 12, Mesh 20+, Relay 30+, Direct public 40.
42. **mDNS** runs only while LAN is advertised, the setting is on and the Hub does not listen on
    loopback only; it answers with healthy addresses only; the TXT record is `v=1` plus `fp=`; the
    `.local` name is checked by connecting to a LAN address with that Host header. It uses
    `multicast-dns` 7.2.5 (MIT).
43. **Host names.** `hostNames()` lists `<name>.local` while mDNS runs and the direct public host
    only while Direct public is on; the Hub adds them to its Host allowlist.
44. **PATCH /network** refuses turning every transport off and Direct public without a URL; the
    switches only change advertising and never close a listener, so it cannot lock the owner out.
    It is all or nothing.
45. **Retention.** Probe history 7 days, transport events 90 days.
46. **Concurrency.** Concurrent `POST /network/test` calls share one running check; a second
    rollback while one runs is 409 `rollback_in_progress`.
47. **Wake Helper matching.** The exact `power.lan` subnets `novad` reports, else the endpoint
    address with the prefix of the Hub interface on that network, else /24 or /64. The broadcast is
    always computed from the subnet (a reported one is ignored), and `power.lan` has a schema (IPv4
    network, /1 to /30, no host bits). Loopback and mesh addresses never match. The Hub's own
    fallback is a directed broadcast that uses only the target's filtered addresses and leaves only
    by physical LAN interfaces (never mesh ranges, tunnels or bridges, `wg0` included); a target
    whose only address is loopback is 409 `no_wake_helper`.
48. **The wake limit counts attempts.** The count and a `pending` row go in one transaction before
    the helper is called, and pending, sent and failed attempts all count; 0029 rebuilds
    `wake_request` to allow `pending`.
49. **novad's Wake Helper** runs in the supervisor rather than the management module, so its limit
    of 10 a minute survives module restarts; only ports 9 and 7; the broadcast must be on a physical
    IPv4 subnet read from `/proc/net/route` (Linux only).
50. **`GET /network` lists recent wakes** (`wakeHelpers.recent`, the newest 20, with `via`).

### Network Setup (FR-136)
51. **Secrets per CLI.** Tailscale reads the auth key from `--auth-key=file:/dev/stdin` (on
    Windows from a 0600 temp file in the data folder, deleted right after); NetBird gets
    `NB_SETUP_KEY`; a remote Headscale gets `HEADSCALE_CLI_ADDRESS` and `HEADSCALE_CLI_API_KEY` in
    the environment; a Headscale pre-auth key goes from the CLI's output into the vault (rollback
    drops it from the vault but does not expire it on the server: it is single use and lasts an
    hour); WireGuard keys are made with `node:crypto`, kept in the vault and written to a 0600 file
    under the data folder while the interface is configured, since `wg-quick` reads the private key
    only from its config file. Typed secrets are deleted once `mesh.up` succeeds or is undone, and
    all of a run's once nothing in it is applied.
52. **CLI versions assumed** (only fakes were exercised): Tailscale 1.7x (`debug prefs`,
    `cert --cert-file=- --key-file=-`), Headscale 0.26 (`nodes approve-routes`, `policy get/set`,
    `preauthkeys --user <id>`), NetBird `status --json`.
53. **Consent** is remembered per change kind and provider, granted by sending back the exact step
    description, and covers only that exact text: a different description asks again (`changed:
    true`) and replaces the old consent. Descriptions hold no run-specific file paths.
54. **Lock-out guard.** Each step lists what applying and undoing it could cut. A request the Hub
    can vouch for as local is never blocked; loopback, or any request with `x-forwarded-for`,
    `forwarded`, `x-real-ip` or `x-forwarded-host`, counts as `unknown` and needs another healthy
    path the step does not touch; only `useRequestTransport` (the Relay tunnel's `relay:` address)
    can mark a request's transport. WireGuard AllowedIPs map to paths: LAN when they overlap a LAN
    subnet, Mesh for `100.64.0.0/10`, Relay and Direct public for anything public, all four for
    `0.0.0.0/0` or `::/0`.
55. **Automatic rollback** when an expected path fails its reachability test after the retries
    (5, 2 s apart), when the step's own check fails, or when the owner's own path stops answering.
    Without a reachability test connected, steps that expect one fail closed.
56. **Failed undo.** A step whose undo fails becomes `rollback_failed` with both errors, is audited
    and announced, makes the run `failed`, refuses to apply again (`rollback_pending`) and is
    retried by the next rollback. Every undo command runs and their errors are reported together.
57. **Rollback with the setting off.** Rollback works while `network.setup.allowSystemChanges` is
    off (it puts back what the owner had) and the audit records the setting's value; applying
    needs it. The certificate and Relay steps go through the trust and relay areas and are not host
    changes.
58. **Headscale ACLs** only add rules; with no policy (allow-all) the allow-all rule is kept; tag
    owners are `user@`. Only Headscale's own "acl policy not found" counts as no policy: any other
    read error stops the step, the merge uses the policy read at snapshot time, and the undo writes
    that original text back.
59. **ufw** gets only `allow` rules and is never enabled, reset or given a deny rule; the undo
    deletes only rules that are present.
60. **The command runner.** Argument lists through `spawn`, never a shell; a timeout (60 s by
    default) kills the program's whole process group; a call settles on exit (plus 200 ms for late
    output) or the timer; a small fixed environment; CLIs found only in fixed system folders (and
    `%LOCALAPPDATA%\Microsoft\WindowsApps` for `winget`), never the inherited `PATH`, and the
    child's `PATH` is that list. `NOVA_NETWORK_TOOLS_FILE` (`{bins, baseEnv}`) names other programs
    instead; only whoever starts the Hub can set it, its use is logged, and an unreadable file stops
    the start. The setup lock is taken before the first await and released in `finally`; calls to
    the other areas are capped (60 s, certificates 180 s).
61. **Manual steps** (described, never run): Headscale MagicDNS, NetBird routes, DNS and exit node,
    WireGuard routes and exit node, WireGuard on Windows. A client joined to another control server
    is not taken over without `replaceExisting`.
62. **Relay URLs** in setup options refuse whitespace and quotes.

### The Relay (FR-137)
63. **Keys.** Each side has a separate X25519 key for the Relay; each X25519 public key travels in
    a sealed pairing blob, signed by that side's Ed25519 key (the device key, or the Hub identity
    when loaded). The Hub's X25519 key is imported non-extractable.
64. **Session keys.** One per direction, HKDF-SHA256 over the X25519 shared secret, the info
    binding a fixed label, both routing ids, the client id, both X25519 public keys and the
    direction.
65. **Sealing.** XChaCha20-Poly1305 (`@noble/ciphers` 2.4.0, MIT) with a random 24-byte nonce;
    `ct` is base64 of nonce, ciphertext and tag; the associated data is the JSON array
    `["nova-relay-v1", client, stream, seq, seg.i, seg.n]`. The library has no `node:` imports and
    runs in browsers.
66. **The pairing code never reaches the Relay.** PBKDF2-SHA256, 600,000 iterations, salted with
    the Relay pairing id, gives the hash the Relay checks claims against, the key that seals the
    Hub's offer and the key that seals the client's claim.
67. **The Hub picks the Relay pairing id**, because the hash and the offer are bound to it; the
    Relay refuses a duplicate.
68. **The claim** reaches the Hub as a data frame on stream `pair.<pairingId>`; unconfirmed claims
    are re-sent each time the Hub connects and never queued. A claim never touches an existing
    client: if its insert does not add exactly one row it is dropped and audited
    (`client_conflict`); refusals and the request-id update change only the pending row the claim
    created; a claim after its slot expired is refused; decisions must match the client's account
    and request id. Every refusal is audited as `relay.pair` `refused` with its reason.
69. **Stream ids and floors.** A side prefix and a counter that only grows (max(previous + 1,
    ms × 1024)); the Hub stores the highest client counter per client (`stream_floor`) before the
    stream's first message is delivered, and a failed write refuses the stream. A client whose
    clock went backwards gets a sealed `stale` notice and retries once, for GET and HEAD only.
70. **Acks are not sealed** (the schema gives them no `ct`); a forged ack can only stop resends.
71. **Relay behaviour.** It answers pings itself; `unknown_route` is a per-frame `close` and the
    connection stays; frames above 96 KiB close with `too_large` (1009); a connection silent for
    90 s closes with `idle` (4008); at most 2 connections per route, the newest replacing the
    oldest; close codes 4001 unauthorized and 4003 revoked; revoked route tokens stay refused 30
    days; an unconfirmed claimed route is removed after 15 minutes. The route token travels in an
    Authorization header or as the `bearer.<token>` subprotocol next to `nova-relay.v1`.
72. **Relay limits.** Queues bounded per route (512 frames, 8 MiB), per Hub (32 MiB) and in total
    (256 MiB), oldest dropped first; 100 client routes per Hub (429) and 100,000 in total (503
    `relay_full`); 10,000 Hubs (503) and 20,000 connections (1013); a Hub with no client routes
    unseen for 24 hours, and any Hub unseen for 30 days, is forgotten; state writes are debounced
    (1 s) and asynchronous. `--trust-proxy` takes a hop count (1–10) or proxy addresses and CIDR
    ranges; `true` is refused.
73. **Validation is slightly stricter than the schema:** `reason` only on close frames,
    `seg.i < seg.n`, `ct` valid base64.
74. **The tunnel.** One stream per request; `head`, `body` chunks of 256 KiB, `end`; a random
    request id echoed in `head` and `error` (a mismatch is `bad_response`); the Hub dispatches with
    `inject`, an allowlist of request headers (no cookie, origin or x-forwarded), `Host:
    localhost` and `remoteAddress: relay:<clientId>`. Only the normalised `/api/v1/*` path is
    reachable (normalised with `new URL`; `%2e`, `%2f`, `%5c`, backslashes and `//` refused in the
    path), not `/api/v1/ws`. Bodies pause at 4 MiB unacked and are dropped at 16 MiB; a session
    holds at most 32 MiB for reassembly. The client gets a generic `server_error`; the real error
    goes to the Hub log.
75. **A Relay that forgets the Hub** marks the registration `rejected`. With no paired clients the
    Hub registers again by itself, at most once a minute; with clients it reports `error` and the
    owner turns the Relay off and on, and the clients pair again. Replaced registrations' tokens
    and keys leave the vault.
76. **Only revoked keys are blocked** (Add Device's list plus this registry's `revoked` rows); an
    expired decision is stored as `expired`.
77. **Secure URLs.** A Relay URL must be https or wss; http or ws only to loopback, checked in the
    setting and in the connector. `relay.selfHosted: false` with an empty URL falls back to
    `wss://relay.arialabs.ai`; nothing is contacted while `relay.enabled` is off.
78. **`last_seen_at`** is updated only after a frame opens with the client's key.

### Web (FR-139, FR-140)
79. **Network surface.** A top-level sidebar entry, `/network` and `/network/:section`, tabs on
    desktop and pages on phones; the host-changes switch sits at the top of Network → Setup and asks
    first; network settings are saved with `PATCH /api/v1/network` (so each save is audited and can
    be rolled back), not the generic settings route; detection runs when Setup opens. The QR code
    library is `qrcode` 1.5.4 (MIT).
80. **Found by J8.5 and fixed.** The join page checks for a secure context first and says the Hub
    needs HTTPS (it had reported a missing Web Crypto as a wrong Hub); the web settings store
    reloads on `settings.changed`, so a setting saved through another route (the Relay's) reaches
    every page; the Relay endpoint takes its health from the connector and a connector change runs
    the endpoint checks at once; a transport turned off is logged as `off`, not as a failure.
    `novad install` waits the Hub's 10-minute pending window after the reveal, not the 2-minute
    reveal deadline.

## Consequences
A man in the middle of an Add Device join can no longer get its own key approved by matching the
digits; a typed code cannot burn the owner's pairings; a device can no longer grant itself a role.
A Hub restart between commit and reveal costs that one join. Because `novad` and compute nodes
still use bearer tokens over plain HTTP, the code and the granted token are visible on the LAN
during an install; the pin, the signed manifest and the Hub-signed confirmation keep a party on the
path from substituting the binary or its own key. The Hub's identity and CA are never silently
replaced, so a vault problem shows up as a trust problem instead of breaking every pin; replacing
the CA is an explicit owner action that every device must follow. Network Setup refuses rather
than risk locking the owner out, which makes it strict for a browser on the Hub itself. The Relay
works end to end from the library, the server and the Hub, but no shipped client pairs through it
yet.

## Known limitations
- `novad` and compute nodes: bearer tokens over plain HTTP; no TLS client in `novad`; device
  certificates are issued but nothing checks them (mutual TLS is M7).
- A device session is a full owner session; scopes other than `offline-replica` and
  `local-runtime` are recorded, not enforced.
- The Relay has no forward secrecy (static-static X25519 per pairing; re-pairing changes the
  keys); two tabs on one paired record get replies only on the newest connection; push
  registration accepts any device token; real APNs/FCM senders and the channel relay are M7; the
  Hub sends no notification pushes; the Hub's connector cannot register with a Relay that requires
  a registration token; a client's floor for Hub-opened streams is in memory unless the app
  persists it; pairing over the Relay needs the QR (no typed code).
- No client calls `selectEndpoint` yet; the web app uses the origin it was loaded from.
- No identity rotation, no device-certificate renewal, no `ca.mobileconfig`.
- mDNS has no name-conflict probing and no answer throttle; the Hub has no IPv6 WoL fallback.
- Network Setup has no elevation, assumes vendor package repositories, never installs Headscale
  and was exercised only against fake CLIs; `relay.enroll` and the certificate step run with
  `allowSystemChanges` off; a rollback through the setup routes does not mark the network change
  log's entry.
- `novad` on Windows is untested (key generation reads `/dev/urandom`) and its macOS service setup
  is untested; `novad uninstall` is not built.
- Diagnostics `problems` are free text; `mesh` and `relay` in the diagnostics view are untyped.
- `GET /api/v1/session` does not say which device a session belongs to; the web app keeps "this
  device" in local storage.
