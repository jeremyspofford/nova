# Slice 5b — Tailnet access

Parent: the Master Roadmap, §S5b (added 2026-09-02 after S5's walk showed the
tailnet was assumed by S5/S7 but never scheduled). Inputs: slice-05-carries.md
§Public access wave + the 09-03 stalls (tailscale serve cached web's old IP
after a recreate; serve config lost on node restart; single-file bind-mount
trap), memory [[nova-v4-tailnet-url]] / [[nova-v4-public-gate-tunnel]] /
[[home-assistant-tailnet-access]], and the nova4 lane's tailscale sidecar
(prior art, mine-not-port). Slice type: ADDITIVE (infra + two small core/web
changes). Size: M (T2 S–M, T1 M, T3 S). Owner gate: the walk from a phone on the tailnet, plus the
one input only the owner holds — either a TS_AUTHKEY or consent to migrate the
old node's state.

Goal: ONE durable HTTPS origin on the owner's tailnet — `https://nova.<tailnet>
.ts.net` — that survives web recreates and node restarts, serves the UI, the
API and the device WebSocket, and is what phones, laptops and remote novad
daemons use. Today's interim (the old nova4 lane's container reconnected by
hand, serve re-applied by hand after every web recreate) is exactly the
fragility this slice removes. The public tunnel + token gate stay as the
"no-Tailscale device" escape hatch; this slice makes the gate per-origin so
tailnet peers are not taxed for it.

Frontier facts (verified 2026-09-03, sources in the S5b research): image
`tailscale/tailscale:v1.102.3` (2026-08-19; `TS_BOOT_TIMEOUT` new). containerboot
CLEARS the serve config on EVERY start and re-applies it asynchronously via an
fsnotify watch on the config's parent DIRECTORY — a racy path with an OPEN
upstream bug matching our 09-03 "No serve config" (tailscale/tailscale #19693,
#14559); the config file must live in a mounted DIRECTORY. `TS_STATE_DIR` on a
named volume keeps node identity + MagicDNS across restarts/recreates with no
new authkey (`TS_AUTH_ONCE=true` once joined). `tailscale serve` injects
`Tailscale-User-Login/-Name/-Profile-Pic` for tailnet peers, STRIPS any
client-supplied copy, and funnel (public) traffic never carries them — so the
header is unspoofable on a path only serve can reach. serve's upstream
re-resolution on backend recreate is UNDOCUMENTED (our hang is a known-
undocumented class). Every official sidecar+serve example uses KERNEL
networking (`TS_USERSPACE=false` + /dev/net/tun + cap net_admin) with the app
joining the sidecar's namespace; userspace + shared namespace is untested.
Funnel: ports 443/8443/10000, ACL `funnel` attr, a port is serve OR funnel.

## Definition of done (operator-visible, walked live)
1. From a phone on the tailnet: open `https://nova.<tailnet>.ts.net` → login
   → chat; the device tile is green; no gate page (tailnet peers are exempt).
2. Web recreated by ANY shape the operator actually uses — `up -d --build
   --no-deps web`, a plain `up -d web`, `docker compose restart`, a crash-
   restart — and the tailnet URL keeps working with NO manual step. Pinned by
   a tailnet-free topology test (T1) — the 09-03 stall class is removed by
   topology, not by a ritual.
3. `docker restart <tailscale service>` → the serve mapping is still there
   and the service reports healthy only when it is (the wrapper applies it;
   the healthcheck reads `tailscale serve status`).
