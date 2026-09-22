# Adversarial critique — `design-shell-first.md`

Written 2026-09-21 against `design-shell-first.md` (1356 lines), checked line by
line against this worktree, `map-requirements.md`, `rulings.md`,
`map-portability.md`, `map-deploy-data.md` and `map-v3-backup.md`.

**How to read the evidence.** Every claim below carries `path:line`. Where I ran
a command to settle a question, the command and its actual output are quoted and
marked **[measured here, 2026-09-21]**. Where I could not run something (a second
host, a macOS runner, a live restore), it says so and does not pretend otherwise.
This review took nothing in the design on trust; several of its confident
assertions are true and are named as such at the end.

**Verdict: SOUND-WITH-FIXES.** 3 critical, 12 major, 11 minor.
The architecture is right and most of the fixes are small. Two of the three
criticals are the same root cause — the design derives "what is ours" from a
*rendered* compose config, and `docker compose config` prunes. That one
substitution (derive the ours-set from a source profiles cannot prune) closes
both. The third critical is that the slice's own DoD walk cannot be executed as
written.

---

## 0. What I measured, before any finding

These are the facts the rest of the document rests on. They were produced in
this worktree today.

**(a) This session's compose is v5.3.0, not v5.5.1.**

```
$ docker compose version
Docker Compose version v5.3.0
$ docker --version
Docker version 29.6.1, build 8900f1d
```

The design says of its central coverage mechanism: *"Measured in this session
against compose v5.5.1"* (`design-shell-first.md:230`) and repeats
`novaxtest3` / v5.5.1 provenance at `:447-450`. v5.5.1 is the **mini PC's**
compose (`map-requirements.md:99`). Whatever was measured, it was not measured
in a session whose `docker compose` answers v5.3.0. See minor m7.

**(b) `--profile '*'` works on v5.3.0, and `x-` keys survive the render — on
top-level volumes AND on long-syntax binds.** I built a probe compose file with
a profile-gated service, a long-syntax bind carrying `x-nova-backup`, a
tmpfs mount, and two declared volumes (one mounted, one not):

```
$ docker compose --project-directory $D -f $D/docker-compose.yml --profile '*' config
...
    volumes:
      - type: bind
        source: /.../here
        target: /b
        read_only: true
        x-nova-backup: exclude-code
        x-nova-backup-reason: in the repo
...
volumes:
  vol_one:
    name: novaxprobe_vol_one
    x-nova-backup: include
    x-nova-backup-reason: the notes
```

So §4.1's core claim is **true and load-bearing**: the disposition can live
beside the thing it describes and be read back out of the render. Requirement #4
is satisfiable exactly as designed. This is the design's best idea and it
survives contact.

**(c) The same run proved two things the design does not account for.**

`vol_two` — declared under `volumes:` with `name: custom_two` and
`x-nova-backup: dump-pg`, but mounted by no service — **is absent from the
rendered output entirely**, and absent from `config --volumes`:

```
$ docker compose ... --profile '*' config --volumes
vol_one
```

And rendering v4's real compose file:

```
$ docker compose --project-directory deploy -f deploy/docker-compose.yml config --volumes
v4_workspace
v4_memdata
v4_pgdata
v4_models

$ docker compose --project-directory deploy -f deploy/docker-compose.yml --profile '*' config --volumes
v4_tailscale
v4_pgdata
v4_models
v4_ollama
v4_memdata
v4_workspace
```

`v4_ollama` (`deploy/docker-compose.yml:215`, `profiles: ["inference"]`) and
`v4_tailscale` (`:244`, `profiles: ["tailnet"]`) exist in the ours-set **only
because of the `--profile '*'` flag**. Drop it and two of v4's six volumes
vanish.

**(d) Those two volumes exist right now on this host, correctly labelled.**

```
$ docker volume ls --format '{{.Name}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.volume"}}' | grep -i nova
nova_kokoro_models|nova|kokoro_models
nova_nova_coder_workspaces|nova|nova_coder_workspaces
nova_ntfy_cache|nova|ntfy_cache
nova_tailscale_state|nova|tailscale_state
nova_v4_memdata|nova|v4_memdata
nova_v4_models|nova|v4_models
nova_v4_ollama|nova|v4_ollama
nova_v4_pgdata|nova|v4_pgdata
nova_v4_tailscale|nova|v4_tailscale
nova_v4_workspace|nova|v4_workspace
nova_whisper_models|nova|whisper_models
```

**(e) `docker volume ls --format '{{.Label "…"}}'` and `docker ps --format
'{{.Label "…"}}'` both work.** §8.1's derivation is mechanically expressible;
that part is fine.

---

## CRITICAL

### C1 — `--profile '*'` is the only thing keeping two v4 volumes out of the deletion offer, and nothing checks it

**Severity: critical.** Directly violates ruling 1: *"It must be impossible for
that path to touch a v4 volume. That is a test, not a promise"*
(`rulings.md:25-26`).

**What breaks.** §8.1 derives the entire ours-set from one rendered config:

```
OURS_VOLK:= docker compose "${COMPOSE_ARGS[@]}" --profile '*' config --volumes
OURS_VOLN:= config_volume_name for each key
```

and then classifies (`design-shell-first.md:916-924`):

```
C := docker volume ls --filter "label=com.docker.compose.project=$PROJECT" ...
     -> FOREIGN when the volume label is not in OURS_VOLK
D := docker volume ls --format '{{.Name}}' | names matching ^${PROJECT}_
     -> FOREIGN when the name is not in OURS_VOLN
```

Measurement (c) shows that without the flag, `OURS_VOLK` = {v4_workspace,
v4_memdata, v4_pgdata, v4_models}. Measurement (d) shows `nova_v4_tailscale` and
`nova_v4_ollama` carry `com.docker.compose.project=nova` and
`com.docker.compose.volume=v4_tailscale` / `v4_ollama`. Rule C: project label
matches, volume label not in OURS_VOLK → **FOREIGN**. Rule D: name matches
`^nova_`, not in OURS_VOLN → **FOREIGN**. The design's own stated safety net —
*"**Labels exclude, names only add**: a volume whose `com.docker.compose.volume`
label is one of ours is never foreign"* (`:932-934`) — does not help, because
"one of ours" is the pruned set.

The operator then sees §8.2's screen, which prints `nova_v4_tailscale` and
`nova_v4_ollama` in the foreign list **and** prints a block headed *"this
install's volumes, which are NOT in that list:"* containing four names. Typing
`delete` destroys the tailnet node identity — the single asset `move-only`
exists to carry, and the one thing in the whole system that cannot be
regenerated (a new node key is a new node).

