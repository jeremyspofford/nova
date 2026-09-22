# Runbook: moving Nova from the Dell to the mini PC

**Stance: the short, rehearsed cutover.** One downtime window, entered only
after a full-dress drill has already run the same code against the same data
on the destination. Fewer intermediate states are individually reversible; in
exchange the window is short, its length has been *measured* rather than
guessed, and the data is never live in two places.

Every factual claim below carries its source: a `path:line` in this worktree,
or the exact read-only command that produced it. Where something is *not*
measured it says so in those words. Nothing in this file was executed against
either machine beyond reads.

## Placeholders

This repo is **public**. Every host-identifying string below is a placeholder,
not a real value. Substitute before running; none of these are secrets, they
are simply not published.

| Placeholder | What it is |
|---|---|
| `<TAILNET>` | the tailnet's DNS suffix, so the hub URL is `https://nova.<TAILNET>.ts.net` |
| `<MINI>` | the mini PC's own tailnet node name (it has one already, distinct from `nova`) |
| `<MINI_IP>` | the mini PC's tailnet address |
| `<DELLWIN>` | the Dell's **Windows** tailnet node name — a second, separate node from `nova` |
| `<DELL_IP>` | that Windows node's tailnet address |
| `<USER>` | the login on both machines |
| `$DELL_REPO` | the checkout the **running** Dell stack was brought up from (read it off `docker ps --format '{{.Label "com.docker.compose.project.config_files"}}'`) |
| `$DELL_DEPLOY` | `$DELL_REPO/deploy` — the directory whose `.env` the running stack uses |
| `$MINI_REPO` | the mini PC's checkout of this repo |
| `$MINI_DEPLOY` | `$MINI_REPO/deploy` |

Set the two directory variables in each shell before you start; every command
below uses them rather than a literal path.

```sh
# on the Dell
DELL_REPO=<the checkout the live stack was brought up from>; DELL_DEPLOY="$DELL_REPO/deploy"
# on the mini PC
MINI_REPO=<the checkout there>; MINI_DEPLOY="$MINI_REPO/deploy"
```

---

## 0. What this moves, and what it does not

**Moves.** The tailnet node identity (`v4_tailscale`, holding `tailscaled.state`
— the node key, the certs, the MagicDNS registration), the three Postgres
databases, the memory notes (`v4_memdata`), Nova's scratch space
(`v4_workspace`), and the carried `.env` keys. After the move
`https://nova.<TAILNET>.ts.net` is the *same origin, same certificate, same
cookie scope*, served by the mini PC — so no phone is re-paired and no login is
repeated (`docs/plans/rebuild/s45/read-tailnet-identity.md` §3, §5).

**Does not move.** The GPU. The Dell keeps the 3090 and keeps its own,
*separate* Windows tailnet node — measured: `docker exec nova-tailscale-1
tailscale status` lists `nova` and `<DELLWIN>` as two distinct peers. That
second node is what Phase B uses to keep the 3090 after the hub leaves.

**Does not move, by disposition.** `v4_models` and `v4_ollama` are
`exclude-redownload` (`deploy/docker-compose.yml`, the `volumes:` block). The
Dell's seven local models (17 GB `qwen3.8:27b`, 19 GB `gemma4:31b`, and five
more — `docker exec nova-ollama-1 ollama list`) are **not** in the bundle and
will not appear on the mini PC. That is deliberate and it is the whole reason
Phase B exists.

---

## 1. Prerequisites — every one of these must be true before step 1

Check each. A prerequisite that cannot be *checked* is a prerequisite that has
failed.

### P1. `./install` dispatches the verbs this runbook uses — **BLOCKER, false today**

    grep -n 'install) cmd_install' -A 2 $DELL_DEPLOY/install.sh

Verifies: the dispatch table names `backup`, `restore` and `drill`.

**Measured today, on `slice/s41`, re-read after the last commit: it does not.** `deploy/install.sh:1831-1833`
is exactly `install) cmd_install ;; update) cmd_update ;; *) die "unknown
subcommand: $cmd (expected: install, update)"`, and `deploy/install.sh` never
sources `deploy/backup.sh` or `deploy/passphrase.sh` (only
`deploy/install.sh:71`, `. "$SCRIPT_DIR/subnet.sh"`). `cmd_backup`,
`cmd_restore` and `cmd_drill` exist in `deploy/backup.sh` (lines 2337, 3980,
3993) and are reachable **only** from `deploy/backup_test.sh`, which sources
them directly.

On failure: **stop.** Every `./install backup|restore|drill` in this runbook is
unreachable until the dispatch lands. Do not work around it by sourcing
`backup.sh` by hand: `cmd_install`'s `refuse_if_moved`
(`deploy/install.sh:371-385`) is the only thing that stops a parked host from
starting a second claimant of the node key, and a hand-sourced verb skips it.

### P2. `./install undo-move` exists — **BLOCKER, false today**

    grep -n 'cmd_undo_move\|undo_move()' $DELL_DEPLOY/backup.sh $DELL_DEPLOY/install.sh

Verifies: a function, not a mention.

**Measured today: only mentions.** `deploy/backup.sh:21` says in its own words
that "`cmd_undo_move` is still owed"; `deploy/backup.sh:2227` and
`deploy/install.sh:384` both *print* `./install undo-move` as the way back.
The command they name does not exist.

On failure: **stop.** `undo-move` is the rollback for the entire cutover
(§6, Phase D). Without it, rolling back means deleting `deploy/.moved` and
`deploy/tailscale/MOVED_TO` by hand on a machine that is off the tailnet — the
3am scenario `design-verdict.md` §9.5 was written to prevent.

### P3. A failed `--move` restarts what it stopped — **BLOCKER, false today**

    sed -n '1676p' $DELL_DEPLOY/backup.sh

Verifies: the writer-restart branch is not skipped in move mode.

**Measured today, the line reads:**

    if [ -n "$BK_RUN_STOPPED" ] && [ "$BK_RUN_MODE" != "move" ]; then

