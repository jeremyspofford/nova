# Domain, public ingress and bundled mesh (design, owner queue item 7, 2026-11-11)

**Sources:** the owner's batch of 2026-11-11, item 7, marked [DESIGN FIRST]
(`docs/builder-packet/INPUT-2026-11-11-OWNER-BATCH.md:82-89`), quoted here in full:

> Public name: nova.arialabs.ai. The domain is a name, not reachability: design a gated public
> ingress (console auth in front) while the tailnet stays the private path. Bundled networking: ship
> Headscale (BSD-3, open-source Tailscale control-plane implementation, works with official Tailscale
> clients) on the hub, on from first boot, as Nova's own mesh; hosted Tailscale remains the zero-config
> alternative. Note Headscale lacks Serve/Funnel equivalents — the ingress must be Nova's own work.

Its reconciliation with the ledger: `docs/builder-packet/nova-owner-batch-reconciliation-2026-11-11.md`,
item 7 (`:266-289`), conflicts C8 and C9 (`:37-38`, `:281-285`) and rulings R16, R17 and R18
(`:389-391`). The trust model: M4 §0 (`docs/plans/M4.md:25-66`). Networking: M10d and the build's hard
limits (`docs/plans/M10.md:105-110`, `:121-125`), and the orchestration ADR's tier table
(`docs/plans/M10-orchestration.md:50`, `:364`). LOCAL-FIRST-AND-DEVICE-MESH §3 to §5. OPERATING-RULES
on dependencies (`docs/builder-packet/OPERATING-RULES.md:19`). The self-investigation design for what
the loop would watch (`docs/plans/self-investigation-adr-2026-11-11.md`). Format follows that record
and `docs/plans/knowledge-graph-adr-2026-11-10.md`.

**Status:** PROPOSED, 2026-11-11. Docs only: nothing in Nova changes in this step, and no real
network, DNS, tailnet, Tailscale or Headscale setting was read for change or changed while writing it.
The owner marked the item [DESIGN FIRST], so nothing here is built until he rules on the list at the
end (S7-R1 to S7-R14, with R16, R17 and R18 carried over from the reconciliation). Where this record
states a builder's recommendation it says so; it decides nothing in the owner's place.

**Conflicts are presented, not resolved.** C8 (console auth in front of a public ingress, against M4's
loopback-only console) is in section 4 with both sides and its options, open under R16. C9 (Headscale on
from first boot, against M10's tier 3 with a dead-man's switch for every network change) is in section
7, open under R17.

**Every claim about today's code was read at `580fbbc27`** (main after PR #505) and carries a
`file:line`. Headscale's facts were checked against Headscale's own documentation on 2026-11-11
(section 6.1); one of the batch's facts reads differently there and is flagged, not corrected.

## What exists today

| Piece | Where | What it does now |
|---|---|---|
| Two listeners | `docs/plans/M4.md:29-43`; `src/core/mesh/access.ts:1-10` | The **console** (`NOVA_HOST:NOVA_PORT`, loopback by default) and the optional **mesh listener** ("the device door") for paired devices |
| Who is console | `src/core/mesh/access.ts:60-63` | Console listener, loopback peer, loopback `Host`, no forwarding headers (`forwarded`, `x-forwarded-*`, `tailscale-*`, `x-real-ip`, `:34`), not a browser task, no WebSocket upgrade. "A reverse proxy pointed at the console port is therefore not the console" (`:9-10`) |
| What a device may do | `src/core/mesh/access.ts:65-77`; `M4.md:47-51` | A `browser` or `phone` gets **what the console gets** except approving new devices and promotion (unless `can_approve`); a `computer` only device routes; a `standby` only sync routes |
| What anyone may reach | `access.ts:28-32`, `M4.md:44-46` | Enrollment routes, `/pair` and its assets, `/join.sh`, `/device-agent.tar`, `GET /api/v1/mesh/hello` (fingerprint, epoch, name) |
| Sessions | `M4.md:56-59`; `src/core/mesh/devices.ts:21` | Ed25519-signed session request, 12 h token (`SESSION_TTL_MS`), stored hashed; cookie `HttpOnly; SameSite=Strict; Secure` on HTTPS (`access.ts:94-96`); honoured only on the mesh listener (`:119-122`) |
| Mesh transport rule | `src/config.js:81-124` | `NOVA_MESH_URL` https with `NOVA_TLS_CERT`/`NOVA_TLS_KEY`, or http only with `NOVA_MESH_TRANSPORT=proxy|network`; plain HTTP otherwise refused at startup. **One** `NOVA_MESH_PUBLIC_URL`, the address QR codes and commands carry |
| Host allowlist | `src/server.js:330-334`, `:686` | Only loopback names, `NOVA_HOST`, the mesh bind host and the one public URL's host; anything else gets 421 (DNS-rebinding guard) |
| Client address behind a proxy | `access.ts:131-144` | The last `x-forwarded-for` entry, trusted only with `transport: proxy` and a loopback peer |
| Enrollment limits | `src/core/mesh/enroll.ts:106-111`, `:155`, `:212-213` | Per address (IPv6 by /64): 30 calls and 90 polls a minute, 10 wrong codes in 5 min; **hub-wide** 50 wrong codes in 5 min and 20 new codes an hour |
| Codes | `src/core/mesh/wire.ts:19-20`, `M4.md:75` | Crockford-32, 8 characters, 5 minutes, single use, commit-then-reveal with 6 matching digits |
| Tier 3 from a device | `src/core/approvals/routes.ts:1-5`; `src/core/api.ts:119-121` | On Nova's own screen tier 3 needs a passkey; **an approver device sends `{confirm: true}` alone** |
| Console passkeys | `src/core/passkeys.ts:1-12`, `:46-52` | WebAuthn on the hub's screen, `rp_id: 'localhost'` |
| Networking through chat | `src/core/network/index.ts:1-14`; `src/core/index.ts:646-656`, `:1885-1892` | Snapshot and diff (tier 1), apply (tier 3), dead-man's switch: no contact from a trusted, off-hub phone or browser on the mesh listener within `mesh.contact_window_s` (default 300 s), and Nova reverts |
| The stable name | `src/core/index.ts:875-908`; `src/core/mesh/handover.ts:17-20` | `NOVA_MESH_NAME_CONTROL` + `NOVA_MESH_NAME_TOKEN` move `NOVA_MESH_PUBLIC_URL` to a promoted hub; "only a loopback stand-in in this build" |
| Site | `src/core/index.ts:222`, `:781` | `NOVA_MESH_SITE` `home` or `cloud` |
| The owner's preview today | `docs/LEDGER.md:2829-2833`; `scripts/preview.sh:13-30`; `docs/builder-packet/HANDOFF-FROM-BUILDER-2026-11-01.md:166-176`; `docs/builder-packet/nova-versioning-changelog-2026-11-03.md:13-15` | The device door on loopback `:4320` with `transport: proxy`; Tailscale Serve `:9446` → door. The owner's own shim on `:4319` → Serve `:9445` (recorded as "console"). Builders never touch Serve, the shim or `nova-tailnet-proxy` |