**The concrete sequence.** Any one of these is sufficient:

1. **Compose too old.** The design pins no minimum compose version and adds no
   check. `--profile "*"` is a comparatively recent addition; a host with an
   older compose treats `*` as an ordinary profile name that matches nothing —
   my probe showed exactly that behaviour for a non-matching profile (the
   unprofiled render dropped `alpha` and its volumes). `install.sh:7` targets
   bash 3.2 for macOS/BSD hosts; nothing says those hosts' compose is new
   enough.
2. **`COMPOSE_ARGS` at the moment of the call.** `refuse_foreign_project` is
   specified to run "inside `preflight`" (`design-shell-first.md:106`).
   `preflight` (`deploy/install.sh:322-329`) runs before `generate_secrets`,
   before `decide_tailnet` (which appends `--profile tailnet`,
   `deploy/install.sh:609`) and, if placed ahead of `decide_inference`, before
   `--profile inference` (`deploy/install.sh:849`) and the GPU overlay
   (`deploy/install.sh:830`). `COMPOSE_ARGS` is initialised as
   `(-f "$COMPOSE_FILE")` (`deploy/install.sh:49`). So at the call site the
   ours-set is whatever `--profile '*'` alone yields — a single flag between the
   operator and the deletion of his node identity.
3. **Anyone removing the flag as a simplification.** There is no test that
   fails.

**Why §8.4's test cannot catch it.** `test_a_v4_volume_can_never_be_caught`
(`design-shell-first.md:989-1007`) stubs `docker` and *supplies* a fixture in
which all six `nova_v4_*` volumes are present and labelled. The fixture supplies
the very property the test asserts. This is the failure the repo already has a
name for — the fixture stamps what the product does not.

**Smallest fix.** Stop deriving the safety set from a prunable render. Two
changes, both small:

- `OURS_VOLK` := the rendered set **∪ the volume keys parsed from the raw
  compose file text**. `install.sh` already has the awk-over-config-text idiom
  (`config_volume_name`, `deploy/install.sh:405-413`); the same shape over the
  raw `volumes:` block is ~6 lines and profiles cannot touch it.
- Add one mechanical assertion, used by both `refuse_foreign_project` and
  `coverage_plan`: the rendered `config --services` count must equal the number
  of children of `services:` in the raw file(s); otherwise **refuse** with
  *"compose rendered N of M services — this build of compose does not honour
  `--profile '*'`"*. That converts a silent prune into a stated cannot.
- Make §8.4's test a *negative* fixture: render is missing `v4_tailscale` and
  `v4_ollama`, live volumes carry them, assert they are **not** offered.

---

### C2 — a declared volume that no rendered service mounts is invisible to coverage, so MUST #4's "refuses rather than silently skipping" has a hole

**Severity: critical.** MUST #4 (`map-requirements.md:13`): *"coverage derived
from the compose file; an unclassified volume **refuses** rather than silently
skipping."* The whole point, as §4.4 puts it, is that *"What arc 8 forbids is a
list whose failure mode is **silence**"* (`design-shell-first.md:377-378`).

**What breaks.** Measurement (c): `vol_two`, declared under `volumes:` with a
`name:` and an `x-nova-backup` key, **did not appear anywhere in the rendered
output** — not in the `volumes:` block, not in `config --volumes` — because no
rendered service mounted it. §4.2 step (1) iterates "CFG | volume keys". A
volume compose pruned is not *unclassified*; it is **absent**. It never reaches
the `DISP empty -> R1_UNCLASSIFIED` branch (`design-shell-first.md:271`). The
backup carries on and reports success, having silently skipped it.

§4.2 step (3) is the design's stated backstop — *"live containers, INCLUDING
exited ones — catches what compose does not name"* (`:288-291`). It does not
catch this: step (3) finds volumes via `docker inspect` of containers in the
project, and a volume nothing mounts is attached to no container. A volume kept
across a service removal — exactly the "keep the data, drop the service" case a
future slice will hit — is invisible to both.

**The concrete sequence.** A later slice retires a service but keeps its volume
declared so the data survives the transition (or comments out a mount while
debugging). The next `./install backup` reports a complete, verified bundle.
The volume is not in `manifest.volumes` and not in `manifest.excluded` — which
§3.3 calls *"**mandatory and never empty-by-omission**"* (`:200`) — so the
restore cannot even say what it is missing. Then C1's rule D classifies it
FOREIGN and offers to delete it.

**Smallest fix.** Same substitution as C1: build the declared-volume set from
the **raw** compose text and require a disposition for every key in it,
rendered or not. A key present in the file and absent from the render is itself
worth a stated refusal (`R2_PRUNED_VOLUME`) until someone decides what it means
— that is a cannot, not an approval.

---

### C3 — the DoD walk (MUST #28) cannot be executed as designed: restore refuses every carried secret, and `$PACK_IMAGE` does not exist on the target

**Severity: critical.** MUST #28 (`map-requirements.md:37`, `hub-topology.md:318`,
`hub/r2-integration.md:409`): *"walk: back up on the Dell, `restore --drill` on
the mini PC; counts, md5s and the key fingerprint equal."* Both halves are
blocked.

**Half one — `$PACK_IMAGE` is a locally built image.** §5.3: *"`$PACK_IMAGE` is
the core service's image … `pack_image()` reads an explicit `image:` for `core`
… else `printf '%s-core' "$PROJECT"`, then **verifies with `docker image
inspect`** and refuses if it is absent, naming `./install` as the fix"*
(`design-shell-first.md:450-455`). `deploy/docker-compose.yml` carries **no
`image:` for `core`** (verified: the only `image:` lines are `:5` postgres,
`:171` searxng, `:208` ollama, `:243` tailscale). So on the mini PC, before
`./install` has ever run, `nova-core` does not exist and
`./install restore <bundle> --drill` **refuses at step 0**. §7.3 has no fallback
to `meta.fallback_image`, although §5.3 builds exactly that probe for the
*in-bundle* script. The design never states that the drill host must have
completed a full install first.

