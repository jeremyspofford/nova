# Moving Nova from the Dell to the mini PC — the reversible runbook

**Status: a plan, not a record.** Nothing in here has been executed. Every
factual claim about this repo or either machine carries its source — a
`path:line` in this worktree, or the exact command whose output it came from,
run read-only on 2026-09-21. Nothing was started, stopped, removed, deployed
or written to on either machine while this was written.

**Stance, from the brief and obeyed throughout:** every step is individually
undoable, and the Dell stays authoritative until the last possible moment.
Where a shorter sequence exists, this document takes the longer one on
purpose.

## Placeholders — this repo is public

Real addresses, hostnames, account names, home paths and hardware UUIDs are
**replaced by placeholders** below. Substitute your own when you run this.

| Placeholder | What it is |
|---|---|
| `<DELL>` | the source machine: Windows 11 + WSL2 + Docker Desktop + RTX 3090 |
| `<HUB>` | the destination: the mini PC, Pop!_OS, N150, always on |
| `<USER>` | the shell account on both machines |
| `<REPO>` | the Nova checkout path on the machine in question |
| `<TAILNET>` | your tailnet's DNS suffix, so Nova's URL is `https://nova.<TAILNET>.ts.net` |
| `<DELL-TS>` | the Dell's **own** tailnet address (its native node — **not** Nova's) |
| `<HUB-TS>` | the mini PC's **own** tailnet address (its native node) |
| `<BUNDLE>` | a bundle filename, `nova-backup-<host>-<stamp>.tar` |
| `<PW>` | the bundle passphrase |

Docker bridge addresses (`172.18.128.x`) are **not** placeholders: they are
literal defaults already committed at `deploy/docker-compose.yml`.

---

## 0. The shape of the move, in one paragraph

Nova's tailnet identity is a **volume**, not a config file: `v4_tailscale`
holds `tailscaled.state` and is `TS_STATE_DIR`
(`deploy/docker-compose.yml:342`, `:323`). `backup --move` flips that
volume's disposition from `move-only` to `include`
(`deploy/docker-compose.yml`, the `v4_tailscale` block: `x-nova-backup:
move-only`), stops every service and proves each one stopped
(`deploy/backup.sh:2178-2203`, `bk_park`), then writes two markers
(`deploy/tailscale/MOVED_TO` and `deploy/.moved`, `deploy/backup.sh:2205-2226`)
and reads them back. The destination restores that volume bit-for-bit and
installs with **no auth key**, because `TS_AUTH_ONCE: "true"`
(`deploy/docker-compose.yml:324`) makes containerboot consult `TS_AUTHKEY`
only when the state store holds no logged-in node. Same node key, same DNS
name, same TLS cert, same cookie scope — so the phone keeps its home-screen
icon and its session.

The whole risk is that **two tailscaled must never hold one node key at
once**. Every ordering rule below exists for that one reason.

---

## 1. What travels, and what does not

Read from `deploy/docker-compose.yml`'s `volumes:` block and
`deploy/.env.example`.

| Volume | Disposition | Consequence for the move |
|---|---|---|
| `v4_pgdata` | `dump-pg` | three `pg_dump -Fc` files travel; a fresh PGDATA initialises from `deploy/postgres-init/01-databases.sql` with the **carried** password |
| `v4_memdata` | `include` | the notes — measured **3.8 MB** (`s41/measurements.md`, R3) |
| `v4_workspace` | `include` | her scratch — measured **244 KB** (same) |
| `v4_models` | `exclude-redownload` | gateway's `/models`; nothing reads it but a `statvfs` |
| `v4_ollama` | `exclude-redownload` | **model weights do NOT travel.** Measured on the Dell: 7 models, ~82 GB |
| `v4_tailscale` | `move-only` | travels **only** on `--move`; that is the identity |

Database sizes, measured on the Dell
(`docker exec nova-postgres-1 psql -U postgres -At -c "select datname,
pg_size_pretty(pg_database_size(datname)) from pg_database where datname like
'nova%'"`): `nova_core` **15 MB**, `nova_gateway` **9.3 MB**, `nova_memory`
**7.6 MB**. So the whole bundle is **tens of megabytes**, not gigabytes.
Transfer time is not a term in the downtime budget.

`.env` keys marked `# nova-backup: carry` (`deploy/.env.example:26,28,30,32,37,47,100`)
travel: `POSTGRES_PASSWORD`, `CORE_TOKEN`, `CORE_GATEWAY_TOKEN`,
`CORE_MEMORY_TOKEN`, `SEARXNG_SECRET`, `NOVA_PUBLIC_GATE_TOKEN`,
`TAILNET_HOSTNAME`. Keys marked `host` do **not**: `COMPOSE_FILE`,
`COMPOSE_PROFILES`, `NOVA_SUBNET*`, `NOVA_WEB_ADDR`, `NOVA_TAILSCALE_ADDR`,
`TS_AUTHKEY`. `INSTANCE_SECRET` is declared `drop`
(`deploy/.env.example:143-144`) — dead config, deliberately not carried.

**The one thing that does not travel and that people forget:** local model
weights. After the move the hub has an ollama with whatever is already on it.
Measured on the mini PC today (`docker exec nova-ollama-1 ollama list`): one
model, `nomic-embed-text:latest` — **the embedder, and no chat model at all.**
Phase 6 is not optional.

---

## 2. Prerequisites — every one of these must be true before step 1

Each has a check you can run and a stated action when it fails. Several are
**false today**; they are marked so.

### P1 — the S41 verbs are reachable from `./install` — **FALSE TODAY**

```
grep -n 'case "$cmd" in' -A 6 deploy/install.sh
grep -n '^cmd_backup()\|^cmd_restore()\|^cmd_drill()\|^cmd_undo_move()' deploy/backup.sh
grep -c 'backup\.sh' deploy/install.sh
```

**Verifies:** `main()` dispatches `backup`, `restore`, `drill` and
`undo-move`, and `deploy/install.sh` sources `deploy/backup.sh`.

