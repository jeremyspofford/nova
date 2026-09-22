# S41 design — portable hub, encrypted bundle, verified restore drill

Binding inputs, read first and not re-argued here: [`rulings.md`](rulings.md),
[`map-requirements.md`](map-requirements.md), [`map-v3-backup.md`](map-v3-backup.md),
[`map-deploy-data.md`](map-deploy-data.md), [`map-portability.md`](map-portability.md).
Arc 8 wins wherever it contradicts the plain-tar S41 bullets (ruling 2).

Every factual claim about this repo carries `path:line`. Claims I could not
verify from this worktree are marked **[unverified]** and appear again in §13
with the one command that would settle them. Nothing in this document reports
a result I did not check.

---

## 1. Architecture

```
  HOST (bash 3.2: ./install backup|restore|drill|undo-move)
  ───────────────────────────────────────────────────────────────────────
  deploy/install.sh            main(): install | update | backup | restore
   │                           | drill | undo-move            (:1130-1137)
   ├─ deploy/subnet.sh         decide_subnet, host_routes_in_use,
   │                           docker_subnets_in_use, subnet_overlaps
   ├─ deploy/passphrase.sh     resolve_passphrase  ->  stdout + exit code
   │                           nova_pass_{file,env,prompt,cmd}
   └─ deploy/backup.sh         cmd_backup / cmd_restore / cmd_drill /
                               cmd_undo_move — ORCHESTRATION ONLY.
                               It never reads a byte of Nova's data and
                               never holds a key. It decides, it verifies,
                               it refuses.
        │  passphrase on STDIN (never argv, never -e, never .env)
        │  plan + manifest on STDIN as one JSON line
        ▼
  CONTAINERS (everything that touches data or crypto)
  ───────────────────────────────────────────────────────────────────────
  docker run --rm -i --network none --user 0:0  $PACK_IMAGE
      python3 /work/novabundle.py  {plan|pack|verify|kat|fingerprint}
      mounts: every included volume :ro, every included bind :ro,
              the stage volume :rw, the archive dir :rw
      PACK_IMAGE = the core service's image (python:3.12-slim +
      `cryptography`, services/core/Dockerfile:1, services/core/pyproject.toml:11)

  docker run --rm  $PG_IMAGE  pg_dump -Fc / pg_restore / psql
      PG_IMAGE = deploy/docker-compose.yml:5 (postgres:16), read from
      `docker compose config`, never typed

  ARCHIVE  nova-backup-<host>-<UTCstamp>-<sha7>.tar   mode 0600
  ───────────────────────────────────────────────────────────────────────
  README.txt  restore.sh  nova_restore.py  kat.enc  kat.sha256   cleartext
  meta.json                                    cleartext, UNAUTHENTICATED
  payload.enc              NOVAENC1(scrypt + AES-256-GCM per 4 MiB frame)
       └─ manifest.json FIRST, then db/, listings/, volumes/, files/, env/

  BARE MACHINE (no checkout)
  ───────────────────────────────────────────────────────────────────────
  tar -xOf bundle restore.sh | sh -s -- <bundle> <outdir>
      probes 4 decryptor backends, accepts one only after a known-answer
      test with the real passphrase, refuses with `docker pull` lines
```

The host script is a decider: it derives what exists from `docker compose
config` and `docker inspect`, verifies each step's own result, and refuses —
it never reads Nova's data, so it needs nothing on the host beyond `bash`,
`docker` and the `openssl` the installer already requires
(`deploy/install.sh:85-90`). Everything that touches bytes runs inside a
container that is already on the machine, which is how "authenticated
encryption of many GB from portable shell" stops being a shell problem: the
shell never encrypts anything, it pipes a passphrase into a python process in
the core image whose `cryptography` dependency is already installed
(`services/core/pyproject.toml:11`). Coverage is derived from the rendered
compose config with **all** profiles on, and an item that carries no
disposition is a refusal, not a skip. The bundle is self-opening: the restore
script and a known-answer test vector travel inside it, so a machine with only
`docker` can prove it has a working decryptor and a correct passphrase before
it reads one byte of payload. S41 restores onto an **empty** target or into a
namespaced drill; it never overwrites a live system, which is why it needs no
pre-restore safety snapshot and no database swap.

---

## 2. Every file created or modified

### Created

