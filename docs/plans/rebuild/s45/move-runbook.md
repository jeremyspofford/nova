# Moving Nova from the Dell to the mini PC — THE runbook

**Status: a plan, not a record. Nothing in here has been executed.** It is
built by reading code on branch `slice/s41` at `705620ee`, reading the S41
design and rulings, and read-only measurements of both machines on 2026-09-21.
Nothing was started, stopped, removed, deployed or written to on either machine
while it was written.

This document replaces `runbook-reversible.md` and `runbook-short-cutover.md`.
It takes the reversible runbook's **structure** — rehearse at zero downtime,
prove the GPU path first, and put a checkpoint between "Nova runs on the new
hardware" and "the new hardware owns the tailnet identity" — and grafts the
short-cutover runbook's **mechanisms** wherever they are better: its
prerequisite discipline, its selective teardown, its pre-built images, its
baseline recording, and its insistence that a timed rehearsal replaces a
guessed window. Everything the two attack documents showed to be broken is
dropped, each with the finding quoted.

---

## Placeholders — this repo is public

Every host string below is a **placeholder**. Substitute your own. None of
these are secrets; they are simply not published.

| Placeholder | What it is |
|---|---|
| `<DELL>` | the source: Windows 11 + WSL2 + Docker Desktop + RTX 3090 |
| `<HUB>` | the destination: the mini PC, Pop!_OS, N150, always on |
| `<USER>` | the shell account on both machines |
| `<TAILNET>` | your tailnet's DNS suffix, so Nova's URL is `https://nova.<TAILNET>.ts.net` |
| `<DELL-TS>` | the Dell's **own** Windows tailnet address — **not** Nova's |
| `<DELLWIN>` | the Dell's **own** Windows tailnet node name — **not** `nova` |
| `<HUB-TS>` | the mini PC's **own** tailnet address (it has its own node already) |
| `<S41_COMMIT>` | the commit that finished S41 |
| `<BUNDLE>` | a bundle filename, `nova-backup-<host>-<stamp>.tar` |

Set these in each shell before you start; every command below uses them.

```sh
# on <DELL>
DELL_DEPLOY=<the deploy dir the RUNNING stack was brought up from>
# on <HUB>
MINI_REPO=<the checkout there>; MINI_DEPLOY="$MINI_REPO/deploy"
```

Docker bridge addresses (`172.18.128.x`) and the volume names `nova_v4_*` are
**not** placeholders — they are literal defaults already committed in
`deploy/docker-compose.yml`.

---

## What this moves, in one paragraph

Nova's tailnet identity is a **volume**, not a config file: `v4_tailscale`
holds `tailscaled.state` and is `TS_STATE_DIR`. It is declared `move-only`
(`deploy/docker-compose.yml`, the `v4_tailscale` block), so it travels only on
`backup --move`; that run also stops every service, proves each one stopped,
and writes two markers (`deploy/tailscale/MOVED_TO` and `deploy/.moved`),
reading each back. The destination restores that volume bit-for-bit and
installs with **no auth key**, because `TS_AUTH_ONCE: "true"` makes
containerboot consult `TS_AUTHKEY` only when the state store holds no logged-in
node. Same node key, same DNS name, same TLS cert, same cookie scope — the
phone keeps its home-screen icon and its session.

**The whole risk is that two tailscaled must never hold one node key at once.**
Every ordering rule below exists for that one reason.

### What travels, and what does not

Read from `deploy/docker-compose.yml`'s `volumes:` block (all verified at
`705620ee`):

| Volume | Disposition | Consequence |
|---|---|---|
| `v4_pgdata` | `dump-pg` | three `pg_dump -Fc` files travel; a fresh PGDATA initialises from `deploy/postgres-init/01-databases.sql` with the **carried** password |
| `v4_memdata` | `include` | the notes — measured ~3.8 MB |
| `v4_workspace` | `include` | her scratch — measured ~244 KB |
| `v4_models` | `exclude-redownload` | gateway's `/models`; measured 0 files, 4.0K |
| `v4_ollama` | `exclude-redownload` | **model weights do NOT travel** (~82 GB on the Dell) |
| `v4_tailscale` | `move-only` | travels **only** on `--move`; that is the identity |

`.env` keys marked `# nova-backup: carry` travel. Keys marked `host`
(`COMPOSE_FILE`, `COMPOSE_PROFILES`, `NOVA_SUBNET*`, `NOVA_WEB_ADDR`,
`NOVA_TAILSCALE_ADDR`, `TS_AUTHKEY`) do not. `INSTANCE_SECRET` is `drop`.

**Caution on carry**: `bk_carry_keys` (`deploy/backup.sh`) iterates the keys
**present in the live `.env`** and emits only those declared `carry`. A key
that is declared `carry` but absent from the live `.env` does **not** travel.
`TAILNET_HOSTNAME` was measured absent from the Dell's live `.env` on
2026-09-21 — see P16, which turns that into a check rather than an assumption.

---

## Prerequisites — run these days earlier, and re-run the starred ones on the day

Each has a command, what it verifies, and what to do when it fails. A
prerequisite that cannot be *checked* is a prerequisite that has failed.

### P0 — S41 is finished and merged. **BLOCKER.**

This runbook is written against S41's verbs. At the time of writing, three
agents were editing `deploy/backup.sh`, `deploy/backup/**` and `tests/e2e/**`
on `slice/s41`. **Do not run this from a branch under active edit.** Establish
`<S41_COMMIT>` as a merged, tested commit first.

### P1 — `./install` dispatches the verbs. **TRUE at `705620ee`.**

```sh
grep -n 'backup|restore|drill)' $DELL_DEPLOY/install.sh
```

**Verifies:** `main()` dispatches them. Measured at `705620ee`:
`deploy/install.sh:1833` is `backup|restore|drill)`, which `shift`s, sources
`$DEPLOY_DIR/backup.sh` and calls `"cmd_$cmd" "$@"`. This was **false** when
both source runbooks were written and landed in commit `705620ee`
("fix(s41): ./install actually dispatches backup, restore and drill"). That is
the argument for running every P-check on the day rather than trusting this
list.

**On failure: stop.** Do not source `backup.sh` by hand to call `cmd_backup` —
that skips `cmd_install`'s `refuse_if_moved`, the only thing that stops a
parked host from starting a second claimant of the node key.

### P2 — `undo-move` does not exist. **FALSE at `705620ee`. Not a stop — write the by-hand undo on paper.**

```sh
grep -n '^cmd_undo_move()' $DELL_DEPLOY/backup.sh    # no match
```

Measured: `deploy/install.sh:1846-1850` dispatches `undo-move)` to
`die "undo-move is not built yet. The by-hand equivalent is in
deploy/README.md, under 'Moving Nova'."` — a stated CANNOT, which is better
than the "unknown subcommand" both source runbooks measured, and still not the
verb.

**Both source runbooks prescribe `./install undo-move` as the rollback for the
whole cutover. Drop that.** The rollback in this document is the by-hand one,
documented at `deploy/README.md`, "Moving Nova to another machine" →
"Undoing a park": remove `deploy/.moved` and `deploy/tailscale/MOVED_TO`.

Also drop the reversible runbook's claim that `undo-move` would check tailnet
liveness for you. `attack-reversible.md` C11: *"§9.5 step 3 conditions that
read on 'if a host `tailscale` CLI exists'. **Measured on `<DELL>`:
`command -v tailscale` → not on PATH.** The sidecar is stopped at that moment
by definition. So the branch taken is always 'I cannot check from here'."*
The liveness check that matters is the one **you** run on `<HUB>`, in R3.

**Action:** print R3 below on paper, or on your phone, before step 19. You will
be reading it on a machine with no Nova.

### P3 — a failed `--move` does not restart what it stopped. **FALSE at `705620ee`. Not a stop — R0 exists.**

```sh
awk 'NR==1676' $DELL_DEPLOY/backup.sh
```

Measured, verbatim at `705620ee`:

```sh
  if [ -n "$BK_RUN_STOPPED" ] && [ "$BK_RUN_MODE" != "move" ]; then
```

