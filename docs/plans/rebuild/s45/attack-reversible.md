# Attack on `runbook-reversible.md`

**Stance: adversary.** The job was to find the step that loses his data, strands
him off the tailnet, or silently leaves him worse off — and to check the
runbook's claims rather than believe them.

**Nothing was started, stopped, removed, deployed or written to on either
machine.** Every reading below is a read-only command, and every claim carries
either a `path:line` in this worktree (`slice/s41`, `06808424`) or the exact
command whose output it came from, run 2026-09-21.

## Placeholders — this repo is public

`<DELL>` the source machine · `<HUB>` the mini PC · `<HUB-TS>` the mini PC's own
tailnet address · `<DELL-TS>` the Dell's own tailnet address · `<TAILNET>` the
tailnet DNS suffix · `<REPO>` a Nova checkout path · `<USER>` the shell account ·
`<PW>` the bundle passphrase. Docker bridge addresses and the volume names
`nova_v4_*` are **not** placeholders: they are literal, already committed at
`deploy/docker-compose.yml`.

---

## Verdict

**SAFE-WITH-FIXES.**

The runbook's spine is sound and unusually honest. The property that makes it
recoverable is real and I verified it: `restore`'s non-empty-target refusal
(`deploy/backup.sh:4315-4392`) reads the DECLARED volume set out of *this
checkout's* render, treats "could not determine" as a refusal, and also refuses
on any container labelled `com.docker.compose.project=nova` including exited
ones — so a restore never writes over anything, and the Dell's volumes are never
touched by the move (`bk_park` runs `compose stop`, never `down -v` —
`deploy/backup.sh:2178-2229`). The runbook's central claim, that everything
before the first write on the hub is a clean revert, survives the attack.

What does not survive:

- **the rollback is not symmetric.** Every mechanical guard in this design
  points one way. Coming back leaves two live copies of the node identity and
  nothing keeping them apart (**C1**).
- **the one gate protecting the identity at cutover fails open**, and
  `install.sh`'s own refusal text is what arms it (**C3**).
- **the park marker is scoped to a checkout; the compose project is scoped to
  the machine** — and this Dell has two v4 checkouts today (**C4**).
- **Phase 2 step 10 deletes the embedder and nothing puts it back** (**C2**).
- **the passphrase prerequisite verifies a different property than the one that
  binds**, and the hub cannot satisfy it as configured (**C5**).

C1, C2, C3, C4 and C5 should be fixed before the runbook is executed. None of
them is a reason to redesign it.

---

## C1 — CRITICAL: the rollback leaves two live copies of the node identity, guarded by nothing

**Severity: critical (strands him off the tailnet, no mechanical guard, not detectable by any healthcheck).**

### The exact sequence

1. Steps 11-19 complete. Nova serves from `<HUB>` at the same URL.
2. Something is wrong — the N150 is too slow, a bug, anything. He takes **R4 →
   R3** exactly as written: stop the hub's stack, read
   `docker inspect nova-tailscale-1 --format '{{.State.Running}}'` as `false`,
   then on `<DELL>` run `./install undo-move` and `./install`. Nova is back on
   the Dell at the same URL. The runbook calls this a clean revert.
3. `<HUB>` is now left holding, all at once:
   - `nova_v4_tailscale`, a complete `tailscaled.state` for the live node;
   - `COMPOSE_PROFILES` containing `tailnet` in `<REPO>/deploy/.env`, written by
     step 17's `record_compose_profiles` (`deploy/install.sh:1682-1700`);
   - `restart: unless-stopped` on the sidecar (`deploy/docker-compose.yml:301`);
   - **no `.moved`, no `MOVED_TO`, and no marker of any kind.**