so in `--move` the restart is unconditionally skipped. The 2026-09-21 ruling
(`docs/plans/rebuild/s41/rulings.md`, "a failed `--move` parks or restarts, and
says which") requires every exit path to end running **or** parked and to say
which. The most recent commit touching this is `7b662253`, a `docs(s41)`
commit — the rule is written, the code is not.

On failure: **stop.** This is the defect behind §7's riskiest step. A failure
anywhere between the writer stop and `bk_park` leaves the Dell stopped, off the
tailnet, with no marker and no restart — and P2 means no scripted way back.

### P4. `deploy/tailscale/start.sh` refuses on `MOVED_TO` — **true, landed mid-writing**

    grep -n 'MOVED_TO' $DELL_DEPLOY/tailscale/start.sh

Verifies: the sidecar's own command refuses to start on a parked host.

**Measured twice today, with different answers, which is why this check is
here and not assumed.** The first reading matched nothing. The second, after
commit `89e75231` ("feat(s41): the sidecar refuses to start while MOVED_TO is
present"), matches six times: `deploy/tailscale/start.sh:86-87` is
`MOVED_TO="$CONFIG_DIR/MOVED_TO"` / `if [ -e "$MOVED_TO" ]; then`, as step 0
before containerboot.

This matters because it closes the hole the other refusal cannot: `./install`'s
`refuse_if_moved` (`deploy/install.sh:371-385`) runs only inside `./install`,
so a bare `docker compose up -d` on a parked Dell — the reflex of anyone trying
to get Nova back — would otherwise start a second tailscaled on the moved node
key. Two claimants of one node key flap, and **no healthcheck notices**
(`deploy/docker-compose.yml`, the `v4_tailscale` comment;
`read-tailnet-identity.md` §2a).

The bound is stated in the file itself: a `docker run` of the sidecar image
that does **not** mount `/config` still bypasses it.

On failure (the grep matches nothing again — a revert, or a different
checkout): treat it as a blocker, or accept that the only thing between the
owner and an intermittent, undiagnosable tailnet fault is his own memory of not
typing `docker compose up`.

### P5. The Dell's live checkout carries the S41 code

    git -C $DELL_REPO rev-parse --abbrev-ref HEAD
    git -C $DELL_REPO log --oneline -1

Verifies: the branch and commit that the *running* stack was brought up from
contains `cmd_backup`.

**Measured today: it does not.** The live stack's compose files resolve to a
worktree on branch `rebuild/v4` at commit `0996a31f`
(`docker ps --format '{{.Label "com.docker.compose.project.config_files"}}'`,
then `git -C <that worktree> log --oneline -1`). `slice/s41` is 141 commits
ahead of `rebuild/v4` and 0 behind, and `0996a31f` is an ancestor of
`slice/s41` (`git merge-base --is-ancestor`), so it fast-forwards.

This matters mechanically, not cosmetically: `BK_DIR` is the directory of
`backup.sh` itself (`deploy/backup.sh:24`) and `bk_env_file` defaults to
`$BK_DIR/.env` (`deploy/backup.sh:48`). Running the verb from a *different*
checkout reads a *different* `.env` and backs up the wrong stack's declared
state. The S41 code must be checked out **in the deployed worktree**, with its
existing `deploy/.env` left in place.

On failure: fast-forward the deployed worktree to the S41 commit, confirm
`deploy/.env` is unchanged (`git status --short` must not list it — it is
gitignored), and re-run this check.

### P6. The mini PC's checkout is on the same commit, and clean

    ssh <USER>@<MINI_IP> "git -C $MINI_REPO log --oneline -1; git -C $MINI_REPO status --short"

Verifies: identical `deploy/` code on both ends.

**Measured today: `main` at `e5abd0b` (the merge of PR #68, the S40b slice), working tree clean.** That commit predates S41, so
the mini PC has no `backup.sh` at all: `ls $MINI_REPO/deploy` there returns
`README.md docker-compose.gpu.yml docker-compose.yml install.sh install_test.sh
postgres-init tailnet_topology_test.sh tailscale` — no `backup.sh`, no
`passphrase.sh`, no `backup/`, no `compose_read.sh`, no `subnet.sh`.

On failure: fetch and check out the S41 commit there (Phase A, step 2).

### P7. Both machines run a shell and tooling the code supports

    ssh <USER>@<MINI_IP> "bash --version | head -1; openssl version; tar --version | head -1; python3 -V; docker --version; docker compose version"

Verifies: bash >= 3.2 (the floor `map-portability.md` sets), OpenSSL present,
GNU tar, python3, docker + compose.

Measured 2026-09-21 (`docs/plans/rebuild/s41/map-minipc-measured.md`, "Host
facts that bind the encrypted bundle"): bash 5.2.21, OpenSSL 3.0.13, GNU tar
1.35, python3 3.12.3, Docker 29.8.0 / compose v5.5.1. `age` is **not**
installed and is not needed — the bundle's crypto runs in a container
(`docker run --rm python:3.12-slim python3 -c "import ctypes.util;
print(ctypes.util.find_library('crypto'))"` prints `libcrypto.so.3`,
`measurements.md` R5).

On failure: the missing tool is named by the check; install it before step 1,
never mid-restore.

### P8. The backup passphrase resolves, and you know which source

    grep -E '^NOVA_PASSPHRASE_(SOURCE|FILE|CMD)=' $DELL_DEPLOY/.env

Verifies: which of the four resolvers this machine uses
(`deploy/passphrase.sh:33`, `NOVA_PASSPHRASE_SOURCES="file env prompt cmd"`).

**Measured today: none of the three keys is present in the live `.env`,** and
no `deploy/.backup-passphrase` file exists in the deployed worktree
(`ls -la $DELL_DEPLOY/.backup-passphrase` → no such file). So the first backup
will take the `file` resolver's *absent* branch (`nova_pass_file` returns exit
3, "the ONE case that permits a create", `deploy/passphrase.sh:84-92`) and
generate one.

On failure — or rather, **before step 1 either way**: decide this deliberately.
The passphrase opens every bundle this machine ever writes. Whatever source you
choose, the passphrase must be recorded somewhere **off both machines** before
the cutover, because after Phase D the Dell is parked and the bundle is the
only copy of the identity. A passphrase that lives only on the Dell's disk is
not a backup.

### P9. The `.env` has no key that nothing declares

    comm -23 <(grep -o '^[A-Z_]*' $DELL_DEPLOY/.env | sort -u) \
             <(grep -oE '^#? ?[A-Z_]+=' $DELL_DEPLOY/.env.example | tr -d '# =' | sort -u)

Verifies: `bk_env_facts` (`deploy/backup.sh:608-672`) can classify every live
key; an undeclared one is a refusal.

Measured: the live `.env` carries `POSTGRES_PASSWORD CORE_TOKEN
CORE_GATEWAY_TOKEN CORE_MEMORY_TOKEN INSTANCE_SECRET SEARXNG_SECRET
NOVA_PUBLIC_GATE_TOKEN COMPOSE_PROFILES COMPOSE_FILE`. Both of the keys
`measurements.md` R7 flagged are now declared on commented-out lines —
`COMPOSE_FILE` as `host` and `INSTANCE_SECRET` as `drop`
(`deploy/.env.example:131-144`). So this passes on `slice/s41` and would have
refused on `rebuild/v4`.

On failure: add the declaration to `.env.example` with a disposition. Do not
delete the key from `.env` to make the check pass.

### P10. Disk, both ends

    df -Pk $DELL_DEPLOY; ssh <USER>@<MINI_IP> "df -h /"

Verifies: the 4x-of-payload headroom `bk_need_out_kb`
(`deploy/backup.sh:1541`) demands on the source, and room for a restore on the
destination.

Measured: Dell 904 GB free of 1007 GB; mini PC 341 GB free of 460 GB. The
payload is small — `nova_core` 15 MB, `nova_gateway` 9.3 MB, `nova_memory`
7.6 MB (`psql -c "select datname, pg_size_pretty(pg_database_size(datname))"`),
`v4_memdata` 1 MB and `v4_pgdata` 90 MB (`docker system df -v`),
`v4_workspace` 244 KB (`measurements.md` R3). Headroom is not the constraint
here.

On failure: free space before step 1. The backup refuses rather than writes a
short bundle, which is correct and is not something to work around at 2am.

### P11. SSH from the Dell to the mini PC works unattended

    ssh -o BatchMode=yes -o ConnectTimeout=10 <USER>@<MINI_IP> true && echo OK

Verifies: key-based, no prompt — which is what makes the transfer a single
command inside the downtime window.

Measured: it works today (every mini PC reading in this file came through it).

On failure: fix it before step 1. Fixing SSH while Nova is down is the kind of
thing that turns a 25-minute window into two hours.

### P12. The mini PC's stack really is disposable

    ssh <USER>@<MINI_IP> "docker exec nova-postgres-1 psql -U core -d nova_core -At -c 'select count(*) from people'"

Verifies: **0**. A zero here is the evidence that tearing it down destroys
nothing. Anything other than 0 means someone used it and this runbook's
Phase D step 26 would delete real data.

Measured today: `0`. Also measured: the mini PC's ollama holds exactly one
model, `nomic-embed-text:latest` (274 MB), pulled minutes before the reading.

On failure: **stop** and find out what is in it.

### P13. The mini PC has no `nova_v4_tailscale` volume

    ssh <USER>@<MINI_IP> "docker volume ls --format '{{.Name}}' | grep tailscale || echo NONE"

Verifies: `NONE`. If a tailnet state volume already existed there, a restore
into it would be a second identity in the same place.

Measured today: the mini PC's volumes are `nova_v4_memdata nova_v4_models
nova_v4_ollama nova_v4_pgdata nova_v4_workspace` plus three `jobhunter_*`. No
tailscale volume, and no `nova-tailscale-1` container — the "no tailnet
profile" claim in the brief, confirmed rather than assumed.

On failure: **stop.** Establish whose identity it is before deleting anything.

### P14. Nothing else on the mini PC shares the project name `nova`

    ssh <USER>@<MINI_IP> "docker ps -a --format '{{.Names}}\t{{.Label \"com.docker.compose.project\"}}' | sort -k2"

Verifies: the only `com.docker.compose.project=nova` objects are the dry-run
stack's. **Select by the label, never by the name** — on this very machine a
volume named `nova_pgdata` belonged to project `docker`
(`map-minipc-measured.md`, "a `nova_` name is not the `nova` project"), and a
name-prefix selection would have destroyed 75.8 MB of an unrelated project.

Measured today, after the 2026-09-21 cleanup: the `nova` project is exactly
the seven dry-run containers; `minecraft` (2, **running**, must stay running)
and `jobhunter` (6, exited) are the only other projects.

On failure: **stop.** Resolve the collision before any teardown.

---

## Phase A — prepare the destination. No downtime, fully reversible.

Nova keeps serving from the Dell throughout Phase A.

**1. Record the starting state of the hub, so "it still works" has a baseline.**

    docker exec nova-tailscale-1 tailscale status --json \
      | tr -d ' \n\t\r' | grep -o '"DNSName":"[^"]*"' | head -1
    docker exec nova-tailscale-1 tailscale serve status --json

Verifies: `Self.DNSName` is `nova.<TAILNET>.ts.net.` and the serve config maps
`"443":{"HTTPS":true}` with `Handlers["/"].Proxy` pointing at the `web`
container's fixed bridge address. Both were read today and match
(`read-tailnet-identity.md` §4).

On failure: the hub is already not in the state this runbook assumes. Stop and
find out why before moving anything.

**2. Put the S41 commit on the mini PC.**

    ssh <USER>@<MINI_IP> "cd $MINI_REPO && git fetch origin && git checkout <S41_COMMIT> && git log --oneline -1 && ls deploy/backup.sh deploy/passphrase.sh deploy/compose_read.sh deploy/backup/restore.sh"

Verifies: the commit is checked out AND all four paths exist. Listing the files
is the check — "git said OK" is not.

On failure: the checkout did not take (dirty tree, detached-head confusion).
Resolve on the mini PC. Nothing has changed on the Dell; there is nothing to
undo.

**3. Put the same commit in the Dell's *deployed* worktree (P5).**

    git -C $DELL_REPO fetch origin
    git -C $DELL_REPO merge --ff-only <S41_COMMIT>
    git -C $DELL_REPO log --oneline -1
    ls -la $DELL_DEPLOY/.env

Verifies: fast-forwarded, and `deploy/.env` still exists and is mode 600.

On failure: if `--ff-only` refuses, the deployed worktree has commits of its
own. **Do not** force. Stop and reconcile — a forced move here can silently
change the compose file the running stack was started from.

Note: this changes the *source* of the images the Dell would build, but nothing
is rebuilt until something runs `docker compose up --build`. Nova keeps running
on the containers it already has.

**4. Pre-build the destination's images, outside the downtime window.**

    ssh <USER>@<MINI_IP> "cd $MINI_DEPLOY && docker compose --project-directory $MINI_DEPLOY build 2>&1 | tail -20 && docker pull tailscale/tailscale:v1.102.3"

Verifies: four built images present and the sidecar image pulled —

    ssh <USER>@<MINI_IP> "docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'nova-(web|core|gateway|memory)|tailscale/tailscale'"

must list five lines.

**Why this is a step and not an optimisation:** `compose_up` is `docker compose
… up -d --build` (`deploy/install.sh:1706-1707`), so without this the build
runs *inside* the cutover window on an N150. Measured today the mini PC already
has `nova-web`, `nova-core`, `nova-memory`, `nova-gateway`, `searxng`,
`postgres:16` and `ollama/ollama:0.33.1` — but **not**
`tailscale/tailscale:v1.102.3`, and the four `nova-*` images were built from
`e5abd0b`, not from S41. Both gaps would otherwise be paid for in downtime.

On failure: a build error here is a build error you get to fix with Nova still
up. That is the entire point of doing it now. Do not proceed to Phase D with a
failing build.

**5. Confirm the subnet the install will land on is free there.**

    ssh <USER>@<MINI_IP> "ip -o -f inet addr show | awk '{print \$2, \$4}'"

Verifies: what is allocated. Measured today: `docker0` 172.17/16,
`br-…` 172.19/16 (jobhunter) and `br-…` 172.18/16 — **172.18 is currently
held by the dry-run stack's own `nova_default` network**, which Phase D step 26
removes. After teardown 172.18 is free and v4's pinned subnet fits.
`measurements.md` says explicitly this must be re-read on the day, not trusted
from a table.

On failure: `decide_subnet` (`deploy/subnet.sh`) picks another; note which, and
expect `NOVA_SUBNET*` in the mini PC's `.env` to differ from the Dell's. That
is correct — those keys are `host` disposition (`deploy/.env.example:69-74`)
and deliberately do not travel.

---

## Phase B — keep the 3090. Proven before it is needed. ~1 minute of inference outage.

The gateway already routes a non-builtin ollama row to its stored address:
`base_url_of` returns the live `OLLAMA_URL` only when the row is **both**
`adapter == "ollama"` **and** `builtin` — every other row, "including another
machine's engine", gets its stored `base_url`
(`services/gateway/app/providers.py:96-107`). So no gateway code is needed.
What *is* needed is reachability.

**6. Confirm the gap, from the destination.**

    ssh <USER>@<MINI_IP> "curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://<DELL_IP>:11434/api/version || echo 'rc='\$?"

Verifies: this **fails today**, and that is the expected reading. Measured:
`000`, `rc=7` (could not connect). Cause:
`deploy/docker-compose.yml:273` publishes ollama as
`"127.0.0.1:11434:11434"` — loopback only. The container itself listens on
`0.0.0.0:11434` (`docker inspect nova-ollama-1` env `OLLAMA_HOST=0.0.0.0:11434`),
so the restriction is entirely in the host publish.

On failure (i.e. it *succeeds*): something already exposes ollama. Find out
what, and whether it is exposed only to the tailnet or to the LAN as well,
before adding a second path.

**7. Expose the Dell's ollama on its tailnet interface only.**

Edit `deploy/docker-compose.yml:273` in the Dell's deployed worktree from
`"127.0.0.1:11434:11434"` to bind the Dell's **Windows** tailnet address:

    ports:
      - "<DELL_IP>:11434:11434"

then

    docker compose --project-directory $DELL_DEPLOY up -d ollama

Verifies (three readings, all required):

    docker inspect nova-ollama-1 --format '{{json .NetworkSettings.Ports}}'
    curl -s -m 5 http://<DELL_IP>:11434/api/version
    ssh <USER>@<MINI_IP> "curl -s -m 5 http://<DELL_IP>:11434/api/version"

The first must show `HostIp` as `<DELL_IP>`; the second proves the bind took on
this host; the third — the only one that matters — proves the mini PC can reach
it.

**Not measured, stated plainly:** this Dell runs Docker Desktop on Windows with
a WSL2 backend, and the tailnet address belongs to the *Windows* Tailscale
adapter (WSL sees it mirrored on `eth6`). Whether Docker Desktop will bind a
published port to that specific address has **not** been tested in this
session, because testing it means restarting a container on the live hub. The
third reading above is what decides it, and it decides it in one command.

On failure of the third reading, in order of preference:

- **B-alt-1.** Serve it through the Dell's own Windows tailnet node instead of
  publishing a port: on Windows, `tailscale serve --bg --https=443
  http://127.0.0.1:11434`, then verify from the mini PC with
  `curl -s https://<DELLWIN>.<TAILNET>.ts.net/api/version`. This keeps the
  loopback publish untouched, adds TLS, and is reachable only from the tailnet.
  Also **not measured here.**
- **B-alt-2.** Publish on `0.0.0.0:11434` and rely on the Windows firewall.
  This exposes the engine to the whole LAN. Take it only as a temporary
  measure, write down that you did, and close it when S42 lands the TLS and
  bearer it productises.

Roll back either alt by reverting the compose line and
`docker compose … up -d ollama`. One container, ~30 seconds, nothing else
touched.

**8. Add the provider row on the Dell's gateway — while both machines are up.**

    curl -s -X POST http://127.0.0.1:8001/admin/providers \
      -H "Authorization: Bearer $CORE_GATEWAY_TOKEN" \
      -H 'content-type: application/json' \
      -d '{"name":"dell","adapter":"ollama","base_url":"http://<DELL_IP>:11434","auth_shape":"none"}'

Verifies: HTTP 200 and a JSON body echoing the row. The gateway **verifies
before it saves**: `create_provider` calls `_verify_or_502`
(`services/gateway/app/admin.py:762`, `670-691`), and the ollama adapter's
`verify` does `GET /api/version` and turns any transport error into a 502 with
the provider's own reason (`services/gateway/app/adapters/ollama.py:341-356`).
A 200 here is therefore not a claim, it is a proof the endpoint answered.

Then list the models through the gateway, which is the second, independent
check:

    curl -s -H "Authorization: Bearer $CORE_GATEWAY_TOKEN" \
      http://127.0.0.1:8001/admin/providers/dell/models

Verifies: the Dell's seven models are listed by name.

Do this **now, not after the cutover**, for a mechanical reason: this row is in
`nova_gateway`, which travels in the bundle. Creating it here means it arrives
on the mini PC already created *and already verified*. Creating it after the
cutover means creating it at the moment the hub has no working model — and if
the Dell happens to be asleep then, `_verify_or_502` refuses and you cannot
create it at all.

Naming: `hub`, `library` and `ollama` are reserved
(`services/gateway/app/providers.py:38-41`); `dell` or any other slug is fine.

On failure with 502: the row was **not** written (that is what
`_verify_or_502` guarantees) — go back to step 7. On 409: a row by that name
exists; `GET /admin/providers` and reconcile.

**9. Decide what `chat.model` will be after the move, and write it down now.**

    docker exec nova-postgres-1 psql -U core -d nova_core -At \
      -c "select key, value from settings where key like 'chat.%'"

Measured today: `chat.model = "hub:qwen3.8:27b"` and
`chat.vision_model = "qwen3.8:27b"`. The `hub:` prefix is the **builtin**
provider, which always resolves to the live `OLLAMA_URL`
(`providers.py:96-107`) — on the mini PC that is the mini PC's own CPU ollama,
which holds one 274 MB embedding model and no chat model at all.

So after the cutover `chat.model` must become `dell:qwen3.8:27b`. Do not change
it yet — the Dell's own turns would then take a network hop for no reason. Just
record the exact string you will set, and its rollback value.

On failure to read this: stop. A hub whose configured model does not exist
answers every turn with an error, and finding that out during the window is
avoidable.

---

## Phase C — the drill. One short writer pause on the Dell; no cutover.

This is the pre-flight rehearsal. It runs the **same code** over the **same
data** onto the **destination machine**, and it is what converts §7's downtime
estimate into a measurement.

**10. Write a routine bundle on the Dell — not a move.**

    time $DELL_REPO/install backup --transport tailnet

Verifies: exit 0, and the run's own report naming the bundle path, its
sha256, and per-database table counts. Note that `--transport` is recorded in
the manifest only (`deploy/backup.sh:2132`); it moves no bytes.

**Time this step.** `bk_stop_writers` stops `core`, `gateway` and `memory` for
the dump and — in routine mode, unlike `--move` — the cleanup restarts them
(`deploy/backup.sh:1676`). The elapsed time of this command is, within a
minute or two, the first half of the cutover window.

On failure: read the refusal; every one of them is a sentence naming what it
found. Nothing is parked (routine mode writes no marker) and the writers are
back up. Fix and re-run. **Do not proceed to Phase D until this exits 0.**

**11. Confirm the bundle is on disk and intact.**

    ls -l $(grep -E '^NOVA_BACKUP_DIR=' $DELL_DEPLOY/.env | cut -d= -f2- || echo $DELL_DEPLOY/backups)
    sha256sum <the bundle>

Verifies: the file exists, is mode 0600, and its digest equals the one the run
printed.

Note: `NOVA_BACKUP_DIR` is unset in the live `.env` today, so the default
`$DELL_DEPLOY/backups` applies (`deploy/backup.sh:966-972`); that directory
does not exist yet and the run creates it (`bk_mode_probe`,
`deploy/backup.sh:1564+`).

On failure: a digest mismatch means the bundle is not the bundle. Re-run
step 10.

**12. Copy the bundle to the mini PC and re-verify it there.**

    scp <bundle> <USER>@<MINI_IP>:$MINI_DEPLOY/backups/
    ssh <USER>@<MINI_IP> "sha256sum $MINI_DEPLOY/backups/<bundle base>"

Verifies: **the digest, read on the destination**, equals the source digest.
"scp exited 0" is transport accepting bytes, not the destination holding them.

On failure: re-copy. If it fails twice, stop — something is wrong with the
link, and the cutover depends on this same link.

**13. Run the drill on the mini PC, with its dry-run stack still up.**

    ssh <USER>@<MINI_IP> "cd $MINI_REPO && time ./install restore $MINI_DEPLOY/backups/<bundle base> --drill"

Verifies: exit 0 and a final report of the shape
`drill <id>: N tables compared across 3 databases, M volume listings diffed,
signature key fingerprint equal` (`deploy/backup.sh`, the step-16 report).

The drill touches nothing live — it says so itself on the first line ("nothing
below touches a live volume, a live database, a live container or
deploy/.env"), it creates its own throwaway volumes, network and postgres
container, and it skips the empty-target refusal entirely (`drill -eq 1`
branches at `deploy/backup.sh:4066`, `4340`).

**Time this step too.** It is the second half of the cutover window, minus the
`./install` that follows.

On failure: **stop the whole move.** A failed drill is the drill working. Read
which check failed — every one names the database, table or volume it
compared — fix it, take a fresh bundle, and drill again. Do not proceed on a
drill that "mostly passed".

**14. Confirm the drill cleaned up after itself.**

    ssh <USER>@<MINI_IP> "docker ps -a --format '{{.Names}}' | grep drill || echo CLEAN; docker volume ls --format '{{.Name}}' | grep drill || echo CLEAN"

Verifies: `CLEAN` twice. The drill's own teardown failure is itself reported as
a failed drill ("A drill whose teardown cannot be verified is a FAILED drill:
the leftovers are named on their own lines"), so this is a second, independent
reading of the same property.

On failure: remove the named leftovers by hand and re-run step 13 until it is
clean. A leftover `nova-drill-*` volume is small; a leftover one that the next
run collides with is not.

**15. Record the measured window.**

Add the two timings from steps 10 and 13 together, plus two minutes for the
copy and four to six for `./install` on the mini PC. That number — not §7's
estimate — is what you tell the owner, and it is what decides whether the
cutover happens now or at a better hour.

If the sum exceeds roughly 45 minutes, stop and find out why before spending
it. The payload is ~32 MB of database and ~1.3 MB of volumes; a long run means
something other than data size is slow, and you want to know what.

---

## Phase D — the cutover. This is the downtime window.

Everything above was rehearsal. From here the Dell stops serving.

Tell the owner the window has started. He is about to lose the URL.

**16. Last-second re-check that the Dell is the live hub and the mini PC is not.**

    docker exec nova-tailscale-1 tailscale status | grep -E 'nova|<MINI>'
    ssh <USER>@<MINI_IP> "docker volume ls --format '{{.Name}}' | grep tailscale || echo NONE"

Verifies: `nova` is online from the Dell's sidecar, and the mini PC still has
no tailscale volume (P13 re-read at the last possible moment).

On failure: **abort.** Nothing has been done yet; there is nothing to undo.

**17. Tear down the mini PC's dry-run stack.**

Restore refuses a non-empty target *by design* — `bk_volume_state`
(`deploy/backup.sh:3656-3663`) reports a volume that exists and is not empty,
and a separate reading lists any container labelled with the project,
**exited ones included** (`deploy/backup.sh:4368-4372`). Its refusal text says
in full: *"A bad restore CANNOT be rolled back in place, which is why this
refuses instead of merging."*

    ssh <USER>@<MINI_IP> "docker compose --project-directory $MINI_DEPLOY down"
    ssh <USER>@<MINI_IP> "docker volume rm nova_v4_pgdata nova_v4_memdata nova_v4_workspace"

Verifies:

    ssh <USER>@<MINI_IP> "docker ps -a --filter label=com.docker.compose.project=nova --format '{{.Names}}' | wc -l; docker volume ls --format '{{.Name}}' | grep '^nova_v4_'"

must print `0` and then list **only** `nova_v4_models` and `nova_v4_ollama`.

**Why only those three volumes.** The empty-target check examines volumes whose
disposition is `include`, `move-only` or `dump-pg` and skips the rest
(`deploy/backup.sh:4355-4358`). From `deploy/docker-compose.yml`'s `volumes:`
block: `v4_pgdata` is `dump-pg`, `v4_memdata` and `v4_workspace` are `include`,
`v4_tailscale` is `move-only` (absent here), and `v4_models` / `v4_ollama` are
`exclude-redownload` — not checked, and worth keeping: `nova_v4_ollama` holds
the pulled `nomic-embed-text` the memory service embeds with. A blanket
`down -v` would delete it and the restore would not notice, but the first
memory write would.

**This step is irreversible** and it is the first one that is. It destroys the
dry-run stack's data. P12 measured `people = 0` there, which is the evidence
that this costs nothing; if P12 was not re-checked today, re-check it now.

On failure: if `docker volume rm` says a volume is in use, a container still
references it — `docker ps -a --filter volume=<name>` names which. Remove it.
Do **not** proceed with a partial teardown; the restore would refuse anyway,
and it would refuse after you have already parked the Dell.

**18. Write the move bundle on the Dell. The window opens here.**

    time $DELL_REPO/install backup --move --transport tailnet

What `--move` changes (`design-verdict.md` §9.5): `v4_tailscale`'s disposition
becomes `include` so the node identity travels, `tailscale` joins the writer
set, the stack is left **stopped**, and the two markers are written.

Verifies, in the run's own output, all four:
- the bundle path and its sha256;
- `parked: every service of this project reads .State.Running false` —
  `bk_park` re-reads `.State.Running` per service and refuses if any is not
  `false` (`deploy/backup.sh:2189-2202`);
- `parked: the stack is stopped and …/MOVED_TO and …/.moved are in place` —
  both markers are written **and read back** byte-for-byte
  (`deploy/backup.sh:2219-2226`);
- exit 0.

**On failure — read carefully, this is §7's riskiest step.** `bk_park`'s
failure messages are deliberately specific: *"the bundle IS written at
&lt;path&gt;. Separately: … this host is NOT parked."* Two different states hide
behind a non-zero exit:

- *Bundle written, park failed.* The bundle is good. The Dell is stopped or
  partly stopped and both markers may be missing. Bring the Dell back with
  `docker compose --project-directory $DELL_DEPLOY --profile '*' up -d`,
  confirm `tailscale status` shows `nova` online again, and start over. Nothing
  reached the mini PC.
- *Failure before the park, anywhere after the writers stopped.* Per P3 the
  writers are **not** restarted in move mode and no marker is written. The Dell
  is stopped, off the tailnet, silent. Recover with the same
  `docker compose … --profile '*' up -d`, then `tailscale status` to prove the
  node is back. If P3 was fixed before this run, the run says which of the two
  states it left instead of leaving you to work it out.

Either way, **do not continue to step 19 on a non-zero exit.**

**19. Copy the bundle and verify the digest on the destination.**

    scp <bundle> <USER>@<MINI_IP>:$MINI_DEPLOY/backups/
    ssh <USER>@<MINI_IP> "sha256sum $MINI_DEPLOY/backups/<bundle base>"

Verifies: the digest read on the mini PC equals the one step 18 printed.

On failure: re-copy. The Dell is parked but its data is untouched — the bundle
is a copy, not a move of the bytes — so this is recoverable, just slow.

**20. Restore on the mini PC.**

    ssh <USER>@<MINI_IP> "cd $MINI_REPO && time ./install restore $MINI_DEPLOY/backups/<bundle base>"

Verifies, in the run's own output:
- `target: every declared volume this restore fills is absent or empty, and no
  container of the project 'nova' is here` — step 17 proved by the code that
  will act on it;
- per-database `N tables compared, every count and digest equal`;
- `signing key fingerprint equal` — the key every paired device pins;
- the final `restored: …` line, which the code prints *only* with the three
  facts behind it;
- `next: ./install`.

The verb ends with `postgres` stopped and `deploy/.restored` written
(`deploy/backup.sh`, step 15 of the restore). That is correct: it does not
start the stack.

On failure: the refusal names the check. A digest or count mismatch means the
bundle and the target disagree and you must not start anything on top of it —
go to §6 Phase D rollback. A refusal on the empty-target check means step 17
was incomplete; finish it and re-run, which is safe because nothing was
written.

**21. Bring Nova up on the mini PC, on the tailnet.**

    ssh <USER>@<MINI_IP> "cd $MINI_REPO && NOVA_TAILNET=1 ./install"

Verifies: `./install` prints `tailnet: no auth key needed — <reason>`. That
line is the proof the carried identity took: `tailscale_state_present`
(`deploy/install.sh:1138-1177`) runs the sidecar's own image read-only against
the restored volume and looks for `tailscaled.state` **before** it would ever
prompt for a key (`decide_tailnet`, `deploy/install.sh:1260-1270`). If it
instead asks for `TS_AUTHKEY`, the identity did **not** arrive.

`NOVA_TAILNET=1` is required because `COMPOSE_PROFILES` is `host` disposition
(`deploy/.env.example:112-113`) and does not travel; the mini PC's own value is
`inference`, measured today.

On failure — it asks for an auth key: **stop and do not give it one.** A fresh
key plus the carried `TAILNET_HOSTNAME` (which *is* `carry`,
`deploy/.env.example:100-101`) while the Dell's node still exists produces a
second, differently-named peer, and every phone's home-screen icon then points
at a URL that serves nothing (`read-tailnet-identity.md` §2b, §5). Go to §6.

**22. Prove the tailnet cutover took — from outside the mini PC.**

    ssh <USER>@<MINI_IP> "docker exec nova-tailscale-1 /config/serve_check.sh"

Verifies: one line, `serving https://nova.<TAILNET>.ts.net/ -> http://…:80`.
This is the same script compose uses as the sidecar's healthcheck
(`deploy/docker-compose.yml:361-368`), and it refuses to report up unless it
reads the mapping back out of `tailscale serve status --json`
(`deploy/tailscale/serve_check.sh:107-124`). `start.sh` is the single writer of
that mapping and rebuilds it on every start (`deploy/tailscale/start.sh:21-22`),
so nothing had to be carried for this to work.

Then, from a **third** machine on the tailnet — not the Dell, not the mini PC:

    curl -s -o /dev/null -w '%{http_code}\n' https://nova.<TAILNET>.ts.net/

Verifies: a real HTTP status over the real URL. The sidecar reporting healthy
is the mini PC's opinion of itself; this is the owner's path.

On failure: `./install` already dumps the last 20 log lines of any unhealthy
service (`deploy/install.sh`, the unhealthy branch in `cmd_install`) — read
them. A `BackendState` that is not `Running` means the node did not come up; a
missing serve mapping means `start.sh` could not reach `web`.

**23. Prove it is the *same* Nova, not a fresh one.**

    ssh <USER>@<MINI_IP> "docker exec nova-postgres-1 psql -U core -d nova_core -At -c 'select count(*) from people; select count(*) from turns; select count(*) from messages'"

Verifies: counts that match the Dell's, not zeros. The restore already compared
every table count and digest, but this is the reading a human can hold:
`people = 1` where the dry-run stack had `people = 0` (P12).

Then have the owner **open the app on his phone** and confirm he is still
logged in. He should be: same origin, same certificate, same cookie scope,
and the `sessions` row came with the database.

On failure — he is logged out: the session row did not survive, or the origin
changed. Check step 22's DNS name character by character against step 1's.

**The window closes here.** Tell him.

---

## Phase E — the GPU, after the move.

**24. Point chat at the Dell's engine.**

    ssh <USER>@<MINI_IP> "docker exec nova-postgres-1 psql -U core -d nova_core -c \"update settings set value = '\\\"dell:qwen3.8:27b\\\"' where key = 'chat.model'\""

Verifies: read it back, and then verify it *through the product*, not through
the database:

    ssh <USER>@<MINI_IP> "curl -s -H \"Authorization: Bearer \$CORE_GATEWAY_TOKEN\" http://127.0.0.1:8001/admin/providers/dell/models"

must list the Dell's models, over the tailnet, from the mini PC.

On failure: the row travelled but the address does not resolve from here. Go
back to Phase B step 7's third reading.

**25. Have Nova answer one real turn, in the app.**

Not a curl. The owner opens the chat and asks her something. Then read the
trace:

    ssh <USER>@<MINI_IP> "docker exec nova-postgres-1 psql -U core -d nova_core -At -c \"select tool, status, started_at from turn_spans where turn_id = '<the turn id>' order by started_at\""

Verifies: the turn ran, and against which provider. A reply is a claim; the
trace is the fact.

On failure: the turn errors or hangs. Most likely the Dell is asleep — see
step 26.

**26. When the Dell is asleep.**

There is no wake-on-LAN until S46. Stated consequence, not a defect: with the
Dell asleep the hub has **no GPU and no usable local model**. The mini PC's own
ollama runs on an N150 CPU and holds only `nomic-embed-text`.

What the owner can do, in order:

- **Wake the Dell** by hand and retry. The provider row needs no change; the
  address is the same when it comes back.
- **Fail over to a cloud provider.** The gateway already carries verified rows
  for Anthropic, Cerebras and OpenRouter (`GET /admin/providers`, read today).
  Switching is one `settings` write, the same shape as step 24, to
  e.g. `anthropic:<model id>`.
- **Accept CPU inference** by pulling a small model onto the mini PC and
  pointing `chat.model` at `hub:<that model>`. Slow, and it costs the
  `nova_v4_ollama` disk you deliberately kept in step 17.

What must **not** happen: adding the provider row while the Dell is asleep.
`_verify_or_502` (`services/gateway/app/admin.py:670-691`) refuses to save a
row it cannot reach. That is why step 8 creates it in Phase B, on the Dell,
while both machines are awake.

Memory embeddings are unaffected: they use `nomic-embed-text`, which the mini
PC holds locally (274 MB) and which step 17 deliberately preserved.

---

## 6. Rollback, phase by phase

| Phase | What undoes it | Reversible? |
|---|---|---|
| A (steps 1-5) | `git checkout` the previous commit on either machine; delete the pre-built images if you want the disk back | Fully. Nova never stopped. |
| B (steps 6-9) | Revert the compose port line and `docker compose … up -d ollama`; `DELETE /admin/providers/dell` | Fully. ~30s of inference outage. |
| C (steps 10-15) | Delete the bundle from both machines; the drill cleans itself up (step 14 proves it) | Fully. One writer pause on the Dell, already over. |
| D step 17 (teardown) | **Nothing.** The dry-run data is gone. | **Irreversible** — and worth nothing, per P12's `people = 0`. |
| D step 18 (`--move`) | `./install undo-move` on the Dell, then `./install` — P2 says this does not exist yet; without it, delete `deploy/.moved` and `deploy/tailscale/MOVED_TO` by hand and run `./install` | Reversible. **The Dell's volumes are not deleted by `--move`** — it stops the stack and writes markers; the data is still there. |
| D steps 19-22 | Tear the mini PC down again (`docker compose … down`, `docker volume rm` the three), then undo-move the Dell | Reversible, while nothing has been written on the mini PC. |
| E | `update settings` back to the recorded value from step 9 | Fully. |

### The point of no return

It is **not** a command. It is the **first write on the mini PC after the
cutover** — the owner's first chat turn, or the first session row, at step 23
or 25.

Before that moment, rolling back to the Dell costs only time: the Dell's
databases and volumes are exactly as `--move` left them, and un-parking plus
`./install` returns the same Nova. After that moment, the two machines have
diverged, and going back to the Dell **silently discards** every turn, note and
setting written on the mini PC. Nothing in the code notices this; there is no
merge. If a rollback is being considered after real use, the honest path is to
take a fresh `backup` on the mini PC first and restore *that* onto the Dell —
which means tearing the Dell's stack down to make it an empty target, and is a
second cutover, not a rollback.

The second, smaller irreversible point is **step 17**, which destroys the mini
PC's dry-run data. It is safe only because P12 measured that data as empty.
Re-check P12 the day of, not the week before.

---

## 7. Downtime, and what the owner sees

**Expected total: 25-40 minutes**, of which **20-35 minutes** is
`https://nova.<TAILNET>.ts.net` answering from nowhere.

The window opens when `--move` stops the writers (step 18, early in that
command — `bk_stop_writers` runs for the database dump, well before
`bk_park`) and closes when `serve_check.sh` passes on the mini PC (step 22).

Breakdown, and where each number comes from:

| Segment | Estimate | Basis |
|---|---|---|
| step 18, `backup --move` | 4-10 min | payload is ~32 MB of database (`pg_size_pretty` per db) plus 1.3 MB of volumes (`docker system df -v`, `measurements.md` R3); the cost is the dump, the pack, the encrypt, the re-verify and the self-test restore into a scratch database, not the bytes |
| step 19, copy | <1 min | bundle well under 100 MB, over the tailnet |
| step 20, `restore` | 4-10 min | same passes in reverse, plus a full second copy of every database compared table by table |
| step 21, `./install` | 4-8 min | images pre-built and the sidecar image pre-pulled in Phase A step 4; what remains is startup, migrations and the health wait, whose own timeout is 240s (`deploy/install.sh:1727`) |
| steps 22-23, verification | 2-5 min | including the owner opening his phone |
| slack | 10 min | one retry of any single step without blowing the estimate |

**These are estimates from data sizes, not measurements.** Phase C step 15
replaces them with real numbers before you spend them. That is Phase C's main
purpose.

**On his phone, during the window:** he taps the Nova icon and the browser
fails to connect. Not a login page, not an error from Nova — a connection
failure, because MagicDNS still resolves `nova.<TAILNET>.ts.net` while no node
is answering for it. The app is a plain install of the web origin; there is no
service worker to serve a cached shell (`apps/web` ships none — searched
`apps/web/src` and `apps/web/public`, only `public/manifest.webmanifest`
exists), so there is no offline screen and nothing stale to clear afterwards.

**After the window:** he taps the same icon, the same URL loads, and he is
still logged in — same origin, same certificate, same cookie scope, and his
`sessions` row travelled in the database. He does **not** delete and re-add the
app, and he does **not** log in again. If either of those turns out to be
necessary, the identity did not carry and you are in §6, not in a minor
annoyance.

---

## 8. What this runbook could not verify

Stated, because a runbook that hides its own gaps is worse than one that
refuses.

1. **Three prerequisites are false today** (P1, P2, P3) and every one of them
   is a blocker: the `./install` verb dispatch, `cmd_undo_move`, and the
   `--move` failure restart. P4 was false when this file was started and true
   by the time it was finished (`89e75231`), which is the argument for running
   the P-checks on the day rather than trusting this list. This runbook is
   written against the design and the tests; it cannot be executed until the
   remaining three land.
2. **Phase B step 7 is unmeasured.** Whether Docker Desktop on this Windows
   host will bind a published port to the Windows Tailscale adapter's address
   was not tested, because testing it means restarting a container on the live
   hub. Step 7's third reading decides it in one command, and B-alt-1 and
   B-alt-2 are the fallbacks — both also unmeasured.
3. **Node key expiry during a long park.** Measured today, the node key expires
   2027-01-10 (`docker exec nova-tailscale-1 tailscale status --json`,
   `KeyExpiry`). Comfortably past a short cutover. If the Dell is parked for
   months before the mini PC is stood up, the key can lapse while offline and
   the bit-identical guarantee this whole plan rests on is gone. Whether key
   expiry is disabled for this node needs the admin console.
4. **Tailscale's rename behaviour** when a *different* node key requests the
   name `nova` while the old one is online is stated from general behaviour,
   not measured here — no second node was created to test it
   (`read-tailnet-identity.md` §2b, §8).
5. **Two of the three documents this task was told to read first do not
   exist**: `docs/plans/rebuild/s45/read-live-stack.md` and
   `docs/plans/rebuild/s45/read-gpu-path.md` were absent from that directory
   throughout. The live-stack and GPU-path facts above were therefore measured
   directly, by the commands cited beside each claim, rather than inherited.
