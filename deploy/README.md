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

## Machines

Since S40 the gateway treats local inference as **engines**: a provider row with
`adapter='ollama'` plus an `engines` row (lifecycle, the serving switch, cached
state). Today there is one, the bundled container, and its provider name is
**`hub`**.

- **Ids name the machine.** `hub:qwen3:8b` is the bundled engine's `qwen3:8b`. A bare id (`qwen3:8b`, whose own colon is the tag) still means the default provider.
  - Migration 009 renamed the builtin provider `ollama` → `hub` and rewrote `ollama:X` chain links. Core's 035 rewrote `chat.model`/`chat.vision_model` values that carried the `ollama:` prefix.
  - **History keeps `ollama`.** Usage rows and probes written before S40 still say so, because that was true. `ollama` is now a reserved provider name, so nothing new can take it over.
- **Reading an engine.** `GET /admin/engines[?live=1]` and `GET /admin/engines/{name}` replace `/admin/vram`, which is gone.
  - Each engine states what it saw (`ready`, `unreachable`, `switched_off`, `unobserved`), with its reason, when it saw it, its models, and its compute.
  - Failures are cached for 10 s and successes for 30 s.
- **Measurement identity.** Every served reply, probe and usage row carries `served_on`, the compute it actually ran on, in the D10 grammar (`gpu:cuda:<uuid>`, `cpu:<model>|<n>c|<GiB>g`, joined by `+` for a split). `runtime` (`container`) is recorded separately.
  - When it cannot be known, it is **omitted, never guessed**.
  - Fit and speed read only numbers measured on the same compute. Legacy probes with no compute are never read by fit.
- **The serving switch** is in Settings → Models → Machines, or you can ask her ("stop running chat models here" → `machine_configure`, which reads the value back).
  - When it is off, chat routing passes over that machine and the next link in the role's chain answers, saying so. With no next link, the turn fails and says why.
  - Calls that name their model with no role are still served there.
  - **Memory's embeddings do not go through the switch.** The memory service calls the bundled ollama container directly (`http://ollama:11434`), so a switched-off `hub` still embeds. If that container stops answering, the urgent `peer_down:hub` check still fires.
- **Rollback of S40 (drilled on copies of live data).** `pg_restore --clean` does **not** work over an S40 database, because `providers` cannot be dropped while `engines` references it. Instead:
  1. Stop `gateway` and `core`.
  2. Drop and recreate each database: `DROP DATABASE nova_gateway; CREATE DATABASE nova_gateway OWNER gateway;` and `DROP DATABASE nova_core; CREATE DATABASE nova_core OWNER core;` (the owners are the service roles from `postgres-init/01-databases.sql`).
  3. `pg_restore -U postgres -d <db>` the pre-S40 dumps.
  4. `docker tag nova-<svc>:pre-s40 nova-<svc>:latest`.
  5. `up -d --no-deps --no-build --force-recreate gateway core web`.