4. Any one of these on `<HUB>`, days later, re-joins the node:
   - `docker compose --project-directory <REPO>/deploy up -d` — which is
     verbatim the command `record_compose_files` prints on every install
     (`deploy/install.sh:1666`: *"run compose from $DEPLOY_DIR, or with
     --project-directory $DEPLOY_DIR, and no -f"*);
   - `./install` re-run — `decide_tailnet` (`deploy/install.sh:1220-1231`) reads
     `COMPOSE_PROFILES`, finds `tailnet`, sets `want=1`, then
     `tailscale_state_present` (`:1138-1177`) returns 0 and it prints
     *"tailnet: no auth key needed"* and starts it;
   - `docker start nova-tailscale-1`.
5. Two tailscaled hold one node key — the failure the runbook's own §0 calls
   *"the whole risk"*.

### What he observes

The URL answers intermittently, then stops answering from either machine.
**Nothing turns red.** `serve_ok` (`deploy/tailscale/serve_check.sh:107-124`)
reads only its OWN tailscaled: `BackendState`, its own serve map, and a
CertDomains *warning*. It never asks whether another node holds the key. Both
hosts report `healthy` in `docker compose ps` throughout.

### Why the runbook does not prevent it — it hopes

R4's own row says only: *"the node key has now been served from two hosts in
sequence. The Dell's copy of `tailscaled.state` is stale; Tailscale generally
accepts it, and this is not measured against your tailnet."* That is the wrong
worry. The live hazard is not staleness on the Dell, it is **the hub's copy
still being bootable with the profile still switched on**.

`undo-move` cannot help: its design (`s41/design-verdict.md:1819-1846`) touches
only `deploy/.moved` and `deploy/tailscale/MOVED_TO` **on the machine it runs
on**. It writes nothing on the destination, by design.

And its one safety read is, on this machine, structurally a no-op. §9.5 step 3
reads the peer liveness *"if a host `tailscale` CLI exists"*. **Measured on
`<DELL>`: `command -v tailscale` → not on PATH.** The sidecar is stopped at that
moment, so there is no tailscaled to ask either. `undo-move` will always take
the *"I cannot check from here"* branch here. R3's only real check on the hub is
a single point-in-time `docker inspect`, which says nothing about tomorrow.

### Smallest fix

Make R3/R4 remove the hub's copy before the Dell's markers come off. Deleting it
is safe: the bundle still holds a copy whose listing step 14's drill diffed, and
the Dell's own `nova_v4_tailscale` is untouched.

Insert into R3, **on `<HUB>`, before anything is done on `<DELL>`**:

```
docker compose --project-directory <REPO>/deploy --profile '*' stop
docker inspect nova-tailscale-1 --format '{{.State.Running}}'        # must read false
docker volume rm nova_v4_tailscale
docker volume ls --format '{{.Name}}' | grep -x nova_v4_tailscale    # must print NOTHING
NOVA_TAILNET=0 ./install                                             # takes `tailnet` out of COMPOSE_PROFILES
```

`NOVA_TAILNET=0` is already supported and already says what it does not do
(`deploy/install.sh:1231-1236`: *"A running tailscale container is left alone"*)
— which is why the explicit `stop` and the volume removal both stay.

---

## C2 — HIGH: Phase 2 step 10 deletes the embedder, and nothing in the runbook puts it back

**Severity: high (silently leaves him worse off; degradation is logged, not surfaced).**

### The exact sequence

1. **P15** measures the hub's ollama and records the finding:
   `nomic-embed-text:latest` only. I re-measured it —
   `ssh <USER>@<HUB-TS> 'docker exec nova-ollama-1 ollama list'` → exactly one
   model, `nomic-embed-text:latest`. The runbook reads this as *"the embedder,
   and no chat model at all"* and sends the reader to Phase 6.
2. **Phase 2 step 10** runs `docker compose --project-directory <REPO>/deploy
   down -v` on `<HUB>`. `-v` removes `nova_v4_ollama`. **The embedder goes with
   it.**
3. `v4_ollama` is `exclude-redownload` (`deploy/docker-compose.yml:439-441`), so
   the bundle does not carry it back.
4. **Phase 6 step 22** pulls `qwen3:8b` — a *chat* model — and its verification
   is *"a chat-capable model appears in the list **alongside**
   `nomic-embed-text:latest`"*. That sentence is false after step 10:
   `nomic-embed-text` is not there any more, and nothing else in the runbook
   pulls it.

### What he observes

Not an error. `services/memory/app/embedding.py:75,83` default
`MEMORY_EMBED_URL=http://ollama:11434` and `DEFAULT_MODEL="nomic-embed-text"`,
and the memory service sets neither env var in compose
(`deploy/docker-compose.yml:127-129` carries only `DATABASE_URL` and
`SERVICE_TOKEN`). So memory talks to the hub's own now-empty ollama.
`services/memory/app/api.py:266-267` is explicit that this is *"deliberately NOT
fatal and deliberately NOT silent"* — meaning it logs and carries on. Old notes
stay searchable because `v4_memdata` is `include` and
`.embeddings/*.jsonl` rides along (`deploy/docker-compose.yml:429-434`). **Every
note written after the move is unembedded**, and `api.py:253` states the
consequence in its own words: recall over those units *"honestly refuses to
run"*. He will not see it on the screen; he will see recall that quietly stops
covering anything recent.

### Smallest fix

Add to step 22, first line, and fix step 22's verification sentence:

```
docker exec nova-ollama-1 ollama pull nomic-embed-text
docker exec nova-ollama-1 ollama pull qwen3:8b
docker exec nova-ollama-1 ollama list     # BOTH must be listed
```

and add to P15 the sentence step 10 invalidates: *"step 10 deletes this model
with the volume; it is re-pulled in step 22, not carried."*

---

## C3 — HIGH: step 17's identity gate fails open, and `install.sh`'s own refusal text is what arms it

**Severity: high (this is the step that can lose the tailnet name for good).**

Step 17's entire protection is a negative observation: *"**Verifies:** the
installer asks for **no auth key**. … **If it asks for a key, stop.**"*

`decide_tailnet` tests the key **first** and short-circuits
(`deploy/install.sh:1263-1266`):

```
key="$(get_env_value TS_AUTHKEY)"
if [ -n "$key" ]; then
  log "tailnet: TS_AUTHKEY is set (used once, on the node's first login)"
else
  tailscale_state_present && rc=0 || rc=$?
```

With a non-empty `TS_AUTHKEY`, `tailscale_state_present` is **never called**.
The installer asks nothing, step 17's gate reads PASS, and `TS_AUTH_ONCE: "true"`
(`deploy/docker-compose.yml:324`) then decides on its own whether to use the key
— it uses it precisely when the state store has no logged-in node, i.e. exactly
the failure the gate exists to catch.

### The exact sequence

1. Step 15's restore does not populate `nova_v4_tailscale` (a listing diff the
   operator waved through, a `--drill`-only run mistaken for the real one, a
   bundle written without `--move`).