**Not present anywhere in `src/` or the plans:** Headscale, a Funnel equivalent, a public ingress, an
ACME client, DNS management for a real zone, or a remote console role.

## Decision (proposed)

Treat `nova.arialabs.ai` as **a second front of the existing device door**, never of the console.
Three separable parts, each with its own rulings:

1. **The public name** (section 3): who owns the zone, which records exist, who holds the certificate.
2. **The gated ingress** (sections 4 and 5): a public path that admits only what M4 already admits from
   a device, with an edge gate that refuses before the app for anything without a device credential.
   Whether a person can ever reach a *console* this way is C8, open under R16.
3. **The bundled mesh** (sections 6 and 7): Headscale shipped with the hub as one *mesh provider*
   beside hosted Tailscale, managed as a supervised service; when it turns on is C9, open under R17.

```
 Public internet                         Private path (tailnet: Headscale or hosted Tailscale)
 ───────────────                         ───────────────────────────────────────────────────
 browser/phone                           paired phone/computer, standby
      │ https://nova.arialabs.ai               │ WireGuard
      ▼                                        ▼
 [ ingress edge ]  ── (option I-B: relay, TLS passthrough by SNI; I-A: hub port, needs router change)
      │ TLS terminates on the hub only
      ▼
 ┌──────────── hub ─────────────────────────────────────────────────────────────┐
 │  edge gate: device credential or refuse  →  mesh listener (the device door)  │
 │  console listener: loopback only, unchanged, never behind any ingress         │
 │  Headscale (supervised service)  ── control URL must be reachable by devices  │
 └──────────────────────────────────────────────────────────────────────────────┘
```

## 1. Hard limits kept by this design, and by any build of it until the owner lifts them

- **The console is never reachable through the public name or any proxy** (M4 §0; `access.ts:9-10`).
  Nothing here weakens `isConsole`.
- **No real network configuration is changed by a builder**: the owner's router, DNS, the
  `arialabs.ai` zone, Tailscale Serve settings, the shim on `:4319`, the hosted tailnet's policy
  (`M10.md:125`). Every build slice is tested against stand-ins.
- **No account is created** (no DNS provider, ACME account, relay host or Tailscale account) and no
  paid call or spend (`docs/plans/owner-priority-queue-2026-11-02.md:14`).
- **No new runtime dependency in core** (`M4.md:18`). Headscale is a separate supervised binary, not a
  library, and its addition is justified in its own PR (OPERATING-RULES:19).
- **Parked items untouched:** F-012, F-049 (no part of this uses `.github/workflows/handoffs.yml` or
  `handoffs/inbox/`), Jarvis promotion, D8, slice 1b of ADR #481, PR #207.

## 2. Threat model for a public name

**Assets.** The person's data and Nova's control (anything a `browser`/`phone` session can do is close
to the console, `access.ts:5-7`); the hub's identity key (`home/mesh/identity.json`); device sessions;
the vault; Headscale's state (its private keys and node registrations); the person's home IP address.

**Attackers.** (a) The whole internet: scanners, credential stuffers, botnets. (b) Someone who stole a
device session token or a paired phone. (c) Someone on the path (hotel Wi-Fi, a relay operator). (d)
Someone who controls DNS for the name, or obtains a certificate for it. (e) A paired but compromised
device.

