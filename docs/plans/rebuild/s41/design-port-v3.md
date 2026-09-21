# S41 design — the encrypted bundle, ported from v3 to v4's stack

Written 2026-09-21 on `slice/s41`. Binding inputs, read first and not
re-argued here: [`rulings.md`](rulings.md), [`map-requirements.md`](map-requirements.md),
[`map-v3-backup.md`](map-v3-backup.md), [`map-deploy-data.md`](map-deploy-data.md),
[`map-portability.md`](map-portability.md).

Every claim about this repo carries `path:line`. Claims marked **measured**
were produced by a read-only command run in this worktree on 2026-09-21 and
the command is given. Claims marked **unverified** were not checked and say
why.

---

## 1. Architecture

```
                         ./install  (root wrapper, install:13-21)
                                │
                     deploy/install.sh  main()  (install.sh:1130-1137)
                     ├── install            (existing)
                     ├── backup [--move]  ─┐
                     ├── restore <bundle> [--drill]  ├─ sourced from
                     ├── drill             │         deploy/backup.sh
                     └── undo-move        ─┘         (bash 3.2, no JSON)
                                │
        ┌───────────────────────┼────────────────────────┐
        │ HOST, via docker CLI  │                        │ HOST, via python3
        │                       │                        │
  render FACTS            throwaway containers      deploy/backup/
  compose config --json   ├ postgres:  pg_dump -Fc  nova_restore.py
  docker ps -a/inspect    ├ postgres:  pg_restore   (stdlib + ctypes
  docker volume ls        ├ postgres:  tar volumes   libcrypto; the
  git check-ignore        └ core image: python ────┐ SAME file that
  ip route / netstat                              │ travels inside
        │                                         │ every bundle)
        └──────────► $STAGE/facts/*.json ─────────┤
                                                  ▼
                                    deploy/backup/nova_bundle.py
                                    coverage → manifest → tar.gz
                                    → NOVAENC1 encrypt → outer tar
                                    → full round-trip verify
                                                  │
                                                  ▼
                            nova-backup-<host>-<stamp>[-N].tar   (0600)
```

Five sentences. **`deploy/backup.sh` owns every side effect** — it is the only
thing that calls `docker`, writes `.env`, or touches the host — and it is
bash 3.2 so it runs on macOS's `/bin/bash` unchanged. **The Python never
shells out**: `backup.sh` renders every fact it needs (compose config, docker
inspect, git status, route tables, readability probes) into JSON files under a
staging directory, and `nova_bundle.py` consumes those files, which is why the
backup writer can run inside a throwaway container of the already-built core
image without ever holding the docker socket. **The writer and the reader are
two files on purpose**: `nova_bundle.py` needs the `cryptography` package
(already in the core image — `services/core/pyproject.toml:11`), while
`nova_restore.py` must open a bundle on a machine with no stack, no images and
no `.env`, so it carries a stdlib+ctypes fallback and is copied byte-identical
into every bundle. **Coverage is derived, not listed**: the set of things a
bundle must carry is computed from the compose file, the live container
mounts, the volume labels and git's own opinion of every bind, and anything
that cannot be classified stops the backup with a named refusal. **Nothing is
renamed into place until a full decrypt-and-re-hash round trip of the written
file has passed.**

### Why the writer runs in a container and the reader runs on the host

Backup happens on a machine whose stack is up, so the core image exists and
carries `cryptography`; running the writer there means backup needs **no host
Python at all** on Linux or macOS. Restore happens on a machine that has
nothing yet — the bundle contains `deploy/.env`, so the stack cannot start
before the bundle is open (v3 states this at `scripts/nova_restore.py:9-12`).
So restore uses the host's `python3` and refuses, in words, when there is none.
That refusal is a "cannot", not a "may not".

---

## 2. Every file created or modified

### New

| Path | Responsibility |
|---|---|
| `deploy/backup.sh` | The four verbs as bash 3.2 functions (`cmd_backup`, `cmd_restore`, `cmd_drill`, `cmd_undo_move`), the docker orchestration, the fact renderers, `sha256_of`, `mode_probe`, the scratch/drill name assertions. Sourced by `install.sh`; has its own `BASH_SOURCE` guard so `backup_test.sh` can source it. |
| `deploy/backup_test.sh` | Shell suite, `#!/usr/bin/env bash` + `set -uo pipefail` (the harness shape at `deploy/install_test.sh:1,13`, deliberately no `-e`). Stubs `docker`, `git`, `ip`, `netstat`, `stat`, `python3`. No docker, no network. |
| `deploy/backup/nova_bundle.py` | The writer: coverage classification, MANIFEST, inner tar, NOVAENC1 encrypt, outer tar, verify, full round trip. Reads facts, never shells out. |
| `deploy/backup/nova_restore.py` | The reader: NOVAENC1 decrypt (prefers `cryptography`, falls back to ctypes libcrypto), inner-archive verify, `restore_to` layout, printed next steps. Standalone — no imports from anything else in this repo. **This exact file is a member of every bundle.** |
| `deploy/backup/policy.py` | `VOLUME_POLICY`, `PATH_POLICY`, `ANON_POLICY`, `SEGMENT_POLICY` — the four hand-maintained tables, each row carrying a written reason. Imported by `nova_bundle.py`. |
| `deploy/backup/pyproject.toml` | So the Python suite has a home CI can run (`uv run --project deploy/backup pytest`). Dependency: `cryptography` (test-only for the writer path). |
| `deploy/backup/tests/*.py` | §10. |
| `deploy/backup/fixtures/compose-v4.json` | `docker compose ... --profile inference --profile tailnet config --format json` for this repo, checked in. The coverage suite's fixture and the drift alarm. |
| `apps/novad/repoint.go`, `apps/novad/repoint_test.go` | The `repoint` verb. |

### Modified

| Path | Change |
|---|---|
| `deploy/install.sh` | `main` gains `backup`, `restore`, `drill`, `undo-move` (`:1130-1137`). New: `decide_subnet`, `docker_subnets_in_use`, `host_routes_in_use`, `subnet_overlaps`, `ip_to_int`, `pick_project_subnet`, `derive_subnet_addrs`, `config_volume_keys`, `config_service_keys`, `check_foreign_project`, `foreign_containers`, `foreign_volumes`, `delete_foreign_project`, `refuse_if_moved`. `cmd_install` calls `refuse_if_moved` first and `check_foreign_project` inside `preflight`; `decide_subnet` runs right after `generate_secrets` and before `record_compose_files`. |
| `deploy/docker-compose.yml` | `:332-334` become `${NOVA_SUBNET:-172.18.0.0/16}`, `${NOVA_SUBNET_RANGE:-172.18.0.0/17}`, `${NOVA_SUBNET_GATEWAY:-172.18.0.1}`. Defaults are the literals that are there today, so the Dell's live network is unchanged by the edit. Nothing else moves. |
| `deploy/.env.example` | Documents `NOVA_SUBNET`, `NOVA_SUBNET_RANGE`, `NOVA_SUBNET_GATEWAY` beside the existing `NOVA_WEB_ADDR`/`NOVA_TAILSCALE_ADDR` block (`.env.example:22-33`), and `NOVA_BACKUP_PASSPHRASE_SOURCE` / `NOVA_BACKUP_PASSPHRASE_FILE`. |
| `deploy/tailscale/start.sh` | `refuse_if_moved` at the top: `/var/lib/tailscale/MOVED_TO` present → log `this node moved to <contents>` and exit 1 before containerboot starts. POSIX sh (the file is `#!/bin/sh`, Alpine). |
| `deploy/tailscale/start_test.sh` | Two cases for the above. |
| `deploy/install_test.sh` | The foreign-project and subnet cases (§8, §9). |
| `deploy/README.md` | New `## Backup`, `## Restore`, `## Moving Nova to another host` sections; the "Migrating an existing node" procedure (`:203-230`) now points at `backup --move`. |
| `apps/novad/main.go` | `case "repoint"` in the switch (`:40-52`) and a line in `usage()` (`:55-64`). |
| `.github/workflows/rebuild-ci.yml` | Trigger extended to `main` and `slice/**` (measured: it fires on `rebuild/**` only, `:3-7`, so nothing in this slice would run in CI as things stand). `installer` job lints and runs `backup_test.sh`. Two new jobs: `backup` (ubuntu) and `backup-macos` (`macos-15`). |
| `docs/plans/rebuild/hub-topology.md`, `docs/plans/rebuild/hub/r2-integration.md` | Correct the now-wrong "backups exclude `network_credentials`" text at `hub-topology.md:135,411` and `hub/r2-integration.md:61,550`, per `rulings.md:60-67`. |

---

## 3. The bundle format

### 3.1 Layout

Two nested archives, ported unchanged in shape from v3
(`backend/app/backup_snapshot.py:293-311,357-361`).

**Outer** — plain **uncompressed** tar, `nova-backup-<host>-<stamp>[-N].tar`,
mode 0600. Uncompressed because its payload is AES-GCM ciphertext
(incompressible) and its other members are tiny. Member order is fixed:

| # | member | cleartext | purpose |
|---|---|---|---|
| 1 | `README.txt` | yes | one paragraph for whoever finds the file: what it is, that it is encrypted, and the exact `python3 nova_restore.py` line. |
| 2 | `nova_restore.py` | yes | the standalone reader, byte-identical to `deploy/backup/nova_restore.py` in git. |
| 3 | `meta.json` | yes, **unauthenticated** | advisory listing facts so a bundle can be identified without the passphrase. **Nothing in it ever decides a restore.** |
| 4 | `payload.enc` | no | NOVAENC1 over the inner archive. |

**Inner** — `tar.gz`, member order forced so the manifest is **first** (gzip
cannot seek; v3 measured 3.4s of pointless decompression on a 167 MB bundle
before forcing this, `backup_snapshot.py:298-305`):

```
MANIFEST.json
db/nova_core.dump           pg_dump -Fc
db/nova_gateway.dump
db/nova_memory.dump
volumes/v4_memdata.tar      tar --numeric-owner, built in a container
volumes/v4_memdata.listing  "<sha256>  <relpath>", LC_ALL=C sorted
volumes/v4_workspace.tar
volumes/v4_workspace.listing
volumes/v4_tailscale.tar    --move only
volumes/v4_tailscale.listing
files/deploy/.env
```

