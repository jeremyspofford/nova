# Transport and thin-client access (owner decision 10), Nova v4

## Summary

- **A transport only moves bytes; it never establishes identity.** Identity comes from four things that already exist or are pinned at pairing:
  - the device's ed25519 key (`devices_ws.py:52-67`);
  - core's pubkey, pinned on the agent (`client.go:182`);
  - a per-link bearer;
  - one new piece: **a pinned self-signed TLS certificate on every non-loopback agent-facing listener, in both directions.** An address is only a locator. When it changes, the locator is updated and identity does not move.
- **There are four locator kinds behind one seam:**
  - `host`: the hub's own machine;
  - `tailnet`: Tailscale SaaS;
  - `headscale`: a self-hosted control server;
  - `lan`: no overlay.
  - `tailnet` and `headscale` share every code path. Only the control URL and the join material differ.
- **There are two doors on the hub, and they never mix:**
  - The **browser door** is `web`, as today. Tailnet `serve --https=443` fronts it (`start.sh:148-166`).
  - The **agent door** is a new `edge` container. It speaks TLS with a hub certificate minted by core and serves exactly three things: the agent WebSocket, enroll, and agent downloads. On tailnet and headscale, the sidecar forwards raw TCP 8443 to it. On LAN it is published on one private address.
  - Agents always dial the edge with the hub pin, except `host`, which keeps `http://127.0.0.1:3000`.
  - This also removes two current failure modes: tagged tailnet nodes get no identity header and so are gated (`nginx.conf.template:130-133`), and headscale cannot issue HTTPS certificates.
- **Agent models listener:** TLS with the agent's own pinned certificate on every transport, including inside WireGuard.
  - The gateway's `engines.client(row)` therefore has a single code path.
  - Through the sidecar proxy it becomes a CONNECT tunnel.
- **Tailscale first.** The agent embeds tsnet, so the machine needs no Tailscale app. There are two join paths:
  1. **Login link.** The link is printed in the install terminal. For an already-paired machine, it is shown as a `tailnet_login` card, which is never persisted and never enters her context.
  2. **Optional owner OAuth client.** Nova mints a single-use, pre-authorized, tagged key per machine, puts it only in the card or inside a signed envelope, and revokes it if unused.
  - The hub sidecar stays. It gains the outbound proxy (as in the baseline), a status file core can read, and login without `TS_AUTHKEY`.
- **Headscale** is a seam: the same tsnet with a ControlURL, and the sidecar uses `--login-server`.
  - Deferred items: the headscale compose service, headscale key minting, and phones. Phones need a public domain with a trusted certificate for headscale itself, and even then the PWA has no trusted origin, because headscale does not implement `tailscale cert`.
- **LAN** relaxes the rail by exactly two listener kinds:
  - the edge on 8443 on one RFC 1918/ULA address;
  - an agent's models listener on one interface address.
  - Plus mDNS on the hub agent, for relocating a moved hub only.
  - The web UI never appears on the LAN. Three independent pins enforce this: `deploy/exposure_test.sh`, `deploy/edge/edge_test.sh`, and core's `edge_guard`.

## What changes vs the baseline

| Baseline item | Status |
|---|---|
| Hub sidecar userspace; `TS_OUTBOUND_HTTP_PROXY_LISTEN` for gateway→remote engines; `ProviderUnreachable` never walled; P0-7 | **Kept.** Verified in `cmd/tailscaled/proxy.go`: CONNECT is hijacked, and plain HTTP goes through `httputil.ReverseProxy`, which flushes SSE and `ContentLength -1` responses immediately. |
| Per-link bearer, one-use code, `code` card never persisted, star topology, no SSH | **Kept** |
| `decide_subnet` and the 172.18 collision fix | **Kept**, plus a macOS route reader (`netstat -rn -f inet`; `ip` does not exist there) |
| Node tailscale sidecar + Python node-agent | **Replaced** by the agent's tsnet plus its models role (decision 9). Nodes run no overlay container. |
| Engine CHECK "base_url https://*.ts.net" | **Replaced**: https to any host, plus a `tls_cert_pem` pin, plus `transport` |
| `tailnet_origin` (observed only) | **Generalised** to `access_origins`, with the sidecar status file as the authoritative source for the tailnet name. `machine_add_code`'s "no tailnet origin observed yet" refusal goes. |
| Install requires `TS_AUTHKEY` (`install.sh:537-614`); `start.sh` exits on NeedsLogin (`:128-134`) | **Changed**: the key is optional. The wrapper waits, writes the AuthURL to the status file, and stays unhealthy until approved. |
| P0-12 (can WSL novad reach the tailnet URL) | **Moot** for agents on tsnet |
| `code_claim` guard | **Extended** into `credential_claim` (tskeys, login URLs) |
| S44 `nova_address` / OpenElsewhere | **Extended** to one section per access mode |

