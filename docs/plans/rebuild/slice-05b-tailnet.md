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
   --no-deps web`, a plain `up -d web`, a crash-restart — and the tailnet URL
   keeps working with NO manual step. Pinned by a tailnet-free topology test
   (T1) — the 09-03 stall class is removed by topology, not by a ritual.
3. `docker restart <tailscale service>` → the serve mapping is still there
   and the service reports healthy only when it is (the wrapper applies it;
   the healthcheck reads `tailscale serve status`).
4. Pair a laptop on the tailnet with the one-liner as printed by the modal
   (the modal's origin is the tailnet URL when opened from it); novad runs
   with `--server https://nova.<tailnet>.ts.net` and the tile goes green.
5. The public tunnel path still gates (token required); the tailnet path
   does not; localhost gates iff the token is set (unchanged).
6. Stop the tailscale service → unreachable from the phone; localhost fine.
7. Host/WSL restart → netns, web and tailscale all come back (docker retries
   the namespace join with backoff — see it once).

## Architecture (revised 2026-09-03 after design review)
- **The pod shape, not a sidecar-joins-web.** A `service:` network mode
  pins the joiner to ONE container id's sandbox: if the owner is recreated
  or even restarted, the joiner keeps the torn-down namespace (lo only —
  no uplink, no nginx) and never exits, so `restart:` never fires; compose
  only re-hashes the joiner when it is in the converged set (never with
  `--no-deps web`, never without the profile). That is the 09-03 stall in a
  worse form. So: an UNPROFILED pause service **`netns`** (`alpine`, `sleep
  infinity`, `restart: unless-stopped`) owns the network identity — `ports:
  127.0.0.1:3000:8080` and `networks.default.aliases: [web]` so `http://web`
  keeps resolving for e2e and in-network callers — and BOTH `web` and
  `tailscale` run `network_mode: "service:netns"` (`depends_on: netns`).
  web recreates/restarts and tailscale restarts are then independent in
  either order; serve proxies `http://127.0.0.1:80` with no name to resolve.
  A netns recreate (rare: port config) fails the joiners LOUDLY ("cannot
  join network of a non running container") until a full `up` — an error,
  not a stall. web keeps its own healthcheck (dials 127.0.0.1/healthz).
- **The `tailscale` service** (profile `tailnet`, opt-in; image
  `tailscale/tailscale:v1.102.3` pinned; `TS_HOSTNAME=${TAILNET_HOSTNAME:-nova}`
  — `hostname:` is REJECTED with a shared namespace, and without it the node
  would be named after a container id; TS_STATE_DIR on the NAMED VOLUME
  `v4_tailscale`; TS_AUTH_ONCE=true; TS_AUTHKEY from .env, blank by default,
  a NON-reusable key recommended since it lingers in .env; NO
  `TS_SERVE_CONFIG` — one writer only, see next; the wrapper mounted from
  the DIRECTORY `deploy/tailscale/`; `restart: unless-stopped`). Networking
  mode decided AT BUILD: userspace first (no tun/caps; the old lane ran
  userspace serve for months); if serve cannot bind/proxy in the shared
  namespace, the official kernel shape (`TS_USERSPACE=false`, `/dev/net/tun`,
  `cap_add: net_admin` — all allowed with `service:` mode).
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
- **One nginx server block, two listeners, listener-derived trust.**
  `listen 127.0.0.1:80;` — loopback inside the shared namespace, so ONLY
  netns/web/tailscale can reach it (a plain `listen 80` would be reachable by
  every container on nova_default, which could forge the header) — and
  `listen 8080;` (published as 127.0.0.1:3000; e2e/in-network callers use
  `web:8080`). Maps on `$server_port`: `tailnet_peer = (port 80 &&
  $http_tailscale_user_login != "")`; `gate_block = enabled && !cookie &&
  !tailnet_peer`. On :80 the header is trustworthy because serve strips any
  client copy and funnel never sets it; on :8080 (cloudflared forwards client
  headers) identity headers are never consulted and not forwarded upstream
  (tripwire grep of the rendered conf — nothing in core reads them until S8).
  The `/api/v1/devices/ws` carve-out stays on BOTH listeners (same-host novad
  → :8080 with no cookie; funnel novad → :80 with no header). Tagged tailnet
  nodes carry no identity headers → they get the token gate (documented).
  Enroll from the tailnet works because `/api/` on :80 with the header is
  exempt — that is the mechanism, say so in README.
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
- **Interim survives T2's deploy**: once nginx binds :80 to loopback the old
  node's `http://web:80` route goes dark — at T2 deploy time re-point it
  (`docker exec nova4-tailscale-1 tailscale serve --bg http://web:8080`) so
  the phone keeps working until T3 replaces the node.
- novad: `--server https://nova.<tailnet>.ts.net` for remote devices (serve
  handles the WS upgrade — verify in T3); the pairing modal already prints
  `window.location.origin`.

## Tasks (order: T2 → T1 → T3)
- **T2 — Listeners, listener-derived gate, forwarded scheme (S–M; no tailnet
  needed).** nginx.conf.template: one server block, `listen 127.0.0.1:80` +
  `listen 8080`, the `$server_port`/identity-header maps, the `$fwd_proto`
  map on every proxied location, WS carve-out on both listeners; web
  Dockerfile EXPOSE 8080; compose: the `netns` pause service owning ports +
  the `web` alias, web → `network_mode: service:netns` + depends_on (this is
  T2 because the loopback :80 contract is what the sidecar targets);
  tests/e2e/docker-compose.e2e.yml + e2e/conftest.py → `http://web:8080`;
  gate_test.sh: `port_of`/`-p` → 8080, and the :80 matrix run INSIDE the
  container (`docker exec … wget -S --header 'Tailscale-User-Login: a@b'
  http://127.0.0.1/` → 200 ungated; without header → 401; forged header on
  the published port from outside → 401; `http://$(hostname -i)/healthz` from
  inside → REFUSED while 127.0.0.1 → 200, proving loopback-only); a rendered-
  conf tripwire that :8080 forwards no `Tailscale-User-*`. identity.py +
  auth_api test through the real route (TestClient + `X-Forwarded-Proto:
  https` → `Secure` in Set-Cookie; without → not); the nginx half asserted in
  the e2e job (runner → `:8080` with the header → login → Secure) or it is
  vacuous. Deploy: hold until T1 is ready, then deploy T2+T1 together and
  re-point the old node (above).
- **T1 — The tailscale service (M).** FIRST commit: the tailnet-free topology
  test — a throwaway compose project (`web: nginx:alpine`, `netns: alpine
  sleep infinity`, a `sc: alpine sleep infinity` joiner with the plan's
  network_mode), `up -d`, `up -d --no-deps --force-recreate web`, then
  `docker exec sc wget -qO- http://127.0.0.1/` must succeed (this FAILS
  under sidecar-joins-web and PASSES under the pod shape — it decides the
  topology and is DoD 2's pin). Then: the compose service (profile, pinned
  image, TS_HOSTNAME, state volume, TS_AUTH_ONCE, no TS_SERVE_CONFIG, the
  directory-mounted wrapper, healthcheck, userspace-vs-kernel decided by a
  real test), install.sh refuse/prompt/profile/health, `.env.example`,
  README. CI stand-ins: run the wrapper against a fake `tailscale` on PATH
  and assert it exits non-zero when `serve status` lacks the mapping; `docker
  compose --profile tailnet create tailscale` with a dummy key (create, no
  start — catches compose validation such as the hostname conflict);
  `compose config` greps for the named volume + directory mount (tripwires).
  "Restart the node → mapping present" needs a logged-in node: owner walk
  (DoD 3), plus the healthcheck.
- **T3 — Migrate the node + DoD walk (S, owner gate).** Stop old → copy state
  → `--profile tailnet up` (T2+T1 deployed in the same sitting) → novad on
  the WSL box keeps `127.0.0.1:3000`; remote novad → `--server https://nova.
  <tailnet>.ts.net` (config edit or re-enroll — say which) → DoD 1–7 with the
  owner on the phone: recreate web live (2), restart the node (3), pair the
  laptop (4), tunnel gated / tailnet not (5), stop the service (6), and a
  host restart when the owner is at the box (7).

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