2. Step 17 runs. `TS_AUTHKEY` is non-empty in `<REPO>/deploy/.env`.
3. The installer prints `tailnet: TS_AUTHKEY is set` and starts the sidecar.
   The operator, following the runbook, sees no prompt and proceeds.
4. containerboot logs in with that key and mints a **new** node. The Dell's node
   is parked but still *registered*, so the name `nova` is taken and the control
   plane hands the new node a suffixed name.
5. `https://nova.<TAILNET>.ts.net` now resolves to the Dell's registered,
   offline node. Nothing answers. The phone's home-screen icon is dead and
   getting back means delete-and-re-add plus a fresh login on every device
   (`s45/read-tailnet-identity.md` §5).

**Measured today: `TS_AUTHKEY` is EMPTY on `<HUB>`** (`grep -m1 '^TS_AUTHKEY='
<REPO>/deploy/.env` on `<HUB>` → empty value; only the key's presence and its
length were read, never its content). So the trap is **not armed right now**.

What arms it is the runbook's own recovery path. `refuse_tailnet`
(`deploy/install.sh:1204-1213`) — the message printed the instant the state
volume is missing — says, as way forward 1: mint a key, *"put it in $ENV_FILE
as `TS_AUTHKEY=tskey-auth-…` and re-run: `NOVA_TAILNET=1 ./install`"*. An
operator who hits that refusal at step 17 and follows the terminal has converted
step 17's gate into a no-op and minted the second node in one move. The terminal
wins over the document at 3am, every time.

Step 18 catches it afterwards (`Self.DNSName` with a numeric suffix) — but only
after a spurious node exists on the tailnet, and the runbook never says to
delete that node in the admin console.

### Smallest fix

Replace step 17's negative gate with a positive, mechanical one, run **before**
the install:

```
# on <HUB>, before step 17
grep -m1 '^TS_AUTHKEY=' <REPO>/deploy/.env    # the value MUST be empty
IMG=$(docker compose --project-directory <REPO>/deploy config \
        --format json | python3 -c 'import json,sys;print(json.load(sys.stdin)["services"]["tailscale"]["image"])')
docker run --rm -v nova_v4_tailscale:/s:ro --entrypoint sh "$IMG" \
  -c 'wc -c < /s/tailscaled.state'            # MUST print a non-zero size
```

