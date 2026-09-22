# Adversarial critique — `design-port-v3.md`

Written 2026-09-21 on `slice/s41`. Read-only: nothing was deployed, restarted,
mutated or committed. Every finding below carries either a `path:line` or the
exact read-only command that produced it, run in this worktree on 2026-09-21.

Binding inputs I checked the design against: [`rulings.md`](rulings.md),
[`map-requirements.md`](map-requirements.md) (the 33 numbered bullets, cited as
`#n`), [`map-portability.md`](map-portability.md), [`map-deploy-data.md`](map-deploy-data.md),
[`map-v3-backup.md`](map-v3-backup.md).

**What I did not do:** I did not run `install.sh`, `docker compose up`, any
`docker rm`, any write to a volume, or any psql write. Two findings (C1, C2)
are grounded in live read-only `docker` queries against this machine's running
stack; every other finding is grounded in source lines.

**Summary:** 2 critical, 11 major, 10 minor. Verdict at the end.

---

## CRITICAL

### C1 — the foreign-volume classifier deletes `nova_v4_ollama`

**Severity: critical.** This is the exact thing `rulings.md:25-26` says must be
impossible: *"It must be impossible for that path to touch a v4 volume."*

**What breaks.** §8.1 derives the "ours" set as:

```
ours_volumes   = compose_config_text | config_volume_keys         # NEW, sibling of :402-411
```

`compose_config_text` is an existing function and the design reuses it by name.
It is:

```sh
compose_config_text() {
  docker compose "${COMPOSE_ARGS[@]}" --profile tailnet config 2>/dev/null
}
```
`deploy/install.sh:394-396`

It passes **only** `--profile tailnet`. `COMPOSE_ARGS` starts as
`(-f "$COMPOSE_FILE")` (`deploy/install.sh:49`) and gains `--profile inference`
only inside `decide_inference`, the last step of `preflight`
(`deploy/install.sh:322-329`) — and **not at all** when inference is off.

`docker compose config` prunes a top-level volume whose only consumer is a
disabled profile. **Measured** (compose v5.3.0, docker 29.6.1, this worktree):

```
$ P='python3 -c "import json,sys;print(sorted((json.load(sys.stdin).get(\'volumes\') or {}).keys()))"'

$ docker compose -f deploy/docker-compose.yml --profile tailnet config --format json 2>/dev/null | eval $P
['v4_memdata', 'v4_models', 'v4_pgdata', 'v4_tailscale', 'v4_workspace']                  # 5

$ docker compose -f deploy/docker-compose.yml --profile tailnet --profile inference \
    config --format json 2>/dev/null | eval $P
['v4_memdata', 'v4_models', 'v4_ollama', 'v4_pgdata', 'v4_tailscale', 'v4_workspace']     # 6
```

So `ours_volumes` is missing `v4_ollama`. §8.1's rule is *"Foreign iff the
volume key is not in `ours_volumes`"*, and **measured** on this machine:

```
$ docker volume ls --filter "label=com.docker.compose.project=nova" \
    --format '{{.Name}}|{{.Label "com.docker.compose.volume"}}'
...
nova_v4_ollama|v4_ollama
...
```

`nova_v4_ollama` carries key `v4_ollama` → **classified foreign → printed under
"Foreign volumes" → deleted on confirmation.**

**The concrete sequence.**
1. Operator hits install.sh's own documented recovery for a busy ollama port —
   `NOVA_SKIP_INFERENCE=1 ./install` (the text is at `deploy/install.sh:315-318`),
   or simply runs on a host where a host ollama holds the port, which sets
   `BUNDLED_INFERENCE=0` and never adds the profile (`deploy/install.sh:247-252`).
2. `preflight` → `check_foreign_project` → `compose_config_text` renders five
   volume keys.
3. `nova_v4_ollama` is classified foreign and printed in the delete block.
   Nothing in the block is wrong on its face — it *is* named first — so the
   operator sees a plausible list and types the phrase.
4. `docker volume rm nova_v4_ollama` succeeds, because the ollama container is
   not running (that is why the profile is off).
5. §8.3's post-condition #2 is *"every volume key in `ours_volumes` that existed
   before still exists"*. `v4_ollama` is not in `ours_volumes`, so the check
   **passes**. The step reports success.
6. The one volume just destroyed is `EXCLUDE_REDOWNLOAD` in `VOLUME_POLICY`
   (§4.6) — so no bundle ever made has a copy of it.

**Why §8.4's test does not catch it.** `foreign_volumes_never_names_a_v4_volume`
uses *"a compose-config stub returning this repo's real `volumes:` block"* —
i.e. all six keys. The fixture supplies what the product does not. That is the
`fixture-stamps-what-the-product-doesnt` failure mode by name.

**The design contradicts itself here.** §4.1's `compose.json` renderer is
specified as `--profile inference --profile tailnet config --format json`, with
the reason spelled out: *"**Every** profile, always, whatever is enabled: a
profile-gated service that is off still owns its volume"*. §8.1 then reaches for
a helper that does the opposite, for the more dangerous of the two uses.

**Smallest fix.** Two lines, both needed:
1. `ours_volumes` must be rendered with every profile — a new
   `compose_config_text_all_profiles()` that adds `--profile inference
   --profile tailnet`, used by `config_volume_keys`/`config_service_keys`, and a
   refusal (not an empty set) when the render exits non-zero or yields no
   `volumes:` block at all.
2. Post-condition #2 must be *"every labelled volume that was **not** in the
   printed foreign list still exists"*, computed from the same `docker volume
   ls` capture — not from `ours_volumes`. As written it is vacuous exactly when
   the ours-set is wrong, which is the only case it needed to catch.

Add a fourth §8.4 case: with `--profile inference` absent from `COMPOSE_ARGS`,
`foreign_volumes` still classifies `v4_ollama` as ours.

---

### C2 — `ANON_POLICY` is empty, a v4 service has an anonymous volume, and every backup refuses on day one

**Severity: critical.** It breaks `#1` (ship a complete encrypted bundle): no
bundle is ever written.