### 2.1 What the public name exposes, and to whom

| Surface | Reachable by | Today on the tailnet | Proposed on the public name |
|---|---|---|---|
| Console | this machine only | no | **never** |
| Person routes (`scope: person`) | trusted browser/phone | yes | yes, behind the edge gate (S7-R2) |
| Device and sync routes | computer, standby | yes | **no** by default (they have the tailnet; S7-R3) |
| `GET /api/v1/mesh/hello` | anyone | yes | gated (S7-R4): it names the hub and its fingerprint |
| Enrollment (`/mesh/join*`), `/pair`, `/join.sh`, `/device-agent.tar` | anyone | yes | **not public** by default; pairing happens on the tailnet or the home network (S7-R4) |
| Headscale control URL and DERP | any device joining or roaming | n/a | must be reachable by devices wherever they are (section 6.3): a second public surface, of a third-party program |
| The person's home IP | — | hidden by Tailscale | exposed by option I-A, hidden by I-B (section 5) |

### 2.2 Threats and the controls that answer them

| Threat | Today's control | Gap on a public name | Proposed control |
|---|---|---|---|
| **Enumeration** (is there a Nova here, whose, which version) | `mesh/hello` returns name and fingerprint to anyone (`M4.md:46`) | Public scanners index it; the hub's name may be the person's name | Edge gate answers 404 to everything without a device credential, including `/`, `/pair` and `hello`; no `Server` or version header; certificate transparency still shows the name (section 3) |
| **Credential stuffing** | No passwords exist; sessions are Ed25519-signed (`M4.md:56-58`) | None for passwords. A stolen 12 h bearer token works from anywhere | Edge accepts a session only from a device key that signed it; S7-R5 asks for a shorter session on the public path and binding to the device key at each renewal |
| **Pairing-code guessing** | 40-bit code, 5 min, per-address and hub-wide limits (`enroll.ts:106-111`) | From the internet, attackers rotate addresses; the **hub-wide 50 per 5 minutes is a lockout lever**: anyone can stop the person pairing | Enrollment not on the public name (S7-R4). If the owner wants public pairing, the hub-wide limit's lockout effect is stated and accepted in the open |
| **Tier 3 from a stolen device** | An approver device confirms tier 3 with `{confirm: true}` alone (`approvals/routes.ts:4`) | Over the public name, a stolen session can revoke devices, approve enrollments (if `can_approve`) and apply network changes | **Security concern, top.** S7-R6: tier 3 arriving on the public path needs a passkey made for `nova.arialabs.ai`, or is refused there and done on the tailnet or the hub's screen |
| **DoS** | Enrollment limiter in memory (`limiter.ts:1-3`) | Floods on 443, TLS handshakes, slowloris; a home uplink saturates | Connection, header-time and body limits at the edge; per-address request budget before session check; a relay (I-B) absorbs volume and can be cut off without touching the hub; the tailnet path is unaffected by a public flood when they are separate listeners or ports |
| **DNS hijack or mis-issued certificate** | Devices pin the hub's key from the roster (`M4.md:113`) | A browser trusts any valid certificate for the name | Paired devices keep pinning the roster key; the web client checks `mesh/hello`'s fingerprint against its pinned one after load; CAA records limit issuers; DNSSEC where the registrar supports it (S7-R7) |
| **Header spoofing behind a proxy** | `x-forwarded-for` trusted only from loopback with `transport: proxy` (`access.ts:131-144`) | A relay that passes the client's header lets a client choose its rate-limit key | I-B passes TLS through by SNI and adds nothing; if a PROXY-protocol header is used, it is accepted only from the relay's pinned address |
| **DNS rebinding** | Host allowlist, 421 (`server.js:330-334`, `:686`) | The new name must be added | The public name joins the allowlist explicitly; nothing else does |
| **Headscale exposure** | n/a | A public control plane holds the mesh's keys; its CVEs become the hub's | Supervised as its own user with no access to Nova's home; upgrades tracked (section 6.4); admin API on a Unix socket or loopback only; S7-R10 |
| **Home IP disclosure** | Tailscale hides it | I-A publishes it in DNS | I-B by default (S7-R1) |

### 2.3 What never becomes reachable from the public name, under any option

The console listener; the passkey ceremony for the hub's screen (`rp_id: 'localhost'`,
`passkeys.ts:52`); sync and standby routes; the vault broker; Headscale's admin API and its database;
the Ollama and Screenpipe endpoints; `/__dev/events`; the OAuth callbacks that already refuse
non-loopback hosts (`server.js:609`).

## 3. The public name: DNS, certificates, ownership (R18)

**R18 is carried over, not duplicated:** whether the owner sets up DNS and certificates, or Nova does it
as a tier-3 networking change once built. This section lays out what either path involves.

**Records the design needs** (whatever R18 decides):
- `nova.arialabs.ai`: the ingress (an A/AAAA or CNAME to the relay under I-B; to the home address under
  I-A, which then needs dynamic DNS).
- A control-plane name for Headscale if it is public (for example `mesh.nova.arialabs.ai`; S7-R9).
- `CAA` on `arialabs.ai` or the subdomain naming the one issuer used.
- No wildcard record: each name is one surface.