**Half two — and once `./install` has run on the target, restore refuses.**
`generate_secrets` (`deploy/install.sh:912-927`) writes fresh random values for
`SECRET_KEYS="POSTGRES_PASSWORD CORE_TOKEN CORE_GATEWAY_TOKEN CORE_MEMORY_TOKEN
SEARXNG_SECRET"` (`deploy/install.sh:29`). All five are on §4.4's `carry` list
(`design-shell-first.md:359-362`). §7.2 step 10: *"`.env` … holds a different
value (**conflict**). Verifies zero conflicts. Any conflict → refuse naming
every conflicting key, and **nothing is written** — all-or-nothing"*
(`:766-770`). Five conflicts, guaranteed, on the normal path. There is no
remedy, no `--adopt-env`, no bounded offer. The DoD walk stops here.

**The sequence, end to end.** `./install` on the mini PC (needed for the image
and the postgres bits) → `.env` gets five fresh secrets → `./install restore
<bundle> --drill` → refuses, naming five keys → nothing in the design says what
to do next except hand-edit `.env`, which is the manual step the slice exists to
remove.

**Smallest fix.** Two lines of design, no new machinery:

- §7.3 uses the same backend probe §5.3 already specifies: prefer `$PACK_IMAGE`,
  fall back to `meta.fallback_image` with a printed `docker pull`, and only
  refuse when neither is obtainable. Then a drill needs docker, not an install.
- §7.2 step 10's conflict case adopts §8's exact shape, which the design has
  already argued is not an approval: print every conflicting key **by name**,
  state that overwriting them is what a move means, and require the typed
  literal `adopt`, defaulting to doing nothing. A `--drill` never touches `.env`
  at all (§7.3 step 3 already says so), so the drill half of the DoD stops being
  blocked by it entirely — which is a third, even smaller fix: make step 10
  a no-op under `--drill` and say so.

---

## MAJOR

### M1 — the deletion offer names `nova_tailscale_state` without saying it holds a tailnet node identity, at the exact command `deploy/README.md` tells the operator to run

**What breaks.** Measurement (d): `nova_tailscale_state` is live on this host
with `com.docker.compose.project=nova` and `com.docker.compose.volume=tailscale_state`.
§8.1 rule C classifies it FOREIGN (its volume label is not in OURS_VOLK), and
correctly so — it is v3's. But `deploy/README.md:203-230`, *"Migrating an
existing node (instead of a new key)"*, says of that exact volume: *"move its
identity rather than minting a second node with the same name"*, and its step 5
is **`NOVA_TAILNET=1 ./install`** (`deploy/README.md:224`) — the very command
whose `preflight` now offers to delete it.

**The sequence.** Operator reads `deploy/README.md:203-230`. Runs `./install`
first (to see the health table, or having skipped to step 5, or because step 4's
copy failed and he is retrying). §8.2 prints `nova_tailscale_state` among 5
foreign volumes with the line *"Deleting … is IRREVERSIBLE and destroys whatever
data they hold. Nothing else is touched."* Nothing on the screen distinguishes
it from `nova_ntfy_cache`. He types `delete`. The node identity is gone; the
identity migration the README describes is now impossible and the node must be
re-authenticated under a new key.

Ruling 1 is satisfied *literally* — the object is named. It is not satisfied in
substance: *"the offer states what will be destroyed"* (`rulings.md:28`) and a
volume name is not what will be destroyed. Note also that ruling 1 was about the
**mini PC's** old stack (`rulings.md:8-17`); the design applies the same offer on
every host, including the Dell, where the foreign set is different and includes
this. That scope expansion is not flagged anywhere in the design.

**Smallest fix.** The installer already has the reader. `state_file_on_volume()`
(`deploy/install.sh:439-444`) looks for `tailscaled.state` on a volume through a
throwaway container. Run it over each foreign volume before printing, and
annotate:

```
  nova_tailscale_state   (no compose volume label)
      >> HOLDS A TAILSCALE NODE IDENTITY (tailscaled.state). Deleting it
         means this node must be re-authenticated under a new key.
         deploy/README.md:203-230 copies it into nova_v4_tailscale.
```

Three lines of script, using a function that already exists.

---

### M2 — the writer set is derived from volume mounts only, so `gateway` writes to Postgres throughout the count/dump window (MUST #6)

**What breaks.** MUST #6 (`map-requirements.md:15`): *"`backup`: stop the
writers and verify they stopped."* §7.1 step 8: *"The writer set is derived in
§4 step (2), never listed"* (`design-shell-first.md:625`). §4.2 step (2) records
a writer only from a mount: *"`M.read_only false` -> record S as a WRITER of
M.source"* (`:280`).

Verified against the real file: `gateway` mounts `../data:/data:ro`
(`deploy/docker-compose.yml:83`) and `v4_models:/models` read-write (`:84`).
`v4_models` is `exclude-redownload` in §4.1's table. With the disposition filter
the prose implies (*"postgres is never in it (its volume's disposition is
`dump-pg`)"*, `design-shell-first.md:626`), the writer set is
{core, memory, tailscale-under-move} and **gateway stays running**. Gateway has
`DATABASE_URL: postgresql://gateway:…@postgres:5432/nova_gateway`
(`deploy/docker-compose.yml:77`) and is the service that records spend.

**The sequence.** Step 12 computes counts and md5s against the live server
(`design-shell-first.md:645-652`). Step 13 takes the `pg_dump` snapshot
(`:653-661`). Any gateway write in between — one spend row, one catalog refresh —
puts the dump one row ahead of the counts. Step 14's self-test restore recomputes
and compares to step 12, finds a difference, and *"Any mismatch → refuse, naming
the tables"* (`:670`). So: a backup that is perfectly correct **refuses**, at
random, whenever the gateway is doing its job. Conversely, requirement #6 is not
met — a database writer was never stopped.

**Smallest fix.** Derive the writer set as the union of two facts, both already
in the rendered config: (a) services mounting a carried volume read-write, and
(b) services whose environment carries a `postgresql://…@postgres` URL or whose
`depends_on` names `postgres`. Exclude `postgres` itself by service name, once,
after the union — which is what the prose already wants and the rule does not
say. This keeps "derived, never hardcoded" intact.

---

### M3 — "refuse a non-empty target" (MUST #14) does not cover `v4_pgdata`, the volume holding all three databases

**What breaks.** MUST #14 (`map-requirements.md:23`): *"`restore`: refuse a
non-empty target or an older `pg_restore`."* §7.2 step 7 scopes the check to
*"For every volume **in the manifest**"* (`design-shell-first.md:740`).
`v4_pgdata`'s disposition is `dump-pg` — *"never file-copied; carried as logical
dumps"* (`:249`) — so it is a carried-as-dumps volume whose membership in
`manifest.volumes` versus `manifest.excluded` §3.3 never settles. If it is in
`excluded` (the natural reading of "never file-copied"), the check skips it.

