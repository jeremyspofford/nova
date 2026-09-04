# deploy/ — the stack, the installer, the tailnet

`docker-compose.yml` is the whole running system (project `nova`);
`install.sh` (run as `./install` from the repo root) is the only supported
way to bring it up; `.env` (from `.env.example`) holds every secret and
switch. Each file carries its reasoning inline; this is the operator's map.

## Install

`./install` is idempotent: preflight (docker, compose, openssl, disk, ports,
whether a bundled ollama can start), hardware detection into
`data/hardware.json`, secrets generated into `deploy/.env` (never
overwritten), `docker compose up -d --build`, then a wait on every service's
healthcheck and a status table. A red row is a real failure and the script
exits non-zero.

Two optional profiles:

- `inference` — the bundled ollama. On by default; `NOVA_SKIP_INFERENCE=1`
  leaves it off (the installer refuses, up front, when a host ollama already
  holds :11434 — see `decide_inference`).
- `tailnet` — Nova as a node on your tailnet (below). Off by default;
  `NOVA_TAILNET=1 ./install` turns it on.

The installer passes the profiles it enables explicitly, and writes every
profile it started (`inference`, `tailnet`) to `COMPOSE_PROFILES` in `.env`
— derived from the `--profile` flags it passed, so the two cannot disagree —
so a plain `docker compose up -d` afterwards converges the same set; an
explicit off-switch (`NOVA_SKIP_INFERENCE=1`, `NOVA_TAILNET=0`) takes its
profile back out. One compose fact to know: a `--profile X` flag on the
command line REPLACES the `.env` list rather than adding to it — so after
installing, prefer `docker compose up -d` with no flag, or re-run
`./install`.

**The deploy rule (2026-09-04).** Run compose from this directory — `cd
deploy && docker compose …`, or `docker compose --project-directory deploy …`
from the repo root — and never with a bare `-f deploy/docker-compose.yml`.
The installer writes `COMPOSE_FILE` to `deploy/.env` with ABSOLUTE paths:
the base file, plus `docker-compose.gpu.yml` whenever docker has the NVIDIA
runtime. Compose reads that list only when no `-f` is given (a `-f` REPLACES
it, the way `--profile` replaces `COMPOSE_PROFILES`), and it resolves a
relative entry from the shell's working directory rather than from `.env`'s —
from the repo root a relative list loaded the v3 `docker-compose.yml`. Two
facts say you got it right: `docker compose --project-directory deploy config
--services` lists the v4 services (`core`, `gateway`, `memory`, … — v3's file
has `backend` and `frontend` instead), and `docker compose --project-directory
deploy logs --no-log-prefix ollama | grep 'inference compute'` says
`library=CUDA`. The installer reads that second line itself after the health
table and refuses to report success on anything else — including a line it
cannot read — because every healthcheck is green either way (`ollama list`
passes on the CPU) and a 27B model on the CPU only shows up as the next chat
turn timing out, which is exactly what happened.

## Tailnet access

One durable HTTPS origin on your tailnet — `https://<node>.<tailnet>.ts.net`
— serving the UI, the API and the device WebSocket to phones, laptops and
remote `novad` daemons. Tailnet peers are never asked for the public-gate
token: `tailscale serve` stamps each request with the peer's identity and
nginx trusts that header only when the connection comes from the sidecar's
own fixed address (`apps/web/README.md` has the mechanism; it is a fact
about the network, not a claim in a header).

### Enabling it

```
NOVA_TAILNET=1 ./install
```

It asks for two things and writes both to `deploy/.env`:

- **`TS_AUTHKEY`** — a Tailscale auth key from
  https://login.tailscale.com/admin/settings/keys. The installer never
  generates one: it is the one input only you hold. It is used ONCE, on the
  node's first login; after that the identity lives on the `nova_v4_tailscale`
  volume and the key is not consulted again (`TS_AUTH_ONCE`). A
  **non-reusable** key (the default kind) is the right choice — it lingers
  in `.env`, but cannot join a second node. Blank it out afterwards if you
  like; nothing breaks. Not needed at all when the volume already holds a
  logged-in node (a re-install, or a migrated node — below): the installer
  looks inside the volume before asking.
- **`TAILNET_HOSTNAME`** — the node's name, the first label of the URL.
  Default `nova`.

Without a key and without a node on the volume the installer **refuses the
profile before pulling or building anything**, and says which of the two
would fix it. An engine you cannot start is not an engine.

Your tailnet needs **HTTPS certificates** and **MagicDNS** enabled (admin
console → DNS). Without certificates `tailscale serve --https=443` cannot
take effect — the sidecar then exits non-zero with the reason instead of
pretending, and `docker compose ps` shows it unhealthy.

When it is up, `./install` prints the URL; so does

```
docker compose -f deploy/docker-compose.yml exec tailscale tailscale status
docker compose -f deploy/docker-compose.yml exec tailscale tailscale serve status
```

### How the sidecar starts (and why a wrapper)

The service runs `tailscale/tailscale:v1.102.3` (pinned) as an ordinary
container at a fixed address — userspace networking, no tun device, no
capabilities, no namespace shared with web. Its command is
`deploy/tailscale/start.sh`, mounted from that DIRECTORY (never a single-file
bind, which dies with exit 127 when Docker Desktop recycles its mount):

1. starts containerboot (tailscaled + the one-time login) and forwards
   SIGTERM to it;
2. waits — bounded, `NOVA_TAILSCALE_READY_TIMEOUT` seconds, default 120 —
   for `tailscale status --json` to report `Running`; on timeout it prints
   the state, tailscaled's Health lines and the login URL it was waiting on,
   and exits non-zero. `NeedsLogin` with a login URL and no `TS_AUTHKEY`
   exits at once instead (nobody can click through a restarting container);