so `bk_backup_cleanup`'s writer-restart branch is unconditionally skipped in
move mode. The 2026-09-21 ruling (`docs/plans/rebuild/s41/rulings.md`, "a
failed `--move` parks or restarts, and says which") requires every exit path to
end running **or** parked and to say which. The rule is written; the code is
not.

On `--move` the sidecar is in the writer set (`writer_services` includes any
service with a read-write mount of a volume this run carries, and `--move`
makes `v4_tailscale` carried), so a failure at the dump, the tar, the pack or
the verify leaves the Dell with **writers stopped including tailscale, no
markers, no bundle, and the URL dead**, saying nothing about which state that
is.

**Action:** R0 below is the recovery. Print it. If S41 lands the ruling before
you run this, re-read line 1676 and delete this prerequisite.

### P4 — the sidecar refuses to start on a parked host. **TRUE at `705620ee`.**

```sh
grep -n 'MOVED_TO' $DELL_DEPLOY/tailscale/start.sh
```

Measured: `deploy/tailscale/start.sh:86-92` is
`MOVED_TO="$CONFIG_DIR/MOVED_TO"` / `if [ -e "$MOVED_TO" ]; then` … and it
refuses *"anyway"* when the marker's body cannot be read. This closes the hole
`refuse_if_moved` cannot: that runs only inside `./install`, so a bare
`docker compose up -d` on a parked Dell — the reflex of anyone trying to get
Nova back — would otherwise start a second tailscaled on the moved node key.

`read-tailnet-identity.md` §7 reports this guard as missing. **That reading is
older than the file**; it landed in commit `89e75231`. Re-run the grep rather
than trusting either document.

The bound, stated in the file itself and in `deploy/README.md`: a `docker run`
of that image that does **not** mount `/config` bypasses it.

### P5 — the deployed worktree carries S41, and you have recorded its images first

The S41 code must be in the **deployed** worktree, not a sibling checkout:
`BK_DIR` is the directory of `backup.sh` itself and fixes where the markers
land, and the sidecar's `/config` bind is `source: ./tailscale` **relative to
the compose file the container was created from**. A marker written into a
second checkout parks nothing.

```sh
docker inspect nova-core-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
git -C $DELL_DEPLOY/.. log --oneline -1
docker compose --project-directory $DELL_DEPLOY images     # RECORD THIS OUTPUT
```

**Verifies:** the config files resolve to `$DELL_DEPLOY`, that worktree is at
`<S41_COMMIT>`, and you have the four `nova-*` image ids written down.

Measured 2026-09-21: the live stack was served from a worktree at `rebuild/v4`,
`0996a31f`; `slice/s41` was 141 commits ahead and `0996a31f` was an ancestor,
so it fast-forwards. Step 2 does that merge.

**Why the image ids matter, and what this drops.** `attack-short-cutover.md`
F1 found that the short-cutover runbook's rollback detonates the fallback:

> *"`./install` is `cmd_install` → `compose_up` → `deploy/install.sh:1707`:
> `docker compose "${COMPOSE_ARGS[@]}" up -d **--build**`. All four `nova-*`
> images are rebuilt from S41 source. … Two migrations exist at HEAD that do
> not exist at `0996a31f`: `A services/core/migrations/035_hub_engine.sql`,
> `A services/gateway/migrations/009_engines.sql`."*

Verified at `705620ee`: `deploy/install.sh:1706-1707` is
`log "starting services (docker compose ${COMPOSE_ARGS[*]} up -d --build)…"` /
`docker compose "${COMPOSE_ARGS[@]}" up -d --build`.

**So: every rollback in this document brings the Dell back with
`docker compose --project-directory $DELL_DEPLOY --profile '*' up -d` — no
`--build`, and never `./install`.** The images that were serving are still on
disk; those are the rollback. Do not `docker image prune` on the Dell until the
move is declared final.

**On failure of `--ff-only`:** the deployed worktree has commits of its own. Do
**not** force. Stop and reconcile.

### P6 — the destination checkout is the same commit, and clean

```sh
ssh <USER>@<HUB-TS> "git -C $MINI_REPO log --oneline -1; git -C $MINI_REPO status --short"
```

**Verifies:** `<S41_COMMIT>`, clean tree.

**Why it binds:** `restore` gates on migrations by **content hash** — for every
entry in `manifest.databases[].migrations_member` a file of that hash must
exist in this checkout's `services/<svc>/migrations/`, and there is **no
override flag**. A renumbered migration still matches; a genuinely different
one refuses, naming the file, its database and the source sha.

Measured 2026-09-21: the mini PC was on `main` at `e5abd0b`, which predates S41
and has no `backup.sh` at all.

**On failure:** check out `<S41_COMMIT>` there. Do not edit migrations to make
the gate pass.

### P7 — the destination's images are pre-built, and the sidecar image pre-pulled

```sh
ssh <USER>@<HUB-TS> "docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'nova-(web|core|gateway|memory)|tailscale/tailscale'"
```

**Verifies:** five lines — the four services with a `build:` stanza, built from
`<S41_COMMIT>`, plus `tailscale/tailscale:v1.102.3`.

**Why it is a prerequisite and not a step:** `compose_up` is `up -d --build`,
so without this the build runs *inside* the window, on an N150. Measured
2026-09-21: the mini PC had the four `nova-*` images but built from `e5abd0b`,
and did **not** have `tailscale/tailscale:v1.102.3`. Both gaps would be paid
for in downtime. Step 4 does the build.

### P8 — the shell and tooling on both machines

```sh
ssh <USER>@<HUB-TS> "bash --version | head -1; openssl version; tar --version | head -1; python3 -V; docker --version; docker compose version"
```

**Verifies:** bash >= 3.2, OpenSSL, GNU tar, python3, docker + compose.
Measured on the mini PC: bash 5.2.21, OpenSSL 3.0.13, GNU tar 1.35, python3
3.12.3, Docker 29.8.0 / compose v5.5.1. `age` is not installed and is not
needed — the bundle's crypto runs in a container.

### P9 — the passphrase. **Both source runbooks get this wrong. Read this one.**

`attack-short-cutover.md` F2 (CRITICAL) and `attack-reversible.md` C5 (HIGH)
found the same hole from two sides: **no step in either runbook gets the
passphrase onto the destination, and the destination cannot generate one.**

Verified at `705620ee`: the default resolver is `file`
(`deploy/passphrase.sh`), reading `$NP_DIR/.backup-passphrase`;
`nova_pass_file` returns exit 3 for an absent file — *"the ONE case that
permits a create"* — and `bk_restore_run` turns that into *"there is no
passphrase here, and a restore never generates one"*. The `prompt` resolver
cannot save you either: it is a stated cannot without a terminal, and every
destination command below is `ssh <HUB-TS> "…"` with **no `-t`**.

Measured 2026-09-21: neither machine had a `NOVA_PASSPHRASE_*` key or a
`deploy/.backup-passphrase`.

```sh
grep -E '^NOVA_PASSPHRASE_(SOURCE|FILE|CMD)=' $DELL_DEPLOY/.env    # state which resolver
```

**Verifies:** you can name the resolver this machine uses.

**On failure — and this is the normal case:** decide it deliberately now. The
passphrase is created by the **first backup**, at step 5, so there is nothing
to record before then. Step 6 is where it is copied to the mini PC and recorded
off both machines. Do not skip step 6.

`--passphrase-file` exists (`deploy/backup.sh`, the restore parser: `--drill`,
`--passphrase-file`, validated as a regular file, mode 600, non-empty, one
line). Use it if you chose a non-default path.

### P10 — disk, both ends

```sh
df -Pk $DELL_DEPLOY
ssh <USER>@<HUB-TS> "df -h /"
```

**Verifies:** the 4x-of-payload headroom `bk_need_out_kb` demands on the
source, and room on the destination. Measured: Dell ~904 GB free of 1007 GB;
mini PC ~341 GB free of 460 GB. Payload measured: `nova_core` 15 MB,
`nova_gateway` 9.3 MB, `nova_memory` 7.6 MB, `v4_memdata` ~1 MB,
`v4_workspace` 244 KB. Not close.

### P11 — postgres major on the destination >= the dump's major

```sh
ssh <USER>@<HUB-TS> "docker run --rm postgres:16 pg_restore --version"
```

Measured on the Dell: server PostgreSQL 16.15. `deploy/docker-compose.yml` pins
the **major only**, so the tag floats and the mini PC pulls whatever
`postgres:16` is on the day. **On failure:** the restore refuses with both
numbers. Pin the same digest on both hosts.

### P12 — ssh to the destination works unattended. **BLOCKER.**

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 <USER>@<HUB-TS> 'echo OK; hostname'
```

**Verifies:** you can reach the destination while Nova's URL is dead. The mini
PC has its own, separate, already-registered native tailnet node, distinct from
`nova`; the move never touches it.

**On failure: stop.** This is the prerequisite that turns a bad move from
"recoverable" into "drive to the machine".

### P13 — ssh to the SOURCE works, and the Dell will not sleep. **BLOCKER. ★ re-check on the day.**

Neither source runbook has this. `attack-reversible.md` C8 and
`attack-short-cutover.md` F10 found the same gap:

> *"**P12** makes 'the mini PC is reachable by a path that is not Nova' a
> prerequisite … There is **no matching prerequisite for `<DELL>`** — and
> `<DELL>` is the machine that sleeps. That is the entire premise of the move."*

Every rollback in this document runs on the Dell.

```sh
ssh -o BatchMode=yes <USER>@<DELL-TS> 'echo OK; hostname'
```

Then, on Windows, disable sleep and hibernate for the duration — **record the
previous values first**:

```
powercfg /query SCHEME_CURRENT SUB_SLEEP        # record
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

**On failure: stop.** A Dell that sleeps between step 19 and step 21 leaves you
with a parked machine you must physically wake, at the worst moment. Note that
this is a Windows host change, outside compose, and therefore outside every
rollback below — step 36 puts it back.

### P14 — the destination's `TS_AUTHKEY` is blank. **★ re-check at step 18.**

Neither source runbook has this, and both have a gate that fails open without
it. `attack-reversible.md` C3 and `attack-short-cutover.md` F5 found it
independently.

```sh
ssh <USER>@<HUB-TS> "grep -c '^TS_AUTHKEY=.' $MINI_DEPLOY/.env"     # must print 0
```

**Why:** `decide_tailnet` tests the key **first** and short-circuits. Verified
at `705620ee`, `deploy/install.sh:1259-1265`:

```sh
  key="$(get_env_value TS_AUTHKEY)"
  if [ -n "$key" ]; then
    log "tailnet: TS_AUTHKEY is set (used once, on the node's first login)"
  else
    tailscale_state_present && rc=0 || rc=$?
```

With a non-empty key, `tailscale_state_present` is **never called**, the
installer asks nothing, and `TS_AUTH_ONCE: "true"` then decides on its own
whether to use the key — it uses it precisely when the state store has no
logged-in node, i.e. exactly the failure the gate exists to catch.

**And the tool's own screen is what arms it.** `refuse_tailnet`
(`deploy/install.sh:1203-1217`) — printed the instant the state volume is
missing — offers as way forward **1**: *"Mint an auth key … put it in
$ENV_FILE as `TS_AUTHKEY=tskey-auth-...` and re-run: `NOVA_TAILNET=1
./install`"*. An operator who hits that refusal and follows the terminal has
minted a second node in one move. **The terminal wins over the document at 3am,
every time.** Step 26 replaces the negative gate with a positive one.

Measured 2026-09-21: blank on both machines. Nothing keeps it that way across a
failed attempt.

### P15 — the destination has no tailnet state volume. **★ re-check at step 18.**

```sh
ssh <USER>@<HUB-TS> "docker volume ls --format '{{.Name}}' | grep tailscale || echo NONE"
```

**Verifies:** `NONE`. Measured 2026-09-21: the mini PC's volumes were
`nova_v4_{memdata,models,ollama,pgdata,workspace}` plus three `jobhunter_*`; no
tailscale volume and no `nova-tailscale-1` container.

**On failure: stop.** Establish whose identity it is before deleting anything.

### P16 — `TAILNET_HOSTNAME` on the destination

`attack-short-cutover.md` F12: the short-cutover runbook says
`TAILNET_HOSTNAME` is carried. **It is not, today** — `bk_carry_keys` emits
only keys present in the live `.env`, and `TAILNET_HOSTNAME` was measured
absent from the Dell's. The node is named `nova` by *default*, not by carry.

```sh
ssh <USER>@<HUB-TS> "grep -m1 '^TAILNET_HOSTNAME=' $MINI_DEPLOY/.env"
```

**Verifies:** empty, or exactly the left-most label of step 1's `Self.DNSName`.

**On failure:** set it to match, or blank it. If it holds anything else,
containerboot requests that name and the carried node is renamed — which is
hazard (b) with your own node key, and the URL your phone points at stops
answering. And **never run step 27 through an interactive shell**, where the
"Node name on the tailnet" prompt can be answered by hand.

### P17 — the `.env` has no key nothing declares

```sh
comm -23 <(grep -o '^[A-Z_]*' $DELL_DEPLOY/.env | sort -u) \
         <(grep -oE '^#? ?[A-Z_]+=' $DELL_DEPLOY/.env.example | tr -d '# =' | sort -u)
```

**Verifies:** `bk_env_facts` can classify every live key; an undeclared one
refuses the backup. Measured: passes on `slice/s41`, would have refused on
`rebuild/v4`. **On failure:** add the declaration with a disposition to
`.env.example`. Do not delete the key from `.env` to make the check pass.

### P18 — nothing else on the destination may be collateral. **★ re-measure on the day.**

```sh
ssh <USER>@<HUB-TS> "docker ps -a --format '{{.Names}}\t{{.Label \"com.docker.compose.project\"}}' | sort -k2"
ssh <USER>@<HUB-TS> "docker exec nova-postgres-1 psql -U core -d nova_core -At -c 'select count(*) from people'"
```

**Verifies:** the only `com.docker.compose.project=nova` objects are the
dry-run stack's, and `people` there is **0** — the evidence that tearing it
down destroys nothing. Measured 2026-09-21: `0`; `minecraft` (2 containers,
**running**, must stay running) and `jobhunter` (6, exited) are separate
projects.

**Select by the label, never by the name prefix `nova`.** That rule is not
caution: `map-minipc-measured.md` records a volume named `nova_pgdata` whose
project label said `docker`, and a name-prefix delete would have destroyed
75.8 MB of an unrelated project. `attack-reversible.md` C10 notes that
particular volume is now gone from the mini PC — **the rule stands, the example
is history** — and that the Dell still carries v3-era volumes under the `nova`
project label (`nova_tailscale_state`, `nova_kokoro_models`, `nova_ntfy_cache`,
`nova_whisper_models`, `nova_nova_coder_workspaces`), so the caution is live on
the source side too.

**On failure: stop and re-scope the command.**

---

# Phase 1 — rehearse, with the Dell fully live

**Downtime: zero.** Nova serves throughout. Nothing here is destructive on
either machine.

## 1. Record the baseline. Everything later compares against this.

`attack-short-cutover.md` F9: *"Step 23 says: 'Verifies: counts that match the
Dell's, not zeros.' No step in Phase A, B or C reads `people`, `turns` or
`messages` on the Dell. … By step 23 the Dell is parked."* Neither source
runbook records the numbers its own final check needs. This step does.

```sh
# on <DELL> — write ALL of this down, in a file on a THIRD machine
docker exec nova-tailscale-1 tailscale status --json | python3 -c \
  "import json,sys; d=json.load(sys.stdin); s=d['Self']; \
   print('HaveNodeKey', d['HaveNodeKey']); print('DNSName', s['DNSName']); \
   print('Created', s['Created']); print('KeyExpiry', s.get('KeyExpiry')); \
   print('CertDomains', d['CertDomains'])"
docker exec nova-tailscale-1 tailscale serve status --json
docker exec nova-postgres-1 psql -U core -d nova_core -At \
  -c 'select count(*) from people' -c 'select count(*) from turns' \
  -c 'select count(*) from messages' -c 'select count(*) from devices'
docker exec nova-postgres-1 psql -U core -d nova_core -At \
  -c "select key, value from settings where key like 'chat.%'"
docker exec nova-postgres-1 psql -U gateway -d nova_gateway -At \
  -c "select name,adapter,builtin,is_default,local from providers"
docker compose --project-directory $DELL_DEPLOY images
```

**Verifies:** you have, on a third machine: the exact DNS name, the serve
mapping, four row counts, the `chat.*` settings, the provider rows, and the
four image ids (P5's rollback).

**Note `HaveNodeKey` is a TOP-LEVEL field, not `Self.HaveNodeKey`.**
`attack-reversible.md` C7: *"An operator reading `.Self.HaveNodeKey` gets
`null` on a perfectly healthy node, and step 18's stated failure branch is …
'go to Rollback R3' — i.e. throw away a successful move."* The python
expression above reads it from the right place.

Measured 2026-09-21 for reference — **do not trust this table, produce your
own**: `HaveNodeKey: true`, `DNSName: nova.<TAILNET>.ts.net.`,
`Created: 2026-07-14T21:13:49Z` (the original node, never re-created),
`KeyExpiry: 2027-01-10T21:13:49Z`, serve
`"443":{"HTTPS":true}` with `Handlers["/"].Proxy == "http://172.18.128.10:80"`;
`people` 1, `turns` 1047, `devices` 1; `chat.model = "hub:qwen3.8:27b"`,
`chat.vision_model = "qwen3.8:27b"`; providers `hub|ollama|t|t|t`,
`anthropic|anthropic-messages|f|f|f`, `cerebras|openai-chat|f|f|f`,
`openrouter|openai-chat|f|f|f`.

**On failure:** the hub is already not in the state this runbook assumes. Stop
and find out why before moving anything.

## 2. Put `<S41_COMMIT>` in the DEPLOYED worktree.

```sh
git -C $DELL_DEPLOY/.. fetch origin
git -C $DELL_DEPLOY/.. merge --ff-only <S41_COMMIT>
git -C $DELL_DEPLOY/.. log --oneline -1
ls -la $DELL_DEPLOY/.env                      # still present, mode 600
git -C $DELL_DEPLOY/.. status --short         # must NOT list deploy/.env
```

**Verifies:** fast-forwarded, `.env` untouched (it is gitignored).

**Nothing is rebuilt by this.** Nova keeps running on the containers it already
has — the images only change when something runs `up -d --build`, which is why
P5 says every rollback below omits `--build`.

**On failure:** `--ff-only` refused — the worktree has commits of its own. Do
**not** force. Stop and reconcile.

## 3. Put the same commit on the mini PC, and make the bundle directory.

```sh
ssh <USER>@<HUB-TS> "cd $MINI_REPO && git fetch origin && git checkout <S41_COMMIT> && git log --oneline -1 && ls deploy/backup.sh deploy/passphrase.sh deploy/compose_read.sh deploy/backup/restore.sh"
ssh <USER>@<HUB-TS> "mkdir -p $MINI_DEPLOY/backups && chmod 700 $MINI_DEPLOY/backups && ls -ld $MINI_DEPLOY/backups"
```

**Verifies:** the commit is checked out AND all four paths exist — *listing the
files is the check; "git said OK" is not* — and the bundle directory exists.

The `mkdir` is `attack-short-cutover.md` F13: *"`scp <bundle>
<USER>@<MINI_IP>:$MINI_DEPLOY/backups/` with a trailing slash onto a missing
directory fails."*

**On failure:** resolve on the mini PC. Nothing changed on the Dell; nothing to
undo.

## 4. Pre-build the destination's images and pull the sidecar image.

```sh
ssh <USER>@<HUB-TS> "cd $MINI_DEPLOY && docker compose --project-directory $MINI_DEPLOY build 2>&1 | tail -20"
ssh <USER>@<HUB-TS> "docker pull tailscale/tailscale:v1.102.3"
ssh <USER>@<HUB-TS> "docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'nova-(web|core|gateway|memory)|tailscale/tailscale'"
```

**Verifies:** five lines (P7). This starts nothing.

**On failure:** a build error here is a build error you fix with Nova still up.
That is the entire point of doing it now. **Do not proceed to Phase 4 with a
failing build.**

## 5. Write a routine bundle on the Dell — no `--move`. **Time it.**

```sh
cd $DELL_DEPLOY/.. && time ./install backup --transport tailnet
```

**Verifies:** exit 0; the run prints the bundle path, its sha256, its mode and
owner, the passphrase fingerprint, the per-database table counts, and
everything the bundle does **not** carry with a reason for each. The stack is
running again when it exits — in routine mode the cleanup restarts the writers
it stopped (`deploy/backup.sh:1676`, the branch P3 says is skipped in move
mode).

`--transport` is recorded in the manifest only; it moves no bytes, and it makes
the final rename intra-filesystem by construction.

**The elapsed time of this command is the first half of the cutover window.**
Write it down.

**On failure:** read the refusal — every one names what it found. Nothing is
parked (routine mode writes no marker) and the writers are back up. Confirm
with `docker compose --project-directory $DELL_DEPLOY ps` before doing anything
else. **Do not proceed until a plain backup succeeds:** if the mechanism cannot
write a bundle with the stack live, it will not write one with the stack
stopped.

## 6. Get the passphrase onto the mini PC, and off both machines. **Do not skip.**

This step exists because both source runbooks omit it and both attacks called
that critical (P9).

```sh
# on <DELL> — step 5 created this
ls -l $DELL_DEPLOY/.backup-passphrase          # mode -rw-------
sha256sum $DELL_DEPLOY/.backup-passphrase

# record the passphrase somewhere that is NEITHER machine, now.

# on <HUB> — paste it in, 0600
ssh <USER>@<HUB-TS> "install -m 600 /dev/stdin $MINI_DEPLOY/.backup-passphrase" < $DELL_DEPLOY/.backup-passphrase
ssh <USER>@<HUB-TS> "sha256sum $MINI_DEPLOY/.backup-passphrase; ls -l $MINI_DEPLOY/.backup-passphrase"
```

**Verifies:** the sha256 on the mini PC **equals** the Dell's, and the mode is
`600`. The `file` resolver mode-checks 0600 and refuses anything looser.

**Why the sha256 and not "I copied it":** `attack-reversible.md` C5(a): *"Three
blank assignments satisfy that grep while the two machines resolve to two
different passphrases — which is the failure that matters."* Compare the
digest, not the intention.

**On failure: stop.** A bundle nobody can open is not a backup, and the Dell is
about to be parked. If you chose a non-default resolver, add
`--passphrase-file <path>` to every `restore` and `drill` command below.

## 7. Copy the bundle to the mini PC, and compare the digest on BOTH ends.

```sh
scp <BUNDLE> <USER>@<HUB-TS>:$MINI_DEPLOY/backups/
ssh <USER>@<HUB-TS> "sha256sum $MINI_DEPLOY/backups/$(basename <BUNDLE>)"
```

**Verifies:** the digest **read on the destination** equals step 5's. "scp
exited 0" is transport accepting bytes, not the destination holding them.

**On failure:** re-copy. If it fails twice, stop — the cutover depends on this
same link.

## 8. Drill it on the mini PC, with its dry-run stack still up. **Time it.**

```sh
ssh <USER>@<HUB-TS> "cd $MINI_REPO && time ./install restore $MINI_DEPLOY/backups/$(basename <BUNDLE>) --drill"
```

**Verifies:** exit 0, and a final report naming tables compared per database,
volume listings diffed, and **signing-key fingerprint equal**.

The drill touches nothing live: it says so on its own first line, creates its
own throwaway volumes, network and postgres, and **skips the empty-target
refusal**. Verified at `705620ee`: the non-empty-target check at
`deploy/backup.sh:4338` is gated `if [ "$drill" -eq 0 ]; then`, and the content
volume at `:4410` branches to `nova-drill-${D}_content` when `drill -eq 1`.
That is why this runs with the dry-run stack still up.

**The elapsed time is the second half of the cutover window, minus the
`./install`.** Write it down.

**On failure: this is the whole point of Phase 1 and it cost you nothing.**
Read which gate refused — passphrase (`kat.enc`), member hash, pg version,
migration content hash, volume listing, table counts, signing key — fix it with
the Dell still serving. **Do not continue to Phase 3.** A drill that "mostly
passed" is a failed drill.

## 9. Confirm the drill cleaned up after itself.

```sh
ssh <USER>@<HUB-TS> "docker ps -a --format '{{.Names}}' | grep drill || echo CLEAN; docker volume ls --format '{{.Name}}' | grep drill || echo CLEAN"
```

**Verifies:** `CLEAN` twice. A drill whose teardown cannot be verified reports
itself as a FAILED drill with the leftovers named, so this is a second,
independent reading of the same property.

**On failure:** remove the named leftovers by hand and re-run step 8 until it
is clean.

## 10. Say out loud what the drill did NOT prove.

**An ordinary backup does not carry `v4_tailscale`.** Verified at `705620ee`:
its disposition is `move-only`, and four independent sites read
`move-only) [ "$mode" = "move" ] || continue ;;`. The comment at
`deploy/backup.sh:1127-1128` states it: *"in routine mode a move-only volume is
not read at all."*

So Phase 1 has proven the crypto, the passphrase, the migration gate, the pg
version gate, the volume listings, every table count and digest, and the
signing key — and has proven **nothing** about the identity volume. The report
says "M volume listings diffed" with M short by one, and nothing says so.

`attack-short-cutover.md` F3 found this and named the fix, which is already in
this repo at `deploy/README.md`, "Restore, and the drill":
`restore --drill` first, `restore` second. **Step 22 drills the real move
bundle for exactly this reason. Do not skip step 22.**

There is no `backup --move --drill`: verified at `705620ee`, `--drill` is
parsed only by `bk_restore_run`, and `backup`'s parser knows only `--move`,
`--transport`, `--out`. The identity carry is unrehearsable before the window
with today's code; step 22 is the earliest it can be rehearsed, and it is still
before the restore.

**Verifies:** you can state this paragraph before proceeding.

## 11. Record the measured window.

Add step 5's and step 8's timings, plus one minute for the copy and four to
eight for `./install` on the mini PC. **That number, not the estimate in §D
below, is what you tell the owner**, and it is what decides whether the cutover
happens now or at a better hour.

If the sum exceeds roughly 45 minutes, stop and find out why before spending
it. The payload is ~32 MB of database and ~1.3 MB of volumes; a long run means
something other than data size is slow.

---

# Phase 2 — prove the GPU path while the Dell is still the hub

**Downtime: zero for Nova's URL.**

After the move the hub has no GPU (measured: `nvidia-smi` absent on the mini
PC; `docker exec nova-ollama-1 nvidia-smi -L` on the Dell prints one RTX 3090).

**Correction to the brief, which both attacks confirm.** `providers.base_url_of`
does route a non-builtin row to its stored address — verified at `705620ee`,
*"Every other row, including another machine's engine, is its stored address"*
— **but** `providers.validate_shape` **refuses** `adapter=ollama` for a
non-builtin row, verified verbatim:

```
adapter=ollama cannot be registered here: it is an engine, and the only engine
here is the bundled one ('hub') — another machine's ollama is reached with
adapter=openai-chat at its /v1 address
```

and the guard is `if adapter == "ollama" and not (existing or {}).get("builtin")`
— on a create, `existing` is `None`, so **every** create with `adapter=ollama`
is refused with a 400.

**DROPPED:** `runbook-short-cutover.md` step 8's
`-d '{"name":"dell","adapter":"ollama",...}'`. It cannot work. The row is
`adapter: "openai-chat"`, `base_url: "…/v1"`, `auth_shape: "none"`. Still no
new code — just not the adapter the brief named.

## 12. Confirm the gap, from the destination.

```sh
ssh <USER>@<HUB-TS> "curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://<DELL-TS>:11434/api/version || echo rc=\$?"
```

**Verifies:** this **fails today**, and that is the expected reading. Measured:
`000`, `rc=7`. Cause: `deploy/docker-compose.yml:273` publishes ollama as
`"127.0.0.1:11434:11434"` — loopback only. The container itself listens on
`0.0.0.0:11434`, so the restriction is entirely in the host publish.

**On failure (i.e. it succeeds):** something already exposes ollama. Find out
what, and to whom, before adding a second path.

## 13. Make the Dell's engine reachable from the tailnet.

**Read this before you touch anything.** Ollama's API has **no auth**, and
serves `POST /api/pull` and `DELETE /api/delete` alongside `/api/generate`.
Whatever you do here, any tailnet peer can delete the Dell's seven local models
(17 GB `qwen3.8:27b`, 19 GB `gemma4:31b` and five more), which are
`exclude-redownload` and therefore **in no bundle**. Per the hub lane's closed
decision 11, the tailnet includes a work device. S42 productises the TLS and
the bearer; until then this is an accepted, stated exposure.

### 13a — primary: serve it through the Dell's own Windows node.

`attack-short-cutover.md` F11 promotes this over the compose port bind, and the
reasoning holds: *"It needs no compose edit at all, so it cannot fail the live
ollama container; it is reachable only from the tailnet; it adds TLS; and it
leaves the loopback publish untouched, so its rollback is
`tailscale serve --https=443 off` rather than a compose edit plus a container
recreate."*

On Windows, on the Dell's own node (not Nova's sidecar):

```
tailscale serve --bg --https=443 http://127.0.0.1:11434
tailscale serve status
```

Then, the only reading that matters:

```sh
ssh <USER>@<HUB-TS> "curl -s -m 5 https://<DELLWIN>.<TAILNET>.ts.net/api/version"
```

**Verifies:** a JSON version comes back, from the machine that will need it.

**Rollback:** `tailscale serve --https=443 off`. Nothing else was touched.

> **Unmeasured, and you must verify it here rather than trust this document.**
> Whether Windows' `127.0.0.1:11434` reaches the port Docker Desktop published
> inside WSL depends on WSL2 running in **mirrored** networking mode. The
> evidence for mirrored mode is real but indirect (`ip route` inside WSL
> carries a per-peer `/32` route for every tailnet peer, and `ip -4 -o addr`
> shows the host's routable LAN address rather than a WSL NAT `172.x` one); the
> end-to-end probe was refused by the session's sandbox. **The curl above is
> the verification.** Also check the Dell's Windows node is not already serving
> something on 443 — `tailscale serve status` before you start.

### 13b — if 13a fails: bind the published port to the tailnet address.

In `$DELL_DEPLOY`, put the change in a **host-local overlay**
(`deploy/docker-compose.ollama-tailnet.yml`, appended to `COMPOSE_FILE`), not
in the committed compose file, so it is one line to undo and it does not
travel:

```yaml
services:
  ollama:
    ports:
      - "<DELL-TS>:11434:11434"
```

```sh
docker compose --project-directory $DELL_DEPLOY up -d ollama   # NOT restart — restart does not re-read .env
docker inspect nova-ollama-1 --format '{{json .NetworkSettings.Ports}}'
ssh <USER>@<HUB-TS> "curl -s -m 5 http://<DELL-TS>:11434/api/version"
```

**Verifies:** `HostIp` is `<DELL-TS>`, and the mini PC gets a JSON version back.

**Failure cost is higher than 13a's:** if Docker Desktop will not bind to that
address the container does not start and the **live** hub loses inference until
you revert. **Rollback:** drop the overlay from `COMPOSE_FILE`,
`docker compose --project-directory $DELL_DEPLOY up -d ollama`.

**If both 13a and 13b fail: do not proceed to Phase 4 yet.** The move is still
safe without the GPU, but decide that deliberately rather than discover it
after the hub is homeless.

## 14. Prove the mini PC's GATEWAY CONTAINER can reach it — not just the host.

```sh
ssh <USER>@<HUB-TS> "docker exec nova-gateway-1 python -c \"import urllib.request; print(urllib.request.urlopen('https://<DELLWIN>.<TAILNET>.ts.net/api/version', timeout=5).status)\""
```

**Verifies:** `200` from inside the container that will make the call. Step 13
proved the **host** could reach it; a container is a different path, and this
is the one `_verify_or_502` will take at step 30.

**Do NOT create the provider row yet.** `POST /admin/providers` runs
`_verify_or_502` (verified at `705620ee`: *"a refusal is a 502 with the
provider's own reason and NOTHING is written"*). Creating the row on the Dell
now would verify **the Dell's gateway container's** path to the Dell's own
tailnet address — not the path that will matter. The row is created at step 30,
from the machine that will use it.

`runbook-short-cutover.md` step 8 argues the other way: create it on the Dell
so it travels in the bundle, and so you are not creating it at a moment the
Dell may be asleep. That concern is real and P13 answers it — the Dell must be
awake and un-sleeping through the whole window and Phase 6.

**On failure:** the host can reach it and the container cannot. That is a DNS
or routing difference inside the container; fix it now, with Nova still up.

## 15. Decide what `chat.model` becomes, and write both values down.

From step 1 you have the current values. Measured 2026-09-21:
`chat.model = "hub:qwen3.8:27b"`.

The `hub:` prefix is the **builtin** provider, and `base_url_of` resolves the
builtin row to the **live** `OLLAMA_URL` (`http://ollama:11434`,
`deploy/docker-compose.yml:94`), never a stored column. So after the move
`hub:` silently means *the mini PC's own CPU ollama*, which holds
`nomic-embed-text` and **no chat model at all**.