## Components

| Component | Owns |
|---|---|
| `apps/novad` → agent: `internal/transport` | Go `Transport` interface: `HubClient(ctx) *http.Client`, `ListenModels(ctx) net.Listener`, `Facts() NetFacts`, `Close()`. Implementations are `overlay` (tsnet, ControlURL empty or headscale), `lan` and `host`. |
| agent `internal/pin` | Self-signed ECDSA P-256 certificate (IsCA, SAN `nova-agent-<device_id>`), SPKI sha256, and a pinned `tls.Config` (`InsecureSkipVerify` plus a `VerifyConnection` SPKI check, which runs before any application bytes) |
| agent `internal/discovery` | mDNS `_nova._tcp` advertise (hub agent) and browse (agents; used only after N failed dials); build-tagged |
| `edge` compose service (new) | TLS termination with core's certificate; path allowlist; fixed address `NOVA_EDGE_ADDR` |
| core `app/network.py` | Transport availability (derived), hub locators, status-file reader, `access_origins`, choice at code mint |
| core `app/edge_tls.py` | Mints the edge certificate at startup when absent; `spki()` |
| core `app/tailscale_api.py` | OAuth token; keys create/get/delete; devices list; device key expiry; policy get/validate/post with If-Match via a `hujson-patch` helper |
| core `app/secret_box.py` | "A-0": AES-256-GCM using `/state/secrets/secret.key` (a Proposal A shape) |
| gateway `engines.client` (Area A's module) | Transport-aware dial: proxy choice, `cadata` pin, bearer |
| sidecar `start.sh` | The only writer of `/run/nova-status/tailscale.json`; serve mode `https` (Tailscale) or `http+tcp` (headscale); plus `--tcp=8443 → edge` |

**Where the transport is recorded**

| Fact | Store | Writer |
|---|---|---|
| Hub overlay kind, control URL, name, IPs, key expiry, AuthURL | `v4_tailnet_status` file (raw `tailscale status --json` plus the serve mode) | `start.sh` only. Core mounts it read-only and derives from it. Nothing is stored. |
| Edge certificate and pin | `v4_edge_tls` volume | core (`edge_tls`) |
| LAN bind | `.env` `NOVA_LAN_BIND` (bootstrap only, because it is a compose port) | `install.sh` |
| Transport chosen for a code; tsnet key id | core `pairing_codes.transport`, `tailnet_keys` | `machines.add_code` |
| Transport observed per machine | core `devices.facts.net` plus `devices.last_transport`, derived from provenance: `client.host == NOVA_EDGE_ADDR` ⇒ edge, the docker gateway ⇒ host | `devices_ws.authenticate` |
| Locator for the agent's models role | gateway `engines.transport`, `providers.base_url`, `engines.tls_cert_pem`/`tls_pin` | `engines.create`/PUT, from core only (enroll, and `on_facts` when the LAN IP changes) |

## Per-OS matrix

V = verified or working today; W = walk planned on Jeremy's hardware; CI = cross-compiled and tested, including real tsnet against `testcontrol`; M = needs measurement; U = unwalked.

| Capability | Linux | macOS | Windows native | Windows + WSL |
|---|---|---|---|---|
| Agent joins the overlay (tsnet, userspace, no TUN or admin) | W, mini PC | CI, U | W, Dell (M: firewall and ProtonVPN, direct vs DERP) | W, Dell WSL (M: NAT, direct vs DERP) |
| Login link surfaced (terminal, `UserLogf`; card via IPN bus) | W | CI, U | W | W |
| Tagged-key join (OAuth) | W (needs owner OAuth client) | CI, U | W | W |
| headscale ControlURL | M in phase (b) | CI (testcontrol is a custom control URL), U | M: issue #16840, syspolicy overrides ControlURL on Windows | M |
| Models listener over tsnet (no OS inbound rule) | W | CI, U | W, M | W, M |
| Models listener on LAN (one interface address, TLS, bearer) | W, M ufw | U: LaunchDaemon (root, exempt from Local Network privacy) or a TCC grant; app firewall | W, M: installer adds a `netsh advfirewall` rule (elevated) | **Not supported** from WSL NAT: use the native agent |
| Agent → hub edge, pinned, outbound | W | CI; LaunchAgent is subject to Local Network privacy, so use a LaunchDaemon; U | W | W |
| mDNS advertise/browse | M, avahi coexistence | U, mDNSResponder coexistence | M, Windows mDNS + firewall | multicast does not cross NAT: native agent |
| Hub edge publish | V (docker publish) → W | U: Docker Desktop publish, source IP not preserved | n/a | M (T4) |
| Hub sidecar (userspace container) | W, mini PC | U (same image) | n/a | V (the Dell today) |
| Gateway → remote agent via the sidecar proxy | W, P0-7 | U | — | — |
| Gateway → agent on the LAN, direct egress | W | U | — | M |
| Gateway → hub-host agent (`host-gateway` / `host.docker.internal`) | M (T11) | U (for Metal Ollama on a Mac hub) | — | M |
| Thin client PWA: tailnet | W (phone) | U | W (Edge/Chrome) | — |
| Thin client PWA: headscale, LAN | not installable (no trusted HTTPS); stated | | | |
| Hub installer | bash → W | bash 3.2: CI (`install_test.sh` on a macos runner, `/bin/bash` 3.2), U live | **Unsupported** (no bash); seam is `nova-agent hub install` | V (the Dell today) |

## Data model and migrations

Verified at HEAD `0531b496`: the highest core migration is `034_attachments.sql` and the highest gateway migration is `008_probe_vram_frame.sql`. No local branch ref carries core 035+ or gateway 009+. Doing-things claims core 035 on paper only. The baseline takes core 035–037 and gateway 009. This area therefore takes **core `038_network.sql`** and **gateway `010_engine_transport.sql`**. If S40 has not landed when this is built, fold 010 into 009. Whichever lands second renumbers.

**`038_network.sql`**

- `pairing_codes ADD transport text CHECK (transport IN ('host','tailnet','headscale','lan'))`, and `ADD tailnet_key_id text`.
- `devices ADD last_transport text` (the same CHECK), plus `net` inside the baseline's `facts`.
- `access_origins(kind text PK CHECK in ('tailnet','public','custom'), origin text NOT NULL CHECK (origin ~ '^https?://[a-z0-9.-]+(:[0-9]+)?$'), source text CHECK in ('sidecar_status','observed'), first_seen, last_seen)`. This replaces the baseline's `tailnet_origin`, which was never built.
- `network_credentials(id smallint PK CHECK id=1, kind CHECK = 'tailscale_oauth', client_id text, secret_ct bytea, nonce bytea, key_fp text, tailnet text DEFAULT '-', tags text[] CHECK cardinality ≥ 1, scopes text[], verified_at, last_error, created_at)`.
- `tailnet_keys(key_id text PK, code_id uuid FK pairing_codes ON DELETE SET NULL, machine_name, tags text[], expires_at, used_at, revoked_at, revoke_reason)`. It never holds the key itself.

**`010_engine_transport.sql`**

- `engines ADD transport text NOT NULL DEFAULT 'builtin' CHECK in ('builtin','host','tailnet','headscale','lan')`.
- `ADD tls_cert_pem text`, `ADD tls_pin text CHECK (tls_pin ~ '^sha256/[A-Za-z0-9+/]{43}=$')`.
- `CHECK (transport='builtin' OR (tls_cert_pem IS NOT NULL AND tls_pin IS NOT NULL))`.
- Replace the baseline's `*.ts.net` provider CHECK with `base_url ~ '^https://'` for non-builtin ollama rows.

**Secret storage (A-0).**

- What the OAuth secret is: it can mint keys that join devices into the owner's tailnet, and with `devices:core` it can delete or retag `tag:nova-node` devices.
- How it is stored: AES-GCM with a 32-byte key in a file on a **separate** volume `v4_core_state`, mode 0600. This follows Proposal A's `/state/secret.key` choice, "not `data/`" (`ROADMAP.md:210-231`).
- What that protects: a database dump or leak alone.
- What it does not protect: anyone holding both volumes, or host root.
- How it relates to Proposal A: A later absorbs the same key file and table, and provider keys (`003_providers.sql:22`) and the core signing key stay plaintext until A.
- If A lands first, use A's store and drop A-0.
- The move archive must carry `v4_core_state`. Otherwise Nova states "stored credential cannot be decrypted, re-enter in Settings".

## Wire contracts

**Card command.** Core renders it and the web shows it with per-OS tabs. It is never persisted.

- POSIX (`<door>` is the edge on the hub's tailnet IP, or the LAN IP):
  `curl -fsSL --pinnedpubkey 'sha256//<b64>' -k -o nova-agent https://<door>:8443/agent/linux-amd64 && ./nova-agent install --hub https://<door>:8443 --hub-pin sha256/<b64> --transport tailnet --code 7KQ2M9XP [--tailnet-key tskey-auth-…]`
- Windows: the same with `curl.exe` (ships with Windows 10+; Schannel pin support is T6) and `.\nova-agent.exe install …`. **The agent binary is its own installer on every OS**, and that is the non-bash seam.
- If the machine can reach neither door (it has no Tailscale and is not on the hub's LAN), `machine_add_code` refuses: "CANNOT: that machine can reach neither Nova's tailnet address nor her LAN door; turn on LAN (`NOVA_LAN=1 ./install`) or use the public release channel once it exists".

**Enroll body** (additive under the unknown-keys contract): `platform: runtime.GOOS`, replacing the hardcoded `"linux"` at `main.go:162`. Also `arch`, `transport`, and `agent_cert_pem`, which travels over the pinned edge channel and so is authenticated.

**Auth-frame facts** (`facts.net`):

```
{overlay:{kind, backend_state, ips[], dns_name, control_url, key_expiry, auth_pending:bool},
 lan:{ifaces[{name,ipv4_cidr,mac}]},
 models_listen:{transport, addr, port, pin}}
```

**New device→core frame** `net {auth_url?, backend_state}`. It is sent when tsnet's IPN bus reports a change. Core keeps `auth_url` **in memory only** and pushes it to the owner as a card.

**New signed envelopes** (authority leaves core only this way):

- `net.join {kind, control_url?, hostname, auth_key?}` → result `{state, ips[]}` (the AuthURL arrives by the `net` frame). The agent's audit `summary` excludes `auth_key`.
- `net.leave {}`.
- `net.pin_update {new_pin}`, deferred.

**Sidecar status file** `/run/nova-status/tailscale.json`:

```
{v:1, written_at, serve:{mode, https_ok, tcp_8443_ok}, control_url, status:<raw tailscale status --json>}
```

It is written atomically (tmp then mv) on every poll and after serve.

**Edge allowlist**

- Served: `GET /api/v1/devices/ws` (upgrade), `POST /api/v1/devices/enroll` (plus Area A's agent enroll route if distinct), `GET /agent/{os}-{arch}`, `GET /agent/SHA256SUMS`, `GET /healthz`.
- Everything else: 404.
- Core's `edge_guard` middleware also returns 404 for any other path whose `request.client.host == NOVA_EDGE_ADDR`.

**Gateway dial** (all with the bearer and `ssl.SSLContext(PROTOCOL_TLS_CLIENT)`, `check_hostname=False`, `load_verify_locations(cadata=tls_cert_pem)`; builtin keeps `OLLAMA_URL`):

| transport | URL | proxy |
|---|---|---|
| tailnet / headscale | `https://<agent overlay IPv4>:11435` | `NOVA_TAILNET_PROXY` (CONNECT) |
| lan | `https://<agent LAN IPv4>:11435` | none |
| host | `https://host.docker.internal:11435` (`extra_hosts: host-gateway`) | none |

**Tailscale API** (OAuth client credentials at `https://api.tailscale.com/api/v2/oauth/token`; the access token lasts one hour):

- `POST /api/v2/tailnet/-/keys` with `{capabilities:{devices:{create:{reusable:false, ephemeral:false, preauthorized:true, tags:["tag:nova-node"]}}}, expirySeconds:3600, description:"nova <machine> <code_id>"}`;
- `DELETE /keys/{id}` when the code expires unused;
- `GET /devices`;
- update device key `keyExpiryDisabled`;
- `GET`/`POST /acl` with `If-Match` (phase a2, via `hujson-patch`).

**REST:** `GET /api/v1/network`, `POST|DELETE /api/v1/network/tailscale-credential` (write-only secret), `GET /api/v1/network/origins`.

**SSE:** a `card` frame `{kind:'code'|'tailnet_login', …}` replaces the baseline's `code` frame and is added to `KNOWN_FRAME_KEYS`.

**nginx `web`:** adds `proxy_set_header X-Nova-Gate-Passed $gate_cookie_ok` so a `public` origin can be observed with provenance (it counts only when `client.host == NOVA_WEB_ADDR`).

## File-level changes

**deploy/**

- `docker-compose.yml`:
  - **tailscale** (`:230-305`): add `TS_OUTBOUND_HTTP_PROXY_LISTEN`, `TS_EXTRA_ARGS: ${TS_EXTRA_ARGS:-}` (headscale `--login-server`), `NOVA_SERVE_MODE`, `NOVA_EDGE_ADDR`, and the volume `v4_tailnet_status:/run/nova-status`.
  - **core**: mount `v4_tailnet_status` read-only, plus `v4_edge_tls` and `v4_core_state`; env `NOVA_WEB_ADDR`, `NOVA_TAILSCALE_ADDR`, `NOVA_EDGE_ADDR`.
  - **gateway**: `NOVA_TAILNET_PROXY` and `extra_hosts`.
  - **new `edge`**: profiles `[tailnet, headscale, lan]`, pinned nginx-alpine, fixed `NOVA_EDGE_ADDR` (`.128.30`), `ports: ["${NOVA_LAN_BIND:-127.0.0.1}:8443:8443"]`. The default is loopback, so LAN off is the safe default.
- `deploy/edge/nginx.conf` and `edge_test.sh`: real client containers; the UI, `/api/v1/auth/login` and `/api/v1/chat/stream` → 404; the ws upgrade passes; a wrong-pin curl fails.
- `tailscale/start.sh`: the NeedsLogin branch (`:128-134`) waits and writes the status file instead of calling `fail`; `write_status()`; serve modes; a `--tcp=8443 tcp://$NOVA_EDGE_ADDR:8443` mapping verified by `serve_check.sh`.
- `install.sh`:
  - `decide_tailnet` no longer calls `refuse_tailnet` without a key; it prints "approve in Nova → Settings → Network", and `wait_for_health` skips tailscale in that case.
  - New `decide_lan`: with `NOVA_LAN=1`, `lan_bind_address` comes from the default-route IPv4 (`ip -4 route get` on Linux; `route -n get default` plus `ipconfig getifaddr` on macOS). Under WSL it asks for the Windows LAN IP.
  - New `lan_bind_is_private`: refuses non-RFC 1918/ULA values, and refuses `0.0.0.0` unless the value is typed explicitly and stated.
  - New `host_routes_in_use_darwin`.
- `exposure_test.sh` (new): `docker compose config` for the profile sets {∅, tailnet, lan, tailnet+lan, headscale}. It asserts every `ports[].host_ip` is 127.0.0.1 except edge 8443 == `NOVA_LAN_BIND`; no `network_mode`; web is never published off loopback. Also a test fixture showing that a public `NOVA_LAN_BIND` makes `install.sh` die.
- `README.md`: "Networks: Tailscale, headscale, LAN" and the exact rail.

**services/core/**

- New modules: `network.py`, `network_api.py`, `tailscale_api.py`, `secret_box.py`, `edge_tls.py`, `tools/network.py`, `checks/network.py`.
- `identity.py`: `edge_guard`; the origin recorder writes `access_origins`.
- `devices_ws.py`: the `net` frame; provenance → `last_transport`.
- `machines.py` (baseline): `add_code(transport)`; `on_facts` → gateway PUT when a `lan` locator changes.
- `tools/devices.py:114-116`: the path check accepts `C:\…` when the device platform is windows (`ntpath`).
- `main.py`: `edge_tls.ensure()` in lifespan.
- `Dockerfile`: Go stage builds the agent for {linux, darwin, windows}×{amd64, arm64} plus `hujson-patch`, and `SHA256SUMS`.
- `live_facts.py`: `network_status` → `AUTO_RUN`; the other two → `NOT_AUTO_RUN`.

**services/gateway/**

- `engines.py` (Area A): `client()` per the dial table; `_ssl_context(row)`.
- `adapters/base.py:127` `http_client` gains `verify=`/`proxy=` parameters, and mounted test transports still win.

**apps/novad/**

- New packages `internal/transport/{transport,overlay,lan,host}.go`, `internal/pin`, `internal/discovery`.
- `client.go:147`: `websocket.Dial(…, &websocket.DialOptions{HTTPClient: t.HubClient()})`.
- `config`: `Transport`, `HubPin`, `ControlURL`, `OverlayHostname`, and a tsnet `Dir` under the state dir (0700).
- `main.go`: the `install` verb.
- `go.mod`: `tailscale.com` pinned. It needs go ≥ 1.27.1; CI uses "1.27".
- CI: `go test` on ubuntu, macos and windows runners; six cross-builds; `otool -l | grep LC_UUID` on the macOS runner (local-network privacy keys on the executable UUID).

**apps/web/**

- `pages/settings/NetworkSection.tsx`, first on the Devices tab: overlay state and key expiry, the pending-login button and QR, LAN door address and short pin, and the Tailscale API access form (the secret field is write-only).
- `OpenElsewhere.tsx`: one section per access mode.
- `LoginCard.tsx`.
- `AddMachineFlow`: per-OS tabs.
- `streamChat.ts`: add `card`.

## Nova's tools, guards, eval cases

| Tool | reads_only / ephemeral | Does |
|---|---|---|
| `network_status(machine?)` (new) | True / True, `AUTO_RUN` | Reports the hub overlay (from the status file, read now), the LAN door, the credential (present, scopes, verified_at; never the value), access origins and each machine's transport and overlay state. Facts: `{"network":…,"checked_now":true}` and `{"machine","joined":bool\|null,"checked_now"}`. |
| `tailnet_join(machine)` (new) | False / True | For a paired machine: mints a tagged key if a credential exists, then sends signed `net.join`. With no credential, the agent's AuthURL goes to a `tailnet_login` card. Progress lines; bounded 10 min; success only when the agent's facts show Running **and** the gateway reached the pinned listener through the proxy. The result states the key id and expiry, never the key. |
| `network_configure(...)` (new) | False / False | `remove_credential`; `key_expiry_off(machine\|hub)` (credential with `devices:core`); `apply_grant` (phase a2: `tagOwners` plus one grant `tag:nova-hub → tag:nova-node tcp:11435`, applied through `hujson-patch` so the owner's comments survive; validate first, then If-Match; reads back and states "your policy still allows all; the grant narrows nothing until that rule goes"); `transport(machine, kind)`. Everything is read back. |
| `machine_add_code` (changed) | — | Gains `transport="auto"`. The derived order is: host if it is the hub machine, else the overlay if Running, else lan if the door is on and the hub LAN address is known, else CANNOT with each reason. |
| `nova_address` (changed) | True / True | Every access mode with provenance and per-platform steps, including Tailscale app links (`tailscale.com/download/{ios,android,mac,windows,linux}`). |

**Guards**

- `credential_claim`, which extends `code_claim`: fires on `tskey-(auth|client|api)-\S+` or a `login.tailscale.com/a/…` URL in her reply that does not appear in the user's message. She never holds one, so the check is exact.
- `address_claim`, generalised: fires on any Nova URL that is not in `access_origins` or the door locator, and **always** on a LAN IP with :3000 or :80 given for the app. The rail is enforced in her words too.
- `state_claim`: `_STATE_WORD` gains `joined|on (your|the) tailnet|reachable`, with evidence only from `network_status` or `tailnet_join` facts.
- Narration kind `joined_machine` → `{tailnet_join}`.
- Capability phrases: "add … to (my) tailnet/Tailscale", "set up the network(ing)".
- `_JOIN_TAILNET` in `_OFFER_CLASSES`.
- MUST_FIRE: "I can't add machines to your tailnet." Must not fire: "It hadn't joined after 10 minutes; the approval link is still on your screen."

**Eval cases** (suite +3): `joins-a-paired-machine-to-the-tailnet` (FixturePlant `eval_box`), `says-approval-is-pending-not-joined`, `gives-a-real-address-never-the-lan-app`. Registry goes 45 → 48 in one pinned move.

## Tests

- **core:**
  - `test_network.py`: availability from status-file fixtures; `edge_guard`; auto choice; LAN refusal reasons.
  - `test_tailscale_api.py`: mounted fake API; key body pinned; 412 retry; unused key revoked at code expiry; `test_secrets_not_logged` cases.
  - `test_secret_box.py`: the stored column is never plaintext; a missing key file gives a stated failure.
  - `test_tools_network.py`.
  - Guard tests.
  - `test_no_approvals` stays green. `test_settings` KNOWN_KEYS does not move.
- **gateway:** a Go-generated cross-language certificate fixture passes; a certificate with the same subject and a different key is refused **before the fake server receives a request**; tailnet rows use the proxy, lan and host rows do not.
- **Go:** two real tsnet nodes against `testcontrol` plus `RunDERPAndSTUN` (verified in `tsnet_test.go`); AuthURL surfaced over the IPN bus; the models listener is reachable only on the overlay; the LAN listener refuses `0.0.0.0` and `::`; pin mismatch aborts before any bytes.
- **deploy:** `exposure_test.sh`, `edge_test.sh`; `start_test.sh` pinned cases move (`:335-347`: "login URL, no key" now stays up, writes `auth_url` and stays unhealthy; config assertions `:486-506` gain the proxy, status volume and `--tcp` mapping); `install_test.sh` on macOS bash 3.2 in CI.
- **web:** NetworkSection (the secret is never re-rendered), OpenElsewhere (no QR without an origin; never loopback or LAN), AddMachineFlow per-OS commands.

## Live DoD walks (available hardware)

**(a) Tailnet**

1. Hub join by login link, on an isolated project on the mini PC with a throwaway hostname:
   - `NOVA_TAILNET=1 ./install` with no key prints "approve in Nova".
   - Ask "Put yourself on my tailnet". She calls `network_status` and says it is pending, with the card on screen.
   - Approve. She calls `network_status` again and reports Running, the name, and the key-expiry date.
   - Tear the project down.
2. Dell, native Windows agent, no credential:
   - `machine_add_code` → Windows tab → `curl.exe` from the door on the hub's tailnet IP (the Dell has the Tailscale app).
   - The agent prints the login link. Approve it.
   - Enroll, then `machine_status`: transport tailnet (tsnet), and whether the path is direct or DERP with ProtonVPN on and off.
   - The chat span shows `served_by=dell:…`.
3. With the owner's OAuth client (`auth_keys` plus `devices:core`, tag `tag:nova-node`):
   - Enter it in Settings. She calls `network_status` and reports it verified.
   - Remove and re-add the Dell. The card carries the key, and the tool text carries only the key id.
   - An unused code's key is deleted at expiry, and the API read-back confirms it.
   - `network_configure(key_expiry_off=hub)` reads back.
4. Phone: scan the QR and install the PWA. "How does my wife use you on her laptop?" She calls `nova_address` and gives the Tailscale link, the sign-in step and the URL. Checked at 393 px.

**(c) LAN**

1. On the mini PC, `NOVA_LAN=1 ./install` puts the door on 192.168.0.245:8443.
2. Dell native agent, `transport=lan`: pinned `curl.exe`, a firewall rule, enroll through the edge, listener on 192.168.0.140:11435. The gateway connects to it directly, and a turn is served.
3. From the phone on the LAN: `:8443/` → 404, `:3000` refused, `:11435` without TLS and bearer refused.
4. Change the Dell's DHCP lease. The facts update the locator, and route explain shows the new address.

**(b) Headscale.** An agent-only walk against a LAN-reachable headscale, if an http or self-hosted-TLS control URL works (T8/T12).

**UNWALKED until hardware or a decision exists:** all of macOS (agent, LaunchDaemon, Local Network privacy, Docker Desktop or OrbStack hub, Metal); Windows hubs without WSL; headscale phones; arm64 hosts; AMD and Intel GPU nodes; mDNS on macOS.

## Risks and new P0 measurements

**Risks**

- Two tailnet nodes per machine (the app plus the agent).
- Login-link nodes are user-owned, and key expiry drops them after the configured period. This is covered by the `tailnet_key_expiring:<m>` check (non-urgent, 14 days out) and `key_expiry_off`.
- The Windows ControlURL issue (#16840, open when read).
- On Docker Desktop, edge source IPs are not preserved.
- Losing the edge certificate breaks every agent's pin. The move archive must carry `v4_edge_tls`.
- The blast radius of the OAuth secret: `policy_file` is optional and requested separately.
- Owners may paste secrets into chat.
- DERP-relayed tokens/s.
- The size and CVE cadence of the tsnet-bearing binary; bump deliberately.

**P0 measurements**

| ID | Measure |
|---|---|
| T1 | Dell native tsnet with ProtonVPN on and off: direct or DERP, connect p99, 27B tokens/s through the proxy vs local |
| T2 | The same from inside WSL2 NAT, and after resume |
| T3 | Mini PC gateway → Dell LAN listener, with and without a firewall rule |
| T4 | Docker Desktop publishing on a specific LAN IP, plus the Windows firewall |
| T5 | Go mDNS alongside avahi, and Windows browse |
| T6 | `curl.exe --pinnedpubkey` (Schannel) against the edge |
| T8 | Windows tsnet ControlURL against headscale |
| T9 | OAuth tagged-key mint → Running time; `keyExpiryDisabled` read-back |
| T10 | Busybox status-file writes; JSON size with peers |
| T11 | `host-gateway` → hub-host agent on Linux |
| T12 | tsnet or headscale with an `http://` or self-signed control URL |
| T13 | `serve --https=443` and `--tcp=8443` coexisting on one node |

## Interfaces required from the other two areas

**From Engines / agent**

- The models role accepts a `net.Listener` and a `tls.Config` from `transport`.
- Engine rows carry `transport`, `tls_cert_pem`, `tls_pin`, and the core-driven `base_url` PUT.
- The agent `install` verb and per-OS service registration. On Windows+WSL, the agent that serves models on the LAN must be the native Windows build fronting `127.0.0.1:11434`.
- The macOS network roles run as a LaunchDaemon.
- A public release channel for machines that can reach neither door.
- Hub-move archives carry `v4_edge_tls` and `v4_core_state`.

**From Wake**

- Relay choice reads the same `facts.net.lan.ifaces`.
- The hub's native agent is the default relay and also hosts mDNS.
- "Answering" means the pinned-TLS `/ready` succeeds, on any transport.

## Owner-level open questions

1. Should the Tailscale OAuth secret be stored now under A-0, a narrow encrypted store ahead of Proposal A? The alternative is the login-link path only, until Proposal A.
2. LAN-only households cannot install the app on phones. Is "tailnet or public tunnel" acceptable, or should a later "your own domain and certificate" mode put the UI on the LAN? That would be a further relaxation of the rail.
3. Build headscale (b) now, when phones need a public domain and certificate for headscale itself and still get no installable app? Or keep it as a seam until someone asks?
4. Windows hubs without WSL: build `nova-agent hub install` in Go, or state "Windows hubs need WSL" for now?

## Verification ledger

- **Verified by reading the sources:**
  - tsnet `Server` fields, the auth precedence, the AuthURL sent to `UserLogf`, and that `Up` does not error on NeedsLogin ([pkg.go.dev](https://pkg.go.dev/tailscale.com/tsnet), [tsnet.go](https://raw.githubusercontent.com/tailscale/tailscale/main/tsnet/tsnet.go)). The pkg.go.dev banner "not in the latest version of its module" is unexplained, because `tsnet/` exists on main; the implementation will pin a module version.
  - Tailscale requires go 1.27.1 ([go.mod](https://raw.githubusercontent.com/tailscale/tailscale/main/go.mod)).
  - Proxy CONNECT and flush behaviour ([proxy.go](https://raw.githubusercontent.com/tailscale/tailscale/main/cmd/tailscaled/proxy.go), [reverseproxy.go](https://raw.githubusercontent.com/golang/go/master/src/net/http/httputil/reverseproxy.go)).
  - OAuth: the `auth_keys` scope, tags mandatory, one-hour tokens ([oauth-clients](https://tailscale.com/docs/features/oauth-clients), [trust-credentials](https://tailscale.com/docs/reference/trust-credentials)).
  - Keys: one-off or reusable, pre-approved, 90-day maximum, tagged devices get no key expiry ([auth-keys](https://tailscale.com/docs/features/access-control/auth-keys)).
  - OAuth-app device provisioning is alpha ([device-provisioning](https://tailscale.com/docs/features/oauth-apps/device-provisioning)).
  - Personal plan: 50 tagged resources ([pricing](https://tailscale.com/pricing)).
  - `hujson` `Patch` preserves comments ([hujson](https://pkg.go.dev/github.com/tailscale/hujson)).
  - `serve --tcp` needs no certificates ([serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)).
  - Headscale: no `tailscale cert` ([#2527](https://github.com/juanfont/headscale/issues/2527), open), TLS chain and ACME needs ([tls](https://headscale.net/stable/ref/tls/)), public DERP by default ([derp](https://headscale.net/stable/ref/derp/)), iOS and Android custom-server steps ([apple](https://headscale.net/stable/usage/connect/apple/), [android](https://headscale.net/stable/usage/connect/android/)), latest release v0.29.3 with a minimum client of 1.80 ([releases](https://github.com/juanfont/headscale/releases)).
  - The Windows ControlURL issue ([#16840](https://github.com/tailscale/tailscale/issues/16840)).
  - Docker Desktop host networking is L4-only and cannot bind host IPs ([docker docs](https://docs.docker.com/engine/network/drivers/host/)).
  - Chrome installability requires HTTPS ([web.dev](https://web.dev/articles/install-criteria)).
  - macOS: LaunchDaemons are exempt from Local Network privacy, LaunchAgents are not, and it keys on the executable UUID ([mjtsai summary of Apple's Quinn](https://mjtsai.com/blog/2024/10/02/local-network-privacy-on-sequoia/)).
  - `testcontrol` in the tsnet tests ([tsnet_test.go](https://raw.githubusercontent.com/tailscale/tailscale/main/tsnet/tsnet_test.go)).
- **Assumed, and assigned to a check:**
  - OAuth client tags must exist in `tagOwners` before the client is created (T9).
  - Python `cadata` pinning of a Go self-signed certificate (CI fixture).
  - Docker Desktop specific-IP publishing (T4).
  - Schannel `--pinnedpubkey` (T6).
  - Go emits LC_UUID (CI `otool`).
  - http control URLs (T12).

### Critical Files for Implementation
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/deploy/docker-compose.yml
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/deploy/tailscale/start.sh
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/apps/novad/internal/client/client.go
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/services/core/app/identity.py
- /home/jeremy/workspace/nova/.claude/worktrees/nova-gateway-local-inference-1094ff/deploy/install.sh