**The design's claim, §4.6:**

> `ANON_POLICY` — empty today. **Measured**: `docker ps -a --filter
> label=com.docker.compose.project=nova` plus `docker inspect .Mounts` shows no
> anonymous volume on any v4 service.

**That claim is false.** Measured, same command family, this machine, now:

```
$ docker inspect nova-searxng-1 --format '{{range .Mounts}}{{.Type}} | {{.Name}} -> {{.Destination}}{{"\n"}}{{end}}'
bind   |                  | /…/searxng          -> /etc/searxng
volume | 289bbf48…6210ca  |                     -> /var/cache/searxng

$ docker inspect searxng/searxng:latest --format '{{json .Config.Volumes}}'
{"/etc/searxng":{},"/var/cache/searxng":{}}

$ docker volume inspect 289bbf48…6210ca --format '{{json .Labels}}'
{"com.docker.volume.anonymous":""}
```

`searxng` is a v4 service (`deploy/docker-compose.yml:162`), it comes up with the
base stack with no profile, its image declares `VOLUME /var/cache/searxng`, and
the resulting volume is anonymous and carries **no** compose project label — so
`volumes.json` (§4.1 source 3) cannot see it and `containers.json` (source 2)
can, which is precisely what §4.1 says source 2 is for.

**What the algorithm then does** (§4.2 step 2): name matches `^[0-9a-f]{64}$` →
anonymous → `ANON_POLICY[("searxng", "/var/cache/searxng")]` → **miss** →
`UNCLASSIFIED` → `R1_UNCLASSIFIED` → §4.3: exit 3, nothing written. **Every
`./install backup` on a healthy v4 stack refuses.**

**The design deleted the row it needed.** §4.6's last paragraph:

> Dropped from v3 outright, because the services do not exist in v4's compose
> (`:4-329`): … and the `searxng` `ANON_POLICY` rows.

`searxng` is declared at `deploy/docker-compose.yml:162` — inside the very
`:4-329` span the sentence cites. And v3's two rows are exactly the two the port
needs:

```python
ANON_POLICY: dict[tuple[str, str], tuple[str, str]] = {
    ("searxng", "/etc/searxng"):      (EXCLUDE_CODE, "searxng's generated runtime config. …"),
    ("searxng", "/var/cache/searxng"): (EXCLUDE_EPHEMERAL, "a search result cache; regenerates on use"),
}
```
`backend/app/backup_coverage.py:332-341`

**Why CI stays green.** §11.3's `test_coverage_v4_real.py` runs coverage *"over
the checked-in `fixtures/compose-v4.json` plus a checked-in ignored-path scan"*.
There is no containers fixture, and the anonymous volume exists **only** in
`docker inspect` output. The suite asserts zero refusals and passes; the product
refuses. §13's risk 9 calls `test_coverage_v4_real.py` *"the alarm … a red suite
at commit time, not a failed backup at 3am"* — for this class of drift it is not
an alarm at all.

**Smallest fix.**
1. Restore the two searxng rows into `ANON_POLICY`, keyed `(service,
   destination)` exactly as v3 has them.
2. Add `deploy/backup/fixtures/containers-v4.json`, captured from `docker ps -a
   --filter label=com.docker.compose.project=<p>` + `docker inspect .Mounts` on
   a live v4 stack, and make `test_coverage_v4_real.py` consume it alongside the
   compose fixture. Without a containers fixture the "drift alarm" cannot see
   the one source that produces anonymous and image-declared volumes.
3. State in `deploy/README.md` how to refresh both fixtures, because
   `searxng/searxng:latest` is deliberately unpinned (`deploy/docker-compose.yml:162-171`)
   — the next upstream image that adds a `VOLUME` line reproduces this bug.

---

## MAJOR

### M1 — restore's non-empty-target refusal never looks at `nova_v4_pgdata`

**Severity: major.** Falls short of `#14`: *"MUST — `restore`: refuse a
non-empty target or an older `pg_restore`."*

§7.2 step 3: *"For each volume **the bundle carries**, `docker volume inspect
nova_<key>`; if it exists, probe it … and refuse if non-empty."*

`v4_pgdata` is `INCLUDE_PG` (§4.6) — *"captured by `pg_dump` per database and
never as files"* — so it has no `volumes[]` row in the manifest (§3.2) and no
`volumes/v4_pgdata.tar` member (§3.1). **The bundle does not carry it, so step 3
never inspects it.** The single most important non-empty target on the machine
is the one the check cannot see. The second half of step 3 ("refuse if any
container carries `com.docker.compose.project=<project>`") catches containers,
not volumes, and `docker compose down` removes containers while keeping volumes.

**A sequence that reports success and leaves a broken stack.**
1. Target host previously ran `./install` once; postgres initialised
   `nova_v4_pgdata` with `POSTGRES_PASSWORD=<target-secret>` via
   `deploy/postgres-init/01-databases.sql`. Core never started, so the three
   databases are empty. `docker compose down` was then run: containers gone,
   volumes kept, `deploy/.env` deleted along with the checkout (or the operator
   re-cloned).
2. `./install restore <bundle>`. Step 3: `nova_v4_memdata` and
   `nova_v4_workspace` do not exist (memory/core never ran) → nothing to refuse.
   No containers exist → nothing to refuse. **Passes.**
3. Step 6: `deploy/.env` absent → the carried `.env` is written, carrying
   `POSTGRES_PASSWORD=<source-secret>`.
4. Step 7 creates the two volumes; step 9 `up -d postgres`. `postgres-init` runs
   **only on a fresh PGDATA**, so it is skipped; the cluster keeps
   `<target-secret>`. `pg_isready` answers without authenticating, so step 9's
   "verifies healthy" passes.
5. Step 10 `pg_restore` runs *inside the postgres container* as the superuser
   over the local socket — it does not use `POSTGRES_PASSWORD` — and succeeds.
   Step 11's census matches. Step 12 parks and prints `./install` as next.
6. `./install` brings up core, gateway and memory, which authenticate over TCP
   with `<source-secret>` against a cluster holding `<target-secret>`, and every
   one of them fails to connect.

The restore said it verified counts and md5s and it did. It still produced a hub
that cannot open its own database, and it did so by writing into a cluster it
never admitted was there.

**Smallest fix.** Step 3's loop must run over **every volume key
`config_volume_keys` declares**, not over `manifest.volumes` — refusing any that
exists and is non-empty, with `v4_pgdata` named explicitly in the refusal text
("a postgres cluster already exists on this host; restore writes into an empty
machine"). That is one changed input to an existing loop.

---

### M2 — `decide_subnet` at restore: §9 and §7.2 contradict, and both branches are broken

**Severity: major.** Touches `#12` (decide_subnet first) and the primary
bare-machine flow.