**Write down:** the new value (`dell:<the model id>`) and the rollback value
(exactly what step 1 recorded). Do not change it yet — the Dell's own turns
would take a network hop for no reason.

`hub`, `library` and `ollama` are **reserved** provider names (verified at
`705620ee`, `providers.RESERVED_NAMES`), so the row at step 30 is named
something else; `dell` is fine.

---

# Phase 3 — empty the destination

## 16. Tear down the mini PC's dry-run stack — SELECTIVELY.

`restore` refuses a non-empty target **by design**: for every declared volume
whose disposition is `include`, `move-only` or `dump-pg` it probes for
emptiness and treats "could not determine" as a refusal, and it also refuses if
**any** container carries `label=com.docker.compose.project=nova`, exited ones
included. Its own words, at `deploy/backup.sh:4380`: *"A bad restore CANNOT be
rolled back in place, which is why this refuses instead of merging."*

**DROPPED:** `runbook-reversible.md` Phase 2 step 10's
`docker compose --project-directory <REPO>/deploy down -v`.
`attack-reversible.md` C2:

> *"`-v` removes `nova_v4_ollama`. **The embedder goes with it.** … `v4_ollama`
> is `exclude-redownload`, so the bundle does not carry it back. … Old notes
> stay searchable … **Every note written after the move is unembedded**, and
> `api.py:253` states the consequence in its own words: recall over those units
> 'honestly refuses to run'. He will not see it on the screen; he will see
> recall that quietly stops covering anything recent."*

