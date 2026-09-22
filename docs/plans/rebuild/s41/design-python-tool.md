# S41 design — `novabackup`: a one-shot Python tool in the stack, a thin portable wrapper on the host

Written 2026-09-21 on `slice/s41`. Binding inputs, read first and not re-argued
here: [`rulings.md`](rulings.md) (the owner's two decisions of 2026-09-21),
[`map-requirements.md`](map-requirements.md) (the 33 numbered MUSTs/CARRIEDs),
[`map-v3-backup.md`](map-v3-backup.md) (what v3 built, and what v4 does not
have), [`map-deploy-data.md`](map-deploy-data.md) (the deploy surface as it is),
[`map-portability.md`](map-portability.md) (bash 3.2 and GNU/BSD).

Requirement numbers below (`#12`, `#27`, …) are `map-requirements.md`'s.

Every claim about this repo carries `path:line`. Four claims are **measured
here** with read-only commands and are marked **[M]**; everything else is read
from source. Nothing was deployed, restarted, mutated or committed.

---

## 0. The core choice, and the argument for it

**The logic is a Python package, `deploy/backup/novabackup/`. It runs two ways
from one source: inside a one-shot container built from digest-pinned bases, and
as a stdlib-only zipapp (`restore.pyz`) that travels inside every bundle.
`deploy/backup.sh` is a bash-3.2 wrapper that locates docker, resolves the
compose config, builds the image and hands over.**

### Why not bash

The v3 system that already does this job is 3,797 lines of Python
(`map-v3-backup.md:1-11`). The parts that cannot be written in portable bash 3.2
at all, not merely awkwardly:

- **AES-256-GCM with per-chunk AAD over a 200 MB file.** `openssl enc` has no
  AEAD mode on the CLI and no framing; an `openssl enc -aes-256-cbc` + separate
  HMAC reimplementation is a cryptographic construction written in shell.
  `map-portability.md` §3 confirms the repo's design never shells to
  `openssl enc`, `age` or `gpg`, and that `cryptography` is already in the core
  image (`services/core/pyproject.toml:11`).
- **scrypt.** No portable CLI. `hashlib.scrypt` is stdlib.
- **A manifest with per-table row counts and md5s, per-volume file listings, and
  a typed `excluded` list.** `hub/r1-hubmove-design.md:66-77` designed a
  line-oriented `MANIFEST` *explicitly because* "bash 3.2 has no JSON parser".
  That is the tail wagging the dog: the format was chosen to fit the language.
- **Re-deriving every member hash from extracted bytes** (v3's `verify()`,
  `map-v3-backup.md` §5) — a tar round-trip plus a hash-and-compare over
  hundreds of members.
- **Refusing, not skipping, on an unclassified volume** (#4) — set algebra over
  three sources with typed dispositions.

Each of those is a place where a bash version would be *almost* right, and
"almost right" in a backup is indistinguishable from right until the restore.

### Why an image rather than a module in an existing service

`services/core` is the tempting host: it already has `cryptography` and a
container. It is the wrong one, for a decisive mechanical reason: **`backup`
must stop `core` and verify it stopped** (#6). A process cannot stop itself and
keep running. `gateway` and `memory` are stopped too. `postgres` stays up (we
dump through it) but has no Python. So the runner must be a process outside the
service set — which is exactly a one-shot container.

Two further reasons: core has no docker socket and no repo mount
(`deploy/docker-compose.yml:56-60` — core mounts `v4_workspace` and nothing
else), and D21 keeps every backup/restore/move verb out of her context
(#33) — a module under `services/core/app/` is one import away from being a
tool.

### The bootstrap problem, confronted

> Restoring onto a machine that does not have the image yet.

The image is a **convenience on the backup side and never a dependency on the
restore side.** Three layers, in order:

1. **`restore.pyz` travels inside every bundle, in cleartext, as the second
   outer member** (#3). It is the *same package source*, packed with stdlib
   `zipapp`, and it needs only `python3 ≥ 3.9` plus `docker` on PATH. It does
   the full verified restore — not v3's "print the next commands" (v3's
   `nova_restore.py` deliberately stopped at printing,
   `map-v3-backup.md` §5). One source, two carriers, pinned against each other
   by a round-trip test (test 9, §12).
2. **If `python3` is absent**, `deploy/backup.sh restore` builds the image from
   the checkout and runs the same code in it. The checkout is present, because a
   restore target must have the repo to `./install` afterwards.
3. **If the image cannot be built** (no network for the base pull), restore
   cannot proceed — and says so, naming the two digests it could not fetch.
   This is honest rather than a gap: a restore target also has to pull
   `postgres:16` to have a database at all. A machine with no registry access is
   not a machine Nova can be restored onto by any design in this slice.

The decrypt path in `restore.pyz` carries v3's answer verbatim
(`map-portability.md` §3): prefer `cryptography.hazmat.primitives.ciphers.aead.
AESGCM` if importable; else call the system `libcrypto` through `ctypes`; on
`sys.platform == "darwin"` **never** call `ctypes.util.find_library` (Apple's
stub libcrypto aborts the process) and try only the two Homebrew paths. I could
not verify those two paths against a current Homebrew — no macOS machine was
available. Risk 6, §14.

### Why the docker CLI, and not the Engine API

The tool needs `docker compose config` to derive coverage, and compose
resolution is a **client-side** feature that the Engine HTTP API cannot do.
Having established that the client must be present, adding a second transport
(a stdlib Engine-API client) would mean two code paths that drift. So: **one
transport, the docker CLI**, shelled out to with `subprocess`, exactly as v3
shelled out to `pg_dump`/`psql` and as `deploy/install.sh` does throughout. The
image gets the CLI and the compose plugin by `COPY --from` two digest-pinned
official images — no `curl`, no `apt`, no build-time network beyond the pulls.

### What the wrapper keeps, and why

`deploy/backup.sh` does four things and no more:

1. Locates docker and the engine endpoint (`docker context inspect`).
2. Runs `docker compose … --profile '*' config --format json` — the one artifact
   only a host-side compose client can produce — into a `mktemp` file, mode
   0600, removed on `trap EXIT`. **This file contains resolved secret values**
   (`POSTGRES_PASSWORD`, `TS_AUTHKEY`, `SEARXNG_SECRET` interpolated from
   `deploy/.env`), which is why the mode and the trap are not optional.
3. `decide_subnet`, for `restore` only, before any compose call (#12) — sourced
   from `install.sh`, not reimplemented (§11).
4. `docker build -q deploy/backup` (a no-op against docker's cache) and
   `docker run --rm` with the image id that build printed.

Everything else — coverage, dumps, hashing, encryption, the manifest, the drill,
the refusals — is in the tool.

---

## 1. Architecture

```
  OPERATOR                                                        THE BUNDLE
  ./install backup [--move] [--transport X]                       nova-backup-<host>-<stamp>.tar  (0600)
  ./install restore <bundle> [--drill]                            ├── README.txt        cleartext
  ./install undo-move                                             ├── restore.pyz       cleartext, stdlib-only
       │                                                          ├── meta.json         cleartext, UNAUTHENTICATED, advisory
       │  deploy/install.sh main() :1130  dispatches              └── payload.enc       NOVAENC1 = AES-256-GCM(inner.tar.gz)
       ▼                                                                    │
  deploy/backup.sh   (bash 3.2; THIN)                                       │ decrypt
   1 locate docker        docker context inspect                            ▼
   2 compose config       docker compose --profile '*' config --format json   inner.tar.gz
   3 decide_subnet        (restore only; sourced from install.sh)           ├── MANIFEST.json     FIRST member, always
   4 build + hand over    docker build -q ; docker run --rm ──┐             ├── db/nova_core.dump      pg_dump -Fc
       │                                                      │             ├── db/nova_gateway.dump
       │ mounts: /var/run/docker.sock, <repo> rw,             │             ├── db/nova_memory.dump
       │         <archive dir> rw, compose.json ro            │             ├── volumes/v4_memdata.tar
       ▼                                                      │             ├── volumes/v4_workspace.tar
  ┌────────────────────────────────────────────────────┐      │             ├── volumes/v4_tailscale.tar   (--move only)
  │  nova-backup image  (FROM python:3.12-slim@sha256) │◄─────┘             └── files/deploy/.env
  │  + docker CLI + compose plugin (COPY --from, pinned)│
  │                                                     │      writes ▲      ┌──────────────────────────────┐
  │  novabackup/  cli · coverage · policy · pgfacts     │─────────────┘      │ restore.pyz on a BARE MACHINE│
  │               dump · volumes · manifest · crypto    │  same package  ═══►│ python3 + docker, no image    │
  │               passphrase · bundle · verbs · drill   │    source          │ same verbs, same refusals     │
  └───────────┬─────────────────────────────────────────┘                    └──────────────────────────────┘
              │ docker CLI (the one transport)
              ▼
   postgres (stays up: pg_dump/pg_restore/psql run INSIDE it — client==server by construction)
   core · gateway · memory · web   (STOPPED and verified stopped for the duration)
   throwaway containers of postgres's own image id, for every volume tar and untar
```

`deploy/backup.sh` locates docker, produces the one artifact a host-side compose
client alone can produce — the fully resolved config with **every profile
enabled** — and hands it, the repo and the docker socket to a one-shot container
whose bases are pinned by digest. Inside, `novabackup` derives what must be
carried from that config plus the live container mounts, refuses if anything in
that union has no classification, stops the writers and verifies they stopped,
measures every table's count and md5, dumps each database with the postgres
container's own `pg_dump`, test-restores each dump into a `nova_verify_*`
scratch database and compares before the bundle counts as written, tars each
volume through a throwaway container of postgres's own image id, writes
`MANIFEST.json`, and encrypts the whole inner archive under a passphrase that
arrives through a resolver seam. The finished outer tar carries, in cleartext
ahead of the ciphertext, a README, an advisory `meta.json` and `restore.pyz` —
the same package source packed by stdlib `zipapp` — so a bare machine with
`python3` and `docker` and nothing else can run the identical restore and the
identical refusals. Every verb's last step re-reads what it just wrote and
compares it against the manifest; a step that cannot make its comparison fails
and says which comparison it could not make, because a fallback that reads as
success is the defect this codebase hates most. The wrapper stays in bash only
because `install.sh` is already bash-3.2 and already owns `.env`, the compose
argument array and `decide_subnet` (`deploy/install.sh:44-52,867-899`) — and
S41 reuses those rather than writing a second copy of the trap they exist for.

---

## 2. Every file created or modified

### Created

| Path | Responsibility |
|---|---|
| `deploy/backup.sh` | bash 3.2 wrapper. `cmd_backup`/`cmd_restore`/`cmd_undo_move`. Locates docker; writes the resolved compose JSON to a 0600 `mktemp` removed on `trap EXIT`; `sha256_of` (`sha256sum`, else `shasum -a 256`, #21); the 0600 mode probe on the archive directory (#25/#26); `decide_subnet` before any compose call on restore (#12); `docker build -q` then `docker run --rm`. Guarded entry (`[ "${BASH_SOURCE[0]:-$0}" = "$0" ]`) so `backup_test.sh` can source it, copying `deploy/install.sh:1139-1141`. |
| `deploy/backup_test.sh` | `#!/usr/bin/env bash`, `set -uo pipefail` (no `-e`: a harness must survive a failed assertion — `map-portability.md` §1), hand-rolled PASS/FAIL counter copied from `deploy/install_test.sh:19-27`. Stubs `docker`, `stat`, `sha256sum`, `shasum` as shell functions. No docker, no network. |
| `deploy/backup/Dockerfile` | `FROM docker:29-cli@sha256:<pinned> AS cli` then `FROM python:3.12-slim@sha256:<pinned>`; `COPY --from=cli` the `docker` binary and the `docker-compose` cli-plugin; `pip install --no-cache-dir --require-hashes -r requirements.txt` (`cryptography` pinned with its wheel hash); `COPY novabackup ./novabackup`; a build-time `RUN docker --version && docker compose version && python -c "import hashlib;hashlib.scrypt(b'a',salt=b'b'*16,n=16384,r=8,p=1,dklen=32)"` so a moved plugin path or a scrypt-less Python fails the **build**, not a 3am restore. |
| `deploy/backup/requirements.txt` | One line: `cryptography==<pinned> --hash=sha256:<...>`. |
| `deploy/backup/pyproject.toml` | `ruff` + `pytest` config mirroring `services/core/pyproject.toml:36-56` (target py312, line-length 100, `select = ["E","F","I","UP"]`, `timeout = 120`). |
| `deploy/backup/novabackup/__init__.py` | Version string = nothing. The *tool version* recorded in the manifest is the image id `docker build -q` printed, or the pyz's own sha256 — derived, never a literal someone must bump. |
| `…/cli.py` | argparse: `backup`, `restore`, `drill`, `undo-move`; flags `--move`, `--drill`, `--transport`, `--passphrase-source`, `--passphrase-file`, `--archive-dir`, `--compose-config`, `--repo`. Sets `os.umask(0o077)` as its first statement (v3's rule: nothing this process writes is ever group/world readable). |
| `…/dockerclient.py` | The one transport. `run(argv) -> (rc, stdout_bytes, stderr_text)`, `exec_in(container, argv, stdin=None) -> …` (`docker exec -i`), `inspect_json(ref)`, `volume_exists/create/remove`, `compose(argv)`. Every call is recorded in an in-memory log the verbs' tests assert argv against. |
| `…/composeconfig.py` | Parses the resolved config JSON. Exposes `project`, `services`, `volumes` (key → resolved full name), `mounts`, `networks`, `compose_files`, `project_dir`. Verifies every service key present in the raw YAML file is present in the resolved config (§3, the `--profile '*'` check). |
| `…/policy.py` | `VOLUME_POLICY`, `PATH_POLICY`, `ANON_POLICY`, `SEGMENT_POLICY`. Every entry carries a written reason. Total, not partial: a miss is a refusal (§3). |
| `…/coverage.py` | The derivation and classification algorithm, the three refusal codes, `report()` with `may_backup = not refusals`. |
| `…/pgfacts.py` | Session pinning, `schema_migrations` read, per-table counts and md5s, `SCRATCH_RE` and the three-touchpoint assertion, the self-test restore, the signing-key fingerprint read. |
| `…/volumes.py` | Per-volume listing and tar, in and out, through a throwaway container of postgres's **image id**. |
| `…/manifest.py` | Build, serialise, validate. `REQUIRED_FIELDS` with types — the thing test 18 pins. |
| `…/crypto.py` | `NOVAENC1`: `encrypt_file`, `decrypt_file`, `derive_key`, `generate_passphrase`, `fingerprint`, `CryptoError`. No settings, no resolver, no app imports — pure mechanism, so it is the module that ports into the pyz unchanged. |
| `…/passphrase.py` | The resolver seam: `Resolver`, `RESOLVERS`, `resolve()`, `PassphraseUnavailable` (§5). |
| `…/bundle.py` | Inner/outer tar assembly with fixed member order, `safe_extract`, `.part`-then-`os.replace` atomicity with the same-second collision loop, `verify_inner`, `verify_bundle` (the full round trip), `build_pyz` (`zipapp.create_archive`). |
| `…/verbs.py` | `backup`, `restore`, `drill`, `undo_move` as the numbered sequences in §6. |
| `…/restore_main.py` | The zipapp entry point. Imports lazily so the pyz never needs `cryptography` at import time. |
| `deploy/backup/tests/*.py` | §12. |
| `docs/plans/rebuild/s41/` slice record | Written as S41 lands, not now. |

### Modified

| Path | Change |
|---|---|
| `deploy/install.sh:1130-1137` (`main`) | `backup`, `restore`, `undo-move` cases, dispatched into `deploy/backup.sh` (sourced). |
| `deploy/install.sh:1078` (`cmd_install`) | `refuse_if_moved` first; `check_foreign_project` inside `preflight`; `decide_subnet` after `generate_secrets` and before `record_compose_files`. |
| `deploy/install.sh` (new functions) | `refuse_if_moved`, `check_foreign_project`, `foreign_project_containers`, `foreign_project_volumes`, `project_own_volumes`, `offer_delete_foreign`, `docker_subnets_in_use`, `host_routes_in_use`, `subnet_overlaps`, `ip2int`, `int2ip`, `pick_project_subnet`, `derive_subnet_addrs`, `decide_subnet`, `sha256_of`, and one new pure reader `config_volume_keys` (the volume KEYS of `compose_config_text`, beside the existing `config_volume_name` at `deploy/install.sh:405`). |
| `deploy/docker-compose.yml:332-334` | `subnet: ${NOVA_SUBNET:-172.18.0.0/16}`, `ip_range: ${NOVA_SUBNET_RANGE:-172.18.0.0/17}`, `gateway: ${NOVA_SUBNET_GATEWAY:-172.18.0.1}`. The defaults are today's literals, so the Dell's live network is unchanged and nothing is recreated there. `NOVA_WEB_ADDR`/`NOVA_TAILSCALE_ADDR` are already env-driven (`:126,142,255,284`) and only their **defaults** move with the subnet, via `.env`. |
| `deploy/tailscale/start.sh` | A new step 0 ahead of containerboot: if `/config/MOVED_TO` exists, print it and `exit 1` (#18). The directory is already bind-mounted read-only at `/config` (`deploy/docker-compose.yml:290`), so this needs no compose change and no single-file bind — the mount shape that dies on a WSL restart. |
| `deploy/tailscale/start_test.sh` | One case for that refusal. |
| `deploy/install_test.sh` | The `decide_subnet`, foreign-project and `refuse_if_moved` cases (§12). |
| `deploy/.env.example` | Document `NOVA_SUBNET`, `NOVA_SUBNET_RANGE`, `NOVA_SUBNET_GATEWAY`, `NOVA_BACKUP_PASSPHRASE` (name only, never a value) and `NOVA_BACKUP_DIR`. |
| `deploy/README.md` | New `## Backups`, `## Restoring`, `## Moving Nova to another host` sections. `## Machines`'s manual rollback drill (`deploy/README.md:74-79`) gains a pointer. There is no backup/restore text there today (`map-deploy-data.md` §6). |
| `.gitignore` | `deploy/tailscale/MOVED_TO`, `deploy/.restored`, `deploy/backups/`. |
| `apps/novad/main.go:40-48` | `case "repoint": cmdRepoint(os.Args[2:])`, plus `cmdRepoint` (§10). |
| `apps/novad/main_test.go` | Four repoint cases. |
| `.github/workflows/rebuild-ci.yml` | Two new jobs, `backup-linux` and `backup-macos` (§12). |
| Four documents with now-wrong text | `hub-topology.md:135,411` and `hub/r2-integration.md:61,550` say backups exclude `network_credentials`; ruling 2 reverses that (the bundle is encrypted). Corrected as part of S41, per `rulings.md:60-67`. |

### Explicitly NOT modified

No file under `services/*/app/`, `services/*/migrations/`, `apps/web/src/`,
`evals/cases/` or `tests/` (except the new `tests/e2e` live case). #30, #31 and
`rulings.md:68-72`. `test_tools_registry`'s pinned name set, `test_eval_corpus`'s
`suite_version` and count, and `test_no_approvals` must all be untouched and
green — if an S41 change reddens one of them, the change is out of scope.

---

## 3. The bundle format

### Outer archive — plain uncompressed `tar`, member order fixed

| # | Member | Cleartext | Why |
|---|---|---|---|
| 1 | `README.txt` | yes | One paragraph for whoever finds the file: what it is, that it is encrypted, and the exact line to run. |
| 2 | `restore.pyz` | yes | The standalone restorer (#3). Stdlib-only zipapp built by `zipapp.create_archive`. |
| 3 | `meta.json` | yes, **unauthenticated** | Lets a bundle be listed without the passphrase. **Nothing decides anything from it.** |
| 4 | `payload.enc` | no | `NOVAENC1` over the inner `tar.gz`. |

Uncompressed on purpose: member 4 is incompressible ciphertext and members 1–3
are tiny, and an uncompressed tar lets `python3 -c "import tarfile"` — or `tar
-xOf bundle README.txt` — read the first three members without decompressing
190 MB first.

`meta.json` fields: `outer_version` (int, `1`), `encrypted` (bool),
`created_at` (str), `bundle_version` (int), `mode` (str), `source_host` (str),
`members` (int), `bytes_inner` (int), `included` (object: `databases`,
`volumes`, `files`, each a list of str), `excluded` (list of str),
`passphrase_fingerprint` (str), `restore_pyz_sha256` (str), `restore_hint`
(str). Every one of these also appears, authenticated, inside `MANIFEST.json`;
a restore re-reads it from there and never from `meta.json`.

### Inner archive — `tar.gz`, `MANIFEST.json` written FIRST

gzip cannot seek, so listing a bundle means decompressing everything ahead of
the member you want. v3 measured 3.4 s on a 167 MB bundle before the order was
forced (`map-v3-backup.md` §1). Members after the manifest:

```
MANIFEST.json
db/nova_core.dump            pg_dump -Fc --no-owner --no-acl
db/nova_gateway.dump
db/nova_memory.dump
volumes/<compose key>.tar    one per INCLUDE volume, tar --numeric-owner, built in a container
files/<repo-relative path>   e.g. files/deploy/.env
```

### `MANIFEST.json` — exact fields and types

`bundle_version` is `2`. (v3's was `1`; v4's is a different shape — three
databases, not one — and a v3 bundle must be refused by name rather than
half-read.) A field marked *required* must be present; `null` is a value, not an
absence. Unknown top-level keys are an error, not ignored: a manifest this code
does not fully understand is not a manifest it may restore from.

```jsonc
{
  "bundle_version": 2,                       // int, == BUNDLE_VERSION
  "format": "nova-backup/2",                 // str
  "created_at": "20260921T143005Z",          // str, %Y%m%dT%H%M%SZ, UTC, == the filename stamp
  "mode": "routine",                         // str, one of routine|move
  "transport": "local",                      // str, one of local|scp|offsite. RECORDED ONLY — see below
  "source": {
    "host": "dell-xps-8950",                 // str
    "os": "Linux 6.18.33.1-microsoft-standard-WSL2",  // str
    "repo_sha": "12ea01bf…",                 // str|null  (null when the repo could not be read)
    "repo_dirty": false,                     // bool|null (same)
    "project": "nova",                       // str, from the resolved config's `name`
    "compose_files": ["/…/deploy/docker-compose.yml"],  // [str], absolute, as compose reported
    "docker_version": "29.8.0",              // str
    "compose_version": "v5.3.0",             // str
    "tool_id": "sha256:…"                    // str — the image id, or "pyz:<sha256>"
  },
  "postgres": {
    "server_version": "16.10",               // str, from SHOW server_version
    "server_version_num": 160010,            // int, from SHOW server_version_num
    "pg_dump_version": "16.10",              // str, from pg_dump --version inside the container
    "pg_dump_major": 16,                     // int
    "container_image": "postgres:16",        // str, the tag compose asked for
    "container_image_id": "sha256:…"         // str, what is actually running
  },
  "databases": [                             // [object], exactly three, sorted by name
    {
      "name": "nova_core",                   // str
      "role": "core",                        // str, the owning role from postgres-init/01-databases.sql
      "member": "db/nova_core.dump",         // str
      "bytes": 48213904,                     // int
      "sha256": "…",                         // str, 64 hex
      "migrations": ["001_…sql", "…"],       // [str], schema_migrations.filename, sorted
      "session": {                           // object — the settings the md5s were measured under
        "TimeZone": "UTC", "DateStyle": "ISO, MDY",
        "IntervalStyle": "postgres", "extra_float_digits": "3",
        "bytea_output": "hex", "lc_numeric": "C"
      },
      "tables": [                            // [object], sorted by (schema, name)
        {"schema": "public", "name": "turn_spans", "rows": 184213, "md5": "…"}  // str,str,int,str(32 hex)
      ],
      "selftest": {
        "scratch_db": "nova_verify_a1b2c3d4",// str, matches ^nova_verify_[0-9a-f]{8}$
        "tables_compared": 24,               // int — the NUMBER COMPARED, not "ok"
        "equal": true                        // bool — always true in a written bundle
      }
    }
  ],
  "volumes": [                               // [object], sorted by key
    {
      "key": "v4_memdata",                   // str, the compose key
      "name": "nova_v4_memdata",             // str, the resolved full name
      "member": "volumes/v4_memdata.tar",    // str
      "disposition": "INCLUDE",              // str
      "files": 1843,                         // int
      "bytes": 96431104,                     // int (sum of member sizes, not the tar's)
      "listing_sha256": "…",                 // str — sha256 over "<sha256>  <relpath>\n" lines, LC_ALL=C sorted
      "sha256": "…"                          // str — sha256 of the member tar's bytes
    }
  ],
  "files": [                                 // [object], sorted by member
    {
      "member": "files/deploy/.env",         // str
      "origin": "deploy/.env",               // str, repo-relative
      "restore_to": "deploy/.env",           // str — the WRITER decides; the restorer obeys this hint
      "kind": "file",                        // str, one of file|tree
      "mode": 384,                           // int, the low 9 permission bits (0o600 == 384)
      "bytes": 412,                           // int
      "sha256": "…",                         // str
      "keys": ["POSTGRES_PASSWORD", "…"]     // [str]|null — KEY NAMES ONLY, never values
    }
  ],
  "excluded": [                              // [object] — "a restore that cannot say what it is
    {                                        //  missing invites the operator to assume it is
      "kind": "volume",                      //  missing nothing"
      "name": "v4_ollama",
      "disposition": "EXCLUDE_REDOWNLOAD",
      "reason": "model weights; re-pulled, or the node package adopts the existing volume"
    }
  ],
  "identity": {
    "core_signing_key_sha256": "…",          // str|null — sha256 of private_key_hex. NEVER the value.
    "tailnet_dns_name": "nova.…ts.net",      // str|null
    "device_count": 3,                       // int
    "people_count": 1                        // int
  },
  "coverage": {
    "sources": ["compose", "containers"],    // [str]
    "services": ["core", "…"],               // [str], every service in the resolved config
    "profiles": ["inference", "tailnet"],    // [str]
    "refusals": []                           // [object] — MUST be empty; a bundle is not written otherwise
  },
  "encryption": {
    "algorithm": "AES-256-GCM",              // str
    "kdf": "scrypt",                         // str
    "n": 32768, "r": 8, "p": 1,              // int, int, int
    "dklen": 32, "chunk_bytes": 4194304,     // int, int
    "passphrase_fingerprint": "a1b2c3d4e5f6",// str, 12 hex
    "passphrase_source": "env"               // str, the resolver name that supplied it
  }
}
```

Two notes a reader will otherwise ask about.

- **`transport` (#11, `hub/r2-integration.md:402`) has no behaviour in S41.** No
  offsite copy is built. It is recorded from `--transport` (default `local`) so
  a later slice that does build one does not have to bump `bundle_version` to
  add it. That is the whole of its job, and the manifest test pins it as a
  recorded string with no consumer.
- **`encryption` lives inside the encrypted manifest.** That looks circular; it
  is not. The parameters needed to *decrypt* are in the `NOVAENC1` header, which
  is outside. The manifest's copy exists so that after decryption the drill can
  cross-check the fingerprint and say "older bundles are sealed under a
  different passphrase than the one configured now" — a fact `meta.json` also
  carries, but unauthenticated.

---

## 4. Coverage — derived from the compose file, refusing on unclassified

### The measurement this section rests on **[M]**

Run here, read-only, 2026-09-21, against `deploy/docker-compose.yml` with
compose `v5.3.0`:

```
$ docker compose -f docker-compose.yml config --format json | jq '.services|keys, .volumes|keys'
  ["core","gateway","memory","postgres","searxng","web"]
  ["v4_memdata","v4_models","v4_pgdata","v4_workspace"]

$ docker compose -f docker-compose.yml --profile '*' config --format json | jq '…'
  ["core","gateway","memory","ollama","postgres","searxng","tailscale","web"]
  ["v4_memdata","v4_models","v4_ollama","v4_pgdata","v4_tailscale","v4_workspace"]

$ docker compose -f docker-compose.yml config --profiles          → inference
$ docker compose -f docker-compose.yml --profile '*' config --profiles → inference, tailnet
```

**Without `--profile '*'`, compose omits `ollama` and `tailscale` AND their
volumes `v4_ollama` and `v4_tailscale` from the resolved config** — and
`config --profiles` omits `tailnet` too, so "list the profiles, then pass each"
is circular and wrong. A coverage pass over the unwildcarded config would
silently not know `v4_tailscale` exists, which is precisely the class of miss
arc 8 exists to stop. The wrapper therefore always passes `--profile '*'`, and
`composeconfig.py` **verifies it worked**: it reads the top-level `services:`
keys straight out of the raw YAML file with a minimal indentation scan and
asserts every one appears in the resolved config. A missing service is a
refusal naming it and the exact `--profile` flags to re-run with — never a
narrower run that looks fine.

The resolved shapes, also measured: volume mounts appear as `{"type":"volume",
"source":"<compose key>","target":…}` and binds as `{"type":"bind","source":
"<absolute host path>","target":…,"read_only":…}`; the top-level `volumes` map
is `{"<key>": {"name": "nova_<key>"}}`; `name` is `"nova"`; `networks.default`
carries the IPAM block. So the full volume name is **read**, never assembled —
the same discipline as `config_volume_name` (`deploy/install.sh:405-414`).

### The algorithm

```
INPUT  C  = resolved compose config JSON (all profiles), from the wrapper
       L  = docker ps -a --filter label=com.docker.compose.project=<C.name>, each inspected
       R  = the repo root (the parent of C's project directory)

 1. P := C["name"].  Refuse unless P equals the project name of the checkout's
    own compose file (the same text, re-read). A bundle must not be taken of a
    project that is not this one.
 2. Assert every service key in the RAW yaml appears in C["services"]  (the
    --profile '*' check above). Miss → refusal R0_PROFILE_GAP.
 3. DECLARED := { key -> C["volumes"][key]["name"] }        for every key
       an entry with "external": true keeps its own name and is keyed
       "external:<name>" so it can never be confused with a project volume.
 4. MOUNTED := for every service s, for every m in s["volumes"]:
       m.type == "volume" -> ("volume", m.source, s, m.target)
       m.type == "bind"   -> ("bind",   m.source, s, m.target)
       m.type == "tmpfs"  -> recorded as excluded with the reason
                             "tmpfs holds nothing across a restart"
 5. LIVE := for every container c in L, for every mount in c.Mounts:
       Type=="volume" -> ("volume", Name, c.Labels[...service], Destination)
       Type=="bind"   -> ("bind",   Source, …)
    An ANONYMOUS volume is one whose Name matches ^[0-9a-f]{64}$. It is keyed
    (service, destination) — never by name, because the name is a fresh 64-hex
    id after every recreate. LIVE is what catches an image-declared volume the
    compose file never names; it is also why exited containers are included.
 6. SCAN_ROOTS := { C.project_dir }  ∪  { dirname(b) for every BIND source b
                    that is not under C.project_dir }
    Measured today that is {<repo>/deploy, <repo>/data} — DERIVED from the bind
    sources (gateway's ../data), not a list.
 7. HOST_FILES := every regular file under each SCAN_ROOT, skipping any path
    containing a SEGMENT_POLICY segment (.git, node_modules, __pycache__,
    .venv, dist, build — each with a written reason).
 8. UNIVERSE := DECLARED ∪ volumes(MOUNTED) ∪ volumes(LIVE)
                ∪ binds(MOUNTED) ∪ binds(LIVE) ∪ HOST_FILES
 9. Classify every member:
       volume, named       -> VOLUME_POLICY[key]
       volume, external    -> VOLUME_POLICY["external:" + name]
       volume, anonymous   -> ANON_POLICY[(service, target)]
       bind or host file   -> PATH_POLICY[first matching pattern, repo-relative]
    A miss is disposition UNCLASSIFIED.
10. Mode: a disposition of INCLUDE_MOVE_ONLY becomes INCLUDE when mode=="move"
    and EXCLUDE_DECLINED otherwise. Nothing else in coverage depends on mode.
11. Refusals, collected — never thrown one at a time, so one run names them all:
       R0_PROFILE_GAP        step 2
       R1_UNCLASSIFIED       any UNCLASSIFIED member
       R2_UNREACHABLE        an INCLUDE member the runner cannot actually read
       R3_INTERPOLATION      a bind source still containing "${"  (an unresolved
                             variable means compose could not tell us the path)
12. report()["may_backup"] := (refusals == [])
```

`may_backup` false → `backup` raises `BackupRefused` and **no bundle is
written**. Not a partial bundle with a warning (v3's explicit rule,
`map-v3-backup.md` §4).

### The refusal, exactly

An `R1_UNCLASSIFIED` prints, per member, and then exits 3:

```
REFUSING: 1 thing in this stack has no classification, so a backup cannot say
what it carries.

  volume  v4_newthing  (nova_v4_newthing)
      declared in deploy/docker-compose.yml, mounted by service `core` at /data/new
      no entry in deploy/backup/novabackup/policy.py  VOLUME_POLICY["v4_newthing"]

  Add one. The choices and what they mean:
      INCLUDE            operator state; it goes in the bundle
      INCLUDE_PG         a live PGDATA copy is torn; dump it instead
      INCLUDE_MOVE_ONLY  node identity; carried only by `backup --move`
      EXCLUDE_CODE       it comes back from git
      EXCLUDE_REDOWNLOAD it comes back from a registry or a model pull
      EXCLUDE_EPHEMERAL  a cache; losing it costs time, not data
      EXCLUDE_DECLINED   deliberately out, and say why

Nothing was stopped, dumped or written.
```

That last line matters: the coverage pass runs **before** any writer is stopped,
so a refusal costs nothing.

### Why a policy table is not the banned `BACKUP_EXCLUDE_DATA`

`rulings.md:44-46` forbids the hand-kept list. The distinction is load-bearing
and a reader will otherwise collapse it:

| | `BACKUP_EXCLUDE_DATA` | `VOLUME_POLICY` here |
|---|---|---|
| Where the SET of things comes from | the list | the compose file + live containers |
| A thing in the stack but not in the list | **silently skipped** | **refuses the whole run** |
| A thing in the list but not in the stack | invisible | reddens a unit test |
| What the list decides | whether to skip | what a known thing MEANS |

Something has to say that `v4_ollama` is re-downloadable, because git cannot see
inside a volume (v3's own reason, `map-v3-backup.md` §4). The control is that
the table must be **total** over a derived set, and two tests enforce both
directions (tests 10 and 11, §12) so the day a volume is added to compose, the
unit suite goes red before the operator ever meets the runtime refusal.

### The v4 tables, re-derived from `deploy/docker-compose.yml` (not ported)

`VOLUME_POLICY` — every key in the file today:

| Key | Disposition | Reason |
|---|---|---|
| `v4_pgdata` | `INCLUDE_PG` | a live PGDATA file copy is torn. Dumped instead; the fresh volume initialises from `deploy/postgres-init/01-databases.sql` with the carried password. |
| `v4_memdata` | `INCLUDE` | the notes (`services/memory/app/store.py:1-18`) — the state with no other copy anywhere. Carries `.embeddings/*.jsonl` too, which is a cache (`services/memory/app/embedding.py:664-688`); it is inside the volume, and a volume-level tar is the honest unit. |
| `v4_workspace` | `INCLUDE` | core's workspace files and attachments (`deploy/docker-compose.yml:60`). |
| `v4_tailscale` | `INCLUDE_MOVE_ONLY` | the node identity (`tailscaled.state`, certs, the MagicDNS name). Carrying it on a routine backup would let a restore stand up a second node claiming the same name; carrying it on a move is the entire point of a move. |
| `v4_models` | `EXCLUDE_EPHEMERAL` | gateway's model-file cache; its only reader is a disk-free check. |
| `v4_ollama` | `EXCLUDE_REDOWNLOAD` | model weights, tens of GB, re-pulled — or adopted in place by the node package. |

`PATH_POLICY` — patterns, repo-relative, first match wins:

| Pattern | Disposition | Reason |
|---|---|---|
| `deploy/.env` | `INCLUDE` (keys filtered, §6 restore step 7) | the only home of `POSTGRES_PASSWORD`, `CORE_TOKEN`, `CORE_GATEWAY_TOKEN`, `CORE_MEMORY_TOKEN`, `SEARXNG_SECRET` (`deploy/install.sh:29`). **This is the one thing a naive volume-only backup loses and nothing can regenerate.** Carried because the bundle is encrypted — ruling 2. |
| `deploy/postgres-init/**` | `EXCLUDE_CODE` | in git. |
| `deploy/tailscale/**` | `EXCLUDE_CODE` | in git. |
| `deploy/tailscale/MOVED_TO` | `EXCLUDE_EPHEMERAL` | this host's marker; a move must not carry its own refusal to the target. |
| `searxng/**` | `EXCLUDE_CODE` | in git, config only; searxng holds no state (`deploy/docker-compose.yml:185`). |
| `data/hardware.json` | `EXCLUDE_REDOWNLOAD` | regenerated by `detect_hardware` (`deploy/install.sh:808-863`), and host-specific — carrying the Dell's GPU to the mini PC is a lie the gateway would read. |
| `data/**` (anything else) | **no entry** | so a new file under `data/` refuses. `data/` is gitignored wholesale (`.gitignore:13`), which is exactly why it cannot be left to a catch-all. |
| `deploy/.restored`, `deploy/backups/**` | `EXCLUDE_EPHEMERAL` | a bundle must not contain other bundles. |

`ANON_POLICY` is empty today, with a comment recording that the measured
container set declares no anonymous volumes; an anonymous volume appearing later
therefore refuses, which is the intended behaviour.

`network_credentials` needs no entry at all: coverage of a database is
schema-driven — the whole database is dumped — so the table is carried the day
S43a creates it (`rulings.md:60-67`), and the four documents that still say
otherwise are corrected by this slice (§2).

---

## 5. Crypto

Ported from v3's `backend/app/backup_crypto.py` with the wire format **byte for
byte unchanged**, because it is already correct, already has the reader-side
cost cap, and keeping the bytes identical means a v3 payload can be opened by
this reader for free. Named, current, real tools only: Python's stdlib
`hashlib.scrypt` and the `cryptography` package's `AESGCM` (already a
`services/core` dependency, `services/core/pyproject.toml:11`).

### Container format `NOVAENC1`

```
b"NOVAENC1"                         8-byte magic
<4-byte big-endian header length>
<header JSON>                       {"v":1,"cipher":"AES-256-GCM","kdf":"scrypt",
                                     "n":32768,"r":8,"p":1,
                                     "salt":"<32 hex>","nonce_prefix":"<8 hex>",
                                     "chunk":4194304}
repeated to EOF:
  <4-byte big-endian ciphertext length><ciphertext || 16-byte GCM tag>
```

- **Cipher**: AES-256-GCM, 128-bit tag (`TAG_LEN = 16`).
- **KDF**: `hashlib.scrypt(passphrase.encode("utf-8"), salt=salt, n=32768, r=8,
  p=1, dklen=32, maxmem=256*1024*1024)`. Stdlib, so `restore.pyz` derives the
  same key with no third-party package. ~34 MB of KDF memory — deliberately
  modest, because the generated passphrase carries 160 bits of entropy and the
  KDF is not what stands between an attacker and the key.
- **Salt**: 16 random bytes, **fresh per file** → a fresh key per file.
- **Chunking**: 4 MiB plaintext per frame (a bundle is hundreds of MB;
  single-shot GCM would hold plaintext and ciphertext in memory at once).
  Reader accepts up to 64 MiB.
- **Nonce**: `nonce_prefix (4 random bytes, per file) || frame_index (8-byte
  big-endian, from 0)`. Unique per (file, chunk) with nothing stored; the
  reader reconstructs it from frame position.
- **AAD**: `MAGIC || header_bytes || 8-byte-BE(index) || (0x01 if final else
  0x00)`. This authenticates the header *and the chunk's position in the
  sequence*. Consequences, which are the reason for the design: a tampered
  header fails; a reordered chunk fails; and a **truncated file fails** instead
  of silently yielding a shorter archive — because the true final chunk's AAD
  carries `final=1`, and a truncation either finds no frame or finds an earlier
  chunk whose `final=0` no longer matches its position.
- **Finality**: at write, `final = (cumulative_bytes_read >= file_size)` — NOT
  "the read was short", because the last chunk of an exact-multiple file is
  full-length. At read, by **lookahead**: the next frame header is read before
  the current frame is decrypted, and `final = (next frame is None)`.
- **Reader-side cost cap**, separate from the writer's cost and checked before
  any allocation: `n <= 2**18`, `n` a power of two, `r <= 16`, `p <= 4`, and
  `128 * r * n <= 128 MiB`; `salt` must decode to exactly 16 bytes and
  `nonce_prefix` to exactly 4. A decryptor must allocate `128*r*n` bytes
  *before* the first authentication check can run, so without this cap a
  tampered header naming an absurd cost makes an honest reader allocate
  gigabytes, or blow `maxmem` and turn "tampered" into a bare `ValueError`.
- **Every failure raises `CryptoError`** — never `ValueError`, never
  `MemoryError` — with the one sentence, identical in the library and in
  `restore.pyz`, and pinned identical by test 7:

  > decryption failed — wrong passphrase, or the file is corrupt, truncated or
  > tampered with (GCM cannot tell these apart)

  GCM genuinely cannot distinguish those, and pretending otherwise produces the
  3am reasoning "the passphrase must be right, so the file must be broken".
- **Passphrase generation** (when the `prompt` resolver generates one):
  `secrets.token_bytes(20)` → 160 bits → base32, lowercased, grouped
  `xxxx-xxxx-…` (8 groups of 4). Optimised for transcription, not typing,
  because the point is to be written down off-machine.

### How `restore.pyz` decrypts on a bare machine

1. `AESGCM` from `cryptography` if it imports. Otherwise:
2. System OpenSSL's `libcrypto` through `ctypes`: `EVP_CIPHER_CTX_new`,
   `EVP_DecryptInit_ex(EVP_aes_256_gcm())`, `EVP_CIPHER_CTX_ctrl(…,
   EVP_CTRL_AEAD_SET_IVLEN, 12, …)`, key/IV init, `EVP_DecryptUpdate` for the
   AAD then the ciphertext, `EVP_CIPHER_CTX_ctrl(…, EVP_CTRL_AEAD_SET_TAG, 16,
   tag)`, `EVP_DecryptFinal_ex` — whose **return value is the tag check**, and a
   zero return is a `CryptoError`, not a warning.
   On `sys.platform == "darwin"`, `ctypes.util.find_library` is **never called**
   (Apple's stub libcrypto aborts the whole process); only
   `/opt/homebrew/opt/openssl@3/lib/libcrypto.dylib` and
   `/usr/local/opt/openssl@3/lib/libcrypto.dylib` are tried. **Unverified**: no
   macOS machine was available to confirm those paths against a current
   Homebrew. The macOS CI job (§12) is what measures it.
3. If neither is available, or if `hashlib.scrypt` is missing (a Python built
   without OpenSSL), **refuse** with the exact remedy (`pip install
   cryptography`, or `brew install openssl@3`). Never a weaker KDF, never a
   different cipher, never "continuing without verification".

The passphrase reaches `restore.pyz` by `--passphrase-file`, then
`$NOVA_BACKUP_PASSPHRASE`, then an interactive `getpass.getpass()` — **never a
positional argument**, so it never lands in `ps` output or shell history. It is
tried **stripped, then verbatim**: a paper transcription usually gains
whitespace, and a stored value may legitimately carry it.

---

## 6. The passphrase resolver seam

### Interface

```python
class PassphraseUnavailable(Exception): ...          # never a bare exception

@dataclass(frozen=True)
class ResolverContext:
    mode: str                 # "backup" | "restore" | "drill"
    interactive: bool         # sys.stdin.isatty()
    passphrase_file: Path | None
    bundle_fingerprint: str | None   # restore: which passphrase sealed this bundle

@dataclass(frozen=True)
class Resolver:
    name: str
    description: str          # one line, printed by --help and by the refusal
    can_create: bool          # may it MINT a passphrase when there is none?
    resolve: Callable[[ResolverContext], str]

RESOLVERS: dict[str, Resolver]

def resolve(source: str | None, ctx: ResolverContext) -> tuple[str, str]:
    """Returns (passphrase, resolver_name). Raises PassphraseUnavailable with a
    stated reason — an unknown name, or ANY exception out of the resolver —
    and never returns an empty string."""

def fingerprint(passphrase: str) -> str:   # sha256(utf-8)[:12] hex
```

Callers — `verbs.backup`, `verbs.restore`, `verbs.drill`, and
`restore_main` — only ever call `resolve(...)` and `fingerprint(...)`.

### The resolvers that land now

| Name | Source | `can_create` | Refuses when |
|---|---|---|---|
| `env` | `$NOVA_BACKUP_PASSPHRASE`. Passed to the container by `--env NOVA_BACKUP_PASSPHRASE` (**name only** — the value is inherited, never written into argv, which `backup_test.sh` asserts against the recorded `docker run` argv). | no | unset or empty |
| `file` | `--passphrase-file <path>`, read raw (not stripped at read; stripped-then-verbatim at use) | no | the path does not exist, **or its mode has any group/other bit set** — a passphrase file the rest of the machine can read is a CANNOT, and the refusal names the observed mode |
| `prompt` | `getpass.getpass()` on a TTY. On `backup` with nothing there yet, it offers to generate: prints the 160-bit phrase once, then requires the operator to **retype it** and compares — a transcription check, mechanical, not a sentence asking them to be careful. | yes | not a TTY, or the retype does not match |

Default order when `--passphrase-source` is absent: `file` if
`--passphrase-file` was given, else `env`, else `prompt`. Nothing supplies one
and stdin is not a TTY → `PassphraseUnavailable`, and **no bundle is written**.
No passphrase, no bundle — the whole run refuses rather than writing a
plaintext one.

### How a secrets manager plugs in later, without changing callers

Add one `Resolver` to `RESOLVERS` and select it with `--passphrase-source
<name>` (or `NOVA_BACKUP_PASSPHRASE_SOURCE`). Nothing else moves — not the
verbs, not the crypto, not the manifest, which already records
`encryption.passphrase_source` as a free string. v3's registry carried the
owner's own words for why (`map-v3-backup.md` §3, quoting 2026-08-02):
"Eventually it'll get it from a secrets manager. Could be the one that is
shipped, an mcp server, application such as 1password, or a cloud secrets
manager like aws secrets manager."

**What is deliberately not here**: v3's `local` resolver, which get-or-created
the passphrase inside Nova's own `secret_store` under an advisory lock. v4 has
no secret store at all (`map-v3-backup.md` §6.4: a grep for `secret_store`
across `services/` returns only a test filename), so the resolver would have
nowhere to live. Proposal A adds a `store` entry to this same dict later;
`rulings.md:48-49` rules the store out of S41. Also not here: v3's
off-machine-recording nag and `confirmation()` — they wrote to
`recommendations`/`capability_events` tables v4 does not have
(`map-v3-backup.md` §6.9).

**The consequence, stated rather than hidden**: with no store, the passphrase's
only home is wherever the operator put it — a password manager feeding
`$NOVA_BACKUP_PASSPHRASE`. Lose it and every bundle is unreadable, by design,
with no recovery path in this slice. `--drill` reports when the newest bundles'
fingerprints differ from the configured one, which is the only early warning
there is. Open question 1, §15.

---

## 7. The verbs

Exit codes, uniform across all four: `0` verified · `1` a verification failed ·
`2` the environment could not be asked (docker down, no python3) · `3` refused
before anything was touched (coverage, passphrase, gates) · `4` **partial**: the
artefact is good but the machine was not left as found (e.g. the bundle is
written and verified but a writer did not come back healthy). `4` exists so
"the backup is fine, the stack is not" can never be printed as `0`.

A rule applied to every step below: **a step that cannot make its own
verification FAILS and names the verification it could not make.** There is no
"assume ok", no `|| true`, no `ignore_errors`.

### 7.1 `backup` — `./install backup [--move] [--transport X]`

| # | Step | Verifies | On failure |
|---|---|---|---|
| 1 | Resolve the docker endpoint (`docker context inspect`), then `docker version --format json`. | The daemon answered and the JSON parsed. | exit 2 naming the endpoint tried. Nothing touched. |
| 2 | Build/refresh the tool image (`docker build -q deploy/backup`). | A non-empty image id was printed and `docker image inspect <id>` succeeds. | exit 2 with the build log's last 20 lines. |
| 3 | Wrapper writes the resolved compose JSON (`--profile '*'`) to a 0600 `mktemp`; `trap` removes it. | `jq`-free: the tool parses it and asserts §4 step 2 (every raw service present). | exit 3 naming the missing services and the `--profile` flags to use. |
| 4 | Resolve the passphrase (§6) and compute its fingerprint. | Non-empty; on `prompt`-generate, the retype matched. | exit 3. **No bundle.** |
| 5 | Archive directory: exists, is a directory, `os.statvfs` free bytes ≥ 2× the estimated bundle size (sum of volume sizes + dump estimate), and the **0600 mode probe**: create `.nova-probe-<8 hex>`, `os.chmod(0o600)`, re-`stat`, require `st_mode & 0o777 == 0o600`, unlink. | The archive path can actually hold owner-only permissions (#25/#26). This replaces the hardcoded `/mnt/[a-z]/` regex from `hub/r2-slices-design.md:210`: the probe catches NTFS, exFAT, a CIFS mount and an SMB share, none of which a path pattern knows about. | exit 3 naming the path and the mode actually observed. |
| 6 | Coverage (§4), with the live container list. | `may_backup` — i.e. no `R0`/`R1`/`R2`/`R3` refusal. | exit 3, printing every refusal at once. **Nothing has been stopped yet** — that is why this step is here and not later. |
| 7 | Stop `core`, `gateway`, `memory`, `web` (+ `tailscale` when `--move`) with `docker stop -t 330` (core's `stop_grace_period`, `deploy/docker-compose.yml:34`). | For each: `docker inspect` reports `.State.Running == false` **and** `.State.FinishedAt` is later than the moment the stop was issued (so a container that was already dead for other reasons is not read as "we stopped it"). Polled to 360 s. And: `postgres` reports `.State.Health.Status == "healthy"`. | exit 1 naming the container still running; then **restart whatever this run stopped** (routine mode) and say both what failed and what was restarted. |
| 8 | Per database (`nova_core`, `nova_gateway`, `nova_memory`), through `docker exec -i postgres psql -U postgres -d <db> -tAX -v ON_ERROR_STOP=1`: pin the session (`SET TimeZone='UTC'; SET DateStyle='ISO, MDY'; SET IntervalStyle='postgres'; SET extra_float_digits=3; SET bytea_output='hex'; SET lc_numeric='C';`), list `information_schema.tables` where `table_type='BASE TABLE'` and schema not in (`pg_catalog`,`information_schema`), then per table `SELECT count(*)` and `SELECT md5(string_agg(t::text,'' ORDER BY t::text)) FROM <tbl> t`. Read `schema_migrations.filename`. Read `sha256(core_signing_key.private_key_hex)` — **computed in SQL via `encode(sha256(private_key_hex::bytea),'hex')`, so the key value never crosses the process boundary.** | Every listed table produced both a count and an md5 (no NULL, no missing row); `psql` exit 0; the table list is non-empty for `nova_core` and `nova_gateway`. `nova_memory` legitimately has only `schema_migrations` (`services/memory/app/store.py:20-23`) and that is recorded, not treated as an error. | exit 1 naming the database and the first table that produced no measurement. |
| 9 | Dump each database: `docker exec -i postgres pg_dump -Fc --no-owner --no-acl -U postgres -d <db>`, stdout streamed to `<staging>/db/<db>.dump`. | exit 0; file size > 0; **the first five bytes are `PGDMP`**. (Size alone is not enough: a `pg_dump` that fails after emitting a header leaves a plausible-looking short file.) | exit 1 with `pg_dump`'s stderr verbatim; delete the staging tree. |
| 10 | Self-test restore, per database: `scratch = "nova_verify_" + uuid4().hex[:8]`; assert `SCRATCH_RE = ^nova_verify_[0-9a-f]{8}$` **before CREATE**; `CREATE DATABASE`; connect and `SELECT current_database()` and compare to `scratch`; assert again **before `pg_restore`**; `pg_restore --exit-on-error --single-transaction --no-owner -d <scratch>`; re-measure counts and md5s under the identical pinned session; assert again **before DROP** in a `finally`. | Every table present, and **every count and every md5 equal**. `pg_restore --exit-on-error` is required, not tidy: its default is to continue past errors, which turns a misdirected restore into an interleaving instead of a stop. The `current_database()` cross-check catches a DSN that looks right and resolves elsewhere. | exit 1 naming the first differing table with both values; drop the scratch db; delete the staging tree. **No bundle is written.** |
| 11 | Per INCLUDE volume, two runs of a throwaway container of **postgres's own image id** (read from the running container, so nothing is pulled): (a) `sh -c 'cd /v && find . -type f -print0 \| LC_ALL=C sort -z \| xargs -0 sha256sum'` → the listing; (b) `tar -C /v -cf - --numeric-owner .` → the member. Both with `-v <name>:/v:ro`. | Both exits 0; the number of regular-file members in the tar the tool just wrote **equals** the listing's line count (read back with `tarfile`, not assumed); `listing_sha256` computed over the LC_ALL=C-sorted listing. | exit 1 naming the volume and both counts. |
| 12 | Write `MANIFEST.json`; build `inner.tar.gz` with the manifest as the **first** member, then `db/`, `volumes/`, `files/`. | `tarfile.getnames()[0] == "MANIFEST.json"`. | exit 1. |
| 13 | Self-verify the inner archive: extract to a **fresh** temp dir with `safe_extract` and **re-derive** every member's sha256 from the extracted bytes. | Every re-derived hash equals the manifest's. Deliberately not trusting the numbers the manifest recorded moments ago. The exception handler here is broad on purpose: a truncated gzip raises `EOFError`, which is neither `TarError` nor `OSError`, and a narrower catch turns "corrupt" into an uncaught crash. | exit 1; delete the `.part`. |
| 14 | `crypto.encrypt_file(inner, payload.enc, passphrase)`. | The writer's own frame accounting: total plaintext bytes consumed equals the inner archive's size. | exit 1; delete everything. |
| 15 | `bundle.build_pyz()` → `restore.pyz`; build the outer tar as `README.txt`, `restore.pyz`, `meta.json`, `payload.enc`, in that order, into `<final>.part` created with mode 0600. | `zipfile.ZipFile(pyz).testzip() is None` and a subprocess `python3 restore.pyz --version` exits 0 — the script in the bundle is one this machine can actually run. #3 is only satisfied if the copy travels *and works*. | exit 1; delete the `.part`. |
| 16 | **Round-trip the finished bundle**: reopen `<final>.part` from disk, read `meta.json`, decrypt `payload.enc` with the same passphrase, `safe_extract`, re-hash every member, re-parse `MANIFEST.json` and compare it field-by-field with the one built in step 12. | The bundle a stranger would open is the bundle we meant to write. | exit 1; delete the `.part`. |
| 17 | `os.replace(part, final)`. Name `nova-backup-<host>-<stamp>[-N].tar`. A collision loop appends `-2`, `-3`, … | The final path did not exist before the replace. This guards a documented v3 incident: two snapshots in the same second let `os.replace` clobber the very bundle being restored. | exit 1. |
| 18 | Routine mode: `docker compose … start core gateway memory web`; poll `.State.Health.Status` to 240 s. `--move` mode: also stop `postgres`, then write the marker (§7.4). | Every restarted service reports `healthy`. | **exit 4**, stating plainly that the bundle IS written and verified at `<path>` and that `<service>` did not come back, with its last 20 log lines. Never `0`. |
| 19 | Print the verdict. | — | One line per fact actually checked: writers stopped (n), tables measured (n per db), dumps verified (`PGDMP`, bytes), self-test equal (n tables per db), volumes tarred (n files, n bytes), bundle round-tripped, path, sha256, fingerprint. The word "verified" appears only after step 16. |

### 7.2 `restore` — `./install restore <bundle>`

Destructive, onto an **empty** target only. There is no restore-over-a-live-system
in S41 (§13).

| # | Step | Verifies | On failure |
|---|---|---|---|
| 1 | `refuse_if_moved`: is `deploy/tailscale/MOVED_TO` present here? | Absent. | exit 3: this machine was moved away from; run `./install undo-move` first. |
| 2 | **`decide_subnet` (§9), before any compose command.** | It wrote or adopted `NOVA_SUBNET`/`NOVA_SUBNET_RANGE`/`NOVA_SUBNET_GATEWAY` into `deploy/.env`, and re-reading them back gives the values it chose. | exit 3 naming the colliding network or route. Nothing created. This is step 2 and not step 9 because bringing `postgres` up creates `nova_default`, and on the mini PC the hardcoded 172.18 collides with `docker_default` (#12). |
| 3 | Open the bundle: read the outer tar, resolve the passphrase for *this* bundle's fingerprint, decrypt, `safe_extract` the inner archive into a private temp dir (0700). | Every member's sha256 equals the manifest's; `bundle_version == 2` (a `1` is v3's shape and is refused **by name**, not half-read); `safe_extract` rejects absolute paths, `..`, symlinks, hardlinks and device nodes. | exit 1, **hard stop**: print the mismatching members and **print no next steps at all**, then remove everything this run created. A half-extracted credential file must never be left looking like a finished restore. |
| 4 | Empty-target check (#14): for every volume in the manifest, `docker volume inspect` must fail **or** `docker run --rm -v <name>:/v:ro <img> sh -c 'ls -A /v \| head -1'` must print nothing. And `docker ps -a --filter label=com.docker.compose.project=<project>` must be empty. | Nothing is being overwritten. | exit 3 naming **every** non-empty volume and **every** existing container. A container of a foreign `nova` project lands here too, with the same message `install.sh` prints (§8). |
| 5 | Version gate (#14): `docker run --rm <postgres image from compose> pg_restore --version` → major. | `major >= manifest.postgres.pg_dump_major`. An **older** `pg_restore` cannot read a newer custom-format dump. | exit 3 naming both versions and the image tag. |
| 6 | Migration gate: for each database, every filename in `manifest.databases[].migrations` exists in this checkout's `services/<role>/migrations/`. | All present. | exit 3 naming the first missing file and `manifest.source.repo_sha` — "this bundle came from a newer Nova; check out `<sha>` and restore there." **Stated degradation**: v4's `schema_migrations` has only `filename` and `applied_at`, no checksum (`services/core/app/migrations_runner.py:19-24`), so this is filename-only and a *renumbered* migration reads as missing. v3 hit exactly that and fixed it with a checksum fallback (`map-v3-backup.md` §5). Adding the column is a migration, and S41 ships none (#31) — carry, §13. |
| 7 | `.env` keys: for each key in `manifest.files[].keys` for `files/deploy/.env`, compare against the target's `deploy/.env` if one exists. | Either the key is absent there, or its value is **identical**. A conflict refuses. If `deploy/.env` is absent, write it (from `deploy/.env.example` plus the carried keys), `chmod 0600`, then **re-stat and require 0600**. | exit 3 naming the conflicting **key** and never its value, on either side. |
| 8 | Create each volume: `docker volume create --label com.docker.compose.project=<project> --label com.docker.compose.volume=<key> <name>`, then read the labels back with `docker volume inspect`. | The volume exists and carries exactly those labels, so a later `docker compose up` adopts it instead of creating a second one. | exit 1 naming the volume. |
| 9 | Untar each volume member into its volume through a throwaway container (`tar -C /v -xf - --numeric-owner`), then **re-run the listing pass** of step 7.1/11 against the restored volume and compare to `manifest.volumes[].listing_sha256`. | The restored file set and every file's sha256 are identical to the manifest's. | exit 1, printing the paths that differ (present-only, missing, or hash-differing). The volume is **left in place** for inspection, and the run stops — never continues to the database. |
| 10 | `docker compose … up -d postgres`; poll health. | `.State.Health.Status == "healthy"` within 240 s; and the three databases exist (created by `deploy/postgres-init/01-databases.sql` on the fresh volume) **and are empty** — `SELECT count(*) FROM information_schema.tables WHERE table_schema='public'` returns 0 for each. | exit 1 with postgres's last 20 log lines; a non-empty database is exit 3 (#14 again, at the level that matters). |
| 11 | Per database: `docker exec -i postgres pg_restore --exit-on-error --single-transaction --no-owner --role=<role> -U postgres -d <db>` with the dump on stdin (#15). | exit 0. `--single-transaction` means a failure leaves the database as it was, not half-populated. | exit 1 with `pg_restore`'s stderr verbatim. |
| 12 | Re-measure counts and md5s under the **identical** pinned session and compare to the manifest (#16). | Every table present; every count equal; every md5 equal. Note this is `count(*)`, not `n_live_tup` — v3 compared a stats-collector estimate and therefore had to forgive differences (`map-v3-backup.md` §5). An exact count cannot be forgiven, so a difference here is a failure, not a note. | exit 1 listing **every** difference, not the first. |
| 13 | Re-read `encode(sha256(private_key_hex::bytea),'hex')` from `core_signing_key` and compare to `manifest.identity.core_signing_key_sha256` (#16). | Equal. `null == null` is equal (a stack that never generated one); one side `null` is a failure. This is the fact that decides whether every paired device still verifies after the move. | exit 1. |
| 14 | `docker compose … stop postgres`; write `deploy/.restored` (bundle name, its sha256, the stamp, the manifest's `source.host` and `repo_sha`). | The file exists and re-reads. | exit 1. |
| 15 | Print. | — | The per-database table counts and the per-volume file counts actually compared, the fingerprint match, and then exactly one next command: `./install`. The word **"restored"** is printed only if steps 9, 12 and 13 all passed. |

### 7.3 `restore --drill` and the `drill` verb

Two entry points, one implementation. `restore --drill <bundle>` drills one
named bundle; `./install backup drill` (the **drill verb**, #5) picks the newest
bundle in the archive directory and drills that. The weekly schedule is not
built (#5 says the verb; `rulings.md:68-72` keeps the scheduler out).

Everything happens inside a throwaway world named
`nova-drill-<uuid4().hex[:8]>`, with `DRILL_RE = ^nova-drill-[0-9a-f]{8}$`
asserted **before every create and before every delete** — the three-touchpoint
pattern v3 used for scratch databases, applied to containers, volumes and the
network. Nothing named `nova_*` is created, written or removed at any point.

| # | Step | Verifies | On failure |
|---|---|---|---|
| 1 | Choose the bundle. For the `drill` verb: the newest `nova-backup-*.tar` in the archive directory. | **There is at least one bundle.** No bundles is a **FAILED drill**, not a vacuous pass — the question a drill answers is "could I recover from disaster today", and with no bundle the answer is no. | exit 1: "no bundle to drill". |
| 2 | Open and hash-verify (as 7.2/3), version gate (7.2/5), migration gate (7.2/6). | Same three. | exit 1; nothing created. |
| 3 | Create the network `nova-drill-<id>_net` and the volumes `nova-drill-<id>_<key>`; start `postgres` from `manifest.postgres.container_image` with `docker run -d --name nova-drill-<id>-pg`, `POSTGRES_PASSWORD` a fresh `secrets.token_hex(16)` that never leaves the process, and the repo's own `deploy/postgres-init/` bind-mounted read-only so the three roles/databases are created identically. | `DRILL_RE` before each create; `pg_isready -U postgres` inside the container within 120 s. | exit 1; run the teardown (step 7) and report what it removed. |
| 4 | `pg_restore --exit-on-error --single-transaction --no-owner --role=<role>` each dump; re-measure and compare counts and md5s. | Every table, every count, every md5 equal — **and** that the comparison was actually made for every table in the manifest. A table that could not be measured is a failure, not a skip. | exit 1 listing every difference. |
| 5 | Untar each volume member into its `nova-drill-*` volume; re-list; compare `listing_sha256`. | Equal. | exit 1 listing the differing paths. |
| 6 | Compare the signing-key fingerprint. | Equal. | exit 1. |
| 7 | Teardown, in a `finally`: `docker rm -f` the container, `docker volume rm` each drill volume, `docker network rm` the drill network — each name re-asserted against `DRILL_RE` immediately before the command. | **Each removal is confirmed by a follow-up `inspect` that must fail with "no such".** | exit 1 naming every object that survived, so a leak is reported rather than accumulating silently. This is a distinct failure from a comparison failure and says so. |
| 8 | Cross-checks the drill alone can surface. | Whether **older** bundles in the archive directory carry a `passphrase_fingerprint` different from the configured passphrase's (read from each bundle's cleartext `meta.json`, no decryption needed) — a rotated passphrase means those bundles are unreadable and the operator should know before they need them. | Reported as a stated warning line, not a failure: they were valid when written. |
| 9 | Report. | — | Per database: tables compared, rows compared. Per volume: files compared. Fingerprint equal. Elapsed. Exit 0 **only** if every comparison in steps 4–6 was both made and equal, and step 7 confirmed every removal. |

### 7.4 `backup --move`, the marker, and `undo-move`

`--move` is `backup` with `mode="move"` plus three differences:

1. `v4_tailscale` flips from `INCLUDE_MOVE_ONLY` to `INCLUDE` (§4 step 10) — the
   node identity travels, which is the point of a move. `manifest.mode` records
   it, so a restore can tell a move bundle from a routine one.
2. `tailscale` is stopped and verified stopped alongside the other writers
   (step 7), and `postgres` is stopped at the end; nothing is restarted.
3. The marker is written (#18).

**The marker: `deploy/tailscale/MOVED_TO`.** That path, not `deploy/.moved`,
for a mechanical reason: `deploy/tailscale/` is already bind-mounted into the
sidecar read-only at `/config` (`deploy/docker-compose.yml:290`), so the sidecar
can see the marker with **no compose change and no single-file bind** — a
single-file mount resolves to a host inode at create time and dies with exit 127
when the WSL mount is recycled, which this repo has been bitten by
(`deploy/docker-compose.yml:287-289`). Line-oriented, so `sh` inside an Alpine
image can print it:

```
moved_at=20260921T143005Z
bundle=nova-backup-dell-xps-8950-20260921T143005Z.tar
bundle_sha256=<64 hex>
tailnet_dns_name=nova.<tailnet>.ts.net
to=<what the operator passed to --move, or "unstated">
```

`deploy/tailscale/start.sh` gains a step 0 **before** containerboot: if
`/config/MOVED_TO` exists, print it and `exit 1`. The sidecar then never starts,
so the moved-away machine cannot claim the tailnet name back and flap against
the new one. `install.sh`'s `refuse_if_moved` runs first in `cmd_install`
(`deploy/install.sh:1078`) and refuses the same way, so `./install` cannot
restart the stack around it either.

**`undo-move`** — `./install undo-move`:

| # | Step | Verifies | On failure |
|---|---|---|---|
| 1 | Read `deploy/tailscale/MOVED_TO`. | Present and parses (every `key=value` line known). | Absent → print "no marker here; nothing was moved from this machine" and **exit 0**: the postcondition (no marker) already holds. Present but unparseable → exit 1 naming the bad line; removing a marker it cannot read is not something it may assume is safe. |
| 2 | Try to say whether the moved-to instance is live: if a host `tailscale` CLI exists, `tailscale status --json` and look for a peer whose DNS name equals the marker's `tailnet_dns_name` and is online. | Either a definite answer, or a definite **"could not check"**. | If there is no host CLI — the usual case, since the sidecar that would answer is exactly the thing refusing to start — it prints: *"I cannot check from here whether `<name>` is online: the sidecar is stopped, so there is no tailscaled to ask. If that node is up elsewhere, both will claim the name and flap."* |
| 3 | Remove the marker. | `os.path.exists` is false afterwards. | exit 1 naming the path. |

Step 2 is the shape this codebase requires and it is worth being explicit about:
`undo-move` **states what it could not verify and then does what it was asked**.
It does not refuse on the owner's behalf, and it does not ask him to confirm. A
check may state that something CANNOT be done; it may never decide that it MAY
NOT (`services/core/tests/test_no_approvals.py`).

---

## 8. `install.sh`: the foreign `nova` compose project

Ruling 1 (`rulings.md:12-38`): the installer **refuses**, **names every
container and volume it found**, then **offers to delete exactly what it named**,
with the names coming from `docker` output and never from a list in the script.

### Why this is a refusal and not an approval gate

v4's compose project is `nova` (`deploy/docker-compose.yml:1`), and so is the
mini PC's stopped platform-line stack. A plain `docker compose up` there would
**adopt** `nova-postgres-1` as this project's `postgres` service container and
recreate it (`hub-p0-measurements.md:58-66`). So the refusal states a **CANNOT**:
the install cannot proceed while another project owns this project name. The
deletion that follows is the owner disposing of his own data, which nothing in
Nova decides for him — he ruled it, and the script's job is to bound it exactly.
`services/core/tests/test_no_approvals.py` is scoped to `services/core/app`
(`APP_DIR = Path(tools.__file__).resolve().parent.parent`); this is host tooling
and no tool, guard or dispatch is involved.

### How the names are derived

Every name comes from `docker`, and the identity test is the one
`bundled_ollama_running` already uses for a single service
(`deploy/install.sh:186-217`), generalised from one slot to the whole project.

```sh
project="$(compose_config_text | config_project_name)"     # install.sh:394,399 — read, never "nova"
want="$(canonical_path "$COMPOSE_FILE")"                   # install.sh:132

foreign_project_containers() {                             # ids, one per line
  local id labels
  for id in $(docker ps -aq --filter "label=com.docker.compose.project=$project"); do
    labels="$(docker inspect --format \
      '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$id")"
    # OURS iff any config-files entry, canonicalised, equals this repo's compose file.
    # An EMPTY label is foreign: unlabelled cannot be proven ours.
    config_files_match "$labels" "$want" || printf '%s\n' "$id"
  done
}
```

Volumes are **not** taken from `docker volume ls --filter label=…`. That filter
misses exactly this case: the mini PC's `nova_pgdata`, `nova_postgres-data`,
`nova_redis-data`, `nova_redis_data` predate compose volume labelling
(`hub-p0-measurements.md:61`), and v3 measured the same failure — a label filter
that missed the real Postgres volume while including a stale one nothing
referenced (`map-v3-backup.md` §4). So:

```sh
foreign_project_volumes() {          # derived from the containers ALREADY NAMED
  local id
  for id in $(foreign_project_containers); do
    docker inspect --format \
      '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\n"}}{{end}}{{end}}' "$id"
  done | sort -u
}
```

That is the bound the ruling asks for: the deletion set is derived **from the
containers it printed**, so it cannot name anything it did not first show.

### How a v4 volume can never be caught

Two independent mechanisms, because one is a filter and the other is an assert:

```sh
project_own_volumes() {              # the resolved FULL names, read from compose
  local cfg key                      # e.g. nova_v4_pgdata … — never assembled
  cfg="$(compose_config_text)"       # install.sh:394, with --profile tailnet
  for key in $(printf '%s' "$cfg" | config_volume_keys); do
    printf '%s' "$cfg" | config_volume_name "$key"          # install.sh:405
  done
  # plus every volume mounted by a container that IS ours by the config_files test
}
```

1. The deletion set is `foreign_project_volumes() - project_own_volumes()`.
2. **Immediately before the delete loop**, each remaining name is re-checked
   against `project_own_volumes` and the loop `die`s on a hit. The filter could
   be wrong; the assert next to the destructive command is what makes it safe.

Because `project_own_volumes` is read from `compose config` (measured **[M]** in
§4: `{"v4_pgdata": {"name": "nova_v4_pgdata"}, …}`), a volume added to
`deploy/docker-compose.yml` tomorrow is protected the same day, with nothing to
update. A `nova_v4_*` name pattern would have been the wrong control: it is a
list, and it would not protect a volume someone names differently.

### What it prints

```
REFUSING: another compose project called `nova` is on this machine, and it is
not this one. `docker compose up` would ADOPT its containers.

  containers (10)
    nova-postgres-1        service postgres      exited 13 days ago
                           created from /compose/docker-compose.yml
    nova-orchestrator-1    service orchestrator  exited 13 days ago
    …
  volumes mounted by those containers (4)
    nova_pgdata            1.4 GB
    nova_postgres-data     220 MB
    nova_redis-data        12 MB
    nova_redis_data        4 MB

  this install's own volumes, which will NOT be touched (6)
    nova_v4_pgdata  nova_v4_memdata  nova_v4_workspace
    nova_v4_models  nova_v4_ollama   nova_v4_tailscale

Nothing has been changed.

Deleting the 10 containers and the 4 volumes above DESTROYS their data
permanently. There is no undo. To do it, type the word  delete  and press
enter. Anything else, including a blank line, does nothing.

delete >
```

Sizes come from one `docker system df -v` read; a volume whose size cannot be
read prints `size unknown` rather than a guess.

### The offer, bounded

- TTY only, through the existing `have_tty` and `prompt_value`
  (`deploy/install.sh:500-518`). Not a TTY → print the block, exit 1, and give
  the exact interactive command to re-run. There is no `--yes` flag and no
  `NOVA_ASSUME_DELETE` variable: an unattended run must never delete data.
- The answer must be the literal word `delete`. Not `y`, not `Y`, not the empty
  default — a boolean is one careless default away from being true.
- Deletion uses the **container ids** collected during the listing, never names
  (a name can be retaken between the listing and the delete; an id cannot), and
  the exact volume **names** printed.
- Every removal is verified: `docker inspect <id>` must then fail, and
  `docker volume inspect <name>` must then fail. A survivor is a `die` naming
  it. Nothing prints "removed" without the re-inspect.
- After a successful deletion the install **continues**, because the CANNOT it
  refused on is gone.

---

## 9. `decide_subnet` and the 172.18 collision

New bash in `deploy/install.sh` (it must run before anything is up and it writes
`.env`, which compose reads at `up` time), called from `cmd_install` after
`generate_secrets` and before `record_compose_files`, and from
`backup.sh restore` as its step 2.

`deploy/docker-compose.yml:332-334` is a hardcoded literal today
(`map-deploy-data.md` §1.5). It becomes:

```yaml
- subnet:    ${NOVA_SUBNET:-172.18.0.0/16}
  ip_range:  ${NOVA_SUBNET_RANGE:-172.18.0.0/17}
  gateway:   ${NOVA_SUBNET_GATEWAY:-172.18.0.1}
```

The defaults are today's values, so the Dell's live network is unchanged and
nothing is recreated there.

| Function | Shape | Portability |
|---|---|---|
| `ip2int` / `int2ip` | `IFS=.` read into four parts, `$(( a*16777216 + b*65536 + c*256 + d ))` | pure bash 3.2 arithmetic |
| `subnet_overlaps A/a B/b` | `max(startA,startB) <= min(endA,endB)` | pure |
| `docker_subnets_in_use` | `docker network ls -q` then `docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}'`; **excludes** this project's own `nova_default` so an adopt is not read as a collision. rc 2 when docker cannot be asked. | docker only |
| `host_routes_in_use` (#22) | `ip -4 route show` when `command -v ip`, else `netstat -rn -f inet`. A `default` line is skipped; a bare host address becomes `/32`. rc 2 when **neither** exists. | `ip` is Linux-only; `netstat -rn` is the macOS/BSD path |
| `pick_project_subnet` | candidates in order: `172.18.0.0/16` … `172.31.0.0/16`, then `10.200.0.0/16` … `10.254.0.0/16`. First with no overlap wins. | pure |
| `derive_subnet_addrs X.Y.0.0/16` (#23) | `NOVA_SUBNET_RANGE=X.Y.0.0/17`, `NOVA_SUBNET_GATEWAY=X.Y.0.1`, `NOVA_WEB_ADDR=X.Y.128.10`, `NOVA_TAILSCALE_ADDR=X.Y.128.20` — the lower /17 for the allocator, the upper half for the two fixed addresses the allocator never reaches (`deploy/docker-compose.yml:316-320`) | pure |

`decide_subnet`, in order:

1. **An existing project network is adopted.** `docker network inspect
   <project>_default` → its subnet. Verifies: it parses, and the derived
   `.128.10`/`.128.20` addresses fall **inside** it. Adopting means nothing is
   recreated, which is the whole reason to check first. A network that is **not
   a /16** makes the `.128.x` derivation wrong → `die` naming it and the
   addresses it could not derive, rather than writing addresses outside the
   network.
2. **An explicit `NOVA_SUBNET`** (env or `.env`) is never overridden. Verifies:
   it overlaps no docker subnet and no host route. A collision is `die`, naming
   the exact collider — the network's name, or the route. A set value that
   collides is an operator error worth stopping on, not a value to silently
   improve.
3. **Otherwise pick**, write all five keys with `set_env_value`
   (`deploy/install.sh:880-899` — `mktemp` + `mv`, never `sed -i`, which needs a
   mandatory empty argument on BSD), and log every candidate rejected and why.
4. If `host_routes_in_use` returned rc 2 (neither `ip` nor `netstat`),
   `decide_subnet` **refuses to pick** rather than picking blind, and says which
   two commands it looked for. Adoption (case 1) and an explicit value (case 2)
   still work, because neither needs the host route table.

**The 172.18 collision, concretely.** The mini PC's measured docker networks are
`bridge` 172.17/16, `docker_default` **172.18/16**, `jobhunter_default` 172.19/16,
`nova_nova-internal` 172.20/16, `project_nova-internal` 172.21/16
(`hub-p0-measurements.md:55`). With no `nova_default` present, case 3 runs and
rejects 172.18–172.21, landing on **172.22.0.0/16**, range `172.22.0.0/17`,
gateway `172.22.0.1`, web `172.22.128.10`, sidecar `172.22.128.20`. That is a
**prediction from a recorded measurement, not a verification** — `decide_subnet`
does not exist yet and has never run on that machine. The `install_test.sh`
fixture in §12 pins the arithmetic; only the walk pins the machine.

---

## 10. novad `repoint`

`apps/novad/main.go:40-48` gains `case "repoint": cmdRepoint(os.Args[2:])`.
Flags: `--server URL` (required), `--check` (verify and print, write nothing).

| # | Step | Verifies | On failure |
|---|---|---|---|
| 1 | `config.DefaultPaths()`, `paths.Enrolled()` (`apps/novad/internal/config/config.go:38,65`). | Enrolled. | exit 1: "not enrolled — run `novad enroll`". |
| 2 | `config.Load(paths)` (`…/config.go:100`). | Config and the ed25519 seed both read; the seed is 32 bytes. | exit 1 with the loader's own message. |
| 3 | `client.WSURL(*server)` (`apps/novad/internal/client/client.go:96-114`). | The scheme is http/https/ws/wss. | exit 1 with its message. Config untouched. |
| 4 | Dial with a 30 s timeout; read the first frame. | `frame["type"] == wire.TypeChallenge`. | exit 1 with the dial error. Config untouched. |
| 5 | Compare `frame["core_pubkey"]` to `cfg.CorePubKey`. | **Equal.** | exit 1: "that server is not the Nova you paired with (it presented `<short>`, we pinned `<short>`)". Config untouched. This is the check the verb exists for; it is the same TOFU refusal the agent already makes at `apps/novad/internal/client/client.go:182-184`. |
| 6 | Complete the handshake: sign the **raw** nonce bytes, send `auth`, read the reply. | A `ready` frame. A server with the right core key that has **forgotten this device** would pass step 5 and fail here, so the write is not made on a half-proof. | exit 1 with the server's own reason. Config untouched. |
| 7 | `--check`: print `ok`, the server and the short key; exit 0. | — | Writes nothing, by construction. |
| 8 | `cfg.Server = *server`; `config.Save(paths, cfg, priv)` (`…/config.go:78-95`, 0600 in a 0700 dir), then **re-`Load` and compare** `Server` and `CorePubKey`. | The file on disk says what we meant. | exit 1 naming the config path. |
| 9 | Print the new server and `systemctl --user restart novad`. | — | It **never** claims the daemon reconnected. That is `novad status`'s job, and status already refuses to call a reachability probe "connected" (`apps/novad/main.go:233-240`). |

---

## 11. The full test list

"Live" means a running v4 stack or a docker daemon; everything else runs with no
docker and no network, stubbing only the seams that touch the outside world —
the pattern `deploy/install_test.sh:1-11` already establishes.

### A. Python, `deploy/backup/tests/` — `pytest`, no live stack

| # | Test | Pins |
|---|---|---|
| 1 | `test_crypto.py::test_round_trip_small` | 1 KiB plaintext survives encrypt→decrypt byte for byte |
| 2 | `::test_round_trip_multi_chunk` | 9 MiB at a 4 MiB chunk: three frames, and the tail frame is short |
| 3 | `::test_exact_multiple_last_chunk_is_final` | 8 MiB exactly — `final` decided by `done >= size`, not by a short read. The bug a naive test cannot see. |
| 4 | `::test_truncated_payload_raises` | dropping the last frame **raises**, never returns a shorter archive |
| 5 | `::test_reordered_frames_raise` | frames 0 and 1 swapped fail the AAD position binding |
| 6 | `::test_tampered_header_raises` | one flipped byte in the header JSON |
| 7 | `::test_bad_decrypt_sentence_is_identical_in_library_and_pyz` | the wrong-passphrase/corrupt sentence, character for character, in both sources |
| 8 | `::test_kdf_cost_cap_refuses_before_allocating` | a header with `n=2**22` raises `CryptoError`, not `MemoryError`, and no 4 GB allocation is attempted |
| 9 | `::test_pyz_reader_matches_library_writer` | builds the zipapp, decrypts a library-written payload in a **subprocess**. This is the pin v3's docstring claimed and this design owes. Parameterised over `NOVA_FORCE_CTYPES_GCM` ∈ {0,1} so the libcrypto path is exercised, and asserts the forcing worked. |
| 10 | `test_coverage.py::test_every_compose_volume_has_a_policy` | **both directions** against `deploy/docker-compose.yml`. Red the day a volume is added or removed. The S41 tripwire. |
| 11 | `::test_every_policy_key_names_a_real_volume` | the other direction, as its own failure |
| 12 | `::test_unclassified_volume_refuses` | a fixture compose with `v4_newthing`: `may_backup is False`, and the message names the volume, the service that mounts it, and `VOLUME_POLICY["v4_newthing"]` |
| 13 | `::test_unclassified_volume_is_never_skipped` | the member list is empty **and** an exception is raised — refuse, not skip (#4) |
| 14 | `::test_profile_gap_refuses` | a resolved config missing `tailscale` while the raw YAML declares it → `R0_PROFILE_GAP`. Pins the measurement in §4. |
| 15 | `::test_anonymous_volume_keyed_by_service_and_target` | a 64-hex name in the live list is keyed by `(service, target)`, and refuses with no `ANON_POLICY` entry |
| 16 | `::test_move_only_volume_included_only_in_move_mode` | `v4_tailscale` |
| 17 | `::test_external_volume_needs_its_own_policy_key` | `external: true` keeps its own name and is keyed `external:<name>` |
| 18 | `::test_bind_with_unexpanded_variable_refuses` | a `source` containing `${` → `R3_INTERPOLATION` |
| 19 | `::test_scan_roots_are_derived_from_bind_sources` | a fixture whose bind is `../otherdata` makes `otherdata` a scan root — no hardcoded `data` |
| 20 | `::test_unclassified_host_file_refuses` | `data/mystery.db` in a fixture tree |
| 21 | `::test_unreachable_include_refuses` | an INCLUDE volume that does not exist → `R2_UNREACHABLE` |
| 22 | `test_manifest.py::test_required_fields_and_types` | every key in §3 and its Python type; an unknown top-level key is an error |
| 23 | `::test_manifest_is_the_first_inner_member` | the ordering (the 3.4 s listing incident) |
| 24 | `::test_manifest_carries_no_secret_value` | no value anywhere in the manifest equals any value in the fixture `.env`; `files[].keys` holds only key **names**; `identity.core_signing_key_sha256` is 64 hex and is not the key |
| 25 | `::test_bundle_version_2_refuses_a_v1_manifest` | a v3 bundle is refused by name |
| 26 | `test_passphrase.py::test_env_resolver` / `::test_file_resolver` / `::test_prompt_resolver_requires_retype` | each resolver's happy path |
| 27 | `::test_file_resolver_refuses_group_readable` | mode `0640` refuses and names the observed mode |
| 28 | `::test_unknown_source_raises_passphrase_unavailable` | never a bare exception |
| 29 | `::test_no_passphrase_means_no_bundle` | `backup` raises before any writer is stopped |
| 30 | `::test_fingerprint_is_twelve_hex_and_is_not_the_passphrase` | |
| 31 | `test_safe_extract.py` ×4 | absolute member, `..` member, symlink member, device node — each refused |
| 32 | `test_verbs.py::test_backup_refuses_when_a_writer_did_not_stop` | fake docker: `Running` stays true |
| 33 | `::test_backup_refuses_when_a_writer_was_already_dead` | `FinishedAt` older than the stop request — "we stopped it" must be a fact |
| 34 | `::test_backup_refuses_on_empty_pg_dump_output` | |
| 35 | `::test_backup_refuses_when_the_dump_lacks_PGDMP` | a plausible short file is still a failure |
| 36 | `::test_backup_refuses_when_selftest_counts_differ` | a count mismatch writes **no** bundle |
| 37 | `::test_backup_refuses_when_selftest_md5s_differ` | same, for md5 |
| 38 | `::test_backup_deletes_the_part_on_every_refusal` | parameterised over steps 12–16: no `.part` is ever left looking finished |
| 39 | `::test_backup_does_not_clobber_a_same_second_bundle` | the `-2` collision loop |
| 40 | `::test_backup_refuses_a_dir_that_cannot_hold_0600` | the mode probe, with a fake stat returning `0644` (#26) |
| 41 | `::test_backup_restarts_what_it_stopped_when_a_later_step_fails` | routine mode leaves the stack up |
| 42 | `::test_backup_exits_4_when_the_bundle_is_good_but_a_service_is_unhealthy` | the "partial" code; never 0 |
| 43 | `::test_restore_refuses_a_non_empty_volume` | (#14) |
| 44 | `::test_restore_refuses_an_existing_nova_container` | including an exited one |
| 45 | `::test_restore_refuses_an_older_pg_restore_major` | 15 vs a 16 dump (#14) |
| 46 | `::test_restore_accepts_a_newer_pg_restore_major` | the refusal is one-directional |
| 47 | `::test_restore_refuses_a_missing_migration_and_names_the_source_sha` | |
| 48 | `::test_restore_refuses_a_conflicting_env_key_without_printing_values` | the message contains the key and neither value |
| 49 | `::test_restore_writes_env_0600_and_restats_it` | |
| 50 | `::test_restore_pg_restore_argv_has_single_transaction_and_exit_on_error` | (#15) — asserted against the recorded argv |
| 51 | `::test_restore_does_not_print_restored_when_an_md5_differs` | the sentence that must not appear |
| 52 | `::test_restore_does_not_print_restored_when_a_volume_listing_differs` | |
| 53 | `::test_restore_does_not_print_restored_when_the_key_fingerprint_differs` | (#16) |
| 54 | `::test_restore_prints_no_next_steps_on_a_hash_mismatch` | hard stop, and the temp tree is removed |
| 55 | `::test_scratch_name_asserted_before_create_restore_and_drop` | three call sites, each independently |
| 56 | `::test_scratch_db_is_dropped_when_the_selftest_raises` | the `finally` |
| 57 | `::test_drill_with_no_bundle_fails` | not a vacuous pass |
| 58 | `::test_drill_name_asserted_before_every_create_and_delete` | |
| 59 | `::test_drill_touches_nothing_named_nova_underscore` | the recorded argv never contains a `nova_*` object except read-only reads |
| 60 | `::test_drill_fails_when_a_teardown_removal_cannot_be_confirmed` | a leak is reported, not swallowed |
| 61 | `::test_drill_reports_a_stale_passphrase_fingerprint_as_a_warning_not_a_failure` | |
| 62 | `::test_move_includes_v4_tailscale_and_routine_does_not` | |
| 63 | `::test_move_writes_the_marker_and_restarts_nothing` | |
| 64 | `::test_undo_move_states_it_could_not_check_when_no_tailscale_cli` | the sentence is present, and the marker is **still removed** — no approval gate |
| 65 | `::test_undo_move_exits_0_when_there_is_no_marker` | the postcondition holds |
| 66 | `::test_undo_move_verifies_the_marker_is_gone` | |
| 67 | `test_scope.py::test_s41_adds_no_tool_module` | no new file under `services/*/app/tools/` (#30) |
| 68 | `test_scope.py::test_s41_adds_no_migration` | no new file under `services/*/migrations/` (#31) |

### B. Shell — bash 3.2, no docker

`deploy/backup_test.sh` (new): `docker`, `stat`, `sha256sum`, `shasum`, `ip`,
`netstat` all stubbed as shell functions; PASS/FAIL counter per
`deploy/install_test.sh:19-27`; exit code is the signal.

| # | Test | Pins |
|---|---|---|
| 69 | `wrapper refuses when docker is absent, naming the endpoint` | exit 2 |
| 70 | `wrapper builds and uses the id that build printed` | never a floating tag |
| 71 | `wrapper refuses when docker build fails` | |
| 72 | `sha256_of falls back from sha256sum to shasum -a 256` | both stubs produce the same hash for one fixture (#21) |
| 73 | `mode probe refuses a dir where 0600 does not stick` | driven with both the GNU `stat -c '%a'` and BSD `stat -f '%Lp'` stubs, the pair already used at `deploy/install_test.sh:266,317` |
| 74 | `the compose config temp file is 0600 and removed on exit` | including on a failing exit |
| 75 | `no passphrase value appears in any recorded docker argv` | `--env NAME` only |
| 76 | `restore calls decide_subnet before any compose command` | asserted on call **order**, not presence (#12) |
| 77 | `backup.sh sources cleanly and defines its functions without running main` | the guarded entry point |

`deploy/install_test.sh` (additions):

| # | Test | Pins |
|---|---|---|
| 78 | `ip2int / int2ip round trip` | |
| 79 | `subnet_overlaps: adjacent /16s do not; a /17 inside a /16 does; identical do` | |
| 80 | `host_routes_in_use parses ip -4 route` / `81 … parses netstat -rn` | (#22), both stubbed |
| 82 | `host_routes_in_use returns 2 when neither exists, and decide_subnet then refuses to pick` | |
| 83 | `decide_subnet picks 172.22 when 172.17–172.21 are in use` | the mini PC fixture |
| 84 | `decide_subnet adopts an existing nova_default and writes nothing` | |
| 85 | `decide_subnet refuses to derive .128.x from an adopted /24` | |
| 86 | `decide_subnet dies naming the collider when NOVA_SUBNET is set and collides` | |
| 87 | `derive_subnet_addrs from 172.22.0.0/16` | all five keys (#23) |
| 88 | `foreign_project_containers names a container created from another config_files` | fixture labels |
| 89 | `a container with an EMPTY config_files label is foreign` | unlabelled cannot be proven ours |
| 90 | `foreign_project_volumes derives only from the containers already named` | |
| 91 | **`no v4 volume ever enters the deletion set`** | fixture with all four old and all six `nova_v4_*` volumes present — **ruling 1's required test** |
| 92 | **`the delete path issues no command naming a v4 volume`** | a recording stub: the argv of every `docker volume rm`. The listing being right and the command being right are two assertions, because they are two mechanisms (filter, then assert). |
| 93 | `a foreign container that MOUNTS a v4 volume still does not put it in the set` | the case the "ours wins" rule exists for |
| 94 | `no TTY: it prints the block, exits 1, and offers nothing` | |
| 95 | `an answer that is not the literal word delete removes nothing` | `y`, `Y`, `yes`, blank |
| 96 | `deletion uses container IDs, not names` | |
| 97 | `a survivor after removal is a die naming it` | never "removed" without the re-inspect |
| 98 | `refuse_if_moved refuses while deploy/tailscale/MOVED_TO exists` | (#18) |

`deploy/tailscale/start_test.sh` (addition):

| # | Test | Pins |
|---|---|---|
| 99 | `start.sh exits non-zero and prints the marker before containerboot when /config/MOVED_TO exists` | the sidecar refusal (#18), in POSIX `sh` |

### C. Go — `apps/novad/main_test.go`

| # | Test | Pins |
|---|---|---|
| 100 | `TestRepointSavesWhenTheCoreKeyMatches` | config re-loads with the new server |
| 101 | `TestRepointRefusesADifferentCoreKey` | non-zero exit **and the config file is byte-identical afterwards** |
| 102 | `TestRepointCheckWritesNothing` | `--check` with the pinned key |
| 103 | `TestRepointLeavesConfigUntouchedWhenTheServerIsUnreachable` | |
| 104 | `TestRepointRefusesWhenTheServerForgetsThisDevice` | handshake completes to `auth` and fails there (step 6) |

### D. Live — needs docker, not in the default suite

| # | Test | Pins |
|---|---|---|
| 105 | `tests/e2e/test_backup_roundtrip.py` (marked `live`) | back up the real stack, `restore --drill` the result; assert every table's count and md5 and the signing-key fingerprint equal, and assert **no `nova-drill-*` container, volume or network survives**. This is the DoD walk (#28), automated. |
| 106 | `…::test_backup_refuses_when_a_new_volume_is_added` (marked `live`) | add a throwaway volume to a copy of the compose file and run coverage against a live daemon — pins that the refusal is real and not only a fixture behaviour |

### E. CI (`.github/workflows/rebuild-ci.yml`)

Two new jobs. **Standing caveat**: the workflow triggers only on `rebuild/**`
(`.github/workflows/rebuild-ci.yml:3-7`) and the owner's 2026-09-07 decision was
"CI and hooks OFF for now". These jobs are therefore **written and committed but
not enabled**; adding `slice/**`/`main` to the trigger is a one-line change and
is his call, not this design's. Open question 3, §15.

```yaml
  backup-linux:                      # ubuntu-latest
    - bash -n deploy/backup.sh deploy/backup_test.sh
    - shellcheck -S warning deploy/backup.sh deploy/backup_test.sh
    - ./deploy/backup_test.sh
    - uv run --directory deploy/backup pytest -m "not live"
    - docker build -q deploy/backup          # proves both pinned digests resolve

  backup-macos:                      # macos-15  (#27)
    - /bin/bash --version | head -1          # states the version; 3.2 is the target
    - /bin/bash -n deploy/install.sh deploy/install_test.sh deploy/backup.sh deploy/backup_test.sh
    - /bin/bash ./deploy/install_test.sh
    - /bin/bash ./deploy/backup_test.sh
    - python3 -m pytest deploy/backup/tests -m "not live"
    - NOVA_FORCE_CTYPES_GCM=1 python3 -m pytest deploy/backup/tests/test_crypto.py::test_pyz_reader_matches_library_writer
```

The macOS job earns its place twice: it is the only thing that runs the shipped
scripts under a real bash 3.2 (`ubuntu-latest` runs GNU bash 5.x, so the
discipline stated at `deploy/install.sh:7` is enforced by code review today and
nothing else — `map-portability.md` §6), and its last line is the **only**
measurement anywhere of `restore.pyz`'s ctypes-libcrypto path against a real
Homebrew OpenSSL, which §5 flags as unverified. Whether `docker` is usable on
GitHub's hosted macOS runners is unverified here, so neither macOS step needs it.

---

## 12. Exactly what I am NOT building, and why

| Not built | Why |
|---|---|
| **A secrets store** (Proposal A: `{{secret:name}}`, an encrypted store, 1Password/Bitwarden resolvers) | `rulings.md:48-49`: only the passphrase **resolver seam** lands in S41. The seam is a dict; the store is a slice. |
| **`BACKUP_EXCLUDE_DATA`** | `rulings.md:44-46`. Coverage is derived from the compose file and refuses. §4 explains why `VOLUME_POLICY` is not the same thing. |
| **Any chat tool, guard, narration kind, capability phrase, action class, eval case or `live_facts` entry** | #30 and `rulings.md:68-72`: S41 is operator tooling; the move's chat walk is S45. `test_tools_registry`'s pinned set and `test_eval_corpus`'s `suite_version` must not move. |
| **Any migration in any service** | #31. Consequence, stated not hidden: `schema_migrations` still has no `checksum` column (`services/core/app/migrations_runner.py:19-24`), so the restore migration gate is **filename-only** and a renumbered migration reads as missing. v3 hit exactly that bug. Carry for whichever slice next touches the shared runner. |
| **Scheduling the weekly drill** | #5 builds the verb; the schedule "may land later". `services/core/app/scheduler.py` exists but is a chat-turn timer mechanism, not a mechanical-handler one, and wiring it is a design of its own. |
| **A restore over a live system** (v3's `apply_bundle`) | v4's restore targets an **empty** machine only (#14). That removes, deliberately, the pre-restore safety snapshot, the `ALTER DATABASE … RENAME` swap and the `.pre-restore-<stamp>` aside-directories. Consequence: **a bad restore cannot be rolled back in place** — you restore the previous bundle onto a fresh target. That is the right trade for the slice whose job is "spin Nova up on a different machine", and the wrong one for "undo what I just did to this one". |
| **Offsite copy, retention/pruning, a `backup_attempts` table, a freshness verdict, the off-machine-recording nag** | None is in S41's 33 requirements; each depends on v4 tables that do not exist (`map-v3-backup.md` §6.9). |
| **Any HTTP route, UI surface or `settings` key** | Nothing in v4 reads a `backups.*` setting, and adding one means `SETTING_DEFS` and `test_settings.py`'s `KNOWN_KEYS`. Configuration is CLI flags and `.env` in this slice. |
| **Carrying `v4_pgdata`, `v4_ollama` or `v4_models` as files** | Dispositions, not omissions: each appears in `MANIFEST.excluded` with its reason. A restore that cannot say what it is missing invites the operator to assume it is missing nothing. |
| **Special handling for `network_credentials`** | The table does not exist until S43a. Database coverage is schema-driven, so it is carried the day it exists — and the four lines that still say otherwise are corrected by this slice (§2). |
| **A `--yes` / `NOVA_ASSUME_DELETE` path for the foreign-project deletion** | An unattended run must never destroy data. TTY only, the literal word `delete`, default nothing. |
| **A real Docker Desktop walk on macOS** | The macOS CI leg is bash-3.2 + no-docker tests. Whether `docker` works on hosted macOS runners is unverified (`map-portability.md` §6), and D20 already scopes macOS as "CI only". |
| **A `sha256`/`md5` host binary in the tool's hot path** | Host-side `sha256_of` exists only in the wrapper, for the operator's own `scp` check. Every hash that a decision rests on is computed by Python's `hashlib` or by Postgres's own `md5()` inside the container, so GNU-vs-BSD divergence cannot reach a verdict. |

---

## 13. Risks, ranked, each with the cheapest measurement that settles it

**1. The per-table md5 is not stable across postgres minors or session settings.**
The entire DoD — "counts, md5s and the key fingerprint are equal" (#28) — rests
on `md5(string_agg(t::text,'' ORDER BY t::text))`, and `t::text` renders
timestamps, intervals, floats, bytea and numerics through session GUCs. §7.1/8
pins six of them, but a *minor version* that changes a type's text output would
make every drill fail with no real difference. The Dell and the mini PC both
float on `postgres:16` (`deploy/docker-compose.yml:5` is a major-only pin) and
their minors have never been compared (open question #6).
**Cheapest measurement**: on the Dell, run the pinned-session md5 for
`nova_core.public.turn_spans` against the running container, then again inside a
freshly pulled `postgres:16` throwaway with the same dump restored, and compare
one string. Two commands, five minutes. If they differ, fall back to a
column-wise digest (`md5(string_agg(md5(col::text), '' ORDER BY pk))`) or to
counts plus a `pg_dump` byte hash, and say so in the manifest's `session` block.
*This is the measurement to take before writing a line of code.*

**2. The bootstrap: the tool image cannot be built on the restore target.**
The whole design leans on "the pyz needs only python3 + docker". If the mini
PC's stock `python3` lacks `hashlib.scrypt` (a Python built without OpenSSL) or
is older than 3.9, restore falls back to the image, and if the image cannot
build there, restore is impossible at the moment it is needed.
**Cheapest measurement**: on the mini PC, two one-liners —
`python3 -V` and `python3 -c "import hashlib;hashlib.scrypt(b'a',salt=b'b'*16,n=16384,r=8,p=1,dklen=32);print('ok')"` —
plus `docker build -q deploy/backup` once, timed. Ten minutes, and it settles
risk 2 and half of risk 6.

**3. Passphrase loss is total, unrecoverable data loss.** This is a certainty
under the design, not a probability: no store, no escrow, no recovery. The only
mitigations are the generate-and-retype transcription check and the drill's
stale-fingerprint warning.
**Cheapest measurement**: none — it is a decision, not an unknown. It needs the
owner's answer to open question 1, and the cheapest *de-risking* is to make the
first routine backup on the Dell with a passphrase he has already written into
his password manager, before any bundle exists that he could lose.

**4. `docker compose config --format json` shape drift between the two machines.**
The coverage algorithm reads `services[].volumes[].type/source/target` and
`volumes[].name` — all measured **[M]** here against compose v5.3.0. The mini PC
runs v5.5.1 (`hub-p0-measurements.md`), and `--profile '*'` is load-bearing
(§4). A shape change there silently narrows coverage.
**Cheapest measurement**: run the two commands from §4 on the mini PC and diff
the printed key sets against this document. One minute. (The `R0_PROFILE_GAP`
check in §4 step 2 is the code that catches this at runtime, so this is
confirmation rather than the only defence.)

**5. Bundle size versus the mini PC's disk and the backup's own free-space
check.** `v4_memdata` + `v4_workspace` + three dumps, doubled by the staging
tree and the `.part`. The mini PC has 351 GB free, so this is almost certainly
fine — but the estimate that step 5 of `backup` gates on is currently a guess.
**Cheapest measurement**: `docker system df -v` on the Dell and read the three
volume sizes. Thirty seconds.

**6. `restore.pyz`'s macOS ctypes-libcrypto path is unverified.** Two hardcoded
Homebrew paths, carried from v3, never run against a current Homebrew by me.
**Cheapest measurement**: test 9 on the `macos-15` CI job with
`NOVA_FORCE_CTYPES_GCM=1`. Free, once the job exists — which is why that job
earns its keep beyond bash 3.2.

**7. Coverage's host-file scan is not git-aware.** §4 step 7 walks the derived
scan roots and refuses on an unclassified regular file, which catches a new file
under `deploy/` or `data/`. It does **not** know what git tracks, so a
newly-tracked code file also refuses (noisy but safe), and a gitignored file
outside the scan roots is invisible (silent, and not safe). v3 used git for this
(its `R5_UNCOVERED_HOST_STATE`).
**Cheapest measurement**: `git -C <repo> status --porcelain --ignored` on the
Dell, filtered to paths outside `deploy/` and `data/`, and check whether any of
them is state rather than build output. If the answer is "none", the scan roots
are sufficient and this risk closes; if not, a CI-side test comparing
`git check-ignore` output against `PATH_POLICY` is the cheap fix (git is free in
CI, and keeps the runtime git-free).

**8. The docker socket in a container is real privilege.** `nova-backup` runs
`--rm`, publishes nothing, is not in the compose file, is never started by the
stack and is never reachable by Nova — but a mounted socket is root on the host.
**Cheapest measurement**: `grep -rn "nova-backup" deploy/docker-compose.yml
services/` must return nothing, as a test (test 67's neighbour). The bound is
structural: the image is only ever launched by the operator's own shell.

**9. The mini PC's postgres minor is unmeasured** (#6, still open). Subsumed by
risk 1's measurement, which touches both containers anyway.

**10. `decide_subnet` has never run on the mini PC.** §9 predicts 172.22.0.0/16
from a recorded network list. The prediction could be stale — a new network may
have appeared since.
**Cheapest measurement**: `docker network inspect $(docker network ls -q) |
grep -o '172\.[0-9]*\.' | sort -u` on the mini PC, re-run on the day of the
move rather than trusting the P0 table.

---

## 14. Open questions for the owner

Three, each stated because it is his to settle and not mine
(`owner-choice-needs-a-question`).

1. **Where does the backup passphrase live?** The design ships `env`, `file` and
   `prompt`, with no store and no escrow (§6). The intended answer is a password
   manager feeding `$NOVA_BACKUP_PASSPHRASE`. If he wants Nova to hold it, that
   is Proposal A and it is not in this slice — but the first bundle is written
   before Proposal A exists, so the answer is needed now, not later.
2. **`eval_runs` / `eval_suite_runs`: carried or not?** They are pure
   measurement history in `nova_core` — nothing live reads them to decide
   anything (`map-deploy-data.md` §4.2). Database coverage is schema-driven, so
   today they are carried automatically and a bundle is that much larger. If he
   would rather they were dropped, that is an explicit `EXCLUDE_DECLINED` on a
   table rather than a volume, which is a coverage mechanism this design does
   not build.
3. **Should the CI workflow be enabled for `slice/**` and `main`?** #27 requires
   `install_test.sh` and `backup_test.sh` on `macos-15`, but `rebuild-ci.yml`
   triggers only on `rebuild/**` and the 2026-09-07 decision was CI off. The
   jobs are written either way; turning them on is a one-line trigger change and
   his call.