**Measured 2026-09-21 on branch `slice/s41`:** `main()`
(`deploy/install.sh:1830-1837`) knows only `install` and `update` and dies
with *"unknown subcommand: $cmd (expected: install, update)"*.
`deploy/install.sh` does not source `deploy/backup.sh` — the only matches for
`backup.sh` in that file are comments (`deploy/install.sh:68`).
`cmd_backup` (`deploy/backup.sh:2337`), `cmd_restore` (`:3980`) and
`cmd_drill` (`:3993`) exist and nothing dispatches to them.

**On failure: stop. The move cannot begin.** No workaround is acceptable here
— sourcing `backup.sh` by hand to call `cmd_backup` skips whatever wiring
`cmd_install` does first, including `refuse_if_moved`.

### P2 — `undo-move` exists — **FALSE TODAY**

```
grep -n '^cmd_undo_move()' deploy/backup.sh
```

**Verifies:** the scripted way back onto the Dell exists.

**Measured:** no match. `deploy/backup.sh:21` says in prose *"`cmd_undo_move`
is still owed"*, while `bk_park` already prints `undo it with: ./install
undo-move` (`deploy/backup.sh:2227`) and two refusals name it
(`deploy/backup.sh:2423`, `:4076`). The design is `s41/design-verdict.md:1819-1846`.

**On failure:** either wait for it, or proceed **only** after writing the
manual undo down, on paper, before step 1:

```
rm <REPO>/deploy/.moved <REPO>/deploy/tailscale/MOVED_TO
```

and knowing that it performs **none** of `undo-move`'s checks — no liveness
read, no typed confirmation, no read-back. If you take that route, Phase 3's
rollback is a hand operation at whatever hour it fails.

### P3 — the checkout you run the move from owns the running stack

```
docker inspect nova-core-1 --format '{{index .Config.Labels "com.docker.compose.project"}}'
docker inspect nova-core-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
```

**Verifies:** the project name is `nova` and the config files are the ones
your `COMPOSE_FILE` resolves to.

**Measured on the Dell:** project `nova`, config files
`<REPO>/.worktrees/v4/deploy/docker-compose.yml,<REPO>/.worktrees/v4/deploy/docker-compose.gpu.yml`
— **two** files, the second being the GPU overlay. That worktree is on branch
`rebuild/v4` at `0996a31f`.

**On failure:** a backup run against a different `COMPOSE_FILE` reads a
different stack than the one serving. Fix `COMPOSE_FILE` in the `.env` beside
the compose file you are invoking, re-run the inspect, and only proceed when
both strings match. Dropping the GPU overlay is the documented
`compose GPU overlay trap`: it silently puts ollama on CPU.

### P4 — the source checkout carries S41 **and** is the one serving

P1 and P3 must be true **of the same directory**. Today they are not:
`slice/s41` (this worktree) has the code; `.worktrees/v4` at `rebuild/v4`
serves the stack. **On failure:** merge S41 to whatever the live stack runs
from, bring the stack up on it (`docker compose up -d`, not `restart`), and
re-check P3. Do this days before the move, not on the day.

### P5 — the destination checkout is the **same Nova**, by migration content hash

```
# on <HUB>
git -C <REPO> rev-parse --short HEAD
git -C <REPO> rev-parse --abbrev-ref HEAD
```

**Verifies:** the mini PC's checkout is at the sha the bundle records in
`manifest.source.repo_sha`.

**Why it binds:** `restore` gates on migrations by **content hash** — for
every entry in `manifest.databases[].migrations_member` a file of that hash
must exist in this checkout's `services/<svc>/migrations/`, and there is **no
override flag** (`s41/design-verdict.md:1587-1604`, and the field-name ruling
in `s41/rulings.md`, "B. §5.3 wins over §9.2 step 7"). A renumbered migration
still matches; a genuinely different one refuses, naming the file, its
database and the source sha.

**Measured today:** the mini PC is on `main` at `e5abd0b`; the Dell's live
stack is `rebuild/v4` at `0996a31f`. **These differ.** **On failure:** check
out the source sha on the mini PC and re-run. Do not edit migrations to make
the gate pass.

### P6 — the images are already built on the mini PC

```
# on <HUB>
docker compose --project-directory <REPO>/deploy config --services
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'nova[-_]'
```

**Verifies:** `core`, `gateway`, `memory` and `web` — the four services with a
`build:` stanza (`deploy/docker-compose.yml:36`, `:86`, `:122`, `:142`) — have
images built **from the P5 sha**.

**Why it is a prerequisite and not a step:** on an N150 this build is the
single largest term in the downtime budget. Built beforehand it is zero.

**On failure:** run `docker compose --project-directory <REPO>/deploy build`
on the mini PC **before the move**, at the P5 sha. This starts nothing.

### P7 — the passphrase is resolvable on both machines and recorded off both

```
grep -n 'NOVA_PASSPHRASE_SOURCE\|NOVA_PASSPHRASE_FILE\|NOVA_PASSPHRASE_CMD' <REPO>/deploy/.env
```
(`deploy/.env.example:170,177,181` declare the seam.)

**Verifies:** a resolver is configured, and you can state which one.

**On failure:** stop. A bundle nobody can open is not a backup. Record `<PW>`
somewhere that is neither machine **before** step 1 — the Dell is about to be
stopped and the mini PC is about to be wiped.

### P8 — disk

```
# on <DELL>
df -h "$(grep -E '^NOVA_BACKUP_DIR=' <REPO>/deploy/.env | cut -d= -f2-)" 2>/dev/null || df -h <REPO>
# on <HUB>
df -h /
```

**Verifies:** the bundle directory has room, and the mini PC has room for the
restored volumes plus a drill's throwaway copy.

**Measured on the mini PC:** 341 GB free of 460 GB. Bundle is tens of MB. This
one is not close.

**On failure:** free space. `§9.1`'s free-space refusal will stop you anyway
(`s41/measurements.md`, R3).

### P9 — `NOVA_BACKUP_DIR` is declared and writable, mode 0600 capable

```
grep -n '^NOVA_BACKUP_DIR=' <REPO>/deploy/.env.example   # :80
```
The outer archive is mode 0600 owned by the operator
(`s41/design-verdict.md:432`), and requirement #26 refuses an archive path
that cannot hold 0600. A CIFS/SMB target is **unmeasured**
(`s41/measurements.md`, "Still not measured", risk 6).

**On failure:** point `NOVA_BACKUP_DIR` at ordinary local disk. Do not move
the bundle to a network share until after it has verified.

### P10 — postgres major on the destination ≥ the dump's major

```
# on <HUB>
docker run --rm postgres:16 pg_restore --version
```

**Verifies:** the restore's own version gate (`§9.2 step 7`) will pass.

**Measured on the Dell:** server **PostgreSQL 16.15**, and the `postgres:16`
tag resolves to that same image today (`s41/measurements.md`, R1). But
`deploy/docker-compose.yml:5` pins the **major only**, so the tag floats and
the mini PC will pull whatever `postgres:16` is on the day.

**On failure:** the restore refuses with both numbers. Pin the same digest on
both hosts and re-run.

### P11 — a subnet is free on the destination

```
# on <HUB>
docker network ls --format '{{.Name}}' | while read n; do
  printf '%s %s\n' "$n" "$(docker network inspect "$n" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}')"
