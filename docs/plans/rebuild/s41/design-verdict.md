# S41 design verdict — the encrypted bundle, the drill, and the installer's refusal

**This is the document S41 is built from.** It supersedes the three stance
designs. Where it contradicts them, it wins; where it is silent, they are
background, not authority.

Binding inputs, not re-argued: [`rulings.md`](rulings.md),
[`map-requirements.md`](map-requirements.md) (cited as `#n`),
[`map-minipc-measured.md`](map-minipc-measured.md),
[`map-v3-backup.md`](map-v3-backup.md), [`map-deploy-data.md`](map-deploy-data.md),
[`map-portability.md`](map-portability.md).

Every claim about this repo carries `path:line`. Claims marked **[M]** were
produced by a read-only command run in this worktree on 2026-09-21 and the
command is given. Claims marked **[unverified]** were not checked and say so.
Nothing was deployed, restarted, mutated or committed.

**Headline:** the chosen shape is the shell-first spine, with port-v3's
fact-file discipline and python-tool's bundle mechanics grafted in. The three
critiques raise 72 findings between them (port-v3 23, shell-first 26,
python-tool 23). **69 are folded into this verdict**, each named in §2 with
where it lands; five design elements the critiques attacked are rejected
outright, with reasons; three findings are not carried and §2 says which and
why. One finding is my own and it changes an implementation choice in
two of the three designs: **`docker compose config --format json` keeps a
top-level `x-` key and strips every nested one — a volume's, a service's, a
long-syntax mount's; the YAML render keeps them all** [M].

---

## 1. The chosen architecture, and why

```
  HOST — bash 3.2, the only thing that holds docker or writes .env
  ─────────────────────────────────────────────────────────────────────────
  ./install  (install:13-21)  ->  deploy/install.sh main()  (:1130-1137)
    install | update | backup | restore | drill | undo-move
      │
      ├─ deploy/subnet.sh      decide_subnet, host_routes_in_use,
      │                        docker_subnets_in_use, subnet_overlaps
      ├─ deploy/passphrase.sh  resolve_passphrase -> stdout + exit code
      └─ deploy/backup.sh      cmd_backup / cmd_restore / cmd_drill /
                               cmd_undo_move.  DECIDES, VERIFIES, REFUSES.
                               It reads no byte of Nova's data and holds
                               no key.
      │
      │  renders every fact it needs into $STAGE/facts/*.json, then hands
      │  over.  The passphrase goes on STDIN.  Never argv, never -e.
      ▼
  CONTAINERS — everything that touches bytes or keys
  ─────────────────────────────────────────────────────────────────────────
  docker run --rm -i --network none --user 0:0  $PACK_IMAGE
      python3 /stage/bin/novabundle.py  {plan|pack|verify|kat|fingerprint|genpass}
      $PACK_IMAGE = the already-built core image (cryptography is already a
      dependency, services/core/pyproject.toml:11).  NO DOCKER SOCKET.
      It consumes facts/*.json; it never shells out.
  docker run --rm $PG_IMAGE  pg_dump -Fc | pg_restore | psql | tar
      $PG_IMAGE read from the running container's image id, never typed

  THE BUNDLE   nova-backup-<host>-<UTCstamp>.tar     0600, owned by the operator
  ─────────────────────────────────────────────────────────────────────────
  README.txt  nova_restore.py  restore.sh  kat.enc  kat.sha256   cleartext
  meta.json                                    cleartext, UNAUTHENTICATED
  payload.enc            NOVAENC1 = scrypt + AES-256-GCM per 4 MiB frame
       └─ MANIFEST.json FIRST, then db/, listings/, volumes/, files/, env/

  A BARE MACHINE
  ─────────────────────────────────────────────────────────────────────────
  tar -xOf <bundle> restore.sh | sh -s -- <bundle> <outdir>
      probes four decryptor backends, accepts one only after a known-answer
      test with the real passphrase, refuses with the exact install lines
```

**Five sentences.**