The empty-target check examines only `include`, `move-only` and `dump-pg`
(verified at `705620ee`), so `v4_models` and `v4_ollama` do not need to go —
and `v4_ollama` holds the `nomic-embed-text` the memory service embeds with.

```sh
ssh <USER>@<HUB-TS> "docker compose --project-directory $MINI_DEPLOY down"
ssh <USER>@<HUB-TS> "docker volume rm nova_v4_pgdata nova_v4_memdata nova_v4_workspace"
```

## 17. Verify the teardown — by label AND by name — and that nothing else moved.

```sh
ssh <USER>@<HUB-TS> "docker ps -a --filter label=com.docker.compose.project=nova --format '{{.Names}}' | wc -l"   # 0
ssh <USER>@<HUB-TS> "docker volume ls --format '{{.Name}}' | grep '^nova_v4_'"                                     # ONLY models and ollama
ssh <USER>@<HUB-TS> "docker exec nova-ollama-1 ollama list 2>/dev/null || echo 'ollama container gone — expected'"
ssh <USER>@<HUB-TS> "docker ps --format '{{.Names}}' | grep minecraft"                                             # BOTH still there
```

**Verifies:** zero `nova`-project containers; exactly `nova_v4_models` and
`nova_v4_ollama` left; minecraft untouched.