done
```

**Verifies:** `decide_subnet` has somewhere to land.

**Measured on the mini PC today:** `bridge` 172.17/16, `jobhunter_default`
172.19/16, `nova_default` 172.18/16 (that last one is the dry-run stack's, and
Phase 2 removes it). `s41/measurements.md` lists this as risk 9, **not
measured for the day of the move** — re-read it then, do not trust this table.

**On failure:** the restore dies naming the colliding network. Free one, or
pin `NOVA_SUBNET` somewhere clear.

### P12 — the mini PC is reachable by a path that is not Nova

```
ssh -o BatchMode=yes <USER>@<HUB-TS> 'echo OK; hostname'
```

**Verifies:** you can reach the destination while Nova's URL is dead.

**Measured:** the mini PC has its **own, separate, already-registered** native
tailnet node, distinct from Nova's `nova` identity, and ssh over it works. The
move never touches that node.

**On failure: stop.** Without this you are moving Nova blind. This is the
single prerequisite that turns a bad move from "recoverable" into "drive to
the machine".

### P13 — the node key does not expire inside the window

Read on the Dell:

```
docker exec nova-tailscale-1 tailscale status --json
```

**Verifies:** `KeyExpiry` is comfortably beyond the move, and
`Self.DNSName` is the name you expect.

**Measured 2026-09-21:** `BackendState: "Running"`, `HaveNodeKey: true`,
`Self.DNSName: "nova.<TAILNET>.ts.net."`, `Self.Created: "2026-07-14T21:13:49Z"`
(the original node, never re-created), `KeyExpiry: "2027-01-10T21:13:49Z"`.

**On failure, or if the park will be long:** a key that lapses while the
identity sits in a bundle forces a real re-auth and breaks the bit-identical
guarantee this whole plan rests on. Disable key expiry for that node in the
admin console first, or do not park for months.

### P14 — HTTPS certs are on for the tailnet

The same `tailscale status --json` shows `CertDomains` including
`nova.<TAILNET>.ts.net`. `deploy/tailscale/serve_check.sh:93-105` only
**warns** when they are not; it never gates. **On failure:** turn certs on
tailnet-wide before the move, or the destination comes up on a name the phone
will not open over HTTPS.

### P15 — the destination has, or will have, a chat model

```
# on <HUB>
docker exec nova-ollama-1 ollama list
```

**Measured:** `nomic-embed-text:latest` only. That is the embedder.

**Why it binds:** `hub` is the default provider and `providers.base_url_of`
(`services/gateway/app/providers.py:108-109`) resolves the builtin row to the
**live** `OLLAMA_URL` — `http://ollama:11434`
(`deploy/docker-compose.yml:94`) — never a stored column. So after the move
`hub` silently means *the mini PC's own CPU ollama*. And
`routing.py`'s cross-tier local standby only considers a model ollama
declares fit for chat (`services/gateway/app/routing.py:405-418`), so with
only an embedder installed there is **no** local fallback to derive.

**On failure:** Phase 6 fixes it. Do not skip Phase 6.

### P16 — nothing else on the destination may be collateral

```
# on <HUB>
docker ps --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}'
```

**Measured:** `minecraft-bedrock` and `minecraft-backup` are **running** and
must stay running; `jobhunter` owns three volumes. Every teardown command in
Phase 2 is scoped by `--project-directory` or by the
`com.docker.compose.project` label — **never by the name prefix `nova`**. That
rule is not caution, it is a near-miss already recorded:
`s41/map-minipc-measured.md` measured a volume named `nova_pgdata` whose
project label said `docker`, and deleting by name would have destroyed
75.8 MB of a different project.

**On failure:** stop and re-scope the command.

---

## Phase 1 — rehearse the whole thing with the Dell fully live

**Downtime: zero.** Nova serves throughout. Nothing here is destructive on
either machine. Every step is undone by deleting a file.

**1.** On the Dell, write an **ordinary** bundle — no `--move`.

```
cd <REPO> && ./install backup
```

**Verifies:** the command prints the bundle path, its sha256, and the
per-volume and per-database facts it recorded. The stack is running again when
it exits — the non-move path restarts the writers it stopped
(`deploy/backup.sh:1676`, the `[ "$BK_RUN_MODE" != "move" ]` branch).

**On failure:** read the failure sentence — it names which of "the writers are
running again" or "this host is NOT parked" applies. Confirm the stack is up
(`docker compose ps`) before doing anything else. Do not proceed to Phase 3
until a plain backup succeeds; if the mechanism cannot write a bundle with the
stack live, it will not write one with the stack stopped.

**2.** Confirm the bundle exists and is 0600, owned by you.

```
ls -l "$(grep -E '^NOVA_BACKUP_DIR=' <REPO>/deploy/.env | cut -d= -f2-)"
sha256sum <BUNDLE>
```

**Verifies:** mode `-rw-------`, owner `<USER>`, and a sha256 equal to the one
the command printed.

**On failure:** a root-owned 0600 file that you cannot read back is the exact
defect `s41/map-minipc-measured.md` records from the cleanup — a container
wrote it and the host-side verification could not read it. Fix the ownership
before trusting any later verification, because a verification you cannot run
is not a verification.

**3.** Copy the bundle to the mini PC over the tailnet.