and add one sentence to step 17: *"if the installer prints `tailnet: TS_AUTHKEY
is set`, that is the SAME failure as it asking for a key — it means nothing
checked the state volume. Stop."* Add "TS_AUTHKEY is blank on the destination"
as a numbered prerequisite.

---

## C4 — HIGH: the park marker is scoped to a checkout; the compose project is scoped to the machine

**Severity: high (the one bypass the design documents is not the only one).**

Both guards are path-relative:

- `refuse_if_moved` reads `$MOVED_MARKER = $DEPLOY_DIR/.moved`
  (`deploy/install.sh:61`, `:371-372`) — `DEPLOY_DIR` being the deploy directory
  of the `install.sh` that is running.
- `start.sh` reads `$CONFIG_DIR/MOVED_TO` (`deploy/tailscale/start.sh:86-102`) —
  `/config` being whatever `./tailscale` directory the **compose file that
  started the container** bind-mounts (`deploy/docker-compose.yml:343-350`).

The compose *project* is `nova` (`deploy/docker-compose.yml:1`) on every
checkout, so every checkout on the machine addresses the same containers and the
same `nova_v4_tailscale` volume. `backup --move` writes its markers into exactly
one of them.

**Measured on `<DELL>` today — two v4 checkouts, both complete:**

- `docker inspect nova-core-1 --format '{{index .Config.Labels
  "com.docker.compose.project.config_files"}}'` → the live stack is served from
  `<REPO>/.worktrees/v4/deploy/{docker-compose.yml,docker-compose.gpu.yml}`.
- `ls <REPO>/deploy/` → `install.sh`, `docker-compose.yml` and
  `tailscale/{serve_check.sh,start.sh,start_test.sh}` are all present in the
  main checkout too, with **no `.env`** and therefore no marker and no
  `COMPOSE_PROFILES`.

### The exact sequence

1. The move is run from the serving checkout. Markers land in
   `<REPO>/.worktrees/v4/deploy/`.
2. Months later, from the other checkout: `NOVA_TAILNET=1 ./install`, or
   `docker compose --project-directory <REPO>/deploy --profile tailnet up -d`.
3. `refuse_if_moved` looks for `<REPO>/deploy/.moved` — absent — and returns 0.
4. The sidecar is created with `<REPO>/deploy/tailscale` as `/config`. There is
   no `MOVED_TO` there either. `start.sh`'s step 0 does not fire.
5. It mounts `nova_v4_tailscale` — the *same* volume, because the project name
   is the same — and joins as the live node, while `<HUB>` is serving it.
   Back to C1's flap, with both healthchecks green.