**Both checks, not one.** `attack-reversible.md` C10: *"Step 6 of the restore
probes by the **name** the render resolves for each declared key
(`cfg_volume_name`), not by label. A `nova_v4_*` volume created by hand or left
by a `docker run -v` carries no compose labels, so the runbook's verification
reads clean while the restore refuses."*

**On failure:** if `docker volume rm` says a volume is in use,
`docker ps -a --filter volume=<name>` names which container. Remove it. If
anything unexpected named `nova_*` survives, inspect its **project label**
before touching it. If a minecraft container stopped, you used a command scoped
wider than you thought — start it again before continuing.

**This step is irreversible** for the dry-run stack's data. P18 measured
`people = 0` there, which is the evidence that it costs nothing. **It is not a
point of no return for Nova:** the Dell is still serving, untouched.

---

# Phase 4 — the move. **THE WINDOW OPENS AT STEP 19.**

Tell the owner. He is about to lose the URL.

## 18. Last-second re-checks. ★

```sh
ssh -o BatchMode=yes <USER>@<DELL-TS> 'echo DELL-OK'                                        # P13
ssh <USER>@<HUB-TS> "grep -c '^TS_AUTHKEY=.' $MINI_DEPLOY/.env"                             # P14 — must be 0
ssh <USER>@<HUB-TS> "docker volume ls --format '{{.Name}}' | grep tailscale || echo NONE"   # P15
ssh <USER>@<HUB-TS> "grep -m1 '^TAILNET_HOSTNAME=' $MINI_DEPLOY/.env"                       # P16
ssh <USER>@<HUB-TS> "ls $MINI_DEPLOY/.restore-in-progress 2>&1"                             # must say No such file
docker exec nova-tailscale-1 tailscale status --json | python3 -c \
  "import json,sys;print(json.load(sys.stdin)['Self']['DNSName'])"                          # matches step 1
```

**Verifies:** the Dell answers on its own node; the destination's key is blank,
has no tailnet volume, has the right hostname or none, and has no interrupted
restore; and `nova` is still the Dell's.

**On failure: abort.** Nothing has been done; there is nothing to undo.

## 19. Run the move on the Dell. **Time it. The window opens here.**

```sh
cd $DELL_DEPLOY/.. && time ./install backup --move --transport tailnet
```

**What it does, in order:** flips `v4_tailscale` to `include`, adds `tailscale`
to the quiesced set, dumps, packs, **verifies** the bundle (including running
the reader that ships inside it against the finished bundle with `cryptography`
forced unimportable), chowns everything to you and re-reads it as you, and only
then calls `bk_park` — `docker compose --profile '*' stop`, `.State.Running`
read back `false` for **every** service of the project, and both markers
written under `umask 077` and **read back byte-for-byte**.

**Verifies, all four, in the run's own output:**
- the bundle path and its sha256;
- `parked: every service of this project reads .State.Running false`;
- `parked: the stack is stopped and …/MOVED_TO and …/.moved are in place`;
- exit 0.

### On failure — read the sentence; it tells you which of three states you are in.

**Before you run any recovery command, read whether a marker was written:**

```sh
ls -la $DELL_DEPLOY/tailscale/MOVED_TO $DELL_DEPLOY/.moved
```

`attack-short-cutover.md` F4 found why this comes first:

> *"`bk_park` writes the two markers in a loop: `for path in "$marker" "$moved"`
> … **MOVED_TO is written first.** The second write fails … The runbook's
> step-18 failure text says … 'both markers **may be missing**. Bring the Dell
> back with `docker compose … up -d`' … `MOVED_TO` is **not** missing.
> `deploy/tailscale/start.sh:86-102` … the sidecar refuses. `restart:
> unless-stopped` retries it forever. The verification the runbook then
> prescribes is `docker exec nova-tailscale-1 tailscale status` — which cannot
> run, because the container is not running."*

**If either marker exists and you are recovering, delete BOTH before bringing
the Dell back** (that is the by-hand undo, P2).

- *"the bundle IS written at … Separately: `docker compose stop` did not exit 0,
  so this host is NOT parked"* → the bundle is good, the Dell is half-stopped.
  **R0**, then start over. Nothing reached the mini PC.
- *"… `<services>` would not stop, so this host is NOT parked"* → same, with
  the names.
- *"could not write the move marker …"* / *"did not read back as it was
  written"* → the stack **is** stopped and a marker may be half-written. Delete
  both markers, **R0**, and abort the move.
- **A failure earlier, between the writers stopping and `bk_park`** → per P3,
  nothing restarts anything and no marker was written. **R0.** Do not believe
  the exit message; run `docker compose --project-directory $DELL_DEPLOY ps
  --all` and believe that.

**Do not continue to step 20 on a non-zero exit.**

## 20. Verify the park independently, and in EVERY nova checkout on the Dell.

```sh
docker compose --project-directory $DELL_DEPLOY ps --all --format '{{.Service}} {{.State}}'
cat $DELL_DEPLOY/tailscale/MOVED_TO
cat $DELL_DEPLOY/.moved
ls -l $DELL_DEPLOY/tailscale/MOVED_TO $DELL_DEPLOY/.moved      # both 0600
```

**Verifies:** every service `exited`; both markers present, 0600, carrying
`moved_at`, `bundle`, `bundle_sha256`, `source_host`, `tailnet_dns_name`; and
`bundle_sha256` equals what step 19 printed.

### Then propagate the markers. `attack-reversible.md` C4:

> *"The compose **project** is `nova` on every checkout, so every checkout on
> the machine addresses the same containers and the same `nova_v4_tailscale`
> volume. `backup --move` writes its markers into exactly one of them. …
> Measured on `<DELL>` today — two v4 checkouts, both complete … This repo has
> already been bitten by exactly this class of accident (`compose
> same-project-name trap`)."*

```sh
for d in $(find "$HOME" -maxdepth 6 -type d -name deploy -path '*nova*' 2>/dev/null); do
  [ -f "$d/docker-compose.yml" ] || continue
  [ "$d" = "$DELL_DEPLOY" ] && continue
  cp "$DELL_DEPLOY/.moved" "$d/.moved"
  mkdir -p "$d/tailscale" && cp "$DELL_DEPLOY/tailscale/MOVED_TO" "$d/tailscale/MOVED_TO"
  chmod 600 "$d/.moved" "$d/tailscale/MOVED_TO"
  ls -l "$d/.moved" "$d/tailscale/MOVED_TO"     # READ BOTH BACK, in every directory
done
```

**Verifies:** every nova deploy directory on the Dell now carries both markers,
and you have read each pair back. Note the directories you touched — R3 removes
them from **every** one.

**On failure:** if `find` returns only `$DELL_DEPLOY`, good. If a copy cannot
be read back, write yourself a note naming that directory and **do not run a
bare `docker compose up` on the Dell until step 35**.

## 21. Transfer the move bundle, and compare digests on both ends.

```sh
scp <BUNDLE> <USER>@<HUB-TS>:$MINI_DEPLOY/backups/
ssh <USER>@<HUB-TS> "sha256sum $MINI_DEPLOY/backups/$(basename <BUNDLE>)"
```

**Verifies:** equal to the digest step 19 printed **and** to `bundle_sha256` in
`MOVED_TO`.

**On failure:** re-copy. The Dell is parked but its data is untouched — the
bundle is a copy, not a move of the bytes. If the digest will not settle, go to
**R3**.

## 22. **Drill the real move bundle, before restoring it.** Do not skip.

```sh
ssh <USER>@<HUB-TS> "cd $MINI_REPO && time ./install restore $MINI_DEPLOY/backups/$(basename <BUNDLE>) --drill"
```

**Verifies:** exit 0, and — unlike step 8 — the report now covers
`v4_tailscale` too, because `--move` made it `include`. This is the **only**
rehearsal of the identity carry that exists (step 10).

**Quote the line.** Find and write down the volume line for `v4_tailscale`:
`volume v4_tailscale -> …: N entries, N files, listing identical`. Step 26
needs it.

**Why this step earns its minutes:** it is the last moment at which a bad
bundle costs you only a rollback instead of both copies. The Dell is stopped
but intact.

**On failure: go straight to R3.** Do not attempt the real restore on a bundle
that failed its drill.

## 23. Restore.

```sh
ssh <USER>@<HUB-TS> "cd $MINI_REPO && time ./install restore $MINI_DEPLOY/backups/$(basename <BUNDLE>)"
```

**Verifies, in the run's own output:**
- `target: every declared volume this restore fills is absent or empty, and no
  container of the project 'nova' is here`;
- per-database `N tables compared, every count and digest equal`;
- `volume v4_tailscale -> …: N entries, N files, listing identical`;
- `signing key fingerprint equal`;
- the word **restored**, which is printed *only* with the three facts behind
  it;
- `next: ./install`.

It ends with `postgres` stopped and `deploy/.restored` written. That is
correct — it does not start the stack.

It will print the **names** (never the values) of any carried `.env` keys it
replaced. Five conflicts are normal on a machine that has been installed
before: `generate_secrets` writes fresh values for all five `SECRET_KEYS` on
every install, `ensure_secret` only generates into an EMPTY key, so the hub's
dry-run values are what get replaced and the later `./install` does not undo
them.

**On failure, by gate:**
- *non-empty target* → step 16/17 did not finish. The refusal names every
  volume and container it found. Clear exactly those and re-run — safe, because
  nothing was written.
- *`.restore-in-progress` present* → a previous restore died. The marker lists
  **exactly** what that run created; remove those objects, then the marker.
  Nothing here discovers anything; that list is the bound.
- *passphrase* → P9/step 6.
- *migration content hash* → P6. Check out the sha it names.
- *pg version* → P11.
- *listing diff* → the volume is **left in place** for inspection and the run
  stops before touching the database. Go to **R3**.
- *count/digest mismatch, or signing key* → the data did not survive. **R3.**
  Do not "just carry on": every paired device pins that key
  (`services/core/app/devices_ws.py`, `core_public_key_hex`).