```
scp <BUNDLE> <USER>@<HUB-TS>:<REPO>/../
ssh <USER>@<HUB-TS> 'sha256sum <path>/<BUNDLE>'
```

**Verifies:** the sha256 on the destination equals step 2's.

**On failure:** re-copy. Never proceed on a bundle whose sha you did not
compare on **both** ends.

**4.** Drill it on the mini PC, with its dry-run stack still running.

```
ssh <USER>@<HUB-TS>
cd <REPO> && ./install restore <path>/<BUNDLE> --drill
```

**Verifies:** exit 0, and the report states tables compared per database,
listings diffed per volume, and signing-key fingerprint equality
(`s41/design-verdict.md:1687-1744`). The drill is non-destructive: it touches
no live volume, no live database, writes no `.env`, and runs a throwaway
postgres on its own `nova-drill-<8 hex>-net` with an explicit subnet. Its
teardown re-asserts the name regex and **verifies each removal** — a removal
that cannot be verified makes the drill FAIL rather than report success on top
of a mess.

**On failure:** this is the whole point of Phase 1 and it costs you nothing to
have found out. Read which gate refused — passphrase (`kat.enc`), member hash,
pg version, migration content hash, volume listing, table counts, signing key.
Fix it with the Dell still serving. **Do not continue to Phase 2.**

**5.** Read what the drill *did not* prove, out loud.

An ordinary backup carries `v4_tailscale` as `move-only`, which means **it was
not in this bundle**. So Phase 1 has proven the crypto, the passphrase, the
migration gate, the pg version gate, the volume listings, every table count
and sum, and the signing key — and has proven **nothing** about the identity
volume. Step 12 drills the real move bundle for exactly that reason.

**Verifies:** you can state this sentence before proceeding. There is no
command; the check is that you do not skip step 12 believing Phase 1 covered
it.

**6.** Delete the rehearsal bundle from the mini PC, or leave it — it is inert
either way. Nothing else in Phase 1 left state.

---

## Phase 2 — prove the GPU path while the Dell is still the hub

**Downtime: zero for Nova.** Step 7 briefly recreates the Dell's `ollama`
container, which interrupts local inference for seconds, not the web UI.

This phase exists because after the move the hub has **no GPU** (measured:
`nvidia-smi` is absent on the mini PC; `docker exec nova-ollama-1 nvidia-smi -L`
on the Dell prints one RTX 3090). The brief's premise is correct in outcome
but wrong in mechanism, and the correction matters:

> **Correction to the brief.** `providers.base_url_of`
> (`services/gateway/app/providers.py:96-110`) does route a non-builtin row to
> its stored address. But `providers.validate_shape`
> (`services/gateway/app/providers.py:146-153`) **refuses** `adapter=ollama`
> for a non-builtin row, in those words: *"adapter=ollama cannot be registered
> here: it is an engine, and the only engine here is the bundled one ('hub') —
> another machine's ollama is reached with adapter=openai-chat at its /v1
> address"*. So the row is **`adapter: "openai-chat"`**, `base_url:
> "http://<DELL-TS>:11434/v1"`, `auth_shape: "none"`. Still no new code. Just
> not the adapter the brief named.

**7.** On the Dell, publish ollama on the tailnet interface instead of
loopback only.

Measured gap: `deploy/docker-compose.yml:256-266` binds
`"127.0.0.1:11434:11434"`, and `docker ps` on the Dell confirms
`127.0.0.1:11434->11434/tcp`. From the mini PC,
`curl -m 5 http://<DELL-TS>:11434/api/tags` returns **exit 7, "Couldn't
connect to server"** — measured today.

The change is one published address. Make it in a host-local overlay
(`deploy/docker-compose.ollama-tailnet.yml`, appended to `COMPOSE_FILE`), not
in the committed compose file, so it is one line to undo and it does not
travel.

```
# on <DELL>, after editing COMPOSE_FILE
docker compose up -d ollama       # NOT restart — restart does not re-read .env
docker port nova-ollama-1
```

**Verifies:** `docker port` shows the tailnet address, not `127.0.0.1`.

**On failure:** put `COMPOSE_FILE` back and `docker compose up -d ollama`. The
Dell is unchanged. Nova never stopped.

> **Unverified, and you must verify it here rather than trust this document.**
> The Dell runs WSL2 in **mirrored** networking mode — evidence: `ip route`
> inside WSL carries a per-peer `/32` route on the tailnet interface for every
> tailnet peer, and `ip -4 -o addr` shows the host's own routable LAN
> address directly rather than a WSL NAT `172.x` one. That strongly implies a
> listener bound to `0.0.0.0` inside WSL is reachable at the Dell's tailnet
> address.
> **I could not run the end-to-end probe** (the sandbox refused to open a
> listener). If step 8 fails, the missing piece is a Windows-side
> `netsh interface portproxy` rule, or binding the publish to the LAN address
> instead — and that is a finding to record, not a step to improvise past.

**8.** From the mini PC, reach the Dell's ollama.

```
ssh <USER>@<HUB-TS> 'curl -s -m 5 http://<DELL-TS>:11434/api/tags | head -c 200'
```

**Verifies:** a JSON model list comes back, naming models you recognise from
the Dell.

**On failure:** do **not** proceed to Phase 3. The move is still safe to do
without the GPU, but you should decide that deliberately rather than discover
it after the hub is homeless. Either fix the path now, or accept that the
moved hub has CPU inference only and say so out loud before step 13.

**9.** Do **not** create the provider row yet.

`POST /admin/providers` runs `_verify_or_502`
(`services/gateway/app/admin.py:670-691`) — an adapter verify that must reach
the address **and nothing is written when it refuses**. Creating the row on
the Dell would verify the Dell's gateway container's path to the Dell's own
tailnet address, which is not the path that will matter. The row is created in
Phase 6, from the machine that will use it, where the verify proves the real
thing.

**Verifies:** `docker exec nova-postgres-1 psql -U gateway -d nova_gateway -At
-c "select name,adapter,builtin,is_default,local from providers"` still shows
exactly what it showed before. Measured today: `hub|ollama|t|t|t`,
`anthropic|anthropic-messages|f|f|f`, `cerebras|openai-chat|f|f|f`,
`openrouter|openai-chat|f|f|f`.

**10.** Tear down the mini PC's dry-run stack.