This repo has already been bitten by exactly this class of accident
(`compose same-project-name trap`: a compose command in the main checkout
stopped v4's postgres).

### Smallest fix

Phase 8 step 26 gains an enumeration rather than a spot check:

```
# on <DELL>, after the move
for d in $(find "$HOME" -maxdepth 5 -type d -name deploy -path '*nova*' 2>/dev/null); do
  [ -f "$d/docker-compose.yml" ] || continue
  cp <SERVING>/deploy/.moved                "$d/.moved"
  mkdir -p "$d/tailscale" && cp <SERVING>/deploy/tailscale/MOVED_TO "$d/tailscale/MOVED_TO"
  chmod 600 "$d/.moved" "$d/tailscale/MOVED_TO"
  ls -l "$d/.moved" "$d/tailscale/MOVED_TO"     # read BOTH back, in every directory
done
```

and `undo-move`'s manual counterpart in R3 must remove them from **every**
directory it placed them in, verifying each removal — not from one.

---

## C5 — HIGH: P7 verifies that a resolver exists, not that `<HUB>` can open this bundle; and it is ordered before the passphrase exists

**Severity: high (a bundle nobody can open is not a backup) — but it fails safe, and Phase 1 step 4 catches it.**

Three separate defects, all in one prerequisite.

**(a) P7 checks the wrong property.** Its command is
`grep -n 'NOVA_PASSPHRASE_SOURCE\|NOVA_PASSPHRASE_FILE\|NOVA_PASSPHRASE_CMD'
<REPO>/deploy/.env` and it claims to verify *"a resolver is configured, and you
can state which one."* Three blank assignments satisfy that grep while the two
machines resolve to two different passphrases — which is the failure that
matters. The binding property is "the passphrase resolvable on `<HUB>` opens
**this** bundle", and nothing in P7 tests it.

**(b) `<HUB>` cannot satisfy it as configured today.** Measured over ssh with
`BatchMode=yes`:
- the hub's `<REPO>/deploy/.env` declares **no** `NOVA_PASSPHRASE_*` key at all
  (its full key list is `POSTGRES_PASSWORD CORE_TOKEN CORE_GATEWAY_TOKEN
  CORE_MEMORY_TOKEN SEARXNG_SECRET NOVA_PUBLIC_GATE_TOKEN NOVA_WEB_ADDR
  NOVA_TAILSCALE_ADDR TS_AUTHKEY TAILNET_HOSTNAME COMPOSE_PROFILES COMPOSE_FILE`);
- `grep -c NOVA_PASSPHRASE_SOURCE <REPO>/deploy/.env.example` on `<HUB>` → **0**
  (its checkout predates the S41 seam);
- `<REPO>/deploy/.backup-passphrase` does **not** exist there;
- `ls <REPO>/deploy/backup.sh` on `<HUB>` → **No such file or directory**.

So the runbook's `./install restore <BUNDLE> --drill` — which it writes with no
`--passphrase-file` in **both** Phase 1 step 4 and Phase 3 steps 14 and 15 —
lands on `deploy/backup.sh:4184`: *"there is no passphrase here, and a restore
never generates one"*. That refusal is correct and it is the reason this is
SAFE-WITH-FIXES rather than UNSAFE: the restore refuses rather than proceeding.
But the prerequisite that was supposed to catch it does not, and the commands
carry no way to supply it. `--passphrase-file` exists
(`deploy/backup.sh:4024-4025`, validated at `:3942-3966`: regular file, mode
600, non-empty, one line) and is never used in the runbook.

**(c) P7 is ordered before the passphrase exists.** P7 says record `<PW>`
*"before step 1"*. The `file` source is the default and it is *"the only source
that may CREATE a passphrase, and only when the file does not exist at all"*
(`deploy/.env.example:170-176`), and `cmd_backup` creates it on first use
(`deploy/backup.sh:2486-2488`). **Measured: no `.backup-passphrase` exists
anywhere under the Dell's repo except in this S41 worktree** (`find <REPO>
-maxdepth 4 -name .backup-passphrase` finds one file, 15 bytes, mode 600, in
`<REPO>/.claude/worktrees/<this one>/deploy/` — **not** in the serving checkout).
After P4 merges S41 into the serving checkout, that checkout has no passphrase
file, so the passphrase for the move bundle is **generated at Phase 1 step 1**.
There is nothing to record before step 1. And its only copy then lives on the
machine that is about to be parked and that, by the premise of this whole move,
sleeps.

### Smallest fix

Split P7 into a check that runs after Phase 1 step 1 and a comparison that
binds:

```
# on <DELL>, AFTER Phase 1 step 1 has created it
cat <REPO>/deploy/.backup-passphrase          # record THIS string off both machines
sha256sum <REPO>/deploy/.backup-passphrase

# on <HUB>, before Phase 1 step 4
install -m 600 /dev/stdin <REPO>/deploy/.backup-passphrase   # paste it
sha256sum <REPO>/deploy/.backup-passphrase    # MUST equal the Dell's
```

and add `--passphrase-file <REPO>/deploy/.backup-passphrase` to the restore and
drill commands in Phase 1 step 4 and Phase 3 steps 14 and 15, so the runbook
works whether or not the hub's `.env` has the seam.

---

## C6 — MEDIUM: a `--move` that fails between the writer stop and `bk_park` leaves the Dell off the tailnet, with no marker, no bundle, and no rollback row

**Severity: medium (stated in the runbook, but its rollback table has no row for it).**

On `--move`, `tailscale` joins the writer set — `writer_services`
(`deploy/backup.sh:1133-1176`) includes any service with a read-write mount of a
volume "this run carries", and `--move` makes `v4_tailscale` carried
(`s41/design-verdict.md:1782-1784`). So the sidecar is stopped by
`bk_stop_writers` **before** the dumps and the pack, not by `bk_park`.

`bk_backup_cleanup`'s restart branch is gated
(`deploy/backup.sh:1676`):

```
if [ -n "$BK_RUN_STOPPED" ] && [ "$BK_RUN_MODE" != "move" ]; then
```

**Verified: the 2026-09-21 ruling is not implemented.** `s41/rulings.md:271-298`
("a failed `--move` parks or restarts, and says which") requires every exit path
to end in one of exactly two stated states. The code has only the skip. So a
`--move` that fails at the dump, the tar, the pack or the verify leaves `<DELL>`
with: writers stopped **including tailscale**, no markers, no bundle, and Nova's
URL dead — and the process says nothing about which state that is.

The runbook does name this, honestly, under step 11's failure list. But its
**Rollback table has no row for it**: R3 begins *"anywhere from step 11 to step
16"* and prescribes `undo-move` then `./install`. `undo-move` exits 0 with no
marker (`s41/design-verdict.md:1821-1823`, and the pinned test
`undo_move_exits_0_with_no_marker` at `:2310`), so the sequence does work — it
just reads as a no-op the operator will not trust at 3am.

**Smallest fix:** add an **R0** row to the table — *"`backup --move` failed
before it printed `parked:` — the stack is stopped and there are no markers.
`docker compose --project-directory <REPO>/deploy --profile '*' up -d`, then
`docker compose ps` to confirm eight services, then start over."* Either that,
or implement the ruling before the move is run.

---

## C7 — MEDIUM: step 18's `HaveNodeKey` is top-level, not `Self.*` — and its failure branch is "Rollback R3"

**Severity: medium (a false negative that costs a rollback of a successful move).**

Step 18 verifies, as one list: *"`Self.DNSName` is … ; `Self.Created` is still
the original … ; `HaveNodeKey: true`; and serve shows …"*. P13 does the same.

**Measured on `<DELL>` today**, from
`docker exec nova-tailscale-1 tailscale status --json`:

```
top-level keys: ['AuthURL','BackendState','CertDomains','ClientVersion',
                 'CurrentTailnet','ExtraRecords','HaveNodeKey','Health',
                 'MagicDNSSuffix','Peer','Self','TUN','TailscaleIPs','User','Version']
HaveNodeKey (top-level): True
Self keys: [... 'Created','CurAddr','DNSName','ExitNode', ... ]   # no HaveNodeKey
```

`HaveNodeKey` is a field of the status object, not of `Self`. An operator
reading `.Self.HaveNodeKey` gets `null` on a perfectly healthy node, and step
18's stated failure branch is *"Stop the sidecar on the mini PC, confirm the
Dell really is parked, and go to Rollback R3"* — i.e. throw away a successful
move.

Everything else in step 18 I re-measured and it is correct: `TCP:
{'443': {'HTTPS': True}}`, the web handler is
`{'Proxy': 'http://172.18.128.10:80'}`, `Self.Created`
`2026-07-14T21:13:49…Z`, `KeyExpiry` `2027-01-10T21:13:49Z`, `CertDomains`
holds exactly one entry and it equals `Self.DNSName` minus its trailing dot.

**Smallest fix:** give the exact expression and say where the field lives:

```
docker exec nova-tailscale-1 tailscale status --json | python3 -c \
 "import json,sys; d=json.load(sys.stdin); s=d['Self']; \
  print(d['HaveNodeKey'], s['DNSName'], s['Created'])"
```

---

## C8 — MEDIUM: nothing requires the Dell to stay awake, and every rollback runs on the Dell

**Severity: medium (assumes the Dell is reachable; the runbook prerequisites the hub and not the source).**

**P12** makes "the mini PC is reachable by a path that is not Nova" a
prerequisite and calls it *"the single prerequisite that turns a bad move from
'recoverable' into 'drive to the machine'."* There is **no matching
prerequisite for `<DELL>`** — and `<DELL>` is the machine that sleeps. That is
the entire premise of the move (runbook §THE SITUATION: *"the Dell sleeps and
Nova stops with it"*).

Every rollback in the table runs on `<DELL>`: R2, R3 and R4 all end in
`./install undo-move` (or the manual `rm`) plus `./install`, **there**. After
step 11 the Dell's own tailnet node is still up — `bk_park` stops the *Nova*
sidecar, not the machine's native tailscaled — but a Windows box that sleeps
mid-move takes that with it.

Three steps additionally assume it is awake and unchanged, and only one says so:
Phase 2 step 7-8 (correctly, it is the point of the phase), Phase 6 step 20
(says *"with the Dell AWAKE"*), and **Phase 7 step 24**, which is measured to
run `novad` *on the Dell* and says nothing about it.

### The exact sequence

Step 11 parks. Step 15's restore is running on `<HUB>` and fails a gate. The
Dell has slept in the intervening 20 minutes. R3 cannot be executed at all until
he physically wakes it — and the runbook's own downtime table budgets 12-30
minutes with no instruction to prevent sleep.

**Smallest fix:** add **P17** beside P12:

```
ssh -o BatchMode=yes <USER>@<DELL-TS> 'echo OK; hostname'
```

*"Verifies: `<DELL>` answers on its OWN tailnet node, independently of Nova.
Then disable sleep and hibernate on `<DELL>` for the duration — every rollback
in this document runs there. On failure: stop."* And re-check it at the head of
Phase 3.

---

## C9 — LOW: step 19's `curl -sI` prints nothing on a TLS failure and the pipeline still exits 0

`curl -sI https://nova.<TAILNET>.ts.net/ | head -3`. With `-s`, a certificate
failure or a connection failure produces **no output and no message**, and the
pipeline's exit status is `head`'s, which is 0. Empty output is easy to read as
"nothing to report" in the middle of a cutover. Its sibling at step 16 is
better: `curl -s -o /dev/null -w '%{http_code}\n'` prints `000` on failure.

**Smallest fix:**
`curl -sS -o /dev/null -w 'http=%{http_code} tls=%{ssl_verify_result} cert=%{certs}\n' https://nova.<TAILNET>.ts.net/`
— or simply drop `-s` and add `-w '%{http_code}\n'`.

---

## C10 — LOW: step 10's teardown verification is label-scoped; `restore`'s refusal is name-scoped

Step 10 verifies the teardown with
`docker volume ls --filter label=com.docker.compose.project=nova`. Step 6 of the
restore (`deploy/backup.sh:4340-4368`) probes by the **name** the render
resolves for each declared key (`cfg_volume_name`), not by label. A
`nova_v4_*` volume created by hand or left by a `docker run -v` carries no
compose labels, so the runbook's verification reads clean while the restore
refuses. Fails safe; costs a confusing refusal at the worst moment.

Also: **P16's cited near-miss is stale.** It says the mini PC holds a volume
named `nova_pgdata` labelled `docker`. Measured today, `<HUB>`'s full volume
list is `jobhunter_{frontend_node_modules,postgres_data,redis_data}`,
`nova_v4_{memdata,models,ollama,pgdata,workspace}` and one unlabelled hash.
`nova_pgdata` and `nova_redis_data` are **gone**. The *rule* P16 states
(select by label, never by name prefix) is still right and still worth keeping —
the example behind it is history. Note that `<DELL>`, by contrast, does still
carry v3-era volumes under the `nova` project label (`nova_tailscale_state`,
`nova_kokoro_models`, `nova_ntfy_cache`, `nova_whisper_models`,
`nova_nova_coder_workspaces`), so the same caution is live on the source side.

**Smallest fix:** add the name-scoped check beside the label-scoped one at step
10: `docker volume ls --format '{{.Name}}' | grep -E '^nova_v4_'` must print
nothing; and re-measure P16's table on the day rather than citing it.

---

## C11 — LOW: `undo-move`'s liveness check cannot run on this Dell

Covered under C1 and repeated here because the runbook presents it as a real
check: *"`undo-move` … reads `tailscale status --json` for an online peer
carrying the archived DNS name **and says what it found either way**"*.

§9.5 step 3 conditions that read on *"if a host `tailscale` CLI exists"*.
**Measured on `<DELL>`: `command -v tailscale` → not on PATH.** The sidecar is
stopped at that moment by definition. So the branch taken is always *"I cannot
check from here"*. The runbook should say so, rather than let the reader budget
it as a safeguard.

**Smallest fix:** in R3, replace the sentence with: *"on this machine
`undo-move` will always print `I cannot check from here` — there is no host
tailscale CLI and the sidecar is stopped. The check that matters is the one you
run on `<HUB>` above."*

---

## C12 — LOW: step 21's spend-ledger claim is not what the cited line does

Step 21 says *"`data_plane.py:169` records usage for a non-local row, so turns
on your own 3090 will appear in the spend ledger."* The line reads:

```
if response.status_code == 200 and not decision.row.get("local"):
    await routing.note_success(pool, decision.row["name"], decision.model)
```

That is a routing success note, not a usage or spend record. The surrounding
claim may still be true by another path, but the citation does not support it.
The neighbouring claims in the same step I did verify: `insert_row` derives
`local` as `$2 = 'ollama'` (`services/gateway/app/providers.py:298`), and the
503 text at `data_plane.py:173-175` is verbatim
*"every link in the {role!r} chain refused this request"*.

---

## What I checked and found CORRECT

Stated because an adversary that only lists faults is not a reading.

- **The GPU correction is right and the brief was wrong.** `base_url_of`
  (`services/gateway/app/providers.py:97-110`) routes any non-builtin row to its
  stored address — *"including another machine's engine"* — but `validate_shape`
  (`:146-153`) refuses `adapter=ollama` for a non-builtin row in exactly the
  words the runbook quotes. `adapter: "openai-chat"` at the `/v1` address is the
  correct shape, and `_verify_or_502` (`services/gateway/app/admin.py:670-680`)
  does write nothing on a refusal, so a 200 at step 20 really is a proof of
  reachability.
- **`hub` resolves to the live `OLLAMA_URL`, never a stored column** — P15's
  reason for Phase 6 is sound (`providers.py:108-109`,
  `deploy/docker-compose.yml:94`).
- **The device signing key travels in the database, not on disk** —
  `core_public_key_hex(pool)` (`services/core/app/devices_ws.py:289`). Step 15's
  fingerprint comparison is comparing the right thing.
- **`v4_models` really is inert.** `MODELS_DIR = Path("/models")` has exactly two
  references in the entire gateway (`admin.py:59` and the `os.statvfs` at `:332`)
  and I measured the live volume: `docker run --rm -v nova_v4_models:/m:ro alpine
  du -sh /m` → 4.0K, **0 files**. `exclude-redownload` is the right call.
- **P1, P2, P3, P4 and P5 are all honestly reported as FALSE today.** I
  confirmed harder than the runbook did: `main()`
  (`deploy/install.sh:1827-1834`) knows only `install` and `update`;
  `cmd_undo_move` has no definition anywhere in `deploy/backup.sh`; and
  **`<REPO>/.worktrees/v4/deploy/backup.sh` does not exist at all** — the
  checkout that serves the live stack (`rebuild/v4` at `0996a31f`) predates S41
  entirely. `<HUB>` is on `main` at `e5abd0b` and has no `backup.sh` either. P4
  and P5 are not paperwork; without them the move has no verbs.
- **`restore` never starts anything and never merges.** It names `./install` as
  the one next command, and the non-empty-target refusal
  (`deploy/backup.sh:4315-4392`) reasons explicitly about the exact trap the
  runbook would otherwise walk into: a target whose PGDATA holds the target's own
  password while the carried `.env` holds the source's.
- **The carried-key write is verified, not asserted** (`deploy/backup.sh:4553-4612`):
  planned, applied, `chmod 600`, the mode read back, then every key re-read out of
  `.env` and compared — and only key NAMES are ever printed. Step 15's "five
  conflicts are normal" is right for the reason given: `ensure_secret`
  (`deploy/install.sh:1594-1602`) only generates into an EMPTY key, so the hub's
  dry-run values are what get replaced, and the later `./install` at step 16 does
  not undo them.
- **The park is proved, not claimed** (`deploy/backup.sh:2178-2229`):
  `.State.Running == false` read per service after the stop, both markers written
  under `umask 077` and **read back byte-for-byte**, and a failure at any point
  says which of the two states the host is in.
- **The `MOVED_TO` guard exists** — `deploy/tailscale/start.sh:86-102`, and it
  refuses even when it cannot read the marker's body (*"a marker this container
  cannot read is not a marker it may ignore"*). The runbook is right that
  `s45/read-tailnet-identity.md`'s report of a missing guard is out of date.
- **P14 is right that `serve_check.sh` only warns about certs** —
  `warn_if_no_cert_domain` (`deploy/tailscale/serve_check.sh:93-106`) writes to
  stderr and returns; only `BackendState` and the serve mapping gate.
- **The downtime estimate's data is real.** `<HUB>` has `nova_v4_{memdata,
  models,ollama,pgdata,workspace}` and no `nova_v4_tailscale`, exactly as a
  tailnet-off dry run should; `minecraft-bedrock` and `minecraft-backup` are up
  and the six `jobhunter-*` containers have been exited for six months. P16's
  "do not scope by the name prefix" rule holds.
- **"Do not use Nova until you have decided the move stands"** is the correct
  identification of the point of no return, and it is not where most people
  would put it.