Three `db/` members, not v3's single `db.sql`: v4's one postgres container
serves three databases with one role each
(`deploy/postgres-init/01-databases.sql:13-20`).

### 3.2 `MANIFEST.json` — exact fields and types

JSON, not v3's line-oriented text and not r1's TSV sketch
(`hub/r1-hubmove-design.md:70-80`). **Ruling, mine:** the manifest lives inside
the encrypted payload, so no shell can read it without the passphrase anyway;
its only readers are `nova_bundle.py` and `nova_restore.py`, both Python. A
TSV format bought portability to a bash reader that cannot exist. Cost if
wrong: an operator with only `jq` on a recovered disk still reads
`meta.json` (cleartext JSON) and still runs `nova_restore.py`; nothing is
lost but a format preference.

```jsonc
{
  "bundle_version": 1,                          // int. Bumped only by a breaking change.
  "format": "nova-backup/2",                    // str. /2 = encrypted, three databases.
  "created_at": "20260921T143002Z",             // str, %Y%m%dT%H%M%SZ, UTC. Also the filename stamp.
  "mode": "routine",                            // str, one of "routine" | "move".
  "transport": "local",                         // str, one of "local" | "usb" | "offsite". r2's added field.
  "source": {
    "host": "dell-xps-8950",                    // str, os.uname().nodename
    "repo_sha": "12ea01bf…",                    // str, 40 hex, or "" when git could not be read
    "repo_dirty": true,                         // bool
    "compose_project": "nova",                  // str, from compose config `name`
    "compose_files": ["/abs/deploy/docker-compose.yml", "…gpu.yml"],  // list[str], absolute, in -f order
    "profiles": ["inference", "tailnet"]        // list[str], every profile rendered
  },
  "postgres": {
    "server_version": "16.10",                  // str, SHOW server_version
    "server_version_num": 160010,               // int, SHOW server_version_num
    "pg_dump_major": 16                         // int, from the container's own pg_dump --version
  },
  "databases": [{
    "name": "nova_core",                        // str
    "role": "core",                             // str, the owning role (postgres-init/01-databases.sql)
    "member": "db/nova_core.dump",              // str
    "migrations": ["001_init.sql", "…"],        // list[str], schema_migrations.filename ASC
    "tables": [{
      "schema": "public",                       // str
      "name": "turn_spans",                     // str
      "rows": 48213,                            // int, real count(*), not an estimate
      "md5": "9f2c…"                            // str, 32 hex, md5(string_agg(t::text,'' ORDER BY t::text))
    }]
  }],
  "volumes": [{
    "key": "v4_memdata",                        // str, the compose volume KEY
    "docker_name": "nova_v4_memdata",           // str, the name docker created
    "member": "volumes/v4_memdata.tar",         // str
    "listing_member": "volumes/v4_memdata.listing",  // str
    "files": 1412,                              // int
    "listing_sha256": "0a3e…"                   // str, 64 hex, sha256 of the listing file's bytes
  }],
  "members": [{
    "path": "db/nova_core.dump",                // str, inside the bundle
    "origin": "postgres:nova_core",             // str, where it came from on this host
    "kind": "db",                               // str, one of "db" | "volume" | "listing" | "file"
    "bytes": 91234567,                          // int
    "sha256": "4c9a…",                          // str, 64 hex, of the member's bytes
    "restore_to": "db:nova_core"                // str, one of "db:<name>" | "volume:<key>" | a repo-relative path
  }],
  "excluded": [{
    "kind": "volume",                           // str, "volume" | "bind"
    "name": "v4_ollama",                        // str
    "disposition": "exclude_redownloadable",    // str, one of the six dispositions in §4.2
    "reason": "model weights, re-pullable…"     // str, non-empty, always
  }],
  "coverage": {
    "sources": ["compose", "containers", "volumes", "git", "host-scan"],  // list[str]
    "entries": 14,                              // int
    "refusals": []                              // list — ALWAYS empty in a written bundle
  },
  "fingerprints": {
    "core_signing_key_sha256": "77d1…",         // str 64 hex, or null when the row does not exist
    "passphrase": "3a9f10c4bb27"                // str, sha256(passphrase)[:12]
  },
  "env_keys": ["POSTGRES_PASSWORD", "…"],       // list[str] — NAMES ONLY; values are in files/deploy/.env
  "tailnet": {
    "dns_name": "nova.<tailnet>.ts.net",        // str or null
    "state_carried": false                      // bool, true only in --move mode
  }
}
```

Loading is strict: a manifest missing any documented key, or carrying a value
of the wrong type, raises rather than defaulting. `core_signing_key_sha256`
is legitimately `null` on a hub that has never paired a device — the row is
created on demand (`services/core/migrations/011_devices.sql:19-23`) — and
restore then compares `null` to `null` and says "no signing key in the source
either", never "matched".

`meta.json` (outer, cleartext, advisory): `outer_version` (int, 1),
`encrypted` (bool), `created_at` (str), `bundle_version` (int), `format`
(str), `mode` (str), `transport` (str), `source_host` (str), `members` (int),
`bytes_inner` (int), `passphrase_fingerprint` (str),
`restore_script_sha256` (str). Its docstring and `README.txt` both say it is
unauthenticated.

### 3.3 Member hashing

Ported from `backup_snapshot.py:118-143`: a file is `sha256` of its bytes,
read in 1 MiB chunks. v4 has **no `kind: "tree"` members** — every directory
becomes a `.tar` built in a container plus a per-file `.listing`, which is
strictly better than v3's folded tree hash because a mismatch names the file
that differs instead of saying "the tree differs".

---

## 4. Coverage

### 4.1 The facts it is derived from

`backup.sh` renders five files into `$STAGE/facts/`. Each renderer checks its
own exit status and that its output parses; a renderer that fails aborts the
backup naming the command. An empty-but-successful fact is treated as a
failure, not as "nothing to carry".

| file | command | why |
|---|---|---|
| `compose.json` | `docker compose "${COMPOSE_ARGS[@]}" --profile inference --profile tailnet config --format json` | **Every** profile, always, whatever is enabled: a profile-gated service that is off still owns its volume (`backend/app/backup_inventory.py:57-64`). Warnings go to stderr; only stdout is parsed. **Measured**: this command on v4's file with no `.env` emits `variable is not set` warnings on stderr and still exits 0 with valid JSON on stdout. |
| `containers.json` | `docker ps -a --filter label=com.docker.compose.project=$P --format json`, then `docker inspect` for `.Mounts` | catches anonymous and image-declared volumes compose never names. |
| `volumes.json` | `docker volume ls --filter label=com.docker.compose.project=$P` + `docker volume inspect` | the volumes that actually exist, with their `com.docker.compose.volume` key. `docker volume ls --filter label=<a maintainer's own label>` is deliberately **not** a source — v3 measured it missing the real postgres volume while including a stale one (`backup_coverage.py:48-52`). |
| `git.json` | per bind source: `git check-ignore -q <rel>` → ignored; else `git ls-files --error-unmatch <rel>` → tracked; else `git ls-files <rel>` non-empty → tracked; else unknown. **Directories are probed with a trailing slash first.** | see §4.5 — this is the port's sharpest bug. |
| `hostscan.json` | `git status --porcelain --ignored=matching` at the repo root, `!!` lines | gitignored state nothing mounts. This is how `deploy/.env` — the Postgres password, every service token and `TS_AUTHKEY`, mounted by no container — becomes visible at all. |
| `reachable.json` | per INCLUDE volume: `docker run --rm -v <name>:/v:ro <pg-image> sh -c 'ls /v >/dev/null'`; per INCLUDE file: `[ -r "$path" ]` | R2. The runner's mount list is hand-written and therefore exactly the kind of list this module distrusts; this is what keeps it honest. |

### 4.2 The algorithm

`nova_bundle.coverage(facts, mode) -> (entries, refusals)`.

1. **Build the entry set**, keyed `(kind, name)`:
   - from `compose.json`: for each service, each mount → `{kind: "volume"|"bind", name: source, service, mounted_at, source: "compose"}`; plus every key under top-level `volumes:` even when no service mounts it (a declared-but-unattached volume still holds data).
   - from `containers.json`: each `.Mounts` entry. For `Type=volume`, strip the `<project>_` prefix from the **container side only** — never from the compose side. v3 learned this the hard way: stripping both turns `nova_state` into `state`, the two sources then disagree in opposite directions, and one volume becomes two refusals (`backup_coverage.py:455-461`).
   - from `hostscan.json`: each ignored path that appears in no mount, as `{kind: "bind", source: "host-scan", service: null}`.
