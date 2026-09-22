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