- **the ssh session drops with no summary** → this is not a refusal. **Do not
  run step 24.** `attack-short-cutover.md` F6: *"`grep -rn
  'restore-in-progress' deploy/` matches `deploy/README.md`,
  `deploy/backup_test.sh` and `deploy/backup.sh` — **not
  `deploy/install.sh`**."* Verified at `705620ee`: `install.sh` does not read
  that marker, so `./install` will happily start on top of a half-restored
  database and a half-filled identity volume. Re-read the marker first:
  `ssh <USER>@<HUB-TS> "cat $MINI_DEPLOY/.restore-in-progress"`, undo exactly
  what it names, then re-run step 23.

## 24. Bring Nova up on the mini PC **WITHOUT the tailnet**. This is the checkpoint.

```sh
ssh <USER>@<HUB-TS> "cd $MINI_REPO && ./install"
```

**Note the absence of `NOVA_TAILNET=1`.** `COMPOSE_PROFILES` is a `host` key —
it does not travel — so the destination decides its own profiles, and the
default is tailnet **off**.

This is the step the short-cutover runbook does not have, and it is why this
document takes the reversible structure: **you learn that Nova runs correctly
on the new hardware, with your data, before anything has claimed the tailnet
identity.** At this instant both machines can still serve; only one is running.

## 25. Verify the data against step 1's baseline, locally.

```sh
ssh <USER>@<HUB-TS> "docker compose --project-directory $MINI_DEPLOY ps --format '{{.Service}} {{.State}} {{.Health}}'"
ssh <USER>@<HUB-TS> "curl -s -o /dev/null -w 'web %{http_code}\n' http://127.0.0.1:3000/"
ssh <USER>@<HUB-TS> "curl -s -o /dev/null -w 'core %{http_code}\n' http://127.0.0.1:8000/health/live"
ssh <USER>@<HUB-TS> "docker exec nova-postgres-1 psql -U core -d nova_core -At \
  -c 'select count(*) from people' -c 'select count(*) from turns' \
  -c 'select count(*) from messages' -c 'select count(*) from devices'"
```

**Verifies:** every service healthy, web and core answering, and the four
counts **equal to step 1's** — not zero, not the dry-run stack's zero.

**On failure: R3 still works cleanly.** The mini PC has volumes now, but the
Dell's are untouched and its identity copy is intact.

---

# Phase 5 — the tailnet cutover

The cutover has exactly one ordering rule, and it is mechanical rather than
procedural: **the source's sidecar must read stopped before the destination's
sidecar is ever created.** Step 19's `bk_park` proved that per service and step
20 confirmed it by hand. There is no overlap window to manage, because there
must not be one — two tailscaled on one node key flap, and **a flap is not
something a healthcheck notices**: `serve_ok` reads only its OWN tailscaled and
never asks whether another node holds the key, so both hosts report `healthy`
throughout.

## 26. The POSITIVE identity pre-check. Run this BEFORE `./install`.

**DROPPED:** both source runbooks' gate, which is the negative observation
*"the installer asks for no auth key"*. `attack-reversible.md` C3: *"With a
non-empty `TS_AUTHKEY`, `tailscale_state_present` is **never called**. The
installer asks nothing, step 17's gate reads PASS, and `TS_AUTH_ONCE: 'true'`
then decides on its own whether to use the key — it uses it precisely when the
state store has no logged-in node, i.e. exactly the failure the gate exists to
catch."*

```sh
# 1. the key must be BLANK
ssh <USER>@<HUB-TS> "grep -c '^TS_AUTHKEY=.' $MINI_DEPLOY/.env"          # must print 0

# 2. no interrupted restore
ssh <USER>@<HUB-TS> "ls $MINI_DEPLOY/.restore-in-progress 2>&1"          # No such file

# 3. the state file is present AND NON-EMPTY
ssh <USER>@<HUB-TS> "IMG=\$(docker compose --project-directory $MINI_DEPLOY config --format json \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)[\"services\"][\"tailscale\"][\"image\"])'); \
  docker run --rm -v nova_v4_tailscale:/s:ro --entrypoint sh \"\$IMG\" -c 'wc -c < /s/tailscaled.state'"
```

**Verifies:** `0`, "No such file", and a **non-zero byte count**.

**Why the byte count.** `attack-short-cutover.md` F7: *"`tailscale_state_present`
ends at `state_file_on_volume` … `test -f /s/tailscaled.state`. That is
existence, not content. A truncated, empty, or logged-out `tailscaled.state`
produces the exact success line the runbook pins."* Verified at `705620ee`:
`deploy/install.sh:1122-1125` is exactly that `test -f`.

**What actually proves the contents arrived** is step 23's line
`volume v4_tailscale -> …: N entries, N files, listing identical` — the restore
re-derives per-file content hashes, types, modes and ownership inside the
container that wrote them, and refuses on a mismatch. **Read that line from
step 23's output and quote it to yourself before running step 27.**

**On failure of any of the three: STOP. Do not run step 27.** You are one
`tailscale up` away from minting a second, differently-named node while the
real one sits in a bundle, and every enrolled phone's home-screen icon would
then point at a URL that serves nothing. Go to **R3**.

## 27. Bring the sidecar up on the mini PC.

```sh
ssh <USER>@<HUB-TS> "cd $MINI_REPO && NOVA_TAILNET=1 ./install"
```

**Not through an interactive shell** (P16): with a TTY, the "Node name on the
tailnet" prompt can be answered by hand, and a wrong answer renames your
carried node.

**Verifies:** `tailnet: no auth key needed — <reason>`, then the final line
`On your tailnet: https://<name>/`.

`start.sh` waits for `BackendState: Running`, runs
`tailscale serve --bg --https=443 http://$NOVA_WEB_ADDR:80` against a fixed
bridge address (never a name), and **refuses to let the container report
healthy** until `serve_check.sh`'s `serve_ok` reads the mapping back out of
`tailscale serve status --json`. Nothing had to be carried for the serve
mapping: `start.sh` is its single writer and rebuilds it on every start.

**If it prints `tailnet: TS_AUTHKEY is set`, that is the SAME failure as it
asking for a key** — it means nothing checked the state volume. Stop.

**If it asks for a key, or prints `refuse_tailnet`'s three ways forward: do not
give it one, and do not follow way forward 1 on the screen.** The identity did
not arrive. Go to **R3**.

## 28. Verify it is the SAME node, mechanically against step 1.

```sh
ssh <USER>@<HUB-TS> "docker exec nova-tailscale-1 tailscale status --json" | python3 -c \
  "import json,sys; d=json.load(sys.stdin); s=d['Self']; \
   print('HaveNodeKey', d['HaveNodeKey']); print('DNSName', s['DNSName']); print('Created', s['Created'])"
ssh <USER>@<HUB-TS> "docker exec nova-tailscale-1 tailscale serve status --json"
ssh <USER>@<HUB-TS> "docker exec nova-tailscale-1 /config/serve_check.sh"
```

**Verifies, against the file you wrote at step 1:**
- `DNSName` is **character-for-character** step 1's — **no numeric suffix**;
- `Created` is step 1's original timestamp. **If this is today's date, it is a
  new node**;
- `HaveNodeKey` is `true` (top-level — see step 1);
- serve shows `"443":{"HTTPS":true}` and the web handler's `Proxy` is the
  `172.18.128.x:80` bridge address;
- `serve_check.sh` prints one line, `serving https://…/ -> http://…:80`.

**`serve_check.sh` alone cannot tell you the node was renamed.**
`attack-short-cutover.md` F8: *"If hazard (b) fired and the node came up as
`nova-1`, `serve_ok` still returns 0, the compose healthcheck is green,
`./install` reports 'Nova is up' and prints `On your tailnet:
https://nova-1.<TAILNET>.ts.net/` — a success message containing the wrong
URL."* Make the comparison mechanical:

```sh
ssh <USER>@<HUB-TS> "docker exec nova-tailscale-1 /config/serve_check.sh" \
  | grep -qF "https://<the exact name from step 1>/" && echo SAME || echo "RENAMED — STOP"
```

**On failure — a name like `nova-1`:** the control plane silently renamed a new
node because the old one was still registered. Stop the mini PC's sidecar,
confirm the Dell really is parked, and go to **R3**. Then delete the spurious
node in the Tailscale admin console — neither source runbook says to, and it
will otherwise hold a name.

## 29. Verify from outside both machines. **The window closes here.**

From a **third** tailnet peer — not the Dell, not the mini PC — and then from
the phone:

```sh
curl -sS -o /dev/null -w 'http=%{http_code} tls=%{ssl_verify_result}\n' https://nova.<TAILNET>.ts.net/
```

**Verifies:** a real HTTP status and `tls=0` over the real URL. The sidecar
reporting healthy is the mini PC's opinion of itself; this is the owner's path.

**DROPPED:** `runbook-reversible.md` step 19's `curl -sI … | head -3`.
`attack-reversible.md` C9: *"With `-s`, a certificate failure or a connection
failure produces **no output and no message**, and the pipeline's exit status
is `head`'s, which is 0. Empty output is easy to read as 'nothing to report' in
the middle of a cutover."*

**Then the owner opens the app on his phone.** The real test is that **he is
still signed in without logging in again** — same origin, same cert, same
cookie scope, and the session row came back inside `nova_core`.

**On failure — the name resolves but nothing answers:** the healthcheck should
already have caught it, so suspect DNS caching on the client first.
**On failure — he is logged out:** check step 28's DNS name character by
character against step 1's. If the name is right, the session row did not
survive; the data is still correct (step 23 compared every count and digest),
so just log in.

**Tell him the window is closed.**

---

# Phase 6 — the GPU, after the move

## 30. Create the provider row, from the hub, with the Dell AWAKE.

```sh
ssh <USER>@<HUB-TS> "T=\$(grep -E '^CORE_GATEWAY_TOKEN=' $MINI_DEPLOY/.env | cut -d= -f2-); \
  curl -s -X POST http://127.0.0.1:8001/admin/providers \
  -H \"Authorization: Bearer \$T\" -H 'Content-Type: application/json' \
  -d '{\"name\":\"dell\",\"adapter\":\"openai-chat\",\"base_url\":\"https://<DELLWIN>.<TAILNET>.ts.net/v1\",\"auth_shape\":\"none\"}'"
```

(With 13b instead of 13a, the `base_url` is `http://<DELL-TS>:11434/v1`.)

**Verifies:** HTTP 200, and a row whose `base_url` is what you typed and whose
`listing` is `"available"` with a model count in `listing_note`. The create path
runs `_verify_or_502`, and **nothing is written if the verify refuses** — so a
200 here is a proof of reachability, not a claim of one.

Then list the models through the gateway, which is the second, independent
check:

```sh
ssh <USER>@<HUB-TS> "T=\$(grep -E '^CORE_GATEWAY_TOKEN=' $MINI_DEPLOY/.env | cut -d= -f2-); \
  curl -s -H \"Authorization: Bearer \$T\" http://127.0.0.1:8001/admin/providers/dell/models"
```