| File | Responsibility |
|---|---|
| `deploy/backup.sh` | `cmd_backup`, `cmd_restore`, `cmd_drill`, `cmd_undo_move`, plus the derivation helpers (`coverage_plan`, `writer_services`, `pack_image`, `pg_image`, `mode_probe`, `sha256_of`, `archive_name`). Sourced by `install.sh`; entry guarded the same way (`deploy/install.sh:1139-1141`) so `backup_test.sh` can source it without running anything. Orchestration and refusal only — no data, no keys. |
| `deploy/passphrase.sh` | The resolver seam (§6). Sourced by `backup.sh`. |
| `deploy/subnet.sh` | `decide_subnet`, `host_routes_in_use`, `docker_subnets_in_use`, `subnet_overlaps`, `pick_project_subnet`, `derive_subnet_addrs` (§9). Sourced by `install.sh` **and** `backup.sh` (restore runs it first). |
| `deploy/novabundle.py` | The container-side worker. Subcommands `plan`, `pack`, `verify`, `kat`, `fingerprint`, `genpass`, `listing`. Holds NOVAENC1 (ported from v3 `backend/app/backup_crypto.py`), the tar builder, the member hasher. Runs only inside `$PACK_IMAGE`. |
| `deploy/bundle/nova_restore.py` | The standalone restore script that travels in every bundle (requirement #3). Ported from v3 `scripts/nova_restore.py`; stdlib + optional `cryptography`, with v3's ctypes-libcrypto fallback and its macOS trap-libcrypto workaround (`scripts/nova_restore.py:118-127`). |
| `deploy/bundle/restore.sh` | POSIX `sh` (not bash). Finds a working decryptor backend by known-answer test, then runs `nova_restore.py` under it. Travels in every bundle. |
| `deploy/bundle/README.txt.in` | The cleartext paragraph for whoever finds the file. Templated with the stamp and the source host at pack time. |
| `deploy/backup_test.sh` | Shell suite, `set -uo pipefail` (the test-harness shape, not `install.sh`'s `-e` — `deploy/install_test.sh:13`), hand-rolled PASS/FAIL counter, `docker` stubbed as a shell function. No docker, no network, no live stack. |
| `deploy/tests/test_novabundle.py` | pytest over `novabundle.py`'s crypto and packing (runs in the existing core job). |
| `deploy/tests/test_nova_restore.py` | pytest over the in-bundle script and `restore.sh`'s backend probe. |
| `deploy/tests/fixtures/compose-config-*.yaml` | Captured `docker compose --profile '*' config` output, one per compose version measured, used by the awk readers' tests. |

### Modified

| File | Change |
|---|---|
| `deploy/docker-compose.yml` | (a) `:332-334` become `${NOVA_SUBNET:-172.18.0.0/16}`, `${NOVA_SUBNET_RANGE:-172.18.0.0/17}`, `${NOVA_SUBNET_GATEWAY:-172.18.0.1}`. (b) every entry under `volumes:` (`:336-351`) gains `x-nova-backup:` and `x-nova-backup-reason:`. (c) the four bind mounts (`:13`, `:83`, `:185`, `:290`) become long syntax so they can carry the same two keys. (d) the `tailscale` service gains `NOVA_MOVED: ${NOVA_MOVED:-}`. |
| `deploy/install.sh` | `main`'s `case` (`:1130-1137`) gains `backup`, `restore`, `drill`, `undo-move`; sources `backup.sh`/`subnet.sh`/`passphrase.sh`. `cmd_install` (`:1078`) gains `refuse_if_moved` first and `refuse_foreign_project` inside `preflight`, and `decide_subnet` after `generate_secrets`. `sha256_of` added. |
| `deploy/install_test.sh` | The foreign-project cases (§8) and the moved-marker cases. |
| `deploy/tailscale/start.sh` | Refuses to start when `NOVA_MOVED` is non-empty (§7.5). It is `#!/bin/sh` in an Alpine image (`deploy/docker-compose.yml:293`), so this is not a host-portability surface. |
| `deploy/.env.example` | The subnet keys; `NOVA_MOVED`; `NOVA_PASSPHRASE_SOURCE`; and the `# nova-backup: <disposition>` declaration line above **every** key (§4.4). |
| `deploy/README.md` | New `## Backups`, `## Restoring`, `## Moving Nova to another host` sections. `### Migrating an existing node` (`:203-230`) now points at `backup --move`. |
| `.github/workflows/rebuild-ci.yml` | `installer` job lints and runs the new scripts; new `installer-macos` job on `macos-15` (§11.4). |
| `.gitignore` | `backups/`. |
| `apps/novad/main.go` | `repoint` subcommand + usage line (§10). |
| `apps/novad/main_test.go` | The repoint cases. |
| `docs/plans/rebuild/hub-topology.md:135,411`, `docs/plans/rebuild/hub/r2-integration.md:61,550` | Delete the now-wrong "backups exclude `network_credentials`" text, per `rulings.md:60-67`. |

**No migrations, no tool, no guard, no eval case, no route, no web change.**
(`map-requirements.md` #30, #31; `rulings.md:68-71`.)

---

## 3. The bundle format

### 3.1 Outer archive — uncompressed `tar`, mode 0600

Name: `nova-backup-<host>-<YYYYMMDDTHHMMSSZ>-<sha7>.tar`, where `<sha7>` is the
checkout's `git rev-parse --short=7 HEAD` (or `nogit` when there is none).
Uncompressed on purpose: its payload is AEAD ciphertext and incompressible, and
its other members are tiny.

Member order is **forced**, not alphabetical:

| # | Member | Encrypted? | Purpose |
|---|---|---|---|
| 1 | `README.txt` | no | one paragraph, and the two commands |
| 2 | `restore.sh` | no | POSIX sh; needs only `sh` + one of {python3, docker} |
| 3 | `nova_restore.py` | no | the real restore script |
| 4 | `kat.sha256` | no | 64 hex — sha256 of the KAT plaintext |
| 5 | `kat.enc` | NOVAENC1 | 64 known bytes under the same passphrase, **fresh salt** |
| 6 | `meta.json` | no, **unauthenticated** | listing + backend selection only |
| 7 | `payload.enc` | NOVAENC1 | the inner archive |

Ordering rationale: `tar -xOf <bundle> restore.sh` must work on a many-GB file
without streaming past the payload. Members 1–6 together are under 60 KB.

Atomicity: built as `<final>.part` in the archive directory, `chmod 600` before
the first byte, `mv` to `<final>` only after the round-trip verify passes
(§7.1 steps 18–20). A collision loop appends `-2`, `-3` … if `<final>` exists,
because two bundles landing in the same second is a real incident v3 recorded
(`backend/app/backup_snapshot.py:201-213`).

### 3.2 Inner archive — `tar.gz`, inside `payload.enc`

```
manifest.json                   ALWAYS the first member
db/<dbname>.dump                pg_dump -Fc --no-owner --no-acl
db/<dbname>.counts.tsv          "<schema.table>\t<rows>\t<md5>", sorted
db/<dbname>.migrations.txt      one filename per line, applied order
listings/<volkey>.sha256        "<sha256>  <relpath>", sorted by relpath
listings/<bindkey>.sha256       same
volumes/<volkey>/<relpath>      files, numeric uid/gid/mode preserved
files/<bindkey>/<relpath>       included host binds
env/carried.env                 KEY=VALUE, one per carried key
```

No nested tars. Python's `tarfile` records numeric uid/gid/mode directly, so a
nested `tar --numeric-owner` buys nothing and would need a temp file the size
of the volume. Restore extracts with `--numeric-owner` inside a root container.

### 3.3 `manifest.json` — exact fields and types

Authenticated (it is inside `payload.enc`). **Every restore decision reads
this file and nothing else.**

| Field | Type | Value |
|---|---|---|
| `format` | string | `"nova-backup"` |
| `bundle_version` | int | `1` |
| `created_at` | string | `"YYYYMMDDTHHMMSSZ"` |
| `mode` | string | `"routine"` \| `"move"` |
| `transport` | string | `"local"` \| `"tailnet"` \| `"removable"` — how the bundle is meant to travel (requirement #11 / `hub/r2-integration.md:402`); set by `--transport`, default `"local"`. Advisory: it is printed, and `restore` warns when a `"local"` bundle is opened on a different `source_host`. |
| `source_host` | string | `hostname` |
| `source_sha` | string | 40 hex, or `""` |
| `source_dirty` | bool | `git status --porcelain` non-empty |
| `project` | string | the compose project name (`"nova"`) |
| `compose_files` | array[string] | absolute paths, in `COMPOSE_FILE` order |
| `pg_server_version` | string | e.g. `"16.10"`, from `SHOW server_version` |
| `pg_dump_major` | int | e.g. `16`, from the dumping container's `pg_dump --version` |
| `pack_image` | string | e.g. `"nova-core"` |
| `pack_image_id` | string | `"sha256:…"` from `docker image inspect -f '{{.Id}}'` |
| `migration_match` | string | `"filename"` in S41 (§7.2 step 9) |
| `passphrase_fingerprint` | string | 12 hex = `sha256(passphrase)[:12]` |
| `crypto` | object | `{container:"NOVAENC1", cipher:"aes-256-gcm", kdf:"scrypt", n:int, r:int, p:int, chunk:int}` |
| `core_signing_key_sha256` | string | 64 hex of `private_key_hex`, or `""` when the table is empty (`services/core/migrations/011_devices.sql:19-23`) |
| `tailnet_dns_name` | string | `""` when no tailnet |
| `databases` | array[object] | `{name:string, owner:string, dump_member:string, dump_bytes:int, dump_sha256:string, tables:int, rows:int, counts_member:string, migrations_member:string}` |
| `volumes` | array[object] | `{key:string, full_name:string, disposition:string, files:int, bytes:int, listing_member:string, listing_sha256:string, restore_to:string}` where `restore_to` is `"volume:<full_name>"` |
| `binds` | array[object] | `{source:string, target:string, service:string, disposition:string, files:int, bytes:int, listing_member:string, listing_sha256:string, restore_to:string}` |
| `members` | array[object] | `{path:string, origin:string, kind:"db"\|"counts"\|"migrations"\|"listing"\|"tree"\|"file"\|"env", bytes:int, sha256:string, restore_to:string}` |
| `env_keys` | array[string] | the carried key **names** only; values are in `env/carried.env` |
| `excluded` | array[object] | `{kind:"volume"\|"bind"\|"env"\|"database", name:string, disposition:string, reason:string}` — **mandatory and never empty-by-omission**. A restore that cannot say what it is missing invites the operator to assume it is missing nothing (`backend/app/backup_snapshot.py:284-289`). |
| `member_count` | int | the number of tar members after `manifest.json` |

`sha256` for a file member is over its bytes. For a `"tree"` member (a volume
or bind) the recorded hash is the sha256 of the **listing file's bytes** — the
listing is itself sorted `"<sha256>  <relpath>"` lines, so the tree hash covers
both content and layout, and the listing is what restore diffs against.

### 3.4 `meta.json` — cleartext, unauthenticated, advisory

`{outer_version:1, format, created_at, mode, transport, source_host,
bundle_version, member_count, bytes_payload:int, payload_sha256:string,
passphrase_fingerprint:string, crypto:{…}, crypto_image:string,
fallback_image:string, needs_images:[string]}`.

**Rule, stated in `README.txt` and enforced in `nova_restore.py`: nothing in
`meta.json` decides a restore.** It exists for three things — listing bundles
without the passphrase, choosing a decryptor backend, and printing the
`docker pull` lines. Every value it duplicates is re-read from the
authenticated manifest and compared; a mismatch is a refusal.

---

## 4. Coverage — derived, and refusing

### 4.1 Where the disposition lives

`docker compose config` preserves `x-` extension fields on top-level volume
entries **and** on long-syntax mounts, and resolves the full volume name and
absolute bind source at the same time. Measured in this session against
compose v5.5.1:

```
volumes:
  vol_one:
    name: novaxtest_vol_one
    x-nova-backup: include
```

So the disposition is declared **next to the thing it describes, inside the
compose file**, and read back out of the same rendered config the coverage set
comes from. This is what "derived from the compose file" buys that a
`BACKUP_EXCLUDE_DATA` list never could: the set and the dispositions come from
one document, and an item with no disposition is unrepresentable-as-silent.

The seven legal dispositions (a closed set the script checks):

| Value | Meaning | v4's members |
|---|---|---|
| `include` | carried verbatim | `v4_memdata`, `v4_workspace` |
| `dump-pg` | never file-copied; carried as logical dumps | `v4_pgdata` |
| `move-only` | carried only under `--move` | `v4_tailscale` |
| `exclude-code` | restorable from the repo | `./postgres-init`, `../searxng`, `./tailscale` |
| `exclude-redownload` | re-fetchable | `v4_ollama`, `v4_models` |
| `exclude-derived` | regenerated by the installer | `../data` (`deploy/install.sh:808-863` writes `hardware.json`) |
| `exclude-ephemeral` | no durable content | (none today; `tmpfs` mounts) |

### 4.2 The algorithm

```
coverage_plan(mode):                       # mode = routine | move
  CFG := docker compose --project-directory deploy \
           -f <each COMPOSE_FILE entry> --profile '*' config
      -- `--profile '*'` is verified to render every service regardless of
         which profiles are declared, so no profile list lives in the script
         (v3's stale six-profile tuple, backend/app/backup_inventory.py:233-234,
         cannot recur).
      -- non-zero exit OR empty output  ->  R0_UNREADABLE_COMPOSE. The plan is
         a refusal, never an empty plan.
  PROJECT := CFG | config_project_name                    (install.sh:401-403)

  # (1) the declared volume set
  for K in (CFG | volume keys):
      FULL   := CFG | config_volume_name K                (install.sh:408-418)
      DISP   := CFG | volume x-nova-backup K
      REASON := CFG | volume x-nova-backup-reason K
      DISP empty                    -> R1_UNCLASSIFIED (volume K)
      DISP not in the seven         -> R1_UNCLASSIFIED (volume K, unknown value)
      DISP starts with "exclude" and REASON empty -> R1_UNCLASSIFIED (no reason)

  # (2) every mount of every service, profile-gated and stopped ones included
  for S in services, for M in S.volumes:
      M.type == "volume":
          M.source empty            -> R3_ANONYMOUS_VOLUME (S, M.target)
          M.source not declared     -> R1_UNCLASSIFIED (mount names an
                                       undeclared volume)
          M.read_only false         -> record S as a WRITER of M.source
      M.type == "bind":
          M["x-nova-backup"] empty  -> R1_UNCLASSIFIED (bind S:M.source)
          same disposition checks as (1)
      M.type == "tmpfs":            -> recorded as excluded/ephemeral, no
                                       declaration required (nothing durable)

  # (3) live containers, INCLUDING exited ones — catches what compose does not
  #     name. v3 measured that `docker volume ls --filter label=` is not a
  #     substitute: it missed the real Postgres volume and included a stale one
  #     (backend/app/backup_coverage.py:48-52).
  IDS := docker ps -aq --filter label=com.docker.compose.project=$PROJECT
      docker failing here          -> R0. Never an empty list.
  for C in IDS, for MNT in (docker inspect C | mounts):
      MNT is a named volume not in the declared set -> R4_UNDECLARED_LIVE_MOUNT
      MNT is a bind whose source is not in the bind set -> R4

  # (4) databases — derived from the live server, not from postgres-init
  DBS := SELECT datname FROM pg_database
          WHERE datallowconn AND datname NOT IN ('postgres','template0','template1')
      empty result                 -> R7_NO_DATABASES
      EVERY database returned is carried. There is no per-database disposition,
      so a database added by a later slice cannot be silently dropped.
      Each one's owner role comes from pg_catalog, not from
      deploy/postgres-init/01-databases.sql:13-20.

  # (5) .env keys
  for KEY in (keys present in deploy/.env):
      DISP := the "# nova-backup: <disp>" comment line immediately above KEY in
              deploy/.env.example      (carry | host | drop)
      none                          -> R6_UNDECLARED_ENV_KEY
      carry -> into env/carried.env;  host|drop -> excluded, with the reason

  # (6) reachability, after the mounts are attached
  for every include/move-only source:
      the pack container cannot stat/read it -> R5_UNREACHABLE

  may_backup := (no refusals)
```

`may_backup` is `not refusals`. It is never "a partial bundle with a warning"
(`backend/app/backup_coverage.py:686-693`).

### 4.3 The exact refusal

Every refusal prints three lines and `cmd_backup` exits 1 **before anything is
stopped, dumped or written**:

```
REFUSED  R1_UNCLASSIFIED  volume v4_newthing
  nothing says what a backup should do with it, so this backup will not
  claim to be complete.
  fix: add to deploy/docker-compose.yml under `volumes: v4_newthing:` —
       x-nova-backup: include|dump-pg|move-only|exclude-code|
                      exclude-redownload|exclude-derived|exclude-ephemeral
       x-nova-backup-reason: "<why>"   (required for every exclude-*)
```

R3/R4/R5/R6/R7 use the same shape, naming the container and target, the
bind source, the `.env` key, or the database. Refusals are printed **all of
them**, not just the first, so one run fixes one file.

### 4.4 The `.env` declaration

`deploy/.env.example` gains one comment line above every key:

```
# nova-backup: carry
POSTGRES_PASSWORD=
# nova-backup: host    — absolute paths, and this machine's GPU overlay
COMPOSE_FILE=
# nova-backup: drop    — dead config (install.sh:20-25); never regenerated
INSTANCE_SECRET=
```

`carry` for `POSTGRES_PASSWORD`, `CORE_TOKEN`, `CORE_GATEWAY_TOKEN`,
`CORE_MEMORY_TOKEN`, `SEARXNG_SECRET`, `NOVA_PUBLIC_GATE_TOKEN`,
`TAILNET_HOSTNAME`. `host` for `COMPOSE_FILE`, `COMPOSE_PROFILES`,
`NOVA_SUBNET*`, `NOVA_WEB_ADDR`, `NOVA_TAILSCALE_ADDR`, `NOVA_MOVED`,
`NOVA_PASSPHRASE_*`. `host` for `TS_AUTHKEY` too — it is used once, on first
login, and the identity then lives on `v4_tailscale`
(`deploy/.env.example:38-46`).

`INSTANCE_SECRET` is the honest edge case: it may exist in a real `.env` and
`install.sh` deliberately never removes it (`deploy/install.sh:20-25`). Without
a declaration it would refuse every backup, so S41 declares it `drop` in
`.env.example` as a commented-out key. A key in `.env` that is in neither place
still refuses — that is the point.

**Is this a hand-kept list by another name?** Partly, and the distinction is
the whole argument. `git` cannot see inside a volume and nothing in `.env`
says whether a value is host-specific, so *some* declaration is unavoidable.
What arc 8 forbids is a list whose failure mode is **silence**. Here the set is
read live, the declaration lives beside the thing, and an undeclared item
**refuses**. `test_coverage_refuses_an_undeclared_volume` is the line of code
that keeps that true.

---

## 5. Crypto

### 5.1 The container format, ported unchanged from v3

`NOVAENC1` (`backend/app/backup_crypto.py:10-16,49`):

```
b"NOVAENC1"                      8-byte magic
uint32be                         header length
header JSON  {v, cipher, kdf, n, r, p, salt, nonce_prefix, chunk}
frames: [uint32be ciphertext length][ciphertext || 16-byte tag] ... to EOF
```

- **Cipher**: AES-256-GCM, applied per frame, via `cryptography`'s `AESGCM`.
- **KDF**: `hashlib.scrypt` — stdlib, specifically so the in-bundle restore
  script needs no third-party package to derive the same key
  (`backend/app/backup_crypto.py:17-19`). `n=32768, r=8, p=1, dklen=32,
  maxmem=256 MiB`. ~34 MB of KDF memory, modest on purpose because the
  generated passphrase carries 160 bits.
- **Salt**: 16 random bytes, fresh per file — so `kat.enc` and `payload.enc`
  have different keys.
- **Nonce**: 4 random bytes (per file) `||` uint64be frame index from 0.
  Unique per (file, frame) with nothing stored; reconstructed from position.
- **Chunking**: 4 MiB frames; the reader accepts up to 64 MiB. Whether a frame
  is final is decided at write time by `done >= size` (not by a short read —
  the last frame of an exact-multiple file is full length,
  `backend/app/backup_crypto.py:169-171`), and at read time by lookahead.
- **AAD** = `MAGIC || header_bytes || uint64be(index) || (0x01 if final else
  0x00)`. A tampered header, a reordered frame, and — the one that matters for
  backups — a **truncated** file all fail to decrypt rather than yielding a
  shorter archive.
- **Reader-side cost cap**, separate from the writer's: `n <= 2^18`, `r <= 16`,
  `p <= 4`, `128*r*n <= 128 MiB`, `n` a power of two, `salt` exactly 16 bytes,
  `nonce_prefix` exactly 4. A tampered header naming an absurd cost must read
  as *tampered*, not as an out-of-memory crash
  (`backend/app/backup_crypto.py:57-64,99-135`).
- **One sentence for every failure**: *"decryption failed — wrong passphrase,
  or the file is corrupt, truncated or tampered with (GCM cannot tell these
  apart)."* GCM genuinely cannot distinguish them, and pretending otherwise is
  what produces "the passphrase must be right, the file must be broken"
  reasoning at 3am (`backend/app/backup_crypto.py:32-34,214-218`).

### 5.2 Why chunked AEAD and not `openssl enc`

I measured the alternative before rejecting it. On this host (OpenSSL 3.5.5)
`openssl kdf … SCRYPT`, `openssl enc -aes-256-ctr -K -iv` and
`openssl dgst -sha256 -mac HMAC -macopt hexkey:` all work, so a pure-shell
scrypt + AES-CTR + encrypt-then-MAC construction is *expressible*. It is
rejected for one reason that cannot be engineered away: `openssl enc` and
`openssl kdf` take the passphrase and the derived key **in argv**, and neither
accepts a raw key on a file descriptor. A backup passphrase in `ps` output —
or in `docker inspect` of the container that ran it — is not acceptable, and a
"careful" wrapper is a prompt, not a control. Chunked AEAD in python keeps the
passphrase on stdin and the derived key in one process's memory.

`age` was also considered: it is the right shape (scrypt + ChaCha20-Poly1305
STREAM, O(1) memory, real truncation detection) but its passphrase mode wants a
terminal, which makes it awkward to drive from a script and adds a binary that
is on none of these machines today.

### 5.3 Where each side runs

**Backup.** `docker run --rm -i --network none --user 0:0 $PACK_IMAGE
/app/.venv/bin/python3 /work/novabundle.py …`.

- `$PACK_IMAGE` is the core service's image. `docker compose config` does not
  emit `image:` for a build-only service, but `docker compose config --images`
  does, and compose's synthesized name is `<project>-<service>` — measured this
  session: a `build:`-only service `core` in project `novaxtest3` rendered as
  `novaxtest3-core`. So `pack_image()` reads an explicit `image:` for `core`
  from the rendered config if present, else `printf '%s-core' "$PROJECT"`, then
  **verifies with `docker image inspect`** and refuses if it is absent, naming
  `./install` as the fix.
- `--user 0:0` because the image declares `USER appuser` (uid 1000,
  `services/core/Dockerfile:13,24`) and `v4_tailscale` is root-owned.
- `--network none` because the packer has no business reaching anything.
- The passphrase arrives as the first line of **stdin**, consumed before
  anything else. Never argv, never `-e` (which `docker inspect` would show),
  never a file on the host.

**Restore, on a machine with the checkout**: the same container.

**Restore, on a bare machine**: `restore.sh`, POSIX `sh`. It probes four
backends in order and accepts one **only after it passes the known-answer
test** — decrypt `kat.enc` with the real passphrase and compare the sha256 to
`kat.sha256`:

1. host `python3` with `import cryptography` → run `nova_restore.py` directly;
2. host `python3` with a usable `libcrypto` via `ctypes` — v3's `_openssl_gcm`
   (`scripts/nova_restore.py:113-198`), including its macOS rule: never call
   `ctypes.util.find_library` on darwin, only the two Homebrew paths, because
   Apple's stub libcrypto aborts the whole process
   (`scripts/nova_restore.py:118-127`);
3. `docker run --rm -i --network none -v <bundle dir>:/b:ro -v <out>:/out
   <meta.crypto_image> python3 /b/nova_restore.py`;
4. the same with `<meta.fallback_image>` (`python:3.12-slim`), pulling if
   absent.

Backend 4 is the one that answers "a machine that has only docker":
`python:3.12-slim` carries `hashlib.scrypt` in its stdlib and — because CPython
links `_hashlib`/`_ssl` against it — a `libcrypto.so.3` that path 2's ctypes
code can call. **[unverified]** — I could not run a container from this session
to confirm `ctypes.util.find_library('crypto')` resolves inside that image.
§13 risk 1 has the one-line measurement. If it does not resolve, the fallback
becomes `python:3.12-slim` plus a `pip install cryptography` line printed by
the refusal, which needs network — which is why the KAT gate exists: it fails
loudly at candidate-selection time, before any payload byte is read, instead of
half-decrypting.

If no candidate passes, `restore.sh` exits 1 and prints exactly what to install
and the `docker pull` lines from `meta.needs_images`. It never falls back to
"try anyway".

**The dependency, named plainly.** Backup adds **no** host dependency: bash,
docker, and the `openssl` the installer already requires (`deploy/install.sh:85-90`)
for `openssl rand`. Restore needs **one of** python3-with-a-decryptor or
docker. A truly offline machine with docker but no images cannot restore,
because it also cannot run `postgres:16` to load the dumps; the manifest
records `needs_images` and `restore.sh` prints them. Carrying `docker save`
tarballs beside the bundle is real and is **not built** (§12).

---

## 6. The passphrase resolver seam

`deploy/passphrase.sh`. Bash 3.2, no associative arrays.

### 6.1 Interface

```sh
# Every resolver is a function named  nova_pass_<name>.
#   stdin  : nothing
#   stdout : the passphrase, exactly, no newline appended
#   stderr : a reason, on failure only
#   exit 0 : resolved
#   exit 3 : genuinely ABSENT — the caller may create one
#   exit * : UNAVAILABLE — the caller REFUSES and never creates one
resolve_passphrase()        # -> stdout + the same exit codes
passphrase_fingerprint()    # stdin: the passphrase; stdout: 12 hex
```

The 3-vs-other split is v3's hardest-won lesson, transplanted
(`backend/app/backup_passphrase.py:55-73`): a store that exists but cannot be
read must **never** read as "absent", or the next backup generates a
replacement over the passphrase that still seals every existing bundle. Only
exit 3 permits creation.

`resolve_passphrase` dispatches by `case` over `$NOVA_PASSPHRASE_SOURCE`
(from `deploy/.env`, default `file`). An unknown source is a refusal that names
the sources it has.

### 6.2 The resolvers that land now

| Source | Reads | Absent (exit 3)? |
|---|---|---|
| `file` (default) | `${NOVA_PASSPHRASE_FILE:-$DEPLOY_DIR/.backup-passphrase}`, mode-checked 0600 (refuse otherwise, naming the mode it read), trailing newline stripped | yes, when the file does not exist |
| `env` | `$NOVA_BACKUP_PASSPHRASE` | yes, when unset or empty |
| `prompt` | `read -r -s` on a TTY; twice on create | no — a non-TTY is exit 1, *"cannot prompt without a terminal"*: a stated cannot, not an approval |
| `cmd` | stdout of `$NOVA_PASSPHRASE_CMD` | no — a non-zero exit is **unavailable**, never absent |

### 6.3 Creation

Only on exit 3, and only for `file`. 160 bits (`openssl rand 20`), base32
lowercase in 8 groups of 4 — optimised for transcription, not for typing
(`backend/app/backup_crypto.py:238-245`). The base32 encoding is done by
`novabundle.py genpass` in the container (no host `base32` binary is assumed).
Written under `umask 077`, then `chmod 600`, then the mode is **read back**; if
it is not `600` the file is deleted and the backup refuses. Two concurrent
backups cannot each generate one: the create is guarded by
`mkdir "$DEPLOY_DIR/.backup-passphrase.lock"` (atomic on every filesystem);
the loser re-reads inside the lock and becomes a reader, never a second writer.
The new passphrase is printed **once**, with the sentence that it is the only
copy and nothing else can open the bundles.

### 6.4 How a secrets manager plugs in later

Callers only ever call `resolve_passphrase` and read stdout + the exit code.
A secrets manager arrives in one of two ways, neither of which touches a
caller:

- today, with zero code: `NOVA_PASSPHRASE_SOURCE=cmd` and
  `NOVA_PASSPHRASE_CMD='op read op://nova/backup/passphrase'` (or `bw get
  password …`, or `aws secretsmanager get-secret-value … --query SecretString
  --output text`);
- later, as a first-class resolver: add `nova_pass_onepassword()` to
  `passphrase.sh` and a `case` arm. That is the whole change.

This is exactly Jeremy's 2026-08-02 shape — *"Eventually it'll get it from a
secrets manager. Could be the one that is shipped, an mcp server, application
such as 1password, or a cloud secrets manager"*
(`backend/app/backup_passphrase.py:1-8`). Proposal A, the store itself, is
**out of S41** (`rulings.md:48-49`).

### 6.5 Hygiene, mechanically

The passphrase reaches exactly one place: the first line of the pack
container's stdin. `test_passphrase_never_reaches_argv` stubs `docker` as a
shell function that records `$*` for every call and asserts the passphrase
appears in none of them and that no `-e` flag carries it. Nothing logs it; the
only thing logged is its 12-hex fingerprint.

---

## 7. Every verb, step by step

Convention: each step says what it **verifies** and what it does when that
verification fails. A step that cannot verify its own result FAILS and says
why. No step has a fallback that reads as success.

Global: `cmd_backup`, `cmd_restore` and `cmd_drill` install an `EXIT` trap
that removes the stage volume, the `.part` file and every scratch database and
drill volume, and **reports** anything it could not remove.

### 7.1 `./install backup [--move] [--transport local|tailnet|removable] [--out DIR]`

1. **Moved-marker check.** Verifies `deploy/.moved` does not exist. Exists →
   exit 1, print the marker's contents and `./install undo-move`.
2. **Archive directory mode probe** (requirement #25/#26 — this replaces the
   hardcoded `/mnt/[a-z]/` test, per `hub/r2-integration.md:401`). Write
   `$DIR/.nova-mode-probe.$$`, `chmod 600`, read back with
   `stat -c '%a' 2>/dev/null || stat -f '%Lp' 2>/dev/null` (the portable pair
   already used at `deploy/install_test.sh:266,317`), unlink. Verifies the
   value read back is `600`. Not `600` → refuse, naming the directory and the
   mode ("this filesystem cannot hold owner-only permissions; the bundle is a
   live secret"). **Neither `stat` form answered** → refuse; never assume.
3. **Free space.** `du -sk` each included volume and bind inside a throwaway
   `$PG_IMAGE` container; compare `sum * 1.15` against `detect_disk_free_gb
   "$DIR"` (`deploy/install.sh:92-93`). Verifies both numbers were produced.
   Either unmeasurable → refuse. Insufficient → refuse with both numbers.
4. **Passphrase.** `resolve_passphrase`. Verifies exit 0 and a non-empty
   value. Exit 3 → create (§6.3) and continue; any other exit → refuse: *no
   passphrase, no bundle* (`backend/app/backup_service.py:146-152`).
5. **Coverage** (§4), taken fresh — never cached; the refusals must reflect the
   stack at the moment a bundle is written
   (`backend/app/backup_service.py:99-101`). Verifies `may_backup`. Any refusal
   → print all of them, exit 1. Nothing has been stopped yet.
6. **Pack image.** `pack_image()` then `docker image inspect`. Verifies the
   image exists locally and records its `.Id`. Absent → refuse.
7. **Crypto self-test.** Pipe the passphrase into `novabundle.py kat` in the
   pack image: encrypt 64 known bytes, decrypt them back, compare. Verifies
   this image can do NOVAENC1 with this passphrase *before* the stack is
   stopped. Fails → refuse, naming the image and the error.
8. **Stop the writers.** The writer set is derived in §4 step (2), never
   listed; `postgres` is never in it (its volume's disposition is `dump-pg`),
   and `tailscale` is in it only under `--move`. `docker compose stop` them,
   then poll `docker inspect -f '{{.State.Running}}'` per container for up to
   60 s. Verifies every writer reads `false`. Any still `true` after 60 s →
   restart the ones we stopped and refuse. `docker inspect` failing to answer
   → restart and refuse; *"could not confirm <svc> stopped"* is a failure, not
   a pass.
9. **Postgres alive.** `pg_isready -U postgres` inside the live container.
   Verifies it answers. Fails → restart the writers, refuse.
10. **Versions.** `SHOW server_version` from the live server; `pg_dump
    --version` from a throwaway `$PG_IMAGE`. Verifies both parse and their
    majors are equal. Differ → refuse (compose/image drift). Either unreadable
    → refuse.
11. **Databases.** §4 step (4). Verifies a non-empty list and an owner role for
    each. Empty or unreadable → refuse.
12. **Counts and md5** (requirement #7). Per database, for every table in a
    non-system schema: `SET TimeZone='UTC'; SELECT count(*),
    md5(string_agg(t::text,'' ORDER BY t::text)) FROM <table> t`. Verifies one
    row came back for every table `information_schema.tables` lists. A table
    that errors (an un-castable type) → refuse, naming it — never skipped.
    Written to `db/<db>.counts.tsv`.
13. **Dump** (requirement #8). Per database, `pg_dump -Fc --no-owner --no-acl`
    in a throwaway `$PG_IMAGE` container on the project network, writing into
    the **stage volume** (a throwaway docker volume the host never mounts), so
    the plaintext dump — which holds the signing key and every provider API
    key — never lands on the host filesystem. Client/server still match by
    construction: it is the same image the server runs, and step 10 verified
    the majors. Verifies exit 0, size > 0, and `pg_restore -l` lists > 0
    entries. Any failure → refuse.
14. **Self-test restore** (requirement #9). Per database: `nova_verify_<8 hex>`,
    with the name asserted against `^nova_verify_[0-9a-f]{8}$` **three times** —
    before `CREATE`, before `pg_restore`, before `DROP`
    (`backend/app/backup_restore.py:58-64,217,234,290`). After connecting,
    `SELECT current_database()` must equal the expected name (*a DSN that looks
    right and resolves elsewhere is the failure this catches*). `pg_restore
    --single-transaction --exit-on-error --no-owner --role=<owner>` —
    `--exit-on-error` is required, not tidiness: its default is to continue past
    errors, which turns a misdirected restore into an interleaving instead of a
    stop. Recompute counts and md5s and compare to step 12. Verifies every table
    matches. Any mismatch → refuse, naming the tables. The scratch database is
    dropped in the trap either way.
15. **Signing key.** `SELECT private_key_hex FROM core_signing_key` piped into
    `novabundle.py fingerprint` in the container. Verifies exactly one row
    (`services/core/migrations/011_devices.sql:19-23` makes a second
    unrepresentable). Zero rows → record `""` and list it in `excluded` with the
    reason; more than one → refuse (the CHECK was bypassed).
16. **Hash pass.** One `novabundle.py plan` invocation with every included
    source mounted `:ro`: walk each tree, emit `listings/<key>.sha256`, size and
    hash every member, assemble `manifest.json`. Verifies each source exists and
    is readable. Any unreadable → R5_UNREACHABLE, refuse (*a bundle that
    silently omits a tier is worse than no bundle*,
    `backend/app/backup_coverage.py:537-562`).
17. **Pack + encrypt pass.** One `novabundle.py pack` invocation, same mounts,
    passphrase on stdin: writes `manifest.json` first, then the members, gzips,
    encrypts frame by frame, writes `payload.enc` into the stage volume, and
    prints `bytes_payload` and `payload_sha256`. Verifies the emitted member
    count equals `manifest.member_count`. Mismatch → delete and refuse.
18. **Outer tar.** `umask 077`; build `<final>.part`; `chmod 600` before the
    first byte; members in the §3.1 order.
19. **Round-trip verify.** `novabundle.py verify` reads `<final>.part`,
    decrypts `payload.enc` **as a stream**, parses the tar in memory (nothing
    written to disk), re-derives every member's sha256 from the decrypted bytes
    and compares to the `manifest.json` it just read from the stream's first
    member; then re-runs the KAT from the bundle's own `kat.enc`. Verifies
    every member hash, the member count, and the KAT. Any failure → delete the
    `.part`, refuse. The exception handling here is deliberately broad: a
    truncated bundle raises `EOFError` from `gzip`, which is neither a
    `TarError` nor an `OSError`, and a narrower catch turns "corrupt" into an
    uncaught crash (`backend/app/backup_snapshot.py:420-427`).
20. **Publish.** `mv <final>.part <final>`, then `stat` the final path.
    Verifies the mode is `600` and the size equals what step 18 wrote. Either
    wrong → delete and refuse.
21. **Restart or mark.** Routine: `docker compose up -d` the writers and
    `wait_for_health` (`deploy/install.sh:1025-1054`). Verifies each is healthy.
    Not healthy → exit 1 with the last 20 log lines **and the explicit sentence
    that the bundle is written and verified** — the two outcomes are separate
    facts and are reported separately. `--move`: leave everything stopped, write
    `deploy/.moved` (§7.5) and `NOVA_MOVED=1` into `.env` via `set_env_value`
    (`deploy/install.sh:880-899`); verify by re-reading both.
22. **Report.** Path, bytes, sha256, `passphrase_fingerprint`, member count,
    every `excluded` entry with its reason, and the exact `restore` line.

### 7.2 `./install restore <bundle> [--into DIR]`

Restores onto an **empty** target only. It never overwrites a live system (§12).

1. **Marker check.** Verifies `deploy/.moved` is absent. Present → refuse
   (this host was moved away; restoring here would resurrect the tailnet
   identity), print the marker, name `undo-move`.
2. **Bundle readable.** Verifies the file exists, is a tar, and `stat` returns
   a mode. Mode is group/world-readable → say so (it is a live secret); do not
   refuse, it is already on disk.
3. **Outer members.** Read `README.txt`, `meta.json`, `kat.sha256`, `kat.enc`.
   Verifies `outer_version` is known. Unknown → refuse.
4. **Passphrase + KAT.** Resolve, then decrypt `kat.enc` and compare its sha256.
   Verifies the passphrase and the decryptor backend before a payload byte is
   read. Fails → refuse with the one sentence (§5.1) plus the bundle's recorded
   `passphrase_fingerprint`, so a rotation is visible rather than guessed at
   (`backend/app/backup_service.py:397-414`).
5. **Manifest.** Decrypt the head of the stream and read `manifest.json`.
   Verifies `format` and `bundle_version` are known and every `meta.json` field
   it duplicates agrees. Unknown version or any disagreement → refuse.
6. **`decide_subnet` FIRST** (requirement #12, §9). Verifies a non-colliding
   subnet was chosen and written to `.env`. Collision with a set
   `NOVA_SUBNET` → die naming the colliding network or route.
7. **Empty target.** For every volume in the manifest: `docker volume inspect`;
   if it exists, `ls -A` it through a throwaway `$PG_IMAGE` container. Verifies
   it is absent or empty. Non-empty → refuse, naming it. Also verifies no
   container carries `label=com.docker.compose.project=<project>`; any → refuse
   and name them (this is where §8's installer refusal is re-checked at restore
   time, since a restore can be the first thing run on a new host).
8. **`pg_restore` not older** (requirement #14). `pg_restore --version` in
   `$PG_IMAGE` on this host vs `manifest.pg_dump_major`. Verifies the local
   major is `>=`. Lower → refuse with both numbers. Unreadable → refuse.
9. **Migration gate.** For each database, every filename in
   `db/<db>.migrations.txt` must exist in this checkout's
   `services/<svc>/migrations/`. Verifies each one. Missing → refuse, naming
   the file and `manifest.source_sha` ("this bundle is from a newer Nova; check
   out `<sha7>`"). **Honest degrade:** v4's tracking table is
   `(filename, applied_at)` with no checksum column
   (`services/core/app/migrations_runner.py:19-24`), and S41 adds no migrations
   (requirement #31), so this is filename-only and a *renumbered* migration
   will false-refuse — exactly the bug v3 closed with a checksum
   (`backend/app/backup_apply.py:115-122`). The manifest records
   `migration_match: "filename"` so a later slice flips the value without
   changing the reader. There is no override flag: an override that proceeds is
   a fallback that reads as success.
10. **`.env` plan.** Build the full plan first: for each carried key, `.env`
    lacks it (write) or holds an identical value (no-op) or holds a different
    value (**conflict**). Verifies zero conflicts. Any conflict → refuse naming
    every conflicting key, and **nothing is written** — all-or-nothing. Then
    apply via `set_env_value`, `chmod 600`, and re-read each key to verify.
11. **Create the volumes.** `docker volume create --label
    com.docker.compose.project=<project> --label
    com.docker.compose.volume=<key> <full_name>`. Verifies `docker volume
    inspect` afterwards shows both labels. Missing → refuse (an unlabelled
    volume is one compose will not adopt).
12. **Extract and diff.** Stream `payload.enc` through the decryptor into a
    throwaway container that untars `volumes/<key>/**` into the mounted volume
    with `--numeric-owner`; then recompute the listing **inside that container**
    and diff it against `listings/<key>.sha256`. Verifies byte-for-byte
    equality of the listing. Any difference → refuse, printing the first ten
    differing paths and the counts of added/removed/changed.
13. **Postgres up.** `docker compose up -d postgres`, then `pg_isready`.
    Verifies it answers. Fails → refuse with its logs.
14. **Restore each database.** Verify the three databases and their owner roles
    exist (a fresh `v4_pgdata` runs
    `deploy/postgres-init/01-databases.sql:13-20` automatically); any missing →
    refuse rather than creating them by hand. Then `pg_restore --no-owner
    --role=<owner> --single-transaction --exit-on-error` (requirement #15) in a
    throwaway `$PG_IMAGE`. Verifies exit 0. Non-zero → the whole transaction
    rolled back; refuse with the error.
15. **Re-count and re-md5** (requirement #16). Recompute every table's count and
    md5 and compare to `db/<db>.counts.tsv`. Verifies equality for every table.
    A missing table is structural and fails. A count difference fails too —
    unlike v3, which tolerated it because it compared against `n_live_tup`
    statistics (`backend/app/backup_restore.py:264-279`); here both sides are
    exact `count(*)`, so there is no reason to tolerate a difference.
16. **Signing key.** Recompute `sha256(private_key_hex)` from the restored
    `nova_core` and compare to `manifest.core_signing_key_sha256`. Verifies
    equality. Mismatch, or a missing row where the manifest had one → refuse.
    Every paired device pins this key (`services/core/app/devices_ws.py:288-289`);
    a restore that lost it silently un-pairs every device.
17. **Stop and mark.** `docker compose stop postgres`; write
    `deploy/.restored` (bundle name, stamp, source host, `source_sha`), mode
    0600; verify both by re-reading.
18. **Report.** Print `verified` **only now**, and only with the three facts
    behind it: `<n> tables compared across <m> databases`, `<k> volume listings
    diffed`, `signing key fingerprint equal`. Then `./install` as the next
    command. If any of steps 12/15/16 did not run, the word `verified` is not
    printed at all.

### 7.3 `./install restore <bundle> --drill`

Non-destructive. Touches no live volume, no live database, no live container.

1. **Namespace.** Generate `D=<8 hex>`. Every object it creates is
   `nova_drill_${D}_<key>` (volumes), `nova_drill_${D}_pg` (container),
   `nova_drill_${D}_net` (network), `nova_verify_<8 hex>` (databases). Each name
   is asserted against its regex **before create, before write and before
   delete** (`backend/app/backup_restore.py:1-30`). A name that fails an
   assertion aborts before the operation, and the drill fails.
2. **Isolation.** The throwaway postgres runs on `nova_drill_${D}_net`, not on
   the project network, so it cannot see the live stack. Verifies via
   `docker inspect` that the container is attached to exactly that network.
   Otherwise → fail.
3. **Steps 3–5 and 8–9 of §7.2** run unchanged (passphrase, KAT, manifest,
   `pg_restore` version, migration gate). `decide_subnet` is **not** run — the
   drill creates its own network and must not rewrite `.env`.
4. **Steps 11–12** into the drill volumes; **13–16** against the drill postgres.
   Same verifications, same refusals.
5. **Teardown, in the `EXIT` trap.** Re-assert each name's pattern, then remove
   the container, the volumes and the network, and **verify each removal** —
   `docker volume inspect` must now fail for each. A removal that cannot be
   verified makes the drill **FAIL**, naming the leftover, rather than
   reporting success on top of a mess.
6. Exit 0 only if every count, md5, listing and fingerprint matched and the
   teardown verified.

### 7.4 `./install drill` (requirement #5 — the verb; the schedule is later)

The question it answers is *"could I recover from disaster today"*.

1. **Sweep.** Remove orphaned `nova_verify_*` databases and `nova_drill_*`
   volumes/containers/networks left by a run that died mid-flight — v3 needed
   this because a `finally` does not survive a process restart
   (`backend/app/backup_service.py:568-602`). Verifies by re-listing. Anything
   that will not go → report and fail.
2. **Bundles.** List `*.tar` in the archive directory. **Zero bundles is a
   FAILED drill**, not a vacuous pass: with no bundle the answer to the
   question is *no* (`backend/app/backup_service.py:662-665`).
3. **Newest.** Parse the stamp out of each name; verify it parses. Unparseable
   → fail naming the file (never silently ordered by mtime).
4. **Run** `restore --drill` on it. Verifies exit 0.
5. **Cross-checks the drill alone cannot surface.** Whether any *older* bundle
   carries a different `passphrase_fingerprint` than the current resolver's —
   if so, name those bundles: they need the old passphrase
   (`backend/app/backup_service.py:690-700`). Read from each bundle's cleartext
   `meta.json`, so no passphrase is needed.
6. **Report** the bundle, its age in days, tables compared, listings diffed,
   fingerprint equality, and the stale-passphrase list. Exit non-zero on any
   failure. No scheduler wiring in S41.

### 7.5 `./install backup --move` and `./install undo-move`

`--move` differs from a routine backup in four ways: `v4_tailscale` is carried
(its disposition is `move-only`), the `tailscale` sidecar is in the stop set,
the stack is left stopped, and a marker is written.

`deploy/.moved`, mode 0600, line-oriented (bash 3.2 has no JSON parser —
`deploy/install.sh:7`):

```
moved_at=20260921T143012Z
bundle=nova-backup-dell-20260921T143012Z-12ea01b.tar
bundle_sha256=<64 hex>
source_host=dell-xps-8950
tailnet_dns_name=nova.<tailnet>.ts.net
```

**The sidecar refuses to start while it is present** (requirement #18), as a
line of code in two places:

- `install.sh`'s `refuse_if_moved` runs **first** in `cmd_install`
  (`deploy/install.sh:1078`), so the whole install refuses.
- `--move` also writes `NOVA_MOVED=1` into `deploy/.env`, the compose
  `tailscale` service passes it through, and `deploy/tailscale/start.sh` exits
  non-zero when it is non-empty with *"this node was moved to <host> on <date>;
  run ./install undo-move to bring it back"*. Its healthcheck therefore never
  goes green. A bare `docker compose up -d` reads `deploy/.env`, so this holds
  for a hand-run compose too. **Bound, stated:** a `docker run` of the sidecar
  image by hand bypasses it; nothing on the host can prevent that, and the
  marker file is what tells a human why they should not.

`undo-move`:

1. Verifies `deploy/.moved` exists. Absent → exit 1, *"nothing to undo"*.
2. Prints the marker verbatim: when, which bundle, which host, which DNS name.
3. **Liveness check.** If a `tailscale` CLI is on PATH, read `tailscale status
   --json` and verify no online peer carries the archived `tailnet_dns_name`.
   Online → refuse: bringing this node up would flap the identity. **No CLI** →
   print *"the check could not be made"* — never a pass — and require the typed
   literal `undo` to proceed.
4. Remove `.moved` and unset `NOVA_MOVED`. Verifies the file is gone **and**
   `get_env_value NOVA_MOVED` is empty. Either still present → fail, naming it.
5. Prints `./install` as the next command. It starts nothing itself.

---

## 8. `install.sh`'s refusal for a foreign `nova` compose project

Owner ruling 1 (`rulings.md:8-28`): name everything found, then offer to delete
exactly that, defaulting to nothing.

### 8.1 Derivation — from `docker` output, never from a list

```
PROJECT  := compose_project_name                      (install.sh:446-450)
OURS_SVC := docker compose "${COMPOSE_ARGS[@]}" --profile '*' config --services
OURS_VOLK:= docker compose "${COMPOSE_ARGS[@]}" --profile '*' config --volumes
OURS_VOLN:= config_volume_name for each key           (install.sh:408-418)

# containers, two independent derivations, unioned
A := docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
       --format '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}'
     -> FOREIGN when the service label is not in OURS_SVC
B := docker ps -a --format '{{.ID}}\t{{.Names}}' | names matching ^$PROJECT-.+-[0-9]+$
     -> FOREIGN when the name is not one docker compose ps -a reports as ours

# volumes, two independent derivations, unioned
C := docker volume ls --filter "label=com.docker.compose.project=$PROJECT" \
       --format '{{.Name}}\t{{.Label "com.docker.compose.volume"}}'
     -> FOREIGN when the volume label is not in OURS_VOLK
D := docker volume ls --format '{{.Name}}' | names matching ^${PROJECT}_
     -> FOREIGN when the name is not in OURS_VOLN
```

Both derivations are needed. The label filter alone misses volumes that predate
compose labelling — v3 measured exactly that failure
(`backend/app/backup_coverage.py:48-52`) and the mini PC's four old volumes
(`nova_pgdata`, `nova_postgres-data`, `nova_redis-data`, `nova_redis_data`,
`hub-p0-measurements.md:58-68`) are the same class. The name rule alone would
catch a *v4* volume if compose ever changed its naming; the label rule is what
keeps it out. **Labels exclude, names only add**: a volume whose
`com.docker.compose.volume` label is one of ours is never foreign, whatever its
name.

Any `docker` call here failing is a refusal, not an empty list.

### 8.2 What it prints

```
REFUSED: a compose project named `nova` is already on this machine, and it is
not this Nova. `docker compose up` would ADOPT and recreate its containers.

containers (10):
  6b2f91ac3d0e  nova-postgres-1        service=postgres         exited
  …
volumes (4):
  nova_pgdata           (no compose volume label)
  …
this install's volumes, which are NOT in that list:
  nova_v4_pgdata  nova_v4_models  nova_v4_memdata  nova_v4_workspace
  nova_v4_ollama  nova_v4_tailscale

Deleting the 10 containers and 4 volumes above is IRREVERSIBLE and destroys
whatever data they hold. Nothing else is touched.
Type exactly:  delete     to remove them
anything else (including Enter) leaves everything as it is.
>
```

The names come from the capture above. The "this install's volumes" block is
printed from `OURS_VOLN` so the operator can see the two sets are disjoint.

### 8.3 How the deletion is bounded

1. The capture is written to `$TMP/foreign_containers.tsv` and
   `$TMP/foreign_volumes.txt` **at naming time**, with each container's id.
2. The removal loop reads **only those two files**. It cannot discover a new
   target.
3. Before removing a container: `docker inspect -f '{{.Id}}' <name>` must equal
   the id captured at naming time. Different (recreated in between) → skip and
   say so.
4. Before removing a volume: the name must be in `foreign_volumes.txt` **and**
   must not be in `OURS_VOLN`, recomputed at deletion time. Two independent
   checks, one of them re-derived.
5. Non-TTY (CI, a scripted install) → no offer at all: refuse and print the
   `docker rm` / `docker volume rm` lines for the operator to run by hand.
6. Default is do nothing. Only the literal `delete` proceeds; `y`, `yes`,
   `DELETE`, `delete ` and an empty line all decline.
7. After the loop, re-list and verify each named object is gone. Anything left
   → report it by name and exit 1; it does not proceed to install.

This is not an approval gate in the sense `test_no_approvals` guards. That test
scans `services/core/app/` only (`APP_DIR`,
`services/core/tests/test_no_approvals.py:25,267,274`) — Nova's runtime, where
she must never refuse on the owner's behalf. This is the operator's own
installer, at his own keyboard, about to irreversibly delete his own data, and
the ruling is that it must state exactly what it will destroy and default to
doing nothing (`rulings.md:27-28`).

### 8.4 The test that proves a v4 volume can never be caught

`test_a_v4_volume_can_never_be_caught` in `deploy/install_test.sh`:

- fixture `docker` stub returns the measured mini-PC set (10 containers, 4
  unlabelled volumes) **and** all six `nova_v4_*` volumes with correct
  `com.docker.compose.project=nova` / `com.docker.compose.volume=v4_*` labels;
- asserts the printed foreign list is exactly the 10 + 4;
- asserts the recorded `docker rm`/`docker volume rm` argv is exactly those 14;
- asserts, separately and by name, that `docker volume rm` was **never** called
  with any of the six `nova_v4_*` names;
- **mutation**: relabel one foreign volume with
  `com.docker.compose.volume=v4_pgdata` and assert it is then *not* offered —
  the label rule excludes even when the name rule would have added it;
- **mutation**: rename a v4 volume to `nova_pgdata_x` (still correctly
  labelled) and assert it survives.

---

## 9. `decide_subnet` and the 172.18 collision

172.18/16 is hardcoded at `deploy/docker-compose.yml:332-334` and is **already
taken** on the mini PC, as are 172.17, 172.19, 172.20 and 172.21
(`hub-p0-measurements.md:55`). `NOVA_SUBNET` does not exist anywhere in the
tree today.

`deploy/subnet.sh`:

- `docker_subnets_in_use` — `docker network ls -q`, then `docker network
  inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}{{.Name}}'` per id.
  Excludes `${PROJECT}_default`. A failing `docker` call is a refusal, not an
  empty list.
- `host_routes_in_use` (requirement #22) — `ip -4 route` when present, else
  `netstat -rn -f inet`. The BSD parser must handle what GNU never emits:
  shortened forms (`10.0.0/24`), `link#N` destinations, `default`, and the
  `Destination Gateway Flags Netif` header. A destination it cannot turn into a
  CIDR is **reported and skipped with a printed line**, never silently dropped.
  Neither tool present → refuse; do not assume no routes.
- `subnet_overlaps A B` — pure bash integer arithmetic, no `bc`:
  `ip_to_int` folds the four octets; `mask=$(( 0xFFFFFFFF << (32-prefix) &
  0xFFFFFFFF ))`; two /N blocks overlap iff `(a & m) == (b & m)` for
  `m = mask(min(pa,pb))`. Bash arithmetic is 64-bit, so no `printf` overflow.
- `pick_project_subnet` — tries `172.18` … `172.31`, then `10.200` … `10.254`
  (r1's order, `hub/r1-hubmove-design.md:10,156`). On the mini PC this lands on
  **172.22.0.0/16**. Exhausting both ranges → refuse, listing everything in use.
- `derive_subnet_addrs` — `NOVA_SUBNET_RANGE` = the lower /17,
  `NOVA_SUBNET_GATEWAY` = `.0.1`, `NOVA_WEB_ADDR` = `.128.10`,
  `NOVA_TAILSCALE_ADDR` = `.128.20`. The fixed addresses sit in the upper half
  where the allocator never reaches — the invariant `web`'s nginx trust
  boundary rests on (`deploy/docker-compose.yml:310-320`).
- `decide_subnet` (requirement #23) — three branches:
  1. the project network already exists → **adopt its subnet**, write the
     derived keys, change nothing. Verifies the adopted value is a valid CIDR.
     (Changing IPAM on an existing network is not applied in place, and a
     foreign attached container blocks the recreate —
     `deploy/docker-compose.yml:322-328`.)
  2. `NOVA_SUBNET` is set in `.env` → check it against both sources. Collides →
     **die naming the colliding network or route**. Clean → keep it.
  3. blank → pick the first free, write `NOVA_SUBNET`, `NOVA_SUBNET_RANGE`,
     `NOVA_SUBNET_GATEWAY`, and `NOVA_WEB_ADDR`/`NOVA_TAILSCALE_ADDR` when
     those are blank.
  In every branch it re-reads the keys from `.env` and verifies they are what
  it intended. A write that does not read back is a failure.

Called from `cmd_install` after `generate_secrets` (so `.env` exists) and
before `record_compose_files`, and **first** in `cmd_restore` (requirement #12)
— before any volume is created, because a restore on the mini PC that creates
volumes and then discovers the subnet is taken has already done work it cannot
undo.

`deploy/docker-compose.yml:332-334` becomes `${NOVA_SUBNET:-172.18.0.0/16}`,
`${NOVA_SUBNET_RANGE:-172.18.0.0/17}`, `${NOVA_SUBNET_GATEWAY:-172.18.0.1}`.
The defaults keep the Dell's live network byte-identical, so nothing is
recreated there.

---

## 10. novad `repoint`

`apps/novad/main.go` gains `repoint` to its `switch` (`:39-51`) and its usage
text (`:54-62`):

```
novad repoint --server <url> [--check]
```

1. `config.Load(paths)` (`apps/novad/internal/config/config.go:98`). Not
   enrolled → exit 1, *"not enrolled — run `novad enroll` first"*.
2. Dial `<url>/api/v1/devices/ws` and read the first frame. It must be
   `{"type":"challenge","nonce":…,"core_pubkey":…}`
   (`services/core/app/devices_ws.py:288-289`). Anything else, or a transport
   error, → exit 1 naming the URL. Nothing is written.
3. Hex-decode `core_pubkey` and compare to the pinned `cfg.CorePubKey` with
   `subtle.ConstantTimeCompare`. Not equal → exit 1, *"that server is not the
   Nova you paired with"*. **Nothing is written.** This is the whole control:
   an attacker who owns the DNS name can serve a Nova-shaped socket, but cannot
   produce core's ed25519 public key. The URL is not the identity; the pinned
   key is.
4. `--check` → print the verdict and exit 0/1. Writes nothing, ever.
5. Equal → sign the nonce and complete the challenge, so a successful repoint
   proves this *device* is still accepted by that core, not merely that the key
   matched. A 401/4403 → exit 1 with core's own reason.
6. `config.Save` with the new `Server`
   (`apps/novad/internal/config/config.go:75`), then **re-read the file** and
   verify `Server` is the new value and `CorePubKey` is unchanged. Not read
   back → exit 1; a save that cannot verify itself is a failure.
7. Print the old and the new server, and that the user service must be
   restarted.

Ordering, for the move walk: repoint runs on the Dell **before** the move, so
that afterwards novad reconnects to the hub by itself — the URL and the pinned
key are both unchanged by a move (`hub/r1-hubmove-design.md:325`).

---

## 11. Tests

### 11.1 `deploy/backup_test.sh` — no docker, no network, no live stack

Sources `backup.sh`/`passphrase.sh`/`subnet.sh`, stubs `docker`, `psql`,
`stat`, `ip`, `netstat` as shell functions, uses the existing
`report`/`expect_case`/`expect_tn` harness shape
(`deploy/install_test.sh:19-27,64-71`).

Mode probe and paths: `mode_probe_refuses_a_filesystem_that_cannot_hold_0600`;
`mode_probe_refuses_when_neither_stat_form_answers`;
`archive_name_stamp_is_utc_and_parses_back`;
`sha256_of_falls_back_to_shasum_when_sha256sum_is_absent`.

Coverage: `refuses_an_undeclared_volume`; `refuses_an_unknown_disposition`
(and names all seven legal values); `refuses_an_exclude_without_a_reason`;
`refuses_an_anonymous_volume`; `refuses_an_undeclared_bind`;
`refuses_a_live_mount_compose_does_not_name`;
`refuses_when_compose_config_fails` (R0, and the plan is a refusal, not an
empty plan); `refuses_when_the_database_list_is_empty`;
`every_exclusion_carries_a_reason`;
`carries_v4_tailscale_only_in_move_mode`;
`all_profiles_are_rendered_without_naming_a_profile`;
`env_refuses_an_undeclared_key`;
`env_carries_only_the_carry_disposition` (asserts `COMPOSE_FILE`,
`NOVA_SUBNET`, `TS_AUTHKEY` are absent from the carried list);
`writers_are_derived_and_postgres_is_never_one`.

Passphrase: `absent_permits_create_unavailable_does_not` (exit 3 vs exit 1, and
a pre-existing file is never overwritten); `refuses_a_passphrase_file_not_0600`;
`dispatch_refuses_an_unknown_source_naming_the_ones_it_has`;
`cmd_seam_passes_stdout_through`; `cmd_nonzero_is_unavailable_not_absent`;
`prompt_without_a_tty_is_a_stated_cannot`;
`concurrent_create_produces_one_passphrase`;
**`passphrase_never_reaches_argv`** (records every `docker` invocation's `$*`
and asserts the value appears in none, and that no `-e` carries it).

Backup verbs: `refuses_when_a_writer_will_not_stop_and_restarts_what_it_stopped`;
`refuses_when_docker_inspect_cannot_answer`;
`refuses_when_pg_majors_differ`;
`refuses_a_table_whose_md5_query_errors`;
`scratch_name_is_asserted_before_create_write_and_drop`;
`a_tampered_scratch_name_aborts_before_the_drop`;
`refuses_without_a_passphrase_and_leaves_no_part_file`;
`round_trip_failure_deletes_the_part_file`;
`reports_the_bundle_and_the_unhealthy_restart_as_two_separate_facts`.

Restore verbs: `runs_decide_subnet_before_the_first_volume_create` (a call-order
recorder); `refuses_a_non_empty_target_volume`;
`refuses_an_existing_project_container`; `refuses_an_older_pg_restore`;
`refuses_a_migration_filename_this_checkout_lacks` (names the file and
`source_sha`); `refuses_a_conflicting_env_key_and_writes_nothing` (`.env` is
byte-identical afterwards); `never_prints_verified_when_a_count_differs`;
`never_prints_verified_when_a_listing_differs`;
`never_prints_verified_when_the_key_fingerprint_differs`;
`meta_json_never_decides_anything` (a `meta.json` that disagrees with the
manifest is a refusal).

Drill: `drill_volumes_are_namespaced`;
`drill_fails_when_a_removal_cannot_be_verified`;
`drill_with_no_bundles_fails` (the vacuous-pass pin);
`drill_fails_on_an_unparseable_stamp`;
`drill_names_bundles_sealed_with_an_older_passphrase`.

Subnet: `adopts_an_existing_project_network`;
`picks_172_22_when_17_through_21_are_taken` (the measured mini-PC fixture,
`hub-p0-measurements.md:55`); `dies_naming_the_colliding_network`;
`reads_routes_from_netstat_when_ip_is_absent` (a BSD fixture with `10.0.0/24`,
`link#3` and a `default` line); `refuses_when_neither_ip_nor_netstat_exists`;
`subnet_overlaps_table` (/16 vs /17, adjacent, identical, disjoint);
`fixed_addresses_land_outside_the_dynamic_range`.

Move: `undo_move_refuses_when_the_marker_is_absent`;
`undo_move_refuses_while_the_moved_node_is_online`;
`undo_move_says_the_check_could_not_be_made_without_the_cli`;
`undo_move_verifies_both_the_file_and_the_env_key_are_gone`.

### 11.2 `deploy/install_test.sh` — added cases

`foreign_project_is_named_not_guessed` (all 10 containers and 4 volumes
printed); `foreign_volumes_are_found_without_compose_labels`;
**`a_v4_volume_can_never_be_caught`** (§8.4, with both mutations);
`deletion_is_bounded_to_what_was_named` (an object injected after the capture
is not removed); `deletion_re_verifies_the_container_id`;
`default_is_do_nothing`; `only_the_typed_word_delete_proceeds`;
`non_tty_refuses_and_prints_the_commands`;
`refusal_happens_before_any_compose_up`;
`leftovers_after_deletion_fail_the_install`;
`moved_marker_refuses_install_first`.

### 11.3 pytest (runs in the existing `services` job)

`deploy/tests/test_novabundle.py` — NOVAENC1 round trip; a flipped byte
anywhere fails; a truncated file fails (the case that matters for backups); a
reordered frame fails; a tampered header fails; `n` not a power of two refuses;
`128*r*n` over the cap refuses; every failure raises the same one sentence; the
header caps reject before any allocation; manifest-first ordering; the tree hash
changes on a rename with identical content; a 5 GiB sparse stream packs and
verifies with RSS under 64 MiB (`@pytest.mark.slow`).

`deploy/tests/test_nova_restore.py` — the in-bundle script decrypts a fixture
bundle under both the `cryptography` and the ctypes backend and they agree;
`restore.sh`'s probe picks the first candidate that passes the KAT; the KAT
rejects a wrong passphrase before any payload byte is read; no candidate
passing prints the install lines and `needs_images` and exits non-zero.

`deploy/tests/test_compose_readers.py` — the awk readers against the captured
`docker compose --profile '*' config` fixtures: volume `x-` keys, long-syntax
bind `x-` keys, full volume names, the project name, `--services` and
`--volumes`, and a fixture from a second compose version.

`apps/novad/main_test.go` — `repoint` refuses a different `core_pubkey` and
writes nothing; accepts the pinned one and the config reads back with
`CorePubKey` unchanged; `--check` never writes; a transport error exits 1 and
writes nothing.

`services/core/tests/test_no_approvals.py` — unchanged and must stay green.
S41 adds nothing under `services/core/app/`, which is the only tree it scans
(`:25,267,274`).

### 11.4 CI

- `installer` (`ubuntu-latest`, `.github/workflows/rebuild-ci.yml:50-56`): add
  `bash -n` and `shellcheck -S warning` for `deploy/backup.sh`,
  `deploy/passphrase.sh`, `deploy/subnet.sh`, `deploy/backup_test.sh`,
  `deploy/bundle/restore.sh` (the last with `-s sh`), and run
  `./deploy/backup_test.sh`.
- **new `installer-macos`, `runs-on: macos-15`** (requirement #27): print
  `/bin/bash --version` into the log first, so the bash-3.2 claim is a recorded
  fact rather than an assumption; then `/bin/bash -n` on the same files; then
  `/bin/bash ./deploy/install_test.sh` and `/bin/bash ./deploy/backup_test.sh`.
  **No docker on this job** — both suites stub it, matching the `installer`
  job's own stated strategy (`.github/workflows/rebuild-ci.yml:44-49`), and
  whether docker is even usable on a hosted macOS runner is unverified
  (`map-portability.md` §6). Two pins run only here:
  `sha256_of_falls_back_to_shasum` and
  `reads_routes_from_netstat_when_ip_is_absent`.
- **Conflict to raise, not to decide silently:** the workflow triggers only on
  `rebuild/**` (`.github/workflows/rebuild-ci.yml:3-7`), so nothing in it runs
  on `slice/**` or `main`, and the memory record says CI is deliberately off
  for now. The macOS job is checked in and **will not fire** until the trigger
  is widened. That is the owner's call, not this design's.

### 11.5 Needs a live stack — by hand, not in CI

`deploy/backup_live_test.sh` — the S41 walk (requirement #28): routine backup on
the Dell, `restore --drill` on the mini PC, asserting counts, md5s and the
signing-key fingerprint are equal, plus `./install backup --transport
removable --out /mnt/c/...` refused by the mode probe. Not in CI: it needs two
hosts and real data.

---

## 12. What I am NOT building, and why

- **`BACKUP_EXCLUDE_DATA`** — ruling 2 replaces it with compose-derived coverage
  that refuses. The bullets that still name it
  (`hub-topology.md:298-318`, `hub/r2-integration.md:393-411`) are superseded.
- **The secrets store (Proposal A)** — `rulings.md:48-49`: only the resolver
  seam lands. The seam is built so the store, or 1Password, or AWS Secrets
  Manager, is a new function and a `case` arm.
- **A destructive `apply` over a live system** — v3's `apply_bundle`
  (`backend/app/backup_apply.py:170-278`) with its typed confirm phrase,
  pre-restore safety snapshot, staging-database swap and move-aside file
  restore. S41's DoD is a move and a drill, both onto an empty or namespaced
  target. A live overwrite is a second slice's worth of failure modes, and
  shipping it half-done would be a restore that can destroy data it cannot get
  back.
- **The weekly schedule** — requirement #5 says the verb; the schedule may land
  later. `services/core/app/scheduler.py` is a plausible home but is a
  different shape from v3's `automations` row and was not built for a
  non-chat-turn mechanical handler.
- **The passphrase nag, `capability_events`, `backup_attempts`, `freshness()`,
  `drill_state()`** — v4 has none of the tables these rest on
  (`map-v3-backup.md` §6.9). Building them to host a nag is scope this slice
  does not have.
- **Any migration**, therefore **no `checksum` column** on `schema_migrations`
  (requirement #31). The migration gate is filename-only and the manifest says
  so (`migration_match`).
- **Any tool, guard, eval case, route or web surface** (requirement #30,
  `rulings.md:68-71`). S41 is operator tooling; the chat walk is S45. If the
  drill must become her capability, that is one tool and one eval on top of
  this, not a redesign.
- **Offsite/R2 sync and local bundle retention/pruning** — named in no S41
  requirement.
- **`--with-images`** (carrying `docker save` tarballs of `$PACK_IMAGE` and
  `postgres:16` beside the bundle, for a truly offline restore) — a real gap,
  deliberately deferred. The manifest records `needs_images` and `restore.sh`
  prints the pull lines instead.
- **Carrying `v4_pgdata` raw, `v4_ollama`, `v4_models`, `data/`, the searxng
  config, or novad's per-device files** — each has a disposition and a written
  reason in the compose file, and each appears in the manifest's `excluded`.
- **`age`, `gpg`, `openssl enc`** as the bundle cipher (§5.2).

---

## 13. Risks, ranked, with the cheapest measurement that settles each

1. **The fallback decryptor image may have no reachable libcrypto**, so a
   bare-machine restore has no backend and §5.3 candidate 4 is fiction.
   *Measure:* `docker run --rm python:3.12-slim python3 -c "import
   ctypes.util; print(ctypes.util.find_library('crypto'))"`, and the same
   against the built `nova-core` image. Two lines. If it prints `None`, the
   fallback becomes an explicit `pip install cryptography` line in the refusal
   and the design says restore needs network.
2. **`docker compose config`'s YAML shape drifts between compose versions**,
   breaking every awk reader — and coverage would then refuse everything, or
   worse, see nothing. *Measure:* capture `docker compose --project-directory
   deploy --profile '*' config` on the Dell (v5.5.1) and on the mini PC, diff
   them, and check both in as `deploy/tests/fixtures/`. One command per host.
   (Already verified here: compose preserves `x-` keys on both volumes and
   long-syntax binds, and `--profile '*'` renders all eight services.)
3. **Bundle size and wall time are unknown.** The design reads the data three
   times (hash pass, pack pass, verify pass); at 50 GB that is a different
   conversation from at 500 MB. *Measure:* `docker run --rm -v
   nova_v4_memdata:/a:ro -v nova_v4_workspace:/b:ro postgres:16 du -sb /a /b`
   on the Dell. One command. If it is large, the hash pass and pack pass merge
   (manifest last, plus a manifest-scan pass at restore) and the verify pass
   becomes opt-out.
4. **macOS `/bin/bash` 3.2 rejects something already in `install.sh`** — the
   bash-3.2 discipline is currently enforced by nothing but code review
   (`map-portability.md` §6), and one bash-4-ism already exists elsewhere in
   the tree (`deploy/tailnet_topology_test.sh:248`, `date +%s%N`).
   *Measure:* `docker run --rm -v "$PWD:/w" bash:3.2 bash -n /w/deploy/install.sh
   /w/deploy/backup.sh /w/deploy/subnet.sh /w/deploy/passphrase.sh` — runs
   today, on this machine, no Mac needed.
5. **The `.env` declaration requirement blocks a real install on day one** if a
   live `deploy/.env` carries a key neither file declares. *Measure:* `cut -d=
   -f1 deploy/.env | grep -v '^#'` on the Dell and diff against
   `.env.example`'s keys. One command; the answer is the list of declarations
   S41 must add.
6. **Postgres minor parity between the Dell and the mini PC was never
   measured** (open question #6). The runtime major refusal already covers the
   failure mode; this only says whether to expect it. *Measure:* `docker run
   --rm postgres:16 postgres --version` on both hosts.
7. **The plaintext dumps live on a throwaway docker volume during a backup.**
   That volume is readable by anything on the host that can run docker, for the
   duration of the run. *Measure:* none needed — it is a stated bound. The
   alternative (host tempdir) is strictly worse, and encrypting the dump before
   it leaves postgres would need a second key path.
8. **`NOVA_MOVED` only holds for compose runs that read `deploy/.env`.** A
   hand-run `docker run` of the sidecar image bypasses it. *Measure:* none —
   stated bound; the marker file is what tells a human why not to.
9. **Two concurrent backups.** *Measure:* run `./install backup` twice at once
   on the Dell and check exactly one `.part` exists and one bundle lands. The
   control is the `mkdir` lock (§6.3) plus the `.part`-then-rename collision
   loop.
10. **`git check-ignore` trailing-slash trap** — measured here today:
    `git check-ignore data` reports *not ignored* while `git check-ignore data/`
    reports ignored, because `.gitignore:13` is the directory-only pattern
    `data/`. This design does **not** classify by git (dispositions live in the
    compose file), so the trap is closed — recorded so a future "just ask git"
    simplification does not reopen it.
