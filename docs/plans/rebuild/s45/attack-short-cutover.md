# Attack: `runbook-short-cutover.md`

**Verdict: UNSAFE.** Not because the shape is wrong — the phase ordering is
sound and the drill-first stance is right — but because the step the whole
plan leans on when anything goes wrong, *rolling back to the Dell*, does not
work as written, in two independent ways; and because the plan cannot reach
its own step 20 at all, for want of a passphrase no step transfers. Every
finding below has a small fix. With F1–F4 applied this becomes
SAFE-WITH-FIXES.

**Placeholders.** This repo is public. `<TAILNET>`, `<MINI>`, `<MINI_IP>`,
`<DELLWIN>`, `<DELL_IP>`, `<USER>`, `$DELL_REPO`, `$DELL_DEPLOY`,
`$MINI_REPO`, `$MINI_DEPLOY` are the same placeholders the runbook defines.
No real host string, address or key appears here.

## How this was checked

Every factual claim below carries its source: a `path:line` in this worktree
(`slice/s41`, at and after `e4400a4d`), or the exact read-only command that
produced it. Nothing was started, stopped, removed, written or deployed on
either machine. The machine readings are `docker ps/inspect/volume ls/network
inspect`, `psql -c SELECT`, `git log/status`, `grep` of key NAMES out of
`.env` (never a value), `ip -o addr`, and `docker compose config` — which
talks to no daemon.