§9 step 3 specifies the write: *"Else `pick_project_subnet`,
`derive_subnet_addrs`, `set_env_value` × 5"*, and step 4: *"Verifies: the five
keys **read back from `.env`**"*.

§7.2 step 1 specifies the opposite: *"**Ordering trap, stated because it is easy
to get wrong:** the values are held in shell variables here and are written to
`.env` only at step 6, after the carried `.env` lands."*

Only one can be true, and each is broken:

- **If `decide_subnet` writes** (§9), it calls `set_env_value`, which is:

  ```sh
  set_env_value() {
    local key="$1" value="$2" line tmp replaced
    tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
    …
    done < "$ENV_FILE"
  ```
  `deploy/install.sh:880-893`

  On a bare restore target `deploy/.env` does not exist. The
  `done < "$ENV_FILE"` redirect fails, and `install.sh` runs under `set -euo
  pipefail` (`deploy/install.sh:8`), so **restore dies at step 1 on exactly the
  machine it exists for**, leaving a `deploy/.env.XXXXXX` behind. `cmd_install`
  never hits this because `generate_secrets` copies `.env.example` first
  (`deploy/install.sh:912-916`).

  And if `.env` *were* created first, step 6's rule — *"If one does [exist],
  compare the carried `SECRET_KEYS` … any difference → refuse naming the keys
  that differ"* — sees a five-key file with none of
  `POSTGRES_PASSWORD CORE_TOKEN CORE_GATEWAY_TOKEN CORE_MEMORY_TOKEN
  SEARXNG_SECRET` (`deploy/install.sh:29`) and **refuses every restore**.

- **If `decide_subnet` holds** (§7.2), §9 step 4's "verifies the five keys read
  back from `.env`" has nothing to read, so the one verification that proves the
  subnet decision actually landed is skipped on the restore path.

**Smallest fix.** Give `decide_subnet` an explicit mode: `decide_subnet write`
(install) and `decide_subnet hold` (restore), with the five values exported as
shell variables in both cases and the read-back verification moved to whoever
does the writing. Separately, make `set_env_value` create `$ENV_FILE` when
absent (`: > "$ENV_FILE"` before the loop, or `done < "$ENV_FILE" 2>/dev/null ||
true` is *not* acceptable — it would swallow a real read failure); and enumerate
the "host-specific keys" step 6 rewrites, since §7.2 names them only as a class.

---

### M3 — the volume-tar command turns a failed `tar` into exit 0

**Severity: major.** A fallback that reads as success, in the step that captures
Nova's notes.

§7.1 step 11, verbatim from the design:

```
sh -c 'tar -C /src --numeric-owner -cf /out/volumes/<key>.tar . && \
       cd /src && find . -type f | LC_ALL=C sort > /tmp/f && \
       [ -s /tmp/f ] && xargs -a /tmp/f sha256sum > /out/volumes/<key>.listing || : > /out/volumes/<key>.listing'
```

`||` binds to the whole `&&` chain. If `tar` fails — a full `/out`, a read error
on a file, a permission problem — the chain short-circuits to `: >
/out/volumes/<key>.listing`, which succeeds, so **`sh -c` exits 0.** The design
then says *"Verifies: tar exit 0"* — but the exit status it reads is the `:`'s,
not `tar`'s. The `||` was written for the empty-volume case and it covers the
failure case identically.

The two secondary checks narrow the hole but do not close it: *"the listing's
line count equals `find -type f | wc -l`"* is `0 == 0` when the volume is empty,
and *"`tar -tf | grep -c -v '/$'` ≥ that count"* is `0 >= 0`. So a **failed tar
on an empty-or-nearly-empty volume passes every check** and the volume is
recorded in the manifest as carried. `v4_workspace` on a hub where she has
written nothing yet is exactly that volume.

The irony is worth stating: the design chose the guard-before-pipe form over
`xargs -r` citing BSD portability, but this command runs inside the postgres
image (Debian, GNU userland) where `xargs -r` and `xargs -a` both exist — the
portability constraint that produced the swallow does not apply here at all.

**Smallest fix.** Split it into two `docker run` invocations with separate exit
statuses, or `sh -ec` with an explicit `if`:

```sh
sh -ec 'tar -C /src --numeric-owner -cf /out/volumes/K.tar .
        cd /src; find . -type f | LC_ALL=C sort > /tmp/f
        if [ -s /tmp/f ]; then xargs -a /tmp/f sha256sum > /out/volumes/K.listing
        else : > /out/volumes/K.listing; fi'
```

`-e` makes tar's failure the script's failure; the `if` keeps the empty-volume
case without borrowing the failure path.

---

### M4 — the cleartext `passphrase_fingerprint` is an offline oracle that defeats scrypt

**Severity: major.** A crypto weakening the design introduces by publishing, in
cleartext beside the ciphertext, a cheap verifier for the secret whose guessing
cost the KDF exists to raise.