`restore` refuses a non-empty target **by design** — for every declared volume
whose disposition is `include`, `move-only` or `dump-pg` it probes for
emptiness, and treats "could not determine" as a refusal, not a pass
(`deploy/backup.sh:4350-4392`). It also refuses if **any** container carries
`label=com.docker.compose.project=nova`, exited ones included.

The teardown the refusal itself names (`deploy/backup.sh:4382`):

```
# on <HUB>
docker compose --project-directory <REPO>/deploy down -v
```

**Verifies, all three:**

```
docker ps -a --filter label=com.docker.compose.project=nova --format '{{.Names}}'   # empty
docker volume ls --filter label=com.docker.compose.project=nova --format '{{.Name}}' # empty
docker ps --format '{{.Names}}' | grep minecraft                                     # BOTH still there
```

**On failure:** if anything named `nova_*` survives, inspect its project label
before touching it — `docker volume inspect <name> --format '{{index .Labels
"com.docker.compose.project"}}'`. Remove **only** what the label says is
`nova`. If a minecraft container stopped, you used a command scoped wider than
you thought; start it again before continuing.

**This step is irreversible** for the dry-run stack's data. By the brief that
data is disposable. It is not a point of no return for Nova: the Dell is still
serving, untouched.

---

## Phase 3 — the move

**Downtime begins at step 11 and ends at step 17.**

**11.** On the Dell, run the move.

```
cd <REPO> && ./install backup --move
```

**What it does, in order** (`s41/design-verdict.md:1782-1817`): flips
`v4_tailscale` to `include`, adds `tailscale` to the writer set, dumps and
packs and **verifies** the bundle, and only then calls `bk_park`
(`deploy/backup.sh:2178`) which runs `docker compose --profile '*' stop`,
reads back `.State.Running == false` for **every** service of the project, and
writes both markers with a read-back check on each.

**Verifies:** the two lines `parked: every service of this project reads
.State.Running false` and `parked: the stack is stopped and <MOVED_TO> and
<.moved> are in place`, and then `undo it with: ./install undo-move`.

**On failure — read the sentence, it tells you which state you are in:**
- *"the bundle IS written at ... Separately: `docker compose stop` did not
  exit 0, so this host is NOT parked"* → the bundle is good, the Dell is
  half-stopped. Bring it back: `docker compose up -d`. Do **not** restore on
  the mini PC until the Dell reads stopped or is deliberately running again.
- *"... `<services>` would not stop, so this host is NOT parked"* → same, with
  the names.
- *"could not write the move marker ..."* or *"did not read back as it was
  written"* → the stack **is** stopped and there is **no** marker. Nothing
  protects you from a second `./install` here. Either fix the marker path and
  re-run, or `docker compose up -d` and abort the move.