I re-read the runbook's own prerequisites rather than trusting them. **P1 has
landed since the runbook was written**: `deploy/install.sh:1833` is now
`backup|restore|drill)`, sourcing `backup.sh` and dispatching `cmd_$cmd`
(commit `705620ee`, "fix(s41): ./install actually dispatches backup, restore
and drill"). P2 is still false but is now a *stated* cannot rather than
"unknown subcommand" — `deploy/install.sh:1846-1851` dies with "undo-move is
not built yet". **P3 is still false**: `deploy/backup.sh:1676` still reads
`if [ -n "$BK_RUN_STOPPED" ] && [ "$BK_RUN_MODE" != "move" ]; then`. P4, P5,
P9, P10, P12, P13, P14 re-measured true. This is the second document in this
directory to find a P-check flipping mid-writing, which is the argument for
running them on the day.

---

# Findings, by severity

## F1 — CRITICAL. Step 3 destroys the rollback target before the window opens.

**Severity: critical.** It converts "the exact stack that was serving an hour
ago" into "141 commits of never-run code plus two unrun schema migrations",
and the runbook then prescribes the command that detonates it as the rollback.

**The sequence.**

1. Step 3: `git -C $DELL_REPO merge --ff-only <S41_COMMIT>`. Measured: the
   live stack's compose files resolve to a worktree at `rebuild/v4`,
   `0996a31f` (`docker inspect nova-core-1 --format '{{index .Config.Labels
   "com.docker.compose.project.config_files"}}'`, then `git log --oneline -1`
   in that worktree). `git diff --stat 0996a31f..HEAD -- deploy/ apps/
   services/` is 316 files, +43251/-1377.
2. The runbook's own note says "nothing is rebuilt until something runs
   `docker compose up --build`", and is right.
3. Step 18 fails, or step 20 fails, or the owner aborts at any point in
   Phase D. §6's rollback row for step 18 says: delete the two markers by
   hand, "then `./install`".
4. `./install` is `cmd_install` → `compose_up` →
   `deploy/install.sh:1707`: `docker compose "${COMPOSE_ARGS[@]}" up -d
   **--build**`. All four `nova-*` images are rebuilt from S41 source.
5. `core`, `gateway` and `memory` run their migrations at startup and
   **refuse to start if they fail** (`services/gateway/app/main.py:33-39`,
   same shape in `services/memory/app/main.py:34-38`). Two migrations exist
   at HEAD that do not exist at `0996a31f`:
   `git diff --name-status 0996a31f..HEAD -- services/*/migrations/` →
   `A services/core/migrations/035_hub_engine.sql`,
   `A services/gateway/migrations/009_engines.sql`.

**What the owner observes.** In the good case, a rollback that was supposed to
take four minutes takes as long as a full rebuild on the Dell, and then comes
up on code nobody has ever run in production. In the bad case, a build error
or a migration failure at 2am on the machine that was the whole safety net,
with the mini PC already torn down (step 17) and the bundle unrestored. He has
no hub at all.

**And it is quietly one-way even when it succeeds.** Those two migrations run
against the Dell's live databases. The bundle written at step 18 was sealed
*before* they ran. After a rollback-by-`./install`, the Dell's schema is ahead
of its own bundle, and a later "just restore the bundle onto the Dell" is no
longer the same operation.

**Smallest fix.** Two sentences and one command:

- Change §6's step-18 and step-19-22 rollback cells from "`./install`" to
  "`docker compose --project-directory $DELL_DEPLOY --profile '*' up -d`
  (**no `--build`** — the images that were serving are still on disk; a
  rebuild here runs 141 commits of unrun code and two new migrations against
  the fallback)".
- Add to step 3: "record the four image ids first —
  `docker compose --project-directory $DELL_DEPLOY images`. Those are the
  rollback." Better still: skip step 3 entirely and run the verbs out of a
  *second* S41 checkout with `BK_ENV_FILE` pointed at the deployed `.env`,
  leaving the deployed worktree untouched. `bk_env_file` is already
  overridable (`deploy/backup.sh:48`) — but note that `BK_DIR` also fixes
  where the markers land (`deploy/backup.sh:973-974`), so if you take that
  route, state which `deploy/tailscale/MOVED_TO` the *running* sidecar
  actually reads. The compose bind is `source: ./tailscale` relative to the
  compose file (`deploy/docker-compose.yml:346-347`), i.e. the **deployed**
  worktree's — so a marker written into a second checkout does not park
  anything.

---

## F2 — CRITICAL. The passphrase never reaches the mini PC. The restore cannot run.

**Severity: critical** for completeness (the plan stops dead), **medium** for
danger (it stops safely — but at step 20 the plan improvises inside the
window).

**The sequence.**

1. P8 measures that the Dell has no `NOVA_PASSPHRASE_*` key and no
   `deploy/.backup-passphrase`, so step 10's backup **generates** one
   (`deploy/passphrase.sh:84-92`, the absent-file branch, exit 3 — "the ONE
   case that permits a create").
2. Re-measured on both machines today. Dell:
   `ls -a $DELL_DEPLOY | grep -E 'backup|passphrase'` → nothing. Mini PC:
   `ssh <MINI_IP> "ls -a $MINI_DEPLOY | grep -E 'backup|passphrase'"` →
   nothing. Mini PC `.env` key names (read by name only): no
   `NOVA_PASSPHRASE_SOURCE`, `_FILE` or `_CMD`.
3. Step 13 runs `ssh <MINI_IP> "... ./install restore <bundle> --drill"` —
   **no `--passphrase-file`**. Same at step 20.
4. `bk_restore_run` resolves a passphrase (`deploy/backup.sh:4177-4195`). The
   default resolver is `file` (`deploy/passphrase.sh:37`), the file is
   `$NP_DIR/.backup-passphrase` (`deploy/passphrase.sh:72-79`), it is absent,
   so exit 3 → "there is no passphrase here, and a restore never generates
   one".
5. The `prompt` resolver cannot save it either: `deploy/passphrase.sh:148-151`
   is a stated cannot without a terminal, and every mini-PC command in the
   runbook is `ssh <MINI_IP> "…"` with **no `-t`**, so there is no TTY.

**What the owner observes.** Phase C stops at step 13 with a clean refusal —
which is the system working. But there is no step in the runbook that would
have prevented it, and nothing tells him what to do next. The dangerous
version is the improvisation: `scp`ing a plaintext passphrase file to a second
machine in a hurry, or pasting it into a `NOVA_PASSPHRASE_CMD`, at the one
moment nobody is thinking about where secrets land.

**Smallest fix.** A Phase A step, before step 4, with three parts: (a) decide
the source deliberately (P8 already says to); (b) after step 10 writes the
first bundle, `install -m 600` the passphrase onto the mini PC at
`$MINI_DEPLOY/.backup-passphrase` — the `file` resolver mode-checks 0600 and
refuses anything looser (`deploy/passphrase.sh:95-101`); (c) record it off
both machines, as P8 already requires. Then add `--passphrase-file` to steps
13 and 20 if you chose a non-default path.

---

## F3 — HIGH. The drill does not drill the move. The one carry everything rests on is never rehearsed.

**Severity: high.** Phase C is sold as "the same code over the same data onto
the destination", and the runbook's stance paragraph rests the entire
short-window argument on it. For the tailnet identity, it is not true — and
the repo's own README prescribes the rehearsal the runbook omits.

**The sequence.**

1. Step 10 writes a **routine** bundle (`./install backup --transport
   tailnet`, no `--move`).
2. `v4_tailscale` is `move-only` (`deploy/docker-compose.yml:453-457`). Four
   independent places skip a `move-only` volume unless `mode = move`:
   `deploy/backup.sh:830`, `:847`, `:881`, `:1147` — all
   `move-only) [ "$mode" = "move" ] || continue ;;`. The comment at
   `deploy/backup.sh:1127-1128` says it plainly: "in routine mode a move-only
   volume is not read at all".
3. So the drill bundle contains no node identity. Step 13's drill compares
   databases and the volumes that *are* in it, and reports
   "N tables compared … M volume listings diffed" — with M short by one, and
   nothing saying so.
4. There is no `backup --move --drill`: `--drill` is parsed only by
   `bk_restore_run` (`deploy/backup.sh:4023`), and `backup`'s parser knows
   only `--move`, `--transport`, `--out` (`deploy/backup.sh:2368-2379`).
   `backup --move` also refuses to run on an already-parked host
   (`deploy/backup.sh:2418`). The identity carry is therefore **unrehearsable
   before the window** with today's code.
5. Step 20 restores it for real, un-rehearsed, with the Dell parked and the
   mini PC's dry-run stack already destroyed.

**What the owner observes.** If anything about the `v4_tailscale` carry is
wrong, he finds out at step 20 or 21, with both hubs down and no drill result
to compare against.

**Smallest fix.** It is already written down, in this repo, at
`deploy/README.md:426-428`:

```sh
./install restore <bundle> --drill   # rehearse
./install restore <bundle>           # then do it
./install                            # bring it up
```

Insert `restore --drill` of **the move bundle** between steps 19 and 20. It
touches nothing live (`deploy/backup.sh:4066`, `:4340` — the drill skips the
empty-target refusal and builds its own throwaway volumes, network and
postgres), it is the only rehearsal of the identity carry that exists, and
step 13 has already measured what it costs. Then say in Phase C, in those
words, that the drill does **not** cover `v4_tailscale` and why.

---

## F4 — HIGH. Step 18's stated recovery does not recover, on one of the two failure branches it names.

**Severity: high.** It is a rollback that does not work, at exactly the moment
the runbook calls its riskiest.

**The sequence.**

1. Step 18, `backup --move`. `bk_park` writes the two markers in a loop:
   `for path in "$marker" "$moved"` (`deploy/backup.sh:2209`), where
   `$marker` is `deploy/tailscale/MOVED_TO` and `$moved` is `deploy/.moved`
   (`deploy/backup.sh:973-974`). **MOVED_TO is written first.**
2. The second write fails, or its read-back does not match — disk full,
   a permissions change, an interrupted run. `bk_park` returns 1
   (`deploy/backup.sh:2215-2226`). Exit is non-zero.
3. The runbook's step-18 failure text says, for the "bundle written, park
   failed" branch: "both markers **may be missing**. Bring the Dell back with
   `docker compose --project-directory $DELL_DEPLOY --profile '*' up -d`,
   confirm `tailscale status` shows `nova` online again."
4. `MOVED_TO` is **not** missing. `deploy/tailscale/start.sh:86-102` is the
   guard that landed as P4: `if [ -e "$MOVED_TO" ]; then … exit 1`. The
   sidecar refuses. `restart: unless-stopped`
   (`deploy/docker-compose.yml:301`) retries it forever.
5. The verification the runbook then prescribes is
   `docker exec nova-tailscale-1 tailscale status` — which cannot run,
   because the container is not running.

**What the owner observes.** Everything comes up except the tailnet. The URL
stays dead. The one command he was told to check with errors out with "is not
running" rather than answering the question. The guard that is doing exactly
its job reads as a second, unrelated fault.

**Smallest fix.** One sentence, before the recovery command in step 18's
failure branch: "**First read whether a marker was written**
(`ls -la $DELL_DEPLOY/tailscale/MOVED_TO $DELL_DEPLOY/.moved`). If either
exists, delete both before bringing the Dell back — the sidecar refuses to
start while `MOVED_TO` is present (`deploy/tailscale/start.sh:86`), and
`./install` refuses while `.moved` is (`deploy/install.sh:371-385`)." The
same sentence belongs in §6's step-18 rollback cell, which today says only
"delete `deploy/.moved` and `deploy/tailscale/MOVED_TO` by hand" for the
success case.

---

## F5 — HIGH. Nothing refuses an auth key on a just-restored host, and the tool's own advice is the lockout path.

**Severity: high.** This is the tailnet-lockout sequence the task asked for,
constructed. The runbook does not prevent it; it asks.

**The sequence that locks him out.**

1. Step 21, `NOVA_TAILNET=1 ./install` on the mini PC. Something about the
   identity is wrong — a partial restore (see F6), a `tailscaled.state` that
   exists but holds no logged-in node (see F7), or docker unreadable.
2. `tailscale_state_present` returns 1 or 2. With no TTY (the runbook's own
   `ssh <MINI_IP> "…"`, no `-t`), `decide_tailnet` skips the prompt and calls
   `refuse_tailnet` (`deploy/install.sh:1286`).
3. `refuse_tailnet` prints, at `deploy/install.sh:1207-1212`: *"1. Mint an
   auth key at … put it in `$ENV_FILE` as `TS_AUTHKEY=tskey-auth-…` and
   re-run: `NOVA_TAILNET=1 ./install`"*. That is the first and most prominent
   of the three ways forward it offers.
4. The owner follows the screen, not the runbook. He mints a key.
5. Now `decide_tailnet` checks `TS_AUTHKEY` **before** it ever checks the
   carried state: `deploy/install.sh:1260-1263` is
   `key="$(get_env_value TS_AUTHKEY)"; if [ -n "$key" ]; then log "tailnet:
   TS_AUTHKEY is set …"` — and the `else` branch holding
   `tailscale_state_present` is never reached. The identity proof is gone for
   every subsequent run of `./install` on that machine, permanently, until
   someone blanks the key by hand.
6. A fresh key + `TS_HOSTNAME=nova` while the Dell's `nova` node still exists
   in the control plane (parked, but registered — `KeyExpiry` 2027-01-10) is
   hazard (b) from `read-tailnet-identity.md` §2b: a second,
   differently-named peer. Every phone's home-screen icon points at a URL
   that serves nothing, and each device needs delete-and-re-add.

**Does the runbook prevent it, or hope?** It hopes. Step 21's on-failure says
"**stop and do not give it one**" — a good sentence, in a document, against a
tool that prints the opposite instruction on the operator's screen at the
moment of maximum pressure. There is no P-check that the destination's
`TS_AUTHKEY` is blank. Measured today it is blank
(`ssh <MINI_IP> 'grep -m1 "^TS_AUTHKEY=" $MINI_DEPLOY/.env'` → the key is
present and **empty**), so the identity path is live *today* — but nothing
keeps it that way across a failed attempt, and the file already has the key
sitting there waiting for a value.

`deploy/.restored` is written by the restore (`deploy/backup.sh:3249-3250`,
`:4960`) and **nothing in `install.sh` reads it** (`grep -n 'restore'
deploy/install.sh` → only a comment at `:1566` and the dispatch at `:1833`).
The fact that a restore just happened is on disk and unused.

**Smallest fix, in ascending order of doing the job.**

- Runbook only: add **P15** — `ssh <MINI_IP> 'grep -c "^TS_AUTHKEY=." $MINI_DEPLOY/.env'`
  must print `0`, re-read at step 16 with P13.
- Mechanical, and this is the one that matters (CLAUDE.md: "if a property
  must hold, the backend enforces it"): in `decide_tailnet`, check the
  carried state **before** `TS_AUTHKEY`, or refuse a non-empty `TS_AUTHKEY`
  while `deploy/.restored` is present and the state volume holds a node —
  a CANNOT, naming the moved-in identity, not a decision on the owner's
  behalf. The marker exists; it is one `[ -f ]` away from being a control.

---

## F6 — HIGH. An interrupted restore is not refused by `./install`, and step 21 will start on top of it.

**Severity: high.** A half-restored database plus a live node identity is the
"silently worse off" outcome.

**The sequence.** Step 20's restore dies midway — ssh drops, the N150 runs out
of memory, a volume fill fails. By then it has created the in-progress marker
(`deploy/backup.sh:4615`, "the in-progress marker, BEFORE the first docker
volume create"), written the carried `.env` keys (step 8 of the restore,
`deploy/backup.sh:4553-4612`), and possibly filled some volumes including
`v4_tailscale`. The operator, reading step 20's on-failure ("the refusal names
the check … go to §6"), does not see a refusal — he sees a dropped ssh session
and no summary. He runs step 21.

`./install` does not look. `grep -rn 'restore-in-progress' deploy/` matches
`deploy/README.md:367`, `deploy/backup_test.sh` and `deploy/backup.sh:3247` —
**not `deploy/install.sh`**. `refuse_if_moved` (`deploy/install.sh:371-385`)
reads `.moved` only, which is on the *Dell*. So `cmd_install` proceeds,
`compose_up` runs, and the tailscale sidecar starts on whatever landed in
`nova_v4_tailscale`.

**What the owner observes.** Either a hub serving a partial database at the
real URL, or — worse, because it is intermittent — a node that half-registers
and flaps. `read-tailnet-identity.md` §2a: "a health check does not notice it,
because both sides read locally healthy."

**Smallest fix.** Runbook: step 21 gets a precondition —
`ssh <MINI_IP> "ls $MINI_DEPLOY/.restore-in-progress"` must say "No such
file", and step 20's on-failure gets "if the session dropped, do **not** run
step 21; re-read the marker first". Mechanical: `refuse_if_moved` gains a
sibling that refuses while `.restore-in-progress` exists — it is the same
shape, the same file layer, and the marker was written for exactly this
("that marker exists precisely to survive a crash",
`deploy/backup.sh:3400`).

---

## F7 — MEDIUM. Step 21's identity proof is `test -f`. It passes on an empty file.

**Severity: medium** — step 22 is an independent check that would catch it.
But the runbook calls this line "**the proof** the carried identity took", and
it is not.

`tailscale_state_present` ends at `state_file_on_volume`
(`deploy/install.sh:1122-1125`):

```sh
docker run --rm -v "$1:/s:ro" --entrypoint sh "$2" -c 'test -f /s/tailscaled.state'
```

That is existence, not content. A truncated, empty, or logged-out
`tailscaled.state` produces the exact success line the runbook pins:
`tailnet: no auth key needed — volume nova_v4_tailscale already holds a node
(tailscaled.state)` (`deploy/install.sh:1267`). The runbook's on-failure
branch considers only one outcome — "if it instead asks for `TS_AUTHKEY`" —
so the failure mode where it *does not* ask and is still wrong has no
handling.

The restore *does* verify content: volume listings carry per-file content
hashes, types, modes and ownership, re-derived and diffed inside the container
that wrote them (`deploy/backup.sh:1843-1918`, `:3666-3803`), and a mismatch
refuses. So the real coverage is good. The defect is that the runbook credits
the wrong line for it.

**Smallest fix.** Reword step 21: "this line proves a `tailscaled.state` file
is on the volume and that no key was asked for. What proves the *contents*
arrived intact is step 20's `volume v4_tailscale -> …: N entries, N files,
listing identical` (`deploy/backup.sh:3803`) — read that line and quote it
before running step 21."

---

## F8 — MEDIUM. `serve_check.sh` cannot tell you the node was renamed. The healthcheck goes green for the wrong URL.

**Severity: medium** — the third-machine curl at step 22 does catch it, and
the runbook does require it.

`deploy/tailscale/serve_check.sh:123` is:

```sh
echo "serving https://$name/ -> $(serve_target)"
```

where `name="$(dns_name)"` — whatever the node is *actually* called. If
hazard (b) fired and the node came up as `nova-1`, `serve_ok` still returns 0,
the compose healthcheck is green (`deploy/docker-compose.yml:368-372`),
`./install` reports "Nova is up" and prints `On your tailnet:
https://nova-1.<TAILNET>.ts.net/` (`deploy/install.sh:1814`) — a success
message containing the wrong URL. Only a human comparing step 22's string to
step 1's catches it inside the mini PC.

This is not a defect in `serve_check.sh` — it is a healthcheck, and it answers
"would a peer get web", honestly. It is a defect in reading it as a cutover
check.

**Smallest fix.** Make the comparison mechanical rather than visual. Step 1
already captures `Self.DNSName`; have step 1 write it to a file, and step 22
diff against it:

```sh
ssh <USER>@<MINI_IP> "docker exec nova-tailscale-1 /config/serve_check.sh" \
  | grep -qF "https://$(cat dns-name-from-step-1)/" || echo "RENAMED — STOP"
```

And promote the third-machine curl from "Then, from a third machine" to a
numbered step with its own on-failure — it is the only reading taken from the
owner's side of the wire.

---

## F9 — MEDIUM. Step 23 compares against a number no earlier step records, from a machine that is stopped.

**Severity: medium.**

Step 23 says: "Verifies: counts that match **the Dell's**, not zeros." No step
in Phase A, B or C reads `people`, `turns` or `messages` on the Dell. Step 1
records the tailnet state; step 9 records `chat.%` settings; P12 reads
`people` on the **mini PC**, which is the wrong machine and is `0` by design.

By step 23 the Dell is parked: every service stopped (`bk_park`,
`deploy/backup.sh:2185`), `refuse_if_moved` blocks `./install`
(`deploy/install.sh:371`), and getting `nova-postgres-1` back up means a bare
`docker compose up -d postgres` on a parked host — the precise reflex the
runbook spends P4 arguing against.

Measured on the Dell today, read-only: `people` = 1, `turns` = 1047. Those are
the numbers that should have been written down.

**Smallest fix.** Add to step 1, beside the tailscale reading:

```sh
docker exec nova-postgres-1 psql -U core -d nova_core -At \
  -c 'select count(*) from people' -c 'select count(*) from turns' \
  -c 'select count(*) from messages'
```

"Write these three numbers down. They are step 23's baseline, and after step
18 they cannot be read again."

---

## F10 — MEDIUM. Nothing stops the Dell from sleeping during the window, and its sleeping is the whole reason for the move.

**Severity: medium.**

The runbook's own premise (§0 and the brief) is that the Dell sleeps and Nova
stops with it. Steps 18, 19, 24 and the entire Phase E need the Dell awake,
and there is no prerequisite that disables sleep for the duration, and no step
that re-checks reachability before the long-running commands.

- Sleep between step 18 and step 19: the `scp` fails. The Dell is parked and
  off the tailnet; the owner has to wake it physically to retry. Recoverable,
  slow, and at the worst moment.
- Sleep **during** step 18's dump: the run dies after the writers stopped and
  before `bk_park` — F4's sibling, and P3's unfixed branch means nothing
  restarts anything.
- Sleep during Phase E: stated by the runbook, correctly, as a consequence.

**Smallest fix.** A prerequisite **P16**: "On the Dell, disable sleep and
hibernation for the duration (Windows: `powercfg /change standby-timeout-ac
0` and `/hibernate-timeout-ac 0`; record the previous values and restore them
after). Re-enable after Phase D. Until S46 lands wake-on-LAN, decide
deliberately whether it stays disabled for Phase E." Note that this is a
*host* change on Windows, outside compose, and therefore outside every
rollback in §6.

---

## F11 — MEDIUM. Phase B publishes an unauthenticated inference engine to the whole tailnet, and only flags the LAN case.

**Severity: medium** (security), **low** (availability).

Step 7 binds `<DELL_IP>:11434` and the runbook's risk note covers only
**B-alt-2** ("exposes the engine to the whole LAN"). The primary path has the
same shape at tailnet scope: ollama's API has no auth, and it serves
`POST /api/pull` and `DELETE /api/delete` alongside `/api/generate`. Any
tailnet peer can delete the seven local models — 17 GB `qwen3.8:27b`, 19 GB
`gemma4:31b` and five more — which are `exclude-redownload`
(`deploy/docker-compose.yml:439-443`) and therefore **not in any bundle**.
Per the hub lane's closed decision 11, the tailnet includes a work device.

Availability: step 7's bind is explicitly unmeasured (Docker Desktop binding a
published port to the Windows Tailscale adapter). If it fails, the container
does not start and the **live** hub loses inference until someone reverts the
line — more than the "~1 minute of inference outage" §6's Phase B row
promises.

**Smallest fix.** Promote **B-alt-1** (`tailscale serve` on the Dell's own
Windows node) to the primary. It needs no compose edit at all, so it cannot
fail the live ollama container; it is reachable only from the tailnet; it adds
TLS; and it leaves the loopback publish untouched, so its rollback is
`tailscale serve --https=443 off` rather than a compose edit plus a container
recreate. Also state, in one line, that until S42 lands the bearer, any
tailnet peer can pull and delete models on the Dell.

---

## F12 — MEDIUM. `TAILNET_HOSTNAME` is not carried. The runbook says it is.

**Severity: medium.** The outcome is correct today by accident, and the
runbook's stated mechanism is wrong, which makes the failure invisible.

Step 21's on-failure says: "A fresh key plus **the carried
`TAILNET_HOSTNAME`** (which *is* `carry`, `deploy/.env.example:100-101`)". The
disposition is right; the conclusion is not.

`bk_carry_keys` (`deploy/backup.sh:1480-1488`) iterates the keys **present in
the live `.env`** and emits only those declared `carry`. Measured on the Dell
(key names only): `POSTGRES_PASSWORD CORE_TOKEN CORE_GATEWAY_TOKEN
CORE_MEMORY_TOKEN INSTANCE_SECRET SEARXNG_SECRET NOVA_PUBLIC_GATE_TOKEN
COMPOSE_PROFILES COMPOSE_FILE`. **`TAILNET_HOSTNAME` is not there.** So it is
not in `carried.env`, and step 8 of the restore never writes it.

The node is named `nova` today by *default*, not by carry:
`decide_tailnet` reads an empty `TAILNET_HOSTNAME`, finds no TTY over
`ssh <MINI_IP> "…"`, and falls to `hostname=nova`
(`deploy/install.sh:1242-1248`); compose then passes it as `TS_HOSTNAME`
(`deploy/docker-compose.yml:318`). Measured: the Dell's live node is
`nova.<TAILNET>.ts.net.`; the mini PC's `.env` has `TAILNET_HOSTNAME=`
(present, empty). The defaults agree, so it works.

The risk is that nothing checks. If the mini PC's `TAILNET_HOSTNAME` is ever
set to anything else — an earlier experiment, a typo, or an operator running
`./install` **with** a TTY and answering the "Node name on the tailnet"
prompt with something other than the default — the restore will not correct
it, containerboot requests that name, and the carried node is renamed. That is
hazard (b) with the owner's own node key: the URL his phone icon points at
stops answering.

**Smallest fix.** Correct the sentence, and add the check it implies to
step 16: `ssh <MINI_IP> 'grep -m1 "^TAILNET_HOSTNAME=" $MINI_DEPLOY/.env'`
must be empty or exactly the left-most label of step 1's `Self.DNSName`. And
never run step 21 through an interactive shell where that prompt can be
answered by hand.

---

## F13 — LOW. `$MINI_DEPLOY/backups/` does not exist, so the first `scp` fails.

**Severity: low** — Phase C catches it at step 12, outside the window.

Measured: `ssh <MINI_IP> "ls -a $MINI_DEPLOY"` lists no `backups` directory
(the mini PC is at `main`/`e5abd0b`, which has no `backup.sh` at all). `scp
<bundle> <USER>@<MINI_IP>:$MINI_DEPLOY/backups/` with a trailing slash onto a
missing directory fails.

**Smallest fix.** `mkdir -p $MINI_DEPLOY/backups && chmod 700 $MINI_DEPLOY/backups`
in Phase A step 2, beside the checkout.

---

# Checked, and clean

Stated because an adversary who reports only hits is not reporting.

- **Step 17's teardown command runs from `$HOME`, not from the repo** (no
  `cd`, unlike step 4) — and it works anyway. Verified read-only:
  `ssh <MINI_IP> 'cd ~ && docker compose --project-directory $MINI_DEPLOY
  config --services'` returns the seven services, rc 0. `--project-directory`
  is where compose reads `.env`, and the mini PC's `COMPOSE_FILE` is a single
  absolute path to its own `deploy/docker-compose.yml`. Not a finding.
- **Step 17 keeping `nova_v4_models` and `nova_v4_ollama`** is right, and the
  reasoning is right: the empty-target check examines only `include`,
  `move-only` and `dump-pg` (`deploy/backup.sh:4355-4358`), and
  `nomic-embed-text` on `nova_v4_ollama` is what memory embeds with.
- **`v4_models` as `exclude-redownload`** — I suspected its stated reason
  ("its only reader in the whole service is `os.statvfs`") had gone stale
  across 141 commits that added an engines subsystem. It has not.
  `grep -rn 'MODELS_DIR' services/gateway/app/` at HEAD returns exactly
  `admin.py:59` (the definition) and `admin.py:332` (the `statvfs`). The cited
  line numbers are still correct.
- **The signing key travels and is compared.** `core_signing_key` is a
  database row, not an `.env` key, so it rides in the dump; the manifest
  records a sha256 of it (`deploy/backup.sh:2089`, `:2156`) and the restore
  refuses on a mismatch (`bk_compare_signing_key`,
  `deploy/backup.sh:3872-3903`). Measured on the Dell: exactly 1 row. Step
  23's "he is still logged in" claim is sound on this axis.
- **`INSTANCE_SECRET` is `drop`** (`deploy/.env.example:143-144`) and is
  present in the Dell's live `.env` but absent from the mini PC's. It is dead
  ("dropped at S2 seam-hygiene", `deploy/.env.example:136`), so this is
  correct, not a secret silently regenerated.
- **`nova_tailscale_state`** — v3's old node-state volume — still exists on
  the Dell under project label `nova`. I expected it to confuse
  `state_volume_by_label`. It does not: the lookup filters on
  `com.docker.compose.volume=v4_tailscale` as well as the project
  (`deploy/install.sh:1109-1111`), and `docker volume inspect` confirms the
  old volume's label is `tailscale_state`. Not a finding.
- **`./install` does not report success on an unhealthy stack.**
  `wait_for_health || true` at `deploy/install.sh:1789` looked like a
  swallowed failure; it is not — `unhealthy_services` is read immediately
  after and `die "unhealthy service(s):…"` fires at `deploy/install.sh:1802`,
  before "Nova is up".
- **`check_inference_compute` does not fail on the GPU-less mini PC.** It
  returns 0 when no GPU overlay was merged (`deploy/install.sh:1433-1437`).
- **Subnet.** The mini PC holds `docker0` 172.17, jobhunter 172.19, nova
  172.18 (`ip -o -f inet addr show`). After step 17 frees 172.18, v4's pinned
  default fits, and the Dell carries no `NOVA_SUBNET*` key, so both ends
  resolve to the same defaults. Step 5's reading is accurate.
- **P14's "select by the label, never the name".** Re-confirmed: the mini
  PC's `nova` project is exactly the seven dry-run containers; `minecraft` (2,
  running) and `jobhunter` (6, exited) are separate projects.

---

# The one-line verdict

**UNSAFE as written.** Three things must change before this is run, and none
of them is large:

1. **F1** — stop the rollback from rebuilding. One word (`--build`) removed
   from §6, or step 3 dropped entirely.
2. **F2** — get the passphrase onto the destination, deliberately, in
   Phase A.
3. **F4** — read the markers before the recovery `up -d`.

Then **F3** (drill the move bundle — the README already prescribes it) and
**F5**/**F6** (the two `[ -f ]` checks that would make the tailnet guard
mechanical instead of a sentence) turn it from "safe if followed exactly" into
"safe". The rest are corrections to claims, and one host setting nobody has
disabled.

And P3 is still false. `deploy/backup.sh:1676` has not moved. Until it does,
every one of these findings sits downstream of a `--move` that can stop the
Dell and walk away.