§3.1 member 3 puts `meta.json` in the outer tar, **cleartext and
unauthenticated**, and §3.2 gives it `passphrase_fingerprint`. §3.2's manifest
field is `"fingerprints": {"passphrase": "sha256(passphrase)[:12]"}`, and v3's
implementation is:

```python
def fingerprint(passphrase: str) -> str:
    return hashlib.sha256(passphrase.encode("utf-8")).hexdigest()[:12]
```
`backend/app/backup_passphrase.py:151-155`, written into cleartext `meta` at
`backend/app/backup_snapshot.py:336-354`.

**What breaks.** §5 chooses `n = 2**15, r = 8` and justifies the modest cost:
*"the KDF is there for the operator who types his own"* (the same reasoning is
in `backend/app/backup_crypto.py:50-54`). For that operator, an attacker holding
the bundle does not pay scrypt at all: he reads `passphrase_fingerprint` from the
outer tar without a passphrase, and tests candidates at **one unsalted SHA-256
each**, ~2^-48 false-positive rate — then pays scrypt exactly once, for the
confirmed hit. Against a dictionary-derived passphrase that is the difference
between "infeasible" and "a few CPU-hours". The `env` and `prompt` resolvers
(§6) both accept an operator-chosen passphrase and the design sets no entropy
floor on either.

For the *generated* 160-bit default this is harmless, which is presumably why v3
never noticed. Shipping `prompt` and `env` is what makes it matter.

**Smallest fix.** Keep the use case (§7.4 step 4 needs to compare passphrase
identity across bundles without opening them) and drop the oracle: make the
cleartext value `sha256(scrypt_key)[:12]`, where `scrypt_key` is the key already
derived from **this file's** header salt. Identity still answers "which paper key
opens this file" — derive the key with that bundle's salt and compare — but each
guess now costs one scrypt, which is the whole point of having one. Keep the raw
`sha256(passphrase)[:12]` only inside the encrypted manifest, where it is already
behind the thing it identifies. One line in the writer, one in `drill`.

---

### M5 — `--drill` never restores a single volume