2. **Classify each entry.**
   - `kind == "volume"`:
     - name matches `^[0-9a-f]{64}$` → anonymous → `ANON_POLICY[(service, mounted_at)]`; a miss is `UNCLASSIFIED` (keyed by service+destination because the volume's *id* changes on every recreate).
     - else `VOLUME_POLICY[key]`; a miss is `UNCLASSIFIED`.
   - `kind == "bind"`:
     - the source is `/dev/*`, ends `.sock`, or is the docker socket → `EXCLUDE_DECLINED` ("not stored bytes").
     - the source still contains `${VAR}` or `$VAR` → `UNCLASSIFIED`. Never apply the compose default: the default would silently snapshot a different directory than the one in use and then pass every checksum it computed.
     - any path segment is in `SEGMENT_POLICY` → that disposition.
     - `PATH_POLICY[repo-relative path]` → that disposition. **An explicit row beats git.** Without this, the backup output directory — necessarily gitignored — is included by the general rule and every bundle contains every previous bundle.
     - a `host-scan` entry with no `PATH_POLICY`/`SEGMENT_POLICY` row → `UNCLASSIFIED`. (See §4.4: this is a deliberate departure from v3.)
     - else git: `ignored` → `INCLUDE`; `tracked` → `EXCLUDE_CODE`; `unknown` → `UNCLASSIFIED`.
3. **Mode overlay.** In `mode == "move"`, `v4_tailscale`'s disposition flips from `EXCLUDE_DECLINED` to `INCLUDE`. This is the only mode-dependent row and the table says so in its reason text.
4. **Refuse.** Four codes, all collected, all gating:

| code | fires when | text (abridged) |
|---|---|---|
| `R1_UNCLASSIFIED` | any entry left `UNCLASSIFIED` | `a named volume with no entry in VOLUME_POLICY. Git cannot see inside a volume, so this is the one thing that must be decided by hand — add it to deploy/backup/policy.py as include or exclude, with a reason.` (and the three sibling texts for anonymous volumes, unexpanded variables, unknown binds) |
| `R2_UNREACHABLE` | an `INCLUDE`/`INCLUDE_PG` entry whose `reachable.json` says no | `classified as state to carry, but the backup cannot read it: <reason>. A bundle that silently omits a tier is worse than no bundle.` |
| `R3_VOLUME_MISSING` | an `INCLUDE` volume that `volumes.json` does not list | `<key> is to be carried but no volume named <docker_name> exists on this host. Either the stack has never run the service that owns it, or the volume was removed.` |
| `R4_FACT_UNREADABLE` | any renderer in §4.1 failed or produced unparseable output | names the command and its stderr. |

5. `may_snapshot = not refusals`. Explicitly **not** "a partial bundle with a
   warning" (`backup_coverage.py:686-693`).

### 4.3 The exact refusal

`nova_bundle.py` exits **3** having written nothing (no `.part`, no staging
leftovers), and prints to stderr:

```
Error: this stack has state the backup cannot account for. No bundle was written.

  R1_UNCLASSIFIED  volume:v4_vectors
      a named volume with no entry in VOLUME_POLICY. Git cannot see inside a
      volume, so this is the one thing that must be decided by hand — add it
      to deploy/backup/policy.py as include or exclude, with a reason.
      declared by: memory (compose), mounted at /data/vectors

  R2_UNREACHABLE   volume:v4_memdata
      classified as state to carry, but the backup cannot read it:
      `docker run --rm -v nova_v4_memdata:/v:ro postgres:16 ls /v` exited 125.
      A bundle that silently omits a tier is worse than no bundle.

2 refusals. Decide each one, then run `./install backup` again.
```

`backup.sh` propagates exit 3 unchanged and adds nothing. The `Error:` prefix
is the house convention for a stated refusal.

### 4.4 Where I depart from v3, and why

v3 classified a **host-scan-only** path by the git rule: gitignored → INCLUDE
(`backup_coverage.py:583-610`). That makes `.env` carry itself, which is the
point — but it also makes `.claude/`, `.worktrees/`, `services/*/.venv/` and
every `__pycache__/` carry themselves, because in this repo they are all
gitignored and mounted by nothing. **Measured**, `git status --porcelain
--ignored=matching` in this worktree returns 19 such paths today, none of
which is Nova's state.

So: a host-scan-only entry with no `PATH_POLICY`/`SEGMENT_POLICY` row is
`UNCLASSIFIED` and refuses. The dangerous direction is silent *exclusion*;
this makes the loud direction the default one. The cost is a table that must
be extended the day someone adds a `.gitignore` line, and the alarm for that
is `test_coverage_v4_real.py` (§10) going red in CI, not a backup failing at
3am.

### 4.5 The port bug this design exists to not ship

v3's `git_status_fn` passes the repo-relative path to `git check-ignore -q`
without a trailing slash (`backend/app/backup_inventory.py:181-208`).
**Measured in this worktree:**

```
git check-ignore -v data   -> exit 1  (NOT ignored)
git check-ignore -v data/  -> .gitignore:13:data/   data/
```

`../data:/data:ro` is a real v4 bind (`deploy/docker-compose.yml:83`). Port
`git_status_fn` verbatim and it returns `unknown` for that bind, which falls
to `UNCLASSIFIED`, which means **every v4 backup refuses on day one**.
`git.json`'s renderer therefore probes a directory as `<rel>/` first and falls
back to `<rel>`, and `test_git_status_directory_trailing_slash` pins it.

### 4.6 The tables (`deploy/backup/policy.py`), re-derived for v4

`VOLUME_POLICY` — the six keys `deploy/docker-compose.yml:337-351` declares:

| key | disposition | reason (abridged; the file carries the full sentence) |
|---|---|---|
| `v4_pgdata` | `INCLUDE_PG` | the three databases. A live PGDATA copy is torn, so this tier is captured by `pg_dump` per database and never as files. |
| `v4_memdata` | `INCLUDE` | the notes — one markdown file per journal-day or topic under `people/` (`services/memory/app/store.py:1-18`). They exist nowhere else. `.embeddings/<model>.jsonl` rides along inside the same volume; it is a cache (`services/memory/app/embedding.py:664-688`) and carrying it only saves a rebuild. |
| `v4_workspace` | `INCLUDE` | Nova's own scratch space (`deploy/docker-compose.yml:55-60`). A file she wrote lives only here. |
| `v4_models` | `EXCLUDE_EPHEMERAL` | gateway's `/models`. **Measured**: its only reader in the whole service is `os.statvfs` for a free-space check (`services/gateway/app/admin.py:59,332`); nothing writes there. |
| `v4_ollama` | `EXCLUDE_REDOWNLOAD` | local model weights, re-pullable. Stated cost, not a free choice: a restore on a disconnected machine has no local inference until the pulls finish. |
| `v4_tailscale` | `EXCLUDE_DECLINED` (routine) / `INCLUDE` (`--move`) | the tailnet node identity (`tailscaled.state`, `deploy/docker-compose.yml:286`). Two live nodes sharing one identity flap, so it travels only on a move — which also leaves `MOVED_TO` behind on the source. |

`PATH_POLICY` (repo-relative, explicit beats git) — the rows this repo needs
today: `deploy/.env` → `INCLUDE` ("every generated secret,
`deploy/install.sh:29`, plus `TS_AUTHKEY`; mounted by nothing, so only the
host scan sees it"); `deploy/backups` → `EXCLUDE_DECLINED` ("where bundles
are written; included, a bundle would contain every previous bundle");
`data` → `EXCLUDE_EPHEMERAL` **with `allowed_children = {"hardware.json"}`**
("regenerated by `detect_hardware` at every install, `deploy/install.sh:808-863`;
a restored host's GPUs are not the source host's") — any other child of
`data/` is `R1_UNCLASSIFIED` naming the child, so the day something writes
real state there the backup says so instead of dropping it; `.claude`,
`.superpowers`, `.worktrees` → `EXCLUDE_DECLINED` ("this machine's tooling
state, not Nova's"); `backend/.coverage`, `backend/uv.lock`,
`frontend/vite.config.js`, `tools/wake-training/data`,
`tests/e2e/.isolated`, `tests/e2e/test-results`,
`tests/e2e/playwright-report`, `tests/e2e/.auth` → `EXCLUDE_EPHEMERAL` /
`EXCLUDE_DECLINED` with their own reasons.

`SEGMENT_POLICY` (a segment name means the same thing wherever it appears):
`__pycache__`, `.venv`, `venv`, `node_modules`, `.ruff_cache`,
`.pytest_cache`, `.mypy_cache`, `dist`, `build`, `dev-dist`, `.egg-info`.

`ANON_POLICY` — empty today. **Measured**: `docker ps -a --filter
label=com.docker.compose.project=nova` plus `docker inspect .Mounts` shows no
anonymous volume on any v4 service. The table exists so that an image that
declares one later refuses rather than vanishes.

Dropped from v3 outright, because the services do not exist in v4's compose
(`:4-329`): `postgres_data`, `nova_state`, `tailscale_state`,
`ollama_models`, `whisper_models`, `kokoro_models`, `ntfy_cache`,
`coder_workspaces`, and the `searxng` `ANON_POLICY` rows.

---

## 5. Crypto

**Ported byte-for-byte from `backend/app/backup_crypto.py`. The format does
not change.** It is pure mechanism — "no settings, no resolver, no app
imports" (`backup_crypto.py:36-39`) — so there is nothing v3-shaped in it to
carry across.

**Container** `NOVAENC1` (`backup_crypto.py:10-16,49`):

```
b"NOVAENC1"                          8-byte magic
4-byte BE header length              (header bytes <= 4096, else refuse)
header JSON {v,cipher,kdf,n,r,p,salt,nonce_prefix,chunk}  sorted keys, no spaces
frames: [4-byte BE ciphertext length][ciphertext||tag] … to EOF
```

**Algorithm**: AES-256-GCM, 128-bit tag (`TAG_LEN=16`), applied **per chunk**
rather than once over the file, so neither writer nor reader ever holds a
whole multi-hundred-MB bundle in memory twice.

**KDF**: `hashlib.scrypt` — chosen precisely because the standalone restore
script must derive the same key with **no third-party package**
(`backup_crypto.py:17-19`). Write parameters `n = 2**15 (32768)`, `r = 8`,
`p = 1`, `dklen = 32`, `maxmem = 256 MiB`; ≈34 MB of KDF memory. Salt: 16
random bytes, **fresh per file** — a fresh salt is a fresh key.

I considered raising `n` and decided against it: the ceiling the reader will
pay is `128*r*n <= 128 MiB`, so `n = 2**17, r = 8` sits exactly on the cap,
and the mini PC's measured 12.5 GiB free RAM (`hub-topology.md:76-82`) buys
nothing for a passphrase that is *generated* with 160 bits of entropy. The
reader's accepted region already permits a later raise without a format
change.

**Reader-side cost cap** (the subtle half, `backup_crypto.py:57-64,118-135`):
a decryptor must allocate `128*r*n` bytes *before* the first authentication
check can run, so a tampered header can make an honest reader allocate
gigabytes — or name a cost that blows `maxmem` and turns "tampered" into a
bare `ValueError`. Accepted region: `0 < n <= 2**18` and `n` a power of two,
`0 < r <= 16`, `0 < p <= 4`, `128*r*n <= 128 MiB`, `0 < chunk <= 64 MiB`,
`salt`/`nonce_prefix` decoding to exactly 16/4 bytes of hex. Every violation
raises `CryptoError`, never `ValueError`.

**Chunking**: 4 MiB. A frame's "is this the last one" flag is decided at
write time by cumulative **position** (`done >= size`), never by a short read
— the last chunk of an exact-multiple file is full length. At read time it is
decided by **lookahead**: the next frame is read before the current one is
decrypted, and `final = (next is None)`.

**Authentication**: nonce = 4-byte random per-file prefix ‖ 8-byte BE frame
counter, so it is unique per (file, chunk) with nothing stored. AAD =
`MAGIC ‖ header_bytes ‖ BE64(index) ‖ (0x01 if final else 0x00)`. The header
and the chunk's *position in the sequence* are authenticated, not just its
bytes. Consequences, and the reason this design is worth the code: a tampered
header fails, a reordered chunk fails, and — the one that matters for backups
— a **truncated** file fails instead of quietly yielding a shorter archive.

**Wrong passphrase and corrupt file are the same exception, on purpose.** GCM
cannot distinguish them and the code refuses to pretend it can; every failure
path raises `CryptoError` with one sentence: *"decryption failed — wrong
passphrase, or the file is corrupt, truncated or tampered with (GCM cannot
tell these apart)."* One layer above, `restore` catches it and adds the one
useful hint it actually has: the bundle's recorded
`fingerprints.passphrase` versus the fingerprint of the passphrase that was
just tried, so "you used a rotated passphrase" is stated when it is *known*,
and never guessed.

**Passphrase generation** (`backup_crypto.py:238-245`): 160 bits
(`secrets.token_bytes(20)`), base32 lowercase, 8 groups of 4 joined by `-`.
It optimises for transcription onto paper, not for typing, because the whole
point is that it is recorded off-machine.

**How the in-bundle script decrypts on a bare machine** — ported from
`scripts/nova_restore.py:87-316`:

1. `python3` ≥ 3.9 is the one hard requirement. `hashlib.scrypt`, `tarfile`,
   `gzip`, `struct`, `json`, `getpass` are all stdlib, so the KDF and the
   whole archive path need nothing installed.
2. AES-GCM backend, in order: (a) `from cryptography.hazmat.primitives.ciphers.aead
   import AESGCM` if the package happens to be present; (b) the system
   OpenSSL `libcrypto` via `ctypes`, driving `EVP_aes_256_gcm` /
   `EVP_DecryptInit_ex` / `EVP_CIPHER_CTX_ctrl(GCM_SET_IVLEN, GCM_SET_TAG)` /
   `EVP_DecryptUpdate` / `EVP_DecryptFinal_ex` — where `Final_ex`'s return
   value **is** the tag check.
3. On `sys.platform == "darwin"` it **never** calls
   `ctypes.util.find_library`, because Apple's stub libcrypto aborts the whole
   process when called; it tries exactly two Homebrew paths
   (`/opt/homebrew/opt/openssl@3/lib/libcrypto.dylib`,
   `/usr/local/opt/openssl@3/lib/libcrypto.dylib`) and, failing both, prints
   `Error: no usable OpenSSL on this machine — run `pip3 install cryptography`
   and try again.` **Unverified**: no macOS machine was available here, so
   whether those two paths are still right for a current Homebrew is not
   checked. Risk 9, §12.
4. `os.umask(0o077)` is set at the top of `main()` so nothing it writes —
   `.env`, the dumps — is ever group- or world-readable. On **any** exception
   anywhere in `main()`, everything the run created under `--out` is removed:
   a half-decrypted `.env` must never be left looking like a finished restore.

Two readers of one format is a real cost (`nova_bundle.py` has one,
`nova_restore.py` has the other). It is the price of an in-bundle script with
no imports, and it is paid by `test_restore_reader.py`, which encrypts with
the writer and decrypts with the reader with the `cryptography` backend forced
off, so the ctypes path is the one exercised.

---

## 6. The passphrase resolver seam

Interface, in `nova_bundle.py` and mirrored read-side in `nova_restore.py`:

```python
class PassphraseUnavailable(Exception): ...

@dataclass(frozen=True)
class Resolver:
    name: str
    description: str                      # shown by `./install backup --help`
    available: Callable[[], str | None]   # None = usable; a SENTENCE = why not
    resolve:   Callable[[], str]          # the passphrase, in memory only

RESOLVERS: dict[str, Resolver]            # THE SEAM

def resolve_passphrase() -> str:
    name = os.environ.get("NOVA_BACKUP_PASSPHRASE_SOURCE", "file")
    src = RESOLVERS.get(name)
    if src is None:
        raise PassphraseUnavailable(
            f"NOVA_BACKUP_PASSPHRASE_SOURCE is {name!r}, which this build "
            f"does not provide (available: {', '.join(sorted(RESOLVERS))})")
    why = src.available()
    if why:
        raise PassphraseUnavailable(f"the {name!r} passphrase source cannot be used: {why}")
    try:
        return src.resolve()
    except PassphraseUnavailable:
        raise
    except Exception as e:
        raise PassphraseUnavailable(f"the {name!r} passphrase source failed: {e}") from e
```

Any failure becomes `PassphraseUnavailable`, never a bare exception, and
`backup` refuses the whole bundle on it: **no passphrase, no bundle**
(`backend/app/backup_service.py:146-152`).

**Resolvers that land now — three:**

| name | resolve | available() refuses when |
|---|---|---|
| `file` (default) | reads `$NOVA_BACKUP_PASSPHRASE_FILE` (default `deploy/.backup-passphrase`), stripped then verbatim. If the file is absent, `backup` **generates** one with `generate_passphrase()`, writes it 0600, and prints it **once** with "record this off-machine; it is not in the bundle and this machine's copy dies with this machine." | the file exists and is not mode 0600; or the filesystem cannot hold 0600 (the §7 mode probe). |
| `env` | `$NOVA_BACKUP_PASSPHRASE`. For CI and for an operator who keeps it elsewhere. | the variable is unset or empty. |
| `prompt` | `getpass.getpass()`. | stdin is not a TTY. |

Never a positional CLI argument, so the passphrase never reaches `ps` or shell
history. The only log line generation ever emits names the *file*, never the
value; `test_passphrase.py` asserts no log record emitted during a build
contains the passphrase.

**Restore side**, ported order (`scripts/nova_restore.py:321-335`):
`--passphrase-file <path>` → `$NOVA_BACKUP_PASSPHRASE` → interactive
`getpass`. Each candidate is tried **stripped, then verbatim** — a paper
transcription usually gains whitespace, and a stored value may legitimately
carry it.

**How a secrets manager plugs in later without changing callers.** A new
module registers into `RESOLVERS` at import:

```python
# deploy/backup/resolvers_extra.py  (does not exist in S41)
RESOLVERS["onepassword"] = Resolver("onepassword", "…", _op_available, _op_resolve)
```

Callers only ever call `resolve_passphrase()`. `test_passphrase.py` asserts
`sorted(RESOLVERS) == ["env", "file", "prompt"]` and that
`deploy/.env.example`'s documented options are exactly that set, so adding a
source without offering it — or offering one that does not exist — is a red
suite, not a silent divergence. v3's `local` resolver (the secret store) is
**not** ported: v4 has no secret store at all (a grep for `secret_store` under
`services/` returns only a test filename). When Proposal A lands, it registers
`local` here and nothing else moves.

---

## 7. The verbs

Common helpers in `backup.sh`, all bash 3.2:

- `sha256_of <file>` — `sha256sum`, else `shasum -a 256`, else **refuse**
  ("neither sha256sum nor shasum is on this host; a bundle whose hashes
  cannot be computed is not a bundle"). Never a silent skip.
- `mode_probe <dir>` — write `<dir>/.nova-mode-probe`, `chmod 600`, read the
  mode back with `stat -c '%a' … || stat -f '%Lp' …` (the pair already in
  `deploy/install_test.sh:266,317`), require exactly `600`, delete the probe.
  This replaces the hardcoded `/mnt/[a-z]/` check (requirement #25) and is
  what implements requirement #26.
- `scratch_name_ok <name>` — `^nova_verify_[0-9a-f]{8}$`.
- `drill_name_ok <name>` — `^nova_drill_[0-9a-f]{8}_[a-z0-9_]+$`.
- Guard-first instead of `xargs -r`; `mktemp "<file>.XXXXXX"` + `mv` instead
  of `sed -i`; `df -Pk` instead of `df -h`; `cd … && pwd -P` instead of
  `readlink -f`; `date +%s` and never `%N`. Every one of these is already the
  pattern in `install.sh` (map-portability §2).

### 7.1 `./install backup [--move] [--out DIR] [--transport local|usb|offsite]`

1. **`refuse_if_moved`.** Verifies `deploy/.moved` is absent. Fails → exit 1
   naming the file and `./install undo-move`.
2. **Output directory.** Default `deploy/backups`, `mkdir -p`, `chmod 700`.
   Verifies `mode_probe` returns `600`. Fails → refuse naming the path and
   the mode actually read: *"this filesystem cannot hold owner-only
   permissions (read back 0777). The bundle carries deploy/.env, so it will
   not be written somewhere that cannot protect it."*
3. **Free space.** Sum `pg_database_size` for the three databases plus
   `du -sk` of each INCLUDE volume (in a throwaway container); require
   `detect_disk_free_gb "$OUT"` ≥ 1.5× that. Verifies both numbers were
   actually read. Fails, or either number unreadable → refuse with both
   numbers. Never "assume enough".
4. **Passphrase**, through §6. Verifies a value came back. Fails → refuse; no
   bundle.
5. **Facts** (§4.1). Verifies each renderer exited 0 and its output parses.
   Fails → refuse naming the command and its stderr.
6. **Coverage** (`nova_bundle.py coverage`). Verifies `refusals == []`. Fails
   → exit 3 with §4.3's block; nothing written.
7. **Stop the writers**: `core gateway memory web`, plus `tailscale` when
   `--move`. `postgres` stays up. Verifies each by re-reading
   `docker inspect -f '{{.State.Running}}' <id>` and requiring `false`. Any
   still running → restart whatever this step stopped, then refuse naming it:
   a dump taken while core is writing is a dump nobody can trust.
8. **Per-database census.** `SET TimeZone='UTC'` first (so a `timestamptz`
   renders identically on both sides), then for every table in
   `information_schema.tables` outside `pg_catalog`/`information_schema`:
   `SELECT count(*), md5(coalesce(string_agg(t::text, '' ORDER BY t::text), ''))
   FROM <schema>.<table> t`. Also `SELECT filename FROM schema_migrations
   ORDER BY filename`, and
   `SELECT encode(sha256(convert_to(private_key_hex,'UTF8')),'hex') FROM
   core_signing_key WHERE id = 1` (zero rows → `null`, recorded as `null`).
   Verifies: every catalogued table produced a `(rows, md5)` pair, and
   `schema_migrations` exists in all three databases. Fails → refuse naming
   the table or the database and the SQL error. A database with no migration
   ledger refuses, because restore's gate would then have nothing to check.
9. **Dump**, inside the postgres container:
   `pg_dump -Fc --no-owner --no-acl -d <db> -f /stage/db/<db>.dump`.
   Databases are dumped **before** files are copied, for v3's reason
   (`backup_snapshot.py:230-235`): an attachment blob written between the two
   shows up as a file with no row, which is recoverable; a row with no blob is
   not. Verifies: exit 0, size > 0, **and** `pg_restore --list` of the file
   exits 0 and prints ≥ 1 entry. Fails on any → refuse.
10. **Self-test restore**, per database, inside the same container.
    `scratch="nova_verify_$(8 hex)"`. Assert `scratch_name_ok` **before
    CREATE, before RESTORE and before DROP** — three separate assertions, v3's
    pattern (`backend/app/backup_restore.py:58-64,217,234,290`). After CREATE,
    connect and compare `SELECT current_database()` to `$scratch` before
    anything is written — a DSN that looks right and resolves elsewhere is the
    failure this catches. Then
    `pg_restore --single-transaction --exit-on-error --no-owner --role=<role>
    -d $scratch`, re-run step 8's census against it, compare **every** table's
    count and md5, `DROP DATABASE $scratch`. Verifies: exact equality for
    every table. Fails → refuse naming the first table that differed and both
    values. `--exit-on-error` is required, not tidiness: `pg_restore`'s
    default is to continue past errors, which turns a broken restore into an
    interleaving instead of a stop.
11. **Tar each INCLUDE volume**, in a throwaway container (requirement #24),
    running as root because postgres-owned files are not readable otherwise:
    `docker run --rm -v <docker_name>:/src:ro -v "$STAGE":/out <pg-image> \
      sh -c 'tar -C /src --numeric-owner -cf /out/volumes/<key>.tar . && \
             cd /src && find . -type f | LC_ALL=C sort > /tmp/f && \
             [ -s /tmp/f ] && xargs -a /tmp/f sha256sum > /out/volumes/<key>.listing || : > /out/volumes/<key>.listing'`
    then a second throwaway container `chown -R <uid>:<gid> /out` so the host
    user can read what was just written. Verifies: tar exit 0; the listing's
    line count equals `find -type f | wc -l`; `tar -tf | grep -c -v '/$'` ≥
    that count. Fails → refuse naming the volume. (Guard-before-pipe instead
    of `xargs -r`, which BSD does not have.)
12. **Copy each INCLUDE file** to `files/<repo-relative path>`. Verifies the
    copy's sha256 equals the source's. Fails → refuse.
13. **Build**, in a throwaway container of the core image
    (`img="$(docker compose "${COMPOSE_ARGS[@]}" images -q core)"`; empty →
    refuse, *"the core image is not built; run ./install first"*):
    `docker run --rm -u "$(id -u):$(id -g)" -v "$STAGE":/stage \
       --entrypoint python3 "$img" /stage/bin/nova_bundle.py build …`
    a. write `MANIFEST.json`;
    b. build `inner.tgz` with the manifest as the **first** member;
    c. `verify_inner`: re-extract to a fresh tempdir and **re-derive** every
       member's sha256 from the extracted bytes — deliberately not trusting
       the manifest's own numbers. The exception handler here is broad on
       purpose: a truncated gzip raises `EOFError`, which is neither
       `TarError` nor `OSError`, and a narrower catch turns "corrupt" into an
       uncaught crash (`backup_snapshot.py:420-427`);
    d. `encrypt_file(inner.tgz → payload.enc)`;
    e. write the outer tar as `<final>.part`, members in §3.1's order;
    f. **full round trip on the written file**: open `<final>.part`, decrypt
       `payload.enc`, re-extract, re-verify every hash against the manifest,
       and assert the embedded `nova_restore.py`'s sha256 equals the git
       copy's.
    Verifies at every lettered step. Any failure → delete the `.part` and the
    staging tree, refuse.
14. **Publish.** `os.replace(part, final)` with a collision loop appending
    `-1`, `-2`, … Verifies the final path did not exist beforehand. This
    guards a real v3 incident: two snapshots in the same second let
    `os.replace` clobber the very bundle being restored
    (`backup_snapshot.py:201-213`).
15. **Protect.** `chmod 600` the bundle, read the mode back with the `stat`
    pair. Verifies `600`. Fails → **delete the bundle** and refuse. An
    unprotectable bundle holding `.env` is worse than no bundle.
16. **Restart or park.**
    - routine: `docker compose … up -d core gateway memory web` then
      `wait_for_health` (`deploy/install.sh:1025-1054`). Verifies every one
      goes healthy inside the existing 240s budget. Fails → the bundle stands,
      but exit non-zero naming the unhealthy service and its last 20 log lines
      (install.sh's existing pattern, `:1093-1105`).
    - `--move`: leave everything stopped; write `MOVED_TO` into the
      `v4_tailscale` volume through a throwaway container, `touch
      deploy/.moved`. Verifies both by reading them back. Fails → refuse
      saying the move marker is **not** in place, so nobody believes the
      source host is parked when it is not.
17. Print the bundle path, bytes, sha256, `fingerprints.passphrase`, and the
    single line that the passphrase is not inside the bundle.

### 7.2 `./install restore <bundle> [--drill] [--passphrase-file F]`

0. **`python3` ≥ 3.9 on this host.** Verifies
   `python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,9) else 1)'`.
   Fails → `Error: restore needs python3 (3.9 or newer) on this host. The
   bundle cannot be opened without it.` No fallback.
1. **`decide_subnet` first** (§8). Verifies the chosen subnet overlaps nothing
   in `docker_subnets_in_use ∪ host_routes_in_use`. Fails → die naming the
   colliding network or route. First, because every step after this creates
   docker objects on that network. **Ordering trap, stated because it is
   easy to get wrong:** the values are held in shell variables here and are
   written to `.env` only at step 6, *after* the carried `.env` lands, so the
   carried file cannot clobber them.
2. **Open and verify.** `nova_restore.py --verify-only <bundle>`: read the
   outer tar, take `meta.json` as advisory only, resolve the passphrase (§6),
   decrypt `payload.enc` into a tempdir under `umask 077`, extract the inner
   archive with a path-traversal-safe extractor, re-derive every member's
   sha256 and compare to `MANIFEST.json`, and check
   `manifest.bundle_version <= OUR_BUNDLE_VERSION`. Verifies: every member
   matches. Fails → **hard stop**, remove everything created under the temp
   dir, print the first mismatching member — and print **no next steps**, so a
   failed verify can never read as a partial success.
3. **Refuse a non-empty target.** For each volume the bundle carries,
   `docker volume inspect nova_<key>`; if it exists, probe it
   (`docker run --rm -v …:/v:ro <pg-image> find /v -mindepth 1 -print -quit`)
   and refuse if non-empty. Also refuse if **any** container carries
   `com.docker.compose.project=<project>`. Verifies: nothing here will be
   overwritten. Fails → refuse listing every non-empty volume and every
   container found. (`--drill` replaces this step with §7.3's name
   assertions.)
4. **Refuse an older `pg_restore`.** Read `pg_restore --version` from the
   image compose will run, compare its major to `postgres.pg_dump_major`.
   Verifies target major ≥ source major. Fails → refuse with both numbers.
5. **Migration gate**, per database: every `databases[].migrations` filename
   must exist in this checkout's `services/<svc>/migrations/`. Verifies this
   checkout is not older than the bundle. Fails → refuse naming the first
   missing filename, its database, and `source.repo_sha`. **Stated
   degradation:** v4's ledger is `(filename, applied_at)` with no checksum
   column (`services/core/app/migrations_runner.py:19-24`), so this gate is
   **filename-only** and a renumbered migration will refuse a perfectly
   restorable bundle. v3 hit exactly that and fixed it with a checksum
   fallback (`backend/app/backup_apply.py:115-122`). Adding the column is a
   carry, not S41; the refusal text says which case it might be and how to
   override (`--skip-migration-gate`, which prints what it is skipping).
6. **Apply the carried `.env`.** Only when `deploy/.env` does not exist. If
   one does, compare the carried `SECRET_KEYS` (`deploy/install.sh:29`)
   against it: identical → continue; any difference → refuse naming the keys
   that differ. Never merge silently. Then write step 1's host-specific keys
   over it, `chmod 600`, read the mode back. Verifies the mode. Fails →
   refuse.
7. **Create the volumes** with compose's own labels:
   `docker volume create --label com.docker.compose.project=<project>
   --label com.docker.compose.volume=<key> nova_<key>`. Verifies
   `docker volume inspect` reports both labels. Fails → refuse.
8. **Untar each volume** in a throwaway container, then **re-derive the
   listing in the same container** and diff it against
   `volumes/<key>.listing`. Verifies: identical sha256 and identical file
   count. Fails → refuse naming the first differing path. (v3 hashed the
   whole tree; per-file says *what* differs.)
9. **`docker compose … up -d postgres`**, wait for `pg_isready`. Verifies
   healthy inside the existing budget. Fails → die with its logs.
10. **Restore**, per database, inside the postgres container:
    `pg_restore --no-owner --role=<role> --single-transaction --exit-on-error
    -d <db>`. Verifies exit 0. Fails → refuse; `--single-transaction` means
    the database is left exactly as it was (empty).
11. **Re-verify.** Re-run step 8's census against the restored databases and
    compare every table's count and md5 to the manifest; re-read the core
    signing key's sha256 and compare. Verifies: equality, table by table. A
    **count** mismatch is a failure here, unlike v3's tolerance for
    `n_live_tup` — both sides are real `count(*)`s. Fails → refuse naming the
    first mismatch and both values.
12. **Park.** Stop postgres, write `deploy/.restored` with the bundle's
    `created_at` and sha256, read it back. Print `./install` as the next step.

### 7.3 `restore --drill` (requirement #17)

The same steps 2, 4, 5, 10, 11 — nothing on the host is written, and step 1 is
skipped entirely because the drill creates no project network.

- One run id: `RUN="$(8 hex)"`.
- Volumes: `nova_drill_${RUN}_<key>`. `drill_name_ok` is asserted **before
  create and before delete**.
- Postgres: `docker run -d --name nova-drill-pg-${RUN} --network none
  -e POSTGRES_PASSWORD=<random 32 hex> -v nova_drill_${RUN}_pgdata:/var/lib/postgresql/data
  postgres:16`, then the three databases and roles created inside it with the
  same SQL as `deploy/postgres-init/01-databases.sql`. `--network none`
  because a drill must not be reachable as if it were the real thing.
- `.env` is decrypted into a tempdir under `umask 077` and dies with it. It is
  never written under `deploy/`.
- `trap` on EXIT removes the container and every `nova_drill_${RUN}_*` volume.
  Verifies each removal by re-querying. A removal that fails **says so and
  exits non-zero naming what is left** — never a silent `rm -f`, never
  `ignore_errors`.

### 7.4 `./install drill` (requirement #5 — the verb)

1. **Sweep orphans.** Any volume matching `^nova_drill_[0-9a-f]{8}_` and any
   container named `nova-drill-pg-*` left by a run that died. Verifies each
   removal. Prints what it swept. (v3 needed this because a `finally` does not
   survive a process restart mid-verify, `backend/app/backup_service.py:568-602`.)
2. **Find the newest bundle** in the backup directory. Verifies at least one
   exists. **No bundles at all is a FAILED drill**, not a vacuous pass: the
   question is "could I recover from disaster today", and with no bundle the
   answer is no. Exit non-zero saying exactly that.
3. Run `restore --drill` on it. Verifies its exit status.
4. **Report**: bundle path, `created_at`, age in days, per-database table
   count, whether every md5 matched, the key-fingerprint comparison, and the
   passphrase fingerprint. Plus one cross-check the drill alone would not
   surface: if any *older* bundle in the directory carries a different
   `passphrase_fingerprint` than the current passphrase, name those bundles
   and say they need the previous passphrase.
5. The exit code **is** the verdict.

The weekly schedule is out of scope (ruling: the verb now, the schedule may
follow). Its future home is `timers.JOBS` — a job handler runs mechanically
with no model in the loop and a refused firing pauses its row
(`services/core/app/timers.py:56,570-584`) — which is a better fit than
reconstructing v3's `automations` shape.

### 7.5 `./install undo-move`

1. Verifies `deploy/.moved` exists; absent → say so and exit 0 (idempotent).
2. Remove `MOVED_TO` from the `v4_tailscale` volume through a throwaway
   container, then re-read to confirm it is gone. Fails → refuse, so nobody
   believes the node is unparked when it is not.
3. Remove `deploy/.moved`; confirm.
4. Print: run `./install`.

And in `deploy/tailscale/start.sh` (POSIX sh, runs in the Alpine sidecar), at
the very top, before containerboot:

```sh
if [ -f /var/lib/tailscale/MOVED_TO ]; then
  log "this node moved to $(cat /var/lib/tailscale/MOVED_TO) — refusing to start"
  log "run './install undo-move' on this host if the move was reverted"
  exit 1
fi
```

The refusal lives at the layer that would cause the conflict: two tailscaled
processes sharing one node identity flap.

---

## 8. `install.sh`'s refusal for a foreign `nova` compose project

### 8.1 How the names are derived

Nothing is hardcoded. Every name comes from docker output or from the compose
file compose itself rendered.

```
project        = compose_config_text | config_project_name        # install.sh:398-401
ours_volumes   = compose_config_text | config_volume_keys         # NEW, sibling of :402-411
ours_services  = compose_config_text | config_service_keys        # NEW
```

**Containers.** `docker ps -a --filter "label=com.docker.compose.project=$project"
--format '{{.ID}}|{{.Names}}|{{.Label "com.docker.compose.service"}}|{{.State}}'`,
then for each, `docker inspect --format '{{index .Config.Labels
"com.docker.compose.project.config_files"}}'`. Classify into three:

- **ours** — any comma-separated entry `canonical_path`-equal to
  `$COMPOSE_FILE` (`deploy/install.sh:132-146`, the exact test
  `bundled_ollama_running` already uses at `:203-215`).
- **sibling** — a named config file that **exists on this host**, whose
  `name:` equals `$project` and whose declared volume keys are a subset of
  `ours_volumes`: another checkout of this same stack.
- **foreign** — everything else, including a config file that does not exist
  on this host, and a container with no config-files label at all.

**Why `sibling` exists, and it is not hypothetical.** **Measured** on this
machine:

```
docker ps -a --filter label=com.docker.compose.project=nova \
  --format '{{.Names}} {{.Label "com.docker.compose.project.config_files"}}'
```

returns eight **running** v4 containers created from
`…/.worktrees/v4/deploy/docker-compose.yml` — not from this worktree's file —
beside seven exited v3 containers created from `…/nova/docker-compose.yml` and
from `/compose/docker-compose.yml`. A classifier that tested only "config
files equal my compose file" would call the live v4 stack foreign and offer to
delete it. That is the single most dangerous bug this feature can have, and
the `sibling` class is what closes it.

**Volumes.** `docker volume ls --filter "label=com.docker.compose.project=$project"
--format '{{.Name}}|{{.Label "com.docker.compose.volume"}}'`. **Foreign iff the
volume key is not in `ours_volumes`.** This is airtight in the direction that
matters: a volume this compose file created carries, by construction, one of
the keys this compose file declares, so it can never land in the foreign set —
independently of which checkout created it, which is why the sibling problem
does not arise for volumes at all.

**Measured** on this machine, that query returns eleven volumes: `v4_pgdata`,
`v4_models`, `v4_memdata`, `v4_workspace`, `v4_ollama`, `v4_tailscale` (ours,
all six declared at `deploy/docker-compose.yml:337-351`) and `kokoro_models`,
`nova_coder_workspaces`, `ntfy_cache`, `tailscale_state`, `whisper_models`
(foreign, all v3's). A volume created without labels is invisible to this
query — and correctly so: compose adopts by label, so an unlabelled volume is
not something `docker compose up` can take, and this path must not offer to
delete something it cannot prove belongs to the project.

### 8.2 What it prints

```
A different stack is using the compose project name this installer uses.

  project:        nova     (from /abs/deploy/docker-compose.yml)
  this checkout:  /abs/deploy/docker-compose.yml

  Foreign containers (6)
    3f21a9c0b1d4  nova-postgres-1      service=postgres      exited
                  created from /compose/docker-compose.yml (no such file on this host)
    8ab4…         nova-orchestrator-1  service=orchestrator  exited
                  created from /compose/docker-compose.yml (no such file on this host)
    …

  Foreign volumes (4)
    nova_pgdata           key=pgdata
    nova_postgres-data    key=postgres-data
    nova_redis-data       key=redis-data
    nova_redis_data       key=redis_data

  Not touched — these belong to this stack (6)
    nova_v4_pgdata  nova_v4_models  nova_v4_memdata
    nova_v4_workspace  nova_v4_ollama  nova_v4_tailscale

  `docker compose up` here would ADOPT and recreate the foreign containers
  whose service name this file also declares: postgres.

This will DELETE the 6 containers and the 4 volumes named above. The data in
those volumes cannot be recovered afterwards. It will not touch anything in
the "Not touched" list.

Type exactly:  delete nova's old stack
Anything else, including an empty line, leaves everything as it is.
>
```

The default is to do nothing: a bare Enter, EOF, `y`, `yes` and any other
input all decline.

### 8.3 How the deletion is bounded

The IDs and names printed above are captured into two shell variables at the
moment they are named. The deletion runs `docker rm -f` on **that captured ID
list** and `docker volume rm` on **that captured name list** — never a
re-query, so nothing that appeared between the print and the confirmation can
be swept in. Then a **post-condition check**:

1. every captured ID and name is gone (re-query); and
2. every volume key in `ours_volumes` that existed before still exists.

Either check failing exits 1 loudly, naming what survived or what vanished.
The step never reports a success it did not read back.

Non-TTY: never prompt. Print the same block, print the exact
`docker rm -f …` / `docker volume rm …` commands, and exit 1.
`--yes-delete-foreign-project` is the flag for a scripted run, and it is what
`install_test.sh` drives.

### 8.4 The test that proves a v4 volume can never be caught

`install_test.sh::foreign_volumes_never_names_a_v4_volume` — a `docker` stub
answering `volume ls` with a fixture holding all eleven measured names above
**plus** the mini PC's four platform-line volumes, and a compose-config stub
returning this repo's real `volumes:` block. It asserts:

- the classified-foreign output is exactly the nine non-`v4_` keys, in order;
- for every key in `config_volume_keys` — iterated from the compose text, so
  adding a volume to `docker-compose.yml` extends the assertion by itself —
  a volume carrying that key classifies as ours;
- the foreign output string contains none of the six `nova_v4_*` names;
- `delete_foreign_project`'s captured deletion list is byte-identical to the
  printed foreign list.

A fourth case, `delete_foreign_postcheck_fails_when_a_v4_volume_vanished`,
stubs `docker volume ls` to drop `nova_v4_pgdata` after the deletion and
asserts the function exits non-zero. That is the check that would catch the
bug the other three are designed to prevent.

---

## 9. `decide_subnet` and the 172.18 collision

**Today** the subnet is a hardcoded literal (`deploy/docker-compose.yml:332-334`),
and **172.18/16 is already `docker_default` on the mini PC**, as are
172.17, 172.19, 172.20 and 172.21 (`hub-p0-measurements.md:55`). `decide_subnet`,
`NOVA_SUBNET` and `NOVA_SUBNET_GATEWAY` appear nowhere in the tree outside
`docs/plans/` — this is all new code.

New bash-3.2 functions in `install.sh`:

- **`docker_subnets_in_use`** — `docker network ls -q`, then per id
  `docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}'`;
  drop the row named `<project>_default` (ours, adopting is the point). Exit 2
  if docker cannot be asked; `decide_subnet` then **refuses**, never guesses.
- **`host_routes_in_use`** — `ip -4 route` when present, else `netstat -rn -f inet`
  (requirement #22; `ip` is Linux-only, macOS has only the BSD form). Skip
  `default`; expand BSD's short forms (`172.18` → `172.18.0.0/16`) by octet
  count. Neither tool present → refuse.
- **`ip_to_int`** and **`subnet_overlaps <cidr> <cidr>`** — pure bash integer
  arithmetic (bash's `$(( ))` is 64-bit signed, so 32-bit addresses are safe).
  Two CIDRs overlap when their networks agree under the **shorter** of the two
  masks.
- **`pick_project_subnet`** — candidates `172.18.0.0/16 … 172.31.0.0/16`, then
  `10.200.0.0/16 … 10.254.0.0/16`; the first that overlaps nothing wins. None
  free → die listing everything in use. On the mini PC this lands on
  **172.22.0.0/16**.
- **`derive_subnet_addrs <cidr>`** — `NOVA_SUBNET_RANGE=<a.b>.0.0/17` (dynamic
  allocation confined to the lower half), `NOVA_SUBNET_GATEWAY=<a.b>.0.1`,
  `NOVA_WEB_ADDR=<a.b>.128.10`, `NOVA_TAILSCALE_ADDR=<a.b>.128.20` (the upper
  half, where the allocator never reaches). Requirement #23 is satisfied by
  `decide_subnet` exporting `NOVA_SUBNET_GATEWAY`.
- **`decide_subnet`** — called in `cmd_install` right after `generate_secrets`
  and **before** `record_compose_files` (`deploy/install.sh:1082-1089` states
  that ordering rule), and **first** in `cmd_restore`:
  1. The project network already exists → **adopt its subnet** and write the
     five keys derived from it. Changing IPAM on an existing network is not
     applied in place (`deploy/docker-compose.yml:322-328`), so adopting is
     the only non-destructive answer.
  2. Else `.env` already carries a non-blank `NOVA_SUBNET` → check it for
     overlap. Overlapping → **die** naming the colliding network or route.
     Never silently move a subnet the operator pinned.
  3. Else `pick_project_subnet`, `derive_subnet_addrs`, `set_env_value` × 5.
  4. Verifies: the five keys read back from `.env`, and `subnet_overlaps` is
     false for the chosen value against the in-use set. Fails → die.

The compose edit is three `${VAR:-literal}` substitutions whose defaults are
today's literals, so the Dell's live network does not move when this lands.
`NOVA_WEB_ADDR`/`NOVA_TAILSCALE_ADDR` are already env-driven
(`deploy/docker-compose.yml:126,142,255,284`) and are what nginx's
`$from_sidecar` trust map reads (`apps/web/nginx.conf.template:117-119`), so
the derived addresses reach the trust boundary through the variable that is
already there. Nothing new is wired into nginx.

---

## 10. novad `repoint`

`apps/novad` today has `enroll`, `run`, `status`, `version`
(`apps/novad/main.go:40-52`) and stores `{DeviceID, Name, Server, CorePubKey}`
plus the ed25519 seed under `~/.config/novad/`
(`apps/novad/internal/config/config.go:17-23,76-95`). A hub move changes
`Server` and nothing else, because core's signing key travels inside the
bundle — so `repoint` is exactly "change the URL, after proving the new URL is
the same Nova".

`novad repoint --server <url> [--check]`:

1. `config.Load`. Verifies enrolment. Fails → *"not enrolled — run `novad
   enroll` first"*, exit 1.
2. Dial `<url>/api/v1/devices/ws` and read the first frame, which core sends
   before anything else: `{"type":"challenge","nonce":<hex>,"core_pubkey":<hex>}`
   (`services/core/app/devices_ws.py:288-289`). Verifies: a frame arrives
   inside a short timeout and carries 64 hex characters. Fails → *"that server
   did not answer as a Nova device endpoint: <reason>"*, exit 1, **config
   untouched**.
3. Compare to the pinned `cfg.CorePubKey`. Verifies byte equality. Unequal →
   `Error: that server is not the Nova you paired with (pinned 4f21a8c3…,
   offered 91bb0e7d…). Re-enroll if you meant to pair with a different Nova.`
   exit 1, config untouched.
4. `--check` → print `ok` and exit 0 **without writing**. This is what the
   hub-move runbook's P4 uses to decide between `repoint` and a fresh
   `enroll`.
5. Save via the existing `config.Save` (0600 in a 0700 dir). Verifies by
   reading the file back and comparing `Server`. Fails → exit 1 naming the
   file.
6. Print old → new and *"restart the novad user service for this to take
   effect"*. It restarts nothing itself.

---

## 11. The full test list

### 11.1 `deploy/backup_test.sh` — shell, no docker, no live stack

`sha256_of_prefers_sha256sum`, `sha256_of_falls_back_to_shasum`,
`sha256_of_refuses_when_neither_exists` ·
`mode_probe_accepts_600`, `mode_probe_refuses_644`,
`mode_probe_refuses_when_stat_cannot_read` ·
`host_routes_parses_ip_route`, `host_routes_parses_netstat_bsd`,
`host_routes_expands_short_bsd_form`, `host_routes_refuses_without_either` ·
`subnet_overlaps_16_vs_16`, `subnet_overlaps_24_inside_16`,
`subnet_overlaps_disjoint_is_false`, `subnet_overlaps_8_contains_16` ·
`pick_subnet_skips_172_17_through_21_and_lands_on_172_22` (the mini PC
fixture), `pick_subnet_falls_through_to_10_200`,
`pick_subnet_dies_when_nothing_is_free` ·
`decide_subnet_adopts_an_existing_project_network`,
`decide_subnet_dies_on_a_pinned_colliding_value`,
`decide_subnet_writes_five_keys`,
`derive_subnet_addrs_derives_range_gateway_web_and_sidecar` ·
`refuse_if_moved_refuses_when_dot_moved_exists` ·
`backup_refuses_when_out_dir_cannot_hold_0600`,
`backup_refuses_when_coverage_refuses` (stubbed `python3` exiting 3),
`backup_refuses_when_a_writer_did_not_stop`,
`backup_refuses_when_free_space_cannot_be_read` ·
`restore_refuses_without_python3`,
`restore_refuses_a_non_empty_target_volume`,
`restore_refuses_an_existing_project_container` ·
`scratch_name_ok_accepts_nova_verify_8hex_and_nothing_else`,
`drill_name_ok_accepts_nova_drill_8hex_key_and_nothing_else` ·
`drill_with_no_bundles_fails` ·
`undo_move_refuses_when_MOVED_TO_could_not_be_removed`.

Pins: every bash-3.2 seam, every refusal path, and the portable-tool
fallbacks. **Needs no live stack.**

### 11.2 `deploy/install_test.sh` — additions, no docker

`foreign_volumes_names_only_non_v4_keys` ·
`foreign_volumes_never_names_a_v4_volume` ·
`foreign_volumes_is_derived_from_config_volume_keys` ·
`foreign_containers_classifies_ours_by_config_files` ·
`foreign_containers_classifies_a_second_checkout_as_sibling` (the measured
`.worktrees/v4` case) ·
`foreign_containers_classifies_an_absent_config_path_as_foreign` ·
`check_foreign_project_is_silent_when_nothing_is_foreign` ·
`delete_foreign_refuses_without_the_exact_phrase` ·
`delete_foreign_refuses_on_an_empty_line` ·
`delete_foreign_deletes_exactly_the_captured_ids` ·
`delete_foreign_postcheck_fails_when_a_v4_volume_vanished` ·
`delete_foreign_never_prompts_without_a_tty`.

Pins ruling 1 in both directions: what must be named, and what must never be.
**Needs no live stack.**

### 11.3 `deploy/backup/tests/` — pytest, no docker, no live stack

`test_novaenc.py` — round trip; an exact-multiple-of-chunk file; wrong
passphrase → `CryptoError`; one flipped byte → `CryptoError`; a truncated file
→ `CryptoError`; two frames swapped → `CryptoError`; tampered headers
(`n` not a power of two, `n` over `MAX_N`, `r` over `MAX_R`,
`128*r*n` over the cap, a 4097-byte header, a 15-byte salt) each →
`CryptoError` and **never** a bare `ValueError`;
`generate_passphrase` yields 8 groups of 4 lowercase base32 characters and 160
bits of entropy.

`test_restore_reader.py` — the writer encrypts, `nova_restore.py`'s reader
decrypts, with `cryptography` forced unimportable so the **ctypes libcrypto**
path is the one exercised. This is the pin between the two implementations of
one format.

`test_bundle_layout.py` — `MANIFEST.json` is the inner archive's first member;
the outer tar's first three members are `README.txt`, `nova_restore.py`,
`meta.json` and all three read without a passphrase; the embedded
`nova_restore.py` is byte-identical to the git copy; no field of `meta.json`
is consulted by any restore code path (an AST check over `nova_restore.py`).

`test_bundle_verify.py` — a member corrupted after the manifest was written
fails `verify`; a member removed fails; a corrupted `payload.enc` fails the
outer round trip via GCM; a truncated bundle raises `CryptoError`, not
`EOFError`.

`test_coverage.py` — an undeclared named volume → `R1` naming it; an
anonymous 64-hex volume with no `ANON_POLICY` row → `R1` keyed by
(service, destination); an unexpanded `${VAR}` bind → `R1` and **never** the
compose default; an unreadable INCLUDE → `R2`; a declared INCLUDE volume that
does not exist in `--move` mode → `R3`; a failed fact renderer → `R4`;
`may_snapshot` is false whenever `refusals` is non-empty; and the one that
matters most — **a refusal never downgrades to a skip**: the entry stays,
carries its reason, and no bundle is written.

`test_coverage_v4_real.py` — coverage over the checked-in
`fixtures/compose-v4.json` plus a checked-in ignored-path scan, asserting
**zero refusals**. The drift alarm: adding a volume to compose or a line to
`.gitignore` reddens this and the fix is a policy row with a reason.

`test_git_status_directory_trailing_slash` — `git check-ignore` is probed with
a trailing slash for a directory. Pins §4.5, the bug a verbatim port ships.

`test_policy.py` — every row in all four tables carries a non-empty reason;
every key in the compose fixture's `volumes:` has a `VOLUME_POLICY` row; no
row names a volume the compose file does not declare (so a deleted service's
row is a red suite, not dead weight).

`test_manifest.py` — every field in §3.2 is present with its documented type;
a manifest missing a field raises rather than defaulting; `bundle_version` is
an int and a bundle from the future is refused by version, not by parse error.

`test_passphrase.py` — `sorted(RESOLVERS) == ["env", "file", "prompt"]` and
`deploy/.env.example` documents exactly that set; an unknown source refuses by
name and lists what exists; a resolver raising becomes `PassphraseUnavailable`;
the `file` resolver refuses a non-0600 file; the passphrase appears in **no**
log record emitted during a build (`caplog`) and in no argv the module
constructs.

`test_restore_layout.py` — `restore_to` hints map to `volume:<key>`,
`db:<name>` and repo-relative paths; an unknown hint refuses; the extractor
refuses a member whose path escapes the output directory.

### 11.4 `apps/novad/repoint_test.go` — Go, no live stack

`TestRepointSavesWhenTheOfferedKeyMatchesThePin` ·
`TestRepointRefusesADifferentKeyAndLeavesConfigByteIdentical` ·
`TestRepointRefusesAnUnreachableServerAndLeavesConfigByteIdentical` ·
`TestRepointCheckWritesNothing` — all against an `httptest` WebSocket server
that emits core's real challenge frame shape.

### 11.5 `deploy/tailscale/start_test.sh` — additions

`start_refuses_when_MOVED_TO_is_present_and_names_the_hub` ·
`start_proceeds_when_MOVED_TO_is_absent`. This file already runs real
containers in the docker-backed CI job.

### 11.6 Needs a live stack — the S41 walk, not CI

Back up on the Dell (`./install backup`), copy the bundle to the mini PC,
`./install restore --drill` there. Counts, md5s and the core signing key
fingerprint must be equal, and the drill must leave no
`nova_drill_*` volume behind. Plus: `./install` on the mini PC names the four
platform-line volumes and the old containers, and deletes exactly those.
Recorded in `deploy/README.md`, run by hand, **not** in CI.

### 11.7 CI

`.github/workflows/rebuild-ci.yml`:

- **Trigger extended** to `main` and `slice/**`. **Measured**: it fires on
  `rebuild/**` only (`:3-7`), so as things stand not one test in this slice
  would run in CI.
- `installer` (ubuntu-latest) gains
  `bash -n deploy/backup.sh deploy/backup_test.sh`,
  `shellcheck -S warning deploy/backup.sh deploy/backup_test.sh`, and
  `./deploy/backup_test.sh`.
- **new `backup` job** (ubuntu-latest): `uv run --project deploy/backup pytest`.
- **new `backup-macos` job** — `runs-on: macos-15`,
  `defaults.run.shell: /bin/bash -euo pipefail {0}` so the scripts execute
  under macOS's **bash 3.2** (requirement #27). Steps:
  `./deploy/install_test.sh`, `./deploy/backup_test.sh`, and the pytest suite.
  It runs **no** docker step. **Unverified**: whether GitHub's hosted
  `macos-15` runners provide a usable docker daemon was not checked here, and
  nothing in this repo has ever run docker on macOS — so the macOS leg is
  deliberately the no-docker suites only, which is also what `hub/r2-integration.md:66`
  (D20) already describes as the intended shape.

---

## 12. What I am NOT building, and why

1. **No new tool, no guard, no eval case, no chat step.** S41 is operator
   tooling; the move's chat walk is S45 (`rulings.md:68-71`,
   `hub/r2-integration.md:411`). `test_tools_registry`'s pinned name set and
   `test_eval_corpus`'s counts therefore do not move in this slice, and if
   they do, something went wrong.
2. **No secrets store (Proposal A).** Only the resolver seam
   (`rulings.md:48-49`). Cost: the `file` resolver's passphrase sits in a 0600
   file beside the bundles, which is exactly why the generation message says
   to record it off-machine.
3. **No weekly schedule.** The drill verb only (requirement #5). Its future
   home is `timers.JOBS`.
4. **No `BACKUP_EXCLUDE_DATA` list.** Ruling 2 replaced it with §4's derived
   coverage.
5. **No destructive `apply_bundle` over a live system.** v3's
   `backend/app/backup_apply.py` (typed confirmation phrase, pre-restore
   safety snapshot, staged database, point-of-no-return, `_swap_database`,
   `_restore_files`) is where most of v3's complexity lives, and v4's
   `restore` sidesteps all of it by **refusing a non-empty target**
   (requirement #14) — restore onto an empty machine is exactly the ruling's
   "spin Nova up on a different machine". Cost, stated: there is no in-place
   rollback of a bad upgrade. The documented recovery is restore onto empty
   volumes, and `deploy/README.md:74-79`'s manual per-migration rollback drill
   stays the answer for a single bad migration.
6. **No checksum column in `schema_migrations`.** The gate degrades to
   filename-only and says so (§7.2 step 5). Adding the column means editing
   the runner in all three services
   (`services/core/app/migrations_runner.py:1-6`) and is not S41's business.
7. **No off-machine copy.** v3's `offsite_state`/`offsite_sync`
   (`backend/app/backup_service.py:459-565`) is a real feature and is named in
   none of S41's 33 requirement bullets.
8. **No `backup_attempts` history, no freshness verdict, no passphrase nag.**
   Those depend on v3's `backup_attempts`, `automations`, `recommendations`
   and `capability_events` tables, none of which exist in v4 (map-v3-backup
   §6.9). `drill` reports what it just measured instead of what it remembers.
9. **No retention or pruning of old bundles.** The directory grows until an
   operator deletes something; `drill` at least tells him when an old bundle
   needs a previous passphrase.
10. **No `network_credentials` handling.** The table does not exist yet
    (S43a). Coverage is schema-driven, so it is carried the day it is created
    — which is exactly `rulings.md:60-67`, and the only S41 work is deleting
    the now-wrong "backups exclude `network_credentials`" sentences.
11. **No `attach-node`, no `enroll --json`.** r1 lists them beside `repoint`
    (`hub/r1-hubmove-design.md:36`); only `repoint` is in S41's MUST list.
12. **No UI.** D21 keeps every backup/restore/move verb out of her context
    (`hub-topology.md:141`).

---

## 13. Risks, ranked, with the cheapest measurement that settles each

| # | Risk | Cheapest measurement | State |
|---|---|---|---|
| 1 | The foreign-project classifier calls a **sibling v4 checkout** foreign and offers to delete the live stack. | `docker ps -a --filter label=com.docker.compose.project=nova --format '{{.Names}} {{.Label "com.docker.compose.project.config_files"}}'` | **Measured, real.** The Dell's live v4 containers name `.worktrees/v4/deploy/docker-compose.yml`, not this worktree's file. The `sibling` class (§8.1) and `foreign_containers_classifies_a_second_checkout_as_sibling` exist because of this reading. |
| 2 | A verbatim port of `git_status_fn` makes **every** v4 backup refuse on the `../data` bind. | `git check-ignore -v data; git check-ignore -v data/` | **Measured, real.** Exit 1 vs. a match. §4.5 fixes it; `test_git_status_directory_trailing_slash` pins it. |
| 3 | Volume tars written by a root container are unreadable by the host user, so the build step fails after the expensive part. | `docker run --rm -v /tmp/probe:/out alpine sh -c 'touch /out/f'; ls -l /tmp/probe/f` | **Not run.** §7.1 step 11 adds the `chown` container; the probe settles whether it is needed on this docker/WSL combination. |
| 4 | No host `python3` on the restore target, so `restore` cannot run at all. | `python3 -V` on the mini PC | **Not run.** Pop!_OS 24.04 ships one, but this is an assumption until read. The refusal at §7.2 step 0 is stated, not silent. |
| 5 | Postgres **minor** drift between hosts (open question #6). | `docker run --rm postgres:16 postgres --version` on the Dell and the mini PC | **Not run.** The major-version refusal (§7.2 step 4) is the mechanical answer; `pg_restore` is forward-compatible within a major, so a minor difference is expected to be harmless — expected, not measured. |
| 6 | `macos-15` runners lack `/bin/bash` 3.2, `shasum`, or `stat -f`, so the portability leg proves nothing. | a 6-line throwaway workflow printing `/bin/bash --version` and `command -v shasum sha256sum stat python3` | **Not run.** Nothing in this repo has ever run on macOS CI. |
| 7 | The bundle is too large to be practical — `v4_memdata` and `v4_workspace` are unmeasured. | `docker run --rm -v nova_v4_memdata:/v:ro alpine du -sh /v` per INCLUDE volume | **Not run.** Step 3's free-space check refuses rather than half-writing, so the failure is loud either way. |
| 8 | `nova_restore.py`'s two hardcoded Homebrew libcrypto paths are stale on a current macOS. | run `nova_restore.py --verify-only` on any Mac with Homebrew OpenSSL | **Not run; no macOS machine available here.** The `cryptography` fallback and the stated `pip3 install cryptography` message are the mitigation. |
| 9 | The refusal-on-unclassified coverage makes routine backups fail whenever someone edits `.gitignore`. | run `test_coverage_v4_real.py` in CI on every push | **Designed in.** The alarm is a red suite at commit time, not a failed backup at 3am. The trade is stated at §4.4. |
| 10 | `docker compose config --format json` fails or emits non-JSON when `.env` is absent, taking the fact renderer with it. | the command, run in a checkout with no `deploy/.env` | **Measured, benign.** It emits `variable is not set` warnings on **stderr** and valid JSON on stdout, exit 0. The renderer must parse stdout only — stated at §4.1. |