- A failure earlier, between the writers stopping and `bk_park` — **check the
  stack yourself**. `bk_backup_cleanup`'s restart branch is skipped in move
  mode (`deploy/backup.sh:1676`), so the 2026-09-21 ruling ("a failed
  `--move` parks or restarts, and says which", `s41/rulings.md`) may or may
  not be implemented in the code you are running. Run `docker compose ps` and
  believe that, not the exit message.

**12.** Verify the park independently, and verify the Dell will not start
itself.

```
docker compose ps --all --format '{{.Service}} {{.State}}'
cat <REPO>/deploy/tailscale/MOVED_TO
cat <REPO>/deploy/.moved
grep -n 'MOVED_TO' <REPO>/deploy/tailscale/start.sh
```

**Verifies:** every service `exited`; both markers present, 0600, carrying
`moved_at`, `bundle`, `bundle_sha256`, `source_host`, `tailnet_dns_name`; and
`start.sh` refuses while `/config/MOVED_TO` exists.

**Measured today on `slice/s41`:** that guard **does** exist —
`deploy/tailscale/start.sh:86-92` reads `MOVED_TO="$CONFIG_DIR/MOVED_TO"`, and
refuses when present, *"refusing anyway"* even when the body cannot be read.
(`s45/read-tailnet-identity.md` reports this guard as missing; that reading is
older than the file. Re-check rather than trusting either document.)

**On failure:** if `start.sh` has no guard, the sidecar can still be started by
a bare `docker compose up -d` and the only protection is `install.sh`'s
`refuse_if_moved` (`deploy/install.sh:369-386`), which runs **only** inside
`./install`. In that case: write yourself a note, and do not run a bare
`docker compose up` on the Dell until Phase 8.

**13.** Transfer the move bundle, and compare shas on both ends.

```
scp <BUNDLE> <USER>@<HUB-TS>:<path>/
ssh <USER>@<HUB-TS> "sha256sum <path>/<BUNDLE>"
```

**Verifies:** equal to the sha `--move` printed and to `bundle_sha256` in
`MOVED_TO`.

**On failure:** re-copy. If the sha will not settle, the Dell is still
recoverable — go to Rollback R3.

**14.** **Drill the real bundle, before restoring it.**

```
# on <HUB>
cd <REPO> && ./install restore <path>/<BUNDLE> --drill
```

**Verifies:** exit 0, and — unlike Phase 1 — the report now covers
`v4_tailscale` too, because `--move` made it `include` and the drill runs
`§9.2` step 9 (the volume untar and listing diff) against every carried
volume.

**Why this step earns its minutes:** it is the last moment at which a bad
bundle costs you only a rollback instead of both copies. The Dell is stopped
but intact; `undo-move` puts it back.

**On failure: go straight to Rollback R3.** Do not attempt the real restore on
a bundle that failed its drill.

---

## Phase 4 — restore, without claiming the identity

**15.** Restore.

```
# on <HUB>
cd <REPO> && ./install restore <path>/<BUNDLE>
```

**Verifies:** the word **restored**, and it is printed *only* with the three
facts behind it — `<n> tables compared across <m> databases`, `<k> volume
listings diffed`, `signing key fingerprint equal`. If steps 9, 13 or 14 of
`§9.2` did not run, the word is not printed at all
(`s41/design-verdict.md:1678-1686`). It then names exactly one next command:
`./install`.

Along the way it will print the **names** (never the values) of any carried
`.env` keys it replaced. That is expected on a machine that has been installed
before — `generate_secrets` writes fresh values for all five `SECRET_KEYS` on
every install, so five conflicts are normal and are not a warning.

**On failure, by gate:**
- *non-empty target* → Phase 2 step 10 did not finish. Re-read the refusal: it
  names every volume and every container it found. Clear exactly those.
- *`.restore-in-progress` present* → a previous restore died. The marker lists
  **exactly** what that run created; remove those objects and then the marker.
  Nothing here discovers anything — that list is the bound.
- *migration content hash* → P5. Check out the sha it names.
- *pg version* → P10.
- *listing diff* → the volume is **left in place** for inspection and the run
  stops before touching the database. The bundle or the transfer is corrupt;
  go to Rollback R3.
- *count/sum mismatch, or signing key* → the data did not survive. Rollback R3.
  Do not "just carry on" — `services/core/app/devices_ws.py:288-289` shows
  every paired device pins that key.

**16.** Bring Nova up on the mini PC **without the tailnet**.

```
# on <HUB>
cd <REPO> && ./install
```

**Note the absence of `NOVA_TAILNET=1`.** `COMPOSE_PROFILES` is a `host` key
(`deploy/.env.example:113`) — it does not travel — so the destination decides
its own profiles, and the default is tailnet **off** (`TAILNET_ENABLED=0`,
`deploy/install.sh:1031`).

**Verifies, from an ssh session, locally on the mini PC:**

```
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/health/live
docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
docker exec nova-postgres-1 psql -U core -d nova_core -At -c 'select count(*) from people'
docker exec nova-postgres-1 psql -U core -d nova_core -At -c 'select count(*) from devices'
```

Your own data should be there: measured on the Dell today, `devices` holds
**1** row.

**This is the checkpoint that makes the cutover reversible.** You now know
Nova runs correctly on the new hardware, with your data, **before** anything
has claimed the tailnet identity. At this instant both machines can still
serve; only one is running.

**On failure:** Rollback R3 still works cleanly. The mini PC has volumes now,
but the Dell's are untouched and its identity copy is intact.

---

## Phase 5 — the tailnet cutover

The cutover has exactly one ordering rule, and it is mechanical rather than
procedural: **the source's sidecar must read stopped before the destination's
sidecar is ever created.** Step 11's `bk_park` proved that by reading
`.State.Running == false` for every service, and step 12 confirmed it by hand.
There is no overlap window to manage, because there must not be one — two
tailscaled on one node key flap, and a flap is not something a healthcheck
notices (`deploy/install.sh:361-364`).

**17.** Bring the sidecar up on the mini PC.

```
# on <HUB>
cd <REPO> && NOVA_TAILNET=1 ./install
```

**Verifies:** the installer asks for **no auth key**. It checks the volume
first — `tailscale_state_present` (`deploy/install.sh:1138-1177`) `docker
run`s the sidecar's own image read-only against the volume to test for
`tailscaled.state` before ever prompting. Then `deploy/tailscale/start.sh`
waits for `BackendState: Running`, runs `tailscale serve --bg --https=443
http://$NOVA_WEB_ADDR:80`, and **refuses to let the container report healthy**
until `serve_check.sh`'s `serve_ok` reads the mapping back from `tailscale
serve status --json` (`deploy/tailscale/serve_check.sh:107-124`, wired as the
healthcheck at `deploy/docker-compose.yml:361-368`). The final log line prints
`On your tailnet: https://<name>/`.

**If it asks for a key, stop.** That means the identity volume did not restore
— you are one `tailscale up` away from minting a **second, differently-named**
node while the real one sits in a bundle. Every enrolled phone's home-screen
icon would then point at a URL that serves nothing, and getting back means
delete-and-re-add plus a fresh login on each device
(`s45/read-tailnet-identity.md` §5). Abort and go to Rollback R3.

**18.** Verify the identity is the same one, not a new one with the same name.

```
# on <HUB>
docker exec nova-tailscale-1 tailscale status --json
docker exec nova-tailscale-1 tailscale serve status --json
```

**Verifies:** `Self.DNSName` is `nova.<TAILNET>.ts.net.` with **no numeric
suffix**; `Self.Created` is still the original creation timestamp (measured:
`2026-07-14T21:13:49Z` — if this is today's date, it is a new node);
`HaveNodeKey: true`; and serve shows `"443":{"HTTPS":true}` with
`Web["nova.<TAILNET>.ts.net:443"].Handlers["/"].Proxy ==
"http://172.18.128.10:80"` — the shape `serve_ok` checks for, measured on the
Dell today.

**On failure — a name like `nova-1`:** the control plane silently renamed a
new node because the old one was still online. Stop the sidecar on the mini
PC, confirm the Dell really is parked, and go to Rollback R3.

**19.** Verify from outside both machines.

From the phone, or from any other tailnet peer that is neither host:

```
curl -sI https://nova.<TAILNET>.ts.net/ | head -3
```

**Verifies:** HTTP 200 (or a redirect to the login page), a valid certificate
for that exact name, and — the real test — **the phone's existing session
still works without logging in again.** Same origin, same cert, same cookie
scope, and the session row came back inside `nova_core`.

**On failure:** if the name resolves but nothing answers, the serve mapping
did not rebuild — but the healthcheck should already have caught that, so
suspect DNS caching on the client first. If the phone asks you to log in
again, the `nova_core` restore lost the session table; the data is still
correct (step 15's count comparison proved it), so just log in.

---

## Phase 6 — keep the 3090, and decide what happens when the Dell sleeps

**20.** Create the provider row on the mini PC, pointing at the Dell.

```
# on <HUB>, with the Dell AWAKE
T=$(grep -E '^CORE_GATEWAY_TOKEN=' <REPO>/deploy/.env | cut -d= -f2-)
curl -s -X POST http://127.0.0.1:8001/admin/providers \
  -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"name":"dell","adapter":"openai-chat","base_url":"http://<DELL-TS>:11434/v1","auth_shape":"none"}'
```

(`services/gateway/app/admin.py:740`; the router is `prefix="/admin"` at
`:44`; the gateway's bearer is `SERVICE_TOKEN`, wired to `CORE_GATEWAY_TOKEN`
at `deploy/docker-compose.yml:93`.)

**Verifies:** HTTP 200 and a row whose `base_url` is the address you typed and
whose `listing` is `"available"` with a model count in `listing_note`. The
create path runs `_verify_or_502` — **nothing is written if the verify
refuses** (`services/gateway/app/admin.py:670-680`), so a 200 here is a proof
of reachability, not a claim of one.

**On failure — 502 "could not verify provider 'dell'":** the mini PC's gateway
container cannot reach the Dell. Phase 2 step 8 proved the **host** could; a
container is a different path. Check the container's own view:
`docker exec nova-gateway-1 python -c "import urllib.request;
print(urllib.request.urlopen('http://<DELL-TS>:11434/api/tags').status)"`.
Nothing was written, so there is nothing to undo.

**On failure — 400 "adapter=ollama cannot be registered here":** you used the
brief's adapter. Use `openai-chat` and the `/v1` path
(`services/gateway/app/providers.py:146-153`).

**21.** Know what the row is, and is not.

`insert_row` derives `local` as `adapter = 'ollama'`
(`services/gateway/app/providers.py:296-297`), so this row is `local = false`.
Two measured consequences, stated rather than discovered later:

- `data_plane.py:169` records usage for a non-local row, so turns on your own
  3090 will appear in the spend ledger. With no price rows they cost nothing;
  they are still counted.
- `routing.py:561,576` derives a cross-tier **local** standby only when no
  link in the chain is local. This row is not local, so the standby machinery
  still has a job to do — which is step 22.

`compute_id`'s `served_on` grammar (`services/gateway/app/compute_id.py:1-20`)
keeps the history honest across the move: probes taken on the 3090 carry
`gpu:cuda:<uuid>` and the mini PC's own engine will carry a `cpu:` stamp, so a
measurement taken on one is never read as the other's.

**22.** Give the hub something to fall back to when the Dell sleeps.

```
# on <HUB>
docker exec nova-ollama-1 ollama pull qwen3:8b
docker exec nova-ollama-1 ollama list
```

**Verifies:** a chat-capable model appears in the list alongside
`nomic-embed-text:latest`.

**Why:** `hub` is `is_default = true` (measured) and resolves to the mini PC's
own ollama. With only the embedder installed, `standby`
(`services/gateway/app/routing.py:405-418`) finds **no** model ollama declares
fit for chat and returns nothing, so a chain whose only GPU link is asleep has
nowhere to fall. With a small model present it falls to CPU inference on an
N150: slow, and *present*.

**On failure:** the pull is slow or the disk is short. The move is still done;
record that there is no fallback and that a sleeping Dell means no chat.

**23.** Read what happens when the Dell sleeps, and accept it.

**Stated consequence, from the brief and unchanged by anything here: nothing
wakes the Dell until S46.** With step 22 done, a turn whose chain names the
`dell` provider gets: `dell` unreachable → recorded as `unreachable` in the
route verdicts → the chain falls to the local standby on the mini PC's CPU →
the reply arrives, slowly, and the route header says it was a standby.
Without step 22: `503, "every link in the <role> chain refused this request"`
(`services/gateway/app/data_plane.py:173-175`).

**Verifies (optional, and worth doing once deliberately):** put the Dell to
sleep, run one chat turn, and read `turn_spans` for that turn id. A reply is a
claim; the trace is the fact.

---

## Phase 7 — the one enrolled device

**24.** Repoint `novad`.

Measured: `devices` holds exactly **1** row, and `novad.service` is `active
(running)` **on the Dell**, enrolled at `"server": "http://localhost:3000"`.
After the move, `localhost:3000` on the Dell serves nothing.

```
# wherever novad runs
novad repoint --server https://nova.<TAILNET>.ts.net --check
novad repoint --server https://nova.<TAILNET>.ts.net
systemctl --user restart novad
novad status
```

**Verifies:** `--check` prints the verdict and **writes nothing, ever**
(`s41/design-verdict.md:2189-2191`). The real run proves the new URL is the
same Nova before it saves: it dials `/api/v1/devices/ws`, reads core's
challenge frame, and compares `core_pubkey` to the pinned key with
`subtle.ConstantTimeCompare` — *"that server is not the Nova you paired with"*
and **config untouched** if they differ. It then completes the handshake, so a
server with the right key that has forgotten this device fails before the
write. Finally it re-`Load`s the config and compares.

`novad status` is what tells you the daemon reconnected; `repoint` restarts
nothing and never claims it did.

**On failure — "that server is not the Nova you paired with":** you are
pointing at something that is not your Nova. Stop and find out what.
Re-enrolling would silently accept the impostor.

**On failure — the handshake fails after the key matched:** the restored
`nova_core` does not have this device. Step 15 compared the signing key
fingerprint, so this is a device row problem, not a key problem — re-enroll.

**25.** Decide where `novad` should live.

It is on the Dell, which is now a GPU box that sleeps. If the daemon is meant
to be always-on, its home is the mini PC. That is a re-enroll, not a repoint,
and it is a separate decision — not part of this move.

---

## Phase 8 — the Dell afterwards

**26.** Leave the Dell parked, deliberately.

Both markers stay in place. They are what stop a second tailscaled from
claiming the node key — `deploy/tailscale/start.sh:86-92` at the sidecar and
`refuse_if_moved` (`deploy/install.sh:369-386`) at the installer. The Dell's
own `v4_tailscale` volume is **not deleted** by the move: `bk_park` runs
`docker compose stop`, never `down -v`, and nothing in the move path removes a
source volume. That stale copy is the rollback, and it stays valid until the
node key rotates.

**Verifies:** `ls -l <REPO>/deploy/.moved <REPO>/deploy/tailscale/MOVED_TO` on
the Dell, and `docker volume inspect nova_v4_tailscale` still exists.

**27.** Know the one bypass that is left.

A `docker run` of the sidecar image that does **not** mount `/config` sees no
`MOVED_TO` and is refused by nothing (`s41/design-verdict.md:1810-1817`, which
names this bound honestly). Do not do that. There is no code that stops you.

---

## Rollback — what undoes each phase

| | If you stop here | What undoes it | Cost |
|---|---|---|---|
| **R1** | anywhere in Phase 1 | delete the rehearsal bundle | nothing. Nova never stopped |
| **R2** | after Phase 2 step 7 (ollama published) | put `COMPOSE_FILE` back, `docker compose up -d ollama` | seconds of local inference |
| **R2b** | after Phase 2 step 10 (mini PC torn down) | **nothing undoes it** — the dry-run volumes are gone | none for Nova; the brief calls that stack disposable |
| **R3** | anywhere from step 11 to step 16 | `./install undo-move` on the Dell (P2!), then `./install` | Nova returns at the same URL. Everything written to the mini PC since the restore is lost, which is nothing yet |
| **R4** | after step 17 (sidecar up on the mini PC) | stop the mini PC's sidecar and **verify it stopped**, then R3 | same, **but** the node key has now been served from two hosts in sequence. The Dell's copy of `tailscaled.state` is stale; Tailscale generally accepts it, and this is not measured against your tailnet |
| **R5** | after the first real write on the mini PC | technically R4, but you lose that work | see below |

**R3, in full, because it is the one you will actually use:**

```
# on <HUB>: make sure nothing there is claiming the identity
docker compose --project-directory <REPO>/deploy --profile '*' stop
docker inspect nova-tailscale-1 --format '{{.State.Running}}'    # must read false

# on <DELL>
cd <REPO> && ./install undo-move      # prints the marker, asks you to type: undo
cd <REPO> && ./install
```

`undo-move` prints the marker verbatim, reads `tailscale status --json` for an
online peer carrying the archived DNS name **and says what it found either
way** — including *"I cannot check from here whether `<name>` is online: the
sidecar is stopped, so there is no tailscaled to ask"* — then requires the
typed literal `undo`, defaulting to doing nothing. It removes both markers and
verifies both are gone. It starts nothing itself
(`s41/design-verdict.md:1819-1846`).

**If P2 is still false and `undo-move` does not exist**, R3 is:

```
# on <DELL>
rm <REPO>/deploy/.moved <REPO>/deploy/tailscale/MOVED_TO
ls -l <REPO>/deploy/.moved <REPO>/deploy/tailscale/MOVED_TO   # both must be gone
docker compose --project-directory <REPO>/deploy --profile '*' ps --all   # confirm the mini PC is stopped FIRST
cd <REPO> && ./install
```

with none of the checks above. Know that before you start, not at 3am.

### The point of no return

**There is exactly one, and it is not where people expect.**

It is **not** step 17 (the sidecar logging in on the mini PC): the Dell's
`v4_tailscale` volume still holds the same state, so R4 is real.

It is **not** step 15 (the restore): the Dell's volumes are untouched.

It is **the first write to Nova on the mini PC** — the first chat turn, the
first note, the first setting. From that moment the Dell's copy is stale, and
rolling back means losing whatever Nova did in between. Everything before it
is a clean revert to exactly where you started.

So: **do not use Nova until you have decided the move stands.** Step 19's
`curl -sI` and a look at the UI are reads. A conversation is not.

---

## Downtime, and what the owner sees

**Downtime runs from step 11 (`bk_park` stops the stack) to step 17
(`serve_check.sh` passes on the mini PC).**

| Step | Estimate | Basis |
|---|---|---|
| 11 `backup --move` | 2–5 min | three dumps totalling ~32 MB plus two volumes totalling ~4 MB, read three times (hash, pack, verify) |
| 13 transfer | < 1 min | tens of MB over the tailnet |
| 14 drill the move bundle | 3–8 min | decrypt, extract, throwaway postgres, three restores, count+sum every table, on an N150 |
| 15 restore | 3–8 min | the same work against the real objects |
| 16 `./install` (no tailnet) | 2–5 min | **with P6 satisfied.** Starting eight containers and waiting out the health budget |
| 17 `NOVA_TAILNET=1 ./install` | 1–3 min | one more container plus `serve_check` |
| **Total** | **~12–30 minutes** | |

**Add 20–45 minutes if P6 is not satisfied** and the four build services
(`core`, `gateway`, `memory`, `web`) compile on the N150 during the window.
That is the single largest avoidable term, and Phase 0 avoids it entirely.

These are **estimates, not measurements** — nothing in this sequence has been
run. The data volumes behind them are measured.

**What he sees on his phone, during:**

`https://nova.<TAILNET>.ts.net` fails to connect. Not a spinner, not stale
content — a connection failure page. `apps/web` ships **no service worker**
(`s45/read-tailnet-identity.md` §5: searched `apps/web/src` and
`apps/web/public`; only `public/manifest.webmanifest` exists), so there is no
cached shell to render and nothing to invalidate afterwards. MagicDNS still
resolves the name the whole time; it is the connection that fails.

The home-screen icon stays exactly where it is and keeps looking the same —
iOS freezes it at install
(`ios-pwa-icon-frozen-at-install`) and nothing here re-triggers that.

**What he sees on his phone, after:** the same app, at the same URL, with the
same certificate, **still logged in**. Same origin means the same cookie
scope, and the session row is inside the restored `nova_core`. No delete, no
re-add, no re-pair, no re-login. That outcome is the entire reason the
identity is carried rather than re-minted.

**What is slower afterwards, and is not a fault:** the hub has no GPU. Turns
routed to the `dell` provider run on the 3090 as before. Turns that fall to
the hub's own ollama run on an N150 CPU.

---

## What this runbook does not know

Stated plainly, because a plan that hides its gaps is worse than a shorter one.

1. **The WSL inbound path is unverified.** Phase 2 step 7's premise — that a
   listener bound inside WSL is reachable at the Dell's tailnet address — rests
   on WSL's mirrored-mode routing table, not on a probe. The probe was refused
   by this session's sandbox. Step 8 is the verification; treat a failure there
   as a finding.
2. **Hazard 2b's exact rename behaviour** (a different key requesting a name an
   online peer already holds) is stated from general Tailscale behaviour, not
   measured against this tailnet. No second node was created to test it.
3. **`decide_subnet` on the day** is explicitly listed as unmeasured in
   `s41/measurements.md`. P11 re-reads it; the table here is history.
4. **Nothing in this document has been executed.** It is built from reading
   code, reading the S41 design and rulings, and read-only measurements of both
   machines on 2026-09-21. The first person to run it should keep a log and
   correct this file from it.