3. applies `tailscale serve --bg --https=443 http://<NOVA_WEB_ADDR>:80`
   (idempotent), targeting web's FIXED address so a recreated web keeps
   working with no manual step — under a `timeout`
   (`NOVA_TAILSCALE_SERVE_TIMEOUT`, default 60s), because on a tailnet
   without HTTPS certificates enabled the CLI blocks forever; on expiry it
   says so and exits non-zero;
4. READS `tailscale serve status --json` and exits non-zero if the mapping is
   not there;
5. waits on containerboot, whose exit status becomes the container's.

Why not `TS_SERVE_CONFIG`: containerboot's own serve path clears the node's
serve config on every start and re-applies it asynchronously from a file
watcher — a racy path with an open upstream bug (tailscale/tailscale #19693,
#14559) that showed up here as "No serve config" after a restart. So the
mapping has ONE writer, the wrapper, on every start, verified. The compose
healthcheck runs the same code (`deploy/tailscale/serve_check.sh`): green
means exactly two facts, read from tailscaled each time — BackendState
`Running`, and the 443 mapping to web's address present. It says nothing
about web itself (web has its own healthcheck). A third, derived fact — the
node's name listed in `CertDomains`, i.e. HTTPS certificates enabled for
the tailnet — is printed as a warning, never a gate.

`deploy/tailscale/start_test.sh` runs the wrapper inside the real image
against a fake `tailscale`/`containerboot` and creates (never starts) the
service under a throwaway project to inspect its shape. What it cannot do
is log a node in — a restart of a logged-in node keeping its mapping, and
a phone on the tailnet, are the owner's walk.

### Devices and daemons

- Pair a laptop or phone from the tailnet URL: the pairing modal prints the
  origin it was opened from, so the one-liner already carries it. Enrolling
  from the tailnet works through a gated origin (the sidecar path is exempt).
- A remote `novad` runs with `--server https://<node>.<tailnet>.ts.net`
  (serve carries the WebSocket upgrade). A daemon on the same box as the
  stack keeps `http://127.0.0.1:3000`.

### Public visitors (optional): funnel

The same node can publish the origin to the internet with a stable hostname:

```
docker compose -f deploy/docker-compose.yml exec tailscale tailscale funnel --bg 443
```

It needs the `funnel` node attribute in your tailnet ACL (Tailscale prompts
with the exact policy snippet). Funnel visitors arrive WITHOUT a tailnet
identity, so they are token-gated exactly like a cloudflared tunnel is: set
`NOVA_PUBLIC_GATE_TOKEN` in `.env` before turning funnel on. The same
applies to **tagged** tailnet nodes (servers, not people): they carry no
identity header and are gated too.

**Funnel does not survive a restart of the sidecar.** In v1.102.3
`tailscale serve --bg` — which the wrapper runs on every start — resets
funnel for the port it configures (the CLI prints "Removing Funnel"), so
every restart of the service turns funnel OFF for :443 and the command
above has to be run again. Keeping it across restarts needs a wrapper flag
that re-applies `funnel --bg 443` after the serve mapping is verified; that
is a carry, not built.

### Migrating an existing node (instead of a new key)

If a "nova" node already exists on your tailnet from an earlier sidecar
(here: `nova4-tailscale-1`, whose state dir is the volume
`nova_tailscale_state`), move its identity rather than minting a second node
with the same name — and never run two tailscaled on one node key (the
control plane flaps). In this order:

1. `docker stop nova4-tailscale-1` — the old node. It was attached to the
   project network by hand, and a running foreign container blocks the
   network recreate in the next step.
2. `docker compose -f deploy/docker-compose.yml down` — the one-time
   network recreate for the declared addressing. Volumes are untouched.
3. `docker compose -f deploy/docker-compose.yml --profile tailnet create
   tailscale` — creates the new volume `nova_v4_tailscale` with compose's
   labels on it (so it is the project's, for `down -v` and friends) and the
   container, which is NOT started.
4. Copy the state across, with the sidecar's own image so nothing extra is
   pulled:
   ```
   docker run --rm -v nova_tailscale_state:/from:ro -v nova_v4_tailscale:/to \
     --entrypoint sh tailscale/tailscale:v1.102.3 -c 'cp -a /from/. /to/'
   ```
5. `NOVA_TAILNET=1 ./install` — the installer finds `tailscaled.state` on
   the volume and asks for no key. (Had the volume been made by `docker run
   -v` alone it would carry no compose labels; the installer also looks for
   it by the name compose resolves, so a hand-made volume is found too.)

### Deploy notes

- The project network's addressing is declared in the compose file (so web
  and the sidecar can hold fixed addresses). Applying that to a network that
  already exists is a one-time `docker compose down && docker compose up -d`;
  volumes are untouched. A running container from OUTSIDE the project that
  was attached to the network by hand blocks the recreate ("network has
  active endpoints") — stop it first.
- `nova_v4_tailscale` is deliberately not named `tailscale_state`: a volume
  of that name already exists under this project name
  (`nova_tailscale_state`) and the old node `nova4-tailscale-1` runs on it;
  a same-named key would attach a second tailscaled to a live node key.
- Turning it off: `NOVA_TAILNET=0 ./install` removes the profile from
  `.env`; `docker compose -f deploy/docker-compose.yml --profile tailnet
  stop tailscale` stops the node. The volume (and with it the node's
  identity) stays until you `docker volume rm` it.
- Stop the sidecar and the tailnet URL goes dark; `127.0.0.1:3000` is
  unaffected. The other direction holds too: nothing but this sidecar (and
  an explicit tunnel or funnel) exposes the stack beyond loopback.