**Since S42a, `machine_status` also lists Nova's agents** — hands and facts,
never models — as a separate listing from the engines above, grouping the
agents **among themselves** by machine identity (an agent's `machine_uid`).
Nothing here links a specific engine to a specific agent by that identity
yet — that join is S44's. A machine with no models still shows up, through
its agent alone. See "Devices and daemons" below and `apps/novad/README.md`.

## Decision models (Jev and Kev)

Since the decision role (`docs/plans/rebuild/decision-role/spec.md`), before Nova
answers a typed chat message, core asks the decisions role two things: which of her
tools the message needs, and which recalled notes are still right for it. The answer
can add one hint line to her turn — only when the tool fit and the gate are each at
least 0.30 — and can narrow the recalled notes to the ones still judged current. She
still decides, and every guard still judges what she writes.

- **Where it is set.** The `decisions` routing role, in Settings → Routing, edited like
  chat's chain. A link whose provider cannot answer typed questions is refused, by name;
  the Routing picker itself offers the decisions role decision models only, so its chain
  never holds a chat model:
  - **Jev** (cloud): `openrouter:~typesafe/jev-latest`, through the existing `openrouter`
    provider and its key. Models lists it under Cloud with a `decisions` tag. The step's
    total cost (`cost_usd`) is on its `decisions` span, and the Spend page shows it
    under the `decisions` role.
  - **Kev** (your own machine): Providers → Add → the **Kev** preset — the `systemone`
    adapter at `http://<host>:8009/v1`, ticked "Runs on my own machine", so it is never
    priced or capped. The server is started by hand until the Kev engine exists, run
    from a clone of [jaredpalmer/kev](https://github.com/jaredpalmer/kev):
    `uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --host 0.0.0.0
    --port 8009` — `--host 0.0.0.0` is what lets the gateway reach it. Kev is a local
    decision model, and those are switched off until you turn them on (below).
- **Local and cloud: two switches.** Beside the decisions chain in Settings → Routing:
  **Local decision model** (alpha, off by default) and **Cloud decision model** (beta, on
  by default). A link's kind is its provider's "Runs on my own machine" flag, never its
  name. A link whose kind is switched off is passed over for that call — never dialled,
  never walled — and the next link answers; the route says why
  (`dell-kev:kev-latest: local decision models are switched off in Settings (alpha)`), and
  so do "right now: … would answer" in Routing and Nova's `route_explain`. The chain's
  order stays yours. Local is alpha because on a GPU shared with the chat model it rarely
  answers in time: measured on 2026-09-29 with `dell:qwen3:8b` loaded, Kev-4B answered
  within the 5 s budget on 1 of 90 corpus turns and 0 of 10 latency runs (1.8 s alone and
  warm; Jev took 0.8 s). When it cannot answer in time, the step is skipped and the
  message waits up to 5 s. Cloud is beta: the message and its recalled notes go to the
  provider, at a small cost per message. With **both off**, the step does not run at all
  — no call, no delay, no cost — and the turn's `decisions` span says so
  (`outcome: "off"`). Core reads the switches for each turn that asks and names the kinds
  allowed on each call (`X-Nova-Decision-Kinds`); a call with no such header allows every
  kind.
- **With no decision model** — an empty chain, which is how every install starts — nothing
  changes: each turn runs exactly as before, and its trace says why.
- **The budget.** The whole step has 5 seconds per turn (`decisions.TURN_BUDGET_S` in
  core). A slow or unreachable decision model costs the hint, never the turn, and a
  decision is applied whole or not at all. A decision server that cannot be reached, or
  fails with a 5xx, is walled and the next link answers. That wall lapses on the outage
  ladder (1 minute, then 5, then 30 while it keeps failing), and its first clean answer
  after that resets the ladder. A refused key or a rate limit (401, 402, 403, 429) walls
  the whole provider for an hour, then 6, then 24. "Try it again" in Settings → Routing
  clears a wall at once.
- **Where it does not run (yet).** Scheduled firings and agents' turns never ask. Neither
  does a second message sent while she is still answering the first — it is queued, then
  drained without the step once her turn ends. The eval runner's turns do run it,
  because they measure the chat path.
- **Reading it.** Each turn it ran on has one `decisions` span: the kinds allowed
  (`kinds`), the hint, its fit and the gate, each note's scores and verdict by path (never
  its text) when the notes were checked, who served, its cost (`cost_usd`), and — as the
  span's duration — how long it took:
  `SELECT meta, duration_ms FROM turn_spans WHERE turn_id = '<id>' AND kind = 'decisions';`
- **The Jev Router switch.** Settings → Routing shows "Let Jev Router pick the cloud
  model" on Chat, Scheduled tasks and each agent's role, read off what your turns
  actually do: it shows on exactly when the first cloud model a turn would reach is Jev
  Router. On, the role's first cloud link becomes `openrouter:typesafe/jev-router`,
  which picks a model and reasoning effort per request, balancing quality, speed and
  cost — you pay for the model it picks. Off puts the link it replaced back. Local links
  keep their places: when chat's own pick is a cloud model, the switch puts Jev Router in
  its place, and switching off puts the pick back. Scheduled tasks send chat's pick first
  too, so while that pick is a cloud model their switch is chat's: use chat's switch, or,
  when Jev Router is the pick because you chose it in chat, pick another model there. A
  role with no chain of its own walks chat's chain, and its switch reads it there; to
  switch it by itself, give it a chain of its own — an agent's role always needs one for
  that, because its turns send no chat model. Switching a role off can empty its own
  chain; it then walks chat's chain again, and the switch says so when Jev Router is on
  there. With no chain and no chat model, chat answers with the gateway's default model,
  and switching Jev Router on asks you to pick a chat model or give chat a chain first.
  The model it picked is on the round's `llm_call` span as `upstream_model`.

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

Nova's agent runs on Linux, macOS and Windows (S42a); install it on Windows
itself, never inside WSL. How: `apps/novad/README.md`. `machine_status` lists
every agent by machine, with what it can do; two agents on one machine raise
a digest notice (`devices_duplicate_agents`); a revoked agent wipes its
identity and stops.

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

## Adding devices and phones

Since S47, ask Nova in chat to put herself on a device and she sends a QR card — a QR
code, a short link and, for a machine, a one-time code. She never says the code out loud;
it is only ever on the card. This comes from her `show_setup_qr` tool; `nova_address` is
what she reads first to know her own address.

- **A phone or tablet, as the PWA:** "How do I put you on my phone?" sends a card whose
  link opens `/install` on that device — the add-to-home-screen steps for its own browser,
  then sign in.
- **The Nova app:** "Where do I download your app?" sends a card whose link opens `/app`.
  There is no native app yet, so that page shows the same PWA install steps instead.
- **A machine Nova controls:** "Add my laptop" sends a card with a one-time pairing code,
  good for 10 minutes, and the one-line command for Nova's agent. The code rides in the
  link's fragment, which a browser never sends anywhere — it reaches no server, proxy or
  log, and never her own reply.
- **A model server:** the same card as a machine, plus a note that serving its models
  needs the models role (S44), not built yet — today it just pairs as a machine Nova
  controls.

**Step zero:** the phone and app cards say the other device must already be signed in to
Tailscale on the same tailnet before the link works — Nova cannot check this, so the page
loading there is the check. The machine and model-server cards don't carry that line.

Every QR encodes the derived tailnet address (above), never `127.0.0.1` or a LAN address.
With no address to give out, she says so and sends no card.

## Connections (MCP servers)

Nova can use the tools other services publish over MCP (the Model Context
Protocol): GitHub's CI runs and job logs today, and any app she installs later
that ships an MCP server over HTTP. **Settings → Connections** lists what is
connected; she can connect and remove servers herself too.

**Adding GitHub (CI).**
1. On github.com: Settings → Developer settings → Fine-grained personal access
   tokens → Generate. Repository access: the repositories she should watch.
   Permissions: **Actions: Read** (Metadata: Read comes with it).
2. In Nova: Settings → Connections → Connect a server → Start from **GitHub
   (CI)** → paste the token → Connect. The server is asked what it offers
   before it is saved; if it does not answer, the reason is shown and nothing
   is saved.
3. Ask her: "why is CI red on main?"

**What is stored, and where.** The server's name, its tool list, and the
token and any extra headers, in core's database, like provider keys: written
once, never shown again, never in her context, the trace or a log. Only the
address's ORIGIN (scheme, host, port) is ever shown or traced — never its
path, because some servers authenticate BY a secret path (a server with no
token or header beside it to catch by). A header's VALUE is treated as a
credential — kept out of every reason, result and trace — only when the
header's NAME says so: it contains `token`, `secret`, `password`, `auth`,
`cookie` or `key` (case-insensitive, so `X-Api-Key` and `Authorization` both
match, but `X-Api-Version` does not). Name any other credential header that
way, or put it in the token field instead. Anyone who can read the database
can read what is stored; the backup bundle is encrypted.

**What she can do.** Connect a server (`mcp_connect`), remove one
(`mcp_disconnect`), look up a server's tools (`mcp_tools`) and run one
(`mcp_call`). Nothing asks you first. When she replaces or removes a server
you added, or a server's tools change, your Inbox says so — and if you had
muted that kind of change for a server, a later change of the same kind
folds into the muted notice instead of raising a new one, and she says that
when asked rather than claiming it is in your Inbox.

**What she sees from a server is capped.** At most 64 KiB of a server's own
words — the label, the answer and its notes together — reaches her from one
call; past that it is cut, and the cut says how many more bytes were left
out (ask the tool for less — fewer lines, one page). A server that sends
more than 4 MiB for one answer is cut off mid-read with a stated reason
("sent more than 4 MiB in one answer; stopped reading") rather than ever
being fully buffered.

**Tools a server declares badly are left out, and recorded.** A tool whose
definition cannot be used is left out of her list; connecting names up to 20
of them and how many more there were, and the same list is on the
`mcp.server_connected` event on the Governance page.

**Honesty checks.** If she says she cannot reach a server that is connected
and whose last call did not fail, or credits a server with an answer when no
call to it succeeded this turn, a sentence correcting her is appended to the
reply — nothing is refused or redone, and she stays silent about it when the
server really did answer.

**Limits.** HTTP(S) servers only (no local stdio servers); a token or extra
headers, no OAuth sign-in; tools only (no MCP resources or prompts); an image
or audio clip a tool returns is noted, not read. Both protocol eras are
spoken: 2026-07-28 and the 2025 handshake.

## Backup

`./install backup` writes **one encrypted file** that carries everything a
Nova is: every database, every carried volume, the parts of `deploy/.env` that
belong to this Nova rather than to this machine, and the checkout's git
identity. The bundle is a `NOVAENC1` tar — scrypt plus AES-256-GCM per 4 MiB
frame — and it **carries its own reader**, so a machine with nothing but
`python3` or nothing but `docker` can open it.

> **Status, 2026-09-21.** The verbs below live in `deploy/backup.sh` and are
> reached through `./install`. Until S41's final wiring commit lands,
> `deploy/install.sh`'s subcommand table still answers only `install` and
> `update`; if `./install backup` says *"unknown subcommand"*, that wiring is
> what is missing. Delete this note when it does not.

```sh
./install backup                                  # the routine one
./install backup --out /media/usb/nova-backups    # somewhere else, this once
./install backup --transport removable            # records how it is leaving
./install backup --move                           # see "Moving Nova", below
```

`--transport` records how the bundle is leaving (`local`, `tailnet`,
`removable`) into the manifest, and makes the final rename intra-filesystem by
construction — on a removable target a cross-filesystem rename is the normal
case, and it would fail *after* the expensive part.

**Where it lands.** `NOVA_BACKUP_DIR` in `deploy/.env`, or `deploy/backups/`
when that is empty (gitignored). The file is
`nova-backup-<host>-<YYYYMMDDTHHMMSSZ>.tar`, mode `0600`, owned by you — not
by root, even though a container wrote most of it.

**The passphrase** is resolved through a named source, never read from one
hard-coded place. `NOVA_PASSPHRASE_SOURCE` in `deploy/.env` is one of:

| source | where it reads | notes |
|---|---|---|
| `file` (default) | `NOVA_PASSPHRASE_FILE`, default `deploy/.backup-passphrase` | mode `0600`; the **only** source that may create one, and only when the file does not exist at all |
| `env` | `$NOVA_BACKUP_PASSPHRASE` | |
| `prompt` | the terminal | with no terminal this is a stated *cannot*, never a quiet fallback |
| `cmd` | stdout of `NOVA_PASSPHRASE_CMD` | e.g. `op read op://nova/backup/passphrase` — a secrets manager needs no new code |

A store that **exists and cannot be read** is never treated as absent. That
distinction is the whole reason the seam exists: a logged-out secrets manager
must refuse the backup, not generate a second passphrase over the one that
still seals every bundle you already have.

**The passphrase is the only thing that opens a bundle, and Nova's copy of it
lives on the machine the bundle exists to survive. Write it down somewhere
else.** The run prints a 12-hex *fingerprint*, which says WHICH passphrase
without carrying it.

**What the run verifies, in order.** Each of these is a step that fails and
says why rather than continuing:

1. A lock, so two backups cannot interleave.
2. Coverage, derived from the **raw compose text** — every volume and bind
   must carry a disposition (`x-nova-backup:` beside it in
   `docker-compose.yml`) and every `deploy/.env` key a `# nova-backup:` line.
   An **unclassified volume refuses the backup**. There is no hand-kept
   exclusion list to fall out of step.
3. The writers are stopped and *proved* stopped — `.State.Running` false
   **and** `.State.FinishedAt` at or after the moment the stop was issued, so
   a container that was already dead is not mistaken for one this run
   quiesced. Which services those are is **derived from the compose render**,
   not a list in the script, so a service added to the stack is quiesced
   because it is there and not because somebody remembered it.
4. A per-table census — row counts and digests — recorded before the dump.
5. `pg_dump -Fc` per database, inside the postgres container.
6. A **self-test restore** of that dump into a throwaway database, compared
   against the census.
7. The volumes, tarred container-to-container; every symlink recorded as its
   own listing line, so a *retargeted* link is visible rather than invisible.
8. The bundle is packed, and then **the reader that ships inside it is run
   against the finished bundle** with `cryptography` forced unimportable — so
   the path a bare machine takes is the path that was proven, here, before
   you needed it.
9. Everything a container wrote is `chown`ed to you and **re-read as you**
   before it counts.
10. The writers are restarted and each one's healthcheck is read back — or,
    with `--move`, the host is parked (below). Every exit path ends in one of
    those two states and **says which**.

The report at the end names the bundle, its size, its sha256, its mode and
owner, the passphrase fingerprint, the reader's digest, and **everything the
bundle does not carry with the reason for each**. Check the digest yourself,
as yourself:

```sh
sha256sum  /media/usb/nova-backups/nova-backup-dell-workstation-20260921T143012Z.tar   # GNU
shasum -a 256 /media/usb/nova-backups/nova-backup-dell-workstation-20260921T143012Z.tar # macOS
```

## Restore, and the drill

```sh
./install restore nova-backup-dell-workstation-20260921T143012Z.tar
./install restore nova-backup-dell-workstation-20260921T143012Z.tar --drill
./install drill                     # the newest bundle in NOVA_BACKUP_DIR
```

A **wrong passphrase is refused before a single payload byte is read.** The
bundle carries a known-answer test — 64 known bytes under their own fresh salt
— and nothing proceeds until a decryptor reproduces it. The refusal says so,
so "it failed" is never ambiguous between *wrong passphrase* and *corrupt
file*.

`restore` verifies its own work rather than reporting that it ran: it compares
every table's count and digest against the census sealed into the bundle,
diffs every volume against the listing sealed beside it, and compares the
**core signing key fingerprint** — the key every paired device pins. Only when
all three have run does it print the word `restored`, and it then prints what
this bundle does *not* carry, each with the reason recorded when it was
written. It leaves `deploy/.restored` behind and postgres stopped; `./install`
is the next command.

If a restore is interrupted it leaves `deploy/.restore-in-progress`, which
records **exactly what it created**. A later run refuses on that marker and
prints the list. Nothing discovers anything: that list is the bound.

`--drill` is the same walk, non-destructively. It restores into throwaway
objects named `nova-drill-<8 hex>…`, compares the same three things, and
sweeps every object it made. **No `nova-drill-*` container, volume or network
may survive a drill**; the sweep is anchored to that exact name shape, never
to a prefix. Run it on a schedule if you like — a backup nobody has opened is
a belief, not a backup.

### Opening a bundle on a machine that has no Nova

The reader travels inside the file, byte-identical to `deploy/backup/restore.sh`
in this repo:

```sh
tar -xOf nova-backup-dell-workstation-20260921T143012Z.tar restore.sh \
  | sh -s -- nova-backup-dell-workstation-20260921T143012Z.tar ./out
```

It is POSIX `sh`, and it probes four decryptor backends **in order**, accepting
one only after the known-answer test passes: host `python3` with
`cryptography`; host `python3` with a usable libcrypto through `ctypes`; the
core image, if this machine has it; `python:3.12-slim`, pulled. If none passes
it prints exactly what to install and exits non-zero — it never falls back to
"try anyway". Add `--verify-only` to check a bundle without writing anything.

The decryptor images are **constants in that script**, overridable only by
`NOVA_CRYPTO_IMAGE` / `NOVA_FALLBACK_IMAGE` that you type. Nothing inside a
bundle selects the code that opens it: a bundle is a file that can come from
anywhere.

## Moving Nova to another machine

The move is a backup that also **parks the source**, so two Novas never serve
the same data or fight over the same tailnet identity.

On the machine Nova is leaving:

```sh
./install backup --move --out /media/usb/nova-backups
```

`--move` differs from a routine backup in four ways: the tailnet node's state
is carried (it is `move-only`, excluded from every other backup), the sidecar
joins the quiesced set, the whole stack is left stopped, and two markers are
written — `deploy/.moved` and `deploy/tailscale/MOVED_TO`. The run proves the
stack is stopped by reading `.State.Running` back for every service, and
writes each marker and **reads it back** before it says the host is parked.

Then carry the file, and check it arrived whole — the digest the run printed,
computed again on the far side, by you:

```sh
sha256sum nova-backup-dell-workstation-20260921T143012Z.tar
```

On the machine Nova is moving to:

```sh
./install restore nova-backup-dell-workstation-20260921T143012Z.tar --drill   # rehearse
./install restore nova-backup-dell-workstation-20260921T143012Z.tar           # then do it
./install                                                                     # bring it up
```

Rehearse with `--drill` first if the target is new to you: it proves the
bundle opens and that every count, digest and the signing-key fingerprint
match, and leaves nothing behind.

**Then point the devices at the new hub.** Core's signing key travelled inside
the bundle, so each machine's pinned key is still correct and only the URL
changed:

```sh
novad repoint --server https://nova.example-tailnet.ts.net --check   # prove it, write nothing
novad repoint --server https://nova.example-tailnet.ts.net           # then write it
systemctl --user restart novad
novad status
```

`repoint` completes the whole device handshake before it writes: it refuses a
server whose `core_pubkey` is not the pinned one, and it refuses a server that
holds the right key but has forgotten this device. Whoever owns a DNS name can
serve a Nova-shaped socket; they cannot produce core's ed25519 key.

**What the parked machine does now.** Two refusals, at the two layers that
would otherwise cause the damage:

- `./install` refuses first, before any docker call, prints the marker
  verbatim and names the way back.
- The **tailnet sidecar refuses to start at all** while
  `deploy/tailscale/MOVED_TO` is present — so a reboot, a restart policy or a
  stray `docker compose up -d` cannot put a second tailscaled on the node key
  and flap the address you reach Nova at. (`deploy/tailscale/` is already
  bind-mounted into that container read-only at `/config`, which is why the
  marker lives there and needs no compose change. Bound honestly: a
  `docker run` of that image that does **not** mount `/config` bypasses it.)

**Undoing a park** — because the move failed, or because this machine is the
one that should serve after all — is `./install undo-move`. It prints the
marker, says either what it found on the tailnet or that it cannot check from
here (the sidecar is stopped, so there is no tailscaled to ask), warns that
bringing this node up while the other is online will flap the node key, and
acts only after you type `undo`.

It then **brings this machine back**: `MOVED_TO` is removed first, because the
sidecar refuses to start while it exists; the project is started; **every
service is read back** rather than trusting that `up` returned 0; and
`deploy/.moved` is removed only once that has passed. A run that cannot finish
names the half-done state it is leaving and exits 4 — it never reports a
recovery it did not verify.

Doing it by hand is removing `deploy/tailscale/MOVED_TO`, then
`deploy/.moved`, then `./install` — in that order. The verb exists so you are
told what you are undoing first, and so the "did it actually come back" check
is not left to you at the moment you are least able to do it.

## Regenerating the backup fixtures

`deploy/backup/tests/test_coverage_v4_real.py` asserts that the dispositions in
`deploy/docker-compose.yml` cover the **real** stack, against fixtures captured
from a running one. Regenerate them with:

```sh
deploy/backup/fixtures/refresh.sh
```

It is read-only against the stack — `docker compose config`, `docker ps`,
`docker inspect`, one `psql -c SELECT`, and one throwaway `docker run --rm` per
carried volume with the volume mounted `:ro`. It starts nothing and stops
nothing, and writes nothing outside `deploy/backup/fixtures/`. Every absolute
path — this checkout's, and the checkout the live stack was actually created
from, which are often not the same directory — is normalised to `/repo`, and
the suite has its own checks that this happened, because a container capture
from one tree beside a compose render from another makes every bind look
undeclared.

**Stage the working tree first.**

```sh
git add -- deploy/docker-compose.yml deploy/.env.example   # whatever you changed
deploy/backup/fixtures/refresh.sh
```

`refresh.sh` asks git what is tracked and `git ls-files` reads the **index**,
so a fixture captured with new files unstaged records them as `unknown` and the
suite goes red on files that are about to be committed.

Run it:

- in the **same commit** as any change to `deploy/docker-compose.yml`'s
  volumes, binds or `x-nova-backup` rows — otherwise the suite pins a stale
  render;
- when the (deliberately unpinned) searxng image starts declaring another
  `VOLUME`. That refusal is expected, and refreshing the container fixture is
  how the new volume gets classified;
- when docker or compose changes under the stack. The fixtures are named after
  the compose version, so two hosts produce two sets rather than overwriting
  each other.