**On failure — 502 "could not verify provider 'dell'":** the gateway container
cannot reach the Dell. Step 14 proved it could; re-run step 14's command.
Nothing was written, so there is nothing to undo.
**On failure — 400 "adapter=ollama cannot be registered here":** you used the
brief's adapter. Use `openai-chat` and the `/v1` path.
**On failure — 409:** the name is reserved (`hub`, `library`, `ollama`) or
taken. Pick another.

## 31. Know what the row is, and is not.

`insert_row` derives `local` as `adapter = 'ollama'`, so this row is
`local = false`. One measured consequence, stated rather than discovered later:
`routing.py` derives a cross-tier **local** standby only when no link in the
chain is local, and this row is not local — so the standby machinery still has
a job to do, which is step 33.

`compute_id`'s `served_on` grammar keeps the history honest across the move:
probes on the 3090 carry `gpu:cuda:<uuid>` and the mini PC's engine carries a
`cpu:` stamp, so a measurement taken on one is never read as the other's.

**DROPPED:** `runbook-reversible.md` step 21's claim that *"`data_plane.py:169`
records usage for a non-local row, so turns on your own 3090 will appear in the
spend ledger."* `attack-reversible.md` C12: *"That is a routing success note,
not a usage or spend record. The surrounding claim may still be true by another
path, but the citation does not support it."*

## 32. Point `chat.model` at it — through the app, not through psql.

Set `chat.model` to the value you wrote down at step 15, in the app's Settings.
There is a product path (`PUT /api/v1/settings`, `services/core/app/settings_store.py`)
and it is the one the owner will use again.

**DROPPED:** `runbook-short-cutover.md` step 24's raw
`psql -c "update settings set value = …"`. It bypasses the setting's own type
and side effects (the write path re-times the digest beat when the setting is
one its firing is computed from), and it teaches a habit that is wrong every
other time.

**Verify by reading it back, and then through the product:**

```sh
ssh <USER>@<HUB-TS> "docker exec nova-postgres-1 psql -U core -d nova_core -At \
  -c \"select key, value from settings where key like 'chat.%'\""
```

**On failure:** put back the rollback value from step 15.

## 33. Confirm the embedder survived, and give the hub a fallback chat model.

```sh
ssh <USER>@<HUB-TS> "docker exec nova-ollama-1 ollama list"
```

**Verifies:** `nomic-embed-text:latest` is **still there** — step 16
deliberately kept `nova_v4_ollama` for exactly this. If it is missing, something
deleted that volume; re-pull it now:
`ssh <USER>@<HUB-TS> "docker exec nova-ollama-1 ollama pull nomic-embed-text"`.

Then, optionally but recommended:

```sh
ssh <USER>@<HUB-TS> "docker exec nova-ollama-1 ollama pull qwen3:8b"
ssh <USER>@<HUB-TS> "docker exec nova-ollama-1 ollama list"     # BOTH listed
```

**Why:** `hub` is `is_default = true` and resolves to the mini PC's own ollama.
With only the embedder installed, the local standby finds **no** model ollama
declares fit for chat and returns nothing, so a chain whose only GPU link is
asleep has nowhere to fall — and the turn ends at
`503, "every link in the <role> chain refused this request"`. With a small model
present it falls to CPU inference on an N150: slow, and *present*.

**On failure:** the pull is slow or the disk is short. The move is still done;
record that there is no fallback and that a sleeping Dell means no chat.

## 34. Have Nova answer one real turn, in the app. Then read the trace.

Not a curl. The owner opens the chat and asks her something.

```sh
ssh <USER>@<HUB-TS> "docker exec nova-postgres-1 psql -U core -d nova_core -At \
  -c \"select tool, status, started_at from turn_spans where turn_id = '<the turn id>' order by started_at\""
```

**Verifies:** the turn ran, and against which provider. **A reply is a claim;
the trace is the fact.**

**On failure:** the turn errors or hangs — most likely the Dell is asleep. See
"What is still broken".

---

# Phase 7 — the one enrolled device

## 35. Repoint `novad`.

Measured 2026-09-21: `devices` holds exactly **1** row, and `novad.service` was
`active (running)` **on the Dell**, enrolled at `"server":
"http://localhost:3000"`. After the move, `localhost:3000` on the Dell serves
nothing.

```sh
novad repoint --server https://nova.<TAILNET>.ts.net --check
novad repoint --server https://nova.<TAILNET>.ts.net
systemctl --user restart novad
novad status
```

**Verifies:** `--check` prints the verdict and **writes nothing, ever**. The
real run proves the new URL is the same Nova before it saves: it dials
`/api/v1/devices/ws`, reads core's challenge frame, and compares `core_pubkey`
to the pinned key with `subtle.ConstantTimeCompare` — *"that server is not the
Nova you paired with"*, config untouched, if they differ. It then completes the
handshake, so a server with the right key that has forgotten this device fails
before the write. `novad status` is what tells you the daemon reconnected;
`repoint` restarts nothing and never claims it did.

**On failure — "that server is not the Nova you paired with":** you are pointing
at something that is not your Nova. Stop and find out what. **Re-enrolling
would silently accept the impostor.**
**On failure — the handshake fails after the key matched:** the restored
`nova_core` does not have this device. Step 23 compared the signing-key
fingerprint, so this is a device row problem, not a key problem — re-enroll.

**Separate decision, not part of this move:** `novad` is on the Dell, which is
now a GPU box that sleeps. If the daemon is meant to be always-on, its home is
the mini PC — and that is a re-enroll, not a repoint.

---

# Phase 8 — the Dell afterwards

## 36. Leave it parked, deliberately, and put the power settings back.

Both markers stay in place, in **every** directory step 20 put them. They are
what stop a second tailscaled from claiming the node key — `start.sh` at the
sidecar and `refuse_if_moved` at the installer.

```sh
ls -l $DELL_DEPLOY/.moved $DELL_DEPLOY/tailscale/MOVED_TO
docker volume inspect nova_v4_tailscale --format '{{.Name}}'    # still exists — it is the rollback
```

The Dell's own `v4_tailscale` volume is **not deleted** by the move: `bk_park`
runs `docker compose stop`, never `down -v`, and nothing in the move path
removes a source volume. That stale copy is the rollback, and it stays valid
until the node key rotates.

**Do not `docker image prune` on the Dell** until the move is final — the four
`nova-*` images you recorded at step 1 are what a rollback brings back (P5).

Then decide the power settings deliberately (P13):

```
powercfg /change standby-timeout-ac <your recorded value>
powercfg /change hibernate-timeout-ac <your recorded value>
```

**Until S46 lands wake-on-LAN, a sleeping Dell means no GPU.** If you want the
3090 available, leave sleep disabled and say so out loud; if you want the power
back, accept step 33's CPU fallback. This is a choice, not a default.

## 37. Know the one bypass that is left.

A `docker run` of the sidecar image that does **not** mount `/config` sees no
`MOVED_TO` and is refused by nothing. `deploy/README.md` names this bound
honestly. There is no code that stops you. Do not do it.

---

# The final verification list

Run all of these, from the machines named, and check every one off. This is
what "the move worked" means.

| # | Check | Command | Pass |
|---|---|---|---|
| V1 | every service healthy on the hub | `ssh <USER>@<HUB-TS> "docker compose --project-directory $MINI_DEPLOY ps --format '{{.Service}} {{.State}} {{.Health}}'"` | all `running`, health `healthy` where declared |
| V2 | web and core answer locally | `curl` 127.0.0.1:3000 and :8000/health/live on the hub | `200` each |
| V3 | counts equal step 1's | `psql` `people`, `turns`, `messages`, `devices` on the hub | identical to the baseline file |
| V4 | digests equal | step 23's output | `N tables compared, every count and digest equal`, per database |
| V5 | **signing-key fingerprint unchanged** | step 23's output | `signing key fingerprint equal` |
| V6 | identity volume arrived intact | step 23's output | `volume v4_tailscale -> …: listing identical` |
| V7 | same node, not a new one | step 28 | `DNSName` == step 1's, `Created` == step 1's, `HaveNodeKey true` |
| V8 | serve mapping rebuilt | step 28 | `"443":{"HTTPS":true}`, `Proxy` = the bridge address |
| V9 | **the tailnet URL serves, from a third machine** | step 29 | `http=200` (or a login redirect), `tls=0` |
| V10 | **the phone is still signed in, with its threads** | open the app | no login prompt; the threads are there |
| V11 | chat answers on the 3090 | step 34, then the trace | the turn ran, against `dell` |
| V12 | the embedder is present | step 33 | `nomic-embed-text:latest` listed |
| V13 | the Dell is parked and stays parked | step 36 | both markers present in every nova deploy dir, all services `exited` |
| V14 | nothing else on the hub was collateral | `docker ps` | both minecraft containers still running |

**V5, V9 and V10 are the three that cannot be inferred from the others.** V5 is
what every paired device pins; V9 is the owner's own path, not the machine's
opinion of itself; V10 is the whole reason the identity was carried rather than
re-minted.

---

# Rollback, by phase

| | If you stop here | What undoes it | Cost |
|---|---|---|---|
| **R0** | `backup --move` (step 19) failed before it printed `parked:` | see below | minutes; nothing reached the hub |
| **R1** | anywhere in Phase 1 | delete the rehearsal bundle from both machines | nothing. Nova never stopped |
| **R2** | after step 13 (engine exposed) | 13a: `tailscale serve --https=443 off`. 13b: drop the overlay from `COMPOSE_FILE`, `docker compose --project-directory $DELL_DEPLOY up -d ollama` | seconds of local inference |
| **R2b** | after step 16 (hub torn down) | **nothing undoes it** — the dry-run volumes are gone | none for Nova; P18 measured that data empty |
| **R3** | anywhere from step 19 to step 25 | see below | Nova returns at the same URL. Nothing written on the hub is lost, because nothing has been written |
| **R4** | after step 27 (sidecar up on the hub) | R3, with the identity removal done FIRST | same as R3, **plus**: the node key has now been served from two hosts in sequence |
| **R5** | after the first real write on the hub | technically R4, but you lose that work — see "point of no return" | |

## R0 — a `--move` that died before it parked

```sh
# on <DELL>
ls -la $DELL_DEPLOY/tailscale/MOVED_TO $DELL_DEPLOY/.moved     # READ FIRST (step 19's F4 note)
rm -f $DELL_DEPLOY/tailscale/MOVED_TO $DELL_DEPLOY/.moved      # only if either exists
ls -la $DELL_DEPLOY/tailscale/MOVED_TO $DELL_DEPLOY/.moved     # both must be gone
docker compose --project-directory $DELL_DEPLOY --profile '*' up -d     # NO --build
docker compose --project-directory $DELL_DEPLOY ps --all --format '{{.Service}} {{.State}}'
docker exec nova-tailscale-1 tailscale status | head -3
```

**Verifies:** both markers gone; every service running; `nova` online again.
Then start over from step 18.