**Severity: major.** Falls short of `#17` (*"`--drill` restores into throwaway
volumes"*) and hollows out `#5`'s verb.

§7.3 opens: *"The same steps 2, 4, 5, 10, 11 — nothing on the host is written."*
Step 8 — *"Untar each volume in a throwaway container, then re-derive the listing
in the same container and diff it against `volumes/<key>.listing`"* — **is not in
that list.** But §7.3 then says *"Volumes: `nova_drill_${RUN}_<key>`"* and
`drill_name_ok` is asserted "before create and before delete", which only makes
sense if something creates and fills them.

As specified, the only drill volume with a purpose is
`nova_drill_${RUN}_pgdata`, backing the throwaway postgres. So the drill proves
the three database dumps restore and their counts and md5s match — and proves
**nothing** about `v4_memdata` (her notes, which §4.6 says *"exist nowhere
else"*) or `v4_workspace` (*"a file she wrote lives only here"*). A tar member's
sha256 is re-derived at step 2, which proves the bytes are intact; it does not
prove the archive extracts, that the per-file listing matches, or that the file
count is what the manifest claims.

§7.4 step 5 says *"The exit code **is** the verdict"* on the question *"could I
recover from disaster today"*. For two of the three tiers, the verdict is
currently uninformed.

**Smallest fix.** Add step 8 to §7.3's list, targeting
`nova_drill_${RUN}_<key>`, and add its result to §7.4 step 4's report (per
volume: file count, listing match). The trap already removes those volumes.

---

### M6 — the free-space check measures the wrong filesystem for the self-test restore

**Severity: major.** A step that can take the live database down, guarded by a
check of an unrelated disk.

§7.1 step 3 sums the three `pg_database_size` values plus `du -sk` of each
INCLUDE volume and requires **`detect_disk_free_gb "$OUT"` ≥ 1.5×** that.
`$OUT` defaults to `deploy/backups` (step 2), i.e. the repo's filesystem.

§7.1 step 10 then creates `nova_verify_<8hex>` **inside the live postgres
container** and `pg_restore`s a full copy of each database into it — on
`v4_pgdata`'s filesystem, which step 3 never measured. On a hub where the bundle
directory is a roomy second disk (or an external drive, which is the whole point
of `--transport usb`), step 3 passes with metres to spare and step 10 can fill
the filesystem holding the live cluster. Postgres on a full data filesystem
stops accepting writes; the design's own step 10 failure path ("refuse naming
the first table that differed") does not describe or recover that state, and
step 16's restart then brings core, gateway and memory up against a wedged
database.

Peak requirement is also understated: during step 10 the cluster holds the
original three databases **plus** a full second copy, plus WAL for the restore.

**Smallest fix.** Before step 10, read free space on the postgres data
filesystem from inside the container (`df -Pk /var/lib/postgresql/data`, the
`-Pk` form `deploy/install.sh:92-93` already uses) and require ≥ 1.2× the summed
`pg_database_size`. Refuse with both numbers, naming the filesystem. It is the
same shape as step 3, pointed at the disk the step actually writes to.

---

### M7 — the macOS CI leg cannot prove bash 3.2

**Severity: major.** `#27` is *"MUST — CI runs `install_test.sh` and
`backup_test.sh` on `macos-15` **under `/bin/bash`**"*, and the design's
mechanism does not deliver it.

§11.7: *"`runs-on: macos-15`, `defaults.run.shell: /bin/bash -euo pipefail {0}`
so the scripts execute under macOS's **bash 3.2**. Steps:
`./deploy/install_test.sh`, `./deploy/backup_test.sh` …"*

`defaults.run.shell` sets the shell that interprets the **step body**. The step
body is `./deploy/install_test.sh`, which is executed through its own shebang:

```
#!/usr/bin/env bash
```
`deploy/install_test.sh:1` — and §2 specifies the same shebang for the new
`deploy/backup_test.sh`.

`env bash` resolves against `PATH`. GitHub's hosted macOS images carry Homebrew,
and Homebrew's `bash` (5.x) sits on `PATH` ahead of `/bin/bash` whenever it is
installed. So the leg can run the whole suite under bash 5 and report green
while proving nothing about bash 3.2 — which is the single property the job
exists for. §13's risk 6 anticipates the runner's contents but not the shebang,
and it is marked **Not run**.

The failure is silent by construction: a bash-4+ construct (`${var,,}`,
`mapfile`, an associative array) would pass CI and fail on the operator's Mac.

**Smallest fix.** Invoke the interpreter explicitly — `/bin/bash
./deploy/install_test.sh` — and add a first step that fails the job when the
interpreter is not 3.2:

```yaml
- run: /bin/bash -c 'echo "$BASH_VERSION"; [ "${BASH_VERSINFO[0]}" -eq 3 ]'
```

A leg that cannot prove which bash it ran is a leg that reports success it did
not check.

---

### M8 — no trap restarts the writers `backup` stopped

**Severity: major.** A failure that leaves Nova off with nothing said.

§7.1 step 7 stops `core gateway memory web` (plus `tailscale` on `--move`) and
verifies each stopped. Steps 8–15 then run the entire expensive path — census,
three dumps, three self-test restores, volume tars, encryption at
`n = 2**15`, and a full decrypt-and-re-hash round trip of the written file —
with the stack down.

Step 7's own failure path restarts what it stopped. **Nothing else does.** A
`Ctrl-C` at step 11, an OOM in step 13, a full disk at step 14, or the operator's
SSH session dropping leaves core, gateway, memory and web stopped indefinitely.
`restart: unless-stopped` does not bring back a container stopped by `docker
compose stop`; that is the flag's entire semantics. There is no `deploy/.moved`
marker in the routine path, so nothing on the host records that a backup was
mid-flight, and the next `./install` is the only thing that would recover it.

§7.3 gets this right for the drill (*"`trap` on EXIT removes the container and
every `nova_drill_${RUN}_*` volume"*). §7.1 needs the same discipline in the
other direction.

**Smallest fix.** In `cmd_backup`, record what step 7 stopped in a shell
variable and install an EXIT trap that restarts exactly that list unless the run
reached step 16 successfully or `--move` was given. Have it print what it
restarted, and exit non-zero naming anything it could not.

---

### M9 — the foreign deletion is ordered so a partial failure is irreversible, and on the Dell it targets the volume `deploy/README.md` still depends on

**Severity: major.**

**(a) Ordering.** §8.3: *"The deletion runs `docker rm -f` on **that captured ID
list** and `docker volume rm` on **that captured name list**"*, then the
post-condition check. Containers go first. `docker volume rm` fails on a volume
still mounted by **any** container — including one this path deliberately did
*not* remove, because it classified it `ours` or `sibling`. So the achievable
outcome is: every foreign container irreversibly destroyed, volume removal
fails, post-check #1 fires, exit 1 — with no rollback and no restatement of what
survived versus what is gone. The ruling's *"Deletion is irreversible, so the
offer states what will be destroyed"* (`rulings.md:27-28`) is satisfied for the
happy path and not for this one: the operator consented to a *set*, and got a
partial.

*Smallest fix:* before removing anything, run `docker ps -a --filter
volume=<name>` for each captured volume and refuse the whole operation if any is
held by a container outside the captured ID list, naming it. Then delete volumes
first (they are the irrecoverable half) and containers second.

**(b) Scope on the Dell.** Ruling 1 is about *the mini PC's* platform-line stack.
The design correctly derives names from docker output rather than a list — which
means on **this** machine it derives a different set. Measured:

```
$ docker ps -a --filter label=com.docker.compose.project=nova --format '{{.Names}}|{{.State}}'
… nova-coder-1|exited  nova-git-landing-1|exited  nova-home-assistant-1|exited
   nova-kokoro-1|exited  nova-media-1|exited  nova-ntfy-1|exited  nova-whisper-1|exited
$ docker volume ls --filter label=com.docker.compose.project=nova …
… nova_kokoro_models  nova_nova_coder_workspaces  nova_ntfy_cache
   nova_tailscale_state  nova_whisper_models
```

Those v3 containers were created from `…/nova/docker-compose.yml`, which exists
but now declares `name: nova-v3` (`docker-compose.yml:8`) ≠ `$project`, so they
are foreign by §8.1's rule; their volume keys are not in `ours_volumes`, so the
five volumes are foreign too. One of them is `nova_tailscale_state` — the exact
volume `deploy/README.md:203-230` instructs the operator to copy the tailnet node
identity **out of**, and the volume `install.sh`'s own tailnet path is written
around (`deploy/install.sh:352`, `TAILSCALE_STATE_VOLUME_KEY`, and `state_volume_by_label` at `:425-431` and the
comment at `deploy/docker-compose.yml:342-350` explaining why v4's key is
deliberately *not* `tailscale_state`).

The design does say it rewrites that README section to point at `backup --move`.
It does not say that until that migration has been performed, `./install` on this
machine offers to destroy the node identity the migration reads from — and that
`check_foreign_project` runs in `preflight` on **every** `./install`, so the
offer appears on every run.

**(c) Non-TTY hard-fail.** §8.2: *"Non-TTY: never prompt. Print the same block …
and exit 1."* `install.sh` is documented *"Idempotent: safe to re-run"*
(`deploy/install.sh:2`). With v3's containers on this machine, every non-
interactive `./install` — which is how an agent or a CI step runs it — now exits
1 until the operator disposes of v3. That is a real behaviour change to the
installer that `#29` implies but the design does not call out.

*Smallest fix for (b)+(c):* print `nova_tailscale_state` (and any volume named in
`deploy/README.md`'s procedures) in a third class — "foreign, but referenced by
`deploy/README.md:203-230`; migrate before deleting" — and make the non-TTY path
exit 1 only when a foreign container's **service name** collides with one this
compose file declares (the actual adoption hazard, which §8.2 already computes
and prints). A foreign container with no colliding service name is a warning, not
a stop; `docker compose up` cannot adopt it.

---

### M10 — `PATH_POLICY` is exact-match, and the design's own measured host scan does not match it

**Severity: major.** Another day-one refusal, from the design's own measurement.

§4.6 gives `.claude`, `.superpowers`, `.worktrees` as `PATH_POLICY` rows.
§4.4 reports, correctly, that *"`git status --porcelain --ignored=matching` in
this worktree returns 19 such paths today"*. I re-ran it and got 19. Two of them
are:

```
!! .superpowers/sdd/.gitignore
!! .superpowers/sdd/slice-40b-honest-machine-claims/
```

`.superpowers/` is **not** in `.gitignore` (the file lists `.claude/` and
`.worktrees/` but not `.superpowers/`); the ignore comes from a nested
`.superpowers/sdd/.gitignore`, so the scan emits the nested paths, never the
bare directory.

v3's lookup — which the design ports — is exact-then-suffix-then-segment:

```python
if rel in PATH_POLICY: return PATH_POLICY[rel]
for suffix, reason in _EMIT_SUFFIXES: …
twin = _compiled_twin(rel, project_dir)
for seg in rel.split("/"):
    if seg in SEGMENT_POLICY: return SEGMENT_POLICY[seg]
return None
```
`backend/app/backup_coverage.py:369-392`

`.superpowers/sdd/.gitignore` is not equal to `.superpowers`; `.superpowers` is
in the design's `PATH_POLICY`, not its `SEGMENT_POLICY`, so the segment loop
misses too. Result: `None` → UNCLASSIFIED → `R1` → **no bundle, in this worktree,
today**. The other 17 paths are covered (`.claude/` rstrips to `.claude` and hits
the exact row; the rest hit `__pycache__`, `.venv`, `.ruff_cache`,
`node_modules`).

`test_coverage_v4_real.py` may go red at implementation time if its "checked-in
ignored-path scan" is captured honestly — but §4.4 presents the table as already
covering the measured 19, and it does not.

**Smallest fix.** Move `.claude`, `.superpowers`, `.worktrees` into
`SEGMENT_POLICY` (they are unambiguous names wherever they appear, which is the
stated criterion for that table), or give `PATH_POLICY` an explicit
directory-prefix form for rows marked as directories. And capture
`test_coverage_v4_real.py`'s scan fixture from the real command output rather
than writing it by hand, so the test and the product see the same strings.

---

### M11 — the round-trip verify never uses the reader that travels in the bundle

**Severity: major.** The one component that must work on a bare machine is the
one component never exercised against the artifact.

§7.1 step 13f: *"full round trip on the written file: open `<final>.part`,
decrypt `payload.enc`, re-extract, re-verify every hash against the manifest, and
assert the embedded `nova_restore.py`'s sha256 equals the git copy's."* That runs
inside the writer container, from `nova_bundle.py`, using the `cryptography`
backend that `encrypt_file` itself imports (`backend/app/backup_crypto.py:152`).

§5 concedes the shape honestly — *"Two readers of one format is a real cost"* —
and pins it with `test_restore_reader.py`, a unit test over synthetic data with
`cryptography` forced unimportable. What is never checked is **this bundle**,
opened by **the copy of `nova_restore.py` inside it**. The sha256 equality
assertion proves the file is the right bytes; it does not prove those bytes can
open this payload.

That gap is the difference between "the format round-trips" and "this artifact is
restorable", and it is exactly the distinction CLAUDE.md's *never report success
you did not check* draws.

**Smallest fix.** After 13f, in the same container, run the embedded script
against the written file:

```
python3 -c "import sys; sys.modules['cryptography']=None" -m … # force the ctypes path
python3 <extracted>/nova_restore.py --verify-only <final>.part
```

Both `python3` and the bundle are already in that container; it costs one
decrypt. Run it with the `cryptography` import suppressed so the ctypes
libcrypto path — the one a bare machine will use — is the path proven. Any
failure deletes the `.part` and refuses, like every other lettered step.

---

## MINOR

### m1 — §4.4 misreads v3, and cites the lines that disprove it

*"v3 classified a **host-scan-only** path by the git rule: gitignored → INCLUDE
(`backup_coverage.py:583-610`). That makes … `__pycache__/` carry themselves."*

Lines 583-610 are `check_uncovered_host_state`, which does the opposite:

```python
decided = _path_policy(rel, project_dir)
if decided: continue
out.append(Refusal(code="R5_UNCOVERED_HOST_STATE", …))
```
`backend/app/backup_coverage.py:596-609`

And `host_state_entries` includes a scanned path **only** when the policy says
INCLUDE (`backend/app/backup_coverage.py:565-580`). v3 already refuses on an
unclassified host-scan path; the design's behaviour is v3's, not a departure.
This matters only because the design's standard is that every claim carries a
correct `path:line`. *Fix: rewrite §4.4 as "ported, with v3's R5 folded into
R1", and note that the four refusal codes drop v3's fifth.*

### m2 — the census md5 has a 1 GB ceiling and pins only one of four text-rendering GUCs

§7.1 step 8: `SELECT count(*), md5(coalesce(string_agg(t::text, '' ORDER BY
t::text), '')) FROM <schema>.<table> t`.

`string_agg` builds one `text` value; PostgreSQL's varlena limit is 1 GB, so the
first table whose concatenated row text passes it raises and — per step 8's own
rule, *"Fails → refuse naming the table"* — **the backup refuses permanently and
the only remedy is a code change.** `turn_spans` at 48k rows is far away; a hub
that runs for a year is not obviously so, and nothing measures it.

Separately, `t::text` depends on `DateStyle`, `IntervalStyle`,
`extra_float_digits` and `bytea_output` as well as `TimeZone`. Only `TimeZone` is
set. A source and target rendering under different defaults produce different
md5s for identical data — a false mismatch that refuses a good restore.

*Fix: `md5(coalesce(string_agg(md5(t::text), '' ORDER BY md5(t::text)), ''))` —
32 bytes per row instead of a whole row, moving the ceiling to ~31M rows — and
`SET DateStyle='ISO, MDY'; SET IntervalStyle='postgres'; SET
extra_float_digits=1; SET bytea_output='hex';` beside the `SET TimeZone='UTC'`
that is already there.*

### m3 — BSD short-route expansion can miss a `/12` and pick a colliding subnet

§9's `host_routes_in_use` expands BSD's short forms *"by octet count"*
(`172.18` → `172.18.0.0/16`). A macOS host carrying `172.16.0.0/12` — which
covers 172.16 through 172.31, the entirety of `pick_project_subnet`'s first
candidate band — prints it as `172.16` in `netstat -rn` and the rule expands it
to `/16`. `pick_project_subnet` then hands back 172.18.0.0/16 as free. The
design offers no refusal for an ambiguous expansion. Low impact (macOS is a CI
target per `map-portability.md` §6, not a deploy target), but the heuristic is
lossy in the unsafe direction. *Fix: honour an explicit `/n` when netstat prints
one, and when it does not, treat a 1- or 2-octet form in 10/172.16/192.168 as
the containing RFC1918 block rather than the classful guess.*

### m4 — the orphan sweep eats a concurrent drill

§7.4 step 1 sweeps *"any volume matching `^nova_drill_[0-9a-f]{8}_` and any
container named `nova-drill-pg-*`"* **before** step 3 generates this run's
`RUN`. A second drill started while the first is mid-restore deletes the first's
volumes out from under it. Also, `docker ps --filter name=` is an unanchored
substring match, so the container sweep is wider than the anchored regex the
volume sweep uses. Not reachable with one operator and no schedule (§7.4's
schedule is explicitly out of scope), but it becomes reachable the day the
`timers.JOBS` handler lands. *Fix: skip any `nova_drill_*` volume whose
`nova-drill-pg-<RUN>` container still exists, and anchor the container filter
with `--filter name='^nova-drill-pg-'`.*

### m5 — `check_foreign_project` cannot say why a compose render failed

`compose_config_text` discards stderr (`2>/dev/null`, `deploy/install.sh:395`).
§4.1's `R4_FACT_UNREADABLE` promises to name *"the command and its stderr"*, but
§8.1 reuses the stderr-swallowing helper, so a failed render in the deletion path
can only be reported as "no volumes found". Combined with C1's fix this is the
same line of code twice. *Fix: the new all-profiles renderer captures stderr and
refuses with it.*

### m6 — backup needs host `git` and a git repository, which §1 does not say

§1 claims *"running the writer there means backup needs **no host Python at all**
on Linux or macOS."* True, and it needs host `docker` and host `git`: `git.json`
and `hostscan.json` (§4.1) are both git invocations, and `git check-ignore`
outside a work tree exits 128. An operator who deploys by copying the tree rather
than cloning it gets `R4_FACT_UNREADABLE` on every backup, forever. That is a
stated refusal, not a silent failure, so it is minor — but §1's sentence reads as
a dependency list and omits two of the three. *Fix: say "needs host `docker` and
host `git`; no host Python", and have the `git.json` renderer's refusal text name
"this directory is not a git work tree" as a distinct case from "git failed".*

### m7 — the writer container has no mount for `$OUT`

§7.1 step 13's command line is `docker run --rm -u … -v "$STAGE":/stage
--entrypoint python3 "$img" /stage/bin/nova_bundle.py build …` — one mount. Step
13e writes `<final>.part` and step 14 `os.replace(part, final)`. If `<final>` is
under `$OUT` (`deploy/backups`) the container cannot write it; if `.part` is
written under `$STAGE` and `$OUT` is a different filesystem — which
`--transport usb` makes the normal case — `os.replace` raises `OSError: Invalid
cross-device link`, after the expensive part. *Fix: mount `$OUT` into the
container as well and write both `.part` and `final` there, so step 14's rename
is intra-filesystem by construction; state that in the step.*

### m8 — `--move`'s MOVED_TO ordering is load-bearing and untested

`--move` both includes `v4_tailscale` in the bundle (§4.6 mode overlay, tarred at
step 11) and writes `MOVED_TO` into that volume (step 16). The bundle is correct
only because 11 precedes 16. If that order ever inverts, the restored hub's
sidecar reads `MOVED_TO` and refuses to start (§7.5's `start.sh` guard) —
a move that completes and then cannot come up. The design never states the
dependency and §11 has no test for it. *Fix: one assertion in
`test_bundle_layout.py` — a `--move` bundle's `volumes/v4_tailscale.tar` contains
no `MOVED_TO` member.*

### m9 — the drill's pg image and step 4's pg image are different things

§7.2 step 4 reads `pg_restore --version` *"from the image compose will run"*.
§7.3 reuses "the same step 4" but runs `postgres:16` hardcoded. On a host whose
compose resolves a different postgres image the drill checks a version it will
not use. *Fix: `config_service_image postgres` (the reader already exists at
`deploy/install.sh:415-423`) for both paths.*

### m10 — `#4`'s "derived from the compose file" still rests on four hand-kept tables

Not a defect, but worth stating plainly since `rulings.md:47-49` retired
`BACKUP_EXCLUDE_DATA` as *"the hand-kept list"*. §4 derives the **entry set**
from compose + containers + volumes + git + host scan, and classifies it from
`VOLUME_POLICY` / `PATH_POLICY` / `ANON_POLICY` / `SEGMENT_POLICY` — four
hand-kept tables. The material difference from `BACKUP_EXCLUDE_DATA` is real and
sufficient: a miss **refuses** instead of silently skipping, so the list cannot
rot into a silent omission. C2 and M10 are the cost of that design being right
in principle and stale in fact, and both are caught by tests that read from the
same source the product reads. Worth one sentence in §4 so a later reader does
not think the ruling was routed around.

---

## Approvals check

**Nothing in this design rebuilds an approval.** I checked each gate against
`rulings.md`'s standard and against `services/core/tests/test_no_approvals.py`
(which scopes itself to `services/core/app/`, `GATE_MODULES` at
`services/core/tests/test_no_approvals.py:31`, so nothing in `deploy/` can trip
it — the reasoning has to be done by hand, and it holds):

- §8.2's typed confirmation phrase disposes of **the owner's own data at the
  owner's own keyboard**. It decides nothing on his behalf; the alternative is
  silent destruction. The default is to do nothing, which `rulings.md:27-28`
  requires.
- §4.3's `R1`–`R4` state that the backup **cannot account for** state — a
  CANNOT.
- §7.2 step 3 (non-empty target), step 4 (older `pg_restore`), step 0 (no
  `python3`) are all CANNOTs.
- §7.1 step 1 and `start.sh`'s `MOVED_TO` guard state a CANNOT (two tailscaled
  on one node key flap) at the layer that would cause the conflict.
- `--skip-migration-gate` (§7.2 step 5) is an operator override on a CANNOT that
  prints what it skips — it widens, it does not gate.
- §12.1 correctly keeps every verb out of her context per D21, with no tool, no
  guard and no eval, so `test_tools_registry` and `test_eval_corpus` do not move.

---

## Requirement-by-requirement: where the design falls short

Only shortfalls are listed; every other bullet in `map-requirements.md` §1 is
satisfied as written.

| # | The MUST | Shortfall |
|---|---|---|
| 1 | *"a complete **encrypted** bundle"* | **C2** — with `ANON_POLICY` empty and `searxng`'s anonymous volume live, `R1` fires and no bundle is ever written. |
| 4 | *"coverage derived from the compose file; an unclassified volume refuses rather than silently skipping"* | Satisfied in mechanism; **C2** and **M10** are two tables that are already stale against this repo, and **m10** notes the derivation still rests on hand-kept classification. |
| 14 | *"`restore`: refuse a non-empty target"* | **M1** — `nova_v4_pgdata` is never inspected, because it is not a member of the bundle. |
| 17 | *"`--drill` restores into throwaway volumes"* | **M5** — §7.3's step list omits step 8, so no volume is ever extracted. |
| 12 | *"`restore`: `decide_subnet` **first** … via `${NOVA_SUBNET}` / `NOVA_SUBNET_GATEWAY`"* | **M2** — §9 and §7.2 specify contradictory write behaviour and each branch breaks the bare-machine path. |
| 27 | *"CI runs `install_test.sh` and `backup_test.sh` on `macos-15` **under `/bin/bash`**"* | **M7** — `defaults.run.shell` does not override the scripts' `#!/usr/bin/env bash`; the leg can pass under bash 5. |
| 29 | *"`install.sh` refuses when a foreign `nova` compose project is on the target, naming its containers"* + ruling 1's *"impossible to touch a v4 volume"* | **C1** — `v4_ollama` lands in the foreign set and the post-check is blind to it. **M9** — partial irreversible deletion; scope on the Dell. |

---

## Verdict

**SOUND-WITH-FIXES.**

Counts: **2 critical, 11 major, 10 minor.**

The shape is right and I could not break it. Both criticals and most majors are
in the *derived-fact plumbing* — which command renders the facts, which
filesystem is measured, which exit status is read — not in the architecture.
`backup.sh` as the only holder of the docker socket, facts as files, a container
writer and a stdlib reader, coverage that refuses, a full round trip before the
rename: none of that needs to change. What needs to change is that three of the
design's "Measured" claims are stale or wrong against the machine it was measured
on (§4.6's anonymous volumes, §4.6's dropped searxng rows, §8.1's ours-set), and
two of its verification steps read a status or a disk that is not the one the
step wrote to (M3, M6). Fix C1, C2, M1, M2, M3, M5, M6, M7, M11 before writing
code; M4 is a one-line change and should go in at the same time because it is
cheaper now than after bundles exist in the wild.

**Three things this design does better than either of the other two stances**
(a pure-bash pipeline, or a self-contained Python package/zipapp that owns the
whole job):

1. **It reads v3 adversarially instead of copying it, and it found a real port
   bug before shipping it.** §4.5 measures `git check-ignore -v data` (exit 1)
   against `git check-ignore -v data/` (matches `.gitignore:13`) and shows that a
   verbatim port of `backend/app/backup_inventory.py:181-208` makes `../data`
   (`deploy/docker-compose.yml:83`) return `unknown` → UNCLASSIFIED → every v4
   backup refuses. A stance that treats v3 as a library to wrap, or one that
   rewrites from the spec without reading v3, would have shipped that bug or
   re-derived it. C2 and M10 are the same failure mode caught one level deeper —
   which is an argument for more of this method, not less.

2. **One side-effect surface, and it is the one that is already reviewable.**
   `deploy/backup.sh` is the only thing that touches `docker`, `.env` or the
   host; the Python consumes rendered JSON and never shells out. That means the
   writer runs in a throwaway container with **no docker socket**, every fact the
   classifier saw is a file on disk after a failure, and the entire shell suite
   (§11.1, §11.2) runs with stubbed `docker`/`git`/`ip`/`stat` and no live stack.
   A package that owns the whole job has to hold the socket to do its work, and
   its coverage decisions are then only as auditable as its logs.

3. **The `sibling` class, and the measurement that forced it.** §8.1 ran the
   classifier's input on this machine and found eight **running** v4 containers
   created from `…/.worktrees/v4/deploy/docker-compose.yml` — not this
   checkout's file — beside seven exited v3 containers. A classifier built from
   the ruling's text alone ("name the foreign project and offer to delete it")
   calls the live stack foreign and offers to delete it on the first run. That
   this design still has C1 is not an argument against the method; it is the
   method applied to containers and not yet to volumes, and §8.1's own sentence
   — *"the sibling problem does not arise for volumes at all"* — is the place
   the measurement stopped one step early. The other two stances do not reach
   that measurement at all.