4. Pair a laptop on the tailnet with the one-liner as printed by the modal
   (the modal's origin is the tailnet URL when opened from it); novad runs
   with `--server https://nova.<tailnet>.ts.net` and the tile goes green.
5. The public tunnel path still gates (token required); the tailnet path
   does not; localhost gates iff the token is set (unchanged).
6. Stop the tailscale service → unreachable from the phone; localhost fine.
7. Host/WSL restart → web and tailscale both come back with their fixed
   addresses (see it once).

## Architecture (revision 2, 2026-09-03 — after the T2 review MEASURED the pod shape's restart trap)
- **Fixed addresses, no shared namespace.** Revision 1 used the pod shape (an
  unprofiled pause container that web and the sidecar join). The T2 review
  measured, in a throwaway pod on compose v5.3.0: `docker compose restart`
  races the namespace join and web dies `Exited (128) cannot join network
  namespace of a non running container` with NO restart-policy retry (that
  is S1's committed DoD 2 command); `docker restart netns` strands web
  (loopback only, published port gone) while its healthcheck stays GREEN;
  `docker compose up -d` afterwards is a no-op. Any `service:`/pause shape
  couples start ORDER — a class of trap, not one bug. So: the project network
  declares its IPAM (`subnet 172.18.0.0/16`, `gateway 172.18.0.1` — the
  values docker already assigned to nova_default — plus `ip_range
  172.18.0.0/17` so dynamic allocation stays in the lower half) and web and
  the sidecar get FIXED addresses in the upper half via `ipv4_address:
  ${NOVA_WEB_ADDR:-172.18.128.10}` / `${NOVA_TAILSCALE_ADDR:-172.18.128.20}`
  (.env.example documents both; one source). serve proxies
  `http://${NOVA_WEB_ADDR}:80` — no name to resolve, an address that survives
  every recreate; the sidecar is an ordinary container (userspace networking
  exactly as the old lane ran for months; no tun/caps); no service joins
  another; `compose restart`, `docker restart <anything>`, `--no-deps web`
  and a daemon restart are all order-independent. Cost: declaring IPAM on an
  existing network is a ONE-TIME `docker compose down && up` at deploy (the
  T3 sitting; volumes persist; the old node is retired in the same sitting).
  A web recreate keeps its address, so the serve proxy's pooled connection
  dies with the old container (RST) and re-dials — the same unknown the pod
  shape had, walked in DoD 2.
- **The `tailscale` service** (profile `tailnet`, opt-in; image
  `tailscale/tailscale:v1.102.3` pinned; `hostname: nova` is fine for an
  ordinary container but the node name comes from
  `TS_HOSTNAME=${TAILNET_HOSTNAME:-nova}` regardless; `ipv4_address:
  ${NOVA_TAILSCALE_ADDR}`; TS_STATE_DIR on the NAMED VOLUME `v4_tailscale`;
  TS_AUTH_ONCE=true; TS_USERSPACE=true; TS_AUTHKEY from .env, blank by
  default, a NON-reusable key recommended since it lingers in .env; NO
  `TS_SERVE_CONFIG` — one writer only, see next; the wrapper mounted from the
  DIRECTORY `deploy/tailscale/`; `restart: unless-stopped`).
- **Serve applied by US, verified, on every start.** containerboot's own
  TS_SERVE_CONFIG path clears-then-races (open upstream bug); with the CLI
  the config persists in the state store, and two writers would race, so the
  service's command is a wrapper that: starts containerboot (PID 1 semantics
  kept — forward SIGTERM), waits for `tailscale status` BackendState Running,
  runs `tailscale serve --bg --https=443 http://127.0.0.1:80` idempotently,
  then READS `tailscale serve status` and EXITS NON-ZERO if the mapping is not
  there (e.g. HTTPS certs not enabled on the tailnet) — never reports success
  it did not check. A compose `healthcheck` reads the same two facts
  (Running + mapping present) so `compose ps` / install.sh are honest.
- **One listener; trust derived from the SOURCE ADDRESS.** nginx keeps
  `listen 80` (published `127.0.0.1:3000:80` as today; e2e and in-network
  callers keep `web:80`). Maps: `$from_sidecar` = (`$remote_addr` ==
  `${NOVA_TAILSCALE_ADDR}`, templated through the existing `^NOVA_` envsubst
  — unset ⇒ nobody is trusted); `$tailnet_peer` = from_sidecar AND
  `Tailscale-User-Login` present; `$gate_block` = enabled AND no cookie AND
  NOT tailnet_peer. A source address on a docker bridge cannot be completed
  as a TCP connection by another container (the handshake reply goes to the
  real holder), so it is a fact, not a header. Identity headers are forwarded
  upstream ONLY when `$from_sidecar` (empty `proxy_set_header` value removes
  the client's copy elsewhere — nothing in core reads them until S8). On the
  sidecar path the header is trustworthy because serve strips any client copy
  and funnel never sets it: a funnel visitor arrives FROM the sidecar address
  WITHOUT the header ⇒ gated. Published-port traffic arrives from the docker
  gateway ⇒ never trusted (cloudflared forwards client headers). The
  `/api/v1/devices/ws` and `/healthz` carve-outs are unchanged. Tagged
  tailnet nodes carry no identity headers → they get the token gate
  (documented). Enroll from the tailnet works because `/api/` from the
  sidecar with the header is exempt — that is the mechanism, say so in
  README. S8 carry: `core:8000` is on nova_default and published on
  127.0.0.1:8000, so forged identity headers can reach core DIRECTLY; when
  S8 reads them, core needs provenance (e.g. a per-deploy secret header nginx
  adds only on the trusted path).
- **Cookie `Secure` derived from the FORWARDED scheme, with one honest
  source.** nginx terminates no TLS, so `$scheme` is always `http` and
  `proxy_set_header X-Forwarded-Proto $scheme` would erase what serve /
  cloudflared sent. http-level `map $http_x_forwarded_proto $fwd_proto {
  default $scheme; https https; }` + `proxy_set_header X-Forwarded-Proto
  $fwd_proto;` on every proxied location; `identity.set_session_cookie` (the
  single choke point, one caller in auth_api) reads the header explicitly:
  `secure = (header == "https")`; `clear_session_cookie` carries the same
  flag. Downgrade analysis: a client only influences its OWN request's header
  (serve/Cloudflare overwrite it for real visitors; browsers never send it),
  so the only forgeable outcome is a self-inflicted Secure cookie on plain
  http that the liar's own browser drops — trusting `https` from any listener
  is safe; `http` is never used to strip Secure on a TLS path (the map
  cannot).
- **install.sh: an engine you cannot start is not an engine.** The `tailnet`
  profile REFUSES up front unless TS_AUTHKEY is set or the state volume
  already holds an identity; `tailscale` joins HEALTH_CHECKED_SERVICES under
  the profile (like ollama); `COMPOSE_PROFILES=tailnet` is written to .env so
  every later `up` converges the service.
- **Funnel (optional)**: `tailscale funnel --bg 443` on the same node gives a
  STABLE public hostname; funnel visitors hit :80 WITHOUT the identity header
  ⇒ token-gated by the split above with no extra rule. Documented, off by
  default; needs the tailnet ACL `funnel` attr.
- **Migrate, don't re-key — in the right order.** The old `nova4-tailscale-1`
  IS the owner's "nova" node. T3: STOP the old container → copy its state
  volume into `v4_tailscale` (`docker run --rm -v <old>:/from -v
  nova_v4_tailscale:/to alpine cp -a /from/. /to/`) → `up` the new service.
  Never two nodes on one node key (the control plane flaps; the copy can
  catch a torn state file). Fallback: the owner mints a TS_AUTHKEY. The v3
  lane's `tailscale/serve.json`, its test and ROADMAP line are v3 debris —
  retired with the v3 tree, not here.
- **Interim**: the old node keeps proxying `http://web:80` until T3 replaces
  it; nothing in T2 changes web's port. The one-time network recreate at T3
  disconnects the old node — it is retired in that sitting.
- novad: `--server https://nova.<tailnet>.ts.net` for remote devices (serve
  handles the WS upgrade — verify in T3); the pairing modal already prints
  `window.location.origin`.

## Tasks (order: T2 → T1 → T3)
- **T2 — Source-address gate, forwarded scheme, IPAM (S–M; no tailnet
  needed).** nginx.conf.template: single `listen 80`, the `$from_sidecar` /
  `$tailnet_peer` / `$gate_block` maps, identity headers forwarded only when
  from_sidecar, the `$fwd_proto` map on every proxied location, carve-outs
  unchanged; compose: declared IPAM (subnet/gateway as live, ip_range lower
  half) + `ipv4_address` for web from `NOVA_WEB_ADDR`, `.env.example`
  documents NOVA_WEB_ADDR / NOVA_TAILSCALE_ADDR, web's `environment` passes
  NOVA_TAILSCALE_ADDR for envsubst; ports/e2e/Dockerfile stay on :80 (no
  churn). gate_test.sh: a user-defined test network with a declared subnet; a
  client container AT the trusted address with the header ⇒ 200 ungated;
  the same client without the header ⇒ 401; a client at another address with
  the header ⇒ 401; the published-port path with a forged header ⇒ 401;
  unset NOVA_TAILSCALE_ADDR ⇒ nobody trusted; the upstream stub proves the
  identity headers reach core only from the trusted address and
  `X-Forwarded-Proto` https/HTTPS/absent/http map as expected. identity.py +
  auth_api through the real route (TestClient + `X-Forwarded-Proto: https` →
  `Secure` in Set-Cookie; without → not); the nginx→core Secure chain end to
  end is asserted in the e2e job if it runs, else recorded as walked in DoD.
  The `/gate` cookie's `Secure` derives from `$fwd_proto` too (consistency).
  Deploy: hold until T1; the IPAM change needs the one-time down/up.
- **T1 — The tailscale service (M).** FIRST commit: the tailnet-free topology
  test — a throwaway compose project with declared IPAM, `web: nginx:alpine`
  at a fixed address, and `sc: nginx:alpine` at another fixed address reverse-
  proxying `http://<web addr>:80`; then `up -d --no-deps --force-recreate
  web`, `docker compose restart`, `docker restart web`, and after EACH
  `docker exec sc wget -qO- http://127.0.0.1/` must answer (the pod shape
  FAILS the `compose restart` step; this shape passes — it decides the
  topology and is DoD 2's pin). Then: the compose service (profile, pinned
  image, TS_HOSTNAME, fixed address, state volume, TS_AUTH_ONCE, userspace,
  no TS_SERVE_CONFIG, the directory-mounted wrapper, healthcheck),
  install.sh refuse/prompt/profile/health, `.env.example`, README. CI
  stand-ins: run the wrapper against a fake `tailscale` on PATH and assert
  it exits non-zero when `serve status` lacks the mapping; `docker compose
  --profile tailnet create tailscale` with a dummy key (create, no start —
  compose validation); `compose config` greps for the named volume, the
  directory mount and both fixed addresses (tripwires). "Restart the node →
  mapping present" needs a logged-in node: owner walk (DoD 3), plus the
  healthcheck.
- **T3 — Migrate the node + DoD walk (S, owner gate).** Stop old → copy state
  → the one-time `docker compose down && up -d` (IPAM) with T2+T1 deployed →
  `--profile tailnet` → novad on the WSL box keeps `127.0.0.1:3000`; remote
  novad → `--server https://nova.<tailnet>.ts.net` (config edit or re-enroll
  — say which) → DoD 1–7 with the owner on the phone: recreate web live (2),
  restart the node (3), pair the laptop (4), tunnel gated / tailnet not, and
  a forged `Tailscale-User-Login` at the funnel/tunnel URL ⇒ 401 (5), stop
  the service (6), a host restart when the owner is at the box (7).

## Rails in force
DERIVED NEVER HARDCODED (secure from the forwarded scheme; exemption from a
proxy-set identity header on a listener clients cannot reach, never a list
of hostnames; TS_HOSTNAME from .env); MECHANICAL OVER PROMPTS (the stale-IP
class removed by topology, not by a restart ritual; the gate rail is a fact
— loopback-bound — not a claim); NEVER REPORT SUCCESS UNCHECKED (the wrapper
exits non-zero when the mapping is absent; the healthcheck reads it; DoD 2
is pinned by a test that recreates for real; install refuses an engine it
cannot start); the tailnet is the ONLY non-loopback exposure besides the
explicit tunnel/funnel.

## Out of scope (named)
Tailscale identity as an auth factor / SSO (S8); the durable public shape
beyond "funnel + gate" (a real domain + Cloudflare Access is the owner's
account work); per-device gate cookies for daemons (daemons use the ungated
WS by design); the rate limiter keying on a TRUSTED X-Forwarded-For (carries
§Public access wave — behind serve all tailnet peers share one client IP; a
nuisance, not a hole; its own small task later).

## Process
SDD per task; each task reviewed + fix rounds; DoD walked live with the owner
on the phone; commits on rebuild/v4 never pushed; carries → docs/plans/
rebuild/slice-05b-carries.md. Each agent uses its own scratch database; one
committer at a time.