Neither source runbook has this row. `attack-reversible.md` C6: *"The runbook
does name this, honestly, under step 11's failure list. But its **Rollback
table has no row for it**."*

## R3 — the one you will actually use

**Order matters. Do the hub first, all of it, before touching the Dell.**

`attack-reversible.md` C1 (CRITICAL) found that both source runbooks leave the
hub holding a bootable copy of the identity with nothing guarding it:

> *"`<HUB>` is now left holding, all at once: `nova_v4_tailscale`, a complete
> `tailscaled.state` for the live node; `COMPOSE_PROFILES` containing `tailnet`
> …; `restart: unless-stopped` on the sidecar; **no `.moved`, no `MOVED_TO`,
> and no marker of any kind.** Any one of these on `<HUB>`, days later,
> re-joins the node … Two tailscaled hold one node key … **Nothing turns
> red.**"*

```sh
# ── on <HUB>, FIRST ──────────────────────────────────────────────────────
ssh <USER>@<HUB-TS> "docker compose --project-directory $MINI_DEPLOY --profile '*' stop"
ssh <USER>@<HUB-TS> "docker inspect nova-tailscale-1 --format '{{.State.Running}}'"     # MUST read false
ssh <USER>@<HUB-TS> "docker volume rm nova_v4_tailscale"
ssh <USER>@<HUB-TS> "docker volume ls --format '{{.Name}}' | grep -x nova_v4_tailscale" # MUST print NOTHING
ssh <USER>@<HUB-TS> "cd $MINI_REPO && NOVA_TAILNET=0 ./install"    # takes `tailnet` OUT of COMPOSE_PROFILES
ssh <USER>@<HUB-TS> "grep -m1 '^COMPOSE_PROFILES=' $MINI_DEPLOY/.env"   # must not contain tailnet
```

Deleting the hub's copy is safe: the bundle still holds one whose listing step
22's drill diffed, and the Dell's own `nova_v4_tailscale` is untouched.
`NOVA_TAILNET=0` is already supported and already says what it does not do
(*"A running tailscale container is left alone"*) — which is why the explicit
`stop` and the volume removal both stay.

```sh
# ── then on <DELL> ───────────────────────────────────────────────────────
# the by-hand undo — `./install undo-move` does NOT exist (P2)
# remove the markers from EVERY directory step 20 put them in:
for d in <every deploy dir from step 20>; do
  rm -f "$d/.moved" "$d/tailscale/MOVED_TO"
  ls -la "$d/.moved" "$d/tailscale/MOVED_TO"      # both must be GONE, in each one
done
docker compose --project-directory $DELL_DEPLOY --profile '*' up -d      # NO --build, NOT ./install
docker compose --project-directory $DELL_DEPLOY ps --all --format '{{.Service}} {{.State}}'
docker exec nova-tailscale-1 tailscale status --json | python3 -c \
  "import json,sys;d=json.load(sys.stdin);print(d['BackendState'], d['Self']['DNSName'])"
curl -sS -o /dev/null -w 'http=%{http_code}\n' https://nova.<TAILNET>.ts.net/    # from a third machine
```

**Verifies:** markers gone everywhere; every service running; `BackendState:
Running` with step 1's DNS name; the URL answers again.

**Never `./install` here.** P5 and `attack-short-cutover.md` F1: `./install`
runs `up -d --build`, which rebuilds the fallback from S41 source and runs two
migrations that did not exist when the bundle was sealed — *"a build error or a
migration failure at 2am on the machine that was the whole safety net"*, and it
is quietly one-way even when it succeeds, because *"the Dell's schema is ahead
of its own bundle"*.

## The point of no return

**There is exactly one, and it is not where people expect.** Both source
runbooks agree, and they are right.

It is **not** step 27 (the sidecar logging in on the hub): the Dell's
`v4_tailscale` volume still holds the same state, so R4 is real.

It is **not** step 23 (the restore): the Dell's volumes are untouched —
`bk_park` runs `compose stop`, never `down -v`.

> **The point of no return is the first write to Nova on the mini PC after the
> cutover — the first chat turn, the first note, the first setting.** From that
> moment the Dell's copy is stale, and rolling back silently discards whatever
> Nova did in between. Nothing in the code notices; there is no merge.

So: **do not use Nova until you have decided the move stands.** Step 29's curl
and a look at the UI are reads. A conversation is not.

If a rollback is being considered after real use, the honest path is to take a
fresh `backup` on the mini PC and restore *that* onto the Dell — which means
tearing the Dell's stack down to make it an empty target. That is a second
cutover, not a rollback.

The second, smaller irreversible point is **step 16**, which destroys the mini
PC's dry-run data. It is safe only because P18 measured `people = 0` there.
**Re-check P18 the day of, not the week before.**

---

# Expected downtime, and what the owner sees

**The window opens at step 19**, when `--move` stops the writers for the
database dump — well before `bk_park` — **and closes at step 29**, when the URL
answers from a third machine.

**Expected: 20–40 minutes.** These are **estimates from data sizes, not
measurements.** Step 11 replaces them with real numbers; that is Phase 1's main
purpose, and the measured number is what you tell the owner.

| Step | Estimate | Basis |
|---|---|---|
| 19 `backup --move` | 4–10 min | ~32 MB of database plus ~1.3 MB of volumes; the cost is the dump, the self-test restore into a throwaway database, the pack, the encrypt and the re-verify — not the bytes |
| 21 transfer | < 1 min | well under 100 MB over the tailnet |
| 22 drill the move bundle | 3–8 min | decrypt, extract, throwaway postgres, three restores, count+digest every table, on an N150 |
| 23 restore | 4–10 min | the same passes against the real objects |
| 24 `./install` (no tailnet) | 4–8 min | **with P7 satisfied**; startup, migrations and the health wait, whose own timeout is 240s |
| 27 `NOVA_TAILNET=1 ./install` | 1–3 min | one more container plus `serve_check` |
| 28–29 verification | 2–5 min | including the owner opening his phone |
| slack | 10 min | one retry of any single step |

**Add 20–45 minutes if P7 is not satisfied** and the four build services compile
on the N150 inside the window. That is the single largest avoidable term, and
step 4 avoids it entirely.

## On his phone, during the window

`https://nova.<TAILNET>.ts.net` **fails to connect**. Not a spinner, not a
login page, not stale content — a connection-failure page, because MagicDNS
still resolves the name the whole time while no node answers for it.

`apps/web` ships **no service worker** (searched `apps/web/src` and
`apps/web/public`; only `public/manifest.webmanifest` exists), so there is no
cached shell to render, no offline screen, and nothing stale to clear
afterwards.

The home-screen icon stays exactly where it is and keeps looking the same — iOS
freezes it at install and nothing here re-triggers that.

## On his phone, after

The same app, at the same URL, with the same certificate, **still signed in,
with his threads**. Same origin means the same cookie scope, and the session
row is inside the restored `nova_core`. No delete, no re-add, no re-pair, no
re-login.

**If either a delete-and-re-add or a fresh login turns out to be necessary, the
identity did not carry** — that is R3, not a minor annoyance.

---

# What is still broken after this

Stated plainly, because a plan that hides its gaps is worse than a shorter one.

1. **The Dell sleeping.** There is no wake-on-LAN until S46. With the Dell
   asleep the hub has no GPU: a turn whose chain names the `dell` provider gets
   `dell` unreachable, recorded as `unreachable` in the route verdicts, and
   falls to the local standby on the mini PC's N150 CPU — slowly, if step 33
   was done. Without step 33 it ends at
   `503, "every link in the <role> chain refused this request"`. The owner's
   options are: wake the Dell by hand (the provider row needs no change; the
   address is the same when it comes back), switch `chat.model` to a cloud
   provider (verified rows for Anthropic, Cerebras and OpenRouter already
   exist), or accept CPU inference. **Nothing about the move fixes this.**

2. **`undo-move` does not exist** (P2). The rollback is by hand. It works —
   it is two `rm`s and a `compose up -d` — but it performs none of the verb's
   checks: no liveness read, no typed confirmation, no read-back. And on this
   Dell the liveness read would always print *"I cannot check from here"*
   anyway, because there is no host `tailscale` CLI and the sidecar is stopped
   by definition (`attack-reversible.md` C11).

3. **A failed `--move` does not restart what it stopped** (P3,
   `deploy/backup.sh:1676`). The 2026-09-21 ruling requires every exit path to
   end running or parked and to say which; the code has only the skip. R0 is
   the manual recovery. Until that line moves, every step in Phase 4 sits
   downstream of a `--move` that can stop the Dell and walk away.

4. **`./install` does not read `.restore-in-progress`.** Verified at
   `705620ee`: the marker is written by the restore and read by nothing in
   `install.sh`, so a half-restored hub will start. Step 18 and step 26 check
   it by hand. That is a sentence in a document guarding a property that should
   be a `[ -f ]` — by this repo's own rule, not done.

5. **`decide_tailnet` checks `TS_AUTHKEY` before the carried state.** P14. The
   mechanical fix is one reordering, or a refusal of a non-empty `TS_AUTHKEY`
   while `deploy/.restored` is present and the state volume holds a node — a
   CANNOT, naming the moved-in identity, not a decision on the owner's behalf.
   Until then, step 26 is a person running three commands.

6. **`tailscale_state_present` is `test -f`.** It passes on an empty or
   logged-out state file. Step 26's byte count and step 23's listing line cover
   it; the code does not.

7. **The Dell's ollama has no auth.** Whichever path step 13 took, any tailnet
   peer — including a work device — can `POST /api/pull` and
   `DELETE /api/delete` against ~82 GB of model weights that are in no bundle.
   S42 lands the TLS and the bearer.

8. **The deployed worktree is now 141 commits ahead of what was running.**
   After step 2 the Dell's checkout carries S41, but its *containers* do not,
   and that mismatch is deliberate — it is what makes the rollback cheap. The
   day anything runs `./install` or `up -d --build` on the Dell, the new code
   and two new migrations land, and the pre-move images stop being a rollback.

9. **Node key expiry during a long park.** Measured 2026-09-21:
   `KeyExpiry 2027-01-10`, comfortably past any short move. If the Dell is
   parked for months before the hub is stood up, the key can lapse while
   offline and the bit-identical guarantee this whole plan rests on is gone.
   Whether expiry is disabled for this node needs the admin console.

10. **Two things in this document are unmeasured.** Step 13's reachability (the
    WSL2 mirrored-mode assumption, and whether Docker Desktop will bind to the
    Windows Tailscale adapter) — steps 13 and 14 are the verification, and a
    failure there is a **finding to record, not a step to improvise past**. And
    Tailscale's exact rename behaviour when a different key requests a name an
    online peer already holds is stated from general behaviour; no second node
    was created to test it against this tailnet.

11. **Nothing in this document has been executed.** The first person to run it
    should keep a log and correct this file from it — starting with the
    timings, which are the only numbers here that are guesses about time rather
    than readings of code.