**The shell is a decider, not a worker.** `deploy/backup.sh` is the only thing
that calls `docker`, writes `.env` or touches the host; it renders every fact
it needs into JSON files under a staging directory and hands those files to a
container. That is port-v3's discipline and it buys three things nothing else
does: the packer runs with **no docker socket** (so a mounted socket is never
root on the host, which is what rules out the python-tool stance's core move),
every fact the classifier saw is a file on disk after a failure, and the whole
shell suite runs with `docker`/`git`/`ip`/`stat` stubbed and no live stack.

**Everything that touches a byte or a key runs in a container that is already
on the machine.** The pack image is the core service's image, which already
carries `cryptography` (`services/core/pyproject.toml:11`), so backup adds no
host dependency beyond `bash`, `docker` and `git`. That is how a bash-3.2
script ships authenticated encryption of many gigabytes without writing a
cryptographic construction in shell — and the reason it must not reach for
`openssl enc` is measured, not asserted: `openssl enc` and `openssl kdf` take
the key and the passphrase **in argv**, so a shell-native cipher puts the
backup passphrase in `ps` output and in `docker inspect`
(`design-shell-first.md:426-437`; `map-minipc-measured.md:105-109` adds that
OpenSSL 3.0.13's `enc` cannot write or verify a GCM tag at all, so such a
bundle would be unauthenticated in practice).

**Coverage is declared beside the thing it describes, inside the compose
file.** Each volume and each bind carries `x-nova-backup:` and
`x-nova-backup-reason:`; each service carries `x-nova-backup-anon:` keyed by
mount target for the volumes its *image* declares. The set those dispositions
must cover is read from the **raw compose text**, not from the render, because
compose prunes a declared volume no rendered service mounts [M]. Host paths
that no mount names are classified by git plus a small segment table, because
a policy table cannot be made total over a real tree without it — the failure
the python-tool critique found and both other stances carry
(`critique-python-tool.md:131-138`).

**The bundle opens itself, and the opener is proven against the artifact.**
The standalone reader and a known-answer test vector travel inside every
bundle, so a machine with only `docker` can prove it has a working decryptor
and a correct passphrase before it reads one payload byte; and before a bundle
is published, the *shipped copy of the reader* is run against the finished
file with `cryptography` forced unimportable, so the path a bare machine will
take is the path that was proven.

**S41 restores onto an empty target or into a namespaced drill, never over a
live system** — which is why it needs no pre-restore safety snapshot, no
staging-database swap and no move-aside file restore, and why the one thing it
cannot do is roll back a bad upgrade in place.

### Why not the other two, in one line each

- **Port-v3 (four hand-kept Python policy tables).** The mechanism is right —
  a miss refuses — but the tables were measured stale twice against this very
  machine on the day they were written: `ANON_POLICY` empty while a v4 service
  has an anonymous volume, and `PATH_POLICY` exact-match missing
  `.superpowers/sdd/...`. Both confirmed here [M]. Dispositions that live in
  the compose file cannot go stale against the compose file. Its fact-file
  discipline and its `sibling` container class are kept; its tables are not.
- **Python-tool (a purpose-built image with the docker socket).** It buys the
  best bootstrap story and the best typed-verification vocabulary, both of
  which are grafted in below. It costs a new Dockerfile, two digest-pinned
  base pulls, a `docker build` on the restore target at the moment of a
  disaster, and a container holding the docker socket — root on the host — for
  a job the other two stances do without one.

---

## 2. What I took from each critique

### Accepted, and where it lands

| From | Finding | Landed in |
|---|---|---|
| port-v3 C1 | `compose_config_text` renders `--profile tailnet` only, so `v4_ollama` is classified foreign and deleted | §10.1: the ours-set is the union of the raw text and the all-profiles render; the post-check is computed from the captured live listing |
| port-v3 C2 | `ANON_POLICY` empty while `searxng` has an anonymous volume → every backup refuses on day one | §6.2 `x-nova-backup-anon` on the service; §6.5 the two searxng rows |
| port-v3 M1 / shell-first M3 | the non-empty-target check never looks at `v4_pgdata` | §9.2 step 6 iterates the full declared set |
| port-v3 M2 / python-tool M3 | `set_env_value` dies on a bare target because `.env` does not exist | §9.2 step 2 creates `.env` from `.env.example` first |
| port-v3 M3 | the volume-tar `\|\|` chain turns a failed `tar` into exit 0 | §9.1 step 13 uses `sh -ec` with an explicit `if` |
| port-v3 M4 / shell-first M5 | the cleartext `sha256(passphrase)[:12]` is an offline oracle that annuls scrypt | §7.4 |
| port-v3 M5 | `--drill` never restores a volume, so two of three tiers are unverified | §9.3 step 4 |
| port-v3 M6 | the free-space check measures `$OUT`, not the filesystem the self-test restore writes to | §9.1 steps 3 and 11 |
| port-v3 M7 | `defaults.run.shell` does not override `#!/usr/bin/env bash`, so the macOS leg can pass under bash 5 | §12.5 |
| port-v3 M8 | nothing restarts the writers a failed backup stopped | §9.1's EXIT trap |
| port-v3 M9(a) | containers deleted first, volume removal then fails, partial irreversible deletion | §10.1 step 5 |
| port-v3 M9(b,c) | on the Dell the foreign set includes `nova_tailscale_state`, and a non-TTY `./install` now exits 1 | §10.1 steps 3 and 6 |
| port-v3 M10 | `PATH_POLICY` exact-match misses `.superpowers/sdd/.gitignore` | §6.4: segments, not paths, plus git |
| port-v3 M11 | the round-trip verify never uses the reader that travels in the bundle | §9.1 step 20 |
| port-v3 m2 / shell-first M9 / python-tool M2 | the census md5 has a 1 GB ceiling, pins one GUC of five, and is NULL for an empty table | §9.1 step 9 |
| port-v3 m4 | the orphan sweep eats a concurrent drill | §9.4 step 1 |
| port-v3 m6 | backup needs host `git`, which the architecture sentence omitted | §1, §6.1 |
| port-v3 m7 | the writer container has no mount for `$OUT`, so `os.replace` is cross-device | §9.1 step 19 |
| port-v3 m8 | `--move`'s MOVED_TO ordering is load-bearing and untested | moot — the marker no longer lives in the volume (§9.5) |
| port-v3 m9 | the drill's pg image and the version gate's pg image are different things | §9.3 step 2 |
| shell-first C1 | `--profile '*'` is the only thing keeping two v4 volumes out of the deletion offer, and nothing checks it | §10.1, §6.1 R1 |
| shell-first C2 | a declared volume no rendered service mounts is pruned, so it is invisible rather than unclassified | §6.1 — **confirmed here [M]** |
| shell-first C3 | the DoD walk is blocked: no `nova-core` image on the target, and five guaranteed `.env` conflicts | §9.2 step 8, §9.3 step 2 |
| shell-first M1 | the deletion offer names `nova_tailscale_state` without saying it holds a node identity | §10.1 step 3 |
| shell-first M2 | the writer set is derived from volume mounts only, so `gateway` writes to Postgres all the way through the census and dump | §9.1 step 7 |
| shell-first M4 | a failed restore leaves state its own step 6 then refuses, with no cleanup path | §9.2 step 10, `.restore-in-progress` |
| shell-first M6 | `MOVED_TO` downgraded to an env var the design itself calls bypassable | §9.5 — python-tool's placement |
| shell-first M7 | the outer tar is built on the host, breaking #24 and producing a root-owned file | §9.1 step 19 |
| shell-first M8 | `undo-move` refuses on its own judgement when a peer is online — a "may not" | §9.5 |
| shell-first M10 | #27 is discharged by a CI job the design says will not run | §12.5 and §16 |
| shell-first M11 | the claimed concurrency control does not exist; two `.part` writers interleave | §9.1 step 1 |
| shell-first M12 | the migration gate false-refuses a renumbered migration with no path through | §9.2 step 7 |
| shell-first m2 | bash has no floats and the free-space units do not match | §9.1 step 3 |
| shell-first m3 | the emptiness probe can populate the volume it is checking | §9.2 step 6 |
| shell-first m10 | `openssl rand 20` through `$( )` silently drops NUL bytes | §7.5 |
| shell-first m11 | `drill`'s sweep and `backup`'s self-test share the `nova_verify_*` namespace | §9.1 step 10 |
| python-tool C1 | coverage's third derivation signal (git) is missing, so `PATH_POLICY` cannot be total and backup refuses for ever | §6.4 |
| python-tool C2 | a v4 volume can enter the deletion set, and the required test would pass anyway because its fixture is hand-written | §10.1, §12.2 |
| python-tool C3 | the bundle is written root-owned and the operator cannot read it back — **a measured incident**, `map-minipc-measured.md:164-171` | §9's second convention (the writer is not the verifier) and §9.1 step 19 |
| python-tool M1 | the empty-target probe reads every failure as "empty" | §9.2 step 6 |
| python-tool M4 | the `.env` plan deadlocks against `decide_subnet`, and #32's host-specific key filter is referenced and never designed | §9.2 step 8 — the bundle carries a key SET, not a file |
| python-tool M5 | `decide_subnet` adopts a network by name, not by label | §10.2 |
| python-tool M6 | the in-bundle script is unauthenticated executable code whose only authenticated hash is inside the ciphertext it opens | §7.6 |
| python-tool M7 | `DRILL_RE` matches none of the names it is said to guard | §9.3 step 1 |
| python-tool M8 | the foreign-volume derivation misses orphaned volumes and reads no candidate's own project label | §10.1 step 2 |
| python-tool M10 | #28 is a two-machine walk and a single-host e2e test is not it | §12.4, §13 T7 |
| python-tool M11 | the 0600 mode probe is specified twice and the container-side copy measures a synthesised filesystem view | §9.1 step 2 — the probe is the host's |
| python-tool minor 5 | the volume listing covers regular files only, so a symlink or a mode change is invisible | §9.1 step 12 |
| port-v3 m3 | BSD short-route expansion can miss a `/12` and pick a colliding subnet | §10.2 |
| port-v3 m5 | `compose_config_text` discards stderr, so a failed render can only be reported as "no volumes found" | §6.1 |
| port-v3 m10 | "derived from the compose file" still rests on hand-kept classification, and the ruling deserves the distinction in writing | §6.7 |
| shell-first m1 | the free-space step needs the include set the coverage step produces, so as numbered it cannot run | §9.1 steps 3–6 |
| shell-first m4 | there is no portable `date -d`, so "age in days" cannot be computed the obvious way | §9.4 step 3 |
| shell-first m5 | the writer-set rule contradicts its own prose about `postgres` | §9.1 step 7, stated as a rule |
| shell-first m6 | `COMPOSE_FILE` is written into every real `.env` and is absent from `.env.example`, so every existing install refuses on its first backup | §4, `.env.example` |
| shell-first m7 | the compose provenance claim names a version this session does not run | §15 risk 2 — this host is **v5.3.0** [M] |
| shell-first m8 | six line-cites drift by 2–3 lines | every `path:line` in this verdict was re-read before it was written |
| shell-first m9 | the drill network takes whatever subnet docker hands it | §9.3 step 3 |
| python-tool C4 | `project_dir` and `compose_files` are not in `docker compose config --format json`, yet three things rest on them | §5.3 — passed in by the wrapper, which already knows both |
| python-tool M9 | the deletion offer's worked example shows invented sizes and another project's data | §10.1 — the block prints the measured reading and a project-label column |
| python-tool minor 1 | `"AES-256-GCM"` vs v3's lowercase `"aes-256-gcm"` makes the reader refuse every v3 payload | §7.1 |
| python-tool minor 2 | "nothing decides anything from `meta.json`" is not true — the passphrase choice does | §2 rejection 5 |
| python-tool minor 4 | the free-space gate under-counts: the run holds five copies, not two | §9.1 step 6 |
| python-tool minor 6 | "nothing is pulled" cannot hold on the restore side | §9.2 step 9 |
| python-tool minor 8 | the raw-YAML service scan assumes one compose file; the GPU overlay makes it two | §12.1 |

### Rejected, with reasons

1. **port-v3 M9(b)'s third class for `nova_tailscale_state` ("foreign, but
   referenced by `deploy/README.md`; migrate before deleting") — rejected as a
   class, accepted as an annotation.** A third class is a list of names the
   README and the script must keep in sync, which is exactly the rot the
   ruling's "names come from `docker` output" exists to stop. What lands
   instead is a **derived** annotation: `state_file_on_volume`
   (`deploy/install.sh:439`) already reads a volume for `tailscaled.state`
   through a throwaway container, so §10.1 step 3 runs it over every candidate
   and annotates the ones that answer. Same protection, nothing to maintain.
   Cost if wrong: a future asset that is equally irreplaceable but is not a
   tailscaled state file gets no annotation; the answer then is another
   derived probe, not a list.

2. **port-v3 §7.2 step 5's `--skip-migration-gate` — rejected.** The
   shell-first critique is right that "an override that proceeds is a fallback
   that reads as success" (`design-shell-first.md:761-762`), and its M12 shows
   the override is unnecessary once the gate compares **content hashes** taken
   at backup time rather than filenames: a renumbered migration with identical
   content then matches. Cost if wrong: a migration whose content legitimately
   changed after it was applied refuses a good bundle, and the operator's only
   route is to check out the recorded `source_sha`. That is stated in the
   refusal text.

3. **shell-first's `NOVA_MOVED` env var and compose passthrough — rejected
   entirely**, along with its claim that *"a `docker run` of the sidecar image
   by hand bypasses it; nothing on the host can prevent that"*
   (`design-shell-first.md:884-886`). Its own critique calls that sentence
   false and the python-tool design proves it: `deploy/tailscale/` is already
   bind-mounted read-only at `/config` (`deploy/docker-compose.yml:290`), so
   the marker lives inside the thing it governs with **no compose change and
   no single-file bind**. Net simplification and a stronger control.

4. **python-tool's `nova-backup` image and its mounted docker socket —
   rejected.** Its own risk 8 concedes *"a mounted socket is root on the
   host"*, and its bootstrap requires `docker build` on the restore target at
   the moment of a disaster. The pack image is the already-built core image,
   launched with no socket. Cost if wrong: on a host where the core image was
   never built, `backup` refuses naming `./install` as the fix — and `restore`
   does **not** need it, because §9.2's backend probe falls through to
   `python:3.12-slim`.

5. **port-v3's `meta.json`-decides-nothing absolute — rejected as stated,
   kept as a rule with one named exception.** python-tool's minor 2 is right:
   restore must choose *which passphrase* to try before it can decrypt
   anything, and the only pre-decryption source of a bundle's fingerprint is
   `meta.json`. The rule becomes: **nothing that survives a failed decrypt is
   decided by `meta.json`.** A wrong choice there fails the KAT and refuses.

### Not carried, and why

- **port-v3 m1** — that its §4.4 misreads v3's `backup_coverage.py:583-610`
  and cites the lines that disprove it. The finding is correct; the section it
  corrects is not carried, because this verdict does not port v3's host-scan
  classification wholesale.
- **python-tool minor 3** — `PATH_POLICY`'s "first match wins" is stated and
  then violated by its own row order. Moot: there is no `PATH_POLICY` here
  (§6.4 is segments plus git), so there is no ordering to get wrong.
- **python-tool minor 7** — `--env NOVA_BACKUP_PASSPHRASE` keeps the value in
  the container's `Config.Env`, readable by `docker inspect`. Moot: the
  passphrase arrives on **stdin** and never as an env var (§7.5), which is a
  stronger answer than the one the finding asks for.

### Where two critiques disagreed, and what it costs if I chose wrong

| Question | Decision | Cost if wrong |
|---|---|---|
| Fingerprint salt: port-v3 M4 says per-file scrypt key; shell-first M5 says one fixed application salt | **Per-file** (§7.4) | The drill pays one scrypt per bundle it cross-checks instead of one total. At n=2^15, r=8 that is ~34 MB and well under a second each; a directory of 50 bundles costs seconds. A fixed salt would let one precomputed table serve every Nova bundle everywhere, which is the worse direction |
| `undo-move` with the moved-to peer online: shell-first refuses; python-tool states-and-proceeds | **States and proceeds** with a typed literal (§9.5) | If the owner did want a hard stop there, he gets a flap he has to resolve by stopping one node. The house rule settles it: a check may state a CANNOT, never decide a MAY NOT |
| Where the disposition lives: port-v3's Python tables vs shell-first's compose `x-` keys vs python-tool's Python tables | **Compose `x-` keys for everything compose names; git + segments for host paths** (§6) | Two extra keys per volume in the compose file, and the awk readers must survive a compose YAML shape change. Pinned by checked-in fixtures from two compose versions and by R1, which refuses when the render does not contain everything the raw text declares |
| Does `--profile '*'` suffice: python-tool makes the gap a refusal; shell-first says an older compose treats `*` as a literal and nothing catches it | **Both** — wildcard for resolved names, raw text for the declared set, and R1 for the gap (§6.1) | An older compose renders nothing extra and R1 refuses, naming the two sets. That is a stated cannot, not a narrowing |
| Whether the `.env` conflict needs a typed confirmation (shell-first C3's fix) | **No** (§9.2 step 8) | Restore already refuses a non-empty target, so a conflicting secret on an empty target was generated by an install that never used it. Overwriting destroys nothing. Every replaced key is printed by name. If that reasoning is wrong — because some key was hand-edited for a reason — the operator sees the list after the fact rather than before it |

---

## 3. My own finding, which none of the three designs accounts for

**`docker compose config --format json` keeps a TOP-LEVEL `x-` key and strips
every NESTED one — a volume's, a service's, a long-syntax mount's. The plain
YAML render keeps them all.** Measured here on compose **v5.3.0** with a
synthetic probe file carrying one `x-` key at each of those four positions, and
**re-measured by hand on 2026-09-21, same compose version** [M]. The sharper
claim matters: the one position the JSON render preserves is the one position
no disposition in this design occupies, because every disposition §6.2 declares
is nested under a volume, a service or a mount.

The probe file declares `x-nova-top-level:` at the document root, `vol_one`
with `x-nova-backup:` + `x-nova-backup-reason:`, `vol_three` with the same two
keys and **no service mounting it**, service `alpha` with
`x-nova-backup-anon:`, and a long-syntax bind carrying the two keys.

```
$ docker compose --project-directory $D -f $D/docker-compose.yml config --format json
{ "name": "novaxprobe",
  "services": { "alpha": { "command": ["true"], "entrypoint": null,
                           "image": "alpine:3.20",
                           "volumes": [ {"type":"volume","source":"vol_one",
                                         "target":"/one","volume":{}},
                                        {"type":"bind","source":"/abs/bindsrc",
                                         "target":"/b"} ] } },
  "volumes":  { "vol_one": { "name": "novaxprobe_vol_one" } },
  "x-nova-top-level": "kept-or-not" }
                    ^ the only x- that survives: no volume, no service and no
                      mount keeps one, and vol_three is not in here at all

$ docker compose --project-directory $D -f $D/docker-compose.yml config     # YAML
services:
  alpha:
    volumes:
      - type: bind
        source: /abs/bindsrc
        target: /b
        x-nova-backup: exclude-code
        x-nova-backup-reason: from git
    x-nova-backup-anon:
      /var/cache/thing:
        disposition: exclude-ephemeral
        reason: a cache
volumes:
  vol_one:
    name: novaxprobe_vol_one
    x-nova-backup: include
    x-nova-backup-reason: the notes
x-nova-top-level: kept-or-not

$ docker compose --project-directory $D -f $D/docker-compose.yml config --volumes
vol_one
```

Consequences, all binding:

- The disposition readers read the **YAML** render. `install.sh` already reads
  that text with awk (`config_volume_name`, `deploy/install.sh:405`), so this
  is the existing idiom, not a new one.
- `port-v3`'s §4.1 renders `compose.json` with `--format json` and parses it
  for coverage. Had it also put dispositions in the compose file, it would
  have seen none. The JSON render stays — it is the right source for resolved
  mount structure and full volume names — but the **dispositions come out of
  the YAML** and the shell writes them into `facts/dispositions.json`.
- The pack container therefore needs no YAML parser for the DISPOSITIONS; the
  shell hands it `facts/dispositions.json`. (Written when nothing was thought
  to guarantee PyYAML in the core image. `rulings.md` 2026-09-21 measured that
  `uvicorn[standard]` puts it there, and moved the RAW parse into the
  container on the strength of it. The dispositions reading stays here: this
  bullet's conclusion survives, its premise did not.)

The same probe confirmed the second half of shell-first C2, and the re-measure
confirmed it again [M]: `vol_three` — declared under `volumes:`, carrying its
own `x-` keys, mounted by no rendered service — is **pruned from the JSON
render, from the YAML render and from `config --volumes` alike**. It is not
merely undecorated; it is absent, so nothing downstream can know to ask about
it. That is why §6.1's declared set is read from the raw file text and can
never be read from a render.

**The two measurements are the two halves of §6, and neither is a style
preference: pruning is why the declared set must come from raw compose text;
nested-`x-` stripping is why the dispositions cannot come from the JSON
render.** Both were taken on compose v5.3.0, twice.

---

## 4. Every file created or modified

### Created

| Path | Responsibility |
|---|---|
| `deploy/backup.sh` | `cmd_backup`, `cmd_restore`, `cmd_drill`, `cmd_undo_move`; the fact renderers (§6.1); `sha256_of`, `mode_probe`, `archive_name`, `pack_image`, `pg_image`, `writer_services`; the EXIT traps. Orchestration and refusal only — no data, no keys. Sourced by `install.sh`, entry-guarded like `deploy/install.sh:1139-1141` so the suite can source it. |
| `deploy/passphrase.sh` | The resolver seam (§8). |
| `deploy/subnet.sh` | `decide_subnet`, `docker_subnets_in_use`, `host_routes_in_use`, `subnet_overlaps`, `ip_to_int`, `pick_project_subnet`, `derive_subnet_addrs` (§10.2). Sourced by `install.sh` **and** `backup.sh`. |
| `deploy/compose_read.sh` | The awk readers over the **YAML render**: `cfg_volume_name`, `cfg_volume_disposition`, `cfg_bind_disposition`, `cfg_anon_disposition`, `cfg_service_keys`, `cfg_volume_keys`, `cfg_mounts`, `cfg_anon`, `dispositions_json`. Sourced by both. Separate file because §12.1 drives it against checked-in fixtures from two compose versions. **The raw-text readers are no longer here** — `rulings.md` 2026-09-21 moved that parse to `novabundle.py` and PyYAML; `backup.sh` stages the bytes. The two SOURCES of §6.1 are unchanged. |
| `deploy/backup/novabundle.py` | The container-side worker. Subcommands `plan`, `pack`, `verify`, `kat`, `fingerprint`, `genpass`, `listing`. Holds `NOVAENC1`, the tar builder, the member hasher, the manifest writer/validator. Consumes `facts/*.json`; **never shells out**. |
| `deploy/backup/nova_restore.py` | The standalone reader (#3). Stdlib + `ctypes` libcrypto, with `cryptography` preferred when importable. No imports from this repo. **Byte-identical to the copy inside every bundle.** |
| `deploy/backup/restore.sh` | POSIX `sh`. The four-backend probe, KAT-gated (§7.3). Travels in every bundle. |
| `deploy/backup/README.txt.in` | The cleartext paragraph, templated at pack time. |
| `deploy/backup/pyproject.toml` | `ruff` + `pytest` config mirroring `services/core/pyproject.toml`, so CI has `uv run --project deploy/backup pytest`. |
| `deploy/backup/tests/*.py` | §12.3. |
| `deploy/backup/fixtures/` | `compose-v5.3.0.yaml`, `compose-v5.5.1.yaml` (the YAML render, captured on each host), `compose-v5.3.0.json`, `containers-v4.json` (`docker ps -a` + `docker inspect .Mounts` on a live v4 stack — **the fixture port-v3 C2 proves is missing**), `volumes-minipc-precleanup.json` (from `map-minipc-measured.md:20-30`), `ignored-paths.txt` (captured from the real `git status --porcelain --ignored=matching`, never hand-written). |
| `deploy/backup_test.sh` | Shell suite, `#!/usr/bin/env bash`, `set -uo pipefail` (the harness shape at `deploy/install_test.sh:13`, deliberately no `-e`). Stubs `docker`, `git`, `ip`, `netstat`, `stat`, `psql`. No docker, no network. |
| `apps/novad/repoint.go`, `apps/novad/repoint_test.go` | §11. |

### Modified

| Path | Change |
|---|---|
| `deploy/docker-compose.yml` | (a) `:332-334` become `${NOVA_SUBNET:-172.18.0.0/16}`, `${NOVA_SUBNET_RANGE:-172.18.0.0/17}`, `${NOVA_SUBNET_GATEWAY:-172.18.0.1}` — defaults are today's literals, so the Dell's live network does not move. (b) every entry under `volumes:` (`:337-351`) gains `x-nova-backup` + `x-nova-backup-reason`. (c) the four binds (`:13`, `:83`, `:185`, `:290`) become long syntax carrying the same two keys. (d) `searxng` (`:162`) gains `x-nova-backup-anon` for `/etc/searxng` and `/var/cache/searxng`. |
| `deploy/install.sh` | `main`'s case (`:1130-1137`) gains `backup`, `restore`, `drill`, `undo-move`; sources the four new scripts. `cmd_install` (`:1078`) gains `refuse_if_moved` first and `check_foreign_project` inside `preflight` (`:322`), and `decide_subnet` after `generate_secrets` (`:912`) and before `record_compose_files` (`:956`). New: `compose_config_text_all_profiles` (stderr captured, **not** discarded — `compose_config_text` at `:394-396` swallows it), `check_foreign_project`, `foreign_containers`, `foreign_volumes`, `project_own_volumes`, `delete_foreign_project`, `refuse_if_moved`, `sha256_of`. `set_env_value` (`:880`) gains `[ -f "$ENV_FILE" ] \|\| : > "$ENV_FILE"`. |
| `deploy/tailscale/start.sh` | A step 0 before containerboot: `/config/MOVED_TO` present → print it and `exit 1`. POSIX `sh`, Alpine. |
| `deploy/tailscale/start_test.sh` | Two cases for the above. |
| `deploy/install_test.sh` | §12.2. |
| `deploy/.env.example` | `NOVA_SUBNET`, `NOVA_SUBNET_RANGE`, `NOVA_SUBNET_GATEWAY`, `NOVA_PASSPHRASE_SOURCE`, `NOVA_PASSPHRASE_FILE`, `NOVA_PASSPHRASE_CMD`, `NOVA_BACKUP_DIR`; and a `# nova-backup: carry\|host\|drop` line above **every** key, including commented-out declarations for `COMPOSE_FILE` and `INSTANCE_SECRET` (shell-first m6: `COMPOSE_FILE` is written into every real `.env` by `record_compose_files` and is absent from `.env.example`, so without a declaration every existing install refuses on its first backup). |
| `deploy/README.md` | New `## Backups`, `## Restoring`, `## Moving Nova to another host`, `## Refreshing the coverage fixtures`. `### Migrating an existing node` (`:203-230`) points at `backup --move`. The published `nova_restore.py` digest (§7.6). |
| `.gitignore` | `deploy/backups/`, `deploy/.restored`, `deploy/.moved`, `deploy/.restore-in-progress`, `deploy/tailscale/MOVED_TO`, `deploy/.backup-passphrase`. |
| `apps/novad/main.go` | `case "repoint"` in the switch (`:40-48`) and a usage line. |
| `.github/workflows/rebuild-ci.yml` | §12.5. |
| `docs/plans/rebuild/hub-topology.md:135,411`, `docs/plans/rebuild/hub/r2-integration.md:61,550` | Delete the now-wrong "backups exclude `network_credentials`" text, per `rulings.md:60-67`. |

### Explicitly not modified

Nothing under `services/*/app/`, `services/*/migrations/`, `apps/web/src/`,
`evals/cases/` or `tests/`. `test_tools_registry`'s pinned name set,
`test_eval_corpus`'s `suite_version` and count, and
`services/core/tests/test_no_approvals.py` must all be untouched and green
(#30, #31, `rulings.md:68-71`). If an S41 change reddens one of them, the
change is out of scope.

---

## 5. The bundle format

### 5.1 The outer archive — plain uncompressed `tar`, mode 0600, owned by the operator

Name: `nova-backup-<host>-<YYYYMMDDTHHMMSSZ>[-N].tar`. The stamp is UTC and
sorts lexicographically, which is what lets `drill` find the newest bundle
without a portable `date -d` (macOS has none, `map-portability.md:63`). `-2`,
`-3`, … are appended only on a collision.

Uncompressed on purpose: member 7 is incompressible AEAD ciphertext and
members 1–6 together are under 60 KB, so `tar -xOf <bundle> restore.sh` works
on a many-GB file without streaming past the payload. **Member order is
forced, not alphabetical:**

| # | Member | Encrypted | Purpose |
|---|---|---|---|
| 1 | `README.txt` | no | one paragraph for whoever finds the file: what it is, that it is encrypted, the exact line to run, and the sentence that running the carried script is running code from the bundle (§7.6). |
| 2 | `nova_restore.py` | no | the standalone reader. **Byte-identical to `deploy/backup/nova_restore.py` in git**, so one published digest covers every bundle. |
| 3 | `restore.sh` | no | POSIX `sh`; the four-backend KAT-gated probe (§7.3). Also byte-identical to its git copy. |
| 4 | `kat.sha256` | no | 64 hex — the sha256 of the KAT plaintext. |
| 5 | `kat.enc` | yes | 64 known bytes under the same passphrase with **its own fresh salt**, so a decryptor and a passphrase can be proven before a payload byte is read. |
| 6 | `meta.json` | no, **unauthenticated** | listing and backend selection. §5.4. |
| 7 | `payload.enc` | yes | `NOVAENC1` over the inner archive. |

Built as `<final>.part` **in `$OUT`** (so the publish rename is
intra-filesystem by construction), created with `O_EXCL` and mode 0600 before
the first byte, chowned to the invoking uid/gid and re-stat-ed, and renamed
only after §9.1 step 20's round trip passes.

### 5.2 The inner archive — `tar.gz` inside `payload.enc`

```
MANIFEST.json                   ALWAYS the first member
db/<dbname>.dump                pg_dump -Fc --no-owner --no-acl
db/<dbname>.counts.tsv          "<schema>.<table>\t<rows>\t<digest>", LC_ALL=C sorted
db/<dbname>.migrations.tsv      "<filename>\t<sha256 of the file on disk>"
listings/<key>.sha256           the entry listing (§5.5)
volumes/<key>/<relpath>         one volume per prefix, numeric uid/gid/mode
files/<repo-relative path>      included host files
env/carried.env                 KEY=VALUE for the `carry` keys only
```

`MANIFEST.json` is first because gzip cannot seek: listing a bundle otherwise
means decompressing everything ahead of the member you want, and v3 measured
3.4 s of pointless decompression on a 167 MB bundle before the order was
forced (`backend/app/backup_snapshot.py:298-305`).

No nested tars. Python's `tarfile` records numeric uid/gid/mode directly, so a
nested `tar --numeric-owner` would buy nothing and would need a temp file the
size of the volume. Restore extracts with `--numeric-owner` inside a root
container.

### 5.3 `MANIFEST.json` — exact fields and types

Authenticated, because it is inside `payload.enc`. **Every restore decision
reads this file and nothing else** — with the one named exception in §2's
rejection 5. Loading is strict: a documented key that is absent, or a value of
the wrong type, **raises rather than defaulting**, and an unknown top-level
key is an error, because a manifest this code does not fully understand is not
a manifest it may restore from. `null` is a value, not an absence.

```jsonc
{
  "format": "nova-backup/2",                 // str, exact
  "bundle_version": 2,                       // int. 1 is v3's shape and is refused BY NAME.
  "created_at": "20260921T143002Z",          // str, %Y%m%dT%H%M%SZ UTC, == the filename stamp
  "mode": "routine",                         // str, one of "routine" | "move"
  "transport": "local",                      // str, one of "local"|"tailnet"|"removable".
                                             //   RECORDED ONLY — no consumer in S41 (§14.7)
  "migration_match": "content",              // str. "content" in S41; the reader branches on it
  "source": {
    "host": "dell-xps-8950",                 // str, os.uname().nodename
    "os": "Linux 6.18.33.1-microsoft-standard-WSL2",  // str
    "repo_sha": "12ea01bf…",                 // str, 40 hex, or null when git could not be read
    "repo_dirty": true,                      // bool | null (null with repo_sha)
    "project": "nova",                       // str, the resolved compose project name
    "compose_files": ["/abs/deploy/docker-compose.yml"],  // list[str], absolute, in -f order,
                                             //   passed in by the wrapper — compose does NOT
                                             //   report them in its rendered config [M]
    "profiles": ["inference", "tailnet"],    // list[str], every profile rendered
    "docker_version": "29.6.1",              // str
    "compose_version": "v5.3.0",             // str
    "pack_image_id": "sha256:…"              // str, the image the packer actually ran as
  },
  "postgres": {
    "server_version": "16.10",               // str, SHOW server_version
    "server_version_num": 160010,            // int, SHOW server_version_num
    "pg_dump_version": "16.10",              // str, from the container's own pg_dump --version
    "pg_dump_major": 16,                     // int — restore refuses a LOWER local major
    "container_image": "postgres:16",        // str, the tag compose asked for
    "container_image_id": "sha256:…"         // str, what was actually running
  },
  "session": {                               // object[str,str] — the GUCs every digest in this
    "TimeZone": "UTC",                       //   bundle was measured under, pinned with SET LOCAL
    "DateStyle": "ISO, MDY",                 //   in the SAME statement (§9.1 step 9). Restore
    "IntervalStyle": "postgres",             //   applies exactly these before re-measuring; a
    "extra_float_digits": "0",               //   key it does not know is a refusal, because a
    "bytea_output": "hex",                   //   digest measured under an unknown frame is not
    "lc_numeric": "C"                        //   comparable (measurement-frames-outlive-their-code)
  },
  "databases": [{                            // list[object], sorted by name. EVERY database on
    "name": "nova_core",                     //   the server; there is no per-database disposition
    "owner": "core",                         // str, the owning role, read from pg_catalog
    "dump_member": "db/nova_core.dump",      // str
    "dump_bytes": 91234567,                  // int
    "dump_sha256": "4c9a…",                  // str, 64 hex
    "counts_member": "db/nova_core.counts.tsv",       // str
    "migrations_member": "db/nova_core.migrations.tsv", // str
    "tables": 24,                            // int — the NUMBER measured, not "ok"
    "rows": 232941,                          // int, summed
    "selftest": {
      "scratch_db": "nova_selftest_a1b2c3d4",// str, matches ^nova_selftest_[0-9a-f]{8}$
      "tables_compared": 24,                 // int — the number COMPARED
      "equal": true                          // bool — always true in a written bundle
    }
  }],
  "volumes": [{                              // list[object], sorted by key
    "key": "v4_memdata",                     // str, the compose KEY
    "full_name": "nova_v4_memdata",          // str, READ from the render, never assembled
    "disposition": "include",                // str, one of the eight (§6.2)
    "prefix": "volumes/v4_memdata/",         // str, the inner-archive prefix
    "listing_member": "listings/v4_memdata.sha256",  // str
    "listing_sha256": "0a3e…",               // str, 64 hex OF THE LISTING FILE'S BYTES
    "entries": 1412,                         // int, every entry in the listing (files, dirs, links)
    "files": 1301,                           // int, regular files only
    "bytes": 96431104,                       // int, summed member sizes
    "restore_to": "volume:nova_v4_memdata"   // str
  }],
  "binds": [{                                // list[object], sorted by source
    "source": "/abs/data",                   // str, the resolved absolute host path
    "target": "/data",                       // str
    "service": "gateway",                    // str
    "disposition": "exclude-derived",        // str
    "reason": "regenerated by detect_hardware…"  // str, non-empty for every exclude-*
  }],
  "files": [{                                // list[object], sorted by member
    "member": "files/deploy/.env",           // str
    "origin": "deploy/.env",                 // str, repo-relative
    "restore_to": "deploy/.env",             // str — the WRITER decides, the restorer obeys
    "mode": 384,                             // int, the low 9 permission bits (0o600 == 384)
    "bytes": 412,                            // int
    "sha256": "…"                            // str, 64 hex
  }],
  "env_keys": ["POSTGRES_PASSWORD", "…"],    // list[str] — the CARRIED key NAMES only.
                                             //   Values live in env/carried.env. Host-local keys
                                             //   are not here and not in the archive (§9.2 step 8)
  "members": [{                              // list[object], every inner member after MANIFEST
    "path": "db/nova_core.dump",             // str
    "origin": "postgres:nova_core",          // str, where it came from on the source host
    "kind": "db",                            // str, one of db|counts|migrations|listing|tree|file|env
    "bytes": 91234567,                       // int
    "sha256": "4c9a…",                       // str, 64 hex of the member's bytes; for a "tree"
                                             //   member it is the LISTING file's hash (§5.5)
    "restore_to": "db:nova_core"             // str: "db:<name>" | "volume:<full name>" |
                                             //   a repo-relative path. An unknown form refuses.
  }],
  "member_count": 17,                        // int, members after MANIFEST.json
  "excluded": [{                             // list[object] — MANDATORY and never empty-by-omission.
    "kind": "volume",                        //   A restore that cannot say what it is missing
    "name": "v4_ollama",                     //   invites the operator to assume it is missing
    "disposition": "exclude-redownload",     //   nothing (backend/app/backup_snapshot.py:284-289)
    "reason": "model weights, tens of GB, re-pulled…"  // str, non-empty, ALWAYS
  }],
  "coverage": {
    "sources": ["raw", "config", "containers", "git", "env", "pg"],  // list[str]
    "services": ["core", "gateway", "…"],    // list[str], every service in the render
    "entries": 22,                           // int
    "refusals": []                           // list — ALWAYS empty in a written bundle
  },
  "identity": {
    "core_signing_key_sha256": "77d1…",      // str 64 hex, or null when the row does not exist.
                                             //   NEVER the key. null == null is equality at
                                             //   restore; one side null is a failure.
    "tailnet_dns_name": "nova.<tailnet>.ts.net",  // str | null
    "tailnet_state_carried": false,          // bool — true only in --move mode
    "device_count": 3,                       // int
    "people_count": 1                        // int
  },
  "encryption": {
    "container": "NOVAENC1",                 // str
    "cipher": "aes-256-gcm",                 // str, LOWERCASE (§7.1)
    "kdf": "scrypt",                         // str
    "n": 32768, "r": 8, "p": 1,              // int, int, int
    "dklen": 32, "chunk": 4194304,           // int, int
    "fingerprint_kind": "scrypt-key",        // str — how the CLEARTEXT fingerprint is derived
                                             //   (§7.4). A reader that does not know the value
                                             //   refuses rather than comparing the wrong thing.
    "passphrase_sha256_12": "3a9f10c4bb27",  // str — the RAW sha256(passphrase)[:12], kept ONLY
                                             //   here, inside the ciphertext it identifies
    "passphrase_source": "file"              // str, the resolver name that supplied it
  },
  "reader_sha256": "9b71…"                   // str, 64 hex of nova_restore.py — the digest
                                             //   published out of band (§7.6). Recorded here too
                                             //   so a decrypted bundle can confirm what it shipped.
}
```

`encryption` living inside the encrypted manifest looks circular and is not:
the parameters needed to **decrypt** are in the `NOVAENC1` header, which is
outside. The manifest's copy exists so that after decryption the drill can
cross-check what it opened.

### 5.4 `meta.json` — cleartext, unauthenticated, advisory

```jsonc
{
  "outer_version": 1,                        // int
  "encrypted": true,                         // bool
  "format": "nova-backup/2",                 // str
  "bundle_version": 2,                       // int
  "created_at": "20260921T143002Z",          // str
  "mode": "routine",                         // str
  "transport": "local",                      // str
  "source_host": "dell-xps-8950",            // str
  "member_count": 17,                        // int
  "bytes_payload": 198342144,                // int
  "payload_sha256": "…",                     // str, 64 hex
  "passphrase_fingerprint": "8c21fa0e93b7",  // str, 12 hex — the SCRYPT-KEY form (§7.4)
  "fingerprint_kind": "scrypt-key",          // str
  "crypto": {"container": "NOVAENC1", "cipher": "aes-256-gcm", "kdf": "scrypt",
             "n": 32768, "r": 8, "p": 1, "chunk": 4194304},
  "crypto_image": "nova-core",               // str, the image that wrote it
  "fallback_image": "python:3.12-slim",      // str, backend 4 of §7.3's probe
  "needs_images": ["postgres:16", "python:3.12-slim"],  // list[str] — what restore.sh prints
  "reader_sha256": "9b71…"                   // str — ADVISORY ONLY; see §7.6. It looks like a
                                             //   verification and is not one.
}
```

**The rule, stated in `README.txt` and enforced in `nova_restore.py`: nothing
that survives a failed decrypt is decided by `meta.json`.** It exists for three
jobs — listing bundles without a passphrase, choosing a decryptor backend, and
printing the `docker pull` lines — plus the one named exception: restore must
pick *which* passphrase to try before it can decrypt anything, and the only
pre-decryption source of a bundle's fingerprint is this file (§2, rejection 5).
A wrong choice there fails the KAT and refuses. Every other value it duplicates
is re-read from the authenticated manifest and compared; a disagreement is a
refusal.

### 5.5 Member hashing, and what a listing covers

A file member's `sha256` is over its bytes, read in 1 MiB chunks. A **tree**
member — a volume or an included directory — has no single file to hash, so
its recorded hash is the sha256 of its **listing file's bytes**, and the
listing is what restore diffs against:

```
d 0755 0 0 ./people
f 0644 1000 1000 ./people/jeremy
l 0777 1000 1000 ./people/current
<sha256>  ./people/jeremy/2026-09-21.md
<sha256>  ./people/jeremy/topics/4-local-models.md
```

Type, mode, uid and gid lines first for **every** entry, then a content hash
line per regular file, all `LC_ALL=C` sorted. python-tool minor 5: a listing
of `find . -type f` alone cannot detect a missing symlink, a lost empty
directory or a changed mode, all of which are inside the tar — which weakens
"the restored file set is identical" into "the restored *files* are". Restore
re-derives the listing **inside the same container** and diffs it, so a
mismatch names the entries that differ rather than saying "the tree differs";
that is strictly better than v3's folded tree hash.
---

## 6. Coverage

### 6.1 The facts, and where each comes from

`backup.sh` renders six files into `$STAGE/facts/`. Each renderer checks its
own exit status **and** that its output parses; an empty-but-successful fact
is a failure, not "nothing to carry". Every renderer captures stderr and
carries it into the refusal — `compose_config_text` (`deploy/install.sh:394-396`)
discards stderr with `2>/dev/null`, and the new all-profiles renderer must not
(port-v3 m5).

| File | Command | Why this source |
|---|---|---|
| the `raw` fact | `render_raw` **stages the text of every file in `COMPOSE_FILE`** into `facts/compose/`; `novabundle.py` parses it with PyYAML and derives the fact (`rulings.md` 2026-09-21 — there is no `raw.json`) | The declared set. Compose **prunes** a volume no rendered service mounts — out of the JSON render, the YAML render and `config --volumes` alike, re-measured by hand on compose v5.3.0 on 2026-09-21 (§3) [M] — so a render can never be the authority on what was declared. |
| `config.yaml` | `docker compose "${COMPOSE_ARGS[@]}" --profile '*' config` | The **dispositions**, and only here: `--format json` keeps only a **top-level** `x-` key and strips every **nested** one — per volume, per service, per mount — and every disposition §6.2 declares is nested (compose v5.3.0, re-measured by hand 2026-09-21, §3) [M]. |
| `dispositions.json` | `compose_read.sh` over `config.yaml` | What the container reads for the dispositions, already reduced to JSON. |
| `config.json` | the same command with `--format json` | Resolved full volume names, resolved absolute bind sources, mount `read_only`, service environment, `depends_on`, the project name. Warnings go to stderr; only stdout is parsed. |
| `containers.json` | `docker ps -a --filter label=com.docker.compose.project=$P --format json`, then `docker inspect` for `.Mounts` per id | Anonymous and image-declared volumes compose never names. **This is the source with no fixture in port-v3, and it is the only one that can see `searxng`'s anonymous volume** [M]. Exited containers included. |
| `git.json` | per host path under a scan root: `git check-ignore -q <rel>/` then `<rel>`; else `git ls-files --error-unmatch`; else unknown | §6.4. **The trailing slash is not optional** [M]: `git check-ignore -v data` exits 1 while `git check-ignore -v data/` matches `.gitignore:13`, and `../data` is a real bind (`deploy/docker-compose.yml:83`). A verbatim port of v3's `git_status_fn` makes every v4 backup refuse on day one. |
| `reachable.json` | per include-class volume: `docker run --rm -v <name>:/probe:ro $PG_IMAGE find /probe -mindepth 1 -maxdepth 1 -print -quit`; per include-class file: `[ -r "$path" ]` | R6. Mounted at `/probe`, a path no image populates (shell-first m3). Exit status is read, not stdout emptiness (python-tool M1). |

**Why two compose sources and not one.** Each measured behaviour rules out one
single-source shortcut. Pruning rules out deriving the **declared set** from
any render: a volume that no service mounts is the exact case coverage exists
to catch, and it is the one case a render cannot show. Nested-`x-` stripping
rules out deriving the **dispositions** from the JSON render, which is
otherwise the convenient source because it parses without awk. A one-source
implementation is not simpler; it is wrong in one of the two directions, and
silently — the JSON-only version sees every volume as undeclared, the
render-only version never sees the pruned volume at all. §12.1 pins both
directions.

Scan roots are **derived**: `{dirname(COMPOSE_FILE)} ∪ {every resolved bind
source}` — not `dirname(bind)`, which resolves to the repo root and drags in
all of v3's tree (python-tool C1(a)). Today that is
`{deploy, data, searxng, deploy/postgres-init, deploy/tailscale}`.

### 6.2 Where a disposition lives

| Thing | Where the disposition is declared |
|---|---|
| a named volume | `volumes: <key>: x-nova-backup:` + `x-nova-backup-reason:` |
| a bind | the long-syntax mount's own `x-nova-backup:` + `x-nova-backup-reason:` |
| an image-declared (anonymous) volume | the service's `x-nova-backup-anon: {<target>: {disposition, reason}}` |
| an `.env` key | `# nova-backup: carry\|host\|drop` immediately above the key in `deploy/.env.example` |
| a host path under a scan root that no mount names | git (§6.4) |
| a database | **nothing** — every database on the server is carried, so a database a later slice adds cannot be silently dropped |

The eight legal dispositions, a closed set the reader checks:

| Value | Meaning | v4's members today |
|---|---|---|
| `include` | carried verbatim | `v4_memdata`, `v4_workspace` |
| `dump-pg` | never file-copied; carried as logical dumps | `v4_pgdata` |
| `move-only` | carried only under `--move` | `v4_tailscale` |
| `exclude-code` | comes back from git | `./postgres-init`, `../searxng`, `./tailscale`, searxng's `/etc/searxng` |
| `exclude-redownload` | comes back from a registry or a model pull | `v4_ollama`, `v4_models` |
| `exclude-derived` | regenerated by the installer | `../data` (`detect_hardware` writes `hardware.json`, `deploy/install.sh:808-863`) |
| `exclude-ephemeral` | a cache; losing it costs time, not data | searxng's `/var/cache/searxng` |
| `exclude-declined` | deliberately out, and the reason says why | — |

Every `exclude-*` **requires** a non-empty `x-nova-backup-reason`. A missing
reason is R2, not a default.

### 6.3 The algorithm

```
coverage(facts, mode) -> (entries, refusals)          # mode = routine | move

 1. PROJECT := config.json["name"]. Refuse unless it equals the project name of
    the checkout's own compose text, re-read.                        -> R0
 2. Gap check.  raw.services ⊆ config.json.services
                raw.volumes  ⊆ config.json.volumes                   -> R1
    This is what catches a compose build that treats `*` as an ordinary
    profile name, and it is what makes `--profile '*'` a convenience rather
    than the safety mechanism.
 3. Declared volumes := raw.volumes.  For each:
      full name    := config.json.volumes[k].name   (READ, never assembled)
      disposition  := dispositions.json.volumes[k]
      missing, or not one of the eight, or exclude-* with no reason  -> R2
      declared but absent from the render (pruned)                   -> R2,
        with the text "declared in <file> and mounted by no service"
 4. Mounts.  For every service in config.json, for every mount:
      volume, source declared      -> record; read_only false -> S writes it
      volume, source undeclared    -> R2
      bind                         -> disposition from dispositions.json
                                      binds[(service,target)]        -> R2 if none
      bind source still contains "${" or "$"                         -> R3
      tmpfs                        -> excluded, ephemeral, no declaration needed
 5. Live mounts.  For every container in containers.json (exited included),
    for every .Mounts entry:
      Type=volume, Name matches ^[0-9a-f]{64}$  -> ANONYMOUS, keyed
        (service, Destination); disposition from x-nova-backup-anon   -> R2 if none
      Type=volume, Name not in the declared set (after stripping the
        "<project>_" prefix from the CONTAINER side only, never from the
        compose side)                                                 -> R4
      Type=bind, Source not in the bind set                           -> R4
 6. Host paths.  For every regular file under a scan root not inside a mount:
      a path segment is in SEGMENT_POLICY        -> that disposition
      git says tracked                           -> exclude-code
      git says ignored                           -> include
      git says unknown, or git could not be asked-> R2 / R0
 7. .env keys.  For every key in deploy/.env:
      declaration from .env.example's comment line -> carry | host | drop
      none                                         -> R2
 8. Databases.  SELECT datname FROM pg_database WHERE datallowconn
      AND datname NOT IN ('postgres','template0','template1')
      empty                                        -> R7
 9. Mode overlay.  move-only becomes include when mode == "move".  This is the
    only mode-dependent rule and each reason text says so.
10. Reachability (reachable.json) for every include-class source -> R6
11. Existence: an include-class volume with no volume on this host -> R5
12. may_backup := (refusals == [])
```

`may_backup` is **never** "a partial bundle with a warning"
(`backend/app/backup_coverage.py:686-693`). Every refusal is collected, so one
run names them all.

### 6.4 Host paths: git, and a segment table that is not a path table

Port-v3's M10 is the reason this is segments and not paths. Its `PATH_POLICY`
listed `.superpowers` as an exact row; the real scan emits
`.superpowers/sdd/.gitignore` and `.superpowers/sdd/<dir>/`, because
`.superpowers/` is **not** in `.gitignore` (confirmed [M]: `.gitignore` lists
`.claude/` and `.worktrees/` and not `.superpowers/`; the ignore comes from a
nested `.superpowers/sdd/.gitignore`). An exact-match table misses it and the
backup refuses in this worktree today.

`SEGMENT_POLICY`, in `deploy/backup/novabundle.py`, a name that means the same
thing wherever it appears: `.git`, `.claude`, `.superpowers`, `.worktrees`,
`__pycache__`, `.venv`, `venv`, `node_modules`, `.ruff_cache`, `.pytest_cache`,
`.mypy_cache`, `dist`, `build`, `dev-dist`, `.egg-info`, `backups`. Each row
carries a written reason and each is `exclude-ephemeral` or
`exclude-declined`.

Everything else falls to git: **tracked → `exclude-code`, ignored →
`include`, neither → R2.** That is one derived source, not a list, and it is
what makes classification total over a real tree without a catch-all — the
catch-all being exactly the silent skip #4 forbids
(`critique-python-tool.md:127-134`). `deploy/.env` lands in `include` by this
rule, which is how the one file nothing can regenerate gets carried at all.

Consequence, stated: backup needs host `git` **and a git work tree**.
`git check-ignore` outside one exits 128, and the renderer's refusal names
"this directory is not a git work tree" as a case distinct from "git failed"
(port-v3 m6).

### 6.5 The compose-file rows S41 writes

```yaml
volumes:
  v4_pgdata:
    x-nova-backup: dump-pg
    x-nova-backup-reason: >-
      a live PGDATA file copy is torn. Captured as pg_dump -Fc per database;
      a fresh volume initialises from deploy/postgres-init/01-databases.sql
      with the carried password.
  v4_memdata:
    x-nova-backup: include
    x-nova-backup-reason: >-
      the notes (services/memory/app/store.py:1-18) — the state with no other
      copy anywhere. .embeddings/*.jsonl rides along; it is a cache and
      carrying it only saves a rebuild.
  v4_workspace:
    x-nova-backup: include
    x-nova-backup-reason: Nova's own scratch space; a file she wrote lives only here.
  v4_models:
    x-nova-backup: exclude-redownload
    x-nova-backup-reason: >-
      gateway's /models. Its only reader in the whole service is os.statvfs
      for a free-space check (services/gateway/app/admin.py:59,332).
  v4_ollama:
    x-nova-backup: exclude-redownload
    x-nova-backup-reason: >-
      local model weights, tens of GB, re-pulled. Stated cost: a restore on a
      disconnected machine has no local inference until the pulls finish.
  v4_tailscale:
    x-nova-backup: move-only
    x-nova-backup-reason: >-
      the tailnet node identity. Two live nodes sharing one identity flap, so
      it travels only on a move — which also leaves MOVED_TO behind.

services:
  searxng:
    x-nova-backup-anon:
      /etc/searxng:
        disposition: exclude-code
        reason: searxng's generated runtime config; the settings come from ../searxng in git.
      /var/cache/searxng:
        disposition: exclude-ephemeral
        reason: a search result cache; it regenerates on use.
```

Those two `searxng` rows are port-v3 C2, and the volume is live on this
machine right now [M]:

```
$ docker inspect nova-searxng-1 --format '{{range .Mounts}}{{.Type}} | {{.Name}} -> {{.Destination}}{{"\n"}}{{end}}'
bind   |                  -> /etc/searxng
volume | 289bbf48…6210ca  -> /var/cache/searxng
$ docker inspect searxng/searxng:latest --format '{{json .Config.Volumes}}'
{"/etc/searxng":{},"/var/cache/searxng":{}}
```

The image is deliberately unpinned (`deploy/docker-compose.yml:162-171`), so
the next upstream image that adds a `VOLUME` line reproduces this refusal —
which is the behaviour we want, and `deploy/README.md` gains the procedure for
refreshing `containers-v4.json` when it happens.

### 6.6 The exact refusal

`novabundle.py` exits **3** having written nothing — no `.part`, no staging
leftovers — and prints to stderr:

```
Error: this stack has state the backup cannot account for. No bundle was written.
Nothing was stopped, dumped or written.

  R2_UNCLASSIFIED   volume v4_vectors  (nova_v4_vectors)
      declared in deploy/docker-compose.yml, mounted by service `memory` at /data/vectors.
      Nothing says what a backup should do with it, so this backup will not
      claim to be complete. Git cannot see inside a volume, so this is the one
      thing that must be decided by hand.
      fix: in deploy/docker-compose.yml, under `volumes: v4_vectors:` add
             x-nova-backup: include | dump-pg | move-only | exclude-code |
                            exclude-redownload | exclude-derived |
                            exclude-ephemeral | exclude-declined
             x-nova-backup-reason: "<why>"     (required for every exclude-*)

  R2_UNCLASSIFIED   anonymous volume  service `searxng` at /var/cache/searxng
      the image declares this volume; compose never names it, so it has no
      entry under `volumes:` to carry a disposition.
      fix: in deploy/docker-compose.yml, under `services: searxng:` add
             x-nova-backup-anon:
               /var/cache/searxng: {disposition: <one of the eight>, reason: "<why>"}

  R6_UNREACHABLE    volume v4_memdata  (nova_v4_memdata)
      classified as state to carry, but the backup cannot read it:
      `docker run --rm -v nova_v4_memdata:/probe:ro postgres:16 find /probe …` exited 125.
      A bundle that silently omits a tier is worse than no bundle.

3 refusals. Decide each one, then run `./install backup` again.
```

`backup.sh` propagates exit 3 unchanged and adds nothing. `Error:` is the
house prefix for a stated refusal. The eight codes: `R0_FACT_UNREADABLE`,
`R1_PROFILE_GAP`, `R2_UNCLASSIFIED`, `R3_INTERPOLATION`,
`R4_UNDECLARED_LIVE_MOUNT`, `R5_VOLUME_MISSING`, `R6_UNREACHABLE`,
`R7_NO_DATABASES`.

### 6.7 Is this the banned `BACKUP_EXCLUDE_DATA` by another name?

No, and the distinction is the whole argument, so it is written into
`deploy/README.md` rather than left to a reader.

| | `BACKUP_EXCLUDE_DATA` | this |
|---|---|---|
| where the SET comes from | the list | the raw compose text + the render + live containers + git |
| a thing in the stack but not declared | **silently skipped** | **refuses the whole run** |
| a declaration naming nothing real | invisible | reddens `test_policy_names_only_real_things` |
| where the declaration lives | its own file | beside the thing it describes, in the same document the set comes from |

---

## 7. Crypto

Ported from `backend/app/backup_crypto.py` with the wire format **byte for
byte unchanged**. The python-tool critique verified the port line by line
against v3 (`critique-python-tool.md:39-46`) and it is correct.

### 7.1 The container format `NOVAENC1`

```
b"NOVAENC1"                       8-byte magic
uint32be                          header length   (<= 4096, else CryptoError)
header JSON, sorted keys, no spaces:
  {"v":1,"cipher":"aes-256-gcm","kdf":"scrypt","n":32768,"r":8,"p":1,
   "salt":"<32 hex>","nonce_prefix":"<8 hex>","chunk":4194304}
frames to EOF:  [uint32be ciphertext length][ciphertext || 16-byte GCM tag]
```

`"cipher"` is **lowercase** — python-tool's minor 1 caught the design writing
`"AES-256-GCM"`, which `backend/app/backup_crypto.py:119,154` rejects as
`unsupported format`, breaking the stated ability to open a v3 payload. Pinned
by a byte comparison against a v3-written fixture.

- **Cipher**: AES-256-GCM, 128-bit tag, applied **per frame**, so neither side
  ever holds a multi-hundred-MB file in memory twice.
- **KDF**: `hashlib.scrypt(passphrase.encode("utf-8"), salt=salt, n=32768,
  r=8, p=1, dklen=32, maxmem=256*1024*1024)`. Stdlib, chosen precisely so the
  standalone reader derives the same key with no third-party package
  (`backend/app/backup_crypto.py:17-19`). ~34 MB per derivation.
- **Salt**: 16 random bytes, **fresh per file** — so `kat.enc` and
  `payload.enc` have different keys.
- **Nonce**: 4 random bytes per file `||` uint64be frame index from 0. Unique
  per (file, frame) with nothing stored; reconstructed from position.
- **Chunking**: 4 MiB frames; the reader accepts up to 64 MiB. Finality is
  decided at write time by cumulative **position** (`done >= size`), never by
  a short read — the last frame of an exact-multiple file is full length
  (`backend/app/backup_crypto.py:169-171`) — and at read time by **lookahead**
  (`:203-213`): the next frame header is read before the current frame is
  decrypted, and `final = (next is None)`.
- **AAD** = `MAGIC || header_bytes || uint64be(index) || (0x01 if final else
  0x00)`. This authenticates the header **and the frame's position in the
  sequence**. A tampered header fails, a reordered frame fails, and — the one
  that matters for a backup — a **truncated** file fails instead of quietly
  yielding a shorter archive.
- **Reader-side cost cap**, checked before any allocation, separate from the
  writer's cost: `0 < n <= 2**18` and a power of two, `0 < r <= 16`,
  `0 < p <= 4`, `128*r*n <= 128 MiB`, `0 < chunk <= 64 MiB`, `salt` exactly 16
  bytes, `nonce_prefix` exactly 4. A decryptor must allocate `128*r*n` bytes
  *before* the first authentication check can run, so without this a tampered
  header naming an absurd cost makes an honest reader allocate gigabytes, or
  blow `maxmem` and turn "tampered" into a bare `ValueError`. Every violation
  raises `CryptoError`, never `ValueError`, never `MemoryError`.
- **One sentence for every failure**, identical in `novabundle.py` and
  `nova_restore.py` and pinned character-for-character by a test: *"decryption
  failed — wrong passphrase, or the file is corrupt, truncated or tampered
  with (GCM cannot tell these apart)."* GCM genuinely cannot distinguish them,
  and pretending otherwise is what produces "the passphrase must be right, so
  the file must be broken" at 3am.

### 7.2 Passphrase generation

`secrets.token_bytes(20)` → 160 bits → base32, lowercased, 8 groups of 4
joined by `-`. Optimised for transcription onto paper, not for typing, because
the point is that it is recorded off-machine. **Generated inside
`novabundle.py genpass`, never by `openssl rand 20` captured with `$( )`** —
shell-first m10: bash drops NUL bytes and strips trailing newlines from a
command substitution, so roughly one generated passphrase in thirteen would
silently carry less than 160 bits, undetectably.

### 7.3 How the in-bundle reader decrypts on a bare machine

`restore.sh` (POSIX `sh`) probes four backends **in order** and accepts one
only after it passes a known-answer test: decrypt `kat.enc` — 64 known bytes
under the real passphrase with its own fresh salt — and compare the sha256 to
the cleartext `kat.sha256`.

1. host `python3` (≥ 3.9) with `import cryptography` → `nova_restore.py`;
2. host `python3` with a usable `libcrypto` through `ctypes`:
   `EVP_CIPHER_CTX_new`, `EVP_DecryptInit_ex(EVP_aes_256_gcm())`,
   `EVP_CIPHER_CTX_ctrl(…, EVP_CTRL_AEAD_SET_IVLEN, 12, …)`,
   `EVP_DecryptUpdate` for the AAD then the ciphertext,
   `EVP_CIPHER_CTX_ctrl(…, EVP_CTRL_AEAD_SET_TAG, 16, tag)`,
   `EVP_DecryptFinal_ex` — whose **return value is the tag check**, and a zero
   return is a `CryptoError`, not a warning. On `sys.platform == "darwin"`
   `ctypes.util.find_library` is **never called**, because Apple's stub
   libcrypto aborts the whole process; only
   `/opt/homebrew/opt/openssl@3/lib/libcrypto.dylib` and
   `/usr/local/opt/openssl@3/lib/libcrypto.dylib` are tried
   (`scripts/nova_restore.py:118-127`). **[unverified]** — no macOS machine
   was available; risk 6, §15;
3. `docker run --rm -i --network none -v <bundle dir>:/b:ro -v <out>:/out
   <meta.crypto_image> python3 /b/nova_restore.py`;
4. the same with `<meta.fallback_image>` (`python:3.12-slim`), pulling if
   absent.

Backend 4 is the answer to "a machine that has only docker" and it is what
unblocks the DoD walk on the mini PC, where no `nova-core` image exists until
`./install` has run (shell-first C3, half one). If no candidate passes,
`restore.sh` exits 1 and prints exactly what to install and the `docker pull`
lines from `meta.needs_images`. It never falls back to "try anyway". The KAT
gate is what makes that possible: it fails at candidate-selection time, before
any payload byte is read, instead of half-decrypting.

**The dependency, named plainly.** Backup adds no host dependency beyond
`bash`, `docker` and `git`. Restore needs **one of** python3-with-a-decryptor
or docker. A machine with docker but no registry access cannot restore — it
also cannot run `postgres:16` to have a database at all — and `meta.json`
records `needs_images` so `restore.sh` can say which.

`os.umask(0o077)` is the first statement of `nova_restore.py`'s `main()`, so
nothing it writes is ever group- or world-readable; on **any** exception
anywhere in `main()`, everything the run created under `--out` is removed. A
half-decrypted `.env` must never be left looking like a finished restore.

### 7.4 The passphrase fingerprint, and the oracle it is not

v3's fingerprint is `sha256(passphrase)[:12]`
(`backend/app/backup_passphrase.py:151-155`) and v3 writes it into cleartext
meta (`backend/app/backup_snapshot.py:351`). Two critiques found the same
defect independently (port-v3 M4, shell-first M5): an attacker holding the
bundle reads it without a passphrase and tests candidates at **one unsalted
SHA-256 each**, then pays scrypt once for the confirmed hit. Against an
operator-chosen passphrase — which `prompt`, `env` and `cmd` all make
first-class — the entire work factor is annulled.

**Decision: the cleartext fingerprint is derived from the key, not the
passphrase.**

```
fingerprint(passphrase, salt) = sha256(scrypt(passphrase, salt, n, r, p, 32))[:12]
```

where `salt` is **this file's own header salt**. It still answers "does the
passphrase I have open this bundle" and "do these two bundles share a
passphrase" (derive under each file's salt and compare), and each guess now
costs one scrypt — which is the whole point of having one. The raw
`sha256(passphrase)[:12]` is kept only inside the encrypted manifest, where it
is already behind the thing it identifies.

Chosen over shell-first's single application-constant salt because a fixed
salt lets one precomputed table serve every Nova bundle everywhere. Cost of
the choice: `drill`'s cross-bundle check pays one scrypt per bundle instead of
one total — ~34 MB and well under a second each.

### 7.5 Hygiene, mechanically

The passphrase reaches exactly one place: the first line of the pack
container's stdin, consumed before anything else. Never argv, never `-e`
(which `docker inspect` would show for the container's lifetime), never a
positional CLI argument, never a file the container mounts.
`passphrase_never_reaches_argv` stubs `docker` as a shell function recording
`$*` for every call and asserts the value appears in none of them and that no
`-e` carries it. Nothing logs it; the only thing logged is the 12-hex
fingerprint.

### 7.6 The in-bundle reader is executable code, and it is unauthenticated

python-tool M6, accepted. `nova_restore.py` and `restore.sh` travel in
cleartext; their only authenticated hashes are inside `payload.enc`, which is
what they exist to open. There is no order of operations in which the operator
authenticates the code before running it, and `meta.json`'s
`restore_script_sha256` is *worse* than nothing because it looks like a
verification.

Three mechanical answers, none of them a gate:

1. `nova_restore.py` and `restore.sh` are **byte-identical to their git
   copies** — no templating, no stamping — so one digest covers every bundle
   for a given commit. Pinned by `test_bundle_layout.py`.
2. `backup`'s verdict line prints that digest, `deploy/README.md` publishes
   it, and `./install backup --print-reader-sha256` prints it without making a
   bundle — so the operator can compare **out of band** against a digest that
   did not travel with the file.
3. `README.txt` says in one sentence that running the carried script is
   running code from the bundle, and that restoring from a checkout is the
   verified path.

---

## 8. The passphrase resolver seam

`deploy/passphrase.sh`, bash 3.2, no associative arrays.

### 8.1 Interface

```sh
# Every resolver is a function named  nova_pass_<name>.
#   stdin  : nothing
#   stdout : the passphrase, exactly, no newline appended
#   stderr : a reason, on failure only
#   exit 0 : resolved
#   exit 3 : genuinely ABSENT — the caller MAY create one
#   exit * : UNAVAILABLE — the caller REFUSES and never creates one
resolve_passphrase()       # -> stdout + the same exit codes
passphrase_fingerprint()   # stdin: passphrase + salt; stdout: 12 hex (via the container)
```

The 3-vs-other split is v3's hardest-won lesson
(`backend/app/backup_passphrase.py:55-73`): a store that exists but cannot be
read must **never** read as "absent", or the next backup generates a
replacement over the passphrase that still seals every existing bundle. Only
exit 3 permits creation.

`resolve_passphrase` dispatches by `case` over `$NOVA_PASSPHRASE_SOURCE` (from
`deploy/.env`, default `file`). An unknown source refuses **by name and lists
the sources it has**.

### 8.2 The four resolvers that land now

| Source | Reads | Absent (exit 3)? |
|---|---|---|
| `file` (default) | `${NOVA_PASSPHRASE_FILE:-$DEPLOY_DIR/.backup-passphrase}`, mode-checked 0600 (refuse otherwise, naming the mode it read), trailing newline stripped | yes, when the file does not exist |
| `env` | `$NOVA_BACKUP_PASSPHRASE` | yes, when unset or empty |
| `prompt` | `read -r -s` on a TTY; twice on create, compared — a transcription check, mechanical, not a sentence asking the operator to be careful | no — a non-TTY is exit 1, *"cannot prompt without a terminal"*: a stated cannot |
| `cmd` | stdout of `$NOVA_PASSPHRASE_CMD` | no — a non-zero exit is **unavailable**, never absent |

Creation happens only on exit 3 and only for `file`. Written under `umask
077`, then `chmod 600`, then the mode is **read back**; if it is not `600` the
file is deleted and the backup refuses. Two concurrent backups cannot each
generate one: the create is guarded by `mkdir
"$DEPLOY_DIR/.backup-passphrase.lock"` (atomic on every filesystem) and the
loser re-reads inside the lock and becomes a reader, never a second writer.
The new passphrase is printed **once**, with the sentence that it is the only
copy and nothing else can open the bundles.

Any failure that is not exit 3 refuses the whole bundle: **no passphrase, no
bundle** (`backend/app/backup_service.py:146-152`).

On the restore side the order is `--passphrase-file <path>` →
`$NOVA_BACKUP_PASSPHRASE` → interactive prompt, and each candidate is tried
**stripped, then verbatim** — a paper transcription usually gains whitespace,
and a stored value may legitimately carry it.

### 8.3 How a secrets manager plugs in later

Two ways, neither of which touches a caller:

- **today, with zero code**: `NOVA_PASSPHRASE_SOURCE=cmd` and
  `NOVA_PASSPHRASE_CMD='op read op://nova/backup/passphrase'` (or `bw get
  password …`, or `aws secretsmanager get-secret-value … --output text`);
- **later, as a first-class resolver**: add `nova_pass_onepassword()` and a
  `case` arm.

That is exactly the owner's 2026-08-02 shape (v3 #32, `ARCS.md:386-388`).
Proposal A — the store itself — is out of S41 (`rulings.md:48-49`); when it
lands it registers `store` here and nothing else moves.
`resolvers_are_exactly_the_documented_set` asserts the `case` arms and
`.env.example`'s documented options are the same four, so adding a source
without offering it — or offering one that does not exist — is a red suite.

---

## 9. The verbs

Convention, applied to every step: **a step states what it verifies and what
it does when that verification fails. A step that cannot make its own
verification FAILS and names the verification it could not make.** No `|| true`,
no `ignore_errors`, no fallback that reads as success.

Second convention, from a measured incident rather than a principle: **the
writer is not the verifier, so an artefact a container writes must end up
readable by the invoking user, and the step that writes it proves that by
reading it back as the operator.** During the mini PC cleanup on 2026-09-21 the
archive step wrote its tar as root inside a container, and the host-side
`tar -tzf` / `sha256sum` check — running as the invoking user — failed with
`Permission denied` **naming the host path**, which reads as a host bug and is
not one; the fix was a `chown <uid>:<gid>` inside the container, after which
the operator's own `sha256sum -c` passed
(`map-minipc-measured.md:164-171`). In S41 exactly one artefact crosses that
boundary — the published bundle — so the rule is enforced in one place, §9.1
step 19, and pinned in one place, §12.1's
`the_operator_can_read_the_file_the_container_wrote`. Requirement #26 (an
archive path that cannot hold mode 0600 is refused) is the other half of the
same fact: a 0600 that belongs to root protects the bundle from its owner.

Exit codes, uniform: `0` verified · `1` a verification failed · `2` the
environment could not be asked · `3` refused before anything was touched · `4`
**partial** — the artefact is good but the machine was not left as found. `4`
exists so "the backup is fine, the stack is not" can never be printed as `0`
(python-tool's ladder, adopted).

### 9.1 `./install backup [--move] [--transport local|tailnet|removable] [--out DIR]`

1. **Take the run lock and refuse a moved host.** `mkdir "$OUT/.nova-backup.lock"`
   — atomic on every filesystem — released in the EXIT trap. Verifies the
   `mkdir` succeeded. Held → refuse: *"a backup is already running (lock held
   since <stamp>)"*. Then verify `deploy/.moved` is absent; present → exit 1
   printing the marker and `./install undo-move`. (shell-first M11: without
   the lock, two runs in the same second both compute the same `<final>`, both
   write `<final>.part`, and the verify reads the file both are touching.)
2. **Archive directory mode probe, on the HOST** (#25, #26). `mkdir -p`,
   `chmod 700`; write `$OUT/.nova-mode-probe.$$`, `chmod 600`, read the mode
   back with `stat -c '%a' 2>/dev/null || stat -f '%Lp' 2>/dev/null` (the pair
   already at `deploy/install_test.sh:266,317`), unlink. Verifies the value
   read back is exactly `600`. Not `600` → refuse naming the path and the mode
   observed: *"this filesystem cannot hold owner-only permissions (read back
   0777). The bundle carries every secret this machine has, so it will not be
   written somewhere that cannot protect it."* **Neither `stat` form answered**
   → refuse; never assume. This replaces the hardcoded `/mnt/[a-z]/` regex and
   it runs on the host, not in the container: a container's view of a
   bind-mounted host directory is synthesised by the file-sharing layer, so a
   `chmod`+`stat` round trip **inside** the container can succeed on a host
   filesystem that cannot hold the mode — which is exactly the NTFS/exFAT/CIFS
   case the probe exists for (python-tool M11).
3. **Facts** (§6.1), all six, taken fresh — never cached, because the refusals
   must reflect the stack at the moment a bundle is written
   (`backend/app/backup_service.py:99-101`). Verifies each renderer exited 0
   and its output parses. Fails → refuse naming the command **and its
   stderr**.
4. **Coverage** (§6.3). Verifies `may_backup`. Any refusal → §6.6, exit 3.
   **Nothing has been stopped yet** — that is why this step is here and not
   later. Coverage also comes **before** the free-space check, because the
   free-space check needs the include set coverage produces: shell-first m1
   caught its sibling design numbering the two the other way round, so as
   written its step 3 could not run.
5. **Passphrase** (§8). Verifies exit 0 and a non-empty value. Exit 3 → create
   and continue; any other exit → refuse. No passphrase, no bundle. Before the
   `du -sk` pass, so a missing passphrase refuses without spending containers
   on measurement.
6. **Free space, twice, in kilobytes.** (a) `du -sk` each include-class source
   from step 4's plan, in a throwaway `$PG_IMAGE` container, plus the summed
   `pg_database_size`; require `detect_disk_free_kb "$OUT"` ≥ `sum * 400 /
   100`. Four times, not twice: the run holds the staging tree, `inner.tgz`,
   `payload.enc`, the `.part`, and the round-trip's streamed re-read
   (python-tool minor 4, which counted the same five and called `2×` an
   under-count). (b) `df -Pk /var/lib/postgresql/data` **inside the live
   postgres container**; require ≥ 1.2 × the summed `pg_database_size`,
   because step 10's self-test restore writes a full second copy of every
   database onto **that** filesystem, not onto `$OUT` (port-v3 M6). Verifies
   both numbers were read. Either unreadable, or insufficient → refuse with
   both numbers and the filesystem named. `detect_disk_free_kb` is
   `detect_disk_free_gb` (`deploy/install.sh:92-93`) without its two
   divisions — bash `$(( ))` has no floats, so the ratio is integer
   arithmetic and both sides are KB (shell-first m2).
7. **Stop the writers, and derive who they are.** The writer set is the union
   of two facts, both in the rendered config, minus `postgres` by name:
   - services mounting an include- or move-only-class volume with
     `read_only: false`;
   - **services whose environment carries a `postgresql://…@postgres` URL or
     whose `depends_on` names `postgres`.**

   The second half is shell-first M2, and it is not hypothetical: `gateway`
   mounts only `v4_models` read-write (`deploy/docker-compose.yml:84`) — an
   `exclude-redownload` volume — so under the mount rule alone it stays
   running while it writes `nova_gateway` through
   `DATABASE_URL: postgresql://gateway:…@postgres:5432/nova_gateway` (`:77`).
   One spend row between step 9's census and step 10's dump puts the dump a
   row ahead of the counts, and step 11 then refuses a perfectly correct
   backup, at random, whenever the gateway is doing its job.

   `docker compose stop` them, then poll `docker inspect -f
   '{{.State.Running}}'` per container to 60 s. Verifies every writer reads
   `false` **and** that `.State.FinishedAt` is later than the moment the stop
   was issued, so a container that was already dead for other reasons is not
   read as "we stopped it". Any still running, or `docker inspect` unable to
   answer → restart what this run stopped and refuse: *"could not confirm
   <svc> stopped"* is a failure, not a pass.

   **From here to step 21 an EXIT trap restarts exactly the list this step
   stopped**, unless the run reached step 21 or `--move` was given. It prints
   what it restarted and exits non-zero naming anything it could not. Without
   it, a Ctrl-C at step 13, an OOM at step 17 or a dropped SSH session leaves
   core, gateway, memory and web stopped indefinitely — `restart:
   unless-stopped` does not bring back a container stopped by `docker compose
   stop`, and there is no marker in the routine path to record that a backup
   was mid-flight (port-v3 M8).
8. **Postgres alive and versions agree.** `pg_isready -U postgres` inside the
   live container; `SHOW server_version` and `SHOW server_version_num` from
   the live server; `pg_dump --version` from a throwaway container of the
   **image id read off the running postgres container**. Verifies all three
   parse and the majors are equal. Differ, or any unreadable → restart the
   writers, refuse.
9. **Census, per database.** Pin the session in the same statement as the
   measurement — `SET LOCAL TimeZone='UTC'; SET LOCAL DateStyle='ISO, MDY';
   SET LOCAL IntervalStyle='postgres'; SET LOCAL extra_float_digits=0; SET
   LOCAL bytea_output='hex'; SET LOCAL lc_numeric='C';` — because `t::text`
   renders timestamps, intervals, floats, bytea and numerics through those
   GUCs and all of them are settable per-database and per-role. A source
   pinning one set and a freshly initialised target pinning another produce
   different digests for identical data, and step 15 would then refuse a good
   restore after the whole multi-GB extract (port-v3 m2, shell-first M9).

   Then, for every `BASE TABLE` in a non-system schema:

   ```sql
   SELECT count(*),
          coalesce(sum(('x'||substr(md5(t::text),1,16))::bit(64)::bigint), 0)
     FROM <schema>.<table> t;
   ```

   **Not** `md5(string_agg(t::text, '' ORDER BY t::text))`. `string_agg`
   materialises the whole table as one `text` value and PostgreSQL's hard
   varlena limit is 1 GB; past it the query fails with `invalid memory alloc
   request size`, which lands in the same branch as an un-castable type — so
   once any table crosses roughly a gigabyte of text, **every backup refuses
   for ever** and the only remedy is a code change. The sum form is
   constant-memory, needs no sort, is order-independent (which is what we want
   across a dump and restore), and `sum(bigint)` returns `numeric` so it
   cannot overflow. `coalesce(…, 0)` is python-tool M2: `md5(string_agg(…))`
   is NULL for an empty table and `psql -tAX` prints NULL as an empty string,
   indistinguishable from "no measurement" — so any zero-row table turned a
   healthy stack into a refused backup that sent the operator hunting a
   phantom.

   Also read `schema_migrations.filename ORDER BY filename`, the **sha256 of
   each of those migration files on disk** (§9.2 step 7), and
   `encode(sha256(private_key_hex::bytea),'hex') FROM core_signing_key` —
   computed in SQL so the key value never crosses the process boundary. Zero
   rows is legitimate on a hub that has never paired a device
   (`services/core/migrations/011_devices.sql:19-23`) and is recorded as
   `null`, listed in `excluded` with the reason. Verifies: every catalogued
   table produced both numbers; `schema_migrations` exists in every database;
   at most one `core_signing_key` row. Fails → refuse naming the database, the
   table and the SQL error. Never skipped.
10. **Dump**, per database, in a throwaway `$PG_IMAGE` container on the project
    network, writing into the **stage volume** — a throwaway docker volume the
    host never mounts — so the plaintext dump, which holds the signing key and
    every provider API key, never lands on the host filesystem:
    `pg_dump -Fc --no-owner --no-acl -U postgres -d <db>`. Databases are
    dumped **before** files are copied, for v3's reason
    (`backend/app/backup_snapshot.py:230-235`): an attachment written between
    the two shows up as a file with no row, which is recoverable; a row with
    no blob is not. Verifies exit 0, size > 0, **the first five bytes are
    `PGDMP`** (size alone is not enough: a `pg_dump` that fails after emitting
    a header leaves a plausible short file), and `pg_restore -l` exits 0 with
    ≥ 1 entry. Any failure → refuse.
11. **Self-test restore**, per database, in the same container. Scratch name
    `nova_selftest_<8 hex>` — **not** `nova_verify_*`: `drill`'s orphan sweep
    also walks `nova_verify_*`, and a drill started during a backup would try
    to drop the live run's scratch database and then report a failed drill for
    a healthy system (shell-first m11). `SELFTEST_RE =
    ^nova_selftest_[0-9a-f]{8}$` is asserted **before CREATE, before
    pg_restore and before DROP** — three independent assertions
    (`backend/app/backup_restore.py:58-64,217,234,290`). After CREATE, connect
    and compare `SELECT current_database()` to the expected name before
    anything is written: a DSN that looks right and resolves elsewhere is the
    failure this catches. Then `pg_restore --single-transaction
    --exit-on-error --no-owner --role=<owner>` — `--exit-on-error` is
    required, not tidiness: its default is to continue past errors, which
    turns a misdirected restore into an interleaving instead of a stop.
    Re-run step 9 under the identical pinned session and compare. Verifies
    **every** table's count and sum. Any mismatch → refuse naming the first
    differing table and both values. The scratch database is dropped in the
    trap either way.
12. **Tar each include-class volume** in a throwaway `$PG_IMAGE` container
    (#24), running as root because postgres-owned files are not otherwise
    readable, with the stage volume mounted for output:

    ```sh
    sh -ec 'tar -C /src --numeric-owner -cf /out/volumes/K.tar .
            cd /src
            find . -mindepth 1 \( -type f -o -type l -o -type d \) -printf "%y %#m %U %G %p\n" \
              | LC_ALL=C sort > /tmp/meta
            find . -type f -print0 | LC_ALL=C sort -z > /tmp/f
            if [ -s /tmp/f ]; then xargs -0 -a /tmp/f sha256sum > /tmp/h; else : > /tmp/h; fi
            cat /tmp/meta /tmp/h > /out/listings/K.sha256'
    ```

    Two things here are deliberate. **`sh -ec`, not an `&&` chain with a
    trailing `||`**: `||` binds to the whole chain, so a failed `tar` —
    a full `/out`, a read error, a permission problem — short-circuits to the
    empty-listing branch, which succeeds, so `sh -c` exits 0 and the step's
    stated "verifies tar exit 0" reads the `:`'s status, not `tar`'s. On an
    empty-or-nearly-empty volume every secondary check is then `0 == 0` and
    the volume is recorded as carried (port-v3 M3). `v4_workspace` on a hub
    where she has written nothing yet is exactly that volume. **And the
    listing covers types, modes and ownership, not just regular files**: a
    `find . -type f` listing cannot detect a missing symlink, an empty
    directory or a changed mode, all of which are inside the tar (python-tool
    minor 5). `-print0`/`xargs -0` handles a filename containing a newline.
    Verifies: `tar` exit 0; the listing's file-hash line count equals `find
    -type f | wc -l`; `tar -tf | grep -c -v '/$'` ≥ that count. Fails →
    refuse naming the volume.
13. **Copy each include-class host file** into the stage volume at
    `files/<repo-relative path>`; build `env/carried.env` from the `carry`
    keys only (§9.2 step 8). Verifies each copy's sha256 equals the source's.
    Fails → refuse.
14. **Crypto self-test.** Pipe the passphrase into `novabundle.py kat` in the
    pack image: encrypt 64 known bytes, decrypt them back, compare. Verifies
    this image can do `NOVAENC1` with this passphrase. Fails → refuse naming
    the image and the error. (This is step 14 and not step 4 only because the
    pack image is resolved here; it still runs before anything is written.)
15. **Hash pass.** `novabundle.py plan` with every include-class source
    mounted `:ro` and `facts/` mounted: walk each tree, size and hash every
    member, assemble `MANIFEST.json`. Verifies each source exists and is
    readable. Any unreadable → R6, refuse.
16. **Pack and encrypt.** `novabundle.py pack`, passphrase on stdin: writes
    `MANIFEST.json` **first**, then the members, gzips, encrypts frame by
    frame into `payload.enc` in the stage volume. Verifies the emitted member
    count equals `manifest.member_count` and the total plaintext consumed
    equals the inner archive's size. Mismatch → delete and refuse.
17. **Self-verify the inner archive.** Extract to a fresh temp dir with
    `safe_extract` and **re-derive** every member's sha256 from the extracted
    bytes — deliberately not trusting the numbers the manifest recorded
    moments ago. The exception handler here is broad on purpose: a truncated
    gzip raises `EOFError`, which is neither `TarError` nor `OSError`, and a
    narrower catch turns "corrupt" into an uncaught crash
    (`backend/app/backup_snapshot.py:420-427`).
18. **Outer tar, in the pack container**, with `$OUT` mounted `:rw` — not on
    the host. #24 says *"tars built inside throwaway containers"*, not "the
    inner tar"; `map-portability.md:67` says the outer-tar step must stay in
    Python or a container rather than use the host's `tar`; and a host-side
    step cannot read a stage volume the host never mounts (shell-first M7).
    Built as `<final>.part` in `$OUT` so step 21's rename is intra-filesystem
    by construction — `--transport removable` makes a cross-filesystem
    `os.replace` the normal case otherwise, and it raises after the expensive
    part (port-v3 m7). Created with `O_EXCL` and mode 0600 before the first
    byte. Members in §5.1's order.
19. **Chown to the operator, and prove it.** The wrapper passes
    `NOVA_HOST_UID`/`NOVA_HOST_GID`; the container `os.chown`s the `.part`,
    then **re-stats and fails if the chown did not take**. Verifies by having
    the host shell run `sha256_of "$part"` **as the operator** and requiring
    it to succeed. **Ownership, not mode, is what is relaxed here**: the
    cleanup's other half-fix, `umask 022`, is deliberately not carried, because
    the bundle holds every secret this machine has and must stay 0600 — a
    world-readable backup trades one failure for a worse one. This is
    python-tool C3 and it is a measured incident, not a hypothesis: *"a
    container writing the archive produces a root-owned, mode-0600 file, and
    the host-side verification — running as the operator — then cannot read it
    back. That bit during this very cleanup"*
    (`map-minipc-measured.md:164-171`). Without it the operator cannot
    `sha256sum`, `scp`, open or delete his own backup without `sudo`, and the
    DoD walk stops at the copy.
20. **Round-trip the finished file with the reader that ships inside it.**
    In the same container: extract `nova_restore.py` from `<final>.part` and
    run `python3 nova_restore.py --verify-only <final>.part` **with
    `cryptography` forced unimportable**, so the ctypes libcrypto path — the
    one a bare machine will take — is the path proven. It decrypts
    `payload.enc` as a stream, re-derives every member's sha256 from the
    decrypted bytes, compares to the `MANIFEST.json` it read from the stream's
    first member, and re-runs the KAT from the bundle's own `kat.enc`. Then
    assert the extracted `nova_restore.py` is byte-identical to the git copy.
    Verifies every member hash, the member count and the KAT. Any failure →
    delete the `.part`, refuse.

    This is port-v3 M11. The sha256-equality assertion alone proves the file
    is the right bytes; it does not prove those bytes can open **this**
    payload, and that is the difference between "the format round-trips" and
    "this artifact is restorable".
21. **Publish.** `os.replace(part, final)`, then `stat` the final path.
    Verifies the final path did not exist beforehand (a collision loop appends
    `-2`, `-3`, … — two snapshots in the same second let `os.replace` clobber
    the very bundle being restored, `backend/app/backup_snapshot.py:201-213`),
    the mode is `600`, the owner is the operator, and the size equals what
    step 18 wrote. Any wrong → delete and refuse.
22. **Restart, or park.**
    - routine: `docker compose up -d` the writers, then `wait_for_health`
      (`deploy/install.sh:1025-1054`). Verifies each is healthy inside the
      existing 240 s budget. Not healthy → **exit 4**, stating as two separate
      facts that the bundle **is** written and verified at `<path>` and that
      `<service>` did not come back, with its last 20 log lines. Never `0`.
    - `--move`: leave everything stopped, stop `postgres` too, write
      `deploy/tailscale/MOVED_TO` and `deploy/.moved` (§9.5), and verify both
      by reading them back. Fails → refuse saying the move marker is **not**
      in place, so nobody believes the source host is parked when it is not.
23. **Report.** One line per fact actually checked: writers stopped (n),
    tables measured (n per db), dumps verified (`PGDMP`, bytes), self-test
    equal (n tables per db), volumes tarred (n entries, n bytes), bundle
    round-tripped by the shipped reader, path, bytes, sha256, owner and mode,
    `passphrase_fingerprint`, the reader digest, every `excluded` entry with
    its reason, and the exact `restore` line. The word **verified** appears
    only after step 20.

### 9.2 `./install restore <bundle> [--passphrase-file F]`

Onto an **empty** target only. It never overwrites a live system (§14).

1. **Refuse a moved host, and a stale restore.** Verify `deploy/.moved` is
   absent (present → refuse, print it, name `undo-move`), and read
   `deploy/.restore-in-progress` if it exists (step 10).
2. **Create `deploy/.env` if absent**, from `deploy/.env.example`, `chmod
   600`, mode read back. `set_env_value` (`deploy/install.sh:880-899`) ends
   `done < "$ENV_FILE"`, and on a bare restore target that file does not
   exist; under `set -euo pipefail` (`:8`) the redirect kills the script and
   leaves a `deploy/.env.XXXXXX` behind. `cmd_install` never hits it because
   `generate_secrets` (`:912-916`) copies the example first; restore has no
   equivalent (port-v3 M2, python-tool M3). `set_env_value` also gains
   `[ -f "$ENV_FILE" ] || : > "$ENV_FILE"` as a belt.
3. **`decide_subnet` FIRST** (#12, §10.2). It **writes** the five keys and
   re-reads them. Verifies a non-colliding subnet was chosen and read back.
   Collision with a pinned `NOVA_SUBNET` → die naming the colliding network or
   route. First, because every step after this creates docker objects on that
   network, and a restore that creates volumes and then discovers the subnet
   is taken has already done work it cannot undo.
4. **Open the bundle.** Read the outer tar's cleartext members. Verify
   `meta.outer_version` is known. Resolve the passphrase for this bundle's
   fingerprint (the one place `meta.json` is consulted — see §2's rejection
   5), decrypt `kat.enc`, compare its sha256 to `kat.sha256`. Verifies the
   passphrase and the decryptor backend **before a payload byte is read**.
   Fails → refuse with §7.1's one sentence plus the bundle's recorded
   `passphrase_fingerprint`, so a rotation is stated when it is known and
   never guessed.
5. **Manifest and hashes.** Decrypt the stream, `safe_extract` into a private
   0700 temp dir, re-derive every member's sha256 and compare, and check
   `format`, `bundle_version` and every `meta.json` field the manifest
   duplicates. `safe_extract` refuses an absolute path, a `..` member, a
   symlink, a hardlink and a device node. Any mismatch → **hard stop**: remove
   everything created under the temp dir, print the first mismatching member,
   and **print no next steps at all**, so a failed verify can never read as a
   partial success.
6. **Refuse a non-empty target.** For **every volume in the declared set** —
   not `manifest.volumes` — whose disposition is `include`, `move-only` or
   `dump-pg`: `docker volume inspect`; if it exists, probe it with `docker run
   --rm -v <name>:/probe:ro $PG_IMAGE find /probe -mindepth 1 -maxdepth 1
   -print -quit`. Verifies **exit 0 with empty stdout**; a non-zero exit is
   "could not determine", which is a refusal, not a pass. `/probe` is a path
   no image populates, so the probe cannot populate the volume it is checking.
   Also refuse if any container carries
   `label=com.docker.compose.project=<project>`, exited ones included.

   Three separate findings converge here. `v4_pgdata` is `dump-pg`, so it has
   no `manifest.volumes` row and a loop over the manifest never inspects the
   single most important non-empty target on the machine (port-v3 M1,
   shell-first M3) — the sequence being: target ran `./install` once and was
   `docker compose down`-ed, so its PGDATA holds `<target-secret>`; restore
   writes the carried `.env` with `<source-secret>`; postgres-init does not
   re-run on a non-empty PGDATA; `pg_restore` succeeds over the local socket
   as superuser; every census matches; and then core, gateway and memory all
   fail to authenticate over TCP. The restore verified counts and md5s and
   still produced a hub that cannot open its own database. The probe's exit
   status is python-tool M1, measured: `ls -A /nonexistent | head -1` exits 0
   with empty stdout, so every failure mode reads as "empty, proceed". The
   mount path is shell-first m3.
7. **Version and migration gates.** `pg_restore --version` from `$PG_IMAGE`
   on this host; verify its major ≥ `manifest.postgres.pg_dump_major`. Lower,
   or unreadable → refuse with both numbers. Then, per database: for every
   entry in `manifest.databases[].migrations`, a file of that **content hash**
   must exist in this checkout's `services/<svc>/migrations/`. The hashes were
   taken at backup time by reading the files on disk — a file read, not a
   schema change, so #31 holds and `schema_migrations` still has no checksum
   column (`services/core/app/migrations_runner.py:19-24`). `manifest.migration_match`
   records `"content"` so a later slice can move the value without changing
   the reader. Verifies every one. Missing → refuse naming the filename, its
   database and `manifest.source.repo_sha`: *"this bundle is from a Nova this
   checkout does not have; check out `<sha7>` and restore there."*

   There is **no override flag**. shell-first M12 is right that a filename-only
   gate false-refuses a *renumbered* migration — a correct bundle refused,
   with the operator's only copy of his Nova and nowhere to go — and right
   that the fix is not an override ("an override that proceeds is a fallback
   that reads as success") but asking the question correctly. Content hashing
   makes a renumbered migration match and still refuses a genuinely different
   one, more accurately than before.
8. **Apply the carried `.env` keys.** The bundle carries a **key set**, not a
   file: only keys declared `carry` in `.env.example` (§6.2) are in
   `env/carried.env`, so `COMPOSE_FILE` — written into every real `.env` with
   absolute paths by `record_compose_files` (`deploy/install.sh:956-963`) —
   and `NOVA_SUBNET*`, `NOVA_WEB_ADDR`, `NOVA_TAILSCALE_ADDR`,
   `COMPOSE_PROFILES`, `TS_AUTHKEY` never travel. Without that split, step 3
   writes `NOVA_SUBNET` and step 8 finds the bundle's value present and
   different, and the restore the whole slice exists for deadlocks against
   itself (python-tool M4).

   Build the whole plan first, then apply: for each carried key, `.env` lacks
   it (write), holds an identical value (no-op), or holds a different value
   (**replace, and print the key name**). Then `chmod 600`, re-stat, and
   re-read every key to verify. A replacement is **not** a refusal and needs
   no confirmation: step 6 already refused a non-empty target, so a
   conflicting secret on this machine was generated by an install whose
   postgres never initialised with it — overwriting it destroys nothing. That
   is what unblocks the DoD walk, which otherwise hits five guaranteed
   conflicts because `generate_secrets` writes fresh values for all five
   `SECRET_KEYS` (`deploy/install.sh:29`) on every install (shell-first C3,
   half two). Stated bound: a key an operator hand-edited for a reason is
   replaced, and he sees the list of replaced key **names** — never values, on
   either side.
9. **Create the volumes and fill them.** `docker volume create --label
   com.docker.compose.project=<project> --label
   com.docker.compose.volume=<key> <full name>`; verify `docker volume
   inspect` reports both labels, because an unlabelled volume is one
   `docker compose up` will not adopt. Then stream the payload through a
   throwaway `$PG_IMAGE` container that untars `volumes/<key>/**` with
   `--numeric-owner`, recompute the listing **in that container** and diff it
   against `listings/<key>.sha256`. Verifies byte-for-byte listing equality.
   Any difference → refuse, printing the first ten differing paths and the
   counts of added, removed and changed; the volume is **left in place** for
   inspection and the run stops before touching the database.

   `$PG_IMAGE` here is resolved by **tag** from the compose config and pulled
   if absent — there is no running postgres container to read an image id off
   at this point, which the backup side can do and the restore side cannot
   (python-tool minor 6).
10. **The in-progress marker.** Before the first `docker volume create`, write
    `deploy/.restore-in-progress` (mode 0600) naming the bundle, its sha256,
    the project and **every object this run is about to create**; remove it at
    step 15. On a re-run, step 6's refusal quotes the marker and offers the
    §10.1 shape — exactly the objects this tool created, the typed literal
    `discard`, default do nothing. Nothing is discovered; the marker is the
    bound.

    This is shell-first M4 and it is the one genuinely new gap: without it, a
    restore that fails at step 12 leaves six labelled half-populated volumes
    and a container, and the re-run refuses **on state it created itself**,
    with no verb that clears it — so the operator's only route is hand-run
    `docker volume rm` on his only copy of the data, unguided, at the worst
    possible moment.
11. **Postgres up.** `docker compose up -d postgres`; poll health. Verifies
    healthy inside the existing budget, that the three databases and their
    owner roles exist (created by
    `deploy/postgres-init/01-databases.sql:13-20` on a fresh volume) and that
    each is **empty**. Missing → refuse rather than creating them by hand; not
    empty → exit 3. Fails → refuse with its last 20 log lines.
12. **Restore each database.** `pg_restore --exit-on-error --single-transaction
    --no-owner --role=<owner> -U postgres -d <db>` (#15) in the postgres
    container. Verifies exit 0. Non-zero → the whole transaction rolled back,
    so the database is exactly as it was; refuse with the stderr verbatim.
13. **Re-measure** (#16). Recompute every table's count and sum under the
    **identical** pinned session and compare to `db/<db>.counts.tsv`. Verifies
    every table present and every pair equal. A count difference is a
    failure — unlike v3, which forgave it because it compared `n_live_tup`
    statistics (`backend/app/backup_restore.py:264-279`); here both sides are
    exact `count(*)`, so there is nothing to forgive. Fails → refuse listing
    **every** difference, not the first.
14. **Signing key** (#16). Recompute `encode(sha256(private_key_hex::bytea),
    'hex')` from the restored `nova_core` and compare to the manifest.
    Verifies equality; `null == null` is equality, one side `null` is a
    failure. Every paired device pins this key
    (`services/core/app/devices_ws.py:288-289`), so a restore that lost it
    silently un-pairs every device.
15. **Park.** `docker compose stop postgres`; remove
    `deploy/.restore-in-progress`; write `deploy/.restored` (bundle name, its
    sha256, `created_at`, `source.host`, `source.repo_sha`) mode 0600; verify
    both by re-reading.
16. **Report.** Print the word **restored** only now, and only with the three
    facts behind it: `<n> tables compared across <m> databases`, `<k> volume
    listings diffed`, `signing key fingerprint equal`. If any of steps 9, 13
    or 14 did not run, the word is not printed at all. Then exactly one next
    command: `./install`.

### 9.3 `./install restore <bundle> --drill` (#17)

Non-destructive. Touches no live volume, no live database, no live container,
and **never writes `.env`** — so `decide_subnet` (step 3) and the `.env` plan
(step 8) are skipped entirely.

1. **Namespace.** `D=<8 hex>`. Objects: volumes `nova-drill-${D}_<key>`,
   container `nova-drill-${D}-pg`, network `nova-drill-${D}-net`, databases
   `nova_verify_<8 hex>`. The regex asserted immediately before every create
   and every delete is

   ```
   DRILL_RE = ^nova-drill-[0-9a-f]{8}(-pg|-net|_[A-Za-z0-9][A-Za-z0-9_.-]*)$
   ```

   asserted **on the object name that reaches the command**, not on the world
   id. python-tool M7: `^nova-drill-[0-9a-f]{8}$` matches none of the names it
   was said to guard, so the stated three-touchpoint control either fails on
   every create or is being applied to a different string than the one that
   reaches `docker volume rm` — which is its entire purpose.
2. **Image.** `$PG_IMAGE` by tag from the manifest, and the decryptor by
   §7.3's probe: prefer the local pack image, fall through to
   `meta.fallback_image` with a printed `docker pull`, refuse only when
   neither is obtainable. A drill therefore needs **docker, not a completed
   install** — which is what makes the DoD walk executable on the mini PC,
   where `deploy/docker-compose.yml` carries no `image:` for `core` (the only
   `image:` lines are `:5`, `:171`, `:208`, `:243`) so `nova-core` does not
   exist until `./install` has run (shell-first C3, half one). The same
   `$PG_IMAGE` is used for the version gate and for the throwaway server, so
   the drill cannot check a version it will not use (port-v3 m9).
3. **Isolation.** The throwaway postgres runs on `nova-drill-${D}-net`, not on
   the project network. That network is created with an **explicit** subnet
   from `pick_project_subnet` (§10.2) with the project's own network excluded,
   and torn down in step 5 — shell-first m9: a drill network with no IPAM
   takes whatever block docker hands it, which on a host where 172.17–172.21
   are already spoken for can be the very block a subsequent real restore was
   about to pick. `POSTGRES_PASSWORD` is a fresh `secrets.token_hex(16)` that
   never leaves the process, and `deploy/postgres-init/` is bind-mounted
   read-only so the roles and databases are created identically. Verifies via
   `docker inspect` that the container is attached to exactly that network.
   Otherwise → fail.
4. **Run §9.2 steps 4, 5, 7, 9, 12, 13, 14** against the drill objects —
   including **step 9**, the volume untar and listing diff. port-v3 M5: its
   §8.3 omitted the volume step, so the drill proved the three dumps restore
   and proved **nothing** about `v4_memdata` (the notes, which exist nowhere
   else) or `v4_workspace` (a file she wrote lives only here). Re-deriving a
   tar member's sha256 proves the bytes are intact; it does not prove the
   archive extracts, that the per-entry listing matches, or that the entry
   count is what the manifest claims. For two of the three tiers the verdict
   was uninformed.
5. **Teardown, in the EXIT trap.** Re-assert `DRILL_RE`, remove the container,
   every drill volume and the network, and **verify each removal** — `docker
   inspect` must now fail with "no such". A removal that cannot be verified
   makes the drill **FAIL**, naming the leftover, rather than reporting
   success on top of a mess. Never a silent `rm -f`, never `ignore_errors`.
6. Exit 0 only if every count, sum, listing and fingerprint matched **and**
   the teardown verified.

### 9.4 `./install drill` (#5 — the verb; the schedule is later)

The question it answers is *"could I recover from disaster today"*.

1. **Sweep.** Remove orphaned `nova-drill-*` volumes, containers and networks
   and orphaned `nova_verify_*` databases left by a run that died — a
   `finally` does not survive a process restart
   (`backend/app/backup_service.py:568-602`). "Orphaned" means: no
   `nova-drill-<RUN>-pg` container still exists for that RUN, and for a
   database, no open connection and created more than an hour ago. The
   container filter is anchored (`--filter name='^nova-drill-'`), because
   `docker ps --filter name=` is an unanchored substring match and would be
   wider than the anchored regex the volume sweep uses. Verifies each removal
   by re-listing; anything that will not go → report and fail. (port-v3 m4:
   an unconditional sweep deletes a concurrent drill's volumes out from under
   it — not reachable with one operator today, reachable the day a scheduled
   handler lands.)
2. **Bundles.** List `*.tar` in the archive directory. **Zero bundles is a
   FAILED drill**, not a vacuous pass: with no bundle the answer to the
   question is *no* (`backend/app/backup_service.py:662-665`).
3. **Newest.** Parse the `YYYYMMDDTHHMMSSZ` stamp out of each name and verify
   it parses; unparseable → fail naming the file. Never ordered by mtime. The
   stamp sorts lexicographically, so no `date -d` is needed — macOS `date` has
   none (`map-portability.md:63`) and there is no portable epoch-from-string
   form. Age in days is computed from `date +%s` and civil arithmetic on the
   stamp's digits, or the stamp is printed and the age omitted.
4. **Run** `restore --drill` on it. Verifies exit 0.
5. **The cross-check a drill alone cannot surface.** For every *older* bundle
   in the directory, derive the configured passphrase under that bundle's own
   header salt (§7.4) and compare to its cleartext
   `passphrase_fingerprint` — no decryption, no passphrase for those bundles
   needed. Any that differ are named: they need the previous passphrase, and
   the operator should know that before he needs them.
6. **Report** the bundle, its stamp and age, tables compared per database,
   listings diffed per volume, fingerprint equality, and the stale-passphrase
   list. The exit code **is** the verdict. No scheduler wiring in S41.

### 9.5 `backup --move`, the marker, and `undo-move`

`--move` differs from a routine backup in four ways: `v4_tailscale`'s
`move-only` disposition becomes `include`, `tailscale` joins the writer set,
the stack is left stopped, and the marker is written.

**The marker is `deploy/tailscale/MOVED_TO`.** That path, for a mechanical
reason: `deploy/tailscale/` is already bind-mounted into the sidecar read-only
at `/config` (`deploy/docker-compose.yml:290`), so the sidecar sees the marker
with **no compose change and no single-file bind** — a single-file mount
resolves to a host inode at create time and dies with exit 127 when the WSL
mount is recycled, which this repo has been bitten by. And
`deploy/tailscale/**` is `exclude-code`, so the marker never travels in the
bundle and cannot refuse to start on the destination — which is the real
reason r1's "write `MOVED_TO` into `v4_tailscale`" cannot be taken literally,
and which no design stated.

Line-oriented, mode 0600, so `sh` in an Alpine image can print it:

```
moved_at=20260921T143012Z
bundle=nova-backup-dell-xps-8950-20260921T143012Z.tar
bundle_sha256=<64 hex>
source_host=dell-xps-8950
tailnet_dns_name=nova.<tailnet>.ts.net
```

`deploy/tailscale/start.sh` gains a step 0 before containerboot: `/config/MOVED_TO`
present → print it and `exit 1`. `install.sh`'s `refuse_if_moved` runs **first**
in `cmd_install` (`deploy/install.sh:1078`) and refuses the same way, keyed off
`deploy/.moved`. The refusal lives at the layer that would cause the
conflict: two tailscaled processes sharing one node identity flap. **Bound,
stated honestly:** a `docker run` of the sidecar image that does *not* mount
`/config` still bypasses it. That is a smaller hole than shell-first's
`NOVA_MOVED` env var, whose own document claimed — falsely — that nothing on
the host could do better.

**`undo-move`:**

1. Verifies `deploy/.moved` exists. Absent → print *"no marker here; nothing
   was moved from this machine"* and **exit 0**: the postcondition already
   holds. Present but unparseable → exit 1 naming the bad line; removing a
   marker it cannot read is not something it may assume is safe.
2. Print the marker verbatim: when, which bundle, which host, which DNS name.
3. **Liveness, stated either way.** If a host `tailscale` CLI exists, read
   `tailscale status --json` and look for an online peer carrying the archived
   `tailnet_dns_name`. Then, **in both branches**, print what was found or
   that it could not be found — *"I cannot check from here whether `<name>` is
   online: the sidecar is stopped, so there is no tailscaled to ask"* — say
   that bringing this node up while that peer is online will flap the node
   key, and require the typed literal `undo`. Default is to do nothing.

   Both branches are identical on purpose. shell-first's design refuses
   outright when a peer is online, with nothing the operator can type; its own
   critique names that a "may not" (M8), and the sequence is real: a
   half-dead hub answers `tailscale status` long after it stops serving, so
   the owner goes to the Dell to bring Nova back and the tool refuses, leaving
   him to delete the marker by hand at 3am — defeating the whole mechanism.
   A check may state that something CANNOT be done; it may never decide that
   it MAY NOT.
4. Remove `deploy/tailscale/MOVED_TO` and `deploy/.moved`. Verifies **both**
   are gone by re-reading. Either still present → fail, naming it.
5. Print `./install` as the next command. It starts nothing itself.

---

## 10. `install.sh`

### 10.1 The foreign `nova` compose project (#29, ruling 1)

Ruling 1: name everything found, then offer to delete exactly that, defaulting
to nothing. Three constraints from `map-minipc-measured.md` that no design
used, and they are binding:

- **Select by the `com.docker.compose.project` label, read from `docker`
  itself, never by name, and print the label matched beside every object**
  (`:35-39`). Measured: `nova_pgdata` on the mini PC belonged to project
  `docker` (`nova-ai-platform`), so name-prefix selection would have destroyed
  75.8 MB of a different project of his and two of its containers.
- **Ask docker, not compose.** The old project's compose file on that machine
  is a root-owned empty **directory** — the single-file bind-mount failure
  mode — so `docker compose -p nova down -v` cannot read its config
  (`:58-67`).
- **The blocker is gone on that machine** (`:126-163`): on the owner's
  instruction of 2026-09-21 — *"You can clean up everything from all old nova
  stacks. nova-ai-platform included."* — all three old projects (`nova`,
  `docker` = nova-ai-platform, `project`) were archived to
  `/home/jeremy/nova-old-stacks-archive` (21 MB, six `.tgz` plus `SHA256SUMS`,
  every checksum re-verified **by the operator**, not by root) and then
  removed: 13 containers, 6 volumes, 3 networks, 7 images. `minecraft` is still
  running, `jobhunter` is untouched, and the phantom `~/workspace/nova` stub
  tree went with `rmdir`. The refusal is still built and still **required** —
  it is what makes the *next* machine safe, and its label-not-name rule is now
  proven by a real near-miss rather than argued. **But it can no longer be
  walked.** No machine we have carries a foreign `nova` project any more, so
  every case in §12.2 is fixture-backed, built from the pre-cleanup reading
  above — which is why that reading is kept verbatim — and §13 T7 records the
  honest state of #29: the refusal branch has never been exercised on hardware
  and, after 2026-09-21, nothing on the Dell or the mini PC can exercise it.
  `map-requirements.md:97-99` ("The stopped platform-line `nova` project on the
  mini PC") is stale as a present-tense fact and survives only as the source of
  the fixtures.

**1. The ours-set, which is what the safety rests on.**

```
project     := compose_config_text | config_project_name           (install.sh:399-401)
ours_volk   := the raw fact's `volumes` (every file in COMPOSE_FILE)  # cannot be pruned
             ∪ (compose_config_text_all_profiles | cfg_service_keys-volumes)
ours_voln   := cfg_volume_name(k) for each k in ours_volk          (install.sh:405-413)
ours_svc    := the raw fact's `services` ∪ rendered services
```

All three designs derived this from a *rendered* config and all three were
broken the same way. `compose_config_text` (`deploy/install.sh:394-396`)
passes `--profile tailnet` and nothing else; `COMPOSE_ARGS` starts as
`(-f "$COMPOSE_FILE")` (`:49`) and gains `--profile inference` only inside
`decide_inference`, which runs *after* `preflight` (`:322`) — and not at all
when inference is off. Measured here [M]:

```
$ docker compose -f deploy/docker-compose.yml --project-directory deploy config --volumes
v4_pgdata  v4_memdata  v4_workspace  v4_models              # 4

$ docker compose -f deploy/docker-compose.yml --project-directory deploy --profile '*' config --volumes
v4_workspace  v4_ollama  v4_models  v4_tailscale  v4_memdata  v4_pgdata   # 6
```

and, also measured here, `nova_v4_ollama` and `nova_v4_tailscale` are live on
this host carrying `com.docker.compose.project=nova` and
`com.docker.compose.volume=v4_ollama` / `v4_tailscale`. So under any of the
three designs' rules, both classify **foreign** and land in the delete block.
One of them is the tailnet node identity — the single asset `move-only` exists
to carry and the one thing in the system that cannot be regenerated. Reading
the declared set from the **raw text** closes it, because no profile can prune
a file's own `volumes:` block, and the render is then only a source of
resolved names. Any `docker` or render call here failing is a refusal, not an
empty set.

**2. The candidate set, from two independent derivations, unioned.**

```
containers := docker ps -a --filter "label=com.docker.compose.project=$project" \
                --format '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}'
              then per id: docker inspect .Config.Labels["com.docker.compose.project.config_files"]
volumes    := (volumes mounted by the named foreign containers)
            ∪ (docker volume ls --filter "label=com.docker.compose.project=$project")
```

The union is python-tool M8: deriving volumes only from surviving containers
misses any volume whose containers are gone — the ordinary result of `docker
compose down` without `-v` — and ruling 1 requires the installer to name
*every* container **and volume** it found.

Containers classify into three, the `sibling` class being port-v3's and
measured-real:

- **ours** — any comma-separated `config_files` entry, `canonical_path`-equal
  (`deploy/install.sh:132-146`) to `$COMPOSE_FILE`.
- **sibling** — a named config file that **exists on this host**, whose
  project name equals `$project` and whose declared volume keys are a subset
  of `ours_volk`: another checkout of this same stack.
- **foreign** — everything else, including a config file that does not exist
  and a container with no `config_files` label at all.

**`sibling` is not hypothetical.** Measured here [M]: the live `nova-searxng-1`
mounts `/home/jeremy/workspace/nova/.worktrees/v4/searxng`, i.e. the running
v4 stack was created from a **different checkout's** compose file than this
worktree's. A classifier that tests only "config files equal my compose file"
calls the entire live stack foreign and offers to delete it on the first run
from any worktree — which is python-tool C2's sequence, and it is the single
most dangerous bug this feature can have.

**3. What it prints.** Every object carries the label that selected it, and
every volume carries its **own** `com.docker.compose.project` read back from
`docker volume inspect` — plus, for volumes only, one derived annotation:
`state_file_on_volume` (`deploy/install.sh:439-444`) already looks for
`tailscaled.state` through a throwaway container, so it is run over each
candidate.

The block below is the **recorded pre-cleanup reading** of the mini PC
(`map-minipc-measured.md:20-30,45-56`) rendered in the shape the installer
prints. It is not a capture, and after 2026-09-21 it is not reproducible —
those objects no longer exist. It fixes the columns and the wording; §12.2's
fixture carries the same rows, and that fixture is now the only place they
exist.

```
REFUSED: a compose project named `nova` is on this machine and it is not this one.
`docker compose up` here would ADOPT and recreate its containers.

  project:       nova   (from /abs/deploy/docker-compose.yml)
  this checkout: /abs/deploy/docker-compose.yml

  Foreign containers (9)
    3f21a9c0b1d4  nova-postgres-1      service=postgres      exited
                  label com.docker.compose.project=nova
                  created from /home/jeremy/workspace/nova/docker-compose.yml (not readable here)
    …

  Foreign volumes (2)
    nova_postgres-data   label project=nova   key=postgres-data   67.66 MB
    nova_redis-data      label project=nova   key=redis-data      37.06 kB

  Left alone — labelled for another project (2)
    nova_pgdata          label project=docker      75.77 MB
    nova_redis_data      label project=docker      264 B

  Left alone — this stack's own (6)
    nova_v4_pgdata  nova_v4_models  nova_v4_memdata
    nova_v4_workspace  nova_v4_ollama  nova_v4_tailscale

  `docker compose up` here would adopt the foreign containers whose service
  name this file also declares: postgres.

Deleting the 9 containers and 2 volumes above is IRREVERSIBLE and destroys
whatever data they hold. Nothing else is touched.
Type exactly:  delete     to remove them
anything else, including Enter, leaves everything as it is.
>
```

A volume that holds a `tailscaled.state` is annotated in place:

```
    nova_tailscale_state  label project=nova  key=tailscale_state
        >> HOLDS A TAILSCALE NODE IDENTITY (tailscaled.state). Deleting it means
           this node must be re-authenticated under a new key.
           deploy/README.md:203-230 copies it into nova_v4_tailscale.
```

That annotation is shell-first M1, and on **this** machine it is the live
case: `nova_tailscale_state` carries `project=nova` [M], is foreign by the
rule (v3's compose file now declares `name: nova-v3`), and is the exact volume
`deploy/README.md:203-230` tells the operator to migrate the node identity
out of — whose step 5 is `NOVA_TAILNET=1 ./install`, the very command whose
preflight now offers to delete it. Ruling 1 is satisfied literally by naming
it; a volume name is not what will be destroyed.

**4. How the deletion is bounded.**

1. The capture is written to `$TMP/foreign_containers.tsv` (id, name, service,
   state, label) and `$TMP/foreign_volumes.tsv` (name, project label, key) **at
   naming time**. The removal loop reads only those two files. It cannot
   discover a new target.
2. **Before removing anything**, run `docker ps -a --filter volume=<name>` for
   each captured volume and refuse the whole operation if any is held by a
   container outside the captured id list, naming it. port-v3 M9(a): `docker
   volume rm` fails on a mounted volume, so containers-first produces every
   foreign container irreversibly destroyed, volume removal failing, and the
   operator — who consented to a *set* — left with a partial and no rollback.
3. **Volumes first, containers second.** Volumes are the irrecoverable half.
4. Before each container removal, `docker inspect -f '{{.Id}}'` must equal the
   id captured at naming time; different (recreated in between) → skip and say
   so. Before each volume removal, the name must be in the capture **and** its
   own project label must still read as the foreign project **and** it must
   not be in `ours_voln`, recomputed at deletion time. Three checks, two of
   them re-derived next to the destructive command.
5. After the loop, re-list and verify: every captured object is gone, **and
   every labelled volume that was not in the printed foreign list still
   exists** — computed from the same `docker volume ls` capture, not from
   `ours_volk`. port-v3's post-check was "every key in `ours_volk` still
   exists", which is vacuous exactly when the ours-set is wrong, the only case
   it needed to catch. Either check failing exits 1 loudly, naming what
   survived or what vanished. Nothing prints "removed" without the re-inspect.
6. **Non-TTY** → never prompt. Print the same block and the exact `docker rm`
   / `docker volume rm` lines, and exit 1 **only when a foreign container's
   service name collides with one this compose file declares** — the actual
   adoption hazard, which the block already computes. A foreign container with
   no colliding service name is a printed warning and the install continues.
   port-v3 M9(c): `install.sh` is documented *"Idempotent: safe to re-run"*
   (`deploy/install.sh:2`), and with v3's containers on this machine an
   unconditional non-TTY exit 1 breaks every non-interactive `./install`,
   which is how an agent or a CI step runs it. There is no `--yes` flag and no
   `NOVA_ASSUME_DELETE`: an unattended run must never destroy data.
7. After a successful deletion the install **continues**, because the CANNOT
   it refused on is gone.

**Why this is not an approval.** `services/core/tests/test_no_approvals.py`
scans `services/core/app/` only (`APP_DIR` at `:25`), which is Nova's runtime,
where she must never refuse on the owner's behalf. This is the operator's own
installer, at his own keyboard, about to irreversibly delete his own data, on
his own ruling; the script's only job is to bound it exactly and to default to
nothing. All three critiques checked this independently and agreed; it is
recorded here so it is not re-argued.

### 10.2 `decide_subnet` (#12, #22, #23)

172.18/16 is a hardcoded literal (`deploy/docker-compose.yml:332-334`) and
`NOVA_SUBNET` appears nowhere in the tree today. `deploy/subnet.sh`:

- **`docker_subnets_in_use`** — `docker network ls -q`, then `docker network
  inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}'` per
  id; exclude only a `<project>_default` **whose
  `com.docker.compose.project.config_files` label matches this checkout**.
  python-tool M5: selecting the network to adopt by *name* is the error
  `map-minipc-measured.md:35-39` rules out for volumes and containers, and
  §10.1 deletes containers and volumes but not networks — so a foreign
  project's leftover `nova_default` survives the cleanup and would be adopted,
  IPAM and all, by the next install. The compose comment at `:308-320` says
  the fixed address **is** the trust boundary for web's identity header;
  adopting addressing someone else chose is not a neutral convenience.
  A `docker` call that fails here is a refusal, not an empty set.
- **`host_routes_in_use`** (#22) — `ip -4 route` when present, else `netstat
  -rn -f inet`. The BSD parser handles what GNU never emits: shortened forms,
  `link#N` destinations, `default`, and the header row. **An explicit `/n` is
  honoured when netstat prints one; a 1- or 2-octet form inside 10/8,
  172.16/12 or 192.168/16 is expanded to the containing RFC1918 block, not to
  the classful guess** — port-v3 m3: a macOS host carrying `172.16.0.0/12`
  prints it as `172.16`, an octet-count expansion calls it `/16`, and
  `pick_project_subnet` then hands back 172.18.0.0/16 as free although the
  /12 covers the entire first candidate band. A destination that cannot be
  turned into a CIDR is **reported and skipped with a printed line**, never
  silently dropped. Neither tool present → return 2, and `decide_subnet`
  refuses to pick rather than picking blind, naming the two commands it looked
  for.
- **`ip_to_int` / `subnet_overlaps`** — pure bash 3.2 integer arithmetic,
  64-bit, no `bc`. Two blocks overlap iff `(a & m) == (b & m)` for
  `m = mask(min(pa, pb))`.
- **`pick_project_subnet`** — `172.18` … `172.31`, then `10.200` … `10.254`
  (r1's order). Exhausting both → refuse listing everything in use.
- **`derive_subnet_addrs`** (#23) — `NOVA_SUBNET_RANGE` = the lower /17,
  `NOVA_SUBNET_GATEWAY` = `.0.1`, `NOVA_WEB_ADDR` = `.128.10`,
  `NOVA_TAILSCALE_ADDR` = `.128.20`: the fixed addresses sit in the upper half
  where the allocator never reaches, which is the invariant web's nginx trust
  boundary rests on (`apps/web/nginx.conf.template:117-119` reads
  `NOVA_WEB_ADDR`, and `deploy/docker-compose.yml:126,142,255,284` already
  drive both from env).
- **`decide_subnet`**, three branches, **all of which write and read back**:
  1. **this checkout's project network exists** → adopt its subnet, derive and
     write the five keys. Changing IPAM on an existing network is not applied
     in place (`deploy/docker-compose.yml:322-328`), so adopting is the only
     non-destructive answer — but it must still write, or `.env` carries no
     `NOVA_WEB_ADDR`, compose falls back to the literal `172.18.128.10`
     (`:126,284`), and the address is outside the adopted network so `up`
     fails (python-tool M5, second half). If the adopted network is not a /16,
     `die` naming it and the addresses it could not derive, rather than
     writing addresses outside the network.
  2. **`NOVA_SUBNET` is set** → check it against both sources; collides →
     **die naming the colliding network or route**. Never silently move a
     subnet the operator pinned.
  3. **blank** → pick, derive, write, logging every candidate rejected and
     why.

  In every branch it re-reads the five keys from `.env` and verifies they are
  what it intended. A write that does not read back is a failure. port-v3's
  §10 and §8.2 contradicted each other on whether it writes (M2); it writes,
  and §9.2 step 2 guarantees `.env` exists first.

Called from `cmd_install` after `generate_secrets` (`deploy/install.sh:912`)
and before `record_compose_files` (`:956`), and **first** in `cmd_restore`.
The compose edit is three `${VAR:-literal}` substitutions whose defaults are
today's literals, so the Dell's live network does not move when this lands.

Note, from `map-minipc-measured.md:153-157`: after the 2026-09-21 cleanup,
172.18/16 is **free** on the mini PC — only 172.17 (docker0) and 172.19
(jobhunter) remain allocated, and v4 pins 172.18. **The collision this
mechanism was written for does not exist on the machine we are moving to.**
`decide_subnet` is still required — it is a general mechanism and 172.19 is
still taken — but on this install it is expected to fall through branch 3 on
its first candidate and change nothing, and no step may be written as though
the collision were a live blocker. Two binding inputs are stale in that
direction and are superseded here: `map-requirements.md:95-96` ("172.18/16 is
already taken on the mini PC … r1 lands on 172.22.0.0/16") and the
`hub-p0-measurements.md:55` reading behind it. What survives is the mechanism
and branch 2: nothing may *assume* 172.18, and a pinned `NOVA_SUBNET` that
collides still dies naming what it collided with.

---

## 11. novad `repoint`

`apps/novad/main.go:40-48` gains `case "repoint"`. A hub move changes `Server`
and nothing else, because core's signing key travels inside the bundle — so
`repoint` is exactly "change the URL, after proving the new URL is the same
Nova".

`novad repoint --server <url> [--check]`:

1. `config.DefaultPaths()` / `config.Load`. Verifies enrolment and that the
   ed25519 seed is 32 bytes. Fails → *"not enrolled — run `novad enroll`
   first"*, exit 1.
2. `client.WSURL(*server)`. Verifies the scheme. Fails → exit 1, config
   untouched.
3. Dial `<url>/api/v1/devices/ws` with a 30 s timeout and read the first
   frame, which core sends before anything else:
   `{"type":"challenge","nonce":<hex>,"core_pubkey":<hex>}`
   (`services/core/app/devices_ws.py:288-289`). Verifies a challenge frame
   arrives carrying 64 hex characters. Fails → exit 1 naming the URL, config
   untouched.
4. Compare `core_pubkey` to the pinned `cfg.CorePubKey` with
   `subtle.ConstantTimeCompare`. Unequal → *"that server is not the Nova you
   paired with (it presented `<short>`, we pinned `<short>`). Re-enroll if you
   meant to pair with a different Nova."* exit 1, **config untouched**. This
   is the whole control: an attacker who owns the DNS name can serve a
   Nova-shaped socket but cannot produce core's ed25519 public key. The URL is
   not the identity; the pinned key is.
5. Complete the handshake — sign the raw nonce, send `auth`, read the reply.
   Verifies a `ready` frame. A server with the right core key that has
   **forgotten this device** passes step 4 and fails here, so the write is not
   made on a half-proof. Fails → exit 1 with core's own reason, config
   untouched.
6. `--check` → print the verdict and exit 0/1. **Writes nothing, ever.** This
   is what the hub-move runbook uses to decide between `repoint` and a fresh
   `enroll`.
7. `config.Save` (0600 in a 0700 dir), then **re-`Load` and compare** `Server`
   and `CorePubKey`. Fails → exit 1 naming the config path; a save that cannot
   verify itself is a failure.
8. Print old → new and `systemctl --user restart novad`. It restarts nothing
   and **never claims the daemon reconnected** — that is `novad status`'s job,
   and status already refuses to call a reachability probe "connected"
   (`apps/novad/main.go:233-240`).

---

## 12. Tests

### 12.1 `deploy/backup_test.sh` — bash 3.2, no docker, no network, no live stack

Sources `backup.sh`, `passphrase.sh`, `subnet.sh`, `compose_read.sh`; stubs
`docker`, `git`, `psql`, `stat`, `ip`, `netstat` as shell functions; uses the
existing `report`/subshell harness shape (`deploy/install_test.sh:19-27`).

**Compose readers** (driven against the checked-in YAML fixtures from **two**
compose versions): `reads_volume_disposition_from_the_yaml_render` ·
`reads_bind_disposition_from_a_long_syntax_mount` ·
`reads_anon_disposition_from_a_service_extension` ·
**`json_render_strips_nested_x_keys_so_the_reader_must_use_yaml`** (my §3
finding, asserting **both** halves against the fixtures — a top-level `x-` key
survives the JSON render, and a volume's, a service's and a long-syntax
mount's do not — so a future "just use JSON, it parses" simplification cannot
land, and so a future compose that starts keeping nested keys is noticed
rather than silently relied on) ·
`the_render_really_did_prune_it` (the shell half) with
`test_a_volume_no_service_mounts_is_still_declared` and
`test_the_declared_set_is_the_union_of_every_file` in
`deploy/backup/tests/test_raw_compose.py` (the parser half, over the same two
probe fixtures; python-tool minor 8: the GPU overlay makes it two files).

**Coverage**: `refuses_an_undeclared_volume` ·
`refuses_an_unknown_disposition_and_names_all_eight` ·
`refuses_an_exclude_without_a_reason` ·
`refuses_a_declared_volume_the_render_pruned` (shell-first C2) ·
`refuses_an_anonymous_volume_with_no_service_declaration` (port-v3 C2) ·
`refuses_a_live_mount_compose_does_not_name` ·
`refuses_an_unexpanded_variable_and_never_applies_the_compose_default` ·
`refuses_when_the_render_is_missing_a_raw_service` (R1) ·
`refuses_when_a_fact_renderer_fails_and_prints_its_stderr` ·
`refuses_when_the_database_list_is_empty` ·
`git_check_ignore_is_probed_with_a_trailing_slash` (port-v3's §4.5 bug, and
the reason every v4 backup would refuse on day one) ·
`git_unknown_is_a_refusal_not_an_include` ·
`segment_policy_catches_a_nested_superpowers_path` (port-v3 M10) ·
`carries_v4_tailscale_only_in_move_mode` ·
`env_refuses_an_undeclared_key` ·
`env_carries_only_the_carry_disposition` (asserts `COMPOSE_FILE`,
`NOVA_SUBNET`, `TS_AUTHKEY` are absent from the carried set) ·
**`writers_include_gateway_because_it_holds_a_postgres_dsn`** (shell-first M2) ·
`writers_never_include_postgres`.

**Passphrase**: `absent_permits_create_unavailable_does_not` (exit 3 vs exit 1;
a pre-existing file is never overwritten) ·
`refuses_a_passphrase_file_not_0600_and_names_the_mode` ·
`dispatch_refuses_an_unknown_source_naming_the_ones_it_has` ·
`cmd_nonzero_is_unavailable_not_absent` ·
`prompt_without_a_tty_is_a_stated_cannot` ·
`concurrent_create_produces_one_passphrase` ·
`resolvers_are_exactly_the_documented_set` ·
**`passphrase_never_reaches_argv`** (records every `docker` invocation's `$*`;
asserts the value appears in none and that no `-e` carries it).

**Backup verbs**: `run_lock_refuses_a_second_backup` (shell-first M11) ·
`mode_probe_refuses_a_filesystem_that_cannot_hold_0600` ·
`mode_probe_refuses_when_neither_stat_form_answers` ·
`free_space_checks_the_postgres_filesystem_separately` (port-v3 M6) ·
`free_space_arithmetic_is_integer_and_both_sides_are_kb` (shell-first m2) ·
`refuses_when_a_writer_will_not_stop_and_restarts_what_it_stopped` ·
`refuses_when_a_writer_was_already_dead` (FinishedAt older than the stop) ·
**`the_exit_trap_restarts_exactly_what_step_7_stopped`** (port-v3 M8) ·
`refuses_when_pg_majors_differ` ·
`a_failed_tar_is_not_reported_as_an_empty_volume` (port-v3 M3, driven with a
`docker` stub whose inner `sh -ec` exits non-zero) ·
`selftest_name_is_asserted_before_create_restore_and_drop` ·
`selftest_uses_its_own_prefix_not_nova_verify` (shell-first m11) ·
`round_trip_failure_deletes_the_part_file` ·
`reports_the_bundle_and_the_unhealthy_restart_as_two_separate_facts` (exit 4) ·
**`the_operator_can_read_the_file_the_container_wrote`** (python-tool C3: the
host-side `sha256_of` must succeed on the published bundle).

**Restore verbs**: `creates_env_from_the_example_before_decide_subnet`
(port-v3 M2) · `runs_decide_subnet_before_the_first_volume_create` (a call-order
recorder, not a presence check) ·
**`refuses_a_non_empty_v4_pgdata`** (port-v3 M1, shell-first M3) ·
`the_emptiness_probe_reads_exit_status_not_stdout` (python-tool M1, driven
with a stub that writes to stderr and exits non-zero) ·
`the_emptiness_probe_mounts_a_path_no_image_populates` ·
`refuses_an_existing_project_container` ·
`refuses_an_older_pg_restore` · `accepts_a_newer_pg_restore` ·
`migration_gate_matches_a_renumbered_migration_by_content` (shell-first M12) ·
`migration_gate_refuses_a_changed_migration_and_names_the_source_sha` ·
`env_replacement_prints_key_names_and_never_values` ·
`env_host_local_keys_are_never_carried` (python-tool M4) ·
`a_failed_restore_writes_the_in_progress_marker_and_the_rerun_quotes_it`
(shell-first M4) · `never_prints_restored_when_a_count_differs` ·
`never_prints_restored_when_a_listing_differs` ·
`never_prints_restored_when_the_key_fingerprint_differs` ·
`prints_no_next_steps_on_a_hash_mismatch`.

**Drill**: `drill_re_matches_every_object_name_it_guards` (python-tool M7,
asserted on the recorded argv) · `drill_never_touches_a_nova_underscore_object` ·
`drill_restores_and_diffs_every_volume_listing` (port-v3 M5) ·
`drill_needs_no_installed_pack_image` (shell-first C3) ·
`drill_fails_when_a_removal_cannot_be_verified` ·
`drill_with_no_bundles_fails` (the vacuous-pass pin) ·
`drill_fails_on_an_unparseable_stamp` ·
`drill_sweep_skips_a_live_run` (port-v3 m4) ·
`drill_names_bundles_sealed_with_an_older_passphrase`.

**Subnet**: `adopts_only_a_network_whose_config_files_label_matches`
(python-tool M5) · `adopt_writes_the_derived_keys` ·
`refuses_to_derive_128_addresses_from_a_non_slash_16` ·
`dies_naming_the_colliding_network` ·
`reads_routes_from_netstat_when_ip_is_absent` (a BSD fixture with `10.0.0/24`,
`link#3` and a `default` line) ·
`expands_a_bsd_short_form_to_the_containing_rfc1918_block` (port-v3 m3) ·
`refuses_to_pick_when_neither_ip_nor_netstat_exists` ·
`subnet_overlaps_table` · `fixed_addresses_land_outside_the_dynamic_range`.

**Move**: `undo_move_exits_0_with_no_marker` ·
`undo_move_states_the_peer_check_in_both_branches_and_still_proceeds_on_undo`
(shell-first M8) · `undo_move_verifies_both_markers_are_gone` ·
`refuse_if_moved_refuses_install_first`.

### 12.2 `deploy/install_test.sh` — additions, no docker

Every case here is **fixture-backed, and after 2026-09-21 that is the only
thing it can be**: the mini PC's three old projects were archived and removed
that day (`map-minipc-measured.md:126-147`), so no machine we have can
exercise `check_foreign_project`'s refusal or its deletion loop against a real
foreign project. The fixtures are built from the recorded pre-cleanup reading
(`map-minipc-measured.md:20-30,45-56`) and never hand-invented — which is
python-tool C2's whole point about the test ruling 1 demands. The slice record
says so in those words: #29's refusal and deletion paths are proven by
fixtures and have never been walked on hardware (§13 T7, §15 risk 11).

`ours_volk_includes_a_volume_only_the_inference_profile_declares` (port-v3 C1,
shell-first C1, python-tool C2 — **driven from a real captured
`--profile tailnet` render, not a hand-written six-name fixture**, which is the
point python-tool's critique makes about the test the ruling demands) ·
**`a_v4_volume_can_never_be_caught`** (fixture: the mini PC's measured
pre-cleanup set from `map-minipc-measured.md:20-30` **plus** all six
`nova_v4_*` volumes correctly labelled; asserts the printed foreign list, the
recorded `docker volume rm` argv, and separately by name that no `nova_v4_*`
name appears in any removal command) ·
`a_volume_labelled_for_another_project_is_left_alone_and_named`
(`nova_pgdata` → project `docker`, `map-minipc-measured.md:24`) ·
`orphaned_foreign_volumes_with_no_container_are_still_named` (python-tool M8) ·
`a_second_checkout_of_this_stack_is_a_sibling_not_foreign` (the measured
`.worktrees/v4` case — port-v3's `sibling` class) ·
`a_container_with_no_config_files_label_is_foreign` ·
`a_volume_holding_tailscaled_state_is_annotated` (shell-first M1) ·
`deletion_refuses_when_a_captured_volume_is_held_by_an_uncaptured_container`
(port-v3 M9a) · `deletion_removes_volumes_before_containers` ·
`deletion_is_bounded_to_what_was_named` (an object injected after the capture
is not removed) · `deletion_re_verifies_the_container_id` ·
`deletion_re_reads_each_volumes_own_project_label` ·
`postcheck_fails_when_a_v4_volume_vanished` (the check that would catch the
bug the others prevent) ·
`postcheck_is_computed_from_the_live_capture_not_from_ours_volk` (port-v3 C1's
second half) · `default_is_do_nothing` ·
`only_the_typed_word_delete_proceeds` (`y`, `Y`, `yes`, `DELETE`, `delete `,
blank, EOF all decline) · `non_tty_prints_the_commands_and_offers_nothing` ·
`non_tty_exits_1_only_on_a_service_name_collision` (port-v3 M9c) ·
`a_survivor_after_removal_is_a_die_naming_it`.

### 12.3 `deploy/backup/tests/` — pytest, no docker, no live stack

`test_novaenc.py` — round trip; an exact-multiple-of-chunk file (finality by
position, not by a short read); a flipped byte anywhere; a truncated file (the
case that matters for backups); two frames swapped; tampered headers (`n` not
a power of two, `n` over `MAX_N`, `r` over `MAX_R`, `128*r*n` over the cap, a
4097-byte header, a 15-byte salt) each → `CryptoError` and **never** a bare
`ValueError` or `MemoryError`; the cost cap refuses **before** any allocation;
the failure sentence is identical in the library and in `nova_restore.py`,
character for character; `"cipher"` is lowercase and a v3-written fixture
decrypts (python-tool minor 1); `genpass` yields 8 groups of 4 lowercase
base32 characters and 160 bits.

`test_restore_reader.py` — the writer encrypts and `nova_restore.py` decrypts,
in a **subprocess**, parameterised over `NOVA_FORCE_CTYPES_GCM ∈ {0,1}` with
an assertion that the forcing worked. This is the pin between two
implementations of one format, and it is the test port-v3's docstring claimed
and did not own.

`test_restore_sh.py` — `restore.sh`'s probe picks the first candidate that
passes the KAT; a wrong passphrase is rejected **before any payload byte is
read**; no candidate passing prints the install lines and `needs_images` and
exits non-zero; it never falls back to "try anyway".

`test_bundle_layout.py` — `MANIFEST.json` is the inner archive's first member;
the outer tar's first five members are `README.txt`, `nova_restore.py`,
`restore.sh`, `kat.sha256`, `kat.enc` and all read without a passphrase; the
embedded `nova_restore.py` and `restore.sh` are **byte-identical to the git
copies** (so one published digest covers every bundle — §7.6); an AST check
over `nova_restore.py` that the only `meta.json` field it reads is the
fingerprint used to choose a passphrase (§2 rejection 5).

`test_bundle_verify.py` — a member corrupted after the manifest was written
fails; a member removed fails; a corrupted `payload.enc` fails via GCM; a
truncated bundle raises `CryptoError`, not `EOFError`; `safe_extract` refuses
an absolute member, a `..` member, a symlink, a hardlink and a device node.

`test_coverage.py` — every refusal code, each asserting the entry **stays**
and carries its reason; `may_backup` is false whenever refusals is non-empty;
and the one that matters most — **a refusal never downgrades to a skip**: the
member list is empty *and* an exception is raised.

`test_coverage_v4_real.py` — coverage over the checked-in
`compose-v5.3.0.yaml` **plus `containers-v4.json` plus `ignored-paths.txt`**,
asserting **zero refusals**. All three fixtures are required: port-v3's drift
alarm had only a compose fixture, and the anonymous volume that breaks every
backup exists **only** in `docker inspect` output, so the suite passed while
the product refused. The ignored-path fixture is captured from the real
command, never hand-written, so the test and the product see the same strings.

`test_policy.py` — every declared disposition in `deploy/docker-compose.yml`
is one of the eight; every `exclude-*` carries a non-empty reason; **every key
in the raw `volumes:` block has a disposition** and **every disposition names
a key the file declares** — both directions, each its own failure, so adding
or removing a volume reddens the unit suite before the operator ever meets the
runtime refusal; every `SEGMENT_POLICY` row carries a reason.

`test_manifest.py` — every field in §5.3 present with its documented type; a
missing field raises rather than defaulting; an unknown top-level key is an
error; `bundle_version` 1 (v3's shape) is refused **by name**; no value
anywhere in the manifest equals any value in the fixture `.env`; `env_keys`
holds names only; `core_signing_key_sha256` is 64 hex or null and is not the
key.

`test_census.py` — the sum digest is constant-memory and order-independent
(shuffled inserts give the same value); an **empty table measures as
`(0, 0)`**, not as a failure (python-tool M2); a table of 2 M synthetic rows
does not raise (the 1 GB `string_agg` ceiling the sum form removes); the six
pinned GUCs appear in the same statement as the measurement.

`test_passphrase_fingerprint.py` — the cleartext fingerprint is derived from
the scrypt key under that file's own salt, not from the passphrase; two
bundles sealed with the same passphrase compare equal under their own salts;
the raw `sha256(passphrase)[:12]` appears **only** inside the encrypted
manifest (port-v3 M4, shell-first M5).

`test_scope.py` — no new file under `services/*/app/tools/`; no new file under
`services/*/migrations/`; nothing under `deploy/backup/` is imported by
anything under `services/`; `grep -rn "novabundle" services/` returns nothing.

### 12.4 Needs a live stack or two machines — by hand, not in CI

`tests/e2e/test_backup_roundtrip.py`, marked `live`: back up the real stack,
`restore --drill` the result, assert every table's count and sum and the
signing-key fingerprint are equal, and assert **no `nova-drill-*` container,
volume or network survives**. A second case adds a throwaway volume to a copy
of the compose file and runs coverage against a live daemon, pinning that the
refusal is real and not only a fixture behaviour.

**This is not #28, and it must not be recorded as #28.** python-tool M10: the
walk is *"back up on the Dell, `restore --drill` on the mini PC"* — two
machines — and a single-host e2e case exercises none of what the cross-machine
walk is for: carrying the file and reading it back as the operator (the
measured ownership incident), a different docker and compose version, a
different postgres minor, a different subnet, and a target with no v4 checkout
history. The walk is §13 T7, run by hand, recorded in `deploy/README.md`.

### 12.5 CI

- **`installer` (ubuntu-latest)** gains `bash -n` and `shellcheck -S warning`
  for `deploy/backup.sh`, `deploy/passphrase.sh`, `deploy/subnet.sh`,
  `deploy/compose_read.sh`, `deploy/backup_test.sh` and
  `deploy/backup/restore.sh` (the last with `-s sh`), then
  `./deploy/backup_test.sh`, then — the substitute for the macOS leg that does
  run wherever the workflow is enabled —

  ```
  docker run --rm -v "$PWD:/w" bash:3.2 bash -n \
    /w/deploy/install.sh /w/deploy/backup.sh /w/deploy/subnet.sh \
    /w/deploy/passphrase.sh /w/deploy/compose_read.sh /w/deploy/backup_test.sh
  ```

  A **real** bash 3.2 parser, on Linux, needing no macOS runner. #20's
  bash-3.2 discipline is otherwise enforced by code review alone
  (`map-portability.md` §6), and one bash-4-ism already exists in the tree
  (`deploy/tailnet_topology_test.sh:248`).
- **new `backup` job (ubuntu-latest)**: `uv run --project deploy/backup pytest
  -m "not live"`.
- **new `backup-macos` job (`macos-15`)** (#27). Two things port-v3 got wrong
  and this fixes (M7): the step body must invoke the interpreter
  **explicitly** — `/bin/bash ./deploy/install_test.sh` — because
  `defaults.run.shell` sets the shell that interprets the step body, and the
  step body runs the script through its own `#!/usr/bin/env bash`
  (`deploy/install_test.sh:1`), which resolves against `PATH`, where
  Homebrew's bash 5 sits ahead of `/bin/bash` on GitHub's macOS images. And
  the job's **first step fails when the interpreter is not 3.2**:

  ```yaml
  - run: /bin/bash -c 'echo "$BASH_VERSION"; [ "${BASH_VERSINFO[0]}" -eq 3 ]'
  ```

  A leg that cannot prove which bash it ran is a leg that reports success it
  did not check. Then `/bin/bash ./deploy/install_test.sh`,
  `/bin/bash ./deploy/backup_test.sh`, the pytest suite, and
  `NOVA_FORCE_CTYPES_GCM=1 pytest deploy/backup/tests/test_restore_reader.py`
  — the only measurement anywhere of the ctypes-libcrypto path against a real
  Homebrew OpenSSL (§7.3's `[unverified]`). **No docker on this job**: both
  shell suites stub it, and whether docker is usable on a hosted macOS runner
  is unverified (`map-portability.md` §6).
- **#27 is recorded as DEFERRED, NOT MET.** `.github/workflows/rebuild-ci.yml:3-7`
  triggers on `rebuild/**` only, so nothing in this slice runs in CI at all —
  and the workflow is additionally `disabled_manually` on GitHub, so even a
  widened trigger would not fire it until it is re-enabled. The owner's
  standing decision of 2026-09-07 is that CI is off, so **the current answer
  to §16 is that #27 stays deferred and the `bash:3.2 bash -n` container step
  is what ships.** The jobs are written and committed; enabling them is a
  one-line trigger change plus a click, and it is his call (§16). Both
  shell-first M10 and python-tool M10 are right that recording a never-executed
  job as satisfying #27 is reporting success nobody checked.

---

## 13. Task breakdown

Seven tasks. T1, T2, T5 and T6 are independent of each other and can run in
parallel; T3 needs T1 and T2; T4 needs T3; T7 needs everything.

| # | Task | Independently testable by | Depends on |
|---|---|---|---|
| **T1** | **Coverage.** The `x-nova-backup` rows in `deploy/docker-compose.yml`, the `# nova-backup:` lines in `.env.example`, `deploy/compose_read.sh`, the six fact renderers in `backup.sh`, `novabundle.py`'s `coverage()` and its eight refusal codes, `SEGMENT_POLICY`, and the fixtures. | `backup_test.sh`'s compose-reader and coverage blocks; `test_coverage.py`, `test_coverage_v4_real.py`, `test_policy.py`. No docker. | — |
| **T2** | **Crypto, bundle, passphrase, the in-bundle reader.** `novabundle.py`'s `NOVAENC1`/tar/manifest/`safe_extract`, `nova_restore.py`, `restore.sh`'s KAT probe, `deploy/passphrase.sh`. | `test_novaenc.py`, `test_restore_reader.py`, `test_restore_sh.py`, `test_bundle_layout.py`, `test_bundle_verify.py`, `test_manifest.py`, `test_passphrase_fingerprint.py`; `backup_test.sh`'s passphrase block. No docker. | — |
| **T3** | **`backup`.** §9.1's 23 steps: the lock, the probes, the writer derivation, the census, the dump, the self-test, the tars, pack, the shipped-reader round trip, chown, publish, restart-or-park, the EXIT trap. | `backup_test.sh`'s backup block; `test_census.py`. Then one real `./install backup` on the Dell. | T1, T2 |
| **T4** | **`restore`, `restore --drill`, `drill`.** §9.2–§9.4, including the in-progress marker and the orphan sweep. | `backup_test.sh`'s restore and drill blocks; `tests/e2e/test_backup_roundtrip.py` (live, single host). | T3 |
| **T5** | **The installer.** `check_foreign_project` + bounded deletion, `decide_subnet` + `subnet.sh` + the three compose substitutions, `refuse_if_moved`, `set_env_value`'s missing-file fix. | `install_test.sh`'s new cases. No docker. | — |
| **T6** | **The edges.** novad `repoint`, `deploy/tailscale/start.sh`'s `MOVED_TO` guard, `deploy/README.md`'s three new sections + the fixture-refresh procedure, the four `network_credentials` text corrections, the CI jobs. | `repoint_test.go`, `start_test.sh`, `bash -n`/`shellcheck`. No docker. | — |
| **T7** | **The walk (#28).** Back up on the Dell; `sha256_of` the bundle **as the operator**; copy it to the mini PC; `./install restore --drill` there; compare counts, sums and the signing-key fingerprint; confirm no `nova-drill-*` object survives. Then `./install` on the mini PC and confirm the foreign-project path is **silent** — the old stacks were archived and removed on 2026-09-21 (`map-minipc-measured.md:126-147`), so the only branch this walk can exercise is the no-foreign-project one. **The refusal and the deletion loop stay fixture-only (§12.2); record them as never walked on hardware, not as walked and passed.** | By hand, recorded in `deploy/README.md`. Not in CI. | T1–T6 |

---

## 14. What S41 does NOT build, and why

1. **No tool, no guard, no eval case, no narration kind, no chat step.** S41 is
   operator tooling; the move's chat walk is S45 (#30, `rulings.md:68-71`).
   `test_tools_registry`'s pinned name set and `test_eval_corpus`'s counts do
   not move in this slice, and if they do, something went wrong. If the drill
   must become her capability, that is one tool and one eval on top of this,
   not a redesign.
2. **No migration in any service** (#31). Consequence, stated rather than
   hidden: `schema_migrations` still has no `checksum` column
   (`services/core/app/migrations_runner.py:19-24`). The restore gate works
   around it with content hashes taken at backup time (§9.2 step 7), which is
   a file read, not a schema change.
3. **No secrets store (Proposal A).** Only the resolver seam
   (`rulings.md:48-49`). Consequence: with no store, the passphrase's only
   home is wherever the operator put it. Lose it and every bundle is
   unreadable, by design, with no recovery path in this slice. `drill`'s
   stale-fingerprint report is the only early warning there is. See §16.
4. **No `BACKUP_EXCLUDE_DATA`.** Ruling 2 replaced it with §6's derived,
   refusing coverage. The plain-tar sketch at `hub-topology.md:298-318` and
   `hub/r2-integration.md:393-411` is superseded on encryption and on
   coverage.
5. **No weekly schedule.** #5 builds the verb; the schedule may land later.
   Its plausible home is `timers.JOBS` — a job handler runs mechanically with
   no model in the loop and a refused firing pauses its row
   (`services/core/app/timers.py:56,570-584`) — which fits better than
   reconstructing v3's `automations` shape, but wiring it is a design of its
   own.
6. **No restore over a live system.** v3's `apply_bundle` — typed confirmation
   phrase, pre-restore safety snapshot, staged database, point of no return,
   `_swap_database`, `_restore_files` — is where most of v3's complexity
   lives, and §9.2 sidesteps all of it by refusing a non-empty target (#14).
   **Consequence, stated: a bad restore cannot be rolled back in place.** The
   documented recovery is restoring the previous bundle onto a fresh target,
   and `deploy/README.md:74-79`'s manual per-migration rollback drill remains
   the answer for a single bad migration. That is the right trade for the
   slice whose job is "spin Nova up on a different machine" and the wrong one
   for "undo what I just did to this one".
7. **No off-machine copy, no retention, no pruning.** `transport` is
   **recorded only** — it is printed and carried in the manifest so a later
   slice that builds an offsite copy does not have to bump `bundle_version`,
   and the manifest test pins it as a recorded string with no consumer. The
   directory grows until an operator deletes something; `drill` at least says
   when an old bundle needs a previous passphrase.
8. **No `backup_attempts`, no freshness verdict, no passphrase nag, no
   `capability_events`.** Each rests on v3 tables v4 does not have
   (`map-v3-backup.md` §6.9). `drill` reports what it just measured instead of
   what it remembers.
9. **No `--with-images`** (carrying `docker save` tarballs beside the bundle
   for a truly offline restore). A real gap, deliberately deferred: the
   manifest records `needs_images` and `restore.sh` prints the pull lines.
10. **No `network_credentials` special handling.** The table does not exist
    until S43a; database coverage is schema-driven, so it is carried the day
    it exists (`rulings.md:60-67`). The only S41 work is deleting the four
    now-wrong sentences.
11. **No `attach-node`, no `enroll --json`.** r1 lists them beside `repoint`;
    only `repoint` is in S41's MUST list.
12. **No HTTP route, UI surface or `settings` key.** D21 keeps every
    backup/restore/move verb out of her context (`hub-topology.md:141`), and
    adding a setting would move `SETTING_DEFS` and `test_settings.py`'s
    `KNOWN_KEYS`. Configuration is CLI flags and `.env`.
13. **No `age`, `gpg` or `openssl enc` as the bundle cipher.** §1 and
    `map-minipc-measured.md:101-109`: `age` is not installed on the mini PC,
    and OpenSSL 3.0.13's `enc` cannot write or verify a GCM tag, so an
    `openssl enc -aes-256-gcm` bundle is unauthenticated in practice.

---

## 15. Open risks, each with the cheapest measurement that settles it

| # | Risk | Cheapest measurement | State |
|---|---|---|---|
| 1 | **The per-table digest is not stable across postgres minors.** The whole DoD rests on counts and digests being equal (#28), and `t::text` renders types through session GUCs. §9.1 step 9 pins six of them, but a *minor* that changes a type's text output makes every drill fail with no real difference. The Dell and the mini PC both float on `postgres:16` (`deploy/docker-compose.yml:5` is a major-only pin) and their minors have never been compared (open question 6). | On the Dell: run the pinned-session digest for `nova_core.public.turn_spans` against the running container, then again inside a freshly pulled `postgres:16` throwaway with the same dump restored, and compare one string. Two commands. | **Not run. Take this before writing a line of T3.** If they differ, fall back to a column-wise digest and record the frame in the manifest's `session` block. |
| 2 | **Compose YAML shape drift between hosts breaks every awk reader**, and coverage would then refuse everything — or, worse, see nothing. The Dell runs compose **v5.3.0** [M]; the mini PC runs v5.5.1 (`map-minipc-measured.md:98`). | `docker compose --project-directory deploy -f deploy/docker-compose.yml --profile '*' config` on each host; diff; check both in as `deploy/backup/fixtures/`. One command per host. | Half measured, now twice: v5.3.0 confirmed here and **re-measured by hand on 2026-09-21** for `x-` preservation on volumes, long-syntax binds **and** service extensions, for the exact JSON/YAML divergence (top-level kept, every nested one stripped) and for the pruning of a declared-but-unmounted volume out of both renders and `config --volumes` (§3) [M]. v5.5.1 not measured. R1 is the runtime catch. |
| 3 | **Bundle size and wall time are unknown.** `v4_memdata` and `v4_workspace` are unmeasured, and the design reads the data three times (hash, pack, verify). At 50 GB that is a different conversation from at 500 MB. | `docker run --rm -v nova_v4_memdata:/a:ro -v nova_v4_workspace:/b:ro postgres:16 du -sb /a /b` on the Dell. One command. | Not run. Step 3's free-space check refuses rather than half-writing, so the failure is loud either way; if it is large, the hash and pack passes merge and the verify pass becomes the thing that costs. |
| 4 | **`nova_restore.py`'s two hardcoded Homebrew libcrypto paths are stale on a current macOS**, so the ctypes fallback is fiction on the one platform it was written for. | Run `test_restore_reader.py` with `NOVA_FORCE_CTYPES_GCM=1` on the `macos-15` job. Free once the job fires. | Not run; no macOS machine here. Mitigated by the `cryptography` preference and the stated `pip3 install cryptography` refusal. |
| 5 | **`python:3.12-slim` may have no reachable libcrypto**, so §7.3's backend 4 — the answer to "a machine that has only docker" — is fiction, and with it the DoD walk's independence from a completed install. | `docker run --rm python:3.12-slim python3 -c "import ctypes.util; print(ctypes.util.find_library('crypto'))"`. One line. | Not run. If it prints `None`, the fallback becomes an explicit `pip install cryptography` in the refusal and restore needs network — which the KAT gate surfaces at selection time rather than half-way through a decrypt. |
| 6 | **A container-written file the operator cannot read** — the measured incident (`map-minipc-measured.md:164-171`) — recurs on a filesystem where `chown` does not take (a CIFS or SMB archive target, which `--transport removable` makes plausible). | `./install backup --out <the target>` and then `sha256_of` the result as the operator; §9.1 step 19 does exactly this and fails if it cannot. | **Designed in as a check.** Unmeasured against a real SMB target. |
| 7 | **The `.env` declaration requirement blocks a real install on day one** if a live `deploy/.env` carries a key neither file declares. `COMPOSE_FILE` is the known case and is handled (shell-first m6); there may be others. | `cut -d= -f1 deploy/.env \| grep -v '^#'` on the Dell, diffed against `.env.example`'s keys. One command. | Not run — `deploy/.env` does not exist in this worktree. The answer is the list of declarations S41 must add. |
| 8 | **The plaintext dumps live on a throwaway docker volume during a backup**, readable by anything on the host that can run docker, for the duration of the run. | None needed — a stated bound. The alternative (a host tempdir) is strictly worse, and encrypting the dump before it leaves postgres would need a second key path. | Accepted. |
| 9 | **`decide_subnet` has never run on the mini PC**, and the `172.22` prediction two designs make is already stale: after the cleanup only 172.17 and 172.19 remain allocated there (`map-minipc-measured.md:153-157`). | `docker network inspect $(docker network ls -q) \| grep -o '172\.[0-9]*\.' \| sort -u` on the mini PC, re-run **on the day of the move**, not trusting any recorded table. | Not run. |
| 10 | **Two of the three `.gitignore`-derived classifications could rot**, making a routine backup refuse whenever someone edits `.gitignore`. | `test_coverage_v4_real.py` in CI on every push, with its fixture captured from the real command. | **Designed in.** The alarm is a red suite at commit time, not a failed backup at 3am, and the trade is stated at §6.4. |
| 11 | **The foreign-project refusal has never run against a real foreign project, and after 2026-09-21 no machine we have can make it.** The three old projects on the mini PC were archived and removed that day (`map-minipc-measured.md:126-147`), so §10.1 — the one path in this slice that deletes the owner's data irreversibly — is proven only by §12.2's fixtures. Fixtures are written by the same hand as the code they check, which is python-tool C2's objection, answered here only insofar as the fixtures come from a recorded reading rather than from imagination. | Build a **synthetic** foreign project on purpose: one exited `alpine` container and one empty volume, both labelled `com.docker.compose.project=nova`, from a scratch compose file outside this checkout; run `./install` and decline at the prompt; then run it again and type `delete`; then confirm every `nova_v4_*` volume still exists. Ten minutes, and the only objects at risk are the two it created. | **Not run, and it is now the only way to run it.** Worth doing once before T5 is called done; until then #29 is fixture-proven, not walked. |

---

## 16. The one question that is genuinely the owner's

**Should `.github/workflows/rebuild-ci.yml`'s trigger be widened to `slice/**`
and `main`?**

`#27` requires `install_test.sh` and `backup_test.sh` to run on `macos-15`
under `/bin/bash`. The workflow triggers on `rebuild/**` only
(`.github/workflows/rebuild-ci.yml:3-7`), so **not one test in this slice runs
in CI as things stand**, and the 2026-09-07 decision recorded in memory was
"CI and hooks OFF for now". The jobs are written and committed either way;
widening the trigger is a one-line change.

**The current answer, unless he changes it, is no.** His standing decision of
2026-09-07 is that CI is off, and it is off in two independent ways: the
trigger is `rebuild/**` only (`.github/workflows/rebuild-ci.yml:3-7`) **and**
`rebuild-ci` is `disabled_manually` on GitHub, so widening the trigger alone
would still fire nothing. So S41 ships with **#27 deferred, not met**, and the
substitute that runs wherever the workflow is enabled is the `bash:3.2 bash -n`
container step in the `installer` job (§12.5). The `macos-15` jobs are written
and committed anyway, so answering the question later costs a one-line trigger
change and a click rather than a design. Two of the three critiques
independently flagged recording a never-executed job as satisfying #27 as
reporting success nobody checked, and they are right.

Everything else that looked like an owner question is already settled:
the passphrase's home is the resolver seam plus his password manager
(`rulings.md:48-49` keeps the store out of S41, and §14.3 states the
consequence plainly); `eval_runs`/`eval_suite_runs` are carried because
database coverage is schema-driven and a per-table exclusion is a mechanism
this slice deliberately does not build; and the disposal of the mini PC's old
stacks is done (`map-minipc-measured.md:126-147`).