**The sequence.** Operator tries v4 on the mini PC, then `docker compose down`
(containers removed, volumes kept — the documented one-time recreate at
`deploy/README.md:214-215` does exactly this). Later he restores the Dell's
bundle. Step 7 finds no project containers ✓ and iterates `manifest.volumes`,
which does not include `v4_pgdata` ✓. Step 13 does `docker compose up -d
postgres` — onto the **mini PC's old `nova_v4_pgdata`**. Postgres does not run
`deploy/postgres-init/01-databases.sql` because PGDATA is not empty. Step 14
checks the three databases and roles exist — they do, they are the *old* ones —
and proceeds to `pg_restore` into them. `--single-transaction --exit-on-error`
means it errors on the first duplicate object and rolls back, so this ends in a
refusal rather than corruption. But the stated invariant — restores onto an
**empty** target only (`:711`) — is simply not enforced for the one volume that
matters most, and the narrower case (old PGDATA initialised but with empty
databases, e.g. an aborted install) restores into a server whose roles and
passwords are the target's, not the bundle's.

**Smallest fix.** Step 7 iterates the full declared volume set and refuses on any
non-empty volume whose disposition is `include`, `move-only` **or `dump-pg`**.
`exclude-redownload` volumes (`v4_ollama`, `v4_models`) are deliberately exempt —
refusing because the target already has models cached would be wrong.

---

### M4 — a failed restore is a dead end: the tool leaves state its own step 7 then refuses, and there is no cleanup path

**What breaks.** §7's global trap covers *"the stage volume, the `.part` file and
every scratch database and drill volume"* (`design-shell-first.md:593-596`). It
does **not** cover the restore path's own products: the volumes created at step
11 with project labels (`:753-758`) and the postgres container created at step 13
(`:764`).