**Certificates.** TLS terminates **on the hub**, never at a third party (LOCAL-FIRST §5: a relay is "a
dumb encrypted transport … never a plaintext data home"). The hub's mesh listener already takes
`NOVA_TLS_CERT`/`NOVA_TLS_KEY` (`config.js:97-100`). Ways to get one:
- **C-1, the owner provides it.** Files on disk; Nova warns 21 days before expiry. No ACME in Nova.
- **C-2, ACME HTTP-01 or TLS-ALPN-01 by Nova**, through the ingress path. Needs the name to resolve to
  the ingress first; works with I-B passthrough (the relay forwards port 443 by SNI).
- **C-3, ACME DNS-01 by Nova.** Needs a DNS provider API token in the vault: an account credential, so
  account rules apply (tier 3, the person present; `M10.md:110-113`). It is also a write path to the
  owner's zone.

A builder's note, not a recommendation: C-1 and C-2 keep Nova away from the zone; C-3 is the only one
that issues while the ingress is down.

**Certificate transparency.** Any publicly trusted certificate for `nova.arialabs.ai` is logged in CT
logs: the name's existence becomes public the day the certificate is issued, whatever the edge gate
does. That is inherent to a public name and is stated, not mitigated.

**Two names, one door.** `NOVA_MESH_PUBLIC_URL` is one address (`config.js:107-124`), and the host
allowlist takes that one name (`server.js:330`). A device paired on the tailnet holds the tailnet
address in its roster. Serving both needs the config to accept **a list of public URLs** with one
marked as the address told to new devices, and the roster to carry both (S7-R8). The stable-name driver
(`index.ts:875-908`) then moves both on promotion, or the public name follows the hub through the relay
(I-B needs no DNS change on promotion: the relay forwards to whichever node holds the hub role and
presents the right key).

## 4. The gated ingress and conflict C8 (options, not decided)

**The batch:** "design a gated public ingress (console auth in front)". **The ledger:** M4 §0, "A reverse
proxy (for example `tailscale serve`) pointed at the console port therefore gets **no** console
rights" (`M4.md:37`), and the model "tightens today's behaviour, never loosens it" (`M4.md:25`). The
console has no authentication of its own to put in front: it is defined by being on this machine.

Read side by side, "console auth" has three meanings, and each is an option under R16:

- **G-A. Device door only.** The public name reaches the mesh listener; a paired `browser` or `phone`
  gets its existing device rights. "Auth in front" is the edge gate requiring a device credential
  before any route. No M4 change. A person must have paired the device first, on the tailnet or at
  home. Consequence: a paired phone already gets nearly the console's rights (`access.ts:5-7`), so
  this is already powerful; S7-R5 and S7-R6 matter most here.
- **G-B. Device door plus passkey step-up.** G-A, and a WebAuthn passkey registered for
  `rp_id: nova.arialabs.ai` (a separate credential from the hub-screen passkeys) is required for
  tier 3 and for approving enrollments from the public path. Tightens a paired device's rights on the
  public path only. M4 amended in the open to add the step-up; it loosens nothing.
- **G-C. A new authenticated remote console.** A third principal, `remote-console`, created by passkey
  on the hub's screen, with console rights over the public name. **This loosens M4 §0**, which the
  model forbids without the owner amending it. It also brings back exactly what M4 removed: a network
  path to everything.

**Builder's reading, not a ruling:** G-A and G-B fit M4 as written; G-C needs the owner to amend M4's
"never loosens" line explicitly. Which one is R16.

### 4.1 The edge gate (common to G-A and G-B)

A small layer in front of the mesh listener on the public port, in core, with no new dependency:

1. TLS handshake limits; header and body time limits; per-address connection cap.
2. Host must be exactly the public name (otherwise 421, as today).
3. A request with no valid device session gets **404 with an empty body** for every path, including
   `/pair` and `hello`, unless S7-R4 admits them. No redirect to `/pair` on the public name (today's
   unauthenticated navigation redirects there, `access.ts:178-182`).
4. A valid session from a `computer` or `standby` is refused on the public port (S7-R3).
5. Then the existing `Access.gate` and the API's scope checks run unchanged.

**How a browser gets a session on the public name without pairing there:** it doesn't. The device
pairs on the tailnet or at home and keeps its device key (`ui/js/device-key.js`); on the public name it
signs a fresh session request with that key. The session endpoint itself is the one route the edge
admits without a session, limited per address and requiring a known device's valid signature, so a
stranger gets a uniform refusal (S7-R4 covers this).

## 5. Ingress transports (Nova's own work)

Headscale's stable documentation lists no Funnel (section 6.1), so reaching the hub from the internet
is Nova's to build. Options under S7-R1:

| | I-A: port on the hub | I-B: Nova relay, TLS passthrough | I-C: third-party tunnel |
|---|---|---|---|
| How | Router forwards 443 to the hub; dynamic DNS | The hub keeps an outbound connection to a small relay (a `cloud` site, `NOVA_MESH_SITE`); the relay forwards 443 by SNI, never decrypting | Cloudflare Tunnel or similar |
| Real network change | Router (tier 3, dead-man's switch) | None at home; a relay host to run | None at home |
| Home IP | Published | Hidden | Hidden |
| Works behind CGNAT | No | Yes | Yes |
| Who sees plaintext | Hub only | Hub only | **The tunnel provider** (TLS ends there), against LOCAL-FIRST §5 |
| Account or spend | None | A small host: owner's account and money | Provider account |
| DoS absorbed by | Home uplink | Relay (can be cut off without touching the hub) | Provider |
| "Nova's own work" | Yes | Yes | No |

**Builder's recommendation, not a ruling:** I-B. It is the only one that keeps TLS on the hub, hides
the home address, survives CGNAT and needs no router change. Its cost is a relay host the owner pays for
and a small relay program Nova ships (SNI forwarding plus an authenticated outbound tunnel from the
hub, pinned by the hub's identity key). I-C is listed because it is the common answer, and rejected
by this record on the plaintext point; the owner may still choose it.

## 6. Headscale on the hub

### 6.1 Facts checked against Headscale's own documentation (2026-11-11)

| Batch's statement | Headscale's documentation | Status |
|---|---|---|
| BSD-3 | "BSD-3-Clause license" (https://github.com/juanfont/headscale) | Agrees |
| Open-source Tailscale control-plane implementation | "a self-hosted, open source alternative to the Tailscale control server" (https://headscale.net/stable/about/features/) | Agrees |
| Works with official Tailscale clients | Supports "the last 10 releases of the Tailscale client"; Linux, BSD, Windows, Android, macOS, iOS, tvOS, some with extra setup (https://headscale.net/stable/about/clients/) | Agrees, with a version window and per-platform setup |
| Lacks Serve/Funnel equivalents | **Stable docs** list Funnel and Serve only with open issues (#1040, #1921). **The `main` branch's features page** marks Serve `[x]` and Funnel `[ ]` (https://raw.githubusercontent.com/juanfont/headscale/main/docs/about/features.md). Latest release v0.29.7, 2026-10-30 | **Differs in part: flagged.** Funnel: no equivalent, agrees. Serve: unsupported in the stable docs, but the development docs mark it supported, so it may arrive in a later release. Not corrected here (S7-R13) |

Further facts the design depends on, same sources:
- "a _single_ Tailscale network (tailnet)" per Headscale (https://github.com/juanfont/headscale).
- "We recommend the use of SQLite"; PostgreSQL is in "maintenance mode"
  (https://headscale.net/stable/about/faq/).
- Upgrades go version to version "without skipping minor versions in between" (same FAQ).
- **"Running headscale on a machine that is also in the tailnet can cause problems with subnet routers,
  traffic relay nodes, and MagicDNS. It might work, but it is not supported."** (same FAQ). The batch
  puts Headscale on the hub, and the hub must be in the mesh to be reached through it. **Flagged:**
  that is the configuration Headscale's maintainers call unsupported (S7-R11).
- TLS: own certificate, or built-in Let's Encrypt over HTTP-01 (port 80) or TLS-ALPN-01 (port 443)
  (https://headscale.net/stable/ref/tls/).
- Embedded DERP server available (features page).
- Tailscale's own documentation: "A device is not able to transmit packets on multiple tailnets
  simultaneously." (https://tailscale.com/kb/1225/fast-user-switching).

### 6.2 Shape

- **Mesh providers.** A setting `mesh.provider`: `none`, `hosted` (the person's hosted Tailscale; Nova
  only reads), `headscale` (bundled). The existing transport rule is unchanged: Nova still serves the
  device door only with TLS or a stated `network` transport (`config.js:81-84`).
- **Process.** Headscale runs as a supervised service under `src/supervisor/services.ts`, its own OS
  user, its own state directory outside Nova's home (`headscale/`), admin API on a Unix socket readable
  only by the hub process. The binary is pinned by version and SHA-256 in the repository, fetched once
  at install (the "download" is the person's install step, not a builder's).
- **The hub as a node.** Either the hub's `tailscaled` joins its own Headscale (unsupported per the FAQ),
  or it runs in a separate network namespace or container on the hub, or Headscale runs on another
  node (the standby or the relay). S7-R11.

### 6.3 Reachability of the control plane

Devices must reach Headscale's `server_url` to join and to roam (a phone on mobile data re-registers
with the control server). With the hub at home, that URL is either:
- on the public name through the same ingress (I-B forwards `mesh.nova.arialabs.ai` by SNI to
  Headscale on the hub), which makes Headscale a **public** surface; or
- reachable only at home, which means a phone that leaves home keeps its WireGuard peers but cannot
  join, re-key or pick up changes until it is back.

DERP (relay of last resort when peers can't connect directly) works over HTTPS and passes through I-B;
STUN (UDP 3478) does not pass a TCP SNI relay, so direct connections are less likely and more traffic
is relayed. A builder's note: hosted Tailscale has none of these problems; that is what
"zero-config" buys.

### 6.4 Lifecycle, upgrades, backups, keys and ACLs

- **Install:** at first boot or at setup (C9, section 7). Creates the Headscale config from a template
  Nova owns, one Headscale user for the household, one ACL policy file.
- **Upgrades:** Nova ships a pinned Headscale version per Nova release, upgrades one minor at a time as
  the FAQ requires, through the supervisor's release slots with a smoke probe (`/health` of
  Headscale) and rollback. A database snapshot precedes each upgrade. Tier 3 (it is networking).
- **Backups:** Headscale's SQLite database and its noise private key are in the nightly backup and the
  restore drill, **encrypted with the vault's key like other secrets**. Losing the private key forces
  every node to re-register; losing the database loses every node registration.
- **Keys:** pre-auth keys are minted by Nova only during pairing, single use, short-lived, tied to the
  pairing request (a paired device gets its tailnet key in the same approved flow, so hub-side
  approval stays the one gate: LOCAL-FIRST §3). No reusable keys. Node expiry on.
- **ACLs:** Nova owns the policy file and generates it from the device registry: phones and browsers
  reach only the hub's door port; computers reach the hub's device port and each other only where a
  role needs it (M10f); the standby reaches the sync port. Default deny. A policy change is a network
  change: tier 3 with the dead-man's switch (`network/index.ts:1-14`), with Headscale as a network
  target.
- **Revocation:** revoking a device in Nova also deletes its Headscale node in the same step; a failed
  delete is a red problem, never silent.
- **Promotion:** if the hub moves, Headscale's database and private key move with the backup lineage;
  until then the old hub's Headscale keeps serving or the mesh freezes (S7-R12).

### 6.5 Coexistence with the owner's hosted tailnet and Serve ports

- A device can be on **one tailnet at a time** (Tailscale's documentation above). A phone on the
  owner's hosted tailnet cannot be on Nova's Headscale tailnet at the same time; switching cuts the
  other. That is the central coexistence fact.
- The owner's existing Serve ports (`:9445`, `:9446`) and shim (`:4319`) live on the hosted tailnet.
  Nothing in this design touches them. With `mesh.provider: hosted`, today's preview set-up continues
  as it is.
- **Devices already enrolled** keep their Nova device keys and sessions; Nova pairing is independent
  of the transport. Moving them to Headscale changes only how packets reach the hub: each device
  joins the Headscale tailnet (leaving the hosted one), and its roster gains the new address
  (S7-R8). No re-pairing is needed. Their old address stops working the moment they leave the hosted
  tailnet, so the migration is per device, person present, one at a time, with the dead-man's switch
  counting the device that stays behind.
- **Security concern, to be checked by the owner, not by a builder:** the handoff records the shim
  on `:4319` feeding a Serve port labelled "console" (`nova-versioning-changelog-2026-11-03.md:13-15`).
  M4 makes a proxy pointed at the console port a stranger, *if* the forwarding headers arrive
  (`access.ts:34`, `:54-56`). A shim that connects from loopback with a loopback `Host` and strips
  every forwarding header would be the console, reachable by every node on the hosted tailnet. This
  record does not inspect the owner's shim (it is off limits); the owner confirms which (S7-R14).

## 7. "On from first boot" and conflict C9 (options, not decided)

**The batch:** "ship Headscale … on the hub, on from first boot". **The ledger:** "Networking (router,
DNS, firewall, Tailscale): tier 3, always", with snapshot, diff, apply and a dead-man's switch
(`M10.md:105-110`; for clusters `M10-orchestration.md:50`), and the build's hard limit: "No change to
any real network configuration" (`M10.md:125`).

A fact that shapes the options: **at first boot no device is paired, so the dead-man's switch has
nobody to confirm contact** (`network/index.ts:10-14` counts trusted off-hub phones and browsers). A
switch armed then would always revert, or never be meaningful.

- **H-A. On from first boot, local only.** Headscale starts at first boot bound to loopback and the
  home network only, with no public control URL, no DNS, no router change. It changes nothing outside
  the hub, so it is arguably not a "network change" in M10's sense; it becomes one (tier 3, switch)
  the moment it is published on the ingress or its ACL is changed. Needs the owner to rule that
  "starts a local control server" is not networking under M10d.
- **H-B. Installed at first boot, off until setup.** Present and ready; the setup interview offers it,
  and turning it on is tier 3 with the switch armed after the first device pairs.
- **H-C. Offered only.** Hosted Tailscale stays the default; Headscale is a later choice in Settings,
  tier 3.

Every option keeps the build's hard limit: no builder turns Headscale on against a real network.
Which option is R17.

## 8. Failure postures: what the person sees

Wording follows the problem conventions (`src/core/log.ts:11-23`): amber unless work stops.

| Failure | What happens | What the person sees |
|---|---|---|
| Hub offline | The relay (I-B) answers the public name with a static page it holds: no data, no name | On the public name: "Nova isn't reachable right now. It may be off or offline at home." On the tailnet: the PWA's existing offline posture |
| Relay down (I-B) | The public name fails; the tailnet path is unaffected | Health, amber: "Nova can't be reached from outside your home: the relay isn't answering." with the time since |
| Certificate expires in 21 days | Renewal attempted (C-2/C-3) or a warning (C-1) | Health, amber: "The certificate for nova.arialabs.ai runs out on <date>." |
| Certificate expired | The public name's TLS fails; Nova never serves without TLS (`config.js:102-103`) | Health, amber: "The certificate for nova.arialabs.ai ran out on <date>, so Nova isn't reachable from outside. The tailnet still works." |
| Headscale down | Existing WireGuard peers keep working for a while; no joins, no re-keys, no policy changes. The supervisor restarts it with backoff | Health, amber: "Nova's own network control isn't running. Devices already connected keep working; new ones can't join." |
| Headscale database or key lost | Restore from the drilled backup; if none, every node re-registers | Health, red: "Nova's network lost its records. Each device has to join again." with the steps |
| DNS points elsewhere | Paired clients see a hub fingerprint mismatch (section 2.2) | On the device: "This isn't your Nova. Don't sign in." and a red problem on the hub when it learns of it |
| Public-path DoS | Edge limits engage; the relay can be paused | Health, amber: "Nova is refusing a flood of requests from outside. Your devices on the tailnet aren't affected." |

## 9. What self-investigation would watch here

Mapped onto the invariants of `docs/plans/self-investigation-adr-2026-11-11.md` §1, as new signals
for I3 and I6. All repairs that would touch networking are fix class **F5**: steps for the person,
never applied by the loop (`self-investigation-adr-2026-11-11.md:225`).

| Invariant | Signal | Fix class |
|---|---|---|
| The public name resolves to the expected ingress | A periodic resolve, compared with the configured target | F5 (person) |
| The certificate is valid for 21 days or more | Expiry read from the served certificate | F1 for an ACME renewal retry if R18 lets Nova renew; F5 otherwise |
| The public name serves the hub's fingerprint | `hello` through the public path from the relay, compared with the identity key | F5; a mismatch is red |
| Headscale is up and its version is the pinned one | Supervisor service state, Headscale health | F1 (`restart-runtime`-like restart), as other services |
| Every trusted device has a Headscale node and no node lacks a trusted device | Registry against Headscale's node list | F5: an orphan node is a security finding, never auto-deleted by the loop |
| The ACL policy in Headscale equals the one Nova generated | Digest comparison | F5 |
| The edge refused more than N requests in a window | Edge counters | Evidence only |
| The relay tunnel is connected | Tunnel heartbeat | F1 reconnect |

## 10. Security concerns, explicitly

1. **A paired phone or browser is nearly the console** (`access.ts:5-7`), and an approver device
   confirms tier 3 with `{confirm: true}` alone (`approvals/routes.ts:4`). Putting the device door on
   the internet turns a stolen session or phone into remote control, including network changes and
   device approvals. S7-R5 and S7-R6 exist for this; G-B answers it.
2. **The hub-wide wrong-code limit is a lockout lever** once enrollment is public
   (`enroll.ts:110`, `:213`). Keep enrollment off the public name (S7-R4).
3. **Headscale becomes a public, internet-facing control plane** if roaming devices must reach it
   (section 6.3), and it runs on the hub that holds the vault. Separate OS user, no access to Nova's
   home, admin API not on the network, pinned versions, CVE tracking (S7-R10).
4. **Headscale on a node of its own tailnet is unsupported upstream** (section 6.1; S7-R11).
5. **A third-party tunnel (I-C) sees plaintext**, against LOCAL-FIRST §5.
6. **Certificate transparency publishes the name** the day a certificate is issued.
7. **DNS-01 (C-3) puts a zone-write credential in the hub's vault**: a compromise of the hub can then
   repoint the owner's domain.
8. **The owner's `:4319` shim, labelled "console", needs his check** (section 6.5; S7-R14).
9. **Two public URLs** (tailnet and public name) widen the host allowlist; each name must be added
   explicitly, never by pattern (S7-R8).

## 11. Acceptance criteria for a later build

Each becomes at least one test that fails on the code before it. All run against stand-ins: a loopback
"public" listener, a stand-in relay, a stand-in Headscale binary, a stand-in DNS resolver, a stand-in
ACME server. None touches a real network.

1. No request through the public listener is ever `console`, whatever its peer, Host and headers
   (property test over header combinations, including a shim that strips forwarding headers).
2. Without a valid device session, every path on the public listener returns the same 404 with an empty
   body and no `Server` or version header; timing does not reveal whether a path exists.
3. A `computer` or `standby` session is refused on the public listener (unless S7-R3 says otherwise).
4. Enrollment routes, `/pair`, `/join.sh`, `/device-agent.tar` and `hello` are unreachable on the public
   listener under the default (S7-R4).
5. Under G-B, a tier-3 request on the public listener without a passkey for the public `rp_id` is
   refused before the route runs; the same request on the tailnet behaves as today.
6. The public name is added to the host allowlist exactly; a look-alike host gets 421.
7. A paired device's session started on the tailnet can be renewed on the public name by signing with
   its device key; a stranger's signature gets the uniform refusal.
8. The roster carries every public URL; a device reconnects on the other when one fails.
9. With `mesh.provider: hosted`, nothing about today's preview set-up changes (existing M4 and mesh
   tests pass unchanged).
10. A Headscale stand-in that dies is restarted by the supervisor and raises the amber problem of
    section 8; joins wait.
11. Revoking a device deletes its Headscale node in the same step; a failed delete is red.
12. Pre-auth keys are single use, expire with the pairing request and are never logged.
13. The generated ACL denies everything not derived from the registry; a changed policy goes through
    the network worker with the dead-man's switch, and a stand-in that "loses contact" reverts it.
14. Headscale's database and key are in the backup, encrypted, and restored by the drill.
15. Certificate expiry inside 21 days raises the amber problem; an expired certificate stops the public
    listener, never falls back to plain HTTP.
16. The self-investigation signals of section 9 open incidents with the right invariant; none of their
    fixes applies a network change.

## 12. Slices (smallest useful first)

1. **The edge gate on a loopback stand-in, no real network.** A second mesh front ("public") on a
   loopback port in tests only, the edge gate (section 4.1), the uniform 404, the computer/standby
   refusal, the enrollment exclusion, and acceptance criteria 1 to 4 and 6. Ships nothing that listens
   on a real interface: the public front cannot be configured outside tests until the owner rules on
   S7-R1 and R16. Value: the gate that every option needs, proven before any exposure exists; it also
   adds the property test for criterion 1 that hardens today's console check against shims.
2. **Multiple public URLs in config and roster** (S7-R8), criteria 7 and 8. Still no real network.
3. **G-B step-up** if R16 chooses it: a public-`rp_id` passkey for tier 3 on the public path,
   criterion 5.
4. **Headscale as a supervised service against a stand-in binary**, provider setting, keys bound to
   pairing, ACL generation, revocation, backup and drill; criteria 9 to 14. No real Headscale run by a
   builder.
5. **The relay (I-B) and certificates** per S7-R1 and R18, stand-ins only; criterion 15.
6. **Self-investigation signals**, after that design's slice 1; criterion 16.
7. **The owner's own switch-on**, on his network, person present, tier 3 with the dead-man's switch:
   not a builder's step.

**Proposed first slice:** slice 1. It changes no real network configuration, needs none of the open
rulings (it is the gate common to G-A and G-B, and the public front stays test-only), and every later
slice stands on it.

## Rejected alternatives

- **Point a proxy at the console and add a login.** M4 §0 forbids it; it is G-C by the back door.
- **Tailscale Funnel.** Not available with Headscale (stable docs), terminates TLS at Tailscale's edge,
  and is not Nova's own work.
- **A wildcard certificate and record.** Widens what the name covers for no need.
- **Pairing on the public name by default.** Opens the code-guessing and hub-wide lockout surface to
  the whole internet for a step that is rare and can happen on the tailnet.

## Consequences

- The public name adds a surface whose only content is the device door, behind a gate that refuses
  strangers before any route runs.
- Headscale adds a supervised third-party service, its backups, its upgrade cadence, and (if roaming
  must work) a second public surface.
- Choosing Headscale means each device leaves the hosted tailnet to join Nova's; the two cannot be used
  at once on one device.
- The tailnet stays the private path in every option; the public path is optional and can be turned
  off without touching it.

## Ruling list for the owner

Carried over from the reconciliation, not duplicated: **R16** (C8: device door only, or a new
authenticated remote-console role; section 4 sets out G-A, G-B and G-C), **R17** (C9: Headscale's start
and coexistence; section 7 sets out H-A, H-B and H-C, and section 6.5 the coexistence facts) and
**R18** (who sets up DNS and certificates; section 3 sets out C-1, C-2 and C-3).

- **S7-R1:** the ingress transport: I-A (a port on the hub through your router), I-B (a Nova relay with TLS passthrough, on a host you pay for), or I-C (a third-party tunnel that sees plaintext)?
- **S7-R2:** which person routes the public name serves: all of them, or a reduced set (for example chat, tasks, memory reads), with the rest tailnet-only?
- **S7-R3:** may computers and the standby ever use the public name, or are they tailnet-only?
- **S7-R4:** is enrollment (codes, `/pair`, `join.sh`, `hello`) ever reachable on the public name, or only on the tailnet and home network?
- **S7-R5:** device sessions on the public path: keep 12 hours, or shorter (for example 1 hour, renewed by the device key)?
- **S7-R6:** tier 3 arriving on the public path: refused there (do it on the tailnet or the hub's screen), allowed with a passkey for the public name, or allowed as today with `confirm: true`?
- **S7-R7:** DNS hardening for `arialabs.ai`: CAA naming one issuer, DNSSEC, both, or neither?
- **S7-R8:** may the mesh carry a list of public URLs (tailnet and public name), with each name added to the host allowlist explicitly?
- **S7-R9:** Headscale's control URL: public through the ingress (roaming devices work, a second public surface), or home-only (devices re-key only at home)?
- **S7-R10:** Headscale's isolation on the hub: its own OS user and state directory, a container, or on another node (standby or relay)?
- **S7-R11:** given Headscale's FAQ calls a Headscale server that is also in its own tailnet unsupported, accept that on the hub, isolate the hub's node in its own namespace, or run Headscale elsewhere?
- **S7-R12:** on hub promotion, does Headscale's state move with the hub (backup lineage), or stay on a node that never changes role?
- **S7-R13:** the batch says Headscale lacks Serve; the stable docs agree but the development docs mark Serve supported. Design as if Serve never arrives, or revisit when a release ships it?
- **S7-R14:** please confirm what your shim on `:4319` (behind Serve `:9445`, recorded as "console") forwards to and which headers it passes, since a header-stripping shim to the console port would give every node on your tailnet console rights.