**The sequence.** Restore reaches step 15 (re-count) and one table differs — or
step 16's key fingerprint differs, or the operator hits Ctrl-C during the
multi-GB extract at step 12. The trap removes the stage volume and scratch DBs.
It leaves: six labelled, partially-populated volumes and a `nova-postgres-1`
container. The operator re-runs the restore. Step 7: *"verifies no container
carries `label=com.docker.compose.project=<project>`; any → refuse and name
them"* and *"Non-empty → refuse, naming it"*. **The disaster-recovery tool now
refuses to run, on state it created itself, and the design contains no verb that
clears it.** `./install` is also unavailable — §8's `refuse_foreign_project`
sees a project whose containers are its own so does not fire, but the half-
populated volumes remain. The operator's only route is hand-run `docker volume
rm` on his only copy of the data, unguided, at the worst possible moment.

This is the shape the design is otherwise excellent at avoiding: it never reports
success it did not check, but here it refuses with no stated way forward.

**Smallest fix.** Write `deploy/.restore-in-progress` (mode 0600) before step 11
naming the bundle, the project and every volume about to be created; remove it at
step 18. On a re-run, if the marker is present and names the same bundle, the
step 7 refusal quotes the marker and offers the §8 shape — the exact objects it
created, the typed literal `discard`, default do nothing. Nothing is discovered;
the marker is the bound. That is a stated cannot plus the operator's own choice,
not an approval.

---

### M5 — `passphrase_fingerprint` is an unsalted `sha256(passphrase)[:12]` in cleartext `meta.json`, which is an offline filter that bypasses scrypt

**What breaks.** §3.4 puts `passphrase_fingerprint` in `meta.json`, *"cleartext,
unauthenticated"* (`design-shell-first.md:207-210`). §3.3 defines it as
*"12 hex = `sha256(passphrase)[:12]`"* (`:189`). §7.1 step 22 prints it in the
report (`:707`) and §7.2 step 4 prints it in a refusal (`:729-731`).

This is a faithful port — v3's `fingerprint()` is
`hashlib.sha256(passphrase.encode("utf-8")).hexdigest()[:12]`
(`backend/app/backup_passphrase.py:151-155`) and v3 does put it in cleartext meta
(`backend/app/backup_snapshot.py:351`). The design inherits the weakness **and
widens the exposure**, because v3's default passphrase came from a secret store
and was always the generated 160-bit one, whereas §6.2 makes `prompt`, `env` and
`cmd` first-class sources whose values a human chooses.

**The sequence.** A bundle travels on removable media (`transport: removable` is
a first-class mode, `:175`) and is lost. The attacker reads `meta.json` without
any passphrase — that is what it is for. The KDF is scrypt n=32768 r=8 p=1, ~34 MB
per guess, deliberately modest *"because the generated passphrase carries 160
bits"* (`:405`). But the attacker does not pay it: he computes plain SHA-256 over
candidate passphrases at GPU speed, keeps the ~2^-48 that match the 12 hex, and
pays scrypt **once** per survivor. Against an operator-typed passphrase the
entire work factor is annulled. It also confirms, for free and offline, that two
bundles share a passphrase.

**Smallest fix.** Keep the function (§7.4 step 5 genuinely needs a
passphrase-free, cross-bundle-comparable identifier) and change its derivation to
one fixed, application-constant salt at the same scrypt cost:
`fp = sha256(scrypt(passphrase, salt=NOVA_FP_SALT, n=32768, r=8, p=1))[:12]`.
It stays comparable across bundles, §7.4 still computes the current one with a
single scrypt run, and a guess now costs 34 MB instead of a hash. Record the
derivation in `crypto` so a later change is readable.

---

### M6 — `MOVED_TO` (MUST #18) is downgraded to an env var the design itself calls bypassable, when the specified placement is not

**What breaks.** MUST #18 (`map-requirements.md:27`, `hub-topology.md:325`):
*"`--move` / `undo-move` write **`MOVED_TO`**; the sidecar refuses to start while
it is present."* The r1 design is explicit about *where*: *"write `MOVED_TO` into
`v4_tailscale`"* (`hub/r1-integration.md:473`), *"`deploy/tailscale/start.sh`
exits 'this node moved to <hub>' when `MOVED_TO` exists"* (`:491`), and the
rationale is stated: *"The refusal then lives at the layer that would cause the
conflict"* (`hub/r1-hubmove-critique.md:62`).

§7.5 instead writes `deploy/.moved` on the host plus `NOVA_MOVED=1` in
`deploy/.env` passed through compose (`design-shell-first.md:854-886`), and then
concedes: *"**Bound, stated:** a `docker run` of the sidecar image by hand
bypasses it; **nothing on the host can prevent that**"* (`:884-886`, emphasis
mine).

That sentence is false, and the sibling design proves it: put the marker in the
directory already bind-mounted into the container at `/config`
(`deploy/docker-compose.yml:290`, and `design-python-tool.md:224` does exactly
this). Then **any** container started from that image with that mount sees it —
`docker run -v ./tailscale:/config` included — and the check lives inside the
thing it governs rather than in the host's `.env`.

There is a real reason not to use r1's literal placement: a marker inside
`v4_tailscale` would be carried by the `move-only` disposition into the bundle
and refuse to start on the **destination**. The design never says this. It
asserts the weakest of the three placements and declares the strongest
impossible.

**Smallest fix.** Write `deploy/tailscale/MOVED_TO` (the directory is
`exclude-code`, so it never travels in the bundle, and it is already mounted
read-only at `/config`). `deploy/tailscale/start.sh` checks `/config/MOVED_TO`
as step 0. Keep `deploy/.moved` as the host-side marker for `install.sh`'s
`refuse_if_moved`. Drop `NOVA_MOVED`, the `.env` key and the compose change
entirely — that is a net simplification as well as a stronger control. Then
replace the "nothing can prevent that" sentence with the real bound: a `docker
run` that does not mount `/config` still bypasses it.

---

### M7 — the outer tar is built on the host, which breaks MUST #24, falsifies the "no host dependency" claim, contradicts §7.1 step 13, and produces a root-owned 0600 file

**What breaks.** Four things from one under-specified step. §7.1 step 18 in full:
*"**Outer tar.** `umask 077`; build `<final>.part`; `chmod 600` before the first
byte; members in the §3.1 order"* (`design-shell-first.md:686-688`). It never
says where it runs, and every surrounding step names its container explicitly.

1. **MUST #24** (`map-requirements.md:33`, `hub/r2-integration.md:400`): *"tars
   built inside throwaway containers."* Not "the inner tar".
2. **`map-portability.md:67` says so directly:** *"`backup.sh` porting this
   should keep the outer-tar step in Python (or a container), not reimplement it
   with the host's `tar` binary."* The design cites `map-portability.md` as a
   binding input (`design-shell-first.md:4`) and contradicts it without
   argument.
3. **§5.3's dependency claim becomes false:** *"Backup adds **no** host
   dependency: bash, docker, and the `openssl` the installer already requires"*
   (`:500-502`). A host tar is a host dependency, with GNU/bsdtar divergence
   (`map-portability.md:67`).
4. **It contradicts step 13 in the same section.** Step 13 puts the dumps in
   *"the **stage volume** (a throwaway docker volume **the host never
   mounts**)"* (`:655-657`), and step 17 writes `payload.enc` there too
   (`:680-683`). A host-side step 18 cannot read a volume the host never mounts.

There is a fifth consequence the design does not consider at all: §5.3 runs the
pack container `--user 0:0` (`:456-458`). If step 18 runs there, `<final>.part`
lands on the host archive directory **owned by root, mode 0600** — and the
operator who ran `./install` (uid 1000) cannot read his own backup. Step 20's
verify (`stat` the mode and size) would pass; the failure surfaces later, when he
tries to copy it.

**Smallest fix.** State that step 18 runs in the pack container (the archive
directory is already mounted `:rw` per §1) using Python's `tarfile`, exactly as
v3 does (`backend/app/backup_snapshot.py:357-361`), and that it `os.chown`s the
result to the invoking uid/gid — passed in on the plan JSON, which already
travels on stdin — then re-reads owner and mode and fails if either is wrong.
That satisfies #24, restores the dependency claim, removes the contradiction and
closes the ownership trap in one paragraph.

---

### M8 — `undo-move` refuses on its own judgement when a peer is online: a "may not", with no path through

**What breaks.** The house rule, quoted in this task's own framing: *a check may
state that something CANNOT be done; it may never decide that it MAY NOT.*
§7.5's `undo-move` step 3: *"verify no online peer carries the archived
`tailnet_dns_name`. **Online → refuse**: bringing this node up would flap the
identity"* (`design-shell-first.md:891-893`). There is no override on that
branch. The adjacent branch — no tailscale CLI — is handled correctly:
*"print 'the check could not be made' — never a pass — and require the typed
literal `undo` to proceed"* (`:893-895`). That one is a stated fact plus the
operator's decision. The online branch is the tool deciding for him.

**The sequence.** The hub's disk fails while its tailscale sidecar is still
reachable on the tailnet (a half-dead host answers `tailscale status` long after
it stops serving). The owner goes to the Dell to bring Nova back. `undo-move`
refuses. There is nothing he can type. His only route is to delete
`deploy/.moved` by hand and unset `NOVA_MOVED` by hand — defeating the whole
marker mechanism, at 3am, under pressure.

Note the design elsewhere gets this exactly right and even argues it: §8.3 item 5
turns a non-TTY into *"refuse and print the `docker rm` lines for the operator to
run by hand"* (`:980-983`), and §8.3's closing paragraph (`:984-988`) is a
careful, correct reading of why the installer's deletion offer is not the thing
`test_no_approvals` guards. The online branch simply does not follow its own
reasoning.

**Smallest fix.** Make it identical to the no-CLI branch: name the peer and when
it was last seen, state plainly that bringing this node up while that peer is
online will flap the node key, require the typed literal `undo`, default to doing
nothing. One `case` arm.

---

### M9 — the per-table md5 recipe has a hard size ceiling and depends on GUCs the design does not pin

**What breaks.** §7.1 step 12 (MUST #7): *"`SET TimeZone='UTC'; SELECT count(*),
md5(string_agg(t::text,'' ORDER BY t::text)) FROM <table> t`"*
(`design-shell-first.md:645-648`), and *"A table that errors (an un-castable
type) → refuse, naming it — never skipped"* (`:650-651`).

1. **Ceiling.** `string_agg` materialises the whole table as **one `text`
   value**. PostgreSQL's hard limit on a single varlena is 1 GB; past it the
   query fails with `invalid memory alloc request size`. That is not an
   un-castable type, but it lands in the same branch: **refuse**. Once any table
   crosses roughly a gigabyte of text representation, every backup refuses
   forever, and the design offers no escape because it (rightly) refuses to add
   a skip. The `ORDER BY` also forces a full sort of that text.
2. **Rendering GUCs.** The design pins `TimeZone` — a genuinely good catch — and
   nothing else. `t::text` rendering is also governed by `DateStyle`,
   `IntervalStyle`, `extra_float_digits` and `bytea_output`, all of which are
   settable per-database and per-role (`ALTER DATABASE … SET`). The source
   server may carry one; the restored server, freshly initialised by
   `deploy/postgres-init/01-databases.sql:13-20`, will not. Step 15 then compares
   two correct renderings of the same data, finds them different, and refuses a
   good restore — after the whole multi-GB extract.

**Smallest fix.** Both are one line each.

- Replace the aggregate with a constant-memory, order-independent one:
  `SELECT count(*), sum(('x'||substr(md5(t::text),1,16))::bit(64)::bigint) FROM t`.
  No 1 GB value, no sort, same failure sensitivity for the purpose.
- Pin the rendering on **both** sides in the same statement:
  `SET LOCAL TimeZone='UTC'; SET LOCAL DateStyle='ISO, MDY'; SET LOCAL
  IntervalStyle='postgres'; SET LOCAL extra_float_digits=0; SET LOCAL
  bytea_output='hex';` and record the pinned set in the manifest's `crypto`-like
  sibling so a future change to it is visible as a frame change rather than a
  mismatch.

---

### M10 — MUST #27 and MUST #20 are discharged by a CI job the design says will not run

**What breaks.** MUST #27 (`map-requirements.md:36`, `hub/r2-integration.md:406`):
*"CI runs `install_test.sh` and `backup_test.sh` on `macos-15` under
`/bin/bash`."* MUST #20 (`:29`): *"`deploy/backup.sh` + `install.sh` bash-3.2
portable."*

§11.4 builds the job and then states, honestly, that it is inert:
*"the workflow triggers only on `rebuild/**` (`.github/workflows/rebuild-ci.yml:3-7`),
so nothing in it runs on `slice/**` or `main` … The macOS job is checked in and
**will not fire** until the trigger is widened. That is the owner's call, not
this design's"* (`design-shell-first.md:1240-1246`).

Verified — `.github/workflows/rebuild-ci.yml:3-7` is exactly:

```
on:
  push:
    branches: ["rebuild/**"]
  pull_request:
    branches: ["rebuild/**"]
```

Raising it to the owner is right. Recording it as satisfying #27 is not: after
S41 lands, the requirement's own artifact exists and has never executed, and
`map-portability.md:270` already says *"**Nothing here runs `install_test.sh`
under an actual bash 3.2, and nothing…**"*. Meanwhile §13.4 concedes the bash-3.2
discipline *"is currently enforced by nothing but code review"* and names one
existing bash-4-ism (`deploy/tailnet_topology_test.sh:248`). So #20 has no
enforcement either.

**Smallest fix.** Take the measurement §13.4 already proposes and make it a CI
step in the **`installer`** job, which does run wherever the workflow is enabled:
`docker run --rm -v "$PWD:/w" bash:3.2 bash -n /w/deploy/*.sh`. That is a real
bash 3.2 parser, on Linux, needing no macOS runner. Keep the `macos-15` job for
the BSD-userland pins (`shasum`, `netstat -rn`, `stat -f`) and say plainly in
the slice record that #27 is **deferred, not met**, pending the trigger decision.

---

### M11 — §13.9 asserts a concurrency control that does not exist

**What breaks.** §13 risk 9: *"Two concurrent backups … The control is the
`mkdir` lock (§6.3) plus the `.part`-then-rename collision loop"*
(`design-shell-first.md:1338-1341`). Both halves are wrong.

- §6.3's lock is `mkdir "$DEPLOY_DIR/.backup-passphrase.lock"` and it guards
  **passphrase creation only**: *"Two concurrent backups cannot each generate
  one"* (`:551-556`). It is taken and released inside the resolver. It does not
  span a backup run.
- §3.1's collision loop tests `<final>`: *"A collision loop appends `-2`, `-3` …
  if `<final>` exists"* (`:146-149`). Two backups started in the same second
  compute the same `<final>`, see it absent, and both write **`<final>.part`** —
  which the loop never tests. They interleave into one file; one of them then
  passes step 19's round-trip verify (or neither does) and renames.

This is the design's own standard applied to itself: it states a control it did
not check. It is also the one place where the failure could produce a bundle that
verifies and is wrong, since the verify reads the same `.part` both writers are
touching.

**Smallest fix.** Take a run-level lock the way §6.3 already knows how:
`mkdir "$DIR/.nova-backup.lock"` at step 1, released in the EXIT trap, second
runner refuses with *"a backup is already running (lock held since <stamp>)"* —
a stated cannot. And create the `.part` with `set -o noclobber` / `O_EXCL` so
even without the lock the second writer fails loudly rather than interleaving.

---

### M12 — the migration gate can refuse a correct restore, by the design's own admission, with no path through

**What breaks.** §7.2 step 9 is admirably honest: *"this is filename-only and a
*renumbered* migration will false-refuse — exactly the bug v3 closed with a
checksum (`backend/app/backup_apply.py:115-122`) … There is no override flag: an
override that proceeds is a fallback that reads as success"*
(`design-shell-first.md:756-762`).

Verified: `services/core/app/migrations_runner.py:19-24` is
`CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY,
applied_at timestamptz …)` — no checksum column, as stated.

The honesty is right; the conclusion is not. A *renumbered* migration is a
**correct** bundle being refused. The operator's only copy of his Nova will not
restore, the tool says why, and offers nothing. The reasoning that rules out an
override ("a fallback that reads as success") is sound, but it rules out the
wrong thing: the fix is not an override, it is to stop asking the question
wrongly.

**Smallest fix, and it needs no migration** (so requirement #31 holds). The gate
compares a list of *filenames* recorded at pack time against the checkout's
files. Record content hashes of those files instead — computed at **backup**
time by hashing `services/<svc>/migrations/<filename>` on disk, which is a file
read, not a schema change. `manifest.migration_match` becomes `"content"`. A
renumbered migration with identical content then matches; a genuinely different
migration still refuses, more accurately than before. The `members` array already
carries `{path, sha256}` per member (`:196`), so the shape exists.

---

## MINOR

**m1 — §7.1 step 3 needs step 5's output.** Step 3 free-space checks *"each
included volume and bind"* (`design-shell-first.md:604-609`), but the included
set is produced by coverage at step 5 (`:615-620`). As numbered, step 3 cannot
run. Fix: move coverage to step 3, or state that step 3 uses a provisional plan.

**m2 — `sum * 1.15` is not bash arithmetic, and the units do not match.** Step 3
compares `du -sk` (kilobytes) against `detect_disk_free_gb`
(`deploy/install.sh:92-93`, which is `df -Pk … $4/1024/1024` **truncated to
integer GB**). Bash `$(( ))` has no floats, so `sum * 1.15` must be
`sum * 115 / 100`; and a KB sum compared to truncated GB free rounds up to a
whole gigabyte of slack in the wrong direction. Fix: work in KB on both sides —
`detect_disk_free_kb()` is the same `awk` without the two divisions.

**m3 — the emptiness probe can populate the volume it is checking.** §7.2 step 7
mounts each existing volume into a throwaway `$PG_IMAGE` container to `ls -A` it
(`:740-744`). Docker copies image content into a **new, empty** named volume on
first mount. If the probe mounts at a path the image populates, the check itself
makes the volume non-empty, and the next run refuses. Fix: mount at a path that
does not exist in the image (`/probe`), and say so.

**m4 — no portable `date` for "age in days".** §7.4 step 6 reports *"its age in
days"* (`:848`). `map-portability.md:63` records that macOS `date` has **no
`-d`**, and there is no portable epoch-from-string form. Fix: sort bundles
lexicographically (the `YYYYMMDDTHHMMSSZ` stamp sorts correctly, so step 3's
"newest" is already safe) and compute days with `date +%s` for *now* plus a
days-from-civil arithmetic on the stamp's digits — or print the stamp and drop
the age.

**m5 — the writer-set rule contradicts its own prose.** §4.2 (2) as written —
*"`M.read_only false` -> record S as a WRITER of M.source"* (`:280`) — puts
`postgres` in the set (it mounts `v4_pgdata` read-write,
`deploy/docker-compose.yml:12`). §7.1 step 8's prose says postgres is never in
it. Under the disposition filter that reconciles them, `ollama` also leaves the
set — but §7.1 never says whether ollama is stopped for a routine backup, which
is a real availability answer the operator needs. Fix: state the filter as a rule
in §4.2, not as an aside in §7.1. (See M2 for the substantive half.)

**m6 — `COMPOSE_FILE` is not in `deploy/.env.example`, so §4.2 (5) refuses on day
one.** §4.4 lists `COMPOSE_FILE` under `host` as though it were a key there
(`:359-361`). Verified: `.env.example` has 11 uncommented keys and `COMPOSE_FILE`
is not among them (`POSTGRES_PASSWORD:5`, `CORE_TOKEN:6`,
`CORE_GATEWAY_TOKEN:7`, `CORE_MEMORY_TOKEN:8`, `SEARXNG_SECRET:12`,
`NOVA_PUBLIC_GATE_TOKEN:20`, `NOVA_WEB_ADDR:32`, `NOVA_TAILSCALE_ADDR:33`,
`TS_AUTHKEY:46`, `TAILNET_HOSTNAME:49`, `COMPOSE_PROFILES:58`). But
`record_compose_files` (`deploy/install.sh:955-963`) writes `COMPOSE_FILE` into
every real `.env`. So `R6_UNDECLARED_ENV_KEY` fires on the first backup of every
existing install. §4.4 already solves this shape for `INSTANCE_SECRET` (a
commented-out declared key); apply it to `COMPOSE_FILE` and say so. I could not
diff a live `deploy/.env` — it does not exist in this worktree — so the full
day-one list is unmeasured; §13.5's one-command measurement still owes an answer.

**m7 — "measured in this session against compose v5.5.1" is not this session.**
`design-shell-first.md:230` and `:447-450`. This session's compose answers
v5.3.0 (measurement (a)). The *substance* of both claims is true — I reproduced
them on v5.3.0 (measurement (b)) — so this is a provenance error, not a wrong
fact. But in a document whose opening promise is *"Nothing in this document
reports a result I did not check"* (`:10-11`), an unreproducible provenance line
is the one thing that makes a reader stop trusting the rest. Fix: state the host
and version actually used, and check the fixtures in (§13 risk 2 already asks
for this).

**m8 — six line-cites drift by 2-3 lines.** `config_project_name` is at
`deploy/install.sh:399-401`, not `:401-403` (`design-shell-first.md:265`).
`config_volume_name` is at `:405-413`, not `:408-418` (`:268`).
`compose_project_name` is at `:444-448`, not `:446-450` (`:904`).
`config.Save` is at `apps/novad/internal/config/config.go:78`, not `:75`
(`:1097`); `config.Load` at `:100`, not `:98` (`:1072`). `main.go`'s switch
starts at `:40`, not `:39` (`:1068`). `useradd … appuser` is
`services/core/Dockerfile:12`, not `:13` (`:458`). Everything else I sampled was
exact — including the harder ones: `install.sh:1130-1137` (main's case),
`:1139-1141` (the entry guard), `:85-90`, `:92-93`, `:880-899`, `:1025-1054`;
`install_test.sh:13`, `:19-27`, `:62-72`, `:266`, `:317`;
`docker-compose.yml:5,13,83,185,290,332-334,336-351`;
`011_devices.sql:19-23`; `devices_ws.py:288-289`; `migrations_runner.py:19-24`;
`test_no_approvals.py:25,267,274`; `pyproject.toml:11`; and every v3 cite I
checked (`backup_crypto.py:10-16,17-19,57-64,169-171,238-245`,
`backup_coverage.py:48-52`, `backup_snapshot.py:201-213,284-289,420-427`,
`backup_passphrase.py:55-73`). Fix: re-run the cites once before the slice
record lands.

**m9 — the drill network takes whatever subnet docker hands it.** §7.3 step 2
creates `nova_drill_${D}_net` with no IPAM (`design-shell-first.md:810-814`) on a
host where 172.17-172.21 are already in use (`map-requirements.md:96`). It will
consume the next free block — possibly the one `decide_subnet` was about to pick
for the real restore. Harmless but noisy; fix: allocate it from §9's
`pick_project_subnet` with the project network excluded, or tear it down before
`decide_subnet` runs.

**m10 — `openssl rand 20` sends raw bytes through the shell.** §6.3 generates the
passphrase as *"160 bits (`openssl rand 20`), base32 lowercase … The base32
encoding is done by `novabundle.py genpass` in the container"* (`:546-549`). If
those 20 raw bytes are captured with `$( )` rather than piped, bash drops NUL
bytes and strips trailing newlines — roughly 1 in 13 generated passphrases would
silently carry less than 160 bits, undetectably. v3 avoids this entirely by doing
it in Python: `base64.b32encode(secrets.token_bytes(20))`
(`backend/app/backup_crypto.py:244-245`). Fix: delete the host step; `genpass`
generates its own bytes. That also drops one use of the `openssl` dependency.

**m11 — `drill`'s sweep and `backup`'s self-test share the `nova_verify_*`
namespace on the live server.** §7.1 step 14 creates `nova_verify_<8hex>` on the
**live** postgres (`:663-673`); §7.4 step 1 sweeps *"orphaned `nova_verify_*`
databases"* with no stated test for "orphaned" (`:830-834`). A `drill` started
while a `backup` is mid-self-test will try to drop the live run's scratch
database. `DROP DATABASE` fails while a connection is open, so nothing is
destroyed — but §7.4 step 1 then says *"Anything that will not go → report and
fail"*, so the drill reports a failed drill for a perfectly healthy system. Fix:
give the backup's scratch databases their own prefix (`nova_selftest_*`), or
make "orphaned" mean "no connections and created more than an hour ago" and say
which.

---

## Requirements sweep — MUSTs in `map-requirements.md` §1 the design does not satisfy

| # | MUST | Status |
|---|---|---|
| 4 | coverage derived from compose; unclassified **refuses** rather than silently skipping | **Hole** — a declared, unmounted volume is pruned from the render and is therefore invisible, not unclassified (**C2**) |
| 6 | `backup`: stop the writers and verify they stopped | **Not met** — database writers are never derived; `gateway` keeps writing `nova_gateway` (**M2**) |
| 7 | per-table row counts and md5s | Met, with a 1 GB ceiling and unpinned rendering GUCs (**M9**) |
| 14 | `restore`: refuse a non-empty target | **Partial** — `v4_pgdata`, which holds all three databases, is outside the check (**M3**) |
| 18 | `--move`/`undo-move` write `MOVED_TO`; the sidecar refuses while present | **Weakened** — renamed to `NOVA_MOVED` in `.env`, a mechanism the design itself calls bypassable (**M6**) |
| 20 | `backup.sh` + `install.sh` bash-3.2 portable | **Unenforced** — §13.4 concedes code review is the only check (**M10**) |
| 24 | tars built inside throwaway containers | **Not met for the outer tar** (**M7**) |
| 27 | CI runs both suites on `macos-15` | **Not met** — the job cannot fire on this branch and the design says so (**M10**) |
| 28 | the walk: back up on the Dell, `restore --drill` on the mini PC | **Blocked** — no `nova-core` image on the target; five `.env` conflicts with no remedy (**C3**) |
| 29 + ruling 1 | installer names a foreign `nova` project, then offers to delete **only** what it named; a v4 volume must be untouchable | **Not met** — two v4 volumes fall out of the ours-set (**C1**); the offer does not say which named volume holds a node identity (**M1**) |

Satisfied as designed, and checked: #1, #2, #3, #5, #8, #9, #10, #11, #12, #13,
#15, #16, #17, #19, #21, #22, #23, #25, #26, #30, #31, #32, #33.

## Approval-shape check

I looked specifically for a gate that decides on the owner's behalf. The design
is mostly disciplined about this and argues it explicitly and correctly at
§8.3's closing paragraph (`design-shell-first.md:984-988`) — including the
correct observation that `test_no_approvals.py` scans `services/core/app/` only,
which I verified (`services/core/tests/test_no_approvals.py:25,267,274`), and
that S41 adds nothing there.

One violation: **M8**, `undo-move`'s online-peer branch, which refuses outright
with nothing to type. Two near-misses that are correct as written and should
stay: §8.3's non-TTY refusal (a stated cannot with the commands printed) and
§6.2's `prompt`-without-a-TTY (the design labels it *"a stated cannot, not an
approval"*, `:541`). One place where the *absence* of a path is the problem
rather than its presence: **M12**'s migration gate and **C3**'s `.env` conflict,
both of which refuse correctly and then leave the operator with nowhere to go.

---

## Verdict

**SOUND-WITH-FIXES** — 3 critical, 12 major, 11 minor.

Nothing here is a reason to abandon the stance. The three criticals are two root
causes: *derive the ours-set from a source compose cannot prune* (C1, C2 — the
same six-line change fixes both), and *the DoD walk needs an image fallback and
a bounded `.env` answer* (C3). The majors are each a paragraph of design, and
several of them (M5, M7, M9, M10, M12) make the design simpler rather than
larger.

### The three things this stance does better than the other two would

1. **The host script never touches a byte of data or a key, so portability stops
   being a crypto problem.** §5.2's rejection of `openssl enc` is the sharpest
   argument in any of the three documents, and it is measured rather than
   asserted: `openssl enc` and `openssl kdf` take the key and passphrase **in
   argv**, so a shell-native cipher puts the backup passphrase in `ps` output
   and in `docker inspect`. The answer — the shell decides and refuses, a
   container in the core image does the AEAD with the passphrase on stdin — is
   what lets a bash-3.2 script ship real authenticated encryption of many
   gigabytes without a single portability compromise. A python-tool stance gets
   the crypto for free but owes a host python; a v3-port stance owes v3's whole
   service shape. This one owes neither.

2. **Coverage lives in the compose file, next to the thing it describes, and I
   confirmed it survives the render on both volumes and long-syntax binds.**
   That is the cleanest available reading of MUST #4. A `BACKUP_EXCLUDE_DATA`
   list — or any file kept separately from the stack — fails silently when the
   stack changes; this one cannot, because the set and the dispositions come out
   of the same document in the same call. §4.4's own self-interrogation
   (*"Is this a hand-kept list by another name? Partly, and the distinction is
   the whole argument"*) is the right instinct, and the answer is right: the
   failure mode is a refusal, not silence. C2 is a hole in the mechanism, not in
   the idea.

3. **Every step states what it verifies and what it does when the verification
   fails, and the honest degrades are labelled as degrades.** §7's convention —
   *"A step that cannot verify its own result FAILS and says why. No step has a
   fallback that reads as success"* — is carried through step by step, and the
   hard cases are the ones it gets right: step 8 restarts what it stopped and
   refuses rather than assuming a container stopped; step 21 reports "the bundle
   is written" and "the stack did not come back healthy" as **two separate
   facts**; §7.2 step 18 will not print the word `verified` at all unless steps
   12, 15 and 16 all ran; §7.4 step 2 makes *zero bundles a FAILED drill* rather
   than a vacuous pass. The places where it slips (M11's asserted lock, the
   §13.4/§11.4 CI gap) are slips against a standard the document itself sets
   and mostly meets — which is why they were findable at all.
